import { type LocaleState, useLocaleSync } from "@agenteschat/client/lib/locale-sync";
import { resources } from "@agenteschat/i18n";
import { loadStrings } from "@agenteschat/i18n/load";
import {
  type AppLocale,
  appLocale,
  DEFAULT_LOCALE,
  isAppLocale,
  LOCALE_CODES,
  localeInfo,
  readyLocales,
} from "@agenteschat/i18n/locale";
import i18n, { type i18n as I18n, type InitOptions } from "i18next";
import { useEffect, useState } from "react";
import { initReactI18next, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";

export type LocaleCode = AppLocale;
export { DEFAULT_LOCALE };

/** The languages people can pick, each by its own name (never translated). */
export const locales = readyLocales().map((l) => ({ code: l.code, label: l.native }));

/**
 * `<Trans>` props for values people typed (a name): interpolated escaped, then shown as the same text. The app's
 * `escapeValue: false` leaves escaping to React, but `<Trans>` parses the interpolated string first, so a typed
 * `<strong>` would become an element.
 */
export const TYPED_VALUES = { tOptions: { interpolation: { escapeValue: true } }, shouldUnescape: true };

/** This browser's language choice: a code, or "auto" (the browser's own). */
const STORAGE_KEY = "agentes.locale";
/** "1" while a choice made signed out waits for the next sign-in to reach the server. */
const PENDING_KEY = "agentes.locale.pending";
/** The landing's language switch (agentes.chat), shared with the app's host. */
const LANDING_COOKIE = "agentes_locale";

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function readLocaleState(): LocaleState {
  const v = read(STORAGE_KEY);
  return { stored: v === "auto" || isAppLocale(v) ? v : null, pending: read(PENDING_KEY) === "1" };
}

export function rememberLocale(store: AppLocale | "auto", pending: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, store);
    if (pending) localStorage.setItem(PENDING_KEY, "1");
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Not persisted; still applies to this tab.
  }
}

/** The browser's own language among those people can pick ("pt-PT" → pt-BR, "en-GB" → en), else English. */
export const detectedLocale = (languages: readonly string[] = browserLanguages()): AppLocale =>
  appLocale(languages) ?? DEFAULT_LOCALE;

const cookieValue = (cookie: string, name: string) =>
  cookie
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

/**
 * The language to start in: this browser's choice, else the one picked on the landing (its cookie), else the
 * browser's own, else English.
 */
export function savedLocale(
  languages: readonly string[] = browserLanguages(),
  cookie: string = typeof document === "undefined" ? "" : document.cookie,
): LocaleCode {
  const { stored } = readLocaleState();
  if (stored && stored !== "auto") return stored;
  if (stored === "auto") return detectedLocale(languages);
  return appLocale([cookieValue(cookie, LANDING_COOKIE)]) ?? detectedLocale(languages);
}

const retryOnce = <T>(load: () => Promise<T>) => load().catch(() => load());

/** Downloads `code` into the instance without switching to it (a page shown in another language). */
export function loadLocale(code: LocaleCode, instance: I18n = i18n): Promise<void> {
  if (instance.hasResourceBundle(code, "translation")) return Promise.resolve();
  return retryOnce(loadStrings[code]).then((strings) => {
    instance.addResourceBundle(code, "translation", strings);
  });
}

/** `t` in `lang` for a page shown in another language than the app's: the app's until `lang` has downloaded. */
export function usePageT(lang: LocaleCode) {
  const { i18n: instance } = useTranslation();
  const [loaded, setLoaded] = useState<LocaleCode | null>(null);
  useEffect(() => {
    loadLocale(lang, instance)
      .then(() => setLoaded(lang))
      .catch(() => {});
  }, [lang, instance]);
  return instance.getFixedT(loaded === lang ? lang : instance.language);
}

/** The language picked last (a slower download of an earlier pick must not win). */
let wanted: LocaleCode | null = null;

/** Shows the app in `code` once it has downloaded (if it can't, the language stays as it was). */
export function setLocale(code: LocaleCode, instance: I18n = i18n) {
  wanted = code;
  const apply = () => {
    if (wanted !== code) return;
    void instance.changeLanguage(code);
    if (typeof document !== "undefined") document.documentElement.lang = code;
  };
  if (instance.hasResourceBundle(code, "translation")) apply();
  else
    loadLocale(code, instance)
      .then(apply)
      .catch(() => {});
}

/** The person's pick in a language picker, kept on this browser (to send at the next sign-in when signed out). */
export function chooseLocale(choice: AppLocale | "auto", instance: I18n, signedIn: boolean): AppLocale {
  const code = choice === "auto" ? detectedLocale() : choice;
  rememberLocale(choice, !signedIn);
  setLocale(code, instance);
  return code;
}

/** What the server should keep for a pick in Settings: the language, or the browser's own and "auto". */
export const localePatch = (choice: AppLocale | "auto") =>
  choice === "auto" ? { locale: detectedLocale(), auto: true } : { locale: choice, auto: false };

/** The signed-in person's language on this browser and on the server, matched once their `/me` arrives (ADR 0122). */
export function useServerLocale(user: { id: string; locale?: string | null; localeAuto?: boolean } | undefined) {
  const { i18n: instance } = useTranslation();
  const api = useApi();
  useLocaleSync({
    user,
    read: readLocaleState,
    detected: () => detectedLocale(),
    apply: (code, store) => {
      rememberLocale(store, false);
      if (code !== instance.language) setLocale(code, instance);
    },
    send: (patch) => api.account.updateMe(patch),
  });
}

const options = (lng: LocaleCode): InitOptions => ({
  lng,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: LOCALE_CODES,
  load: "currentOnly",
  // `device`: this computer's name in the desktop app's words ("Use this Mac"; lib/desktop.ts sets it there).
  interpolation: { escapeValue: false, defaultVariables: { device: "Mac" } },
  initAsync: false,
  returnNull: false,
});

/**
 * The app's instance with only `lng` downloaded (index.html preloads it): a ready language holds every key (ADR 0122),
 * so English, every key's fallback, comes only with one that isn't ready.
 */
export async function loadI18n(lng: LocaleCode): Promise<I18n> {
  const codes = [...new Set<LocaleCode>(localeInfo(lng).ready ? [lng] : [lng, DEFAULT_LOCALE])];
  const strings = await Promise.all(codes.map((code) => retryOnce(loadStrings[code])));
  const instance = i18n.createInstance();
  void instance.use(initReactI18next).init({
    ...options(lng),
    resources: Object.fromEntries(codes.map((code, i) => [code, { translation: strings[i] ?? {} }])),
  });
  return instance;
}

/** An instance with every language loaded at once (tests). */
export function createI18n(lng: LocaleCode = DEFAULT_LOCALE): I18n {
  const instance = i18n.createInstance();
  void instance.use(initReactI18next).init({ ...options(lng), resources });
  return instance;
}
