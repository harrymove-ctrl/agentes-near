import type { Message, ThreadInfo, ThreadStartMeta } from "../api/types";
import { clockHour } from "./format";
import { plainLine } from "./markdown";

/**
 * Threads in the web (ADR 0029): the range suggested by "Criar thread a partir daqui", the
 * selection model of "Ajustar trecho", and what the channel shows for each
 * thread (context marks, closed lines). Pure functions; the components are in
 * components/threads.
 */

/** A pause longer than this ends the suggested range (the subject probably changed). */
export const SUGGEST_GAP_MS = 15 * 60_000;
/** The most messages a suggestion takes; the person can extend it in "Ajustar trecho". */
export const SUGGEST_MAX = 50;

/** `meta.threadStart` of a thread's root made from a range, when it is one. */
export function threadStartOf(meta: Message["meta"]): ThreadStartMeta | null {
  const start = meta?.threadStart;
  if (!start || typeof start !== "object") return null;
  const s = start as Partial<ThreadStartMeta>;
  if (typeof s.firstMessageId !== "string" || typeof s.lastMessageId !== "string") return null;
  return {
    title: typeof s.title === "string" ? s.title : "",
    contextChannelId: typeof s.contextChannelId === "string" ? s.contextChannelId : "",
    firstMessageId: s.firstMessageId,
    lastMessageId: s.lastMessageId,
    count: typeof s.count === "number" ? s.count : 0,
    moved: s.moved === true,
    movedCount: typeof s.movedCount === "number" ? s.movedCount : 0,
  };
}

/** What a range can hold: top-level messages already saved (no thread markers, no unsent ones). */
export function rangeCandidates(list: Message[]): Message[] {
  return list.filter((m) => !m.threadId && !m.local && !threadStartOf(m.meta));
}

/**
 * "Criar thread a partir daqui": the clicked message starts the range ("a
 * partir daqui"), and it runs forward over the conversation that follows
 * without a pause longer than `SUGGEST_GAP_MS`, up to `SUGGEST_MAX`
 * messages. A simple heuristic on purpose (no model): the toast offers
 * "Ajustar" right away, and the selection there shows exactly what went in.
 */
export function suggestRange(
  list: Message[],
  fromId: string,
  options: { gapMs?: number; max?: number } = {},
): { firstId: string; lastId: string; ids: string[] } | null {
  const gap = options.gapMs ?? SUGGEST_GAP_MS;
  const max = options.max ?? SUGGEST_MAX;
  const candidates = rangeCandidates(list);
  const start = candidates.findIndex((m) => m.id === fromId);
  const first = candidates[start];
  if (!first) return null;
  const ids = [first.id];
  let last = first;
  for (const m of candidates.slice(start + 1)) {
    if (ids.length >= max || Date.parse(m.createdAt) - Date.parse(last.createdAt) > gap) break;
    ids.push(m.id);
    last = m;
  }
  return { firstId: first.id, lastId: last.id, ids };
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "10:02–10:31"; across days, "14 de out., 10:02 – 15 de out., 09:00"; one message, "10:02". */
export function timeSpan(locale: string, fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const time = new Intl.DateTimeFormat(locale, { hour: clockHour(locale), minute: "2-digit" });
  if (sameDay(from, to)) {
    const a = time.format(from);
    const b = time.format(to);
    return a === b ? a : `${a}–${b}`;
  }
  const full = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: clockHour(locale),
    minute: "2-digit",
  });
  return `${full.format(from)} – ${full.format(to)}`;
}

/** The name a thread shows: its title, else its root's text. */
/** A thread's name: its title, else its first message in plain words. */
export const threadTitle = (t: Pick<ThreadInfo, "title" | "rootText">) => t.title?.trim() || plainLine(t.rootText);

// ── "Ajustar trecho": the selection on the channel ───────────────────────────

/** Start (`a`), end (`b`) and what is left out in between. */
export interface RangeSelection {
  a: string;
  b: string;
  excluded: ReadonlySet<string>;
}

export interface SelectionInfo {
  /** Indexes of the start and the end in the list. */
  ia: number;
  ib: number;
  range: Message[];
  included: Message[];
  left: Message[];
  count: number;
  from: string | null;
  to: string | null;
}

const indexOf = (list: Message[], id: string) => list.findIndex((m) => m.id === id);

export function selectionInfo(list: Message[], sel: RangeSelection): SelectionInfo {
  const ia = indexOf(list, sel.a);
  const ib = indexOf(list, sel.b);
  const range = ia >= 0 && ib >= ia ? list.slice(ia, ib + 1) : [];
  const included = range.filter((m) => !sel.excluded.has(m.id));
  const left = range.filter((m) => sel.excluded.has(m.id));
  return {
    ia,
    ib,
    range,
    included,
    left,
    count: included.length,
    from: included[0]?.createdAt ?? null,
    to: included.at(-1)?.createdAt ?? null,
  };
}

/** Exclusions only inside the range (moving an edge drops the ones that fell out). */
function clampExcluded(list: Message[], a: string, b: string, excluded: ReadonlySet<string>): Set<string> {
  const ia = indexOf(list, a);
  const ib = indexOf(list, b);
  return new Set(
    [...excluded].filter((id) => {
      const j = indexOf(list, id);
      return j >= ia && j <= ib;
    }),
  );
}

/**
 * A tap on a row: before the range moves the start there, after it moves the
 * end, inside it toggles the row in or out.
 */
