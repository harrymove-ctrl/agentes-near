import type { Approval, Message, ReplyRef } from "../api/types";
import type { LiveRun } from "../realtime/streams";
import { messageMediaOf } from "./media";
import {
  answeredNotices,
  isAgentOnlyNotice,
  isAnsweredNotice,
  isEventLine,
  isTalkerReply,
  settledNotices,
} from "./notices";
import { quoteExcerpt, replyOf } from "./reply";
import { isRoutineCall, routineReplyOf } from "./routines";
import { voiceOf } from "./voice";

type Timed = { createdAt: string; id: string; local?: Message["local"] };

/**
 * A message on its way (`local: "pending"`) was sent just now: after everything the server has, whatever the two
 * clocks say. By time alone, my first of two quick messages, once the server has it (its clock, later than mine),
 * would move under the second still on its way, and back when that one lands.
 */
const sending = (m: Timed) => (m.local === "pending" ? 1 : 0);

const byTime = (a: Timed, b: Timed) =>
  sending(a) - sending(b) ||
  (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1);

/**
 * How far before its post a message's `createdAt` can be (replies were once placed where their streamed words first
 * showed): what landed in such a place still reads as new. Mirrors the engine's `PLACE_KEPT_MS`
 * (packages/engine/src/message-place.ts).
 */
export const PLACE_KEPT_MS = 10 * 60_000;

/** When the server posted a message (ms): its id is a UUIDv7 from the clock at its insert. NaN for an id made here. */
export const postedAtOf = (id: string) => Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);

/**
 * The id of the message the server posted last, wherever its place (one placed before its post, `PLACE_KEPT_MS`, sits
 * above what came after it). Messages still on their way (`local-…`) are left out.
 */
export function lastPostedId(list: readonly Pick<Message, "id">[] | undefined): string | undefined {
  let last: string | undefined;
  for (const m of list ?? []) if (!m.id.startsWith("local-") && (last === undefined || m.id > last)) last = m.id;
  return last;
}

/**
 * A message landed after `at` (ms), for whoever last looked then: written after it, or posted since in a place before
 * it (`PLACE_KEPT_MS`). As the server counts unread (`landedAfterSql`).
 */
export function landedAfter(m: Pick<Message, "id" | "createdAt">, at: number) {
  const placed = Date.parse(m.createdAt);
  return placed > at || (placed > at - PLACE_KEPT_MS && postedAtOf(m.id) > at);
}

/** Adds (or replaces) a message in a list, keeping it ordered and without duplicates. */
export function upsertMessage(list: Message[] | undefined, message: Message): Message[] {
  const rest = (list ?? []).filter((m) => m.id !== message.id);
  return [...rest, message].sort(byTime);
}

/**
 * A list read again from the server, keeping my messages of the list before that are still on their way or wait to
 * go out (`waits`, by `clientId`) while the server doesn't have them (no message of its with their `clientId`). One
 * the server refused goes with the read. `start` is the list when the read began: a message that came live while it
 * was on its way (in `before`, not in `start`) is kept too, since a read made before it was written lacks it.
 */
export function withLocalCopies(
  read: Message[],
  before: Message[] | undefined,
  waits: (clientId: string | null | undefined) => boolean,
  start?: Message[],
): Message[] {
  const written = new Set(read.map((m) => m.clientId));
  const readIds = new Set(read.map((m) => m.id));
  const had = new Set((start ?? []).map((m) => m.id));
  const kept = (before ?? []).filter((m) =>
    m.local
      ? (m.local === "pending" || waits(m.clientId)) && !written.has(m.clientId)
      : !had.has(m.id) && !readIds.has(m.id),
  );
  return kept.length === 0 ? read : [...read, ...kept].sort(byTime);
}

/**
 * Agents reply inside the thread of the message that called them (the
 * executor posts with `threadId = root`), but the channel lists only
 * top-level messages. The channel view shows the conversation as one
 * timeline: top-level messages plus the loaded
 * thread replies, in time order.
 */
export function mergeTimeline(topLevel: Message[], threads: (Message[] | undefined)[]): Message[] {
  const seen = new Map<string, Message>();
  for (const m of topLevel) seen.set(m.id, m);
  for (const thread of threads) for (const m of thread ?? []) seen.set(m.id, m);
  return [...seen.values()].sort(byTime);
}

export type TimelineItem =
  | { kind: "day"; key: string; iso: string }
  | {
      kind: "message";
      key: string;
      message: Message;
      grouped: boolean;
      /** A reply shown away from the message it answers (others came in between): that message, quoted. */
      context?: ReplyRef;
    }
  | { kind: "approval"; key: string; approval: Approval }
  | { kind: "run"; key: string; run: LiveRun };

export const GROUP_WINDOW_MS = 5 * 60_000;

/**
 * A row's React key. An optimistic message keeps its key when the server
 * copy (same `clientId`, new id) replaces it: no remount, no flash.
 */
