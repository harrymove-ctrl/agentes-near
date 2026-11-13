/**
 * Scroll math for the cover headers (Início's sky, the agent's sky): parallax while scrolling up, a
 * stretch on pull-down overscroll, and fades. Pure worklets (they run on the UI thread from Reanimated's
 * scroll handler, and in the unit tests as plain functions). `y` is the scroll distance from rest:
 * 0 at rest, positive scrolled up, negative pulled down.
 */

/** How much of the scroll the cover keeps up with: 0.5 moves it at half the content's speed. */
export const PARALLAX = 0.5;

/** 0 → 1 as `y` goes from `from` to `to`, clamped. */
export function progress(y: number, from: number, to: number): number {
  "worklet";
  if (to === from) return y >= to ? 1 : 0;
  const k = (y - from) / (to - from);
  return k < 0 ? 0 : k > 1 ? 1 : k;
}

/**
 * The cover's transform for a scroll `y`, with `height` the cover's own height. Scrolled up: it lags
 * behind the content (moves down by `y * factor`, so on screen it rises at `1 - factor` speed). Pulled
 * down: it grows from its bottom edge so its top stays at the top of the gap the pull opens (a stretchy
 * header). Never more than the cover's height either way, so a long fling stays sane.
 */
export function coverTransform(y: number, height: number, factor?: number): { translateY: number; scale: number } {
  "worklet";
  // A literal, not PARALLAX: the worklet plugin doesn't capture a module constant used as a default
  // parameter, and reading it on the UI thread throws (a crash on the first scroll).
  const f = factor ?? 0.5;
  if (!(height > 0) || !Number.isFinite(y)) return { translateY: 0, scale: 1 };
  if (y >= 0) return { translateY: Math.min(y, height) * f, scale: 1 };
  const pull = Math.min(-y, height);
  const scale = (height + pull) / height;
  // Scaling happens around the center: move up by half the growth so the bottom edge stays put.
  return { translateY: -pull / 2, scale };
}
