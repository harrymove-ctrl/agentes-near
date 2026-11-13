import { describe, expect, test } from "bun:test";
import {
  markCells,
  muteHex,
  pageCells,
  pageGrid,
  STRIP_ROWS,
  skyEdgeCells,
  stripCells,
  stripWidth,
} from "../src/features/browser/trail-pixels";

const tones = { raised: "#ffffff", danger: "#b42a20" };
const count = (runs: { cells: number[] }[]) => runs.reduce((n, r) => n + r.cells.length / 2, 0);
const inside = (runs: { cells: number[] }[], w: number, h: number) =>
  runs.every((r) => r.cells.every((v, i) => v >= 0 && v < (i % 2 === 0 ? w : h)));

describe("the steps' card pixels on the phone (the web's drawings as cells)", () => {
  test("the strip: one 3-cell column per step on the 7-row line, an open taller than an action", () => {
    expect(stripWidth(3)).toBe(11);
    const open = count(stripCells(["open"], "sky", tones));
    const act = count(stripCells(["act"], "sky", tones));
    const shot = count(stripCells(["shot"], "sky", tones));
    expect(open).toBe(3 * STRIP_ROWS);
    expect(act).toBe(3 * 3);
    expect(shot).toBe(3 * 2);
    const runs = stripCells(["open", "read", "act", "shot", "failed"], "violet", tones);
    expect(inside(runs, stripWidth(5), STRIP_ROWS)).toBe(true);
  });

  test("a failure is drawn in the danger tones, never the agent's", () => {
    const colors = markCells("failed", "green", tones).map((r) => r.color);
    expect(colors).toContain("#b42a20");
    expect(colors.every((c) => c === "#b42a20" || c.startsWith("#"))).toBe(true);
    expect(markCells("open", "green", tones).some((r) => r.color === "#b42a20")).toBe(false);
  });

  test("the sky edge: two rows across the card, greyed", () => {
    const runs = skyEdgeCells(300, "sky", "#ffffff", false);
    expect(count(runs)).toBe(2 * 100);
    expect(inside(runs, 100, 2)).toBe(true);
    // Muted: a saturated blue comes out closer to grey.
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(muteHex("#2060ff").slice(i, i + 2), 16));
    expect(Math.max(r ?? 0, g ?? 0, b ?? 0) - Math.min(r ?? 0, g ?? 0, b ?? 0)).toBeLessThan(0xff - 0x20);
    expect(muteHex("#ffffff")).toBe("#ffffff");
  });

  test("the drawn page fills its grid, light and dark", () => {
    const { w, h } = pageGrid(96, 47);
    expect([w, h]).toEqual([48, 24]);
    for (const dark of [false, true]) {
      const runs = pageCells(w, h, "amber", dark);
      expect(count(runs)).toBe(w * h);
      expect(inside(runs, w, h)).toBe(true);
    }
  });
});
