import { useEffect, useRef } from "react";
import { AGENT_GRADIENTS, bodyTones, gradientOf, mixHex, spriteGrid } from "../agent/engine.js";
import { cx } from "../cx";
import type { AgentColor, AgentEyes } from "./AgentLook";

/**
 * A routine's runs in pixels: each run is a dithered
 * column in the agent's own tones on a 2px grid. Height is the run's cost
 * (`weight`, 0–1, a share of the priciest recent run); nothing new is a
 * stub; a failure a column in the danger tone; a skip a short warm one.
 * Decorative canvases (nothing to read): the caller gives the words, an
 * `aria-label` on a `role="img"` wrapper.
 */
export type RunPixelStatus = "ok" | "silent" | "failed" | "skipped";
export interface RunPixel {
  status: RunPixelStatus;
  /** 0–1. */
  weight?: number;
  at?: string | Date;
}

export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
export const CELL = 2;

export const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches === true;

/** A color token as "#rrggbb" (the mixer reads six digits: "#fff" would come out blue). */
export function token(el: Element, name: string, fallback: string) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v.slice(0, 7);
  if (/^#[0-9a-f]{3,4}$/i.test(v)) return `#${[...v.slice(1, 4)].map((c) => c + c).join("")}`;
  return fallback;
}

/** Bayer between a column's tones: deep at the base, light at the top. */
export function column(ctx: CanvasRenderingContext2D, x0: number, w: number, h: number, base: number, pal: string[]) {
  const last = pal.length - 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const f = h <= 1 ? 0.5 : 1 - y / (h - 1);
      const s = f * last;
      const b = Math.floor(s);
      const idx = s - b > (BAYER[((y & 3) << 2) | ((x0 + x) & 3)] ?? 0.5) ? b + 1 : b;
      ctx.fillStyle = pal[Math.min(last, idx)] ?? pal[0] ?? "#888888";
      ctx.fillRect(x0 + x, base - y, 1, 1);
    }
}

interface Palette {
  ok: string[];
  silent: string[];
  failed: string[];
  skipped: string[];
  dot: string;
  future: string;
}
function paletteFor(el: Element, color: AgentColor): Palette {
  const tones = bodyTones(color);
  const raised = token(el, "--raised", "#ffffff");
  const danger = token(el, "--danger", "#b42a20");
  const warn = token(el, "--warn", "#9a5b00");
  const t = (i: number) => tones[i] ?? "#888888";
  return {
    ok: [t(1), t(1), t(2), t(3)],
    silent: [mixHex(t(3), raised, 0.35), t(4)],
    failed: [danger, danger, mixHex(danger, raised, 0.45)],
    skipped: [warn, mixHex(warn, raised, 0.4)],
    dot: token(el, "--line-strong", "#cfcfc9"),
    future: mixHex(t(3), raised, 0.25),
  };
}

function drawRun(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x0: number,
  w: number,
  rows: number,
  base: number,
  run: RunPixel,
) {
  const tall = (min: number) => Math.max(min, Math.round(min + (run.weight ?? 1) * (rows - min)));
  if (run.status === "ok") column(ctx, x0, w, tall(Math.ceil(rows * 0.4)), base, p.ok);
  else if (run.status === "silent") column(ctx, x0, w, 2, base, p.silent);
  else if (run.status === "failed") column(ctx, x0, w, rows, base, p.failed);
  else column(ctx, x0, w, Math.ceil(rows * 0.4), base, p.skipped);
}

/** A run in progress: cells arriving in the sky's light end, flickering. */
function drawWorking(ctx: CanvasRenderingContext2D, x0: number, w: number, rows: number, base: number, t: number) {
  const [top, bottom] = AGENT_GRADIENTS.sky;
  const sky = [bottom, top, mixHex(top, "#ffffff", 0.5)];
  const h = 3 + Math.round((Math.sin(t * 5) + 1) * ((rows - 3) / 2));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if ((x * 7 + y * 13 + Math.floor(t * 12)) % 5 === 0) continue;
      ctx.fillStyle = sky[Math.min(2, Math.floor((y / h) * 3))] ?? bottom;
      ctx.fillRect(x0 + x, base - y, 1, 1);
    }
}

