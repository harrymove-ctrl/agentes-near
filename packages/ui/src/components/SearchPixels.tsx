import {
  ACCESSORY_PALETTE,
  bodyTones,
  drawAgent,
  drawEyes,
  EYE_X,
  eyeShapes,
  mixHex,
  toneAt,
} from "../agent/engine.js";
import { cx } from "../cx";
import { reduced, useCanvas } from "./RunPixels";

/**
 * The magnifier on the agent's grid: o the glass, * its shine, the rest letters of the accessories' palette (the same
 * in both themes). The dark rim stays on the body and the handle is a gray that reads on either surface.
 */
const GLASS = [
  "..KKK......",
  ".KoooK.....",
  "K*ooooK....",
  "K*ooooK....",
  "KoooooK....",
  "KoooooK....",
  ".KoooKK....",
  "..KKKKMg...",
  ".......Mg..",
  "........Mg.",
  ".........Mg",
];
const PANES = GLASS.flatMap((row, y) =>
  [...row].flatMap((ch, x) => (ch === "o" || ch === "*" ? [[x, y] as const] : [])),
);
/** The scene in cells: the agent (16 cells, one dither cell each) in the middle, the glass over its right eye. */
const COLS = 22;
const ROWS = 16;
const AGENT_X = 3;
/** Where the glass's first row starts on the agent's grid. */
const GLASS_AT = [8, 3] as const;
/** How much bigger the eye looks through the glass (wider more than taller, so it fits). */
const ZOOM = [1.5, 1.15] as const;
/** CSS pixels per cell. */
const CELL = 4;

/**
 * Nothing found, drawn: the sky agent from the engine holding a pixel magnifier over its right eye, which looks big
 * through the glass, the body behind it in bigger dither cells. It looks around and blinks, and the glass bobs a
 * cell. Still with reduced motion. Every cell lands on whole device pixels. Decorative: the caller says it in words.
 */
export function AgentSearching({ className }: { className?: string }) {
  const ref = useCanvas((ctx, canvas, tt) => {
    const dpr = (typeof devicePixelRatio === "number" && devicePixelRatio) || 1;
    const P = Math.max(1, Math.round(CELL * dpr));
    if (canvas.width !== COLS * P) {
      canvas.width = COLS * P;
      canvas.height = ROWS * P;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const still = reduced();
    const t = still ? 0 : tt;
    const bob = still ? 0 : Math.round((Math.sin(t * 1.4) + 1) / 2);
    const pose = {
      blink: !still && t % 4.3 > 4.15,
      look: [still ? 0 : 0.015 * Math.sin(t * 0.9), 0] as [number, number],
    };
    const s = 16 * P;
    const tones = bodyTones("sky");
    // No squash or turn: the body's cells stay on the canvas grid.
    drawAgent(ctx, AGENT_X * P, 0, s, { color: "sky", cells: 16, pose, withEyes: false });
    const [left, right] = eyeShapes("round", pose);
    if (left) drawEyes(ctx, AGENT_X * P, 0, s, [left]);

    const [gx, gy] = [GLASS_AT[0], GLASS_AT[1] + bob];
    const cell = (x: number, y: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect((AGENT_X + gx + x) * P, (gy + y) * P, P, P);
    };
    // Behind the glass, the body at half its cells (each one twice as big), a touch lighter.
    for (const [x, y] of PANES)
      cell(x, y, mixHex(tones[toneAt((gx + x) >> 1, (gy + y) >> 1, 8)] ?? "#8cc3ff", "#ffffff", 0.18));
    if (right) {
      ctx.save();
      ctx.beginPath();
      for (const [x, y] of PANES) ctx.rect((AGENT_X + gx + x) * P, (gy + y) * P, P, P);
      ctx.clip();
      const w = right.w * ZOOM[0];
      const h = right.h * ZOOM[1];
      // In the middle of the glass, moved as the eye looks around (enlarged too).
      const mx = (gx + 3.5) / 16 + (right.x + right.w / 2 - EYE_X[1]) * ZOOM[0];
      drawEyes(ctx, AGENT_X * P, 0, s, [{ ...right, x: mx - w / 2, y: (gy + 4) / 16 - h / 2, w, h }]);
      ctx.restore();
    }
    const shine = mixHex(tones[4] ?? "#c6e1ff", "#ffffff", 0.6);
    GLASS.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        const color = ch === "*" ? shine : ACCESSORY_PALETTE[ch];
        if (color) cell(x, y, color);
      });
    });
  }, true);
  return (
    <canvas
      ref={ref}
      className={cx("ac-searchpx", className)}
      width={COLS * CELL}
      height={ROWS * CELL}
      style={{ width: COLS * CELL, height: ROWS * CELL }}
    />
  );
}
