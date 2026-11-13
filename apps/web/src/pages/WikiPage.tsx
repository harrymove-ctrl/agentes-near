import type { WikiPageSummary } from "@agenteschat/client";
import { keys, useWikiPage, useWikiReads, useWikiTrash, useWikiTree } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { outlineOf, type WikiFolder, wikiSlug, wikiTree } from "@agenteschat/client/lib/wiki";
import { Button, Checkbox, EmptyState, GroupHeading, Icon, Kbd, PageHeader, SearchField } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Fragment, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { HelpLink } from "@/components/HelpLink";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { WikiGraphView } from "@/components/WikiGraph";
import { ObsidianMark } from "@/components/wiki/ObsidianMark";
import { WikiAudienceDialog } from "@/components/wiki/WikiAudience";
import { WikiBulkAgentsDialog, WikiBulkDeleteDialog, WikiTrash } from "@/components/wiki/WikiBulk";
import { useVaultDrop, VaultDropOverlay, WikiImportDialog } from "@/components/wiki/WikiImport";
import { AuthorAvatar, PageOutline, WikiReader } from "@/components/wiki/WikiReader";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { copyText } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import type { VaultFile } from "@/lib/obsidian";
import { useToast } from "@/lib/toast";
import "./wiki.css";
import { typingInField } from "@/lib/keys";

/** The suggested start (Visão geral, Processos/Como trabalhamos, Glossário), in the UI language. */
export function starterPages(t: TFunction) {
  const overview = t("wiki.starterPages.overview");
  const how = t("wiki.starterPages.howWeWork");
  const glossary = t("wiki.starterPages.glossary");
  return [
    {
      title: overview,
      folder: "",
      body: `# ${overview}\n\n${t("wiki.starterPages.overviewBody")}\n\n- [[${how}]]\n- [[${glossary}]]\n`,
    },
    {
      title: how,
      folder: t("wiki.starterPages.processes"),
      body: `# ${how}\n\n${t("wiki.starterPages.howWeWorkBody")}\n`,
    },
    { title: glossary, folder: "", body: `# ${glossary}\n\n${t("wiki.starterPages.glossaryBody")}\n` },
  ];
}

/** Imported in the last day and not edited since: marked "novo" in the tree. */
const isFresh = (p: WikiPageSummary) =>
  p.sourceType === "obsidian" && (p.version ?? 1) === 1 && Date.now() - Date.parse(p.updatedAt) < 86_400_000;

type View = "home" | "graph" | "trash";

/**
 * The org wiki: pages on the left
 * (pinned, folders, tags, Obsidian import); the home, a page or the graph in
 * the middle. A vault dropped anywhere opens the import.
 */
