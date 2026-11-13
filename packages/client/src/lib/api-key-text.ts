/**
 * API keys pasted into a message: everyone in the chat reads it, agents included, so the composer asks
 * before sending one. Shapes only, checked on this device: `sk-ant-…`, `sk-proj-…` and the other `sk-…`
 * keys (20+ characters after `sk-`), and Google's `AIza…`.
 */
const KEY_SHAPES = /(^|[^\w-])(sk-[\w-]{20,}|AIza[\w-]{35})(?![\w-])/g;

/** A key is random: one run of 16+ characters with a digit in it, which a hyphenated word (`sk-learn-…`) lacks. */
const random = (token: string) =>
  token.startsWith("AIza") || token.split("-").some((part) => part.length >= 16 && /\d/.test(part));

/** The first key-shaped token in `text`, or null. */
export function looksLikeApiKey(text: string): string | null {
  for (const m of text.matchAll(KEY_SHAPES)) if (m[2] && random(m[2])) return m[2];
  return null;
}

/** `text` with its key-shaped tokens taken out ("Tirar do texto"). */
export function withoutApiKeys(text: string): string {
  return text
    .replace(KEY_SHAPES, (all, before: string, token: string) => (random(token) ? before : all))
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
