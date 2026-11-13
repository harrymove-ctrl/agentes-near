import type { RunStatus } from "@agenteschat/client/lib/calendar";
import { AGENT_GRADIENTS, type AgentColorName, bodyTones, mixHex, spriteGrid } from "@agenteschat/ui/agent/engine";
import { CellGrid, type CellRun, column } from "../browser/trail-pixels";

/**
 * A routine's runs in pixels on the phone, the web's drawings (`RunStrip` and `RunLane` in `@agenteschat/ui`
 * `RunPixels.tsx`) as cell lists a Skia canvas replays (./RunPixels.tsx): each run a dithered column in the
 * agent's tones as tall as its cost (`weight`), nothing new a stub, a failure in the danger tone, a skip a short
 * warm one; a run at work flickers in the sky's light. On the horizon, a lane per routine: a dotted line, the
 * past runs as small columns, the next ones as pixels and the agent itself on its next run. Same grid, tones and
 * Bayer order as the web. Pure TypeScript, so it runs in `bun test`.
 */

export type { CellRun };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5;

/** Points per cell (the web's 2 px cells). */
export const RUN_CELL = 2;

/** A finished run as a pixel (`runPixels`): its status, its cost as a share (0–1) and when. */
export interface RunPixel {
  status: RunStatus;
  weight?: number;
  at: string;
}

/** The surface, the danger and warm tones and the dots' tone, as six-digit hex (the mixer reads six digits). */
export interface RunTones {
  raised: string;
  danger: string;
  warn: string;
  dot: string;
}

interface Palette {
  ok: string[];
  silent: string[];
  failed: string[];
  skipped: string[];
  dot: string;
  future: string;
}

function paletteFor(color: AgentColorName, tones: RunTones): Palette {
  const t = bodyTones(color);
  const at = (i: number) => t[i] ?? "#888888";
  return {
    ok: [at(1), at(1), at(2), at(3)],
    silent: [mixHex(at(3), tones.raised, 0.35), at(4)],
    failed: [tones.danger, tones.danger, mixHex(tones.danger, tones.raised, 0.45)],
    skipped: [tones.warn, mixHex(tones.warn, tones.raised, 0.4)],
    dot: tones.dot,
    future: mixHex(at(3), tones.raised, 0.25),
  };
}

function drawRun(out: CellGrid, p: Palette, x0: number, w: number, rows: number, base: number, run: RunPixel) {
  const tall = (min: number) => Math.max(min, Math.round(min + (run.weight ?? 1) * (rows - min)));
  if (run.status === "ok") column(out, x0, w, tall(Math.ceil(rows * 0.4)), base, p.ok);
  else if (run.status === "silent") column(out, x0, w, 2, base, p.silent);
  else if (run.status === "failed") column(out, x0, w, rows, base, p.failed);
  else column(out, x0, w, Math.ceil(rows * 0.4), base, p.skipped);
}

/** A run in progress: cells arriving in the sky's light end, flickering (`t` in seconds). */
function drawWorking(out: CellGrid, x0: number, w: number, rows: number, base: number, t: number) {
  const [top, bottom] = AGENT_GRADIENTS.sky;
  const sky = [bottom, top, mixHex(top, "#ffffff", 0.5)];
  const h = 3 + Math.round((Math.sin(t * 5) + 1) * ((rows - 3) / 2));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if ((x * 7 + y * 13 + Math.floor(t * 12)) % 5 === 0) continue;
      out.put(x0 + x, base - y, sky[Math.min(2, Math.floor((y / h) * 3))] ?? bottom);
    }
}

// ── The strip (a row, the last runs) ────────────────────────────────────────

const COLUMN_W = 3;
const COLUMN_GAP = 1;
/** The strip's height in cells. */
export const STRIP_ROWS = 10;

/** The strip's width in cells for that many slots. */
export const stripWidth = (slots: number) => slots * (COLUMN_W + COLUMN_GAP) - COLUMN_GAP;

/**
 * The last runs as columns, oldest left; empty slots are a dot on the line. `runs` newest first (as the API sends
 * them); `running`: the newest slot shows a run in progress at `t` seconds.
 */
