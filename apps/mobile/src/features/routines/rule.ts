import type { ApiRule, ProposedRoutine } from "@agenteschat/client";
import { clockHour, joinNames, toYmd } from "@agenteschat/client/lib/format";
import { timezoneName } from "@agenteschat/client/lib/routines";
import {
  BUSINESS_DAYS,
  nextOccurrences,
  type RecurrenceRule,
  type Weekday,
  weekdayOfYmd,
  zonedInstant,
} from "@agenteschat/ui/recurrence";
import type { TFunction } from "i18next";

/**
 * A routine's "when" on the phone: the rule the API sends turned into the form's rule and back, the sentence
 * in the person's language ("Toda semana, seg, às 09:00") and the next runs, as the web says them
 * (`apps/web/src/lib/recurrence.ts`, an app module the phone can't import). The date math itself is the shared
 * `@agenteschat/ui/recurrence`. Pure TypeScript, so it runs in `bun test`.
 */

export type { RecurrenceRule };

const pad = (n: number) => String(n).padStart(2, "0");
const isBusiness = (days: Weekday[] | undefined) =>
  Boolean(days && days.length === 5 && BUSINESS_DAYS.every((d) => days.includes(d)));

/** A new rule: today, 09:00, every week on today's weekday. */
export function defaultRule(timezone: string, today = new Date()): RecurrenceRule {
  const start = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return { freq: "weekly", interval: 1, byWeekday: [weekdayOfYmd(start)], times: ["09:00"], timezone, start };
}

/** "15 de outubro". */
const dayMonth = (locale: string, ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }).format(
    new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1),
  );
};

/** "31/12" (with the year when it isn't this one). */
const shortDate = (locale: string, ymd: string, now = new Date()) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1);
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
};

/** "A cada 2 semanas, seg e qua, às 09:00 (horário de Brasília), até 31/12". */
export function ruleSentence(
  t: TFunction,
  locale: string,
  rule: RecurrenceRule,
  now = new Date(),
  /** Leave the zone out (the list says it only when it isn't mine). */
  withZone = true,
): string {
  const n = Math.max(1, rule.interval || 1);
  const days = (list: Weekday[]) =>
    joinNames(
      list.map((d) => t(`recurrence.wd.${d}.abbr`)),
      t,
    );
  let head: string;
  switch (rule.freq) {
    case "once":
      head = t("recurrence.s.once", { date: shortDate(locale, rule.start, now) });
      break;
    case "hourly":
      head = t("recurrence.s.hourly", { count: n });
      break;
    case "daily":
      head = isBusiness(rule.byWeekday)
        ? t("recurrence.s.businessDays")
        : rule.byWeekday?.length
          ? days(rule.byWeekday)
          : t("recurrence.s.daily", { count: n });
      break;
    case "weekly":
      head = `${t("recurrence.s.weekly", { count: n })}, ${days(rule.byWeekday?.length ? rule.byWeekday : [weekdayOfYmd(rule.start)])}`;
      break;
    case "monthly": {
      const every = t("recurrence.s.monthly", { count: n });
      if (rule.bySetPos && rule.byWeekday?.length) {
        head =
          isBusiness(rule.byWeekday) && rule.bySetPos === -1
            ? t("recurrence.s.lastBusiness", { every })
            : t("recurrence.s.nth", {
                every,
                nth: rule.bySetPos === -1 ? t("recurrence.last") : t("recurrence.nth", { n: rule.bySetPos }),
                weekday: t(`recurrence.wd.${rule.byWeekday[0] as Weekday}.long`),
              });
      } else {
        const d = rule.byMonthDay?.[0] ?? Number(rule.start.slice(8, 10));
        head = d === -1 ? t("recurrence.s.lastDay", { every }) : t("recurrence.s.monthDay", { every, day: d });
      }
      break;
    }
    case "yearly":
      head = t("recurrence.s.yearly", { count: n, date: dayMonth(locale, rule.start) });
      break;
  }
  const times = [...rule.times].sort();
  const parts = [head];
  if (rule.freq === "hourly") parts.push(t("recurrence.s.from", { time: times[0] ?? "00:00" }));
  else if (times.length) parts.push(t("recurrence.s.at", { times: joinNames(times, t) }));
  let out = withZone ? `${parts.join(", ")} (${timezoneName(rule.timezone, locale)})` : parts.join(", ");
  if (rule.until) out += `, ${t("recurrence.s.until", { date: shortDate(locale, rule.until, now) })}`;
  else if (rule.count) out += `, ${t("recurrence.s.count", { count: rule.count })}`;
  return out;
}

/** A run in its zone: "seg, 20 out · 09:00" (the form's "Próximas"). */
export function runLabel(locale: string, iso: string | Date, timeZone: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");
  const time = new Intl.DateTimeFormat(locale, { hour: clockHour(locale), minute: "2-digit", timeZone }).format(d);
  return `${date} · ${time}`;
}

/** The next occurrences in the rule's zone, before the server answers with its own. */
export function upcomingLabels(locale: string, rule: RecurrenceRule, from = new Date(), n = 3): string[] {
  return nextOccurrences(rule, from, n).map((d) => runLabel(locale, d, rule.timezone));
}

/** A next run on this phone's clock: "seg 20 out, 09:00". */
export { nextLabel } from "@agenteschat/client/lib/format";

// ── The API's rule ⇄ the form's ────────────────────────────────────────────

const POSITIONED = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/;

