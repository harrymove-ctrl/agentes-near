import type { WikiAuthor, WikiPage as WikiPageData, WikiPageSummary, WikiVersion } from "@agenteschat/client";
import { ApiError, keys, useRoles, useWikiAction, useWikiHistory, useWikiPage } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { fileIcon } from "@agenteschat/client/lib/files";
import { relativeTime, whenAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { type AudienceChoice, EVERYONE } from "@agenteschat/client/lib/who-sees";
import { leafTitle, wikiImportOf } from "@agenteschat/client/lib/wiki";
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Diff,
  diffLines,
  EmptyState,
  Icon,
  Kbd,
  Locked,
  Menu,
  modKey,
  Popover,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { renderIdRef } from "@/chat/IdRef";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usePreviewUrl } from "@/components/artifacts/FileView";
import { MenuEntries } from "@/components/DesktopMenus";
import { ErrorState, LoadingList, LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { WhoSeesButton, WhoSeesDialog } from "@/components/WhoSees";
import { WikiEditor } from "@/components/WikiEditor";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { readComposerDraft, writeComposerDraft } from "@/hooks/useComposerDraft";
import { useDirectory } from "@/hooks/useDirectory";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { copyText, type MenuEntry } from "@/lib/context-menu";
import { entityMenu } from "@/lib/entity-menu";
import { typingInField } from "@/lib/keys";
import { type EmbedRenderer, Markdown } from "@/lib/markdown";
import { isAttachmentName } from "@/lib/obsidian";
import { useToast } from "@/lib/toast";
import { retitled } from "@/lib/wiki-rich";
import { ObsidianMark } from "./ObsidianMark";
import { WikiAskDialog } from "./WikiAsk";
import { WikiAudienceDialog, WikiWhoSeesDialog } from "./WikiAudience";
import { WikiBulkDeleteDialog } from "./WikiBulk";
import { WikiFolderPicker, WikiTagsEdit } from "./WikiProps";
import { WikiRichEditor, type WikiRichEditorHandle } from "./WikiRichEditor";

/** The name of who wrote it, and for whom ("Theo", "Ana"). */
function useNames() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (a: WikiAuthor) => ({
    name: a.type === "agent" ? (dir.agentById.get(a.id)?.name ?? "") : (dir.memberById.get(a.id)?.name ?? ""),
    behalf: a.onBehalfOf ? (dir.memberById.get(a.onBehalfOf)?.name ?? null) : null,
  });
}

/** "por Theo, a pedido de Walter" / "por Walter". */
export function useAuthorLabel() {
  const { t } = useTranslation();
  const names = useNames();
  return (a: WikiAuthor) => {
    const { name, behalf } = names(a);
    return behalf ? t("wiki.byFor", { name, person: behalf }) : t("wiki.by", { name });
  };
}

export function AuthorAvatar({ a, size = "xs" }: { a: WikiAuthor; size?: "xs" | "sm" }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (a.type === "agent") return <AgentAvatar agentId={a.id} name={dir.agentById.get(a.id)?.name ?? ""} size={size} />;
  const m = dir.memberById.get(a.id);
  return <Avatar size={size} name={m?.name ?? "?"} imageUrl={m?.image} />;
}

/** "**Theo** a pedido de **Ana**". */
export function AuthorLine({ a }: { a: WikiAuthor }) {
  const { t } = useTranslation();
  const { name, behalf } = useNames()(a);
  return (
    <span className="wiki-by">
      <AuthorAvatar a={a} />
      <span>
        <b>{name}</b>
        {behalf && (
          <>
            {" "}
            {t("wiki.atRequestOf")} <b>{behalf}</b>
          </>
        )}
      </span>
    </span>
  );
}

/** A version note: ours translated ("criou a página"), a person's as written. */
export function useNoteText() {
  const { t } = useTranslation();
  return (v: WikiVersion) =>
    v.noteCode ? t(`wiki.note.${v.noteCode}`, { ...v.noteParams, defaultValue: v.note ?? "" }) : (v.note ?? "");
}

