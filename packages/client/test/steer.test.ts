import { afterEach, describe, expect, test } from "bun:test";
import type { ActiveRun, ChannelEvent, Message } from "../src/index";
import {
  applyChannelEvent,
  applySteerEvent,
  continuedRunIdOf,
  emptySteer,
  emptyStreams,
  RealtimeConnection,
  reconcileRuns,
  reconcileSteer,
  seedSteerMessages,
  steerStateIn,
  steerStateOf,
  steerStore,
} from "../src/index";
import { fakeSockets } from "./fake-socket";

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const steered = (messageId: string, extra: Record<string, unknown> = {}) =>
  ({ type: "agent.run.steered", channelId: "c1", runId: "r1", agentId: "ada", messageId, ...extra }) as Ev;
const read = (...messageIds: string[]) => ({ type: "agent.run.read", ...base, messageIds }) as Ev;
const delivered = (...messageIds: string[]) => ({ type: "agent.run.delivered", ...base, messageIds }) as Ev;
const redispatched = (runId: string, newRunId: string, ...messageIds: string[]) =>
  ({ type: "agent.run.redispatched", ...base, runId, newRunId, messageIds }) as Ev;
const waitMessage = (messageId: string, outcome: "resolved" | "woke" | "held") =>
  ({ type: "agent.run.wait_message", ...base, messageId, waitKind: "browser_help", outcome }) as Ev;

/** A person's message that went into these runs (its receipts name the agent). */
const person = (id: string, runIds: string[]) =>
  ({
    id,
    channelId: "c1",
    author: { type: "person", id: "u1" },
    meta: { steeredRunIds: runIds },
    receipts: {
      seenBy: ["ada"],
      pickedBy: ["ada"],
      handled: runIds.map((runId) => ({ agentId: "ada", runId, status: "running" })),
    },
  }) as unknown as Message;

