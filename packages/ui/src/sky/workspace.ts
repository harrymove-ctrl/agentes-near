/**
 * The workspace's own sky: behind its header in the sidebar (and the Mac app's title bar above it) and behind
 * Conversas' title on the phone. The Cloud's (agentes.chat) is the day sky, with pixel clouds drifting by; a server
 * of one's own is the same sky at dusk, lilac with a few slow stars. Light tones: it is always on screen.
 *
 * DOM-free: the web draws it on its canvas sky (apps/web Sky.tsx `WorkspaceSky`), the phone app mirrors these
 * functions in a shader (apps/mobile src/sky/shaders.ts `workspace`). Clouds and stars come from the time alone,
 * so two skies side by side (the title bar's and the sidebar's) show the same ones.
 */
import { bayerAt, mix, parseColor } from "./math";

export type SkyHour = "day" | "dusk";

/** agentes.chat and its subdomains are the Cloud (as the server's `isAgentesCloud`); any other host is one's own. */
export function skyHourOf(host: string): SkyHour {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  return name === "agentes.chat" || name.endsWith(".agentes.chat") ? "day" : "dusk";
}

/** The hour's light end, three steps each: pale on a light surface, deeper on a dark one. */
const STOPS: Record<SkyHour, { light: readonly string[]; dark: readonly string[] }> = {
  day: { light: ["#cfe5ff", "#a6cfff", "#86bbff"], dark: ["#173763", "#1f4f93", "#2a69c4"] },
  dusk: { light: ["#e3dcff", "#c9c0ff", "#aaa6f5"], dark: ["#26214f", "#352d7d", "#4a40a8"] },
};

/** Whether a surface is dark (its relative luminance below the middle). */
export function isDarkSurface(surface: string): boolean {
  const [r, g, b] = parseColor(surface);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** The surface, then three steps into the hour's light (the field's tones, 0 = the bare surface). */
export function workspaceTones(hour: SkyHour, surface: string): string[] {
  const dark = isDarkSurface(surface);
  const stops = STOPS[hour][dark ? "dark" : "light"];
  const reach = dark ? 0.85 : 0.9;
  return [surface, ...stops.map((s, i) => mix(surface, s, reach * (0.35 + 0.65 * ((i + 1) / stops.length))))];
}

/** How much of its ink a faint field's clouds and stars show: a touch in the sky, not shapes on it. */
const FAINT_INK = 0.55;

/**
 * What is drawn over the field: a cloud's lit top or a bright star, and a cloud's body or a dim star. `faint`:
 * over a faint field (the header's), where white would vanish on a light surface: the sky's own deeper tones, thinned
 * toward the surface.
 */
export function workspaceInk(hour: SkyHour, surface: string, faint = false): { bright: string; dim: string } {
  const ink = fullInk(hour, surface, faint);
  if (!faint) return ink;
  return { bright: mix(surface, ink.bright, FAINT_INK), dim: mix(surface, ink.dim, FAINT_INK) };
}

function fullInk(hour: SkyHour, surface: string, faint: boolean): { bright: string; dim: string } {
  const dark = isDarkSurface(surface);
  const tones = workspaceTones(hour, surface);
  const deepest = tones[tones.length - 1] ?? surface;
  if (faint && !dark) return { bright: deepest, dim: tones[2] ?? deepest };
  if (hour === "day") {
    return dark
      ? { bright: mix(surface, "#ffffff", 0.32), dim: mix(surface, "#ffffff", 0.2) }
      : { bright: "#ffffff", dim: mix(deepest, "#ffffff", 0.6) };
  }
  const star = dark ? "#fff6d6" : "#ffffff";
  return { bright: star, dim: mix(deepest, star, 0.5) };
}

const smooth = (a: number, b: number, x: number) => {
  const e = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return e * e * (3 - 2 * e);
};

/**
 * The header's sky at (u, v) of its box (the title bar included where there is one): light, from the left (behind
 * the window's buttons and the mark), thinning out to the right and gone well before the sidebar's edge (no line
 * against the page), fuller on top, ending at the header's foot; it breathes a little.
 */
export function headerField(u: number, v: number, t: number): number {
  const foot = 1 - smooth(0.7, 1, v);
  const across = 1 - smooth(0.05, 0.78, u);
  return across * (0.42 * (0.7 + 0.3 * (1 - v)) + 0.04 * Math.sin(u * 6 + v * 3 + t * 0.5)) * foot;
}

