import { afterAll, afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  addRunStep,
  type Brain,
  type BrainEvent,
  cancelRun,
  claimJobs,
  createAgent,
  createAgentRuns,
  createChannel,
  createJobHandlers,
  createPassToolSource,
  drainOutbox,
  enqueue,
  executeToolForRun,
  insertMessage,
  invokeToolForRun,
  issueRunToolToken,
  LONG_JOB_KINDS,
  type MachineStatus,
  mayFallBack,
  openDm,
  postPauseCards,
  queueOnRun,
  type RoutineBrief,
  recordAgentActions,
  recoverStaleRuns,
  releaseInbox,
  runBrainOf,
  STUCK_END_NOTE,
  STUCK_NOTE,
  type ToolSource,
  WRAP_UP_NOTE,
} from "../src";
import { deliverNotice } from "../src/delivery";
import * as ledger from "../src/routine-ledger";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * ADR 0053 in the run executor and the shared engine base: a routine's background run never posts by
 * itself on any path and closes its ledger on every ending, never falls back to the API brain, posts its
 * pause cards where it reports; a run's effective brain is stored; reading a person's message owes them
 * an answer; receipts go out instead of a pass; nothing is lost at the cap; report-woken messages link
 * to their routine run; a background run near its cap wraps up; recovery revokes stale bridge tokens.
 */

// PGlite setup on a slow machine.
setDefaultTimeout(30_000);

/** Every ending of a background run goes through `closeRoutineRun`: what it was told. */
const closeSpy = spyOn(ledger, "closeRoutineRun");
afterAll(() => closeSpy.mockRestore());
const ends = () => closeSpy.mock.calls.map(([, run, end]) => ({ runId: run.id, ...end }));

let f: Fixture;
afterEach(async () => {
  closeSpy.mockClear();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => {
  const last = req.messages.at(-1);
  return last ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : "";
};
const agentMessages = async () =>
  (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent" && !m.meta.notice);
const runById = async (id: string) =>
  (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
const routineRunById = async (id: string) =>
  (await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, id)))[0];

/** A read tool, a sensitive one (an approval) and one that records a receipt (an undoable change). */
function workTools(over: { onLook?: (ctx: { runId: string; db: Fixture["db"] }) => Promise<void> } = {}): ToolSource {
  return {
    name: "work",
    tools: async () => [
      {
        name: "look",
        description: "Look at the open pull requests",
        scope: "context:read",
        inputSchema: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          await over.onLook?.(ctx);
          return { content: "3 PRs open" };
        },
      },
      {
        name: "deploy_app",
        description: "Deploy the app",
        scope: "",
        sensitive: true,
        inputSchema: { type: "object", properties: { env: { type: "string" } } },
        describe: () => ({ title: "Deploy to production" }),
        execute: async () => ({ content: "deployed" }),
      },
      {
        name: "file_issue",
        description: "File an issue",
        // A scope every agent has by default (an internal change people can undo).
        scope: "drive:write",
        inputSchema: { type: "object", properties: {} },
        execute: async (_input, ctx) => {
          await recordAgentActions(ctx.db, ctx, [
            { kind: "issue.created", target: { type: "issue", id: crypto.randomUUID(), number: 7, title: "Bug" } },
          ]);
          return { content: "Issue #7 created" };
        },
      },
    ],
  };
}

/**
 * A routine's background run, as the routine engine fires it: a brief in the routine's own room (here a
 * plain channel standing in for it), delivering to #general. Not executed yet.
 */
async function backgroundRun(options: { access?: "read" | "act"; body?: string } = {}) {
  const room = await createChannel(f.db, f.owner.id, f.org.id, { name: `rotina-${crypto.randomUUID().slice(0, 8)}` });
  await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
  const [routine] = await f.db
    .insert(schema.routines)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      name: "Vigiar PRs",
      prompt: "Confira os PRs abertos.",
      target: { type: "channel", channelId: f.general.id },
      triggerType: "schedule",
      createdByUserId: f.owner.id,
    })
    .returning();
  if (!routine) throw new Error("no routine");
  const [routineRun] = await f.db
    .insert(schema.routineRuns)
    .values({ orgId: f.org.id, routineId: routine.id, at: new Date(), trigger: "schedule", status: "started" })
    .returning();
  if (!routineRun) throw new Error("no routine run");
  const brief: RoutineBrief = {
    routineId: routine.id,
    routineRunId: routineRun.id,
    name: routine.name,
    creatorUserId: f.owner.id,
    deliverTo: { channelId: f.general.id, threadId: null },
    access: options.access ?? "act",
    report: "when_new",
    trigger: "schedule",
    dueAt: new Date().toISOString(),
  };
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: room.id,
    author: { type: "person", userId: f.owner.id },
    body: options.body ?? routine.prompt,
    meta: {
      routineBrief: brief,
      routine: { id: routine.id, name: routine.name, runId: routineRun.id },
      background: true,
    },
  });
  const [run] = await f.db.transaction((tx) =>
    createAgentRuns(tx, message, [f.agent.id], "mention", { background: true }),
  );
  if (!run) throw new Error("no run");
  await f.db.update(schema.routineRuns).set({ agentRunId: run.id }).where(eq(schema.routineRuns.id, routineRun.id));
  return { run, routine, routineRun, room, message, brief };
}