describe("what became of a message sent while an agent works", () => {
  test("steered → waiting; steered with now → now until read; read → read", () => {
    let s = applySteerEvent(emptySteer, steered("m2"));
    expect(steerStateIn(s, "m2")).toEqual({ runId: "r1", agentId: "ada", state: "waiting" });
    s = applySteerEvent(s, steered("m3", { now: true }));
    expect(steerStateIn(s, "m3")?.state).toBe("now");
    s = applySteerEvent(s, read("m2", "m3"));
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    expect(steerStateIn(s, "m3")?.state).toBe("read");
    // Events can cross: a late steered never takes "read" back.
    s = applySteerEvent(s, steered("m2"));
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    expect(steerStateIn(s, "other")).toBeNull();
  });

  test("a stop (judged after the send) drops it; a run that answered or passed read what it had", () => {
    let s = applySteerEvent(emptySteer, steered("m2"));
    s = applySteerEvent(s, steered("m2", { stop: true }));
    expect(steerStateIn(s, "m2")).toBeNull();
    s = applySteerEvent(s, steered("m4"));
    s = applySteerEvent(s, { type: "run.finished", ...base, status: "done" });
    expect(steerStateIn(s, "m4")?.state).toBe("read");
    s = applySteerEvent(s, { ...steered("m6"), runId: "r3" } as Ev);
    s = applySteerEvent(s, { type: "agent.passed", ...base, runId: "r3" } as Ev);
    expect(steerStateIn(s, "m6")?.state).toBe("read");
  });

  test("never nowhere: a stopped or failed run's unread message follows to the new run", () => {
    let s = applySteerEvent(emptySteer, { ...steered("m5"), runId: "r2" } as Ev);
    s = applySteerEvent(s, { type: "run.canceled", ...base, runId: "r2" });
    // Still waiting (the server hands it on), not dropped.
    expect(steerStateIn(s, "m5")).toEqual({ runId: "r2", agentId: "ada", state: "waiting" });
    s = applySteerEvent(s, redispatched("r2", "r9", "m5"));
    expect(steerStateIn(s, "m5")).toEqual({ runId: "r9", agentId: "ada", state: "waiting" });
    // The new run's events before it starts don't read it; once it runs, it has it.
    s = applySteerEvent(s, { type: "agent.run", ...base, runId: "r9", status: "queued" } as Ev);
    expect(steerStateIn(s, "m5")?.state).toBe("waiting");
    s = applySteerEvent(s, { type: "agent.run", ...base, runId: "r9", status: "running" } as Ev);
    expect(steerStateIn(s, "m5")).toEqual({ runId: "r9", agentId: "ada", state: "read" });
  });

  test("a run that ended read gets corrected by the redispatch; a late redispatch never undoes the new run", () => {
    let s = applySteerEvent(emptySteer, steered("m2"));
    s = applySteerEvent(s, { type: "run.finished", ...base, status: "done" });
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    s = applySteerEvent(s, redispatched("r1", "r2", "m2"));
    expect(steerStateIn(s, "m2")).toEqual({ runId: "r2", agentId: "ada", state: "waiting" });
    // Read on the new run: a repeated redispatch changes nothing.
    s = applySteerEvent(s, { type: "agent.run.read", ...base, runId: "r2", messageIds: ["m2"] } as Ev);
    s = applySteerEvent(s, redispatched("r1", "r2", "m2"));
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    // A steered (not started-with) message isn't read just because its run streams.
    s = applySteerEvent(s, { ...steered("m3"), runId: "r2" } as Ev);
    s = applySteerEvent(s, { type: "agent.delta", ...base, runId: "r2", seq: 0, text: "x" } as Ev);
    expect(steerStateIn(s, "m3")?.state).toBe("waiting");
  });

  test("Claude Code: delivered mid-turn, then read; a late delivered never undoes read", () => {
    let s = applySteerEvent(emptySteer, steered("m2"));
    s = applySteerEvent(s, delivered("m2"));
    expect(steerStateIn(s, "m2")?.state).toBe("delivered");
    // A repeated steered doesn't take it back to waiting.
    s = applySteerEvent(s, steered("m2"));
    expect(steerStateIn(s, "m2")?.state).toBe("delivered");
    s = applySteerEvent(s, read("m2"));
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    s = applySteerEvent(s, delivered("m2"));
    expect(steerStateIn(s, "m2")?.state).toBe("read");
  });

  test("a message to a waiting run: resolved, woke (stopped to read) or held (after the card)", () => {
    let s = applySteerEvent(emptySteer, steered("m2"));
    s = applySteerEvent(s, waitMessage("m2", "resolved"));
    expect(steerStateIn(s, "m2")?.state).toBe("resolved");
    // "Encerrou o pedido de ajuda" says more than "leu", and the run's end doesn't change it.
    s = applySteerEvent(s, read("m2"));
    s = applySteerEvent(s, { type: "run.finished", ...base, status: "done" });
    expect(steerStateIn(s, "m2")?.state).toBe("resolved");

    s = applySteerEvent(s, { ...steered("m3"), runId: "r4" } as Ev);
    s = applySteerEvent(s, { ...waitMessage("m3", "woke"), runId: "r4" } as Ev);
    expect(steerStateIn(s, "m3")?.state).toBe("now");

    s = applySteerEvent(s, { ...steered("m4"), runId: "r4" } as Ev);
    s = applySteerEvent(s, { ...waitMessage("m4", "held"), runId: "r4" } as Ev);
    expect(steerStateIn(s, "m4")?.state).toBe("held");
    s = applySteerEvent(s, { ...delivered("m4"), runId: "r4" } as Ev);
    expect(steerStateIn(s, "m4")?.state).toBe("held");
    s = applySteerEvent(s, { ...read("m4"), runId: "r4" } as Ev);
    expect(steerStateIn(s, "m4")?.state).toBe("read");
    // Read stays read.
    s = applySteerEvent(s, { ...waitMessage("m4", "held"), runId: "r4" } as Ev);
    expect(steerStateIn(s, "m4")?.state).toBe("read");
  });

  test("reload: from meta.steeredRunIds and the channel's active runs (pendingMessageIds)", () => {
    let s = seedSteerMessages(emptySteer, "c1", [person("m2", ["r1"]), person("m3", ["r1"]), person("m4", ["r0"])]);
    // Not known until the active runs are listed.
    expect(steerStateIn(s, "m2")).toBeNull();
    const active: ActiveRun = {
      runId: "r1",
      agentId: "ada",
      channelId: "c1",
      threadId: "m1",
      status: "running",
      pendingMessageIds: ["m3"],
    };
    s = reconcileSteer(s, "c1", [active]);
    expect(steerStateIn(s, "m2")).toEqual({ runId: "r1", agentId: "ada", state: "read" });
    expect(steerStateIn(s, "m3")).toEqual({ runId: "r1", agentId: "ada", state: "waiting" });
    // Its run is no longer active: it read it (and answered).
    expect(steerStateIn(s, "m4")?.state).toBe("read");
  });

  test("reload: a message handed to a new run, and one held by an approval", () => {
    let s = seedSteerMessages(emptySteer, "c1", [person("m2", ["r0"]), person("m3", ["r1"]), person("m4", ["r0"])]);
    const at = { agentId: "ada", channelId: "c1", threadId: "m1" };
    s = reconcileSteer(s, "c1", [
      // r0 ended without reading m2 and m4: the new run starts with one (queued) or has it pending.
      { runId: "r5", ...at, status: "queued", triggerMessageId: "m2" },
      { runId: "r1", ...at, status: "waiting_approval", pendingMessageIds: ["m3"] },
      { runId: "r6", ...at, status: "running", pendingMessageIds: ["m4"] },
    ]);
    expect(steerStateIn(s, "m2")).toEqual({ runId: "r5", agentId: "ada", state: "waiting" });
    expect(steerStateIn(s, "m3")).toEqual({ runId: "r1", agentId: "ada", state: "held" });
    expect(steerStateIn(s, "m4")).toEqual({ runId: "r6", agentId: "ada", state: "waiting" });
  });

  test("reconnect: a missed redispatch is found in the active runs", () => {
    let s = applySteerEvent(emptySteer, steered("m2"), 1_000);
    s = applySteerEvent(s, { type: "run.canceled", ...base }, 1_100);
    s = reconcileSteer(
      s,
      "c1",
      [{ runId: "r7", agentId: "ada", channelId: "c1", threadId: "m1", status: "running", pendingMessageIds: ["m2"] }],
      2_000,
    );
    expect(steerStateIn(s, "m2")).toEqual({ runId: "r7", agentId: "ada", state: "waiting" });
    // Gone from the list: it read it.
    s = reconcileSteer(s, "c1", [], 3_000);
    expect(steerStateIn(s, "m2")?.state).toBe("read");
  });

  test("reconnect: a live 'waiting' heard before the list asked is settled by it, a newer one isn't", () => {
    let s = applySteerEvent(emptySteer, steered("m2"), 1_000);
    s = applySteerEvent(s, steered("m3"), 3_000);
    s = reconcileSteer(s, "c1", [], 2_000);
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    expect(steerStateIn(s, "m3")?.state).toBe("waiting");
  });

  test("run.continued and meta.canceled.continuedRunId mark the stopped reply", () => {
    const stopped = {
      id: "m9",
      channelId: "c1",
      author: { type: "agent", id: "ada" },
      meta: { canceled: { byUserId: "u1", text: "Parcial", continuedRunId: "r2" } },
    } as unknown as Message;
    expect(continuedRunIdOf(stopped)).toBe("r2");
    let s = seedSteerMessages(emptySteer, "c1", [stopped]);
    expect(s.continued.m9).toBe("r2");
    s = applySteerEvent(s, { type: "run.continued", channelId: "c1", runId: "r1", newRunId: "r3", messageId: "m8" });
    expect(s.continued.m8).toBe("r3");
  });

  test("a reply at the step limit is marked the same way (meta.stepLimit.continuedRunId)", () => {
    const atLimit = {
      id: "m7",
      channelId: "c1",
      author: { type: "agent", id: "ada" },
      meta: { bodyCode: "step_limit", stepLimit: { continuedRunId: "r5" } },
    } as unknown as Message;
    expect(continuedRunIdOf(atLimit)).toBe("r5");
    expect(seedSteerMessages(emptySteer, "c1", [atLimit]).continued.m7).toBe("r5");
    expect(continuedRunIdOf({ meta: { stepLimit: {} } } as unknown as Message)).toBeNull();
  });
});

