import { afterEach, expect, test } from "bun:test";
import {
  BRAIN_PROTOCOL,
  brainTopic,
  createMemoryPubSub,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  STEER_PROTOCOL,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainIO,
  type BrainTurn,
  createClaudeCodeBrain,
  createJobHandlers,
  drainOutbox,
  executeToolForRun,
  listMessages,
  type MachineStatus,
  postPersonMessage,
  type SteerMessage,
  type SteerReply,
} from "../src";
import { deliverLive, listenLiveSteering } from "../src/live-steer";
import { takeInbox } from "../src/run-inbox";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * Live steering: a person's message reaches a computer brain's turn in
 * progress (read at its next tool boundary), with "received" then "read"
 * receipts; what the turn never confirms is read with its next turn; a turn
 * that can't take messages leaves them for its end, as before.
 */

let f: Fixture | undefined;
afterEach(async () => {
  const current = f;
  f = undefined;
  await current?.close();
});

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: STEER_PROTOCOL,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

async function computerAgent(fx: Fixture) {
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.9.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, fx.agent.id));
  return paired.machineId;
}

/** A promise with its resolve outside. */
function gate<T = void>() {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    open = r;
  });
  return { promise, open };
}

const waitUntil = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/**
 * A Claude Code stand-in: its first turn hands the engine `steer` (answering
 * with `reply`), says it started, and ends when `finish` opens, yielding what
 * the test asks for first; later turns answer at once. Keeps every turn.
 */
function steerableBrain(reply: (messages: SteerMessage[]) => SteerReply) {
  const seen: BrainTurn[] = [];
  const handed: SteerMessage[][] = [];
  const started = gate();
  const finish = gate<BrainEvent[]>();
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn: BrainTurn, io: BrainIO) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      if (n > 0) {
        yield { type: "done", text: `Turn ${n + 1}.` };
        return;
      }
      io.steerable?.(async (messages) => {
        handed.push(messages);
        return reply(messages);
      });
      try {
        started.open();
        const events = await finish.promise;
        yield* events;
        yield { type: "done", text: "Feito." };
      } finally {
        io.steerable?.(null);
      }
    },
  };
  return { brain, seen, handed, started, finish };
}

const post = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

test("a message during a computer turn is handed to it live; read ones join it, unconfirmed ones go to the next turn", async () => {
  f = await setup();
  const fx = f;
  await computerAgent(fx);
  const events = fx.listen(fx.general.id);
  const { brain, seen, handed, started, finish } = steerableBrain((messages) => ({
    status: "accepted",
    accepted: messages.map((m) => m.uuid),
  }));
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev roda os testes");
  const drained = drainOutbox(fx.db, handlers);
  await started.promise;

  const first = await post(fx, "@dev e atualiza a doc");
  const second = await post(fx, "@dev e o changelog");
  // Each one went to the turn as it arrived, rendered like messages read between turns.
  expect(handed).toHaveLength(2);
  expect(handed[0]).toEqual([
    { uuid: expect.any(String), text: expect.stringContaining("while you were working]: @dev e atualiza a doc") },
  ]);
  expect(handed[1]?.[0]?.text).toContain("@dev e o changelog");
  const delivered = events.filter((e) => e.type === "agent.run.delivered");
  expect(delivered.map((e) => e.messageIds)).toEqual([[first.id], [second.id]]);
  // Nothing waits in the inbox while the turn has them.
  const [running] = await fx.db.select().from(schema.agentRuns);
  expect(running?.pendingMessageIds).toEqual([]);

  // The turn read only the first before it ended.
  finish.open([{ type: "steer_read", uuids: [handed[0]?.[0]?.uuid ?? ""] }]);
  await drained;
  await drainOutbox(fx.db, handlers);

  const read = events.filter((e) => e.type === "agent.run.read");
  expect(read[0]?.messageIds).toEqual([first.id]);
  // The unconfirmed one goes to the next turn's prompt (once), and is read then.
  expect(seen).toHaveLength(2);
  expect(seen[1]?.trigger).toContain("@dev e o changelog");
  expect(seen[1]?.trigger).not.toContain("@dev e atualiza a doc");
  expect(read.at(-1)?.messageIds).toEqual([second.id]);
  const [run] = await fx.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(run?.pendingMessageIds).toEqual([]);
  // Read mid-turn, it updates the task the judges hold the reply to (ADR 0112), not only the brain's prompt.
  expect((run?.transcript as { request?: string } | null)?.request).toContain("e atualiza a doc");
  const steps = await fx.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  expect(steps.some((s) => (s.data as { live?: boolean }).live === true)).toBe(true);
  // The answer before the next turn, then the next turn's: one run, nothing lost.
  const main = await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id);
  expect(main.map((m) => m.body)).toEqual([
    "@dev roda os testes",
    "@dev e atualiza a doc",
    "@dev e o changelog",
    "Feito.",
    "Turn 2.",
  ]);
});

