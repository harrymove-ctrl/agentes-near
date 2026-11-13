import type { AppLocale } from "./locale";
import { fillPluralGaps, type LocaleStrings } from "./plurals";

const json = (code: AppLocale, load: () => Promise<{ default: LocaleStrings }>) => () =>
  load().then((m) => fillPluralGaps(code, m.default));

/** Each language as its own download: an app loads only the one in use (and English, the fallback). */
export const loadStrings: Record<AppLocale, () => Promise<LocaleStrings>> = {
  en: () => import("./en").then((m) => m.en),
  "pt-BR": () => import("./pt-BR").then((m) => fillPluralGaps("pt-BR", m.ptBR)),
  es: json("es", () => import("./locales/es.json")),
  fr: json("fr", () => import("./locales/fr.json")),
  de: json("de", () => import("./locales/de.json")),
  it: json("it", () => import("./locales/it.json")),
  nl: json("nl", () => import("./locales/nl.json")),
  ja: json("ja", () => import("./locales/ja.json")),
  ko: json("ko", () => import("./locales/ko.json")),
  "zh-Hans": json("zh-Hans", () => import("./locales/zh-Hans.json")),
  id: json("id", () => import("./locales/id.json")),
  tr: json("tr", () => import("./locales/tr.json")),
  pl: json("pl", () => import("./locales/pl.json")),
  ru: json("ru", () => import("./locales/ru.json")),
};
