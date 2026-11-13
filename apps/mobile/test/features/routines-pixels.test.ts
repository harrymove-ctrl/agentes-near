import { describe, expect, test } from "bun:test";
import { AGENT_GRADIENTS } from "@agenteschat/ui/agent/engine";
import {
  LANE_BASE,
  laneCells,
  laneWidth,
  laneX,
  type RunPixel,
  SPRITE,
  STRIP_ROWS,
  spriteCells,
  spritePose,
  spriteX,
  stripCells,
  stripWidth,
} from "../../src/features/routines/run-pixels";

const tones = { raised: "#ffffff", danger: "#b42a20", warn: "#9a5b00", dot: "#cfcfc9" };
type Runs = { color: string; cells: number[] }[];
const count = (runs: Runs) => runs.reduce((n, r) => n + r.cells.length / 2, 0);
const cellsOf = (runs: Runs, color: string) =>
  runs.filter((r) => r.color === color).reduce((n, r) => n + r.cells.length / 2, 0);
const xsOf = (runs: Runs, keep: (color: string) => boolean) =>
  runs.filter((r) => keep(r.color)).flatMap((r) => r.cells.filter((_, i) => i % 2 === 0));
const inside = (runs: Runs, w: number, h: number) =>
  runs.every((r) => r.cells.every((v, i) => v >= 0 && v < (i % 2 === 0 ? w : h)));

const AT = "2026-10-28T12:00:00.000Z";
const px = (status: RunPixel["status"], weight?: number): RunPixel =>
  weight === undefined ? { status, at: AT } : { status, weight, at: AT };
const SLOTS = 14;
const W = stripWidth(SLOTS);

describe("a routine's last runs as a pixel strip (the web's RunStrip as cells)", () => {
  test("14 slots of 3 cells and a gap: 55 cells wide, 10 rows; no runs is a dotted line", () => {
    expect(W).toBe(55);
    const runs = stripCells([], "sky", tones, { slots: SLOTS });
    expect(count(runs)).toBe(14);
    expect(cellsOf(runs, tones.dot)).toBe(14);
    expect(inside(runs, W, STRIP_ROWS)).toBe(true);
  });

  test("a run that told people is as tall as its cost; nothing new a stub; a failure the whole column", () => {
    expect(count(stripCells([px("ok", 1)], "violet", tones, { slots: SLOTS }))).toBe(13 + 3 * 10);
    expect(count(stripCells([px("ok", 0)], "violet", tones, { slots: SLOTS }))).toBe(13 + 3 * 4);
    expect(count(stripCells([px("ok")], "violet", tones, { slots: SLOTS }))).toBe(13 + 3 * 10);
    expect(count(stripCells([px("silent")], "violet", tones, { slots: SLOTS }))).toBe(13 + 3 * 2);
    const failed = stripCells([px("failed")], "violet", tones, { slots: SLOTS });
    expect(cellsOf(failed, tones.danger)).toBeGreaterThan(0);
    expect(count(failed)).toBe(13 + 3 * 10);
    const skipped = stripCells([px("skipped")], "violet", tones, { slots: SLOTS });
    expect(cellsOf(skipped, tones.warn)).toBeGreaterThan(0);
    expect(count(skipped)).toBe(13 + 3 * 4);
    // The agent's own tones never draw a failure, and a failure never takes them.
    expect(cellsOf(stripCells([px("ok")], "violet", tones, { slots: SLOTS }), tones.danger)).toBe(0);
  });

  test("newest on the right; only the last 14 fit", () => {
    const runs = stripCells([px("failed"), px("ok")], "green", tones, { slots: SLOTS });
    expect(Math.min(...xsOf(runs, (c) => c === tones.danger))).toBe(52);
    const full = stripCells(
      Array.from({ length: 20 }, () => px("ok", 1)),
      "green",
      tones,
      { slots: SLOTS },
    );
    expect(count(full)).toBe(14 * 30);
    expect(cellsOf(full, tones.dot)).toBe(0);
    expect(inside(full, W, STRIP_ROWS)).toBe(true);
  });

  test("a run at work flickers in the newest slot, in the sky's light", () => {
    const working = stripCells([], "sky", tones, { slots: SLOTS, running: true, t: 0 });
    expect(cellsOf(working, tones.dot)).toBe(13);
    // At t = 0 the column is 7 cells tall, 5 of its 21 cells left out by the flicker.
    expect(count(working)).toBe(13 + 16);
    const sky = new Set<string>(AGENT_GRADIENTS.sky);
    expect(Math.min(...xsOf(working, (c) => c !== tones.dot))).toBe(52);
    expect(working.some((r) => sky.has(r.color))).toBe(true);
    const withOne = stripCells([px("ok", 1)], "sky", tones, { slots: SLOTS, running: true, t: 0 });
    expect(count(withOne)).toBe(12 + 30 + 16);
    expect(inside(withOne, W, STRIP_ROWS)).toBe(true);
  });
});