test("a burst before the first computer turn (ADR 0112): one turn whose prompt has all of it, as conversation lines", async () => {
  f = await setup({ quietMs: 400 });
  const fx = f;
  await computerAgent(fx);
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn: BrainTurn) {
      seen.push({ ...turn, system: "", messages: [] });
      yield { type: "done", text: "Bate: 42 nos dois." };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev oi");
  const drained = drainOutbox(fx.db, handlers);
  const start = Date.now();
  while (!(await fx.db.select().from(schema.agentRuns)).some((r) => r.status === "running")) {
    if (Date.now() - start > 15000) throw new Error("the run never started");
    await new Promise((r) => setTimeout(r, 5));
  }
  // No @ needed: the same person's follow-ups go to the agent still answering them (the floor).
  await post(fx, "preciso de uma coisa");
  await post(fx, "olha o relatório de ontem e me diz se bate com o quadro");
  await drained;
  await drainOutbox(fx.db, handlers);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.trigger).toContain("@dev oi");
  expect(seen[0]?.trigger).toContain("[ana]: preciso de uma coisa");
  expect(seen[0]?.trigger).toContain("[ana]: olha o relatório de ontem");
  expect(seen[0]?.trigger).not.toContain("while you were working");
  const all = await fx.db.select().from(schema.agentRuns);
  expect(all).toHaveLength(1);
  expect(all[0]?.status).toBe("done");
});

test("a message to a computer-brain run still starting answers at once: the send never waits for a live delivery", async () => {
  f = await setup();
  const fx = f;
  await computerAgent(fx);
  const checking = gate();
  const release = gate();
  let calls = 0;
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "done", text: "Feito." };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id) => {
        // The run's first look at its computer (before any turn): held here, the run is claimed but not listening yet.
        if (calls++ === 0) {
          checking.open();
          await release.promise;
        }
        return statusOf(id);
      },
    },
  });
  await post(fx, "@dev oi");
  const drained = drainOutbox(fx.db, handlers);
  await checking.promise;
  const start = Date.now();
  await post(fx, "preciso de uma coisa");
  expect(Date.now() - start).toBeLessThan(1500);
  release.open();
  await drained;
  await drainOutbox(fx.db, handlers);
  const all = await fx.db.select().from(schema.agentRuns);
  expect(all).toHaveLength(1);
  expect(all[0]?.status).toBe("done");
});

test("a message sent before the turn is steerable is handed to it as soon as it is, and read in that turn", async () => {
  f = await setup();
  const fx = f;
  await computerAgent(fx);
  const events = fx.listen(fx.general.id);
  const inTurn = gate();
  const ready = gate();
  const handed: SteerMessage[][] = [];
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn: BrainTurn, io: BrainIO) {
      seen.push({ ...turn, system: "", messages: [] });
      if (seen.length > 1) {
        yield { type: "done", text: "Turn 2." };
        return;
      }
      // The CLI is still starting: the turn runs, but can't take messages yet.
      inTurn.open();
      await ready.promise;
      io.steerable?.(async (messages) => {
        handed.push(messages);
        return { status: "accepted", accepted: messages.map((m) => m.uuid) };
      });
      try {
        await waitUntil(() => handed.length > 0);
        yield { type: "steer_read", uuids: handed[0]?.map((m) => m.uuid) ?? [] };
        yield { type: "done", text: "Feito, com a doc." };
      } finally {
        io.steerable?.(null);
      }
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev roda os testes");
  const drained = drainOutbox(fx.db, handlers);
  await inTurn.promise;
  const msg = await post(fx, "@dev e atualiza a doc");
  expect(handed).toHaveLength(0);
  ready.open();
  await drained;
  await drainOutbox(fx.db, handlers);
  expect(handed).toHaveLength(1);
  expect(handed[0]?.[0]?.text).toContain("@dev e atualiza a doc");
  expect(events.filter((e) => e.type === "agent.run.delivered").map((e) => e.messageIds)).toEqual([[msg.id]]);
  expect(events.filter((e) => e.type === "agent.run.read").map((e) => e.messageIds)).toEqual([[msg.id]]);
  // Read in the turn it was sent in: no second turn, and the request grew with it.
  expect(seen).toHaveLength(1);
  const [run] = await fx.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect((run?.transcript as { request?: string } | null)?.request).toContain("e atualiza a doc");
});

