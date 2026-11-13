import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  applySettings,
  callableAgents,
  createAgent,
  createIssue,
  createTeamStatusToolSource,
  createToolGateway,
  getAgent,
  getTeam,
  insertMessage,
  linePrompt,
  lineRefusal,
  loadTeam,
  openPersonAgentDm,
  RIGHT_HAND,
  setReportsTo,
  settingLines,
  speakerFor,
  type ToolContext,
  teammatesFor,
  teamStatus,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const addAgent = (name: string) =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle: name.toLowerCase(), role: "Sales", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
const lineOf = async (id: string) => (await getAgent(f.db, f.org.id, id))?.reportsToAgentId ?? null;
const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

describe("the line's rules", () => {
  const row = (id: string, reportsToAgentId: string | null = null, builtin: string | null = null) =>
    [id, { id, builtin, reportsToAgentId }] as const;

  test("refuses itself, the right hand at either end, a loop and more than 3 agents deep", () => {
    const rows = new Map([row("a"), row("b", "a"), row("c", "b"), row("d"), row("lodi", null, "right_hand")]);
    expect(lineRefusal(rows, "a", "a")).toContain("itself");
    expect(lineRefusal(rows, "lodi", "a")).toContain("right hand");
    expect(lineRefusal(rows, "d", "lodi")).toContain("right hand");
    expect(lineRefusal(rows, "a", "c")).toContain("loop");
    // d → c makes a, b, c, d: four agents top to bottom.
    expect(lineRefusal(rows, "d", "c")).toContain("at most 3");
    // A line moved under another counts its own reports too.
    expect(lineRefusal(new Map([row("x"), row("y"), row("z", "y")]), "y", "x")).toBeNull();
    expect(lineRefusal(new Map([row("w"), row("x", "w"), row("y"), row("z", "y")]), "y", "x")).toContain("at most 3");
    expect(lineRefusal(rows, "d", "b")).toBeNull();
    expect(lineRefusal(rows, "c", null)).toBeNull();
    expect(lineRefusal(rows, "nope", "a")).toContain("isn't in this workspace");
  });
});

