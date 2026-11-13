import { afterEach, expect, test } from "bun:test";
import {
  ACCOUNTS_PROTOCOL,
  BRAIN_PROFILES_PROTOCOL,
  BRAIN_PROTOCOL,
  brainTopic,
  CONVERSATION_PROTOCOL,
  createMemoryPubSub,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  type PubSub,
  type ServerFrame,
  type WireBrainEvent,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type BrainEvent,
  type BrainTurn,
  brainSessionId,
  claudeCodeAvailability,
  createClaudeCodeBrain,
  createJobHandlers,
  drainOutbox,
  listMessages,
  type MachineCallOptions,
  MachineDroppedError,
  MachineOfflineError,
  MachineRequestError,
  type MachineStatus,
  postPersonMessage,
  recordPlanUsage,
  restatesReaction,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined;
  await current?.close();
});

const MACHINE = "0193cccc-0000-7000-8000-000000000001";
const RUN = "0193bbbb-0000-7000-8000-000000000001";
const SESSION = "0193aaaa-0000-7000-8000-000000000001";

const status = (over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: MACHINE,
  orgId: "org",
  name: "mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: BRAIN_PROTOCOL,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

const turn = (over: Partial<BrainTurn> = {}): BrainTurn => ({
  runId: RUN,
  orgId: "org",
  agentId: "agent-1",
  channelId: "ch",
  threadRootId: null,
  system: "You are dev.",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  model: "opus",
  session: { id: SESSION, resume: false, machineId: MACHINE, cwd: "" },
  trigger: "hi",
  ...over,
});

const io = (signal = new AbortController().signal) => ({
  signal,
  executeTool: async () => ({ content: "never called" }),
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/**
 * A hub whose machine answers `brain.turn` like a runner: its events go out
 * on the run's topic (as the real hub publishes them) and the request
 * resolves with the final one.
 */
function fakeHub(
  pubsub: PubSub,
  opts: {
    status?: MachineStatus | null;
    events?: WireBrainEvent[];
    final?: WireBrainEvent;
    /** Don't publish the stream (lost events): only the reply ends the turn. */
    silent?: boolean;
    from?: string;
    fail?: Error;
  } = {},
) {
  const calls: { machineId: string; request: MachineRequest; options?: MachineCallOptions }[] = [];
  const hub = {
    status: async () => (opts.status === undefined ? status() : opts.status),
    call: async (machineId: string, request: MachineRequest, options?: MachineCallOptions) => {
      calls.push({ machineId, request, ...(options ? { options } : {}) });
      if (opts.fail) throw opts.fail;
      const runId = (request as { runId: string }).runId;
      const final = opts.final ?? { type: "done", text: "Hello world", session: { id: SESSION } };
      if (!opts.silent) {
        for (const event of [...(opts.events ?? []), final]) {
          await pubsub.publish(brainTopic(runId), { type: "brain.event", machineId: opts.from ?? machineId, event });
        }
        await pubsub.publish(brainTopic(runId), { type: "brain.done", machineId: opts.from ?? machineId });
      }
      return { runId, final } as never;
    },
  };
  return { hub, calls };
}

const brainWith = (pubsub: PubSub, hub: ReturnType<typeof fakeHub>["hub"]) =>
  createClaudeCodeBrain({
    hub,
    pubsub,
    agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
    finalGraceMs: 20,
  });

test("a turn goes to the agent's computer as brain.turn and streams its events back", async () => {
  const pubsub = createMemoryPubSub();
  const { hub, calls } = fakeHub(pubsub, {
    events: [
      { type: "text_delta", text: "Hello " },
      { type: "tool_call", id: "t1", name: "search_context", input: { query: "x" }, executed: { content: "found" } },
      { type: "text_delta", text: "world" },
      { type: "usage", input: 16, output: 7, source: "plan", model: "claude-opus-5-5" },
    ],
  });
  const events = await collect(brainWith(pubsub, hub).run(turn(), io()));
  expect(events).toEqual([
    { type: "text_delta", text: "Hello " },
    { type: "tool_call", id: "t1", name: "search_context", input: { query: "x" }, executed: { content: "found" } },
    { type: "text_delta", text: "world" },
    { type: "usage", input: 16, output: 7, source: "plan", model: "claude-opus-5-5" },
    { type: "done", text: "Hello world", session: { id: SESSION } },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.machineId).toBe(MACHINE);
  expect(calls[0]?.request).toMatchObject({
    op: "brain.turn",
    runId: RUN,
    kind: "claude_code",
    agent: { id: "agent-1", handle: "dev" },
    session: { id: SESSION, resume: false },
    cwd: "",
    model: "opus",
    system: "You are dev.",
    prompt: "hi",
    keepAlive: true,
    personalMcp: false,
  });
  const sent = calls[0]?.request as { mcp?: { token?: string } } | undefined;
  expect(sent?.mcp?.token?.length ?? 0).toBeGreaterThan(20);
});

test("before a chat turn: the agent's checkouts set where it starts and add # Your code; a failure changes nothing", async () => {
  const pubsub = createMemoryPubSub();
  const { hub, calls } = fakeHub(pubsub);
  const seen: BrainTurn[] = [];
  const brain = (prepare: (t: BrainTurn) => Promise<{ cwd: string; prompt: string; start?: string } | null>) =>
    createClaudeCodeBrain({
      hub,
      pubsub,
      agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
      finalGraceMs: 20,
      prepare: async (t) => {
        seen.push(t);
        return prepare(t);
      },
    });
  await collect(
    brain(async () => ({
      cwd: "repos/acme/app",
      prompt: "# Your code\nacme/app is checked out at /w/repos/acme/app",
      start: "You start in /w/repos/acme/app.",
    })).run(turn(), io()),
  );
  expect(seen).toHaveLength(1);
  expect(calls[0]?.request).toMatchObject({
    cwd: "repos/acme/app",
    system: "You are dev.\n\n# Your code\nacme/app is checked out at /w/repos/acme/app",
  });
  // Where it starts is the turn's, not the session's system text.
  expect((calls[0]?.request as { prompt?: string } | undefined)?.prompt).toStartWith("You start in /w/repos/acme/app.");
  // A sync the engine already started (during the quiet window) is used as it is: none starts here.
  await collect(
    brain(async () => null).run(
      { ...turn(), code: Promise.resolve({ cwd: "repos/acme/web", prompt: "# Your code\nweb", start: "" }) },
      io(),
    ),
  );
  expect(seen).toHaveLength(1);
  expect(calls[1]?.request).toMatchObject({ cwd: "repos/acme/web", system: "You are dev.\n\n# Your code\nweb" });
  await collect(
    brain(async () => {
      throw new Error("offline");
    }).run(turn(), io()),
  );
  expect(calls[2]?.request).toMatchObject({ cwd: "", system: "You are dev." });
});

test("protocol 40: what holds for the conversation, and # Your code, go apart from the system text; an older runner gets one text", async () => {
  const conversation = "# This conversation\n\n## Your team\nOther agents: @ops.";
  const code = { cwd: "repos/acme/app", prompt: "# Your code\nacme/app", start: "" };
  const sent = async (protocol: number) => {
    const pubsub = createMemoryPubSub();
    const { hub, calls } = fakeHub(pubsub, { status: status({ protocol }) });
    await collect(
      createClaudeCodeBrain({
        hub,
        pubsub,
        agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
        finalGraceMs: 20,
      }).run({ ...turn(), conversation, code: Promise.resolve(code) }, io()),
    );
    return calls[0]?.request as { system?: string; conversation?: string } | undefined;
  };
  expect(await sent(CONVERSATION_PROTOCOL)).toMatchObject({
    system: "You are dev.",
    conversation: `${conversation}\n\n# Your code\nacme/app`,
  });
  const older = await sent(CONVERSATION_PROTOCOL - 1);
  expect(older?.system).toBe(`You are dev.\n\n${conversation}\n\n# Your code\nacme/app`);
  expect(older?.conversation).toBeUndefined();
});

test("a new session reads the conversation so far, not only the message that called it", async () => {
  const pubsub = createMemoryPubSub();
  const { hub, calls } = fakeHub(pubsub, { events: [] });
  const messages = [
    { role: "user" as const, content: "[Atlas]: New Sentry error: ACME-BACKEND-2X" },
    { role: "user" as const, content: "what error is this? can you find it in the code?" },
  ];
  await collect(
    brainWith(pubsub, hub).run(turn({ messages, trigger: "what error is this? can you find it in the code?" }), io()),
  );
  expect((calls[0]?.request as { prompt?: string } | undefined)?.prompt).toBe(
    "The conversation so far:\n\nUser: [Atlas]: New Sentry error: ACME-BACKEND-2X\n\nNow answer this:\n\nwhat error is this? can you find it in the code?",
  );
});

test("events lost on the way: the reply's final event still ends the turn; another machine can't speak for the run", async () => {
  const pubsub = createMemoryPubSub();
  const silent = fakeHub(pubsub, { silent: true });
  expect(await collect(brainWith(pubsub, silent.hub).run(turn(), io()))).toEqual([
    { type: "done", text: "Hello world", session: { id: SESSION } },
  ]);
  const impostor = fakeHub(pubsub, {
    from: "0193cccc-0000-7000-8000-00000000ffff",
    events: [{ type: "text_delta", text: "evil" }],
  });
  expect(await collect(brainWith(pubsub, impostor.hub).run(turn(), io()))).toEqual([
    { type: "done", text: "Hello world", session: { id: SESSION } },
  ]);
});

test("a plan limit streams limit{resetsAt} and ends with a retryable plan_limit", async () => {
  const pubsub = createMemoryPubSub();
  const { hub } = fakeHub(pubsub, {
    events: [{ type: "limit", resetsAt: "2030-03-17T17:46:40.000Z" }],
    final: { type: "error", code: "plan_limit", message: "You've hit your limit", retryable: true },
  });
  expect(await collect(brainWith(pubsub, hub).run(turn(), io()))).toEqual([
    { type: "limit", resetsAt: "2030-03-17T17:46:40.000Z" },
    { type: "error", code: "plan_limit", message: "You've hit your limit", retryable: true },
  ]);
});

test("not reachable: each reason ends the turn at once, retryable, without calling the machine", async () => {
  const cases: [MachineStatus | null, string][] = [
    [null, "machine_offline"],
    [status({ online: false }), "machine_offline"],
    [status({ execAllowed: false }), "exec_disabled"],
    [status({ protocol: BRAIN_PROTOCOL - 1 }), "runner_outdated"],
    [status({ executors: { detectedAt: "2026-10-17T00:00:00Z" } }), "cli_missing"],
    [status({ executors: { claude: { version: "2.1", loggedIn: false } } }), "not_logged_in"],
  ];
  for (const [s, code] of cases) {
    const pubsub = createMemoryPubSub();
    const { hub, calls } = fakeHub(pubsub, { status: s });
    const events = await collect(brainWith(pubsub, hub).run(turn(), io()));
    expect(events).toEqual([expect.objectContaining({ type: "error", code, retryable: true })]);
    expect(calls).toHaveLength(0);
  }
  // Login unknown (an older detection): it is tried.
  expect(claudeCodeAvailability(status({ executors: { claude: { version: "2.1" } } }))).toBeNull();
  const pubsub = createMemoryPubSub();
  const { hub } = fakeHub(pubsub);
  expect(await collect(brainWith(pubsub, hub).run(turn({ session: undefined }), io()))).toEqual([
    expect.objectContaining({ code: "no_session", retryable: true }),
  ]);
});

test("a plan turn needs a runner that keeps plan to reading (ADR 0053 §3); a work turn still goes to an older one", async () => {
  const sent = async (protocol: number, mode: "plan" | "work") => {
    const pubsub = createMemoryPubSub();
    const { hub, calls } = fakeHub(pubsub, { status: status({ protocol }) });
    const brain = createClaudeCodeBrain({
      hub,
      pubsub,
      agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
      permissions: async () => ({ mode, branchPrefix: "agentes/dev/" }),
      finalGraceMs: 20,
    });
    return { events: await collect(brain.run(turn(), io())), calls };
  };
  const old = await sent(BRAIN_PROFILES_PROTOCOL - 1, "plan");
  expect(old.events).toEqual([expect.objectContaining({ type: "error", code: "runner_outdated", retryable: true })]);
  expect(old.calls).toHaveLength(0);
  const current = await sent(BRAIN_PROFILES_PROTOCOL, "plan");
  expect(current.calls[0]?.request).toMatchObject({ op: "brain.turn", permissions: { mode: "plan" } });
  const work = await sent(BRAIN_PROFILES_PROTOCOL - 1, "work");
  expect(work.calls[0]?.request).toMatchObject({ op: "brain.turn", permissions: { mode: "work" } });
});

test("accounts (ADR 0041): the account and effort go to a runner that knows them; a signed-out account ends the turn", async () => {
  const ACCOUNT = "0193dddd-0000-4000-8000-000000000001";
  const account = { id: ACCOUNT, label: "Trabalho", status: "active" as const };
  const sent = async (s: MachineStatus, over: Partial<BrainTurn>) => {
    const pubsub = createMemoryPubSub();
    const { hub, calls } = fakeHub(pubsub, { status: s });
    const events = await collect(brainWith(pubsub, hub).run(turn(over), io()));
    return {
      events,
      request: calls[0]?.request as (MachineRequest & { account?: string; effort?: string }) | undefined,
    };
  };

  // Protocol 13: both go with the turn.
  const current = await sent(status({ protocol: ACCOUNTS_PROTOCOL }), { account, effort: "high" });
  expect(current.request).toMatchObject({ op: "brain.turn", account: ACCOUNT, effort: "high" });
  // Without them, nothing is added.
  const plain = await sent(status({ protocol: ACCOUNTS_PROTOCOL }), {});
  expect(plain.request && "account" in plain.request).toBe(false);
  expect(plain.request && "effort" in plain.request).toBe(false);

  // An older runner never sees them: the effort is dropped, an account can't run there.
  const oldEffort = await sent(status(), { effort: "high" });
  expect(oldEffort.request && "effort" in oldEffort.request).toBe(false);
  const oldAccount = await sent(status(), { account });
  expect(oldAccount.request).toBeUndefined();
  expect(oldAccount.events).toEqual([
    expect.objectContaining({ type: "error", code: "runner_outdated", retryable: true }),
  ]);

  // A signed-out account: not logged in, naming it, without calling the machine.
  const out = await sent(status({ protocol: ACCOUNTS_PROTOCOL }), { account: { ...account, status: "signed_out" } });
  expect(out.request).toBeUndefined();
  expect(out.events).toEqual([expect.objectContaining({ type: "error", code: "not_logged_in", retryable: true })]);
  expect((out.events[0] as { message: string }).message).toContain('"Trabalho"');

  // With an account, the computer's own sign-in doesn't matter (the account's status decides).
  const ownSignedOut = status({
    protocol: ACCOUNTS_PROTOCOL,
    executors: { claude: { version: "2.1", loggedIn: false }, detectedAt: new Date().toISOString() },
  });
  expect(claudeCodeAvailability(ownSignedOut)?.type).toBe("error");
  expect(claudeCodeAvailability(ownSignedOut, account)).toBeNull();
});

test("a failed request becomes the turn's error (offline and old runners may fall back; a timeout doesn't)", async () => {
  const cases: [Error, string, boolean][] = [
    [new MachineOfflineError("mac", null), "machine_offline", true],
    [new MachineRequestError("bad_request", "Unknown op brain.turn"), "runner_outdated", true],
    [new MachineRequestError("timeout", "too slow"), "timeout", false],
    [new MachineRequestError("internal", "busy"), "busy", true],
    [new MachineRequestError("no_slot", "This computer is short of memory for more work right now"), "busy", true],
    [new MachineRequestError("canceled", "canceled"), "canceled", false],
  ];
  for (const [fail, code, retryable] of cases) {
    const pubsub = createMemoryPubSub();
    const { hub } = fakeHub(pubsub, { fail });
    expect(await collect(brainWith(pubsub, hub).run(turn(), io()))).toEqual([
      expect.objectContaining({ type: "error", code, retryable }),
    ]);
  }
});

test("a turn cut mid-way (the link dropped, the agent's worker stopped) waits for the computer; our own stop says so", async () => {
  const cases: [Error, boolean][] = [
    [new MachineDroppedError("mac"), false],
    [new MachineDroppedError("mac", { message: "The agent's worker on this computer stopped while this ran." }), false],
    [new MachineDroppedError("mac", { serverStop: true }), true],
  ];
  for (const [fail, serverStop] of cases) {
    const pubsub = createMemoryPubSub();
    const { hub } = fakeHub(pubsub, { fail });
    const events = await collect(brainWith(pubsub, hub).run(turn(), io()));
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "machine_offline", retryable: true })]);
    expect((events[0] as { serverStop?: boolean }).serverStop === true).toBe(serverStop);
  }
});

