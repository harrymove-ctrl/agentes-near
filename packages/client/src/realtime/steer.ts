import { useMemo, useSyncExternalStore } from "react";
import type { ActiveRun, Message, WaitMessageOutcome } from "../api/types";

/**
 * What became of a message a person sent while an agent worked or waited (it
 * went into the agent's task in progress), so they always know:
 * - `waiting`: "Ada lê na próxima pausa" (queued on the run; also on the new
 *   run it was handed to when the first one ended without reading it);
 * - `now`: "Ada parou para ler" (sent with "Parar e mandar", or it woke a
 *   waiting run), until it is read;
 * - `delivered`: "Ada recebeu" (handed to Claude Code mid-turn, read at its
 *   next tool boundary);
 * - `held`: "Ada lê depois da sua decisão" (the run waits for an
 *   approval: chat text never decides one);
 * - `read`: "Ada leu";
 * - `resolved`: "Ada encerrou o pedido de ajuda" (it ended the run's wait,
 *   e.g. "pronto, loguei" closed the browser help).
 * Nothing sent to an agent goes nowhere: a run that ends without reading a
 * message hands it to a new run (`agent.run.redispatched`), and the receipt
 * follows it there.
 *
 * Live from `agent.run.steered` (with `now`), `agent.run.delivered`,
 * `agent.run.read`, `agent.run.redispatched`, `agent.run.wait_message` and the
 * run's start and end; on load and reconnect from the messages'
 * `meta.steeredRunIds` and the channel's active runs (`pendingMessageIds`): a
 * message still pending in an active run (or about to start one) waits, held
 * when that run waits for an approval; otherwise its run read it.
 *
 * One store per app, fed by `RealtimeConnection` (events) and the HTTP client
 * (message lists, active runs), so web and phone read it the same way:
 * `useSteerState(orgId, channelId, messageId)`.
 */
export type SteerPhase = "waiting" | "now" | "delivered" | "held" | "read" | "resolved";

export interface SteerState {
  runId: string;
  agentId: string;
  state: SteerPhase;
}

interface LiveSteer extends SteerState {
  channelId: string;
  /** When we heard it (an active-runs list asked earlier can't undo it). */
  at: number;
  /** It starts its run (handed over from a run that ended): read once that run is under way. */
  starts?: true;
}

/** An active run as last listed: its agent, its unread messages, what started it, and its status. */
interface ListedRun {
  agentId: string;
  pending: string[];
  trigger: string | null;
  status: string;
}

export interface SteerStoreState {
  /** From events, by message id. */
  live: Record<string, LiveSteer>;
  /** From message lists: the runs each message went into (agent from its receipts, when known). */
  seeded: Record<string, { channelId: string; runs: { runId: string; agentId: string | null }[] }>;
  /** The active runs of each channel as last listed, by run id. */
  active: Record<string, Record<string, ListedRun>>;
  /** Stopped replies someone continued ("Continuar"): message id → the new run. */
  continued: Record<string, string>;
}

export const emptySteer: SteerStoreState = { live: {}, seeded: {}, active: {}, continued: {} };

/** The events this store reads (the rest pass through unchanged). */
export type SteerEvent =
  | {
      type: "agent.run.steered";
      channelId: string;
      runId: string;
      agentId?: string;
      messageId: string;
      now?: boolean;
      stop?: boolean;
    }
  | { type: "agent.run.read"; channelId: string; runId: string; agentId: string; messageIds: string[] }
  | { type: "agent.run.delivered"; channelId: string; runId: string; agentId: string; messageIds: string[] }
  | {
      type: "agent.run.redispatched";
      channelId: string;
      runId: string;
      newRunId: string;
      agentId: string;
      messageIds: string[];
    }
  | {
      type: "agent.run.wait_message";
      channelId: string;
      runId: string;
      agentId: string;
      messageId: string;
      outcome: WaitMessageOutcome;
    }
  | { type: "agent.passed"; channelId: string; runId: string }
  | { type: "agent.run"; channelId: string; runId: string; status: string }
  | { type: "agent.typing" | "agent.delta" | "agent.tool"; channelId: string; runId: string }
  | { type: "run.continued"; channelId: string; runId: string; newRunId: string; messageId: string }
  | { type: "run.finished"; channelId: string; runId: string; status: string }
  | { type: "run.canceled"; channelId: string; runId: string }
  | { type: string };