/**
 * Runs a draw function: once (reduced motion, nothing moving) or about 12 times a second while mounted, and again as
 * the theme changes: what it draws reads the theme's colors, and a still one would keep the old ones.
 */
export function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, t: number) => void,
  moving: boolean,
) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fn = useRef(draw);
  fn.current = draw;
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx) return;
    const paint = () => fn.current(ctx, canvas, performance.now() / 1000);
    paint();
    if (!moving || reduced()) return;
    const timer = setInterval(() => {
      if (!document.hidden && canvas.isConnected) paint();
    }, 80);
    return () => clearInterval(timer);
  });
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx || typeof MutationObserver === "undefined") return;
    const theme = new MutationObserver(() => fn.current(ctx, canvas, performance.now() / 1000));
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => theme.disconnect();
  }, []);
  return ref;
}

/** The last runs as a strip of pixel columns, oldest left; empty slots are a dot on the line. */
export function RunStrip({
  runs,
  color = "sky",
  slots = 14,
  running = false,
  className,
}: {
  /** Newest first (as the API sends them). */
  runs: RunPixel[];
  color?: AgentColor;
  slots?: number;
  /** The newest slot shows a run in progress. */
  running?: boolean;
  className?: string;
}) {
  const COLW = 3;
  const GAP = 1;
  const ROWS = 10;
  const width = slots * (COLW + GAP) - GAP;
  const ref = useCanvas((ctx, canvas, t) => {
    const p = paletteFor(canvas, color);
    ctx.clearRect(0, 0, width, ROWS);
    const shown = runs.slice(0, slots - (running ? 1 : 0)).reverse();
    const pad = slots - shown.length - (running ? 1 : 0);
    for (let i = 0; i < pad; i++) {
      ctx.fillStyle = p.dot;
      ctx.fillRect(i * (COLW + GAP) + 1, ROWS - 1, 1, 1);
    }
    shown.forEach((run, j) => {
      drawRun(ctx, p, (pad + j) * (COLW + GAP), COLW, ROWS, ROWS - 1, run);
    });
    if (running) drawWorking(ctx, (slots - 1) * (COLW + GAP), COLW, ROWS, ROWS - 1, t);
  }, running);
  return (
    <canvas
      ref={ref}
      className={cx("ac-run-strip", className)}
      width={width}
      height={ROWS}
      style={{ width: width * CELL, height: ROWS * CELL }}
    />
  );
}

const SPRITES = new Map<string, string[]>();
export const spriteOf = (eyes: string) => {
  let g = SPRITES.get(eyes);
  if (!g) {
    g = spriteGrid(9, eyes);
    SPRITES.set(eyes, g);
  }
  return g;
};

/**
 * One routine's lane on the time horizon: a dotted line, past runs as small
 * columns, future runs as single pixels in the agent's light tone and the
 * next one as the agent itself, a pixel sprite on the line (it blinks and
 * hops). While it runs the sprite stands at "now" writing.
 */
export function RunLane({
  from,
  to,
  now,
  past,
  future,
  color = "sky",
  eyes = "round",
  running = false,
  className,
}: {
  from: Date;
  to: Date;
  now: Date;
  past: (RunPixel & { at: string | Date })[];
  future: (string | Date)[];
  color?: AgentColor;
  eyes?: AgentEyes;
  running?: boolean;
  className?: string;
}) {
  const ROWS = 15;
  const BASE = 11;
  const ref = useCanvas((ctx, canvas, t) => {
    const w = Math.max(10, Math.round(canvas.clientWidth / CELL) || 300);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== ROWS) canvas.height = ROWS;
    const span = to.getTime() - from.getTime() || 1;
    const X = (d: string | Date) => Math.round(((new Date(d).getTime() - from.getTime()) / span) * (w - 1));
    const p = paletteFor(canvas, color);
    ctx.clearRect(0, 0, w, ROWS);
    for (let x = 0; x < w; x += 2) {
      ctx.fillStyle = p.dot;
      ctx.fillRect(x, BASE + 1, 1, 1);
    }
    for (const run of past) drawRun(ctx, p, X(run.at) - 1, 2, 8, BASE, run);
    const next = running ? undefined : future[0];
    for (const d of future) {
      if (d === next) continue;
      ctx.fillStyle = p.future;
      ctx.fillRect(X(d), BASE, 1, 1);
    }
    const cx0 = running ? X(now) + 6 : next !== undefined ? Math.max(X(next), X(now) + 6) : null;
    if (cx0 === null) return;
    const tones = bodyTones(color);
    const grid = spriteOf(eyes);
    const still = reduced();
    const seed = color.length + eyes.length;
    const hop = !running && !still && (t * 1.3 + seed) % 3 < 0.35 ? 1 : 0;
    const blink = !still && (t + seed * 0.7) % 4.2 < 0.14;
    const top = BASE - 8 - hop;
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = row[x];
        if (c === ".") continue;
        if (c === "o")
          ctx.fillStyle = running
            ? y === 4
              ? "#ffffff"
              : (tones[1] ?? "#000")
            : blink
              ? (tones[1] ?? "#000")
              : "#ffffff";
        else {
          const s = (1 - y / 8) * 3;
          const b = Math.floor(s);
          ctx.fillStyle =
            tones[Math.min(4, 1 + (s - b > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5) ? b + 1 : b))] ?? "#888";
        }
        ctx.fillRect(cx0 - 4 + x, top + y, 1, 1);
      }
    });
  }, true);
  return <canvas ref={ref} className={cx("ac-run-lane", className)} />;
}

