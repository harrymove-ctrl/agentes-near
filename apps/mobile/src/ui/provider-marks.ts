import { markOf, PROVIDER_MARKS } from "@agenteschat/ui/brand/marks";
import type { Scheme } from "./palette";

/** Box and drawing per size, in points: the web's sizes, and `hero` (a page's head, on a raised tile). */
export const LOGO_SIZES = { xs: [14, 14], chip: [20, 12], sm: [30, 16], tile: [48, 26], hero: [64, 34] } as const;
export type LogoSize = keyof typeof LOGO_SIZES;

/** The id of the gradient a mark's main shape is filled with, inside its own drawing. */
export const MARK_GRADIENT = "mark";

/**
 * A maker's mark as drawn on the phone (pure, so it is unit-tested): its shapes in order, each in the maker's
 * colors for this scheme. The main shape takes the brand's color, its gradient, or `ink` for a one-color mark;
 * the parts (Kimi's dot, OpenCode's block) keep their own colors. An image mark has no shapes: `ProviderLogo`
 * draws the phone's own copy of its file. Null for an id with no mark.
 */
export function markShapes(id: string, scheme: Scheme, ink: string) {
  const key = markOf(id);
  if (!key) return null;
  const mark = PROVIDER_MARKS[key];
  if ("image" in mark) return { key, image: true, gradient: null, shapes: [] };
  return {
    key,
    image: false,
    gradient: mark.gradient ?? null,
    shapes: [
      { d: mark.path, fill: mark.gradient ? `url(#${MARK_GRADIENT})` : (mark.color ?? ink) },
      ...(mark.parts ?? []).map((part) => ({
        d: part.path,
        fill: scheme === "dark" ? (part.dark ?? part.color) : part.color,
      })),
    ],
  };
}

/** The ring in the surface's color around each chip of a stack, in points. */
export const STACK_RING = 2;

/**
 * A stack's chips, left to right as given, each after the first drawn 2 pt over the one before: with its ring, it
 * covers only the 4 pt around the mark before it, never the mark (the makers ask for clear space around theirs).
 */
export const stackChips = (ids: readonly string[]) => ids.map((id, i) => ({ id, marginLeft: i === 0 ? 0 : -2 }));