/** Final: nothing later about the same run takes it back. */
const settled = (s: Pick<LiveSteer, "state">) => s.state === "read" || s.state === "resolved";

/** Rewrites the live entries of one run (`fix` returns the entry itself to leave it). */
function eachOfRun(state: SteerStoreState, runId: string, fix: (s: LiveSteer) => LiveSteer): SteerStoreState {
  let live = state.live;
  for (const [id, s] of Object.entries(state.live)) {
    if (s.runId !== runId) continue;
    const next = fix(s);
    if (next === s) continue;
    if (live === state.live) live = { ...state.live };
    live[id] = next;
  }
  return live === state.live ? state : { ...state, live };
}

/**
 * The run answered or passed: it read what it had. A run that failed or was stopped keeps its
 * unread messages as they are: the server hands them to a new run (`agent.run.redispatched`),
 * and a reconnect's active-runs list settles them if that event was missed.
 */
const endRun = (state: SteerStoreState, runId: string) =>
  eachOfRun(state, runId, (s) => (settled(s) ? s : { ...s, state: "read" }));

/** The run is under way: the messages it was started with are in its conversation now. */
const startRun = (state: SteerStoreState, runId: string) =>
  eachOfRun(state, runId, (s) => (s.starts && s.state === "waiting" ? { ...s, state: "read" } : s));

/** Sets these messages' phase on `e.runId`, except where `keep` says that run already got further. */
function mark(
  state: SteerStoreState,
  e: { channelId: string; runId: string; agentId: string },
  ids: string[],
  phase: SteerPhase,
  now: number,
  keep: (current: LiveSteer) => boolean,
): SteerStoreState {
  let live = state.live;
  for (const id of ids) {
    const current = state.live[id];
    if (current && current.runId === e.runId && keep(current)) continue;
    if (live === state.live) live = { ...state.live };
    live[id] = { runId: e.runId, agentId: e.agentId, channelId: e.channelId, state: phase, at: now };
  }
  return live === state.live ? state : { ...state, live };
}

export function applySteerEvent(state: SteerStoreState, event: SteerEvent, now = Date.now()): SteerStoreState {
  switch (event.type) {
    case "agent.run.steered": {
      const e = event as Extract<SteerEvent, { type: "agent.run.steered" }>;
      // A "stop": the run is being canceled; the receipt says so, not this.
      if (e.stop) {
        if (!state.live[e.messageId]) return state;
        const { [e.messageId]: _gone, ...live } = state.live;
        return { ...state, live };
      }
      const agentId = e.agentId ?? state.live[e.messageId]?.agentId;
      if (!agentId) return state;
      // Already further along on this run (events can cross): never back to waiting.
      return mark(
        state,
        { ...e, agentId },
        [e.messageId],
        e.now ? "now" : "waiting",
        now,
        (c) => c.state !== "waiting",
      );
    }
    case "agent.run.delivered": {
      const e = event as Extract<SteerEvent, { type: "agent.run.delivered" }>;
      // Handed over, not read yet: never undoes a "leu" (or a held one) on the same run.
      return mark(state, e, e.messageIds, "delivered", now, (c) => settled(c) || c.state === "held");
    }
    case "agent.run.read": {
      const e = event as Extract<SteerEvent, { type: "agent.run.read" }>;
      // "Encerrou o pedido de ajuda" says more than "leu": it stays.
      return mark(state, e, e.messageIds, "read", now, (c) => c.state === "resolved");
    }
    case "agent.run.wait_message": {
      const e = event as Extract<SteerEvent, { type: "agent.run.wait_message" }>;
      // `woke`: the run stopped waiting to read it, like "Parar e mandar".
      const phase: SteerPhase = e.outcome === "resolved" ? "resolved" : e.outcome === "held" ? "held" : "now";
      const keep = phase === "resolved" ? (c: LiveSteer) => c.state === "resolved" : settled;
      return mark(state, e, [e.messageId], phase, now, keep);
    }
    case "agent.run.redispatched": {
      const e = event as Extract<SteerEvent, { type: "agent.run.redispatched" }>;
      // It follows to the new run, waiting there (whatever the old run's end said: it hadn't read it),
      // unless the new run already got further with it.
      let live = state.live;
      for (const id of e.messageIds) {
        if (state.live[id]?.runId === e.newRunId) continue;
        if (live === state.live) live = { ...state.live };
        live[id] = {
          runId: e.newRunId,
          agentId: e.agentId,
          channelId: e.channelId,
          state: "waiting",
          at: now,
          starts: true,
        };
      }
      return live === state.live ? state : { ...state, live };
    }
    case "agent.run":
    case "agent.typing":
    case "agent.delta":
    case "agent.tool": {
      const e = event as { type: string; runId?: unknown; status?: unknown };
      if (typeof e.runId !== "string") return state;
      if (e.status === "done") return endRun(state, e.runId);
      if (e.type === "agent.run" && e.status !== "running") return state;
      return startRun(state, e.runId);
    }
    case "agent.passed":
      return endRun(state, (event as Extract<SteerEvent, { type: "agent.passed" }>).runId);
    case "run.finished": {
      const e = event as Extract<SteerEvent, { type: "run.finished" }>;
      return e.status === "done" ? endRun(state, e.runId) : state;
    }
    case "run.continued": {
      const e = event as Extract<SteerEvent, { type: "run.continued" }>;
      if (state.continued[e.messageId] === e.newRunId) return state;
      return { ...state, continued: { ...state.continued, [e.messageId]: e.newRunId } };
    }
    default:
      return state;
  }
}