describe("a routine's lane on the horizon (the web's RunLane as cells)", () => {
  const from = new Date(0);
  const to = new Date(1000);
  const iso = (ms: number) => new Date(ms).toISOString();

  test("its width in 2-point cells, and where an instant falls", () => {
    expect(laneWidth(300)).toBe(150);
    expect(laneWidth(10)).toBe(10);
    expect(laneX(new Date(500), from, to, 11)).toBe(5);
    expect(laneX(to, from, to, 11)).toBe(10);
  });

  test("a dotted line; the coming runs as pixels, the next one left to the agent", () => {
    const empty = laneCells(20, from, to, [], [], "sky", tones, false);
    expect(count(empty)).toBe(10);
    expect(cellsOf(empty, tones.dot)).toBe(10);
    const future = [iso(400), iso(800)];
    const waiting = laneCells(20, from, to, [], future, "sky", tones, false);
    expect(count(waiting)).toBe(11);
    // While it runs the agent stands at "now": every coming run is a pixel.
    expect(count(laneCells(20, from, to, [], future, "sky", tones, true))).toBe(12);
    expect(inside(waiting, 20, 15)).toBe(true);
  });

  test("a past run is a small column on the line", () => {
    const lane = laneCells(20, from, to, [{ status: "ok", weight: 1, at: iso(500) }], [], "amber", tones, false);
    expect(count(lane)).toBe(10 + 2 * 8);
    const xs = xsOf(lane, (c) => c !== tones.dot);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([9, 10]);
    expect(lane.every((r) => r.cells.every((v, i) => i % 2 === 0 || v <= LANE_BASE + 1))).toBe(true);
  });

  test("the agent stands on its next run, never on top of now; at now while it runs", () => {
    const end = new Date(100);
    expect(spriteX(101, from, end, new Date(50), [], true)).toBe(56);
    expect(spriteX(101, from, end, new Date(50), [iso(80)], false)).toBe(80);
    expect(spriteX(101, from, end, new Date(50), [iso(52)], false)).toBe(56);
    expect(spriteX(101, from, end, new Date(50), [], false)).toBeNull();
  });

  test("it hops and blinks now and then; still with reduced motion, and no hop while it runs", () => {
    const look = { color: "sky", eyes: "round" };
    // Its seed is 8 (the lengths of "sky" and "round"): a hop when (1.3t + 8) mod 3 < 0.35, a blink when
    // (t + 5.6) mod 4.2 < 0.14.
    const hop = 1.1 / 1.3;
    const blink = 2.85;
    expect(spritePose(0, look, false, false)).toEqual({ hop: 0, blink: false });
    expect(spritePose(blink, look, false, false).blink).toBe(true);
    expect(spritePose(hop, look, false, false).hop).toBe(1);
    expect(spritePose(hop, look, true, false).hop).toBe(0);
    expect(spritePose(blink, look, false, true)).toEqual({ hop: 0, blink: false });
  });

  test("the sprite: 9 cells a side, white eyes that close on a blink", () => {
    const open = spriteCells("sky", "round", false, false);
    expect(inside(open, SPRITE, SPRITE)).toBe(true);
    expect(cellsOf(open, "#ffffff")).toBeGreaterThan(0);
    expect(cellsOf(spriteCells("sky", "round", false, true), "#ffffff")).toBe(0);
  });
});
