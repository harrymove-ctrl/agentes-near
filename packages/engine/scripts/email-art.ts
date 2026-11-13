/**
 * The emails' pictures the app's own engines draw, at twice the size the layout shows them:
 *
 *   bun packages/engine/scripts/email-art.ts
 *
 * writes into `apps/web/public/email/` the workspace's computer (`drawComputer` in packages/ui/src/computer/portrait.js)
 * as `COMPUTER` in the layout says, and the onboarding's agents whole, eyes and accessory (`drawAgent` and
 * `drawAccessory` in packages/ui/src/agent/engine.js), as `WHOLE` says. No browser: a canvas of its own takes what the
 * engines draw here (rectangles, rounded ones and a clip; anything else throws), sampled 8×8 a pixel for a canvas's
 * soft edges. A changed drawing gets a new file name (Gmail's image proxy caches by name).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { type Ctx2D, drawAccessory, drawAgent } from "@agenteschat/ui/agent/engine";
import {
  COMPUTER_ART,
  COMPUTER_GRID,
  COMPUTER_ROWS,
  type ComputerCtx,
  drawComputer,
} from "@agenteschat/ui/computer/portrait";
import { COMPUTER, ONBOARDING_CREW, WHOLE, wholeFile } from "../src/email/layout";

/** A box in canvas pixels, its corners' radii [top-left, top-right, bottom-right, bottom-left]. */
type Box = { x: number; y: number; w: number; h: number; r: number[] };

const inside = (b: Box, x: number, y: number) => {
  const [cx, cy] = [b.x + b.w / 2, b.y + b.h / 2];
  const [tl = 0, tr = 0, br = 0, bl = 0] = b.r;
  const r = x < cx ? (y < cy ? tl : bl) : y < cy ? tr : br;
  const dx = Math.max(0, Math.abs(x - cx) - b.w / 2 + r);
  const dy = Math.max(0, Math.abs(y - cy) - b.h / 2 + r);
  return Math.abs(x - cx) <= b.w / 2 && Math.abs(y - cy) <= b.h / 2 && dx * dx + dy * dy <= r * r;
};