const RUNNER = {
  hostname: "mac",
  os: "darwin" as const,
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const statusOf = (machineId: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

/** Pairs a computer and makes it the agent's, thinking with Claude Code. */
async function computerAgent() {
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, f.owner.id, f.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await f.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  return paired.machineId;
}

/** A Claude Code stand-in that replays a script per turn. */
function scriptedBrain(script: (n: number, turn: Parameters<Brain["run"]>[0]) => AsyncIterable<BrainEvent>) {
  let n = 0;
  const brain: Brain = {
    kind: "claude_code",
    run(turn) {
      return script(n++, turn);
    },
  };
  return { brain, turns: () => n };
}

describe("a routine's background run never posts by itself", () => {
  test("its final answer is its record: the ledger closes silent, nothing is posted", async () => {
    f = await setup({ reply: () => ({ chunks: ["Nada novo desde ontem."] }) });
    const { run, routineRun } = await backgroundRun();
    await drainOutbox(f.db, f.handlers);

    expect((await runById(run.id))?.status).toBe("done");
    expect(await agentMessages()).toEqual([]);
    expect(ends()).toEqual([{ runId: run.id, status: "done", text: "Nada novo desde ontem." }]);
    expect(await routineRunById(routineRun.id)).toMatchObject({ status: "silent", summary: "Nada novo desde ontem." });
  });

  test("a failure: nothing posted, the ledger fails with the run's error code", async () => {
    f = await setup({
      toolSources: [workTools()],
      reply: () => ({ chunks: [], toolUses: [{ name: "look", input: {} }] }),
    });
    const handlers = createJobHandlers({ ...f.jobDeps, maxToolTurns: 1 });
    const { run, routineRun } = await backgroundRun();
    await drainOutbox(f.db, handlers);

    expect(await runById(run.id)).toMatchObject({ status: "failed", error: "too_many_tool_calls" });
    expect(await agentMessages()).toEqual([]);
    expect(ends()).toEqual([{ runId: run.id, status: "failed", code: "too_many_tool_calls" }]);
    expect(await routineRunById(routineRun.id)).toMatchObject({ status: "failed", code: "too_many_tool_calls" });
  });

  test("stopped by a person while it works: quiet, the ledger says who stopped it", async () => {
    f = await setup({
      toolSources: [
        workTools({
          onLook: async (ctx) => {
            await cancelRun({ db: ctx.db, pubsub: f.pubsub }, f.owner.id, f.org.id, ctx.runId);
          },
        }),
      ],
      reply: () => ({ chunks: ["Olhando os PRs."], toolUses: [{ name: "look", input: {} }] }),
    });
    const { run, routineRun, room } = await backgroundRun();
    const general = f.listen(f.general.id);
    const inRoom = f.listen(room.id);
    await drainOutbox(f.db, f.handlers);

    expect((await runById(run.id))?.status).toBe("canceled");
    expect(await agentMessages()).toEqual([]);
    expect(ends()).toContainEqual({ runId: run.id, status: "canceled", code: "stopped", byUserId: f.owner.id });
    expect(await routineRunById(routineRun.id)).toMatchObject({ status: "canceled", code: "stopped" });
    // Nothing in a conversation: no "stopped by" line, no stop event; the run's own events say background.
    expect([...general, ...inRoom].some((e) => e.type === "run.canceled")).toBe(false);
    const states = inRoom.filter((e) => e.type === "agent.run") as { background?: boolean }[];
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((e) => e.background === true)).toBe(true);
  });

  test("an approval: no narration, the card goes where it reports; a stop while it waits is quiet too", async () => {
    f = await setup({
      toolSources: [workTools()],
      reply: () => ({
        chunks: ["O erro voltou; vou pedir o deploy."],
        toolUses: [{ name: "deploy_app", input: { env: "prod", why: "O erro 500 voltou depois do deploy 2.14." } }],
      }),
    });
    const { run, routineRun, room } = await backgroundRun();
    const general = f.listen(f.general.id);
    await drainOutbox(f.db, f.handlers);

    expect((await runById(run.id))?.status).toBe("waiting_approval");
    const posted = await agentMessages();
    // Only the card, in #general (where it reports), never in its room; the narration isn't posted.
    expect(posted).toHaveLength(1);
    const [card] = posted;
    expect(card).toMatchObject({ channelId: f.general.id, threadId: null, meta: { bodyCode: "approval_request" } });
    expect(posted.some((m) => m.channelId === room.id)).toBe(false);
    expect(posted.some((m) => m.body.includes("vou pedir o deploy"))).toBe(false);
    const [approval] = await f.db.select().from(schema.approvals);
    expect(approval).toMatchObject({ channelId: f.general.id, messageId: card?.id, threadRootId: card?.id });
    expect(general.some((e) => e.type === "approval.created")).toBe(true);
    expect(ends()).toEqual([]);

    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run.id);
    expect(ends()).toEqual([{ runId: run.id, status: "canceled", code: "stopped", byUserId: f.owner.id }]);
    expect(await routineRunById(routineRun.id)).toMatchObject({ status: "canceled", code: "stopped" });
    expect(general.some((e) => e.type === "run.canceled")).toBe(false);
    expect((await f.db.select().from(schema.approvals))[0]?.status).toBe("canceled");
  });

  test("a computer brain's bridged approval: the same card, where it reports", async () => {
    f = await setup({ toolSources: [workTools()] });
    const { run, room } = await backgroundRun();
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "running",
        startedAt: new Date(),
        transcript: { system: [], messages: [], postedUpTo: 0, postedCount: 0, deltaSeq: 0 },
      })
      .where(eq(schema.agentRuns.id, run.id));
    const inRoom = f.listen(room.id);

    const out = await invokeToolForRun(
      { db: f.db, pubsub: f.pubsub, tools: f.tools },
      { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId: "" },
      { id: "call-1", name: "deploy_app", input: { env: "prod", why: "O erro 500 voltou depois do deploy 2.14." } },
    );
    expect(out.result.pause?.kind).toBe("approval");
    const posted = await agentMessages();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      channelId: f.general.id,
      threadId: null,
      meta: { bodyCode: "approval_request" },
    });
    expect((await f.db.select().from(schema.approvals))[0]?.channelId).toBe(f.general.id);
    expect(inRoom.find((e) => e.type === "agent.run")).toMatchObject({ status: "waiting_approval", background: true });
  });

  test("postPauseCards: an approval card carries the agent's why and where it came from", async () => {
    f = await setup();
    const { run, routine } = await backgroundRun();
    const origin = { kind: "routine", routineId: routine.id, routineName: routine.name };
    const [approval] = await f.db
      .insert(schema.approvals)
      .values({
        orgId: f.org.id,
        runId: run.id,
        agentId: f.agent.id,
        channelId: run.channelId,
        threadRootId: run.threadRootId,
        toolUseId: "toolu_1",
        tool: "deploy_app",
        scope: "",
        params: { env: "prod" },
        actionHash: "hash",
        title: "Deploy to production",
        why: "O erro 500 voltou depois do deploy 2.14.",
        origin,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    if (!approval) throw new Error("no approval");
    const posted = await f.db.transaction((tx) =>
      postPauseCards(tx, run, { approvals: [approval], questions: [], secretRequestIds: [] }),
    );
    expect(posted.messages).toHaveLength(1);
    expect(posted.messages[0]).toMatchObject({
      channelId: f.general.id,
      meta: { approvalId: approval.id, why: "O erro 500 voltou depois do deploy 2.14.", origin },
    });
    expect(posted.approvals[0]).toMatchObject({ channelId: f.general.id, messageId: posted.messages[0]?.id });
  });

  test("cut off by a deploy: nothing posted, the ledger fails as interrupted", async () => {
    f = await setup();
    const { run, routineRun } = await backgroundRun();
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "running",
        startedAt: new Date(Date.now() - 20 * 60_000),
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        transcript: {
          system: [],
          messages: [{ role: "assistant", content: [{ type: "text", text: "Olhando…" }] }],
          postedUpTo: 0,
          postedCount: 0,
          deltaSeq: 0,
        },
      })
      .where(eq(schema.agentRuns.id, run.id));
    // A tool started and never reported back: unsafe to repeat. Its job was held by the worker that died.
    await addRunStep(f.db, run, "tool_call", { toolUseId: "toolu_cut", name: "look", input: {} });
    await f.db
      .update(schema.outbox)
      .set({ status: "processing", lockedUntil: new Date(Date.now() + 600_000), lockedBy: "dead" })
      .where(eq(schema.outbox.kind, "agent_run.execute"));

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([run.id]);
    expect(await agentMessages()).toEqual([]);
    expect(ends()).toEqual([{ runId: run.id, status: "failed", code: "interrupted" }]);
    expect(await routineRunById(routineRun.id)).toMatchObject({ status: "failed", code: "interrupted" });
  });

  test("a computer brain cut off after a tool ran: nothing posted, the ledger fails with its code", async () => {
    let checks = 0;
    const env: ToolSource = {
      name: "env",
      tools: async () => [
        {
          name: "check_env",
          description: "Check the environment",
          scope: "context:read",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            checks++;
            return { content: "go: not found" };
          },
        },
      ],
    };
    f = await setup({ toolSources: [env], reply: () => ({ chunks: ["Respondi pela API."] }) });
    const machineId = await computerAgent();
    const { brain } = scriptedBrain(async function* (_n, turn) {
      const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
      const result = await executeToolForRun(f.jobDeps, id, { id: "c-1", name: "check_env", input: {} });
      yield { type: "text_delta", text: "Verifiquei o ambiente." };
      yield { type: "tool_call", id: "c-1", name: "check_env", input: {}, executed: result };
      yield { type: "error", code: "executor_crashed", message: "Claude Code exited", retryable: true };
    });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      brains: { claude_code: () => brain },
      machines: { status: async (id) => statusOf(id) },
    });
    const { run, routineRun } = await backgroundRun();
    await drainOutbox(f.db, handlers);

    expect(checks).toBe(1);
    expect((await runById(run.id))?.status).toBe("failed");
    expect(await agentMessages()).toEqual([]);
    expect(f.provider.calls).toHaveLength(0);
    expect(ends()).toEqual([
      { runId: run.id, status: "failed", code: "executor_crashed", detail: "Claude Code exited" },
    ]);
    expect(await routineRunById(routineRun.id)).toMatchObject({ status: "failed", code: "executor_crashed" });
  });

  test("near its cap a model run is told once to wrap up, with its tools still there", async () => {
    f = await setup({
      toolSources: [workTools()],
      reply: (req) =>
        lastText(req).includes(WRAP_UP_NOTE)
          ? { chunks: ["Resumo: 3 PRs abertos, nenhum novo."] }
          : { chunks: [], toolUses: [{ name: "look", input: {} }] },
    });
    const handlers = createJobHandlers({ ...f.jobDeps, maxToolTurns: 4 });
    const { run } = await backgroundRun();
    await drainOutbox(f.db, handlers);

    const requests = f.provider.calls.map((c) => c.request);
    expect(requests).toHaveLength(3);
    expect(lastText(requests[1] as ModelRequest)).not.toContain(WRAP_UP_NOTE);
    expect(lastText(requests[2] as ModelRequest)).toContain(WRAP_UP_NOTE);
    expect(requests[2]?.tools?.map((t) => t.name)).toContain("look");
    expect((await runById(run.id))?.status).toBe("done");
    expect(ends()).toEqual([{ runId: run.id, status: "done", text: "Resumo: 3 PRs abertos, nenhum novo." }]);
  });

  test("going in circles: one note, then told to hand off what it has, then it fails as stuck in its ledger", async () => {
    f = await setup({
      toolSources: [workTools()],
      judge: (kind) => (kind === "stuck_run" ? 0.9 : undefined),
      reply: () => ({ chunks: [], toolUses: [{ name: "look", input: {} }] }),
    });
    const { run, routineRun } = await backgroundRun();
    await drainOutbox(f.db, f.handlers);

    const requests = f.provider.calls.map((c) => c.request);
    expect(requests).toHaveLength(8);
    expect(lastText(requests[3] as ModelRequest)).toContain(STUCK_NOTE);
    expect(lastText(requests[6] as ModelRequest)).toContain(STUCK_END_NOTE);
    expect(await runById(run.id)).toMatchObject({ status: "failed", error: "stuck" });
    expect(await agentMessages()).toEqual([]);
    expect(await routineRunById(routineRun.id)).toMatchObject({ status: "failed", code: "stuck" });
  });

  test("going in circles, it does as told and ends with its record: the routine run still fails as stuck", async () => {
    const record = "Olhei os PRs 6 vezes e nada mudou.";
    f = await setup({
      toolSources: [workTools()],
      judge: (kind) => (kind === "stuck_run" ? 0.9 : undefined),
      reply: (req) =>
        lastText(req).includes(STUCK_END_NOTE)
          ? { chunks: [record] }
          : { chunks: [], toolUses: [{ name: "look", input: {} }] },
    });
    const { run, routine, routineRun } = await backgroundRun();
    await drainOutbox(f.db, f.handlers);

    expect(f.provider.calls).toHaveLength(7);
    expect(await runById(run.id)).toMatchObject({ status: "failed", error: "stuck" });
    expect(ends()).toEqual([{ runId: run.id, status: "failed", code: "stuck", detail: record }]);
    expect(await routineRunById(routineRun.id)).toMatchObject({ status: "failed", code: "stuck", summary: record });
    // A failure like any other: a routine stuck on every firing is paused as a failing one.
    const [after] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
    expect(after?.failuresInRow).toBe(1);
  });
});

