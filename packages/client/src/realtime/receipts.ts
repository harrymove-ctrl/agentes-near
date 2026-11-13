import type { ChannelEvent, ConnectIntent, DecidedBy, Message, MessageReceipts, RunStatus } from "../api/types";
import { PLATFORM_CAP } from "../lib/limits";
import { isMediaAfterReply } from "../lib/media";
import { NO_AI } from "../lib/no-ai";
import type { SteerPhase, SteerState } from "./steer";
import type { RunSteeredEvent } from "./streams";

/**
 * Agent receipts under a person's message, or an agent's that mentions agents (ADR 0089: whom it handed work to, and
 * who it only mentioned): who saw it and who is answering.
 * Built from `message.receipts` (list API) and live events: the expected
 * `message.routed` / `message.claimed` / `message.handled`, plus the run
 * events. Run events land on the messages that run answers (its trigger, and
 * messages steered into it), known from `message.routed` / `message.claimed`
 * / the list receipts; only an unknown run falls back to the event's `threadId`.
 */
/**
 * `outage`: its run is parked because its AI provider is down, and retries by itself. `queued`: in line for room on
 * its computer; `away`: waiting for its computer to come back. `plan` / `budget`: waiting for its plan's limit or its
 * budget to renew. `asking`: it asked the person something. `passed`: its run ended without answering (it passed and
 * posted nothing, or was canceled before it started); `canceled`: a person stopped it once it had started.
 */
export type ReceiptPhase =
  | "seen"
  | "picked"
  | "claimed"
  | "waiting"
  | "asking"
  | "outage"
  | "queued"
  | "away"
  | "plan"
  | "budget"
  /** Long work waiting in the agent's line of work (ADR 0121): nobody is asked anything. */
  | "line"
  | "handled"
  | "passed"
  | "canceled"
  | "failed"
  | "no_ai";

export interface MessageReceipt {
  /** The router decided (so "nobody picked it" is final). */
  routed: boolean;
  /** Something came from the server (event or list receipts). False = only the client's guess after a mention. */
  confirmed?: boolean;
  /** Agent id → phase, in the order they appeared. */
  agents: [agentId: string, phase: ReceiptPhase][];
  /** Runs answering this message (its own, the task it was steered into, the run its answer resumed). */
  runs?: string[];
  /** Agent id → the run its receipt follows: the latest heard of ("Responder agora" starts a new one). */
  runOf?: Record<string, string>;
  /** Agents the message mentions: they answer unless the server says they can't (`blocked`). */
  mentioned?: string[];
  /** Mentioned agents that won't answer (they don't reply to this person). */
  blocked?: string[];
  /**
   * Mentioned agents the message only references (part of the request to another agent, or an agent's mention the
   * judge read as no hand-off): no answer expected.
   */
  referenced?: string[];
  /** An agent's message: nobody answering it is no news (it waits for nobody). */
  byAgent?: true;
  /** Routed to nobody: the organization has no AI connected (with the Connect step the message asked for). */
  noAi?: { intent?: ConnectIntent; provider?: string };
  /** Routed to nobody: the workspace used up its platform AI for the month, so only @mentions start agents. */
  platformCap?: true;
  /** Who picked the agents (ADR 0074). */
  decidedBy?: DecidedBy;
  /** Nobody could read it (no Jev, small model, plan or rule): only a mention reaches an agent. */
  mentionNeeded?: true;
  /** The author's own plan is picking who answers, until the decision. */
  picking?: true;
  /** Agent id → why its run failed, as a run's error is worded (`runErrorText`). */
  failures?: Record<string, { code: string; params?: Record<string, string> }>;
  /** The list receipts last seeded: the same read seeded again changes nothing. */
  server?: MessageReceipts;
}

const MENTION_NEEDED = "mention_needed";

export type ReceiptsState = Record<string, MessageReceipt>;

