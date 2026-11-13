/**
 * The app's languages (ADR 0122). English is the source and the default; every other language falls back to it per
 * key. `ready` languages are the ones people can pick and the ones picked for them; the server accepts every code.
 * `weekStart` (0 Sunday, 1 Monday, CLDR) is stored because Firefox has no `Intl.Locale.getWeekInfo`. `script` drives
 * the font rules and the typography checks.
 */
export const LOCALES = [
  { code: "en", native: "English", english: "English", intl: "en-US", weekStart: 0, script: "latin", ready: true },
  {
    code: "pt-BR",
    native: "Português (Brasil)",
    english: "Portuguese (Brazil)",
    intl: "pt-BR",
    weekStart: 0,
    script: "latin",
    ready: true,
  },
  { code: "es", native: "Español", english: "Spanish", intl: "es", weekStart: 1, script: "latin", ready: true },
  { code: "fr", native: "Français", english: "French", intl: "fr-FR", weekStart: 1, script: "latin", ready: true },
  { code: "de", native: "Deutsch", english: "German", intl: "de-DE", weekStart: 1, script: "latin", ready: true },
  { code: "it", native: "Italiano", english: "Italian", intl: "it-IT", weekStart: 1, script: "latin", ready: true },
  { code: "nl", native: "Nederlands", english: "Dutch", intl: "nl-NL", weekStart: 1, script: "latin", ready: true },
  { code: "ja", native: "日本語", english: "Japanese", intl: "ja-JP", weekStart: 0, script: "cjk", ready: true },
  { code: "ko", native: "한국어", english: "Korean", intl: "ko-KR", weekStart: 0, script: "cjk", ready: true },
  {
    code: "zh-Hans",
    native: "简体中文",
    english: "Chinese (Simplified)",
    intl: "zh-CN",
    weekStart: 0,
    script: "cjk",
    ready: true,
  },
  {
    code: "id",
    native: "Bahasa Indonesia",
    english: "Indonesian",
    intl: "id-ID",
    weekStart: 0,
    script: "latin",
    ready: true,
  },
  { code: "tr", native: "Türkçe", english: "Turkish", intl: "tr-TR", weekStart: 1, script: "latin", ready: true },
  { code: "pl", native: "Polski", english: "Polish", intl: "pl-PL", weekStart: 1, script: "latin", ready: true },
  { code: "ru", native: "Русский", english: "Russian", intl: "ru-RU", weekStart: 1, script: "cyrillic", ready: true },
] as const satisfies readonly {
  code: string;
  native: string;
  english: string;
  intl: string;
  weekStart: 0 | 1;
  script: "latin" | "cjk" | "cyrillic";
  ready: boolean;
}[];

export type LocaleInfo = (typeof LOCALES)[number];
export type AppLocale = LocaleInfo["code"];
export const DEFAULT_LOCALE: AppLocale = "en";
/** Every code, for `z.enum` and i18next's `supportedLngs`. */
export const LOCALE_CODES = LOCALES.map((l) => l.code) as [AppLocale, ...AppLocale[]];

const BY_CODE = new Map<string, LocaleInfo>(LOCALES.map((l) => [l.code, l]));

export const localeInfo = (code: AppLocale): LocaleInfo => BY_CODE.get(code) ?? LOCALES[0];

export const isAppLocale = (v: unknown): v is AppLocale => typeof v === "string" && BY_CODE.has(v);

/** The languages people can pick, in the registry's order. */
export const readyLocales = (): LocaleInfo[] => LOCALES.filter((l) => l.ready);

/**
 * One tag's language: pt-PT → pt-BR, es-MX → es, the old Android `in` → id, every Chinese tag → zh-Hans (Traditional
 * Chinese has no translation of its own, and Simplified reads closer than English).
 */
function tagLocale(tag: string): AppLocale | null {
  const base = tag.trim().replace(/_/g, "-").toLowerCase().split("-")[0] ?? "";
  if (base === "pt") return "pt-BR";
  if (base === "zh") return "zh-Hans";
  if (base === "in") return "id";
  return isAppLocale(base) ? base : null;
}

/** The first tag (most preferred first) that matches a language people can pick, or any registry language with `all`. */
export function appLocale(tags: readonly (string | null | undefined)[], all = false): AppLocale | null {
  for (const tag of tags) {
    const code = tag ? tagLocale(tag) : null;
    if (code && (all || localeInfo(code).ready)) return code;
  }
  return null;
}

/**
 * The Intl tag to format with: the person's own browser tag when it is the same language (en-GB keeps 24h and
 * day-first dates), else the registry's.
 */
export function intlLocale(code: AppLocale, browserTags: readonly string[] = []): string {
  const own = browserTags.find((tag) => tagLocale(tag) === code);
  if (!own) return localeInfo(code).intl;
  try {
    return Intl.getCanonicalLocales(own.replace(/_/g, "-"))[0] ?? localeInfo(code).intl;
  } catch {
    return localeInfo(code).intl;
  }
}
