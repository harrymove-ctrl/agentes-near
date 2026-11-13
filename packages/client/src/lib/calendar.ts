import type { Actor, CalendarEvent, CalendarRange, RoutineTarget } from "../api/types";
import { formatTime, uses12h } from "./format";

export { uses12h };

/** "ter, 20 out": a day as the calendar writes it, in the reader's language. */
export const shortDay = (locale: string, d: Date) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");

/** "ter, 20 out, 15:00–15:30": an event's or a proposal's day and times. */
export const slotText = (locale: string, start: string, end: string) =>
  `${shortDay(locale, new Date(start))}, ${formatTime(locale, start)}–${formatTime(locale, end)}`;

export type RsvpStatus = CalendarEvent["rsvp"][number]["status"];

/** The viewer's answer to an event they're invited to; null when they aren't. */
export const myRsvp = (event: Pick<CalendarEvent, "rsvp"> | undefined, userId: string) =>
  event?.rsvp.find((r) => r.type === "person" && r.id === userId)?.status ?? null;

/** Pixels per hour in the day/week grid. */
export const HOUR_PX = 44;
/** Snap for drag-to-create, move and resize. */
export const SNAP_MIN = 15;

export type CalendarView = "day" | "week" | "month" | "agenda";
/** Where an item comes from (its left color). */
export type ItemSource = "person" | "agent" | "routine" | "reminder" | "deadline";

export interface CalItem {
  key: string;
  kind: "event" | "routine" | "reminder" | "deadline";
  source: ItemSource;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean;
  /** The agent behind it (agent events, routines): its avatar and color. */
  agentId?: string;
  /**
   * Whose it is: who made an event, the agent of a routine run or a reminder, who has a task due. The calendar opens
   * the item with their face.
   */
  owner?: Actor;
  eventId?: string;
  seriesId?: string | null;
  occurrenceStart?: string | null;
  routineId?: string;
  /** A reminder: its id, who set it and whether this person may cancel it. */
  reminderId?: string;
  setBy?: string | null;
  canCancel?: boolean;
  issueId?: string;
  issueNumber?: number;
  people: Actor[];
  description?: string;
  location?: string | null;
  target?: RoutineTarget;
  /** A routine band: every run it stands for, and their spacing in minutes when regular. */
  runs?: Date[];
  every?: number | null;
  /** A band's recent runs as they went (from the routine), and whether one is running now. */
  pastRuns?: { at: Date; status: RunStatus; weight?: number }[];
  running?: boolean;
  /** A single run: how it went (when it already ran), else how the routine's last run went. */
  result?: RunStatus;
  lastResult?: RunStatus;
}

export type RunStatus = "ok" | "silent" | "failed" | "skipped";

// ── Dates (local days) ──────────────────────────────────────────────────────

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
/** The same wall-clock time `n` days later (addDays drops the time). */
export const shiftDays = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
export function mondayOf(d: Date) {
  return addDays(startOfDay(d), -((d.getDay() + 6) % 7));
}
export const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
export const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

/** The days a view shows around `focus`. */
export function viewDays(view: CalendarView, focus: Date, businessOnly = false): Date[] {
  if (view === "day") return [startOfDay(focus)];
  if (view === "week") {
    const monday = mondayOf(focus);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i)).filter((d) => !businessOnly || !isWeekend(d));
  }
  if (view === "month") {
    const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
    const start = mondayOf(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }
  return Array.from({ length: 30 }, (_, i) => addDays(startOfDay(focus), i));
}

/** The range to fetch for a view: [from, to). */
export function viewRange(view: CalendarView, focus: Date): { from: Date; to: Date } {
  if (view === "day") return { from: startOfDay(focus), to: addDays(startOfDay(focus), 1) };
  if (view === "week") return { from: mondayOf(focus), to: addDays(mondayOf(focus), 7) };
  const days = viewDays(view, focus);
  return { from: days[0] as Date, to: addDays(days[days.length - 1] as Date, 1) };
}

