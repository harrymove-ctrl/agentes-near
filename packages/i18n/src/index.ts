/**
 * @agenteschat/i18n: the UI strings of the web, phone and desktop apps (ADR 0035, ADR 0122).
 * English is the source; pt-BR keeps its TypeScript file (its comments are notes for translators); every other
 * language is a JSON file in `locales/`, filled by `bun run i18n:apply`, and falls back to English per key.
 * Apps load one language at a time through `@agenteschat/i18n/load`; this module holds them all (tests, tools).
 */
import { en } from "./en";
import type { AppLocale } from "./locale";
import de from "./locales/de.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import id from "./locales/id.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import nl from "./locales/nl.json";
import pl from "./locales/pl.json";
import ru from "./locales/ru.json";
import tr from "./locales/tr.json";
import zhHans from "./locales/zh-Hans.json";
import { fillPluralGaps, type LocaleStrings } from "./plurals";
import { ptBR } from "./pt-BR";

export { en, type Translations as Strings, type Translations } from "./en";
export { fillPluralGaps, type LocaleStrings } from "./plurals";
export { ptBR } from "./pt-BR";

/** Every language's strings as written. */
export const STRINGS: Record<AppLocale, LocaleStrings> = {
  en,
  "pt-BR": ptBR,
  es,
  fr,
  de,
  it,
  nl,
  ja,
  ko,
  "zh-Hans": zhHans,
  id,
  tr,
  pl,
  ru,
};

/** i18next resources for every language at once, one namespace (`translation`), plural gaps filled. */
export const resources = /* @__PURE__ */ Object.fromEntries(
  Object.entries(STRINGS).map(([code, strings]) => [code, { translation: fillPluralGaps(code as AppLocale, strings) }]),
) as Record<AppLocale, { translation: LocaleStrings }>;

const leafAt = (tree: LocaleStrings, key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>((node, k) => (node && typeof node === "object" ? (node as LocaleStrings)[k] : undefined), tree);

/**
 * A string the server writes itself (a computer's default name) in `code`, English where that language has none,
 * with `{{name}}` filled from `vars`. With `vars.count`, its plural form comes first (`key_one`, `key_few`…), as
 * i18next picks it.
 */
export function serverText(code: AppLocale, key: string, vars: Record<string, string> = {}): string {
  const forms =
    vars.count === undefined ? [] : [`${key}_${new Intl.PluralRules(code).select(Number(vars.count))}`, `${key}_other`];
  for (const k of [...forms, key]) {
    const raw = leafAt(STRINGS[code], k) ?? leafAt(en, k);
    if (typeof raw === "string") return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => vars[name] ?? m);
  }
  return key;
}
