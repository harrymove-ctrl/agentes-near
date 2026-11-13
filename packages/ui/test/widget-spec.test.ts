import { describe, expect, test } from "bun:test";
import {
  chartBlocksOf,
  chartBlockToWidgetSpec,
  clipText,
  defaultSize,
  type ExampleWords,
  exampleWidgetSpec,
  layoutToSize,
  nextSize,
  phoneSpan,
  scheduleRunsPerDay,
  sizeToLayout,
  specHeadline,
  splitDelta,
  validateWidgetSpec,
  WIDGET_KINDS,
  WIDGET_LIMITS,
  WIDGET_SCHEDULE_CRON,
  widgetSpecOf,
} from "../src/widgets/spec";

describe("validateWidgetSpec", () => {
  test("keeps a kpi's fields, trimmed, and drops what it doesn't know", () => {
    const out = validateWidgetSpec({
      kind: "kpi",
      value: 18420,
      prefix: " R$ ",
      delta: { text: "+12%", up: true },
      note: "vs. yesterday  so far",
      spark: [2, 3, 5],
      color: "red",
    });
    expect(out).toEqual({
      ok: true,
      spec: {
        kind: "kpi",
        value: 18420,
        prefix: "R$",
        delta: { text: "+12%", up: true },
        note: "vs. yesterday so far",
        spark: [2, 3, 5],
      },
    });
  });

  test("refuses what can't be drawn honestly", () => {
    expect(validateWidgetSpec(null).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "pie" }).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "kpi", value: "12" }).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "kpi", value: Number.NaN }).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "kpi", value: 1, delta: { text: "+1" } }).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "bars", labels: ["a", "b"], values: [1] }).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "line", labels: ["a"], values: [1] }).ok).toBe(false);
    const many = Array.from({ length: WIDGET_LIMITS.points + 1 }, (_, i) => i);
    expect(validateWidgetSpec({ kind: "bars", labels: many.map(String), values: many }).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "list", rows: [] }).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "text", items: ["a", 3, null] }).ok).toBe(false);
    expect(validateWidgetSpec({ kind: "goal", pct: 40 }).ok).toBe(false);
  });

  test("a goal's share stays between 0 and 100", () => {
    expect(widgetSpecOf({ kind: "goal", pct: 140, line: "140 of 100" })).toEqual({
      kind: "goal",
      pct: 100,
      line: "140 of 100",
    });
    expect(widgetSpecOf({ kind: "goal", pct: -3, line: "x" })).toEqual({ kind: "goal", pct: 0, line: "x" });
  });

  test("bars keep a valid alert index only; list rows keep their tone", () => {
    expect(widgetSpecOf({ kind: "bars", labels: ["a", "b"], values: [1, 2], alertIndex: 1 })).toEqual({
      kind: "bars",
      labels: ["a", "b"],
      values: [1, 2],
      alertIndex: 1,
    });
    expect(widgetSpecOf({ kind: "bars", labels: ["a"], values: [1], alertIndex: 4 })).toEqual({
      kind: "bars",
      labels: ["a"],
      values: [1],
    });
    expect(
      widgetSpecOf({
        kind: "list",
        rows: [{ text: "Order 4371", meta: "3 days", tone: "warn" }, { text: "Order 4402", tone: "x" }, "Order 4410"],
      }),
    ).toEqual({
      kind: "list",
      rows: [{ text: "Order 4371", meta: "3 days", tone: "warn" }, { text: "Order 4402" }, { text: "Order 4410" }],
    });
  });

  test("text is cut to its limit", () => {
    const long = "x".repeat(WIDGET_LIMITS.item + 50);
    const spec = widgetSpecOf({ kind: "text", items: [long] });
    expect(spec?.kind === "text" && spec.items[0]?.length).toBe(WIDGET_LIMITS.item);
  });
});

