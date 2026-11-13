/**
 * The help pages on the docs site (`docsUrl`), in English and the languages that translated them: each holds the
 * background reading that a screen of the app links to once, where it helps.
 */
import { docsUrl } from "../docs";
import { type LegalInline, legalInline } from "../legal";
import { type AppLocale, appLocale } from "../locale";
import { helpDe } from "./pages.de";
import { helpEn } from "./pages.en";
import { helpEs } from "./pages.es";
import { helpFr } from "./pages.fr";
import { helpId } from "./pages.id";
import { helpIt } from "./pages.it";
import { helpJa } from "./pages.ja";
import { helpKo } from "./pages.ko";
import { helpNl } from "./pages.nl";
import { helpPl } from "./pages.pl";
import { helpPtBR } from "./pages.pt-BR";
import { helpRu } from "./pages.ru";
import { helpTr } from "./pages.tr";
import { helpZhHans } from "./pages.zh-Hans";
import type { HelpDocument } from "./types";

export type { HelpBlock, HelpDocument, HelpSection } from "./types";

/** Each page and the edition it speaks to (tests hold a Cloud page to the Cloud's words). */
export const HELP_PAGES = {
  "install-on-a-server": "selfhost",
  "run-on-your-computer": "selfhost",
  "workspace-computer": "cloud",
  import: "both",
  wiki: "both",
  memory: "both",
  approvals: "both",
  "who-answers": "both",
  jev: "selfhost",
  "apps-de-ia": "both",
  computers: "both",
} as const;

export type HelpSlug = keyof typeof HELP_PAGES;

/**
 * Where every self-hosted pointer sends a reader: the installer, the setup, the server's messages and settings. The
 * files that can't import this (`install.sh`, the MIT setup package, the desktop app's Rust, `.env` descriptions)
 * hold the URL as text, and a test keeps them equal.
 */
export const INSTALL_PAGE = "install-on-a-server" satisfies HelpSlug;
export const INSTALL_DOCS_URL = docsUrl("en", INSTALL_PAGE);

export const isHelpSlug = (slug: string): slug is HelpSlug => Object.hasOwn(HELP_PAGES, slug);

/** Every language's pages: English has them all, another language what it translated. */
export const HELP: Record<AppLocale, Partial<Record<HelpSlug, HelpDocument>>> = {
  en: helpEn,
  "pt-BR": helpPtBR,
  es: helpEs,
  fr: helpFr,
  de: helpDe,
  it: helpIt,
  nl: helpNl,
  ja: helpJa,
  ko: helpKo,
  "zh-Hans": helpZhHans,
  id: helpId,
  tr: helpTr,
  pl: helpPl,
  ru: helpRu,
};

/** The page in `locale` ("pt-PT" reads pt-BR), or in English where that language has none. */
export function helpDocument(slug: HelpSlug, locale: string): HelpDocument {
  return HELP[appLocale([locale], true) ?? "en"][slug] ?? helpEn[slug];
}

/**
 * Where an old `/help/<slug>` address goes now: the docs page in `locale`, in English where that language has no
 * page (as `helpDocument`), the docs index for a page that doesn't exist.
 */
export function helpDocsUrl(slug: string | undefined, locale: AppLocale): string {
  if (!slug || !isHelpSlug(slug)) return docsUrl(locale);
  return docsUrl(HELP[locale][slug] ? locale : "en", slug);
}

/** A piece of inline help text: plain, `**bold**`, `` `code` `` or a link. */
export type HelpInline = LegalInline | { kind: "code"; text: string };

/** Code spans, then `[text](href)` links; what's between them goes to `legalInline` (bold and bare links). */
const CODE_OR_LINK = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Splits a line into text, bold, code and links. A URL inside code or a link is never linked twice, and `[[note]]`
 * (the wiki's own syntax) stays plain text.
 */
export function helpInline(line: string): HelpInline[] {
  const out: HelpInline[] = [];
  let last = 0;
  for (const m of line.matchAll(CODE_OR_LINK)) {
    const at = m.index ?? 0;
    if (at > last) out.push(...legalInline(line.slice(last, at)));
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else out.push({ kind: "link", text: m[2] ?? "", href: m[3] ?? "" });
    last = at + m[0].length;
  }
  if (last < line.length) out.push(...legalInline(line.slice(last)));
  return out;
}
