/**
 * The agent symbol's body in the sky's dither, from the agent engine
 * (../agent/engine.js): a crisp SVG per color and grid, cached as a data URL.
 */

import { bodySvg, bodyTones, ditherCells } from "../agent/engine.js";
import type { AgentColor } from "../components/AgentLook";

export { ditherCells };

/** Five tones of an agent color, deep to light. */
export const ditherTones = (color: AgentColor = "sky"): string[] => bodyTones(color);

/** The body as an SVG string (`cells` × `cells`). */
export const ditherSvg = (color: AgentColor = "sky", cells = 14): string => bodySvg(color, cells);

const cache = new Map<string, string>();

/** The body as a data URL, cached per color and grid. */
export function ditherUrl(color: AgentColor = "sky", cells = 14): string {
  const key = `${color}:${cells}`;
  let url = cache.get(key);
  if (!url) {
    url = `data:image/svg+xml,${encodeURIComponent(bodySvg(color, cells))}`;
    cache.set(key, url);
  }
  return url;
}
