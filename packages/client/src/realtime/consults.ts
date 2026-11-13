import type { ChannelEvent, ConsultationStatus, OpenConsult } from "../api/types";
import { isMediaAfterReply } from "../lib/media";

/**
 * An agent asking another agent, live (`agent.consulting` → `agent.consulted`):
 * the working line says "Dev está perguntando ao Infra… 0:12", then "Infra
 * respondeu. Dev está escrevendo…". Kept apart from the runs: `ask_agent` never
 * waits, so the asking turn says what it asked and ends while the question is
 * still out; the line stays until the answer (or the server says it's gone:
 * `reconcileConsults`, on load and reconnect). Work handed off (`tell_agent`) isn't on the line: the reply that
 * handed it shows where it is.
 */
export type LiveConsultStatus = "asking" | ConsultationStatus;

export interface LiveConsult {
  runId: string;
  /** The agent that asked. */
  agentId: string;
  /** The agent it asked. */
  consultedAgentId: string;
  channelId: string;
  threadId: string;
  status: LiveConsultStatus;
  /** When the question went out (the line's clock). */
  since: number;
  /** When the status last changed (old entries are hidden if an event was missed). */
  at: number;
}

/** By the asking run's id. */
export type ConsultsState = Record<string, LiveConsult>;

/**
 * A question still "out" this long since the last word of it missed its event: the server gives a question more
 * time every 15 min while its colleague is at it, and says so (`agent.consultation`).
 */
export const CONSULT_ASKING_MAX_MS = 20 * 60_000;
/** "Infra respondeu. Dev está escrevendo…" until the first words; gone if nothing came for this long. */
export const CONSULT_BACK_MAX_MS = 3 * 60_000;

const drop = (state: ConsultsState, runId: string) => {
  if (!state[runId]) return state;
  const { [runId]: _gone, ...rest } = state;
  return rest;
};

/** Drops the entry once the question is back (the run moved on: it writes, calls another tool, waits). */
const dropIfBack = (state: ConsultsState, runId: string) =>
  state[runId] && state[runId].status !== "asking" ? drop(state, runId) : state;

/**
 * The answer came back as a notice that woke another run of the asker (the asking run had ended):
 * that run writing (or posting) is the asker writing, so the "respondeu" line of the agent there goes.
 */
const dropBackOf = (state: ConsultsState, agentId: unknown, channelId: unknown) => {
  if (typeof agentId !== "string" || typeof channelId !== "string") return state;
  const gone = Object.values(state).filter(
    (c) => c.status !== "asking" && c.agentId === agentId && c.channelId === channelId,
  );
  return gone.reduce((s, c) => drop(s, c.runId), state);
};

