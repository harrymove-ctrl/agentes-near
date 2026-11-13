/**
 * The avatar tile's own pixel sky: a
 * 4×4 Bayer dither from a soft tone at the top to a slightly deeper one at the
 * bottom, both the agent's color mixed into the surface. Drawn once per color,
 * pixel size and theme and cached; the live loop (../agent/live.ts) stamps it
 * under the agent.
 */
import { gradientOf, mixHex } from "../agent/engine.js";
import { BoundedMap } from "../bounded-map";
import { bayerAt } from "./math";

/** [top, bottom] of an agent's tile sky: light mixes its light tone into white, dark its deep tone into the dark surface. */
export function avatarSkyTones(color: string | undefined, dark: boolean): [string, string] {
  const [light, deep] = gradientOf(color);
  if (dark) return [mixHex(deep, "#1c1c1b", 0.78), mixHex(deep, "#1c1c1b", 0.55)];
  return [mixHex(light, "#ffffff", 0.86), mixHex(light, "#ffffff", 0.62)];
}

/** Which tone a sky cell takes: 0 (top tone) or 1 (bottom tone), for an `n`×`n` grid. */
export function avatarSkyCell(x: number, y: number, n: number): 0 | 1 {
  const t = Math.min(1, Math.max(0, (y / (n - 1)) * 1.15 - 0.1));
  return t > bayerAt(x, y) ? 1 : 0;
}

/** Sky cells per side for a tile of `px` device pixels (about 4 device pixels per cell). */
export const avatarSkyCells = (px: number) => Math.max(8, Math.round(px / 4));

// Bounded: the custom color picker's live preview asks for a new color on every pointer move.
const cache = new BoundedMap<string, HTMLCanvasElement | null>(256);
// Asked every frame for every avatar: the color math once per color and theme.
const looked = new BoundedMap<string, HTMLCanvasElement | null>(256);

/** The sky as a `px`×`px` canvas, cached per color, size and theme (null without a DOM canvas). */
export function avatarSky(color: string | undefined, px: number, dark: boolean): HTMLCanvasElement | null {
  const asked = `${color ?? ""}|${dark ? 1 : 0}|${px}`;
  if (looked.has(asked)) return looked.get(asked) ?? null;
  const [top, bottom] = avatarSkyTones(color, dark);
  const key = `${top}|${bottom}|${px}`;
  if (cache.has(key)) {
    const hit = cache.get(key) ?? null;
    looked.set(asked, hit);
    return hit;
  }
  let canvas: HTMLCanvasElement | null = null;
  try {
    if (typeof document !== "undefined" && px > 0) {
      const c = document.createElement("canvas");
      c.width = c.height = px;
      const g = c.getContext("2d");
      if (g) {
        const n = avatarSkyCells(px);
        const cell = px / n;
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            g.fillStyle = avatarSkyCell(x, y, n) ? bottom : top;
            g.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
          }
        canvas = c;
      }
    }
  } catch {
    canvas = null;
  }
  cache.set(key, canvas);
  looked.set(asked, canvas);
  return canvas;
}
