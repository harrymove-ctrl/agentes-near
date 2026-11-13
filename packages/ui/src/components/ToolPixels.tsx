import { useEffect, useRef, useState } from "react";
import { bodyTones, drawAgent, idlePose, mixHex } from "../agent/engine.js";
import { cx } from "../cx";
import type { AgentColor, AgentEyes } from "./AgentLook";
import { BAYER, reduced, token, useCanvas } from "./RunPixels";

/**
 * The pixel pieces of a connector's tool review:
 * a level swatch, a subject's strip (one square per tool, in its level's
 * tone), the proportion bar, the "needs your decision" illustration (the
 * agent and a "?" bubble), the suggestion sparkle and the happy agent of the
 * done card. Level tones are the agent's own body tones: light = só consulta,
 * deep = muda coisas, ink dither = pede aprovação, an empty outlined square =
 * desligada. No traffic-light colors. The canvases are decorative: the
 * caller gives the words (`label` on the strip and bar).
 */
export type ToolLevelKind = "read" | "write" | "approval" | "off";
export const TOOL_LEVEL_ORDER: ToolLevelKind[] = ["read", "write", "approval", "off"];

const isDark = (el: Element) => el.closest("[data-theme]")?.getAttribute("data-theme") === "dark";

/** The two tones (light, deep) of each level, for this element's theme. */
export function toolLevelTones(el: Element, color: AgentColor = "sky"): Record<ToolLevelKind, [string, string]> {
  const T = bodyTones(color);
  const t = (i: number) => T[i] ?? "#888888";
  const ink = token(el, "--ink", "#151514");
  const raised = token(el, "--raised", "#ffffff");
  // One step lighter on dark, so the deep tone still reads.
  const dark = isDark(el);
  return {
    read: dark ? [t(3), t(4)] : [t(2), t(3)],
    write: dark ? [t(1), t(2)] : [t(0), t(1)],
    approval: [ink, mixHex(ink, raised, 0.42)],
    off: [token(el, "--faint", "#76766f"), raised],
  };
}

/** A dithered block: deep at the bottom, light at the top, Bayer-mixed (canvas pixels = cells). */
function ditherRect(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  w: number,
  h: number,
  tones: [string, string],
) {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = 0.78 - 0.56 * (h > 1 ? y / (h - 1) : 0.5);
      ctx.fillStyle = k > (BAYER[((x0 + x) & 3) + (((y0 + y) & 3) << 2)] ?? 0.5) ? tones[1] : tones[0];
      ctx.fillRect(x0 + x, y0 + y, 1, 1);
    }
}

function outline(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, color: string, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, n, 1);
  ctx.fillRect(x, y + n - 1, n, 1);
  ctx.fillRect(x, y, 1, n);
  ctx.fillRect(x + n - 1, y, 1, n);
  ctx.globalAlpha = 1;
}

/** A level's swatch (legend, segmented options): 4×4 cells. */
export function ToolLevelSwatch({
  level,
  color = "sky",
  className,
}: {
  level: ToolLevelKind;
  color?: AgentColor;
  className?: string;
}) {
  const ref = useCanvas((ctx, canvas) => {
    const tones = toolLevelTones(canvas, color);
    ctx.clearRect(0, 0, 4, 4);
    if (level === "off") outline(ctx, 0, 0, 4, tones.off[0]);
    else ditherRect(ctx, 0, 0, 4, 4, tones[level]);
  }, false);
  return <canvas ref={ref} className={cx("ac-toolpx-swatch", className)} data-level={level} width={4} height={4} />;
}

/** Repaints when the element's width changes (strips and bars fill their box). */
function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/**
 * A subject's tools as squares (6 px, 2 px apart), sorted by level and
 * wrapping to rows; the strip fills its box's width.
 */
