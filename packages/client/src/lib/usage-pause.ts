import type { TFunction } from "i18next";
import type { CatchUpClosed } from "../api/types";
import { usageWhen } from "./plan-usage";

/**
 * Long work paused near a plan's or a budget's limit (ADR 0118, `meta.actionCard` `usage_paused`): it picks up by
 * itself when the limit resets, and Continuar agora (`api.chat.answerNow` on the card) lets it go on now. Shared by
 * the web and the phone.
 */
export interface UsagePauseCard {
  kind: "usage_paused";
  state: "paused" | "continued" | "resumed" | "ended" | "canceled";
  /** The paused run: "Don't run it" cancels it. */
  runId: string | null;
  agentId: string;
  /** The person behind the work: with the agent's owner and admins, who may press Continuar agora. */
  forUserId: string | null;
  source: "plan" | "budget";
  percent: number;
  window: string | null;
  plan: string;
  resetsAt: string | null;
  continuedByUserId: string | null;
  continuedAt: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function usagePauseCardOf(meta: Record<string, unknown> | null | undefined): UsagePauseCard | null {
  const raw = meta?.actionCard as Record<string, unknown> | undefined;
  if (raw?.kind !== "usage_paused" || typeof raw.agentId !== "string" || typeof raw.percent !== "number") return null;
  return {
    kind: "usage_paused",
    state:
      raw.state === "continued" || raw.state === "resumed" || raw.state === "ended" || raw.state === "canceled"
        ? raw.state
        : "paused",
    runId: str(raw.runId),
    agentId: raw.agentId,
    forUserId: str(raw.forUserId),
    source: raw.source === "budget" ? "budget" : "plan",
    percent: raw.percent,
    window: str(raw.window),
    plan: str(raw.plan) ?? "",
    resetsAt: str(raw.resetsAt),
    continuedByUserId: str(raw.continuedByUserId),
    continuedAt: str(raw.continuedAt),
  };
}

/** "das 5 horas", "of its week": a plan's window as the card says it. */
export const usageWindowText = (t: TFunction, window: string) =>
  (t as unknown as (key: string, o: Record<string, unknown>) => string)(`usageCard.window.${window}`, {
    defaultValue: "",
  });

/** The card's title and its line ("Ada pausou este trabalho · plano do Claude em 96% das 5 horas", "Retoma às 15:40…"). */
export function usagePauseText(t: TFunction, locale: string, card: UsagePauseCard, agent: string) {
  const say = t as unknown as (key: string, o: Record<string, unknown>) => string;
  const title =
    card.source === "budget"
      ? say("chat.body.usage_paused_budget", { agent, percent: card.percent })
      : say("chat.body.usage_paused", {
          agent,
          plan: card.plan,
          percent: card.percent,
          window: card.window ? usageWindowText(t, card.window) : "",
        }).trim();
  const when = card.resetsAt ? usageWhen(t, locale, card.resetsAt) : null;
  const line =
    card.source === "budget"
      ? say("usageCard.lineBudget", { when: when ?? "" })
      : when
        ? say("usageCard.line", { when })
        : say("usageCard.lineUnknown", {});
  return { title, line };
}

/**
 * Continuar agora and "Don't run it" are for the person behind the work, the agent's owner or an admin (the server's
 * `mayStopRun`); everyone else sees them greyed.
 */
export const mayContinueUsage = (
  card: Pick<UsagePauseCard, "forUserId">,
  meId: string | null,
  ownerId: string | null | undefined,
  admin: boolean,
) => admin || (meId !== null && (card.forUserId === meId || ownerId === meId));

export interface UsageWait {
  runId: string;
  /** The turns waiting behind it: its own and every later one in the conversation it speaks for (`usageWait.runIds`). */
  count: number;
  forUserId: string | null;
  canceled: boolean;
  /** Its run is back at work, or over: nothing waits to cancel. */
  ended: boolean;
  /** Skipped as already handled (ADR 0136): why, and who may answer it anyway. */
  closed: CatchUpClosed | null;
  /** Someone pressed "Responder mesmo assim": who. */
  continuedByUserId: string | null;
}

/**
 * An agent's note that it waits on its plan or budget (`meta.usageWait`: "I'll answer at 9:00"), with the run it holds:
 * "Don't run it" cancels that run, and the later turns in its conversation it speaks for. Null: no such note, or one written before notes named their run.
 */
export function usageWaitOf(meta: Record<string, unknown> | null | undefined): UsageWait | null {
  const raw = meta?.usageWait as Record<string, unknown> | undefined;
  const runId = str(raw?.runId);
  if (!runId || usagePauseCardOf(meta)) return null;
  const joined = raw?.runIds;
  return {
    runId,
    count: 1 + (Array.isArray(joined) ? joined.length : 0),
    forUserId: str(raw?.forUserId),
    canceled: raw?.canceled === true,
    ended: raw?.ended === true,
    closed: closedOf(raw?.closed),
    continuedByUserId: str(raw?.continuedByUserId),
  };
}

/**
 * The way out of a wait, on the agent's page, for a note whose wait isn't only time: another model for a model's own
 * limit or the region it needs (its owner or an admin), a higher limit for a spent budget (an admin). Null for a plan's
 * limit, which only time ends, and for anyone who couldn't do it.
 */
export function usageWaitFix(
  meta: Record<string, unknown> | null | undefined,
  who: { admin: boolean; owner: boolean },
) {
  const code = meta?.bodyCode;
  if (code === "budget_wait") return who.admin ? ("raiseBudget" as const) : null;
  const model = typeof code === "string" && code.startsWith("plan_model_");
  return model && (who.admin || who.owner) ? ("changeModel" as const) : null;
}

const CLOSED_REASONS = new Set(["solved", "withdrawn", "task_canceled", "mixed"]);

function closedOf(raw: unknown): CatchUpClosed | null {
  const c = raw as Partial<CatchUpClosed> | null | undefined;
  if (!c || typeof c !== "object" || !CLOSED_REASONS.has(c.reason ?? "")) return null;
  return {
    reason: c.reason as CatchUpClosed["reason"],
    ...(c.who && typeof c.who.name === "string" ? { who: c.who } : {}),
    askers: Array.isArray(c.askers) ? c.askers.filter((a): a is string => typeof a === "string") : [],
    at: typeof c.at === "string" ? c.at : "",
  };
}

/** "Responder mesmo assim" stays this long after a skip (the server's `ANSWER_ANYWAY_MS`). */
export const ANSWER_ANYWAY_MS = 7 * 24 * 3600_000;

/** Who may press "Responder mesmo assim": anyone who asked in it, the agent's owner and admins, for 7 days. */
export const mayAnswerAnyway = (
  closed: CatchUpClosed,
  meId: string | null,
  ownerId: string | null | undefined,
  admin: boolean,
) => admin || (meId !== null && (closed.askers.includes(meId) || ownerId === meId));

/** Whether the skip is recent enough to answer it anyway. */
export const answerAnywayOpen = (closed: CatchUpClosed, now = Date.now()) =>
  now - Date.parse(closed.at) < ANSWER_ANYWAY_MS;

/** A skipped catch-up's line: "Não respondi: Nina já cuidou disso." */
export const closedNoteText = (t: TFunction, closed: CatchUpClosed) =>
  (t as unknown as (key: string, o?: Record<string, unknown>) => string)(
    `chat.body.usage_wait_closed_${closed.reason}`,
    {
      name: closed.who?.name ?? "",
    },
  );
