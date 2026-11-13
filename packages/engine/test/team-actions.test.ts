import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  callTargets,
  commandAction,
  createAgent,
  createChannel,
  createToolGateway,
  drainOutbox,
  grantScopes,
  isOutsideTool,
  linkRunChecks,
  postPersonMessage,
  runChecksForReply,
  searchVisible,
  type ToolContext,
  type ToolDefinition,
  type ToolSource,
  teamNoticeText,
  updateOrgSettings,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("targets", () => {
  test("addresses, numbers, pages and code; never the text or the sender", () => {
    expect(
      callTargets({
        to: ["Ana <Ana@Pixelpress.com>", "joao@acme.com"],
        cc: "rh@acme.com; ",
        from: "vendas@nossa.com",
        subject: "Fale com bia@acme.com",
        body: "Copie carlos@acme.com e veja https://acme.com/precos",
        phone: "(11) 4002-8922",
        link: "https://Acme.com/Contato/?utm=x#topo",
      }).sort(),
    ).toEqual(
      [
        "email:ana@pixelpress.com",
        "email:joao@acme.com",
        "email:rh@acme.com",
        "phone:+551140028922",
        "url:acme.com/Contato",
      ].sort(),
    );
    expect(
      callTargets(
        { repo: "Acme/App", branch: "fix/login", title: "Fix" },
        { pullRequest: { repo: "acme/app", number: 212 } },
      ),
    ).toEqual(["github:acme/app@fix/login", "github:acme/app#212"]);
    expect(callTargets({ repo: "acme/app", pull_number: 7 })).toEqual(["github:acme/app#7"]);
    // A default branch says nothing about which work it is.
    expect(callTargets({ repo: "acme/app", branch: "main" })).toEqual([]);
  });

  test("commands that leave the computer, and nothing else", () => {
    expect(
      commandAction("Bash", { command: "gh pr create -R acme/app --head fix/login --title 'Fix login'" }),
    ).toMatchObject({
      tool: "gh pr create",
      targets: ["github:acme/app@fix/login"],
    });
    expect(commandAction("Bash", { command: "gh pr comment 212 --repo acme/app --body ok" })?.targets).toEqual([
      "github:acme/app#212",
    ]);
    expect(commandAction("Bash", { command: "git push origin fix/login" })).toMatchObject({
      tool: "git push",
      targets: ["branch:fix/login"],
    });
    expect(commandAction("Bash", { command: "curl -X POST https://hooks.acme.com/deal -d '{}'" })).toMatchObject({
      tool: "curl",
      targets: ["url:hooks.acme.com/deal"],
    });
    expect(commandAction("Bash", { command: "curl https://acme.com/precos" })).toBeNull();
    expect(commandAction("Bash", { command: "gh pr view 212 -R acme/app" })).toBeNull();
    expect(commandAction("Bash", { command: "ls -la && git status" })).toBeNull();
    expect(commandAction("Bash", { command: "git commit -m push" })).toBeNull();
    expect(commandAction("Bash", { command: "git -C ../app push origin fix/login" })?.tool).toBe("git push");
    expect(commandAction("Read", { file_path: "/tmp/x" })).toBeNull();
  });

  test("outside tools: a connected app's write, a mailbox that sends, opening a PR", () => {
    const t = (name: string, scope: string, connectionId: string | null = "c1") => ({ name, scope, connectionId });
    expect(isOutsideTool(t("hubspot_create_note", "custom:c1:write"))).toBe(true);
    expect(isOutsideTool(t("hubspot_search", "custom:c1:read"))).toBe(false);
    expect(isOutsideTool(t("mail_sales_send", "mail:send"))).toBe(true);
    expect(isOutsideTool(t("mail_sales_move", "mail:write"))).toBe(false);
    expect(isOutsideTool(t("open_pull_request", "github:pr.write", null))).toBe(true);
    expect(isOutsideTool(t("create_issue", "issues:write", null))).toBe(false);
  });
});

/** `open_pull_request` without a network: records what it opened. */
function fakePrs() {
  const opened: Record<string, unknown>[] = [];
  let next = 212;
  const tool: ToolDefinition = {
    name: "open_pull_request",
    description: "Open a pull request (fake)",
    scope: "github:pr.write",
    connectorLabel: "GitHub",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, branch: { type: "string" }, title: { type: "string" } },
      required: ["repo", "branch", "title"],
      additionalProperties: false,
    },
    async execute(input) {
      opened.push(input);
      const number = next++;
      return { content: `Opened PR #${number}`, data: { pullRequest: { repo: input.repo, number } } };
    },
  };
  // Claude Code's prompt tool: answers what the test says.
  const answers: string[] = [];
  const prompt: ToolDefinition = {
    name: "permission_prompt",
    description: "Permission prompt (fake)",
    scope: "",
    inputSchema: { type: "object" },
    async execute() {
      return { content: answers.shift() ?? JSON.stringify({ behavior: "allow" }) };
    },
  };
  const source: ToolSource = { name: "fake-prs", tools: async () => [tool, prompt] };
  return { source, opened, answers };
}

