import type { Artifact, ArtifactFilters, ArtifactKind } from "@agenteschat/client";
import { useArtifacts, useChannels } from "@agenteschat/client";
import { ARTIFACT_KINDS, KIND_ICON } from "@agenteschat/client/lib/artifacts";
import {
  DRIVE_GROUPS,
  DRIVE_SORTS,
  type DriveGroup,
  type DriveSection,
  type DriveSort,
  type DriveView,
  type DriveWho,
  driveSections,
  isDriveView,
  onlyItsConversation,
  PRIVATE_SECTION,
  rangeOf,
} from "@agenteschat/client/lib/drive";
import { joinNames } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Checkbox,
  cx,
  EmptyState,
  FilterBar,
  FilterChip,
  type FilterOption,
  GroupHeading,
  Icon,
  Kbd,
  Menu,
  MenuRadioGroup,
  MenuSeparator,
  PageHeader,
  SearchField,
  Segmented,
  Toolbar,
  useMatchMedia,
} from "@agenteschat/ui";
import { type MouseEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useArtifactDownload, useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { artifactLink, useArtifactViewer, useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { useFileShare } from "@/components/artifacts/ShareDialog";
import { UploadButton, useDriveUpload } from "@/components/artifacts/Upload";
import { DriveDetails } from "@/components/drive/DriveDetails";
import { DriveCard, DriveRow, type ItemProps } from "@/components/drive/DriveItems";
import { DriveTrash } from "@/components/drive/DriveTrash";
import { DropOverlay, UploadProgress, useFileDrop } from "@/components/drive/DriveUploads";
import { useActorFilterOptions } from "@/components/filters";
import { ErrorState, LoadingList } from "@/components/Loading";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { useOrg } from "@/components/org-context";
import { SelectionBar } from "@/components/SelectionBar";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import { useOpenParam } from "@/lib/open-param";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import "./drive.css";
import { typingInField } from "@/lib/keys";

/** Authors shown on a channel's group header. */
const STACK_MAX = 5;

/** A menu, listbox or dialog is open: Esc and shortcuts are theirs. */
const layerOpen = () => Boolean(document.querySelector('[role="menu"], [role="listbox"], [role="dialog"]'));

/**
 * Drive: everything the viewer can see, as a
 * grid of real previews (or a list), with quick filters, grouping, a details
 * panel, multi-select with a floating bar, drop to upload and the trash.
 */
export function DrivePage({ open }: { open?: { id: string; version?: number } }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useRightHandLook();
  const uploads = can(org, "upload_files");
  const viewer = useArtifactViewer();
  const authorName = useAuthorName();
  const channels = useChannels(org.id);
  const toast = useToast();
  const downloads = useArtifactDownload();
  const share = useFileShare();
  const searchRef = useRef<HTMLInputElement>(null);
  const phone = useMatchMedia(COMPACT_QUERY);

  const [q, setQ] = useState("");
  const [trashOpen, setTrashOpen] = useState(false);
  const [view, setViewState] = useState<DriveView>(() => {
    const saved = storage.get(STORAGE_KEYS.driveView);
    return isDriveView(saved) ? saved : "grid";
  });
  const setView = (v: DriveView) => {
    setViewState(v);
    storage.set(STORAGE_KEYS.driveView, v);
  };
  const [who, setWho] = useState<DriveWho>("all");
  const [kinds, setKinds] = useState<ArtifactKind[]>([]);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [group, setGroup] = useState<DriveGroup>("date");
  const [sort, setSort] = useState<DriveSort>("recent");
  // The item whose details are open, in the URL (`?open=…`).
  const [openId, setOpenParam] = useOpenParam();
  const setOpenId = (next: string | null | ((o: string | null) => string | null)) =>
    setOpenParam(typeof next === "function" ? next(openId) : next);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [uploadsHidden, setUploadsHidden] = useState(false);

  const search = useDeferredValue(q.trim());
  // Every filter and the order go to the server, so each looks at all the files, not the pages loaded.
  const filters = useMemo<ArtifactFilters>(() => {
    const f: ArtifactFilters = {};
    if (search) f.q = search;
    if (kinds.length > 0) f.kinds = kinds;
    if (channelIds.length > 0) f.channelIds = channelIds;
    const picked = authors.flatMap((key) => {
      const [type, id] = key.split(":");
      return (type === "agent" || type === "person") && id ? [{ type, id } as const] : [];
    });
    if (picked.length > 0) f.authors = picked;
    if (who !== "all") f.who = who;
    if (sort !== "recent") f.sort = sort;
    return f;
  }, [search, kinds, channelIds, authors, who, sort]);
  const list = useArtifacts(org.id, filters);

  const remover = useDeleteArtifact((ids) => {
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    setOpenId((o) => (o && ids.includes(o) ? null : o));
  });
  const uploader = useDriveUpload((saved) =>
    toast.show(t("files.uploaded", { name: saved.title }), "info", {
      label: t("artifacts.openFile"),
      run: () => viewer.open(saved.id),
    }),
  );
  const upload = (files: File[]) => {
    setUploadsHidden(false);
    void uploader.upload(files);
  };
  const drop = useFileDrop(upload, !trashOpen);

  // A shared link (`/drive?artifact=…&v=…`) opens the viewer.
  useEffect(() => {
    if (open?.id) viewer.open(open.id, open.version);
  }, [open?.id, open?.version, viewer]);

  const channelLabel = (a: Artifact) =>
    a.audience.kind === "channel"
      ? `#${a.audience.name}`
      : a.audience.kind === "dm"
        ? a.audience.between
          ? t("drive.dmBetween", { names: joinNames(a.audience.between.map(authorName), t) })
          : a.audience.with
            ? t("drive.dmWith", { name: authorName(a.audience.with) })
            : t("drive.dm")
        : t("artifacts.noChannel");

  const rows = list.artifacts ?? [];
  const sections = driveSections(rows, group);
  const shown = sections.flatMap((s) => s.items);
  const counts = new Map(Object.entries(list.counts ?? {}) as [ArtifactKind, number][]);
  // All the files these filters find, beyond the pages loaded (an older server sends no counts).
  const total = list.counts
    ? [...counts].reduce((n, [k, c]) => (kinds.length === 0 || kinds.includes(k) ? n + c : n), 0)
    : rows.length;

  const filtered = Boolean(search) || kinds.length > 0 || channelIds.length > 0 || authors.length > 0 || who !== "all";
  const clearFilters = () => {
    setKinds([]);
    setChannelIds([]);
    setAuthors([]);
    setWho("all");
  };
  const openItem = rows.find((a) => a.id === openId);
  const picked = shown.filter((a) => selected.has(a.id));
  const selectAll = () => setSelected(new Set(shown.map((a) => a.id)));

  const toggle = (a: Artifact) => {
    anchor.current = a.id;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(a.id)) next.delete(a.id);
      else next.add(a.id);
      return next;
    });
  };
  const pick = (a: Artifact, e: MouseEvent) => {
    if (e.shiftKey) {
      const range = rangeOf(
        shown.map((x) => x.id),
        anchor.current,
        a.id,
      );
      anchor.current = a.id;
      setSelected((s) => new Set([...s, ...range]));
      return;
    }
    if (e.metaKey || e.ctrlKey || selected.size > 0) {
      toggle(a);
      return;
    }
    anchor.current = a.id;
    setOpenId((o) => (o === a.id ? null : a.id));
  };
  const openViewer = (a: Artifact) => viewer.open(a.id);

  // "/" searches, ⌘A selects what's shown, Esc clears the selection.
  const keys = useRef({ shown, selected, openId, trashOpen, selectAll });
  keys.current = { shown, selected, openId, trashOpen, selectAll };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keys.current;
      if (s.trashOpen || layerOpen()) return;
      const active = document.activeElement;
      if (e.key === "Escape") {
        if (typingInField(active)) return;
        // The details dialog closes itself on Esc; here Esc clears the selection.
        if (s.selected.size > 0) setSelected(new Set());
        return;
      }
      if (typingInField(active) || e.altKey) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && s.shown.length > 0) {
        e.preventDefault();
        s.selectAll();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const downloadPicked = async () => {
    for (const a of picked) await downloads.save(a, undefined, a.version);
  };
  const copyLinks = async () => {
    await navigator.clipboard?.writeText(
      picked.map((a) => artifactLink(window.location.origin, org.id, a.id)).join("\n"),
    );
    // The share dialog's rule, for many at once: say which links only their conversation opens, with the way to share.
    const closed = picked.find(onlyItsConversation);
    if (closed) {
      toast.show(t("share.someOnlyHere"), "info", { label: t("share.button"), run: () => share.open(closed) });
    } else toast.show(t("drive.linksCopied", { count: picked.length }));
  };
  const deletable = picked.filter((a) => a.canDelete);

  const authorOptions = useActorFilterOptions();
  const channelOptions: FilterOption[] = (channels.data ?? []).map((c) => ({ value: c.id, label: `#${c.name}` }));
  const clearOf = (name: string) => t("filters.clear", { name });
  const chipText = {
    searchLabel: t("filters.search"),
    searchPlaceholder: t("filters.searchPlaceholder"),
    noResults: t("filters.noResults"),
  };
  const itemProps = (a: Artifact): ItemProps => ({
    artifact: a,
    open: a.id === openId,
    selected: selected.has(a.id),
    channelName: channelLabel,
    onPick: pick,
    onToggle: toggle,
    onOpen: openViewer,
  });

  const sectionTitle = (s: DriveSection) => {
    if (s.key === PRIVATE_SECTION) return t("drive.private");
    if (group === "date")
      return t(s.key === "today" ? "drive.today" : s.key === "week" ? "drive.thisWeek" : "drive.earlier");
    const first = s.items[0];
    if (group === "channel") return s.key && first ? channelLabel(first) : t("drive.noChannel");
    return first ? authorName(first.createdBy) : "";
  };
  const sectionHead = (s: DriveSection) => {
    if (s.key === PRIVATE_SECTION) {
      return (
        <GroupHeading
          className="drive-group__head"
          title={
            <>
              <Icon name="lock" size={16} />
              {sectionTitle(s)}
            </>
          }
          count={s.items.length}
          aside={<span className="drive-group__hint">{t("drive.privateHint")}</span>}
        />
      );
    }
    if (group === "none") return null;
    const first = s.items[0];
    const people = new Map(s.items.map((a) => [`${a.createdBy.type}:${a.createdBy.id}`, a.createdBy]));
    return (
      <GroupHeading
        className="drive-group__head"
        title={
          <>
            {group === "author" && first && (
              <ActorAvatar size="xs" actor={first.createdBy} name={authorName(first.createdBy)} />
            )}
            {group === "channel" && <Icon name={s.key ? "channel" : "drive"} size={16} />}
            {sectionTitle(s)}
          </>
        }
        count={s.items.length}
        aside={
          group === "channel" && (
            <span className="drive-group__stack" aria-hidden="true">
              {[...people.values()].slice(0, STACK_MAX).map((p) => (
                <ActorAvatar key={`${p.type}:${p.id}`} size="xs" actor={p} name={authorName(p)} />
              ))}
            </span>
          )
        }
      />
    );
  };

  const kindOptions: FilterOption[] = ARTIFACT_KINDS.filter((k) => (counts.get(k) ?? 0) > 0 || kinds.includes(k)).map(
    (k) => ({
      value: k,
      label: t(`drive.kindMany.${k}`),
      leading: <Icon name={KIND_ICON[k]} size={16} />,
      count: counts.get(k) ?? 0,
    }),
  );

  return (
    <div className={cx("page drive drive-drop", drop.over && "drive-drop--over")} {...drop.props}>
      {drop.over && <DropOverlay />}
      <div className="drive__main">
        <PageHeader
          title={trashOpen ? t("artifacts.trashTitle") : t("drive.title")}
          meta={trashOpen ? t("artifacts.trashHint") : t("drive.subtitle")}
          lead={
            trashOpen && (
              <Button
                variant="ghost"
                iconOnly
                icon="chevronLeft"
                aria-label={t("artifacts.backToDrive")}
                title={t("artifacts.backToDrive")}
                onClick={() => setTrashOpen(false)}
              />
            )
          }
          actions={
            !trashOpen && (
              <>
                <Button
                  variant="ghost"
                  icon="trash"
                  onClick={() => {
                    setTrashOpen(true);
                    setOpenId(null);
                    setSelected(new Set());
                  }}
                >
                  {t("artifacts.trash")}
                </Button>
                {uploads && !(list.isSuccess && rows.length === 0 && !filtered) && (
                  <UploadButton
                    size="md"
                    label={t("files.upload")}
                    busy={uploader.busy}
                    multiple
                    onFiles={upload}
                    variant="primary"
                  />
                )}
              </>
            )
          }
        />

        {trashOpen && <DriveTrash />}
        {remover.dialog}
        {share.dialog}

        {!trashOpen && (
          <>
            <Toolbar
              search={
                <SearchField
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && q) {
                      e.stopPropagation();
                      setQ("");
                    }
                  }}
                  onClear={() => setQ("")}
                  clearLabel={t("filters.clearSearch")}
                  placeholder={t("drive.search")}
                  aria-label={t("drive.search")}
                  shortcut={
                    <Kbd title={t("drive.searchHint")} aria-hidden="true">
                      /
                    </Kbd>
                  }
                />
              }
              actions={
                <>
                  <Menu
                    align="end"
                    label={t("drive.arrange")}
                    trigger={
                      // On a phone its icon alone, so the search keeps its words whole beside it.
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="layers"
                        iconOnly={phone}
                        aria-label={t("drive.arrangeValue", { group: t(`drive.group.${group}`) })}
                      >
                        {t(`drive.group.${group}`)}
                      </Button>
                    }
                  >
                    <MenuRadioGroup
                      label={t("drive.groupBy")}
                      value={group}
                      onValueChange={(v) => setGroup(v as DriveGroup)}
                      options={DRIVE_GROUPS.map((g) => ({ value: g, label: t(`drive.group.${g}`) }))}
                    />
                    <MenuSeparator />
                    <MenuRadioGroup
                      label={t("drive.sortBy")}
                      value={sort}
                      onValueChange={(v) => setSort(v as DriveSort)}
                      options={DRIVE_SORTS.map((s) => ({ value: s, label: t(`drive.sort.${s}`) }))}
                    />
                  </Menu>
                  <Segmented<DriveView>
                    size="sm"
                    label={t("drive.view")}
                    value={view}
                    onValueChange={setView}
                    className="drive-view"
                    options={[
                      {
                        value: "grid",
                        label: (
                          <>
                            <Icon name="grid" size={16} />
                            <span className="ac-visually-hidden">{t("drive.viewGrid")}</span>
                          </>
                        ),
                      },
                      {
                        value: "list",
                        label: (
                          <>
                            <Icon name="list" size={16} />
                            <span className="ac-visually-hidden">{t("drive.viewList")}</span>
                          </>
                        ),
                      },
                    ]}
                  />
                </>
              }
            >
              <Segmented<DriveWho>
                label={t("drive.who")}
                value={who}
                onValueChange={setWho}
                options={[
                  { value: "all", label: t("drive.everyone") },
                  {
                    value: "agents",
                    label: (
                      <>
                        <Icon name="agent" size={16} />
                        {t("drive.agents")}
                      </>
                    ),
                  },
                  {
                    value: "people",
                    label: (
                      <>
                        <Icon name="person" size={16} />
                        {t("drive.people")}
                      </>
                    ),
                  },
                ]}
              />
              <FilterBar
                label={t("drive.filters")}
                clearText={t("drive.clear")}
                onClear={clearFilters}
                filters={[
                  {
                    key: "channel",
                    active: channelIds.length > 0,
                    node: (
                      <FilterChip
                        label={t("drive.channel")}
                        icon="channel"
                        multiple
                        options={channelOptions}
                        value={channelIds}
                        onChange={setChannelIds}
                        valueText={(o) => o.label}
                        countText={(count) => t("filters.channels", { count })}
                        clearLabel={clearOf(t("drive.channel"))}
                        {...chipText}
                      />
                    ),
                  },
                  {
                    key: "author",
                    active: authors.length > 0,
                    node: (
                      <FilterChip
                        label={t("drive.author")}
                        icon="person"
                        multiple
                        options={authorOptions}
                        value={authors}
                        onChange={setAuthors}
                        valueText={(o) => o.label}
                        countText={(count) => t("filters.people", { count })}
                        clearLabel={clearOf(t("drive.author"))}
                        {...chipText}
                      />
                    ),
                  },
                  ...(kindOptions.length > 0
                    ? [
                        {
                          key: "kind",
                          active: kinds.length > 0,
                          node: (
                            <FilterChip
                              label={t("drive.kind")}
                              icon="file"
                              multiple
                              options={kindOptions}
                              value={kinds}
                              onChange={(v) => setKinds(v as ArtifactKind[])}
                              countText={(count) => t("filters.kinds", { count })}
                              clearLabel={clearOf(t("drive.kind"))}
                              {...chipText}
                            />
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </Toolbar>

            {filtered && list.isSuccess && rows.length > 0 && (
              <div className="drive-summary">
                <span>{t("drive.count", { count: total })}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  onClick={() => {
                    setQ("");
                    clearFilters();
                  }}
                >
                  {t("drive.clear")}
                </Button>
              </div>
            )}

            {list.isLoading && <LoadingList count={5} trailing />}
            {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
            {list.isSuccess && rows.length === 0 && !filtered && (
              <EmptyState
                size="page"
                agent={look}
                title={t("drive.emptyTitle")}
                actions={
                  uploads && (
                    <UploadButton
                      size="md"
                      label={t("files.upload")}
                      busy={uploader.busy}
                      multiple
                      onFiles={upload}
                      variant="primary"
                    />
                  )
                }
              >
                {t(uploads ? "drive.emptyText" : "drive.emptyViewer")}
              </EmptyState>
            )}
            {list.isSuccess && rows.length === 0 && filtered && (
              <EmptyState
                size="panel"
                title={t("drive.noResults")}
                actions={
                  <Button
                    onClick={() => {
                      setQ("");
                      clearFilters();
                    }}
                  >
                    {t("drive.clear")}
                  </Button>
                }
              >
                {t("drive.noResultsHint")}
              </EmptyState>
            )}

            {rows.length > 0 && view === "grid" && (
              <div className={cx("ac-groups", selected.size > 0 && "drive--selecting")}>
                {sections.map((s) => (
                  <section key={s.key || "all"} className="drive-group">
                    {sectionHead(s)}
                    <div className="drive-grid">
                      {s.items.map((a) => (
                        <DriveCard key={a.id} {...itemProps(a)} onDelete={(x) => remover.ask(x)} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
            {rows.length > 0 && view === "list" && (
              <div className={cx("drive-table", selected.size > 0 && "drive--selecting")}>
                <div className="drive-table__head">
                  <Checkbox
                    className="drive-check"
                    checked={picked.length === shown.length ? true : picked.length > 0 ? "indeterminate" : false}
                    onCheckedChange={(on) => (on ? selectAll() : setSelected(new Set()))}
                    aria-label={t("drive.selectAll", { count: shown.length })}
                  />
                  <span aria-hidden="true">{t("drive.name")}</span>
                  <span aria-hidden="true">{t("drive.by")}</span>
                  <span className="drive-row__where" aria-hidden="true">
                    {t("drive.where")}
                  </span>
                  <span aria-hidden="true">{t("drive.when")}</span>
                  <span />
                </div>
                {sections.map((s) => (
                  <section key={s.key || "all"} className="drive-group">
                    {sectionHead(s)}
                    <ul className="drive-list">
                      {s.items.map((a) => (
                        <DriveRow key={a.id} {...itemProps(a)} onDelete={(x) => remover.ask(x)} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            {list.hasNextPage && rows.length > 0 && (
              <div className="drive-more">
                <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {t("drive.loadMore")}
                </Button>
              </div>
            )}

            {picked.length > 0 && (
              <SelectionBar label={t("drive.selection")}>
                <span className="drive-selbar__count">{t("drive.selected", { count: picked.length })}</span>
                {picked.length < shown.length && (
                  <Button size="sm" variant="ghost" icon="checks" onClick={selectAll}>
                    <span className="drive-selbar__label">{t("drive.selectAll", { count: shown.length })}</span>
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon="download" onClick={() => void downloadPicked()}>
                  <span className="drive-selbar__label">{t("artifacts.download")}</span>
                </Button>
                <Button size="sm" variant="ghost" icon="link" onClick={() => void copyLinks()}>
                  <span className="drive-selbar__label">{t("drive.copyLinks")}</span>
                </Button>
                {deletable.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    className="drive-selbar__danger"
                    onClick={() => remover.ask(deletable)}
                  >
                    <span className="drive-selbar__label">{t("drive.moveToTrash")}</span>
                  </Button>
                )}
                <span className="drive-selbar__sep" aria-hidden="true" />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon="close"
                  aria-label={t("drive.clearSelection")}
                  title={t("drive.clearSelection")}
                  onClick={() => setSelected(new Set())}
                />
              </SelectionBar>
            )}
          </>
        )}
      </div>

      {openItem && !trashOpen && (
        <DriveDetails
          key={openItem.id}
          artifact={openItem}
          onClose={() => setOpenId(null)}
          onDelete={(a) => remover.ask(a)}
        />
      )}
      {uploader.queue.length > 0 && !uploadsHidden && (
        <UploadProgress queue={uploader.queue} onHide={() => setUploadsHidden(true)} />
      )}
    </div>
  );
}
