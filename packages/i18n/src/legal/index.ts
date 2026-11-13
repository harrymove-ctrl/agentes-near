/**
 * Terms of Use and Privacy Policy, in English (the version that prevails) and the languages that translated them.
 * The landing page keeps a copy of this folder (`src/i18n/legal`); change both together.
 */
import { type AppLocale, appLocale } from "../locale";
import { legalDe } from "./de";
import { legalEs } from "./es";
import { legalFr } from "./fr";
import { legalId } from "./id";
import { legalIt } from "./it";
import { legalJa } from "./ja";
import { legalKo } from "./ko";
import { legalNl } from "./nl";
import { legalPl } from "./pl";
import { privacyEn } from "./privacy.en";
import { privacyPtBR } from "./privacy.pt-BR";
import { legalRu } from "./ru";
import { termsEn } from "./terms.en";
import { termsPtBR } from "./terms.pt-BR";
import { legalTr } from "./tr";
import type { LegalDocument, LegalKind } from "./types";
import { legalZhHans } from "./zh-Hans";

export type { LegalBlock, LegalDocument, LegalKind, LegalSection } from "./types";

const BY_LOCALE: Record<AppLocale, Partial<Record<LegalKind, LegalDocument>>> = {
  en: { terms: termsEn, privacy: privacyEn },
  "pt-BR": { terms: termsPtBR, privacy: privacyPtBR },
  es: legalEs,
  fr: legalFr,
  de: legalDe,
  it: legalIt,
  nl: legalNl,
  ja: legalJa,
  ko: legalKo,
  "zh-Hans": legalZhHans,
  id: legalId,
  tr: legalTr,
  pl: legalPl,
  ru: legalRu,
};

/** Each page in every language that has it (English always). */
export const legalDocuments = {
  terms: Object.fromEntries(
    Object.entries(BY_LOCALE).flatMap(([code, docs]) => (docs.terms ? [[code, docs.terms]] : [])),
  ) as Partial<Record<AppLocale, LegalDocument>> & Record<"en" | "pt-BR", LegalDocument>,
  privacy: Object.fromEntries(
    Object.entries(BY_LOCALE).flatMap(([code, docs]) => (docs.privacy ? [[code, docs.privacy]] : [])),
  ) as Partial<Record<AppLocale, LegalDocument>> & Record<"en" | "pt-BR", LegalDocument>,
};

/** The page in `locale`, or in English where that language has none. */
export function legalDocument(kind: LegalKind, locale: string): LegalDocument {
  return legalDocuments[kind][appLocale([locale], true) ?? "en"] ?? legalDocuments[kind].en;
}

/** A piece of inline legal text: plain, `**bold**`, or a link (email or https). */
export type LegalInline = { kind: "text" | "bold"; text: string } | { kind: "link"; text: string; href: string };

const LINKS = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+|https:\/\/[^\s)]+[^\s).,;])/g;

/** Splits a line into text, bold and links, for any renderer (React in the apps, HTML at build time). */
export function legalInline(line: string): LegalInline[] {
  const out: LegalInline[] = [];
  line.split("**").forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      out.push({ kind: "bold", text: part });
      return;
    }
    let last = 0;
    for (const m of part.matchAll(LINKS)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ kind: "text", text: part.slice(last, at) });
      const text = m[0];
      out.push({ kind: "link", text, href: text.startsWith("https://") ? text : `mailto:${text}` });
      last = at + text.length;
    }
    if (last < part.length) out.push({ kind: "text", text: part.slice(last) });
  });
  return out;
}