test("session ids: stable per agent and conversation, UUID-shaped", () => {
  const a = brainSessionId("agent-1", "thread-1");
  expect(a).toBe(brainSessionId("agent-1", "thread-1"));
  expect(a).not.toBe(brainSessionId("agent-1", "thread-2"));
  expect(a).not.toBe(brainSessionId("agent-2", "thread-1"));
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("end to end through the real hub: the runner's brain.event frames reach the brain; plan usage is recorded at no cost", async () => {
  f = await setup({ machines: true });
  const fx = f;
  const hub = fx.machineHub;
  if (!hub) throw new Error("no hub");
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const RUNNER = {
    hostname: "mac",
    os: "darwin" as const,
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
  };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "brain.turn") return;
      setTimeout(async () => {
        const final = { type: "done", text: "Oi!", session: { id: frame.session.id } };
        await reply({ type: "brain.event", runId: frame.runId, event: { type: "text_delta", text: "Oi" } });
        await reply({
          type: "brain.event",
          runId: frame.runId,
          event: { type: "usage", input: 9, output: 3, source: "plan" },
        });
        await reply({ type: "brain.event", runId: frame.runId, event: final });
        await reply({ type: "brain.done", runId: frame.runId });
        await reply({ type: "result", id: frame.id, ok: true, data: { runId: frame.runId, final } });
      }, 1);
    },
    close() {},
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      ...RUNNER,
      exec: true,
      executors: { claude: { version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "max" } },
    }),
  );
  const [row] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId));
  expect(row?.executors.claude).toEqual({ version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "max" });

  const brain = createClaudeCodeBrain({
    hub,
    pubsub: fx.pubsub,
    agentScope: async (t) => ({ id: t.agentId, handle: fx.agent.handle }),
    finalGraceMs: 20,
  });
  const events = await collect(
    brain.run(
      turn({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        session: { id: SESSION, resume: false, machineId: paired.machineId, cwd: "" },
      }),
      io(),
    ),
  );
  expect(events).toEqual([
    { type: "text_delta", text: "Oi" },
    { type: "usage", input: 9, output: 3, source: "plan" },
    { type: "done", text: "Oi!", session: { id: SESSION } },
  ]);

  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 1,
    })
    .returning({ id: schema.agentRuns.id });
  const id = await recordPlanUsage(fx.db, {
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    provider: "claude_code",
    model: "claude-opus-5-5",
    inputTokens: 9,
    outputTokens: 3,
  });
  const [usage] = await fx.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.id, id ?? ""));
  expect(usage).toMatchObject({
    costNanoUsd: 0,
    billedTo: "plan",
    provider: "claude_code",
    model: "claude-opus-5-5",
    inputTokens: 9,
    outputTokens: 3,
  });
});

