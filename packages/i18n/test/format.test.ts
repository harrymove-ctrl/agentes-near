import { describe, expect, test } from "bun:test";
import { dayMonthOrder, formatList, formatMoneyUsd, formatTime, plural, relativeTime } from "../src/format";

describe("Intl formatting", () => {
  test("lists in each language's own way", () => {
    expect(formatList("ja-JP", ["a", "b", "c"])).toBe("a、b、c");
    expect(formatList("en-US", ["Ada", "Atlas", "Theo"])).toBe("Ada, Atlas, and Theo");
    expect(formatList("pt-BR", ["Ada", "Theo"])).toBe("Ada e Theo");
  });

  test("dollars where each language writes them, more decimals for tiny amounts", () => {
    expect(formatMoneyUsd("de-DE", 0.42)).toBe("0,42 $");
    expect(formatMoneyUsd("en-US", 0.42)).toBe("$0.42");
    expect(formatMoneyUsd("en-US", 0.004)).toBe("$0.004");
    expect(formatMoneyUsd("en-US", 0.0003)).toBe("$0.0003");
  });

  test("day before or after the month", () => {
    expect(dayMonthOrder("en-US")).toBe("md");
    expect(dayMonthOrder("en-GB")).toBe("dm");
    expect(dayMonthOrder("pt-BR")).toBe("dm");
    expect(dayMonthOrder("ja-JP")).toBe("md");
  });

  test("relative times", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(relativeTime("fr-FR", new Date("2026-11-02T11:58:00Z"), now)).toMatch(/^il y a 2\smin$/);
    expect(relativeTime("ru-RU", new Date("2026-11-01T12:00:00Z"), now)).toBe("вчера");
    expect(relativeTime("en-US", new Date("2026-11-02T11:59:50Z"), now)).toBe("now");
    expect(relativeTime("en-US", new Date("2026-11-05T12:00:00Z"), now)).toBe("in 3 days");
  });

  test("plural picks zero, then the language's category", () => {
    const forms = { zero: "none", one: "one", few: "few", many: "many", other: "other" };
    expect(plural("ru", 0, forms)).toBe("none");
    expect(plural("ru", 3, forms)).toBe("few");
    expect(plural("ru", 5, forms)).toBe("many");
    expect(plural("ja", 1, { other: "x" })).toBe("x");
  });

  test("time by the language's clock", () => {
    const d = new Date(2026, 10, 2, 15, 5);
    expect(formatTime("en-US", d)).toMatch(/^3:05\s?PM$/);
    expect(formatTime("de-DE", d)).toBe("15:05");
  });
});
