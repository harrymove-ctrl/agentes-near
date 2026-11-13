import { type AppLocale, appLocale, DEFAULT_LOCALE, isAppLocale } from "@agenteschat/i18n/locale";
import { fillPluralGaps, type LocaleStrings } from "@agenteschat/i18n/plurals";
import { deepMerge } from "@agenteschat/i18n/tree";
import { mobileEn } from "./keys.en";
import { mobilePtBR } from "./keys.pt-BR";
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

export type { AppLocale };
export { DEFAULT_LOCALE, deepMerge };

/** The app's own strings per language (English is the source; a missing key falls back to it). */
export const MOBILE: Record<AppLocale, LocaleStrings> = {
  en: mobileEn,
  "pt-BR": mobilePtBR,
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

type Strings = Record<string, unknown>;
type Resources = Record<string, Record<string, Strings>>;

/**
 * The shared resources (`@agenteschat/i18n`, i18next shape: locale -> namespace -> strings) with the app's
 * own strings added under `mobile` in every namespace, so `t("mobile.auth.social.failed")` works with
 * whatever namespace the shared package uses. `extra` adds more `mobile.*` strings per locale (the
 * screens' keys); a key a language lacks falls back to English through i18next's `fallbackLng`.
 */
export function withMobileKeys(
  resources: Record<string, Record<string, object>>,
  extra: Partial<Record<AppLocale, object>> = {},
): Resources {
  const out: Resources = {};
  for (const [locale, namespaces] of Object.entries(resources)) {
    const code = isAppLocale(locale) ? locale : DEFAULT_LOCALE;
    const more = extra[code];
    const mobile = fillPluralGaps(code, more ? deepMerge(MOBILE[code], more) : MOBILE[code]);
    const merged: Record<string, Strings> = {};
    for (const [ns, strings] of Object.entries(namespaces)) merged[ns] = { ...(strings as Strings), mobile };
    out[locale] = merged;
  }
  return out;
}

/** The phone's languages (most preferred first) mapped to ours: "pt-PT" → pt-BR, "en-GB" → en, else English. */
export function pickLocale(tags: readonly (string | null | undefined)[]): AppLocale {
  return appLocale(tags) ?? DEFAULT_LOCALE;
}
