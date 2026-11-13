import type { Issue, IssueActivity } from "@agenteschat/client";
import { useArtifact, useIssueAction } from "@agenteschat/client";
import { formatBytes } from "@agenteschat/client/lib/files";
import { whenAt } from "@agenteschat/client/lib/format";
import { Button, EmptyState, Icon, Segmented, Spinner } from "@agenteschat/ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { useArtifactDownload } from "@/components/artifacts/ArtifactActions";
import { useArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { DrivePreview } from "@/components/drive/DrivePreview";
import { useFileDrop } from "@/components/drive/DriveUploads";
import { useOrg } from "@/components/org-context";
import { type PendingFile, useComposerFiles } from "@/hooks/useComposerFiles";

/** A file of the task and where it came from ("Na criação · ontem às 17:40", "Comentário de Ana · …"). */
export interface IssueFileEntry {
  id: string;
  title: string;
  origin: string;
}

/**
 * Every file of a task, in the order they came: the ones it was created with, each comment's, the ones an agent
 * attached, then the ones linked later (sent in its conversation, an agent's report). Only what is still linked: one
 * taken off (Desfazer) or in the trash isn't.
 */
export function useIssueFileEntries(issue: Issue, activity: IssueActivity[]): IssueFileEntry[] {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const linked = new Set(issue.artifacts.map((f) => f.id));
  const seen = new Set<string>();
  const out: IssueFileEntry[] = [];
  for (const a of activity) {
    const when = whenAt(t, i18n.language, a.createdAt);
    for (const f of a.attachments ?? []) {
      if (seen.has(f.id) || !linked.has(f.id)) continue;
      seen.add(f.id);
      out.push({
        id: f.id,
        title: f.title,
        origin:
          a.kind === "comment"
            ? t("issues.files.fromComment", { name: actors.name(a.author), when })
            : a.event === "artifact_linked"
              ? t("issues.files.linked", { name: actors.name(a.author) })
              : t("issues.files.fromCreation", { when }),
      });
    }
  }
  for (const f of issue.artifacts) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({ id: f.id, title: f.title, origin: t("issues.files.linked", { name: actors.name(f.createdBy) }) });
  }
  return out;
}

/**
 * "Anexos": every file of the task in a grid (the real preview, as in the Drive) or a list, with where each one
 * came from. "Adicionar arquivos", a drop or a paste here sends them as a comment of their own, so the
 * discussion and the history show who attached what. Empty, one way in: the kit's empty state with its one button
 * (a drop and a paste still work anywhere on it), which also says files sent in the task's conversation land here.
 */
