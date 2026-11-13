import { describe, expect, test } from "bun:test";
import { chartShares, chartTable, formatChartValue, parseChart } from "../src/lib/chart";

const BAR = {
  type: "bar",
  title: "Conversão por gatilho",
  subtitle: "Compras ÷ exibições",
  unit: "%",
  labels: ["first_trip_soft", "generic", "trip_limit"],
  series: [{ name: "Taxa", values: [15, 6.7, 5] }],
};

describe("parseChart", () => {
  test("a valid block becomes a chart", () => {
    expect(parseChart(JSON.stringify(BAR))).toEqual(BAR as never);
  });

  test("anything off is not a chart (the block then shows as code)", () => {
    const bad: unknown[] = [
      "not json",
      "[1,2]",
      { ...BAR, type: "radar" },
      { ...BAR, title: "" },
      { ...BAR, series: [{ name: "Taxa", values: [15, 6.7] }] },
      { ...BAR, series: [{ name: "Taxa", values: [15, "6,7", 5] }] },
      { ...BAR, series: [] },
      {
        ...BAR,
        labels: Array.from({ length: 30 }, (_, i) => `d${i}`),
        series: [{ name: "x", values: Array(30).fill(1) }],
      },
      { ...BAR, type: "pie", series: [{ name: "x", values: [1, -2, 3] }] },
      { type: "number", title: "Taxa geral", labels: [], series: [] },
    ];
    for (const b of bad) expect(parseChart(typeof b === "string" ? b : JSON.stringify(b))).toBeNull();
  });

  test("a number needs a value; its line under it is optional; kpi is an alias", () => {
    const spec = parseChart(
      JSON.stringify({
        type: "kpi",
        title: "Conversão",
        unit: "%",
        value: 5.1,
        delta: "+0,8 pp",
        labels: [],
        series: [],
      }),
    );
    expect(spec).toMatchObject({ type: "number", value: 5.1, delta: "+0,8 pp" });
  });
});

describe("formatting and the table", () => {
  test("units as people read them", () => {
    expect(formatChartValue(6.7, "%", "pt-BR")).toBe("6,7%");
    expect(formatChartValue(1200, "R$", "pt-BR")).toBe("R$ 1.200");
    expect(formatChartValue(120, "ms", "en")).toBe("120 ms");
    expect(formatChartValue(435, undefined, "en")).toBe("435");
  });

  test("a pie's table adds the share", () => {
    const pie = parseChart(
      JSON.stringify({
        type: "pie",
        title: "Compras",
        labels: ["a", "b"],
        series: [{ name: "Compras", values: [3, 1] }],
      }),
    );
    if (!pie) throw new Error("expected a chart");
    expect(chartShares(pie)).toEqual([0.75, 0.25]);
    expect(chartTable(pie, "pt-BR", { item: "Item", share: "Parte" })).toEqual({
      header: ["Item", "Compras", "Parte"],
      rows: [
        ["a", "3", "75%"],
        ["b", "1", "25%"],
      ],
    });
  });
});
