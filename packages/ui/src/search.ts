/** Lowercase and without accents ("São Paulo" → "sao paulo"): what a search compares. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Whether every word of `query` is in `text`, ignoring case and accents ("glm flash" finds "GLM 5.3 Flash"). */
export function matchesWords(text: string, query: string): boolean {
  const hay = fold(text);
  return fold(query)
    .split(/\s+/)
    .every((word) => hay.includes(word));
}
