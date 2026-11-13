import { describe, expect, test } from "bun:test";
import { MONTH_ROWS, monthCells, monthNow, monthWidth } from "../src/features/agents/month-pixels";

const tones = { raised: "#ffffff", danger: "#b42a20", dot: "#cfcfc9" };
const count = (runs: { cells: number[] }[]) => runs.reduce((n, r) => n + r.cells.length / 2, 0);
const cellsOf = (runs: { color: string; cells: number[] }[], color: string) =>
  runs.filter((r) => r.color === color).reduce((n, r) => n + r.cells.length / 2, 0);
const inside = (runs: { cells: number[] }[], w: number) =>
  runs.every((r) => r.cells.every((v, i) => v >= 0 && v < (i % 2 === 0 ? w : MONTH_ROWS)));

describe("the agent's month in pixels on its profile (the web's Atividade drawing as cells)", () => {
  test("the month in UTC, as the server counts its days", () => {
    expect(monthNow(new Date(Date.UTC(2026, 9, 27, 12)))).toEqual({ days: 31, today: 27 });
    expect(monthNow(new Date(Date.UTC(2026, 1, 3, 12)))).toEqual({ days: 28, today: 3 });
  });

  test("at least three cells a day, else the box's width in 2-point cells", () => {
    expect(monthWidth(40, 31)).toBe(93);
    expect(monthWidth(360, 31)).toBe(180);
  });

  test("a quiet month is a dotted line: one dot a day", () => {
    const runs = monthCells(93, 31, 31, [], "sky", tones);
    expect(cellsOf(runs, "#cfcfc9")).toBe(31);
    expect(count(runs)).toBe(31);
    expect(inside(runs, 93)).toBe(true);
  });

  test("the busiest day is the tallest column; days to come stay dots", () => {
    const perDay = [
      { day: 2, runs: 10, failed: 0 },
      { day: 3, runs: 5, failed: 0 },
    ];
    const runs = monthCells(93, 31, 10, perDay, "violet", tones);
    expect(cellsOf(runs, "#cfcfc9")).toBe(29);
    // Three cells a day: columns two wide. Day 2 the full height (rows less five), day 3 half of it.
    const full = MONTH_ROWS - 5;
    expect(count(runs) - 29).toBe(2 * full + 2 * Math.round(full / 2));
    expect(inside(runs, 93)).toBe(true);
    // Seen on the 2nd, the 3rd is still to come: a dot.
    expect(cellsOf(monthCells(93, 31, 2, perDay, "violet", tones), "#cfcfc9")).toBe(30);
  });

  test("a day with a failure wears a cap in the danger tone, never the agent's", () => {
    const runs = monthCells(93, 31, 31, [{ day: 1, runs: 4, failed: 1 }], "green", tones);
    expect(runs.some((r) => r.color === "#b42a20")).toBe(true);
    const fine = monthCells(93, 31, 31, [{ day: 1, runs: 4, failed: 0 }], "green", tones);
    expect(fine.some((r) => r.color === "#b42a20")).toBe(false);
  });
});
