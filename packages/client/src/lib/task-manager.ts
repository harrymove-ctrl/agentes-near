import type { TFunction } from "i18next";
import type { EndedTask, HiddenTasks, ManagedTask, TaskNow, TaskWait } from "../api/types";
import { type Activity, toolActivity } from "./activity";
import { durationText, etaMinutes } from "./computer-queue";
import { usageWhenShort } from "./plan-usage";
import { usageWindowText } from "./usage-pause";

/**
 * The task manager, the same on every app (ADR 0128): the web's page, the phone's list and the chat's strip read
 * these. Tasks are grouped by agent; a routine's background run goes to its own section; what a task uses now comes
 * from its latest tool call, the way the chat's live chip says it.
 */

export type TaskState = "working" | "waiting" | "queued";

/** Working, waiting on a person (an ok, an answer), or not started yet. */
export const taskState = (t: Pick<ManagedTask, "status">): TaskState =>
  t.status === "running" ? "working" : t.status === "queued" ? "queued" : "waiting";

/**
 * What the waiting is for: your ok (an approval), an answer, or no person: its computer (full or away), its plan's
 * limit, the budget (`held`).
 */
export type WaitReason = "ok" | "answer" | "computer_busy" | "computer_offline" | "plan" | "budget";

export const waitsFor = (t: Pick<ManagedTask, "status" | "held">): WaitReason | null =>
  t.status === "waiting_approval" ? "ok" : t.status === "waiting_input" ? (t.held ?? "answer") : null;

/** A wait on a person (your ok, an answer): "espera você". The others wait on a computer, a plan or a budget. */
export const waitsOnPerson = (t: Pick<ManagedTask, "status" | "held">) => {
  const w = waitsFor(t);
  return w === "ok" || w === "answer";
};

/**
 * A task waiting for room on its computer, with its place in the line ("Na fila · 2º"); null for any other state.
 * People's turns go first, then the longest wait (ADR 0032 "Calm waits").
 */
export const linePlace = (t: Pick<ManagedTask, "held" | "line">) =>
  t.held === "computer_busy" && t.line ? t.line : null;

/** The words of a wait (`taskManager.state.*`). */
export const waitKey = (w: WaitReason) =>
  w === "ok"
    ? "taskManager.state.ok"
    : w === "answer"
      ? "taskManager.state.answer"
      : w === "computer_busy"
        ? "taskManager.state.computerBusy"
        : w === "computer_offline"
          ? "taskManager.state.computerOffline"
          : w === "plan"
            ? "taskManager.state.plan"
            : "taskManager.state.budget";

const say = (t: TFunction) => t as unknown as (key: string, o?: Record<string, unknown>) => string;

/** A sentence with a window that may have no words of its own: no gap where it was. */
const closeGap = (text: string) => text.replace(/\s+/g, " ").trim();

/** When a limit gives way: its reset in the reader's zone, "quando renovar" unknown, "em instantes" once past it. */
function backWhen(t: TFunction, locale: string, resetsAt: string | null, now: number) {
  if (!resetsAt) return say(t)("taskManager.wait.whenRenews");
  if (Date.parse(resetsAt) <= now) return say(t)("taskManager.wait.whenSoon");
  return usageWhenShort(t, locale, resetsAt, new Date(now));
}

/** A computer's waits that mean it's off; any other (signed out, paused, a program to update, none set) isn't "desligado". */
const COMPUTER_GONE = new Set(["machine_offline", "machine_dropped"]);

/**
 * What a waiting task says on its row, whole: what holds it and why ("Pausada: plano a 95% da semana"), and what comes
 * next ("Volta sáb às 18:00"). Null when it isn't waiting.
 */
