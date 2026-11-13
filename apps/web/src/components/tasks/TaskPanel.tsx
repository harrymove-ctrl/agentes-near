import type { EndedTask, ManagedTask } from "@agenteschat/client";
import { TASK_MANAGER_POLL_MS, useTaskSteps } from "@agenteschat/client";
import { type Activity, activityVerb, toolActivity } from "@agenteschat/client/lib/activity";
import { capitalize } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  delegationText,
  endedState,
  taskPlace,
  taskState,
  taskTime,
  taskTitle,
} from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import { Button, Chip, GroupHeading, PixelStop } from "@agenteschat/ui";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { ErrorState, LoadingList } from "@/components/Loading";
import { OpensAgent } from "@/components/OpensAgent";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { colorOf } from "@/components/Sky";
import { TaskStepsBlock } from "@/components/ToolCalls";
import { useDirectory } from "@/hooks/useDirectory";
import { useEscClose } from "@/hooks/useEscClose";
import { inlineWords } from "@/lib/markdown";
import { SayWhy, StopTaskButton, TaskStateChip, UsingNow, useOpenTask } from "./TaskBits";
import "@/components/threads/threads.css";

/**
 * A task opened from the task manager ("Ver passos", ADR 0128), over the page like a thread beside its channel: the
 * agent and what the task is, what it does now, its state, time and what it uses (no cost), its steps as a reply's
 * block lists them (asked again every 3 s while it works), "Abrir na conversa" and "Parar tarefa". Once stopped it
 * says so, and who stopped it can still say why.
 */