const phaseOf = (
  status: RunStatus | "done" | "failed" | "waiting_approval" | "waiting_input" | "canceled",
  outage?: boolean,
  computer?: "queued" | "away" | "line",
  passed?: boolean,
  usage?: "plan" | "budget",
): ReceiptPhase =>
  passed
    ? "passed"
    : outage && status === "waiting_input"
      ? "outage"
      : computer && status === "waiting_input"
        ? computer
        : usage && status === "waiting_input"
          ? usage
          : status === "canceled"
            ? "canceled"
            : status === "queued"
              ? "picked"
              : status === "running"
                ? "claimed"
                : status === "waiting_approval"
                  ? "waiting"
                  : status === "waiting_input"
                    ? "asking"
                    : status === "failed"
                      ? "failed"
                      : "handled";

const RANK: Record<ReceiptPhase, number> = {
  seen: 0,
  picked: 1,
  claimed: 2,
  waiting: 2,
  asking: 2,
  outage: 2,
  queued: 2,
  away: 2,
  plan: 2,
  budget: 2,
  line: 2,
  handled: 3,
  passed: 3,
  canceled: 3,
  failed: 3,
  no_ai: 3,
};

function set(
  state: ReceiptsState,
  messageId: string,
  agentId: string,
  phase: ReceiptPhase,
  force = false,
  confirmed = true,
): ReceiptsState {
  const base = state[messageId] ?? { routed: false, agents: [] };
  const current = { ...base, confirmed: Boolean(base.confirmed || confirmed) };
  const existing = current.agents.find(([id]) => id === agentId);
  // Never move back (a late "seen" doesn't undo "respondeu"), except a new run starting again.
  if (existing && !force && RANK[phase] < RANK[existing[1]]) {
    return current.confirmed === base.confirmed ? state : { ...state, [messageId]: current };
  }
  const agents = existing
    ? current.agents.map(([id, p]) => [id, id === agentId ? phase : p] as [string, ReceiptPhase])
    : [...current.agents, [agentId, phase] as [string, ReceiptPhase]];
  return { ...state, [messageId]: { ...current, agents } };
}

/** Why an agent's run failed, kept beside its phase. */
function withFailure(
  state: ReceiptsState,
  messageId: string,
  agentId: string,
  failure: { errorCode?: string; errorParams?: Record<string, string> },
): ReceiptsState {
  const receipt = state[messageId];
  if (!failure.errorCode || !receipt) return state;
  const why = { code: failure.errorCode, ...(failure.errorParams ? { params: failure.errorParams } : {}) };
  return { ...state, [messageId]: { ...receipt, failures: { ...receipt.failures, [agentId]: why } } };
}

/**
 * Remembers that `runId` answers `messageId` (so its events land there, not on the thread's root), and that it is
 * the run `agentId`'s receipt there follows.
 */
function linkRun(
  state: ReceiptsState,
  messageId: string,
  runId: string | null | undefined,
  agentId?: string,
): ReceiptsState {
  if (!runId) return state;
  const base = state[messageId] ?? { routed: false, agents: [] };
  const runs = base.runs?.includes(runId) ? base.runs : [...(base.runs ?? []), runId];
  const runOf = agentId && base.runOf?.[agentId] !== runId ? { ...base.runOf, [agentId]: runId } : base.runOf;
  if (runs === base.runs && runOf === base.runOf) return state;
  return { ...state, [messageId]: { ...base, runs, ...(runOf ? { runOf } : {}) } };
}

/** A run's event: on every message that run answers; an unknown run falls back to `threadId`. */
function setForRun(
  state: ReceiptsState,
  runId: string | null | undefined,
  threadId: string | null | undefined,
  agentId: string,
  phase: ReceiptPhase,
  force = false,
): ReceiptsState {
  const targets = runId
    ? Object.entries(state)
        .filter(([, r]) => r.runs?.includes(runId))
        .map(([id]) => id)
    : [];
  if (targets.length === 0) return threadId ? set(state, threadId, agentId, phase, force) : state;
  let next = state;
  for (const id of targets) next = set(next, id, agentId, phase, force);
  return next;
}

/**
 * Seeds a person's message: server receipts, else the agents it mentions (they will answer). Server receipts
 * replace a local guess, and a confirmed receipt when the read is `fresh`: nothing changed that receipt since the
 * read was asked for, so the read is the newest word on it.
 */
