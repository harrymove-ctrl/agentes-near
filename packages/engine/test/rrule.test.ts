import { describe, expect, test } from "bun:test";
import {
  cronToRule,
  describeRule,
  endRuleBefore,
  nextOccurrence,
  normalizeRule,
  type RecurrenceFields,
  recurrenceFromFields,
  ruleOccurrences,
  ruleToCron,
  type ScheduleRule,
} from "../src";

const SP = "America/Sao_Paulo";
const at = (iso: string) => new Date(iso);
const days = (rule: ScheduleRule, from: string, to: string) =>
  ruleOccurrences(normalizeRule(rule), at(from), at(to)).map((d) => d.toISOString());

describe("rules", () => {
  test("DST in São Paulo (2018/19): wall time kept; a skipped midnight moves to the first valid minute; a repeated hour runs once", () => {
    // DST started at 00:00 on 2018-11-04 (clocks jumped to 01:00) and ended at 00:00 on 2019-02-17.
    const nine = { freq: "daily", times: ["09:00"], timezone: SP, start: "2018-11-03" } as ScheduleRule;
    expect(days(nine, "2018-11-03T00:00:00Z", "2018-11-06T00:00:00Z")).toEqual([
      "2018-11-03T12:00:00.000Z", // 09:00 -03
      "2018-11-04T11:00:00.000Z", // 09:00 -02
      "2018-11-05T11:00:00.000Z",
    ]);
    const midnight = { freq: "daily", times: ["00:30"], timezone: SP, start: "2018-11-03" } as ScheduleRule;
    expect(days(midnight, "2018-11-03T00:00:00Z", "2018-11-05T12:00:00Z")).toEqual([
      "2018-11-03T03:30:00.000Z",
      "2018-11-04T03:00:00.000Z", // 00:30 didn't exist: 01:00 -02
      "2018-11-05T02:30:00.000Z",
    ]);
    const late = { freq: "daily", times: ["23:30"], timezone: SP, start: "2019-02-15" } as ScheduleRule;
    const end = days(late, "2019-02-15T00:00:00Z", "2019-02-19T00:00:00Z");
    expect(end).toEqual([
      "2019-02-16T01:30:00.000Z", // 15th 23:30 -02
      "2019-02-17T01:30:00.000Z", // 16th 23:30 -02 (the first of the two)
      "2019-02-18T02:30:00.000Z", // 17th 23:30 -03
    ]);
  });

  test("month ends, last business day, nth weekday, every 2 weeks, until and count", () => {
    const local = (list: string[]) => list.map((d) => d.slice(0, 10));
    expect(
      local(
        days(
          { freq: "monthly", byMonthDay: [-1], times: ["12:00"], timezone: "UTC", start: "2026-01-15" },
          "2026-01-01T00:00:00Z",
          "2026-05-01T00:00:00Z",
        ),
      ),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    // On the 31st: months without one are skipped.
    expect(
      local(
        days(
          { freq: "monthly", times: ["12:00"], timezone: "UTC", start: "2026-01-31" },
          "2026-01-01T00:00:00Z",
          "2026-06-01T00:00:00Z",
        ),
      ),
    ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    const lastBusinessDay: ScheduleRule = {
      freq: "monthly",
      byWeekday: ["MO", "TU", "WE", "TH", "FR"],
      bySetPos: [-1],
      times: ["18:00"],
      timezone: SP,
      start: "2026-01-01",
    };
    expect(local(days(lastBusinessDay, "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z"))).toEqual([
      "2026-01-30",
      "2026-02-27",
      "2026-03-31",
      "2026-04-30",
      "2026-05-29",
    ]);
    expect(
      local(
        days(
          { freq: "monthly", byWeekday: ["2TU"], times: ["10:00"], timezone: "UTC", start: "2026-01-01" },
          "2026-01-01T00:00:00Z",
          "2026-03-01T00:00:00Z",
        ),
      ),
    ).toEqual(["2026-01-13", "2026-02-10"]);
    const biweekly: ScheduleRule = {
      freq: "weekly",
      interval: 2,
      byWeekday: ["MO", "WE"],
      times: ["09:00"],
      timezone: SP,
      start: "2026-10-12",
      until: "2026-11-11",
    };
    expect(local(days(biweekly, "2026-10-01T00:00:00Z", "2027-01-01T00:00:00Z"))).toEqual([
      "2026-10-12",
      "2026-10-14",
      "2026-10-26",
      "2026-10-28",
      "2026-11-09",
      "2026-11-11",
    ]);
    const thrice = normalizeRule({ freq: "daily", times: ["08:00"], timezone: "UTC", start: "2026-10-01", count: 3 });
    expect(
      ruleOccurrences(thrice, at("2026-10-02T00:00:00Z"), at("2026-12-01T00:00:00Z")).map((d) =>
        d.toISOString().slice(0, 10),
      ),
    ).toEqual(["2026-10-02", "2026-10-03"]);
    expect(nextOccurrence(thrice, at("2026-10-03T09:00:00Z"))).toBeNull();
    expect(endRuleBefore(thrice, "2026-10-02")).toMatchObject({ until: "2026-10-01" });
    expect(endRuleBefore(thrice, "2026-10-01")).toBeNull();
  });

  test("descriptions, cron when possible, and the way back from cron", () => {
    const biweekly = normalizeRule({
      freq: "weekly",
      interval: 2,
      byWeekday: ["MO", "WE"],
      time: "09:00",
      timezone: SP,
      start: "2026-10-12",
      until: "2026-12-31",
    });
    expect(describeRule(biweekly)).toMatch(/^Every 2 weeks, Mon and Wed, at 09:00 \(Brasília time\), until 12\/31/);
    expect(ruleToCron(biweekly)).toBeNull();
    expect(
      describeRule(
        normalizeRule({
          freq: "monthly",
          byWeekday: ["MO", "TU", "WE", "TH", "FR"],
          bySetPos: [-1],
          time: "18:00",
          timezone: SP,
        }),
      ),
    ).toBe("Every month, on the last business day, at 18:00 (Brasília time)");
    const workdays = cronToRule("0 9 * * 1-5", SP) as ScheduleRule;
    expect(workdays).toMatchObject({ freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["09:00"] });
    expect(ruleToCron(normalizeRule(workdays))).toBe("0 9 * * 1-5");
    expect(ruleToCron(normalizeRule({ freq: "daily", times: ["08:00", "18:00"], timezone: "UTC" }))).toBe(
      "0 8,18 * * *",
    );
    expect(cronToRule("*/15 * * * *", "UTC")).toBeNull();
    expect(() => normalizeRule({ freq: "daily", times: ["25:00"], timezone: "UTC" })).toThrow();
    expect(() => normalizeRule({ freq: "weekly", byWeekday: ["2TU"], timezone: "UTC" })).toThrow();
  });

  test("the model's fields become rules (what cron can't say, too); bad fields make none", () => {
    const none: RecurrenceFields = {
      kind: "recurring",
      freq: "none",
      interval: 1,
      every_minutes: 0,
      weekdays: [],
      weekday_position: 0,
      month_days: [],
      months: [],
      set_position: 0,
      times: [],
      until: "",
      count: 0,
      local_date_time: "",
    };
    const read = (fields: Partial<RecurrenceFields>) => {
      const r = recurrenceFromFields({ ...none, ...fields }, SP);
      return r?.type === "rule" ? r.rule : r;
    };
    // "a cada 2 semanas na segunda e quarta às 9h", in any language.
    expect(read({ freq: "weekly", interval: 2, weekdays: ["MO", "WE"], times: [{ hour: 9, minute: 0 }] })).toEqual({
      freq: "weekly",
      interval: 2,
      byWeekday: ["MO", "WE"],
      times: ["09:00"],
      timezone: SP,
    });
    // "último dia útil do mês às 18h".
    const lastBusiness = read({
      freq: "monthly",
      weekdays: ["MO", "TU", "WE", "TH", "FR"],
      set_position: -1,
      times: [{ hour: 18, minute: 0 }],
    }) as ScheduleRule;
    expect(lastBusiness).toMatchObject({ freq: "monthly", bySetPos: [-1], times: ["18:00"] });
    expect(describeRule(normalizeRule(lastBusiness))).toBe(
      "Every month, on the last business day, at 18:00 (Brasília time)",
    );
    // "2ª terça do mês às 10h": the position goes on the weekday; weekly rules don't take one.
    expect(
      read({ freq: "monthly", weekdays: ["TU"], weekday_position: 2, times: [{ hour: 10, minute: 0 }] }),
    ).toMatchObject({ freq: "monthly", byWeekday: ["2TU"] });
    expect(read({ freq: "weekly", weekdays: ["TU"], weekday_position: 2 })).toMatchObject({ byWeekday: ["TU"] });
    // "todo dia às 8h até 31/12", "10 vezes"; hourly keeps only the minute.
    expect(read({ freq: "daily", times: [{ hour: 8, minute: 0 }], until: "2026-12-31", count: 10 })).toMatchObject({
      freq: "daily",
      times: ["08:00"],
      until: "2026-12-31",
      count: 10,
    });
    expect(read({ freq: "hourly", times: [{ hour: 14, minute: 30 }] })).toMatchObject({ times: ["00:30"] });
    expect(recurrenceFromFields({ ...none, every_minutes: 15 }, SP)).toEqual({ type: "minutes", every: 15 });
    expect(recurrenceFromFields({ ...none, kind: "once", local_date_time: "2026-10-16T09:00" }, SP)).toEqual({
      type: "once",
      localDateTime: "2026-10-16T09:00",
    });
    // Out of range or not a schedule: no rule.
    expect(read({ freq: "daily", times: [{ hour: 24, minute: 0 }] })).toBeNull();
    expect(read({ freq: "monthly", month_days: [32] })).toBeNull();
    expect(read({ freq: "daily", interval: 0 })).toMatchObject({ interval: 1 });
    expect(read({ freq: "daily", interval: 5000 })).toBeNull();
    expect(read({ freq: "daily", until: "31/12" })).toBeNull();
    expect(read({ freq: "none" })).toBeNull();
    expect(read({ every_minutes: 90 })).toBeNull();
    expect(read({ kind: "once", local_date_time: "amanhã" })).toBeNull();
    expect(read({ kind: "unreadable" })).toBeNull();
  });
});
