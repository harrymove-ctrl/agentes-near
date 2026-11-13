import type { BrowserTrailKind } from "@agenteschat/client";
import { type AgentColorName, bodyTones, gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import type { CellRun } from "../../computer/cells";

/**
 * The pixels of the card after an agent's run in its browser or on its desktop, the web's drawings
 * (`RunPixels.tsx` in `@agenteschat/ui`: `BrowserStrip`, `BrowserMark`, `SkyStrip`, `PageSilhouette`) as cell
 * lists a Skia canvas replays (./TrailPixels.tsx). Same grid, tones and Bayer order as the web, so both apps
 * draw the same picture. Pure TypeScript: no React Native, no Skia, so it runs in `bun test`.
 */

export type { CellRun };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5;

/** Points per cell of the step columns (the web's `CELL`). */
export const TRAIL_CELL = 2;
/** The strip's height in cells: 7 sits on one line of text. */
export const STRIP_ROWS = 7;
const COLUMN_W = 3;
const COLUMN_GAP = 1;

/** The cells grouped by color, in the order the colors first appear (also the agent's month, `month-pixels.ts`). */
export class CellGrid {
  private readonly byColor = new Map<string, number[]>();
  put(x: number, y: number, color: string) {
    let list = this.byColor.get(color);
    if (!list) {
      list = [];
      this.byColor.set(color, list);
    }
    list.push(x, y);
  }
  runs(): CellRun[] {
    return [...this.byColor].map(([color, cells]) => ({ color, cells }));
  }
}

/** Bayer between a column's tones, `h` cells up from `base` (the web's `column`). */
export function column(out: CellGrid, x0: number, w: number, h: number, base: number, pal: string[]) {
  const last = pal.length - 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const f = h <= 1 ? 0.5 : 1 - y / (h - 1);
      const s = f * last;
      const b = Math.floor(s);
      const idx = s - b > bayer(x0 + x, y) ? b + 1 : b;
      out.put(x0 + x, base - y, pal[Math.min(last, idx)] ?? pal[0] ?? "#888888");
    }
}

/** The surface the card sits on and the danger tone, as six-digit hex (the mixer reads six digits). */
export interface TrailTones {
  raised: string;
  danger: string;
}

function trailPalette(color: AgentColorName, tones: TrailTones): Record<BrowserTrailKind, string[]> {
  const t = bodyTones(color);
  const at = (i: number) => t[i] ?? "#888888";
  return {
    open: [at(0), at(1), at(2)],
    read: [at(1), at(2), at(3)],
    act: [at(2), at(3), at(4)],
    shot: [mixHex(at(3), tones.raised, 0.35), at(4)],
    failed: [tones.danger, tones.danger, mixHex(tones.danger, tones.raised, 0.45)],
  };
}

const HEIGHT: Record<BrowserTrailKind, number> = { open: 1, read: 0.7, act: 0.4, shot: 0, failed: 1 };
const rowsOf = (kind: BrowserTrailKind, rows: number) =>
  kind === "shot" ? 2 : Math.max(3, Math.round(HEIGHT[kind] * rows));

/** The strip's width in cells for that many steps. */
export const stripWidth = (steps: number) => Math.max(1, steps * (COLUMN_W + COLUMN_GAP) - COLUMN_GAP);

/** The steps in order, oldest left: an open the whole column, a read most of it, an action a stub, a print two cells. */
export function stripCells(kinds: BrowserTrailKind[], color: AgentColorName, tones: TrailTones): CellRun[] {
  const pal = trailPalette(color, tones);
  const out = new CellGrid();
  kinds.forEach((k, i) => {
    column(out, i * (COLUMN_W + COLUMN_GAP), COLUMN_W, rowsOf(k, STRIP_ROWS), STRIP_ROWS - 1, pal[k]);
  });
  return out.runs();
}

/** One step's column, marking its line in the list (3 × 7 cells). */
export const MARK_W = COLUMN_W;
export function markCells(kind: BrowserTrailKind, color: AgentColorName, tones: TrailTones): CellRun[] {
  const out = new CellGrid();
  column(out, 0, COLUMN_W, rowsOf(kind, STRIP_ROWS), STRIP_ROWS - 1, trailPalette(color, tones)[kind]);
  return out.runs();
}

