import { describe, expect, test } from "bun:test";
import { AGENT_GRADIENTS, mixHex } from "@agenteschat/ui/agent/engine";
import { phoneField } from "@agenteschat/ui/sky/workspace";
import {
  BAYER,
  barField,
  bayerAt,
  COMPUTER_SPRITES,
  computerSpriteAt,
  computerSpriteBlinks,
  type Field,
  fromSurface,
  fuseField,
  gridOf,
  horizonField,
  MAX_PLAN_ITEMS,
  paletteUniform,
  pillField,
  pillWorkField,
  rgba,
  shaderBayer,
  shaderCell,
  shaderToneIndex,
  skyField,
  statesUniform,
  sweepField,
  trackField,
  webToneIndex,
} from "../src/sky/math";
import { EFFORT_SHADER, shaderSource } from "../src/sky/shaders";

describe("Bayer thresholds", () => {
  test("the shader's formula equals the web's table for every cell", () => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(shaderBayer(x, y)).toBe(bayerAt(x, y));
    expect(BAYER.length).toBe(16);
  });
});

/** Runs the web's loop and the shader's steps over a whole drawing. */
function compare(field: Field, width: number, height: number, pixel: number, tones: number, times: number[]) {
  const { w, h } = gridOf(width, height, pixel);
  let checked = 0;
  for (const t of times)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const web = webToneIndex(field(x / w, y / h, t, x, y), tones, x, y);
        // The shader samples points inside the cell: any point of it must land on the same cell and tone.
        const cell = shaderCell(x * pixel + pixel / 2, y * pixel + pixel / 2, width, height, pixel);
        expect(cell.x).toBe(x);
        expect(cell.y).toBe(y);
        const shader = shaderToneIndex(field(cell.u, cell.v, t, cell.x, cell.y), tones, cell.x, cell.y);
        if (shader !== web) throw new Error(`tone differs at (${x}, ${y}) t=${t}: web ${web}, shader ${shader}`);
        checked++;
      }
  return checked;
}

describe("the shader picks the same tone as the web", () => {
  test("sky", () => {
    expect(compare(skyField, 390, 260, 4, 7, [0, 1.3, 7.9])).toBeGreaterThan(1000);
  });
  test("fuse", () => {
    for (const rem of [0, 0.3, 0.7, 1]) compare(fuseField(rem), 300, 6, 2, 7, [0, 0.5, 2]);
  });
  test("workspace sky", () => {
    expect(compare((u, v, t) => phoneField(u, v, t), 390, 200, 4, 4, [0, 2.1, 9.4])).toBeGreaterThan(1000);
  });
  test("spend bar", () => {
    for (const k of [0, 0.25, 1]) compare(barField(k), 320, 10, 2, 7, [0]);
  });
  test("plan track", () => {
    compare(trackField(["done", "done", "run", "todo", "todo"]), 320, 14, 2, 7, [0, 0.8]);
  });
});

describe("palettes", () => {
  test("fromSurface goes from the surface into the agent's color", () => {
    const tones = fromSurface("#ffffff", 1, "teal");
    const [top, bot] = AGENT_GRADIENTS.teal;
    expect(tones).toHaveLength(7);
    expect(tones[0]).toBe("#ffffff");
    expect(tones[4]).toBe(mixHex("#ffffff", bot, 0.55));
    expect(tones[6]).toBe(mixHex(top, "#ffffff", 0.5));
  });
  test("paletteUniform pads to 8 colors with the last tone", () => {
    const { pal, last } = paletteUniform(["#000000", "#ffffff"]);
    expect(pal).toHaveLength(32);
    expect(last).toBe(1);
    expect(pal.slice(28)).toEqual([1, 1, 1, 1]);
    expect(rgba("#ff8000")).toEqual([1, 128 / 255, 0, 1]);
  });
  test("statesUniform: 2 done, 1 running, 0 to do", () => {
    const s = statesUniform(["done", "run", "todo"]);
    expect(s).toHaveLength(MAX_PLAN_ITEMS);
    expect(s.slice(0, 4)).toEqual([2, 1, 0, 0]);
  });
});

