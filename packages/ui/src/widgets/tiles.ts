/**
 * A widget's tones (ADR 0135), the same as the chat's charts: the stroke in the agent's deep tone (its light one on
 * a dark page), the fill a 2px Bayer dither in its light tone. CSS reads them as variables, so bars, a goal's fill,
 * the building sweep and the dashboards' thumbnails share one tile.
 */
import type { CSSProperties } from "react";
import type { AgentColorName } from "../agent/engine.js";
import { chartAreaTones, chartInk } from "../sky/chart";
import { bayerAt } from "../sky/math";

/** Points per dither cell, as the chat's charts draw them. */
export const WIDGET_CELL = 2;

/** The stroke and the fill of an agent color (the color as `AgentAvatar` takes it: a name or a hex). */
export function widgetTones(color: string, dark: boolean): { stroke: string; fill: string } {
  const c = color as AgentColorName;
  return { stroke: chartInk(c, dark), fill: chartAreaTones(c, dark)[0] };
}

const tiles = new Map<string, string>();

/**
 * A 4×4 Bayer tile of `color` at `density` (0..1, the share of cells lit), as a CSS `url()` of an 8×8 SVG: each
 * cell is 2px when drawn at `background-size: 8px 8px`.
 */
export function ditherTile(color: string, density = 0.55): string {
  const key = `${color}|${density}`;
  const hit = tiles.get(key);
  if (hit) return hit;
  let cells = "";
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      if (bayerAt(x, y) < density)
        cells += `<rect x="${x * WIDGET_CELL}" y="${y * WIDGET_CELL}" width="${WIDGET_CELL}" height="${WIDGET_CELL}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" shape-rendering="crispEdges" fill="${color}">${cells}</svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  tiles.set(key, url);
  return url;
}

/**
 * CSS variables for a widget in an agent's tones: `--wg-s` the stroke (and `--wg-c`, the update's flash), `--wg-f`
 * the fill, `--wg-tile` the dither tile (`background: var(--wg-tile) 0 0 / 8px 8px`).
 */
export function widgetTileVars(color: string, dark: boolean): CSSProperties {
  const { stroke, fill } = widgetTones(color, dark);
  return {
    "--wg-s": stroke,
    "--wg-c": stroke,
    "--wg-f": fill,
    "--wg-tile": ditherTile(fill),
  } as CSSProperties;
}
