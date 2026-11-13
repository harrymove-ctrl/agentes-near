import { resources as shared } from "@agenteschat/i18n";
import { loadStrings } from "@agenteschat/i18n/load";
import {
  type AppLocale,
  appLocale,
  DEFAULT_LOCALE,
  isAppLocale,
  LOCALE_CODES,
  readyLocales,
} from "@agenteschat/i18n/locale";
import { fillPluralGaps, type LocaleStrings } from "@agenteschat/i18n/plurals";
import { deepMerge } from "@agenteschat/i18n/tree";
import i18next, { type i18n as I18n, type InitOptions } from "i18next";
import { initReactI18next } from "react-i18next";
import type { Platform } from "../control/platform";
import { type DesktopTranslations, desktopEn } from "./keys.en";
import { desktopPtBR } from "./keys.pt-BR";
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
export { DEFAULT_LOCALE };

// ponytail: the desktop's own strings (about 25 KB a language) are all in the bundle, for the cover page to read
// synchronously; the shared ones (about 500 KB a language) load one language at a time (`loadDesktopI18n`).
export const DESKTOP_STRINGS: Record<AppLocale, LocaleStrings> = {
  en: desktopEn,
  "pt-BR": desktopPtBR,
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

/** A language's desktop strings with English under every key it lacks (the cover page reads them without i18next). */
export const desktopStrings = (lng: AppLocale): DesktopTranslations => deepMerge(desktopEn, DESKTOP_STRINGS[lng]);

/**
 * The shared resources (locale → namespace → strings) with the app's own strings under `desktop`
 * in every namespace, so `t("desktop.tray.now")` works next to the shared keys.
 */
export function withDesktopKeys(resources: Record<string, Record<string, object>>) {
  const out: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [locale, namespaces] of Object.entries(resources)) {
    const desktop = isAppLocale(locale) ? fillPluralGaps(locale, DESKTOP_STRINGS[locale]) : {};
    const merged: Record<string, Record<string, unknown>> = {};
    for (const [ns, strings] of Object.entries(namespaces)) merged[ns] = { ...(strings as object), desktop };
    out[locale] = merged;
  }
  return out;
}

/** This computer's choice in Preferences (`agentes.desktop.locale`, shared by every window): a code or "auto". */
export const LOCALE_PREF = "locale";

/** The languages people can pick, each by its own name. */
export const locales = readyLocales().map((l) => ({ code: l.code, label: l.native }));

/** The system's languages (most preferred first) mapped to ours: "pt-PT" → pt-BR, "en-GB" → en, else English. */
export function pickLocale(tags: readonly (string | null | undefined)[]): AppLocale {
  return appLocale(tags) ?? DEFAULT_LOCALE;
}

export function detectedLocale(): AppLocale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  return pickLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

/** The language picked in Preferences, else the system's. */
export function systemLocale(): AppLocale {
  try {
    const raw = localStorage.getItem(`agentes.desktop.${LOCALE_PREF}`);
    const choice = raw ? JSON.parse(raw) : null;
    if (isAppLocale(choice)) return choice;
  } catch {
    // No storage: the system's language.
  }
  return detectedLocale();
}

/** This computer's name in `lng` ("Mac", "PC", "computador"). */
export const deviceName = (lng: AppLocale, platform: Platform) => desktopStrings(lng).device[platform];

/** `{{device}}` is filled in for every string, so callers never pass it. */
const options = (lng: AppLocale, platform: Platform): InitOptions => ({
  lng,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: LOCALE_CODES,
  load: "currentOnly",
  interpolation: { escapeValue: false, defaultVariables: { device: deviceName(lng, platform) } },
  initAsync: false,
  returnNull: false,
});

/** One language's shared strings, downloaded, with the desktop's own under `desktop`. */
const bundleFor = (lng: AppLocale) =>
  loadStrings[lng]().then((strings) => ({ ...strings, desktop: fillPluralGaps(lng, DESKTOP_STRINGS[lng]) }));

/** The app's instance with only `lng` and English (every key's fallback) loaded; English if `lng` can't load. */
export async function loadDesktopI18n(lng: AppLocale, platform: Platform): Promise<I18n> {
  const [en, own] = await Promise.all([
    bundleFor(DEFAULT_LOCALE),
    lng === DEFAULT_LOCALE ? null : bundleFor(lng).catch(() => null),
  ]);
  const use = own ? lng : DEFAULT_LOCALE;
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    ...options(use, platform),
    resources: { [DEFAULT_LOCALE]: { translation: en }, ...(own ? { [lng]: { translation: own } } : {}) },
  });
  return instance;
}

/** An instance with every language loaded at once (tests). */
export function createDesktopI18n(lng: AppLocale = systemLocale(), platform: Platform = "mac"): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({ ...options(lng, platform), resources: withDesktopKeys(shared) });
  return instance;
}

/** The language picked last (a slower download of an earlier pick must not win). */
let wanted: AppLocale | null = null;

/** Shows `instance` in `lng`, with `{{device}}` in that language's words. */
export function switchDesktopLocale(instance: I18n, lng: AppLocale, platform: Platform) {
  wanted = lng;
  const apply = () => {
    if (wanted !== lng) return;
    const interpolation = instance.options.interpolation;
    if (interpolation) interpolation.defaultVariables = { device: deviceName(lng, platform) };
    void instance.changeLanguage(lng);
    document.documentElement.lang = lng;
  };
  if (instance.hasResourceBundle(lng, "translation")) apply();
  else
    bundleFor(lng)
      .then((strings) => {
        instance.addResourceBundle(lng, "translation", strings);
        apply();
      })
      .catch(() => {});
}
