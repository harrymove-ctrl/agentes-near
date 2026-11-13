import type { ComputerSummary, EndedTask, ManagedTask } from "@agenteschat/client";
import {
  type AgentTasks,
  delegationText,
  endedState,
  taskState,
  tasksOf,
  taskWaitWords,
  taskWhere,
  waitsFor,
  waitsOnPerson,
} from "@agenteschat/client/lib/task-manager";
import type { TFunction } from "i18next";

/**
 * What the phone's task manager says (ADR 0128): its list, a task's screen, an agent's tasks screen and the count in
 * its DM's header, from the shared model (`@agenteschat/client/lib/task-manager`).
 */

/** A conversation: a channel's (or a DM's) main timeline, or one of its threads. */
export interface Place {
  channelId: string;
  threadId: string | null;
}

/** A task asked in this conversation: its main timeline, or this thread. */
export const isHere = (task: Pick<ManagedTask, "channelId" | "threadId">, place: Place) =>
  task.channelId === place.channelId && (task.threadId ?? null) === place.threadId;

/** `held`: it waits on no person but on its computer (full or away), its plan's limit or the budget (`held`). */
export type RowState = "working" | "ok" | "answer" | "queued" | "stopping" | HeldState;
export type HeldState = "computerBusy" | "computerOffline" | "plan" | "budget";

const HELD: Record<NonNullable<ManagedTask["held"]>, HeldState> = {
  computer_busy: "computerBusy",
  computer_offline: "computerOffline",
  plan: "plan",
  budget: "budget",
};

/** A task's state on its row: one asked to stop here says so until it leaves the list. */
export function rowState(
  task: Pick<ManagedTask, "runId" | "status" | "held">,
  stopping: ReadonlySet<string>,
): RowState {
  if (stopping.has(task.runId)) return "stopping";
  const state = taskState(task);
  if (state !== "waiting") return state;
  const wait = waitsFor(task);
  if (wait === "ok" || wait === "answer" || wait === null) return wait ?? "answer";
  return HELD[wait];
}

/** It waits on no person (a computer, a plan, a budget): grey, not "espera você". */
export const isHeld = (state: RowState): state is HeldState =>
  state === "computerBusy" || state === "computerOffline" || state === "plan" || state === "budget";

/**
 * A task's state on its row: a wait says what holds it and what comes next ("Pausada: plano a 95% da semana", "Volta
 * sáb às 18:00"; "Na fila · 2º", "começa em ~3 min").
 */
export function taskStateWords(
  t: TFunction,
  locale: string,
  task: Pick<ManagedTask, "status" | "held" | "line" | "wait">,
  state: RowState,
  now: number,
): { state: string; next: string | null } {
  if (state === "working") return { state: t("taskManager.state.working"), next: null };
  if (state === "queued") return { state: t("taskManager.state.queued"), next: null };
  if (state === "stopping") return { state: t("taskManager.state.stopping"), next: null };
  return taskWaitWords(t, locale, task, now) ?? { state: t("taskManager.state.answer"), next: null };
}

/** A computer on the task manager: "Cheio · 2 na fila · 3 trabalhando", "Tem espaço · 1 trabalhando". */
export function computerLine(t: TFunction, computer: Pick<ComputerSummary, "working" | "inLine">): string {
  const room =
    computer.inLine > 0 ? t("taskManager.queue.full", { count: computer.inLine }) : t("taskManager.queue.room");
  return computer.working > 0 ? `${room} · ${t("taskManager.working", { count: computer.working })}` : room;
}

/**
 * An agent's row: "1 trabalhando · 1 espera você"; with nothing of that, `held`, what holds its tasks ("Pausada: plano
 * a 95% da semana"), or "Na fila" while they only wait their turn.
 */
export function groupLine(t: TFunction, group: Pick<AgentTasks, "working" | "waiting">, held?: string | null) {
  const parts = [
    group.working > 0 ? t("taskManager.working", { count: group.working }) : null,
    group.waiting > 0 ? t("taskManager.waiting", { count: group.waiting }) : null,
  ].filter((p): p is string => Boolean(p));
  const mark: "working" | "waiting" | "queued" =
    group.working > 0 ? "working" : group.waiting > 0 ? "waiting" : "queued";
  return { mark, text: parts.length > 0 ? parts.join(" · ") : (held ?? t("taskManager.state.queued")) };
}