export function seedReceipt(state: ReceiptsState, message: Message, fresh = false): ReceiptsState {
  const mentioned = message.mentionedAgentIds ?? [];
  // An agent's message has one only for the agents it mentions: the judge decides whom it hands off to.
  const byAgent = message.author?.type === "agent";
  if (message.author?.type !== "person" && !(byAgent && mentioned.length > 0)) return state;
  const existing = state[message.id];
  const r = message.receipts;
  const metaReferenced = message.meta?.referencedAgentIds;
  const referenced = r?.referenced ?? (Array.isArray(metaReferenced) ? (metaReferenced as string[]) : []);
  // The mentions stay on the receipt: "nobody will answer" needs the server to say they can't.
  const withMentions = (s: ReceiptsState): ReceiptsState => {
    const current = s[message.id];
    if (!current || mentioned.length === 0) return s;
    const next = {
      ...current,
      ...(current.mentioned ? {} : { mentioned }),
      ...(referenced.length > 0 && !current.referenced ? { referenced } : {}),
      ...(byAgent && !current.byAgent ? { byAgent: true as const } : {}),
    };
    return next.mentioned === current.mentioned &&
      next.referenced === current.referenced &&
      next.byAgent === current.byAgent
      ? s
      : { ...s, [message.id]: next };
  };
  // The list seeds again each time it changes: a read already seeded changes nothing (events may be ahead of it).
  if (existing && (!r || existing.server === r)) return withMentions(state);
  // Otherwise the read may be older than events heard since it was asked for: it only ends the run each agent's
  // receipt follows (a run's end is final), never one a newer run replaced. That shows a run end that was missed.
  if (r && existing?.confirmed && !fresh) {
    let next = state;
    for (const h of r.handled) {
      const phase = h.reason === NO_AI ? "no_ai" : phaseOf(h.status, h.outage, h.computer, h.passed, h.usage);
      const follows = existing.runOf?.[h.agentId];
      if (RANK[phase] < RANK.handled || (follows && h.runId && h.runId !== follows)) continue;
      next = linkRun(set(next, message.id, h.agentId, phase), message.id, h.runId, h.agentId);
      next = withFailure(next, message.id, h.agentId, h);
    }
    return withMentions({ ...next, [message.id]: { ...(next[message.id] ?? existing), server: r } });
  }
  let next: ReceiptsState = existing
    ? { ...state, [message.id]: { routed: false, agents: [], ...(existing.runs ? { runs: existing.runs } : {}) } }
    : state;
  if (r) {
    for (const id of r.seenBy) next = set(next, message.id, id, "seen");
    for (const id of r.pickedBy) next = set(next, message.id, id, "picked");
    for (const h of r.handled) {
      next = set(
        next,
        message.id,
        h.agentId,
        h.reason === NO_AI ? "no_ai" : phaseOf(h.status, h.outage, h.computer, h.passed, h.usage),
      );
      next = linkRun(next, message.id, h.runId, h.agentId);
      next = withFailure(next, message.id, h.agentId, h);
    }
    // Receipts come from the router's decision: "nobody picked it" is final. A read with none (the router is
    // still on it) keeps "Picking who answers", and a `message.routing` after it still counts.
    const current = next[message.id] ?? { routed: false, agents: [] };
    const decided =
      r.seenBy.length > 0 || r.handled.length > 0 || Boolean(r.noAi || r.platformCap || r.reason || r.decidedBy);
    return withMentions({
      ...next,
      [message.id]: {
        ...current,
        routed: decided,
        ...(!decided && existing?.picking ? { picking: true as const } : {}),
        blocked: r.blocked ?? [],
        // The Connect step `message.routed` asked for stays while the server still says "no AI".
        ...(r.noAi ? { noAi: existing?.noAi ?? {} } : {}),
        ...(r.platformCap ? { platformCap: true as const } : {}),
        ...(r.decidedBy ? { decidedBy: r.decidedBy } : {}),
        ...(r.reason === MENTION_NEEDED ? { mentionNeeded: true as const } : {}),
        server: r,
      },
    });
  }
  // A person's mention: the server resolved it, so that agent will answer (unless the message only references it). An
  // agent's waits for the judge.
  for (const id of mentioned)
    next = set(next, message.id, id, byAgent || referenced.includes(id) ? "seen" : "picked", false, false);
  return withMentions(next);
}

