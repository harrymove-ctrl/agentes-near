import { afterAll, afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type RealtimeEvent } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import {
  ANSWER_NUDGE,
  createAgent,
  createAgentRuns,
  createPassToolSource,
  drainOutbox,
  insertMessage,
  listMessages,
  loadReplyPolicy,
  openDm,
  postPersonMessage,
  queueOnRun,
  resolveBrain,
  type ToolSource,
} from "../src";
import * as ledger from "../src/routine-ledger";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

// PGlite setup on a slow machine.
setDefaultTimeout(30_000);

/** Background runs hand their answer to `closeRoutineRun` (routine-ledger.ts): what it got. */
const finishSpy = spyOn(ledger, "closeRoutineRun");
afterAll(() => finishSpy.mockRestore());
const finished = () =>
  finishSpy.mock.calls.map(([, run, end]) => ({ runId: run.id, text: end.status === "done" ? end.text : "" }));

let f: Fixture;
afterEach(async () => {
  finishSpy.mockClear();
  await f?.close();
});

const lastText = (req: ModelRequest) => {
  const last = req.messages.at(-1);
  return last ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : "";
};
const agentMessages = async () =>
  (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent").map((m) => m.body);
/** What went out before its message: never its words (`agent.typing` only says it writes). */
const beforeMessage = (events: RealtimeEvent[]) => JSON.stringify(events.filter((e) => e.type !== "message.created"));
const runRow = async () => (await f.db.select().from(schema.agentRuns))[0];

/** A person's message in #general without a mention, and the router bringing the agent in. */
async function routed(body: string, over: { background?: boolean; trigger?: "router" | "mention" } = {}) {
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body,
  });
  const [run] = await f.db.transaction((tx) => createAgentRuns(tx, message, [f.agent.id], over.trigger ?? "router"));
  if (over.background && run)
    await f.db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, run.id));
  await drainOutbox(f.db, f.handlers);
  return message;
}

describe("a run that must answer never posts the silence word", () => {
  test("a DM answered NO_REPLY: told once to answer, then the answer is posted (never the word, never live)", async () => {
    f = await setup({
      toolSources: [createPassToolSource()],
      reply: (req) => ({ chunks: lastText(req).includes(ANSWER_NUDGE) ? ["Aqui ", "está."] : ["NO_", "REPLY"] }),
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const events = f.listen(dm.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "oi, tudo bem?" });
    await drainOutbox(f.db, f.handlers);

    expect(await agentMessages()).toEqual(["Aqui está."]);
    expect(f.provider.calls.length).toBe(2);
    // A DM is addressed: no `pass`, no "why you were called".
    const first = f.provider.calls[0]?.request as ModelRequest;
    expect(first.tools?.map((t) => t.name) ?? []).not.toContain("pass");
    expect(systemText(first.system)).not.toContain("# Why you were called");
    await Bun.sleep(5);
    expect(beforeMessage(events)).not.toContain("NO_");
    expect(beforeMessage(events)).not.toContain("Aqui");
    expect(events.some((e) => e.type === "agent.passed")).toBe(false);
    expect((await runRow())?.status).toBe("done");
  });

  test("still only the word after the nudges: empty_reply, nothing posted", async () => {
    f = await setup({ reply: () => ({ chunks: ["NO_REPLY"] }) });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    expect(await agentMessages()).toEqual([]);
    // Answer nudges share the run's two continues (ADR 0097): the first answer and two nudged turns.
    expect(f.provider.calls.length).toBe(3);
    const run = await runRow();
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("empty_reply");
  });

  test("a mention can't pass: the tool isn't offered (and calling it anyway is refused)", async () => {
    f = await setup({ toolSources: [createPassToolSource()], reply: () => ({ chunks: ["Feito."] }) });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev roda o deploy",
    });
    await drainOutbox(f.db, f.handlers);
    const request = f.provider.calls[0]?.request as ModelRequest;
    expect(request.tools?.map((t) => t.name) ?? []).not.toContain("pass");
    expect(systemText(request.system)).not.toContain("# Why you were called");
    expect(await agentMessages()).toEqual(["Feito."]);
  });

  test("the word glued to real text is cut from the message, and none of it went out before", async () => {
    f = await setup({ reply: () => ({ chunks: ["NO_REP", "LY Claro", ", aqui está.", " NO_", "REPLY"] }) });
    const events = f.listen(f.general.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    expect(await agentMessages()).toEqual(["Claro, aqui está."]);
    await Bun.sleep(5);
    expect(beforeMessage(events)).not.toContain("NO_");
    expect(beforeMessage(events)).not.toContain("Claro");
  });
});

