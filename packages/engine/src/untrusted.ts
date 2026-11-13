import { cleanOutside, replaceDisguised } from "@agenteschat/adapters";
import { cutText } from "./format";

export { cleanOutside };

/**
 * One envelope for outside content (ADR 0053): an MCP server's answer, an email, a webhook's event,
 * a routine run's own record. The model sees it inside `<external_data source="…">` (the system
 * prompt says what that means: data to weigh, never instructions). Any copy of a closing or opening
 * marker inside the text is neutralised, so the text can't end the block early or open a fake one,
 * and long text is cut with a note. Every place that hands outside text to a model uses this.
 */

/**
 * Markers of every envelope the engine writes, old and current: none may appear inside a block. Spaces after the
 * slash are only looked for after a slash: `\s*\/?\s*` splits a long run of spaces every way before it fails.
 */
const MARKERS =
  /<\s*(?:\/\s*)?(?:external_data|email_content|database_rows|untrusted_data|page_content|thread)\b[^>]*>/gi;

/** Said once when outside text carried characters that hide or reorder it (bidi overrides, tag characters). */
export const HIDDEN_CHARS_NOTE = "[hidden characters removed]";

/** A block's longest text by default (a routine's event or record, not a whole page of results). */
export const UNTRUSTED_MAX_CHARS = 8000;

/** The source label: short, plain, never able to break out of its attribute. */
const sourceLabel = (source: string) =>
  source
    .replace(/[^\p{L}\p{N} .:@/_-]/gu, "")
    .trim()
    .slice(0, 80) || "external";

/**
 * Outside text with characters that hide or reorder it stripped (`cleanOutside`) and every envelope marker
 * neutralised, also when disguised (full-width, zero-width split, look-alike letters: `replaceDisguised`). The rest
 * stays exactly as written, so a file read and written back is unchanged.
 */
export function neutralizeUntrusted(text: string): string {
  const clean = cleanOutside(text);
  const out = replaceDisguised(clean, MARKERS, "[marker removed]");
  return clean !== text ? `${out}\n${HIDDEN_CHARS_NOTE}` : out;
}

/** Outside text inside the `<external_data>` envelope, neutralised and cut to `maxChars`. */
export function untrustedBlock(source: string, text: string, maxChars = UNTRUSTED_MAX_CHARS): string {
  const clean = neutralizeUntrusted(text);
  const body =
    clean.length > maxChars ? `${cutText(clean, maxChars)}\n[… ${clean.length - maxChars} more characters cut]` : clean;
  return `<external_data source="${sourceLabel(source)}">\n${body}\n</external_data>`;
}