/**
 * A read of messages. `before`: the receipts when it was asked for; one that hasn't changed since takes the read as it
 * is (`seedReceipt`), so a run that moved while nobody listened reads as it is now.
 */
export function seedReceipts(state: ReceiptsState, messages: readonly Message[], before?: ReceiptsState) {
  let next = state;
  for (const m of messages) next = seedReceipt(next, m, before !== undefined && next[m.id] === before[m.id]);
  return next;
}

/** The client's guess right after an explicit @mention or an agent DM (not confirmed; times out). */
export function guessReceipt(state: ReceiptsState, messageId: string, agentIds: string[]): ReceiptsState {
  let next = state;
  for (const id of agentIds) next = set(next, messageId, id, "picked", false, false);
  return next;
}

export function applyReceiptEvent(
  state: ReceiptsState,
  event: ChannelEvent | (RunSteeredEvent & { agentId?: string }),
): ReceiptsState {
  switch (event.type) {
    case "message.routing": {
      const current = state[event.messageId] ?? { routed: false, agents: [] };
      if (current.routed || current.picking) return state;
      return { ...state, [event.messageId]: { ...current, picking: true } };
    }
    case "message.routed": {
      // The router's decision wins over any guess: agents not picked only "saw" it.
      const picked = new Set(event.pickedBy);
      const before = state[event.messageId];
      let next: ReceiptsState = before
        ? {
            ...state,
            [event.messageId]: {
              ...before,
              agents: before.agents.map(([id, p]) => [id, p === "picked" && !picked.has(id) ? "seen" : p]),
            },
          }
        : state;
      for (const id of event.seenBy) next = set(next, event.messageId, id, "seen");
      for (const id of event.pickedBy) next = set(next, event.messageId, id, "picked");
      for (const r of event.runs ?? []) next = linkRun(next, event.messageId, r.runId, r.agentId);
      const {
        noAi: _before,
        platformCap: _capped,
        picking: _picking,
        decidedBy: _decidedBy,
        mentionNeeded: _mentionNeeded,
        ...current
      } = next[event.messageId] ?? { routed: false, agents: [] };
      // Mentioned agents that got nothing: said explicitly, or the whole decision was "nobody".
      const blocked = event.blocked ?? (event.strategy === "none" ? event.seenBy : current.blocked);
      const referenced = event.referenced ?? current.referenced;
      return {
        ...next,
        [event.messageId]: {
          ...current,
          routed: true,
          confirmed: true,
          ...(blocked ? { blocked } : {}),
          ...(referenced ? { referenced } : {}),
          // Routed again once an AI is connected: the decision that replaces it says what happens now.
          ...(event.reason === NO_AI ? { noAi: { intent: event.intent, provider: event.provider } } : {}),
          ...(event.reason === PLATFORM_CAP ? { platformCap: true as const } : {}),
          ...(event.decidedBy ? { decidedBy: event.decidedBy } : {}),
          ...(event.reason === MENTION_NEEDED ? { mentionNeeded: true as const } : {}),
        },
      };
    }
    case "message.claimed":
      // A run the receipt didn't follow yet (Tentar de novo starts a new one on the same message): it is the news.
      return set(
        linkRun(state, event.messageId, event.runId, event.agentId),
        event.messageId,
        event.agentId,
        "claimed",
        state[event.messageId]?.runOf?.[event.agentId] !== event.runId,
      );
    case "message.handled":
      return withFailure(
        set(
          linkRun(state, event.messageId, event.runId, event.agentId),
          event.messageId,
          event.agentId,
          event.reason === NO_AI
            ? "no_ai"
            : event.status
              ? phaseOf(event.status, event.outage, event.computer, event.passed, event.usage)
              : "handled",
        ),
        event.messageId,
        event.agentId,
        event,
      );
    case "agent.run.steered": {
      // Went into the agent's task in progress: that agent is on it (a "stop" ends it). A task other than the run the
      // receipt follows (Tentar de novo after a failure joins one) is the news, as `message.claimed`'s is.
      const linked = linkRun(state, event.messageId, event.runId, event.agentId);
      const phase = event.stop ? "handled" : (event.computer ?? event.usage ?? "claimed");
      const moved = Boolean(event.agentId && state[event.messageId]?.runOf?.[event.agentId] !== event.runId);
      return event.agentId ? set(linked, event.messageId, event.agentId, phase, moved) : linked;
    }
    case "agent.run":
      return setForRun(
        state,
        event.runId,
        event.triggerMessageId ?? event.threadId,
        event.agentId,
        phaseOf(event.status, event.outage, event.computer, false, event.usage),
        event.status === "running",
      );
    case "agent.thinking":
      // Announced at post time = picked; a run thinking = answering.
      return event.runId === null
        ? set(state, event.threadId, event.agentId, "picked")
        : setForRun(state, event.runId, event.threadId, event.agentId, "claimed", true);
    case "agent.typing":
      return setForRun(state, event.runId, event.threadId, event.agentId, "claimed", true);
    case "run.finished":
      return setForRun(
        state,
        event.runId,
        event.threadId,
        event.agentId,
        phaseOf(event.status, event.outage, event.computer, event.passed, event.usage),
        event.status === "waiting_approval",
      );
    case "question.asked":
      // The agent waits for a person: "Theo está esperando uma resposta" (on the message its run answers).
      return setForRun(state, event.question.runId, event.threadId, event.question.agentId, "asking", true);
    case "question.answered":
      return setForRun(state, event.question.runId, event.threadId, event.question.agentId, "claimed", true);
    case "message.created": {
      const m = event.message;
      // An agent's sticker after its reply (ADR 0091) answers nobody: a newer message's receipt stays. Neither does its
      // note that it still waits for its computer, or for its plan or budget, or why it didn't answer.
      if (
        m?.author?.type === "agent" &&
        m.author.id &&
        m.threadId &&
        !m.meta?.approvalId &&
        !m.meta?.brainUnavailable &&
        !m.meta?.usageWait &&
        !isMediaAfterReply(m.meta)
      ) {
        return setForRun(state, m.agentRunId, m.threadId, m.author.id, "handled");
      }
      return state;
    }
    default:
      return state;
  }
}