/** Past `WORKING_TEXT_MAX`: a stretch this long is read as the answer (a stopped reply keeps it). */
const LONG = "Vou olhar cada arquivo do projeto antes de mexer em qualquer coisa. ".repeat(5);

test("a computer brain's stretches, a call and a message read mid-answer: none of its words go out before its reply", async () => {
  f = await setup({
    toolSources: [
      {
        name: "env",
        tools: async () => [
          {
            name: "check_env",
            description: "Check the environment",
            scope: "",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => ({ content: "ok" }),
          },
        ],
      },
    ],
  });
  const fx = f;
  const machineId = await computerAgent(fx);
  const events = fx.listen(fx.general.id);
  let runId = "";
  const handed: SteerMessage[][] = [];
  const sent = gate();
  const brain: Brain = {
    kind: "claude_code",
    async *run(_turn: BrainTurn, io: BrainIO) {
      io.steerable?.(async (messages) => {
        handed.push(messages);
        return { status: "accepted", accepted: messages.map((m) => m.uuid) };
      });
      try {
        const [row] = await fx.db.select().from(schema.agentRuns);
        runId = row?.id ?? "";
        const id = { orgId: fx.org.id, agentId: fx.agent.id, runId, machineId };
        const pause = () => new Promise((r) => setTimeout(r, 5));
        // As the runner does: the text's last characters wait for the next event, here the call's end.
        yield { type: "text_delta", text: `${LONG}Vou olhar o build.gra` };
        await pause();
        await executeToolForRun(fx.jobDeps, id, { id: "c-1", name: "check_env", input: {} });
        yield { type: "text_delta", text: "dle primeiro." };
        await pause();
        yield { type: "tool_call", id: "c-1", name: "check_env", input: {}, executed: { content: "ok" } };
        yield { type: "text_delta", text: `${LONG}A resposta.` };
        await pause();
        sent.open();
        await waitUntil(() => handed.length > 0);
        yield { type: "steer_read", uuids: handed[0]?.map((m) => m.uuid) ?? [] };
        yield { type: "text_delta", text: "E sobre o recado." };
        await pause();
        yield { type: "done", text: `${LONG}A resposta.\n\nE sobre o recado.` };
      } finally {
        io.steerable?.(null);
      }
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev olha o build");
  const drained = drainOutbox(fx.db, handlers);
  await sent.promise;
  await post(fx, "@dev e o recado?");
  await drained;

  expect(handed).toHaveLength(1);
  // It said it writes; its step lines aside, none of its words went out but in its reply.
  expect(events.some((e) => e.type === "agent.typing")).toBe(true);
  const before = JSON.stringify(
    events.filter((e) => e.type !== "message.created"),
    (k, v) => (k === "said" ? undefined : v),
  );
  for (const words of ["build.gra", "dle primeiro", "A resposta", "E sobre o recado"])
    expect([words, before.includes(words)]).toEqual([words, false]);
  const main = await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id);
  expect(main.at(-1)?.body).toBe(`${LONG}A resposta.\n\nE sobre o recado.`.trim());
});

test("a long stretch a call ended is never posted: the reply is what it said after its last call", async () => {
  f = await setup();
  const fx = f;
  await computerAgent(fx);
  const events = fx.listen(fx.general.id);
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "text_delta", text: `${LONG}Vou seguir o plano` };
      yield { type: "tool_call", id: "c-1", name: "Bash", input: {}, executed: { content: "ok" } };
      yield { type: "text_delta", text: "Pronto." };
      yield { type: "done", text: "Pronto." };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev segue o plano");
  await drainOutbox(fx.db, handlers);
  const main = await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id);
  expect(main.map((m) => m.body)).toEqual(["@dev segue o plano", "Pronto."]);
  expect(JSON.stringify(events.filter((e) => e.type !== "message.created"))).not.toContain("Pronto");
});