/**
 * One routine run as a single pixel mark (4×4 cells, 8px): dithered in the
 * agent's own tones when it went fine, the danger tone when it failed, a
 * pale square when it said nothing new or is still to come. Decorative: the
 * caller gives the words (a button's `aria-label`).
 */
export function RunMark({
  color = "sky",
  status = "next",
  className,
}: {
  color?: AgentColor;
  status?: RunPixelStatus | "next";
  className?: string;
}) {
  const N = 4;
  const ref = useCanvas((ctx, canvas) => {
    const p = paletteFor(canvas, color);
    const tones = bodyTones(color);
    const next = [p.future, tones[4] ?? p.future];
    const pal =
      status === "ok"
        ? p.ok
        : status === "failed"
          ? p.failed
          : status === "skipped"
            ? p.skipped
            : status === "silent"
              ? p.silent
              : next;
    ctx.clearRect(0, 0, N, N);
    column(ctx, 0, N, N, N - 1, pal);
  }, false);
  return (
    <canvas
      ref={ref}
      className={cx("ac-run-mark", className)}
      data-status={status}
      width={N}
      height={N}
      style={{ width: N * CELL, height: N * CELL }}
    />
  );
}

/** A legend key (3×5 cells) in neutral tones, for the horizon's legend. */
export function RunKey({ status }: { status: RunPixelStatus | "next" }) {
  const ref = useCanvas((ctx, canvas) => {
    const p = paletteFor(canvas, "graphite");
    ctx.clearRect(0, 0, 3, 5);
    if (status === "next") {
      ctx.fillStyle = p.future;
      ctx.fillRect(1, 4, 1, 1);
    } else drawRun(ctx, p, 0, 3, 5, 4, { status, weight: 1 });
  }, false);
  return <canvas ref={ref} className="ac-run-key" width={3} height={5} />;
}

/** A day of an agent's month: its runs and how many failed. */
export interface MonthDay {
  day: number;
  runs: number;
  failed: number;
}

/**
 * An agent's month in pixels (its Atividade tab): a dithered column per day in the agent's tones, as tall as
 * that day's runs over the busiest day's; a day with a failure wears a cap in the danger tone; a day without
 * runs, and every day to come, is a dot on the line. Decorative: the caller gives the words.
 */
