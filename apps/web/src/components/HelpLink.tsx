import { helpUrl } from "@agenteschat/client/lib/server";
import type { HelpSlug } from "@agenteschat/i18n/help";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * A link to a help page on agentes.chat, in the reader's language, as a help line's link. It carries only the page,
 * the language and the section, and opens a new tab with no referrer, so the site never learns which server the
 * reader came from. Without children, a `<Trans>` tag fills it.
 */
export function HelpLink({ slug, section, children }: { slug: HelpSlug; section?: string; children?: ReactNode }) {
  const { i18n } = useTranslation();
  return (
    <a
      href={helpUrl(slug, i18n.language, section)}
      target="_blank"
      rel="noopener noreferrer"
      className="ac-link ac-link--muted"
    >
      {children}
    </a>
  );
}
