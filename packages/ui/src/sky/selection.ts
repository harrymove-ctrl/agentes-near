/**
 * The chosen sidebar item's sky: a dithered sky that rises
 * from the item's right edge and fades out before the label. An SVG of crisp cells, transparent
 * where the item's own background shows (so it sits on any surface and keeps the item's radius);
 * cached per color and theme. An agent's row uses the agent's color.
 */
import type { AgentColorName } from "../agent/engine.js";
import { agentTones, bayerAt } from "./math";

/** Cells: 72 × 20, drawn at the item's height (2px cells on a 40px item), anchored right. */
const W = 72;
const H = 20;

const cache = new Map<string, string>();

export function selectionSkyUrl(color: AgentColorName = "sky", dark = false): string {
  const key = `${color}:${dark}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tones = agentTones(color);
  // Light rises from the pale end of the sky; dark from the deep end.
  const ramp = dark ? [tones[0], tones[1], tones[2], tones[3]] : [tones[5], tones[4], tones[3], tones[2]];
  const first = ramp[0] ?? "#4b93ff";
  // Level 0 is the item itself; the first two steps are the sky's first tone, see-through.
  const levels: { fill: string; opacity?: number }[] = [
    { fill: "none" },
    { fill: first, opacity: 0.25 },
    { fill: first, opacity: 0.55 },
    ...ramp.map((fill) => ({ fill: fill ?? first })),
  ];
  const n = levels.length - 1;
  const strength = color === "sky" ? 0.8 : 0.92;
  let rects = "";
  for (let y = 0; y < H; y++) {
    let runStart = 0;
    let runLevel = -1;
    for (let x = 0; x <= W; x++) {
      let level = -1;
      if (x < W) {
        const u = x / W;
        let f = u + 0.12 * Math.sin((y / H) * 3.1 + (0.42 + 0.58 * u) * 4);
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        const k = f ** 1.4 * strength * n;
        const lo = Math.floor(k);
        level = Math.min(n, lo + (k - lo > bayerAt(x, y) ? 1 : 0));
      }
      if (level === runLevel) continue;
      const run = levels[runLevel];
      if (run && runLevel > 0) {
        rects += `<rect x="${runStart}" y="${y}" width="${x - runStart}" height="1" fill="${run.fill}"${
          run.opacity ? ` fill-opacity="${run.opacity}"` : ""
        }/>`;
      }
      runStart = x;
      runLevel = level;
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges">${rects}</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  cache.set(key, url);
  return url;
}
