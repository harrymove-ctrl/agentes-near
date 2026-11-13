/**
 * Pixel art for the installers' pictures (installer-art.ts for Windows, dmg-art.ts for the macOS .dmg), drawn from
 * the agent engine and the sky's tones so the installers show the same agent and sky as the app's cover.
 *
 * No dependencies: the wordmark is outlines as path data (Funnel Display Light for "agentes", Doto Rounded
 * SemiBold for the dotted ".chat", both SIL Open Font License 1.1), filled here, and small BMP and PNG writers.
 */
import { deflateSync } from "node:zlib";
import { bodyTones, EYE_COLOR, eyeShapes, inBody, toneAt } from "../../../packages/ui/src/agent/engine.js";
import { SKY_TONES } from "../../../packages/ui/src/sky/math";

export type RGB = [number, number, number];

export const hex = (h: string): RGB => {
  const n = Number.parseInt(h.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const WHITE: RGB = [255, 255, 255];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** The sky's run from deep to light (the cover's sky). */
export const SKY = (SKY_TONES as string[]).map(hex);

/** A picture `w`×`h` pixels, drawn in points of `k` pixels each (2 = twice the size it shows at). */
export class Picture {
  readonly px: Float64Array;
  constructor(
    readonly w: number,
    readonly h: number,
    readonly k = 2,
  ) {
    this.px = new Float64Array(w * h * 3);
  }

  /** Paints (x, y) with `c` at `alpha` over what is there. */
  blend(x: number, y: number, c: RGB, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || alpha <= 0) return;
    const i = (y * this.w + x) * 3;
    for (let k = 0; k < 3; k++) this.px[i + k] = (this.px[i + k] as number) * (1 - alpha) + (c[k] as number) * alpha;
  }

  rect(x: number, y: number, w: number, h: number, c: RGB) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.blend(xx, yy, c);
  }

  /** A rect in points (rounded to whole pixels), at `alpha`. */
  box(x: number, y: number, w: number, h: number, c: RGB, alpha = 1) {
    const x0 = Math.round(x * this.k);
    const y0 = Math.round(y * this.k);
    const x1 = Math.round((x + w) * this.k);
    const y1 = Math.round((y + h) * this.k);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c, alpha);
  }

  /** 24-bit BMP, rows bottom-up, each padded to 4 bytes. */
  bmp(): Uint8Array {
    const row = Math.ceil((this.w * 3) / 4) * 4;
    const size = 54 + row * this.h;
    const out = new Uint8Array(size);
    const v = new DataView(out.buffer);
    out[0] = 0x42; // "BM"
    out[1] = 0x4d;
    v.setUint32(2, size, true);
    v.setUint32(10, 54, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, this.w, true);
    v.setInt32(22, this.h, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 24, true);
    v.setUint32(34, row * this.h, true);
    v.setInt32(38, 3780, true); // 96 dpi
    v.setInt32(42, 3780, true);
    for (let y = 0; y < this.h; y++) {
      const at = 54 + (this.h - 1 - y) * row;
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 3;
        for (let k = 0; k < 3; k++) out[at + x * 3 + (2 - k)] = Math.round(this.px[i + k] as number); // BGR
      }
    }
    return out;
  }

  /** 8-bit RGB PNG at 72 dpi per point (a 2× picture says 144 dpi, as macOS expects of a Retina image). */
  png(): Uint8Array {
    const raw = new Uint8Array((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      const at = y * (this.w * 3 + 1); // filter byte 0 (none), then the row
      for (let x = 0; x < this.w * 3; x++) raw[at + 1 + x] = Math.round(this.px[y * this.w * 3 + x] as number);
    }
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, this.w);
    hv.setUint32(4, this.h);
    ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, no filter set, not interlaced
    const phys = new Uint8Array(9);
    const pv = new DataView(phys.buffer);
    const perMeter = Math.round((72 * this.k) / 0.0254);
    pv.setUint32(0, perMeter);
    pv.setUint32(4, perMeter);
    phys[8] = 1; // meters
    const chunks = [
      chunk("IHDR", ihdr),
      chunk("pHYs", phys),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ];
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const out = new Uint8Array(sig.length + chunks.reduce((n, c) => n + c.length, 0));
    out.set(sig);
    let at = sig.length;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** One PNG chunk: length, type, data and the CRC of type + data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = (CRC[(c ^ (out[i] as number)) & 255] as number) ^ (c >>> 8);
  v.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

/* ---------- The sky: ordered dither over a run of tones ---------- */

/** Dithers `tones` over the picture in cells of `cell` points; `at(u, v)` (0..1) picks along the tones. */
export function dither(p: Picture, tones: RGB[], at: (u: number, v: number) => number, cell = 2) {
  const size = cell * p.k;
  const cw = Math.ceil(p.w / size);
  const ch = Math.ceil(p.h / size);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const val = Math.max(0, Math.min(0.999, at((x + 0.5) / cw, (y + 0.5) / ch))) * (tones.length - 1);
      const lo = Math.floor(val);
      const th = ((BAYER[(y & 3) * 4 + (x & 3)] as number) + 0.5) / 16;
      const tone = tones[val - lo > th ? Math.min(lo + 1, tones.length - 1) : lo] as RGB;
      p.rect(x * size, y * size, size, size, tone);
    }
}

/** A small pixel cloud (the landing's), at (x, y) in points, `cell` points per block. */
export function cloud(p: Picture, x: number, y: number, cell: number, tone: RGB) {
  const shape = ["..XXX...", ".XXXXXX.", "XXXXXXXX"];
  shape.forEach((line, j) => {
    [...line].forEach((c, i) => {
      if (c === "X") p.rect((x + i * cell) * p.k, (y + j * cell) * p.k, cell * p.k, cell * p.k, tone);
    });
  });
}

/* ---------- The agent: the engine's body, tones and eyes, still ---------- */

const SS = 4; // samples per axis on the edges