export function MonthRuns({
  days,
  today,
  perDay,
  color = "sky",
  className,
}: {
  /** Days in the month. */
  days: number;
  /** Today's day of the month: later days are still to come. */
  today: number;
  /** Only the days with runs. */
  perDay: readonly MonthDay[];
  color?: AgentColor;
  className?: string;
}) {
  const ROWS = 40;
  const ref = useCanvas((ctx, canvas) => {
    const w = Math.max(days * 3, Math.round(canvas.clientWidth / CELL) || days * 8);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== ROWS) canvas.height = ROWS;
    const p = paletteFor(canvas, color);
    ctx.clearRect(0, 0, w, ROWS);
    const byDay = new Map(perDay.map((d) => [d.day, d]));
    const max = Math.max(1, ...perDay.map((d) => d.runs));
    const slot = w / days;
    const colW = Math.max(2, Math.floor(slot * 0.62));
    const base = ROWS - 1;
    for (let d = 1; d <= days; d++) {
      const x0 = Math.round((d - 1) * slot + (slot - colW) / 2);
      const day = byDay.get(d);
      if (d > today || !day || day.runs === 0) {
        ctx.fillStyle = p.dot;
        ctx.fillRect(x0 + Math.floor(colW / 2), base, 1, 1);
        continue;
      }
      const h = Math.max(2, Math.round((day.runs / max) * (ROWS - 5)));
      column(ctx, x0, colW, h, base, p.ok);
      if (day.failed > 0) column(ctx, x0, colW, 2, base - h - 1, p.failed);
    }
  }, false);
  return <canvas ref={ref} className={cx("ac-month-runs", className)} />;
}

/**
 * An agent's browser steps in pixels: one dithered column per
 * step in the agent's tones, as a routine's runs. The height says what it was: an open the whole
 * column, reading most of it, an action a stub, a print two cells; a failure the whole column in
 * the danger tone.
 */
export type BrowserPixelKind = "open" | "read" | "act" | "shot" | "failed";

function browserPalette(el: Element, color: AgentColor): Record<BrowserPixelKind, string[]> {
  const t = bodyTones(color).map((x) => x ?? "#888888");
  const raised = token(el, "--raised", "#ffffff");
  const danger = token(el, "--danger", "#b42a20");
  const at = (i: number) => t[i] ?? "#888888";
  return {
    open: [at(0), at(1), at(2)],
    read: [at(1), at(2), at(3)],
    act: [at(2), at(3), at(4)],
    shot: [mixHex(at(3), raised, 0.35), at(4)],
    failed: [danger, danger, mixHex(danger, raised, 0.45)],
  };
}

const BROWSER_HEIGHT: Record<BrowserPixelKind, number> = { open: 1, read: 0.7, act: 0.4, shot: 0, failed: 1 };
const browserRows = (kind: BrowserPixelKind, rows: number) =>
  kind === "shot" ? 2 : Math.max(3, Math.round(BROWSER_HEIGHT[kind] * rows));

/** The steps in order, oldest left (the card's header). */
export function BrowserStrip({
  kinds,
  color = "sky",
  rows: ROWS = 10,
  className,
}: {
  kinds: BrowserPixelKind[];
  color?: AgentColor;
  /** Its height in pixels: 7 sits on one line of text. */
  rows?: number;
  className?: string;
}) {
  const W = 3;
  const GAP = 1;
  const width = Math.max(1, kinds.length * (W + GAP) - GAP);
  const ref = useCanvas((ctx, canvas) => {
    const pal = browserPalette(canvas, color);
    ctx.clearRect(0, 0, width, ROWS);
    kinds.forEach((k, i) => {
      column(ctx, i * (W + GAP), W, browserRows(k, ROWS), ROWS - 1, pal[k]);
    });
  }, false);
  return (
    <canvas
      ref={ref}
      className={cx("ac-run-strip", className)}
      width={width}
      height={ROWS}
      style={{ width: width * CELL, height: ROWS * CELL }}
    />
  );
}

/** One step's column, marking its line in the list. */
export function BrowserMark({
  kind,
  color = "sky",
  className,
}: {
  kind: BrowserPixelKind;
  color?: AgentColor;
  className?: string;
}) {
  const W = 3;
  const ROWS = 7;
  const ref = useCanvas((ctx, canvas) => {
    ctx.clearRect(0, 0, W, ROWS);
    column(ctx, 0, W, browserRows(kind, ROWS), ROWS - 1, browserPalette(canvas, color)[kind]);
  }, false);
  return (
    <canvas
      ref={ref}
      className={cx("ac-run-mark", className)}
      width={W}
      height={ROWS}
      style={{ width: W * CELL, height: ROWS * CELL }}
    />
  );
}

/**
 * Acceptance criteria as pixel blocks: one block per
 * criterion, done ones dithered in the assignee's tones (an agent's color;
 * a person or nobody: neutral ink), open ones a dotted outline.
 */
