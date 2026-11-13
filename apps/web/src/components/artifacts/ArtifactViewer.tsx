import type { ArtifactAuthor, ArtifactContent, ArtifactDetail, ArtifactRef } from "@agenteschat/client";
import {
  keys,
  useArtifact,
  useArtifactBlob,
  useArtifactVersions,
  useChannels,
  useSaveArtifact,
} from "@agenteschat/client";
import { artifactText, KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { errorText } from "@agenteschat/client/lib/errors";
import { fileIcon, formatBytes, isPreviewImage, previewKind } from "@agenteschat/client/lib/files";
import { keepWhole, relativeTime } from "@agenteschat/client/lib/format";
import { filePath } from "@agenteschat/client/lib/message-links";
import {
  Alert,
  Button,
  Chip,
  cx,
  DetailsDialog,
  Field,
  FormActions,
  Icon,
  Input,
  Locked,
  Menu,
  MenuItem,
  Textarea,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useMatchMedia } from "@/hooks/useMatchMedia";
import { copyText } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { ArtifactMoreMenu, type DownloadFormat, useArtifactDownload, useDeleteArtifact } from "./ArtifactActions";
import { fileSaver } from "./fileSaver";
import { useFileShare } from "./ShareDialog";
import { UploadButton, useDriveUpload } from "./Upload";
import { ArtifactContentView, TableEditor } from "./views";

export { fileSaver };

/** Link to an artifact (opens Drive with the viewer). */
export const artifactLink = (origin: string, orgId: string, id: string, version?: number) =>
  `${origin}${filePath(orgId, id, version)}`;

/** Where the viewer is a phone's full-screen sheet (DetailsDialog's CSS): no room for "2 de 4" beside the title. */
const SHEET_QUERY = "(max-width: 640px)";

/** An artifact at a version (the latest when left out). */
interface ViewerItem {
  id: string;
  version?: number | undefined;
}

interface ViewerTarget extends ViewerItem {
  /** The pictures of the message it opened from, in its order, to move through. */
  set?: ViewerItem[] | undefined;
  /** The one it opened on: moving through `set` keeps the same dialog, only its picture changes. */
  key: string;
}

const ViewerContext = createContext<{
  open: (id: string, version?: number, set?: ViewerItem[]) => void;
  close: () => void;
} | null>(null);

/** Opens artifacts in the side panel from anywhere in the workspace (chat cards, Drive). */
export function ArtifactViewerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const open = useCallback(
    (id: string, version?: number, set?: ViewerItem[]) => setTarget({ id, version, set, key: id }),
    [],
  );
  const close = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ open, close }), [open, close]);
  return (
    <ViewerContext.Provider value={value}>
      {children}
      {target && (
        <ArtifactViewer
          key={target.key}
          id={target.id}
          version={target.version}
          set={target.set}
          onVersion={(version) => setTarget({ ...target, version })}
          onMove={(item) => setTarget({ ...target, id: item.id, version: item.version })}
          onClose={close}
        />
      )}
    </ViewerContext.Provider>
  );
}

/** The pictures `ImageSet` opens a picture of its message with (two or more), or none. */
const ImageSetContext = createContext<((id: string) => ViewerItem[] | undefined) | null>(null);

/**
 * Around a message's attachments: a picture among them opens in the viewer with the message's other pictures, in its
 * order, to move through. Read when one opens, from the queries its cards loaded them with (`useArtifact` at the
 * ref's version).
 */
export function ImageSet({ refs, children }: { refs: ArtifactRef[]; children: ReactNode }) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const setOf = (id: string) => {
    const set = refs.flatMap((r) => {
      const a = r.deleted ? undefined : qc.getQueryData<ArtifactDetail>(keys.artifact(org.id, r.id, r.version));
      return a?.content.kind === "file" && isPreviewImage(a.content)
        ? [{ id: a.id, version: a.shownVersion < a.version ? a.shownVersion : undefined }]
        : [];
    });
    return set.length > 1 && set.some((i) => i.id === id) ? set : undefined;
  };
  return <ImageSetContext.Provider value={setOf}>{children}</ImageSetContext.Provider>;
}

export function useArtifactViewer() {
  const value = useContext(ViewerContext);
  const setOf = useContext(ImageSetContext);
  if (!value) throw new Error("useArtifactViewer must be used inside ArtifactViewerProvider");
  return setOf ? { ...value, open: (id: string, version?: number) => value.open(id, version, setOf(id)) } : value;
}

/** The viewer where there is one; a text with no viewer around it (a page of its own) opens the Drive instead. */
export const useMaybeArtifactViewer = () => useContext(ViewerContext);

