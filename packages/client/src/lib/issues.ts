import type { TFunction } from "i18next";
import type { Issue, IssueActivity, IssuePriority, IssueStatus } from "../api/types";
import { timeAgo } from "./format";
import { blockedText } from "./long-work";
import { can } from "./permissions";

export const BOARD: IssueStatus[] = ["todo", "in_progress", "in_review", "done"];
export const STATUSES: IssueStatus[] = [...BOARD, "canceled"];
export const PRIORITIES: IssuePriority[] = ["low", "normal", "high"];

/** Columns a stage of the board holds at most (mirror of packages/engine/src/issue-columns.ts). */
export const STAGE_COLUMNS_MAX = 10;

/** A circle that fills as the work goes. */
export const STATUS_ICON: Record<IssueStatus, "stageTodo" | "stageProgress" | "stageReview" | "stageDone" | "close"> = {
  todo: "stageTodo",
  in_progress: "stageProgress",
  in_review: "stageReview",
  done: "stageDone",
  canceled: "close",
};

/**
 * Who sees "Excluir tarefa": who created it, an administrator, and, on a task no person created, whoever may give
 * agents work. Mirrors `mayDelete` in packages/engine/src/issue-deletion.ts, which decides.
 */
export function canDeleteIssue(
  org: Parameters<typeof can>[0],
  i: Pick<Issue, "createdBy">,
  myUserId: string | null | undefined,
) {
  if (i.createdBy.type === "person") return i.createdBy.id === myUserId || can(org, "administrator");
  return can(org, "assign_work") || can(org, "administrator");
}

/** The sentences of a task's delete confirmation: what goes with it (`who`: the agent that stops, when one is on it). */
export function deleteIssueText(t: TFunction, i: Pick<Issue, "subIssues">, who: string | null) {
  const steps = i.subIssues?.length ?? 0;
  return [
    t("issues.delete.body"),
    steps > 0 ? t("issues.delete.steps", { count: steps }) : "",
    who ? t("issues.delete.working", { name: who }) : "",
    t("common.cantUndo"),
  ]
    .filter(Boolean)
    .join(" ");
}

/** A task a DM or a private channel holds back: only who reads that conversation sees it (`channels`: the app's list). */
export function heldBack(i: Pick<Issue, "channelId">, channels: { id: string; visibility: string }[] | undefined) {
  if (!i.channelId || !channels) return false;
  const channel = channels.find((c) => c.id === i.channelId);
  return !channel || channel.visibility === "private";
}

/** An event of a task in the person's language from its code (`issues.event.*`); the server's words as the fallback. */
export function issueEventText(t: TFunction, a: Pick<IssueActivity, "text" | "textCode" | "textParams">) {
  if (!a.textCode) return a.text;
  const p = a.textParams ?? {};
  const extra = {
    ...(p.status ? { status: t(`issues.status.${p.status}`, { defaultValue: p.status }) } : {}),
    ...(p.priority ? { priority: t(`issues.priority.${p.priority}`, { defaultValue: p.priority }) } : {}),
  };
  return t(`issues.event.${a.textCode}`, { ...p, ...extra, defaultValue: a.text });
}

/** Description text → description + acceptance criteria (lines starting with "-", "*" or "[ ]"). */
export function splitCriteria(text: string) {
  const criteria: string[] = [];
  const rest: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*]\s*(?:\[[ x]?\]\s*)?|\[[ x]?\]\s*)(.+)$/i);
    if (m?.[1]?.trim()) criteria.push(m[1].trim());
    else rest.push(line);
  }
  return { description: rest.join("\n").trim(), criteria };
}

/** An agent working on the issue now (a live run), not a stalled one. */
export const isWorking = (i: Pick<Issue, "work">) => Boolean(i.work && i.work.state !== "stalled");
/** In progress with an agent and no run alive: the agent took it but nobody is working. */
export const isStalled = (i: Pick<Issue, "work">) => i.work?.state === "stalled";
export const isOpen = (i: Pick<Issue, "status">) => i.status !== "done" && i.status !== "canceled";

/** The one state a task's card, row and list say, beside who has it ("Pergunta algo", "Parado há 2 dias"). */
export type CardState =
  | { kind: "approval" }
  | { kind: "question" }
  | { kind: "running" }
  | { kind: "stalled"; since: string }
  | { kind: "blocked"; blocked: NonNullable<Issue["blocked"]> };