function inPill(u: number, v: number, e: { x: number; y: number; w: number; h: number }): boolean {
  if (u < e.x || u > e.x + e.w || v < e.y || v > e.y + e.h) return false;
  const r = Math.min(e.w, e.h) / 2;
  const cx = Math.min(Math.max(u, e.x + r), e.x + e.w - r);
  const cy = Math.min(Math.max(v, e.y + r), e.y + e.h - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The engine's "arc" eye (drawEyes): the top half of an ellipse, stroked with round ends, in body units. */
function onArc(u: number, v: number, e: { x: number; y: number; w: number; h: number }, line: number): boolean {
  const lw = line;
  const rx = Math.max(0.5 / 128, e.w / 2 - lw / 2);
  const ry = e.h;
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h;
  const steps = 24;
  for (let k = 0; k < steps; k++) {
    const a0 = Math.PI + (Math.PI * k) / steps;
    const a1 = Math.PI + (Math.PI * (k + 1)) / steps;
    const d = distToSegment(
      u,
      v,
      cx + rx * Math.cos(a0),
      cy + ry * Math.sin(a0),
      cx + rx * Math.cos(a1),
      cy + ry * Math.sin(a1),
    );
    if (d <= lw / 2) return true;
  }
  return false;
}

/** The agent (round eyes, as the cover) at (x, y) in points, `size` points wide; sky and 12 cells unless told. */
export function agent(p: Picture, x: number, y: number, size: number, happy = false, color = "sky", n = 12) {
  const s = Math.round(size * p.k);
  const ox = Math.round(x * p.k);
  const oy = Math.round(y * p.k);
  const tones = (bodyTones(color) as string[]).map(hex);
  const eyes = eyeShapes("round", happy ? { expression: "happy" } : {}) as {
    x: number;
    y: number;
    w: number;
    h: number;
    kind: string;
  }[];
  const line = Math.max(1.4, s * 0.055) / s;
  const eye = (u: number, v: number) => eyes.some((e) => (e.kind === "arc" ? onArc(u, v, e, line) : inPill(u, v, e)));
  for (let py = 0; py < s; py++)
    for (let px = 0; px < s; px++) {
      let hits = 0;
      let white = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / s;
          const v = (py + (sy + 0.5) / SS) / s;
          if (!inBody(u, v)) continue;
          hits++;
          if (eye(u, v)) white++;
        }
      if (!hits) continue;
      const u = (px + 0.5) / s;
      const v = (py + 0.5) / s;
      const tone = tones[toneAt(Math.min(n - 1, Math.floor(u * n)), Math.min(n - 1, Math.floor(v * n)), n)] as RGB;
      p.blend(ox + px, oy + py, tone, hits / (SS * SS));
      if (white) p.blend(ox + px, oy + py, hex(EYE_COLOR), white / hits);
    }
}

/* ---------- The wordmark: "agentes" in Funnel Display Light, ".chat" after it ---------- */

/** Outlines at 100 px, baseline at y = 0; ".chat" starts where "agentes" advances to (as the cover sets them). */
export const WORDMARK = {
  width: 603.33,
  agentes:
    "M21.5 0.9L21.5 0.9Q13.2 0.9 8.3-3.3Q3.5-7.5 3.5-14.2L3.5-14.2Q3.5-21.3 8.2-25.3Q12.9-29.2 21.8-29.2L21.8-29.2L39.8-29.2L39.8-31.5Q39.8-44.3 26.1-44.3L26.1-44.3Q14.9-44.3 12.7-35.8L12.7-35.8L4.7-35.8Q5.8-43.0 11.6-47.0Q17.4-51.0 26.3-51.0L26.3-51.0Q36.5-51.0 41.9-46.1Q47.3-41.3 47.3-32.1L47.3-32.1L47.3-8.3L51.2-8.3L51.2 0L42.5 0L42.5-7.5L39.0-7.5Q36.4-3.7 31.8-1.4Q27.3 0.9 21.5 0.9ZM22.5-5.6L22.5-5.6Q27.3-5.6 31.2-7.6Q35.2-9.6 37.5-13.0Q39.8-16.3 39.8-20.4L39.8-20.4L39.8-23.2L22.4-23.2Q10.8-23.2 10.8-14.5L10.8-14.5Q10.8-10.4 14.0-8Q17.1-5.6 22.5-5.6ZM83.8 21.0L83.8 21.0Q73.7 21.0 67.3 16.8Q61.0 12.5 59.8 5.0L59.8 5.0L68.2 5.0Q70.5 14.2 83.8 14.2L83.8 14.2Q92.0 14.2 96.4 10.3Q100.8 6.3 100.8-1L100.8-1L100.8-9.5L100.4-9.5Q98.5-5.0 94.0-2.5Q89.5 0 83.5 0L83.5 0Q76.3 0 71.1-3.1Q65.8-6.3 63.0-12.0Q60.2-17.7 60.2-25.5L60.2-25.5Q60.2-37.3 66.5-44.1Q72.8-51.0 83.7-51.0L83.7-51.0Q89.7-51.0 93.9-48.8Q98.2-46.7 100.7-42.5L100.7-42.5L104.2-42.5L104.2-50.0L112.8-50.0L112.8-41.7L108.7-41.7L108.7-0.4Q108.7 9.7 102.1 15.3Q95.6 21.0 83.8 21.0ZM85.3-6.8L85.3-6.8Q92.3-6.8 96.5-10.9Q100.8-15.0 100.8-21.7L100.8-21.7L100.8-29.3Q100.8-36.0 96.5-40.1Q92.3-44.2 85.3-44.2L85.3-44.2Q77.3-44.2 72.6-39.3Q68.0-34.3 68.0-25.5L68.0-25.5Q68.0-16.7 72.6-11.8Q77.3-6.8 85.3-6.8ZM147.0 1L147.0 1Q139.3 1 133.7-2.2Q128.0-5.4 124.9-11.3Q121.8-17.3 121.8-25.2L121.8-25.2Q121.8-33.1 124.9-38.9Q128.0-44.7 133.6-47.8Q139.2-51.0 146.7-51.0L146.7-51.0Q153.8-51.0 158.9-48.1Q164.1-45.3 167.0-40.0Q169.8-34.8 169.8-27.6L169.8-27.6L169.8-24.1L129.3-24.1Q129.7-15.5 134.4-10.7Q139.1-5.8 146.9-5.8L146.9-5.8Q152.3-5.8 156.1-8.2Q159.9-10.5 161.3-14.9L161.3-14.9L169.3-14.9Q167.4-7.3 161.5-3.2Q155.7 1 147.0 1ZM129.8-30.1L129.8-30.1L162.3-30.1Q161.7-36.8 157.5-40.6Q153.3-44.3 146.6-44.3L146.6-44.3Q139.8-44.3 135.4-40.6Q130.9-36.8 129.8-30.1ZM190.8 0L183.0 0L183.0-41.7L178.8-41.7L178.8-50.0L187.5-50.0L187.5-42.5L191.0-42.5Q193.5-46.7 198.0-48.8Q202.6-50.9 208.4-50.9L208.4-50.9Q217.8-50.9 223.4-45.4Q229.0-39.9 229.0-30.8L229.0-30.8L229.0 0L221.2 0L221.2-29.6Q221.2-36.7 217.3-40.4Q213.4-44.1 206.0-44.1L206.0-44.1Q198.7-44.1 194.8-40.4Q190.8-36.7 190.8-29.6L190.8-29.6L190.8 0ZM269.7 0L254.3 0Q250.8 0 248.9-1.8Q246.9-3.6 246.9-7.2L246.9-7.2L246.9-44.0L237.3-44.0L237.3-50.0L247.0-50.0L247.0-65.0L254.7-65.0L254.7-50.0L268.3-50.0L268.3-44.0L254.8-44.0L254.8-6.2L269.7-6.2L269.7 0ZM301.2 1L301.2 1Q293.5 1 287.8-2.2Q282.2-5.4 279.1-11.3Q276-17.3 276-25.2L276-25.2Q276-33.1 279.1-38.9Q282.2-44.7 287.8-47.8Q293.3-51.0 300.8-51.0L300.8-51.0Q307.9-51.0 313.1-48.1Q318.3-45.3 321.1-40.0Q324-34.8 324-27.6L324-27.6L324-24.1L283.5-24.1Q283.8-15.5 288.5-10.7Q293.3-5.8 301.1-5.8L301.1-5.8Q306.5-5.8 310.3-8.2Q314.1-10.5 315.5-14.9L315.5-14.9L323.5-14.9Q321.6-7.3 315.7-3.2Q309.8 1 301.2 1ZM283.9-30.1L283.9-30.1L316.4-30.1Q315.8-36.8 311.7-40.6Q307.5-44.3 300.8-44.3L300.8-44.3Q294-44.3 289.5-40.6Q285.1-36.8 283.9-30.1ZM354.1 1L354.1 1Q343.9 1 338.0-3.2Q332.1-7.4 331.5-15.0L331.5-15.0L339.3-15.0Q339.9-10.2 343.6-7.8Q347.3-5.5 354.3-5.5L354.3-5.5Q367.1-5.5 367.1-13.7L367.1-13.7Q367.1-17.0 365.1-18.8Q363.2-20.6 358.5-21.4L358.5-21.4L347.6-23.4Q334.0-25.9 334.0-36.4L334.0-36.4Q334.0-43.2 339.1-47.1Q344.2-51.0 353.0-51.0L353.0-51.0Q362.1-51.0 367.5-47.0Q373.0-43.0 373.8-35.8L373.8-35.8L366.2-35.8Q365.3-40.3 362.0-42.4Q358.8-44.5 352.9-44.5L352.9-44.5Q347.3-44.5 344.3-42.5Q341.3-40.6 341.3-36.8L341.3-36.8Q341.3-34.0 343.3-32.4Q345.3-30.8 349.7-29.9L349.7-29.9L360.5-27.9Q367.7-26.6 371.0-23.3Q374.3-19.9 374.3-14.3L374.3-14.3Q374.3-7.0 369.1-3.0Q363.8 1 354.1 1Z",
  chat: "M388.3 1L388.3 1Q385.8 1 384.1-0.8Q382.3-2.5 382.3-5.0L382.3-5.0Q382.3-7.5 384.1-9.3Q385.8-11.0 388.3-11.0L388.3-11.0Q390.8-11.0 392.6-9.3Q394.3-7.5 394.3-5.0L394.3-5.0Q394.3-2.5 392.6-0.8Q390.8 1 388.3 1ZM426.7 1L426.7 1Q419.1 1 413.5-2.2Q407.9-5.4 404.9-11.3Q401.8-17.1 401.8-25.0L401.8-25.0Q401.8-32.9 404.8-38.8Q407.8-44.6 413.4-47.8Q419.0-51.0 426.7-51.0L426.7-51.0Q435.6-51.0 441.6-46.6Q447.6-42.3 449.7-33.8L449.7-33.8L441.7-33.8Q440.2-39.2 436.4-41.7Q432.7-44.2 426.7-44.2L426.7-44.2Q418.6-44.2 414.1-39.1Q409.7-34.1 409.7-25.0L409.7-25.0Q409.7-16 414.1-10.9Q418.6-5.8 426.7-5.8L426.7-5.8Q439.2-5.8 442.0-17.0L442.0-17.0L450.0-17.0Q448.0-8.2 441.9-3.6Q435.8 1 426.7 1ZM466.7 0L458.8 0L458.8-70.0L466.7-70.0L466.7-41.7L467.0-41.7Q469.4-46.2 473.9-48.5Q478.3-50.9 484.3-50.9L484.3-50.9Q493.7-50.9 499.3-45.4Q504.8-39.9 504.8-30.8L504.8-30.8L504.8 0L497.0 0L497.0-29.6Q497.0-36.7 493.1-40.4Q489.3-44.1 481.8-44.1L481.8-44.1Q474.5-44.1 470.6-40.4Q466.7-36.7 466.7-29.6L466.7-29.6L466.7 0ZM533.2 0.9L533.2 0.9Q524.8 0.9 520.0-3.3Q515.2-7.5 515.2-14.2L515.2-14.2Q515.2-21.3 519.9-25.3Q524.6-29.2 533.5-29.2L533.5-29.2L551.5-29.2L551.5-31.5Q551.5-44.3 537.8-44.3L537.8-44.3Q526.6-44.3 524.3-35.8L524.3-35.8L516.3-35.8Q517.5-43.0 523.3-47.0Q529.1-51.0 538.0-51.0L538.0-51.0Q548.2-51.0 553.6-46.1Q559.0-41.3 559.0-32.1L559.0-32.1L559.0-8.3L562.8-8.3L562.8 0L554.2 0L554.2-7.5L550.7-7.5Q548.1-3.7 543.5-1.4Q538.9 0.9 533.2 0.9ZM534.2-5.6L534.2-5.6Q538.9-5.6 542.9-7.6Q546.8-9.6 549.2-13.0Q551.5-16.3 551.5-20.4L551.5-20.4L551.5-23.2L534.1-23.2Q522.5-23.2 522.5-14.5L522.5-14.5Q522.5-10.4 525.6-8Q528.8-5.6 534.2-5.6ZM601.3 0L586.0 0Q582.5 0 580.5-1.8Q578.6-3.6 578.6-7.2L578.6-7.2L578.6-44.0L569.0-44.0L569.0-50.0L578.7-50.0L578.7-65.0L586.3-65.0L586.3-50.0L600.0-50.0L600.0-44.0L586.4-44.0L586.4-6.2L601.3-6.2L601.3 0Z",
};

/** ".chat" in Doto Rounded SemiBold (the logo's dotted ".chat", Logo.tsx), at 100 px from x = 0, baseline y = 0. */
export const DOTTED_CHAT = {
  width: 300,
  d: "M24.9-18.4L24.9-18.4Q23.6-18.4 22.6-17.4Q21.6-16.4 21.6-15.1L21.6-14.9Q21.6-13.6 22.6-12.6Q23.6-11.6 24.9-11.6L25.1-11.6Q26.4-11.6 27.4-12.6Q28.4-13.6 28.4-14.9L28.4-15.1Q28.4-16.4 27.4-17.4Q26.4-18.4 25.1-18.4L24.9-18.4ZM14.9-8.4L14.9-8.4Q13.6-8.4 12.6-7.4Q11.6-6.4 11.6-5.1L11.6-4.9Q11.6-3.6 12.6-2.6Q13.6-1.6 14.9-1.6L15.1-1.6Q16.4-1.6 17.4-2.6Q18.4-3.6 18.4-4.9L18.4-5.1Q18.4-6.4 17.4-7.4Q16.4-8.4 15.1-8.4L14.9-8.4ZM24.9-8.4L24.9-8.4Q23.6-8.4 22.6-7.4Q21.6-6.4 21.6-5.1L21.6-4.9Q21.6-3.6 22.6-2.6Q23.6-1.6 24.9-1.6L25.1-1.6Q26.4-1.6 27.4-2.6Q28.4-3.6 28.4-4.9L28.4-5.1Q28.4-6.4 27.4-7.4Q26.4-8.4 25.1-8.4L24.9-8.4ZM34.9-8.4L34.9-8.4Q33.6-8.4 32.6-7.4Q31.6-6.4 31.6-5.1L31.6-4.9Q31.6-3.6 32.6-2.6Q33.6-1.6 34.9-1.6L35.1-1.6Q36.4-1.6 37.4-2.6Q38.4-3.6 38.4-4.9L38.4-5.1Q38.4-6.4 37.4-7.4Q36.4-8.4 35.1-8.4L34.9-8.4ZM24.9 1.6L24.9 1.6Q23.6 1.6 22.6 2.6Q21.6 3.6 21.6 4.9L21.6 5.1Q21.6 6.4 22.6 7.4Q23.6 8.4 24.9 8.4L25.1 8.4Q26.4 8.4 27.4 7.4Q28.4 6.4 28.4 5.1L28.4 4.9Q28.4 3.6 27.4 2.6Q26.4 1.6 25.1 1.6L24.9 1.6ZM74.9-48.4L74.9-48.4Q73.6-48.4 72.6-47.4Q71.6-46.4 71.6-45.1L71.6-44.9Q71.6-43.6 72.6-42.6Q73.6-41.6 74.9-41.6L75.1-41.6Q76.4-41.6 77.4-42.6Q78.4-43.6 78.4-44.9L78.4-45.1Q78.4-46.4 77.4-47.4Q76.4-48.4 75.1-48.4L74.9-48.4ZM84.9-48.4L84.9-48.4Q83.6-48.4 82.6-47.4Q81.6-46.4 81.6-45.1L81.6-44.9Q81.6-43.6 82.6-42.6Q83.6-41.6 84.9-41.6L85.1-41.6Q86.4-41.6 87.4-42.6Q88.4-43.6 88.4-44.9L88.4-45.1Q88.4-46.4 87.4-47.4Q86.4-48.4 85.1-48.4L84.9-48.4ZM94.9-48.4L94.9-48.4Q93.6-48.4 92.6-47.4Q91.6-46.4 91.6-45.1L91.6-44.9Q91.6-43.6 92.6-42.6Q93.6-41.6 94.9-41.6L95.1-41.6Q96.4-41.6 97.4-42.6Q98.4-43.6 98.4-44.9L98.4-45.1Q98.4-46.4 97.4-47.4Q96.4-48.4 95.1-48.4L94.9-48.4ZM64.9-38.4L64.9-38.4Q63.6-38.4 62.6-37.4Q61.6-36.4 61.6-35.1L61.6-34.9Q61.6-33.6 62.6-32.6Q63.6-31.6 64.9-31.6L65.1-31.6Q66.4-31.6 67.4-32.6Q68.4-33.6 68.4-34.9L68.4-35.1Q68.4-36.4 67.4-37.4Q66.4-38.4 65.1-38.4L64.9-38.4ZM104.9-38.4L104.9-38.4Q103.6-38.4 102.6-37.4Q101.6-36.4 101.6-35.1L101.6-34.9Q101.6-33.6 102.6-32.6Q103.6-31.6 104.9-31.6L105.1-31.6Q106.4-31.6 107.4-32.6Q108.4-33.6 108.4-34.9L108.4-35.1Q108.4-36.4 107.4-37.4Q106.4-38.4 105.1-38.4L104.9-38.4ZM64.9-28.4L64.9-28.4Q63.6-28.4 62.6-27.4Q61.6-26.4 61.6-25.1L61.6-24.9Q61.6-23.6 62.6-22.6Q63.6-21.6 64.9-21.6L65.1-21.6Q66.4-21.6 67.4-22.6Q68.4-23.6 68.4-24.9L68.4-25.1Q68.4-26.4 67.4-27.4Q66.4-28.4 65.1-28.4L64.9-28.4ZM64.9-18.4L64.9-18.4Q63.6-18.4 62.6-17.4Q61.6-16.4 61.6-15.1L61.6-14.9Q61.6-13.6 62.6-12.6Q63.6-11.6 64.9-11.6L65.1-11.6Q66.4-11.6 67.4-12.6Q68.4-13.6 68.4-14.9L68.4-15.1Q68.4-16.4 67.4-17.4Q66.4-18.4 65.1-18.4L64.9-18.4ZM104.9-18.4L104.9-18.4Q103.6-18.4 102.6-17.4Q101.6-16.4 101.6-15.1L101.6-14.9Q101.6-13.6 102.6-12.6Q103.6-11.6 104.9-11.6L105.1-11.6Q106.4-11.6 107.4-12.6Q108.4-13.6 108.4-14.9L108.4-15.1Q108.4-16.4 107.4-17.4Q106.4-18.4 105.1-18.4L104.9-18.4ZM74.9-8.4L74.9-8.4Q73.6-8.4 72.6-7.4Q71.6-6.4 71.6-5.1L71.6-4.9Q71.6-3.6 72.6-2.6Q73.6-1.6 74.9-1.6L75.1-1.6Q76.4-1.6 77.4-2.6Q78.4-3.6 78.4-4.9L78.4-5.1Q78.4-6.4 77.4-7.4Q76.4-8.4 75.1-8.4L74.9-8.4ZM84.9-8.4L84.9-8.4Q83.6-8.4 82.6-7.4Q81.6-6.4 81.6-5.1L81.6-4.9Q81.6-3.6 82.6-2.6Q83.6-1.6 84.9-1.6L85.1-1.6Q86.4-1.6 87.4-2.6Q88.4-3.6 88.4-4.9L88.4-5.1Q88.4-6.4 87.4-7.4Q86.4-8.4 85.1-8.4L84.9-8.4ZM94.9-8.4L94.9-8.4Q93.6-8.4 92.6-7.4Q91.6-6.4 91.6-5.1L91.6-4.9Q91.6-3.6 92.6-2.6Q93.6-1.6 94.9-1.6L95.1-1.6Q96.4-1.6 97.4-2.6Q98.4-3.6 98.4-4.9L98.4-5.1Q98.4-6.4 97.4-7.4Q96.4-8.4 95.1-8.4L94.9-8.4ZM124.9-68.4L124.9-68.4Q123.6-68.4 122.6-67.4Q121.6-66.4 121.6-65.1L121.6-64.9Q121.6-63.6 122.6-62.6Q123.6-61.6 124.9-61.6L125.1-61.6Q126.4-61.6 127.4-62.6Q128.4-63.6 128.4-64.9L128.4-65.1Q128.4-66.4 127.4-67.4Q126.4-68.4 125.1-68.4L124.9-68.4ZM124.9-58.4L124.9-58.4Q123.6-58.4 122.6-57.4Q121.6-56.4 121.6-55.1L121.6-54.9Q121.6-53.6 122.6-52.6Q123.6-51.6 124.9-51.6L125.1-51.6Q126.4-51.6 127.4-52.6Q128.4-53.6 128.4-54.9L128.4-55.1Q128.4-56.4 127.4-57.4Q126.4-58.4 125.1-58.4L124.9-58.4ZM124.9-48.4L124.9-48.4Q123.6-48.4 122.6-47.4Q121.6-46.4 121.6-45.1L121.6-44.9Q121.6-43.6 122.6-42.6Q123.6-41.6 124.9-41.6L125.1-41.6Q126.4-41.6 127.4-42.6Q128.4-43.6 128.4-44.9L128.4-45.1Q128.4-46.4 127.4-47.4Q126.4-48.4 125.1-48.4L124.9-48.4ZM144.9-48.4L144.9-48.4Q143.6-48.4 142.6-47.4Q141.6-46.4 141.6-45.1L141.6-44.9Q141.6-43.6 142.6-42.6Q143.6-41.6 144.9-41.6L145.1-41.6Q146.4-41.6 147.4-42.6Q148.4-43.6 148.4-44.9L148.4-45.1Q148.4-46.4 147.4-47.4Q146.4-48.4 145.1-48.4L144.9-48.4ZM154.9-48.4L154.9-48.4Q153.6-48.4 152.6-47.4Q151.6-46.4 151.6-45.1L151.6-44.9Q151.6-43.6 152.6-42.6Q153.6-41.6 154.9-41.6L155.1-41.6Q156.4-41.6 157.4-42.6Q158.4-43.6 158.4-44.9L158.4-45.1Q158.4-46.4 157.4-47.4Q156.4-48.4 155.1-48.4L154.9-48.4ZM124.9-38.4L124.9-38.4Q123.6-38.4 122.6-37.4Q121.6-36.4 121.6-35.1L121.6-34.9Q121.6-33.6 122.6-32.6Q123.6-31.6 124.9-31.6L125.1-31.6Q126.4-31.6 127.4-32.6Q128.4-33.6 128.4-34.9L128.4-35.1Q128.4-36.4 127.4-37.4Q126.4-38.4 125.1-38.4L124.9-38.4ZM134.9-38.4L134.9-38.4Q133.6-38.4 132.6-37.4Q131.6-36.4 131.6-35.1L131.6-34.9Q131.6-33.6 132.6-32.6Q133.6-31.6 134.9-31.6L135.1-31.6Q136.4-31.6 137.4-32.6Q138.4-33.6 138.4-34.9L138.4-35.1Q138.4-36.4 137.4-37.4Q136.4-38.4 135.1-38.4L134.9-38.4ZM164.9-38.4L164.9-38.4Q163.6-38.4 162.6-37.4Q161.6-36.4 161.6-35.1L161.6-34.9Q161.6-33.6 162.6-32.6Q163.6-31.6 164.9-31.6L165.1-31.6Q166.4-31.6 167.4-32.6Q168.4-33.6 168.4-34.9L168.4-35.1Q168.4-36.4 167.4-37.4Q166.4-38.4 165.1-38.4L164.9-38.4ZM124.9-28.4L124.9-28.4Q123.6-28.4 122.6-27.4Q121.6-26.4 121.6-25.1L121.6-24.9Q121.6-23.6 122.6-22.6Q123.6-21.6 124.9-21.6L125.1-21.6Q126.4-21.6 127.4-22.6Q128.4-23.6 128.4-24.9L128.4-25.1Q128.4-26.4 127.4-27.4Q126.4-28.4 125.1-28.4L124.9-28.4ZM164.9-28.4L164.9-28.4Q163.6-28.4 162.6-27.4Q161.6-26.4 161.6-25.1L161.6-24.9Q161.6-23.6 162.6-22.6Q163.6-21.6 164.9-21.6L165.1-21.6Q166.4-21.6 167.4-22.6Q168.4-23.6 168.4-24.9L168.4-25.1Q168.4-26.4 167.4-27.4Q166.4-28.4 165.1-28.4L164.9-28.4ZM124.9-18.4L124.9-18.4Q123.6-18.4 122.6-17.4Q121.6-16.4 121.6-15.1L121.6-14.9Q121.6-13.6 122.6-12.6Q123.6-11.6 124.9-11.6L125.1-11.6Q126.4-11.6 127.4-12.6Q128.4-13.6 128.4-14.9L128.4-15.1Q128.4-16.4 127.4-17.4Q126.4-18.4 125.1-18.4L124.9-18.4ZM164.9-18.4L164.9-18.4Q163.6-18.4 162.6-17.4Q161.6-16.4 161.6-15.1L161.6-14.9Q161.6-13.6 162.6-12.6Q163.6-11.6 164.9-11.6L165.1-11.6Q166.4-11.6 167.4-12.6Q168.4-13.6 168.4-14.9L168.4-15.1Q168.4-16.4 167.4-17.4Q166.4-18.4 165.1-18.4L164.9-18.4ZM124.9-8.4L124.9-8.4Q123.6-8.4 122.6-7.4Q121.6-6.4 121.6-5.1L121.6-4.9Q121.6-3.6 122.6-2.6Q123.6-1.6 124.9-1.6L125.1-1.6Q126.4-1.6 127.4-2.6Q128.4-3.6 128.4-4.9L128.4-5.1Q128.4-6.4 127.4-7.4Q126.4-8.4 125.1-8.4L124.9-8.4ZM164.9-8.4L164.9-8.4Q163.6-8.4 162.6-7.4Q161.6-6.4 161.6-5.1L161.6-4.9Q161.6-3.6 162.6-2.6Q163.6-1.6 164.9-1.6L165.1-1.6Q166.4-1.6 167.4-2.6Q168.4-3.6 168.4-4.9L168.4-5.1Q168.4-6.4 167.4-7.4Q166.4-8.4 165.1-8.4L164.9-8.4ZM194.9-48.4L194.9-48.4Q193.6-48.4 192.6-47.4Q191.6-46.4 191.6-45.1L191.6-44.9Q191.6-43.6 192.6-42.6Q193.6-41.6 194.9-41.6L195.1-41.6Q196.4-41.6 197.4-42.6Q198.4-43.6 198.4-44.9L198.4-45.1Q198.4-46.4 197.4-47.4Q196.4-48.4 195.1-48.4L194.9-48.4ZM204.9-48.4L204.9-48.4Q203.6-48.4 202.6-47.4Q201.6-46.4 201.6-45.1L201.6-44.9Q201.6-43.6 202.6-42.6Q203.6-41.6 204.9-41.6L205.1-41.6Q206.4-41.6 207.4-42.6Q208.4-43.6 208.4-44.9L208.4-45.1Q208.4-46.4 207.4-47.4Q206.4-48.4 205.1-48.4L204.9-48.4ZM214.9-48.4L214.9-48.4Q213.6-48.4 212.6-47.4Q211.6-46.4 211.6-45.1L211.6-44.9Q211.6-43.6 212.6-42.6Q213.6-41.6 214.9-41.6L215.1-41.6Q216.4-41.6 217.4-42.6Q218.4-43.6 218.4-44.9L218.4-45.1Q218.4-46.4 217.4-47.4Q216.4-48.4 215.1-48.4L214.9-48.4ZM224.9-38.4L224.9-38.4Q223.6-38.4 222.6-37.4Q221.6-36.4 221.6-35.1L221.6-34.9Q221.6-33.6 222.6-32.6Q223.6-31.6 224.9-31.6L225.1-31.6Q226.4-31.6 227.4-32.6Q228.4-33.6 228.4-34.9L228.4-35.1Q228.4-36.4 227.4-37.4Q226.4-38.4 225.1-38.4L224.9-38.4ZM194.9-28.4L194.9-28.4Q193.6-28.4 192.6-27.4Q191.6-26.4 191.6-25.1L191.6-24.9Q191.6-23.6 192.6-22.6Q193.6-21.6 194.9-21.6L195.1-21.6Q196.4-21.6 197.4-22.6Q198.4-23.6 198.4-24.9L198.4-25.1Q198.4-26.4 197.4-27.4Q196.4-28.4 195.1-28.4L194.9-28.4ZM204.9-28.4L204.9-28.4Q203.6-28.4 202.6-27.4Q201.6-26.4 201.6-25.1L201.6-24.9Q201.6-23.6 202.6-22.6Q203.6-21.6 204.9-21.6L205.1-21.6Q206.4-21.6 207.4-22.6Q208.4-23.6 208.4-24.9L208.4-25.1Q208.4-26.4 207.4-27.4Q206.4-28.4 205.1-28.4L204.9-28.4ZM214.9-28.4L214.9-28.4Q213.6-28.4 212.6-27.4Q211.6-26.4 211.6-25.1L211.6-24.9Q211.6-23.6 212.6-22.6Q213.6-21.6 214.9-21.6L215.1-21.6Q216.4-21.6 217.4-22.6Q218.4-23.6 218.4-24.9L218.4-25.1Q218.4-26.4 217.4-27.4Q216.4-28.4 215.1-28.4L214.9-28.4ZM224.9-28.4L224.9-28.4Q223.6-28.4 222.6-27.4Q221.6-26.4 221.6-25.1L221.6-24.9Q221.6-23.6 222.6-22.6Q223.6-21.6 224.9-21.6L225.1-21.6Q226.4-21.6 227.4-22.6Q228.4-23.6 228.4-24.9L228.4-25.1Q228.4-26.4 227.4-27.4Q226.4-28.4 225.1-28.4L224.9-28.4ZM184.9-18.4L184.9-18.4Q183.6-18.4 182.6-17.4Q181.6-16.4 181.6-15.1L181.6-14.9Q181.6-13.6 182.6-12.6Q183.6-11.6 184.9-11.6L185.1-11.6Q186.4-11.6 187.4-12.6Q188.4-13.6 188.4-14.9L188.4-15.1Q188.4-16.4 187.4-17.4Q186.4-18.4 185.1-18.4L184.9-18.4ZM224.9-18.4L224.9-18.4Q223.6-18.4 222.6-17.4Q221.6-16.4 221.6-15.1L221.6-14.9Q221.6-13.6 222.6-12.6Q223.6-11.6 224.9-11.6L225.1-11.6Q226.4-11.6 227.4-12.6Q228.4-13.6 228.4-14.9L228.4-15.1Q228.4-16.4 227.4-17.4Q226.4-18.4 225.1-18.4L224.9-18.4ZM194.9-8.4L194.9-8.4Q193.6-8.4 192.6-7.4Q191.6-6.4 191.6-5.1L191.6-4.9Q191.6-3.6 192.6-2.6Q193.6-1.6 194.9-1.6L195.1-1.6Q196.4-1.6 197.4-2.6Q198.4-3.6 198.4-4.9L198.4-5.1Q198.4-6.4 197.4-7.4Q196.4-8.4 195.1-8.4L194.9-8.4ZM204.9-8.4L204.9-8.4Q203.6-8.4 202.6-7.4Q201.6-6.4 201.6-5.1L201.6-4.9Q201.6-3.6 202.6-2.6Q203.6-1.6 204.9-1.6L205.1-1.6Q206.4-1.6 207.4-2.6Q208.4-3.6 208.4-4.9L208.4-5.1Q208.4-6.4 207.4-7.4Q206.4-8.4 205.1-8.4L204.9-8.4ZM214.9-8.4L214.9-8.4Q213.6-8.4 212.6-7.4Q211.6-6.4 211.6-5.1L211.6-4.9Q211.6-3.6 212.6-2.6Q213.6-1.6 214.9-1.6L215.1-1.6Q216.4-1.6 217.4-2.6Q218.4-3.6 218.4-4.9L218.4-5.1Q218.4-6.4 217.4-7.4Q216.4-8.4 215.1-8.4L214.9-8.4ZM224.9-8.4L224.9-8.4Q223.6-8.4 222.6-7.4Q221.6-6.4 221.6-5.1L221.6-4.9Q221.6-3.6 222.6-2.6Q223.6-1.6 224.9-1.6L225.1-1.6Q226.4-1.6 227.4-2.6Q228.4-3.6 228.4-4.9L228.4-5.1Q228.4-6.4 227.4-7.4Q226.4-8.4 225.1-8.4L224.9-8.4ZM254.9-68.4L254.9-68.4Q253.6-68.4 252.6-67.4Q251.6-66.4 251.6-65.1L251.6-64.9Q251.6-63.6 252.6-62.6Q253.6-61.6 254.9-61.6L255.1-61.6Q256.4-61.6 257.4-62.6Q258.4-63.6 258.4-64.9L258.4-65.1Q258.4-66.4 257.4-67.4Q256.4-68.4 255.1-68.4L254.9-68.4ZM254.9-58.4L254.9-58.4Q253.6-58.4 252.6-57.4Q251.6-56.4 251.6-55.1L251.6-54.9Q251.6-53.6 252.6-52.6Q253.6-51.6 254.9-51.6L255.1-51.6Q256.4-51.6 257.4-52.6Q258.4-53.6 258.4-54.9L258.4-55.1Q258.4-56.4 257.4-57.4Q256.4-58.4 255.1-58.4L254.9-58.4ZM244.9-48.4L244.9-48.4Q243.6-48.4 242.6-47.4Q241.6-46.4 241.6-45.1L241.6-44.9Q241.6-43.6 242.6-42.6Q243.6-41.6 244.9-41.6L245.1-41.6Q246.4-41.6 247.4-42.6Q248.4-43.6 248.4-44.9L248.4-45.1Q248.4-46.4 247.4-47.4Q246.4-48.4 245.1-48.4L244.9-48.4ZM254.9-48.4L254.9-48.4Q253.6-48.4 252.6-47.4Q251.6-46.4 251.6-45.1L251.6-44.9Q251.6-43.6 252.6-42.6Q253.6-41.6 254.9-41.6L255.1-41.6Q256.4-41.6 257.4-42.6Q258.4-43.6 258.4-44.9L258.4-45.1Q258.4-46.4 257.4-47.4Q256.4-48.4 255.1-48.4L254.9-48.4ZM264.9-48.4L264.9-48.4Q263.6-48.4 262.6-47.4Q261.6-46.4 261.6-45.1L261.6-44.9Q261.6-43.6 262.6-42.6Q263.6-41.6 264.9-41.6L265.1-41.6Q266.4-41.6 267.4-42.6Q268.4-43.6 268.4-44.9L268.4-45.1Q268.4-46.4 267.4-47.4Q266.4-48.4 265.1-48.4L264.9-48.4ZM274.9-48.4L274.9-48.4Q273.6-48.4 272.6-47.4Q271.6-46.4 271.6-45.1L271.6-44.9Q271.6-43.6 272.6-42.6Q273.6-41.6 274.9-41.6L275.1-41.6Q276.4-41.6 277.4-42.6Q278.4-43.6 278.4-44.9L278.4-45.1Q278.4-46.4 277.4-47.4Q276.4-48.4 275.1-48.4L274.9-48.4ZM254.9-38.4L254.9-38.4Q253.6-38.4 252.6-37.4Q251.6-36.4 251.6-35.1L251.6-34.9Q251.6-33.6 252.6-32.6Q253.6-31.6 254.9-31.6L255.1-31.6Q256.4-31.6 257.4-32.6Q258.4-33.6 258.4-34.9L258.4-35.1Q258.4-36.4 257.4-37.4Q256.4-38.4 255.1-38.4L254.9-38.4ZM254.9-28.4L254.9-28.4Q253.6-28.4 252.6-27.4Q251.6-26.4 251.6-25.1L251.6-24.9Q251.6-23.6 252.6-22.6Q253.6-21.6 254.9-21.6L255.1-21.6Q256.4-21.6 257.4-22.6Q258.4-23.6 258.4-24.9L258.4-25.1Q258.4-26.4 257.4-27.4Q256.4-28.4 255.1-28.4L254.9-28.4ZM254.9-18.4L254.9-18.4Q253.6-18.4 252.6-17.4Q251.6-16.4 251.6-15.1L251.6-14.9Q251.6-13.6 252.6-12.6Q253.6-11.6 254.9-11.6L255.1-11.6Q256.4-11.6 257.4-12.6Q258.4-13.6 258.4-14.9L258.4-15.1Q258.4-16.4 257.4-17.4Q256.4-18.4 255.1-18.4L254.9-18.4ZM284.9-18.4L284.9-18.4Q283.6-18.4 282.6-17.4Q281.6-16.4 281.6-15.1L281.6-14.9Q281.6-13.6 282.6-12.6Q283.6-11.6 284.9-11.6L285.1-11.6Q286.4-11.6 287.4-12.6Q288.4-13.6 288.4-14.9L288.4-15.1Q288.4-16.4 287.4-17.4Q286.4-18.4 285.1-18.4L284.9-18.4ZM264.9-8.4L264.9-8.4Q263.6-8.4 262.6-7.4Q261.6-6.4 261.6-5.1L261.6-4.9Q261.6-3.6 262.6-2.6Q263.6-1.6 264.9-1.6L265.1-1.6Q266.4-1.6 267.4-2.6Q268.4-3.6 268.4-4.9L268.4-5.1Q268.4-6.4 267.4-7.4Q266.4-8.4 265.1-8.4L264.9-8.4ZM274.9-8.4L274.9-8.4Q273.6-8.4 272.6-7.4Q271.6-6.4 271.6-5.1L271.6-4.9Q271.6-3.6 272.6-2.6Q273.6-1.6 274.9-1.6L275.1-1.6Q276.4-1.6 277.4-2.6Q278.4-3.6 278.4-4.9L278.4-5.1Q278.4-6.4 277.4-7.4Q276.4-8.4 275.1-8.4L274.9-8.4Z",
};

type Edge = [number, number, number, number];

/** M/L/Q/Z path data (absolute, as the outlines above) to line edges, curves flattened. */
export function edges(d: string, scale: number, dx: number, dy: number): Edge[] {
  const out: Edge[] = [];
  const tokens = d.match(/[MLQZ]|-?\d*\.?\d+/g) ?? [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  const P = (px: number, py: number): [number, number] => [dx + px * scale, dy + py * scale];
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (/[MLQZ]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z") {
        out.push([...P(x, y), ...P(sx, sy)]);
        x = sx;
        y = sy;
      }
      continue;
    }
    if (cmd === "M") {
      x = sx = num();
      y = sy = num();
      cmd = "L";
    } else if (cmd === "L") {
      const nx = num();
      const ny = num();
      out.push([...P(x, y), ...P(nx, ny)]);
      x = nx;
      y = ny;
    } else if (cmd === "Q") {
      const cx = num();
      const cy = num();
      const nx = num();
      const ny = num();
      let px = x;
      let py = y;
      for (let k = 1; k <= 8; k++) {
        const s = k / 8;
        const qx = (1 - s) ** 2 * x + 2 * (1 - s) * s * cx + s * s * nx;
        const qy = (1 - s) ** 2 * y + 2 * (1 - s) * s * cy + s * s * ny;
        out.push([...P(px, py), ...P(qx, qy)]);
        px = qx;
        py = qy;
      }
      x = nx;
      y = ny;
    } else i++;
  }
  return out;
}