export function taskWaitWords(
  t: TFunction,
  locale: string,
  task: Pick<ManagedTask, "status" | "held" | "line" | "wait">,
  now = Date.now(),
): { state: string; next: string | null } | null {
  const reason = waitsFor(task);
  if (!reason) return null;
  const s = say(t);
  const w = task.wait ?? null;
  const back = () => s("taskManager.wait.back", { when: backWhen(t, locale, w?.resetsAt ?? null, now) });
  const paused = w?.code === "usage_pause" && w.percent !== null;
  switch (reason) {
    case "ok":
      return { state: s(waitKey(reason)), next: s("taskManager.wait.okNext") };
    case "answer":
      return { state: s(waitKey(reason)), next: s("taskManager.wait.answerNext") };
    case "computer_busy": {
      const place = linePlace(task);
      return {
        state: place ? s("taskManager.state.inLine", { position: place.position }) : s(waitKey(reason)),
        next: place?.estimatedStartAt
          ? s("queue.startsIn", { n: etaMinutes(place.estimatedStartAt, now) })
          : s("taskManager.wait.computerBusyNext"),
      };
    }
    case "computer_offline":
      if (w?.code === "work_queue")
        return { state: s("taskManager.wait.workLine"), next: s("taskManager.wait.workLineNext") };
      if (w && !COMPUTER_GONE.has(w.code))
        return { state: s("taskManager.wait.computerWait"), next: s("taskManager.wait.computerWaitNext") };
      return { state: s(waitKey(reason)), next: s("taskManager.wait.computerOfflineNext") };
    case "budget": {
      if (!paused && w?.code !== "budget") return { state: s(waitKey(reason)), next: null };
      // With no reset it's other runs' reservations filling the budget, not the month: a moment, not a renewal.
      const next = w?.resetsAt ? back() : s("taskManager.wait.back", { when: s("taskManager.wait.whenSoon") });
      if (paused) return { state: s("taskManager.wait.pausedBudget", { percent: w.percent }), next };
      return { state: s(w?.resetsAt ? "taskManager.wait.budgetOut" : waitKey(reason)), next };
    }
    case "plan":
      if (paused) {
        const window = w.window ? usageWindowText(t, w.window) : "";
        return { state: closeGap(s("taskManager.wait.pausedPlan", { percent: w.percent, window })), next: back() };
      }
      if (w?.scope === "region")
        return {
          state: s("taskManager.wait.modelRegion", { model: w.model ?? "" }),
          next: s("taskManager.wait.modelRegionNext"),
        };
      if (w?.scope === "inactive")
        return { state: s("taskManager.wait.planInactive"), next: s("taskManager.wait.planInactiveNext") };
      if (w?.scope === "off")
        return {
          state: s("taskManager.wait.modelOff", { model: w.model ?? "" }),
          next: s("taskManager.wait.modelOffNext"),
        };
      if (w?.scope === "model")
        return { state: s("taskManager.wait.modelLimit", { model: w.model ?? "" }), next: back() };
      if (w?.code === "plan_limit")
        return { state: s("taskManager.wait.planLimit", { plan: w.plan ?? "" }), next: back() };
      return { state: s(waitKey(reason)), next: null };
  }
}

/** Tasks waiting on the same limit: the line over them says it once, with Continuar agora for a pause. */
export interface TaskWaitGroup {
  key: string;
  tasks: ManagedTask[];
  /** The first task's wait, at the furthest any of them got. */
  wait: TaskWait;
  /** The ones the viewer may press Continuar agora on. */
  continuable: string[];
}

const USAGE_LIMITS = new Set(["plan_limit", "budget"]);

/**
 * What makes two waits the same limit; null for a wait whose rows say it all (a computer, a person, a region, a budget
 * only reservations fill for a moment).
 */
function limitKey({ held, wait: w }: ManagedTask) {
  if (
    !w?.key ||
    w.scope === "region" ||
    w.scope === "off" ||
    w.scope === "inactive" ||
    (held === "budget" && !w.resetsAt)
  )
    return null;
  const near = w.code === "usage_pause" && w.percent !== null;
  return near || USAGE_LIMITS.has(w.code) ? `${w.code}:${w.key}:${w.model ?? ""}:${w.window ?? ""}` : null;
}

/** The groups among `tasks`: two or more waiting on the same limit, in order of first appearance. */
export function taskWaitGroups(tasks: ManagedTask[]): TaskWaitGroup[] {
  const byLimit = new Map<string, ManagedTask[]>();
  for (const task of tasks) {
    const key = taskState(task) === "waiting" ? limitKey(task) : null;
    if (key) byLimit.set(key, [...(byLimit.get(key) ?? []), task]);
  }
  return [...byLimit]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => {
      const waits = list.map((task) => task.wait as TaskWait);
      const percents = waits.flatMap((w) => (w.percent === null ? [] : [w.percent]));
      return {
        key,
        tasks: list,
        wait: { ...(waits[0] as TaskWait), percent: percents.length ? Math.max(...percents) : null },
        continuable: list.filter((task) => task.wait?.canContinue).map((task) => task.runId),
      };
    });
}