/** The receipt row's words, e.g. "Ada vai responder" / "Nenhum agente vai responder". */
export interface ReceiptView {
  seen: string[];
  /** Main status, or null when there is nothing to say yet. */
  status:
    | {
        kind:
          | "picked"
          | "claimed"
          | "waiting"
          | "asking"
          | "outage"
          | "away"
          | "queued"
          | "plan"
          | "budget"
          | "line"
          | "handled"
          | "canceled"
          | "failed";
        agents: string[];
      }
    /** Every agent it was for ended without answering: "No one replied", and a person can call one. */
    | { kind: "passed"; agents: string[] }
    /** `mentionNeeded`: no step could read it and no rule fit, so only a mention reaches an agent. */
    | { kind: "nobody"; mentionNeeded?: true }
    /** Nobody will answer for want of an AI (`agents`: those that couldn't think; empty: nobody was asked). */
    | { kind: "no_ai"; agents: string[] }
    /** Nobody was asked: the workspace used up its platform AI for the month, an @mention still gets an answer. */
    | { kind: "platform_cap" }
    | null;
  /** Everyone who answered answered: the row can shrink to avatars. */
  done: boolean;
  /** Agents the message only references (no answer expected from them). */
  referenced: string[];
  /** Who picked the agents (ADR 0074), when the server said. */
  decidedBy?: DecidedBy;
  /** The author's own plan is picking who answers: "Picking who answers" until the decision. */
  picking?: true;
}