export function pickRow(list: Message[], sel: RangeSelection, id: string): RangeSelection {
  const j = indexOf(list, id);
  const ia = indexOf(list, sel.a);
  const ib = indexOf(list, sel.b);
  if (j < 0) return sel;
  if (j < ia) return { ...sel, a: id };
  if (j > ib) return { ...sel, b: id };
  const excluded = new Set(sel.excluded);
  if (excluded.has(id)) excluded.delete(id);
  else excluded.add(id);
  return { ...sel, excluded };
}

/** Drags an edge to a row; it never crosses the other edge. */
export function moveEdge(list: Message[], sel: RangeSelection, edge: "a" | "b", id: string): RangeSelection {
  const j = indexOf(list, id);
  if (j < 0) return sel;
  let target = id;
  if (edge === "a" && j > indexOf(list, sel.b)) target = sel.b;
  if (edge === "b" && j < indexOf(list, sel.a)) target = sel.a;
  if (sel[edge] === target) return sel;
  const next = { ...sel, [edge]: target };
  return { ...next, excluded: clampExcluded(list, next.a, next.b, sel.excluded) };
}

/** Arrow keys on an edge: one row up (-1) or down (+1). */
export function stepEdge(list: Message[], sel: RangeSelection, edge: "a" | "b", delta: -1 | 1): RangeSelection {
  const j = indexOf(list, sel[edge]) + delta;
  const row = list[Math.max(0, Math.min(list.length - 1, j))];
  return row ? moveEdge(list, sel, edge, row.id) : sel;
}

/**
 * Left-out rows collapse to one line; consecutive ones share it. Returns the
 * first row of each run (with the whole run) and the rows hidden under it.
 * Rows in `open` were expanded by the person and stay as they are.
 */
export function excludedRuns(list: Message[], sel: RangeSelection, open: ReadonlySet<string> = new Set()) {
  const { range } = selectionInfo(list, sel);
  const heads = new Map<string, Message[]>();
  const hidden = new Set<string>();
  let run: Message[] = [];
  const flush = () => {
    const [head, ...rest] = run;
    if (head) {
      heads.set(head.id, run);
      for (const m of rest) hidden.add(m.id);
    }
    run = [];
  };
  for (const m of range) {
    if (sel.excluded.has(m.id) && !open.has(m.id)) run.push(m);
    else flush();
  }
  flush();
  return { heads, hidden };
}

/** The selection a thread's context starts from (what is in the list between its first and last). */
export function selectionOf(list: Message[], ctx: ThreadInfo["context"]): RangeSelection | null {
  if (!ctx) return null;
  if (indexOf(list, ctx.firstMessageId) < 0 || indexOf(list, ctx.lastMessageId) < 0) return null;
  return {
    a: ctx.firstMessageId,
    b: ctx.lastMessageId,
    excluded: clampExcluded(list, ctx.firstMessageId, ctx.lastMessageId, new Set(ctx.excludedMessageIds)),
  };
}

// ── What the channel shows ─────────────────────────────────────────────────

/**
 * Messages of this channel that are the context of a thread (still in the
 * channel): they get the quiet mark in the gutter. `list` is the channel's
 * top-level timeline, oldest first.
 */
export function contextMarks(threads: ThreadInfo[], list: Message[], channelId: string): Set<string> {
  const marks = new Set<string>();
  const top = rangeCandidates(list);
  for (const t of threads) {
    const ctx = t.context;
    if (!ctx || ctx.moved || ctx.channelId !== channelId || t.state === "archived") continue;
    const sel = selectionOf(top, ctx);
    if (!sel) continue;
    for (const m of selectionInfo(top, sel).included) marks.add(m.id);
  }
  return marks;
}

/**
 * What the channel hides because of threads: the replies of closed and
 * archived threads (a closed one is one line; an archived one isn't shown),
 * archived roots, and the replies of threads made from a range (those live in
 * the thread view, not in the channel).
 */
export function hiddenByThreads(threads: ThreadInfo[], list: Message[]) {
  const collapsed = new Set(threads.filter((t) => t.state !== "open").map((t) => t.id));
  const archived = new Set(threads.filter((t) => t.state === "archived").map((t) => t.id));
  const fromRange = new Set(list.filter((m) => threadStartOf(m.meta)).map((m) => m.id));
  return (m: Message) =>
    archived.has(m.id) || Boolean(m.threadId && (collapsed.has(m.threadId) || fromRange.has(m.threadId)));
}

/** The chip a thread shows: what it waits on or how it is, never a colored dot. */
export type ThreadStatus = "needsYou" | "working" | "open" | "closed" | "archived";
export function threadStatus(t: Pick<ThreadInfo, "state" | "working" | "needsYou">): ThreadStatus {
  if (t.state === "archived") return "archived";
  if (t.state === "closed") return "closed";
  if (t.needsYou) return "needsYou";
  if (t.working) return "working";
  return "open";
}

/**
 * Messages a thread holds, for the lines and rows ("12 mensagens"). Plain
 * thread: its root and replies. Made from a range: the range and the replies
 * (its root is only the marker); moved messages are replies already.
 */
export const threadMessageCount = (t: Pick<ThreadInfo, "replyCount" | "context">) =>
  !t.context ? t.replyCount + 1 : t.context.moved ? t.replyCount : t.context.count + t.replyCount;
