/**
 * Charts in messages, C · Traço + trama: clean shapes (rounded bars, a smooth line,
 * a round ring) filled with a fine dither in the agent's tones. DOM-free: these return which tone each cell
 * takes; the web paints them on a canvas, the phone app on Skia. Cells are 2 points.
 */
import { type AgentColorName, gradientOf } from "../agent/engine.js";
import { bayerAt, mix } from "./math";

/** Points per dither cell. */
export const CHART_CELL = 2;

/** The fill ramp, light to deep (6 tones). */
export function chartRamp(color: AgentColorName = "sky"): string[] {
  const [top, bottom] = gradientOf(color);
  return [
    mix(top, "#ffffff", 0.55),
    mix(top, "#ffffff", 0.25),
    top,
    mix(top, bottom, 0.5),
    bottom,
    mix(bottom, "#000000", 0.35),
  ];
}

/** The line's stroke and its points. */
export function chartInk(color: AgentColorName = "sky", dark = false): string {
  const [top, bottom] = gradientOf(color);
  return dark ? top : bottom;
}

/** The two tones of the area under a line (near the line, then farther down). */
export function chartAreaTones(color: AgentColorName = "sky", dark = false): [string, string] {
  const r = chartRamp(color);
  return dark ? [r[4] as string, r[5] as string] : [r[1] as string, r[0] as string];
}

/** A pie's slices, strongest first (and the legend's swatches). */
export function chartSlices(color: AgentColorName = "sky", dark = false): string[] {
  const [top, bottom] = gradientOf(color);
  return dark
    ? [
        top,
        mix(top, bottom, 0.5),
        bottom,
        mix(bottom, "#000000", 0.25),
        mix(bottom, "#000000", 0.45),
        mix(bottom, "#000000", 0.6),
      ]
    : [
        bottom,
        mix(bottom, top, 0.5),
        top,
        mix(top, "#ffffff", 0.35),
        mix(top, "#ffffff", 0.55),
        mix(top, "#ffffff", 0.72),
      ];
}

/**
 * A bar's cells (`cols` × `rows`), as ramp indexes: light at its start, deeper toward its tip; the top
 * value (`lead`) runs deeper than the rest.
 */
export function barCells(cols: number, rows: number, lead: boolean): Uint8Array {
  const out = new Uint8Array(cols * rows);
  const n = 5;
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const f = 0.12 + (x / Math.max(1, cols - 1)) * (lead ? 0.8 : 0.5);
      const k = f * n;
      const lo = Math.floor(k);
      out[y * cols + x] = Math.min(n, lo + (k - lo > bayerAt(x, y) ? 1 : 0));
    }
  return out;
}

/**
 * The area under a line: `tops[x]` is the line's height at each column, in cells (NaN where there is none).
 * 0 = empty, 1 = the near tone, 2 = the far tone; it thins out going down.
 */
export function areaCells(cols: number, rows: number, tops: readonly number[]): Uint8Array {
  const out = new Uint8Array(cols * rows);
  for (let x = 0; x < cols; x++) {
    const top = tops[x];
    if (top === undefined || Number.isNaN(top)) continue;
    const y0 = Math.round(top) + 2;
    for (let y = Math.max(0, y0); y < rows; y++) {
      const f = 1 - (y - y0) / (rows - y0 + 1);
      if (f * 0.85 > bayerAt(x, y) + 0.1) out[y * cols + x] = f > 0.6 ? 1 : 2;
    }
  }
  return out;
}

/**
 * A ring of `size` × `size` cells split by `shares` (0..1, in order, clockwise from the top), swept up to
 * `sweep`. Each cell is the slice index to paint (the outer band dithers into the next slice), or -1.
 */
export function ringCells(size: number, shares: readonly number[], sweep = 1): Int8Array {
  const out = new Int8Array(size * size).fill(-1);
  const ends: number[] = [];
  let acc = 0;
  for (const s of shares) {
    acc += s;
    ends.push(acc);
  }
  const c = size / 2;
  const outer = size / 2;
  const inner = outer * 0.57;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const d = Math.hypot(dx, dy);
      if (d > outer || d < inner) continue;
      const a = ((Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI);
      if (a > sweep) continue;
      let i = ends.findIndex((e) => a < e);
      if (i < 0) i = ends.length - 1;
      const t = (d - inner) / (outer - inner);
      out[y * size + x] = t > 0.62 && t - 0.62 > bayerAt(x, y) * 0.5 ? (i + 1) % shares.length : i;
    }
  return out;
}

/** A smooth path through points (Catmull-Rom as cubic Béziers), as SVG `d` (the web's SVG and Skia read it). */
export function smoothPath(points: readonly (readonly [number, number])[]): string {
  const first = points[0];
  if (!first) return "";
  let d = `M${first[0]},${first[1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    if (!p0 || !p1 || !p2 || !p3) continue;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** Where each point sits in a `width` × `height` box (padding `pad`), with a little room above and below. */
export function linePoints(values: readonly number[], width: number, height: number, pad = 8): [number, number][] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) || 1;
  const bottom = lo - span * 0.15;
  const top = hi + span * 0.08;
  return values.map((v, i) => [
    pad + (i * (width - 2 * pad)) / Math.max(1, values.length - 1),
    pad + (1 - (v - bottom) / (top - bottom)) * (height - 2 * pad),
  ]);
}

/**
 * The line's height at each column (in cells), from the same curve `smoothPath` draws (its cubic segments
 * sampled), NaN where the line doesn't reach: the area's tops, without measuring a DOM path.
 */
export function lineTops(points: readonly (readonly [number, number])[], cols: number, cell = CHART_CELL): number[] {
  const tops = new Array<number>(cols).fill(Number.NaN);
  const put = (x: number, y: number) => {
    const col = Math.round(x / cell);
    if (col >= 0 && col < cols && Number.isNaN(tops[col] as number)) tops[col] = y / cell;
  };
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    if (!p0 || !p1 || !p2 || !p3) continue;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    const steps = Math.max(8, Math.ceil((p2[0] - p1[0]) / cell) * 3);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      const x = u * u * u * p1[0] + 3 * u * u * t * (c1[0] ?? 0) + 3 * u * t * t * (c2[0] ?? 0) + t * t * t * p2[0];
      const y = u * u * u * p1[1] + 3 * u * u * t * (c1[1] ?? 0) + 3 * u * t * t * (c2[1] ?? 0) + t * t * t * p2[1];
      put(x, y);
    }
  }
  return tops;
}

/**
 * Cells as SVG path data, one string per value (runs along a row merged into one rectangle): what Skia
 * draws on the phone (`Skia.Path.MakeFromSVGString`). Values below 0, and 0 when `skipZero`, are empty.
 */
export function cellPaths(
  cells: ArrayLike<number>,
  cols: number,
  rows: number,
  cell = CHART_CELL,
  skipZero = false,
): Map<number, string> {
  const out = new Map<number, string>();
  const add = (v: number, x0: number, x1: number, y: number) => {
    const d = `M${x0 * cell} ${y * cell}h${(x1 - x0) * cell}v${cell}h${-(x1 - x0) * cell}Z`;
    out.set(v, (out.get(v) ?? "") + d);
  };
  for (let y = 0; y < rows; y++) {
    let start = 0;
    let run = cells[y * cols] ?? -1;
    for (let x = 1; x <= cols; x++) {
      const v = x < cols ? (cells[y * cols + x] ?? -1) : Number.NaN;
      if (v === run) continue;
      if (run >= 0 && !(skipZero && run === 0)) add(run, start, x, y);
      start = x;
      run = v;
    }
  }
  return out;
}