/** Which words a message's steer state reads in: an agent waiting for its computer has no next pause to read it at. */
export function steerWords(steer: SteerState, receipt: MessageReceipt | undefined): SteerPhase | "computer" {
  const computer = receipt?.agents.some(([id, p]) => id === steer.agentId && (p === "queued" || p === "away"));
  return steer.state === "waiting" && computer ? "computer" : steer.state;
}

export function receiptView(receipt: MessageReceipt | undefined): ReceiptView {
  if (receipt?.picking && !receipt.routed)
    return { seen: [], status: null, done: false, referenced: [], picking: true };
  if (!receipt || (receipt.agents.length === 0 && !receipt.noAi && !receipt.platformCap))
    return { seen: [], status: null, done: false, referenced: [] };
  const decided = receipt.decidedBy ? { decidedBy: receipt.decidedBy } : {};
  const seen = receipt.agents.map(([id]) => id);
  const referenced = (receipt.referenced ?? []).filter((id) => seen.includes(id));
  const with_ = (phase: ReceiptPhase) => receipt.agents.filter(([, p]) => p === phase).map(([id]) => id);
  // "Ninguém vai responder: falta uma IA" only while no other agent answers it.
  const noAi = with_("no_ai");
  if ((noAi.length > 0 || receipt.noAi) && receipt.agents.every(([, p]) => p === "seen" || p === "no_ai"))
    return { seen, status: { kind: "no_ai", agents: noAi }, done: false, referenced };
  for (const kind of [
    "failed",
    "outage",
    "away",
    "queued",
    "plan",
    "budget",
    "line",
    "asking",
    "waiting",
    "claimed",
    "picked",
  ] as const) {
    const agents = with_(kind);
    if (agents.length) return { seen, status: { kind, agents }, done: false, referenced, ...decided };
  }
  // One answer is an answer, whoever else passed.
  const handled = with_("handled");
  if (handled.length) return { seen, status: { kind: "handled", agents: handled }, done: true, referenced, ...decided };
  const canceled = with_("canceled");
  if (canceled.length)
    return { seen, status: { kind: "canceled", agents: canceled }, done: true, referenced, ...decided };
  const passed = with_("passed");
  if (passed.length) return { seen, status: { kind: "passed", agents: passed }, done: true, referenced, ...decided };
  if (receipt.platformCap) return { seen, status: { kind: "platform_cap" }, done: false, referenced };
  // A mention always gets an answer unless the server said that agent can't, or that the message only
  // references it (never "nobody" on a guess).
  const blocked = new Set([...(receipt.blocked ?? []), ...(receipt.referenced ?? [])]);
  const unanswered = (receipt.mentioned ?? []).some((id) => !blocked.has(id));
  const nobody = receipt.mentionNeeded
    ? { kind: "nobody" as const, mentionNeeded: true as const }
    : { kind: "nobody" as const };
  return {
    seen,
    status: receipt.routed && !unanswered && !receipt.byAgent ? nobody : null,
    done: false,
    referenced,
    ...decided,
  };
}

/**
 * The mark on a message's receipt, as the person reads it: the clock while nobody picked it up yet (no agent took it,
 * or the ones picked still wait in line), one tick once an agent got it and is on it, two once everyone it was for
 * acted: answered, or decided not to (routed to nobody, an agent's reaction, an only mention).
 */
export type ReceiptTicks = "clock" | "check" | "checks";

const ACTED: ReadonlySet<ReceiptPhase> = new Set(["handled", "passed", "canceled", "failed", "no_ai"]);

export function receiptTicks(receipt: MessageReceipt | undefined): ReceiptTicks {
  if (!receipt || (receipt.picking && !receipt.routed)) return "clock";
  const expected = receipt.agents.filter(([id, p]) => p !== "seen" && !receipt.referenced?.includes(id));
  if (expected.length === 0) return receipt.routed ? "checks" : "clock";
  if (expected.every(([, p]) => ACTED.has(p))) return "checks";
  return expected.some(([, p]) => p !== "picked") ? "check" : "clock";
}