/** The line over a group: "9 rotinas pausadas: o plano do Claude está em 95% da semana e volta sáb às 18:00. …". */
export function taskWaitGroupText(t: TFunction, locale: string, group: TaskWaitGroup, now = Date.now()) {
  const s = say(t);
  const { wait: w, tasks } = group;
  const count = tasks.length;
  const what = s(tasks.every((task) => task.background) ? "taskManager.waitGroup.routines" : "taskManager.tasks", {
    count,
  });
  const values = { what, plan: w.plan ?? "", model: w.model ?? "", percent: w.percent };
  const when = backWhen(t, locale, w.resetsAt, now);
  if (w.code === "usage_pause" && tasks[0]?.held === "budget")
    return s("taskManager.waitGroup.pausedBudget", { ...values, when });
  if (w.code === "usage_pause") {
    const window = w.window ? usageWindowText(t, w.window) : "";
    return closeGap(s("taskManager.waitGroup.pausedPlan", { ...values, when, window }));
  }
  if (w.code === "budget") return s("taskManager.waitGroup.budgetOut", { ...values, when });
  if (w.scope === "model") return s("taskManager.waitGroup.modelLimit", { ...values, when });
  return s("taskManager.waitGroup.planLimit", { ...values, when });
}

/** Since when it counts (a long work's start, else the run's), in ms. */
export const taskSince = (t: Pick<ManagedTask, "startedAt" | "createdAt">) => Date.parse(t.startedAt ?? t.createdAt);

/** "6:12", "1:02:10": the clock of a task, like a process's time. */
export function taskClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * A task's "Tempo": its clock while it works or waits its turn ("6:12", "1:02:10"); waiting, how long it has waited
 * as people say it ("25 min", "3 h", "3 dias"), since its pause began when the server knows that, else since it
 * started. A wait of days as a clock ("82:07:59") reads as nothing.
 */
export function taskTime(
  t: TFunction,
  task: Pick<ManagedTask, "status" | "startedAt" | "createdAt" | "wait">,
  now: number,
): string {
  if (taskState(task) !== "waiting") return taskClock(now - taskSince(task));
  const since = task.wait?.since ? Date.parse(task.wait.since) : taskSince(task);
  return durationText(t, Math.max(0, now - since));
}

/**
 * What a task uses right now ("Usando agora"):
 * - `brain`: a computer brain's turn (Claude Code, Codex, Cursor); `inner` is what it called last through us, if any;
 * - `browser`, `screen`: the agent's own browser or desktop;
 * - `terminal`: code or a command on its computer;
 * - `app`: a connector, a mailbox, a database (`activity.service` names its logo, `activity.app` its name);
 * - `agentes`: one of our own tools (an issue, the Drive, memory…);
 * - `none`: nothing yet (queued, or only thinking).
 */
export type TaskProgram =
  | { kind: "brain"; brain: "claude_code" | "codex" | "cursor"; inner: TaskProgram | null; detail: string | null }
  | { kind: "browser" | "screen" | "terminal" | "agentes"; activity: Activity; detail: string | null }
  | { kind: "app"; activity: Activity; detail: string | null }
  | { kind: "none" };

const COMPUTER_BRAINS = new Set(["claude_code", "codex", "cursor"]);

function programOf(now: TaskNow | null): TaskProgram | null {
  if (!now) return null;
  const activity = toolActivity(now.tool, now.connector, now.detail, now);
  const detail = now.detail;
  switch (activity.kind) {
    case "browsing":
      return { kind: "browser", activity, detail };
    case "usingScreen":
      return { kind: "screen", activity, detail };
    case "runningCode":
    case "runningCommand":
    case "runningCommandAny":
    case "runningSkillScript":
    case "runningSkillScriptAny":
    case "cloningRepo":
    case "pcFiles":
      return { kind: "terminal", activity, detail };
    case "consulting":
    case "queryingDatabase":
      return { kind: "app", activity, detail };
    default:
      return activity.service ? { kind: "app", activity, detail } : { kind: "agentes", activity, detail };
  }
}