export const messageKey = (m: Pick<Message, "id" | "clientId">) => (m.clientId ? `c:${m.clientId}` : m.id);

/** Same author (person or agent) writing again within 5 minutes: the row collapses under the previous one. */
export function groupsWith(
  prev: { author: Message["author"]; createdAt: string } | null | undefined,
  author: Message["author"],
  createdAt: string,
) {
  if (!prev) return false;
  const gap = new Date(createdAt).getTime() - new Date(prev.createdAt).getTime();
  return prev.author.type === author.type && prev.author.id === author.id && gap < GROUP_WINDOW_MS;
}
const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * The rows of the channel: day dividers, messages (grouped when the same
 * author writes again within 5 minutes), approval cards at the time they
 * were asked, and live agent runs at the end. `working`: the agents at work in this conversation (`settledNotices`),
 * those of `runs` when not given.
 */
export function buildTimeline(
  messages: Message[],
  approvals: Approval[],
  runs: LiveRun[],
  working: ReadonlySet<string> = new Set(runs.map((r) => r.agentId)),
): TimelineItem[] {
  type Entry = { at: string; id: string; item: TimelineItem };
  const entries: Entry[] = [
    ...messages.map((m) => ({
      at: m.createdAt,
      id: m.id,
      item: { kind: "message" as const, key: messageKey(m), message: m, grouped: false },
    })),
    ...approvals.map((a) => ({
      at: a.createdAt,
      id: a.id,
      item: { kind: "approval" as const, key: a.id, approval: a },
    })),
  ].sort((a, b) =>
    byTime(
      { createdAt: a.at, id: a.id, local: a.item.kind === "message" ? a.item.message.local : undefined },
      { createdAt: b.at, id: b.id, local: b.item.kind === "message" ? b.item.message.local : undefined },
    ),
  );

  const out: TimelineItem[] = [];
  let lastDay = "";
  let prev: Message | null = null;
  const byId = new Map(messages.map((m) => [m.id, m]));
  // Routine reports an agent's message already answers: they fold into it.
  const answered = answeredNotices(messages);
  // Events over once they happened (a follow-up that came, a mention its message's own line explains).
  const settled = settledNotices(messages, working);
  // The last message shown, across day dividers and cards (to tell a reply that lands far from its root).
  let lastShown: Message | null = null;
  for (const entry of entries) {
    const day = dayKey(entry.at);
    if (day !== lastDay) {
      out.push({ kind: "day", key: `day-${day}`, iso: entry.at });
      lastDay = day;
      prev = null;
    }
    if (entry.item.kind === "message") {
      const m = entry.item.message;
      // A routine's call written as its creator, a report the agent already told people about, a notice only its agent
      // reads, an event that is over: not shown.
      if (isRoutineCall(m) || isAnsweredNotice(m, answered) || isAgentOnlyNotice(m.meta) || settled.has(m.id)) continue;
      // A routine's answer (or an automatic line: a notice) always shows its own header, and nothing groups under it.
      const routine = Boolean(routineReplyOf(m)) || isEventLine(m.meta);
      const prevRoutine = Boolean(prev && (routineReplyOf(prev) || isEventLine(prev.meta)));
      const root = m.threadId ? byId.get(m.threadId) : undefined;
      const away =
        root && lastShown && lastShown.id !== root.id && lastShown.threadId !== root.id && !replyQuotes(m, root.id);
      // A root that is a GIF or a sticker with no text: its quote names it (ADR 0091).
      const rootVoice = away && voiceOf(root.meta) !== null;
      const rootMedia = rootVoice ? ("voice" as const) : away ? messageMediaOf(root.meta)?.kind : undefined;
      const context: ReplyRef | undefined = away
        ? {
            messageId: root.id,
            threadId: null,
            author: root.author,
            authorName: "",
            excerpt: rootVoice ? "" : quoteExcerpt(root.body),
            ...(rootMedia ? { media: rootMedia } : {}),
          }
        : undefined;
      out.push({
        ...entry.item,
        // A reply that quotes a message starts its own block, its face under the quote; a fast reply while it works
        // shows its header ("enquanto trabalha").
        grouped:
          !context &&
          !replyOf(m.meta) &&
          !routine &&
          !prevRoutine &&
          !isTalkerReply(m.meta) &&
          groupsWith(prev, m.author, m.createdAt),
        ...(context ? { context } : {}),
      });
      prev = m;
      lastShown = m;
    } else {
      out.push(entry.item);
      prev = null;
    }
  }
  for (const run of runs) out.push({ kind: "run", key: `run-${run.runId}`, run });
  return out;
}

/** The message already quotes that one itself (a person's "Responder"). */
function replyQuotes(m: Message, id: string) {
  const r = m.meta?.replyTo as { messageId?: unknown } | undefined;
  return r?.messageId === id;
}
