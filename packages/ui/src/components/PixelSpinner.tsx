import { type CSSProperties, useEffect, useRef } from "react";
import { bodyTones } from "../agent/engine.js";
import { cx } from "../cx";
import type { AgentColor } from "./AgentLook";

/**
 * Our working indicator, the pixel orbit: a 3×3 grid where one lit cell walks the ring with a fading
 * trail. Tied to an agent it is drawn in that agent's own `bodyTones`;
 * otherwise in the text color around it (ink, the same tones as the words).
 * Still under prefers-reduced-motion. Decorative unless `label` is given:
 * the chip or button next to it says what is happening.
 */
export type PixelSpinnerSize = 14 | 16 | 24 | 32;

export interface PixelSpinnerProps {
  /** 14 (chips, rows), 16 (buttons), 24, 32. */
  size?: PixelSpinnerSize;
  /** The agent's color when the work is an agent's; neutral ink otherwise. */
  color?: AgentColor;
  /** Accessible name; without it the spinner is `aria-hidden`. */
  label?: string;
  className?: string;
}

/** The ring, clockwise from the top-left cell (the center stays dark). */
export const ORBIT_RING = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [2, 2],
  [1, 2],
  [0, 2],
  [0, 1],
] as const;
/** One step of the lit cell (110 ms). */
export const ORBIT_STEP_MS = 110;
/** Neutral trail: the lit cell, two fading ones, then the dim ring. */
const INK_ALPHA = [1, 0.62, 0.38, 0.16] as const;

/** Which shade each ring cell takes when the lit cell is at `head` (0 lit, 1 and 2 the trail, 3 the rest). */
export function orbitShades(head: number): number[] {
  const n = ORBIT_RING.length;
  return ORBIT_RING.map((_, i) => Math.min(3, (((head - i) % n) + n) % n));
}

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches === true;

// One clock for every spinner on the page (not one timer each).
const draws = new Set<(head: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let head = 0;
function join(draw: (head: number) => void) {
  draws.add(draw);
  draw(head);
  if (!timer && !reduced()) {
    timer = setInterval(() => {
      head = (head + 1) % ORBIT_RING.length;
      for (const d of draws) d(head);
    }, ORBIT_STEP_MS);
  }
  return () => {
    draws.delete(draw);
    if (draws.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function paint(canvas: HTMLCanvasElement, color: AgentColor | undefined, at: number) {
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return;
  const w = canvas.width;
  const cell = w / 3;
  const gap = Math.max(1, Math.round(cell * 0.14));
  const tones = color ? bodyTones(color) : null;
  const ink = tones ? "" : getComputedStyle(canvas).color || "#151514";
  ctx.clearRect(0, 0, w, w);
  orbitShades(at).forEach((shade, i) => {
    const [x, y] = ORBIT_RING[i] ?? [0, 0];
    if (tones) {
      ctx.fillStyle = (shade === 3 ? tones[3] : tones[shade]) ?? "#888888";
      ctx.globalAlpha = shade === 3 ? 0.35 : 1;
    } else {
      ctx.fillStyle = ink;
      ctx.globalAlpha = INK_ALPHA[shade] ?? 0.16;
    }
    const x0 = Math.round(x * cell + gap / 2);
    const y0 = Math.round(y * cell + gap / 2);
    ctx.fillRect(x0, y0, Math.round((x + 1) * cell - gap / 2) - x0, Math.round((y + 1) * cell - gap / 2) - y0);
  });
  ctx.globalAlpha = 1;
}

export function PixelSpinner({ size = 16, color, label, className }: PixelSpinnerProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    return join((at) => paint(canvas, color, at));
  }, [size, color]);
  return (
    <canvas
      ref={ref}
      className={cx("ac-pixspin", className)}
      style={{ width: size, height: size, "--mark-size": `${size}px` } as CSSProperties}
      data-color={color}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
