import type { WikiPageSummary } from "@agenteschat/client";
import { useWikiPage, useWikiTree } from "@agenteschat/client";
import { readsAsPageTitle } from "@agenteschat/client/lib/markdown";
import { resolveWikiLink, splitSection } from "@agenteschat/client/lib/wiki";
import { movesByKeys, Popover, useHoverCard } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { headingId, Markdown, type WikiLinkRenderer } from "@/lib/markdown";

/** The first lines of a page, for the hover card. */
export const previewOf = (body: string, lines = 4) =>
  body
    .split("\n")
    .filter((l) => l.trim() && !/^#\s/.test(l))
    .slice(0, lines)
    .join("\n");

function PreviewCard({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const page = useWikiPage(org.id, slug);
  if (!page.data) return <p className="small muted">{t("common.loading")}</p>;
  return (
    <div className="wiki-preview">
      <span className="wiki-preview__title">{page.data.title}</span>
      {page.data.folder && <span className="small muted">{page.data.folder}</span>}
      <div className="wiki-preview__body">
        <Markdown source={previewOf(page.data.body)} variant="message" excerpt />
      </div>
    </div>
  );
}

/**
 * A `[[link]]`: a chip to the page (hover or focus shows its first lines),
 * or, when the page doesn't exist, a dashed link that offers "Criar página".
 */
export function WikiLinkChip({ title, label, pages }: { title: string; label: string; pages?: WikiPageSummary[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const tree = useWikiTree(org.id, pages === undefined);
  const page = resolveWikiLink(pages ?? tree.data ?? [], title);
  const { section } = splitSection(title);
  // Under a mouse it opens at once. Focus on the link holds it open like a press, until the link's blur.
  const card = useHoverCard(0);
  if (!page && !readsAsPageTitle(title)) return <>{label}</>;
  if (!page) {
    return (
      <button
        type="button"
        className="wiki-link wiki-link--missing"
        title={t("wiki.missingHint", { title })}
        onClick={() =>
          void navigate({
            to: "/org/$orgId/wiki",
            params: { orgId: org.id },
            search: { new: splitSection(title).title },
          })
        }
      >
        {label}
      </button>
    );
  }
  return (
    <Popover
      hover={card}
      // Nothing in it to reach: the focus stays in the box or on the link, whose blur closes it.
      moveFocus={false}
      label={t("wiki.previewOf", { title: page.title })}
      side="top"
      className="wiki-preview-pop"
      trigger={
        <Link
          to="/org/$orgId/wiki/$slug"
          params={{ orgId: org.id, slug: page.slug }}
          hash={section ? `h-${headingId(section)}` : undefined}
          className="wiki-link"
          onFocus={() => {
            if (movesByKeys()) card.onOpenChange(true);
          }}
          onBlur={card.close}
        >
          {label}
        </Link>
      }
    >
      {card.open && <PreviewCard slug={page.slug} />}
    </Popover>
  );
}

/** The renderer to pass to `<Markdown wikiLink>` in chat, issues and the wiki itself. */
export function useWikiLinkRenderer(): WikiLinkRenderer {
  const { org } = useOrg();
  const tree = useWikiTree(org.id);
  const pages = tree.data ?? [];
  return (title, label, key): ReactNode => <WikiLinkChip key={key} title={title} label={label} pages={pages} />;
}
