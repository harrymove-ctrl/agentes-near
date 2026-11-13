import type { TFunction } from "i18next";
import type { ComputerQueue, Message, QueuePurpose, QueueWaiting, QueueWorking } from "../api/types";
import type { MessageReceipt, ReceiptPhase, ReceiptsState } from "../realtime/receipts";
import { joinNames, namesText, ordinalForm } from "./format";
import { agentGrammar } from "./grammar";

/**
 * A shared computer's line (ADR 0032, "Calm waits"), for the web and the phone: the queue dialog, the agent's live
 * row while it waits, the fan-out strip under a message that called several agents, and the outage card's pill.
 * Every time is an estimate, worded "~N min", never as exact.
 */

/** Whole minutes until `iso`, at least 1: an estimate never reads "0 min". */
export const etaMinutes = (iso: string, now: number) => Math.max(1, Math.round((Date.parse(iso) - now) / 60_000));

/** "3 min", "40 s", "2 h", "3 dias": how long something has gone on. */
export function durationText(t: TFunction, ms: number) {
  if (ms < 60_000) return t("run.elapsedSeconds", { n: Math.max(1, Math.round(ms / 1000)) });
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t("format.inMinutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t("format.inHours", { count: hours }) : t("format.inDays", { count: Math.round(hours / 24) });
}

/** "1st", "4º", "4." in the language's own ordinal form. */
export function nthText(t: TFunction, locale: string, n: number) {
  const form = ordinalForm(locale, n);
  return t(`queue.nth.${form === "one" || form === "two" || form === "few" ? form : "other"}`, { n });
}

export type QueueRow<T> = T & {
  /** The viewer asked for it: highlighted. */
  mine: boolean;
};

export interface QueueView {
  working: QueueRow<QueueWorking>[];
  waiting: QueueRow<QueueWaiting>[];
  /** Turns wait for room: the computer is full. */
  full: boolean;
  /** When the next in line should start (null: no basis). */
  nextStartAt: string | null;
  /** When the last in line should start, once every estimate is known. */
  allStartedAt: string | null;
}

const mineOf = (p: QueuePurpose, viewerId: string) => p.kind === "person" && p.userId === viewerId;

export function queueView(queue: ComputerQueue, viewerId: string): QueueView {
  const waiting = queue.waiting.map((w) => ({ ...w, mine: mineOf(w.purpose, viewerId) }));
  const last = waiting.at(-1);
  return {
    working: queue.working.map((w) => ({ ...w, mine: mineOf(w.purpose, viewerId) })),
    waiting,
    full: waiting.length > 0,
    nextStartAt: waiting[0]?.estimatedStartAt ?? null,
    allStartedAt: waiting.every((w) => w.estimatedStartAt) ? (last?.estimatedStartAt ?? null) : null,
  };
}

/** What fills the computer now: "5 asked by agents, 2 routines", or null with nothing on it. */
export function queueFillText(t: TFunction, working: readonly Pick<QueueWorking, "purpose">[]) {
  const parts = (["agent", "person", "routine", "work"] as const).flatMap((kind) => {
    const count = working.filter((w) => w.purpose.kind === kind).length;
    return count > 0 ? [t(`queue.fill.${kind}`, { count })] : [];
  });
  return parts.length ? joinNames(parts, t) : null;
}

/** "Computer · 9 waiting", or "Computer" while nothing waits. */
export const queueButtonText = (t: TFunction, queue: ComputerQueue | null | undefined) =>
  queue?.waiting.length ? t("queue.button", { count: queue.waiting.length }) : t("queue.buttonIdle");

/** "Full · next starts in about 1 min", "Full", "Nobody in line". */
export function queueStatusText(t: TFunction, view: QueueView, now: number) {
  if (!view.full) return t("queue.free");
  return view.nextStartAt ? t("queue.fullNext", { n: etaMinutes(view.nextStartAt, now) }) : t("queue.full");
}

/** "all started in ~6 min", or null with no basis or one in line (its row says it). */
export const queueAllStartedText = (t: TFunction, view: QueueView, now: number) =>
  view.allStartedAt && view.waiting.length > 1
    ? t("queue.allStarted", { n: etaMinutes(view.allStartedAt, now) })
    : null;

export interface QueueNames {
  viewerId: string;
  agent: (agentId: string) => string | undefined;
  person: (userId: string) => string | undefined;
}

/** What a turn is for: "answering you", "answering Theo", "asked by Ravi", "a routine", "long work". */
export function queuePurposeText(t: TFunction, p: QueuePurpose, names: QueueNames) {
  switch (p.kind) {
    case "person": {
      if (p.userId === names.viewerId) return t("queue.purpose.you");
      const name = p.userId ? names.person(p.userId) : undefined;
      return name ? t("queue.purpose.person", { name }) : t("queue.purpose.someone");
    }
    case "agent": {
      const name = p.agentId ? names.agent(p.agentId) : undefined;
      return name ? t("queue.purpose.agent", { name }) : t("queue.purpose.someAgent");
    }
    case "routine":
      return t("queue.purpose.routine");
    case "work":
      return t("queue.purpose.work");
  }
}

/** Where a turn answers, as the app knows the conversation: a channel by name, a DM, or one the viewer can't open. */
export type QueuePlace =
  | { kind: "channel"; name: string; thread: boolean }
  | { kind: "dm"; mine: boolean; withName?: string }
  /** Two agents' private conversation, for who may see that work. */
  | { kind: "agents" }
  | { kind: "hidden" };

/** "#dev", "a thread in #dev", "your DM", "DM with Theo", "a talk between agents", "a private conversation". */
export function queueWhereText(t: TFunction, place: QueuePlace) {
  if (place.kind === "agents") return t("queue.where.agents");
  if (place.kind === "channel") return place.thread ? t("queue.where.thread", { name: place.name }) : `#${place.name}`;
  if (place.kind === "dm") {
    if (place.mine) return t("queue.where.yourDm");
    return place.withName ? t("queue.where.dm", { name: place.withName }) : t("queue.where.private");
  }
  return t("queue.where.private");
}

/**
 * A working row's time: "~2 min left", "past its usual time" (no estimate is honest then), or null with no basis. A
 * line nobody waits in isn't asked again, so an estimate can pass while the dialog is open.
 */
export function queueLeftText(t: TFunction, w: QueueWorking, now: number) {
  if (w.overdue || (w.estimatedEndAt && Date.parse(w.estimatedEndAt) <= now)) return t("queue.overdue");
  return w.estimatedEndAt ? t("queue.left", { n: etaMinutes(w.estimatedEndAt, now) }) : null;
}

/** A waiting row's time: "starts ~3 min", "starts once Ada finishes", or null. */
export function queueStartText(
  t: TFunction,
  w: QueueWaiting,
  agentName: (id: string) => string | undefined,
  now: number,
) {
  if (w.estimatedStartAt) return t("queue.startsIn", { n: etaMinutes(w.estimatedStartAt, now) });
  const after = w.position === 1 && w.after[0] ? agentName(w.after[0]) : undefined;
  return after ? t("queue.startsAfter", { after: t("queue.who", agentGrammar(after)) }) : null;
}

/**
 * The waiting agent's live row: "Waiting for the computer. Next up, in about 1 min" when the line can say when, else
 * "… Next up" alone, or "In line, 4th. After Ada, Kai and Ravi". Null when the run isn't in this computer's line.
 */
export function queueLiveText(
  t: TFunction,
  locale: string,
  queue: ComputerQueue | null | undefined,
  runId: string,
  agentName: (id: string) => string | undefined,
  now: number,
) {
  const w = queue?.waiting.find((x) => x.runId === runId);
  if (!w) return null;
  const { context } = agentGrammar(agentName(w.agentId) ?? "");
  if (w.position === 1) {
    if (w.estimatedStartAt) return t("queue.live.nextEta", { n: etaMinutes(w.estimatedStartAt, now), context });
    return t("queue.live.next", { context });
  }
  const names = w.after.flatMap((id) => agentName(id) ?? []);
  const nth = nthText(t, locale, w.position);
  return names.length
    ? t("queue.live.behind", { nth, names: namesText(t, names, 3) })
    : t("queue.live.position", { nth });
}

/**
 * An agent's place in line for a message: its run as the receipt follows it, else its one waiting turn in this
 * conversation (a new mention joins the turn already waiting).
 */
export function waitingFor(
  queue: ComputerQueue | null | undefined,
  receipt: Pick<MessageReceipt, "runOf"> | undefined,
  agentId: string,
  channelId: string,
): QueueWaiting | null {
  const runId = receipt?.runOf?.[agentId];
  const waiting = queue?.waiting ?? [];
  return (
    (runId ? waiting.find((w) => w.runId === runId) : undefined) ??
    waiting.find((w) => w.agentId === agentId && w.where.channelId === channelId) ??
    null
  );
}

export interface ConversationWait {
  agentId: string;
  runId: string | null;
}

/**
 * The waits for a computer a conversation shows, one per run however many messages went into it: what the receipts
 * say, so a read of the line that hasn't heard of the run, or lost it, never takes one away. A run with a live row
 * (`hasRow`) left the line whatever a receipt that missed it says. The agents of a message with a fan-out strip are
 * left to the strip.
 */
export function conversationWaits(
  messages: readonly Pick<Message, "id" | "author">[],
  receipts: ReceiptsState,
  hasRow: (runId: string) => boolean,
): ConversationWait[] {
  const waits = new Map<string, ConversationWait>();
  for (const m of messages) {
    const receipt = receipts[m.id];
    const queued = receipt?.agents.filter(([, phase]) => phase === "queued") ?? [];
    if (queued.length === 0 || fanShows(m, fanOutOf(receipt), receipt)) continue;
    for (const [agentId] of queued) {
      const runId = receipt?.runOf?.[agentId] ?? null;
      if (!runId || !hasRow(runId)) waits.set(runId ?? agentId, { agentId, runId });
    }
  }
  return [...waits.values()];
}

/** The receipt of a message whose agent is next in line: "Theo is in line for the computer · next". */
export const queuedNextText = (t: TFunction, name: string) =>
  t("receipts.queuedNext", { names: name, context: agentGrammar(name).context });

/** The outage card's pill beside the time: "Away 3 min". */
export const awayText = (t: TFunction, sinceIso: string, now: number) =>
  t("queue.away", { time: durationText(t, Math.max(0, now - Date.parse(sinceIso))) });

export type FanState = "answered" | "working" | "inLine" | "failed";

export interface FanAgent {
  agentId: string;
  state: FanState;
  /** Its place in the computer's line (1 = next); null while not known. */
  position: number | null;
}

export interface FanOut {
  called: number;
  answered: number;
  working: number;
  inLine: number;
  failed: number;
  /** Answered first, then working, then the line in its order. */
  agents: FanAgent[];
}

const FAN_STATE: Partial<Record<ReceiptPhase, FanState>> = {
  handled: "answered",
  // Ended without answering (or stopped): its chip reads "didn't answer", like a failure's.
  passed: "failed",
  canceled: "failed",
  failed: "failed",
  no_ai: "failed",
  claimed: "working",
  waiting: "working",
  asking: "working",
  outage: "working",
};
const FAN_ORDER: FanState[] = ["answered", "working", "inLine", "failed"];

/**
 * Each agent a message called and where it stands, from the message's receipts and its computer's line: null under
 * two agents (the strip is for a fan-out). Agents not started yet count as in line: they start one at a time.
 */
export function fanOutOf(receipt: MessageReceipt | undefined, queue?: ComputerQueue | null): FanOut | null {
  if (!receipt) return null;
  const skip = new Set([...(receipt.blocked ?? []), ...(receipt.referenced ?? [])]);
  const phases = new Map(receipt.agents);
  const ids = [...new Set([...(receipt.mentioned ?? []), ...phases.keys()])].filter((id) => !skip.has(id));
  if (ids.length < 2) return null;
  const agents = ids.map((agentId): FanAgent => {
    const runId = receipt.runOf?.[agentId];
    // By run only: the same agent may also wait in another conversation.
    const mine = <T extends { runId: string }>(rows: T[] | undefined) =>
      runId ? rows?.find((r) => r.runId === runId) : undefined;
    const phase = phases.get(agentId);
    let state = (phase && FAN_STATE[phase]) ?? "inLine";
    const waiting = mine(queue?.waiting);
    if (state !== "answered" && state !== "failed") {
      if (mine(queue?.working)) state = "working";
      else if (waiting) state = "inLine";
    }
    return { agentId, state, position: state === "inLine" ? (waiting?.position ?? null) : null };
  });
  agents.sort(
    (a, b) =>
      FAN_ORDER.indexOf(a.state) - FAN_ORDER.indexOf(b.state) ||
      (a.position ?? Number.POSITIVE_INFINITY) - (b.position ?? Number.POSITIVE_INFINITY),
  );
  const count = (s: FanState) => agents.filter((a) => a.state === s).length;
  return {
    called: agents.length,
    answered: count("answered"),
    working: count("working"),
    inLine: count("inLine"),
    failed: count("failed"),
    agents,
  };
}

/**
 * Whether a message shows the fan-out strip: an agent's message whose called agents started two turns or more, while
 * one still works or waits. Before that the receipt says it; after, each reply is its own message.
 */
export function fanShows(
  message: Pick<Message, "author">,
  fan: FanOut | null,
  receipt: Pick<MessageReceipt, "runOf"> | undefined,
): fan is FanOut {
  if (message.author.type !== "agent" || !fan || fan.working + fan.inLine === 0) return false;
  return fan.agents.filter((a) => receipt?.runOf?.[a.agentId]).length >= 2;
}

/** "12 agents called · 2 answered · 2 working · 8 in line" (the parts at zero left out). */
export function fanOutText(t: TFunction, fan: FanOut) {
  const parts = [t("queue.fan.called", { count: fan.called })];
  for (const s of ["answered", "working", "inLine", "failed"] as const)
    if (fan[s] > 0) parts.push(t(`queue.fan.${s}`, { count: fan[s] }));
  return parts.join(" · ");
}

/** One agent's chip: "answered", "working", "3rd", "in line", "didn't answer". */
export function fanChipText(t: TFunction, locale: string, a: FanAgent) {
  if (a.state === "inLine" && a.position !== null) return nthText(t, locale, a.position);
  return t(`queue.fan.chip.${a.state}`);
}
