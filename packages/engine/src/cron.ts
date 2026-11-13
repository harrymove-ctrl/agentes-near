/**
 * Five-field cron (minute hour day-of-month month day-of-week) evaluated in
 * an IANA time zone, without dependencies. Supports `*`, lists, ranges and
 * steps (`*\/15`, `1-5`, `1,3,5`, `9-17/2`); day-of-week 0 or 7 is Sunday.
 * When both day fields are restricted, a day matches either (as in Vixie
 * cron).
 *
 * Daylight saving time, the same as recurrence rules (`rrule.ts`): a local
 * time that doesn't exist (the hour skipped in spring) moves forward to the
 * first valid minute after it, the same day; a local time that happens twice
 * (autumn) runs once, at its first occurrence.
 */
export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

function field(text: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`invalid cron field "${part}"`);
    const step = m[3] ? Number(m[3]) : 1;
    let from: number;
    let to: number;
    if (m[1] === "*") {
      from = min;
      to = max;
    } else {
      from = Number(m[1]);
      to = m[2] ? Number(m[2]) : m[3] ? max : from;
    }
    if (from < min || to > max || from > to || step < 1) throw new Error(`cron value out of range in "${part}"`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expression: string): CronSpec {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs 5 fields: minute hour day month weekday");
  const [mi = "", h = "", d = "", mo = "", w = ""] = parts;
  const weekdays = field(w, 0, 7);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    minutes: field(mi, 0, 59),
    hours: field(h, 0, 23),
    days: field(d, 1, 31),
    months: field(mo, 1, 12),
    weekdays,
    dayRestricted: d !== "*",
    weekdayRestricted: w !== "*",
  };
}

export const isValidCron = (expression: string) => {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** Offset (ms) of a time zone at an instant: local wall time minus UTC. */
function offsetAt(instant: number, timeZone: string) {
  const p = zonedParts(new Date(instant), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(instant / 60_000) * 60_000;
}

/**
 * The instant of a local wall time in a time zone, or null when that time
 * doesn't exist there (skipped by a DST change). For a time that happens
 * twice, the first one.
 */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date | null {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = [...new Set([offsetAt(wall - 86_400_000, timeZone), offsetAt(wall + 86_400_000, timeZone)])]
    .map((offset) => wall - offset)
    .sort((a, b) => a - b);
  for (const c of candidates) {
    const p = zonedParts(new Date(c), timeZone);
    if (p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi) return new Date(c);
  }
  return null;
}

/**
 * The instant of a local wall time, a time skipped by DST moved forward to the first valid minute after
 * it (the same day): the one semantics schedules use. Null only when nothing is left of that day.
 */
export function zonedTimeForward(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timeZone: string,
): Date | null {
  let at = zonedTime(y, mo, d, h, mi, timeZone);
  // DST gaps are at most two hours.
  for (let shift = 1; !at && shift <= 120; shift++) {
    const total = h * 60 + mi + shift;
    if (total >= 24 * 60) break;
    at = zonedTime(y, mo, d, Math.floor(total / 60), total % 60, timeZone);
  }
  return at;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The next instant strictly after `after` that matches, in `timeZone` (searches up to ~4 years). */
export function nextCronTime(expression: string | CronSpec, timeZone: string, after: Date): Date | null {
  const spec = typeof expression === "string" ? parseCron(expression) : expression;
  const start = zonedParts(after, timeZone);
  let y = start.year;
  let mo = start.month;
  let d = start.day;
  const minutes = [...spec.minutes].sort((a, b) => a - b);
  const hours = [...spec.hours].sort((a, b) => a - b);
  for (let i = 0; i < 1500; i++) {
    if (spec.months.has(mo) && d <= daysInMonth(y, mo)) {
      const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
      const dayOk =
        spec.dayRestricted && spec.weekdayRestricted
          ? spec.days.has(d) || spec.weekdays.has(weekday)
          : spec.days.has(d) && spec.weekdays.has(weekday);
      if (dayOk) {
        for (const h of hours) {
          for (const mi of minutes) {
            // Several slots inside a DST gap move to the same instant: "strictly after" runs it once.
            const at = zonedTimeForward(y, mo, d, h, mi, timeZone);
            if (at && at.getTime() > after.getTime()) return at;
          }
        }
      }
    }
    d++;
    if (d > daysInMonth(y, mo)) {
      d = 1;
      mo++;
      if (mo > 12) {
        mo = 1;
        y++;
      }
    }
  }
  return null;
}
