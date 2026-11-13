import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMMON_RULES,
  HALF_HOURS,
  nextDays,
  presetOf,
  type RecurrenceRule,
  withPreset,
} from "../../src/features/routines/rule";

const base: RecurrenceRule = {
  freq: "weekly",
  interval: 1,
  byWeekday: ["WE"],
  times: ["09:00"],
  timezone: "America/Sao_Paulo",
  start: "2026-11-11",
};

describe("a routine's when as rows (Repetição, Dia, Horário)", () => {
  test("a rule reads as one of the common ones, or as written in the person's own way", () => {
    expect(presetOf(base)).toBe("weekly");
    expect(presetOf({ ...base, freq: "once" })).toBe("once");
    expect(presetOf({ ...base, freq: "daily", byWeekday: undefined })).toBe("daily");
    expect(presetOf({ ...base, freq: "daily", byWeekday: ["MO", "TU", "WE", "TH", "FR"] })).toBe("business");
    expect(presetOf({ ...base, freq: "monthly", byWeekday: undefined, byMonthDay: [5] })).toBe("monthly");
    // Every 2 weeks, two days, two times, an end: only the phrase says those.
    expect(presetOf({ ...base, interval: 2 })).toBe("custom");
    expect(presetOf({ ...base, byWeekday: ["MO", "WE"] })).toBe("custom");
    expect(presetOf({ ...base, times: ["09:00", "18:00"] })).toBe("custom");
    expect(presetOf({ ...base, until: "2026-12-31" })).toBe("custom");
    expect(presetOf({ ...base, freq: "monthly", byWeekday: ["MO"], bySetPos: 2 })).toBe("custom");
  });

  test("picking one keeps the time, zone and start, and the day it already fell on", () => {
    const daily = withPreset({ ...base, interval: 2, until: "2026-12-31" }, "daily");
    expect(daily).toEqual({ freq: "daily", interval: 1, times: ["09:00"], timezone: base.timezone, start: base.start });
    expect(withPreset(daily, "weekly").byWeekday).toEqual(["WE"]);
    expect(withPreset(base, "weekly").byWeekday).toEqual(["WE"]);
    expect(withPreset(base, "monthly").byMonthDay).toEqual([11]);
    expect(withPreset(base, "business").byWeekday).toEqual(["MO", "TU", "WE", "TH", "FR"]);
    for (const p of COMMON_RULES) expect(presetOf(withPreset(base, p))).toBe(p);
  });

  test("the times every half hour, and the next two weeks of days", () => {
    expect(HALF_HOURS).toHaveLength(48);
    expect(HALF_HOURS.slice(0, 3)).toEqual(["00:00", "00:30", "01:00"]);
    expect(HALF_HOURS.at(-1)).toBe("23:30");
    const days = nextDays(new Date(2026, 11, 30));
    expect(days).toHaveLength(14);
    expect(days.slice(0, 3)).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
  });

  test("the form offers them as rows from the system's list, the phrase only for what they don't hold", () => {
    const form = readFileSync(join(import.meta.dir, "../../src/features/routines/RoutineForm.tsx"), "utf8");
    expect(form).toContain("onPress={pickPreset}");
    expect(form).toContain("onPress={pickDay}");
    expect(form).toContain("onPress={pickTime}");
    expect(form).toContain('const showPhrase = writing || cron !== null || preset === "custom";');
  });
});
