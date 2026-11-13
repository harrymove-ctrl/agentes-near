/**
 * Draws the desktop app's icons from the agent engine (packages/ui/src/agent/engine.js), so the
 * tray and the app icon are the same symbol as everywhere else: the body with the cut corner and
 * two pill eyes. Run by CI before `tauri build` (`bun apps/desktop/scripts/icons.ts`), then
 * `tauri icon app-icon.png` makes the .icns and the PNG sizes from the 1024 px master.
 *
 * Outputs (all ignored by git):
 *   src-tauri/icons/tray/{idle,working,paused,offline,update,browsing,needs}.png  36×36 template images (18 pt @2x)
 *   app-icon.png                                                   1024×1024 app icon master
 *
 * No dependencies: a tiny PNG encoder over node:zlib.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { bodyTones, eyeShapes, inBody, toneAt } from "../../../packages/ui/src/agent/engine.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- PNG ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA pixels (width × height × 4) to a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* ---------- Shapes (unit body coordinates: u, v in 0..1 over the body's square) ---------- */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pill (rounded on its short side). */
function inPill(u: number, v: number, b: Box): boolean {
  if (u < b.x || u > b.x + b.w || v < b.y || v > b.y + b.h) return false;
  const r = Math.min(b.w, b.h) / 2;
  const cx = Math.min(Math.max(u, b.x + r), b.x + b.w - r);
  const cy = Math.min(Math.max(v, b.y + r), b.y + b.h - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

const ROUND_EYES: Box[] = eyeShapes("round").map((e: Box) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));

function shifted(eyes: Box[], dx: number): Box[] {
  return eyes.map((e) => ({ ...e, x: e.x + dx }));
}

/** Paused: the eyes are short dashes. */
const DASH_EYES: Box[] = [0.375, 0.625].map((cx) => ({ x: cx - 0.085, y: 0.47, w: 0.17, h: 0.085 }));

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/* ---------- Tray: 36×36 template images (only alpha counts; macOS tints them) ---------- */

type TrayState = "idle" | "working" | "paused" | "offline" | "update" | "browsing" | "needs";
const TRAY_PX = 36;
/** The body's square inside the 36 px canvas. */
const TB = { x: 4, y: 4, s: 28 };
const SS = 4; // supersampling per axis

function trayCoverage(state: TrayState, px: number, py: number): boolean {
  const u = (px - TB.x) / TB.s;
  const v = (py - TB.y) / TB.s;
  const eyes = state === "paused" ? DASH_EYES : state === "working" ? shifted(ROUND_EYES, 0.05) : ROUND_EYES;
  const inEye = eyes.some((e) => inPill(u, v, e));
  if (state === "offline") {
    // Outline only, eyes filled.
    if (inEye) return true;
    const stroke = 2.6 / TB.s;
    const inner = (uu: number, vv: number) =>
      inBody((uu - stroke) / (1 - 2 * stroke), (vv - stroke) / (1 - 2 * stroke));
    return inBody(u, v) && !inner(u, v);
  }
  if (state === "browsing" || state === "needs") {
    // A badge cut out of the bottom-right corner: a ring while an agent is in its browser, a
    // filled dot when one needs a person. Same place and gap as the update badge.
    const bx = 28;
    const by = 28;
    const d = Math.hypot(px - bx, py - by);
    if (d <= 8) {
      if (d > 6.4) return false; // the gap around the badge
      return state === "needs" ? true : d >= 3.6;
    }
  }
  if (state === "update") {
    // A round badge cut out of the bottom-right corner, with a down arrow in it.
    const bx = 27;
    const by = 27;
    const d = Math.hypot(px - bx, py - by);
    if (d <= 8.6) {
      if (d > 7.2) return false; // the gap around the badge
      const half = 1.15;
      return (
        distToSegment(px, py, bx, by - 4, bx, by + 3.2) <= half ||
        distToSegment(px, py, bx - 3, by + 0.4, bx, by + 3.4) <= half ||
        distToSegment(px, py, bx + 3, by + 0.4, bx, by + 3.4) <= half
      );
    }
  }
  return inBody(u, v) && !inEye;
}

function trayPng(state: TrayState): Uint8Array {
  const rgba = new Uint8Array(TRAY_PX * TRAY_PX * 4);
  for (let y = 0; y < TRAY_PX; y++)
    for (let x = 0; x < TRAY_PX; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) if (trayCoverage(state, x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++;
      const i = (y * TRAY_PX + x) * 4;
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  return encodePng(TRAY_PX, TRAY_PX, rgba);
}

/* ---------- App icon: 1024 px, the agent in the sky's dither on a dark tile ---------- */

const hex = (h: string): [number, number, number] => {
  const n = Number.parseInt(h.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function appIconPng(): Uint8Array {
  const S = 1024;
  const tile = { x: 100, y: 100, s: 824, r: 185 };
  const body = { x: 232, y: 222, s: 560 };
  const cells = 22;
  const tones = (bodyTones("sky") as string[]).map(hex);
  const bg = hex("#151514");
  const rgba = new Uint8Array(S * S * 4);
  const inTile = (x: number, y: number) => {
    const cx = Math.min(Math.max(x, tile.x + tile.r), tile.x + tile.s - tile.r);
    const cy = Math.min(Math.max(y, tile.y + tile.r), tile.y + tile.s - tile.r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= tile.r * tile.r;
  };
  const n = 3; // supersampling for the icon's edges
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) {
          const px = x + (sx + 0.5) / n;
          const py = y + (sy + 0.5) / n;
          if (!inTile(px, py)) continue;
          let c = bg;
          const u = (px - body.x) / body.s;
          const v = (py - body.y) / body.s;
          if (inBody(u, v)) {
            const eye = ROUND_EYES.some((e) => inPill(u, v, e));
            if (eye) c = [255, 255, 255];
            else {
              const cx = Math.min(cells - 1, Math.floor(u * cells));
              const cy = Math.min(cells - 1, Math.floor(v * cells));
              c = tones[toneAt(cx, cy, cells) as number] ?? tones[2] ?? bg;
            }
          }
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      const i = (y * S + x) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (n * n)) * 255);
    }
  return encodePng(S, S, rgba);
}

/* ---------- Write ---------- */

const trayDir = join(root, "src-tauri", "icons", "tray");
mkdirSync(trayDir, { recursive: true });
for (const state of ["idle", "working", "paused", "offline", "update", "browsing", "needs"] as const) {
  writeFileSync(join(trayDir, `${state}.png`), trayPng(state));
}
writeFileSync(join(root, "app-icon.png"), appIconPng());
console.log("icons: tray (7 states) and app-icon.png written");