export function CriteriaPixels({
  done,
  color,
  className,
}: {
  done: boolean[];
  color?: AgentColor | null;
  className?: string;
}) {
  const W = 5;
  const H = 4;
  const G = 1;
  const width = Math.max(1, done.length * (W + G) - G);
  const ref = useCanvas((ctx, canvas) => {
    const raised = token(canvas, "--raised", "#ffffff");
    const ink = token(canvas, "--ink", "#151514");
    const tones = color ? bodyTones(color) : null;
    const t = (i: number) => tones?.[i] ?? "#888888";
    const pal = tones
      ? [t(1), t(2), t(3)]
      : [mixHex(ink, raised, 0.1), mixHex(ink, raised, 0.3), mixHex(ink, raised, 0.5)];
    // Open: a quiet solid block, so the row reads as slots to fill (not noise).
    const open = mixHex(raised, ink, 0.1);
    ctx.clearRect(0, 0, width, H);
    done.forEach((d, k) => {
      const x0 = k * (W + G);
      if (d) column(ctx, x0, W, H, H - 1, pal);
      else {
        ctx.fillStyle = open;
        ctx.fillRect(x0, 0, W, H);
      }
    });
  }, false);
  return (
    <canvas
      ref={ref}
      className={cx("ac-crit-pixels", className)}
      width={width}
      height={H}
      style={{ width: width * CELL, height: H * CELL }}
    />
  );
}

/**
 * An agent at work: a thin dithered sweep along the bottom of whatever holds
 * it (give the holder `position: relative`), in the agent's light tones.
 * `waiting` holds still and dim (it waits on a person).
 */
export function WorkSweep({
  color = "sky",
  waiting = false,
  className,
}: {
  color?: AgentColor;
  waiting?: boolean;
  className?: string;
}) {
  const ref = useCanvas((ctx, canvas, t) => {
    const w = Math.max(8, Math.round(canvas.clientWidth / CELL) || 120);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== 2) canvas.height = 2;
    const surface = token(canvas, "--raised", "#ffffff");
    const [top, bottom] = gradientOf(color);
    const pal = [
      surface,
      mixHex(surface, top, 0.2),
      mixHex(surface, top, 0.45),
      mixHex(surface, bottom, 0.55),
      mixHex(top, bottom, 0.5),
    ];
    const last = pal.length - 1;
    const c = ((t * 0.45) % 1.6) - 0.3;
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const f = waiting ? 0.2 + 0.08 * Math.sin(u * 30) : 0.1 + 0.85 * Math.exp(-((u - c) * (u - c)) / 0.02);
        const s = Math.max(0, Math.min(1, f)) * last;
        const b = Math.floor(s);
        ctx.fillStyle = pal[Math.min(last, s - b > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5) ? b + 1 : b)] ?? surface;
        ctx.fillRect(x, y, 1, 1);
      }
  }, !waiting);
  return <canvas ref={ref} className={cx("ac-work-sweep", className)} />;
}

/** A plan cell's side in canvas pixels (square), and the gap between cells. */
export const STRIP_CELL = 7;
export const STRIP_GAP = 2;

/** A plan item's cell in the strip: done, doing, waiting for a person, stopped with the computer, dropped, to do. */
export type PlanStripCell = "done" | "doing" | "waiting" | "stopped" | "dropped" | "todo";

/**
 * One pixel of a plan cell (`null`: left empty), in the agent's tones
 * (`bodyTones`: 0 deep … 4 lightest). `t` in seconds, or null when still.
 * Every kind but dropped fills the whole square, so cells never change size.
 */
export function planCellPixel(
  kind: PlanStripCell,
  color: AgentColor,
  x: number,
  y: number,
  index = 0,
  t: number | null = null,
): { color: string; alpha: number } | null {
  const tones = bodyTones(color);
  const tone = (i: number) => tones[i] ?? "#888888";
  const last = STRIP_CELL - 1;
  const edge = x === 0 || y === 0 || x === last || y === last;
  const b = BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5;
  const faint = { color: tone(3), alpha: 0.28 };
  switch (kind) {
    case "done": {
      const f = 1 - y / last;
      return { color: tone(1 + Math.min(2, Math.floor(f * 2 + b))), alpha: 1 };
    }
    case "doing": {
      const w = t == null ? 0.6 : (Math.sin(t * 4 - x * 0.7 + index) + 1) / 2;
      if (w + b * 0.8 > 0.7) return { color: tone(2 + Math.min(2, Math.floor((w + b) * 1.5))), alpha: 1 };
      return faint;
    }
    case "waiting":
      if (edge) return { color: tone(2), alpha: t == null ? 1 : 0.7 + 0.3 * ((Math.sin(t * 3) + 1) / 2) };
      return faint;
    case "stopped":
      if (edge) return { color: tone(2), alpha: 0.5 };
      return faint;
    case "dropped":
      return (x + y) % 3 === 0 ? { color: tone(3), alpha: 0.3 } : null;
    default:
      return faint;
  }
}