const LONG_ANSWER = "Olá, ".repeat(70);

test("the runner's partial text never reaches the channel: it says it writes, then its reply is posted whole", async () => {
  f = await setup({ machines: true });
  const fx = f;
  const hub = fx.machineHub;
  if (!hub) throw new Error("no hub");
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const RUNNER = {
    hostname: "mac",
    os: "darwin" as const,
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
  };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, fx.agent.id));
  const events = fx.listen(fx.general.id);
  /** What the channel had seen when the runner sent its last piece (before the answer). */
  let seenBeforeDone: typeof events = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "brain.turn") return;
      setTimeout(async () => {
        // Claude Code's `--include-partial-messages`, batched by the runner: pieces of a long answer.
        for (const piece of [LONG_ANSWER, "tudo ", "certo."]) {
          await reply({ type: "brain.event", runId: frame.runId, event: { type: "text_delta", text: piece } });
          await new Promise((r) => setTimeout(r, 30));
        }
        seenBeforeDone = [...events];
        const final = { type: "done", text: `${LONG_ANSWER}tudo certo.`, session: { id: frame.session.id } };
        await reply({ type: "brain.event", runId: frame.runId, event: final });
        await reply({ type: "brain.done", runId: frame.runId });
        await reply({ type: "result", id: frame.id, ok: true, data: { runId: frame.runId, final } });
      }, 1);
    },
    close() {},
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      ...RUNNER,
      exec: true,
      executors: { claude: { version: "2.1.300", loggedIn: true } },
    }),
  );
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    machines: hub,
    brains: {
      claude_code: (_agent, _run, s) =>
        createClaudeCodeBrain({
          hub,
          pubsub: fx.pubsub,
          agentScope: async (t) => ({ id: t.agentId, handle: fx.agent.handle }),
          mcpToken: () => s.mcpToken(),
          finalGraceMs: 20,
        }),
    },
  });
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(fx.db, handlers);

  // Before the turn ended: that it writes, no message of its own and none of its words.
  expect(seenBeforeDone.map((e) => e.type)).toContain("agent.typing");
  const agentPosts = seenBeforeDone.filter(
    (e) =>
      e.type === "message.created" &&
      (e as { message?: { author: { type: string } } }).message?.author.type === "agent",
  );
  expect(agentPosts).toEqual([]);
  expect(JSON.stringify(events.filter((e) => e.type !== "message.created"))).not.toContain("tudo certo");
  const timeline = await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id);
  expect(timeline.map((m) => m.body)).toEqual(["@dev oi", `${LONG_ANSWER}tudo certo.`]);
});

