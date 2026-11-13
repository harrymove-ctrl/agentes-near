/** A copy this small is enough to tell a picture from one flat color, and cheap to read back. */
const PROBE = { width: 16, height: 12 };

/**
 * At most this share of a picture's copy is black. A desktop that just started is black until its wallpaper draws,
 * and a frame before that may already show its dock on the black: two or three pixels of the copy. A window black
 * from edge to edge still leaves the dock's band under it (60 px of 900, a row of the copy).
 */
const BLACK_MAX = 0.97;

/** RGBA pixels that are all one color. */
export function oneColor(pixels: Uint8ClampedArray) {
  for (let i = 4; i < pixels.length; i += 4) {
    if (
      pixels[i] !== pixels[0] ||
      pixels[i + 1] !== pixels[1] ||
      pixels[i + 2] !== pixels[2] ||
      pixels[i + 3] !== pixels[3]
    )
      return false;
  }
  return true;
}

/** The share of RGBA pixels that are black, whatever their alpha (a canvas nothing drew on is black too). */
function blackShare(pixels: Uint8ClampedArray) {
  let black = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) black++;
  }
  return black / (pixels.length / 4);
}

/**
 * Whether a canvas shows a picture yet: not one flat color, and not the black of a screen whose desktop hasn't
 * drawn with a few things on it already. Where the browser can't read a canvas back, it says yes: nothing waits on
 * what can't be seen.
 */
export function showsPicture(canvas: HTMLCanvasElement) {
  if (canvas.width === 0 || canvas.height === 0) return false;
  const probe = document.createElement("canvas");
  probe.width = PROBE.width;
  probe.height = PROBE.height;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;
  ctx.drawImage(canvas, 0, 0, PROBE.width, PROBE.height);
  const pixels = ctx.getImageData(0, 0, PROBE.width, PROBE.height).data;
  return !oneColor(pixels) && blackShare(pixels) <= BLACK_MAX;
}

/** The class of a picture held over an element's canvas while what draws it is replaced (`holdPicture`). */
const STILL = "dsk-still";

/** The canvas drawn in `el`, under any picture held over it. */
export const liveCanvas = (el: ParentNode) => el.querySelector<HTMLCanvasElement>(`canvas:not(.${STILL})`);

/** The picture held over `el`'s canvas, if any: its own last one, or another view's (`holdImage`). */
export const heldPicture = (el: ParentNode) => el.querySelector<HTMLCanvasElement | HTMLImageElement>(`.${STILL}`);

/**
 * Keeps what `el`'s canvas shows now over it, as a still copy, so the canvas can go and a new one draw under it.
 * Whether a picture is held: none while the canvas shows none yet.
 */
export function holdPicture(el: HTMLElement) {
  if (heldPicture(el)) return true;
  const canvas = liveCanvas(el);
  if (!canvas || !showsPicture(canvas)) return false;
  const still = document.createElement("canvas");
  still.className = STILL;
  still.width = canvas.width;
  still.height = canvas.height;
  still.getContext("2d")?.drawImage(canvas, 0, 0);
  el.append(still);
  return true;
}

/** Holds another view's last picture (a data URL) over `el`'s canvas, as `holdPicture` holds its own. */
export function holdImage(el: HTMLElement, src: string) {
  heldPicture(el)?.remove();
  const still = document.createElement("img");
  still.className = STILL;
  still.alt = "";
  still.src = src;
  el.append(still);
}

/** What `el` shows now, as a data URL for `holdImage`: the picture held over it, else its canvas's; null for none. */
export function pictureOf(el: ParentNode): string | null {
  const held = heldPicture(el);
  if (held instanceof HTMLImageElement) return held.src;
  const canvas = held ?? liveCanvas(el);
  if (!canvas || (!held && !showsPicture(canvas))) return null;
  try {
    return canvas.toDataURL("image/jpeg", 0.85) || null;
  } catch {
    return null;
  }
}
