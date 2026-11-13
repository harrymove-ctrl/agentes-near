import type { Ctx2D } from "@agenteschat/ui/agent/engine";

/**
 * The engine's 2D context subset (engine.d.ts `Ctx2D`), recorded as plain commands so a Skia canvas can
 * replay them (./skia-ctx.ts). Pure TypeScript: no React Native, no Skia, so it runs in `bun test`.
 *
 * Paths are kept in user space and drawn under the transform current at `fill`/`stroke`/`clip` time
 * (the engine never changes the transform in the middle of a path). `ellipse` ignores `rotation`
 * (the engine always passes 0).
 */
export type { Ctx2D };

export type PathCmd =
  | { k: "M"; x: number; y: number }
  | { k: "L"; x: number; y: number }
  | { k: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { k: "Q"; x1: number; y1: number; x: number; y: number }
  | { k: "Z" }
  /** Rounded rectangle with radii [top-left, top-right, bottom-right, bottom-left]. */
  | { k: "RR"; x: number; y: number; w: number; h: number; r: [number, number, number, number] }
  /** Arc of the ellipse inside (x, y, w, h), angles in degrees (Skia's arcToOval). */
  | { k: "A"; x: number; y: number; w: number; h: number; start: number; sweep: number };

export type DrawCmd =
  | { op: "save" }
  | { op: "restore" }
  | { op: "translate"; x: number; y: number }
  | { op: "scale"; x: number; y: number }
  | { op: "fillRect"; x: number; y: number; w: number; h: number; color: string }
  | { op: "fill"; path: PathCmd[]; color: string }
  | { op: "stroke"; path: PathCmd[]; color: string; width: number; cap: CanvasLineCap; join: CanvasLineJoin }
  | { op: "clip"; path: PathCmd[] };

/** After `compile`: runs of `fillRect` become one op per color (one Skia path each). */
export type CompiledOp = Exclude<DrawCmd, { op: "fillRect" }> | { op: "rects"; color: string; rects: number[] };

const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;

/** Canvas `ellipse` start/end/anticlockwise → Skia start and sweep (degrees). */
export function arcSweep(start: number, end: number, anticlockwise = false): { start: number; sweep: number } {
  let sweep: number;
  if (!anticlockwise) {
    const d = end - start;
    sweep = d >= TAU ? TAU : ((d % TAU) + TAU) % TAU;
  } else {
    const d = start - end;
    sweep = d >= TAU ? -TAU : -(((d % TAU) + TAU) % TAU);
  }
  return { start: start * DEG, sweep: sweep * DEG };
}

/** Canvas `roundRect` radii (a number or a list of 1–4 numbers) → [tl, tr, br, bl], clamped to the box. */
export function cornerRadii(radii: unknown, w: number, h: number): [number, number, number, number] {
  const list = Array.isArray(radii) ? radii : [radii ?? 0];
  const n = list.map((r) => (typeof r === "number" ? r : 0));
  const [a = 0, b = a, c = a, d = b] = n;
  let tl = a;
  let tr = b;
  let br = c;
  let bl = d;
  if (n.length === 3) {
    tl = a;
    tr = b;
    bl = b;
    br = c;
  }
  const limit = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const clamp = (r: number) => Math.max(0, Math.min(r, limit));
  return [clamp(tl), clamp(tr), clamp(br), clamp(bl)];
}

const colorOf = (style: unknown) => (typeof style === "string" ? style : "#000000");

/** A recording 2D context: hand it to `drawAgent`/`drawAccessory`, then read `commands`. */
export class RecordingContext {
  readonly commands: DrawCmd[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000000";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  private path: PathCmd[] = [];
  private readonly stack: {
    fillStyle: RecordingContext["fillStyle"];
    strokeStyle: RecordingContext["strokeStyle"];
    lineWidth: number;
    lineCap: CanvasLineCap;
    lineJoin: CanvasLineJoin;
  }[] = [];

  save(): void {
    this.stack.push({
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
    });
    this.commands.push({ op: "save" });
  }

  restore(): void {
    const s = this.stack.pop();
    if (s) {
      this.fillStyle = s.fillStyle;
      this.strokeStyle = s.strokeStyle;
      this.lineWidth = s.lineWidth;
      this.lineCap = s.lineCap;
      this.lineJoin = s.lineJoin;
    }
    this.commands.push({ op: "restore" });
  }

  translate(x: number, y: number): void {
    this.commands.push({ op: "translate", x, y });
  }

  scale(x: number, y: number): void {
    this.commands.push({ op: "scale", x, y });
  }

  beginPath(): void {
    this.path = [];
  }

  closePath(): void {
    this.path.push({ k: "Z" });
  }

  moveTo(x: number, y: number): void {
    this.path.push({ k: "M", x, y });
  }

  lineTo(x: number, y: number): void {
    this.path.push({ k: "L", x, y });
  }

  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.path.push({ k: "C", x1, y1, x2, y2, x, y });
  }

  quadraticCurveTo(x1: number, y1: number, x: number, y: number): void {
    this.path.push({ k: "Q", x1, y1, x, y });
  }

  roundRect(x: number, y: number, w: number, h: number, radii?: unknown): void {
    this.path.push({ k: "RR", x, y, w, h, r: cornerRadii(radii, w, h) });
  }

  ellipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    _rotation: number,
    start: number,
    end: number,
    anticlockwise?: boolean,
  ): void {
    const arc = arcSweep(start, end, anticlockwise);
    this.path.push({ k: "A", x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2, start: arc.start, sweep: arc.sweep });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.commands.push({ op: "fillRect", x, y, w, h, color: colorOf(this.fillStyle) });
  }

  fill(..._args: unknown[]): void {
    this.commands.push({ op: "fill", path: [...this.path], color: colorOf(this.fillStyle) });
  }

  stroke(..._args: unknown[]): void {
    this.commands.push({
      op: "stroke",
      path: [...this.path],
      color: colorOf(this.strokeStyle),
      width: this.lineWidth,
      cap: this.lineCap,
      join: this.lineJoin,
    });
  }

  clip(..._args: unknown[]): void {
    this.commands.push({ op: "clip", path: [...this.path] });
  }
}

/** The recorder as the engine's context type (the class covers every member of the Pick). */
export const asCtx = (ctx: RecordingContext): Ctx2D => ctx as unknown as Ctx2D;

/**
 * Groups each run of consecutive `fillRect` (the dither cells, an accessory's pixels) by color, so the
 * replay draws one path per tone instead of hundreds of rectangles. Colors keep their first-seen order.
 */
export function compile(commands: readonly DrawCmd[]): CompiledOp[] {
  const out: CompiledOp[] = [];
  let run: Map<string, number[]> | null = null;
  const flush = () => {
    if (!run) return;
    for (const [color, rects] of run) out.push({ op: "rects", color, rects });
    run = null;
  };
  for (const c of commands) {
    if (c.op === "fillRect") {
      if (!run) run = new Map();
      let list = run.get(c.color);
      if (!list) {
        list = [];
        run.set(c.color, list);
      }
      list.push(c.x, c.y, c.w, c.h);
    } else {
      flush();
      out.push(c);
    }
  }
  flush();
  return out;
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ""));

/** Flat [x, y, w, h, …] → one SVG path string of closed rectangles. */
export function rectsToSvg(rects: readonly number[]): string {
  let d = "";
  for (let i = 0; i + 3 < rects.length; i += 4) {
    const x = rects[i] as number;
    const y = rects[i + 1] as number;
    const w = rects[i + 2] as number;
    const h = rects[i + 3] as number;
    d += `M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}Z`;
  }
  return d;
}
