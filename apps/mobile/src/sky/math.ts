import { type AgentColorName, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import { BAYER, bayerAt, ditherIndex } from "@agenteschat/ui/sky/math";

/** The web's soft tones (activity bar, cards): the same function, so both draw the same colors. */
export { softTones } from "@agenteschat/ui/sky/math";

export { BAYER, bayerAt };

/**
 * The pixel/dither drawings (sky, fuse, spend bar, plan track) as pure math
 * (`fromSurface`, `addSky`, `addFuse`, `addBar`, `addTrack`, `drawDithers`). The app draws them with a
 * Skia shader (./shaders.ts) that does the same steps; the `shader*` functions below mirror the SkSL line
 * by line, and test/sky-math.test.ts checks they pick the same tone as the web's loop.
 */

/** Same thresholds without a table (the shader can't index arrays by a computed value). */
export function shaderBayer(x: number, y: number): number {
  const b2 = (a: number, b: number) => (a < 0.5 ? (b < 0.5 ? 0 : 3) : b < 0.5 ? 2 : 1);
  const x0 = mod(x, 2);
  const y0 = mod(y, 2);
  const x1 = mod(Math.floor(x / 2), 2);
  const y1 = mod(Math.floor(y / 2), 2);
  return (4 * b2(x0, y0) + b2(x1, y1) + 0.5) / 16;
}

/** GLSL `mod` (always positive for a positive divisor). */
export const mod = (a: number, b: number) => a - b * Math.floor(a / b);
/** GLSL `fract`. */
export const fract = (a: number) => a - Math.floor(a);

export function hash2(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Seven tones from a surface color into an agent color. */
export function fromSurface(surface: string, depth = 1, color: AgentColorName = "sky"): string[] {
  const [top, bot] = gradientOf(color);
  return [
    surface,
    mixHex(surface, top, 0.14 * depth),
    mixHex(surface, top, 0.3 * depth),
    mixHex(surface, top, 0.5 * depth),
    mixHex(surface, bot, 0.55 * depth),
    mixHex(top, bot, 0.5),
    mixHex(top, "#ffffff", 0.5),
  ];
}

/** A pixel agent going up an agent's computer's sky: its column, pace (sky cells a second) and where it starts. */
export interface ComputerSprite {
  x: number;
  speed: number;
  phase: number;
  blink: number;
  ghost: boolean;
}

/** At the sides, so they stay clear of the card in the middle. */
export const COMPUTER_SPRITES: readonly ComputerSprite[] = [
  { x: 0.03, speed: 5, phase: 0.1, blink: 0.4, ghost: true },
  { x: 0.16, speed: 3.5, phase: 0.6, blink: 2.1, ghost: false },
  { x: 0.84, speed: 4.5, phase: 0.35, blink: 1.2, ghost: true },
  { x: 0.97, speed: 3.8, phase: 0.85, blink: 3, ghost: false },
];

/** Where a sprite stands at `t` seconds, in sky cells of a `w`×`h` sky: up from under it and over its top, swaying. */
export function computerSpriteAt(sprite: ComputerSprite, t: number, w: number, h: number) {
  "worklet";
  const cells = 9;
  const travel = h + 2 * cells;
  const risen = t * sprite.speed + sprite.phase * travel;
  const y = h + cells - (risen - travel * Math.floor(risen / travel));
  const sway = Math.sin(t * 0.7 + sprite.phase * 6.28) * 2;
  return { x: Math.round(sprite.x * (w - cells) + sway), y: Math.round(y) };
}

/** A sprite blinks for a moment every 4 s. */
export function computerSpriteBlinks(sprite: ComputerSprite, t: number): boolean {
  "worklet";
  return (t + sprite.blink) % 4 < 0.16;
}

/** A field gives the tone position (0 = first tone, 1 = last) of the cell (x, y) at (u, v), time t. */
export type Field = (u: number, v: number, t: number, x: number, y: number) => number;

/** The home's sky: a soft glow low in the middle, fading to the top, with a few twinkling stars. */
export const skyField: Field = (u, v, t, x, y) => {
  const dx = (u - 0.5) * 1.5;
  const dy = (v - 0.78) * 1.8;
  let f = 0.85 * Math.exp(-(dx * dx + dy * dy) / 0.26);
  f *= 1 + 0.06 * Math.sin(t * 0.6 + u * 5);
  const k = Math.min(1, (1 - v) / 0.5);
  f *= k * k * (3 - 2 * k);
  const h = hash2(x, y);
  if (f < 0.12 && h > 0.988 && v < 0.7) f = 0.45 + 0.4 * Math.sin(t * 1.6 + h * 90);
  return f;
};

/** The fuse of a request: lit up to `remaining` (0..1) with a bright, flickering edge; dotted after it. */
export const fuseField =
  (remaining: number): Field =>
  (u, _v, t) => {
    const rem = Math.max(0, remaining);
    if (u > rem) return Math.floor(u * 140) % 3 === 0 ? 0.12 : 0;
    const d = rem - u;
    const edge = Math.exp(-(d * d) / 0.0006) * (0.75 + 0.25 * Math.sin(t * 9 + u * 40));
    return Math.min(1, 0.38 + 0.1 * Math.sin(t * 1.4 - u * 18) + edge);
  };

/** The spend bar: filled up to `k` (0..1), dotted after it. */
export const barField =
  (k: number): Field =>
  (u) =>
    u > k ? (Math.floor(u * 120) % 3 === 0 ? 0.12 : 0) : 0.45 + 0.25 * u;

export type PlanState = "done" | "run" | "todo";

/** A mission's plan as pixel cells: done = the agent's tones, running = breathing, to do = dotted outline. */
export const trackField =
  (items: readonly PlanState[]): Field =>
  (u, v, t, x, y) => {
    const n = Math.max(1, items.length);
    const k = Math.min(n - 1, Math.floor(u * n));
    const local = u * n - k;
    if (local > 0.8) return 0;
    const st = items[k] ?? "todo";
    if (st === "done") return 0.62 + 0.25 * (1 - v);
    if (st === "run") return 0.3 + 0.32 * (0.5 + 0.5 * Math.sin(t * 4 + k));
    return (v < 0.2 || v > 0.8 || local < 0.12 || local > 0.68) && (x + y) % 2 === 0 ? 0.2 : 0;
  };

/**
 * The working line's background (the web's `ActivitySky`): a soft band in the agent's color sweeping left
 * to right every 5 s, over a faint wash.
 */
export const sweepField: Field = (u, _v, t) => {
  const c = mod(t * 0.32, 1.6) - 0.3;
  const d = u - c;
  return 0.08 + 0.5 * Math.exp(-(d * d) / 0.035);
};

/**
 * The conversation header's pill: a little of the agent's sky at its right end,
 * breathing; over glass, so the lowest tone is see-through (`clear`).
 */
export const pillField: Field = (u, v, t) => {
  const e = Math.max(0, (u - 0.55) / 0.45);
  return 0.55 * e * e * (0.8 + 0.2 * Math.sin(v * 5 + t * 0.7));
};

/** The pill while the agent works: a sweep in its color crossing it (the sidebar's trail), stronger to the right. */
export const pillWorkField: Field = (u, v, t) => {
  const p = mod(t * 0.42, 1.6) - 0.3;
  const d = u - p;
  const band = 0.32 * u * u * u + 0.5 * Math.exp(-(d * d) / 0.02) * (0.5 + 0.5 * u);
  return Math.min(0.75, band) + 0.04 * Math.sin(v * 6 + t);
};

/**
 * The launch splash's sky up to `level` (share of the height from the bottom), deepest at the bottom; its top
 * edge waves a little, more as it rises (nothing at all at level 0).
 */
export const horizonField =
  (level: number): Field =>
  (u, v, t) => {
    const edge = v - (1 - level) + 0.08 * level * Math.sin(u * 6 + t * 1.1);
    const s = Math.min(1, Math.max(0, edge / Math.max(0.0001, level)));
    return s * s * (3 - 2 * s) * 0.97;
  };

/** The grid of a drawing `width`×`height` (points) at `pixel` points per cell. */
export const gridOf = (width: number, height: number, pixel: number) => ({
  w: Math.max(2, Math.ceil(width / pixel)),
  h: Math.max(2, Math.ceil(height / pixel)),
});

/** The web's choice of tone for a cell (the shared `ditherIndex`): the index in a palette of `count` tones. */
export const webToneIndex = (f: number, count: number, x: number, y: number) => ditherIndex(f, count - 1, x, y);

/** The shader's choice, step by step as in SkSL (`clamp`, `floor`, the Bayer formula, `min`). */
export function shaderToneIndex(f: number, count: number, x: number, y: number): number {
  const L = count - 1;
  const c = Math.min(1, Math.max(0, f));
  const s = c * L;
  const b = Math.floor(s);
  const idx = s - b > shaderBayer(x, y) ? b + 1 : b;
  return Math.min(idx, L);
}

/** The shader's cell for a point (px, py) in points: its integer coordinates and (u, v). */
export function shaderCell(px: number, py: number, width: number, height: number, pixel: number) {
  const x = Math.floor(px / pixel);
  const y = Math.floor(py / pixel);
  const { w, h } = gridOf(width, height, pixel);
  return { x, y, u: x / w, v: y / h };
}

/** "#rrggbb" → [r, g, b, 1] in 0..1 (a shader uniform). */
export function rgba(hex: string): [number, number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

/** Up to 8 tones as the shader's `pal[8]` (flat, padded with the last tone) and its last index. */
export function paletteUniform(tones: readonly string[]): { pal: number[]; last: number } {
  const list = tones.slice(0, 8);
  const pal: number[] = [];
  for (let i = 0; i < 8; i++) pal.push(...rgba(list[Math.min(i, list.length - 1)] ?? "#000000"));
  return { pal, last: Math.max(0, list.length - 1) };
}

/** Plan states as the shader's `states[48]`: 2 done, 1 running, 0 to do. */
export const MAX_PLAN_ITEMS = 48;
export function statesUniform(items: readonly PlanState[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < MAX_PLAN_ITEMS; i++) {
    const s = items[i];
    out.push(s === "done" ? 2 : s === "run" ? 1 : 0);
  }
  return out;
}