/** Coverage (0..1) per pixel of the shapes in `e` (non-zero winding), 4×4 samples. */
export function coverage(e: Edge[], w: number, h: number): Float64Array {
  const cov = new Float64Array(w * h);
  const n = 4;
  for (let row = 0; row < h * n; row++) {
    const sy = (row + 0.5) / n;
    const hits: [number, number][] = [];
    for (const [x0, y0, x1, y1] of e) {
      if (y0 === y1 || sy < Math.min(y0, y1) || sy >= Math.max(y0, y1)) continue;
      hits.push([x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    for (let col = 0; col < w * n; col++) {
      const sx = (col + 0.5) / n;
      let wind = 0;
      for (const [hx, dir] of hits) {
        if (hx > sx) break;
        wind += dir;
      }
      if (wind !== 0) cov[Math.floor(row / n) * w + Math.floor(col / n)] += 1 / (n * n);
    }
  }
  return cov;
}

/** A soft shadow under a coverage mask: box-blurred three times, `radius` px. */
export function blur(src: Float64Array, w: number, h: number, radius: number): Float64Array {
  let a = src;
  for (let pass = 0; pass < 3; pass++) {
    const b = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += a[y * w + Math.min(w - 1, Math.max(0, x + k))] as number;
        b[y * w + x] = sum / (2 * radius + 1);
      }
    const c = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += b[Math.min(h - 1, Math.max(0, y + k)) * w + x] as number;
        c[y * w + x] = sum / (2 * radius + 1);
      }
    a = c;
  }
  return a;
}

/** The cover's text shadow under `mask` (rgba(4,32,63,.5), 8 points of blur, 1 point down), then `mask` in white. */
function whiteWithShadow(p: Picture, layers: [Float64Array, number][]) {
  const both = (layers[0] as [Float64Array, number])[0].map((_, i) =>
    Math.min(
      1,
      layers.reduce((s, [m, a]) => s + (m[i] as number) * a, 0),
    ),
  );
  const shadow = blur(both, p.w, p.h, Math.round((8 * p.k) / 3));
  for (let yy = 0; yy < p.h; yy++)
    for (let xx = 0; xx < p.w; xx++) {
      const s = (shadow[Math.max(0, yy - p.k) * p.w + xx] as number) * 0.5;
      if (s > 0.002) p.blend(xx, yy, [4, 32, 63], s);
    }
  for (let i = 0; i < p.w * p.h; i++) {
    const x = i % p.w;
    const yy = Math.floor(i / p.w);
    for (const [m, a] of layers) p.blend(x, yy, WHITE, (m[i] as number) * a);
  }
}

/** The wordmark centred on `cx`, its baseline at `y` (points), `size` points tall, white with the cover's shadow. */
export function wordmark(p: Picture, cx: number, y: number, size: number) {
  const scale = (size * p.k) / 100;
  const dx = cx * p.k - (WORDMARK.width * scale) / 2;
  const dy = y * p.k;
  const main = coverage(edges(WORDMARK.agentes, scale, dx, dy), p.w, p.h);
  const dim = coverage(edges(WORDMARK.chat, scale, dx, dy), p.w, p.h);
  whiteWithShadow(p, [
    [main, 1],
    [dim, 0.6],
  ]);
}

/** "agentes" then the dotted ".chat" (0.72 of the size, 0.08 after it: a little larger than Logo.tsx, whose dots
 *  get thin on a picture), centred on `cx`. */
export function dottedWordmark(p: Picture, cx: number, y: number, size: number) {
  const scale = (size * p.k) / 100;
  const advance = 376; // "agentes"' advance in Funnel Display Light at 100 px
  const gap = 8;
  const width = advance + gap + DOTTED_CHAT.width * 0.72;
  const dx = cx * p.k - (width * scale) / 2;
  const dy = y * p.k;
  const main = coverage(edges(WORDMARK.agentes, scale, dx, dy), p.w, p.h);
  const dot = coverage(edges(DOTTED_CHAT.d, scale * 0.72, dx + (advance + gap) * scale, dy), p.w, p.h);
  whiteWithShadow(p, [
    [main, 1],
    [dot, 0.78],
  ]);
}