/** An attachment in the Drive: an image shows, anything else is a file card. */
function Embed({ id, name, block }: { id: string; name: string; block: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const image = /\.(png|jpe?g|gif|webp)$/i.test(name);
  const type = image ? `image/${name.split(".").pop()?.toLowerCase().replace("jpg", "jpeg")}` : "";
  const preview = usePreviewUrl(id, 1, type, image);
  const card = (
    <Link
      to="/org/$orgId/drive"
      params={{ orgId: org.id }}
      search={{ artifact: id }}
      className="wiki-embed"
      data-block={block || undefined}
    >
      <span className="wiki-embed__thumb">
        {preview.url ? <img src={preview.url} alt="" /> : <Icon name={fileIcon(name)} />}
      </span>
      <span className="wiki-embed__text">
        <b>{name}</b>
        <small>{t("wiki.embedInDrive")}</small>
      </span>
    </Link>
  );
  if (image && preview.url && block) {
    return (
      <figure className="wiki-figure">
        <img src={preview.url} alt={name} />
        <figcaption>{card}</figcaption>
      </figure>
    );
  }
  return card;
}

/** `![[…]]`: attachments imported to the Drive; another note embedded shows as its link. */
function useEmbedRenderer(attachments: Record<string, string> | undefined): EmbedRenderer {
  const { t } = useTranslation();
  const wikiLink = useWikiLinkRenderer();
  return (target, key, block) => {
    const name = leafTitle(target);
    const id =
      attachments?.[target] ??
      Object.entries(attachments ?? {}).find(([k]) => leafTitle(k).toLowerCase() === name.toLowerCase())?.[1];
    if (id) return <Embed key={key} id={id} name={name} block={block} />;
    if (!isAttachmentName(target)) return wikiLink(target, name, key);
    return (
      <span key={key} className="wiki-embed wiki-embed--missing" title={t("wiki.embedMissing")}>
        <span className="wiki-embed__thumb">
          <Icon name={fileIcon(name)} />
        </span>
        <span className="wiki-embed__text">
          <b>{name}</b>
          <small>{t("wiki.embedMissing")}</small>
        </span>
      </span>
    );
  };
}

/**
 * The open page's outline, in the tree under its row: the heading at the top of the reading is current, and a click
 * scrolls to it below the page's bar.
 */
export function PageOutline({ items }: { items: { level: number; text: string; id: string }[] }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<string | null>(items[0]?.id ?? null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = items.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => Boolean(e));
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setCurrent(top.target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [items]);
  return (
    <nav className="wiki-toc" aria-label={t("wiki.outline")}>
      {items.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          className="wiki-outline__item"
          data-level={h.level}
          aria-current={current === h.id ? "true" : undefined}
          onClick={(e) => {
            const el = document.getElementById(h.id);
            if (!el) return;
            e.preventDefault();
            el.scrollIntoView({ behavior: "smooth", block: "start" });
            setCurrent(h.id);
          }}
        >
          {h.text}
        </a>
      ))}
    </nav>
  );
}

/** Who sees the page, in a few words: "Todo o workspace", "Diretoria e Theo", "Diretoria e todos os agentes". */
function useAccessLabel(p: WikiPageData) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const roles = useRoles(org.id);
  const dir = useDirectory(org.id);
  const list = (names: string[]) => {
    const shown = names.length > 3 ? [...names.slice(0, 2), t("wiki.access.more", { count: names.length - 2 })] : names;
    return new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(shown);
  };
  const known = (names: (string | undefined)[]) => names.filter((n): n is string => Boolean(n));
  const people = p.audience
    ? known([
        ...p.audience.roleIds.map((id) => roles.data?.roles.find((r) => r.id === id)?.name),
        ...p.audience.userIds.map((id) => dir.memberById.get(id)?.name),
      ])
    : null;
  const agents = p.agentIds ? known(p.agentIds.map((id) => dir.agentById.get(id)?.name)) : null;
  if (!people && !agents) return { limited: false, label: t("wiki.access.everyone") };
  if (!people) {
    return {
      limited: true,
      label: agents?.length ? t("wiki.access.peopleAnd", { agents: list(agents) }) : t("wiki.access.peopleOnly"),
    };
  }
  const names = [...people, ...(agents ?? [])];
  const base = names.length ? list(names) : t("wiki.access.ownersOnly");
  return { limited: true, label: agents === null ? t("wiki.access.withAllAgents", { names: base }) : base };
}

/** The agents that used the page this week, one row each, and the last use. */
function UsesRows({ page }: { page: WikiPageData }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const reads = page.reads;
  const max = reads?.agents[0]?.count ?? 1;
  const last = reads?.last;
  const lastAgent = last ? dir.agentById.get(last.agentId) : undefined;
  if (!reads || reads.total === 0) return <p className="wiki-about__empty">{t("wiki.uses.none")}</p>;
  return (
    <>
      {reads.agents.slice(0, 5).map((r) => (
        <div key={r.agentId} className="wiki-use">
          <AgentAvatar agentId={r.agentId} name={dir.agentById.get(r.agentId)?.name ?? ""} size="xs" />
          <b>{dir.agentById.get(r.agentId)?.name ?? ""}</b>
          <span className="wiki-use__bar" aria-hidden="true">
            <i style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
          </span>
          <span className="wiki-use__n ac-num" title={t("wiki.uses.count", { count: r.count })}>
            {r.count}
          </span>
        </div>
      ))}
      {last && lastAgent && (
        <p className="wiki-about__note">
          {last.channelName
            ? t("wiki.uses.lastIn", {
                name: lastAgent.name,
                when: relativeTime(t, i18n.language, last.at),
                channel: last.channelName,
              })
            : t("wiki.uses.last", { name: lastAgent.name, when: relativeTime(t, i18n.language, last.at) })}
        </p>
      )}
    </>
  );
}