const PR = { repo: "acme/app", branch: "fix/login", title: "Corrige login com Google" };

describe("team actions in the Tool Gateway", () => {
  async function runIn(fx: Fixture, agentId: string, channelId: string): Promise<ToolContext> {
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, channelId, {
      body: "arruma o login",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId,
        channelId,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    return {
      db: fx.db,
      orgId: fx.org.id,
      agentId,
      runId: run?.id ?? "",
      channelId,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
    };
  }

  async function team(fx: Fixture) {
    const prs = fakePrs();
    const tools = createToolGateway({ sources: [prs.source] });
    const qa = await createAgent(
      fx.db,
      fx.owner.id,
      fx.org.id,
      { name: "QA", handle: "qa" },
      { model: "claude-sonnet-5-5" },
    );
    for (const id of [fx.agent.id, qa.id]) {
      await grantScopes(fx.db, fx.org.id, id, [{ connectionId: null, scope: "github:pr.write" }]);
    }
    return { prs, tools, qa };
  }

  const call = (
    tools: ReturnType<typeof createToolGateway>,
    ctx: ToolContext,
    name: string,
    input: Record<string, unknown>,
  ) => tools.invoke(ctx, { toolUseId: `tu_${Math.random()}`, name, input });
  const outputOf = (r: Awaited<ReturnType<typeof call>>) => {
    if (r.type !== "result") throw new Error(`expected a result, got ${r.type}`);
    return r.output;
  };

  test("records what went out; a teammate is told once, goes on with a why; the reply carries it", async () => {
    f = await setup();
    const { prs, tools, qa } = await team(f);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });

    const dev = await runIn(f, f.agent.id, f.general.id);
    expect(outputOf(await call(tools, dev, "open_pull_request", PR)).content).toBe("Opened PR #212");
    const [first] = await f.db.select().from(schema.teamActions);
    expect(first).toMatchObject({
      agentId: f.agent.id,
      runId: dev.runId,
      channelId: f.general.id,
      source: "tool",
      tool: "open_pull_request",
      summary: "GitHub · Corrige login com Google",
      reason: null,
    });
    expect(first?.targets.sort()).toEqual(["github:acme/app#212", "github:acme/app@fix/login"]);

    // QA, in the same channel, would open a second PR for the same branch: held, not run.
    const mine = await runIn(f, qa.id, f.general.id);
    const held = outputOf(await call(tools, mine, "open_pull_request", PR));
    expect(held.isError).toBe(true);
    expect(held.data).toEqual({ code: "team.action_seen" });
    expect(held.content).toContain("Not done: the team already did this.");
    expect(held.content).toContain("Dev already acted on acme/app@fix/login");
    expect(held.content).toContain("in #general");
    expect(held.content).toContain("GitHub · Corrige login com Google");
    expect(prs.opened).toHaveLength(1);

    // What its reply will show, and on which message.
    const [check] = await runChecksForReply(f.db, f.org.id, mine.runId);
    expect(check).toMatchObject({
      tool: "open_pull_request",
      targets: ["acme/app@fix/login"],
      matches: [{ agentId: f.agent.id, agentName: "Dev", channelId: f.general.id, channelName: "general" }],
    });
    const reply = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "stand-in for the reply",
    });
    await linkRunChecks(f.db, f.org.id, [check?.id ?? ""], reply.id);
    expect(await runChecksForReply(f.db, f.org.id, mine.runId)).toEqual([]);

    // Told once: it goes on with a why (kept, never sent to the tool).
    const why = "Dev's PR was closed without merging; this one replaces it.";
    expect(outputOf(await call(tools, mine, "open_pull_request", { ...PR, why })).content).toBe("Opened PR #213");
    expect(prs.opened[1]).toEqual(PR);
    const rows = await f.db.select().from(schema.teamActions).where(eq(schema.teamActions.agentId, qa.id));
    expect(rows[0]?.reason).toBe(why);
    const [after] = await f.db.select().from(schema.teamActionChecks);
    expect(after).toMatchObject({ outcome: "repeated", reason: why, messageId: reply.id });

    // Search: the channel's people and agents find it; nobody else.
    await drainOutbox(f.db, f.handlers);
    const hits = (visible: string[]) =>
      searchVisible(f.context, { orgId: f.org.id, text: "login", visibleChannelIds: visible, kinds: ["action"] });
    expect((await hits([f.general.id])).length).toBe(2);
    expect(await hits([])).toEqual([]);
  });

  test("outside the agent's view: only that someone did it, and when", async () => {
    f = await setup();
    const { prs, tools, qa } = await team(f);
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "sala-qa", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: qa.id });

    await call(tools, await runIn(f, f.agent.id, f.general.id), "open_pull_request", PR);
    const held = outputOf(await call(tools, await runIn(f, qa.id, room.id), "open_pull_request", PR));
    expect(held.content).toContain("Someone on the team already acted on acme/app@fix/login");
    expect(held.content).toContain("in a conversation you can't see");
    expect(held.content).not.toContain("Dev");
    expect(held.content).not.toContain("Corrige login");
    expect(prs.opened).toHaveLength(1);
    const [check] = await f.db.select().from(schema.teamActionChecks);
    expect(check?.matches[0]).toMatchObject({ agentId: null, summary: null, channelId: null });
  });

  test("the workspace switch: off, nothing is held; actions are still recorded", async () => {
    f = await setup();
    const { prs, tools, qa } = await team(f);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { actionCheck: false });

    await call(tools, await runIn(f, f.agent.id, f.general.id), "open_pull_request", PR);
    const out = outputOf(await call(tools, await runIn(f, qa.id, f.general.id), "open_pull_request", PR));
    expect(out.content).toBe("Opened PR #213");
    expect(prs.opened).toHaveLength(2);
    expect(await f.db.select().from(schema.teamActions)).toHaveLength(2);
    expect(await f.db.select().from(schema.teamActionChecks)).toHaveLength(0);
  });

  test("computer commands: held as a refusal, recorded when allowed or waiting, forgotten when a person says no", async () => {
    f = await setup();
    const { prs, tools, qa } = await team(f);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
    const push = { tool_name: "Bash", input: { command: "gh pr create -R acme/app --head fix/login --title Fix" } };

    // Dev's Claude Code asks, a person decides later: it counts while it waits.
    prs.answers.push(JSON.stringify({ status: "pending", request_id: "req-1" }));
    const dev = await runIn(f, f.agent.id, f.general.id);
    await call(tools, dev, "permission_prompt", push);
    const [waiting] = await f.db.select().from(schema.teamActions);
    expect(waiting).toMatchObject({ source: "command", tool: "gh pr create", ref: "req-1" });

    // QA's command for the same branch: refused with the notice, the prompt never asked.
    const mine = await runIn(f, qa.id, f.general.id);
    prs.answers.push(JSON.stringify({ behavior: "allow" }));
    const held = JSON.parse(outputOf(await call(tools, mine, "permission_prompt", push)).content);
    expect(held).toMatchObject({ behavior: "deny", code: "team" });
    expect(held.message).toContain("Dev already acted on acme/app@fix/login");
    expect(prs.answers).toHaveLength(1);
    prs.answers.length = 0;

    // The person said no to Dev's: it never happened.
    prs.answers.push(JSON.stringify({ behavior: "deny", message: "A person said no." }));
    await call(tools, dev, "permission_prompt", { request_id: "req-1" });
    expect(await f.db.select().from(schema.teamActions)).toHaveLength(0);

    // QA asks again in the same run: it goes on, and its command is the team's now.
    expect(JSON.parse(outputOf(await call(tools, mine, "permission_prompt", push)).content).behavior).toBe("allow");
    const [now] = await f.db.select().from(schema.teamActions);
    expect(now).toMatchObject({ agentId: qa.id, source: "command", reason: "went on after the notice" });
  });
});

test("a personal workspace's notice speaks of one person's agents, never a team (ADR 0159)", () => {
  const at = new Date("2026-11-09T12:00:00Z");
  const match = (agentId: string | null) => ({
    actionId: "a1",
    agentId,
    tool: null,
    summary: null,
    channelId: null,
    targets: ["ana@example.com"],
    at: new Date(at.getTime() - 3_600_000).toISOString(),
  });
  const names = { agents: new Map<string, string>(), channels: new Map<string, string>() };
  const personal = teamNoticeText([match(null), match("gone")], names, "self", at, true);
  expect(personal).toContain("Not done: this was already done.");
  expect(personal).toContain("- Someone already acted on");
  expect(personal).toContain("- Another agent already acted on");
  expect(personal).not.toMatch(/team/i);
  // A team's reads as before.
  expect(teamNoticeText([match(null)], names, "self", at)).toContain("Someone on the team already acted on");
});