/**
 * What a task's card says it needs or does now, from one place: its agent's work first, then background work stopped
 * on something, then a turn live in its conversation (`live`). A closed task says nothing. So a card never says
 * "Pergunta algo" and "Trabalhando" at once, as it did while the conversation's line read the live turn on its own.
 */
export function cardState(i: Pick<Issue, "status" | "work" | "blocked">, live = false): CardState | null {
  if (!isOpen(i)) return null;
  const w = i.work;
  if (w?.state === "waiting_approval") return { kind: "approval" };
  if (w?.state === "waiting_input") return { kind: "question" };
  if (w?.state === "running") return { kind: "running" };
  if (w?.state === "stalled") return { kind: "stalled", since: w.since };
  if (i.blocked) return { kind: "blocked", blocked: i.blocked };
  return live ? { kind: "running" } : null;
}

/** A waiting state calls on a person: the card wears its agent's sky. */
export const cardWaits = (s: CardState | null) => s?.kind === "approval" || s?.kind === "question";

/** The state in words: "Pede aprovação", "Pergunta algo", "Trabalhando", "Parado há 2 dias", the blocked reason. */
export function cardStateText(t: TFunction, s: CardState, now = new Date()): string {
  switch (s.kind) {
    case "approval":
      return t("issues.work.waitingApproval");
    case "question":
      return t("issues.work.waitingInput");
    case "running":
      return t("threads.status.working");
    case "stalled":
      return t("issues.work.stalled", { when: timeAgo(t, s.since, now.getTime()) });
    case "blocked":
      return blockedText(t, s.blocked) ?? "";
  }
}

/** An issue someone asked an agent to implement, as a message carries it. */
export interface IssueWorkRef {
  issueId: string;
  number: number;
  title: string;
  agentId: string;
}

function workRef(v: unknown): IssueWorkRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.issueId !== "string" || typeof o.number !== "number" || typeof o.title !== "string") return null;
  return {
    issueId: o.issueId,
    number: o.number,
    title: o.title,
    agentId: typeof o.agentId === "string" ? o.agentId : "",
  };
}

/** `meta.issueWork`: the root of the work thread in the requester's DM with the agent (shown as a card). */
export const issueWorkOf = (meta: Record<string, unknown> | null | undefined) => workRef(meta?.issueWork);
/** `meta.issueTaken`: the one line where the issue came from ("Ada took issue #24"). */
export const issueTakenOf = (meta: Record<string, unknown> | null | undefined) => workRef(meta?.issueTaken);

/** A task the right hand handed to an agent, as its reply carries it (`meta.tasks`): the chip opens its thread. */
export interface HandedTask extends IssueWorkRef {
  /** Its conversation (a channel of kind `task`) and its root: the thread the chip opens. */
  channelId: string;
  rootId: string;
}

/** `meta.tasks`: the tasks a reply handed on (ADR 0137 §13), one chip each. */
export function handedTasksOf(meta: Record<string, unknown> | null | undefined): HandedTask[] {
  const list = Array.isArray(meta?.tasks) ? (meta.tasks as unknown[]) : [];
  return list.flatMap((v) => {
    const ref = workRef(v);
    const { rootId, channelId } = v as { rootId?: unknown; channelId?: unknown };
    return ref && typeof rootId === "string" && typeof channelId === "string" ? [{ ...ref, channelId, rootId }] : [];
  });
}

/**
 * `meta.taskConversation`: the root of a task's conversation (ADR 0145). It stands for the task and is never drawn:
 * the task's own screen is right there.
 */
export const taskConversationOf = (meta: Record<string, unknown> | null | undefined) => workRef(meta?.taskConversation);

/**
 * The conversation line of a task's card and of its dialog's summary: who took part (the first three), how many
 * messages, and an agent at work or when it last moved. Null for a task nobody wrote in yet.
 */
export function conversationLine(i: Pick<Issue, "conversation">) {
  const c = i.conversation;
  if (!c || c.count === 0) return null;
  return { count: c.count, people: c.participants.slice(0, 3), working: c.working, lastAt: c.lastAt };
}
