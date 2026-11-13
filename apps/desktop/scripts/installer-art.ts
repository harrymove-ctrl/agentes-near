/**
 * Draws the Windows installer's pictures (src-tauri/installer/installer.nsi, tauri.windows.conf.json) from the
 * agent engine and the sky's tones, so the installer shows the same agent and sky as the app's cover. Run by CI
 * before `tauri build` on Windows (`bun apps/desktop/scripts/installer-art.ts`).
 *
 * Outputs (ignored by git), 24-bit BMPs at twice the size Windows shows them at 100% (the installer scales them
 * to its controls, so they stay sharp at 150% and 200%):
 *   src-tauri/installer/side.bmp       328×628  the welcome page's side (164×314)
 *   src-tauri/installer/side-done.bmp  328×628  the finish page's side: the same, the agent smiling
 *   src-tauri/installer/header.bmp     300×114  the header of the pages between (150×57)
 *
 * The drawing (sky, agent, wordmark, BMP) is shared with the .dmg's background: pixel-art.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agent, cloud, dither, Picture, type RGB, SKY, WHITE, wordmark } from "./pixel-art";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Pixels per point: everything is drawn at twice the size it shows at 100%. */
const K = 2;

/* ---------- The three pictures ---------- */

/** The welcome and finish pages' side (164×314): the whole sky, the agent and the wordmark in the middle. */
function side(done: boolean): Picture {
  const W = 164;
  const H = 314;
  const p = new Picture(W * K, H * K, K);
  const run = SKY.slice(0, 6);
  dither(p, run, (u, v) => 0.05 + 0.95 * v * v + 0.04 * Math.sin(u * 5));
  cloud(p, 18, 46, 3, run[3] as RGB);
  cloud(p, 112, 92, 2, run[3] as RGB);
  agent(p, (W - 64) / 2, 104, 64, done);
  wordmark(p, W / 2, 200, 21);
  return p;
}

/** The header (150×57), right of the page's title: the sky coming in from the right, the agent on it. */
function header(): Picture {
  const W = 150;
  const H = 57;
  const p = new Picture(W * K, H * K, K);
  const run = [WHITE, ...SKY.slice(0, 6).reverse()];
  dither(p, run, (u, v) => Math.max(0, (u - 0.18) / 0.82) * 0.85 + 0.06 * (v - 0.5));
  agent(p, W - 50, 11, 36);
  return p;
}

const dir = join(root, "src-tauri", "installer");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "side.bmp"), side(false).bmp());
writeFileSync(join(dir, "side-done.bmp"), side(true).bmp());
writeFileSync(join(dir, "header.bmp"), header().bmp());
console.log("installer art: side.bmp, side-done.bmp and header.bmp written");
