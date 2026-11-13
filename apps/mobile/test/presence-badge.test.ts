import { describe, expect, test } from "bun:test";
import { badgeCells } from "@agenteschat/ui/presence/badge";
import { badgeCell, badgeFills, badgeOverhang, badgePaths } from "../src/ui/presence-badge";

/** The cells a path covers ("x,y"), read back from its runs (`M{x} {y}h{w}v1h-{w}z`). */
function covered(d: string): string[] {
  const cells: string[] = [];
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < w; i++) cells.push(`${x + i},${y}`);
  }
  return cells;
}

const layer = (paths: { tone: string; d: string }[], tone: string) => paths.find((p) => p.tone === tone)?.d ?? "";
const cellsOf = (presence: Parameters<typeof badgeCells>[0], ring: boolean, tones: string[]) =>
  badgeCells(presence, ring)
    .cells.filter((c) => tones.includes(c.tone))
    .map((c) => `${c.x},${c.y}`)
    .sort();

describe("the presence badge on the phone (ADR 0084)", () => {
  test("the ring lies under the whole badge, the base under every cell of its shape", () => {
    const { size, paths } = badgePaths("online", true);
    expect(size).toBe(11);
    expect(paths.map((p) => p.tone)).toEqual(["ring", "base", "light", "deep"]);
    expect(covered(layer(paths, "ring")).sort()).toEqual(cellsOf("online", true, ["ring", "base", "light", "deep"]));
    expect(covered(layer(paths, "base")).sort()).toEqual(cellsOf("online", true, ["base", "light", "deep"]));
    expect(covered(layer(paths, "light")).sort()).toEqual(cellsOf("online", true, ["light"]));
  });

  test("busy and away carry the white mark: a bar, a clock", () => {
    for (const presence of ["busy", "away"] as const) {
      const { paths } = badgePaths(presence);
      expect(covered(layer(paths, "mark")).sort()).toEqual(cellsOf(presence, true, ["mark"]));
      expect(covered(layer(paths, "mark"))).toHaveLength(5);
    }
    expect(layer(badgePaths("online").paths, "mark")).toBe("");
  });

  test("offline is an empty outline; without a ring nothing is drawn inside it", () => {
    const { size, paths } = badgePaths("offline", false);
    expect(size).toBe(9);
    expect(paths.some((p) => p.tone === "ring")).toBe(false);
    const drawn = covered(layer(paths, "base"));
    expect(drawn).not.toContain("4,4");
    expect(drawn).toContain("1,0");
    // Hidden is dotted: fewer cells than offline's outline.
    expect(covered(layer(badgePaths("hidden", false).paths, "base")).length).toBeLessThan(drawn.length);
  });

  test("runs stay inside the badge and never cover a cell twice in a layer", () => {
    for (const presence of ["online", "away", "busy", "offline", "hidden"] as const) {
      for (const ring of [true, false]) {
        const { size, paths } = badgePaths(presence, ring);
        for (const p of paths) {
          const cells = covered(p.d);
          expect(new Set(cells).size).toBe(cells.length);
          for (const c of cells) {
            const [x, y] = c.split(",").map(Number);
            expect(x).toBeLessThan(size);
            expect(y).toBeLessThan(size);
          }
        }
      }
    }
  });

  test("colors: the mark is white, the ring is the surface's, light and dark themes differ", () => {
    const light = badgeFills("busy", false, "#ffffff");
    const dark = badgeFills("busy", true, "#0f0f0e");
    expect(light.mark).toBe("#ffffff");
    expect(light.ring).toBe("#ffffff");
    expect(dark.ring).toBe("#0f0f0e");
    expect(light.base).not.toBe(dark.base);
    expect(new Set([light.base, light.light, light.deep]).size).toBe(3);
  });

  test("small faces get small cells, profiles big ones", () => {
    expect(badgeCell(26)).toBe(0.9);
    expect(badgeCell(44)).toBe(1.1);
    expect(badgeCell(52)).toBe(1.1);
    expect(badgeCell(104)).toBe(1.6);
    expect(badgeOverhang(1.1)).toBe(3);
  });
});