export function useAuthorName() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (a: ArtifactAuthor) => dir.authorName({ type: a.type, id: a.id } as Parameters<typeof dir.authorName>[0]);
}

export function ArtifactViewer({
  id,
  version,
  set,
  onVersion,
  onMove,
  onClose,
}: {
  id: string;
  version?: number | undefined;
  /** The pictures it moves through (`ImageSet`): ‹ and › on the stage's sides, ← and →, a swipe, "2 de 4". */
  set?: ViewerItem[] | undefined;
  onVersion: (version: number | undefined) => void;
  onMove: (item: ViewerItem) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const authorName = useAuthorName();
  const channels = useChannels(org.id);
  const query = useArtifact(org.id, id, version);
  const [editing, setEditing] = useState(false);
  const remover = useDeleteArtifact(onClose);
  const a = query.data;
  const channel = a?.channelId ? channels.data?.find((c) => c.id === a.channelId) : undefined;
  const old = a ? a.shownVersion < a.version : false;
  const uploader = useDriveUpload((saved) => {
    toast.show(t("artifacts.saved", { version: saved.version }));
    onVersion(undefined);
  });
  const downloads = useArtifactDownload();
  const share = useFileShare();
  const save = (format?: DownloadFormat) => {
    if (a) void downloads.save(a, format, a.shownVersion, a.content);
  };
  const download = () => save();
  const formats = a ? downloads.formats(a.kind) : [];
  // The whole text of what's shown (a text or code file, a document, a page's source), copied in one click.
  const text = a && !editing ? artifactText(a.content) : undefined;
  const canEditNow = Boolean(a?.canEdit && !old && !editing && (a?.kind === "document" || a?.kind === "table"));
  // A snapshot (a screenshot, a photo) has no versions: no history beside it, no "Enviar nova versão" (ADR 0019).
  const versioned = a?.versioned !== false;
  const canUploadVersion = Boolean(a?.canEdit && !old && a?.kind === "file" && versioned);
  // A picture or a video takes the whole viewer: its versions open beside it only when asked.
  const image =
    a?.content.kind === "file" && (previewKind(a.content.contentType) === "video" || isPreviewImage(a.content));
  const [versionsOpen, setVersionsOpen] = useState(false);
  const sideVersions = versioned && (!image || versionsOpen);
  const focusVersions = () =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".artifact-viewer__versions button")?.focus());
  // Each action's words: on a phone its icon alone (the words stay its name), so the title keeps room to read.
  const words = (text: string) => <span className="artifact-action__label">{text}</span>;
  // Where this picture is among its message's, and the ones beside it.
  const at = set ? set.findIndex((i) => i.id === id) : -1;
  const prev = at > 0 ? set?.[at - 1] : undefined;
  const next = at >= 0 ? set?.[at + 1] : undefined;
  const [moved, setMoved] = useState<"prev" | "next" | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const move = (dir: 1 | -1) => {
    const item = dir === 1 ? next : prev;
    if (!item) return;
    flushSync(() => {
      setMoved(dir === 1 ? "next" : "prev");
      onMove(item);
    });
    // The focus stays in the viewer: what had it left with the old picture (its stage, or the button that ran out at
    // the first or the last one), so it goes to a button that moves on.
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const [ahead, back] = dir === 1 ? [nextRef, prevRef] : [prevRef, nextRef];
    (ahead.current ?? back.current)?.focus();
  };
  const moveRef = useRef(move);
  moveRef.current = move;
  const many = at >= 0;
  // "2 de 4": beside Baixar, or leading the line under the title on a phone's sheet.
  const place = many && set ? t("files.nav.place", { index: at + 1, count: set.length }) : null;
  const sheet = useMatchMedia(SHEET_QUERY);
  // ← and → wherever the focus is in the viewer; a zoomed picture takes them first, to move around in it.
  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!viewerRef.current?.closest('[role="dialog"]')?.contains(e.target as Node)) return;
      e.preventDefault();
      moveRef.current(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [many]);
  const actions = a && (
    <>
      {place && !sheet && (
        <span className="artifact-sheet__place tabular" aria-live="polite">
          {place}
        </span>
      )}
      {a.kind === "file" ? (
        <Button
          size="sm"
          variant="ghost"
          icon="download"
          className="artifact-download"
          title={t("artifacts.download")}
          onClick={download}
        >
          {words(t("artifacts.download"))}
        </Button>
      ) : (
        <Menu
          align="end"
          label={t("artifacts.downloadMenu")}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              icon="download"
              className="artifact-download"
              title={t("artifacts.downloadMenu")}
            >
              {words(t("artifacts.downloadMenu"))}
            </Button>
          }
        >
          {formats.map((f) => (
            <MenuItem key={f.key} icon={f.icon} onSelect={() => save(f.format)}>
              {f.label}
            </MenuItem>
          ))}
        </Menu>
      )}
      {a.inDrive !== false && (
        <Button
          size="sm"
          variant="ghost"
          icon="personAdd"
          className="artifact-share"
          title={t("share.button")}
          onClick={() => share.open(a)}
        >
          {words(t("share.button"))}
        </Button>
      )}
      {text && (
        <Button
          size="sm"
          variant="ghost"
          icon="copy"
          className="artifact-copy"
          title={t("contextMenu.copyText")}
          onClick={() => void copyText(text, () => toast.show(t("contextMenu.textCopied")))}
        >
          {words(t("contextMenu.copyText"))}
        </Button>
      )}
      {canUploadVersion && (
        <UploadButton
          variant="ghost"
          labelClassName="artifact-action__label"
          label={uploader.busy ? t("files.uploadingVersion") : t("files.uploadVersion")}
          busy={uploader.busy}
          onFiles={(files) => void uploader.upload(files.slice(0, 1), { artifactId: a.id })}
        />
      )}
      {canEditNow && (
        <Button
          size="sm"
          variant="ghost"
          icon="edit"
          className="artifact-edit"
          title={t("artifacts.edit")}
          onClick={() => setEditing(true)}
        >
          {words(t("artifacts.edit"))}
        </Button>
      )}
      {image && versioned && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="waiting"
          aria-label={t("artifacts.history")}
          title={t("artifacts.history")}
          aria-pressed={versionsOpen}
          onClick={() => setVersionsOpen(!versionsOpen)}
        />
      )}
      <ArtifactMoreMenu
        artifact={a}
        onVersions={
          versioned
            ? () => {
                setVersionsOpen(true);
                focusVersions();
              }
            : undefined
        }
        onDelete={() => remover.ask(a)}
      />
    </>
  );
  return (
    <DetailsDialog
      open
      size="xl"
      fill={image}
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("artifacts.close")}
      className={image ? "artifact-sheet artifact-sheet--image" : "artifact-sheet"}
      title={
        a ? (
          <span className="artifact-sheet__title" title={a.title}>
            {a.title}
          </span>
        ) : (
          t("artifacts.loading")
        )
      }
      icon={
        a ? (
          <Icon
            name={a.content.kind === "file" ? fileIcon(a.content.name, a.content.contentType) : KIND_ICON[a.kind]}
          />
        ) : undefined
      }
      subtitle={
        a
          ? [
              place && sheet ? place : null,
              // Each fact whole: a narrow head breaks the line between facts, never inside one.
              t(a.content.kind === "file" ? "artifacts.subtitleSize" : "artifacts.subtitle", {
                kind: keepWhole(t(`artifacts.kind.${a.kind}`)),
                name: keepWhole(authorName(a.createdBy)),
                where: keepWhole(channel ? `#${channel.name}` : t("artifacts.noChannel")),
                when: keepWhole(relativeTime(t, i18n.language, a.updatedAt)),
                size: a.content.kind === "file" ? keepWhole(formatBytes(i18n.language, a.content.size)) : "",
              }),
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      actions={actions}
    >
      {query.isError && <Alert>{t("artifacts.notFound")}</Alert>}
      {a && (
        <div
          ref={viewerRef}
          className={cx(
            "artifact-viewer",
            !sideVersions && "artifact-viewer--single",
            image && "artifact-viewer--image",
          )}
          data-moved={moved ?? undefined}
        >
          <div className="artifact-viewer__main">
            {old && (
              <div className="row artifact-viewer__old" role="status">
                <span className="small">{t("artifacts.viewing", { version: a.shownVersion, latest: a.version })}</span>
                <Button size="sm" onClick={() => onVersion(undefined)}>
                  {t("artifacts.backToLatest")}
                </Button>
              </div>
            )}
            {prev && (
              <Button
                ref={prevRef}
                className="artifact-nav artifact-nav--prev"
                iconOnly
                icon="chevronLeft"
                aria-label={t("files.nav.previous")}
                title={t("files.nav.previous")}
                onClick={() => move(-1)}
              />
            )}
            {editing ? (
              <Editor
                artifact={a}
                onDone={(saved) => {
                  setEditing(false);
                  if (saved) onVersion(undefined);
                }}
              />
            ) : (
              // A picture of the set starts afresh: fitted, its zoom gone.
              <ArtifactContentView
                key={a.id}
                content={a.content}
                title={a.title}
                source={{ id: a.id, version: a.shownVersion, agentId: a.createdBy.id }}
                onSwipe={many ? move : undefined}
              />
            )}
            {next && (
              <Button
                ref={nextRef}
                className="artifact-nav artifact-nav--next"
                iconOnly
                icon="chevronRight"
                aria-label={t("files.nav.next")}
                title={t("files.nav.next")}
                onClick={() => move(1)}
              />
            )}
            {set?.map((item) => (
              <Preload key={item.id} item={item} bytes={item === prev || item === next} />
            ))}
          </div>
          {sideVersions && <Versions artifact={a} onVersion={onVersion} />}
        </div>
      )}
      {remover.dialog}
      {share.dialog}
    </DetailsDialog>
  );
}

