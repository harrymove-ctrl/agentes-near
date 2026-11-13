import type { TFunction } from "i18next";
import type { CatchUpClosed, UsageQueue, UsageQueueRow } from "../api/types";
import { joinNames, keepWhole, relativeTime } from "./format";
import { usageWhen } from "./plan-usage";

/**
 * An agent's line of work waiting on its plan or budget (ADR 0118), worded for the web's dialog and the phone's sheet:
 * one short row per conversation in the order it picks them up, and the ones it skipped as already handled.
 */

const say = (t: TFunction) => t as unknown as (key: string, o?: Record<string, unknown>) => string;

/** The agent is answering the first one: the plan is back. */
export const usageQueueResuming = (q: Pick<UsageQueue, "rows">) => q.rows.some((r) => r.state === "answering");

/**
 * One title per phase: "Theo volta às 01:00" (or "quando o plano renovar"), then "Theo está retomando" once it answers
 * the first one. Nothing waiting: its name.
 */
export function usageQueueTitle(t: TFunction, locale: string, agent: string, q: UsageQueue, now = new Date()) {
  if (usageQueueResuming(q)) return say(t)("usageQueue.resuming", { agent });
  if (!q.reason) return agent;
  if (q.resetsAt) return say(t)("usageQueue.back", { agent, when: usageWhen(t, locale, q.resetsAt, now) });
  return say(t)(q.reason === "budget" ? "usageQueue.backBudget" : "usageQueue.backPlan", { agent });
}

/** Behind the title's ⓘ: "Ada usa o mesmo plano do Claude. As conversas dos dois entram na mesma fila." Null alone. */
export const usageQueueShared = (t: TFunction, plan: string | null, others: string[]) =>
  others.length > 0
    ? say(t)("usageQueue.shared", { agents: joinNames(others, t), plan: plan ?? "", count: others.length })
    : null;

/** Where it waits: "DM com Ana", "Sua DM", "#suporte", "Conversa em #suporte", "Rotina Resumo diário". */
export function usageQueueWhere(t: TFunction, row: UsageQueueRow, viewerId: string, person: (id: string) => string) {
  if (row.kind === "routine") return say(t)("usageQueue.routine", { name: row.title ?? "" });
  if (row.kind === "work") return say(t)("usageQueue.work", { name: row.title ?? "" });
  if (row.channelKind === "dm") {
    const asker = row.askers[0];
    return !asker || asker === viewerId
      ? say(t)("usageQueue.yourDm")
      : say(t)("usageQueue.dm", { name: person(asker) });
  }
  const channel = row.channelName ?? "";
  return row.threadId ? say(t)("usageQueue.thread", { channel }) : `#${channel}`;
}

/**
 * After where, on the same line: who asked and when ("Ana e Bruno · há 40 min", "você e Ana · ontem"). A DM already
 * names its person, and a routine or long work has no asker: only when.
 */
export function usageQueueWho(
  t: TFunction,
  locale: string,
  row: UsageQueueRow,
  person: (id: string) => string,
  now = new Date(),
) {
  // "há 40 min" never breaks across lines: a long name before it wraps instead.
  const ago = keepWhole(relativeTime(t, locale, row.since, now));
  if (row.channelKind === "dm" || row.askers.length === 0) return ago;
  return `${joinNames(row.askers.map(person), t)} · ${ago}`;
}

/** The row's hover text: "Pedido por Ana e Bruno · há 3 dias" (a routine or long work: "Pausado há 3 h"). */
export function usageQueueMeta(
  t: TFunction,
  locale: string,
  row: UsageQueueRow,
  person: (id: string) => string,
  now = new Date(),
) {
  const ago = relativeTime(t, locale, row.since, now);
  if (row.askers.length === 0) return say(t)("usageQueue.paused", { ago });
  return say(t)("usageQueue.askedBy", { names: joinNames(row.askers.map(person), t), ago });
}

/** Where a skipped one was: "Sua DM", "Conversa em #vendas", "#financeiro". */
export const usageQueueSkippedWhere = (
  t: TFunction,
  row: { channelKind: string; threadId: string | null; channelName: string | null },
) =>
  row.channelKind === "dm"
    ? say(t)("usageQueue.yourDm")
    : row.threadId
      ? say(t)("usageQueue.thread", { channel: row.channelName ?? "" })
      : `#${row.channelName ?? ""}`;

/** Why it skipped one, in the dialog's voice (the note's "Não respondi:" is the agent's): "Nina já cuidou disso". */
export const usageQueueSkipReason = (t: TFunction, closed: CatchUpClosed) =>
  say(t)(`usageQueue.skip_${closed.reason}`, { name: closed.who?.name ?? "" });

/** What "Não rodar nenhuma" stops (the owner and admins): every one still in line, the hidden ones too. */
export const usageQueueStoppable = (q: Pick<UsageQueue, "rows" | "hidden">) =>
  q.rows.filter((r) => r.state === "queued").length + q.hidden;

/** The status line's tail on an agent out of office with conversations waiting: "· 7 conversas esperando". */
export const usageWaitingText = (t: TFunction, count: number) => say(t)("usageQueue.waiting", { count });
