import type { MachineTask, Mission } from "@agenteschat/client";
import { useTaskOutput } from "@agenteschat/client";
import { formatTime } from "@agenteschat/client/lib/format";
import {
  appendOutputLine,
  formatSpan,
  type SessionState,
  sessionState,
  taskPr,
  taskRange,
  taskSeconds,
} from "@agenteschat/client/lib/missions";
import { Button, DetailsDialog, Icon, type IconName, Segmented } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentSpinner } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useNamesComputers } from "@/components/WorkspaceComputer";
import { useNow } from "./MissionBits";

/**
 * One row per executor session: status icon,
 * title, ONE human line (the live last line with the agent's cursor while it
 * runs), time and the PR; opened: "O que mudou · N arquivos" and the output.
 * The sessions don't talk to people: our agent reviews and speaks once.
 */

const ICON: Record<SessionState, IconName> = {
  running: "spinner",
  done: "check",
  failed: "alert",
  interrupted: "pause",
  canceled: "stop",
  queued: "clock",
};

export function SessionRows({
  tasks,
  computer,
  defaultOpen = true,
  foot,
}: {
  tasks: MachineTask[];
  /** "MacBook do Walter", for the summary line. */
  computer?: string | null;
  defaultOpen?: boolean;
  foot?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const running = tasks.filter((x) => x.status === "running").length;
  const now = useNow(running > 0);
  if (tasks.length === 0) return null;
  const count = (status: MachineTask["status"]) => tasks.filter((x) => x.status === status).length;
  const parts = [
    count("done") ? t("missions.sessions.done", { count: count("done") }) : "",
    running ? t("missions.sessions.running", { count: running }) : "",
    count("interrupted") ? t("missions.sessions.interrupted", { count: count("interrupted") }) : "",
    count("failed") ? t("missions.sessions.failed", { count: count("failed") }) : "",
    count("queued") ? t("missions.sessions.queued", { count: count("queued") }) : "",
  ].filter(Boolean);
  return (
    <div className="mi-sessions">
      <button type="button" className="mi-sessions__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronRight" size={14} />
        <span>
          <b>{t("missions.sessions.count", { count: tasks.length })}</b>
          {parts.length > 0 && ` · ${parts.join(", ")}`}
          {computer && ` · ${computer}`}
        </span>
      </button>
      {open && tasks.map((task) => <SessionRow key={task.id} task={task} now={now} />)}
      {open && foot && (
        <div className="mi-session mi-session--foot">
          <span />
          <span className="mi-session__none">{foot}</span>
          <span />
        </div>
      )}
    </div>
  );
}

type SessionFilter = "all" | "running" | "done" | "failed";
const FILTERS: SessionFilter[] = ["all", "running", "done", "failed"];
const inFilter = (task: MachineTask, f: SessionFilter) =>
  f === "all" ||
  (f === "running" && (task.status === "running" || task.status === "queued")) ||
  (f === "done" && task.status === "done") ||
  (f === "failed" && (task.status === "failed" || task.status === "interrupted" || task.status === "canceled"));

/**
 * "N sessões ›" from the mission header: every executor session in the
 * shared details dialog, filtered Todas / Rodando / Concluídas / Falharam
 * (with counts); a session opens in place ("O que mudou", "Ver saída" with
 * the live log). The computer only where the workspace has more than one.
 */
export function SessionsDialog({
  mission,
  tasks,
  onClose,
}: {
  mission: Pick<Mission, "title" | "machine">;
  tasks: MachineTask[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const names = useNamesComputers(org.id);
  const [filter, setFilter] = useState<SessionFilter>("all");
  const running = tasks.filter((x) => x.status === "running").length;
  const now = useNow(running > 0);
  const shown = tasks.filter((x) => inFilter(x, filter));
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("common.close")}
      className="mi-sessions-dialog"
      eyebrow={t("missions.sessions.eyebrow", { title: mission.title })}
      title={t("missions.sessions.title")}
      subtitle={
        <span>
          {t("missions.sessions.count", { count: tasks.length })}
          {names && mission.machine && ` · ${mission.machine.name}`}
        </span>
      }
    >
      <Segmented
        size="sm"
        label={t("missions.sessions.filterLabel")}
        value={filter}
        onValueChange={setFilter}
        options={FILTERS.map((f) => ({
          value: f,
          label: t(`missions.sessions.filter.${f}`),
          count: f === "all" ? undefined : tasks.filter((x) => inFilter(x, f)).length,
        }))}
      />
      {shown.length === 0 ? (
        <p className="mi-session__none">{t("missions.sessions.noneHere")}</p>
      ) : (
        <ul className="mi-sessions mi-sessions--flat" aria-label={t("missions.sessions.title")}>
          {shown.map((task) => (
            <li key={task.id}>
              <SessionRow task={task} now={now} />
            </li>
          ))}
        </ul>
      )}
    </DetailsDialog>
  );
}

function SessionRow({ task, now }: { task: MachineTask; now: number }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState(false);
  const [all, setAll] = useState(false);
  const state = sessionState(task);
  const pr = taskPr(task);
  const live = state === "running";
  const files = task.files ?? [];
  const shown = all ? files : files.slice(0, 3);
  // ADR 0044: the session that prepares the mission's copy of the project, and sessions that only read.
  const title = task.mode === "setup" ? t("missions.sessions.setupTitle") : task.title;
  const readOnly = task.mode === "read";
  const range = taskRange(task);
  const line =
    state === "interrupted"
      ? task.endedAt
        ? t("missions.sessions.stoppedFinal")
        : t("missions.sessions.stoppedAt", {
            time: formatTime(i18n.language, task.lastEventAt ?? task.createdAt),
          })
      : state === "queued"
        ? t("missions.sessions.queuedLine")
        : state === "canceled"
          ? t("missions.sessions.canceledLine")
          : task.lastLine || (live ? t("missions.sessions.working") : "");
  return (
    <>
      <div className="mi-session ac-iconline">
        <span className="mi-session__icon" data-state={state} title={t(`missions.sessions.state.${state}`)}>
          {state === "running" ? <AgentSpinner agentId={task.agentId} /> : <Icon name={ICON[state]} size={14} />}
        </span>
        <button type="button" className="mi-session__title" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <b>
            <span>{title}</span>
            {readOnly && <small className="mi-session__mode">{t("missions.sessions.readOnly")}</small>}
            <Icon name="chevronRight" size={14} />
          </b>
          {line && (
            <span className="mi-session__line">
              <span key={line}>{line}</span>
              {live && <span className="mi-cursor" aria-hidden="true" />}
            </span>
          )}
          {task.branch && (
            <span className="mi-session__branch">
              <Icon name="pullRequest" size={14} />
              <code>{task.branch}</code>
            </span>
          )}
        </button>
        <span className="mi-session__end">
          <span className="mi-session__time" data-live={live || undefined}>
            {state === "queued" ? "" : formatSpan(t, taskSeconds(task, now))}
          </span>
          {pr &&
            (pr.url ? (
              <a className="mi-pr" href={pr.url} target="_blank" rel="noreferrer">
                <Icon name="pullRequest" size={14} />
                {t("missions.sessions.pr", { number: pr.number })}
              </a>
            ) : (
              <span className="mi-pr">
                <Icon name="pullRequest" size={14} />
                {t("missions.sessions.pr", { number: pr.number })}
              </span>
            ))}
        </span>
      </div>
      {open && (
        <div className="mi-session__more">
          {files.length > 0 ? (
            <>
              <h4>
                {t("missions.sessions.changed")}
                <span>{t("missions.sessions.files", { count: files.length })}</span>
                {range && <code className="mi-mono">{range}</code>}
              </h4>
              <ul className="mi-session__files">
                {shown.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
              {files.length > 3 && (
                <button type="button" className="mi-link" onClick={() => setAll((v) => !v)}>
                  {all ? t("missions.sessions.less") : t("missions.sessions.more", { count: files.length - 3 })}
                </button>
              )}
            </>
          ) : (
            <>
              <h4>
                {t("missions.sessions.changed")}
                {range && <code className="mi-mono">{range}</code>}
              </h4>
              <span className="mi-session__none">
                {readOnly ? t("missions.sessions.readOnlyText") : t("missions.sessions.nothingYet")}
              </span>
            </>
          )}
          {output && <TaskLog task={task} live={live} />}
          <div>
            <Button size="sm" variant="ghost" icon="code" aria-expanded={output} onClick={() => setOutput((v) => !v)}>
              {output ? t("missions.sessions.hideOutput") : t("missions.sessions.showOutput")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * "Ver saída": the session's last lines (the computer reads its log; offline,
 * the lines the server kept), in mono; while it runs, each new live line
 * joins at the end.
 */
function TaskLog({ task, live }: { task: MachineTask; live: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const output = useTaskOutput(org.id, task.id, true);
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (output.data) setLines(output.data.lines);
  }, [output.data]);
  useEffect(() => {
    if (live) setLines((prev) => appendOutputLine(prev, task.lastLine));
  }, [live, task.lastLine]);
  const empty = lines.length === 0;
  return (
    <div className="mi-log-wrap">
      {output.data?.source === "saved" && !empty && (
        <span className="mi-hint ac-iconline">
          <Icon name="computer" size={14} />
          {t("missions.sessions.savedOutput")}
        </span>
      )}
      <pre
        className="mi-log"
        role="log"
        aria-label={t("missions.sessions.outputLabel", { title: task.title })}
        aria-busy={output.isPending}
      >
        {output.isPending && empty
          ? t("missions.sessions.loadingOutput")
          : empty
            ? t("missions.sessions.noOutput")
            : lines.join("\n")}
        {live && <span className="mi-cursor" aria-hidden="true" />}
      </pre>
    </div>
  );
}
