import type { ComputerSummary, EndedTask, ManagedTask } from "@agenteschat/client";
import { useTaskManager } from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import {
  type AgentTasks,
  activityLine,
  agentCardLine,
  agentSummary,
  delegationText,
  endedState,
  groupLead,
  groupTasks,
  helpersOf,
  hiddenCount,
  taskPlace,
  taskState,
  tasksOf,
  taskTime,
  taskTitle,
  taskWhere,
  todayStart,
} from "@agenteschat/client/lib/task-manager";
import { formatDuration } from "@agenteschat/client/lib/work";
import {
  type AgentColor,
  Button,
  Carousel,
  Chip,
  CountChip,
  EmptyState,
  GroupHeading,
  Icon,
  type IconName,
  PageHeader,
  PixelSpinner,
  PixelStop,
  SearchField,
} from "@agenteschat/ui";
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Sparkline } from "@/components/ChartBlock";
import { QueueDialog } from "@/components/ComputerQueue";
import { ErrorState, LoadingList } from "@/components/Loading";
import { OpensAgent } from "@/components/OpensAgent";
import { useOrg } from "@/components/org-context";
import { WaitMark } from "@/components/RequestCard";
import { colorOf } from "@/components/Sky";
import {
  heatOf,
  ProgramStack,
  StopAllConfirm,
  StopTaskButton,
  TaskMark,
  TaskStateChip,
  TaskWaitLines,
  taskAge,
  taskSub,
  UsingNow,
  useProgramText,
  useTaskStop,
} from "@/components/tasks/TaskBits";
import { TaskPanel } from "@/components/tasks/TaskPanel";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { useRightHandLook } from "@/hooks/useRightHandLook";
import "./task-manager.css";

/*
 * The task manager (ADR 0128), one page: the agents as cards with their last half hour (one chosen shows only its
 * tasks), the tasks now (asked by people, grouped by agent and folded until opened, then the routines' background
 * runs) with their state, what each uses, its time and Parar, and what ended today at the end. No cost anywhere:
 * here people stop work. A row or an agent's card chosen gives the toolbar "Ver passos" and "Parar tarefa" / "Parar
 * tudo de Dev".
 */

/** Points on a card's line: the last half hour, one per minute. */
const LINE_POINTS = 30;

/** A row's stop that asks first: the square alone, its words on hover and for screen readers (`what`: whose). */
const stopSquare = (words: string, what?: string) => (
  <Button
    size="sm"
    variant="ghost"
    iconOnly
    className="tm-stop"
    aria-label={what ? `${words}: ${what}` : words}
    title={words}
  >
    <PixelStop size={12} />
  </Button>
);

/**
 * `agent`: that agent's card chosen as the page opens (`?agent=`, from its tasks' panel in a DM); `task`: that task's
 * panel open (`?task=`, from a row of a computer's line).
 */