describe("chart blocks", () => {
  test("a number chart becomes a kpi with its unit and delta split", () => {
    const out = chartBlockToWidgetSpec(
      JSON.stringify({
        type: "number",
        title: "Sales today",
        unit: "R$",
        value: 18420,
        delta: "+12% vs. yesterday",
        labels: ["9h", "10h", "11h"],
        series: [{ name: "Sales", values: [3, 7, 11] }],
      }),
    );
    expect(out).toEqual({
      title: "Sales today",
      spec: {
        kind: "kpi",
        value: 18420,
        prefix: "R$",
        delta: { text: "+12%", up: true },
        note: "vs. yesterday",
        spark: [3, 7, 11],
      },
    });
  });

  test("a percent stays after the number; a minus reads as down", () => {
    const out = chartBlockToWidgetSpec({ type: "kpi", title: "Conversion", unit: "%", value: 6.7, delta: "−0,8 pp" });
    expect(out?.spec).toEqual({ kind: "kpi", value: 6.7, suffix: "%", delta: { text: "−0,8 pp", up: false } });
  });

  test("bar and pie become bars, line stays a line, with the first series", () => {
    const bar = chartBlockToWidgetSpec({
      type: "bar",
      title: "Orders by channel",
      subtitle: "This week",
      labels: ["Site", "App"],
      series: [
        { name: "Orders", values: [41, 26] },
        { name: "Returns", values: [2, 1] },
      ],
    });
    expect(bar).toEqual({
      title: "Orders by channel",
      spec: { kind: "bars", labels: ["Site", "App"], values: [41, 26], note: "This week" },
    });
    const pie = chartBlockToWidgetSpec({ type: "pie", title: "Share", labels: ["a"], series: [{ values: [1] }] });
    expect(pie?.spec.kind).toBe("bars");
    const line = chartBlockToWidgetSpec({
      type: "line",
      title: "Visits",
      unit: "ms",
      labels: ["mon", "tue"],
      series: [{ name: "v", values: [1, 2] }],
    });
    expect(line?.spec).toEqual({ kind: "line", labels: ["mon", "tue"], values: [1, 2], unit: "ms" });
  });

  test("anything else is not a widget", () => {
    expect(chartBlockToWidgetSpec("{not json")).toBeNull();
    expect(chartBlockToWidgetSpec({ type: "bar", labels: ["a"], series: [{ values: [1] }] })).toBeNull();
    expect(chartBlockToWidgetSpec({ type: "scatter", title: "x" })).toBeNull();
    expect(chartBlockToWidgetSpec({ type: "number", title: "x" })).toBeNull();
  });

  test("finds every chart fence of a message, in order", () => {
    const body = 'Here:\n```chart\n{"type":"bar"}\n```\ntext\n```json\n{}\n```\n```chart\n{"type":"line"}\n```';
    expect(chartBlocksOf(body)).toEqual(['{"type":"bar"}', '{"type":"line"}']);
    expect(chartBlocksOf("no charts")).toEqual([]);
  });

  test("splitDelta keeps the words after the move as its note", () => {
    expect(splitDelta("+0,8 pp vs last week")).toEqual({ text: "+0,8 pp", up: true, note: "vs last week" });
    expect(splitDelta("-3 since 9am")).toEqual({ text: "-3", up: false, note: "since 9am" });
    expect(splitDelta("best day of the year")).toEqual({ text: "best day of the year", up: true });
  });
});

describe("schedules and sizes", () => {
  test("runs a day", () => {
    expect(scheduleRunsPerDay("half")).toBe(48);
    expect(scheduleRunsPerDay("hour")).toBe(24);
    expect(scheduleRunsPerDay("day")).toBe(1);
    expect(scheduleRunsPerDay("week")).toBeCloseTo(1 / 7);
    expect(scheduleRunsPerDay("manual")).toBe(0);
  });

  test("every schedule but manual has a cron, never more often than every 30 minutes", () => {
    expect(Object.keys(WIDGET_SCHEDULE_CRON).sort()).toEqual(["day", "half", "hour", "week"]);
    expect(WIDGET_SCHEDULE_CRON.half).toBe("*/30 * * * *");
  });

  test("S, M and L map to the board and back", () => {
    expect(sizeToLayout("s")).toEqual({ w: 1, h: 1 });
    expect(sizeToLayout("m")).toEqual({ w: 2, h: 1 });
    expect(sizeToLayout("l")).toEqual({ w: 2, h: 2 });
    for (const size of ["s", "m", "l"] as const) expect(layoutToSize(sizeToLayout(size))).toBe(size);
    expect(layoutToSize({ w: 1, h: 2 })).toBe("s");
    expect(nextSize("s")).toBe("m");
    expect(nextSize("l")).toBe("s");
    expect(defaultSize("kpi")).toBe("s");
    expect(defaultSize("line")).toBe("m");
    expect(defaultSize(null)).toBe("m");
    expect(phoneSpan(2)).toBe(2);
    expect(phoneSpan(1)).toBe(1);
  });
});

