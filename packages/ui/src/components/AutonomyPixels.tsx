import { bodyTones, drawAgent, idlePose, mixHex, type Pose } from "../agent/engine.js";
import { cx } from "../cx";
import type { AgentColor, AgentEyes } from "./AgentLook";
import { reduced, token, useCanvas } from "./RunPixels";

/**
 * How much a mission asks, drawn: the mission's
 * agent from the engine, bottom left, with a glyph in its own tones: a
 * speech bubble with "?" (asks always), a shield with a shine (asks only
 * what is risky), a bolt with a motion trail (doesn't ask). 22 × 22 cells of
 * 2 px. `alive`: blinks and the glyph moves; otherwise still (and with
 * reduced motion always still). Decorative: the row says it in words.
 */
export type AutonomyKind = "always" | "low_risk_auto" | "never";

const GLYPH: Record<AutonomyKind, string[]> = {
  always: [
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
  ],
  low_risk_auto: [
    "ddddddddd",
    "dllllmmmd",
    "dlllmmmmd",
    "dllmmmmmd",
    "dlmmmmmmd",
    ".dmmmmmd.",
    ".dmmmmmd.",
    "..dmmmd..",
    "...dmd...",
    "....d....",
  ],
  never: ["....xxx", "...xxx.", "..xxx..", ".xxx...", "xxxxxxx", "...xxx.", "..xxx..", ".xxx...", "xxx...."],
};
const N = 22;

/** Draws one frame (exported for tests and prototypes). */
export function drawAutonomy(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  opts: { kind: AutonomyKind; color: AgentColor; eyes: AgentEyes; alive: boolean; t: number },
) {
  const dpr = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio || 1 : 1);
  const P = Math.round(2 * dpr);
  const W = N * P;
  if (canvas.width !== W) {
    canvas.width = W;
    canvas.height = W;
  }
  ctx.clearRect(0, 0, W, W);
  ctx.imageSmoothingEnabled = false;
  const { kind, color, eyes } = opts;
  const on = opts.alive && !reduced();
  const t = on ? opts.t : 2;
  const tn = bodyTones(color);
  const tone = (i: number) => tn[i] ?? "#888888";
  const cell = (x: number, y: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x * P, y * P, P, P);
  };
  // The agent: bottom left (shifted right for the bolt's trail).
  const ax = kind === "never" ? 5 : 0;
  const as = 14;
  const pose: Pose = idlePose(t, 3, { every: on ? 7 : 999, active: false, expressions: on ? ["happy"] : [] });
  if (!on) {
    pose.blink = false;
    pose.expression = undefined;
  }
  if (kind === "never" && on) pose.turn = [0.35, 0];
  drawAgent(ctx, ax * P, (N - as) * P, as * P, { color, eyes, cells: 12, pose });
  const g = GLYPH[kind];
  if (kind === "always") {
    const bob = on ? Math.round((Math.sin(t * 3) + 1) / 2) : 0;
    g.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === "x") cell(12 + x, bob + y, y < 4 ? tone(3) : tone(2));
        else if (ch === "w") cell(12 + x, bob + y, "#ffffff");
      });
    });
  } else if (kind === "low_risk_auto") {
    const shine = on ? ((t * 0.9) % 2.4) * 12 - 6 : -99;
    g.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === ".") return;
        let c = ch === "d" ? tone(0) : ch === "l" ? tone(4) : tone(2);
        if (ch !== "d" && Math.abs(x + y - shine) < 1) c = mixHex(c, "#ffffff", 0.7);
        cell(12 + x, y, c);
      });
    });
  } else {
    const flash = on ? Math.sin(t * 9) > -0.3 : true;
    g.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === "x") cell(15 + x, y, flash ? tone(3) : tone(2));
      });
    });
    // The motion trail: three dashes left of the agent, flickering in turn.
    const raised = token(canvas, "--raised", "#ffffff");
    (
      [
        [12, 4],
        [15, 5],
        [18, 3],
      ] as const
    ).forEach(([y, len], i) => {
      const lit = on ? (Math.floor(t * 6) + i) % 3 !== 0 : true;
      for (let x = 0; x < len; x++)
        cell(5 - len + x, y, x === len - 1 ? tone(2) : lit ? tone(3) : mixHex(tone(3), raised, 0.6));
    });
  }
}

export function AutonomyPixels({
  kind,
  color = "sky",
  eyes = "round",
  alive = false,
  size = 44,
  className,
}: {
  kind: AutonomyKind;
  color?: AgentColor;
  eyes?: AgentEyes;
  /** The chosen one: it blinks and its glyph moves. */
  alive?: boolean;
  size?: number;
  className?: string;
}) {
  const ref = useCanvas((ctx, canvas, t) => {
    try {
      drawAutonomy(ctx, canvas, { kind, color, eyes, alive, t });
    } catch {
      // A canvas without 2D drawing (tests): nothing to show.
    }
  }, alive);
  return (
    <span
      className={cx("ac-autonomy", className)}
      data-kind={kind}
      data-alive={alive || undefined}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <canvas ref={ref} style={{ width: size, height: size }} />
    </span>
  );
}