/** Moves the focus one step of the view (−1 / +1). */
export function stepFocus(view: CalendarView, focus: Date, dir: number): Date {
  if (view === "day") return addDays(focus, dir);
  if (view === "week") return addDays(focus, 7 * dir);
  if (view === "month") return new Date(focus.getFullYear(), focus.getMonth() + dir, 1);
  return addDays(focus, 30 * dir);
}

/** "12–18 de outubro de 2026", "28 de setembro – 4 de outubro de 2026", "outubro de 2026". */
export function rangeLabel(locale: string, view: CalendarView, days: Date[], focus: Date) {
  if (view === "month") return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(focus);
  const first = days[0] ?? focus;
  const last = days[days.length - 1] ?? focus;
  if (view === "day")
    return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
      first,
    );
  try {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).formatRange(first, last);
  } catch {
    const f = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" });
    return `${f.format(first)} – ${f.format(last)}`;
  }
}

// ── Items ───────────────────────────────────────────────────────────────────

/** Range data → items (events, routine runs, reminders, issue due dates). */
export function toItems(range: CalendarRange | undefined): CalItem[] {
  if (!range) return [];
  return [
    ...range.events.map((e): CalItem => {
      const agentAuthor = e.createdBy.type === "agent";
      // All-day: the days themselves (`endDate` inclusive), never shifted by a zone.
      const fromDay = (ymd: string) => {
        const [y, m, d] = ymd.split("-").map(Number);
        return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1);
      };
      const start = e.allDay && e.startDate ? fromDay(e.startDate) : new Date(e.start);
      const end =
        e.allDay && e.endDate
          ? addDays(fromDay(e.endDate), 1)
          : e.allDay
            ? startOfDay(new Date(e.end))
            : new Date(e.end);
      return {
        key: e.occurrenceStart ? `${e.seriesId ?? e.id}@${e.occurrenceStart}` : e.id,
        kind: "event",
        source: agentAuthor ? "agent" : "person",
        title: e.title,
        start,
        end: end > start ? end : addMinutes(start, 30),
        allDay: e.allDay,
        recurring: Boolean(e.rule && e.rule.freq !== "once") || e.recurrence !== "none" || Boolean(e.seriesId),
        agentId: agentAuthor ? e.createdBy.id : undefined,
        owner: e.createdBy,
        eventId: e.id,
        seriesId: e.seriesId ?? null,
        occurrenceStart: e.occurrenceStart ?? null,
        people: e.participants,
        description: e.description,
        location: e.location ?? null,
      };
    }),
    ...range.routines.map(
      (r): CalItem => ({
        key: `${r.routineId}@${r.at}`,
        kind: "routine",
        source: "routine",
        title: r.name,
        // A run is a moment, not a meeting: drawn small at its time.
        start: new Date(r.at),
        end: addMinutes(new Date(r.at), 15),
        allDay: false,
        recurring: true,
        agentId: r.agentId,
        owner: { type: "agent", id: r.agentId },
        routineId: r.routineId,
        people: [{ type: "agent", id: r.agentId }],
        target: r.target,
      }),
    ),
    ...(range.reminders ?? []).map(
      (r): CalItem => ({
        key: `reminder-${r.id}`,
        kind: "reminder",
        source: "reminder",
        title: r.message,
        // A moment too: a minute long, so one at 23:50 stays on its day; `layoutDay` draws it tall enough to read.
        start: new Date(r.at),
        end: addMinutes(new Date(r.at), 1),
        allDay: false,
        recurring: false,
        agentId: r.agentId,
        owner: { type: "agent", id: r.agentId },
        reminderId: r.id,
        setBy: r.createdBy,
        canCancel: r.canCancel,
        people: [],
        target: { type: "conversation", channelId: r.channelId, threadId: r.threadId, reminder: true },
      }),
    ),
    ...range.deadlines.map((d): CalItem => {
      const [y, m, day] = d.date.split("-").map(Number);
      const start = new Date(y ?? 2000, (m ?? 1) - 1, day ?? 1);
      return {
        key: `deadline-${d.issueId}`,
        kind: "deadline",
        source: "deadline",
        title: d.title,
        start,
        end: addDays(start, 1),
        allDay: true,
        recurring: false,
        issueId: d.issueId,
        issueNumber: d.number,
        owner: d.assignee ?? undefined,
        people: [],
      };
    }),
  ];
}

