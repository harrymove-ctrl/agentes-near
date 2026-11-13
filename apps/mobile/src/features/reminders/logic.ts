/**
 * "Lembrar": the quick times ("Daqui a 1 hora", "Hoje à noite", "Amanhã de
 * manhã"), the custom day and time, the checks the server also makes and
 * the ISO time with the device's offset it expects. Times are the device's
 * local time (what the person sees on the clock).
 */

export type ReminderPreset = "inHour" | "tonight" | "tomorrowMorning";
export const REMINDER_PRESETS: ReminderPreset[] = ["inHour", "tonight", "tomorrowMorning"];

/** "Hoje à noite" is at 19h; "Amanhã de manhã" at 9h. */
export const TONIGHT_HOUR = 19;
export const MORNING_HOUR = 9;
/** "Hoje à noite" is offered only while 19h is at least this far away. */
const TONIGHT_LEAD_MS = 15 * 60_000;
/** The server refuses more than a year ahead (`when.too_far`). */
const MAX_AHEAD_MS = 365 * 86_400_000;

const atLocal = (day: Date, hour: number, minute = 0, addDays = 0) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + addDays, hour, minute, 0, 0);

/** When a quick time falls, from `now`; null when it is not offered now ("Hoje à noite" after 18:45). */
export function presetAt(preset: ReminderPreset, now = new Date()): Date | null {
  switch (preset) {
    case "inHour": {
      const at = new Date(now.getTime() + 3_600_000);
      at.setSeconds(0, 0);
      return at;
    }
    case "tonight": {
      const at = atLocal(now, TONIGHT_HOUR);
      return at.getTime() - now.getTime() >= TONIGHT_LEAD_MS ? at : null;
    }
    case "tomorrowMorning":
      return atLocal(now, MORNING_HOUR, 0, 1);
  }
}

/** The quick times offered now, in order, with when each falls. */
export function reminderPresets(now = new Date()): { preset: ReminderPreset; at: Date }[] {
  return REMINDER_PRESETS.flatMap((preset) => {
    const at = presetAt(preset, now);
    return at ? [{ preset, at }] : [];
  });
}

// ── "Escolher…" ──────────────────────────────────────────────────────────────

export interface ClockTime {
  hour: number;
  minute: number;
}

/** The minute stepper moves by this much. */
export const MINUTE_STEP = 15;

/** Moves a time of day by `minutes`, around the clock (23:45 + 15 = 0:00). */
export function stepTime(t: ClockTime, minutes: number): ClockTime {
  const total = (((t.hour * 60 + t.minute + minutes) % 1440) + 1440) % 1440;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

/** The days to pick from: today and the next ones (local midnights). */
export function dayChoices(now = new Date(), count = 7): Date[] {
  return Array.from({ length: count }, (_, i) => atLocal(now, 0, 0, i));
}

/** That day at that time. */
export const atDayTime = (day: Date, t: ClockTime) => atLocal(day, t.hour, t.minute);

/** Where "Escolher…" starts: two hours ahead on the hour, or tomorrow at 9h when that is late at night. */
export function defaultCustom(now = new Date()): { dayOffset: number; time: ClockTime } {
  const hour = now.getHours() + 2;
  if (hour >= 22) return { dayOffset: 1, time: { hour: MORNING_HOUR, minute: 0 } };
  return { dayOffset: 0, time: { hour, minute: 0 } };
}

/** Whole days from today to the day of `at` (0 = today, 1 = tomorrow), in local time. */
export function dayOffsetOf(at: Date, now = new Date()) {
  return Math.round((atLocal(at, 0).getTime() - atLocal(now, 0).getTime()) / 86_400_000);
}

/** The server's own checks, before asking: in the future, at most a year ahead. */
export function checkWhen(at: Date, now = new Date()): "ok" | "past" | "tooFar" {
  if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime() + 60_000) return "past";
  if (at.getTime() - now.getTime() > MAX_AHEAD_MS) return "tooFar";
  return "ok";
}

// ── To the server ────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `2026-10-17T19:00:00-03:00`: the local time with its offset (minutes east
 * of UTC; default: the device's at that moment).
 */
export function isoWithOffset(d: Date, offsetMinutes = -d.getTimezoneOffset()): string {
  const local = new Date(d.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** The device's time zone (`America/Sao_Paulo`), or null when the platform doesn't say. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Which friendly text an error code gets (`mobile.remind.error.*`). */
export type ReminderErrorKey = "noAgent" | "past" | "tooFar" | "noText" | "failed";
export function reminderErrorKey(code: string | null | undefined): ReminderErrorKey {
  switch (code) {
    case "reminder.no_agent":
      return "noAgent";
    case "when.past":
      return "past";
    case "when.too_far":
      return "tooFar";
    case "reminder.text_required":
      return "noText";
    default:
      return "failed";
  }
}
