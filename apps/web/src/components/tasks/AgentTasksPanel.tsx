import type { EndedTask, ManagedTask } from "@agenteschat/client";
import { TASK_MANAGER_POLL_MS, useTaskSteps } from "@agenteschat/client";
import {
  agentCardLine,
  agentSummary,
  helpersOf,
  linePlace,
  taskPlace,
  taskState,
  taskTitle,
  taskWaitWords,
  waitsOnPerson,
} from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import { Button, EmptyState, Icon, PixelStop } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { QueueDialog } from "@/components/ComputerQueue";
import { ErrorState, LoadingList } from "@/components/Loading";
import { OpensAgent } from "@/components/OpensAgent";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { SidePanel } from "@/components/SidePanel";
import { colorOf } from "@/components/Sky";
import { TaskStepsBlock } from "@/components/ToolCalls";
import { useDirectory } from "@/hooks/useDirectory";
import { useEscClose } from "@/hooks/useEscClose";
import { useNow } from "@/hooks/useNow";
import { lookOf } from "@/lib/look";
import { useAgentTasks } from "./agent-tasks-context";
import {
  StopAllInline,
  StopTaskButton,
  TaskMark,
  TaskWaitLines,
  taskAge,
  useProgramText,
  useTaskStop,
} from "./TaskBits";
import "@/components/threads/threads.css";

/**
 * In a DM's header (ADR 0128), while the agent has tasks the person can see: the orbit (or the waiting mark),
 * "3 tarefas · 1 espera você" and a chevron. It opens and closes the agent's tasks in the side panel.
 */
export function AgentTasksPill() {
  const { t } = useTranslation();
  const control = useAgentTasks();
  if (!control || control.tasks.length === 0) return null;
  const { tasks, open, toggle } = control;
  const { waiting } = agentSummary(tasks);
  const working = tasks.find((task) => taskState(task) === "working");
  const words = t("taskManager.tasks", { count: tasks.length });
  const wait = waiting > 0 ? t("taskManager.waiting", { count: waiting }) : null;
  // On a phone only the counts show, as the phone app's badge: the words took the agent's name down to "O…".
  return (
    <Button
      size="sm"
      className="tm-pill"
      aria-label={wait ? `${words} · ${wait}` : words}
      aria-expanded={open}
      onClick={toggle}
    >
      <span className="tm-pill__mark" aria-hidden="true">
        {working ? <AgentSpinner agentId={working.agentId} size={14} /> : <WaitMark />}
      </span>
      <span className="tm-pill__words" aria-hidden="true">
        {words}
        {wait && <span className="tm-pill__wait">{` · ${wait}`}</span>}
      </span>
      <span className="tm-pill__count" aria-hidden="true">
        {tasks.length}
        {working && wait && (
          <>
            <WaitMark />
            <span className="tm-pill__wait">{waiting}</span>
          </>
        )}
      </span>
      <Icon name="chevronRight" size={14} className="tm-pill__chevron" />
    </Button>
  );
}

/**
 * An agent's tasks beside its DM (ADR 0128), in the side panel a thread opens in: how many now, waiting for you and
 * done today, then a card per task (people's first, then its routines') with its state, where and how long, "Passos"
 * (its steps, as a reply's block lists them) and Parar. At the foot, "Abrir no gerenciador" and "Parar todas", which
 * turns the foot into its confirmation. Esc and a click beside it close it.
 */