/** All-day, or crossing midnight: drawn as a bar above the hour grid. */
export const isBarItem = (it: CalItem) =>
  it.allDay || it.end.getTime() - startOfDay(it.start).getTime() > 86_400_000 + 60_000;

/** Whether an item touches a day. */
export const onDay = (it: CalItem, d: Date) => it.start < addDays(startOfDay(d), 1) && it.end > startOfDay(d);

/** From this many runs on a day, a routine is one band with its runs as ticks, not a chip per run. */
export const DENSE_RUNS = 4;

/**
 * Routines that run often (≥ DENSE_RUNS on a day) become one band per routine
 * over consecutive days, carrying the runs; sparser runs stay as they are.
 */
export function collapseRoutines(items: CalItem[], days: Date[]): CalItem[] {
  const out: CalItem[] = [];
  const byRoutine = new Map<string, Map<number, CalItem[]>>();
  for (const it of items) {
    const i = it.kind === "routine" && it.routineId && !it.runs ? days.findIndex((d) => sameDay(d, it.start)) : -1;
    if (i < 0 || !it.routineId) {
      out.push(it);
      continue;
    }
    const perDay = byRoutine.get(it.routineId) ?? new Map<number, CalItem[]>();
    byRoutine.set(it.routineId, perDay);
    perDay.set(i, [...(perDay.get(i) ?? []), it]);
  }
  for (const perDay of byRoutine.values()) {
    let segment: number[] = [];
    const flush = () => {
      const first = segment[0];
      const last = segment[segment.length - 1];
      segment = [];
      if (first === undefined || last === undefined) return;
      const runs = Array.from({ length: last - first + 1 }, (_, k) => perDay.get(first + k) ?? [])
        .flat()
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      const head = runs[0] as CalItem;
      const start = startOfDay(days[first] as Date);
      out.push({
        ...head,
        key: `${head.routineId}~${start.getTime()}`,
        start,
        end: addDays(days[last] as Date, 1),
        allDay: true,
        runs: runs.map((r) => r.start),
        every: spacing((perDay.get(first) ?? []).map((r) => r.start)),
      });
    };
    for (const i of [...perDay.keys()].sort((a, b) => a - b)) {
      const list = perDay.get(i) ?? [];
      if (list.length < DENSE_RUNS) {
        flush();
        out.push(...list);
        continue;
      }
      const prev = segment[segment.length - 1];
      // One band only over days that sit side by side and follow each other.
      if (prev !== undefined && (prev !== i - 1 || !sameDay(addDays(days[prev] as Date, 1), days[i] as Date))) flush();
      segment.push(i);
    }
    flush();
  }
  return out;
}

/** The gap between runs in minutes when it never changes, else null. */
function spacing(runs: Date[]): number | null {
  const sorted = [...runs].sort((a, b) => a.getTime() - b.getTime());
  const gaps = sorted.slice(1).map((d, i) => Math.round((d.getTime() - (sorted[i] as Date).getTime()) / 60_000));
  const g = gaps[0];
  return g !== undefined && g > 0 && gaps.every((x) => x === g) ? g : null;
}

// ── Layout ──────────────────────────────────────────────────────────────────

export interface Placed {
  item: CalItem | RunStack;
  /** Minutes from midnight (clipped to the day). */
  top: number;
  /** How long it is in minutes (a stack: how tall it is drawn). */
  height: number;
  /** Side by side when overlapping: column and how many share the cluster. */
  col: number;
  cols: number;
  /**
   * A column of routine runs alone beside a meeting is narrow, so the meeting keeps room for its name (the runs are
   * faces at the least): how many such columns the cluster has (0: every column as wide), how many come before this
   * one, and whether this one is.
   */
  thins: number;
  thinBefore: number;
  thin: boolean;
}

