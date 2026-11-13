/**
 * The picture viewer's math (worklets: they run on the UI thread during gestures). Translations are
 * from the screen's center, in points.
 */

export const MAX_ZOOM = 4;
/** A drag this far down (or up), or this fast, closes the viewer. */
export const DISMISS_DISTANCE = 120;
export const DISMISS_VELOCITY = 900;

/**
 * The translation that keeps the point under the fingers (`focal`, from the center) still while the
 * scale goes from `from` to `to`.
 */
export function zoomAround(
  start: { x: number; y: number },
  from: number,
  to: number,
  focalX: number,
  focalY: number,
): { x: number; y: number } {
  "worklet";
  const k = from > 0 ? to / from : 1;
  return { x: focalX - (focalX - start.x) * k, y: focalY - (focalY - start.y) * k };
}

/**
 * Keeps a zoomed picture covering its frame: no empty edge pulled in beyond the picture's side. `contentW` and
 * `contentH` are the picture as drawn unzoomed (`containSize`), the whole frame when not known.
 */
export function clampZoomTranslate(
  x: number,
  y: number,
  scale: number,
  width: number,
  height: number,
  contentW = width,
  contentH = height,
): { x: number; y: number } {
  "worklet";
  const maxX = Math.max(0, (scale * contentW - width) / 2);
  const maxY = Math.max(0, (scale * contentH - height) / 2);
  return { x: Math.min(Math.max(x, -maxX), maxX), y: Math.min(Math.max(y, -maxY), maxY) };
}

/** A picture of natural size `w`×`h` fitted whole inside the frame (expo-image's `contain`). */
export function containSize(w: number, h: number, width: number, height: number): { w: number; h: number } {
  "worklet";
  if (w <= 0 || h <= 0) return { w: width, h: height };
  const s = Math.min(width / w, height / h);
  return { w: w * s, h: h * s };
}

/** A double tap's zoom: enough for a thin picture (a wide banner) to fill the screen's other side, 2.5× at least. */
export function doubleTapZoom(contentW: number, contentH: number, width: number, height: number): number {
  "worklet";
  const cover = Math.max(width / Math.max(contentW, 1), height / Math.max(contentH, 1));
  return Math.min(Math.max(cover, 2.5), MAX_ZOOM);
}