describe("the brain a run thinks with", () => {
  test("a background run never falls back to the API: it waits quietly for its computer", async () => {
    f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
    const machineId = await computerAgent();
    const { brain, turns } = scriptedBrain(async function* () {
      yield { type: "done", text: "Voltei." };
    });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      brains: { claude_code: () => brain },
      machines: { status: async (id) => statusOf(id, { online: false }) },
    });
    const { run, routineRun } = await backgroundRun();
    await drainOutbox(f.db, handlers);

    // A model credential exists, yet nothing stands in: no API call, no note, the run waits.
    expect(await runById(run.id)).toMatchObject({
      status: "waiting_input",
      waitingMachineId: machineId,
      brain: "claude_code",
    });
    expect(turns()).toBe(0);
    expect(f.provider.calls).toHaveLength(0);
    expect(await agentMessages()).toEqual([]);
    expect(ends()).toEqual([]);
    expect((await routineRunById(routineRun.id))?.brain).toBe("claude_code");
  });

  test("a conversation run stores its brain, and the model when it falls back", async () => {
    f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
    await computerAgent();
    const { brain } = scriptedBrain(async function* () {
      yield { type: "limit", resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() };
    });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      brains: { claude_code: () => brain },
      machines: { status: async (id) => statusOf(id) },
    });
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "oi",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "mention"));
    await drainOutbox(f.db, handlers);

    const after = await runById(run?.id ?? "");
    expect(after).toMatchObject({ status: "done", brain: "model" });
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.brain).toBe("claude_code");
    expect(runBrainOf(after ?? {}, agent)).toBe("model");
  });

  test("runBrainOf and mayFallBack", () => {
    expect(runBrainOf({ brain: "model" }, { brain: "claude_code" })).toBe("model");
    expect(runBrainOf({ brain: null }, { brain: "codex" })).toBe("codex");
    expect(runBrainOf({ brain: "something" }, null)).toBe("model");
    expect(mayFallBack({ brainFallback: true }, { background: false })).toBe(true);
    expect(mayFallBack({ brainFallback: true }, { background: true })).toBe(false);
    expect(mayFallBack({ brainFallback: false }, { background: false })).toBe(false);
  });
});