export function WikiPage({ slug, newTitle }: { slug?: string; newTitle?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const tree = useWikiTree(org.id);
  const pages = tree.data ?? [];
  const [view, setView] = useState<View>("home");
  const [writing, setWriting] = useState<{ title: string; folder: string } | null>(null);
  const [importing, setImporting] = useState<{ files?: Promise<VaultFile[]> } | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const current = pages.find((p) => p.slug === slug);
  // The open page's outline goes in the tree, under its row (the page itself reads in one column).
  const openPage = useWikiPage(org.id, slug ?? null).data;
  const outline = useMemo(() => {
    if (!openPage) return [];
    const title = openPage.title.trim();
    return outlineOf(openPage.body).filter((h) => !(h.level === 1 && h.text.trim() === title));
  }, [openPage]);

  useEffect(() => {
    if (newTitle === undefined) return;
    const parts = newTitle.split("/");
    setWriting({ title: parts.pop()?.trim() ?? "", folder: parts.join("/") });
  }, [newTitle]);
  useEffect(() => {
    setNavOpen(false);
    if (slug) {
      setView("home");
      setWriting(null);
    }
  }, [slug]);

  // Writing the wiki is a key (`edit_wiki`, ADR 0085): without it, new pages and imports don't start.
  const writes = can(org, "edit_wiki");
  const startNew = (title = "", folder = current?.folder ?? "") => {
    if (!writes) return;
    setWriting({ title, folder });
    setNavOpen(false);
  };
  // N: a new page (when not typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey || typingInField(document.activeElement))
        return;
      if (writing || importing) return;
      e.preventDefault();
      startNew();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const drop = useVaultDrop((files) => setImporting({ files }), writes && importing === null && writing === null);

  let center: ReactNode;
  if (tree.isError && !tree.data) center = <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />;
  else if (writing)
    center = (
      <WikiReader
        key={`new:${writing.title}`}
        initial={writing}
        pages={pages}
        onCreate={startNew}
        onDiscard={() => setWriting(null)}
        onTag={setTag}
      />
    );
  else if (view === "graph") center = <WikiGraphView onOpen={() => setView("home")} />;
  else if (view === "trash") center = <WikiTrash />;
  else if (slug) center = <WikiReader key={slug} slug={slug} pages={pages} onCreate={startNew} onTag={setTag} />;
  else if (tree.isLoading) center = <LoadingCards count={4} />;
  else if (pages.length === 0)
    center = <WikiEmpty onNew={() => startNew()} onImport={() => setImporting({})} onNav={() => setNavOpen(true)} />;
  else
    center = (
      <WikiHome
        pages={pages}
        onNew={() => startNew()}
        onImport={() => setImporting({})}
        onGraph={() => setView("graph")}
        onNav={() => setNavOpen(true)}
      />
    );

  return (
    <div className="wiki" {...drop.props}>
      <WikiNav
        pages={pages}
        loading={tree.isLoading}
        current={writing ? undefined : slug}
        outline={writing || view === "graph" ? [] : outline}
        view={writing ? null : view}
        open={navOpen}
        tag={tag}
        onTag={setTag}
        onHome={() => {
          setView("home");
          setWriting(null);
        }}
        onGraph={() => {
          setView("graph");
          setWriting(null);
          setNavOpen(false);
        }}
        onTrash={() => {
          setView("trash");
          setWriting(null);
          setNavOpen(false);
          if (slug) void navigate({ to: "/org/$orgId/wiki", params: { orgId: org.id } });
        }}
        onNew={() => startNew()}
        onImport={() => setImporting({})}
        onClose={() => setNavOpen(false)}
      />
      {navOpen && (
        <button
          type="button"
          className="wiki__scrim"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setNavOpen(false)}
        />
      )}
      <div className="wiki__center">
        {(slug || writing || view !== "home") && (
          <Button size="sm" variant="ghost" icon="menu" className="wiki__navbtn" onClick={() => setNavOpen(true)}>
            {t("wiki.tree")}
          </Button>
        )}
        {center}
      </div>
      {drop.over && <VaultDropOverlay />}
      {importing && <WikiImportDialog files={importing.files} onClose={() => setImporting(null)} />}
    </div>
  );
}

