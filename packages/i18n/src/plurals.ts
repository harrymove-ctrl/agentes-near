import type { AppLocale } from "./locale";

export type LocaleStrings = { [key: string]: string | LocaleStrings };

/** Where CLDR's `many` only covers round millions ("1 000 000 de personnes"), the same words as `other`. */
const MANY_IS_OTHER = new Set<AppLocale>(["es", "fr", "it", "pt-BR"]);

/**
 * A language's plural forms its translators may leave out, filled in from `_other`: `_many` where it reads the same,
 * and pt-BR's `_zero` ("0 pessoas", where CLDR says `one`). ru and pl get nothing: their `_few` and `_many` differ.
 * Returns a copy; `strings` is left as it is.
 */
export function fillPluralGaps(code: AppLocale, strings: LocaleStrings): LocaleStrings {
  const many = MANY_IS_OTHER.has(code);
  const zero = code === "pt-BR";
  if (!many && !zero) return strings;
  const walk = (node: LocaleStrings): LocaleStrings => {
    const out: LocaleStrings = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = typeof value === "string" ? value : walk(value);
      if (typeof value !== "string" || !key.endsWith("_other")) continue;
      const base = key.slice(0, -"_other".length);
      if (many && !(`${base}_many` in node)) out[`${base}_many`] = value;
      if (zero && !(`${base}_zero` in node)) out[`${base}_zero`] = value;
    }
    return out;
  };
  return walk(strings);
}