/**
 * The line under the title: who wrote it and when (the history), who sees it (the access, for who chooses it), the
 * agents that use it, the page's state and its tags.
 */
function PageMeta({
  page,
  chooseAudience,
  onAudience,
  onHistory,
  onTag,
}: {
  page: WikiPageData;
  chooseAudience: boolean;
  onAudience: () => void;
  onHistory: () => void;
  onTag: (tag: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const access = useAccessLabel(page);
  const reads = page.reads;
  const accessTitle = page.audienceFolder
    ? t("wiki.audienceFollows", { folder: page.audienceFolder })
    : page.audienceFolder === ""
      ? t("wiki.audienceFollowsRoot")
      : access.limited
        ? t("wiki.restrictedHint")
        : t("wiki.access.everyoneHint");
  const accessInner = (
    <>
      <Icon name={access.limited ? "eye" : "audienceEveryone"} size={14} />
      {access.label}
    </>
  );
  return (
    <div className="wiki-meta">
      <AuthorLine a={page.updatedBy} />
      <button
        type="button"
        className="wiki-meta__when"
        title={whenAt(t, i18n.language, page.updatedAt)}
        onClick={onHistory}
      >
        {t("wiki.editedWhen", { when: relativeTime(t, i18n.language, page.updatedAt) })}
      </button>
      <span className="wiki-meta__dot" aria-hidden="true" />
      {chooseAudience ? (
        <button
          type="button"
          className="wiki-chip wiki-chip--line"
          data-limited={access.limited || undefined}
          title={accessTitle}
          aria-label={t("wiki.access.label", { who: access.label })}
          onClick={onAudience}
        >
          {accessInner}
        </button>
      ) : (
        <span className="wiki-chip wiki-chip--line" data-limited={access.limited || undefined} title={accessTitle}>
          {accessInner}
        </span>
      )}
      {reads && reads.total > 0 && (
        <Popover
          label={t("wiki.uses.title")}
          side="bottom"
          className="wiki-uses-pop"
          trigger={
            <button type="button" className="wiki-chip wiki-chip--line" title={t("wiki.uses.title")}>
              <span className="wiki-chip__crew">
                {reads.agents.slice(0, 3).map((r) => (
                  <AgentAvatar
                    key={r.agentId}
                    agentId={r.agentId}
                    name={dir.agentById.get(r.agentId)?.name ?? ""}
                    size="xs"
                  />
                ))}
              </span>
              {t("wiki.uses.week", { count: reads.total })}
            </button>
          }
        >
          <span className="wiki-label">{t("wiki.uses.title")}</span>
          <UsesRows page={page} />
        </Popover>
      )}
      {page.agentContext && (
        <Chip icon="agent" title={t("wiki.context.hint")}>
          {t("wiki.context.chip")}
        </Chip>
      )}
      {page.canEdit === false && (
        <Chip icon="eye" title={t("wiki.readOnlyHint")}>
          {t("wiki.readOnly")}
        </Chip>
      )}
      {page.locked && (
        <Chip icon="lock" title={t("wiki.lockedHint")}>
          {t("wiki.locked")}
        </Chip>
      )}
      {page.source?.type === "obsidian" && (
        <span className="wiki-chip">
          <ObsidianMark size={14} />
          {t("wiki.fromObsidian")}
        </span>
      )}
      {page.tags.length > 0 && (
        <span className="wiki-meta__tags">
          {page.tags.map((tag) => (
            <button key={tag} type="button" className="wiki-tagword" onClick={() => onTag(tag)}>
              #{tag}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/** Where the page is mentioned: pages, conversations (a DM says who it is with) and issues. */
function Backlinks({ page }: { page: WikiPageData }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (page.backlinks.length === 0)
    return <p className="wiki-about__empty">{t("wiki.noBacklinksHint", { title: page.title })}</p>;
  return (
    <div className="wiki-refs">
      {page.backlinks.map((b) => {
        if (b.kind === "page")
          return (
            <Link
              key={`p:${b.slug}`}
              to="/org/$orgId/wiki/$slug"
              params={{ orgId: org.id, slug: b.slug }}
              className="wiki-ref ac-iconline"
            >
              <Icon name="document" size={16} />
              <span>
                <b>{b.title}</b>
                {b.excerpt && <small>{b.excerpt}</small>}
              </span>
            </Link>
          );
        if (b.kind === "message") {
          const who =
            b.dm?.type === "agent"
              ? dir.agentById.get(b.dm.id)?.name
              : b.dm?.type === "person"
                ? dir.memberById.get(b.dm.id)?.name
                : undefined;
          return (
            <Link
              key={`m:${b.messageId}`}
              to="/org/$orgId/c/$channelId"
              params={{ orgId: org.id, channelId: b.channelId }}
              className="wiki-ref ac-iconline"
            >
              {b.dm ? (
                <AuthorAvatar a={{ type: b.dm.type === "agent" ? "agent" : "person", id: b.dm.id }} />
              ) : (
                <Icon name="channel" size={16} />
              )}
              <span>
                <b>{b.dm ? t("wiki.backlinkDm", { name: who ?? t("wiki.backlinkDmSomeone") }) : `#${b.channelName}`}</b>
                <small>{b.excerpt}</small>
              </span>
            </Link>
          );
        }
        return (
          <Link
            key={`i:${b.number}`}
            to="/org/$orgId/issues/$number"
            params={{ orgId: org.id, number: String(b.number) }}
            className="wiki-ref ac-iconline"
          >
            <Icon name="issues" size={16} />
            <span>
              <b>{`#${b.number} ${b.title}`}</b>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function ShortHistory({ page, onOpen }: { page: WikiPageData; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const history = useWikiHistory(org.id, page.slug, true);
  const names = useNames();
  const note = useNoteText();
  const versions = (history.data ?? []).slice(0, 3);
  return (
    <>
      {history.isLoading && <LoadingList count={2} />}
      <div className="wiki-hist">
        {versions.map((v) => {
          const { name, behalf } = names(v.author);
          return (
            <button key={v.version} type="button" className="wiki-hist__item" onClick={onOpen}>
              <AuthorAvatar a={v.author} />
              <span>
                <b>{name}</b>
                {behalf ? ` ${t("wiki.atRequestOf")} ${behalf}` : ""}
                {note(v) ? ` · ${note(v)}` : ""}
                <small>
                  v{v.version} · {relativeTime(t, i18n.language, v.at)}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {page.version > 3 && (
        <Button size="sm" variant="ghost" className="wiki-about__more" onClick={onOpen}>
          {t("wiki.allVersions", { count: page.version })}
        </Button>
      )}
    </>
  );
}

/** "Sobre a página", after the text: the agents that use it, where it is mentioned, its history and authors. */
function PageAbout({ page, onHistory }: { page: WikiPageData; onHistory: () => void }) {
  const { t } = useTranslation();
  const authorLabel = useAuthorLabel();
  return (
    <section className="wiki-about" aria-label={t("wiki.aside")}>
      <section className="wiki-about__block" aria-label={t("wiki.uses.title")}>
        <span className="wiki-label">{t("wiki.uses.title")}</span>
        <UsesRows page={page} />
      </section>
      <section className="wiki-about__block" aria-label={t("wiki.backlinks")}>
        <span className="wiki-label">
          {t("wiki.backlinks")} <span className="wiki-label__n ac-num">{page.backlinks.length}</span>
        </span>
        <Backlinks page={page} />
      </section>
      <section className="wiki-about__block" aria-label={t("wiki.history")}>
        <span className="wiki-label">{t("wiki.history")}</span>
        <ShortHistory page={page} onOpen={onHistory} />
        <p className="wiki-about__note">{page.authors.map((a) => authorLabel(a)).join(" · ")}</p>
      </section>
    </section>
  );
}

/** The title while editing: as big as the page's, and it wraps (Enter goes to the text). */
function TitleField({
  value,
  onChange,
  autoFocus,
  onEnter,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus: boolean;
  onEnter: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: grows with the text
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="wiki-title-input"
      aria-label={t("wiki.form.title")}
      placeholder={t("wiki.form.titlePlaceholder")}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

type Draft = { title: string; folder: string; tags: string[]; body: string };
type Saved = Draft & { base: number | null };

/** What was left unsaved for a page (or a new one) in this browser, if it still reads. */
function readSaved(userId: string, key: string): Saved | null {
  const raw = readComposerDraft(userId, key)?.text;
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Saved>;
    if (typeof s.title !== "string" || typeof s.body !== "string") return null;
    return {
      title: s.title,
      folder: typeof s.folder === "string" ? s.folder : "",
      tags: Array.isArray(s.tags) ? s.tags.filter((x): x is string => typeof x === "string") : [],
      body: s.body,
      base: typeof s.base === "number" ? s.base : null,
    };
  } catch {
    return null;
  }
}

const sameDraft = (a: Draft, b: Draft) =>
  a.title === b.title && a.folder === b.folder && a.body === b.body && a.tags.join(" ") === b.tags.join(" ");

/**
 * One page, in one column: the trail and the page's actions on a bar that stays on top while it scrolls, the title
 * the full width, who wrote it, who sees it and who uses it under it, the text, then "Sobre a página". Editing
 * happens in place with the visual editor (Markdown one click away); what isn't saved stays in this browser.
 * Without `slug` it is a new page being written (`initial` title and folder).
 */
export function WikiReader({
  slug,
  initial,
  pages,
  onCreate,
  onDiscard,
  onTag,
}: {
  slug?: string;
  initial?: { title: string; folder: string };
  pages: WikiPageSummary[];
  onCreate: (title: string, folder?: string) => void;
  onDiscard?: () => void;
  onTag: (tag: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const page = useWikiPage(org.id, slug ?? null);
  const action = useWikiAction(org.id);
  const wikiLink = useWikiLinkRenderer();
  const isNew = !slug;
  const p = page.data;
  const savedKey = `wiki:${p?.id ?? "new"}`;
  const [draft, setDraft] = useState<Draft | null>(() => {
    if (!isNew) return null;
    const saved = readSaved(me.user.id, "wiki:new");
    return saved && !initial?.title
      ? saved
      : { title: initial?.title ?? "", folder: initial?.folder ?? "", tags: [], body: "" };
  });
  const [base, setBase] = useState<number | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [mode, setMode] = useState<"visual" | "markdown">("visual");
  const [editorKey, setEditorKey] = useState(0);
  const rich = useRef<WikiRichEditorHandle>(null);
  const [conflict, setConflict] = useState<WikiPageData | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteImport, setDeleteImport] = useState(false);
  const [audienceOpen, setAudienceOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const embed = useEmbedRenderer(page.data?.source?.attachments);
  const folders = [...new Set(pages.map((x) => x.folder).filter(Boolean))].sort();
  const look = useRightHandLook();
  // Who edits pages (and pins, moves and deletes them); a locked page, and locking it, only who configures.
  const writes = can(org, "edit_wiki") && p?.canEdit !== false;
  const admin = can(org, "configure");
  // Who sees a page: anyone who edits it (the server checks the same); agents and editors, who manages roles too.
  const choosesAudience = writes;
  const [newAudience, setNewAudience] = useState<AudienceChoice>(EVERYONE);
  const [choosingNew, setChoosingNew] = useState(false);
  const editing = draft !== null;
  const original = useMemo<Draft | null>(
    () =>
      isNew
        ? { title: initial?.title ?? "", folder: initial?.folder ?? "", tags: [], body: "" }
        : p
          ? { title: p.title, folder: p.folder, tags: p.tags, body: p.body }
          : null,
    [isNew, initial?.title, initial?.folder, p],
  );
  const dirty = Boolean(draft && original && !sameDraft(draft, original));

  const startEdit = () => {
    if (!p || !writes) return;
    if (p.locked && !admin) {
      toast.show(t("wiki.lockedHint"), "error");
      return;
    }
    const saved = readSaved(me.user.id, savedKey);
    const fresh = { title: p.title, folder: p.folder, tags: p.tags, body: p.body };
    if (saved && !sameDraft(saved, fresh)) {
      setDraft(saved);
      setBase(saved.base);
      setRecovered(true);
    } else {
      setDraft(fresh);
      setBase(p.version);
      setRecovered(false);
    }
    setEditorKey((k) => k + 1);
  };
  const stopEdit = () => {
    writeComposerDraft(me.user.id, savedKey, "");
    setDraft(null);
    setRecovered(false);
    setMode("visual");
  };

  // What isn't saved stays in this browser while it is written (a page left and opened again picks it up).
  useEffect(() => {
    if (!draft || !original) return;
    const id = setTimeout(() => {
      writeComposerDraft(
        me.user.id,
        savedKey,
        sameDraft(draft, original) ? "" : JSON.stringify({ ...draft, base: base ?? p?.version ?? null }),
      );
    }, 400);
    return () => clearTimeout(id);
  }, [draft, original, base, me.user.id, savedKey, p?.version]);

  // E edits (when not typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "e" || e.metaKey || e.ctrlKey || e.altKey || typingInField(document.activeElement))
        return;
      if (!editing && p) {
        e.preventDefault();
        startEdit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /** The text as it is now: the visual editor is read at the moment of saving. */
  const currentBody = () =>
    draft && mode === "visual" ? (rich.current?.markdown() ?? draft.body) : (draft?.body ?? "");

  const toggleMode = () => {
    if (!draft) return;
    if (mode === "visual") {
      setDraft({ ...draft, body: currentBody() });
      setMode("markdown");
    } else {
      setMode("visual");
      setEditorKey((k) => k + 1);
    }
  };

  const save = async (baseVersion?: number) => {
    if (!draft) return;
    const title = draft.title.trim();
    const body = p ? retitled(currentBody(), p.title, title) : currentBody();
    if (!title) {
      toast.show(t("wiki.form.required"), "error");
      return;
    }
    const tags = draft.tags;
    if (isNew) {
      action.mutate(
        { type: "create", input: { title, folder: draft.folder.trim(), body, tags, audience: newAudience } },
        {
          onSuccess: (created) => {
            toast.show(t("wiki.created"));
            stopEdit();
            void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: created.slug } });
          },
          onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
        },
      );
      return;
    }
    if (!p) return;
    try {
      let current = p;
      const folder = draft.folder.trim();
      const changed = body !== p.body || folder !== p.folder || tags.join(" ") !== p.tags.join(" ");
      if (changed) {
        current = await action.mutateAsync({
          type: "update",
          slug: p.slug,
          input: { body, baseVersion: baseVersion ?? base ?? p.version, folder, tags },
        });
      }
      if (title !== p.title) {
        current = await action.mutateAsync({ type: "rename", slug: current.slug, title });
        void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: current.slug } });
      }
      stopEdit();
      setConflict(null);
      toast.show(title !== p.title ? t("wiki.renamed") : t("wiki.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") {
        const latest = await api.wiki.get(org.id, p.slug);
        qc.setQueryData(keys.wikiPage(org.id, p.slug), latest);
        setDraft((d) => (d ? { ...d, body } : d));
        setConflict(latest);
      } else toast.show(errorText(t, e, i18n.language), "error");
    }
  };

  if (!isNew && page.isLoading) return <LoadingPage rows={4} />;
  if (!isNew && !p) {
    if (page.error instanceof ApiError && page.error.code === "wiki.no_access") {
      return (
        <div className="wiki-doc">
          <EmptyState icon="lock" title={t("wiki.noAccessTitle")}>
            {t("wiki.noAccessText")}
          </EmptyState>
        </div>
      );
    }
    const missing = (page.error as { status?: number } | null)?.status === 404;
    const title = leafTitle(slug?.split("/").pop()?.replace(/-/g, " ") ?? "");
    return missing ? (
      <div className="wiki-doc">
        <EmptyState
          size="page"
          agent={look}
          mood="thinking"
          title={t("wiki.missingTitle")}
          actions={
            can(org, "edit_wiki") && (
              <Button
                variant="primary"
                icon="plus"
                onClick={() => onCreate(title.charAt(0).toUpperCase() + title.slice(1))}
              >
                {t("wiki.createPage")}
              </Button>
            )
          }
        >
          {t(can(org, "edit_wiki") ? "wiki.missingText" : "wiki.missingViewer")}
        </EmptyState>
      </div>
    ) : (
      <ErrorState error={page.error} onRetry={() => void page.refetch()} />
    );
  }

  const crumbs = (editing ? draft.folder : (p?.folder ?? "")).split("/").filter(Boolean);
  const imported = p ? wikiImportOf(pages, p) : null;
  // The page's actions: its "…" and the right click on its title.
  const pageEntries = (p: WikiPageData): MenuEntry[] => [
    {
      kind: "item",
      id: "copy-link",
      label: t("wiki.copyLink"),
      icon: "link",
      run: () => void copyText(`[[${p.title}]]`, () => toast.show(t("wiki.linkCopied", { title: p.title }))),
    },
    { kind: "item", id: "history", label: t("wiki.history"), icon: "clock", run: () => setHistoryOpen(true) },
    ...(writes || admin ? ([{ kind: "separator" }] satisfies MenuEntry[]) : []),
    ...(writes
      ? ([
          { kind: "item", id: "rename", label: t("wiki.renameOrMove"), icon: "edit", run: startEdit },
          {
            kind: "item",
            id: "pin",
            label: p.pinned ? t("wiki.unpin") : t("wiki.pin"),
            icon: "pin",
            run: () =>
              action.mutate(
                { type: "pin", slug: p.slug, pinned: !p.pinned },
                { onSuccess: (x) => toast.show(x.pinned ? t("wiki.pinned") : t("wiki.unpinned")) },
              ),
          },
          {
            kind: "item",
            id: "context",
            label: p.agentContext ? t("wiki.context.off") : t("wiki.context.on"),
            icon: "agent",
            run: () =>
              action.mutate(
                { type: "context", slug: p.slug, on: !p.agentContext },
                {
                  onSuccess: (x) => toast.show(x.agentContext ? t("wiki.context.added") : t("wiki.context.removed")),
                  onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
                },
              ),
          },
        ] satisfies MenuEntry[])
      : []),
    ...(choosesAudience && can(org, "manage_roles")
      ? ([
          { kind: "item", id: "audience", label: t("wiki.audience"), icon: "eye", run: () => setAccessOpen(true) },
        ] satisfies MenuEntry[])
      : []),
    ...(admin
      ? ([
          {
            kind: "item",
            id: "lock",
            label: p.locked ? t("wiki.unlock") : t("wiki.lock"),
            icon: "lock",
            run: () =>
              action.mutate(
                { type: "lock", slug: p.slug, locked: !p.locked },
                { onSuccess: (x) => toast.show(x.locked ? t("wiki.lockedDone") : t("wiki.unlockedDone")) },
              ),
          },
        ] satisfies MenuEntry[])
      : []),
    ...(writes
      ? ([
          { kind: "separator" },
          {
            kind: "item",
            id: "delete",
            label: t("wiki.delete"),
            icon: "trash",
            danger: true,
            run: () => setConfirmDelete(true),
          },
          ...(imported
            ? ([
                {
                  kind: "item",
                  id: "delete-import",
                  label: t("wiki.bulk.deleteImport", { name: imported.name, count: imported.pages.length }),
                  icon: "trash",
                  danger: true,
                  run: () => setDeleteImport(true),
                },
              ] satisfies MenuEntry[])
            : []),
        ] satisfies MenuEntry[])
      : []),
  ];
  let actions: ReactNode;
  if (editing) {
    actions = (
      <>
        {(dirty || recovered) && (
          <span className="wiki-top__status" aria-live="polite">
            <Icon name="check" size={14} />
            <span className="wiki-top__status-text">{recovered ? t("wiki.draftRecovered") : t("wiki.draftKept")}</span>
          </span>
        )}
        <Button
          variant="ghost"
          icon="code"
          className="wiki-top__md"
          aria-pressed={mode === "markdown"}
          title={t("wiki.markdownHint")}
          onClick={toggleMode}
        >
          {t("wiki.markdown")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            stopEdit();
            if (isNew) onDiscard?.();
          }}
        >
          {t("common.cancel")}
        </Button>
        <Button variant="primary" loading={action.isPending} disabled={action.isPending} onClick={() => void save()}>
          {t("common.save")}
          <Kbd>{`${modKey()} S`}</Kbd>
        </Button>
      </>
    );
  } else if (p) {
    actions = (
      <>
        {writes && (
          <Button icon="edit" onClick={startEdit}>
            {t("wiki.edit")}
            <Kbd>E</Kbd>
          </Button>
        )}
        <Menu
          label={t("wiki.more")}
          trigger={<Button iconOnly icon="more" aria-label={t("wiki.more")} title={t("wiki.more")} />}
        >
          <MenuEntries entries={pageEntries(p)} />
        </Menu>
      </>
    );
  }

  const label = t("wiki.editorLabel", { title: draft?.title || t("wiki.newPage") });
  const suggested = [
    ...(p?.reads?.agents.map((r) => r.agentId) ?? []),
    ...(p?.authors.filter((a) => a.type === "agent").map((a) => a.id) ?? []),
  ];

  return (
    <div className="wiki-doc" data-editing={editing || undefined}>
      <article className="wiki-doc__main" aria-labelledby={editing ? undefined : "wiki-title"}>
        <div className="wiki-top">
          <div className="wiki-crumbs">
            <Link to="/org/$orgId/wiki" params={{ orgId: org.id }}>
              {t("wiki.title")}
            </Link>
            {crumbs.map((c, i) => (
              <span key={crumbs.slice(0, i + 1).join("/")}>
                <span aria-hidden="true">/</span> {c}
              </span>
            ))}
          </div>
          <div className="wiki-top__acts">{actions}</div>
        </div>
        {editing ? (
          <Locked when={action.isPending}>
            <TitleField
              value={draft.title}
              onChange={(title) => setDraft({ ...draft, title })}
              autoFocus={isNew && !draft.title}
              onEnter={() => rich.current?.focus()}
            />
            <div className="wiki-props">
              <WikiFolderPicker
                value={draft.folder}
                folders={folders}
                onChange={(folder) => setDraft({ ...draft, folder })}
              />
              <WikiTagsEdit tags={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} />
              {isNew && <WhoSeesButton value={newAudience} onClick={() => setChoosingNew(true)} />}
            </div>
            {mode === "visual" ? (
              <WikiRichEditor
                key={editorKey}
                ref={rich}
                value={draft.body}
                title={p?.title}
                onChange={(body) => setDraft((d) => (d && d.body !== body ? { ...d, body } : d))}
                onSave={() => void save()}
                pages={pages}
                label={label}
                autoFocus={!isNew || Boolean(draft.title)}
                onAsk={(quote) => setAsking(quote)}
              />
            ) : (
              <WikiEditor
                value={draft.body}
                onChange={(body) => setDraft({ ...draft, body })}
                onSave={() => void save()}
                pages={pages}
                label={label}
                autoFocus
              />
            )}
            {mode === "visual" && <p className="wiki-hintline small muted">{t("wiki.rich.hint", { key: modKey() })}</p>}
          </Locked>
        ) : (
          p && (
            <>
              <h1 id="wiki-title" className="wiki-title" {...entityMenu(() => pageEntries(p))}>
                {p.title}
              </h1>
              <PageMeta
                page={p}
                chooseAudience={choosesAudience}
                onAudience={() => setAudienceOpen(true)}
                onHistory={() => setHistoryOpen(true)}
                onTag={onTag}
              />
              <div className="wiki-page__body wiki-prose">
                {p.body.trim() ? (
                  <Markdown source={p.body} wikiLink={wikiLink} embed={embed} idRef={renderIdRef} title={p.title} />
                ) : (
                  <p className="muted">{t("wiki.emptyPage")}</p>
                )}
              </div>
              <PageAbout page={p} onHistory={() => setHistoryOpen(true)} />
            </>
          )
        )}
      </article>
      {conflict && draft && (
        <ConflictDialog
          mine={draft.body}
          theirs={conflict}
          onKeepMine={() => void save(conflict.version)}
          onKeepTheirs={() => {
            setConflict(null);
            stopEdit();
          }}
          onClose={() => setConflict(null)}
          saving={action.isPending}
        />
      )}
      {asking !== null && (
        <WikiAskDialog
          title={draft?.title || p?.title || ""}
          quote={asking}
          suggested={suggested}
          onClose={() => setAsking(null)}
        />
      )}
      {p && <HistoryDialog page={p} open={historyOpen} onClose={() => setHistoryOpen(false)} />}
      {p && audienceOpen && <WikiWhoSeesDialog page={p} onClose={() => setAudienceOpen(false)} />}
      {p && accessOpen && <WikiAudienceDialog page={p} onClose={() => setAccessOpen(false)} />}
      {choosingNew && (
        <WhoSeesDialog
          title={t("whoSees.pageTitle")}
          value={newAudience}
          onClose={() => setChoosingNew(false)}
          onSave={(next) => {
            setNewAudience(next);
            setChoosingNew(false);
          }}
        />
      )}
      {p && confirmDelete && (
        <Dialog
          open
          onOpenChange={(o) => !o && !deleting && setConfirmDelete(false)}
          title={t("wiki.deleteTitle", { title: p.title })}
          description={t("wiki.deleteText")}
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button disabled={deleting} onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                try {
                  await api.wiki.remove(org.id, p.slug);
                  setConfirmDelete(false);
                  void qc.invalidateQueries({ queryKey: keys.wiki(org.id) });
                  toast.show(t("wiki.deleted", { title: p.title }));
                  void navigate({ to: "/org/$orgId/wiki", params: { orgId: org.id } });
                } catch (e) {
                  toast.show(errorText(t, e, i18n.language), "error");
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {t("wiki.delete")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
      {deleteImport && imported && (
        <WikiBulkDeleteDialog
          target={imported.target}
          count={imported.pages.length}
          what={{ kind: "import", name: imported.name }}
          onClose={() => setDeleteImport(false)}
          onDone={() => void navigate({ to: "/org/$orgId/wiki", params: { orgId: org.id } })}
        />
      )}
    </div>
  );
}

/** "Alguém editou enquanto você escrevia": the difference and which version stays. */
function ConflictDialog({
  mine,
  theirs,
  onKeepMine,
  onKeepTheirs,
  onClose,
  saving,
}: {
  mine: string;
  theirs: WikiPageData;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
  onClose: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const authorLabel = useAuthorLabel();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.conflictTitle")}
      description={t("wiki.conflictText", { who: authorLabel(theirs.updatedBy) })}
      closeLabel={t("common.close")}
      width={760}
    >
      <DialogBody>
        <Diff
          lines={diffLines(theirs.body.split("\n"), mine.split("\n"))}
          addedLabel={t("wiki.yours")}
          removedLabel={t("wiki.theirs")}
          aria-label={t("wiki.conflictDiff")}
        />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onKeepTheirs}>{t("wiki.keepTheirs")}</Button>
        <Button variant="primary" onClick={onKeepMine} loading={saving} disabled={saving}>
          {t("wiki.keepMine")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** History: every version on the left; the one picked shows what changed from the one before. */
function HistoryDialog({ page, open, onClose }: { page: WikiPageData; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const history = useWikiHistory(org.id, page.slug, open);
  const names = useNames();
  const note = useNoteText();
  const [diff, setDiff] = useState<{ version: number; before: string; after: string } | null>(null);
  useEffect(() => {
    if (!open) setDiff(null);
  }, [open]);
  const show = async (version: number) => {
    const after = await api.wiki.version(org.id, page.slug, version);
    const before = version > 1 ? await api.wiki.version(org.id, page.slug, version - 1) : { body: "" };
    setDiff({ version, before: before.body, after: after.body });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.historyTitle", { title: page.title })}
      description={t("wiki.historyText")}
      closeLabel={t("common.close")}
      width={900}
    >
      <DialogBody>
        <div className="wiki-history">
          <ol className="wiki-history__list">
            {history.isLoading && <LoadingList count={3} />}
            {(history.data ?? []).map((v) => {
              const { name, behalf } = names(v.author);
              return (
                <li key={v.version}>
                  <button
                    type="button"
                    className="wiki-history__item"
                    aria-pressed={diff?.version === v.version}
                    onClick={() => void show(v.version)}
                  >
                    <AuthorAvatar a={v.author} size="sm" />
                    <span>
                      <span className="tabular">v{v.version}</span> <b>{name}</b>
                      {behalf ? ` ${t("wiki.atRequestOf")} ${behalf}` : ""}
                      {note(v) && <small>{note(v)}</small>}
                      <small>{whenAt(t, i18n.language, v.at)}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="wiki-history__diff">
            {diff ? (
              <Diff
                lines={diffLines(diff.before.split("\n"), diff.after.split("\n"))}
                addedLabel={t("wiki.added")}
                removedLabel={t("wiki.removed")}
                aria-label={t("wiki.versionDiff", { version: diff.version })}
              />
            ) : (
              <p className="small muted">{t("wiki.pickVersion")}</p>
            )}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogFooter>
    </Dialog>
  );
}