export function TaskManagerPage({
  agent,
  task: openRun,
  onTaskClosed,
}: {
  agent?: string;
  task?: string;
  /** `task`'s panel closed: the address forgets it, so a row of the line opens it again. */
  onTaskClosed?: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const look = useRightHandLook();
  const view = useTaskManager(org.id, { since: todayStart() });
  const now = useNow(1_000);
  const programText = useProgramText();
  const { stop, stopping, said } = useTaskStop();
  const [q, setQ] = useState("");
  // The agent card chosen (null: Todos), the task row chosen (a run id), the agents opened in the table.
  const [card, setCard] = useState<string | null>(agent ?? null);
  useEffect(() => {
    if (agent) setCard(agent);
  }, [agent]);
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  const [endedOpen, setEndedOpen] = useState(false);
  // Which "Parar tudo" confirmation is open: the toolbar's, or an agent row's (`row:<id>`).
  const [confirm, setConfirm] = useState<string | null>(null);
  // The task whose steps are open in the panel ("Ver passos"); it stays open after the task ends.
  const [panel, setPanel] = useState<string | null>(openRun ?? null);
  useEffect(() => {
    if (openRun) setPanel(openRun);
  }, [openRun]);
  // The computer whose line is open ("Ver fila"): the line's own dialog, as a conversation's header opens it.
  const [queueOf, setQueueOf] = useState<string | null>(null);

  const all = view.data?.tasks ?? [];
  const activity = view.data?.activity;
  // The computers with turns running or waiting for room (ADR 0128).
  const computers = view.data?.computers ?? [];
  // "Cheio · 3 na fila" or "Tem espaço", and "1 trabalhando": a computer as the page lists it.
  const computerText = (c: ComputerSummary) => {
    const room = c.inLine > 0 ? t("taskManager.queue.full", { count: c.inLine }) : t("taskManager.queue.room");
    return c.working > 0 ? `${room} · ${t("taskManager.working", { count: c.working })}` : room;
  };
  const nameOf = (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent");
  const query = q.trim().toLocaleLowerCase();
  const matches = (task: ManagedTask) => {
    if (!query) return true;
    const using = programText(task);
    return [taskTitle(t, task), taskWhere(t, task), nameOf(task.agentId), using?.name, using?.detail]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(query);
  };
  const shown = all.filter(matches);
  const grouped = groupTasks(shown, stopping);
  const summary = agentSummary(all);
  const hidden = view.data?.hidden;

  // The cards: who has tasks, in the table's order, then who worked in the last hour; the chosen one stays.
  const lines = useMemo(() => {
    const out = new Map<string | null, number[]>([[null, activityLine(activity ?? {}, null, LINE_POINTS)]]);
    for (const id of Object.keys(activity ?? {})) out.set(id, activityLine(activity ?? {}, id, LINE_POINTS));
    return out;
  }, [activity]);
  const quiet = useMemo(() => Array.from({ length: LINE_POINTS }, () => 0), []);
  const cardIds: string[] = [];
  const addCard = (id: string) => {
    if (!cardIds.includes(id) && listsAgent(org, dir.anyAgent(id))) cardIds.push(id);
  };
  for (const g of groupTasks(all).groups) addCard(g.agentId);
  for (const task of all) addCard(task.agentId);
  for (const id of Object.keys(hidden?.byAgent ?? {})) addCard(id);
  const worked = Object.entries(activity ?? {})
    .filter(([, line]) => line.some((n) => n > 0))
    .map(([id]) => id)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const id of worked) addCard(id);
  if (card) addCard(card);

  const selTask = all.find((task) => task.runId === selected);
  const stoppableOf = (agentId: string) =>
    tasksOf(all, agentId)
      .filter((task) => task.canStop && !stopping.has(task.runId))
      .map((task) => task.runId);
  const pick = (id: string) => {
    setConfirm(null);
    setSelected((s) => (s === id ? null : id));
  };
  // A search opens every agent, so what it found shows; one folded during it stays folded until the search ends.
  const searching = query !== "";
  useEffect(() => {
    if (!searching) setShut(new Set());
  }, [searching]);
  const isOpen = (key: string) => (searching ? !shut.has(key) : opened.has(key));
  const toggle = (key: string) =>
    (searching ? setShut : setOpened)((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const stopOne = (task: ManagedTask) => stop([task.runId]);
  /** The stop of a task that asked other agents: it and they, after a confirmation. */
  const stopChain = (task: ManagedTask, trigger: ReactNode) => (
    <StopAllConfirm
      agentId={task.agentId}
      runIds={[task.runId]}
      helpers={task.helpers}
      open={confirm === `chain:${task.runId}`}
      onOpenChange={(open) => setConfirm(open ? `chain:${task.runId}` : null)}
      onStop={(runIds, reason) => stop(runIds, reason, true)}
      trigger={trigger}
    />
  );

  const row = (task: ManagedTask, look: "grouped" | "flat" | "agent") => (
    <TaskRow
      key={task.runId}
      task={task}
      now={now}
      look={look}
      meId={me.user.id}
      agentName={nameOf(task.agentId)}
      chain={delegationText(t, task, (id) => dir.anyAgent(id)?.name, me.user.id)}
      stopAll={
        task.helpers && !stopping.has(task.runId)
          ? stopChain(task, stopSquare(t("taskManager.actions.stopAll"), taskTitle(t, task)))
          : null
      }
      selected={selected === task.runId}
      stopping={stopping.has(task.runId)}
      onSelect={() => pick(task.runId)}
      onSteps={() => setPanel(task.runId)}
      onStop={() => stopOne(task)}
    />
  );

  // Everyone's work counts here, as on the computers' rows; what the viewer may not see only counts.
  const working = summary.working + (hidden?.working ?? 0);
  const heading = card ? t("taskManager.agentTasks", { name: nameOf(card) }) : t("taskManager.now");
  const barRunIds = card ? stoppableOf(card) : [];
  const barHelpers = helpersOf(all.filter((task) => barRunIds.includes(task.runId)));
  const stopTool =
    selTask?.canStop && !stopping.has(selTask.runId) && selTask.helpers ? (
      stopChain(
        selTask,
        <Button size="sm" variant="ghost" className="tm-tool-stop">
          <PixelStop size={12} />
          {t("taskManager.actions.stopAll")}
        </Button>,
      )
    ) : selTask?.canStop && !stopping.has(selTask.runId) ? (
      <Button size="sm" variant="ghost" className="tm-tool-stop" onClick={() => stopOne(selTask)}>
        <PixelStop size={12} />
        {t("taskManager.actions.stopTask")}
      </Button>
    ) : !selTask && card && barRunIds.length > 0 ? (
      <StopAllConfirm
        agentId={card}
        runIds={barRunIds}
        helpers={barHelpers}
        open={confirm === "bar"}
        onOpenChange={(open) => setConfirm(open ? "bar" : null)}
        onStop={(runIds, reason) => stop(runIds, reason, barHelpers > 0)}
        trigger={
          <Button size="sm" variant="ghost" className="tm-tool-stop">
            <PixelStop size={12} />
            {t("taskManager.actions.stopAllOf", { name: nameOf(card) })}
          </Button>
        }
      />
    ) : (
      <Button size="sm" variant="ghost" disabled>
        <PixelStop size={12} />
        {t("taskManager.actions.stopTask")}
      </Button>
    );

  const endedShown = (e: EndedTask) =>
    (!card || e.agentId === card) &&
    (!query || `${taskTitle(t, e)} ${nameOf(e.agentId)}`.toLocaleLowerCase().includes(query));
  const ended = (view.data?.ended ?? []).filter(endedShown);

  return (
    <div className="page page--list tm">
      <PageHeader
        title={t("taskManager.title")}
        meta={t("taskManager.subtitle")}
        count={
          (working > 0 || summary.waiting > 0) && (
            <span className="tm-sum">
              {working > 0 && (
                <span className="tm-sum__item">
                  <PixelSpinner size={14} />
                  {t("taskManager.working", { count: working })}
                </span>
              )}
              {summary.waiting > 0 && (
                <span className="tm-sum__item tm-sum__item--wait">
                  <WaitMark />
                  {t("taskManager.waiting", { count: summary.waiting })}
                </span>
              )}
            </span>
          )
        }
        actions={
          <div className="tm-search">
            <SearchField
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onClear={() => setQ("")}
              clearLabel={t("filters.clearSearch")}
              placeholder={t("taskManager.search")}
              aria-label={t("taskManager.search")}
            />
          </div>
        }
      />

      {view.isLoading && <LoadingList count={4} avatar={false} />}
      {view.isError && !view.data && <ErrorState error={view.error} onRetry={() => void view.refetch()} />}

      {view.data && cardIds.length > 0 && (
        <Carousel
          label={t("taskManager.cards.label")}
          previousLabel={t("taskManager.cards.previous")}
          nextLabel={t("taskManager.cards.next")}
          className="tm-cards"
        >
          <AgentCard
            agentId={null}
            name={t("taskManager.all")}
            tasks={all}
            hidden={hiddenCount(hidden, null)}
            line={lines.get(null) ?? quiet}
            color="graphite"
            lineLabel={t("taskManager.activityAll")}
            pressed={card === null}
            onPress={() => {
              setCard(null);
              setSelected(null);
              setConfirm(null);
            }}
          />
          {cardIds.map((id) => (
            <AgentCard
              key={id}
              agentId={id}
              name={nameOf(id)}
              tasks={tasksOf(all, id)}
              hidden={hiddenCount(hidden, id)}
              line={lines.get(id) ?? quiet}
              color={colorOf(dir.anyAgent(id))}
              lineLabel={t("taskManager.activityOf", { name: nameOf(id) })}
              pressed={card === id}
              onPress={() => {
                setCard((c) => (c === id ? null : id));
                setSelected(null);
                setConfirm(null);
              }}
            />
          ))}
        </Carousel>
      )}

      {computers.length > 0 && (
        <section className="tm-computers" aria-label={t("taskManager.queue.computers")}>
          <GroupHeading title={t("taskManager.queue.computers")} count={computers.length} />
          <ul className="tm-computers__list ac-card">
            {computers.map((c) => (
              <li key={c.id} className="tm-computer">
                <span className="tm-computer__icon" aria-hidden="true">
                  <Icon name="computer" size={18} />
                </span>
                <span className="tm-computer__text">
                  <b>{c.name}</b>
                  <small>{computerText(c)}</small>
                </span>
                {(c.inLine > 0 || c.working > 0) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t("queue.see")}: ${c.name}`}
                    onClick={() => setQueueOf(c.id)}
                  >
                    {t("queue.see")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.data && all.length === 0 && !hidden?.total && (
        <EmptyState size="page" agent={look} mood="deal" title={t("taskManager.empty.title")}>
          {t("taskManager.empty.body")}
        </EmptyState>
      )}
      {hidden?.total ? <p className="tm-none">{t("taskManager.hiddenLine", { count: hidden.total })}</p> : null}

      {view.data && all.length > 0 && (
        <section className="tm-now" aria-label={heading}>
          <div className="tm-tools">
            <h2>{heading}</h2>
            <span className="tm-tools__acts">
              <Button
                size="sm"
                variant="ghost"
                icon="list"
                disabled={!selTask}
                onClick={() => selTask && setPanel(selTask.runId)}
              >
                {t("taskManager.actions.steps")}
              </Button>
              {stopTool}
            </span>
          </div>
          {shown.length === 0 ? (
            <EmptyState size="panel" actions={<Button onClick={() => setQ("")}>{t("filters.clearSearch")}</Button>}>
              {t("taskManager.noResults")}
            </EmptyState>
          ) : card ? (
            <TaskTable>
              {tasksOf(shown, card).length > 0 ? (
                <>
                  <TaskWaitLines tasks={tasksOf(shown, card)} />
                  <ul className="tm-list">{tasksOf(shown, card).map((task) => row(task, "agent"))}</ul>
                </>
              ) : (
                <p className="tm-none">{agentCardLine(t, 0, hiddenCount(hidden, card))}</p>
              )}
            </TaskTable>
          ) : (
            <TaskTable>
              {grouped.groups.length > 0 && (
                <TaskSection
                  title={t("taskManager.sections.asked")}
                  count={grouped.groups.reduce((n, g) => n + g.tasks.length, 0)}
                  tasks={grouped.groups.flatMap((g) => g.tasks)}
                >
                  {grouped.groups.map((g) => (
                    <Fragment key={g.agentId}>
                      <AgentRow
                        group={g}
                        name={nameOf(g.agentId)}
                        now={now}
                        open={isOpen(g.agentId)}
                        onToggle={() => toggle(g.agentId)}
                        stopAll={
                          g.stoppable.length > 0 ? (
                            <StopAllConfirm
                              agentId={g.agentId}
                              runIds={g.stoppable}
                              helpers={g.helpers}
                              open={confirm === `row:${g.agentId}`}
                              onOpenChange={(open) => setConfirm(open ? `row:${g.agentId}` : null)}
                              onStop={(runIds, reason) => stop(runIds, reason, g.helpers > 0)}
                              trigger={stopSquare(t("taskManager.actions.stopAllOf", { name: nameOf(g.agentId) }))}
                            />
                          ) : null
                        }
                      />
                      {isOpen(g.agentId) && g.tasks.map((task) => row(task, "grouped"))}
                    </Fragment>
                  ))}
                </TaskSection>
              )}
              {grouped.delegated.length > 0 && (
                <TaskSection
                  title={t("taskManager.sections.delegated")}
                  count={grouped.delegated.reduce((n, g) => n + g.tasks.length, 0)}
                  tasks={grouped.delegated.flatMap((g) => g.tasks)}
                >
                  {grouped.delegated.map((g) => (
                    <Fragment key={g.agentId}>
                      <AgentRow
                        group={g}
                        name={nameOf(g.agentId)}
                        now={now}
                        open={isOpen(`by:${g.agentId}`)}
                        onToggle={() => toggle(`by:${g.agentId}`)}
                        stopAll={
                          g.stoppable.length > 0 ? (
                            <StopAllConfirm
                              agentId={g.agentId}
                              runIds={g.stoppable}
                              open={confirm === `by:${g.agentId}`}
                              onOpenChange={(open) => setConfirm(open ? `by:${g.agentId}` : null)}
                              onStop={(runIds, reason) => stop(runIds, reason, true)}
                              trigger={stopSquare(t("taskManager.actions.stopAllOf", { name: nameOf(g.agentId) }))}
                            />
                          ) : null
                        }
                      />
                      {isOpen(`by:${g.agentId}`) && g.tasks.map((task) => row(task, "flat"))}
                    </Fragment>
                  ))}
                </TaskSection>
              )}
              {grouped.background.length > 0 && (
                <TaskSection
                  title={t("taskManager.sections.background")}
                  count={grouped.background.length}
                  tasks={grouped.background}
                >
                  {grouped.background.map((task) => row(task, "flat"))}
                </TaskSection>
              )}
            </TaskTable>
          )}
        </section>
      )}

      {view.data && (
        <section className="tm-ended" aria-label={t("taskManager.ended.title")}>
          <button type="button" className="tm-more" aria-expanded={endedOpen} onClick={() => setEndedOpen((o) => !o)}>
            <Icon name="chevronRight" size={16} className="tm-more__chevron" />
            {t("taskManager.ended.title")}
            <CountChip size="sm">{ended.length}</CountChip>
          </button>
          {endedOpen &&
            (ended.length > 0 ? (
              <ul className="tm-list tm-list--ended ac-card">
                {ended.map((e) => (
                  <EndedRow
                    key={e.runId}
                    task={e}
                    agentName={nameOf(e.agentId)}
                    meId={me.user.id}
                    selected={panel === e.runId}
                    onOpen={() => setPanel(e.runId)}
                  />
                ))}
              </ul>
            ) : (
              <p className="tm-none">{t("taskManager.ended.none")}</p>
            ))}
        </section>
      )}

      {/* Hung from the shell, like a thread's panel beside its channel: inside the page it would scroll away with the
          list (the page's entrance animation keeps the page a containing block). */}
      {panel &&
        createPortal(
          <TaskPanel
            key={panel}
            runId={panel}
            task={all.find((task) => task.runId === panel)}
            ended={view.data?.ended.find((e) => e.runId === panel)}
            stopping={stopping.has(panel)}
            said={said.get(panel)}
            now={now}
            onStop={() => stop([panel], undefined, Boolean(all.find((task) => task.runId === panel)?.helpers))}
            onClose={() => {
              setPanel(null);
              onTaskClosed?.();
            }}
          />,
          document.querySelector(".shell") ?? document.body,
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
    </div>
  );
}

/** The table: the columns' names (for the eye; each cell says what it is), then its sections. */
function TaskTable({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="tm-table ac-card">
      <div className="tm-row tm-row--head" aria-hidden="true">
        <span>{t("taskManager.columns.task")}</span>
        <span>{t("taskManager.columns.state")}</span>
        <span>{t("taskManager.columns.using")}</span>
        <span className="tm-cell--time">{t("taskManager.columns.time")}</span>
      </div>
      {children}
    </div>
  );
}

/** "Pedidas por pessoas 6", "Rotinas em segundo plano 2": a section of the table, what its rows wait on over them. */
function TaskSection({
  title,
  count,
  tasks,
  children,
}: {
  title: string;
  count: number;
  tasks: ManagedTask[];
  children: ReactNode;
}) {
  return (
    <section className="tm-section" aria-label={title}>
      <h3 className="tm-sec">
        {title}
        <span className="tm-sec__count">{count}</span>
      </h3>
      <TaskWaitLines tasks={tasks} />
      <ul className="tm-list">{children}</ul>
    </section>
  );
}

/**
 * One task: what it is (the whole row picks it), its state, what it uses now, its time (shaded as it grows, but not on
 * a wait with a known reason: that isn't stuck) and Parar. `grouped` sits under its agent's row; `flat` (a routine's
 * background run) shows its agent's face; `agent` is the list of one agent's tasks (its card chosen).
 */
function TaskRow({
  task,
  now,
  look,
  meId,
  agentName,
  chain,
  stopAll,
  selected,
  stopping,
  onSelect,
  onSteps,
  onStop,
}: {
  task: ManagedTask;
  now: number;
  look: "grouped" | "flat" | "agent";
  meId: string;
  agentName: string;
  /** Who asked it among agents, and what started the chain. */
  chain: string | null;
  /** A task that asked other agents stops with them: this stop, in place of its own. */
  stopAll: ReactNode;
  selected: boolean;
  stopping: boolean;
  onSelect: () => void;
  /** "Ver passos": its panel. */
  onSteps: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const title = taskTitle(t, task);
  const where = taskPlace(t, task);
  const asked = task.requester
    ? task.requester.userId === meId
      ? t("taskManager.askedByYou")
      : t("taskManager.askedBy", { name: task.requester.name })
    : null;
  const helpers = task.helpers ? t("taskManager.helpers", { count: task.helpers }) : null;
  const sub = [
    look === "flat"
      ? [agentName, chain ?? where].filter(Boolean).join(" · ")
      : taskSub(t, task, [where, task.background ? null : (chain ?? asked)].filter(Boolean).join(" · ")),
    helpers,
  ]
    .filter(Boolean)
    .join(" · ");
  // A routine's run shows its agent's face (its section has no agent rows); a person's task, its state's mark.
  const face = (
    <OpensAgent agentId={task.agentId}>
      <AgentAvatar agentId={task.agentId} name={agentName} size="xs" />
    </OpensAgent>
  );
  return (
    <li className="tm-row" data-look={look} data-selected={selected || undefined}>
      <span className="tm-cell tm-cell--name">
        {look === "flat" ? face : <TaskMark task={task} />}
        <span className="tm-name">
          <button type="button" className="tm-hit" aria-pressed={selected} onClick={onSelect}>
            {title}
          </button>
          <small>{sub}</small>
        </span>
      </span>
      <span className="tm-cell tm-cell--state">
        <TaskStateChip task={task} stopping={stopping} />
      </span>
      <span className="tm-cell tm-cell--use">
        <UsingNow task={task} />
      </span>
      <TaskTime task={task} now={now} />
      <span className="tm-cell tm-cell--act">
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="list"
          aria-label={`${t("taskManager.actions.steps")}: ${title}`}
          title={t("taskManager.actions.steps")}
          onClick={onSteps}
        />
        {task.canStop &&
          (stopAll ?? (
            <StopTaskButton
              label={t("taskManager.actions.stop")}
              title={title}
              stopping={stopping}
              onClick={onStop}
              compact
            />
          ))}
      </span>
    </li>
  );
}

/** "Tempo": the task's time (`taskTime`), warming as its work goes on; a wait never warms, it isn't stuck. */
function TaskTime({ task, now }: { task: ManagedTask; now: number }) {
  const { t } = useTranslation();
  return (
    <span
      className="tm-cell tm-cell--time ac-num"
      style={{ "--h": taskState(task) === "waiting" ? 0 : heatOf(taskAge(task, now)) } as CSSProperties}
    >
      {taskTime(t, task, now)}
    </span>
  );
}

/**
 * An agent's row over its tasks, folded until opened (the whole row opens it): its face and count, how it stands,
 * the apps it uses now, the time of the task its state is about (`groupLead`), and its stop for all of them.
 */
function AgentRow({
  group,
  name,
  now,
  open,
  onToggle,
  stopAll,
}: {
  group: AgentTasks;
  name: string;
  now: number;
  open: boolean;
  onToggle: () => void;
  stopAll: ReactNode;
}) {
  const { t } = useTranslation();
  // Waiting beats queued, working beats both (someone waits on it while it works on something else).
  const working = group.tasks.find((task) => taskState(task) === "working");
  const held = group.tasks.find((task) => taskState(task) === "waiting");
  const state = working ? (
    <TaskStateChip task={working} />
  ) : group.waiting > 0 ? (
    <Chip tone="waiting" lead={<WaitMark />}>
      {t("taskManager.waiting", { count: group.waiting })}
    </Chip>
  ) : held ? (
    <TaskStateChip task={held} />
  ) : (
    <Chip icon="clock">{t("taskManager.state.queued")}</Chip>
  );
  return (
    <li className="tm-row tm-row--agent" data-open={open || undefined}>
      <span className="tm-cell tm-cell--name">
        <span className="tm-who">
          <span className="tm-twist" aria-hidden="true">
            <Icon name="chevronDown" size={14} />
          </span>
          <OpensAgent agentId={group.agentId}>
            <AgentAvatar agentId={group.agentId} name={name} size="xs" />
          </OpensAgent>
          <span className="tm-name">
            <button
              type="button"
              className="tm-hit"
              aria-expanded={open}
              aria-label={t("taskManager.toggleAgent", { name })}
              onClick={onToggle}
            >
              {name}
            </button>
          </span>
          <CountChip size="sm" aria-label={t("taskManager.tasks", { count: group.tasks.length })}>
            {group.tasks.length}
          </CountChip>
        </span>
      </span>
      <span className="tm-cell tm-cell--state">{state}</span>
      <span className="tm-cell tm-cell--use">
        <ProgramStack tasks={group.tasks} />
      </span>
      <TaskTime task={groupLead(group)} now={now} />
      <span className="tm-cell tm-cell--act">{stopAll}</span>
    </li>
  );
}

/** One agent on a card: its face, name and tasks, who waits on it, and its last half hour edge to edge. */
function AgentCard({
  agentId,
  name,
  tasks,
  hidden,
  line,
  color,
  lineLabel,
  pressed,
  onPress,
}: {
  /** Null: "Todos", every task. */
  agentId: string | null;
  name: string;
  tasks: ManagedTask[];
  /** Its tasks the viewer may not see. */
  hidden: number;
  line: number[];
  color: AgentColor;
  lineLabel: string;
  pressed: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { waiting } = agentSummary(tasks);
  return (
    <div className="tm-card ac-card ac-card--interactive" data-pressed={pressed || undefined}>
      <span className="tm-card__head">
        {agentId ? (
          <OpensAgent agentId={agentId}>
            <AgentAvatar agentId={agentId} name={name} size="sm" />
          </OpensAgent>
        ) : (
          <span className="tm-card__n ac-num" aria-hidden="true">
            {tasks.length + hidden}
          </span>
        )}
        <button
          type="button"
          className="tm-card__text"
          aria-pressed={pressed}
          title={waiting > 0 ? t("taskManager.waiting", { count: waiting }) : undefined}
          onClick={onPress}
        >
          <b>{name}</b>
          <small>{agentCardLine(t, tasks.length, hidden)}</small>
        </button>
        {waiting > 0 && (
          <Chip
            tone="waiting"
            lead={<WaitMark />}
            className="tm-card__wait"
            aria-label={t("taskManager.waiting", { count: waiting })}
          >
            {waiting}
          </Chip>
        )}
      </span>
      <Sparkline values={line} color={color} label={lineLabel} />
    </div>
  );
}

const ENDED_ICON: Record<"done" | "stopped" | "failed", IconName> = {
  done: "check",
  stopped: "stop",
  failed: "alert",
};

/**
 * What ended today: the task, its agent and where, how it ended (and who stopped it), how long it took. The row opens
 * its panel, as a task still on does: its steps and "Abrir na conversa".
 */
function EndedRow({
  task,
  agentName,
  meId,
  selected,
  onOpen,
}: {
  task: EndedTask;
  agentName: string;
  meId: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const state = endedState(task);
  const word =
    state === "stopped"
      ? task.stoppedBy && task.stoppedBy.userId !== meId
        ? t("taskManager.ended.stoppedBy", { name: task.stoppedBy.name })
        : t("taskManager.ended.stopped")
      : t(state === "done" ? "taskManager.ended.done" : "taskManager.ended.failed");
  const took = Date.parse(task.finishedAt) - Date.parse(task.startedAt ?? task.finishedAt);
  return (
    <li className="tm-row tm-row--ended" data-selected={selected || undefined}>
      <span className="tm-cell tm-cell--name">
        <OpensAgent agentId={task.agentId}>
          <AgentAvatar agentId={task.agentId} name={agentName} size="xs" />
        </OpensAgent>
        <span className="tm-name">
          <button type="button" className="tm-hit" aria-pressed={selected} onClick={onOpen}>
            {taskTitle(t, task)}
          </button>
          <small>{[agentName, taskPlace(t, task)].filter(Boolean).join(" · ")}</small>
        </span>
      </span>
      <span className="tm-cell tm-cell--state">
        <Chip icon={ENDED_ICON[state]}>{word}</Chip>
      </span>
      <span className="tm-cell tm-cell--time ac-num">{formatDuration(t, Math.max(0, took))}</span>
    </li>
  );
}