/** A `w`×`h` canvas, `k`×`k` samples a pixel; `pixels()` reads it back as straight RGBA. */
function canvas(w: number, h: number, k: number) {
  const [W, H] = [w * k, h * k];
  /** Premultiplied RGBA, each 0..1, a sample each. */
  const px = new Float64Array(W * H * 4);
  /** Scale x, scale y, then translate: the engines here never rotate. */
  let m = [1, 1, 0, 0];
  let clip: Box[] = [];
  let path: Box[] = [];
  let fill = [0, 0, 0, 1];
  const saved: [number[], Box[], number[]][] = [];
  const box = (x: number, y: number, bw: number, bh: number, r = [0]): Box => {
    const [sx = 1, sy = 1, tx = 0, ty = 0] = m;
    const [tl = 0, tr = tl, br = tl, bl = tr] = r;
    return { x: sx * x + tx, y: sy * y + ty, w: sx * bw, h: sy * bh, r: [tl, tr, br, bl].map((v) => v * sx) };
  };
  // Source-over, as a canvas paints; clearing leaves nothing.
  const paint = (boxes: Box[], clear = false) => {
    const [r = 0, g = 0, b = 0, a = 1] = clear ? [0, 0, 0, 0] : fill;
    for (const at of boxes)
      for (let j = Math.max(0, Math.floor(at.y * k)); j < Math.min(H, Math.ceil((at.y + at.h) * k)); j++)
        for (let i = Math.max(0, Math.floor(at.x * k)); i < Math.min(W, Math.ceil((at.x + at.w) * k)); i++) {
          const [x, y] = [(i + 0.5) / k, (j + 0.5) / k];
          if (!inside(at, x, y) || !clip.every((c) => inside(c, x, y))) continue;
          const n = (j * W + i) * 4;
          for (const [c, v] of [r * a, g * a, b * a, a].entries())
            px[n + c] = v + (px[n + c] ?? 0) * (clear ? 0 : 1 - a);
        }
  };
  const ctx = {
    set fillStyle(c: unknown) {
      const s = String(c);
      const rgba = /^rgba?\(([^)]+)\)$/.exec(s)?.[1]?.split(",").map(Number);
      const n = Number.parseInt(s.slice(1, 7), 16);
      fill = rgba
        ? [(rgba[0] ?? 0) / 255, (rgba[1] ?? 0) / 255, (rgba[2] ?? 0) / 255, rgba[3] ?? 1]
        : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    },
    save: () => saved.push([m, clip, fill]),
    restore: () => {
      [m, clip, fill] = saved.pop() ?? [m, clip, fill];
    },
    translate: (x: number, y: number) => {
      const [sx = 1, sy = 1, tx = 0, ty = 0] = m;
      m = [sx, sy, tx + sx * x, ty + sy * y];
    },
    scale: (x: number, y: number) => {
      const [sx = 1, sy = 1, tx = 0, ty = 0] = m;
      m = [sx * x, sy * y, tx, ty];
    },
    beginPath: () => {
      path = [];
    },
    roundRect: (x: number, y: number, bw: number, bh: number, r: number | number[]) => {
      path.push(box(x, y, bw, bh, typeof r === "number" ? [r] : r));
    },
    clip: () => {
      clip = [...clip, ...path];
    },
    fill: () => paint(path),
    fillRect: (x: number, y: number, bw: number, bh: number) => paint([box(x, y, bw, bh)]),
    clearRect: (x: number, y: number, bw: number, bh: number) => paint([box(x, y, bw, bh)], true),
  };
  const pixels = () => {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sum = [0, 0, 0, 0];
        for (let j = 0; j < k; j++)
          for (let i = 0; i < k; i++)
            for (let c = 0; c < 4; c++) sum[c] = (sum[c] ?? 0) + (px[((y * k + j) * W + x * k + i) * 4 + c] ?? 0);
        const [r = 0, g = 0, b = 0, a = 0] = sum;
        out.set(a ? [r, g, b].map((v) => Math.round((v / a) * 255)) : [0, 0, 0], (y * w + x) * 4);
        out[(y * w + x) * 4 + 3] = Math.round((a / (k * k)) * 255);
      }
    return out;
  };
  return { ctx: ctx as unknown as Ctx2D & ComputerCtx, pixels };
}

function save(file: string, w: number, h: number, rgba: Uint8Array) {
  // Each row starts with its filter byte: 0, none.
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, data.length + 8)), data.length + 8);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  // 8 bits a channel, RGBA.
  head.set([8, 6], 8);
  const path = resolve(import.meta.dir, "../../../apps/web/public/email", file);
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", head),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
  console.log(`${path}: ${w}×${h}, shown at ${w / 2}×${h / 2}`);
}

// The computer: a sample a cell, then each cell a square of pixels.
const N = COMPUTER_GRID;
const tower = canvas(N, N, 1);
drawComputer(tower.ctx, COMPUTER.kind, "online", { t: COMPUTER.t });
const cells = tower.pixels();
const [first, drawn] = COMPUTER_ART[COMPUTER.kind];
const [x0, cols] = [first - COMPUTER.margin, drawn + 2 * COMPUTER.margin];
const [y0, rows] = COMPUTER_ROWS[COMPUTER.kind];
const scale = COMPUTER.cell * 2;
const big = new Uint8Array(cols * scale * rows * scale * 4);
for (let y = 0; y < rows * scale; y++)
  for (let x = 0; x < cols * scale; x++) {
    const from = ((y0 + Math.floor(y / scale)) * N + x0 + Math.floor(x / scale)) * 4;
    big.set(cells.subarray(from, from + 4), (y * cols * scale + x) * 4);
  }
save(COMPUTER.file, cols * scale, rows * scale, big);

// The onboarding's agents, each body as the colour faces (`agent-<colour>.png`) draw it: 12 cells.
for (const look of ONBOARDING_CREW) {
  const face = canvas(WHOLE.width * 2, WHOLE.height * 2, 8);
  drawAgent(face.ctx, WHOLE.x * 2, WHOLE.y * 2, WHOLE.body * 2, {
    color: look.color,
    eyes: look.eyes,
    cells: 12,
    after: (ctx, s, frame) => drawAccessory(ctx, s, look.accessory, frame),
  });
  save(wholeFile(look), WHOLE.width * 2, WHOLE.height * 2, face.pixels());
}
