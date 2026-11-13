/**
 * Widgets (ADR 0135), without React: what a widget shows (`WidgetSpec`), checked the same way by the server, the
 * agents' tools and the apps, plus the small rules every surface shares (schedules, sizes, the chat chart block as a
 * widget). The web draws a spec with the components in this folder; the phone with its own renderer.
 */

/** What a widget draws. */
export const WIDGET_KINDS = ["kpi", "goal", "bars", "line", "list", "text"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** What a person asks for: a kind, or `auto` (the agent picks the kind that shows the ask best). */
export const WIDGET_FORMATS = ["auto", ...WIDGET_KINDS] as const;
export type WidgetFormat = (typeof WIDGET_FORMATS)[number];

/** How often its agent redoes it: every 30 minutes at the least (the floor), or only when asked. */
export const WIDGET_SCHEDULES = ["half", "hour", "day", "week", "manual"] as const;
export type WidgetSchedule = (typeof WIDGET_SCHEDULES)[number];

/** S = 1×1, M = 2×1, L = 2×2 on the 4-column board. */
export const WIDGET_SIZES = ["s", "m", "l"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Where a widget stands: its first run, data shown, a refresh running (the last data stays), or it failed. */
export const WIDGET_STATUSES = ["building", "ok", "updating", "failed"] as const;
export type WidgetStatus = (typeof WIDGET_STATUSES)[number];

/** Columns of a board on the web (the phone shows 2: a 2-wide widget takes the whole row). */
export const BOARD_COLUMNS = 4;
export const PHONE_COLUMNS = 2;

export interface WidgetLayout {
  /** Order on the board, lowest first (tiles and widgets share it on the home board). */
  position: number;
  w: 1 | 2;
  h: 1 | 2;
}

/** One big number: "$18,420", "4 open", with how it moved and a small trend line. */
export interface KpiWidgetSpec {
  kind: "kpi";
  value: number;
  /** Before the number: a currency ("R$", "US$", "$", "€", "£"). */
  prefix?: string;
  /** After the number: "%", "min", "open". */
  suffix?: string;
  /** How it moved: "+12%". `up` true = the good direction (drawn in the up tone), whatever the sign. */
  delta?: { text: string; up: boolean };
  /** The line under it: "vs. yesterday so far". */
  note?: string;
  /** A small trend, oldest first. */
  spark?: number[];
}

/** Progress towards a goal. */
export interface GoalWidgetSpec {
  kind: "goal";
  /** 0–100 (more is drawn full). */
  pct: number;
  /** "$248k of $400k". */
  line: string;
  /** "At this pace, it gets there on the 27th." */
  note?: string;
}

/** A ranking or a count per category. */
export interface BarsWidgetSpec {
  kind: "bars";
  labels: string[];
  values: number[];
  /** The bar to call out (the one the alert is about), by index. */
  alertIndex?: number;
  /**
   * What every value counts, once for the whole chart ("%", "R$", "runs per day"): shown as a tag above the bars,
   * never repeated in each bar's label, which reads only the number.
   */
  unit?: string;
  note?: string;
}

/** Something over time, oldest first. */
export interface LineWidgetSpec {
  kind: "line";
  labels: string[];
  values: number[];
  /** What the values count, once for the whole chart ("ms", "orders"): a tag above the line. */
  unit?: string;
  /** "1,320 yesterday · +33% this week". */
  note?: string;
}

export type ListTone = "ok" | "warn";

/** A short list of things with a word each: pull requests, late orders. */
export interface ListWidgetSpec {
  kind: "list";
  rows: { text: string; meta?: string; tone?: ListTone }[];
}

/** A few sentences the agent writes again on every update. */
export interface TextWidgetSpec {
  kind: "text";
  items: string[];
}

export type WidgetSpec =
  | KpiWidgetSpec
  | GoalWidgetSpec
  | BarsWidgetSpec
  | LineWidgetSpec
  | ListWidgetSpec
  | TextWidgetSpec;

/** How much a spec may hold: past this the data belongs in a Drive table. */
export const WIDGET_LIMITS = {
  /** Labels of a bars or line widget (as a chat chart's points). */
  points: 24,
  spark: 24,
  rows: 8,
  items: 6,
  title: 80,
  label: 40,
  rowText: 120,
  rowMeta: 40,
  item: 280,
  /** One short sentence: an agent's longer note is refused, never cut (`validateWidgetSpec`). */
  note: 140,
  line: 120,
  delta: 40,
  affix: 12,
  /** A bars or line widget's unit: a short tag above the chart ("runs per day"), not a suffix on every value. */
  unit: 32,
} as const;

/** Scheduled widgets a workspace may keep at once (`manual` ones don't count). */
export const WIDGET_SCHEDULED_MAX = 60;
/** Widgets on one board. */
export const WIDGETS_PER_DASHBOARD_MAX = 24;
/** Boards in one workspace (people's homes don't count). */
export const DASHBOARDS_MAX = 200;
/** Updates kept per widget (its history). */
export const WIDGET_HISTORY_KEPT = 20;

/** Runs a day of each schedule (`week`: one in seven days). */
export const SCHEDULE_RUNS_PER_DAY: Record<WidgetSchedule, number> = {
  half: 48,
  hour: 24,
  day: 1,
  week: 1 / 7,
  manual: 0,
};

export const scheduleRunsPerDay = (schedule: WidgetSchedule): number => SCHEDULE_RUNS_PER_DAY[schedule] ?? 0;

/**
 * The cron of each schedule, read in the time zone of whoever set it up (its routine's): every 30 minutes, every
 * hour on the hour, every day at 08:00, every Monday at 08:00. `manual` has none.
 */
export const WIDGET_SCHEDULE_CRON: Record<Exclude<WidgetSchedule, "manual">, string> = {
  half: "*/30 * * * *",
  hour: "0 * * * *",
  day: "0 8 * * *",
  week: "0 8 * * 1",
};

export const isWidgetKind = (v: unknown): v is WidgetKind =>
  typeof v === "string" && (WIDGET_KINDS as readonly string[]).includes(v);
export const isWidgetFormat = (v: unknown): v is WidgetFormat =>
  typeof v === "string" && (WIDGET_FORMATS as readonly string[]).includes(v);
export const isWidgetSchedule = (v: unknown): v is WidgetSchedule =>
  typeof v === "string" && (WIDGET_SCHEDULES as readonly string[]).includes(v);
export const isWidgetSize = (v: unknown): v is WidgetSize =>
  typeof v === "string" && (WIDGET_SIZES as readonly string[]).includes(v);

/** S, M or L as a board's width and height. */
export function sizeToLayout(size: WidgetSize): { w: 1 | 2; h: 1 | 2 } {
  if (size === "l") return { w: 2, h: 2 };
  if (size === "m") return { w: 2, h: 1 };
  return { w: 1, h: 1 };
}

/** A board's width and height as S, M or L (a 1-wide, 2-tall widget reads as S). */
export function layoutToSize(layout: { w: number; h: number }): WidgetSize {
  if (layout.w >= 2) return layout.h >= 2 ? "l" : "m";
  return "s";
}

/** The next size when "Size" is clicked in Organize: S → M → L → S. */
export function nextSize(size: WidgetSize): WidgetSize {
  return size === "s" ? "m" : size === "m" ? "l" : "s";
}

/** The size a new widget of a kind starts at: one number fits S; charts, lists and summaries need M. */
export function defaultSize(kind: WidgetKind | null): WidgetSize {
  return kind === "kpi" || kind === "goal" ? "s" : "m";
}

/** Columns a widget takes on the phone's 2-column board: a 2-wide one takes the whole row. */
export const phoneSpan = (w: number): 1 | 2 => (w >= 2 ? 2 : 1);

// ── Checking a spec ──────────────────────────────────────────────────────────

export type SpecCheck = { ok: true; spec: WidgetSpec } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * `text` at most `max` characters long: a longer one ends at the last whole word that fits, with "…" (cut inside a
 * word only when one word alone is longer than half of `max`). Nothing is ever cut mid-word to fit a box, nor between
 * an emoji's two halves (Postgres refuses jsonb with a lone surrogate).
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, "");
  const space = cut.lastIndexOf(" ");
  const kept = space >= max / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:–—-]+$/, "")}…`;
}

/** A trimmed string clipped to `max` (`clipText`), or null when it isn't text. Numbers are taken as text ("2024"). */
function str(v: unknown, max: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return clipText(String(v), max);
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? clipText(t, max) : null;
}

const NOTE_TOO_LONG: SpecCheck = {
  ok: false,
  error: `A \`note\` is one short sentence of at most ${WIDGET_LIMITS.note} characters: write a shorter one.`,
};

