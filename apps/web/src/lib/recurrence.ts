import type { ApiRule, ProposedRoutine } from "@agenteschat/client";
import { clockHour, joinNames, toYmd } from "@agenteschat/client/lib/format";
import { timezoneName } from "@agenteschat/client/lib/routines";
import {
  BUSINESS_DAYS,
  nextOccurrences,
  type RecurrenceLabels,
  type RecurrenceRule,
  WEEKDAYS,
  type Weekday,
  weekdayOfYmd,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";

const pad = (n: number) => String(n).padStart(2, "0");
const isBusiness = (days: Weekday[] | undefined) =>
  Boolean(days && days.length === 5 && BUSINESS_DAYS.every((d) => days.includes(d)));

/** A new rule: today, 09:00, every week on today's weekday. */
export function defaultRule(timezone: string, today = new Date()): RecurrenceRule {
  const start = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return { freq: "weekly", interval: 1, byWeekday: [weekdayOfYmd(start)], times: ["09:00"], timezone, start };
}

/** Labels of the picker, in the UI language. */
export function recurrenceLabels(t: TFunction, locale: string, rule: RecurrenceRule): RecurrenceLabels {
  const weekdays = Object.fromEntries(
    WEEKDAYS.map((wd) => [wd, { short: t(`recurrence.wd.${wd}.short`), long: t(`recurrence.wd.${wd}.long`) }]),
  ) as RecurrenceLabels["weekdays"];
  return {
    frequency: t("recurrence.frequency"),
    modes: {
      once: t("recurrence.mode.once"),
      daily: t("recurrence.mode.daily"),
      weekly: t("recurrence.mode.weekly"),
      monthly: t("recurrence.mode.monthly"),
      yearly: t("recurrence.mode.yearly"),
      custom: t("recurrence.mode.custom"),
    },
    every: t("recurrence.every"),
    units: {
      hourly: t("recurrence.unit.hourly"),
      daily: t("recurrence.unit.daily"),
      weekly: t("recurrence.unit.weekly"),
      monthly: t("recurrence.unit.monthly"),
      yearly: t("recurrence.unit.yearly"),
    },
    interval: t("recurrence.interval"),
    unit: t("recurrence.unitLabel"),
    businessDays: t("recurrence.businessDays"),
    weekdaysLabel: t("recurrence.weekdays"),
    weekdays,
    onDay: t("recurrence.onDay"),
    onThe: t("recurrence.onThe"),
    nth: (n) => (n === -1 ? t("recurrence.last") : t("recurrence.nth", { n })),
    lastBusinessDay: t("recurrence.lastBusinessDay"),
    yearlyOn: t("recurrence.yearlyOn", { date: dayMonth(locale, rule.start) }),
    times: t("recurrence.times"),
    addTime: t("recurrence.addTime"),
    removeTime: t("recurrence.removeTime"),
    from: t("recurrence.from"),
    period: t("recurrence.period"),
    starts: t("recurrence.starts"),
    ends: t("recurrence.ends"),
    endsNever: t("recurrence.endsNever"),
    endsOn: t("recurrence.endsOn"),
    endsAfter: t("recurrence.endsAfter"),
    occurrences: t("recurrence.occurrences"),
    timezone: t("recurrence.timezone"),
    upcoming: t("recurrence.upcoming"),
    date: {
      previousMonth: t("common.previousMonth"),
      nextMonth: t("common.nextMonth"),
      choose: t("common.chooseDate"),
    },
  };
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

/**
 * The live sentence: "A cada 2 semanas, seg e qua, às 09:00 (horário de
 * Brasília), até 31/12".
 */
export function ruleSentence(
  t: TFunction,
  locale: string,
  rule: RecurrenceRule,
  now = new Date(),
  /** Leave the zone out (the card says it only when it isn't mine). */
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

/** The next occurrences, formatted ("seg, 20 out · 09:00"), in the rule's zone. */
export function upcomingLabels(locale: string, rule: RecurrenceRule, from = new Date(), n = 3) {
  return nextOccurrences(rule, from, n).map((d) => {
    const date = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: rule.timezone,
    })
      .format(d)
      .replace(/\./g, "")
      .replace(/ de /g, " ");
    const time = new Intl.DateTimeFormat(locale, {
      hour: clockHour(locale),
      minute: "2-digit",
      timeZone: rule.timezone,
    }).format(d);
    return `${date} · ${time}`;
  });
}

// ── The backend's rule ⇄ the picker's ───────────────────────────────────────

const POSITIONED = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/;

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

/** When a proposed agent's routine runs, in the reader's words; a schedule no rule holds, as the agent wrote it. */
export const proposedRoutineWhen = (t: TFunction, locale: string, r: ProposedRoutine, now = new Date()) =>
  r.rule ? ruleSentence(t, locale, fromApiRule(r.rule, toYmd(now)), now) : r.schedule;