export function taskProgram(t: Pick<ManagedTask, "brain" | "now" | "status">): TaskProgram {
  if (t.status === "queued") return { kind: "none" };
  const inner = programOf(t.now);
  if (t.brain && COMPUTER_BRAINS.has(t.brain)) {
    const brain = t.brain as "claude_code" | "codex" | "cursor";
    return { kind: "brain", brain, inner, detail: t.now?.detail ?? null };
  }
  return inner ?? { kind: "none" };
}

/** A stable key for a program, to show each app once on an agent's row (`claude_code`, `browser`, `app:github`). */
export function programKey(p: TaskProgram): string | null {
  switch (p.kind) {
    case "none":
      return null;
    case "brain":
      return p.brain;
    case "app":
      return `app:${p.activity.service ?? p.activity.app ?? ""}`;
    default:
      return p.kind;
  }
}

/** What a task is about, for its row: its label, else where it is ("Conversa com Ana", "#produto"). */
export function taskTitle(
  t: TFunction,
  task: Pick<ManagedTask, "label" | "routine" | "channelKind" | "channelName" | "betweenAgents">,
) {
  if (task.label?.trim()) return task.label.trim();
  if (task.routine?.name) return task.routine.name;
  return taskWhere(t, task);
}

/** Where it is: "#produto", "Conversa direta", "Conversa entre agentes", "Rotina «Backups»". */
export function taskWhere(
  t: TFunction,
  task: Pick<ManagedTask, "routine" | "channelKind" | "channelName" | "betweenAgents"> & { background?: boolean },
) {
  if (task.background) {
    return task.routine?.name
      ? t("taskManager.where.routine", { name: task.routine.name })
      : t("taskManager.where.background");
  }
  if (task.betweenAgents) return t("chat.consultPanel.whereDm");
  if (task.channelKind === "dm") return t("taskManager.where.dm");
  return `#${task.channelName ?? ""}`;
}

/** Where it is, unless its title already says it (a task with no title of its own is called by its place). */
export function taskPlace(
  t: TFunction,
  task: Pick<ManagedTask, "label" | "routine" | "channelKind" | "channelName" | "betweenAgents"> & {
    background?: boolean;
  },
) {
  const where = taskWhere(t, task);
  return where === taskTitle(t, task) ? null : where;
}

export interface AgentTasks {
  agentId: string;
  tasks: ManagedTask[];
  working: number;
  waiting: number;
  /** Tasks it can stop now (not already stopping on this screen). */
  stoppable: string[];
  /** What those asked of other agents, still on: it stops with them. */
  helpers: number;
}

/**
 * The task an agent's row speaks for, its time beside its state: the one at work, else one waiting on a person, else
 * one held, else the oldest.
 */
export const groupLead = (g: Pick<AgentTasks, "tasks">): ManagedTask =>
  g.tasks.find((t) => taskState(t) === "working") ??
  g.tasks.find((t) => waitsOnPerson(t)) ??
  g.tasks.find((t) => taskState(t) === "waiting") ??
  (g.tasks[0] as ManagedTask);

/** How many runs these tasks asked of other agents, still on. */
export const helpersOf = (tasks: readonly Pick<ManagedTask, "helpers">[]) =>
  tasks.reduce((n, t) => n + (t.helpers ?? 0), 0);

/** Tasks in groups by `keyOf`, oldest group first, each group oldest first. */
function tasksBy(tasks: ManagedTask[], keyOf: (task: ManagedTask) => string, stopping: ReadonlySet<string>) {
  const byAgent = new Map<string, ManagedTask[]>();
  for (const task of tasks) byAgent.set(keyOf(task), [...(byAgent.get(keyOf(task)) ?? []), task]);
  const groups: AgentTasks[] = [...byAgent].map(([agentId, list]) => {
    const sorted = [...list].sort((a, b) => taskSince(a) - taskSince(b));
    const stoppable = sorted.filter((t) => t.canStop && !stopping.has(t.runId));
    return {
      agentId,
      tasks: sorted,
      working: sorted.filter((t) => taskState(t) === "working").length,
      waiting: sorted.filter((t) => waitsOnPerson(t)).length,
      stoppable: stoppable.map((t) => t.runId),
      helpers: helpersOf(stoppable),
    };
  });
  return groups.sort((a, b) => taskSince(a.tasks[0] as ManagedTask) - taskSince(b.tasks[0] as ManagedTask));
}