/**
 * Under a task's title: where it is, who asked and how far its plan got ("#produto · Ana pediu · 9 de 14 feitos"); a
 * task agents asked of each other says who asked and what started it, and one with helpers how many. Where is left out
 * when it already is the title (a task with no label of its own).
 */
export function taskSubline(
  t: TFunction,
  task: Pick<
    ManagedTask,
    | "routine"
    | "channelKind"
    | "channelName"
    | "betweenAgents"
    | "background"
    | "requester"
    | "plan"
    | "delegation"
    | "helpers"
  >,
  meId: string | null,
  title: string,
  agentName: (id: string) => string | undefined = () => undefined,
): string {
  const where = taskWhere(t, task);
  const asked = task.requester
    ? task.requester.userId === meId
      ? t("taskManager.askedByYou")
      : t("taskManager.askedBy", { name: task.requester.name })
    : null;
  const plan = task.plan && task.plan.total > 0 ? t("taskManager.plan", task.plan) : null;
  const chain = delegationText(t, task, agentName, meId);
  const helpers = task.helpers ? t("taskManager.helpers", { count: task.helpers }) : null;
  return [where === title ? null : where, chain ?? asked, plan, helpers].filter(Boolean).join(" · ");
}

/** How a task ended, for "Terminadas hoje": done, stopped (by you, by someone), or couldn't finish. */
export function endedText(t: TFunction, task: Pick<EndedTask, "status" | "stoppedBy">, meId: string | null): string {
  const state = endedState(task);
  if (state === "done") return t("taskManager.ended.done");
  if (state === "failed") return t("taskManager.ended.failed");
  if (!task.stoppedBy) return t("taskManager.state.stopped");
  return task.stoppedBy.userId === meId
    ? t("taskManager.ended.stopped")
    : t("taskManager.ended.stoppedBy", { name: task.stoppedBy.name });
}

/** "Terminadas hoje", the latest first. */
export const endedLatestFirst = (ended: readonly EndedTask[]) =>
  [...ended].sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));

/** One agent's tasks now: its DM header's count and its tasks screen (ADR 0128). */
export interface AgentTaskView {
  /** People's first, then its routines', oldest first; `here`: asked in the conversation it was opened from. */
  rows: { task: ManagedTask; here: boolean }[];
  /** How many work now. */
  working: number;
  /** How many wait on a person. */
  waiting: number;
  /** "Parar todas": every task one may stop that isn't stopping yet. */
  stoppable: string[];
}

/** An agent's tasks, or null while it has none; `here` tags the ones asked in that conversation. */
export function agentTasksOf(
  tasks: readonly ManagedTask[],
  agentId: string,
  here: Place | null,
  stopping: ReadonlySet<string>,
): AgentTaskView | null {
  const mine = tasksOf([...tasks], agentId);
  if (mine.length === 0) return null;
  return {
    rows: mine.map((task) => ({ task, here: here !== null && isHere(task, here) })),
    working: mine.filter((task) => taskState(task) === "working").length,
    waiting: mine.filter((task) => waitsOnPerson(task)).length,
    stoppable: mine.filter((task) => task.canStop && !stopping.has(task.runId)).map((task) => task.runId),
  };
}

/** "Feitas hoje" on an agent's tasks screen: what it finished today (stopped and failed ones aren't done). */
export const doneTodayOf = (ended: readonly EndedTask[], agentId: string) =>
  ended.filter((e) => e.agentId === agentId && endedState(e) === "done").length;

/** An agent's tasks screen, opened from a conversation (its tasks there are tagged "aqui"). */
export function agentTasksHref(agentId: string, from: Place | null) {
  if (!from) return `/agent-tasks/${agentId}` as const;
  const thread = from.threadId ? `&thread=${from.threadId}` : "";
  return `/agent-tasks/${agentId}?channel=${from.channelId}${thread}` as const;
}

/**
 * What an agent's DM header shows of its tasks: how many there are, and how many wait on you when some also work; its
 * mark is the orbit while some work, else the waiting mark (or queued). `room` is its width in the bar's buttons (44
 * points each), which the conversation's title gives up.
 */
export function tasksBadge(view: Pick<AgentTaskView, "rows" | "working" | "waiting">) {
  const both = view.working > 0 && view.waiting > 0;
  const mark: RowState = view.working > 0 ? "working" : view.waiting > 0 ? "ok" : "queued";
  return { count: view.rows.length, mark, waiting: both ? view.waiting : null, room: both ? 1.9 : 1.3 };
}
