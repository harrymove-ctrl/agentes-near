import type { TFunction } from "i18next";
import type { Approval, Proposal } from "../api/types";
import { agentGrammar } from "./grammar";

/**
 * Lodi's weekly card (ADR 0137 §9, `meta.actionCard` of kind `team_week`): the week's numbers, what worked and a row
 * per fix, each applied as whoever clicks through the path its own card uses. Mirrors
 * packages/engine/src/team-week.ts.
 */

export type TeamWeekRow =
  | { id: string; kind: "approvals"; agentId: string; approvalIds: string[]; since: string }
  /** A how-to of the reader's agent reused past the bar that nobody vouched for yet (ADR 0167): "Virar skill?". */
  | { id: string; kind: "howto"; agentId: string; itemId: string; title: string; uses: number }
  | { id: string; kind: "budget"; agentId: string; proposalId: string; stops: number; from: number; to: number }
  | { id: string; kind: "channel"; agentId: string; proposalId: string; channelId: string }
  | { id: string; kind: "unanswered"; channelId: string; count: number }
  | {
      id: string;
      kind: "routine";
      agentId: string;
      channelId: string;
      dm: boolean;
      text: string;
      count: number;
      hour: number;
    }
  | {
      id: string;
      kind: "stalled";
      issueId: string;
      number: number;
      title: string;
      steps: number[];
      onNumber: number;
      hours: number;
      agentId: string | null;
    };

export type TeamWeekHighlight =
  | { kind: "runs"; agentId: string; channelId: string; count: number }
  | { kind: "tasks"; agentId: string; count: number };

export interface TeamWeekCard {
  kind: "team_week";
  forUserId: string;
  /** "Resumo do dia" (`day`) or the week's (absent on older cards). */
  period?: "day" | "week";
  from: string;
  to: string;
  timezone: string;
  stats: { done: number; stuck: number; waiting: number; spentNanoUsd: number; budgetNanoUsd: number };
  worked: TeamWeekHighlight[];
  rows: TeamWeekRow[];
  proposalIds: string[];
  done: Record<string, { byUserId: string; at: string; routineId?: string }>;
  dismissedAt: string | null;
}

export interface TeamWeekPrefs {
  off: boolean;
  /** 0 = Sunday. */
  day: number;
  hour: number;
  /** "Resumo do dia": every day at `hour` (anyone may); absent from an older server. */
  daily?: boolean;
  timezone: string;
}

export type TeamWeekAct = { dismiss: true } | { rowId: string; text?: string };

export function teamWeekCardOf(meta: Record<string, unknown> | null | undefined): TeamWeekCard | null {
  const c = meta?.actionCard as Partial<TeamWeekCard> | undefined;
  if (c?.kind !== "team_week" || typeof c.forUserId !== "string" || !Array.isArray(c.rows) || !c.stats) return null;
  return {
    ...(c as TeamWeekCard),
    worked: Array.isArray(c.worked) ? c.worked : [],
    proposalIds: Array.isArray(c.proposalIds) ? c.proposalIds : [],
    done: c.done && typeof c.done === "object" ? c.done : {},
    dismissedAt: typeof c.dismissedAt === "string" ? c.dismissedAt : null,
  };
}

/** Where a row stands, from the card and live data: open, applied (Undo where it has one), or nothing left to do. */
export type TeamWeekRowState = "open" | "done" | "gone";

export function teamWeekRowState(
  card: TeamWeekCard,
  row: TeamWeekRow,
  live: { proposals: Proposal[]; approvals: Approval[] | undefined },
): TeamWeekRowState {
  if (card.done[row.id]) return "done";
  if (row.kind === "approvals") {
    if (!live.approvals) return "open";
    return row.approvalIds.some((id) => live.approvals?.find((a) => a.id === id)?.status === "pending")
      ? "open"
      : "done";
  }
  if (row.kind === "budget" || row.kind === "channel") {
    const p = live.proposals.find((x) => x.id === row.proposalId);
    if (!p || p.status === "pending") return p?.stale ? "gone" : "open";
    return p.status === "accepted" ? "done" : "gone";
  }
  return "open";
}

/** Rows "Aplicar as N" runs: open ones that apply in one click. Approvals are read and decided one by one. */
export const appliesInBulk = (row: TeamWeekRow) => row.kind !== "approvals";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "28 out." — a card's day, in the reader's language; the date is the workspace's, never shifted by the device. */
export function weekDay(locale: string, ymd: string) {
  const m = DATE.exec(ymd);
  if (!m) return ymd;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(at);
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** "17:00" / "5:00 PM": an hour of the day in the reader's language. */
export const hourText = (locale: string, hour: number) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 10, 1, hour)),
  );

/** "Monday": a day of the week (0 = Sunday) in the reader's language. */
export const dayText = (locale: string, day: number) =>
  new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 10, 1 + day, 12)),
  );

type Say = (key: string, options?: Record<string, unknown>) => string;