/**
 * A picture of the set loads ahead: its details always (the head follows at once, however fast the moves), its bytes
 * when it is beside the one shown (the picture is there at once too).
 */
function Preload({ item, bytes }: { item: ViewerItem; bytes: boolean }) {
  const { org } = useOrg();
  const a = useArtifact(org.id, item.id, item.version).data;
  useArtifactBlob(org.id, item.id, a?.shownVersion ?? 0, bytes && a !== undefined);
  return null;
}

function Versions({ artifact, onVersion }: { artifact: ArtifactDetail; onVersion: (v: number | undefined) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const versions = useArtifactVersions(org.id, artifact.id);
  const authorName = useAuthorName();
  return (
    <nav className="artifact-viewer__versions" aria-label={t("artifacts.history")}>
      <h3 className="ac-eyebrow">{t("artifacts.history")}</h3>
      <ol>
        {(versions.data ?? []).map((v) => {
          const current = v.version === artifact.shownVersion;
          return (
            <li key={v.version}>
              <button
                type="button"
                className="ac-navcard"
                aria-current={current ? "true" : undefined}
                onClick={() => onVersion(v.version === artifact.version ? undefined : v.version)}
              >
                <span className="artifact-viewer__vhead">
                  <span className="artifact-viewer__vname">
                    {t("artifacts.versionBy", {
                      version: v.version,
                      name: authorName(v.author),
                      when: relativeTime(t, i18n.language, v.createdAt),
                    })}
                  </span>
                  {v.version === artifact.version && <Chip icon="check">{t("artifacts.latest")}</Chip>}
                </span>
                <span className="small muted">{v.note ?? t("artifacts.noNote")}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Editor({ artifact, onDone }: { artifact: ArtifactDetail; onDone: (saved: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSaveArtifact(org.id, artifact.id);
  const [content, setContent] = useState<ArtifactContent>(artifact.content);
  const [note, setNote] = useState("");
  const [stale, setStale] = useState(false);
  return (
    <form
      className="ac-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          { content, note: note.trim() || null, baseVersion: artifact.version },
          {
            onSuccess: (saved) => {
              toast.show(t("artifacts.saved", { version: saved.version }));
              onDone(true);
            },
            onError: (error) => {
              if ((error as { status?: number }).status === 409) setStale(true);
              else toast.show(errorText(t, error, i18n.language), "error");
            },
          },
        );
      }}
    >
      <p className="small muted">{t("artifacts.editing", { version: artifact.version + 1 })}</p>
      <Locked when={save.isPending}>
        {content.kind === "document" && (
          <Field label={t("artifacts.markdownSource")} id="artifact-md">
            <Textarea
              rows={18}
              value={content.markdown}
              onChange={(e) => setContent({ kind: "document", markdown: e.target.value })}
            />
          </Field>
        )}
        {content.kind === "table" && (
          <TableEditor
            columns={content.columns}
            rows={content.rows}
            onChange={(rows) => setContent({ ...content, rows })}
          />
        )}
        <Field label={t("artifacts.note")} id="artifact-note">
          <Input value={note} placeholder={t("artifacts.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Locked>
      {stale && (
        <div className="stack-4" style={{ gap: 8 }}>
          <Alert>{t("artifacts.stale")}</Alert>
          <div className="row">
            <Button type="button" size="sm" onClick={() => onDone(true)}>
              {t("artifacts.backToLatest")}
            </Button>
          </div>
        </div>
      )}
      <FormActions>
        <Button type="button" onClick={() => onDone(false)}>
          {t("artifacts.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={stale} loading={save.isPending}>
          {t("artifacts.save")}
        </Button>
      </FormActions>
    </form>
  );
}
