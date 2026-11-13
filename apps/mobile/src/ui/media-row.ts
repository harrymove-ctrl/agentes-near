/**
 * MediaRow's numbers, the web's `.ac-mediarow` (pure: unit-tested). The face 32 in a card's head and 24 in a list row,
 * 12 and 8 from the name; what goes under the name's line is 8 apart, at the row's full width, never in a column beside
 * the face.
 */
export const MEDIA_ROW = {
  card: { face: 32, gap: 12 },
  row: { face: 24, gap: 8 },
  under: 8,
} as const;

export type MediaRowSize = "card" | "row";

/**
 * The face and the name's first line on one axis, however many lines the name wraps to (the web's `--mediarow-axis`),
 * never the wrapped name's middle: the face's middle where the eye reads that line (`textLineOf`). Whichever is
 * shorter moves down; what ends the line sits on the face's middle.
 */
export function mediaRowAxis(face: number, line: { middle: number }) {
  return { face: Math.max(0, line.middle - face / 2), words: Math.max(0, face / 2 - line.middle) };
}
