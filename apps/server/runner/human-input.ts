/**
 * How an agent's pointer and keys move, so a page sees a person's rhythm and not a script's: a pointer
 * goes along a curve from where it was, at a speed that rises and falls, for a time set by the distance
 * (Fitts), and sometimes overshoots a long move a little and comes back; a button is held a moment; keys
 * come one by one with uneven gaps. The agent browser drives this (`browser.ts`). The desktop helper
 * has the same model and numbers in Python (`desktop-helper.py`, `HUMAN`), plus drags, double clicks
 * and wheel notches, which the browser leaves to `agent-browser`: keep the two in step.
 */

export const HUMAN = {
  /** A move's time: a + b * log2(distance / size + 1), kept between min and max, then ±10%. */
  fittsA: 50,
  fittsB: 100,
  minMs: 150,
  maxMs: 450,
  /** Gap between two pointer events, ± its jitter. */
  stepMs: 16,
  stepJitterMs: 4,
  /** How far the curve's control points leave the straight line: a share of the distance, capped. */
  bend: 0.2,
  bendMaxPx: 120,
  /** Hand tremor on the points between the ends. */
  jitterPx: 0.7,
  /** A move longer than this sometimes ends past the target and comes back. */
  overshootOverPx: 300,
  overshootChance: 0.3,
  overshootShare: [0.03, 0.07],
  overshootMaxPx: 28,
  /** The share of the move's time the way back takes, and its least. */
  correctShare: 0.2,
  correctMinMs: 60,
  holdMs: [40, 120],
  /** Typing: before the first key, between keys, more after a space or punctuation, and rare pauses. */
  firstKeyMs: [120, 260],
  keyMs: [38, 100],
  afterSpaceMs: [10, 40],
  afterPunctuationMs: [40, 120],
  pauseChance: 0.02,
  pauseMs: [200, 450],
  /** Text longer than this goes in at once, as a paste does: typed, it would take minutes. */
  typeMaxChars: 200,
} as const;

export interface Point {
  x: number;
  y: number;
}

/** A pointer event's place, and how long to wait after it before the next. */
export interface PathPoint extends Point {
  ms: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A seeded random source in [0, 1) (mulberry32): the same seed gives the same moves. */
export function randomSource(seed: number = Math.floor(Math.random() * 2 ** 32)): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const between = (rng: () => number, [lo = 0, hi = 0]: readonly number[]) => lo + rng() * (hi - lo);

/** Minimum-jerk position at time share t: slow start, fast middle, slow end. */
const minJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

/** How long a move of `distance` to a target `size` wide takes. */
export function moveMs(distance: number, size: number, rng: () => number): number {
  const fitts = HUMAN.fittsA + HUMAN.fittsB * Math.log2(distance / Math.max(size, 1) + 1);
  return Math.min(Math.max(fitts, HUMAN.minMs), HUMAN.maxMs) * (0.9 + 0.2 * rng());
}

function segment(
  a: Point,
  b: Point,
  ms: number,
  rng: () => number,
  bounds?: { width: number; height: number },
  straight = false,
) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const nx = d ? -dy / d : 0;
  const ny = d ? dx / d : 0;
  const side = rng() < 0.5 ? -1 : 1;
  const reach = straight ? 0 : Math.min(d * HUMAN.bend, HUMAN.bendMaxPx);
  const o1 = side * reach * (0.3 + 0.7 * rng());
  const o2 = side * reach * (0.1 + 0.6 * rng());
  const c1 = { x: a.x + dx * 0.3 + nx * o1, y: a.y + dy * 0.3 + ny * o1 };
  const c2 = { x: a.x + dx * 0.7 + nx * o2, y: a.y + dy * 0.7 + ny * o2 };
  const steps = Math.max(2, Math.round(ms / HUMAN.stepMs));
  const out: PathPoint[] = [];
  for (let i = 1; i <= steps; i++) {
    const s = minJerk(i / steps);
    const u = 1 - s;
    let x = u * u * u * a.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * b.x;
    let y = u * u * u * a.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * b.y;
    if (i < steps) {
      x += (rng() * 2 - 1) * HUMAN.jitterPx;
      y += (rng() * 2 - 1) * HUMAN.jitterPx;
    } else {
      x = b.x;
      y = b.y;
    }
    if (bounds) {
      x = Math.min(Math.max(x, 0), bounds.width - 1);
      y = Math.min(Math.max(y, 0), bounds.height - 1);
    }
    const gap = Math.max(1, ms / steps + (rng() * 2 - 1) * HUMAN.stepJitterMs);
    const p = { x: Math.round(x), y: Math.round(y), ms: Math.round(gap) };
    const last = out[out.length - 1];
    // Two events on the same pixel are one a mouse would send: their waits add up.
    if (last && last.x === p.x && last.y === p.y) last.ms += p.ms;
    else out.push(p);
  }
  return out;
}

