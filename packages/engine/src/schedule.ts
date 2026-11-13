import { isValidCron, nextCronTime, zonedParts, zonedTime } from "./cron";
import type { ErrorParams } from "./errors";
import {
  cronToRule,
  describeRule,
  nextOccurrence,
  normalizeRule,
  ruleToCron,
  type ScheduleRule,
  timezoneName,
} from "./rrule";
import { type ScheduleReader, splitLocalDateTime } from "./schedule-reader";

/**
 * Schedules and moments people write ("toda segunda às 9h", "amanhã às 9h",
 * in any language) become rules and instants here. The words are read by a
 * `ScheduleReader` (a model with structured output); this code only checks
 * what it answered, converts local times to UTC and refuses the past or
 * rules that never fire. A cron expression is accepted as it is (syntax).
 */
export type ScheduleParse =
  | {
      ok: true;
      /** Empty when only the rule can say it ("every 2 weeks"). */
      cron: string;
      description: string;
      timezone: string;
      /** The structured form; null for a cron that doesn't map to one. */
      rule: ScheduleRule | null;
    }
  /** `code` is stable (the app translates it); `error` is the English fallback. */
  | { ok: false; error: string; code: string; params?: ErrorParams };

/** A schedule phrase read: a rule, a cron rules can't hold, or a one-off moment. */
export type ScheduleReading =
  | { ok: true; type: "rule"; rule: ScheduleRule; cron: string | null; description: string; next: Date }
  | { ok: true; type: "cron"; cron: string; description: string; next: Date }
  | { ok: true; type: "once"; at: Date; description: string }
  | { ok: false; error: string; code: string; params?: ErrorParams };

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hhmm = ([h, m]: [number, number]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

// The English text is what agents read: a workspace with no model of its own to read words can still take cron.
const UNREADABLE = {
  ok: false as const,
  error:
    'Couldn\'t read the schedule in words. Send it as a 5-field cron expression in the workspace\'s time zone instead: "0 9 * * 1-5" is weekdays at 9am, "0 1 * * *" every day at 1am.',
  code: "schedule.unreadable",
};

/** A 5-field cron expression as typed (syntax, not language); null when it isn't one. */
function asCron(text: string) {
  const cron = text.trim().replace(/\s+/g, " ");
  return cron.split(" ").length === 5 && isValidCron(cron) ? cron : null;
}

const failure = (error: unknown) => ({
  ok: false as const,
  error: error instanceof Error ? error.message : String(error),
  code: (error as { code?: string }).code ?? "schedule.invalid",
  ...((error as { params?: ErrorParams }).params ? { params: (error as { params?: ErrorParams }).params } : {}),
});

/** A rule checked (`normalizeRule`) and known to fire after `now`. */
function ruleReading(input: ScheduleRule, now: Date): ScheduleReading {
  let rule: ScheduleRule;
  try {
    rule = normalizeRule(input, now);
  } catch (error) {
    return failure(error);
  }
  const next = nextOccurrence(rule, now);
  if (!next) return { ok: false, error: "This schedule never happens (or the series ended)", code: "schedule.never" };
  return { ok: true, type: "rule", rule, cron: ruleToCron(rule), description: describeRule(rule), next };
}

/** The instant of a local "YYYY-MM-DDTHH:mm" in `timezone`, refused when invalid, skipped by DST or past. */
function momentReading(
  local: string,
  timezone: string,
  now: Date,
): { ok: true; at: Date } | { ok: false; error: string; code: string } {
  const parts = splitLocalDateTime(local);
  if (!parts) {
    return {
      ok: false,
      error: 'Couldn\'t tell when. Try something like "tomorrow at 9am", "Friday at 3pm" or "in 2 hours".',
      code: "when.unreadable",
    };
  }
  const at = zonedTime(parts.year, parts.month, parts.day, parts.hour, parts.minute, timezone);
  if (!at) return { ok: false, error: "That time doesn't exist in this time zone.", code: "when.nonexistent" };
  if (at.getTime() <= now.getTime()) return { ok: false, error: "That time has already passed.", code: "when.past" };
  return { ok: true, at };
}

/**
 * A schedule phrase in `timezone`: a cron expression as it is, else what the
 * reader answers (a rule, or a one-off moment), checked here.
 */
export async function readSchedule(
  reader: ScheduleReader | null | undefined,
  input: { orgId: string; phrase: string; timezone: string; now?: Date },
): Promise<ScheduleReading> {
  const now = input.now ?? new Date();
  const phrase = input.phrase.trim();
  if (!phrase) return { ok: false, error: "Say when the routine should run", code: "routine.schedule_required" };
  const cron = asCron(phrase);
  if (cron) {
    const asRule = cronToRule(cron, input.timezone);
    if (asRule) return ruleReading(asRule, now);
    const next = nextCronTime(cron, input.timezone, now);
    if (!next) return { ok: false, error: "This schedule never happens", code: "schedule.never" };
    return { ok: true, type: "cron", cron, description: `cron ${cron} (${timezoneName(input.timezone)})`, next };
  }
  if (!reader) return UNREADABLE;
  const reading = await reader
    .readRecurrence({ orgId: input.orgId, phrase: phrase.slice(0, 300), timezone: input.timezone, now })
    .catch(() => null);
  if (!reading) return UNREADABLE;
  if (reading.type === "minutes") {
    const every = `*/${reading.every} * * * *`;
    const next = nextCronTime(every, input.timezone, now);
    if (!next) return { ok: false, error: "This schedule never happens", code: "schedule.never" };
    const description = reading.every === 1 ? "Every minute" : `Every ${reading.every} minutes`;
    return { ok: true, type: "cron", cron: every, description, next };
  }
  if (reading.type === "once") {
    const moment = momentReading(reading.localDateTime, input.timezone, now);
    if (!moment.ok) return moment;
    return { ok: true, type: "once", at: moment.at, description: describeWhen(moment.at, input.timezone, now) };
  }
  return ruleReading({ ...reading.rule, timezone: input.timezone }, now);
}

/** A recurring schedule as cron (when cron can say it) and rule; a one-off is refused. */
export async function parseSchedule(
  reader: ScheduleReader | null | undefined,
  input: { orgId: string; phrase: string; timezone: string; now?: Date },
): Promise<ScheduleParse> {
  const reading = await readSchedule(reader, input);
  if (!reading.ok) return reading;
  if (reading.type === "once") {
    return {
      ok: false,
      error: 'That is a single moment, not a schedule that repeats. Try "every Monday at 9am".',
      code: "schedule.not_recurring",
    };
  }
  return {
    ok: true,
    cron: reading.cron ?? "",
    description: reading.description,
    timezone: input.timezone,
    rule: reading.type === "rule" ? reading.rule : null,
  };
}

// ── One-off times ("amanhã às 9h") for reminders ─────────────────────────────

/** `code` is stable (the app or the model can say it in the person's language); `error` is English. */
export type WhenParse =
  | { ok: true; at: Date; timezone: string; description: string }
  | { ok: false; error: string; code: string };

const addDays = (y: number, mo: number, d: number, n: number) => {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};
const weekdayOf = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

/** "tomorrow, Oct 16, at 09:00 (Brasília time)"; other days by weekday ("Monday, Oct 19, …"). */
export function describeWhen(at: Date, timezone: string, now = new Date()) {
  const p = zonedParts(at, timezone);
  const today = zonedParts(now, timezone);
  const tomorrow = addDays(today.year, today.month, today.day, 1);
  const same = (a: { year: number; month: number; day: number }) =>
    a.year === p.year && a.month === p.month && a.day === p.day;
  const day = same(today)
    ? "today"
    : same(tomorrow)
      ? "tomorrow"
      : (WEEKDAY_NAMES[weekdayOf(p.year, p.month, p.day)] ?? "");
  const date = `${MONTH_NAMES[p.month - 1]} ${p.day}${p.year !== today.year ? `, ${p.year}` : ""}`;
  return `${day}, ${date}, at ${hhmm([p.hour, p.minute])} (${timezoneName(timezone)})`;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A one-off time in `timezone`: ISO 8601 as it is (with an offset or Z:
 * exact; without: local wall time), else what the reader answers ("amanhã às
 * 9h", "in 2 hours", "vendredi à 15h"). Needs a time of day; the past is refused.
 */
export async function parseWhen(
  reader: ScheduleReader | null | undefined,
  input: { orgId: string; text: string; timezone: string; now?: Date },
): Promise<WhenParse> {
  const now = input.now ?? new Date();
  const raw = input.text.trim();
  if (!raw) return { ok: false, error: "Say when.", code: "when.required" };
  const done = (moment: ReturnType<typeof momentReading>): WhenParse =>
    moment.ok
      ? { ok: true, at: moment.at, timezone: input.timezone, description: describeWhen(moment.at, input.timezone, now) }
      : moment;
  const iso = ISO.exec(raw);
  if (iso) {
    if (iso[6]) {
      const at = new Date(raw);
      if (Number.isNaN(at.getTime()))
        return { ok: false, error: "That time doesn't exist in this time zone.", code: "when.nonexistent" };
      if (at.getTime() <= now.getTime())
        return { ok: false, error: "That time has already passed.", code: "when.past" };
      return done({ ok: true, at });
    }
    return done(momentReading(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}`, input.timezone, now));
  }
  const reading = reader
    ? await reader
        .readMoment({ orgId: input.orgId, text: raw.slice(0, 300), timezone: input.timezone, now })
        .catch(() => ({ error: "unreadable" as const }))
    : ({ error: "unreadable" } as const);
  if ("error" in reading) {
    return reading.error === "time_missing"
      ? { ok: false, error: 'The time of day is missing (for example, "at 9am").', code: "when.time_missing" }
      : {
          ok: false,
          error: 'Couldn\'t tell when. Try something like "tomorrow at 9am", "Friday at 3pm" or "in 2 hours".',
          code: "when.unreadable",
        };
  }
  return done(momentReading(reading.localDateTime, input.timezone, now));
}