/** A spec's `note`: null when absent, false when longer than `WIDGET_LIMITS.note` (unless `clip`, for stored data). */
function noteOf(v: unknown, clip: boolean): string | null | false {
  const t = str(v, Number.POSITIVE_INFINITY);
  if (t === null || t.length <= WIDGET_LIMITS.note) return t;
  return clip ? clipText(t, WIDGET_LIMITS.note) : false;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function numbers(v: unknown, max: number): number[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  const out: number[] = [];
  for (const x of v) {
    const n = num(x);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

function labels(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > WIDGET_LIMITS.points) return null;
  const out: string[] = [];
  for (const x of v) {
    const s = str(x, WIDGET_LIMITS.label);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** Sets `key` on `out` only when there is a value (the stored JSON holds only what is set). */
function put<T extends object, K extends keyof T>(out: T, key: K, value: T[K] | null | undefined) {
  if (value !== null && value !== undefined) out[key] = value;
}

/**
 * A spec as the server keeps it, or why not: the kind's fields only, text trimmed and clipped to its limit at a word's
 * end, numbers finite, one value per label. Anything unknown is dropped. A `note` longer than `WIDGET_LIMITS.note` is
 * refused so its agent writes a shorter one (`options.clipNotes`: clipped instead, for data read back). Never throws.
 */
export function validateWidgetSpec(raw: unknown, options: { clipNotes?: boolean } = {}): SpecCheck {
  const clip = options.clipNotes === true;
  if (!isObject(raw)) return { ok: false, error: "The widget's data must be an object with a `kind`." };
  const kind = raw.kind;
  if (!isWidgetKind(kind)) return { ok: false, error: `Unknown kind: use one of ${WIDGET_KINDS.join(", ")}.` };
  switch (kind) {
    case "kpi": {
      const value = num(raw.value);
      if (value === null) return { ok: false, error: "A kpi needs a numeric `value`." };
      const spec: KpiWidgetSpec = { kind, value };
      put(spec, "prefix", str(raw.prefix, WIDGET_LIMITS.affix));
      put(spec, "suffix", str(raw.suffix, WIDGET_LIMITS.affix));
      if (raw.delta !== undefined && raw.delta !== null) {
        if (!isObject(raw.delta)) return { ok: false, error: "`delta` is `{ text, up }`." };
        const text = str(raw.delta.text, WIDGET_LIMITS.delta);
        if (text === null || typeof raw.delta.up !== "boolean") {
          return { ok: false, error: "`delta` is `{ text, up }`." };
        }
        spec.delta = { text, up: raw.delta.up };
      }
      const note = noteOf(raw.note, clip);
      if (note === false) return NOTE_TOO_LONG;
      put(spec, "note", note);
      if (raw.spark !== undefined && raw.spark !== null) {
        const spark = numbers(raw.spark, WIDGET_LIMITS.spark);
        if (spark === null) return { ok: false, error: `\`spark\` is at most ${WIDGET_LIMITS.spark} numbers.` };
        if (spark.length >= 2) spec.spark = spark;
      }
      return { ok: true, spec };
    }
    case "goal": {
      const pct = num(raw.pct);
      const line = str(raw.line, WIDGET_LIMITS.line);
      if (pct === null || line === null) return { ok: false, error: "A goal needs `pct` (0–100) and `line`." };
      const spec: GoalWidgetSpec = { kind, pct: Math.max(0, Math.min(100, pct)), line };
      const note = noteOf(raw.note, clip);
      if (note === false) return NOTE_TOO_LONG;
      put(spec, "note", note);
      return { ok: true, spec };
    }
    case "bars":
    case "line": {
      const ls = labels(raw.labels);
      const values = numbers(raw.values, WIDGET_LIMITS.points);
      if (ls === null || values === null || ls.length !== values.length || ls.length < (kind === "line" ? 2 : 1)) {
        return {
          ok: false,
          error: `A ${kind} widget needs \`labels\` and \`values\` of one length (at most ${WIDGET_LIMITS.points}).`,
        };
      }
      const note = noteOf(raw.note, clip);
      if (note === false) return NOTE_TOO_LONG;
      if (kind === "bars") {
        const spec: BarsWidgetSpec = { kind, labels: ls, values };
        const at = num(raw.alertIndex);
        if (at !== null && Number.isInteger(at) && at >= 0 && at < values.length) spec.alertIndex = at;
        put(spec, "unit", str(raw.unit, WIDGET_LIMITS.unit));
        put(spec, "note", note);
        return { ok: true, spec };
      }
      const spec: LineWidgetSpec = { kind, labels: ls, values };
      put(spec, "unit", str(raw.unit, WIDGET_LIMITS.unit));
      put(spec, "note", note);
      return { ok: true, spec };
    }
    case "list": {
      if (!Array.isArray(raw.rows) || raw.rows.length === 0 || raw.rows.length > WIDGET_LIMITS.rows) {
        return { ok: false, error: `A list needs 1 to ${WIDGET_LIMITS.rows} \`rows\`.` };
      }
      const rows: ListWidgetSpec["rows"] = [];
      for (const r of raw.rows) {
        const text = isObject(r) ? str(r.text, WIDGET_LIMITS.rowText) : str(r, WIDGET_LIMITS.rowText);
        if (text === null) return { ok: false, error: "Every row needs `text`." };
        const row: ListWidgetSpec["rows"][number] = { text };
        if (isObject(r)) {
          put(row, "meta", str(r.meta, WIDGET_LIMITS.rowMeta));
          if (r.tone === "ok" || r.tone === "warn") row.tone = r.tone;
        }
        rows.push(row);
      }
      return { ok: true, spec: { kind, rows } };
    }
    case "text": {
      if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > WIDGET_LIMITS.items) {
        return { ok: false, error: `A summary needs 1 to ${WIDGET_LIMITS.items} \`items\`.` };
      }
      const items: string[] = [];
      for (const x of raw.items) {
        const s = str(x, WIDGET_LIMITS.item);
        if (s === null) return { ok: false, error: "Every item is a sentence." };
        items.push(s);
      }
      return { ok: true, spec: { kind, items } };
    }
  }
}

/** The spec, or null when it isn't one (for stored data read back). */
export const widgetSpecOf = (raw: unknown): WidgetSpec | null => {
  const checked = validateWidgetSpec(raw, { clipNotes: true });
  return checked.ok ? checked.spec : null;
};

// ── The chat's chart block as a widget ───────────────────────────────────────

/** Units a chart writes before its number (as the chat's chart does). */
const PREFIX_UNITS = new Set(["R$", "US$", "$", "€", "£"]);

/**
 * A delta as the chat writes it ("+0.8 pp vs the week before", "−4% vs. last week") split into what moved and
 * the words after it: a first word that starts with a sign or a digit is the move, the rest the note. A move that
 * starts with a minus reads as down.
 */
export function splitDelta(delta: string): { text: string; up: boolean; note?: string } {
  const t = delta.replace(/\s+/g, " ").trim();
  const m = /^([+\-−–]?\s?[\d.,]+\s?(?:%|pp|p\.p\.)?)(?:\s+(.*))?$/.exec(t);
  const down = /^[-−–]/.test(t);
  if (!m?.[1]) return { text: clipText(t, WIDGET_LIMITS.delta), up: !down };
  const out: { text: string; up: boolean; note?: string } = {
    text: clipText(m[1].trim(), WIDGET_LIMITS.delta),
    up: !down,
  };
  if (m[2]) out.note = clipText(m[2], WIDGET_LIMITS.note);
  return out;
}

/**
 * A chat ```chart block (its JSON text, or the object) as a widget: `number` → kpi (the unit as prefix or suffix,
 * the delta split, the first series as its trend), `bar` and `pie` → bars, `line` → line (the first series; a
 * chart of several series keeps the first). The chart's title is the widget's. Null when the block isn't a chart the
 * chat would draw.
 */
export function chartBlockToWidgetSpec(chart: unknown): { title: string; spec: WidgetSpec } | null {
  let raw = chart;
  if (typeof chart === "string") {
    try {
      raw = JSON.parse(chart);
    } catch {
      return null;
    }
  }
  if (!isObject(raw)) return null;
  const type = raw.type === "kpi" ? "number" : raw.type;
  const title = str(raw.title, WIDGET_LIMITS.title);
  if (!title) return null;
  const unit = str(raw.unit, WIDGET_LIMITS.unit) ?? undefined;
  const series = Array.isArray(raw.series) ? raw.series : [];
  const first = isObject(series[0]) ? series[0].values : undefined;
  const subtitle = str(raw.subtitle, WIDGET_LIMITS.note) ?? undefined;
  let candidate: Record<string, unknown>;
  if (type === "number") {
    const value = num(raw.value);
    if (value === null) return null;
    candidate = { kind: "kpi", value };
    if (unit && PREFIX_UNITS.has(unit)) candidate.prefix = unit;
    else if (unit) candidate.suffix = unit;
    const delta = str(raw.delta, 120);
    if (delta) {
      const split = splitDelta(delta);
      candidate.delta = { text: split.text, up: split.up };
      if (split.note) candidate.note = split.note;
    } else if (subtitle) candidate.note = subtitle;
    const spark = numbers(first, WIDGET_LIMITS.spark);
    if (spark && spark.length >= 2) candidate.spark = spark;
  } else if (type === "bar" || type === "pie") {
    candidate = { kind: "bars", labels: raw.labels, values: first, unit, note: subtitle };
  } else if (type === "line") {
    candidate = { kind: "line", labels: raw.labels, values: first, unit, note: subtitle };
  } else return null;
  // A chat chart's subtitle was written for the chat: clipped at a word's end rather than refused.
  const checked = validateWidgetSpec(candidate, { clipNotes: true });
  return checked.ok ? { title, spec: checked.spec } : null;
}

/** The ```chart fences of a message body, in order (their JSON text). */
export function chartBlocksOf(body: string): string[] {
  const out: string[] = [];
  const fence = /```chart[^\S\n]*\n([\s\S]*?)\n?```/g;
  for (const m of body.matchAll(fence)) if (m[1]?.trim()) out.push(m[1].trim());
  return out;
}

// ── Examples for a preview ───────────────────────────────────────────────────

/** The words of an example, in the reader's language (the apps pass them from `widgets.example.*`). */
export interface ExampleWords {
  /** Seven short day names, oldest first. */
  days: string[];
  vsYesterday: string;
  goalLine: string;
  goalNote: string;
  lineNote: string;
  rows: [string, string, string];
  rowMeta: [string, string, string];
  items: [string, string];
}

/** Example data of a kind, for the new widget's preview before the agent has built it ("example data"). */
export function exampleWidgetSpec(kind: WidgetKind, words: ExampleWords): WidgetSpec {
  const week = words.days.slice(0, 7);
  switch (kind) {
    case "kpi":
      return {
        kind,
        value: 1284,
        delta: { text: "+8%", up: true },
        note: words.vsYesterday,
        spark: [4, 5, 4, 6, 7, 6, 8, 9],
      };
    case "goal":
      return { kind, pct: 48, line: words.goalLine, note: words.goalNote };
    case "bars":
      return { kind, labels: week.slice(0, 5), values: [12, 18, 9, 22, 16] };
    case "line":
      return { kind, labels: week, values: [12, 18, 9, 22, 31, 27, 40], note: words.lineNote };
    case "list":
      return {
        kind,
        rows: words.rows.map((text, i) => ({ text, meta: words.rowMeta[i] ?? "" })),
      };
    case "text":
      return { kind, items: [...words.items] };
  }
}

/** One line for a history row or a notification: the spec's headline in plain words (numbers unformatted). */
export function specHeadline(spec: WidgetSpec): string {
  switch (spec.kind) {
    case "kpi": {
      const value = `${spec.prefix ? `${spec.prefix} ` : ""}${spec.value}${spec.suffix ? ` ${spec.suffix}` : ""}`;
      return spec.delta ? `${value} · ${spec.delta.text}` : value;
    }
    case "goal":
      return `${Math.round(spec.pct)}% · ${spec.line}`;
    case "bars":
    case "line":
      return spec.labels.map((l, i) => `${l} ${spec.values[i]}`).join(", ");
    case "list":
      return spec.rows.map((r) => r.text).join(" · ");
    case "text":
      return spec.items[0] ?? "";
  }
}