export function TaskPanel({
  runId,
  task,
  ended,
  stopping,
  said,
  now,
  onStop,
  onClose,
}: {
  runId: string;
  /** The task while it is on (the page's list); undefined once it ended. */
  task: ManagedTask | undefined;
  /** How it ended, once the page's list says so. */
  ended: EndedTask | undefined;
  /** Stopped from this page: "Parando…", then stopped by me. */
  stopping: boolean;
  /** The reason said with that stop. */
  said: string | undefined;
  now: number;
  onStop: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  useEscClose(onClose);
  const dir = useDirectory(org.id);
  const openTask = useOpenTask();
  // The task as last seen while it was on: what the panel still says once it ended.
  const [seen, setSeen] = useState(task);
  if (task && task !== seen) setSeen(task);
  const last = task ?? seen;
  const working = Boolean(task && taskState(task) === "working" && !stopping);
  const steps = useTaskSteps(org.id, runId, working ? TASK_MANAGER_POLL_MS : false);
  // Once it stops working its steps are asked once more, so its last call says how it ended.
  const refetch = steps.refetch;
  const [wasWorking, setWasWorking] = useState(working);
  useEffect(() => {
    if (wasWorking && !working) void refetch();
    setWasWorking(working);
  }, [working, wasWorking, refetch]);
  const [sent, setSent] = useState<string | null>(null);

  const source = last ?? ended;
  if (!source) return null;
  const name = dir.anyAgent(source.agentId)?.name ?? t("channel.unknownAgent");
  const title = taskTitle(t, source);
  const asked = last?.requester
    ? last.requester.userId === me.user.id
      ? t("taskManager.askedByYou")
      : t("taskManager.askedBy", { name: last.requester.name })
    : null;
  const nameOf = (id: string) => dir.anyAgent(id)?.name;
  const chain = last ? delegationText(t, last, nameOf, me.user.id) : null;
  const meta = [name, taskPlace(t, source), source.background ? null : (chain ?? asked)].filter(Boolean).join(" · ");
  // How it ended: the page's list, else my own stop on its way there.
  const end = task ? null : ended ? endedState(ended) : stopping ? "stopped" : null;
  const stopper = ended?.stoppedBy ?? (stopping ? { userId: me.user.id, name: me.user.name } : null);
  const byMe = end === "stopped" && stopper?.userId === me.user.id;
  const reason = said ?? sent;
  const doing: Activity = task?.now
    ? toolActivity(task.now.tool, task.now.connector, task.now.detail, task.now)
    : { kind: "thinking" };
  const took = ended ? Date.parse(ended.finishedAt) - Date.parse(ended.startedAt ?? ended.finishedAt) : null;
  const state = task ? (
    <TaskStateChip task={task} stopping={stopping} />
  ) : end === "stopped" ? (
    <Chip icon="stop">{t("taskManager.state.stopped")}</Chip>
  ) : end === "done" ? (
    <Chip icon="check">{t("taskManager.ended.done")}</Chip>
  ) : end === "failed" ? (
    <Chip icon="alert">{t("taskManager.ended.failed")}</Chip>
  ) : (
    "—"
  );
  const using = task ? <UsingNow task={task} /> : "—";
  const facts: [string, ReactNode][] = [
    [t("taskManager.columns.state"), state],
    [t("taskManager.columns.time"), task ? taskTime(t, task, now) : took !== null ? formatDuration(t, took) : "—"],
    [t("taskManager.columns.using"), using],
  ];
  const hasSteps = steps.data?.steps.some((s) => s.kind === "tool_call") ?? false;

  return (
    <SidePanel className="tm-panel" label={title} onClose={onClose}>
      <header className="channel__header thread-head thread-head--panel">
        <span className="thread-head__who">
          <OpensAgent agentId={source.agentId}>
            <AgentAvatar agentId={source.agentId} name={name} size="sm" />
          </OpensAgent>
        </span>
        <div className="thread-head__text">
          <h2 className="channel__title thread-title">
            <span className="thread-title__text">{title}</span>
          </h2>
          <span className="channel__topic thread-head__meta">{meta}</span>
        </div>
        <Button size="sm" variant="ghost" iconOnly icon="close" aria-label={t("common.close")} onClick={onClose} />
      </header>

      <div className="thread-panel__page tm-panel__body">
        {working && (
          <p className="tm-panel__now ac-iconline" aria-live="polite">
            <AgentSpinner agentId={source.agentId} size={14} />
            <span>
              <b className="ac-tools__shimmer">{capitalize(activityVerb(t, doing), i18n.language)}…</b>
              {task?.now?.detail && <small> {inlineWords(task.now.detail)}</small>}
            </span>
          </p>
        )}
        {end === "stopped" && (
          <div className="tm-panel__stopped">
            <p className="ac-iconline">
              <PixelStop size={12} dim />
              <span>
                <b>
                  {byMe
                    ? t("taskManager.stopped.line", { agent: name, context: agentGrammar(name).context })
                    : stopper
                      ? t("taskManager.stopped.lineBy", {
                          name: stopper.name,
                          agent: name,
                          context: agentGrammar(name).context,
                        })
                      : t("taskManager.state.stopped")}
                </b>
                {reason && ` · ${t("taskManager.stopped.reason", { reason })}`}
              </span>
            </p>
            {byMe && !reason && <SayWhy runId={runId} onSent={setSent} />}
          </div>
        )}
        <dl className="tm-panel__facts">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <section>
          <GroupHeading level={3} title={t("taskManager.panel.steps")} />
          {steps.isLoading ? (
            <LoadingList count={2} avatar={false} />
          ) : steps.isError && !steps.data ? (
            <ErrorState error={steps.error} onRetry={() => void refetch()} />
          ) : steps.data && hasSteps ? (
            <TaskStepsBlock
              steps={steps.data.steps}
              run={steps.data.run}
              working={working}
              agentName={name}
              color={colorOf(dir.anyAgent(source.agentId))}
            />
          ) : (
            <p className="tm-panel__none">{t("taskManager.panel.noSteps")}</p>
          )}
        </section>
      </div>

      <footer className="tm-panel__foot">
        {task?.delegation && task.canStop && (
          <p className="tm-panel__note">
            {t("taskManager.delegated.stopNote", { name: nameOf(task.delegation.agentId) ?? "" })}
          </p>
        )}
        {!source.background && !source.betweenAgents && (
          <Button size="sm" variant="ghost" icon="message" onClick={() => openTask(source)}>
            {t("taskManager.actions.open")}
          </Button>
        )}
        {task?.canStop && (
          <StopTaskButton
            label={t(task.helpers ? "taskManager.actions.stopAll" : "taskManager.actions.stopTask")}
            stopping={stopping}
            onClick={onStop}
            className="tm-panel__stop"
          />
        )}
      </footer>
    </SidePanel>
  );
}