/** Pixels in the day/week grid → minutes, and back. */
const toPx = (minutes: number) => (minutes / 60) * HOUR_PX;
const toMinutes = (px: number) => (px / HOUR_PX) * 60;

/**
 * Timed items of one day, and its stacks of routine runs, laid out side by
 * side when they overlap: each cluster of overlapping items splits the width
 * into as many columns as it needs (greedy, by start). `heights` (px, by key)
 * are what the page measured: a block whose title wraps past its slot reaches
 * as far as it is drawn, and whatever starts under it goes beside it.
 */
export function layoutDay(
  items: CalItem[],
  day: Date,
  stacks: RunStack[] = [],
  heights: ReadonlyMap<string, number> = new Map(),
): Placed[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + 86_400_000;
  const timed = [
    ...items
      .filter((it) => !isBarItem(it) && onDay(it, day))
      .map((item) => {
        const s = Math.max(item.start.getTime(), dayStart);
        const e = Math.min(Math.max(item.end.getTime(), s + (item.kind === "reminder" ? 30 : 15) * 60_000), dayEnd);
        const drawn = s + toMinutes(heights.get(item.key) ?? 0) * 60_000;
        return { item: item as CalItem | RunStack, s, e, reach: Math.min(Math.max(e, drawn), dayEnd) };
      }),
    ...stacks.map((stack) => {
      const s = dayStart + stack.top * 60_000;
      const e = Math.min(s + stack.height * 60_000, dayEnd);
      return { item: stack as CalItem | RunStack, s, e, reach: e };
    }),
  ].sort((a, b) => a.s - b.s || b.reach - a.reach);
  const out: Placed[] = [];
  let cluster: ((typeof timed)[number] & { col: number })[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    const runsOnly = Array.from({ length: cols }, (_, i) =>
      cluster.filter((c) => c.col === i).every((c) => c.item.kind === "runs"),
    );
    const thins = runsOnly.filter(Boolean).length;
    // Narrow only beside something else: runs side by side with runs share the width evenly.
    const mixed = thins > 0 && thins < cols;
    for (const c of cluster)
      out.push({
        item: c.item,
        top: (c.s - dayStart) / 60_000,
        height: (c.e - c.s) / 60_000,
        col: c.col,
        cols,
        thins: mixed ? thins : 0,
        thinBefore: mixed ? runsOnly.slice(0, c.col).filter(Boolean).length : 0,
        thin: mixed && Boolean(runsOnly[c.col]),
      });
    cluster = [];
  };
  for (const t of timed) {
    if (cluster.length > 0 && t.s >= clusterEnd) flush();
    const colEnds: number[] = [];
    for (const c of cluster) colEnds[c.col] = Math.max(colEnds[c.col] ?? 0, c.reach);
    let col = colEnds.findIndex((end) => end <= t.s);
    if (col < 0) col = colEnds.length;
    cluster.push({ ...t, col });
    clusterEnd = Math.max(clusterEnd, t.reach);
  }
  if (cluster.length > 0) flush();
  return out;
}

/** A single routine run (not a band): a one-line row in the grid, stacked with the runs around it. */
export const isRunMark = (it: CalItem) => it.kind === "routine" && !it.runs && !isBarItem(it);

/**
 * A routine's entry: one single run, or (in the month and agenda views) a
 * frequent routine's runs on one day, as one entry with their count.
 */
export interface RunEntry {
  key: string;
  item: CalItem;
  /** When it runs (the first of the day's runs for a frequent routine). */
  at: Date;
  /** How many runs it stands for (1 for a single run). */
  count: number;
  /** How it went, when it already ran (a frequent routine: failed if any run that day failed). */
  status?: RunStatus;
}

const byTime = (a: RunEntry, b: RunEntry) =>
  a.at.getTime() - b.at.getTime() || a.item.title.localeCompare(b.item.title);
const single = (it: CalItem): RunEntry => ({ key: it.key, item: it, at: it.start, count: 1, status: it.result });

