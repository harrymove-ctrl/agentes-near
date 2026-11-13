/**
 * The screen's own corner radius (pure: no React Native import, so it is unit-tested). iOS doesn't expose
 * it publicly, so it comes from the screen size in points (portrait), per iPhone family. A floating surface
 * near the bottom edge uses it to stay concentric with the glass: radius = display radius - inset.
 */
export type OS = "ios" | "android";

/** Display corner radii by portrait screen size ("width x height" in points). */
const IPHONE: Record<string, number> = {
  "375x812": 39, // X, XS, 11 Pro, 12 mini, 13 mini
  "414x896": 41.5, // XR, XS Max, 11, 11 Pro Max
  "390x844": 47.33, // 12, 13, 14, 16e
  "428x926": 53.33, // 12/13 Pro Max, 14 Plus
  "393x852": 55, // 14 Pro, 15, 15 Pro, 16
  "430x932": 55, // 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  "402x874": 62, // 16 Pro, 17, 17 Pro
  "420x912": 62, // Air
  "440x956": 62, // 16 Pro Max, 17 Pro Max
};

/** A rounded screen we don't know yet (a newer iPhone, an Android phone with gesture navigation). */
const ROUNDED_FALLBACK = 44;

/**
 * The corner radius of the screen, or 0 for a square one (home button iPhones and Android phones with a
 * button bar, told apart by having no bottom inset).
 */
export function displayCornerRadius(os: OS, width: number, height: number, bottomInset: number): number {
  if (bottomInset === 0) return 0;
  if (os === "ios") {
    const w = Math.round(Math.min(width, height));
    const h = Math.round(Math.max(width, height));
    return IPHONE[`${w}x${h}`] ?? ROUNDED_FALLBACK;
  }
  return ROUNDED_FALLBACK;
}

/**
 * The bottom corners of a surface floating `inset` points from the screen's edges: concentric with the
 * screen (its radius minus the inset), never tighter than the surface's own `min`.
 */
export function concentricRadius(displayRadius: number, inset: number, min: number): number {
  return Math.max(min, displayRadius - inset);
}