describe("what a run owes", () => {
  /** A note from another agent (`agent_note`) waking the agent in #general. */
  async function noteRun(text = "Mudei a variável DATABASE_URL.") {
    const delivered = await f.db.transaction((tx) =>
      deliverNotice(tx, {
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadId: null,
        hop: 0,
        stretchId: null,
        notice: { kind: "agent_note", text, from: "@infra", refs: {} },
      }),
    );
    const [run] = delivered.runs;
    if (!run) throw new Error("no run");
    return { run, notice: delivered.message };
  }

  test("a run a note woke may pass", async () => {
    f = await setup({
      toolSources: [createPassToolSource()],
      reply: () => ({ chunks: [], toolUses: [{ name: "pass", input: { reason: "nada a fazer" } }] }),
    });
    const { run } = await noteRun();
    await drainOutbox(f.db, f.handlers);
    expect((await runById(run.id))?.status).toBe("done");
    expect(await agentMessages()).toEqual([]);
  });

  test("a person writes into it while it works: it owes them an answer and acts for them", async () => {
    let notice = "";
    f = await setup({
      toolSources: [
        createPassToolSource(),
        workTools({
          onLook: async (ctx) => {
            const m = await insertMessage(ctx.db, {
              orgId: f.org.id,
              channelId: f.general.id,
              threadId: notice,
              author: { type: "person", userId: f.owner.id },
              body: "e o staging?",
            });
            await queueOnRun(ctx.db, ctx.runId, m.id);
          },
        }),
      ],
      reply: (_req, call) =>
        call === 1
          ? { chunks: [], toolUses: [{ name: "look", input: {} }] }
          : call === 2
            ? { chunks: [], toolUses: [{ name: "pass", input: { reason: "nada" } }] }
            : { chunks: ["O staging também foi atualizado."] },
    });
    const woken = await noteRun();
    notice = woken.notice.id;
    await drainOutbox(f.db, f.handlers);

    const after = await runById(woken.run.id);
    expect(after?.status).toBe("done");
    expect(after?.transcript).toMatchObject({ answerOwed: true, steeredBy: f.owner.id });
    // The pass went nowhere: it answered the person.
    expect((await agentMessages()).map((m) => m.body)).toEqual(["O staging também foi atualizado."]);
  });

  test("a person's message to another agent in the thread is only context: it may still pass, nobody behind it", async () => {
    let notice = "";
    f = await setup({
      toolSources: [
        createPassToolSource(),
        workTools({
          onLook: async (ctx) => {
            const m = await insertMessage(ctx.db, {
              orgId: f.org.id,
              channelId: f.general.id,
              threadId: notice,
              author: { type: "person", userId: f.owner.id },
              body: "@qa e o staging?",
            });
            await queueOnRun(ctx.db, ctx.runId, m.id);
          },
        }),
      ],
      reply: (_req, call) =>
        call === 1
          ? { chunks: [], toolUses: [{ name: "look", input: {} }] }
          : { chunks: [], toolUses: [{ name: "pass", input: { reason: "é com o QA" } }] },
    });
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa", role: "QA", instructions: "Test the app.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: qa.id });
    const woken = await noteRun();
    notice = woken.notice.id;
    await drainOutbox(f.db, f.handlers);

    const after = await runById(woken.run.id);
    expect(after?.status).toBe("done");
    expect(after?.transcript).not.toHaveProperty("answerOwed");
    expect(after?.transcript).not.toHaveProperty("steeredBy");
    // It passed: the person was talking to QA (whose own run answers them).
    expect((await agentMessages()).filter((m) => m.authorAgentId === f.agent.id)).toEqual([]);
  });

  test("a run that changed something posts its receipts instead of passing", async () => {
    f = await setup({
      toolSources: [createPassToolSource(), workTools()],
      reply: (_req, call) =>
        call === 1
          ? { chunks: [], toolUses: [{ name: "file_issue", input: {} }] }
          : { chunks: [], toolUses: [{ name: "pass", input: { reason: "já registrei" } }] },
    });
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "o checkout quebrou de novo",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "router"));
    await drainOutbox(f.db, f.handlers);

    expect((await runById(run?.id ?? ""))?.status).toBe("done");
    const posted = await agentMessages();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.meta).toMatchObject({ bodyCode: "done" });
    const [action] = await f.db.select().from(schema.agentActions);
    expect(action?.messageId).toBe(posted[0]?.id ?? "");
  });

  test("a message read at the cap is never lost: it gets a run of its own", async () => {
    let queued = "";
    let looks = 0;
    f = await setup({
      toolSources: [
        workTools({
          onLook: async (ctx) => {
            looks++;
            if (looks !== 2) return;
            const m = await insertMessage(ctx.db, {
              orgId: f.org.id,
              channelId: f.general.id,
              threadId: null,
              author: { type: "person", userId: f.owner.id },
              // No mention: only the run's inbox brings it to the agent.
              body: "MSG-M e o staging?",
            });
            queued = m.id;
            await queueOnRun(ctx.db, ctx.runId, m.id);
          },
        }),
      ],
      reply: (req) =>
        lastText(req).includes("MSG-M")
          ? { chunks: ["Visto."] }
          : { chunks: [], toolUses: [{ name: "look", input: {} }] },
    });
    const handlers = createJobHandlers({ ...f.jobDeps, maxToolTurns: 2 });
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "olha os PRs",
    });
    const [first] = await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "mention"));
    const events = f.listen(f.general.id);
    await drainOutbox(f.db, handlers);

    expect(await runById(first?.id ?? "")).toMatchObject({ status: "done", error: null });
    // Never marked read by the run that ended at the cap.
    const read = events.filter((e) => e.type === "agent.run.read" && e.runId === first?.id) as {
      messageIds?: string[];
    }[];
    expect(read.some((e) => e.messageIds?.includes(queued))).toBe(false);
    const [own] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, queued));
    expect(own).toMatchObject({ trigger: "mention", status: "done" });
  });
});