/** A run's row in the day/week grid (px, its least: a name that wraps makes it taller), and the room between rows. */
const RUN_ROW_PX = 20;
const ROW_GAP_PX = 2;
/** The "+N rotinas" line under a stack's rows (px). */
const MORE_LINE_PX = 18;

/** How tall a stack is drawn (px) with `shown` rows, and the "+N" line under them when it holds more. */
const stackPx = (shown: number, more: number) =>
  shown * (RUN_ROW_PX + ROW_GAP_PX) - ROW_GAP_PX + (more > 0 ? ROW_GAP_PX + MORE_LINE_PX : 0);

/** Routine runs at one place in a day's column: a row each, up to `shown`, then "+N rotinas" for the `more` others. */
export interface RunStack {
  kind: "runs";
  key: string;
  /** Minutes from midnight of its first run. */
  top: number;
  /** How tall it is drawn, in minutes. */
  height: number;
  runs: RunEntry[];
  shown: number;
  more: number;
}

/**
 * One day's single routine runs as stacks of one-line rows at their time:
 * a run that would start inside the stack above joins it. A stack shows two
 * rows at most, and only as many as fit before the next item under it (at
 * least one); the others go behind "+N rotinas". `heights` (px, by key) are
 * what the page measured: a name that wraps makes a row taller than a line.
 */
export function runStacks(items: CalItem[], day: Date, heights: ReadonlyMap<string, number> = new Map()): RunStack[] {
  const runs = items
    .filter((it) => isRunMark(it) && sameDay(it.start, day))
    .map(single)
    .sort(byTime);
  const groups: { key: string; top: number; runs: RunEntry[] }[] = [];
  for (const r of runs) {
    const top = toPx(minutesOfDay(r.at));
    const open = groups[groups.length - 1];
    // The least it takes: its first row, and "+N" under it once it holds two.
    const least = open && stackPx(1, open.runs.length - 1);
    if (open && top < open.top + Math.max(least ?? 0, heights.get(open.key) ?? 0)) open.runs.push(r);
    else groups.push({ key: `runs-${r.key}`, top, runs: [r] });
  }
  // Where each stack's room ends: the next stack, or a block (an event, a reminder) that starts under it.
  const dayStart = startOfDay(day);
  const starts = items
    .filter((it) => !isRunMark(it) && !isBarItem(it) && onDay(it, day))
    .map((it) => toPx(Math.max(0, (it.start.getTime() - dayStart.getTime()) / 60_000)));
  return groups.map((g, i): RunStack => {
    const below = starts.filter((s) => s > g.top);
    const room = Math.min(groups[i + 1]?.top ?? Number.POSITIVE_INFINITY, ...below, toPx(24 * 60)) - g.top;
    // Two rows where they fit before the next item (with "+N" under them when there are more), else one.
    const shown = g.runs.length > 1 && stackPx(2, g.runs.length - 2) <= room ? 2 : 1;
    const more = g.runs.length - shown;
    const px = Math.max(stackPx(shown, more), heights.get(g.key) ?? 0);
    return { kind: "runs", key: g.key, top: toMinutes(g.top), height: toMinutes(px), runs: g.runs, shown, more };
  });
}

/**
 * Everything routines do on one day (month and agenda views), time-ordered:
 * a mark per single run, and one per frequent routine (a band) carrying how
 * many times it runs that day, not a mark per run.
 */
export function dayRuns(items: CalItem[], day: Date): RunEntry[] {
  const out: RunEntry[] = [];
  for (const it of items) {
    if (it.kind !== "routine") continue;
    if (!it.runs) {
      if (sameDay(it.start, day)) out.push(single(it));
      continue;
    }
    const runs = it.runs.filter((r) => sameDay(r, day));
    const first = runs[0];
    if (!first) continue;
    const past = (it.pastRuns ?? []).filter((r) => sameDay(r.at, day)).sort((a, b) => b.at.getTime() - a.at.getTime());
    const status = past.some((r) => r.status === "failed") ? "failed" : past[0]?.status;
    out.push({ key: `${it.key}@${toYmdLocal(day)}`, item: it, at: first, count: runs.length, status });
  }
  return out.sort(byTime);
}