/**
 * The task manager's sections: tasks people asked for, grouped by agent (agents with someone waiting on them or
 * working first, then by their oldest task), what agents asked of each other in private, grouped by the agent that
 * asked (`delegated`: a group's `agentId` is that agent), and the routines' background runs.
 */
export function groupTasks(tasks: ManagedTask[], stopping: ReadonlySet<string> = new Set()) {
  const delegatedTo = (t: ManagedTask) => !t.background && Boolean(t.delegation);
  return {
    groups: tasksBy(
      tasks.filter((t) => !t.background && !delegatedTo(t)),
      (t) => t.agentId,
      stopping,
    ),
    delegated: tasksBy(tasks.filter(delegatedTo), (t) => t.delegation?.agentId ?? "", stopping),
    background: tasks.filter((t) => t.background).sort((a, b) => taskSince(a) - taskSince(b)),
  };
}

/** Who asked it and what started the chain: "a pedido de Theo · começou com Ana", "… · começou na rotina Bugs". */
export function delegationText(
  t: TFunction,
  task: Pick<ManagedTask, "delegation">,
  agentName: (id: string) => string | undefined,
  meId: string | null,
) {
  const d = task.delegation;
  if (!d) return null;
  const name = agentName(d.agentId);
  const by = name ? t("queue.purpose.agent", { name }) : t("queue.purpose.someAgent");
  const { origin } = d;
  const from =
    origin.kind === "person"
      ? origin.userId === meId
        ? t("taskManager.delegated.fromYou")
        : t("taskManager.delegated.fromPerson", { name: origin.name })
      : origin.kind === "routine"
        ? t("taskManager.delegated.fromRoutine", { name: origin.name })
        : null;
  return from ? `${by} · ${from}` : by;
}

/** Its tasks the viewer may not see (`agentId` null: everyone's). */
export const hiddenCount = (hidden: HiddenTasks | undefined, agentId: string | null) =>
  (agentId ? hidden?.byAgent[agentId] : hidden?.total) ?? 0;

/** An agent's card line: its tasks, how many it has out of the viewer's sight, or free. */
export function agentCardLine(t: TFunction, shown: number, hidden: number) {
  if (shown > 0) return t("taskManager.tasks", { count: shown + hidden });
  return hidden > 0 ? t("taskManager.hiddenTasks", { count: hidden }) : t("taskManager.free");
}

/** An agent's tasks (its card, the chat's strip): people's first, then its routines', oldest first. */
export const tasksOf = (tasks: ManagedTask[], agentId: string) =>
  tasks
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => Number(a.background) - Number(b.background) || taskSince(a) - taskSince(b));

/** The cards' summary: how many tasks and how many wait on a person. */
export function agentSummary(tasks: ManagedTask[]) {
  return {
    tasks: tasks.length,
    working: tasks.filter((t) => taskState(t) === "working").length,
    waiting: tasks.filter((t) => waitsOnPerson(t)).length,
  };
}

/** The last `points` minutes of an agent's activity (zeros when it did nothing). */
export function activityLine(activity: Record<string, number[]>, agentId: string | null, points = 30): number[] {
  const lines = agentId ? [activity[agentId] ?? []] : Object.values(activity);
  const out = Array.from({ length: points }, () => 0);
  for (const line of lines) {
    const tail = line.slice(-points);
    const offset = points - tail.length;
    tail.forEach((n, i) => {
      out[offset + i] = (out[offset + i] ?? 0) + n;
    });
  }
  return out;
}

/** How a task ended, for "Terminadas hoje": done, stopped (by whom) or couldn't. */
export const endedState = (e: Pick<EndedTask, "status">): "done" | "stopped" | "failed" =>
  e.status === "done" ? "done" : e.status === "canceled" ? "stopped" : "failed";

/** Since when "Terminadas hoje" counts: the local midnight. */
export function todayStart(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
