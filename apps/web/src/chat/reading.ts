/**
 * Long answers open at their start.
 *
 * While the person follows the bottom of the conversation, a new agent answer
 * (or a streamed one growing) that is taller than the list lands with its
 * first line at the top, a little air above it, instead of showing only its
 * last paragraph. Short answers keep sticking to the bottom.
 */

/** Air above the first line of a long answer. */
export const READING_TOP_PAD = 12;

export interface ReadingGeometry {
  /** The list's current scroll position, visible height and content height. */
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** The answer's top, in the list's content coordinates (0 = top of the content). */
  rowTop: number;
  rowHeight: number;
}

/**
 * Where to scroll for the newest answer: `held` when it is taller than the
 * list (its start at the top, the rest below the fold), else the bottom.
 * Never past the bottom nor above the top.
 */
export function readingLanding(g: ReadingGeometry, pad = READING_TOP_PAD): { top: number; held: boolean } {
  const bottom = Math.max(0, g.scrollHeight - g.clientHeight);
  if (g.rowHeight + pad <= g.clientHeight) return { top: bottom, held: false };
  const start = Math.max(0, Math.min(bottom, g.rowTop - pad));
  return start < bottom ? { top: start, held: true } : { top: bottom, held: false };
}
