/**
 * The pixel sky's math, DOM-free: tones, the field (blobs, the pointer light,
 * calm zones), the Bayer 4×4 ordered dither and the 9×9 pixel agents. The web
 * draws it on a canvas (`engine.ts`); the phone app reproduces it in a shader
 * and tests it against these functions (ADR 0035).
 */
import { type AgentColorName, EYE_COLOR, gradientOf, spriteBody, spriteGrid } from "../agent/engine.js";

/* ---------- tones ---------- */

/** The landing's sky, deep blue to almost white. */
export const SKY_TONES = ["#0a3f9c", "#0f56c4", "#2b74e6", "#4b93ff", "#78b4ff", "#a6cfff", "#cfe6ff", "#eef7ff"];

/** "#rgb", "#rrggbb" or "rgb(r, g, b)" → [r, g, b]; anything else is mid gray. */
export function parseColor(color: string): [number, number, number] {
  const c = color.trim();
  if (c.startsWith("#")) {
    const h = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join("") : c.slice(1, 7);
    const n = Number.parseInt(h, 16);
    if (h.length === 6 && !Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [128, 128, 128];
}

/** `a` → `b` by `k` (0..1), as "#rrggbb". */
export function mix(a: string, b: string, k: number): string {
  const A = parseColor(a);
  const B = parseColor(b);
  return `#${A.map((v, i) =>
    Math.round(v + ((B[i] ?? v) - v) * k)
      .toString(16)
      .padStart(2, "0"),
  ).join("")}`;
}

/** An `rgba()` color as the solid "#rrggbb" it shows over `over`, for places with no alpha (classic Outlook). */
export const opaque = (color: string, over: string) =>
  mix(over, color, Number(/^rgba\(.*[,/]\s*([\d.]+)\s*\)$/.exec(color.trim())?.[1] ?? 1));

/** WCAG contrast ratio between two opaque colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (color: string) => {
    const [r, g, bl] = parseColor(color).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A color as a little-endian RGBA pixel (for a Uint32Array over ImageData). */
export function pixelOf(color: string): number {
  const [r, g, b] = parseColor(color);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** A full sky in an agent's color: deep to near white (sky → the landing's tones). */
export function agentTones(color: AgentColorName = "sky"): string[] {
  if (color === "sky") return SKY_TONES;
  const [top, bottom] = gradientOf(color);
  const deep = mix(bottom, "#000000", 0.42);
  return [
    deep,
    mix(deep, bottom, 0.5),
    bottom,
    mix(bottom, top, 0.5),
    top,
    mix(top, "#ffffff", 0.4),
    mix(top, "#ffffff", 0.7),
    mix(top, "#ffffff", 0.9),
  ];
}

/** From a surface into the agent's color (empty states, the activity strip). */
export function glowTones(color: AgentColorName, surface: string): string[] {
  const [top, bottom] = gradientOf(color);
  return [
    surface,
    mix(surface, bottom, 0.2),
    mix(surface, bottom, 0.45),
    mix(surface, bottom, 0.72),
    bottom,
    mix(bottom, top, 0.5),
    top,
    mix(top, "#ffffff", 0.5),
  ];
}

/** The light version: from a surface only into the color's light tones (the sidebar). */
export function softTones(color: AgentColorName, surface: string): string[] {
  const [top, bottom] = gradientOf(color);
  return [
    surface,
    mix(surface, top, 0.12),
    mix(surface, top, 0.26),
    mix(surface, top, 0.42),
    mix(surface, top, 0.62),
    top,
    mix(top, bottom, 0.35),
  ];
}

/** Eyes are white on every agent, everywhere (the agent engine). */
export const EYE = EYE_COLOR;

/** The pixel agents' body on a sky of this color: deep enough for the white eyes (navy on the sky). */
export const spriteTone = (color: AgentColorName = "sky") => spriteBody(color);

/* ---------- the field and the dither ---------- */

/** A soft blob added to the field: [x, y, spread, strength] in 0..1 units of the panel. */
export type SkyBlob = [x: number, y: number, spread: number, strength: number];

/** Bayer 4×4 thresholds (row-major), each in 0..1. */
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** The dither threshold at sky pixel (x, y). */
export const bayerAt = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5;

/** `f` plus the blobs at sky pixel (x, y) of a `w`×`h` field (distances in units of the height). */
export function blobsAt(blobs: readonly SkyBlob[], x: number, y: number, w: number, h: number, f = 0): number {
  const inv = 1 / h;
  for (const b of blobs) {
    const dx = (x - b[0] * w) * inv;
    const dy = (y - b[1] * h) * inv;
    f += b[3] * Math.exp(-(dx * dx + dy * dy) / b[2]);
  }
  return f;
}

/** The pointer light at (x, y): `strength` at its center (lx, ly), fading over `radius` sky pixels. */
export function lightAt(x: number, y: number, lx: number, ly: number, strength: number, radius: number): number {
  const dx = x - lx;
  const dy = y - ly;
  return strength * Math.exp(-(dx * dx + dy * dy) * (1 / (radius * radius)));
}

/**
 * The pointer light's center `dt` seconds on, from `from` toward the pointer at `to` (shares of the sky, held within
 * 0.3 past its edges): 5% of the way each 60th of a second, so at the same pace whatever the frame rate.
 */
export const lightToward = (from: number, to: number, dt: number) =>
  from + (Math.min(1.3, Math.max(-0.3, to)) - from) * (1 - 0.95 ** (dt * 60));

/** A moving sky draws about 30 frames a second: the dither moves in whole cells, more frames only cost. */
export const SKY_FRAME_MS = 32;

/** A calm zone (or any box on the sky): [left, top, right, bottom] in sky pixels. */
export type CalmZone = [left: number, top: number, right: number, bottom: number];

/** How calm (0..1) the field is at (x, y): 1 inside a zone, easing to 0 over `pad` sky pixels around it. */
export function calmAt(zones: readonly CalmZone[], pad: number, x: number, y: number): number {
  let k = 0;
  for (const z of zones) {
    const dx = x < z[0] ? z[0] - x : x > z[2] ? x - z[2] : 0;
    const dy = y < z[1] ? z[1] - y : y > z[3] ? y - z[3] : 0;
    if (dx > pad || dy > pad) continue;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < pad) {
      const q = 1 - d / pad;
      const s2 = q * q * (3 - 2 * q);
      if (s2 > k) k = s2;
    }
  }
  return k;
}

/** The tone index (0..levels) for field value `f` at sky pixel (x, y): clamped, then dithered between neighbours. */
export function ditherIndex(f: number, levels: number, x: number, y: number): number {
  const c = f < 0 ? 0 : f > 1 ? 1 : f;
  const s = c * levels;
  const lo = s | 0;
  const idx = s - lo > bayerAt(x, y) ? lo + 1 : lo;
  return idx > levels ? levels : idx;
}

/* ---------- pixel agents ---------- */

/** 9×9 pixel agent from the agent engine: the same shape and eyes as every agent ("X" body, "o" eye). */
export const SPRITE = spriteGrid(9);

/** A frame being drawn: RGBA pixels (`pixelOf`) row by row. */
export interface SkyFrame {
  buf: Uint32Array;
  w: number;
  h: number;
  t: number;
  tones: number[];
}

/** Whether a pixel agent at (x, y), `k` sky pixels per sprite pixel, comes within `pad` sky pixels of any box. */
export function spriteNear(boxes: readonly CalmZone[], x: number, y: number, k: number, pad: number): boolean {
  const s = 9 * k;
  for (const b of boxes) if (x - pad < b[2] && x + s + pad > b[0] && y - pad < b[3] && y + s + pad > b[1]) return true;
  return false;
}

/**
 * Where a pixel agent can stand in a `w`×`h` sky: wholly inside it, not above `top`, and `pad` away from every box
 * in `avoid`. Null after 24 tries: a crowded sky shows fewer agents rather than stacking them.
 */
export function placeSprite(
  rand: () => number,
  w: number,
  h: number,
  k: number,
  top: number,
  avoid: readonly CalmZone[],
  pad: number,
): [x: number, y: number] | null {
  const s = 9 * k;
  const from = Math.ceil(top);
  if (w < s || h - from < s) return null;
  for (let i = 0; i < 24; i++) {
    const x = Math.floor(rand() * (w - s + 1));
    const y = from + Math.floor(rand() * (h - from - s + 1));
    if (!spriteNear(avoid, x, y, k, pad)) return [x, y];
  }
  return null;
}

/**
 * An x for a pixel agent rising from below to `top` whose path keeps `pad` from every box it passes (any x when no
 * column does, after 12 tries).
 */
export function riseColumn(
  rand: () => number,
  w: number,
  k: number,
  top: number,
  boxes: readonly CalmZone[],
  pad: number,
): number {
  const s = 9 * k;
  const passed = boxes.filter((b) => b[3] + pad > top);
  for (let i = 0; i < 12; i++) {
    const x = rand() * w;
    if (!passed.some((b) => x - pad < b[2] && x + s + pad > b[0])) return x;
  }
  return rand() * w;
}

/** Draws one pixel agent at (x, y), `k` sky pixels per sprite pixel, skipping pixels where `skip` says so. */
export function drawSprite(
  f: Pick<SkyFrame, "buf" | "w" | "h">,
  x: number,
  y: number,
  k: number,
  body: number,
  eye: number,
  closed = false,
  skip?: (x: number, y: number) => boolean,
) {
  for (let sy = 0; sy < 9; sy++) {
    const line = SPRITE[sy] as string;
    for (let sx = 0; sx < 9; sx++) {
      const c = line[sx];
      if (c === ".") continue;
      const col = c === "o" && !(closed && sy === 3) ? eye : body;
      for (let ky = 0; ky < k; ky++)
        for (let kx = 0; kx < k; kx++) {
          const X = x + sx * k + kx;
          const Y = y + sy * k + ky;
          if (X >= 0 && X < f.w && Y >= 0 && Y < f.h && !skip?.(X, Y)) f.buf[Y * f.w + X] = col;
        }
    }
  }
}
