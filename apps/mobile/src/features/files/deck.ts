/**
 * A message's pictures as a deck: every card is a pure function of one number, the deck's `place`, which the pan
 * moves on the UI thread (worklets). `place` runs past the ends: whole numbers are a picture on top and the deck
 * loops. A card leaving the top goes out past the left side and comes back in behind the others, so a drag to the
 * right brings the last one back the same way.
 */

export interface DeckCard {
  x: number;
  y: number;
  rotate: number;
  scale: number;
  opacity: number;
  z: number;
}

/** The room above the top card for the ones peeking out behind it. */
export const DECK_RISE = 12;
/** A drag this many card widths long moves the deck by one (the top card keeps up with the finger). */
export const DECK_DRAG = 3.1;
/** Past this speed (points per second) a flick turns the deck, however short. */
const FLICK = 420;
/** Past this share of a turn a drag turns the deck when let go. */
const TURN = 0.035;
/** Far enough past the side for a card to leave the screen. */
const OUT = 1.12;

/** Where a card rests, by how many are above it; the last slot has already faded out. */
const SLOTS = [
  { x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 },
  { x: -7, y: -9, rotate: -3.4, scale: 0.975, opacity: 1 },
  { x: 9, y: -6, rotate: 2.8, scale: 0.95, opacity: 1 },
  { x: 0, y: -2, rotate: 0, scale: 0.92, opacity: 0 },
];

const lerp = (a: number, b: number, k: number) => {
  "worklet";
  return a + (b - a) * k;
};

function slotAt(depth: number): Omit<DeckCard, "z"> {
  "worklet";
  const last = SLOTS.length - 1;
  const i = Math.min(last, Math.floor(depth));
  const k = Math.min(1, depth - i);
  const a = SLOTS[i] ?? { x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 };
  const b = SLOTS[Math.min(last, i + 1)] ?? a;
  return {
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
    rotate: lerp(a.rotate, b.rotate, k),
    scale: lerp(a.scale, b.scale, k),
    opacity: lerp(a.opacity, b.opacity, k),
  };
}

/** `place` within 0..count. */
export function wrapPlace(place: number, count: number): number {
  "worklet";
  return ((place % count) + count) % count;
}

/** The picture on top. */
export function deckIndex(place: number, count: number): number {
  "worklet";
  return wrapPlace(Math.round(place), count);
}

export function deckCard(index: number, place: number, count: number, width: number): DeckCard {
  "worklet";
  let depth = wrapPlace(index - place, count);
  // The last stretch of the loop is the card leaving the top: -1 (back behind the others) to 0 (on top).
  if (depth > count - 1) depth -= count;
  if (depth >= 0) return { ...slotAt(depth), z: 50 - Math.round(depth * 10) };
  const t = -depth;
  const arc = Math.sin(Math.PI * t);
  const rear = slotAt(count - 1);
  return {
    x: -width * OUT * arc + rear.x * t,
    y: rear.y * t,
    rotate: -15 * arc + rear.rotate * t,
    scale: lerp(1, rear.scale, t),
    opacity: t < 0.5 ? 1 : lerp(1, rear.opacity, (t - 0.5) * 2),
    // It changes layers at the far end of the arc, off the screen.
    z: t < 0.5 ? 90 : 1,
  };
}

/** Where the deck settles when let go: the next or the last picture after a flick or a drag, else back. */
export function deckTarget(from: number, place: number, velocityX: number): number {
  "worklet";
  const start = Math.round(from);
  if (Math.abs(velocityX) > FLICK) return start - Math.sign(velocityX);
  const moved = place - from;
  return Math.abs(moved) > TURN ? start + Math.sign(moved) : start;
}