describe("handing on unread messages", () => {
  test("the new run's trigger matches the message: a person or a notice is a mention, in a DM a DM", async () => {
    f = await setup();
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "alguém viu o deploy?",
    });
    const [routed] = await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "router"));
    if (!routed) throw new Error("no run");
    const more = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: ask.id,
      author: { type: "person", userId: f.owner.id },
      body: "e o staging?",
    });
    await queueOnRun(f.db, routed.id, more.id);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, routed.id));
    const handed = await releaseInbox(f.db, f.pubsub, routed, { reason: "done" });
    expect((await runById(handed?.runId ?? ""))?.trigger).toBe("mention");

    // A notice handed on from a router run: a mention too.
    const [other] = await f.db.transaction(async (tx) => {
      const m = await insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: "bom dia",
      });
      return createAgentRuns(tx, m, [f.agent.id], "router");
    });
    if (!other) throw new Error("no run");
    const note = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: other.threadRootId,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Nota",
      meta: { notice: { kind: "agent_note", text: "Nota", refs: {} } },
    });
    await queueOnRun(f.db, other.id, note.id);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, other.id));
    const fromNote = await releaseInbox(f.db, f.pubsub, other, { reason: "done" });
    expect((await runById(fromNote?.runId ?? ""))?.trigger).toBe("mention");

    // A person's message in a DM, handed on from a run a notice started there: a DM.
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const dmNote = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Nota",
      meta: { notice: { kind: "agent_note", text: "Nota", refs: {} } },
    });
    const [inDm] = await f.db.transaction((tx) => createAgentRuns(tx, dmNote, [f.agent.id], "mention"));
    if (!inDm) throw new Error("no run");
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: f.owner.id },
      body: "valeu, e agora?",
    });
    await queueOnRun(f.db, inDm.id, said.id);
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, inDm.id));
    const fromDm = await releaseInbox(f.db, f.pubsub, inDm, { reason: "done" });
    expect((await runById(fromDm?.runId ?? ""))?.trigger).toBe("dm");
  });
});

