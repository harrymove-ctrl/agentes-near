import type { AppLocale } from "@agenteschat/i18n/locale";
import { strings as de } from "./de";
import { en, type PushStrings } from "./en";
import { strings as es } from "./es";
import { strings as fr } from "./fr";
import { strings as id } from "./id";
import { strings as it } from "./it";
import { strings as ja } from "./ja";
import { strings as ko } from "./ko";
import { strings as nl } from "./nl";
import { strings as pl } from "./pl";
import { ptBR } from "./pt-BR";
import { strings as ru } from "./ru";
import { strings as tr } from "./tr";
import { strings as zhHans } from "./zh-Hans";

export type { PushStrings };

/** Every language's translation as written (`bun run i18n:status` counts them). */
export const PUSH: Record<AppLocale, Partial<PushStrings>> = {
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

/** A language's push words, English where it has none. */
export const pushStrings = (locale: AppLocale): PushStrings => ({ ...en, ...PUSH[locale] });