export function ToolLevelStrip({
  levels,
  color = "sky",
  label,
  className,
}: {
  levels: ToolLevelKind[];
  color?: AgentColor;
  /** What it says ("12 consultam · 3 mudam"). */
  label: string;
  className?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const width = useWidth(box);
  const sorted = [...levels].sort((a, b) => TOOL_LEVEL_ORDER.indexOf(a) - TOOL_LEVEL_ORDER.indexOf(b));
  const sq = 6;
  const gap = 2;
  const pitch = sq + gap;
  const cols = Math.max(1, Math.floor(((width || box.current?.clientWidth || 196) + gap) / pitch));
  const rows = Math.max(1, Math.ceil(sorted.length / cols));
  const W = cols * pitch - gap;
  const H = rows * pitch - gap;
  const ref = useCanvas((ctx, canvas) => {
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const tones = toolLevelTones(canvas, color);
    ctx.clearRect(0, 0, W, H);
    sorted.forEach((level, i) => {
      const x = (i % cols) * pitch;
      const y = Math.floor(i / cols) * pitch;
      if (level === "off") outline(ctx, x, y, sq, tones.off[0], 0.6);
      else ditherRect(ctx, x, y, sq, sq, tones[level]);
    });
  }, false);
  return (
    <span ref={box} className={cx("ac-toolpx-strip", className)} role="img" aria-label={label}>
      <canvas ref={ref} width={W} height={H} style={{ width: W, height: H }} />
    </span>
  );
}

/** The proportion of each level (off left out), one cell = 3 css px, a one-cell gap between levels. */
export function ToolLevelBar({
  counts,
  color = "sky",
  label,
  className,
}: {
  counts: Partial<Record<ToolLevelKind, number>>;
  color?: AgentColor;
  label: string;
  className?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const width = useWidth(box);
  const W = Math.max(30, Math.floor((width || box.current?.clientWidth || 600) / 3));
  const H = 6;
  const ref = useCanvas((ctx, canvas) => {
    if (canvas.width !== W) canvas.width = W;
    const tones = toolLevelTones(canvas, color);
    ctx.clearRect(0, 0, W, H);
    const on = (["read", "write", "approval"] as const)
      .map((l) => [l, counts[l] ?? 0] as const)
      .filter(([, n]) => n > 0);
    const total = on.reduce((a, [, n]) => a + n, 0) || 1;
    const usable = W - (on.length - 1);
    let x = 0;
    on.forEach(([l, n], i) => {
      const w = i === on.length - 1 ? W - x : Math.max(2, Math.round((n / total) * usable));
      ditherRect(ctx, x, 0, w, H, tones[l]);
      x += w + 1;
    });
  }, false);
  return (
    <span ref={box} className={cx("ac-toolpx-bar", className)} role="img" aria-label={label}>
      <canvas ref={ref} width={W} height={H} />
    </span>
  );
}

const SPARK = ["..x..", "..x..", "xxlxx", "..x..", "..x.."];

/** The suggestion mark: a small pixel sparkle in the agent's tones (sits on the reason's first line). */
export function SuggestSpark({ color = "sky", className }: { color?: AgentColor; className?: string }) {
  const ref = useCanvas((ctx) => {
    const T = bodyTones(color);
    ctx.clearRect(0, 0, 5, 5);
    SPARK.forEach((r, y) => {
      [...r].forEach((ch, x) => {
        if (ch === ".") return;
        ctx.fillStyle = (ch === "l" ? T[4] : T[1]) ?? "#888888";
        ctx.fillRect(x, y, 1, 1);
      });
    });
  }, false);
  return <canvas ref={ref} className={cx("ac-toolpx-spark", className)} width={5} height={5} />;
}

const ASK = [
  ".xxxxxxx.",
  "xxxwwwxxx",
  "xxwxxxwxx",
  "xxxxxwwxx",
  "xxxxwxxxx",
  "xxxxxxxxx",
  "xxxxwxxxx",
  ".xxxxxxx.",
  "..xx.....",
  "..x......",
];

/**
 * "Needs your decision" (22×22 cells, 2 css px each; the mission settings'
 * family): the agent bottom-left and a "?" bubble top-right, alive (it
 * blinks, the bubble bobs); still with reduced motion.
 */
export function AskPixels({
  color = "sky",
  eyes = "round",
  className,
}: {
  color?: AgentColor;
  eyes?: AgentEyes;
  className?: string;
}) {
  const N = 22;
  const ref = useCanvas((ctx, canvas, tt) => {
    const dpr = Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    const P = Math.round(2 * dpr);
    const W = N * P;
    if (canvas.width !== W) {
      canvas.width = W;
      canvas.height = W;
    }
    ctx.clearRect(0, 0, W, W);
    ctx.imageSmoothingEnabled = false;
    const still = reduced();
    const t = still ? 2 : tt;
    const tn = bodyTones(color);
    const as = 14;
    const pose = idlePose(t, 3, { every: 7, expressions: ["happy"] });
    if (still) {
      pose.blink = false;
      pose.expression = undefined;
    }
    drawAgent(ctx, 0, (N - as) * P, as * P, { color, eyes, cells: 12, pose });
    const gy = still ? 0 : Math.round((Math.sin(t * 3) + 1) / 2);
    ASK.forEach((r, y) => {
      [...r].forEach((ch, x) => {
        if (ch === ".") return;
        ctx.fillStyle = ch === "w" ? "#ffffff" : ((y < 4 ? tn[3] : tn[2]) ?? "#888888");
        ctx.fillRect((12 + x) * P, (gy + y) * P, P, P);
      });
    });
  }, true);
  return <canvas ref={ref} className={cx("ac-toolpx-ask", className)} width={44} height={44} />;
}

/** The done card's agent: happy, idle, alive (still with reduced motion). Its size comes from CSS (64px). */
export function HappyAgent({
  color = "sky",
  eyes = "round",
  size = 64,
  className,
}: {
  color?: AgentColor;
  eyes?: AgentEyes;
  size?: number;
  className?: string;
}) {
  const t0 = useRef(typeof performance !== "undefined" ? performance.now() / 1000 : 0);
  const ref = useCanvas((ctx, canvas, t) => {
    const dpr = Math.min(2, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
    const s = Math.round((canvas.clientWidth || size) * dpr);
    if (canvas.width !== s) {
      canvas.width = s;
      canvas.height = s;
    }
    ctx.clearRect(0, 0, s, s);
    const pose = idlePose(t - t0.current, 3, { expressions: [] });
    pose.expression = "happy";
    pose.blink = false;
    const inner = s * 0.82;
    drawAgent(ctx, (s - inner) / 2, s - inner - s * 0.04, inner, { color, eyes, pose, cells: 16 });
  }, true);
  return <canvas ref={ref} className={cx("ac-toolpx-agent", className)} width={size} height={size} />;
}