/** A queued run with one message in its inbox, and a listener for it that retries fast. */
async function inboxRun(fx: Fixture) {
  await post(fx, "@dev roda os testes");
  const msg = await post(fx, "@dev e a doc");
  const [run] = await fx.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  expect(run.pendingMessageIds).toEqual([msg.id]);
  const live = listenLiveSteering({ db: fx.db, pubsub: fx.pubsub, retryMs: 20 }, run, null, {
    take: () => takeInbox(fx.db, run.id),
    onRead: () => {},
  });
  const pending = async () => (await fx.db.select().from(schema.agentRuns))[0]?.pendingMessageIds;
  return { msg, live, pending };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a turn whose CLI is still starting (no_turn) gets the message on a retry once it can take it", async () => {
  f = await setup();
  const fx = f;
  const events = fx.listen(fx.general.id);
  const { msg, live, pending } = await inboxRun(fx);
  const calls: SteerMessage[][] = [];
  live.steerable(async (messages) => {
    calls.push(messages);
    return calls.length <= 2 ? { status: "no_turn" } : { status: "accepted", accepted: messages.map((m) => m.uuid) };
  });
  await waitUntil(() => calls.length >= 3);
  await waitUntil(() => events.some((e) => e.type === "agent.run.delivered"));
  expect(calls.map((c) => c.map((m) => m.text.includes("@dev e a doc")))).toEqual([[true], [true], [true]]);
  expect(events.filter((e) => e.type === "agent.run.delivered").map((e) => e.messageIds)).toEqual([[msg.id]]);
  expect(await pending()).toEqual([]);
  // Delivered: no more asking.
  await pause(100);
  expect(calls).toHaveLength(3);
  live.close();
});

test("no retry once the turn ended or the run closed: the message waits in the inbox", async () => {
  f = await setup();
  const fx = f;
  const { msg, live, pending } = await inboxRun(fx);
  let calls = 0;
  live.steerable(async () => {
    calls++;
    return { status: "no_turn" };
  });
  await waitUntil(() => calls >= 2);
  expect(await live.endTurn()).toEqual([]);
  const after = calls;
  await pause(100);
  expect(calls).toBe(after);
  expect(await pending()).toEqual([msg.id]);

  live.steerable(async () => {
    calls++;
    return { status: "no_turn" };
  });
  await waitUntil(() => calls >= after + 2);
  live.close();
  const closed = calls;
  await pause(100);
  expect(calls).toBeLessThanOrEqual(closed + 1);
  const settled = calls;
  await pause(100);
  expect(calls).toBe(settled);
  expect(await pending()).toEqual([msg.id]);
});

test("a turn that refuses (unsupported) after a no_turn is not asked again", async () => {
  f = await setup();
  const fx = f;
  const { msg, live, pending } = await inboxRun(fx);
  let calls = 0;
  live.steerable(async (): Promise<SteerReply> => {
    calls++;
    if (calls === 1) return { status: "no_turn" };
    if (calls === 2) return { status: "unsupported", reason: "Claude Code 2.1.100 reads messages only between turns" };
    return { status: "accepted", accepted: [] };
  });
  await waitUntil(() => calls >= 2);
  await pause(100);
  expect(calls).toBe(2);
  expect(await pending()).toEqual([msg.id]);
  live.close();
});

test("a turn that can't take messages: not live, the message waits for the turn's end (asked once per turn)", async () => {
  f = await setup();
  const fx = f;
  await computerAgent(fx);
  const events = fx.listen(fx.general.id);
  const { brain, seen, handed, started, finish } = steerableBrain(() => ({
    status: "unsupported",
    reason: "Claude Code 2.1.100 reads messages only between turns",
  }));
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev roda os testes");
  const drained = drainOutbox(fx.db, handlers);
  await started.promise;
  const msg = await post(fx, "@dev e a doc");
  await post(fx, "@dev e o changelog");
  expect(handed).toHaveLength(1);
  expect(events.some((e) => e.type === "agent.run.delivered")).toBe(false);
  const [running] = await fx.db.select().from(schema.agentRuns);
  expect(running?.pendingMessageIds).toContain(msg.id);
  expect(running?.pendingMessageIds).toHaveLength(2);
  finish.open([]);
  await drained;
  await drainOutbox(fx.db, handlers);
  expect(seen).toHaveLength(2);
  expect(seen[1]?.trigger).toContain("@dev e a doc");
  expect(seen[1]?.trigger).toContain("@dev e o changelog");
});