describe("examples", () => {
  const words: ExampleWords = {
    days: ["wed", "thu", "fri", "sat", "sun", "mon", "tue"],
    vsYesterday: "vs. yesterday",
    goalLine: "48 of 100",
    goalNote: "At this pace, it's hit on the 29th.",
    lineNote: "40 yesterday",
    rows: ["First item", "Second item", "Third item"],
    rowMeta: ["now", "1 h ago", "yesterday"],
    items: ["A short summary.", "Written again on every update."],
  };

  test("every kind has a valid example", () => {
    for (const kind of WIDGET_KINDS) {
      const spec = exampleWidgetSpec(kind, words);
      expect(spec.kind).toBe(kind);
      expect(validateWidgetSpec(spec)).toEqual({ ok: true, spec });
      expect(specHeadline(spec).length).toBeGreaterThan(0);
    }
  });

  test("a headline says the main figure", () => {
    expect(specHeadline({ kind: "kpi", value: 18420, prefix: "R$", delta: { text: "+12%", up: true } })).toBe(
      "R$ 18420 · +12%",
    );
    expect(specHeadline({ kind: "goal", pct: 61.6, line: "R$ 248k of R$ 400k" })).toBe("62% · R$ 248k of R$ 400k");
  });
});

describe("notes and text are never cut mid-word (ADR 0135 §17)", () => {
  const long = `${"visitantes únicos no site ".repeat(6)}(1.012 visitantes)`;

  test("an agent's note longer than one short sentence is refused, so it writes a shorter one", () => {
    expect(long.length).toBeGreaterThan(WIDGET_LIMITS.note);
    for (const kind of ["kpi", "goal", "bars", "line"] as const) {
      const raw = { kind, value: 1, pct: 10, line: "1 of 10", labels: ["a", "b"], values: [1, 2], note: long };
      const out = validateWidgetSpec(raw);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain(`at most ${WIDGET_LIMITS.note} characters`);
    }
    expect(validateWidgetSpec({ kind: "kpi", value: 1, note: "x".repeat(WIDGET_LIMITS.note) }).ok).toBe(true);
  });

  test("data read back, and a chat chart's subtitle, end at a whole word", () => {
    const spec = widgetSpecOf({ kind: "line", labels: ["a", "b"], values: [1, 2], note: long });
    const note = spec?.kind === "line" ? (spec.note ?? "") : "";
    expect(note.length).toBeLessThanOrEqual(WIDGET_LIMITS.note);
    expect(note.endsWith("…")).toBe(true);
    expect(long.startsWith(note.slice(0, -1))).toBe(true);
    expect(long.charAt(note.length - 1)).toBe(" ");
    const chart = chartBlockToWidgetSpec({
      type: "line",
      title: "Visits",
      subtitle: long,
      labels: ["a", "b"],
      series: [{ values: [1, 2] }],
    });
    expect(chart?.spec.kind === "line" && chart.spec.note?.endsWith("…")).toBe(true);
  });

  test("clipText keeps whole words, and cuts inside one only when a single word is too long", () => {
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("one two three four", 12)).toBe("one two…");
    expect(clipText("one two, three", 10)).toBe("one two…");
    expect(clipText("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
    // Never between an emoji's two halves.
    expect(clipText(`${"x".repeat(8)}😀😀`, 10)).toBe(`${"x".repeat(8)}…`);
  });
});