describe("the run a routine's report woke", () => {
  test("its message carries the routine, and the routine run links to it", async () => {
    f = await setup({ reply: () => ({ chunks: ["Erro novo no checkout: 12 ocorrências desde as 9h."] }) });
    const { routine, routineRun, run: background } = await backgroundRun();
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, background.id));
    const delivered = await f.db.transaction((tx) =>
      deliverNotice(tx, {
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadId: null,
        hop: 0,
        stretchId: null,
        notice: {
          kind: "routine_handoff",
          text: "12 erros novos no checkout desde as 9h.",
          from: `Routine «${routine.name}»`,
          refs: {
            runId: background.id,
            routineId: routine.id,
            routineRunId: routineRun.id,
            routineName: routine.name,
            report: "when_new",
          },
        },
      }),
    );
    await drainOutbox(f.db, f.handlers);

    const posted = await agentMessages();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.meta.routine).toEqual({
      id: routine.id,
      name: routine.name,
      runId: routineRun.id,
      noticeId: delivered.message.id,
    });
    expect((await routineRunById(routineRun.id))?.messageId).toBe(posted[0]?.id ?? "");
  });
});

describe("recovery", () => {
  test("a stale computer-brain run's turn tokens are revoked before it is sent again", async () => {
    f = await setup();
    const machineId = await computerAgent();
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "roda os testes",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "mention"));
    if (!run) throw new Error("no run");
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "running",
        brain: "claude_code",
        startedAt: new Date(Date.now() - 20 * 60_000),
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
        transcript: { system: [], messages: [], postedUpTo: 0, postedCount: 0, deltaSeq: 0 },
      })
      .where(eq(schema.agentRuns.id, run.id));
    await issueRunToolToken(f.db, { orgId: f.org.id, agentId: f.agent.id, machineId, runId: run.id });
    // Its job was claimed by the worker that died.
    await f.db
      .update(schema.outbox)
      .set({ status: "processing", lockedUntil: new Date(Date.now() + 600_000), lockedBy: "dead" });

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([run.id]);
    const tokens = await f.db.select().from(schema.runToolTokens).where(eq(schema.runToolTokens.runId, run.id));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revokedAt).not.toBeNull();
  });
});