/** Conversas' sky on the phone at (u, v): the top of the screen, a little fuller on the right, fading toward the list. */
export function phoneField(u: number, v: number, t: number): number {
  const down = 1 - smooth(0.25, 1, v);
  return down * (0.6 + 0.3 * u) + 0.05 * Math.sin(u * 5 + v * 4 + t * 0.5);
}

/**
 * Where clouds and stars may be, as shares of the sky's box: between `x0` and `x1`, `y0` and `y1`. `fade`: how far in
 * from `x0` and `x1` a cloud dissolves, where the area ends in open sky and a straight cut would show.
 */
export interface SkyArea {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  fade?: number;
}
/** In the title bar's band, past the back and forward buttons, short of the sidebar's edge (none over the name). */
export const HEADER_AREA: SkyArea = { x0: 0.6, x1: 0.88, y0: 0.04, y1: 0.3, fade: 0.08 };
/** Above Conversas' title, on the right. */
export const PHONE_AREA: SkyArea = { x0: 0.5, x1: 1, y0: 0.05, y1: 0.42 };

/** GLSL `mod` (always positive for a positive divisor). */
const mod = (a: number, b: number) => a - b * Math.floor(a / b);
/** The shaders' hash of a cell (the same formula, so a star sits on the same cell everywhere). */
export function cellHash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * The clouds, in cells: each row a [from, to) run; the first `lit` rows are its lit top. Three drift right to
 * left at their own pace and come back from the right edge.
 */
export const CLOUDS: readonly { rows: readonly (readonly [number, number])[]; lit: number }[] = [
  {
    rows: [
      [2, 6],
      [1, 8],
      [0, 10],
      [1, 9],
    ],
    lit: 2,
  },
  {
    rows: [
      [1, 4],
      [0, 7],
      [1, 6],
    ],
    lit: 1,
  },
  {
    rows: [
      [2, 5],
      [1, 8],
      [0, 9],
    ],
    lit: 2,
  },
];
const CLOUD_W = 10;

/** Cloud `i`'s top-left cell at time t in a w×h sky (it enters at the area's right side). */
export function cloudOrigin(i: number, w: number, h: number, t: number, area: SkyArea): [number, number] {
  const span = w * (area.x1 - area.x0) + CLOUD_W + 4;
  const x = Math.floor(w * area.x1 - mod(t * (0.9 + 0.35 * i) + i * span * 0.37, span));
  const y = Math.floor(h * (area.y0 + (area.y1 - area.y0) * (0.1 + 0.4 * i)));
  return [x, y];
}

/** What the clouds put at cell (x, y) of a w×h sky at time t: 0 nothing, 1 a cloud's body, 2 its lit top. */
export function cloudAt(x: number, y: number, w: number, h: number, t: number, area: SkyArea): 0 | 1 | 2 {
  // Only inside the area: never over the name, never at the sidebar's edge.
  if (x < w * area.x0 || x >= w * area.x1) return 0;
  // Near those edges, cell by cell in the sky's own dither, so a cloud comes and goes without a straight cut.
  if (area.fade && Math.min(x - w * area.x0, w * area.x1 - x) / (w * area.fade) <= bayerAt(x, y)) return 0;
  for (let i = 0; i < CLOUDS.length; i++) {
    const cloud = CLOUDS[i] as (typeof CLOUDS)[number];
    const [cx, cy] = cloudOrigin(i, w, h, t, area);
    const row = cloud.rows[y - cy];
    if (!row) continue;
    const dx = x - cx;
    if (dx >= row[0] && dx < row[1]) return y - cy < cloud.lit ? 2 : 1;
  }
  return 0;
}

/** What the stars put at cell (x, y) of a w×h sky at time t: 0 nothing, 1 dim, 2 bright (a slow twinkle). */
export function starAt(x: number, y: number, w: number, h: number, t: number, area: SkyArea): 0 | 1 | 2 {
  if (x < w * area.x0 || x >= w * area.x1 || y < h * area.y0 || y > h * area.y1) return 0;
  const k = cellHash(x, y);
  if (k < 0.975) return 0;
  const phase = mod(t * 0.7 + k * 600, 6);
  if (phase > 5.2) return 0; // out for a moment
  return phase < 0.6 ? 1 : 2;
}