describe("a run nobody called by name may stay quiet", () => {
  test("it passes: nothing posted, one call, agent.passed, the reason on a step", async () => {
    f = await setup({
      toolSources: [createPassToolSource()],
      reply: () => ({ chunks: [], toolUses: [{ name: "pass", input: { reason: "Theo já respondeu" } }] }),
    });
    const events = f.listen(f.general.id);
    await routed("alguém sabe onde rodam os builds?");

    expect(await agentMessages()).toEqual([]);
    expect(f.provider.calls.length).toBe(1);
    const request = f.provider.calls[0]?.request as ModelRequest;
    expect(request.tools?.map((t) => t.name)).toContain("pass");
    expect(systemText(request.system)).toContain("# Why you were called");
    const run = await runRow();
    expect(run?.status).toBe("done");
    expect(run?.replyMessageId).toBeNull();
    const steps = await f.db
      .select()
      .from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
    expect(steps.find((s) => s.data.passed)?.data.passed).toEqual({
      how: "pass",
      reason: "Theo já respondeu",
      silent: true,
    });
    await Bun.sleep(5);
    expect(events.find((e) => e.type === "agent.passed")).toMatchObject({ agentId: f.agent.id, runId: run?.id });
    // Its receipt reads "didn't reply", live and after a reload, never "replied".
    expect(events.find((e) => e.type === "message.handled")).toMatchObject({ status: "done", passed: true });
    // On every message the run answers, a steered one too.
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ status: "done", passed: true });
    const [listed] = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(listed?.receipts?.handled).toEqual([
      expect.objectContaining({ agentId: f.agent.id, status: "done", passed: true }),
    ]);
  });

  test("it reacted, then passed: the reaction was its answer, so its receipt is no pass", async () => {
    const react: ToolSource = {
      name: "react",
      tools: async () => [
        {
          name: "react",
          description: "React.",
          scope: "",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          describe: () => ({ title: "React" }),
          execute: async () => ({ content: "Reacted.", data: { reacted: { messageId: "m", reaction: "👍" } } }),
        },
      ],
    };
    let turn = 0;
    f = await setup({
      toolSources: [createPassToolSource(), react],
      reply: () => ({
        chunks: [],
        toolUses: [turn++ === 0 ? { name: "react", input: {} } : { name: "pass", input: { reason: "já reagi" } }],
      }),
    });
    const events = f.listen(f.general.id);
    await routed("o deploy saiu!");

    expect(await agentMessages()).toEqual([]);
    expect((await runRow())?.status).toBe("done");
    await Bun.sleep(5);
    expect(events.some((e) => e.type === "agent.passed")).toBe(false);
    expect(events.find((e) => e.type === "message.handled")).not.toHaveProperty("passed");
    const [listed] = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(listed?.receipts?.handled[0]?.passed).toBeUndefined();
  });

  test("a person writing into it keeps `pass` listed, so its tools never change mid-run; the tool refuses", async () => {
    const look: ToolSource = {
      name: "work",
      tools: async () => [
        {
          name: "look",
          description: "Look at the builds",
          scope: "context:read",
          inputSchema: { type: "object", properties: {} },
          execute: async (_input, ctx) => {
            const m = await insertMessage(ctx.db, {
              orgId: f.org.id,
              channelId: f.general.id,
              author: { type: "person", userId: f.owner.id },
              body: "e o staging?",
            });
            await queueOnRun(ctx.db, ctx.runId, m.id);
            return { content: "2 builds" };
          },
        },
      ],
    };
    f = await setup({
      toolSources: [createPassToolSource(), look],
      reply: (_req, n) =>
        n === 1
          ? { chunks: [], toolUses: [{ name: "look", input: {} }] }
          : n === 2
            ? { chunks: [], toolUses: [{ name: "pass", input: { reason: "nada" } }] }
            : { chunks: ["O staging está ok."] },
    });
    await routed("onde rodam os builds?");

    const [first, second] = f.provider.calls.map((c) => c.request as ModelRequest);
    expect(second?.tools).toEqual(first?.tools);
    expect(second?.tools?.map((t) => t.name)).toContain("pass");
    expect(await agentMessages()).toEqual(["O staging está ok."]);
    // It answered: its receipt is no pass.
    const person = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find(
      (m) => m.body === "onde rodam os builds?",
    );
    expect(person?.receipts?.handled).toEqual([expect.objectContaining({ agentId: f.agent.id, status: "done" })]);
    expect(person?.receipts?.handled[0]?.passed).toBeUndefined();
  });

  test("ending with only the word (or nothing) is a pass too", async () => {
    f = await setup({ reply: () => ({ chunks: ["Nada a acrescentar.\n\nNO_REPLY"] }) });
    const events = f.listen(f.general.id);
    await routed("bom dia, pessoal");
    expect(await agentMessages()).toEqual([]);
    expect(f.provider.calls.length).toBe(1);
    await Bun.sleep(5);
    expect(events.some((e) => e.type === "agent.passed")).toBe(true);
    expect(beforeMessage(events)).not.toContain("NO_REPLY");
  });

  test("another agent's reply to the same message since is read before the first call", async () => {
    f = await setup({ toolSources: [createPassToolSource()], reply: () => ({ chunks: ["NO_REPLY"] }) });
    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "onde rodam os builds?",
    });
    const theo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo", role: "Infra", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: theo.id, runId: crypto.randomUUID(), hop: 1 },
      body: "No GitHub Actions.",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, message, [f.agent.id], "router"));
    await drainOutbox(f.db, f.handlers);
    const request = f.provider.calls[0]?.request as ModelRequest;
    expect(textOf(request.messages.at(-1)?.content ?? "")).toContain(
      "[Meanwhile Theo (@theo) replied here]: No GitHub Actions.",
    );
    expect(await agentMessages()).toEqual(["No GitHub Actions."]);
  });

  test("brought in on another agent's message stored with microseconds: that message is never its own 'meanwhile'", async () => {
    f = await setup({ toolSources: [createPassToolSource()], reply: () => ({ chunks: ["NO_REPLY"] }) });
    const theo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo", role: "Infra", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: theo.id, runId: crypto.randomUUID(), hop: 1 },
      body: "Os builds rodam no GitHub Actions.",
    });
    // Postgres stores now() with microseconds; read back, `createdAt` is cut to milliseconds.
    await f.db
      .update(schema.messages)
      .set({ createdAt: sql`${schema.messages.createdAt} + interval '456 microseconds'` })
      .where(eq(schema.messages.id, said.id));
    const [trigger] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, said.id));
    await f.db.transaction((tx) => createAgentRuns(tx, trigger as typeof said, [f.agent.id], "router"));
    await drainOutbox(f.db, f.handlers);
    const request = f.provider.calls[0]?.request as ModelRequest;
    expect(textOf(request.messages.at(-1)?.content ?? "")).not.toContain("[Meanwhile Theo (@theo) replied here]");
  });
});