/** The web's `is-muted` sky edge: `saturate(0.35) brightness(1.05)` on each tone. */
export function muteHex(hex: string): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const [r = 0, g = 0, b = 0] = rgb;
  const s = 0.35;
  // The CSS saturate() matrix, then brightness.
  const out = [
    (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
    (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
  ].map((v) => Math.max(0, Math.min(255, Math.round(v * 1.05))));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Points per cell of the sky edge (the web draws one cell every 3 px, two rows in a 6 px strip). */
export const SKY_CELL = 3;

/** The thin edge of the agent's sky along the top of the card, still and greyed (the web's `SkyStrip muted`). */
export function skyEdgeCells(width: number, color: AgentColorName, raised: string, dark: boolean): CellRun[] {
  const w = Math.max(8, Math.ceil(width / SKY_CELL));
  const [top, bottom] = gradientOf(color);
  const pal = (
    dark
      ? [raised, mixHex(raised, bottom, 0.45), mixHex(bottom, top, 0.35), mixHex(top, bottom, 0.2)]
      : [raised, mixHex(raised, top, 0.35), mixHex(raised, top, 0.7), top]
  ).map(muteHex);
  const last = pal.length - 1;
  const out = new CellGrid();
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const f = Math.min(1, Math.max(0, 0.42 + 0.22 * Math.sin(u * 9) + 0.16 * Math.sin(u * 23) + (y ? -0.1 : 0.1)));
      const s = f * last;
      const b = Math.floor(s);
      out.put(x, y, pal[Math.min(last, s - b > bayer(x, y) ? b + 1 : b)] ?? raised);
    }
  return out.runs();
}

/** The blocks of a generic page, as fractions of the picture (a bar, a search field, cards, lines). */
const PAGE_BLOCKS: [number, number, number, number][] = [
  [0.05, 0.08, 0.22, 0.16],
  [0.7, 0.08, 0.95, 0.16],
  [0.25, 0.26, 0.75, 0.38],
  [0.05, 0.5, 0.3, 0.7],
  [0.36, 0.5, 0.64, 0.7],
  [0.7, 0.5, 0.95, 0.7],
  [0.05, 0.76, 0.3, 0.82],
  [0.36, 0.76, 0.6, 0.82],
  [0.7, 0.76, 0.9, 0.82],
];

/** The page's size in cells for a box in points (the web's 2 px cells). */
export const pageGrid = (width: number, height: number) => ({
  w: Math.max(16, Math.round(width / TRAIL_CELL)),
  h: Math.max(10, Math.round(height / TRAIL_CELL)),
});

/** The shape of a page, never the real one, fading into the agent's tone toward the bottom (the web's `PageSilhouette`). */
export function pageCells(w: number, h: number, color: AgentColorName, dark: boolean): CellRun[] {
  const [top, bottom] = gradientOf(color);
  const paper = dark ? "#26252b" : "#e9e8ef";
  const ink = dark ? "#3b3946" : "#cfcdd9";
  const tint = dark ? mixHex(bottom, "#0d0d10", 0.6) : mixHex(top, "#ffffff", 0.35);
  const fade = [paper, mixHex(paper, tint, 0.5), tint];
  const inBlock = (x: number, y: number) =>
    PAGE_BLOCKS.some(([x0, y0, x1, y1]) => x >= x0 * w && x < x1 * w && y >= y0 * h && y < y1 * h);
  const out = new CellGrid();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const b = bayer(x, y);
      const f = (y / h) * 0.9 + 0.1;
      const s = f * (fade.length - 1);
      const i = Math.floor(s);
      out.put(
        x,
        y,
        f > b * 1.2 ? (fade[Math.min(fade.length - 1, s - i > b ? i + 1 : i)] ?? paper) : inBlock(x, y) ? ink : paper,
      );
    }
  return out.runs();
}