describe("setting it", () => {
  test("who manages agents sets it at once, gets what it was back, and Desfazer is the same call", async () => {
    f = await setup();
    const nina = await addAgent("Nina");
    const ada = await addAgent("Ada");
    const out = await setReportsTo(f, f.owner.id, f.org.id, [
      { agentId: ada.id, reportsToAgentId: nina.id },
      { agentId: f.agent.id, reportsToAgentId: nina.id },
    ]);
    expect(out.previous).toEqual([
      { agentId: ada.id, reportsToAgentId: null },
      { agentId: f.agent.id, reportsToAgentId: null },
    ]);
    expect(await lineOf(ada.id)).toBe(nina.id);
    // The same line again changes nothing and owes no Desfazer.
    expect(
      (await setReportsTo(f, f.owner.id, f.org.id, [{ agentId: ada.id, reportsToAgentId: nina.id }])).previous,
    ).toEqual([]);
    await setReportsTo(f, f.owner.id, f.org.id, out.previous);
    expect(await lineOf(ada.id)).toBeNull();
    expect(await lineOf(f.agent.id)).toBeNull();
    const audit = await f.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.reports_to_changed"));
    expect(audit.length).toBe(4);
  });

  test("all or none: a refused change leaves the others as they were", async () => {
    f = await setup();
    const nina = await addAgent("Nina");
    await expect(
      setReportsTo(f, f.owner.id, f.org.id, [
        { agentId: f.agent.id, reportsToAgentId: nina.id },
        { agentId: nina.id, reportsToAgentId: f.agent.id },
      ]),
    ).rejects.toThrow("loop");
    expect(await lineOf(f.agent.id)).toBeNull();
  });

  test("a member who doesn't manage agents can't, and the right hand stays out", async () => {
    f = await setup({ rightHand: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const nina = await addAgent("Nina");
    await expect(
      setReportsTo(f, bob.id, f.org.id, [{ agentId: f.agent.id, reportsToAgentId: nina.id }]),
    ).rejects.toThrow();
    const lodi = await lodiOf();
    await expect(
      setReportsTo(f, f.owner.id, f.org.id, [{ agentId: f.agent.id, reportsToAgentId: lodi.id }]),
    ).rejects.toThrow("right hand");
  });

  test("the team screen says who each reports to", async () => {
    f = await setup();
    const nina = await addAgent("Nina");
    await setReportsTo(f, f.owner.id, f.org.id, [{ agentId: f.agent.id, reportsToAgentId: nina.id }]);
    const team = await getTeam(f.db, f.owner.id, f.org.id);
    expect(team.agents.find((a) => a.id === f.agent.id)?.reportsToAgentId).toBe(nina.id);
    expect(team.agents.find((a) => a.id === nina.id)?.reportsToAgentId).toBeNull();
  });
});

describe("what it changes", () => {
  test("a supervisor and its report may always call each other, whatever their lists say", async () => {
    f = await setup();
    const nina = await addAgent("Nina");
    const ada = await addAgent("Ada");
    await updateAgent(f.db, f.owner.id, f.org.id, nina.id, { autonomyBrakes: { callAgents: "none" } });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { autonomyBrakes: { callAgents: "none" } });
    expect(await callableAgents(f.db, f.org.id, nina.id, [f.agent.id, ada.id])).toEqual(new Set());
    await setReportsTo(f, f.owner.id, f.org.id, [{ agentId: f.agent.id, reportsToAgentId: nina.id }]);
    expect(await callableAgents(f.db, f.org.id, nina.id, [f.agent.id, ada.id])).toEqual(new Set([f.agent.id]));
    expect(await callableAgents(f.db, f.org.id, f.agent.id, [nina.id, ada.id])).toEqual(new Set([nina.id]));
    // Who may talk to an agent still applies: its audience is not the line's to widen.
    const team = await loadTeam(f.db, f.org.id);
    const talks = await speakerFor(f.db, f.org.id, f.owner.id);
    expect(teammatesFor(team, nina.id, f.owner.id, new Set(), talks).map((a) => a.handle)).toEqual(["dev"]);
  });

  test("the context lists a supervisor's reports and says who a report reports to; no line, no block", async () => {
    f = await setup();
    const nina = await addAgent("Nina");
    expect(linePrompt(await loadTeam(f.db, f.org.id), nina.id)).toBe("");
    await setReportsTo(f, f.owner.id, f.org.id, [{ agentId: f.agent.id, reportsToAgentId: nina.id }]);
    const team = await loadTeam(f.db, f.org.id);
    const up = linePrompt(team, nina.id);
    expect(up).toContain("# Your line");
    expect(up).toContain("These agents report to you: @dev");
    expect(up).toContain("team_status");
    const down = linePrompt(team, f.agent.id);
    expect(down).toContain("You report to @nina (Sales)");
    expect(down).toContain("ask it with ask_agent");
    expect(down).toContain("approvals stay with people");
  });

  test("the settings card proposes it, names who it was, and applies it", async () => {
    f = await setup({ rightHand: true });
    const nina = await addAgent("Nina");
    const ada = await addAgent("Ada");
    await setReportsTo(f, f.owner.id, f.org.id, [{ agentId: ada.id, reportsToAgentId: nina.id }]);
    const agent = await getAgent(f.db, f.org.id, ada.id);
    if (!agent) throw new Error("no agent");
    const { lines, skipped } = await settingLines(f.db, f.org.id, f.owner.id, agent, [
      { field: "reports_to", to: f.agent.id, label: { to: "Dev" } },
    ]);
    expect(skipped).toEqual([]);
    expect(lines).toEqual([{ field: "reports_to", from: nina.id, to: f.agent.id, label: { to: "Dev", from: "Nina" } }]);
    const top = await getAgent(f.db, f.org.id, nina.id);
    if (!top) throw new Error("no agent");
    const loop = await settingLines(f.db, f.org.id, f.owner.id, top, [{ field: "reports_to", to: ada.id }]);
    expect(loop.lines).toEqual([]);
    expect(loop.skipped[0]).toContain("loop");
    const lodi = await lodiOf();
    const applied = await applySettings(
      f,
      f.owner.id,
      { orgId: f.org.id, settings: lines } as unknown as Parameters<typeof applySettings>[2],
      agent,
    );
    expect(applied).toBe(true);
    expect(await lineOf(ada.id)).toBe(f.agent.id);
    expect(lodi.reportsToAgentId).toBeNull();
  });
});

describe("team_status for a supervisor", () => {
  async function runOf(
    agentId: string,
    author: { type: "person"; userId: string } | null,
    channelId?: string,
  ): Promise<ToolContext> {
    const dm = channelId ? { id: channelId } : await openPersonAgentDm(f.db, f.org.id, f.owner.id, agentId);
    const trigger = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: author ?? { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "como está a equipe?",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId,
        channelId: dm.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    if (!run) throw new Error("no run");
    return {
      db: f.db,
      orgId: f.org.id,
      agentId,
      runId: run.id,
      channelId: dm.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
    };
  }
  const gateway = () => createToolGateway({ sources: [createTeamStatusToolSource()] });

  test("only an agent others report to gets it, and it covers its reports as the person sees them", async () => {
    f = await setup();
    const nina = await addAgent("Nina");
    const ada = await addAgent("Ada");
    const ctx = await runOf(nina.id, { type: "person", userId: f.owner.id });
    expect((await gateway().granted(ctx)).map((t) => t.name)).not.toContain("team_status");
    await setReportsTo(f, f.owner.id, f.org.id, [{ agentId: f.agent.id, reportsToAgentId: nina.id }]);
    expect((await gateway().granted(ctx)).map((t) => t.name)).toContain("team_status");
    const res = await gateway().invoke(ctx, { toolUseId: "tu_1", name: "team_status", input: {} });
    if (res.type !== "result") throw new Error(res.type);
    const text = (res.output as { content: string }).content;
    expect(text).toContain("@dev");
    expect(text).not.toContain("@ada");
    expect(text).not.toContain(`@${ada.handle}`);
    const all = await teamStatus(f.db, f.org.id, f.owner.id);
    expect(all).toContain("@ada");
  });

  test("only its reports' tasks, and in a channel others read, none this conversation may not name", async () => {
    f = await setup();
    const nina = await addAgent("Nina");
    const ada = await addAgent("Ada");
    await setReportsTo(f, f.owner.id, f.org.id, [{ agentId: f.agent.id, reportsToAgentId: nina.id }]);
    const task = (title: string, assigneeId: string, userIds?: string[]) =>
      createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
        title,
        assignee: { type: "agent", id: assigneeId },
        ...(userIds ? { audience: { mode: "people" as const, userIds } } : {}),
      });
    await task("Relatorio aberto", f.agent.id);
    await task("Reajuste sigiloso", f.agent.id, [f.owner.id]);
    await task("Trabalho da Ada", ada.id);
    const status = async (channelId?: string) => {
      const res = await gateway().invoke(await runOf(nina.id, { type: "person", userId: f.owner.id }, channelId), {
        toolUseId: `tu_${crypto.randomUUID()}`,
        name: "team_status",
        input: {},
      });
      if (res.type !== "result") throw new Error(res.type);
      return (res.output as { content: string }).content;
    };
    const dm = await status();
    expect(dm).toContain("Relatorio aberto");
    expect(dm).toContain("Reajuste sigiloso");
    expect(dm).not.toContain("Trabalho da Ada");
    const channel = await status(f.general.id);
    expect(channel).toContain("Relatorio aberto");
    expect(channel).not.toContain("Reajuste sigiloso");
    expect(channel).not.toContain("Trabalho da Ada");
  });

  test("with nobody behind the run it reads nothing and says what to do instead", async () => {
    f = await setup();
    const nina = await addAgent("Nina");
    await setReportsTo(f, f.owner.id, f.org.id, [{ agentId: f.agent.id, reportsToAgentId: nina.id }]);
    const ctx = await runOf(nina.id, null);
    const res = await gateway().invoke(ctx, { toolUseId: "tu_2", name: "team_status", input: {} });
    if (res.type !== "result") throw new Error(res.type);
    expect(res.output).toMatchObject({ isError: true });
    expect((res.output as { content: string }).content).toContain("ask_agent");
  });
});