test("every shader declares the uniforms the component passes", () => {
  for (const kind of ["sky", "computer", "fuse", "bar", "track", "sweep", "pill", "horizon", "workspace"] as const) {
    const src = shaderSource(kind);
    for (const u of ["size", "px", "t", "last", "fade", "clear", "pal"])
      expect(src).toMatch(new RegExp(`uniform \\w+ ${u}\\b`));
    expect(src).toContain("half4 main(float2 pos)");
    expect(src).toContain("float field(");
  }
  expect(shaderSource("pill")).toContain("uniform float work;");
  for (const u of ["size", "px", "pos", "steps", "t", "fillTone", "tipTone", "inkTone", "offTone"])
    expect(EFFORT_SHADER).toMatch(new RegExp(`uniform \\w+ ${u}\\b`));
  expect(shaderSource("fuse")).toContain("uniform float remaining;");
  expect(shaderSource("bar")).toContain("uniform float value;");
  expect(shaderSource("track")).toContain("uniform float states[48];");
  expect(shaderSource("horizon")).toContain("uniform float level;");
  // The workspace sky: its hour and the field's last tone, and clouds or stars drawn over it.
  const ws = shaderSource("workspace");
  expect(ws).toContain("uniform float hour;");
  expect(ws).toContain("uniform float top;");
  expect(ws).toContain("float o = overlay(x, y, w, h);");
  expect(ws).toContain("down * (0.6 + 0.3 * u) + 0.05 * sin(u * 5.0 + v * 4.0 + t * 0.5)");
  expect(shaderSource("sky")).not.toContain("overlay(");
});

test("the launch sky: nothing above its level, deepest at the bottom", () => {
  const half = horizonField(0.5);
  expect(half(0.3, 0.2, 0, 0, 0)).toBe(0);
  expect(half(0.3, 1, 0, 0, 0)).toBeGreaterThan(0.9);
  expect(half(0.3, 0.8, 0, 0, 0)).toBeGreaterThan(half(0.3, 0.6, 0, 0, 0));
  // Before it rises (and after it sinks), not even the wave shows.
  for (const u of [0, 0.25, 0.5, 0.75]) expect(horizonField(0)(u, 0.999, 3, 0, 0)).toBe(0);
  expect(shaderSource("horizon")).toContain("v - (1.0 - level) + 0.08 * level * sin(u * 6.0 + t * 1.1)");
});

test("the working line's sweep: a band that crosses left to right every 5 s, over a faint wash", () => {
  // At t = 0 the band's center sits off the left edge (u = -0.3); 2.5 s later it is at u = 0.5.
  expect(sweepField(0.5, 0, 2.5, 0, 0)).toBeCloseTo(0.58, 5);
  expect(sweepField(0.5, 0, 0, 0, 0)).toBeLessThan(0.1);
  expect(sweepField(0.2, 0, 5, 0, 0)).toBeCloseTo(sweepField(0.2, 0, 0, 0, 0), 5);
  expect(shaderSource("sweep")).toContain("mod(t * 0.32, 1.6) - 0.3");
});

test("the header pill: sky only at its right end; working, a sweep that crosses it", () => {
  // Idle: nothing on the left half, the color gathers at the right end.
  expect(pillField(0.3, 0.5, 0, 0, 0)).toBe(0);
  expect(pillField(1, 0, 0, 0, 0)).toBeGreaterThan(0.4);
  expect(shaderSource("pill")).toContain("(u - 0.55) / 0.45");
  // Working: the band's center starts off the left edge and reaches the middle ~1.9 s later, every 3.8 s.
  expect(pillWorkField(0.5, 0, 0.8 / 0.42, 0, 0)).toBeGreaterThan(pillWorkField(0.5, 0, 0, 0, 0));
  expect(pillWorkField(0.4, 0, 1.6 / 0.42, 0, 0)).toBeCloseTo(pillWorkField(0.4, 0, 0, 0, 0), 1);
  expect(shaderSource("pill")).toContain("mod(t * 0.42, 1.6) - 0.3");
  // Over glass the lowest tone is see-through.
  expect(shaderSource("pill")).toContain("if (clear > 0.5 && idx < 0.5) return half4(0.0);");
});

test("the computer's sky: its agents rise past the top and start again, at the sides, on whole cells", () => {
  expect(shaderSource("computer")).toContain("0.78 - 0.18 * u - 0.4 * v + 0.06 * sin(u * 5.0 + t * 0.5)");
  const [sprite] = COMPUTER_SPRITES;
  if (!sprite) throw new Error("no sprites");
  const w = 84;
  const h = 59;
  const rise = sprite.speed;
  const before = computerSpriteAt(sprite, 1, w, h);
  const after = computerSpriteAt(sprite, 2, w, h);
  expect(before.y - after.y).toBeCloseTo(rise, -0.5);
  // One whole trip later it is back.
  expect(computerSpriteAt(sprite, 1 + (h + 18) / rise, w, h).y).toBeCloseTo(before.y, -0.5);
  for (const s of COMPUTER_SPRITES) {
    for (let t = 0; t < 60; t += 0.7) {
      const at = computerSpriteAt(s, t, w, h);
      expect(Number.isInteger(at.x) && Number.isInteger(at.y)).toBe(true);
      expect(at.y).toBeGreaterThanOrEqual(-9);
      expect(at.y).toBeLessThanOrEqual(h + 9);
    }
  }
  expect(computerSpriteBlinks(sprite, 4 - sprite.blink)).toBe(true);
  expect(computerSpriteBlinks(sprite, 2)).toBe(false);
});