/** Left pane: search, home and graph, pinned pages, the folder tree, tags, Obsidian import. */
function WikiNav({
  pages,
  loading,
  current,
  outline,
  view,
  open,
  tag,
  onTag,
  onHome,
  onGraph,
  onTrash,
  onNew,
  onImport,
  onClose,
}: {
  pages: WikiPageSummary[];
  loading: boolean;
  current?: string;
  outline: { level: number; text: string; id: string }[];
  view: View | null;
  open: boolean;
  tag: string | null;
  onTag: (tag: string | null) => void;
  onHome: () => void;
  onGraph: () => void;
  onTrash: () => void;
  onNew: () => void;
  onImport: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const writes = can(org, "edit_wiki");
  // Who sees a folder: people who write the wiki and manage roles (the server checks the same).
  const choosesAudience = writes && can(org, "manage_roles");
  // "" is the wiki's root: every page and folder.
  const [audienceFolder, setAudienceFolder] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ folder: string; count: number } | null>(null);
  // Choosing pages to delete or to set their agents at once: the rows become checkboxes.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<"delete" | "agents" | null>(null);
  const uid = useId();
  const trashed = useWikiTrash(org.id, writes).data?.length ?? 0;
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const navigate = useNavigate();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  // A page's right click in the tree: open it, copy its [[link]] (its title's menu on the page has the rest).
  const rowMenu = (p: WikiPageSummary) =>
    entityMenu(() => [
      { kind: "header", label: p.title },
      {
        kind: "item",
        id: "open",
        label: t("contextMenu.open"),
        icon: "arrowRight",
        run: () => void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: p.slug } }),
      },
      {
        kind: "item",
        id: "copy-link",
        label: t("wiki.copyLink"),
        icon: "link",
        run: () => void copyText(`[[${p.title}]]`, () => toast.show(t("wiki.linkCopied", { title: p.title }))),
      },
    ]);
  const query = q.trim().toLowerCase();
  const filtering = Boolean(query || tag);
  const shown = useMemo(
    () =>
      pages.filter(
        (p) =>
          (!query || `${p.title} ${p.folder} ${p.excerpt ?? ""}`.toLowerCase().includes(query)) &&
          (!tag || p.tags.includes(tag)),
      ),
    [pages, query, tag],
  );
  const root = useMemo(() => wikiTree(shown), [shown]);
  const tags = useMemo(() => [...new Set(pages.flatMap((p) => p.tags))].sort(), [pages]);
  const pinned = pages.filter((p) => p.pinned);
  const count = (f: WikiFolder<WikiPageSummary>): number =>
    f.pages.length + f.folders.reduce((n, sub) => n + count(sub), 0);

  const pageRow = (p: WikiPageSummary, inTree = true) =>
    selecting ? (
      <label key={p.slug} className="wiki-row wiki-row--pick" htmlFor={`${uid}-${p.id}`}>
        <Checkbox id={`${uid}-${p.id}`} checked={selected.has(p.id)} onCheckedChange={() => toggle(p.id)} />
        <Icon name={p.locked ? "lock" : "document"} size={14} />
        <span className="wiki-row__t">{p.title}</span>
      </label>
    ) : (
      <Fragment key={p.slug}>
        <Link
          to="/org/$orgId/wiki/$slug"
          params={{ orgId: org.id, slug: p.slug }}
          className="wiki-row"
          aria-current={p.slug === current ? "page" : undefined}
          onClick={onClose}
          {...rowMenu(p)}
        >
          <Icon name={p.locked ? "lock" : "document"} size={14} />
          <span className="wiki-row__t">{p.title}</span>
          {isFresh(p) && <span className="wiki-row__new">{t("wiki.fresh")}</span>}
        </Link>
        {inTree && p.slug === current && outline.length > 0 && <PageOutline items={outline} />}
      </Fragment>
    );
  const folderRows = (f: WikiFolder<WikiPageSummary>): ReactNode => {
    const isOpen = filtering || !closed.has(f.path);
    const limited = f.pages.some((p) => p.audienceFolder === f.path);
    return (
      <Fragment key={f.path}>
        <div className="wiki-folder-row">
          <button
            type="button"
            className="wiki-row wiki-row--folder"
            aria-expanded={isOpen}
            onClick={() => {
              const next = new Set(closed);
              if (next.has(f.path)) next.delete(f.path);
              else next.add(f.path);
              setClosed(next);
            }}
          >
            <Icon name="chevronDown" size={14} className="wiki-row__car" />
            <Icon name="drive" size={14} />
            <span className="wiki-row__t">{f.name}</span>
            <span className="wiki-row__n ac-num">{count(f)}</span>
          </button>
          {choosesAudience ? (
            <button
              type="button"
              className="wiki-folder-row__act"
              data-on={limited || undefined}
              aria-label={t("wiki.audienceFolderTitle", { folder: f.path })}
              title={t("wiki.audienceFolderTitle", { folder: f.path })}
              onClick={() => setAudienceFolder(f.path)}
            >
              <Icon name="eye" size={14} />
            </button>
          ) : limited ? (
            <span className="wiki-folder-row__act" data-on title={t("wiki.restricted")}>
              <Icon name="eye" size={14} />
            </span>
          ) : null}
          {writes && !selecting && (
            <button
              type="button"
              className="wiki-folder-row__act wiki-folder-row__act--del"
              aria-label={t("wiki.bulk.deleteFolder", { folder: f.path })}
              title={t("wiki.bulk.deleteFolder", { folder: f.path })}
              onClick={() => setDeleting({ folder: f.path, count: count(f) })}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
        {isOpen && (
          <div className="wiki-sub">
            {f.folders.map((sub) => folderRows(sub))}
            {f.pages.map((p) => pageRow(p))}
          </div>
        )}
      </Fragment>
    );
  };

  return (
    <aside className="wiki-nav" data-open={open || undefined} aria-label={t("wiki.nav")}>
      {audienceFolder !== null && (
        <WikiAudienceDialog folder={audienceFolder} onClose={() => setAudienceFolder(null)} />
      )}
      {deleting && (
        <WikiBulkDeleteDialog
          target={{ folder: deleting.folder }}
          count={deleting.count}
          what={{ kind: "folder", name: deleting.folder }}
          onClose={() => setDeleting(null)}
        />
      )}
      {bulk === "delete" && (
        <WikiBulkDeleteDialog
          target={{ ids: [...selected] }}
          count={selected.size}
          what={{ kind: "pages" }}
          onClose={() => setBulk(null)}
          onDone={stopSelecting}
        />
      )}
      {bulk === "agents" && (
        <WikiBulkAgentsDialog ids={[...selected]} onClose={() => setBulk(null)} onDone={stopSelecting} />
      )}
      <div className="wiki-nav__head">
        <b>{t("wiki.title")}</b>
        {can(org, "edit_wiki") && (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="plus"
            aria-label={t("wiki.new")}
            title={`${t("wiki.new")} (N)`}
            onClick={onNew}
          />
        )}
      </div>
      <SearchField
        size="sm"
        aria-label={t("wiki.search")}
        placeholder={t("wiki.searchPlaceholder")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onClear={() => setQ("")}
        clearLabel={t("filters.clearSearch")}
      />
      <div className="wiki-nav__list">
        <button
          type="button"
          className="wiki-row"
          aria-current={view === "home" && !current ? "page" : undefined}
          onClick={onHome}
        >
          <Icon name="book" size={14} />
          <span className="wiki-row__t">{t("wiki.home")}</span>
        </button>
        <button
          type="button"
          className="wiki-row"
          aria-current={view === "graph" ? "page" : undefined}
          onClick={onGraph}
        >
          <Icon name="diagram" size={14} />
          <span className="wiki-row__t">{t("wiki.graph")}</span>
          <span className="wiki-row__n ac-num">{pages.length}</span>
        </button>
        {writes && (
          <button
            type="button"
            className="wiki-row"
            aria-current={view === "trash" ? "page" : undefined}
            onClick={onTrash}
          >
            <Icon name="trash" size={14} />
            <span className="wiki-row__t">{t("wiki.trash.title")}</span>
            {trashed > 0 && <span className="wiki-row__n ac-num">{trashed}</span>}
          </button>
        )}
      </div>
      {!filtering && pinned.length > 0 && (
        <section className="wiki-nav__section" aria-label={t("wiki.pinnedPages")}>
          <span className="wiki-label">{t("wiki.pinnedPages")}</span>
          <div className="wiki-nav__list">{pinned.map((p) => pageRow(p, false))}</div>
        </section>
      )}
      {/* An empty wiki has no tree to show (its page says so and how to start): no "Pages" over nothing, and "none
          with that name" only after a search. */}
      {(loading || filtering || pages.length > 0) && (
        <nav className="wiki-nav__section" aria-label={t("wiki.tree")}>
          <span className="wiki-label wiki-label--acts">
            {filtering ? t("wiki.results", { count: shown.length }) : t("wiki.tree")}
            {!filtering && choosesAudience && !selecting && pages.length > 0 && (
              <button
                type="button"
                className="wiki-label__act"
                data-on={pages.some((p) => p.audienceFolder === "") || undefined}
                aria-label={t("wiki.audienceRootTitle")}
                title={t("wiki.audienceRootTitle")}
                onClick={() => setAudienceFolder("")}
              >
                <Icon name="eye" size={14} />
              </button>
            )}
            {writes && pages.length > 0 && (
              <button
                type="button"
                className="wiki-label__act wiki-label__act--text"
                onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
              >
                {selecting ? t("common.cancel") : t("wiki.bulk.select")}
              </button>
            )}
          </span>
          {loading ? (
            <LoadingList count={5} avatar={false} />
          ) : (
            <div className="wiki-nav__list">
              {root.folders.map((f) => folderRows(f))}
              {root.pages.map((p) => pageRow(p))}
              {filtering && shown.length === 0 && <p className="small muted wiki-nav__empty">{t("wiki.noMatch")}</p>}
            </div>
          )}
        </nav>
      )}
      {selecting && (
        <div className="wiki-pickbar" role="toolbar" aria-label={t("wiki.bulk.selected", { count: selected.size })}>
          <label className="wiki-pickbar__all" htmlFor={`${uid}-all`}>
            <Checkbox
              id={`${uid}-all`}
              checked={
                shown.length > 0 && shown.every((p) => selected.has(p.id))
                  ? true
                  : selected.size > 0
                    ? "indeterminate"
                    : false
              }
              onCheckedChange={(on) => setSelected(on ? new Set(shown.map((p) => p.id)) : new Set())}
            />
            <span>{selected.size ? t("wiki.bulk.selected", { count: selected.size }) : t("wiki.bulk.selectAll")}</span>
          </label>
          <span className="wiki-pickbar__acts">
            {choosesAudience && (
              <Button size="sm" icon="agent" disabled={selected.size === 0} onClick={() => setBulk("agents")}>
                {t("wiki.bulk.agents")}
              </Button>
            )}
            <Button
              size="sm"
              variant="danger"
              icon="trash"
              disabled={selected.size === 0}
              onClick={() => setBulk("delete")}
            >
              {t("wiki.bulk.delete")}
            </Button>
          </span>
        </div>
      )}
      {tags.length > 0 && (
        <section className="wiki-nav__section" aria-label={t("wiki.tags")}>
          <span className="wiki-label">{t("wiki.tags")}</span>
          <div className="wiki-tags">
            {tags.map((tg) => (
              <button
                key={tg}
                type="button"
                className="wiki-tag"
                aria-pressed={tag === tg}
                onClick={() => onTag(tag === tg ? null : tg)}
              >
                #{tg}
              </button>
            ))}
          </div>
        </section>
      )}
      {can(org, "edit_wiki") && (
        <button type="button" className="wiki-import-card ac-iconline" onClick={onImport}>
          <ObsidianMark size={20} />
          <span>
            <b>{t("wiki.import.cta")}</b>
            <small>{t("wiki.import.ctaText")}</small>
          </span>
        </button>
      )}
    </aside>
  );
}

function HomeHead({
  onNew,
  onImport,
  onNav,
  empty,
}: {
  onNew: () => void;
  onImport: () => void;
  onNav: () => void;
  /** The empty state below takes over its buttons: one way in, in the middle of the page. */
  empty?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <PageHeader
      title={t("wiki.homeTitle", { org: org.name })}
      meta={
        <>
          {t("wiki.subtitle")} <HelpLink slug="wiki">{t("wiki.how")}</HelpLink>
        </>
      }
      actions={
        <>
          <Button variant="ghost" icon="menu" className="wiki__navbtn" onClick={onNav}>
            {t("wiki.tree")}
          </Button>
          {can(org, "edit_wiki") && !empty && (
            <>
              <Button onClick={onImport}>
                <ObsidianMark size={16} />
                {t("wiki.import.short")}
              </Button>
              <Button variant="primary" icon="plus" onClick={onNew}>
                {t("wiki.new")}
                <Kbd>N</Kbd>
              </Button>
            </>
          )}
        </>
      }
    />
  );
}

/** The home: recently edited pages, what the agents read most, folders and the graph. */
function WikiHome({
  pages,
  onNew,
  onImport,
  onGraph,
  onNav,
}: {
  pages: WikiPageSummary[];
  onNew: () => void;
  onImport: () => void;
  onGraph: () => void;
  onNav: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const reads = useWikiReads(org.id);
  const recent = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const top = (reads.data ?? []).slice(0, 5);
  const max = top[0]?.total ?? 1;
  const tops = wikiTree(pages).folders;
  const count = (f: WikiFolder<WikiPageSummary>): number =>
    f.pages.length + f.folders.reduce((n, sub) => n + count(sub), 0);
  const name = (a: WikiPageSummary["updatedBy"]) =>
    a.type === "agent" ? (dir.agentById.get(a.id)?.name ?? "") : (dir.memberById.get(a.id)?.name ?? "");
  return (
    <div className="wiki-home">
      <HomeHead onNew={onNew} onImport={onImport} onNav={onNav} />
      <div className="ac-groups">
        <section className="wiki-home__sec" aria-label={t("wiki.recent")}>
          <GroupHeading title={t("wiki.recent")} />
          <div className="wiki-cards">
            {recent.map((p) => (
              <Link
                key={p.slug}
                to="/org/$orgId/wiki/$slug"
                params={{ orgId: org.id, slug: p.slug }}
                className="wiki-card"
              >
                {/* The source tag ends the folder's line: a long folder gives way ("…") instead of running under it. */}
                <span className="wiki-card__where">
                  <Icon name={p.locked ? "lock" : "drive"} size={14} />
                  <span className="wiki-card__folder">{p.folder || t("wiki.root")}</span>
                  {p.sourceType === "obsidian" && (
                    <span className="wiki-card__src">
                      <ObsidianMark size={14} />
                      {t("wiki.legend.obsidian")}
                    </span>
                  )}
                </span>
                <b className="wiki-card__title">{p.title}</b>
                {p.excerpt && <span className="wiki-card__text">{p.excerpt}</span>}
                <span className="wiki-card__by ac-iconline">
                  <AuthorAvatar a={p.updatedBy} />
                  <span>
                    <b>{name(p.updatedBy)}</b>
                    {p.updatedBy.onBehalfOf
                      ? ` ${t("wiki.atRequestOf")} ${dir.memberById.get(p.updatedBy.onBehalfOf)?.name ?? ""}`
                      : ""}
                    {" · "}
                    {relativeTime(t, i18n.language, p.updatedAt)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
        <div className="wiki-home__two">
          <section className="wiki-home__sec" aria-label={t("wiki.topReads")}>
            <GroupHeading title={t("wiki.topReads")} note={t("wiki.last7Days")} />
            <div className="wiki-panel">
              {reads.isLoading ? (
                <LoadingList count={3} />
              ) : top.length === 0 ? (
                <p className="wiki-panel__empty small muted">{t("wiki.topReadsEmpty")}</p>
              ) : (
                top.map((r) => (
                  <Link
                    key={r.slug}
                    to="/org/$orgId/wiki/$slug"
                    params={{ orgId: org.id, slug: r.slug }}
                    className="wiki-read"
                  >
                    <span className="wiki-read__crew">
                      {r.agents.slice(0, 3).map((a) => (
                        <AgentAvatar
                          key={a.agentId}
                          agentId={a.agentId}
                          name={dir.agentById.get(a.agentId)?.name ?? ""}
                          size="sm"
                        />
                      ))}
                    </span>
                    <span className="wiki-read__t">
                      <b>{r.title}</b>
                      <small>
                        {r.agents
                          .slice(0, 3)
                          .map((a) => dir.agentById.get(a.agentId)?.name)
                          .filter(Boolean)
                          .join(", ")}
                      </small>
                    </span>
                    <span className="wiki-read__bar" aria-hidden="true">
                      <i style={{ width: `${Math.round((r.total / max) * 100)}%` }} />
                    </span>
                    <span className="ac-num wiki-read__n" title={t("wiki.uses.count", { count: r.total })}>
                      {r.total}
                    </span>
                  </Link>
                ))
              )}
            </div>
          </section>
          <section className="wiki-home__sec" aria-label={t("wiki.folders")}>
            <GroupHeading title={t("wiki.folders")} count={t("wiki.pageCount", { count: pages.length })} />
            <div className="wiki-panel">
              {tops.length > 0 && (
                <div className="wiki-folders">
                  {tops.map((f) => (
                    <div key={f.path} className="wiki-folder">
                      <span className="wiki-folder__icon">
                        <Icon name="drive" size={16} />
                      </span>
                      <span>
                        <b>{f.name}</b>
                        <small>{t("wiki.pageCount", { count: count(f) })}</small>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" className="wiki-minigraph" onClick={onGraph} aria-label={t("wiki.openGraph")}>
                <WikiGraphView mini />
                <span className="wiki-minigraph__label">
                  <Icon name="diagram" size={14} />
                  {t("wiki.openGraph")}
                </span>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** No pages yet: import a vault, the suggested start, or a blank page. */
function WikiEmpty({ onNew, onImport, onNav }: { onNew: () => void; onImport: () => void; onNav: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const look = useRightHandLook();
  const edits = can(org, "edit_wiki");
  return (
    <div className="wiki-home">
      <HomeHead onNew={onNew} onImport={onImport} onNav={onNav} empty />
      <EmptyState
        size="panel"
        agent={look}
        title={t("wiki.emptyTitle")}
        actions={
          edits && (
            <div className="wiki-empty__acts">
              <Button
                variant="primary"
                loading={busy}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    // Straight to the API: the empty state goes away as soon as the first page exists.
                    for (const p of starterPages(t)) {
                      await api.wiki.create(org.id, { title: p.title, folder: p.folder, body: p.body });
                    }
                    void qc.invalidateQueries({ queryKey: keys.wiki(org.id) });
                    toast.show(t("wiki.starterCreated"));
                    void navigate({
                      to: "/org/$orgId/wiki/$slug",
                      params: { orgId: org.id, slug: wikiSlug(t("wiki.starterPages.overview")) },
                    });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("wiki.useStarter")}
              </Button>
              <Button onClick={onImport}>
                <ObsidianMark size={16} />
                {t("wiki.import.cta")}
              </Button>
              <Button variant="ghost" icon="plus" onClick={onNew}>
                {t("wiki.blankPage")}
              </Button>
            </div>
          )
        }
      >
        {t(edits ? "wiki.emptyText" : "wiki.emptyViewer")}
      </EmptyState>
      {edits && (
        <ul className="wiki-starter" aria-label={t("wiki.starter")}>
          {starterPages(t).map((p) => (
            <li key={p.title}>
              <Icon name="document" size={14} />
              {p.folder ? `${p.folder} / ${p.title}` : p.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