export function stripCells(
  runs: readonly RunPixel[],
  color: AgentColorName,
  tones: RunTones,
  { slots, running = false, t = 0 }: { slots: number; running?: boolean; t?: number },
): CellRun[] {
  const p = paletteFor(color, tones);
  const out = new CellGrid();
  const shown = runs.slice(0, slots - (running ? 1 : 0)).reverse();
  const pad = slots - shown.length - (running ? 1 : 0);
  for (let i = 0; i < pad; i++) out.put(i * (COLUMN_W + COLUMN_GAP) + 1, STRIP_ROWS - 1, p.dot);
  shown.forEach((run, j) => {
    drawRun(out, p, (pad + j) * (COLUMN_W + COLUMN_GAP), COLUMN_W, STRIP_ROWS, STRIP_ROWS - 1, run);
  });
  if (running) drawWorking(out, (slots - 1) * (COLUMN_W + COLUMN_GAP), COLUMN_W, STRIP_ROWS, STRIP_ROWS - 1, t);
  return out.runs();
}

// ── A lane of the horizon ───────────────────────────────────────────────────

/** A lane's height in cells, and the row its line sits on. */
export const LANE_ROWS = 15;
export const LANE_BASE = 11;
/** The agent's sprite: 9 cells a side, standing on the line. */
export const SPRITE = 9;

/** The lane's width in cells for a track `width` points wide. */
export const laneWidth = (width: number) => Math.max(10, Math.round(width / RUN_CELL));

/** The cell an instant falls on, across a lane `w` cells wide from `from` to `to`. */
export function laneX(at: string | Date, from: Date, to: Date, w: number): number {
  const span = to.getTime() - from.getTime() || 1;
  return Math.round(((new Date(at).getTime() - from.getTime()) / span) * (w - 1));
}

/**
 * The still part of a lane: the dotted line, the past runs as small columns, the coming runs as single pixels
 * in the agent's light tone (the next one is the agent itself, `spriteX`, unless it is running).
 */
export function laneCells(
  w: number,
  from: Date,
  to: Date,
  past: readonly RunPixel[],
  future: readonly string[],
  color: AgentColorName,
  tones: RunTones,
  running: boolean,
): CellRun[] {
  const p = paletteFor(color, tones);
  const out = new CellGrid();
  for (let x = 0; x < w; x += 2) out.put(x, LANE_BASE + 1, p.dot);
  for (const run of past) drawRun(out, p, laneX(run.at, from, to, w) - 1, 2, 8, LANE_BASE, run);
  const next = running ? undefined : future[0];
  for (const d of future) if (d !== next) out.put(laneX(d, from, to, w), LANE_BASE, p.future);
  return out.runs();
}

/** Where the agent stands: at "now" while it runs, else on its next run (never on "now"); null with none. */
export function spriteX(
  w: number,
  from: Date,
  to: Date,
  now: Date,
  future: readonly string[],
  running: boolean,
): number | null {
  const at = laneX(now, from, to, w) + 6;
  if (running) return at;
  const next = future[0];
  return next === undefined ? null : Math.max(laneX(next, from, to, w), at);
}

/** The sprite's hop and blink at `t` seconds, as the web's (`still`: reduced motion, neither). */
export function spritePose(
  t: number,
  look: { color: string; eyes: string },
  running: boolean,
  still: boolean,
): { hop: 0 | 1; blink: boolean } {
  const seed = look.color.length + look.eyes.length;
  return {
    hop: !running && !still && (t * 1.3 + seed) % 3 < 0.35 ? 1 : 0,
    blink: !still && (t + seed * 0.7) % 4.2 < 0.14,
  };
}

/** The agent as a 9×9 sprite: its body dithered in its tones, its eyes (writing while it runs, or blinking). */
export function spriteCells(color: AgentColorName, eyes: string, running: boolean, blink: boolean): CellRun[] {
  const tones = bodyTones(color);
  const out = new CellGrid();
  spriteGrid(SPRITE, eyes).forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === ".") continue;
      if (c === "o") {
        const ink = tones[1] ?? "#000000";
        out.put(x, y, running ? (y === 4 ? "#ffffff" : ink) : blink ? ink : "#ffffff");
        continue;
      }
      const s = (1 - y / 8) * 3;
      const b = Math.floor(s);
      out.put(x, y, tones[Math.min(4, 1 + (s - b > bayer(x, y) ? b + 1 : b))] ?? "#888888");
    }
  });
  return out.runs();
}
