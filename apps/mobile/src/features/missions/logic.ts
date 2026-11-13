import type { MachineTask, Mission, MissionDecision, MissionReview, PlanItem } from "@agenteschat/client";
import type { TFunction } from "i18next";

/**
 * Missions (ADR 0029) on the phone: the plan as pixel cells, what waits on
 * you, who works on the computer now, and the decisions taken.
 */

export type TrackCell = "done" | "run" | "todo";

/** One cell per plan item (dropped ones left out, as in "N de M"). Waiting for people counts as moving. */
export function trackCell(status: PlanItem["status"]): TrackCell | null {
  if (status === "dropped") return null;
  if (status === "done") return "done";
  if (status === "doing" || status === "waiting_you") return "run";
  return "todo";
}

export function trackCells(items: Pick<PlanItem, "status">[]): TrackCell[] {
  return items.flatMap((i) => {
    const c = trackCell(i.status);
    return c ? [c] : [];
  });
}

/** The strip of a mission: its items when the server sent them, else the counts (done, moving, to do). */
export function missionTrack(m: Pick<Mission, "plan" | "runningTasks">): TrackCell[] {
  const items = m.plan.items ?? [];
  if (items.some((i) => i.status !== "dropped")) return trackCells(items);
  const total = Math.max(0, m.plan.total);
  const done = Math.min(total, Math.max(0, m.plan.done));
  const run = Math.min(total - done, Math.max(0, (m.plan.doing ?? m.runningTasks) + m.plan.waiting));
  return [
    ...Array<TrackCell>(done).fill("done"),
    ...Array<TrackCell>(run).fill("run"),
    ...Array<TrackCell>(total - done - run).fill("todo"),
  ];
}

/** "5 de 12": dropped items don't count. */
export function planProgress(m: Pick<Mission, "plan">) {
  const items = m.plan.items ?? [];
  if (items.length === 0) return { done: m.plan.done, total: m.plan.total };
  const live = items.filter((i) => i.status !== "dropped");
  return { done: live.filter((i) => i.status === "done").length, total: live.length };
}

/** Still being worked on (controls and the pinned card). */
export const isOpenMission = (m: Pick<Mission, "status">) =>
  m.status === "proposed" || m.status === "active" || m.status === "paused" || m.status === "awaiting_close";

/** How many things wait on this person in the mission (its decisions and reviews, when they may act). */
export function waitingCount(m: Pick<Mission, "pending" | "canAct">) {
  if (!m.canAct) return 0;
  return (
    m.pending.decisions + m.pending.reviews + m.pending.commands + (m.pending.deliveries ?? 0) + m.pending.provisional
  );
}

/** The cards "Esperando você" shows on the mission: pending reviews, then pending decisions. */
export function waitingCards(reviews: MissionReview[] | undefined, decisions: MissionDecision[] | undefined) {
  return {
    reviews: (reviews ?? []).filter((r) => r.status === "pending"),
    decisions: (decisions ?? []).filter((d) => d.status === "pending" || d.status === "provisional"),
  };
}

/** Decisions already taken, newest first. */
export function takenDecisions(decisions: MissionDecision[] | undefined) {
  return (decisions ?? [])
    .filter((d) => d.status === "taken" && d.chosen)
    .sort((a, b) => (b.chosenAt ?? b.createdAt).localeCompare(a.chosenAt ?? a.createdAt));
}

/** Sessions on the computer right now (this mission's running tasks), newest first. */
export function liveSessions(tasks: MachineTask[] | undefined, missionId: string) {
  return (tasks ?? [])
    .filter((t) => t.missionId === missionId && (t.status === "running" || t.status === "queued"))
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt));
}

/** Whole minutes a session has been running. */
export function sessionMinutes(task: Pick<MachineTask, "startedAt" | "createdAt">, now = Date.now()) {
  return Math.max(0, Math.floor((now - new Date(task.startedAt ?? task.createdAt).getTime()) / 60_000));
}

/** Whole hours of work since it started (the header's "14 h de trabalho"); null before it starts. */
export function hoursSince(iso: string | null, now = Date.now()) {
  if (!iso) return null;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 3_600_000));
}

/** The plan rows, in order, without dropped items. */
export const planRows = (items: Mission["plan"]["items"]) => (items ?? []).filter((i) => i.status !== "dropped");

/** The recommended option of a decision (by text), if any. */
export const recommendedOption = (d: Pick<MissionDecision, "recommendation" | "options">) =>
  d.recommendation && d.options.includes(d.recommendation) ? d.recommendation : null;

/** "MacBook do Walter · ligado": where a mission works. The Cloud's computer is never off: it isn't answering. */
export const missionComputerKey = (online: boolean, cloud: boolean) =>
  online ? "mobile.mission.computerOn" : cloud ? "mobile.mission.computerNotAnswering" : "mobile.mission.computerOff";

/**
 * Where a mission works, said by the computer's name only where the workspace has more than one (`names`, from
 * `namesComputers`). Else only one that isn't working says so ("Computador sem resposta"), and null when it works.
 */
export function missionComputerText(
  t: TFunction,
  machine: { name: string; online: boolean },
  { cloud, names }: { cloud: boolean; names: boolean },
): string | null {
  if (names) return t(missionComputerKey(machine.online, cloud), { name: machine.name });
  if (machine.online) return null;
  return t(cloud ? "mobile.mission.computerNotAnsweringPlain" : "mobile.mission.computerOffPlain");
}
