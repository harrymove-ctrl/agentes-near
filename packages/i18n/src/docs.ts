import type { AppLocale } from "./locale";

/** The public docs site (the landing): the same for every edition, self-hosted servers included. */
export const DOCS_SITE = "https://agentes.chat";

/** The landing's language folders: English at the root, Chinese under `zh/`, Portuguese under `pt/`. */
const FOLDER: Partial<Record<AppLocale, string>> = { en: "", "pt-BR": "pt/", "zh-Hans": "zh/" };

/** A docs page (the index without `slug`) in `locale`, at a section. */
export const docsUrl = (locale: AppLocale, slug?: string, section?: string) =>
  `${DOCS_SITE}/${FOLDER[locale] ?? `${locale}/`}docs${slug ? `/${slug}` : ""}${section ? `#${section}` : ""}`;
