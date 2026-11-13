import { type ReactNode, useEffect, useRef, useState } from "react";
import { bodyTones } from "../agent/engine.js";
import { cx } from "../cx";
import type { AgentColor } from "./AgentLook";
import { useLocked } from "./Field";
import { reduced, token } from "./RunPixels";

export interface EffortStep<V extends string> {
  value: V;
  label: string;
}

const hash = (a: number, b: number, c: number) => {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

/**
 * Draws one frame (exported for tests and prototypes): one-pixel bars, a pixel
 * apart, climbing left to right in `steps` groups. Bars up to `pos` (in steps,
 * 0..steps) are filled in the agent's tone and breathe a pixel out of phase
 * with their neighbours, a few cells twinkle lighter; an ink column marks the
 * edge; the rest is dotted.
 */
export function drawEffort(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  opts: { pos: number; steps: number; t: number; fill: string; tip: string; ink: string; off: string },
) {
  const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio || 1 : 1);
  const W = Math.round(canvas.clientWidth * dpr);
  const H = Math.round(canvas.clientHeight * dpr);
  if (!W || !H) return;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const p = Math.max(2, Math.round(3 * dpr));
  const cols = Math.floor(W / p);
  const rows = Math.floor(H / p);
  const ox = Math.floor((W - cols * p) / 2);
  const per = cols / opts.steps;
  const tick = Math.floor(opts.t / 110);
  const ramp = (i: number) => Math.max(2, Math.round(2 + (rows - 3) * (i / (cols - 1)) ** 1.15));
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  let front = -1;
  for (let i = 0; i < cols; i += 2) {
    const step = Math.floor(i / per);
    // A wider gap between the steps.
    if (step < opts.steps - 1 && i + 2 >= Math.round((step + 1) * per)) continue;
    const on = ((i + 0.5) / cols) * opts.steps <= opts.pos;
    let h = ramp(i);
    if (on) {
      front = i;
      h = Math.min(rows, h + Math.round((Math.sin(opts.t / 380 - i * 0.45) + 1) * 0.5));
    }
    for (let r = 0; r < h; r++) {
      if (!on && r % 2) continue;
      ctx.globalAlpha = on ? 1 : 0.22;
      ctx.fillStyle = !on ? opts.off : r === h - 1 || hash(i, r, tick + i) < 0.035 ? opts.tip : opts.fill;
      ctx.fillRect(ox + i * p, H - (r + 1) * p, p, p);
    }
  }
  if (front >= 0) {
    const h = Math.min(rows, Math.max(4, ramp(front) + 2));
    ctx.globalAlpha = 1;
    ctx.fillStyle = opts.ink;
    for (let r = 0; r < h; r++) ctx.fillRect(ox + front * p, H - (r + 1) * p, p, p);
  }
  ctx.globalAlpha = 1;
}

/**
 * How much an agent thinks, as a slider: a ramp of
 * pixel bars in the agent's color fills up to the chosen step, the step names
 * under it, the label and what the step means on the line above. Drag or click
 * the ramp, click a name, or the arrow keys (`role="slider"`, one tab stop).
 * Still with reduced motion.
 */
export function EffortPixels<V extends string>({
  value,
  onValueChange,
  steps,
  label,
  hint,
  color = "sky",
  disabled: off,
  className,
}: {
  value: V;
  onValueChange: (value: V) => void;
  steps: EffortStep<V>[];
  label: string;
  /** What a step means, on the label's line; follows the finger while dragging. */
  hint?: (value: V) => ReactNode;
  color?: AgentColor;
  disabled?: boolean;
  className?: string;
}) {
  const locked = useLocked();
  const disabled = off || locked;
  const canvas = useRef<HTMLCanvasElement>(null);
  const n = steps.length;
  const index = Math.max(
    0,
    steps.findIndex((s) => s.value === value),
  );
  // While dragging: how far the fill reaches, in steps.
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag === null ? index : Math.min(n - 1, Math.max(0, Math.ceil(drag) - 1));
  const motion = useRef({ pos: index + 1, target: index + 1 });
  motion.current.target = drag ?? index + 1;
  const still = reduced();
  // Still: a new frame only when the choice moves.
  const frameKey = still ? `${index}:${drag}` : "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: frameKey repaints a still ramp when the choice moves
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext?.("2d");
    if (!c || !ctx) return;
    const tones = bodyTones(color);
    let colors = { ink: "", off: "" };
    let frame = 0;
    let raf = 0;
    const paint = (now: number) => {
      // The theme can change under us: the tokens are read again now and then.
      if (frame++ % 30 === 0) colors = { ink: token(c, "--ink", "#151514"), off: token(c, "--faint", "#6f6f6a") };
      const m = motion.current;
      m.pos = still ? m.target : m.pos + (m.target - m.pos) * 0.16;
      drawEffort(ctx, c, {
        pos: m.pos,
        steps: n,
        t: still ? 0 : now,
        fill: tones[1] ?? "#5b8def",
        tip: tones[3] ?? "#9cc0ff",
        ...colors,
      });
      if (!still) raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [color, n, still, frameKey]);

  const reach = (x: number) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r?.width) return null;
    return Math.min(n, Math.max(0.3, ((x - r.left) / r.width) * n));
  };
  const step = (by: number) => {
    const next = steps[Math.min(n - 1, Math.max(0, index + by))];
    if (next && next.value !== value) onValueChange(next.value);
  };
  const current = steps[shown];
  return (
    <div
      className={cx("ac-effort", disabled && "ac-effort--off", className)}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={n}
      aria-valuenow={shown + 1}
      aria-valuetext={current?.label}
      aria-disabled={disabled || undefined}
      onKeyDown={(e) => {
        const by = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (!by || disabled) return;
        e.preventDefault();
        step(by);
      }}
    >
      <span className="ac-effort__head">
        <span>{label}</span>
        {hint && current && <span className="ac-effort__hint">{hint(current.value)}</span>}
      </span>
      <canvas
        ref={canvas}
        className="ac-effort__ramp"
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDrag(reach(e.clientX));
        }}
        onPointerMove={(e) => {
          if (drag !== null) setDrag(reach(e.clientX) ?? drag);
        }}
        onPointerUp={() => {
          if (drag === null) return;
          const next = steps[shown];
          setDrag(null);
          if (next && next.value !== value) onValueChange(next.value);
        }}
        onPointerCancel={() => setDrag(null)}
      />
      <span
        className="ac-effort__names"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
      >
        {steps.map((s, i) => (
          <button
            key={s.value}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            data-on={i === shown || undefined}
            onClick={() => s.value !== value && onValueChange(s.value)}
          >
            {s.label}
          </button>
        ))}
      </span>
    </div>
  );
}