// A pure check (no fixture): what counts as restating a reaction after `react`.
test("restatesReaction: empty, NO_REPLY, only emoji and punctuation, or one short line saying it reacted; anything else is a reply", () => {
  for (const t of [
    "",
    "  ",
    "👍",
    "👍🏽",
    "🙌!",
    "✅ ✅",
    "❤️",
    "NO_REPLY",
    "👍👍👍👍👍👍👍👍",
    "Reagi com 👍 à mensagem do Caio.",
    "Pronto, reagi!",
    "Reacted with 👍 to Caio's message.",
    "J'ai réagi avec 👍",
    "Caioのメッセージにリアクションしました",
  ])
    expect(restatesReaction(t)).toBe(true);
  for (const t of [
    "ok",
    "👍 feito",
    "Pronto!",
    "42",
    "valeu",
    "Reagi com 👍.\nE o PR está pronto para revisão.",
    "Reagi com 👍. A entrega é sexta.",
    "Reacted 👍! The deadline is Friday.",
    "リアクションしました。締め切りは金曜です。",
  ])
    expect(restatesReaction(t)).toBe(false);
});

test("plan usage is stored like API usage: uncached input apart from cache reads and writes, same total", async () => {
  f = await setup();
  const fx = f;
  const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "hi",
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  const base = { orgId: fx.org.id, agentId: fx.agent.id, runId: run?.id ?? "", provider: "claude_code" };
  const id = await recordPlanUsage(fx.db, {
    ...base,
    inputTokens: 100_000,
    outputTokens: 300,
    cacheReadTokens: 90_000,
    cacheWriteTokens: 8_000,
  });
  // An older runner sends only the total.
  const old = await recordPlanUsage(fx.db, { ...base, inputTokens: 5_000, outputTokens: 10 });
  const rows = await fx.db.select().from(schema.usageRecords);
  expect(rows.find((r) => r.id === id)).toMatchObject({
    inputTokens: 2_000,
    cacheReadTokens: 90_000,
    cacheWriteTokens: 8_000,
    costNanoUsd: 0,
  });
  expect(rows.find((r) => r.id === old)).toMatchObject({ inputTokens: 5_000, cacheReadTokens: 0 });
});
