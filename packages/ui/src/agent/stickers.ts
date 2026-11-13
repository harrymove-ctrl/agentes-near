/**
 * The agents' stickers (ADR 0091): each agent of a workspace has one per mood, drawn from its own look by the
 * agent engine (engine.js), so nothing is uploaded and a new agent has its stickers at once. A sticker is a moment
 * of a loop: `drawSticker` draws the frame at time `t` (seconds) on a square of side `S` (canvas pixels).
 *
 * It draws with the engine's `Ctx2D` subset only (no clearing, no global alpha): the phone app replays the same
 * drawing on Skia. The caller clears the square first.
 */
import {
  type AgentColorName,
  type Ctx2D,
  drawAccessory,
  drawAgent,
  type EyeStyle,
  gradientOf,
  type Pose,
  rgbOf,
} from "./engine.js";

/** The moods, in the picker's order (the server's `STICKER_MOODS`). */
export const STICKER_MOODS = ["celebrate", "love", "deal", "thinking", "wow", "dizzy", "wave"] as const;
export type StickerMood = (typeof STICKER_MOODS)[number];

/**
 * One wave of the hand: the sticker waves this long, then rests as long with the hand up. The right hand's hello on a
 * person's first visit to its DM (ADR 0137 §6) plays one wave and stops on its still frame.
 */
export const WAVE_SECONDS = 1.6;

/** An agent's look as stored (unknown values draw the default look). */
export interface StickerLook {
  color?: string;
  eyes?: string;
  accessory?: string;
}

/** The frame shown when nothing moves (reduced motion): a moment where every mood reads at a glance. */
export const STICKER_STILL_T = 0.6;

/** Small pixel props ("1" = a cell), drawn in the agent's own tones. */
const PROPS = {
  heart: ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"],
  question: ["01110", "10001", "00010", "00100", "00000", "00100"],
  bang: ["1", "1", "1", "1", "0", "1"],
  star: ["00100", "01110", "11111", "01110", "01010"],
  check: ["0000001", "0000011", "1000110", "1101100", "0111000", "0010000"],
  hand: ["0010100", "0010101", "1010101", "1010101", "1111111", "0111111", "0011110"],
} as const;

function pixels(ctx: Ctx2D, map: readonly string[], x: number, y: number, cell: number, color: string) {
  ctx.fillStyle = color;
  const side = Math.ceil(cell);
  map.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === "1") ctx.fillRect(Math.round(x + c * cell), Math.round(y + r * cell), side, side);
    }
  });
}

/** A hex tone at `alpha` (0..1), for a prop that fades (the hearts rising). */
const faded = (hex: string, alpha: number) => {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
};

/** A seed from an id or a name, so stickers side by side don't move in step (0..10). */
export function stickerSeed(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 1000) / 100;
}

/**
 * One frame of a sticker: the agent in its mood (pose and face), its shadow on the floor and the mood's pixel props
 * in the agent's tones. `S` is the square's side in canvas pixels; `t` seconds (a seed added keeps neighbors apart).
 */
export function drawSticker(ctx: Ctx2D, look: StickerLook, mood: StickerMood, t: number, S: number): void {
  const [c1, c2] = gradientOf(look.color);
  const s = Math.round(S * 0.56);
  const cell = S / 64;
  let bounce = 0;
  let ox = 0;
  let pose: Pose = {};
  // The wave's rock in pixel steps (-1, 0, 1): none at the still frame and while it rests, so both draw the same.
  const lean = mood === "wave" && t % (WAVE_SECONDS * 2) < WAVE_SECONDS ? Math.round(Math.sin(t * Math.PI * 5)) : 0;
  switch (mood) {
    case "celebrate": {
      const k = Math.abs(Math.sin(t * 5));
      bounce = k * S * 0.12;
      pose = { expression: "star", squash: k < 0.15 ? 1.4 : -0.5 };
      break;
    }
    case "love":
      pose = { expression: "heart", turn: [Math.sin(t * 2) * 0.5, 0], squash: Math.sin(t * 4) * 0.4 };
      break;
    case "deal":
      pose = { expression: "happy", turn: [0, Math.sin(t * 6) * 0.7] };
      break;
    case "thinking":
      pose = { look: [0.06, -0.06], turn: [0.6 + Math.sin(t) * 0.15, -0.5], squash: Math.sin(t * 1.5) * 0.3 };
      break;
    case "wow":
      pose = { expression: "surprised", squash: -1 };
      ox = Math.sin(t * 38) * S * 0.012;
      bounce = S * 0.03;
      break;
    case "dizzy":
      pose = { expression: "dizzy", turn: [Math.cos(t * 3) * 0.8, Math.sin(t * 3) * 0.4] };
      break;
    case "wave":
      pose = { expression: "happy", turn: [0.2 + lean * 0.15, 0] };
      break;
  }
  const x0 = Math.round((S - s) / 2 + ox);
  const y0 = Math.round(S - s - S * 0.06 - bounce);
  // Its shadow on the floor, smaller while it is up in the air.
  ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
  ctx.beginPath();
  ctx.ellipse(S / 2, S - S * 0.055, s * 0.42 * (1 - bounce / S), S * 0.025, 0, 0, Math.PI * 2);
  ctx.fill();
  const accessory = look.accessory && look.accessory !== "none" ? look.accessory : undefined;
  drawAgent(ctx, x0, y0, s, {
    color: look.color as AgentColorName | undefined,
    eyes: look.eyes as EyeStyle | undefined,
    pose,
    after: accessory ? (g, side, frame) => drawAccessory(g, side, accessory, frame, t) : undefined,
  });
  switch (mood) {
    case "celebrate":
      // Confetti of its two tones going round.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + t;
        const r = S * (0.3 + 0.12 * ((t * 1.3 + i * 0.37) % 1));
        ctx.fillStyle = i % 2 ? c1 : c2;
        const side = Math.ceil(cell * 2.4);
        ctx.fillRect(Math.round(S / 2 + Math.cos(a) * r), Math.round(S * 0.38 + Math.sin(a) * r * 0.6), side, side);
      }
      break;
    case "love":
      // Three hearts rising and fading.
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.5 + i / 3) % 1;
        const x = S * (0.62 + i * 0.1) + Math.sin(t * 3 + i) * cell * 3;
        pixels(ctx, PROPS.heart, x, S * 0.4 - p * S * 0.35, cell * 1.6, faded(i % 2 ? c1 : c2, 1 - p));
      }
      break;
    case "deal":
      pixels(ctx, PROPS.check, S * 0.72, S * 0.16, cell * 2.2, c2);
      break;
    case "thinking":
      pixels(ctx, PROPS.question, S * 0.7, S * 0.08 + Math.sin(t * 2) * cell * 2, cell * 2.4, c2);
      break;
    case "wow":
      pixels(ctx, PROPS.bang, S * 0.8, S * 0.12, cell * 2.6, c2);
      break;
    case "dizzy":
      // Stars going round its head.
      for (let i = 0; i < 3; i++) {
        const a = t * 3 + i * 2.09;
        const x = S / 2 + Math.cos(a) * S * 0.26 - cell * 4;
        pixels(ctx, PROPS.star, x, S * 0.2 + Math.sin(a) * S * 0.06, cell * 1.5, i % 2 ? c1 : c2);
      }
      break;
    case "wave": {
      // Its hand up beside it, the fingers leaning further than the palm.
      const hand = cell * 2;
      PROPS.hand.forEach((row, r) => {
        pixels(ctx, [row], S * 0.74 + lean * Math.max(0, 3 - r) * hand * 0.5, S * 0.22 + r * hand, hand, c2);
      });
      break;
    }
  }
}
