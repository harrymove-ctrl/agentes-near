/**
 * The picture viewer's math: a picture of natural size `img` drawn in a stage of size `stage` at `scale` (1 = its
 * real pixels), its top-left corner at (`x`, `y`) in the stage. All in CSS pixels.
 */

export interface Size {
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point, Size {}
export interface ZoomView extends Point {
  scale: number;
}

/** The furthest zoom, in real pixels per screen pixel. */
export const ZOOM_MAX = 8;
/** Where − and + stop (besides the fitted size). */
export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
const EPS = 1e-3;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** As big as the stage lets the whole picture be, never past its real size. */
export function fitScale(img: Size, stage: Size): number {
  if (img.w <= 0 || img.h <= 0 || stage.w <= 0 || stage.h <= 0) return 1;
  return Math.min(1, stage.w / img.w, stage.h / img.h);
}

/** A side smaller than the stage stays centered; a bigger one can't leave an empty edge inside the stage. */
export function clampPan(v: ZoomView, img: Size, stage: Size): ZoomView {
  const w = img.w * v.scale;
  const h = img.h * v.scale;
  return {
    scale: v.scale,
    x: w <= stage.w ? (stage.w - w) / 2 : clamp(v.x, stage.w - w, 0),
    y: h <= stage.h ? (stage.h - h) / 2 : clamp(v.y, stage.h - h, 0),
  };
}

export const fitView = (img: Size, stage: Size): ZoomView =>
  clampPan({ scale: fitScale(img, stage), x: 0, y: 0 }, img, stage);

/** `scale` (kept between the fitted size and ZOOM_MAX) with the picture's point under `at` staying under it. */
export function zoomAt(v: ZoomView, scale: number, at: Point, img: Size, stage: Size): ZoomView {
  const s = clamp(scale, fitScale(img, stage), ZOOM_MAX);
  const k = s / v.scale;
  return clampPan({ scale: s, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k }, img, stage);
}

export const panBy = (v: ZoomView, dx: number, dy: number, img: Size, stage: Size): ZoomView =>
  clampPan({ scale: v.scale, x: v.x + dx, y: v.y + dy }, img, stage);

/** The next stop of − (`-1`) or + (`1`) from `scale`, the fitted size among them. */
export function stepZoom(scale: number, dir: 1 | -1, fit: number): number {
  const stops = [fit, ...ZOOM_STEPS.filter((s) => s > fit + EPS)];
  if (dir > 0) return stops.find((s) => s > scale + EPS) ?? ZOOM_MAX;
  return stops.findLast((s) => s < scale - EPS) ?? fit;
}

/** A click on the fitted picture: its real size, or twice the fitted size when that is bigger. */
export const clickZoom = (fit: number) => Math.min(ZOOM_MAX, Math.max(1, fit * 2));

export const isZoomed = (v: ZoomView, img: Size, stage: Size) => v.scale > fitScale(img, stage) + EPS;

/** A free strip beside the picture narrower than this can't hold the pane: it floats over the picture instead. */
const PANE_MIN = 200;
const PANE_MAX = 560;
const GAP = 12;

/**
 * The hover lens (Mercado Livre style): the magnified pane takes the stage's widest free strip beside the fitted
 * picture (`box`), or floats over the half away from the pointer when no strip is wide enough. The lens is the pane
 * divided by `mag` (never bigger than the picture), centered on the pointer and kept inside the picture; `offset` is
 * where the picture, drawn `mag` times its fitted size, sits inside the pane.
 */
export function lensLayout(stage: Size, box: Rect, pointer: Point, mag: number) {
  const strips: Rect[] = [
    { x: box.x + box.w + GAP, y: GAP, w: stage.w - box.x - box.w - 2 * GAP, h: stage.h - 2 * GAP },
    { x: GAP, y: GAP, w: box.x - 2 * GAP, h: stage.h - 2 * GAP },
    { x: GAP, y: box.y + box.h + GAP, w: stage.w - 2 * GAP, h: stage.h - box.y - box.h - 2 * GAP },
    { x: GAP, y: GAP, w: stage.w - 2 * GAP, h: box.y - 2 * GAP },
  ];
  // The widest strip, the earlier one (right, left, under, over) unless another is clearly wider.
  const room = (r: Rect) => Math.min(r.w, r.h);
  const free = strips
    .filter((r) => room(r) >= PANE_MIN)
    .reduce<Rect | undefined>((best, r) => (!best || room(r) > room(best) * 1.1 ? r : best), undefined);
  const area: Rect = free ?? {
    x: pointer.x < stage.w / 2 ? stage.w / 2 + GAP / 2 : GAP,
    y: GAP,
    w: stage.w / 2 - 1.5 * GAP,
    h: stage.h - 2 * GAP,
  };
  const lensW = Math.min(Math.min(area.w, PANE_MAX) / mag, box.w);
  const lensH = Math.min(Math.min(area.h, PANE_MAX) / mag, box.h);
  const lens: Rect = {
    x: clamp(pointer.x - lensW / 2, box.x, box.x + box.w - lensW),
    y: clamp(pointer.y - lensH / 2, box.y, box.y + box.h - lensH),
    w: lensW,
    h: lensH,
  };
  const paneW = lensW * mag;
  const paneH = lensH * mag;
  const pane: Rect = {
    x: area.x + (area.w - paneW) / 2,
    y: clamp(box.y + (box.h - paneH) / 2, area.y, area.y + area.h - paneH),
    w: paneW,
    h: paneH,
  };
  return { lens, pane, offset: { x: -(lens.x - box.x) * mag, y: -(lens.y - box.y) * mag } };
}

/** How much the lens magnifies the fitted picture: up to its real pixels, between 2× and 4×. */
export const lensMag = (fit: number) => clamp(1 / fit, 2, 4);

/** A wheel event over the picture: a trackpad pinch, a mouse wheel's notch, or a trackpad's two-finger scroll. */
export type WheelIntent = "pinch" | "wheel" | "scroll";

/**
 * Browsers don't say which device sent a wheel event, so it is read from its shape: a pinch comes as a wheel with
 * ctrlKey (Chrome, Edge and Firefox; Safari sends its own gesture events instead); a mouse wheel counts in lines or
 * pages (Firefox) or in large whole steps on Y alone (a notch is 100 or 120 px in Chrome, Edge and Safari); anything
 * else, small or fractional steps or any X, is a trackpad's two-finger scroll.
 * ponytail: a shape heuristic, so a fast trackpad flick of whole 50+ px steps with no X zooms like a wheel; read
 * `wheelDeltaY` multiples of 120 too if that shows up.
 */
export function wheelIntent(e: { ctrlKey: boolean; deltaMode: number; deltaX: number; deltaY: number }): WheelIntent {
  if (e.ctrlKey) return "pinch";
  if (e.deltaMode !== 0) return "wheel";
  return e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50 ? "wheel" : "scroll";
}