/** A message list arrived: which runs each person's message went into, and stopped replies already continued. */
export function seedSteerMessages(state: SteerStoreState, channelId: string, list: Message[]): SteerStoreState {
  let seeded = state.seeded;
  let continued = state.continued;
  for (const m of list) {
    const runIds = m.meta?.steeredRunIds;
    if (m.author?.type === "person" && Array.isArray(runIds) && runIds.length > 0 && !seeded[m.id]) {
      const runs = runIds
        .filter((id): id is string => typeof id === "string")
        .map((runId) => ({
          runId,
          agentId: m.receipts?.handled.find((h) => h.runId === runId)?.agentId ?? null,
        }));
      if (seeded === state.seeded) seeded = { ...state.seeded };
      seeded[m.id] = { channelId, runs };
    }
    const next = continuedRunIdOf(m);
    if (next && continued[m.id] !== next) {
      if (continued === state.continued) continued = { ...state.continued };
      continued[m.id] = next;
    }
  }
  return seeded === state.seeded && continued === state.continued ? state : { ...state, seeded, continued };
}

/**
 * Where a message still waits among a channel's active runs (the runs it went into first): pending
 * in one (held while that run waits for an approval), or the message a queued run starts with (it
 * was handed over when its first run ended). Null: no active run still has it unread.
 */
function waitingIn(
  listed: Record<string, ListedRun>,
  messageId: string,
  first: string[],
): (SteerState & { starts?: true }) | null {
  const order = [...first.filter((id) => listed[id]), ...Object.keys(listed).filter((id) => !first.includes(id))];
  for (const runId of order) {
    const a = listed[runId] as ListedRun;
    if (a.pending.includes(messageId)) {
      return { runId, agentId: a.agentId, state: a.status === "waiting_approval" ? "held" : "waiting" };
    }
    if (a.trigger === messageId && a.status === "queued") {
      return { runId, agentId: a.agentId, state: "waiting", starts: true };
    }
  }
  return null;
}

/**
 * The channel's active runs as the server lists them (`GET …/active-runs`, asked at `askedAt`):
 * the truth for messages heard about before the question (missed events after a reconnect).
 */