export function applyConsultEvent(
  state: ConsultsState,
  event: ChannelEvent | { type: string },
  now = Date.now(),
): ConsultsState {
  // Some run events (`agent.tool`, `run.canceled`) live outside `ChannelEvent`: read them loosely.
  const e = event as unknown as {
    type: string;
    runId?: unknown;
    status?: unknown;
    tool?: unknown;
    agentId?: unknown;
    channelId?: unknown;
  };
  switch (e.type) {
    case "agent.consulting": {
      const ev = event as Extract<ChannelEvent, { type: "agent.consulting" }>;
      if (ev.kind === "note") return state;
      return {
        ...state,
        [ev.runId]: {
          runId: ev.runId,
          agentId: ev.agentId,
          consultedAgentId: ev.consultedAgentId,
          channelId: ev.channelId,
          threadId: ev.threadId,
          status: "asking",
          since: now,
          at: now,
        },
      };
    }
    case "agent.consulted": {
      const ev = event as Extract<ChannelEvent, { type: "agent.consulted" }>;
      if (ev.kind === "note") return state;
      const before = state[ev.runId];
      return {
        ...state,
        [ev.runId]: {
          runId: ev.runId,
          agentId: ev.agentId,
          consultedAgentId: ev.consultedAgentId,
          channelId: ev.channelId,
          threadId: ev.threadId,
          status: ev.status,
          since: before?.since ?? now,
          at: now,
        },
      };
    }
    // Still out, and its colleague still at it: the line stays.
    case "agent.consultation": {
      const before = typeof e.runId === "string" ? state[e.runId] : undefined;
      return before?.status === "asking" ? { ...state, [before.runId]: { ...before, at: now } } : state;
    }
    case "message.created": {
      const message = (event as Extract<ChannelEvent, { type: "message.created" }>).message;
      const runId = message?.agentRunId;
      // An agent's sticker after its reply (ADR 0091) is no answer: what its run still asks stays out.
      if (!runId || isMediaAfterReply(message?.meta)) return state;
      // "I asked; I'll tell you when the answer comes": the question is still out.
      const next = dropIfBack(state, runId);
      return message.author.type === "agent" ? dropBackOf(next, message.author.id, message.channelId) : next;
    }
    // It writes its reply now: the line says that instead.
    case "agent.delta":
    case "agent.typing":
      return typeof e.runId === "string" ? dropBackOf(dropIfBack(state, e.runId), e.agentId, e.channelId) : state;
    case "agent.tool":
      // Another tool after the answer: the line says that tool now.
      return typeof e.runId === "string" && e.tool && e.tool !== "ask_agent"
        ? dropBackOf(dropIfBack(state, e.runId), e.agentId, e.channelId)
        : state;
    // The asking turn ended (or paused): a question still out stays on the line until its answer
    // (`agent.consulted`), which wakes the agent even after its turn ended.
    case "run.canceled":
      return typeof e.runId === "string" ? dropIfBack(state, e.runId) : state;
    case "agent.run":
    case "run.finished": {
      if (typeof e.runId !== "string") return state;
      if (["failed", "done", "canceled", "waiting_input", "waiting_approval"].includes(String(e.status)))
        return dropIfBack(state, e.runId);
      return state;
    }
    default:
      return state;
  }
}

/**
 * The server's questions still out in a channel (`GET …/active-runs`, on load and reconnect): they
 * show (after a reload too, with their real clock), and an "asking" line the server no longer has
 * (answered while we weren't listening) goes. Lines heard after the request went out stay
 * (`askedAt`): the server's answer may predate them.
 */
export function reconcileConsults(
  state: ConsultsState,
  channelId: string,
  open: OpenConsult[],
  askedAt: number,
  now = Date.now(),
): ConsultsState {
  const out: ConsultsState = {};
  for (const [runId, c] of Object.entries(state)) {
    const gone = c.channelId === channelId && c.status === "asking" && c.at < askedAt;
    if (!gone || open.some((o) => o.runId === runId)) out[runId] = c;
  }
  for (const o of open) {
    const known = out[o.runId];
    if (known && known.status !== "asking") continue;
    const since = Date.parse(o.since);
    out[o.runId] = {
      runId: o.runId,
      agentId: o.agentId,
      consultedAgentId: o.consultedAgentId,
      channelId: o.channelId,
      threadId: o.threadId,
      status: "asking",
      since: Number.isNaN(since) ? (known?.since ?? now) : since,
      at: now,
    };
  }
  return out;
}

/**
 * Questions still out, as the server last said (`agents.activeRuns` publishes them): each live view
 * seeds its line from here with `reconcileConsults`.
 */
type ConsultSeed = (channelId: string, open: OpenConsult[], askedAt: number) => void;
const seeds = new Set<ConsultSeed>();
export const consultSeeds = {
  publish(channelId: string, open: OpenConsult[], askedAt: number) {
    for (const fn of seeds) fn(channelId, open, askedAt);
  },
  subscribe(fn: ConsultSeed) {
    seeds.add(fn);
    return () => {
      seeds.delete(fn);
    };
  },
};

/** The consultations to show in a channel now, oldest first (stale ones left out). */
export function consultsIn(state: ConsultsState, channelId: string, now = Date.now()): LiveConsult[] {
  return Object.values(state)
    .filter(
      (c) =>
        c.channelId === channelId && now - c.at < (c.status === "asking" ? CONSULT_ASKING_MAX_MS : CONSULT_BACK_MAX_MS),
    )
    .sort((a, b) => a.since - b.since);
}

/** "0:41", "15:00": the clock next to a question that is out. */
export function elapsedClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
