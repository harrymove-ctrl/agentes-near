import type { MissionFileName } from "@agenteschat/client";
import { useMission, useMissionFiles } from "@agenteschat/client";
import { formatTime, relativeTime } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { editDiff, executorName, type MdLine, mdLines, newLineIndexes } from "@agenteschat/client/lib/missions";
import { DetailsDialog, Diff, Icon, Segmented, Skeleton } from "@agenteschat/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { codeAndBold } from "@/lib/markdown";

/**
 * "Arquivos da missão": mission.md (plan and
 * rules, written by agentes.chat), decisions.md (approved decisions) and
 * notes.md (the executor's notes), rendered. Lines that arrived while the
 * panel was open fade in with a faint time; an edit found on the computer
 * says we kept the approved version, with the small diff on demand.
 */

export const MISSION_FILES: MissionFileName[] = ["mission.md", "decisions.md", "notes.md"];
const FOLDER = ".agentes/";

/** What each file was the last time this page drew it (new lines fade in after). */
const seen = new Map<string, string>();

export function MissionFilesPanel({
  missionId,
  tab,
  diff: diffOpen,
  onTab,
  onClose,
}: {
  missionId: string;
  tab: MissionFileName;
  diff?: boolean;
  onTab: (tab: MissionFileName) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const files = useMissionFiles(org.id, missionId);
  const mission = useMission(org.id, missionId);
  const [showDiff, setShowDiff] = useState(Boolean(diffOpen));
  useEffect(() => setShowDiff(Boolean(diffOpen)), [diffOpen]);
  const file = files.data?.files.find((f) => f.name === tab);
  const edit = files.data?.editedOnMachine.find((e) => e.name === tab);
  const dir = useDirectory(org.id);
  const executor = executorName(
    mission.data?.executor ?? "claude",
    dir.agentById.get(mission.data?.agentId ?? "")?.name ?? "",
  );
  const xg = agentGrammar(executor);
  const content = file?.content ?? "";
  const key = `${missionId}:${tab}`;
  // The lines new since we last drew this file, and when they came.
  const fresh = useMemo(() => newLineIndexes(seen.get(key), content), [key, content]);
  const freshAt = useRef<string | null>(null);
  if (fresh.size > 0) freshAt.current = file?.updatedAt ?? new Date().toISOString();
  useEffect(() => {
    if (file?.content != null) seen.set(key, file.content);
  }, [key, file?.content]);
  const subtitle: Record<string, string> = {
    "mission.md": t("missions.files.missionSub"),
    "decisions.md": t("missions.files.decisionsSub"),
    "notes.md": t("missions.files.notesSub", { executor, context: xg.context }),
  };
  const synced = file?.writtenAt ?? file?.updatedAt;
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      className="mi-files"
      eyebrow={mission.data?.title}
      title={t("missions.files.title")}
      subtitle={
        <span>
          {t("missions.files.folder")} <code className="mi-mono">{FOLDER}</code>
        </span>
      }
      closeLabel={t("common.close")}
      footer={
        <div className="mi-files__foot ac-iconline">
          <Icon name="info" size={14} />
          <span>
            {tab === "notes.md"
              ? t("missions.files.notesFoot", { executor, context: xg.context })
              : t("missions.files.foot")}
          </span>
        </div>
      }
    >
      <div className="mi-files__tabs">
        <Segmented
          size="sm"
          label={t("missions.files.tabs")}
          value={tab}
          onValueChange={onTab}
          options={MISSION_FILES.map((name) => ({ value: name, label: name }))}
        />
      </div>
      <div className="mi-files__meta">
        <b>{subtitle[tab]}</b>
        {synced && <span>{t("missions.files.synced", { when: relativeTime(t, i18n.language, synced) })}</span>}
        {edit && (
          <span className="mi-files__edited">
            <Icon name="refresh" size={14} />
            <span>{t("missions.files.editedKept")}</span>
            <button type="button" className="mi-link" aria-expanded={showDiff} onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? t("missions.files.hideDiff") : t("missions.files.showDiff")}
            </button>
          </span>
        )}
      </div>
      <div className="mi-files__body">
        {edit && showDiff && (
          <div className="mi-files__diff">
            <Diff
              code
              lines={editDiff(edit.diff)}
              addedLabel={t("missions.files.added")}
              removedLabel={t("missions.files.removed")}
              aria-label={t("missions.files.diffLabel", { name: tab })}
            />
            <small>{t("missions.files.diffHint")}</small>
          </div>
        )}
        {files.isPending && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Skeleton width="50%" height={20} />
            <Skeleton width="90%" />
            <Skeleton width="70%" />
          </div>
        )}
        {files.isError && <ErrorState error={files.error} onRetry={() => void files.refetch()} />}
        {files.isSuccess &&
          (content.trim() ? (
            <MissionMarkdown
              content={content}
              fresh={fresh}
              freshLabel={freshAt.current ? formatTime(i18n.language, freshAt.current) : ""}
            />
          ) : (
            <p className="mi-md mi-md__empty">{t("missions.files.empty")}</p>
          ))}
      </div>
    </DetailsDialog>
  );
}

/** The `.agentes/` files' Markdown: headings, checklists, bullets, quotes, paragraphs. */
export function MissionMarkdown({
  content,
  fresh = new Set(),
  freshLabel = "",
}: {
  content: string;
  fresh?: Set<number>;
  freshLabel?: string;
}) {
  const lines = useMemo(() => mdLines(content), [content]);
  return (
    <div className="mi-md">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a file's lines, in order
        <MdRow key={i} line={l} fresh={fresh.has(i)} at={fresh.has(i) ? freshLabel : ""} />
      ))}
    </div>
  );
}

function MdRow({ line, fresh, at }: { line: MdLine; fresh: boolean; at: string }) {
  const { t } = useTranslation();
  if (line.kind === "blank") return null;
  const mark = fresh ? { "data-fresh": "" } : {};
  const time = at ? <span className="mi-md__at">{at}</span> : null;
  if (line.kind === "h1")
    return (
      <div className="mi-md__l mi-md__h1" {...mark}>
        {codeAndBold(line.text)}
        {time}
      </div>
    );
  if (line.kind === "h2")
    return (
      <div className="mi-md__l mi-md__h2" {...mark}>
        {codeAndBold(line.text)}
        {time}
      </div>
    );
  if (line.kind === "check")
    return (
      <div className="mi-md__l mi-md__check" data-state={line.state} {...mark}>
        <span className={line.state === "done" ? "mi-box mi-box--on" : "mi-box"} aria-hidden="true">
          {line.state === "done" && <Icon name="check" size={14} />}
        </span>
        <span>
          {codeAndBold(line.text)}
          {line.state !== "done" && line.state !== "todo" && <small>{t(`missions.files.check.${line.state}`)}</small>}
          {line.note && <small>{line.note}</small>}
          {time}
        </span>
      </div>
    );
  const cls = line.kind === "li" ? "mi-md__li" : line.kind === "quote" ? "mi-md__p mi-md__quote" : "mi-md__p";
  return (
    <div className={`mi-md__l ${cls}`} {...mark}>
      {codeAndBold(line.text)}
      {time}
    </div>
  );
}