test("only code marks a follow-up: a model's words with the marker leave the agent free to stay quiet", async () => {
  f = await setup();
  const policyFor = async (reason: string) => {
    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "e agora?",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, message, [f.agent.id], "router"));
    await f.db.insert(schema.routingDecisions).values({
      orgId: f.org.id,
      channelId: f.general.id,
      messageId: message.id,
      strategy: "plan:claude_code",
      candidates: [{ agentId: f.agent.id, score: 1 }],
      selectedAgentIds: [f.agent.id],
      reason,
    });
    await f.db.update(schema.agentRuns).set({ status: "done" });
    return loadReplyPolicy(f.db, f.org.id, run?.id ?? "");
  };
  expect((await policyFor("plan: follow-up of the talk with dev"))?.mayPass).toBe(true);
  expect((await policyFor("follow-up; plan: the person asks dev again"))?.mayPass).toBe(false);
});

describe("background runs", () => {
  test("the final answer goes to closeRoutineRun, never to the conversation", async () => {
    f = await setup({ reply: () => ({ chunks: ["Tudo certo: 3 PRs abertos."] }) });
    await routed("@dev checa os PRs", { background: true, trigger: "mention" });
    expect(await agentMessages()).toEqual([]);
    const run = await runRow();
    expect(run?.status).toBe("done");
    expect(finished()).toEqual([{ runId: run?.id ?? "", text: "Tudo certo: 3 PRs abertos." }]);
  });

  test("quiet on purpose: an empty text", async () => {
    f = await setup({ reply: () => ({ chunks: ["Nada novo.\n\nNO_REPLY"] }) });
    await routed("@dev checa os PRs", { background: true, trigger: "mention" });
    expect(await agentMessages()).toEqual([]);
    expect(finished().map((x) => x.text)).toEqual([""]);
    expect(f.provider.calls.length).toBe(1);
  });
});

test("sessionFor: a conversation never picks up a background or routine run's session; background starts fresh", async () => {
  f = await setup();
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!agent) throw new Error("no agent");
  let at = Date.now() - 60_000;
  const runWith = async (session: string | null, over: { background?: boolean; routine?: boolean } = {}) => {
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "x",
      ...(over.routine ? { meta: { routine: { id: "r1", name: "PRs" } } } : {}),
    });
    at += 1000;
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: m.id,
        triggerMessageId: m.id,
        trigger: "mention",
        hop: 1,
        status: session ? "done" : "running",
        brainSessionId: session,
        background: over.background ?? false,
        createdAt: new Date(at),
        finishedAt: session ? new Date() : null,
      })
      .returning();
    if (!run) throw new Error("no run");
    return run;
  };
  await runWith("s-conversation");
  await runWith("s-background", { background: true });
  await runWith("s-routine", { routine: true });
  // A later conversation run shared the routine's session (the old bug): that session stays out too.
  await runWith("s-routine");

  const next = await runWith(null);
  const plan = await resolveBrain({ db: f.db }, agent, next, f.general.id);
  expect(plan.session?.id).toBe("s-conversation");

  const background = await runWith(null, { background: true });
  const fresh = await resolveBrain({ db: f.db }, agent, background, f.general.id);
  expect(fresh.session?.id).not.toBe("s-conversation");
  expect(fresh.session?.resume).toBe(false);
});
