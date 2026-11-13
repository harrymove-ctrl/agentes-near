/**
 * Structured recurrence (the backend's `rule`): how often, on which days and
 * times, in which zone, from when and until when. Pure date math here; the
 * sentence ("A cada 2 semanas, seg e qua, às 09:00") is the app's, in its
 * language.
 */

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const BUSINESS_DAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

export type RecurrenceFreq = "once" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Every N units (days, weeks, months, years, hours). */
  interval: number;
  /** Weekly: which days; daily: only these days (business days); monthly: with `bySetPos`. */
  byWeekday?: Weekday[];
  /** Monthly: day numbers (`-1` = the last day). */
  byMonthDay?: number[];
  /** Monthly with `byWeekday`: the 2nd (2) or the last (-1) of those days in the month. */
  bySetPos?: number;
  /** "HH:MM", local to `timezone`; hourly uses the first as the start. */
  times: string[];
  /** IANA zone. */
  timezone: string;
  /** `YYYY-MM-DD`: the first day it can happen. */
  start: string;
  /** `YYYY-MM-DD`, inclusive. */
  until?: string | null;
  /** Stop after this many occurrences. */
  count?: number | null;
}

/** Monday = 0 … Sunday = 6. */
export const weekdayIndex = (d: Date) => (d.getUTCDay() + 6) % 7;
export const weekdayOf = (d: Date): Weekday => WEEKDAYS[weekdayIndex(d)] as Weekday;

const pad = (n: number) => String(n).padStart(2, "0");
/** Days as UTC midnights: no DST jumps while walking the calendar. */
const day = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
};
const ymdOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);
const mondayOf = (d: Date) => plusDays(d, -weekdayIndex(d));
const lastDayOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/** Offset (ms) of `timeZone` from UTC at `at`. */
function zoneOffset(timeZone: string, at: number) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return asUtc - Math.floor(at / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** A wall-clock time in a zone → the instant. */
export function zonedInstant(ymd: string, hm: string, timeZone: string): Date {
  const [h, m] = hm.split(":").map(Number);
  const guess = day(ymd).getTime() + ((h ?? 0) * 60 + (m ?? 0)) * 60_000;
  const first = guess - zoneOffset(timeZone, guess);
  return new Date(guess - zoneOffset(timeZone, first));
}

/** Whether `d` (a day) is one of the rule's days, ignoring times, `until` and `count`. */
function matches(rule: RecurrenceRule, d: Date, start: Date): boolean {
  const every = Math.max(1, rule.interval || 1);
  const wd = weekdayOf(d);
  switch (rule.freq) {
    case "once":
      return daysBetween(start, d) === 0;
    case "hourly":
      // Every N hours runs every day (the hours are counted within the day).
      return !rule.byWeekday?.length || rule.byWeekday.includes(wd);
    case "daily":
      return daysBetween(start, d) % every === 0 && (!rule.byWeekday?.length || rule.byWeekday.includes(wd));
    case "weekly": {
      const days = rule.byWeekday?.length ? rule.byWeekday : [weekdayOf(start)];
      return days.includes(wd) && (daysBetween(mondayOf(start), mondayOf(d)) / 7) % every === 0;
    }
    case "monthly": {
      const months = (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + d.getUTCMonth() - start.getUTCMonth();
      if (months % every !== 0) return false;
      if (rule.byWeekday?.length && rule.bySetPos) {
        const last = lastDayOfMonth(d);
        const candidates: number[] = [];
        for (let n = 1; n <= last; n++) {
          const c = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), n));
          if (rule.byWeekday.includes(weekdayOf(c))) candidates.push(n);
        }
        const pick = rule.bySetPos > 0 ? candidates[rule.bySetPos - 1] : candidates[candidates.length + rule.bySetPos];
        return pick === d.getUTCDate();
      }
      const days = rule.byMonthDay?.length ? rule.byMonthDay : [start.getUTCDate()];
      const last = lastDayOfMonth(d);
      return days.some((n) => (n < 0 ? last + 1 + n : Math.min(n, last)) === d.getUTCDate());
    }
    case "yearly":
      return (
        (d.getUTCFullYear() - start.getUTCFullYear()) % every === 0 &&
        d.getUTCMonth() === start.getUTCMonth() &&
        d.getUTCDate() === Math.min(start.getUTCDate(), lastDayOfMonth(d))
      );
  }
}

/** Hard bound on the walk (about 30 years of days). */
const MAX_DAYS = 11_000;

/** The next `n` occurrences at or after `from` (as instants). */
export function nextOccurrences(rule: RecurrenceRule, from: Date, n = 3): Date[] {
  const out: Date[] = [];
  const start = day(rule.start);
  const until = rule.until ? day(rule.until) : null;
  const times = (rule.times.length ? [...rule.times] : ["09:00"]).sort();
  let seen = 0;
  for (let i = 0; i < MAX_DAYS && out.length < n; i++) {
    const d = plusDays(start, i);
    if (until && d > until) break;
    if (!matches(rule, d, start)) continue;
    const slots = rule.freq === "hourly" ? hourlySlots(times[0] ?? "00:00", Math.max(1, rule.interval || 1)) : times;
    for (const hm of slots) {
      seen++;
      if (rule.count && seen > rule.count) return out;
      const at = zonedInstant(ymdOf(d), hm, rule.timezone);
      if (at >= from) out.push(at);
      if (out.length >= n) break;
    }
    if (rule.freq === "once") break;
  }
  return out;
}

/** Every `every` hours from `startHm` until the end of the day. */
function hourlySlots(startHm: string, every: number) {
  const [h, m] = startHm.split(":").map(Number);
  const slots: string[] = [];
  for (let x = h ?? 0; x < 24; x += every) slots.push(`${pad(x)}:${pad(m ?? 0)}`);
  return slots;
}

/** A sensible rule for a new choice of frequency, keeping times, zone and period. */
export function ruleFor(freq: RecurrenceFreq, base: RecurrenceRule): RecurrenceRule {
  const keep = { times: base.times, timezone: base.timezone, start: base.start, until: base.until, count: base.count };
  const startDay = day(base.start);
  switch (freq) {
    case "once":
      return { freq, interval: 1, ...keep, until: null, count: null };
    case "hourly":
      return { freq, interval: 1, ...keep, times: [base.times[0] ?? "09:00"] };
    case "daily":
      return { freq, interval: 1, ...keep };
    case "weekly":
      return { freq, interval: 1, byWeekday: [weekdayOf(startDay)], ...keep };
    case "monthly":
      return { freq, interval: 1, byMonthDay: [startDay.getUTCDate()], ...keep };
    case "yearly":
      return { freq, interval: 1, ...keep };
  }
}

/** The weekday of a `YYYY-MM-DD` day. */
export const weekdayOfYmd = (ymd: string) => weekdayOf(day(ymd));
/** Which occurrence of its weekday a day is in its month (1–5), and whether it's the last. */
export function weekdayPosition(ymd: string) {
  const d = day(ymd);
  const nth = Math.ceil(d.getUTCDate() / 7);
  return { nth, last: d.getUTCDate() + 7 > lastDayOfMonth(d), weekday: weekdayOf(d) };
}