/** "Toda sexta às 17:00" (or "Todo dia às 9:00"), in the reader's language. */
export function teamWeekWhen(t: TFunction, locale: string, prefs: Pick<TeamWeekPrefs, "day" | "hour" | "daily">) {
  const day = prefs.daily ? "day" : (DAYS[prefs.day] ?? "fri");
  return (t as unknown as Say)(`teamWeek.every.${day}`, { time: hourText(locale, prefs.hour) });
}

/**
 * Whether this person's card comes at all: an administrator's weekly unless off; anyone else's only once they asked for
 * it daily ("Resumo do dia").
 */
export const teamWeekOn = (prefs: Pick<TeamWeekPrefs, "off" | "daily">, admin: boolean) =>
  !prefs.off && (admin || prefs.daily === true);

/** The card's title key: "Resumo do dia" or "Semana da equipe". */
export const teamWeekTitleKey = (card: Pick<TeamWeekCard, "period">) =>
  card.period === "day" ? ("teamWeek.dayTitle" as const) : ("teamWeek.title" as const);

/** Names the rows need, from the reader's directory. */
export interface TeamWeekNames {
  agent: (id: string | null) => string;
  /** The agent's @handle, null when there is none. */
  handle: (id: string | null) => string | null;
  channel: (id: string) => string;
  usd: (nanoUsd: number) => string;
  join: (names: string[]) => string;
  /** "seg., 9:41": when an approval started waiting. */
  since: (iso: string) => string;
}

/** A row's title, its line and its button, in the reader's language. */
export function teamWeekRowText(t: TFunction, locale: string, row: TeamWeekRow, n: TeamWeekNames) {
  const say = t as unknown as Say;
  const named = (id: string | null) => agentGrammar(n.agent(id));
  switch (row.kind) {
    case "approvals":
      return {
        title: say("teamWeek.approvals.title", { name: n.agent(row.agentId), count: row.approvalIds.length }),
        line: say("teamWeek.approvals.line", { since: n.since(row.since) }),
        action: say("teamWeek.approvals.action"),
      };
    case "budget":
      return {
        title: say("teamWeek.budget.title", { ...named(row.agentId), from: n.usd(row.from), to: n.usd(row.to) }),
        line: say("teamWeek.budget.line", { count: row.stops }),
        action: say("rightHand.card.apply"),
      };
    case "channel":
      return {
        title: say("teamWeek.channel.title", { ...named(row.agentId), channel: n.channel(row.channelId) }),
        line: say("teamWeek.channel.line", named(row.agentId)),
        action: say("rightHand.card.apply"),
      };
    case "unanswered":
      return {
        title: say("teamWeek.unanswered.title", { channel: n.channel(row.channelId) }),
        line: say("teamWeek.unanswered.line", { count: row.count, channel: n.channel(row.channelId) }),
        action: say("teamWeek.unanswered.action"),
      };
    case "routine":
      return {
        title: say("teamWeek.routine.title", { ...named(row.agentId), time: hourText(locale, row.hour) }),
        line: say("teamWeek.routine.line", { count: row.count, text: row.text }),
        action: say("teamWeek.routine.action"),
      };
    case "howto":
      return {
        title: say("teamWeek.howto.title", { ...named(row.agentId), what: row.title }),
        line: say("teamWeek.howto.line", { uses: row.uses }),
        action: say("teamWeek.howto.action"),
      };
    case "stalled": {
      const steps = n.join(row.steps.map((s) => `#${s}`));
      return {
        title: say("teamWeek.stalled.title", { number: row.number, title: row.title }),
        line: say("teamWeek.stalled.line", { count: row.steps.length, steps, hours: row.hours, on: row.onNumber }),
        action: say("teamWeek.stalled.action"),
      };
    }
  }
}

/** What a row sends as the person (`unanswered`: to the right hand; `stalled`: in the task's conversation). */
export function teamWeekRowMessage(t: TFunction, row: TeamWeekRow, n: TeamWeekNames): string | undefined {
  const say = t as unknown as Say;
  if (row.kind === "unanswered") return say("teamWeek.unanswered.message", { channel: n.channel(row.channelId) });
  if (row.kind !== "stalled") return undefined;
  const handle = n.handle(row.agentId);
  const steps = n.join(row.steps.map((s) => `#${s}`));
  return handle
    ? say("teamWeek.stalled.message", { handle, steps, on: row.onNumber })
    : say("teamWeek.stalled.messageNoAgent", { steps, on: row.onNumber });
}

/** The line a row applied here shows (a settings row shows its receipt instead). */
export function teamWeekDoneText(t: TFunction, row: TeamWeekRow, rightHandName: string) {
  const say = t as unknown as Say;
  if (row.kind === "routine") return say("teamWeek.routine.done");
  if (row.kind === "unanswered") return say("teamWeek.unanswered.done", agentGrammar(rightHandName));
  if (row.kind === "stalled") return say("teamWeek.stalled.done");
  if (row.kind === "howto") return say("teamWeek.howto.done");
  return say("teamWeek.applied");
}
