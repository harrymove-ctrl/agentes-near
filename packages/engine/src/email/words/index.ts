import type { AppLocale } from "@agenteschat/i18n/locale";
import { deepMerge } from "@agenteschat/i18n/tree";
import { words as de } from "./de";
import { en, type Words } from "./en";
import { words as es } from "./es";
import { words as fr } from "./fr";
import { words as id } from "./id";
import { words as it } from "./it";
import { words as ja } from "./ja";
import { words as ko } from "./ko";
import { words as nl } from "./nl";
import { words as pl } from "./pl";
import { ptBR } from "./pt-BR";
import { words as ru } from "./ru";
import { words as tr } from "./tr";
import { words as zhHans } from "./zh-Hans";

export type { Words };

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (...args: never[]) => unknown ? T[K] : DeepPartial<T[K]> };
/** A translation of the emails: any word group or word English has, in the same shape. */
export type EmailWords = DeepPartial<Words>;

/** Every language's translation as written (`bun run i18n:status` counts them). */
export const WORDS: Record<AppLocale, EmailWords> = {
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

/** The emails' words in `locale`, English where it has none. */
export const wordsFor = (locale: AppLocale): Words => (locale === "en" ? en : deepMerge(en, WORDS[locale]));