describe("the outbox", () => {
  test("a background run's job counts as background work: capped, while a person's run is claimed", async () => {
    f = await setup();
    await backgroundRun();
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "oi",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "mention"));
    await enqueue(f.db, { orgId: f.org.id, kind: "routine.run", payload: { routineRunId: crypto.randomUUID() } });

    const waits: { ms: number; attrs: Record<string, unknown> }[] = [];
    const first = await claimJobs(f.db, {
      workerId: "w",
      batchSize: 100,
      maxBackground: 0,
      onTiming: (name, ms, attrs) => {
        if (name === "queue_wait_ms") waits.push({ ms, attrs });
      },
    });
    // Everything else first (the person's run among it), no background job.
    expect(first.some((j) => j.kind === "agent_run.execute")).toBe(true);
    expect(first.every((j) => !j.background && j.kind !== "routine.run")).toBe(true);
    expect(waits).toHaveLength(first.length);
    expect(waits.every((w) => w.ms >= 0 && w.attrs.background === false)).toBe(true);
    const rest = await claimJobs(f.db, { workerId: "w", maxBackground: 5 });
    expect(rest.map((j) => j.background)).toEqual([true, true]);
    expect(rest.map((j) => j.kind).sort()).toEqual(["agent_run.execute", "routine.run"]);
  });

  test("every long job kind is one the core runs", async () => {
    f = await setup();
    expect(LONG_JOB_KINDS.filter((kind) => !f.handlers[kind])).toEqual([]);
  });
});
