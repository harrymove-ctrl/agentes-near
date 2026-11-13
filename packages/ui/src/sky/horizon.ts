import { gradientOf, mixHex } from "../agent/engine.js";
import type { AgentColor } from "../components/AgentLook";

/**
 * A card's horizon: the sky's light tones in a low dither at the foot of a card with room to spare, the same on the
 * web (`CardHorizon`, a canvas) and the phone (Skia). Pure, so both draw it from one shape.
 */

/** Points per sky pixel, as the app's other skies. */
export const HORIZON_CELL = 4;
/** Below this much room under the content, no horizon: a sliver reads as a smudge. */
const MIN_ROOM = 72;
/** The horizon's top height: it stays low, a foot, never the card's main thing. */
const MAX_HEIGHT = 112;
/** Kept between the content's last line and the horizon's crest. */
const GAP = 24;
/** The crest's wave, in page points: neighbouring cards continue one wave instead of repeating it. */
export const HORIZON_WAVE = 528;

/** How far into the color's light end each step goes, past the card's own ground (light and dark themes). */
const STEPS_LIGHT = [0.12, 0.24, 0.36, 0.5];
const STEPS_DARK = [0.1, 0.19, 0.28, 0.36];

/** The crest at page position `u` (in HORIZON_WAVE units), as a fraction of the horizon's height from its top. */
export function horizonCrest(u: number): number {
  return 0.32 + 0.1 * Math.sin(u * 5.2 + 1.2) + 0.03 * Math.sin(u * 13 + 0.4);
}

/**
 * The horizon's height for this much room under the content: 0 when there's too little. `minRoom`: a small card
 * (the phone's home strip) asks for less.
 */
export function horizonHeight(room: number, minRoom = MIN_ROOM): number {
  if (room < minRoom) return 0;
  return Math.min(MAX_HEIGHT, Math.round(room - GAP));
}

/** From the card's ground into the color's light tones only (lighter than the sidebar's horizon). */
export function horizonTones(color: AgentColor, surface: string, dark: boolean): string[] {
  const [top] = gradientOf(color);
  return [surface, ...(dark ? STEPS_DARK : STEPS_LIGHT).map((k) => mixHex(surface, top, k))];
}