/**
 * A mission's plan as a pixel strip: one square
 * cell per checklist item, all the same size, in the agent's own tones. To do
 * is a faint solid cell, doing an animated dithered one, done a full dithered
 * one, waiting for a person a faint cell outlined in the agent's mid tone
 * (a slow pulse), stopped with the computer the same outline, still and dim,
 * and dropped a faint diagonal (the only broken-up look; callers usually
 * leave dropped items out). The caller gives the words: `label` on
 * `role="img"`, and `titles` (one per cell) for each cell's tooltip.
 */
export function PlanStrip({
  cells,
  color = "sky",
  label,
  titles,
  className,
}: {
  cells: PlanStripCell[];
  color?: AgentColor;
  /** "4 de 12 itens prontos". */
  label: string;
  /** Each cell's tooltip ("Push · esperando você"), in order. */
  titles?: (string | null | undefined)[];
  className?: string;
}) {
  const n = Math.max(1, cells.length);
  const width = n * STRIP_CELL + (n - 1) * STRIP_GAP;
  const moving = cells.includes("doing") || cells.includes("waiting");
  const ref = useCanvas((ctx, _canvas, t) => {
    const still = reduced();
    ctx.clearRect(0, 0, width, STRIP_CELL);
    cells.forEach((kind, i) => {
      const x0 = i * (STRIP_CELL + STRIP_GAP);
      for (let y = 0; y < STRIP_CELL; y++)
        for (let x = 0; x < STRIP_CELL; x++) {
          const px = planCellPixel(kind, color, x, y, i, still ? null : t);
          if (!px) continue;
          ctx.globalAlpha = px.alpha;
          ctx.fillStyle = px.color;
          ctx.fillRect(x0 + x, y, 1, 1);
        }
    });
    ctx.globalAlpha = 1;
  }, moving);
  const hints = titles?.some(Boolean) ? titles : null;
  return (
    <span className={cx("ac-plan-strip", className)} role="img" aria-label={label}>
      {/* Height follows the width (the canvas's own ratio), so a long plan scales down whole. */}
      <canvas ref={ref} width={width} height={STRIP_CELL} style={{ width: width * CELL }} />
      {hints && (
        <span className="ac-plan-strip__hits" aria-hidden="true">
          {cells.map((kind, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
              key={i}
              data-cell={kind}
              title={hints[i] ?? undefined}
              style={{
                left: `${((i * (STRIP_CELL + STRIP_GAP)) / width) * 100}%`,
                width: `${(STRIP_CELL / width) * 100}%`,
              }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * A request's fuse: a pixel line along the bottom of
 * its holder (`position: relative`) that burns down to the deadline. What is
 * left (`left`, 0–1) is in the agent's tones with a flickering edge; the
 * spent part is a sparse dotted trail.
 */
export function ExpiryFuse({
  left,
  color = "sky",
  className,
}: {
  left: number;
  color?: AgentColor;
  className?: string;
}) {
  const rem = Math.max(0, Math.min(1, left));
  const ref = useCanvas((ctx, canvas, t) => {
    const w = Math.max(8, Math.round(canvas.clientWidth / CELL) || 120);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== 2) canvas.height = 2;
    const surface = token(canvas, "--raised", "#ffffff");
    const [top, bottom] = gradientOf(color);
    const pal = [
      surface,
      mixHex(surface, top, 0.14),
      mixHex(surface, top, 0.3),
      mixHex(surface, top, 0.5),
      mixHex(surface, bottom, 0.55),
      mixHex(top, bottom, 0.5),
      mixHex(top, "#ffffff", 0.5),
    ];
    const last = pal.length - 1;
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < w; x++) {
        const u = x / w;
        let f: number;
        if (u > rem) f = x % 3 === 0 ? 0.12 : 0;
        else {
          const d = rem - u;
          const edge = Math.exp(-(d * d) / 0.0006) * (0.75 + 0.25 * Math.sin(t * 9 + u * 40));
          f = Math.min(1, 0.38 + 0.1 * Math.sin(t * 1.4 - u * 18) + edge);
        }
        const s = Math.max(0, Math.min(1, f)) * last;
        const b = Math.floor(s);
        ctx.fillStyle = pal[Math.min(last, s - b > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5) ? b + 1 : b)] ?? surface;
        ctx.fillRect(x, y, 1, 1);
      }
  }, rem > 0);
  return <canvas ref={ref} className={cx("ac-work-sweep", "ac-expiry-fuse", className)} />;
}

/**
 * A thin edge of the agent's pixel sky: two rows
 * of its tones drifting slowly along the top of a card, its identity there. `muted` greys
 * it (a person is in control). Decorative.
 */
export function SkyStrip({
  color = "sky",
  muted = false,
  moving = true,
  className,
}: {
  color?: AgentColor;
  muted?: boolean;
  moving?: boolean;
  className?: string;
}) {
  const ref = useCanvas((ctx, canvas, t) => {
    const w = Math.max(8, Math.ceil(canvas.clientWidth / 3) || 120);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== 2) canvas.height = 2;
    // Its holder's own ground: inside a raised container (a dialog) the strip itself reads one step up (`--raised-2`).
    const surface = token(canvas.parentElement ?? canvas, "--raised", "#ffffff");
    const dark = document.documentElement.dataset.theme === "dark";
    const [top, bottom] = gradientOf(color);
    const pal = dark
      ? [surface, mixHex(surface, bottom, 0.45), mixHex(bottom, top, 0.35), mixHex(top, bottom, 0.2)]
      : [surface, mixHex(surface, top, 0.35), mixHex(surface, top, 0.7), top];
    const last = pal.length - 1;
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const f = Math.min(
          1,
          Math.max(0, 0.42 + 0.22 * Math.sin(u * 9 - t * 0.8) + 0.16 * Math.sin(u * 23 + t * 1.3) + (y ? -0.1 : 0.1)),
        );
        const s = f * last;
        const b = Math.floor(s);
        ctx.fillStyle = pal[Math.min(last, s - b > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5) ? b + 1 : b)] ?? surface;
        ctx.fillRect(x, y, 1, 1);
      }
  }, moving);
  return <canvas ref={ref} className={cx("ac-sky-strip", muted && "is-muted", className)} />;
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

/**
 * The agent's browser after it closed: the
 * shape of a page, never the real one, fading into the agent's tone toward the bottom. Still.
 */
export function PageSilhouette({ color = "sky", className }: { color?: AgentColor; className?: string }) {
  const ref = useCanvas((ctx, canvas) => {
    const w = Math.max(16, Math.round(canvas.clientWidth / CELL) || 66);
    const h = Math.max(10, Math.round(canvas.clientHeight / CELL) || 34);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const dark = document.documentElement.dataset.theme === "dark";
    const [top, bottom] = gradientOf(color);
    const paper = dark ? "#26252b" : "#e9e8ef";
    const ink = dark ? "#3b3946" : "#cfcdd9";
    const tint = dark ? mixHex(bottom, "#0d0d10", 0.6) : mixHex(top, "#ffffff", 0.35);
    const fade = [paper, mixHex(paper, tint, 0.5), tint];
    const inBlock = (x: number, y: number) =>
      PAGE_BLOCKS.some(([x0, y0, x1, y1]) => x >= x0 * w && x < x1 * w && y >= y0 * h && y < y1 * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const b = BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5;
        const f = (y / h) * 0.9 + 0.1;
        const s = f * (fade.length - 1);
        const i = Math.floor(s);
        ctx.fillStyle =
          f > b * 1.2 ? (fade[Math.min(fade.length - 1, s - i > b ? i + 1 : i)] ?? paper) : inBlock(x, y) ? ink : paper;
        ctx.fillRect(x, y, 1, 1);
      }
  }, false);
  // Decorative (a canvas has nothing to read; the text beside it says what the page is).
  return <canvas ref={ref} className={cx("ac-page-silhouette", className)} />;
}