/**
 * The pointer events from `from` to `to` (the last one exactly on `to`), each with the wait after it.
 * `size`: the target's smaller side, for the time; `bounds`: the viewport, kept inside; `straight`: no curve and no
 * overshoot, for a move inside a menu a hover opened: a line into a box stays in it once it enters.
 */
export function pointerPath(
  from: Point,
  to: Point,
  rng: () => number,
  opts: { size?: number; bounds?: { width: number; height: number }; straight?: boolean } = {},
): PathPoint[] {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d < 1) return [{ x: Math.round(to.x), y: Math.round(to.y), ms: HUMAN.stepMs }];
  const ms = moveMs(d, opts.size ?? 24, rng);
  if (!opts.straight && d > HUMAN.overshootOverPx && rng() < HUMAN.overshootChance) {
    const past = Math.min(d * between(rng, HUMAN.overshootShare), HUMAN.overshootMaxPx);
    const ux = (to.x - from.x) / d;
    const uy = (to.y - from.y) / d;
    const wobble = (rng() * 2 - 1) * 3;
    let over = { x: to.x + ux * past - uy * wobble, y: to.y + uy * past + ux * wobble };
    if (opts.bounds) {
      over = {
        x: Math.min(Math.max(over.x, 0), opts.bounds.width - 1),
        y: Math.min(Math.max(over.y, 0), opts.bounds.height - 1),
      };
    }
    const back = Math.max(ms * HUMAN.correctShare, HUMAN.correctMinMs);
    return [...segment(from, over, ms - back, rng, opts.bounds), ...segment(over, to, back, rng, opts.bounds)];
  }
  return segment(from, to, ms, rng, opts.bounds, opts.straight);
}

/** Where in `box` a person would click: near its middle, never on its edge. */
export function pointInBox(box: Box, rng: () => number): Point {
  const spread = () => (rng() + rng() + rng() - 1.5) / 1.5;
  const at = (start: number, size: number) =>
    size < 4
      ? Math.round(start + size / 2)
      : Math.min(
          Math.max(Math.round(start + size / 2 + spread() * size * 0.3), Math.ceil(start + 1)),
          Math.floor(start + size - 2),
        );
  return { x: at(box.x, box.width), y: at(box.y, box.height) };
}

/** Where a pointer nobody moved yet starts: somewhere off the target, inside the viewport. */
export function startPoint(to: Point, bounds: { width: number; height: number }, rng: () => number): Point {
  const angle = rng() * 2 * Math.PI;
  const d = 150 + rng() * 250;
  return {
    x: Math.round(Math.min(Math.max(to.x + Math.cos(angle) * d, 0), bounds.width - 1)),
    y: Math.round(Math.min(Math.max(to.y + Math.sin(angle) * d, 0), bounds.height - 1)),
  };
}

export const holdMs = (rng: () => number) => Math.round(between(rng, HUMAN.holdMs));

/** The wait before each character of `text` is typed. */
export function typingDelays(text: string, rng: () => number): number[] {
  const chars = [...text];
  return chars.map((_, i) => {
    if (i === 0) return Math.round(between(rng, HUMAN.firstKeyMs));
    const prev = chars[i - 1] as string;
    let ms = between(rng, HUMAN.keyMs);
    if (prev === " ") ms += between(rng, HUMAN.afterSpaceMs);
    if (/[.,;:!?]/.test(prev)) ms += between(rng, HUMAN.afterPunctuationMs);
    if (rng() < HUMAN.pauseChance) ms += between(rng, HUMAN.pauseMs);
    return Math.round(ms);
  });
}