const toYmdLocal = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** A row of a day in the month and the agenda: an item, or a routine's runs that day. */
export interface DayEntry {
  key: string;
  item: CalItem;
  at: Date;
  /** A routine that runs often: its first run that day, and how many. */
  day?: { at: Date; count: number };
}

/** One day's items and routine runs as one list of rows: all day first, then by time. */
export function dayEntries(items: CalItem[], day: Date): DayEntry[] {
  const allDay = (it: CalItem) => it.allDay && !it.runs;
  return [
    ...items
      .filter((it) => it.kind !== "routine" && onDay(it, day))
      .map((item): DayEntry => ({ key: item.key, item, at: item.start })),
    ...dayRuns(items, day).map(
      (r): DayEntry => ({
        key: r.key,
        item: r.item,
        at: r.at,
        day: r.item.runs ? { at: r.at, count: r.count } : undefined,
      }),
    ),
  ].sort((a, b) => Number(allDay(b.item)) - Number(allDay(a.item)) || a.at.getTime() - b.at.getTime());
}

export interface Bar {
  item: CalItem;
  /** First visible day index and how many days it covers. */
  from: number;
  span: number;
  lane: number;
}

/** All-day and multi-day items as bars over the visible days, stacked in lanes. */
export function layoutBars(items: CalItem[], days: Date[]): Bar[] {
  const bars: Bar[] = [];
  const lanes: number[][] = [];
  const sorted = items.filter(isBarItem).sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const item of sorted) {
    const idx = days.map((d, i) => (onDay(item, d) ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) continue;
    const from = idx[0] as number;
    const span = (idx[idx.length - 1] as number) - from + 1;
    let lane = lanes.findIndex((used) => used.every((u) => u < from || u >= from + span));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    for (let i = from; i < from + span; i++) lanes[lane]?.push(i);
    bars.push({ item, from, span, lane });
  }
  return bars;
}

/** A y offset in the grid (px) → minutes from midnight, snapped. */
export function yToMinutes(y: number, hourPx = HOUR_PX, snap = SNAP_MIN) {
  const min = (Math.max(0, y) / hourPx) * 60;
  return Math.min(24 * 60, Math.round(min / snap) * snap);
}

/**
 * A drag in a day column (from y0 to y1, px) → the new event's time range.
 * A click without a drag gives 30 minutes from where it was clicked.
 */
export function dragRange(day: Date, y0: number, y1: number, hourPx = HOUR_PX) {
  const a = yToMinutes(Math.min(y0, y1), hourPx);
  const b = yToMinutes(Math.max(y0, y1), hourPx);
  const startMin = Math.min(a, 24 * 60 - SNAP_MIN * 2);
  const endMin = b - a < SNAP_MIN ? startMin + 30 : b;
  const base = startOfDay(day);
  return { start: addMinutes(base, startMin), end: addMinutes(base, Math.min(endMin, 24 * 60)) };
}

/** Where the week opens: around 07:00, or a little before the first timed item. */
export function initialScrollMinutes(items: CalItem[], days: Date[]) {
  const firsts = days.flatMap((d) => layoutDay(items, d).map((p) => p.top));
  if (firsts.length === 0) return 7 * 60;
  return Math.max(0, Math.min(7 * 60, Math.min(...firsts) - 30));
}

/** The next `n` items from `now` (for "Próximos"); a routine only by its next run. */
export function upcomingItems(items: CalItem[], now: Date, n = 5) {
  const seen = new Set<string>();
  return items
    .filter((it) => it.kind !== "deadline" && it.end > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .filter((it) => {
      if (!it.routineId) return true;
      if (seen.has(it.routineId)) return false;
      seen.add(it.routineId);
      return true;
    })
    .slice(0, n);
}

/** The grid's hour label: "1 AM" … "12 PM" in 12-hour locales, "01:00" … "23:00" otherwise. */
export function hourLabel(locale: string, h: number) {
  if (uses12h(locale)) return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2000, 0, 1, h));
  return `${String(h).padStart(2, "0")}:00`;
}