export function reconcileSteer(
  state: SteerStoreState,
  channelId: string,
  runs: ActiveRun[],
  askedAt = Date.now(),
): SteerStoreState {
  const active: Record<string, ListedRun> = {};
  for (const r of runs) {
    active[r.runId] = {
      agentId: r.agentId,
      pending: r.pendingMessageIds ?? [],
      trigger: r.triggerMessageId ?? null,
      status: r.status,
    };
  }
  let live = state.live;
  for (const [id, s] of Object.entries(state.live)) {
    if (s.channelId !== channelId || settled(s) || s.at > askedAt) continue;
    const where = waitingIn(active, id, [s.runId]);
    // Still unread on its run: what we heard stands.
    if (where?.runId === s.runId) continue;
    if (live === state.live) live = { ...state.live };
    // Handed to another run (we missed the event), or its run read it.
    live[id] = where ? { ...s, ...where } : { ...s, state: "read" };
  }
  return { ...state, live, active: { ...state.active, [channelId]: active } };
}

/** The steer state of a message, or null (not sent into a task, or not known yet). */
export function steerStateIn(state: SteerStoreState, messageId: string): SteerState | null {
  const live = state.live[messageId];
  if (live) return { runId: live.runId, agentId: live.agentId, state: live.state };
  const seeded = state.seeded[messageId];
  const listed = seeded ? state.active[seeded.channelId] : undefined;
  if (!seeded || !listed) return null;
  const where = waitingIn(
    listed,
    messageId,
    seeded.runs.map((r) => r.runId),
  );
  if (where) return { runId: where.runId, agentId: where.agentId, state: where.state };
  for (const r of seeded.runs) {
    const agentId = r.agentId ?? listed[r.runId]?.agentId;
    if (agentId) return { runId: r.runId, agentId, state: "read" };
  }
  return null;
}

/**
 * The run that continues this stopped reply (`meta.canceled.continuedRunId`), this reply of a run that ended at
 * its step limit (`meta.stepLimit.continuedRunId`), or this end of a long work (`meta.workEnd.continuedRunId`), if any.
 */
export function continuedRunIdOf(message: Pick<Message, "meta">): string | null {
  const ended = (message.meta?.canceled ?? message.meta?.stepLimit ?? message.meta?.workEnd) as
    | { continuedRunId?: unknown }
    | undefined;
  return typeof ended?.continuedRunId === "string" ? ended.continuedRunId : null;
}

// ── The app's one store ───────────────────────────────────────────────────────

let current: SteerStoreState = emptySteer;
const listeners = new Set<() => void>();

function update(next: SteerStoreState) {
  if (next === current) return;
  current = next;
  for (const l of [...listeners]) l();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Fed by `RealtimeConnection` and the HTTP client; tests may feed and reset it by hand. */
export const steerStore = {
  get: () => current,
  apply: (event: SteerEvent, now = Date.now()) => update(applySteerEvent(current, event, now)),
  seed: (channelId: string, list: Message[]) => update(seedSteerMessages(current, channelId, list)),
  reconcile: (channelId: string, runs: ActiveRun[], askedAt?: number) =>
    update(reconcileSteer(current, channelId, runs, askedAt)),
  subscribe,
  reset: () => update(emptySteer),
};

/** The steer state of a message right now (outside React). */
export const steerStateOf = (messageId: string) => steerStateIn(current, messageId);

/** The run that continues this stopped reply, heard live or from its meta. */
export const continuedRunOf = (messageId: string) => current.continued[messageId] ?? null;

const keyOf = (s: SteerState | null) => (s ? `${s.state}|${s.runId}|${s.agentId}` : "");

/**
 * Under a person's message: "lê na próxima pausa" / "parou para ler" / "recebeu" / "lê depois da sua
 * decisão" / "leu" / "encerrou o pedido de ajuda", or null.
 * `orgId` and `channelId` name where the message is (ids are unique; the store is the app's).
 */
export function useSteerState(_orgId: string, _channelId: string, messageId: string): SteerState | null {
  const key = useSyncExternalStore(
    subscribe,
    () => keyOf(steerStateOf(messageId)),
    () => "",
  );
  return useMemo(() => {
    if (!key) return null;
    const [state, runId, agentId] = key.split("|") as [SteerPhase, string, string];
    return { runId, agentId, state };
  }, [key]);
}

/** "Continuar" was used on this stopped reply (here or on another device): the new run's id, or null. */
export function useContinuedRun(messageId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => continuedRunOf(messageId),
    () => null,
  );
}