describe("the app's steer store is fed by the socket", () => {
  afterEach(() => steerStore.reset());

  test("events on the connection reach steerStateOf", () => {
    const { factory, last } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    conn.subscribe("c1", () => {});
    conn.start();
    last().open();
    last().push({ type: "event", channelId: "c1", event: steered("m2", { now: true }) });
    expect(steerStateOf("m2")?.state).toBe("now");
    last().push({ type: "event", channelId: "c1", event: read("m2") });
    expect(steerStateOf("m2")?.state).toBe("read");
    conn.stop();
  });
});

describe("the live work: what it read, when it read it", () => {
  const run = (events: Ev[]) => events.reduce((s, e) => applyChannelEvent(s, e), emptyStreams);
  const delta = (seq: number, turn: number, text: string) =>
    ({ type: "agent.delta", ...base, seq, turn, text }) as ChannelEvent;

  test("steered only notes it; read adds the step once", () => {
    let s = run([delta(0, 1, "Olhando os logs."), steered("m2")]);
    expect(s.runs.r1?.work ?? []).toEqual([]);
    s = applyChannelEvent(s, read("m2"));
    expect(s.runs.r1?.work).toEqual([{ kind: "steer", messageId: "m2" }]);
    s = applyChannelEvent(s, read("m2"));
    expect(s.runs.r1?.work).toHaveLength(1);
  });

  test("stop and send: the step says it stopped to read; nothing it wrote is in the work", () => {
    let s = run([delta(0, 1, "Começando a"), steered("m3", { now: true })]);
    s = applyChannelEvent(s, read("m3"));
    expect(s.runs.r1?.work).toEqual([{ kind: "steer", messageId: "m3", now: true }]);
    expect(s.runs.r1?.steerNow).toEqual([]);
    s = applyChannelEvent(s, delta(1, 2, "Certo, mudando."));
    expect(s.runs.r1?.status).toBe("running");
    expect(JSON.stringify(s.runs.r1)).not.toContain("mudando");
  });

  test("agent.passed: its row goes at once, and late deltas don't bring it back", () => {
    let s = run([delta(0, 1, "Hmm")]);
    expect(s.runs.r1).toBeDefined();
    s = applyChannelEvent(s, { type: "agent.passed", ...base } as Ev);
    expect(s.runs.r1).toBeUndefined();
    s = applyChannelEvent(s, delta(1, 1, " ok"));
    expect(s.runs.r1).toBeUndefined();
  });

  test("a routine's background run never makes a row (events or the active-runs list)", () => {
    let s = run([
      { type: "agent.thinking", ...base, runId: null, background: true } as Ev,
      { type: "agent.run", ...base, runId: "bg", status: "running", background: true } as Ev,
      { ...delta(0, 1, "Lendo o Sentry"), runId: "bg" } as Ev,
      { type: "agent.tool", ...base, runId: "bg", tool: "web_fetch" } as Ev,
    ]);
    expect(Object.keys(s.runs)).toEqual([]);
    s = reconcileRuns(s, "c1", [
      { runId: "bg2", agentId: "ada", channelId: "c1", threadId: "m1", status: "running", background: true },
    ]);
    expect(Object.keys(s.runs)).toEqual([]);
    // A normal run alongside still shows.
    s = applyChannelEvent(s, delta(0, 1, "Oi"));
    expect(s.runs.r1?.status).toBe("running");
  });

  test("a fast reply while it works (meta.talker) doesn't end the task's row", () => {
    let s = run([delta(0, 1, "Trabalhando")]);
    const message = {
      id: "t1",
      channelId: "c1",
      agentRunId: "r1",
      author: { type: "agent", id: "ada" },
      meta: { talker: { runId: "r1" } },
    };
    s = applyChannelEvent(s, { type: "message.created", channelId: "c1", messageId: "t1", message } as unknown as Ev);
    expect(s.runs.r1?.status).toBe("running");
  });

  test("steered with stop: the row shows it's stopping", () => {
    const s = run([delta(0, 1, "Trabalhando"), steered("m9", { stop: true })]);
    expect(s.runs.r1?.stopping).toBe(true);
  });

  test("run.continued: the stopped run is gone, the new one is live as any other", () => {
    let s = run([delta(0, 1, "Parcial"), { type: "run.canceled", ...base, byUserId: "u1" } as Ev]);
    expect(s.runs.r1).toBeUndefined();
    s = applyChannelEvent(s, {
      type: "run.continued",
      channelId: "c1",
      threadId: "m1",
      agentId: "ada",
      runId: "r1",
      newRunId: "r2",
      messageId: "m9",
    } as Ev);
    expect(s.runs.r1).toBeUndefined();
    expect(s.runs.r2).toMatchObject({ status: "thinking", agentId: "ada", threadId: "m1", triggerMessageId: "m9" });
  });
});
