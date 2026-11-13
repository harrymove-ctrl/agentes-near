import { describe, expect, test } from "bun:test";
import { nextOccurrences, type RecurrenceRule } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { createI18n } from "@/i18n";
import { fromApiRule, ruleSentence, toApiRule, upcomingLabels } from "@/lib/recurrence";

const i18n = createI18n("pt-BR");
const t = i18n.t.bind(i18n) as TFunction;
const SP = "America/Sao_Paulo";
const base: RecurrenceRule = { freq: "weekly", interval: 1, times: ["09:00"], timezone: SP, start: "2026-10-12" };
/** São Paulo local times of the next occurrences ("2026-10-14 09:00"). */
const local = (rule: RecurrenceRule, from = "2026-10-12T00:00:00-03:00", n = 3) =>
  nextOccurrences(rule, new Date(from), n).map((d) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone: SP,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d),
  );

describe("next occurrences", () => {
  test("every 2 weeks on Monday and Wednesday at 09:00", () => {
    expect(local({ ...base, interval: 2, byWeekday: ["MO", "WE"] }, undefined, 4)).toEqual([
      "2026-10-12 09:00",
      "2026-10-14 09:00",
      "2026-10-26 09:00",
      "2026-10-28 09:00",
    ]);
  });

  test("business days only, two times a day", () => {
    expect(
      local(
        { ...base, freq: "daily", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["18:00", "08:30"] },
        "2026-10-16T12:00:00-03:00",
      ),
    ).toEqual(["2026-10-16 18:00", "2026-10-19 08:30", "2026-10-19 18:00"]);
  });

  test("monthly: the 2nd Tuesday; the last business day; day 31 in a short month", () => {
    expect(local({ ...base, freq: "monthly", byWeekday: ["TU"], bySetPos: 2 }, undefined, 2)).toEqual([
      "2026-10-13 09:00",
      "2026-11-10 09:00",
    ]);
    expect(
      local({ ...base, freq: "monthly", byWeekday: ["MO", "TU", "WE", "TH", "FR"], bySetPos: -1 }, undefined, 2),
    ).toEqual(["2026-10-30 09:00", "2026-11-30 09:00"]);
    expect(local({ ...base, freq: "monthly", byMonthDay: [31], start: "2026-10-01" }, undefined, 2)).toEqual([
      "2026-10-31 09:00",
      "2026-11-30 09:00",
    ]);
  });

  test("until and count end the series; once is a single day", () => {
    expect(local({ ...base, freq: "daily", until: "2026-10-13" }, undefined, 5)).toEqual([
      "2026-10-12 09:00",
      "2026-10-13 09:00",
    ]);
    expect(local({ ...base, freq: "daily", count: 2 }, "2026-10-13T00:00:00-03:00", 5)).toEqual(["2026-10-13 09:00"]);
    expect(local({ ...base, freq: "once", start: "2026-10-20" }, undefined, 5)).toEqual(["2026-10-20 09:00"]);
  });

  test("every 6 hours from 06:00", () => {
    expect(local({ ...base, freq: "hourly", interval: 6, times: ["06:00"] }, "2026-10-12T07:00:00-03:00", 3)).toEqual([
      "2026-10-12 12:00",
      "2026-10-12 18:00",
      "2026-10-13 06:00",
    ]);
  });
});

describe("rule ⇄ sentence ⇄ API", () => {
  const now = new Date(2026, 9, 15);
  test("the live sentence", () => {
    expect(ruleSentence(t, "pt-BR", { ...base, interval: 2, byWeekday: ["MO", "WE"], until: "2026-12-31" }, now)).toBe(
      "A cada 2 semanas, seg e qua, às 09:00 (horário de Brasília), até 31/12",
    );
    expect(
      ruleSentence(
        t,
        "pt-BR",
        { ...base, freq: "daily", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["18:00"] },
        now,
      ),
    ).toBe("De segunda a sexta, às 18:00 (horário de Brasília)");
    expect(ruleSentence(t, "pt-BR", { ...base, freq: "monthly", byWeekday: ["TU"], bySetPos: 2 }, now)).toBe(
      "Todo mês na 2ª terça-feira, às 09:00 (horário de Brasília)",
    );
    expect(ruleSentence(t, "pt-BR", { ...base, freq: "daily", count: 10 }, now)).toBe(
      "Todos os dias, às 09:00 (horário de Brasília), 10 vezes",
    );
  });

  test("picker → API rule → picker gives the same rule (the rule is what's sent, never a phrase)", () => {
    const rules: RecurrenceRule[] = [
      { ...base, interval: 2, byWeekday: ["MO", "WE"] },
      { ...base, freq: "daily", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["08:30"] },
      { ...base, freq: "monthly", byMonthDay: [15] },
      { ...base, freq: "monthly", byWeekday: ["TU"], bySetPos: 2 },
      { ...base, freq: "daily", interval: 3 },
    ];
    for (const r of rules) expect(toApiRule(fromApiRule(toApiRule(r), base.start))).toEqual(toApiRule(r));
  });

  test("the API's positions (2TU, -1FR) and byMonth", () => {
    const nth = fromApiRule({ freq: "monthly", byWeekday: ["2TU"], times: ["09:00"], timezone: SP }, "2026-10-01");
    expect(nth).toMatchObject({ byWeekday: ["TU"], bySetPos: 2, start: "2026-10-01" });
    expect(toApiRule(nth).byWeekday).toEqual(["2TU"]);
    expect(toApiRule({ ...base, freq: "yearly", start: "2026-03-15" })).toMatchObject({
      byMonth: [3],
      byMonthDay: [15],
    });
  });

  test("next occurrences are formatted in the rule's zone", () => {
    expect(upcomingLabels("pt-BR", { ...base, freq: "daily" }, new Date("2026-10-12T10:00:00-03:00"), 2)).toEqual([
      "ter, 13 out · 09:00",
      "qua, 14 out · 09:00",
    ]);
  });
});