/** The rule the API sends (positions like "2TU" in `byWeekday`) as the form's. */
export function fromApiRule(r: ApiRule, fallbackStart: string): RecurrenceRule {
  let bySetPos = r.bySetPos ?? undefined;
  const byWeekday = (r.byWeekday ?? []).flatMap((w) => {
    const m = POSITIONED.exec(w);
    if (!m) return [];
    if (m[1]) bySetPos = Number(m[1]);
    return [m[2] as Weekday];
  });
  return {
    freq: r.freq,
    interval: Math.max(1, r.interval ?? 1),
    ...(byWeekday.length ? { byWeekday } : {}),
    ...(r.byMonthDay?.length && !(r.freq === "yearly") ? { byMonthDay: r.byMonthDay } : {}),
    ...(bySetPos ? { bySetPos } : {}),
    times: r.times?.length ? r.times : ["09:00"],
    timezone: r.timezone,
    start: r.start ?? fallbackStart,
    until: r.until ?? null,
    count: r.count ?? null,
  };
}

/** The form's rule as the API takes it (what is sent, never a phrase). */
export function toApiRule(rule: RecurrenceRule): ApiRule {
  const base: ApiRule = {
    freq: rule.freq,
    interval: rule.interval,
    times: rule.times,
    timezone: rule.timezone,
    start: rule.start,
    until: rule.until ?? null,
    count: rule.count ?? null,
  };
  if (rule.freq === "monthly" && rule.bySetPos && rule.byWeekday?.length === 1)
    return { ...base, byWeekday: [`${rule.bySetPos}${rule.byWeekday[0]}`] };
  if (rule.freq === "yearly") {
    const [, m, d] = rule.start.split("-").map(Number);
    return { ...base, byMonth: [m ?? 1], byMonthDay: [d ?? 1] };
  }
  return {
    ...base,
    ...(rule.byWeekday?.length ? { byWeekday: rule.byWeekday } : {}),
    ...(rule.byMonthDay?.length ? { byMonthDay: rule.byMonthDay } : {}),
    ...(rule.bySetPos ? { bySetPos: rule.bySetPos } : {}),
  };
}

/** A one-off's moment as a rule ("Uma vez", that day and time in its zone). */
export function onceRule(at: string, timezone: string): RecurrenceRule {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    freq: "once",
    interval: 1,
    times: [`${get("hour")}:${get("minute")}`],
    timezone,
    start: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** A one-off rule's instant, as the API takes it. */
export const onceAt = (rule: RecurrenceRule) =>
  zonedInstant(rule.start, rule.times[0] ?? "09:00", rule.timezone).toISOString();

/** When a proposed agent's routine runs, as the web says it; a schedule no rule holds, as the agent wrote it. */
export const proposedRoutineWhen = (t: TFunction, locale: string, r: ProposedRoutine, now = new Date()) =>
  r.rule ? ruleSentence(t, locale, fromApiRule(r.rule, toYmd(now)), now) : r.schedule;

/**
 * The common "when"s the form offers as rows (Repetição, Dia, Horário), each picked from the system's list: the rule
 * reads as one of them, or as `custom` (every 2 weeks, several days or times, an end), which only the phrase says.
 */
export type RulePreset = "once" | "daily" | "business" | "weekly" | "monthly" | "custom";
export const COMMON_RULES: Exclude<RulePreset, "custom">[] = ["once", "daily", "business", "weekly", "monthly"];

export function presetOf(rule: RecurrenceRule): RulePreset {
  if (rule.freq === "once") return "once";
  if ((rule.interval || 1) !== 1 || rule.until || rule.count || rule.times.length !== 1) return "custom";
  if (rule.freq === "daily")
    return isBusiness(rule.byWeekday) ? "business" : rule.byWeekday?.length ? "custom" : "daily";
  if (rule.freq === "weekly") return rule.byWeekday?.length === 1 ? "weekly" : "custom";
  if (rule.freq === "monthly")
    return !rule.byWeekday?.length && rule.byMonthDay?.length === 1 && rule.bySetPos === undefined
      ? "monthly"
      : "custom";
  return "custom";
}

/** The rule as a preset, keeping its time, zone and start; the day it falls on comes from what it had, or its start. */
export function withPreset(rule: RecurrenceRule, preset: Exclude<RulePreset, "custom">): RecurrenceRule {
  const { byWeekday, byMonthDay, bySetPos: _pos, until: _until, count: _count, ...rest } = rule;
  const base: RecurrenceRule = { ...rest, interval: 1, times: [rule.times[0] ?? "09:00"] };
  switch (preset) {
    case "once":
      return { ...base, freq: "once" };
    case "daily":
      return { ...base, freq: "daily" };
    case "business":
      return { ...base, freq: "daily", byWeekday: [...BUSINESS_DAYS] };
    case "weekly":
      return { ...base, freq: "weekly", byWeekday: [byWeekday?.[0] ?? weekdayOfYmd(rule.start)] };
    case "monthly":
      return { ...base, freq: "monthly", byMonthDay: [byMonthDay?.[0] ?? Number(rule.start.slice(8, 10))] };
  }
}

/** The times the Horário row offers: every half hour of the day. */
export const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`);

/** The days a one-off may fall on from the Dia row: today and the next 13, as `YYYY-MM-DD`. */
export const nextDays = (from = new Date(), count = 14) =>
  Array.from({ length: count }, (_, i) => toYmd(new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)));