test("deliverLive: false at once for a run that isn't running, and after a short wait when nobody executes it", async () => {
  f = await setup();
  const fx = f;
  const pubsub = createMemoryPubSub();
  const run = { id: "0193bbbb-0000-7000-8000-000000000009", status: "queued" } as never;
  expect(await deliverLive({ db: fx.db, pubsub }, run, { messageId: "m", urgent: false })).toBe(false);
  const started = Date.now();
  const running = { id: "0193bbbb-0000-7000-8000-000000000009", status: "running" } as never;
  expect(await deliverLive({ db: fx.db, pubsub, waitMs: 50 }, running, { messageId: "m", urgent: true })).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a model-brain run answers false at once (it reads messages at each step anyway)", async () => {
  const hold = gate();
  let calls = 0;
  f = await setup({
    reply: () => {
      calls++;
      return { chunks: ["Pron", "to."], hold: hold.promise };
    },
  });
  const fx = f;
  await post(fx, "@dev oi");
  const drained = drainOutbox(fx.db, fx.handlers);
  await waitUntil(() => calls > 0);
  const [run] = await fx.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("running");
  const started = Date.now();
  expect(await deliverLive({ db: fx.db, pubsub: fx.pubsub }, run as never, { messageId: "m", urgent: false })).toBe(
    false,
  );
  // Answered by the instance executing it, not by the timeout.
  expect(Date.now() - started).toBeLessThan(500);
  hold.open();
  await drained;
});

test("Claude Code brain: a runner on protocol 15 takes brain.steer for the turn; an older one is never asked", async () => {
  const pubsub = createMemoryPubSub();
  const MACHINE = "0193cccc-0000-7000-8000-000000000001";
  const RUN = "0193bbbb-0000-7000-8000-000000000001";
  const SESSION = "0193aaaa-0000-7000-8000-000000000001";
  const calls: MachineRequest[] = [];
  const turnEnd = gate();
  const hubFor = (protocol: number) => ({
    status: async () => ({ ...statusOf(MACHINE), protocol }),
    call: async (_id: string, request: MachineRequest) => {
      calls.push(request);
      if (request.op === "brain.steer") return { status: "accepted", accepted: [request.messages[0]?.uuid] } as never;
      await turnEnd.promise;
      const final = { type: "done", text: "ok" };
      await pubsub.publish(brainTopic(RUN), {
        type: "brain.event",
        machineId: MACHINE,
        event: { type: "steer_read", uuids: ["u1"] },
      });
      await pubsub.publish(brainTopic(RUN), { type: "brain.event", machineId: MACHINE, event: final });
      return { runId: RUN, final } as never;
    },
  });
  const turn: BrainTurn = {
    runId: RUN,
    orgId: "org",
    agentId: "agent-1",
    channelId: "ch",
    threadRootId: null,
    system: "",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    session: { id: SESSION, resume: false, machineId: MACHINE, cwd: "" },
    trigger: "hi",
  };
  let steer: ((m: SteerMessage[]) => Promise<SteerReply>) | null = null;
  const handedOff: Array<boolean> = [];
  const io: BrainIO = {
    signal: new AbortController().signal,
    executeTool: async () => ({ content: "" }),
    steerable: (s) => {
      steer = s;
      handedOff.push(s !== null);
    },
  };
  const brain = createClaudeCodeBrain({
    hub: hubFor(STEER_PROTOCOL),
    pubsub,
    agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
    finalGraceMs: 20,
  });
  const out: BrainEvent[] = [];
  const running = (async () => {
    for await (const e of brain.run(turn, io)) out.push(e);
  })();
  await waitUntil(() => steer !== null);
  const reply = await (steer as unknown as (m: SteerMessage[]) => Promise<SteerReply>)([
    { uuid: "u1", text: "[New message from Ada]: hi", urgent: true },
  ]);
  expect(reply).toEqual({ status: "accepted", accepted: ["u1"] });
  expect(calls.find((c) => c.op === "brain.steer")).toEqual({
    op: "brain.steer",
    runId: RUN,
    session: SESSION,
    messages: [{ uuid: "u1", text: "[New message from Ada]: hi", urgent: true }],
    agent: { id: "agent-1", handle: "dev" },
  });
  turnEnd.open();
  await running;
  expect(out).toEqual([
    { type: "steer_read", uuids: ["u1"] },
    { type: "done", text: "ok" },
  ]);
  // Handed at the start, taken back at the end.
  expect(handedOff).toEqual([true, false]);

  // An older runner: the brain never offers steering.
  const old = createClaudeCodeBrain({
    hub: hubFor(BRAIN_PROTOCOL),
    pubsub,
    agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
    finalGraceMs: 20,
  });
  handedOff.length = 0;
  for await (const _ of old.run(turn, io)) {
    // drain
  }
  expect(handedOff).toEqual([]);
});