export function AgentTasksPanel({
  agentId,
  channelId,
  tasks,
  ended,
  hidden = 0,
  onClose,
}: {
  agentId: string;
  /** This conversation: its task is marked "aqui". */
  channelId: string;
  /** The agent's tasks (`tasksOf`). */
  tasks: ManagedTask[];
  /** What ended today (the task manager's), for "Feitas hoje". */
  ended: EndedTask[];
  /** Its tasks the viewer may not see: it isn't free. */
  hidden?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const now = useNow(30_000);
  const { stop, stopping } = useTaskStop();
  const [confirming, setConfirming] = useState(false);
  useEscClose(onClose);
  const name = dir.anyAgent(agentId)?.name ?? t("channel.unknownAgent");
  const title = t("taskManager.agentTasks", { name });
  const { waiting } = agentSummary(tasks);
  const done = ended.filter((e) => e.agentId === agentId && e.status === "done").length;
  const meta = [
    t("taskManager.agentPanel.now", { count: tasks.length }),
    waiting > 0 ? t("taskManager.waiting", { count: waiting }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const stoppable = tasks.filter((task) => task.canStop && !stopping.has(task.runId)).map((task) => task.runId);
  // The page, with this agent's card chosen.
  const openManager = () =>
    void navigate({ to: "/org/$orgId/task-manager", params: { orgId: org.id }, search: { agent: agentId } });
  const wells: [string, number][] = [
    [t("taskManager.agentPanel.wells.now"), tasks.length],
    [t("taskManager.agentPanel.wells.waiting"), waiting],
    [t("taskManager.agentPanel.wells.done"), done],
  ];

  return (
    <SidePanel className="tm-agentpanel" label={title} onClose={onClose}>
      <header className="channel__header thread-head thread-head--panel">
        <span className="thread-head__who">
          <OpensAgent agentId={agentId}>
            <AgentAvatar agentId={agentId} name={name} size="sm" />
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
        <dl className="tm-panel__facts tm-agentpanel__wells">
          {wells.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="ac-num">{value}</dd>
            </div>
          ))}
        </dl>
        {tasks.length === 0 ? (
          <EmptyState size="panel" agent={lookOf(dir.agentById.get(agentId)) ?? true} mood="deal">
            {hidden > 0 ? agentCardLine(t, 0, hidden) : t("taskManager.agentPanel.none", { name })}
          </EmptyState>
        ) : (
          <>
            <TaskWaitLines tasks={tasks} />
            <ul className="tm-agentpanel__list">
              {tasks.map((task) => (
                <TaskCard
                  key={task.runId}
                  task={task}
                  here={task.channelId === channelId}
                  now={now}
                  stopping={stopping.has(task.runId)}
                  onStop={() => stop([task.runId], undefined, Boolean(task.helpers))}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <footer className="tm-panel__foot">
        {confirming ? (
          <StopAllInline
            agentId={agentId}
            runIds={stoppable}
            helpers={helpersOf(tasks.filter((task) => stoppable.includes(task.runId)))}
            onCancel={() => setConfirming(false)}
            onStop={(runIds, reason) => {
              setConfirming(false);
              stop(runIds, reason, helpersOf(tasks) > 0);
            }}
          />
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={openManager}>
              {t("taskManager.actions.openManager")}
            </Button>
            {stoppable.length > 1 && (
              <Button size="sm" className="tm-panel__stop" onClick={() => setConfirming(true)}>
                <PixelStop size={12} />
                {t("taskManager.actions.stopAll")}
              </Button>
            )}
          </>
        )}
      </footer>
    </SidePanel>
  );
}

/**
 * One of the agent's tasks: its mark, what it is ("aqui" for this conversation's), what it waits for or where and how
 * long, "Passos" while it works (its steps open in the card, asked again every 3 s while open), "Ver fila" while it
 * waits in its computer's line (the line's own dialog), and Parar.
 */
function TaskCard({
  task,
  here,
  now,
  stopping,
  onStop,
}: {
  task: ManagedTask;
  here: boolean;
  now: number;
  stopping: boolean;
  onStop: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const programText = useProgramText();
  const [open, setOpen] = useState(false);
  // The computer whose line is open ("Ver fila"): kept once the task leaves the line, so the dialog stays put.
  const [queueOf, setQueueOf] = useState<string | null>(null);
  const working = taskState(task) === "working" && !stopping;
  const steps = useTaskSteps(org.id, open ? task.runId : null, open && working ? TASK_MANAGER_POLL_MS : false);
  const title = taskTitle(t, task);
  const where = here ? t("taskManager.where.here") : taskPlace(t, task);
  const wait = taskWaitWords(t, i18n.language, task, now);
  const place = linePlace(task);
  const program = programText(task)?.name ?? null;
  // Working, or waiting on a person (its mark says which): where, the program, how long. Held or in a line: that
  // wait and what comes next, then where.
  const sub =
    wait && !waitsOnPerson(task)
      ? [wait.state, wait.next, where].filter(Boolean).join(" · ")
      : taskState(task) === "queued"
        ? [t("taskManager.state.queued"), where].filter(Boolean).join(" · ")
        : [where, program, formatDuration(t, taskAge(task, now))].filter(Boolean).join(" · ");
  const name = dir.anyAgent(task.agentId)?.name ?? t("channel.unknownAgent");
  const hasSteps = steps.data?.steps.some((s) => s.kind === "tool_call") ?? false;
  return (
    <li className="tm-taskcard ac-card" data-open={open || undefined}>
      <div className="tm-taskcard__row">
        <TaskMark task={task} />
        <span className="ac-actline">
          <span className="tm-taskcard__label">
            <span className="tm-taskcard__title">
              <b>{title}</b>
            </span>
            <small>{sub}</small>
          </span>
          <span className="ac-acts">
            {place && (
              <Button size="sm" variant="ghost" onClick={() => setQueueOf(place.machineId)}>
                {t("queue.see")}
              </Button>
            )}
            {working && (
              <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {t("taskManager.panel.steps")}
                <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
              </Button>
            )}
            {task.canStop && (
              <StopTaskButton
                label={t("taskManager.actions.stop")}
                title={title}
                stopping={stopping}
                onClick={onStop}
                compact
              />
            )}
          </span>
        </span>
      </div>
      {open && (
        <div className="tm-taskcard__steps">
          {steps.isLoading ? (
            <LoadingList count={2} avatar={false} />
          ) : steps.isError && !steps.data ? (
            <ErrorState error={steps.error} onRetry={() => void steps.refetch()} />
          ) : steps.data && hasSteps ? (
            <TaskStepsBlock
              steps={steps.data.steps}
              run={steps.data.run}
              working={working}
              agentName={name}
              color={colorOf(dir.anyAgent(task.agentId))}
            />
          ) : (
            <p className="tm-panel__none">{t("taskManager.panel.noSteps")}</p>
          )}
        </div>
      )}
      {queueOf && (
        <QueueDialog
          machineId={queueOf}
          open
          onOpenChange={(shown) => {
            if (!shown) setQueueOf(null);
          }}
        />
      )}
    </li>
  );
}