export function IssueFiles({ issue, activity }: { issue: Issue; activity: IssueActivity[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueAction(org.id);
  const entries = useIssueFileEntries(issue, activity);
  const [view, setView] = useState<"grid" | "list">("grid");
  const picker = useRef<HTMLInputElement>(null);
  const adding = useComposerFiles(issue.channelId);
  const drop = useFileDrop(adding.onFiles, true);
  const sending = useRef(false);
  const doneIds = !adding.uploading && adding.attached.length > 0 ? adding.attached.map((f) => f.id).join(",") : "";
  // Once every picked file is in the Drive, they go as one comment (no text): the box empties after.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires when the uploaded set settles, not on each render
  useEffect(() => {
    if (!doneIds || sending.current) return;
    sending.current = true;
    action.mutate(
      { type: "comment", id: issue.id, text: "", attachmentIds: doneIds.split(",") },
      {
        onSettled: () => {
          sending.current = false;
          adding.clear();
        },
      },
    );
  }, [doneIds]);
  const pick = () => picker.current?.click();
  const empty = entries.length === 0 && adding.items.length === 0;
  return (
    <section
      className="issue-files"
      aria-label={t("issues.files.title")}
      data-over={drop.over || undefined}
      onPaste={(e) => {
        const pasted = Array.from(e.clipboardData?.files ?? []);
        if (pasted.length === 0) return;
        e.preventDefault();
        adding.onFiles(pasted);
      }}
      {...drop.props}
    >
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-label={t("issues.files.add")}
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (list.length > 0) adding.onFiles(list);
        }}
      />
      {empty ? (
        <EmptyState
          size="panel"
          icon="upload"
          title={t("issues.files.emptyTitle")}
          actions={
            <Button variant="primary" icon="upload" onClick={pick} loading={adding.uploading}>
              {t("issues.files.add")}
            </Button>
          }
        >
          {t("issues.files.empty")}
        </EmptyState>
      ) : (
        <>
          <div className="issue-files__bar">
            <Segmented
              size="sm"
              label={t("issues.view")}
              value={view}
              onValueChange={setView}
              options={[
                {
                  value: "grid",
                  label: (
                    <>
                      <Icon name="grid" size={16} />
                      {t("issues.files.grid")}
                    </>
                  ),
                },
                {
                  value: "list",
                  label: (
                    <>
                      <Icon name="list" size={16} />
                      {t("issues.list")}
                    </>
                  ),
                },
              ]}
            />
            <span className="issue-files__grow" />
            <Button size="sm" icon="upload" onClick={pick} loading={adding.uploading}>
              {t("issues.files.add")}
            </Button>
          </div>
          {view === "grid" ? (
            <div className="issue-files__grid">
              {entries.map((e) => (
                <IssueFileTile key={e.id} entry={e} />
              ))}
              {adding.items.map((f) => (
                <PendingTile key={f.key} file={f} onRemove={() => adding.remove(f.key)} />
              ))}
            </div>
          ) : (
            <ul className="issue-files__list">
              {entries.map((e) => (
                <IssueFileRow key={e.id} entry={e} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** A saved file in the grid: its real preview, name and where it came from; a click opens the viewer. */
function IssueFileTile({ entry }: { entry: IssueFileEntry }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const a = useArtifact(org.id, entry.id).data;
  return (
    <button
      type="button"
      className="issue-file"
      onClick={() => viewer.open(entry.id)}
      aria-label={t("artifacts.open", { title: entry.title })}
    >
      <span className="issue-file__thumb">{a ? <DrivePreview artifact={a} /> : <Icon name="file" />}</span>
      <span className="issue-file__text">
        <span className="issue-file__name" title={entry.title}>
          {entry.title}
        </span>
        <span className="issue-file__meta">{entry.origin}</span>
      </span>
    </button>
  );
}

/** A saved file in the list: small preview and name (opens it), where it came from, size, download. */
function IssueFileRow({ entry }: { entry: IssueFileEntry }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const download = useArtifactDownload();
  const a = useArtifact(org.id, entry.id).data;
  const size = a?.content.kind === "file" ? formatBytes(i18n.language, a.content.size) : "";
  return (
    <li className="issue-files__row">
      <button
        type="button"
        className="issue-files__open"
        onClick={() => viewer.open(entry.id)}
        aria-label={t("artifacts.open", { title: entry.title })}
      >
        {a ? <DrivePreview artifact={a} size="sm" /> : <span className="issue-files__noprev" />}
        <span className="issue-files__name" title={entry.title}>
          {entry.title}
        </span>
      </button>
      <span className="issue-files__from small muted">{entry.origin}</span>
      <span className="issue-files__size small muted tabular">{size}</span>
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        icon="download"
        aria-label={t("artifacts.download")}
        title={t("artifacts.download")}
        disabled={!a}
        onClick={() => a && void download.save(a, undefined, a.shownVersion, a.content)}
      />
    </li>
  );
}

/** A file on its way to the Drive (the new-task form, "Adicionar arquivos"): thumbnail or type, name, ✕. */
export function PendingTile({ file: f, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="issue-file" data-status={f.status}>
      <span className="issue-file__thumb">
        {f.preview ? <img src={f.preview} alt="" /> : <Icon name={f.icon} />}
        {f.status === "uploading" && <Spinner size={24} className="issue-file__state" />}
      </span>
      <span className="issue-file__text">
        <span className="issue-file__name" title={f.name}>
          {f.name}
        </span>
        <span className="issue-file__meta">
          {f.status === "uploading"
            ? t("channel.uploading")
            : f.status === "failed"
              ? t("channel.uploadFailed")
              : formatBytes(i18n.language, f.size)}
        </span>
      </span>
      <button
        type="button"
        className="issue-file__remove"
        aria-label={t("channel.removeFile", { name: f.name })}
        onClick={onRemove}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
