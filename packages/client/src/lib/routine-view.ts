import type { TFunction } from "i18next";
import type {
  ApiRule,
  AppNotification,
  Routine,
  RoutineEvent,
  RoutineRun,
  RoutineRunStatus,
  RoutineTarget,
  WebhookProvider,
} from "../api/types";
import type { RunStatus } from "./calendar";
import { clockAt, whenAt } from "./format";

/**
 * How Rotinas says a routine (ADR 0053 §11), as pure rules: its state and the one-tap fix for a pause,
 * the week's health, where it runs, its usage, and each run's outcome in plain words. No React, no
 * i18n: each answer is an i18n key (under `routines.*`) with its values, and the page says it.
 */

/** Words to say: an i18n key, its values, and a key to fall back on when the first one is unknown. */
export interface Words {
  key: string;
  values: Record<string, string | number>;
  fallback?: string;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** A run still at work: queued, running, or waiting for a person or the computer. */
export const isRunAtWork = (status: RoutineRunStatus) =>
  status === "queued" || status === "running" || status === "waiting";

/** Parar, not "Rodar agora": a run working now, or one waiting on its plan or budget (it picks up again by itself). */
export const isStoppable = (r: Pick<Routine, "state">) => r.state === "running" || r.state === "usage_paused";

/** Parar's words: a run waiting on its limit hasn't started its work, so stopping it is "Don't run it". */
export const stopWordsKey = (r: Pick<Routine, "state">) =>
  r.state === "usage_paused" ? "routines.usagePause.dontRun" : "routines.stop";

/** Continuar agora is offered only for a pause near the limit, never at the limit itself (nothing is left to use). */
export const usageContinueOffered = (r: Pick<Routine, "usagePause">) => r.usagePause?.limit !== true;

/**
 * A run as the pixel strip and the calendar draw it: told people (`ok`), nothing new (`silent`),
 * `failed`, or it didn't run (`skipped`: stopped, replaced, too late or never started). Null while at
 * work: the strip shows a run in progress on its own.
 */
export function runPixelStatus(status: RoutineRunStatus): RunStatus | null {
  switch (status) {
    case "reported":
      return "ok";
    case "silent":
      return "silent";
    case "failed":
      return "failed";
    case "canceled":
    case "superseded":
    case "missed":
    case "skipped":
      return "skipped";
    default:
      return null;
  }
}

/** The finished runs as pixels (newest first, as the API sends them). */
export function runPixels(runs: readonly RoutineRun[]): { status: RunStatus; weight?: number; at: string }[] {
  return runs.flatMap((r) => {
    const status = runPixelStatus(r.status);
    return status ? [{ status, at: r.at, ...(r.weight !== undefined ? { weight: r.weight } : {}) }] : [];
  });
}

/**
 * Run codes said with their own words (`routines.code.<code>`): every code the routine ledger writes
 * (routines, firing, ledger, hand-off) and the run errors a failed run carries. Any other (a computer's
 * own failure, a plain `error`) falls back to the status.
 */
export const RUN_CODES = [
  "previous_running",
  "previous_waiting",
  "waiting_computer",
  "waiting_plan",
  "waiting_budget",
  "superseded",
  "stale",
  "waiting_plan_late",
  "waiting_budget_late",
  "stopped",
  "no_report",
  "handoff_blocked",
  "deleted",
  "paused",
  "lost",
  "creator_left",
  "creator_no_access",
  "audience",
  "agent_not_in_channel",
  "budget_exceeded",
  "provider_error",
  "provider_unavailable",
  "gave_up",
  "empty_reply",
  "model_refused",
  "runner_outdated",
  "too_many_tool_calls",
  "stuck",
  "missing_credential",
  "credential_revoked",
  "credential_wrong_provider",
  "model_unlisted",
  "agent_archived",
  "interrupted",
  "no_ai",
  "person_limit",
  "org_paused",
  "org_suspended",
  "org_deleting",
  "agent_paused",
  "computer_busy",
  "computer_failed",
  "computer_timeout",
  "cli_failed",
  "account_missing",
  "our_error",
] as const;

/**
 * A run's outcome in plain words (`routines.outcome.<status>`, or `routines.code.<code>` for why it
 * ended): "Contou o que achou", "Nada novo", "Pulada: a anterior ainda estava rodando", "Parada por
 * Walter" (`stopped`: `by`, the person; `nameOf` turns their id into a name). A waiting run says what it
 * waits for: an approval, or the computer.
 */
export function runOutcome(
  run: Pick<RoutineRun, "status" | "code" | "codeParams" | "approvalId">,
  nameOf: (userId: string) => string | null = () => null,
): Words {
  if (run.status === "waiting") {
    if (run.code === "waiting_computer") return { key: "routines.outcome.waitingComputer", values: {} };
    if (run.code === "waiting_plan") return { key: "routines.outcome.waitingPlan", values: {} };
    if (run.code === "waiting_budget") return { key: "routines.outcome.waitingBudget", values: {} };
    return { key: run.approvalId ? "routines.outcome.waitingApproval" : "routines.outcome.waiting", values: {} };
  }
  const fallback = `routines.outcome.${run.status}`;
  // A run that told people says so, whatever its code (`auto_report`: its final text became the report).
  if (!run.code || isRunAtWork(run.status) || run.status === "reported" || run.status === "silent")
    return { key: fallback, values: {} };
  if (run.code === "stopped") {
    const by = run.codeParams?.by;
    const name = by ? (nameOf(by) ?? by) : null;
    return name ? { key: "routines.code.stoppedBy", values: { name } } : { key: "routines.code.stopped", values: {} };
  }
  // A provider's failure by its cause, in the words the conversation uses for it.
  if (run.code.startsWith("provider_") && run.codeParams?.provider)
    return { key: `agentPage.activity.errors.${run.code}`, values: run.codeParams, fallback };
  if ((RUN_CODES as readonly string[]).includes(run.code))
    return { key: `routines.code.${run.code}`, values: { ...(run.codeParams ?? {}) }, fallback };
  return { key: fallback, values: {} };
}

/** "Abrir na conversa": the agent's message for this run (a thread opens as a thread). */
export function runMessageLink(run: Pick<RoutineRun, "link">) {
  const l = run.link;
  if (!l) return null;
  return l.threadId && l.threadId !== l.messageId
    ? { channelId: l.channelId, threadId: l.threadId, messageId: l.messageId }
    : { channelId: l.channelId, threadId: null, messageId: l.messageId };
}

/**
 * Why a routine's notification came, in words: a pause by its coded reason ("Pausada: o agente não está
 * mais no canal"), a failed run by its code ("O orçamento do mês acabou", else "Não deu certo"). Null for
 * other notifications, and for a pause without a reason (its text says it).
 */
export function routineNotificationWords(n: Pick<AppNotification, "kind" | "latest">): Words | null {
  if (n.kind === "routine_failed") return runOutcome({ status: "failed", code: n.latest.reason ?? null });
  if (n.kind === "routine_paused" && n.latest.reason)
    return { key: `routines.pausedReason.${n.latest.reason}`, values: {} };
  return null;
}

// ── State ────────────────────────────────────────────────────────────────────

/** The one-tap fix for a paused routine. */
export type RoutineFix = "add_agent" | "take_over" | "resume";

/** The conversation a routine reports to, when it is a channel or a thread (a DM, the Drive: none). */
export function routineChannelOf(target: RoutineTarget): string | null {
  return target.type === "channel" || target.type === "conversation" ? target.channelId : null;
}

/**
 * How to bring a paused routine back in one tap: the agent left the channel → add it back; its creator
 * left or can't post there anymore → someone takes it over; failing, or paused by a person → resume.
 * An archived agent has no fix here (null), nor does an active routine.
 */
export function pausedFix(r: Pick<Routine, "active" | "pausedReason" | "target">): RoutineFix | null {
  if (r.active) return null;
  switch (r.pausedReason) {
    case "agent_not_in_channel":
      return routineChannelOf(r.target) ? "add_agent" : null;
    case "creator_left":
    case "creator_no_access":
    case "audience":
      return "take_over";
    case "agent_archived":
      return null;
    default:
      return "resume";
  }
}

/**
 * The time word in the state chip: when a run paused near its limit picks up ("14:00", "24 out 14:00"), or since when
 * it waits for its computer ("hoje 09:12"); '' when neither.
 */
export function routineStateTime(
  t: TFunction,
  locale: string,
  r: Pick<Routine, "state" | "waitingFor" | "usagePause">,
  now = new Date(),
) {
  if (r.state === "usage_paused") return r.usagePause?.resetsAt ? clockAt(locale, r.usagePause.resetsAt, now) : "";
  return r.waitingFor ? whenAt(t, locale, r.waitingFor.since, now) : "";
}

/**
 * Milliseconds until the earliest reset among routines waiting on a limit, so the list is read again then; a reset
 * already past (its run picks up within a minute or two) is read again every 30 s. False: nothing to wait for.
 */
export function usagePauseRefetchMs(
  list: readonly Pick<Routine, "state" | "usagePause">[] | undefined,
  now = Date.now(),
) {
  const resets = (list ?? [])
    .map((r) => (r.state === "usage_paused" && r.usagePause?.resetsAt ? Date.parse(r.usagePause.resetsAt) : Number.NaN))
    .filter((at) => Number.isFinite(at));
  if (resets.length === 0) return false as const;
  const next = Math.min(...resets) - now;
  return next > 0 ? next + 1000 : 30_000;
}

/**
 * Why Continuar agora on a run paused near its limit is greyed for this viewer (`routines.usagePause.<reason>`):
 * only its creator, the agent's owner and admins (`canManage`) may press it, and not once the plan's window is used
 * up while the agent's long work may not use paid extra usage (`extra_off`) or the plan has none left
 * (`extra_used_up`). Null: they may.
 */
export const usageContinueBlock = (r: Pick<Routine, "canManage" | "usagePause">) =>
  !r.canManage
    ? ("forbidden" as const)
    : r.usagePause?.extraOff
      ? ("extra_off" as const)
      : r.usagePause?.extraUsedUp
        ? ("extra_used_up" as const)
        : null;

/** Paused reasons with their own words (`routines.pausedReason.<reason>`). */
const PAUSED_REASONS = [
  "creator_left",
  "creator_no_access",
  "agent_archived",
  "agent_not_in_channel",
  "audience",
  "failing",
] as const;

/**
 * The state chip: "Ativa", "Pausada: o agente saiu do canal" (`routines.pausedReason.<reason>`), "Falhando
 * (3 seguidas)", "Esperando o MacBook do Walter desde 09:12", "Esperando alguém", "Rodando". `since` is
 * said by the page (`whenAt`), so it comes in as a word. The computer goes by its name only where that tells
 * it apart (`namesComputer`, from `namesComputers`): else "Esperando o computador desde 09:12".
 */
export function routineStateWords(
  r: Pick<Routine, "state" | "active" | "pausedReason" | "failuresInRow" | "waitingFor" | "trigger" | "usagePause">,
  since = "",
  namesComputer = false,
): Words & { icon: "repeat" | "pause" | "alert" | "computer" | "waiting" | "spinner"; tone: "neutral" | "waiting" } {
  switch (r.state) {
    case "running":
      return { key: "routines.state.running", values: {}, icon: "spinner", tone: "neutral" };
    case "waiting_computer": {
      const machine = namesComputer ? r.waitingFor?.machineName : "";
      if (machine)
        return {
          key: since ? "routines.state.waitingComputerSince" : "routines.state.waitingComputer",
          values: { machine, since },
          icon: "computer",
          tone: "waiting",
        };
      return {
        key: since ? "routines.state.waitingAnyComputerSince" : "routines.state.waitingAnyComputer",
        values: { since },
        icon: "computer",
        tone: "waiting",
      };
    }
    case "waiting_person":
      return { key: "routines.state.waitingPerson", values: {}, icon: "waiting", tone: "waiting" };
    // Quiet: it picks up by itself at the reset (`since` is that time here, `clockAt`). On a plan with a name: "Waiting
    // for the Claude plan · runs at 9:00".
    case "usage_paused":
      if (r.usagePause?.source !== "budget" && r.usagePause?.plan)
        return {
          key: since ? "routines.state.waitingPlan" : "routines.state.waitingPlanUnknown",
          values: { plan: r.usagePause.plan, until: since },
          icon: "pause",
          tone: "neutral",
        };
      return {
        key: `routines.state.${r.usagePause?.source === "budget" ? "usagePausedBudget" : "usagePaused"}${since ? "" : "Unknown"}`,
        values: { until: since },
        icon: "pause",
        tone: "neutral",
      };
    case "failing":
      return {
        key: "routines.state.failing",
        values: { count: Math.max(1, r.failuresInRow) },
        icon: "alert",
        tone: "waiting",
      };
    case "needs_webhook":
      return {
        key: "routines.state.needsWebhook",
        values: {
          provider: r.trigger.type === "event" && eventWebhook(r.trigger.event) === "sentry" ? "Sentry" : "GitHub",
        },
        icon: "alert",
        tone: "waiting",
      };
    case "paused": {
      const reason = (PAUSED_REASONS as readonly string[]).includes(r.pausedReason ?? "") ? r.pausedReason : null;
      return reason
        ? { key: `routines.pausedReason.${reason}`, values: {}, icon: "pause", tone: "waiting" }
        : { key: "routines.state.paused", values: {}, icon: "pause", tone: "neutral" };
    }
    default:
      return { key: "routines.state.active", values: {}, icon: "repeat", tone: "neutral" };
  }
}

// ── The week ─────────────────────────────────────────────────────────────────

/**
 * The week's health: "12 de 14 OK esta semana · 2 puladas · 1 falhou". OK is a run that told people or
 * had nothing new; a skip is any slot that didn't run (replaced and missed ones count too, as in the run
 * strip). The server leaves the runs a person stopped out of the total, so it adds up. Null before its
 * first run.
 */
export function healthWords(h: Routine["health"]): Words[] | null {
  if (h.total <= 0) return null;
  const out: Words[] = [{ key: "routines.health.ok", values: { ok: h.ok + h.silent, total: h.total } }];
  const skipped = h.skipped + h.missed;
  if (skipped > 0) out.push({ key: "routines.health.skipped", values: { count: skipped } });
  if (h.failed > 0) out.push({ key: "routines.health.failed", values: { count: h.failed } });
  return out;
}

/**
 * Where it runs: its computer's name ("MacBook do Walter"), only where that tells it apart (`namesComputer`: the
 * workspace has more than one). Null otherwise, and on the API, so the section isn't shown.
 */
export const whereItRuns = (brain: Routine["brain"], namesComputer: boolean): string | null =>
  namesComputer ? brain.machineName : null;

/**
 * Its usage this week, in plain words ("14 execuções · 120 mil tokens do plano · US$ 0,42 na API"): the
 * runs, then tokens for a plan (Claude Code, Codex) and the cost for the API, both when mixed. People who
 * don't see money (`money` false) never get the cost. The page formats the numbers. Null before any run.
 */
export function usageParts(
  usage: Routine["usage"],
  money: boolean,
): { runs: number; tokens: number | null; costUsd: number | null } | null {
  if (usage.runs <= 0) return null;
  return {
    runs: usage.runs,
    tokens: usage.billedTo !== "api" && usage.tokens > 0 ? usage.tokens : null,
    costUsd: money && usage.billedTo !== "plan" ? usage.costNanoUsd / 1e9 : null,
  };
}

// ── How often ────────────────────────────────────────────────────────────────

/** From this many runs a day (hourly or more often), a routine on someone's computer gets a warning. */
export const BUSY_RUNS_PER_DAY = 24;

/**
 * How many times a rule runs on a day it runs: hourly every N hours → 24 / N; otherwise its times of
 * day. A cron-only routine (no rule) with a minute step (every 15 min) counts from the cron.
 */
export function runsPerDay(rule: Pick<ApiRule, "freq" | "interval" | "times"> | null, cron = ""): number {
  if (rule) {
    if (rule.freq === "once") return 1;
    if (rule.freq === "hourly") return Math.floor(24 / Math.max(1, rule.interval ?? 1));
    return Math.max(1, rule.times?.length ?? 1);
  }
  const [minute = "", hour = ""] = cron.trim().split(/\s+/);
  const step = (field: string, size: number) => {
    if (field === "*") return size;
    const m = /^\*\/(\d+)$/.exec(field);
    if (m) return Math.ceil(size / Math.max(1, Number(m[1])));
    return field.split(",").length;
  };
  if (!minute || !hour) return 1;
  return step(minute, 60) * step(hour, 24);
}

/**
 * On a computer brain and hourly or more often: "Roda 24 vezes por dia no MacBook do Walter, que precisa ficar
 * ligado". Only where people connect their own computers (`selfHost`): the Cloud's own is always on. The computer
 * by its name only where that tells it apart (`namesComputer`), else "no computador".
 */
export function busyOnComputer(
  brain: { kind: string; machineName?: string | null } | null | undefined,
  perDay: number,
  where: { selfHost: boolean; namesComputer: boolean },
): Words | null {
  if (
    !where.selfHost ||
    !brain ||
    !["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"].includes(brain.kind)
  )
    return null;
  if (perDay < BUSY_RUNS_PER_DAY) return null;
  const machine = where.namesComputer ? brain.machineName : null;
  return machine
    ? { key: "routines.busyComputer", values: { count: perDay, machine } }
    : { key: "routines.busyAnyComputer", values: { count: perDay } };
}

/** The service whose webhook brings an event (the engine's `EVENT_WEBHOOK`); null for one made here. */
export const eventWebhook = (event: RoutineEvent): WebhookProvider | null =>
  event === "sentry.issue_created"
    ? "sentry"
    : event === "github.pr_opened" || event === "deploy.succeeded"
      ? "github"
      : null;
