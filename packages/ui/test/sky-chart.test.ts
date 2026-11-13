import { describe, expect, test } from "bun:test";
import {
  areaCells,
  barCells,
  cellPaths,
  chartRamp,
  linePoints,
  lineTops,
  ringCells,
  smoothPath,
} from "../src/sky/chart";

describe("chart cells (C · Traço + trama)", () => {
  test("a bar is light at its start and deeper at its tip; the lead bar runs deeper", () => {
    const lead = barCells(40, 6, true);
    const other = barCells(40, 6, false);
    const avg = (cells: Uint8Array, from: number, to: number) => {
      let sum = 0;
      for (let y = 0; y < 6; y++) for (let x = from; x < to; x++) sum += cells[y * 40 + x] ?? 0;
      return sum / (6 * (to - from));
    };
    expect(avg(lead, 0, 8)).toBeLessThan(avg(lead, 32, 40));
    expect(avg(other, 32, 40)).toBeLessThan(avg(lead, 32, 40));
    expect(Math.max(...lead)).toBeLessThan(chartRamp("amber").length);
  });

  test("the area starts under the line and thins out going down", () => {
    const cells = areaCells(10, 20, Array(10).fill(2));
    for (let x = 0; x < 10; x++) expect(cells[3 * 10 + x]).toBe(0);
    const row = (y: number) => Array.from({ length: 10 }, (_, x) => cells[y * 10 + x]).filter((v) => v !== 0).length;
    expect(row(5)).toBeGreaterThan(row(19));
  });

  test("a ring is empty in the middle and swept clockwise from the top", () => {
    const full = ringCells(40, [0.5, 0.5]);
    expect(full[20 * 40 + 20]).toBe(-1);
    expect(full[2 * 40 + 24]).not.toBe(-1);
    const half = ringCells(40, [0.5, 0.5], 0.25);
    expect(half[20 * 40 + 1]).toBe(-1); // the left side comes last
  });

  test("points span the box; the path starts at the first one", () => {
    const pts = linePoints([1, 3, 2], 100, 50);
    expect(pts[0]?.[0]).toBe(8);
    expect(pts[2]?.[0]).toBe(92);
    expect(pts[1]?.[1]).toBeLessThan(pts[0]?.[1] ?? 0);
    expect(smoothPath(pts).startsWith("M8,")).toBe(true);
  });

  test("the line's tops follow the curve between its points", () => {
    const pts = linePoints([1, 3, 2], 100, 50);
    const tops = lineTops(pts, 50);
    expect(tops[4]).toBeCloseTo((pts[0]?.[1] ?? 0) / 2, 0);
    expect(tops[25]).toBeCloseTo((pts[1]?.[1] ?? 0) / 2, 0);
    expect(Number.isNaN(tops[0] as number)).toBe(true);
  });

  test("cells become one rectangle per run", () => {
    const paths = cellPaths([1, 1, 0, 2, -1, -1], 3, 2, 2, true);
    expect(paths.get(1)).toBe("M0 0h4v2h-4Z");
    expect(paths.get(2)).toBe("M0 2h2v2h-2Z");
    expect(paths.has(0)).toBe(false);
  });
});
