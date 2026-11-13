import type { MailAdapters, PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgent } from "./agents";
import { decidesAgentApprovals, MAX_OWN_ACTIONS, OWN_ACTION_NAME } from "./approval-rules";
import { cancelRoutineAhead, type RoutineAheadView, routinesAhead } from "./approvals";
import { audienceError, audienceSql, canTalkTo, speakerFor, speakerOf } from "./audience";
import { recordAudit } from "./audit";
import { UUID } from "./authority";
import { brainOf } from "./brain-settings";
import { BRAIN_PLAN_NAMES, type BrainKind, isComputerBrain } from "./brains/types";
import { canceledBy } from "./cancel";
import { requireChannelAccess } from "./channels";
import {
  type ConnectorEventId,
  type ConnectorTriggerDeps,
  type ConnectorTriggerFilter,
  type ConnectorTriggerSource,
  checkConnectorTrigger,
  isConnectorEvent,
  normalizeConnectorFilter,
  syncConnectorTrigger,
} from "./connector-triggers";
import { type ContextDeps, schedulesOf } from "./context/summaries";
import { nextCronTime, zonedTimeForward } from "./cron";
import { dashboardRights, viewerOf } from "./dashboards/access";
import { isWidgetChangeRun, widgetFiring, widgetRunStarting } from "./dashboards/refresh-fire";
import { widgetRoutineGone, widgetRoutineHeld } from "./dashboards/refresh-ledger";
import { openDm } from "./dms";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishListChanged, publishMessageCreated, publishRoutineRuns, publishUserEvent } from "./events";
import { releaseRoutineEmails } from "./mail/inbound";
import {
  checkWatchable,
  type MailFilter,
  type MailWatchRow,
  normalizeMailFilter,
  resetMailWatchState,
  syncMailWatch,
  watchesOf,
} from "./mail/watches";
import { getOrgSettings } from "./management";
import { getMessage, insertMessageWithRuns, messageView, replyExcerpt } from "./messages";
import { resolveRoutinePaused } from "./notification-producers";
import { can, getMembership, requirePermission } from "./organizations";
import { PermanentJobError } from "./outbox";
import { maySql } from "./permissions";
import {
  type RoutineAccess,
  type RoutineBrief,
  type RoutineReport,
  routineAccessOf,
  routineReportOf,
} from "./routine-brief";
import { enqueueRoutineJob, queueEventRun, startGatheredRun } from "./routine-events";
import { claimRoutineRun, haltRoutineRuns, makeWayForRun, skipRoutineRun, unclaimRoutineRun } from "./routine-firing";
import {
  DEFAULT_HOOK_METHODS,
  ensureRoutineHook,
  type HookMethod,
  liveHookUrl,
  type RoutineHookConfig,
  routineHookKeys,
  WEBHOOK_EVENT,
} from "./routine-hooks";
import { afterRoutineRunEnded, endRoutineRun } from "./routine-ledger";
import { startRoutineRun } from "./routine-room";
import { pauseRoutine, personCanPost, type RoutinePausedReason } from "./routine-state";
import {
  cronToRule,
  describeRule,
  nextOccurrence,
  normalizeRule,
  ruleOccurrences,
  ruleToCron,
  type ScheduleRule,
} from "./rrule";
import { providerFailure } from "./runs";
import { describeWhen, parseSchedule, readSchedule, type ScheduleParse } from "./schedule";
import { assertCanWork, closedRefusal, deletionPending, orgStanding, standingRefusal } from "./standing";
import { alwaysAsks } from "./tools/gateway";
import {
  assertMayContinuePause,
  overrideUsagePause,
  type PastPlanReason,
  pauseContinuesPastPlan,
  USAGE_WAIT_CODES,
} from "./usage-pause";

export { startRoutineRun } from "./routine-room";

const {
  routines,
  routineRuns,
  agentRuns,
  agents,
  approvals,
  usageRecords,
  channelMembers,
  channels,
  machines,
  messages,
  organizationMembers,
  users,
  webhookEndpoints,
  dashboards,
  dashboardWidgets,
} = schema;

export type RoutineTarget =
  | { type: "channel"; channelId: string }
  | { type: "dm" }
  | { type: "artifact" }
  /**
   * The conversation it was asked in (a thread, or a DM: `threadId` null).
   * `reminder`: at the time the agent just posts "Reminder: …" mentioning
   * `forUserId` (no run); otherwise the agent is asked, as in any routine.
   */
  | { type: "conversation"; channelId: string; threadId: string | null; reminder?: boolean; forUserId?: string }
  /**
   * Redoes a widget in place (ADR 0135 §4): its runs speak only through `update_widget`. Its schedule, instructions
   * and name follow the widget (`syncWidgetRoutine`); people change them from the widget, never here.
   */
  | { type: "widget"; widgetId: string; dashboardId: string };
export const ROUTINE_EVENTS = [
  "sentry.issue_created",
  "github.pr_opened",
  "issue.created",
  "deploy.succeeded",
  /** New mail in a watched mailbox folder (only through an `email` trigger: it needs a watch). */
  "email.received",
  /** A call to the routine's own address (only through a `webhook` trigger: ADR 0106). */
  "webhook.received",
] as const;
export type RoutineEvent = (typeof ROUTINE_EVENTS)[number];
/**
 * The webhook an event comes through (`webhooks.ts`): a routine on it never runs while the workspace has none. The
 * GitHub App's own webhook (`github-app-installs.ts`) keeps installations in step and fires no routine.
 */
export const EVENT_WEBHOOK: Partial<Record<RoutineEvent, "github" | "sentry">> = {
  "github.pr_opened": "github",
  "deploy.succeeded": "github",
  "sentry.issue_created": "sentry",
};

/**
 * The service whose webhook an event routine would wait on when the workspace has none that ever delivered (null:
 * something can fire it). An agent's routine that could never fire is refused at creation (I7); people see
 * `needs_webhook` and set it up from the routine (`webhookSetup`).
 */
export async function missingEventSource(
  db: Executor,
  orgId: string,
  event: RoutineEvent,
): Promise<"github" | "sentry" | null> {
  const provider = EVENT_WEBHOOK[event];
  if (!provider) return null;
  const [hook] = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.orgId, orgId),
        eq(webhookEndpoints.provider, provider),
        isNull(webhookEndpoints.revokedAt),
        isNotNull(webhookEndpoints.lastDeliveryAt),
      ),
    )
    .limit(1);
  return hook ? null : provider;
}

export type RoutineTrigger =
  | {
      type: "schedule";
      phrase: string;
      /** Empty when only the rule can say it ("a cada 2 semanas"). */
      cron: string;
      timezone: string;
      description: string;
      /** The structured form (always present when it can be derived; null for exotic cron). */
      rule: ScheduleRule | null;
    }
  | { type: "event"; event: RoutineEvent }
  /** A one-off (reminders): fires once at `at`, then the routine is done (inactive). */
  | { type: "once"; at: string; timezone: string; description: string }
  /**
   * New mail in a mailbox folder (ADR 0038), filtered; stored as the event
   * `email.received` plus a `mail_watches` row. `status`: the watch's state
   * (`needs_reconnect` when the mailbox must be reconnected).
   */
  | {
      type: "email";
      accountId: string;
      folder: string;
      filter: MailFilter;
      status?: "active" | "needs_reconnect" | "error";
    }
  /**
   * A call to its own address (ADR 0106), stored as the event `webhook.received` plus a `routine_hooks` row. `url`
   * only for who may manage it (null for everyone else and for agents); `signed`: calls must carry a signature.
   */
  | { type: "webhook"; url: string | null; signed: boolean; methods: HookMethod[] }
  /**
   * A connector's event (ADR 0130): stored as a webhook routine whose address the provider was given through the
   * connection (`routine_hooks.source`). `status` `error`: the provider refused it (`lastError`).
   */
  | {
      type: "connector";
      connectionId: string;
      event: ConnectorEventId;
      inboxId: string | null;
      filter: ConnectorTriggerFilter;
      status: "active" | "error";
      lastError: string | null;
    };

/**
 * A routine run as Rotinas shows it (ADR 0053 §5): the open ledger states read with its agent run
 * (`queued`, `running`, `waiting` for a person or a computer), then its one end as stored.
 */
export type RoutineRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "reported"
  | "silent"
  | "failed"
  | "canceled"
  | "superseded"
  | "missed"
  | "skipped";

export interface RoutineRunView {
  id: string;
  at: string;
  status: RoutineRunStatus;
  /** The coded reason of a skip, miss, failure or stop (the app translates it); `stopped` carries `by`. */
  code: string | null;
  codeParams?: Record<string, string>;
  /** Its record or report, cut in `recentRuns`; '' when the viewer may not see what routines read. */
  summary: string;
  /** Recent runs only: its cost (tokens on a plan) relative to the priciest of them (0–1). A share, never money. */
  weight?: number;
  /** The brain that ran it (`model`, `claude_code`, `codex`). */
  brain: string | null;
  /** The agent's message people saw (its report), for readers. */
  link: { channelId: string; threadId: string | null; messageId: string } | null;
  /** While it waits for a person: the approval it waits on, if any (readers only). */
  approvalId?: string | null;
  finishedAt: string | null;
}

/** How much of a run's record a routine's list carries (`recentRuns`); its runs' own list has it whole. */
const RECORD_EXCERPT = 500;

/** How many recent runs each routine carries in the list (its run strip). */
export const RECENT_RUNS = 14;

/** The window of a routine's health and usage ("this week"). */
export const ROUTINE_WEEK_MS = 7 * 86_400_000;

/** What a routine is doing now, for its line in Rotinas (`needs_webhook`: its event has no way in, `EVENT_WEBHOOK`). */
export type RoutineState =
  | "active"
  | "paused"
  | "running"
  | "waiting_computer"
  | "waiting_person"
  | "usage_paused"
  | "failing"
  | "needs_webhook";

export interface RoutineView {
  id: string;
  name: string;
  agentId: string;
  /** Null when the viewer may not see it (a DM, Drive or private-channel routine they don't read). */
  prompt: string | null;
  target: RoutineTarget;
  trigger: RoutineTrigger;
  active: boolean;
  nextRunAt: string | null;
  createdAt: string;
  access: RoutineAccess;
  report: RoutineReport;
  /** Connected-app actions its runs do without asking (`routines.own_actions`): the job its creator set it up for. */
  ownActions: string[];
  /** Why it paused itself (a coded reason the app translates); null when a person paused it, or it runs. */
  pausedReason: string | null;
  failuresInRow: number;
  state: RoutineState;
  /** Its run waits for the agent's computer since then. */
  waitingFor: { machineId: string; machineName: string; since: string } | null;
  /**
   * Its run waits on its plan or budget (`usage_paused`): paused near the limit (ADR 0118) or stopped at it (`limit`).
   * It picks up at `resetsAt` (null: not known yet). `extraOff`: a plan pause whose window is used up, on an agent whose switch keeps long work
   * off paid extra usage, so Continuar agora is refused (`pauseContinuesPastPlan`); `extraUsedUp`: the same with the
   * switch on but no extra usage left. Who may press it: `canManage`.
   */
  usagePause: {
    source: "plan" | "budget";
    resetsAt: string | null;
    /** Stopped at the limit itself (not paused near it): nothing to continue, it runs after the reset. */
    limit: boolean;
    /** The plan it waits for in words ("Claude", "ChatGPT"); null for a budget. */
    plan: string | null;
    extraOff: boolean;
    extraUsedUp: boolean;
  } | null;
  /** Where it thinks: the agent's brain and, for a computer brain, the computer's name. */
  brain: { kind: BrainKind; machineName: string | null };
  /**
   * The last week's runs by outcome (`ok`: reported; `skipped`: slots that didn't run, replaced ones too, as in
   * the run strip; `total`: their sum, without the runs a person stopped).
   */
  health: { ok: number; silent: number; failed: number; skipped: number; missed: number; total: number };
  /** The viewer reads its records and reports (its creator, admins, the agent's owner, its conversation). */
  canSeeDetails: boolean;
  /** The viewer may change, pause, stop or delete it (its creator, admins, the agent's owner). */
  canManage: boolean;
  /** Whose reach it has (ADR 0053 §2): its creator, kept on edit; null once they left. */
  createdByUserId: string | null;
  lastRun: RoutineRunView | null;
  /** The last runs, newest first (at most RECENT_RUNS). */
  recentRuns: RoutineRunView[];
  /** The last week: runs that started the agent, tokens and cost; `plan` when a computer brain's plan paid. */
  usage: { runs: number; tokens: number; costNanoUsd: number; billedTo: "api" | "plan" | "mixed" };
  /** Actions approved ahead for its runs (or waiting to be) that may still run, soonest first; readers only. */
  ahead: RoutineAheadView[];
  /** A widget's routine (ADR 0135 §4): the widget it redoes, which it opens; absent for any other routine. */
  widget?: { id: string; dashboardId: string; title: string } | null;
}

export interface RoutineInput {
  name?: string;
  agentId: string;
  prompt: string;
  target: RoutineTarget;
  /** `timezone`: IANA zone the phrase is read in; default: the creator's, then the org's, then UTC. */
  trigger: RoutineTriggerInput;
  /** What it may do while nobody watches (default `read`). */
  access?: RoutineAccess;
  /** When it speaks (default `when_new`). */
  report?: RoutineReport;
  /** Connected-app actions its job needs, done without asking (`ownActionsOf`); only who decides the agent's approvals sets them. */
  ownActions?: string[];
  /** Created paused: no next run, so the active-routine cap doesn't apply. */
  paused?: boolean;
}

export type RoutineTriggerInput =
  /** A phrase ("a cada 2 semanas na segunda às 9h") or a structured rule (the period picker). */
  | {
      type: "schedule";
      phrase?: string;
      /** `freq: "once"` (the picker's "once") becomes a one-off at its first day and time. */
      rule?: Omit<ScheduleRule, "freq"> & { freq: ScheduleRule["freq"] | "once" };
      timezone?: string;
    }
  | { type: "event"; event: RoutineEvent }
  /** Once, at this moment (ISO 8601). */
  | { type: "once"; at: string; timezone?: string }
  /** New mail in a mailbox the routine's agent can read; `folder` default the inbox. */
  | { type: "email"; accountId: string; folder?: string; filter?: MailFilter }
  /**
   * A call to an address of its own (made with it, kept while its trigger changes). `methods`: the HTTP methods it
   * answers (default POST; left out on a change, what it had).
   */
  | { type: "webhook"; methods?: string[] }
  /** A connector's event (ADR 0130), from a connection the routine's agent may read. */
  | {
      type: "connector";
      connectionId: string;
      event: ConnectorEventId;
      inboxId?: string | null;
      filter?: ConnectorTriggerFilter;
    };

export interface RoutineDeps {
  db: Database;
  pubsub: PubSub;
  /** Reads schedule phrases (`schedulesOf`: the org's cheap model, `kind=summary`). */
  context?: ContextDeps;
  /** Mail adapters: email routines on Gmail/Outlook create and delete Composio triggers. */
  mail?: MailAdapters | null;
  /** Webhook routines' addresses: needed to make one, and to show it to who manages the routine. */
  hooks?: RoutineHookConfig;
  /** Connector events' webhooks are registered at the provider through the connection (ADR 0130). */
  connectors?: ConnectorTriggerDeps;
}

type RoutineRow = typeof routines.$inferSelect;
type RunRow = typeof routineRuns.$inferSelect;

const targetOf = (r: RoutineRow) => r.target as unknown as RoutineTarget;

/** The widget a widget routine redoes ('' for any other routine). */
const widgetIdOf = (r: RoutineRow) => {
  const t = targetOf(r);
  return t.type === "widget" ? t.widgetId : "";
};

/** The board of a widget routine's widget ('' for any other routine). */
const widgetBoardOf = (r: RoutineRow) => {
  const t = targetOf(r);
  return t.type === "widget" ? t.dashboardId : "";
};

/**
 * Routines lists a widget's routine only while the widget updates on a schedule (ADR 0135 §4): one that updates only
 * when asked has no slot of its own to show.
 */
const listedInRoutines = (r: RoutineRow) => targetOf(r).type !== "widget" || Boolean(r.cron);

/** The next slot of a scheduled routine after `after`: its rule, else its cron (older routines). */
export function nextRoutineTime(r: Pick<RoutineRow, "rule" | "cron" | "timezone">, after: Date): Date | null {
  if (r.rule) return nextOccurrence(r.rule as unknown as ScheduleRule, after);
  return r.cron ? nextCronTime(r.cron, r.timezone ?? "UTC", after) : null;
}

/** Slots of a scheduled routine in [from, to) (the calendar). */
export function routineSlots(r: Pick<RoutineRow, "rule" | "cron" | "timezone">, from: Date, to: Date, limit = 200) {
  if (r.rule) return ruleOccurrences(r.rule as unknown as ScheduleRule, from, to, limit);
  const out: Date[] = [];
  let at = r.cron ? nextCronTime(r.cron, r.timezone ?? "UTC", new Date(from.getTime() - 1)) : null;
  while (at && at < to && out.length < limit) {
    out.push(at);
    at = nextCronTime(r.cron as string, r.timezone ?? "UTC", at);
  }
  return out;
}

function triggerOf(
  r: RoutineRow,
  watch?: MailWatchRow,
  hook?: { url: string | null; signed: boolean; methods: HookMethod[]; source?: ConnectorTriggerSource | null },
): RoutineTrigger {
  if (r.triggerType === "event" && r.event === WEBHOOK_EVENT && hook?.source) {
    const s = hook.source;
    return {
      type: "connector",
      connectionId: s.connectionId,
      event: s.event,
      inboxId: s.inboxId ?? null,
      filter: s.filter,
      status: s.status ?? "active",
      lastError: s.lastError ?? null,
    };
  }
  if (r.triggerType === "event" && r.event === WEBHOOK_EVENT) {
    return {
      type: "webhook",
      url: hook?.url ?? null,
      signed: hook?.signed ?? false,
      methods: hook?.methods ?? [...DEFAULT_HOOK_METHODS],
    };
  }
  if (r.triggerType === "event" && r.event === "email.received" && watch) {
    return {
      type: "email",
      accountId: watch.accountId,
      folder: watch.folder,
      filter: watch.filter,
      status: watch.status as "active" | "needs_reconnect" | "error",
    };
  }
  if (r.triggerType === "event") return { type: "event", event: (r.event ?? "issue.created") as RoutineEvent };
  if (r.triggerType === "once") {
    return {
      type: "once",
      at: (r.nextRunAt ?? r.lastRunAt ?? r.createdAt).toISOString(),
      timezone: r.timezone ?? "UTC",
      description: r.description ?? "",
    };
  }
  return {
    type: "schedule",
    phrase: r.phrase ?? "",
    cron: r.cron ?? "",
    timezone: r.timezone ?? "UTC",
    description: r.description ?? "",
    rule: (r.rule as ScheduleRule | null) ?? (r.cron ? cronToRule(r.cron, r.timezone ?? "UTC") : null),
  };
}

/** A routine run's agent run, as the views read it. */
type AgentRunInfo = {
  id: string;
  status: string;
  error: string | null;
  waitingMachineId: string | null;
  /** What it waits on when that's its plan's limit or its budget (`USAGE_WAIT_CODES`). */
  waitingCode: string | null;
  /** A long-work pause's (`usage_pause`): on what. Any usage wait: when the limit resets, and the plan's name. */
  waitSource: string | null;
  resetsAt: string | null;
  plan: string | null;
  /** Continuar agora was pressed on it: back at work as soon as its job runs. */
  continued: boolean;
  updatedAt: Date;
};

/** The ledger's open states: the run hasn't ended. */
const OPEN_RUN = ["queued", "starting", "started"];
/** The ledger's ends, shown as stored. */
const ENDED_RUN = new Set(["reported", "silent", "failed", "canceled", "superseded", "missed", "skipped"]);
/** An agent run still working or waiting. */
const AGENT_ACTIVE = new Set(["queued", "running", "waiting_approval", "waiting_input"]);
/** Waiting for a person (an approval, an answer). A wait for the plan or the budget resumes by itself: still running. */
const agentWaiting = (a: AgentRunInfo | undefined) =>
  a?.status === "waiting_approval" || (a?.status === "waiting_input" && !USAGE_WAIT_CODES.has(a.waitingCode ?? ""));
/** Waiting for its computer (ADR 0032 §5), not for a person. */
const agentAway = (a: AgentRunInfo | undefined) => a?.status === "waiting_input" && Boolean(a.waitingMachineId);
/**
 * Waiting on its plan or budget: paused near the limit (ADR 0118) or stopped at it, and not continued. It says so
 * until its job picks it up, past the reset too: a slot that is still waiting is not "running".
 */
const usageWaiting = (a: AgentRunInfo | undefined) =>
  a?.status === "waiting_input" && USAGE_WAIT_CODES.has(a.waitingCode ?? "") && !a.continued;
/**
 * Not an email run held for the next email (§6.8): that row stays queued with no job on purpose and is no
 * run yet, so no view shows it and it never makes a routine look busy.
 */
const NOT_HELD = sql`not (${routineRuns.status} = 'queued' and coalesce(${routineRuns.event}->>'held', '') = 'true')`;

/** How a stored end reads; anything else that ended (`ok`: a reminder) was delivered. */
const endedAs = (status: string): RoutineRunStatus | null =>
  OPEN_RUN.includes(status) ? null : ENDED_RUN.has(status) ? (status as RoutineRunStatus) : "reported";

/** A run's status: its open state read with its agent run (queued, running, waiting), else its end as stored. */
function runStatus(run: RunRow, agentRun: AgentRunInfo | undefined): RoutineRunStatus {
  if (run.status === "queued" || run.status === "starting") return "queued";
  if (run.status !== "started") return endedAs(run.status) ?? "running";
  // For a person (an approval, an answer) or for its computer.
  if (agentWaiting(agentRun) || usageWaiting(agentRun)) return "waiting";
  // Its agent run ended but the ledger isn't closed yet (the reaper closes it): its outcome already.
  if (agentRun?.status === "done") return "silent";
  if (agentRun?.status === "failed") return "failed";
  if (agentRun?.status === "canceled") return "canceled";
  return "running";
}

/** What run views read besides the rows: agent runs, usage, linked messages, approvals, who stopped them. */
interface RunDetails {
  agentRuns: Map<string, AgentRunInfo>;
  usage: Map<string, { cost: number; tokens: number }>;
  links: Map<string, { channelId: string; threadId: string | null }>;
  /** The pending approval each waiting agent run waits on. */
  approvals: Map<string, string>;
  names: Map<string, string>;
}

/** Every token a call used (as the usage page counts them). */
const TOKENS = sql`${usageRecords.inputTokens} + ${usageRecords.outputTokens}
  + ${usageRecords.cacheReadTokens} + ${usageRecords.cacheWriteTokens}`;

/** A lookup that runs only when there is something to look up (else no rows, no round trip). */
function lookup<T>(keys: readonly unknown[], query: () => PromiseLike<T[]>): Promise<T[]> {
  return keys.length === 0 ? Promise.resolve([]) : Promise.resolve(query());
}

async function runDetails(db: Database, orgId: string, runs: RunRow[]): Promise<RunDetails> {
  const ids = runs.flatMap((r) => (r.agentRunId ? [r.agentRunId] : []));
  const messageIds = runs.flatMap((r) => (r.messageId ? [r.messageId] : []));
  const [agentRows, usageRows, linkRows] = await Promise.all([
    lookup(ids, () =>
      db
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          error: agentRuns.error,
          waitingMachineId: agentRuns.waitingMachineId,
          waitingCode: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'code'`,
          waitSource: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'source'`,
          resetsAt: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'resetsAt'`,
          plan: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'plan'`,
          continued: sql<boolean>`(${agentRuns.transcript}->'usagePause'->'override') is not null`,
          updatedAt: agentRuns.updatedAt,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.id, ids))),
    ),
    lookup(ids, () =>
      db
        .select({
          runId: usageRecords.runId,
          cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`,
          tokens: sql<string>`coalesce(sum(${TOKENS}), 0)`,
        })
        .from(usageRecords)
        .where(and(eq(usageRecords.orgId, orgId), inArray(usageRecords.runId, ids)))
        .groupBy(usageRecords.runId),
    ),
    lookup(messageIds, () =>
      db
        .select({ id: messages.id, channelId: messages.channelId, threadId: messages.threadId })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), inArray(messages.id, messageIds))),
    ),
  ]);
  const waiting = agentRows.filter((a) => a.status === "waiting_approval").map((a) => a.id);
  // Who stopped a run: in its agent run's error, or kept on the routine run when it never started one.
  const stoppers = [
    ...new Set([
      ...agentRows.flatMap((a) => canceledBy(a.error) ?? []),
      ...runs.flatMap((r) => (r.status === "canceled" && r.summary ? [r.summary] : [])),
    ]),
  ];
  const [approvalRows, nameRows] = await Promise.all([
    lookup(waiting, () =>
      db
        .select({ id: approvals.id, runId: approvals.runId })
        .from(approvals)
        .where(and(eq(approvals.orgId, orgId), inArray(approvals.runId, waiting), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.createdAt)),
    ),
    lookup(stoppers, () =>
      db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, stoppers)),
    ),
  ]);
  const pending = new Map<string, string>();
  for (const a of approvalRows) if (a.runId && !pending.has(a.runId)) pending.set(a.runId, a.id);
  return {
    agentRuns: new Map(agentRows.map((a) => [a.id, a])),
    usage: new Map(usageRows.map((u) => [u.runId ?? "", { cost: Number(u.cost), tokens: Number(u.tokens) }])),
    links: new Map(linkRows.map((m) => [m.id, { channelId: m.channelId, threadId: m.threadId }])),
    approvals: pending,
    names: new Map(nameRows.map((u) => [u.id, u.name])),
  };
}

/** One run; `detailed`: the viewer reads the routine's records (else only its outcome). */
function runView(run: RunRow, details: RunDetails, detailed: boolean): RoutineRunView {
  const agentRun = run.agentRunId ? details.agentRuns.get(run.agentRunId) : undefined;
  const status = runStatus(run, agentRun);
  // Stopped by a person: their name (the stop cancels the agent run in their name; a run that never
  // started keeps who stopped it on its row). A canceled run shows no text of its own.
  const stopper =
    run.status === "canceled" ? (canceledBy(agentRun?.error) ?? (run.summary ? run.summary : null)) : null;
  const by = stopper ? details.names.get(stopper) : undefined;
  const link = detailed && run.messageId ? details.links.get(run.messageId) : undefined;
  const approvalId = detailed && run.agentRunId ? (details.approvals.get(run.agentRunId) ?? null) : null;
  // A provider's failure says its cause and its words, for who reads the records: the code alone says only "an error".
  const failure = detailed && status === "failed" ? providerFailure(agentRun?.error) : null;
  const cause = failure?.errorParams?.provider ? failure : null;
  return {
    id: run.id,
    at: run.at.toISOString(),
    status,
    // Waiting for its computer, not for a person: the app says which.
    code: cause
      ? cause.errorCode.replace(/^run\./, "")
      : status !== "waiting"
        ? run.code
        : agentAway(agentRun)
          ? "waiting_computer"
          : usageWaiting(agentRun)
            ? agentRun?.waitingCode === "budget" || agentRun?.waitSource === "budget"
              ? "waiting_budget"
              : "waiting_plan"
            : run.code,
    ...(by ? { codeParams: { by } } : cause ? { codeParams: cause.errorParams } : {}),
    summary: detailed && run.status !== "canceled" ? run.summary : "",
    brain: run.brain,
    link: link && run.messageId ? { ...link, messageId: run.messageId } : null,
    ...(status === "waiting" ? { approvalId } : {}),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/**
 * A routine's recent runs, each with its weight in the run strip: its cost as a share of the priciest
 * of them, or its tokens when none cost anything (a computer brain's plan pays).
 */
function recentViews(runs: RunRow[], details: RunDetails, detailed: boolean): RoutineRunView[] {
  const used = (r: RunRow) => details.usage.get(r.agentRunId ?? "") ?? { cost: 0, tokens: 0 };
  const byCost = runs.some((r) => used(r).cost > 0);
  const amount = (r: RunRow) => (byCost ? used(r).cost : used(r).tokens);
  const max = Math.max(0, ...runs.map(amount));
  return runs.map((r) => {
    const view = runView(r, details, detailed);
    return {
      ...view,
      summary: replyExcerpt(view.summary, RECORD_EXCERPT),
      weight: max > 0 ? Math.round((amount(r) / max) * 100) / 100 : 0,
    };
  });
}

/** The conversation a routine reports to (a channel, a thread's, a DM); null for DM and Drive routines. */
const conversationOf = (t: RoutineTarget) => (t.type === "channel" || t.type === "conversation" ? t.channelId : null);

/** What a viewer may see of each routine (ADR 0053 §9). */
interface ViewerRights {
  /** Reads its prompt, records and reports: its creator, admins, the agent's owner, its conversation's members. */
  reads: boolean;
  /** Changes, pauses, stops or deletes it: its creator, admins, the agent's owner. */
  manages: boolean;
  /** Its prompt is shown even to who doesn't read it (a public channel's). */
  publicPrompt: boolean;
  /** Withdraws what was approved ahead for its runs: who manages it, and who may approve the agent's actions. */
  cancelsAhead: boolean;
}

/**
 * The rights of `viewerId` on each routine; null `viewerId` is the engine itself (an agent's read tool
 * filters on its own): it reads everything and manages nothing.
 */
async function viewerRights(
  db: Database,
  orgId: string,
  rows: RoutineRow[],
  viewerId: string | null,
): Promise<Map<string, ViewerRights>> {
  const channelIds = [...new Set(rows.flatMap((r) => conversationOf(targetOf(r)) ?? []))];
  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  const [member, owners, channelRows, joined] = await Promise.all([
    lookup(viewerId ? [viewerId] : [], () =>
      db
        .select({
          may: maySql(orgId, viewerId ?? "", "manage_routines"),
          approves: maySql(orgId, viewerId ?? "", "approve_actions"),
        })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, viewerId ?? ""))),
    ),
    db
      .select({ id: agents.id, ownerUserId: agents.ownerUserId })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds))),
    lookup(channelIds, () =>
      db
        .select({ id: channels.id, kind: channels.kind, visibility: channels.visibility })
        .from(channels)
        .where(and(eq(channels.orgId, orgId), inArray(channels.id, channelIds))),
    ),
    lookup(viewerId ? channelIds : [], () =>
      db
        .select({ channelId: channelMembers.channelId })
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.orgId, orgId),
            eq(channelMembers.userId, viewerId ?? ""),
            inArray(channelMembers.channelId, channelIds),
          ),
        ),
    ),
  ]);
  const [me] = member;
  const admin = me?.may === true;
  const ownerOf = new Map(owners.map((a) => [a.id, a.ownerUserId]));
  const publicChannels = new Set(
    channelRows.filter((c) => c.kind === "channel" && c.visibility === "public").map((c) => c.id),
  );
  const inChannel = new Set(joined.map((m) => m.channelId));
  const out = new Map<string, ViewerRights>();
  for (const r of rows) {
    const target = targetOf(r);
    const channelId = conversationOf(target);
    const manages = !!viewerId && (admin || r.createdByUserId === viewerId || ownerOf.get(r.agentId) === viewerId);
    out.set(r.id, {
      manages,
      reads: !viewerId || manages || (!!channelId && inChannel.has(channelId)),
      publicPrompt: !!channelId && publicChannels.has(channelId),
      cancelsAhead: manages || me?.approves === true,
    });
  }
  return out;
}

const BRAINS: readonly BrainKind[] = ["model", "claude_code", "codex", "cursor", "opencode", "grok", "antigravity"];
const brainKindOf = (v: unknown): BrainKind => (BRAINS.includes(v as BrainKind) ? (v as BrainKind) : "model");

/** Who paid the week: a computer brain's plan, the API, or both; no usage yet: what its brain would bill. */
function billedTo(
  used: { plan: boolean; api: boolean } | undefined,
  kind: BrainKind,
): RoutineView["usage"]["billedTo"] {
  if (used?.plan && used.api) return "mixed";
  if (used?.plan) return "plan";
  if (used?.api) return "api";
  return kind === "model" ? "api" : "plan";
}

/**
 * Routines as `viewerId` sees them (see `viewerRights`), with their state, last week's health and usage; a webhook
 * routine's address only for who manages it, and only with `hooks`. In a workspace closed to work (suspended, or
 * being deleted) none has a next run: its slots pass.
 */
async function views(
  db: Database,
  rows: RoutineRow[],
  viewerId: string | null,
  hooks?: RoutineHookConfig,
  now = new Date(),
): Promise<RoutineView[]> {
  const first = rows[0];
  if (!first) return [];
  const orgId = first.orgId;
  const closed = closedRefusal(await orgStanding(db, orgId)) !== null;
  const ids = rows.map((r) => r.id);
  const since = new Date(now.getTime() - ROUTINE_WEEK_MS);
  // The last RECENT_RUNS of each routine (one query, ranked per routine).
  const recentIds = await db.execute(sql`
    select id from (
      select ${routineRuns.id} as id,
        row_number() over (partition by ${routineRuns.routineId} order by ${routineRuns.createdAt} desc) as n
      from ${routineRuns}
      where ${inArray(routineRuns.routineId, ids)} and ${NOT_HELD}
    ) ranked
    where n <= ${RECENT_RUNS}`);
  const recentRunIds = rowsOf<{ id: string }>(recentIds).map((r) => r.id);
  const recentRows = await lookup(recentRunIds, () =>
    db.select().from(routineRuns).where(inArray(routineRuns.id, recentRunIds)).orderBy(desc(routineRuns.createdAt)),
  );
  const recent = new Map<string, RunRow[]>();
  for (const r of recentRows) recent.set(r.routineId, [...(recent.get(r.routineId) ?? []), r]);
  const inWeek = and(eq(routineRuns.orgId, orgId), inArray(routineRuns.routineId, ids), gte(routineRuns.at, since));
  const webhookOf = (r: RoutineRow) => (r.triggerType === "event" ? EVENT_WEBHOOK[r.event as RoutineEvent] : undefined);
  const wantedHooks = [...new Set(rows.flatMap((r) => webhookOf(r) ?? []))];
  const [details, rights, watches, hookKeys, weekRows, usageRows, agentRows, hookRows, ahead] = await Promise.all([
    runDetails(db, orgId, recentRows),
    viewerRights(db, orgId, rows, viewerId),
    watchesOf(
      db,
      rows.filter((r) => r.event === "email.received").map((r) => r.id),
    ),
    routineHookKeys(
      db,
      rows.filter((r) => r.event === WEBHOOK_EVENT).map((r) => r.id),
    ),
    db
      .select({
        routineId: routineRuns.routineId,
        status: routineRuns.status,
        runs: sql<number>`count(*)::int`,
        started: sql<number>`count(${routineRuns.agentRunId})::int`,
      })
      .from(routineRuns)
      .where(inWeek)
      .groupBy(routineRuns.routineId, routineRuns.status),
    db
      .select({
        routineId: routineRuns.routineId,
        tokens: sql<string>`coalesce(sum(${TOKENS}), 0)`,
        cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`,
        plan: sql<boolean>`coalesce(bool_or(${usageRecords.billedTo} = 'plan'), false)`,
        api: sql<boolean>`coalesce(bool_or(${usageRecords.billedTo} <> 'plan'), false)`,
      })
      .from(routineRuns)
      .innerJoin(usageRecords, eq(usageRecords.runId, routineRuns.agentRunId))
      .where(inWeek)
      .groupBy(routineRuns.routineId),
    db
      .select({
        id: agents.id,
        brain: agents.brain,
        machineId: agents.machineId,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, [...new Set(rows.map((r) => r.agentId))]))),
    lookup(wantedHooks, () =>
      db
        .selectDistinct({ provider: webhookEndpoints.provider })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.orgId, orgId),
            isNull(webhookEndpoints.revokedAt),
            isNotNull(webhookEndpoints.lastDeliveryAt),
            inArray(webhookEndpoints.provider, wantedHooks),
          ),
        ),
    ),
    routinesAhead(db, orgId, ids, viewerId, now),
  ]);
  const hooked = new Set(hookRows.map((h) => h.provider));
  const machineIds = [
    ...new Set([
      ...agentRows.flatMap((a) => a.machineId ?? []),
      ...[...details.agentRuns.values()].flatMap((a) => a.waitingMachineId ?? []),
    ]),
  ];
  const machineRows = await lookup(machineIds, () =>
    db
      .select({ id: machines.id, name: machines.name })
      .from(machines)
      .where(and(eq(machines.orgId, orgId), inArray(machines.id, machineIds))),
  );
  const machineName = new Map(machineRows.map((m) => [m.id, m.name]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  // A widget's routine is shown with its widget (ADR 0135 §4).
  const widgetIds = [...new Set(rows.map(widgetIdOf).filter(Boolean))];
  const widgetRows = await lookup(widgetIds, () =>
    db
      .select({ id: dashboardWidgets.id, dashboardId: dashboardWidgets.dashboardId, title: dashboardWidgets.title })
      .from(dashboardWidgets)
      .where(and(eq(dashboardWidgets.orgId, orgId), inArray(dashboardWidgets.id, widgetIds))),
  );
  const widgetById = new Map(widgetRows.map((w) => [w.id, w]));
  const week = new Map<string, { status: string; runs: number; started: number }[]>();
  for (const w of weekRows) {
    const entry = { status: w.status, runs: Number(w.runs), started: Number(w.started) };
    week.set(w.routineId, [...(week.get(w.routineId) ?? []), entry]);
  }
  const usageOf = new Map(usageRows.map((u) => [u.routineId, u]));
  const hookUrls = new Map<string, string>();
  if (hooks) {
    for (const [routineId, hook] of hookKeys) {
      if (rights.get(routineId)?.manages) hookUrls.set(routineId, await liveHookUrl(db, hooks, hook));
    }
  }
  // Paused plan runs Continuar agora would take past the plan with extra usage off: their button is greyed.
  const pastPlan = new Map<string, PastPlanReason>();
  for (const a of details.agentRuns.values()) {
    if (a.waitingCode !== "usage_pause" || a.waitSource === "budget" || !usageWaiting(a)) continue;
    const reason = await pauseContinuesPastPlan(db, orgId, a.id);
    if (reason) pastPlan.set(a.id, reason);
  }
  return rows.map((r): RoutineView => {
    const right = rights.get(r.id) as ViewerRights;
    const lastRuns = recent.get(r.id) ?? [];
    const runs = recentViews(lastRuns, details, right.reads);
    // Its runs in progress: queued or being started (held emails are left out above), or whose agent run
    // still works or waits (also after handing off).
    const open = lastRuns.filter((run) => {
      if (run.status === "queued" || run.status === "starting") return true;
      if (run.status !== "started" && run.status !== "reported") return false;
      const agentRun = run.agentRunId ? details.agentRuns.get(run.agentRunId) : undefined;
      return AGENT_ACTIVE.has(agentRun?.status ?? "");
    });
    const openAgents = open.flatMap((run) => {
      const agentRun = run.agentRunId ? details.agentRuns.get(run.agentRunId) : undefined;
      return agentRun ? [agentRun] : [];
    });
    const away = openAgents.find(agentAway);
    const waitingFor = away?.waitingMachineId
      ? {
          machineId: away.waitingMachineId,
          machineName: machineName.get(away.waitingMachineId) ?? "",
          since: away.updatedAt.toISOString(),
        }
      : null;
    const agent = agentById.get(r.agentId);
    const kind = brainKindOf(agent?.brain);
    const paused = openAgents.find(usageWaiting);
    const usagePause = paused
      ? {
          source:
            paused.waitSource === "budget" || paused.waitingCode === "budget" ? ("budget" as const) : ("plan" as const),
          resetsAt: paused.resetsAt,
          limit: paused.waitingCode !== "usage_pause",
          plan: paused.plan ?? (isComputerBrain(kind) ? BRAIN_PLAN_NAMES[kind] : null),
          extraOff: pastPlan.get(paused.id) === "extra_off",
          extraUsedUp: pastPlan.get(paused.id) === "extra_used_up",
        }
      : null;
    const hook = webhookOf(r);
    // A run at work says what it does first (a manual run of a paused routine, a one-off's run after it
    // fired: both inactive, both stoppable); paused, unable to run, failing or active only when nothing is at work.
    const state: RoutineState = waitingFor
      ? "waiting_computer"
      : openAgents.some(agentWaiting)
        ? "waiting_person"
        : usagePause
          ? "usage_paused"
          : open.length > 0
            ? "running"
            : !r.active
              ? "paused"
              : hook && !hooked.has(hook)
                ? "needs_webhook"
                : r.failuresInRow > 0
                  ? "failing"
                  : "active";
    const outcomes = new Map<string, number>();
    let started = 0;
    for (const w of week.get(r.id) ?? []) {
      started += w.started;
      const end = endedAs(w.status);
      if (end) outcomes.set(end, (outcomes.get(end) ?? 0) + w.runs);
    }
    const count = (status: RoutineRunStatus) => outcomes.get(status) ?? 0;
    // The week as the app says it, adding up: a slot the next one replaced is a skip (as in the run strip),
    // and a run a person stopped says nothing about the routine, so it counts nowhere.
    const health = {
      ok: count("reported"),
      silent: count("silent"),
      failed: count("failed"),
      skipped: count("skipped") + count("superseded"),
      missed: count("missed"),
    };
    const used = usageOf.get(r.id);
    const hookKey = hookKeys.get(r.id);
    return {
      id: r.id,
      name: r.name,
      agentId: r.agentId,
      prompt: right.reads || right.publicPrompt ? r.prompt : null,
      target: targetOf(r),
      trigger: triggerOf(
        r,
        watches.get(r.id),
        hookKey && {
          url: hookUrls.get(r.id) ?? null,
          signed: hookKey.signed,
          methods: hookKey.methods,
          source: hookKey.source,
        },
      ),
      active: r.active,
      nextRunAt: r.active && r.nextRunAt && !closed ? r.nextRunAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      access: routineAccessOf(r.access),
      report: routineReportOf(r.report),
      ownActions: r.ownActions,
      pausedReason: r.active ? null : r.pausedReason,
      failuresInRow: r.failuresInRow,
      state,
      waitingFor,
      usagePause,
      brain: {
        kind,
        machineName: kind !== "model" && agent?.machineId ? (machineName.get(agent.machineId) ?? null) : null,
      },
      health: { ...health, total: health.ok + health.silent + health.failed + health.skipped + health.missed },
      canSeeDetails: right.reads,
      canManage: right.manages,
      createdByUserId: r.createdByUserId,
      lastRun: runs[0] ?? null,
      recentRuns: runs,
      usage: {
        runs: started,
        tokens: Number(used?.tokens ?? 0),
        costNanoUsd: Number(used?.cost ?? 0),
        billedTo: billedTo(used, kind),
      },
      ahead: right.reads ? (ahead.get(r.id) ?? []).map((a) => ({ ...a, canCancel: right.cancelsAhead })) : [],
      ...(targetOf(r).type === "widget" ? { widget: widgetById.get(widgetIdOf(r)) ?? null } : {}),
    };
  });
}

/** One routine as the person sees it (after a stop or a take-over, for instance). */
export async function getRoutineView(
  db: Database,
  actorId: string,
  orgId: string,
  id: string,
  hooks?: RoutineHookConfig,
) {
  await requirePermission(db, actorId, orgId, "read");
  const row = await loadRoutine(db, orgId, id);
  if (!(await routineSeer(db, orgId, actorId))(row)) throw new NotFoundError("Routine not found");
  const [view] = await views(db, [row], actorId, hooks);
  return view as RoutineView;
}

/** The reader of schedule phrases; none without the context deps (then only cron expressions are read). */
const readerOf = (deps: RoutineDeps) => (deps.context ? schedulesOf(deps.context) : null);

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** The zone a person's routine phrase means: the one they chose, else their own, else the org's, else UTC. */
export async function routineTimezone(db: Database, actorId: string, orgId: string, chosen?: string | null) {
  if (chosen) {
    if (!isTimeZone(chosen))
      throw new ValidationError("Unknown time zone", "schedule.unknown_timezone", { timezone: chosen });
    return chosen;
  }
  const settings = await getOrgSettings(db, actorId, orgId);
  const [me] = await db
    .select({ timezone: schema.organizationMembers.timezone })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, actorId)));
  return me?.timezone || settings.timezone || "UTC";
}

/** A schedule phrase (any language) → cron and rule in the creator's time zone, read by the schedule reader. */
export async function parseScheduleForOrg(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  phrase: string,
  timezone?: string | null,
): Promise<ScheduleParse> {
  const zone = await routineTimezone(deps.db, actorId, orgId, timezone);
  return parseSchedule(readerOf(deps), { orgId, phrase, timezone: zone });
}

/**
 * The trigger columns of a routine, validated like on create; `nextRunAt` computed from now. `keepZone`:
 * the zone an edit keeps when none is given (the routine's own, not the editor's).
 */
async function resolveTrigger(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  trigger: RoutineTriggerInput,
  keepZone: string | null = null,
) {
  const none = {
    phrase: null as string | null,
    cron: null as string | null,
    timezone: null as string | null,
    description: null as string | null,
    event: null as string | null,
    rule: null as Record<string, unknown> | null,
  };
  // The picker's "once": a one-off at its first day and time (a time skipped by DST moves forward).
  if (trigger.type === "schedule" && (trigger.rule?.freq as string | undefined) === "once") {
    const rule = trigger.rule as unknown as ScheduleRule;
    const zone = await routineTimezone(deps.db, actorId, orgId, rule.timezone ?? trigger.timezone ?? keepZone);
    const [y, m, d] = (rule.start ?? "").split("-").map(Number) as [number, number, number];
    const [h, mi] = (rule.times?.[0] ?? rule.time ?? "09:00").split(":").map(Number) as [number, number];
    const at = y && m && d ? zonedTimeForward(y, m, d, h, mi, zone) : null;
    if (!at) throw new ValidationError("Pick the day and time", "routine.once_needs_time");
    return resolveTrigger(deps, actorId, orgId, { type: "once", at: at.toISOString(), timezone: zone });
  }
  if (trigger.type === "schedule") {
    const now = new Date();
    const phrase = trigger.phrase?.trim() ?? "";
    const zone = await routineTimezone(deps.db, actorId, orgId, trigger.rule?.timezone ?? trigger.timezone ?? keepZone);
    if (!trigger.rule && !phrase)
      throw new ValidationError("Say when the routine should run", "routine.schedule_required");
    // A rule from the picker as it is; a phrase read by the schedule reader (a rule, a cron, or a one-off).
    const reading = trigger.rule ? null : await readSchedule(readerOf(deps), { orgId, phrase, timezone: zone, now });
    if (reading && !reading.ok) throw new ValidationError(reading.error, reading.code, reading.params);
    if (reading?.type === "once") {
      return resolveTrigger(deps, actorId, orgId, { type: "once", at: reading.at.toISOString(), timezone: zone });
    }
    if (reading?.type === "cron") {
      return {
        ...none,
        triggerType: "schedule",
        phrase,
        cron: reading.cron,
        timezone: zone,
        description: reading.description,
        nextRunAt: reading.next as Date | null,
      };
    }
    const rule = reading ? reading.rule : normalizeRule({ ...trigger.rule, timezone: zone } as ScheduleRule, now);
    const next = nextOccurrence(rule, now);
    if (!next) throw new ValidationError("This schedule never happens (or the series ended)", "schedule.never");
    return {
      ...none,
      triggerType: "schedule",
      phrase: phrase || null,
      cron: ruleToCron(rule),
      timezone: rule.timezone,
      description: describeRule(rule),
      rule: rule as unknown as Record<string, unknown>,
      nextRunAt: next as Date | null,
    };
  }
  if (trigger.type === "once") {
    const at = new Date(trigger.at);
    if (Number.isNaN(at.getTime())) throw new ValidationError("Invalid date and time", "schedule.invalid_datetime");
    if (at.getTime() <= Date.now()) throw new ValidationError("Pick a moment in the future", "schedule.in_the_past");
    const timezone = await routineTimezone(deps.db, actorId, orgId, trigger.timezone ?? keepZone);
    // English, for the model and as a fallback; the app shows `at` in its own words.
    const description = describeWhen(at, timezone);
    return { ...none, triggerType: "once", timezone, description, nextRunAt: at as Date | null };
  }
  if (trigger.type === "email") {
    if (!trigger.accountId) throw new ValidationError("Pick a mailbox", "routine.mail_account_not_found");
    normalizeMailFilter(trigger.filter);
    return { ...none, triggerType: "event", event: "email.received" as string | null, nextRunAt: null as Date | null };
  }
  if (trigger.type === "webhook" || trigger.type === "connector") {
    if (trigger.type === "connector") {
      if (!isConnectorEvent(trigger.event)) throw new ValidationError("Unknown event", "routine.unknown_event");
      if (trigger.inboxId && !UUID.test(trigger.inboxId)) {
        throw new ValidationError("Pick an inbox", "routine.connector_inbox_invalid");
      }
      normalizeConnectorFilter(trigger.filter);
    }
    return { ...none, triggerType: "event", event: WEBHOOK_EVENT as string | null, nextRunAt: null as Date | null };
  }
  // Mail events need a mailbox and a folder, webhook calls an address: only through their own triggers.
  if (!ROUTINE_EVENTS.includes(trigger.event) || trigger.event === "email.received" || trigger.event === WEBHOOK_EVENT)
    throw new ValidationError("Unknown event", "routine.unknown_event");
  return { ...none, triggerType: "event", event: trigger.event as string | null, nextRunAt: null as Date | null };
}

/** Admins, or the agent's owner. */
async function requireRoutineManager(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  if (can(membership, "manage_routines")) return;
  const agent = await getAgent(db, orgId, agentId);
  if (agent?.ownerUserId !== actorId) throw new ForbiddenError("Only an admin or the agent's owner can do this");
}

/**
 * Where a routine reports must take it: the agent is in that conversation, and its creator (who stays
 * accountable for what it says there) can post in it. `creatorId` null: the creator is gone (the routine
 * pauses when it fires).
 */
async function checkTarget(
  db: Database,
  orgId: string,
  agentId: string,
  target: RoutineTarget,
  creatorId: string | null,
) {
  if (target.type !== "channel" && target.type !== "conversation") return;
  const [row] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channels.id, target.channelId), eq(channels.orgId, orgId), eq(channelMembers.agentId, agentId)));
  if (!row)
    throw new ValidationError(
      "Add the agent to the channel before creating the routine",
      "routine.agent_not_in_channel",
    );
  if (!creatorId) return;
  const access = await requireChannelAccess(db, creatorId, orgId, target.channelId).catch(() => null);
  if (!access || !can(access.membership, "post")) {
    throw new ValidationError(
      "Who created the routine must be in that conversation and able to post there",
      "routine.creator_cannot_post",
    );
  }
}

/** The shortest time between two runs of a routine that starts agent runs (ADR 0053 §6.5). */
export const MIN_ROUTINE_INTERVAL_MS = 15 * 60_000;
/** Active routines an agent may have at once. */
export const MAX_ACTIVE_ROUTINES = 20;
/** How far ahead a schedule's real occurrences are checked against the minimum interval. */
const FREQUENCY_WINDOW_MS = 400 * 86_400_000;

/** Whether a routine starts agent runs: reminders only post, one-offs fire once (both exempt from the limits). */
const startsRuns = (triggerType: string, target: RoutineTarget) =>
  triggerType !== "once" && !(target.type === "conversation" && target.reminder);

/**
 * Refuses a schedule whose real occurrences (DST and month ends included) come closer than the
 * minimum interval anywhere in the next year.
 */
export function checkFrequency(
  r: Pick<RoutineRow, "triggerType" | "rule" | "cron" | "timezone">,
  target: RoutineTarget,
) {
  if (r.triggerType !== "schedule" || !startsRuns(r.triggerType, target)) return;
  const now = new Date();
  const slots = routineSlots(r, now, new Date(now.getTime() + FREQUENCY_WINDOW_MS), 300);
  for (let i = 1; i < slots.length; i++) {
    if ((slots[i] as Date).getTime() - (slots[i - 1] as Date).getTime() < MIN_ROUTINE_INTERVAL_MS) {
      throw new ValidationError("A routine can run at most every 15 minutes", "routine.too_frequent", {
        minutes: MIN_ROUTINE_INTERVAL_MS / 60_000,
      });
    }
  }
}

/** Refuses one more active routine (one that starts runs) for an agent that has the most it may have. */
async function checkRoutineCap(db: Database, orgId: string, agentId: string, exceptId?: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.agentId, agentId),
        eq(routines.active, true),
        isNull(routines.deletedAt),
        ne(routines.triggerType, "once"),
        sql`coalesce(${routines.target}->>'reminder', 'false') <> 'true'`,
        // A widget's routine counts in the workspace's cap of scheduled widgets instead (ADR 0135 §7).
        sql`coalesce(${routines.target}->>'type', '') <> 'widget'`,
        exceptId ? ne(routines.id, exceptId) : undefined,
      ),
    );
  if (Number(row?.n ?? 0) >= MAX_ACTIVE_ROUTINES) {
    throw new ValidationError(
      `An agent can have at most ${MAX_ACTIVE_ROUTINES} active routines: pause or delete one first`,
      "routine.too_many",
      { max: MAX_ACTIVE_ROUTINES },
    );
  }
}

/**
 * A routine's own actions as sent: trimmed and unique, each a tool name (or a Composio action's slug). Merge, deploy,
 * rollback and the rest that always ask a person at the time are refused (`alwaysAsks`), so nobody thinks they're on.
 */
export function ownActionsOf(list: readonly string[]): string[] {
  const out = [...new Set(list.map((a) => a.trim()).filter(Boolean))];
  if (out.length > MAX_OWN_ACTIONS) {
    throw new ValidationError(`At most ${MAX_OWN_ACTIONS} actions on its own`, "routine.too_many_actions", {
      max: MAX_OWN_ACTIONS,
    });
  }
  for (const action of out) {
    if (!OWN_ACTION_NAME.test(action)) {
      throw new ValidationError(`Not a tool name: ${action}`, "routine.action_invalid", { action });
    }
    if (alwaysAsks(action)) {
      throw new ValidationError(
        `${action} always asks a person at the time (merge, deploy, rollback and the like): leave it out`,
        "routine.action_always_asks",
        { action },
      );
    }
  }
  return out;
}

/** A routine acts on its own only by the word of someone who could approve those actions themselves. */
async function requireActionApprover(db: Database, actorId: string, orgId: string, ownerUserId: string | null) {
  if (await decidesAgentApprovals(db, orgId, actorId, ownerUserId)) return;
  throw new ForbiddenError(
    "Only the agent's owner or someone who approves its actions can let a routine act on its own",
    "routine.actions_need_approver",
  );
}

const emailWatch = (t: Extract<RoutineTriggerInput, { type: "email" }>) => ({
  accountId: t.accountId,
  folder: t.folder?.trim() || "INBOX",
  filter: t.filter ?? {},
});

export async function createRoutine(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  input: RoutineInput,
): Promise<RoutineView> {
  const { db } = deps;
  await requireRoutineManager(db, actorId, orgId, input.agentId);
  const agent = await getAgent(db, orgId, input.agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  // A routine asks the agent on its creator's behalf: only people who can talk to it create one.
  if (!canTalkTo(agent, actorId, await speakerFor(db, orgId, actorId))) throw await audienceError(db, agent);
  const prompt = input.prompt.trim().slice(0, 10_000);
  if (!prompt) throw new ValidationError("Say what the agent should do", "routine.prompt_required");
  await checkTarget(db, orgId, agent.id, input.target, actorId);
  const trigger = await resolveTrigger(deps, actorId, orgId, input.trigger);
  checkFrequency(trigger, input.target);
  if (!input.paused && startsRuns(trigger.triggerType, input.target)) await checkRoutineCap(db, orgId, agent.id);
  if (input.trigger.type === "email") await checkWatchable(db, orgId, agent.id, input.trigger.accountId);
  if (input.trigger.type === "connector") await checkConnectorTrigger(db, orgId, agent.id, input.trigger);
  const hooks = input.trigger.type === "webhook" || input.trigger.type === "connector" ? hooksOf(deps) : null;
  const ownActions = ownActionsOf(input.ownActions ?? []);
  if (ownActions.length > 0) await requireActionApprover(db, actorId, orgId, agent.ownerUserId);
  const name = input.name?.trim().slice(0, 120) || prompt.split("\n")[0]?.slice(0, 60) || "Routine";
  const [row] = await db
    .insert(routines)
    .values({
      orgId,
      agentId: agent.id,
      name,
      prompt,
      target: input.target as unknown as Record<string, unknown>,
      ...trigger,
      ...(input.paused ? { active: false, nextRunAt: null } : {}),
      access: routineAccessOf(input.access),
      report: routineReportOf(input.report),
      ownActions,
      createdByUserId: actorId,
    })
    .returning();
  if (!row) throw new Error("routine insert returned nothing");
  if (input.trigger.type === "email") await syncMailWatch(deps, row, emailWatch(input.trigger));
  // A connector's provider posts its events: its address answers POST whatever a webhook trigger had chosen.
  if (hooks)
    await ensureRoutineHook(
      db,
      hooks,
      row,
      input.trigger.type === "webhook" ? input.trigger.methods : DEFAULT_HOOK_METHODS,
    );
  if (input.trigger.type === "connector") await syncConnector(deps, row, connectorSource(input.trigger));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "routine.created",
    target: { type: "routine", id: row.id },
    details: {
      agentId: agent.id,
      trigger: input.trigger.type,
      access: row.access,
      report: row.report,
      ownActions: row.ownActions,
    },
  });
  await publishListChanged(deps.pubsub, orgId, "routines");
  const [view] = await views(db, [row], actorId, deps.hooks);
  return view as RoutineView;
}

const connectorSource = (t: Extract<RoutineTriggerInput, { type: "connector" }>) => ({
  connectionId: t.connectionId,
  event: t.event,
  ...(t.inboxId ? { inboxId: t.inboxId.toLowerCase() } : {}),
  filter: t.filter ?? {},
});

/** The connector event a routine waits on now (ADR 0130), as `syncConnector` takes it; null: none. */
async function connectorOf(db: Database, routineId: string) {
  const source = (await routineHookKeys(db, [routineId])).get(routineId)?.source;
  if (!source) return null;
  const { externalId: _e, status: _s, lastError: _l, ...rest } = source;
  return rest;
}

/** Keeps the provider's webhook for a routine's connector event in step with it, at the routine's address. */
async function syncConnector(
  deps: RoutineDeps,
  row: RoutineRow,
  next: Omit<ConnectorTriggerSource, "externalId" | "status" | "lastError"> | null,
) {
  const hook = (await routineHookKeys(deps.db, [row.id])).get(row.id);
  if (!hook) return;
  const url = deps.hooks ? await liveHookUrl(deps.db, deps.hooks, hook) : null;
  await syncConnectorTrigger(deps.db, deps.connectors, row, url, next);
}

/** The addresses' config, which a webhook routine can't be made without (the server always passes it). */
function hooksOf(deps: RoutineDeps): RoutineHookConfig {
  if (!deps.hooks) throw new Error("webhook routines need the server's address and secret");
  return deps.hooks;
}

/** The organization's routines as the person sees them (ADR 0053 §9: outcomes only where they don't read). */
export async function listRoutines(db: Database, actorId: string, orgId: string, hooks?: RoutineHookConfig) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select()
    .from(routines)
    .where(and(eq(routines.orgId, orgId), isNull(routines.deletedAt)))
    .orderBy(routines.createdAt);
  const sees = await routineSeer(db, orgId, actorId);
  // A widget's routine shows only to who sees its board (ADR 0135 §8): a private board's are its owner's alone.
  const boardIds = [...new Set(rows.map(widgetBoardOf).filter(Boolean))];
  const viewer = viewerOf(membership, actorId);
  const boards = await lookup(boardIds, () =>
    db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.orgId, orgId), inArray(dashboards.id, boardIds))),
  );
  const seenBoards = new Set(boards.filter((b) => dashboardRights(b, viewer).see).map((b) => b.id));
  const listed = (r: RoutineRow) => listedInRoutines(r) && (!widgetBoardOf(r) || seenBoards.has(widgetBoardOf(r)));
  return views(
    db,
    rows.filter((r) => sees(r) && listed(r)),
    actorId,
    hooks,
  );
}

/**
 * Whether `viewerId` sees a routine at all (its name, schedule, runs): who manages it (its creator, admins, the
 * agent's owner), who manages agents, or who the agent answers. The agents list's own rule (`listsAgent` in the
 * apps), so an agent hidden from someone doesn't show through its routines on Início, Rotinas or the calendar.
 */
export async function routineSeer(
  db: Database,
  orgId: string,
  viewerId: string,
): Promise<(r: Pick<RoutineRow, "agentId" | "createdByUserId">) => boolean> {
  const [membership, agentRows] = await Promise.all([
    getMembership(db, viewerId, orgId),
    db
      .select({
        id: agents.id,
        ownerUserId: agents.ownerUserId,
        audienceMode: agents.audienceMode,
        audienceUserIds: agents.audienceUserIds,
        audienceRoleIds: agents.audienceRoleIds,
        consultable: agents.consultable,
        brain: agents.brain,
      })
      .from(agents)
      .where(eq(agents.orgId, orgId)),
  ]);
  if (can(membership, "manage_routines") || can(membership, "manage_agents")) return () => true;
  const talks = speakerOf(membership);
  const listed = new Set(agentRows.filter((a) => canTalkTo(a, viewerId, talks)).map((a) => a.id));
  return (r) => r.createdByUserId === viewerId || listed.has(r.agentId);
}

/**
 * The org's routines for an agent's read tool (`list_routines` with `agent`):
 * no person check here, the caller is an agent of the org and filters what it
 * may show (audiences, private conversations). Optionally one agent's only.
 * With `viewerId` (the person behind the run), prompts and run records as that person sees them in Settings › Rotinas.
 */
export async function listOrgRoutines(
  db: Database,
  orgId: string,
  options: { agentId?: string; viewerId?: string | null } = {},
) {
  const rows = await db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        isNull(routines.deletedAt),
        options.agentId ? eq(routines.agentId, options.agentId) : undefined,
      ),
    )
    .orderBy(routines.createdAt);
  return views(db, rows, options.viewerId ?? null);
}

async function loadRoutine(db: Database, orgId: string, id: string, options: { deleted?: boolean } = {}) {
  const [row] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.id, id), eq(routines.orgId, orgId)));
  if (!row || (row.deletedAt && !options.deleted)) throw new NotFoundError("Routine not found");
  return row;
}

/** Edit: its creator, admins, or the agent's owner. */
async function requireRoutineEditor(db: Database, actorId: string, orgId: string, routine: RoutineRow) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  if (routine.createdByUserId === actorId || can(membership, "manage_routines")) return;
  const agent = await getAgent(db, orgId, routine.agentId);
  if (agent?.ownerUserId !== actorId) {
    throw new ForbiddenError(
      "Only who created the routine, the agent's owner or an admin can change it",
      "routine.editor_only",
    );
  }
}

/**
 * A webhook routine whose address the person manages (ADR 0106): its creator, admins or the agent's owner, as for
 * editing it. One without a webhook is not found.
 */
export async function managedWebhookRoutine(db: Database, actorId: string, orgId: string, id: string) {
  const routine = await loadRoutine(db, orgId, id);
  await requireRoutineEditor(db, actorId, orgId, routine);
  if (routine.event !== WEBHOOK_EVENT) {
    throw new NotFoundError("This routine isn't started by a webhook", "routine.no_webhook");
  }
  return routine;
}

export interface RoutinePatch {
  name?: string;
  prompt?: string;
  agentId?: string;
  trigger?: RoutineTriggerInput;
  target?: RoutineTarget;
  /** `true` resumes it: the reason it paused itself and its failure streak are cleared. */
  active?: boolean;
  access?: RoutineAccess;
  report?: RoutineReport;
  /**
   * Replaces its own actions (`RoutineInput.ownActions`): adding one takes its creator, when they decide the agent's
   * approvals; any editor may take them away.
   */
  ownActions?: string[];
}

/**
 * Edits a routine (`PATCH …/routines/{id}`), validated like create: a new
 * agent must be one the person manages and can talk to; the target is
 * checked against the agent and the routine's creator; a new schedule is
 * parsed again in the routine's own zone (unless one is given), checked
 * against the minimum interval, and `nextRunAt` recomputed; resuming counts
 * against the agent's active routines. Audited with the before/after of what
 * changed.
 */
export async function updateRoutine(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  id: string,
  patch: RoutinePatch,
): Promise<RoutineView> {
  const { db } = deps;
  const current = await loadRoutine(db, orgId, id);
  await requireRoutineEditor(db, actorId, orgId, current);
  // A widget's routine follows its widget (ADR 0135 §4): only pausing and resuming it happen here.
  if (
    targetOf(current).type === "widget" &&
    (patch.name !== undefined ||
      patch.prompt !== undefined ||
      patch.agentId !== undefined ||
      patch.trigger !== undefined ||
      patch.target !== undefined ||
      patch.report !== undefined ||
      patch.ownActions !== undefined)
  ) {
    throw new ForbiddenError(WIDGET_ROUTINE_FIXED, "routine.widget_fixed");
  }
  const set: Partial<typeof routines.$inferInsert> = {};
  const agentId = patch.agentId ?? current.agentId;
  if (patch.agentId !== undefined && patch.agentId !== current.agentId) {
    await requireRoutineManager(db, actorId, orgId, patch.agentId);
    set.agentId = patch.agentId;
  }
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (set.agentId && !canTalkTo(agent, actorId, await speakerFor(db, orgId, actorId)))
    throw await audienceError(db, agent);
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 120);
    if (!name) throw new ValidationError("Give the routine a name", "routine.name_required");
    set.name = name;
  }
  if (patch.prompt !== undefined) {
    const prompt = patch.prompt.trim().slice(0, 10_000);
    if (!prompt) throw new ValidationError("Say what the agent should do", "routine.prompt_required");
    set.prompt = prompt;
  }
  const target = patch.target ?? targetOf(current);
  if (patch.target !== undefined || set.agentId) {
    await checkTarget(db, orgId, agentId, target, current.createdByUserId);
    if (patch.target !== undefined) set.target = target as unknown as Record<string, unknown>;
  }
  if (patch.access !== undefined) set.access = routineAccessOf(patch.access);
  if (patch.report !== undefined) set.report = routineReportOf(patch.report);
  if (patch.ownActions !== undefined) {
    const ownActions = ownActionsOf(patch.ownActions);
    if (JSON.stringify(ownActions) !== JSON.stringify(current.ownActions)) {
      // Taking actions away only makes it ask more, so any of its editors may; adding one is its creator's word.
      if (ownActions.some((a) => !current.ownActions.includes(a))) {
        if (actorId !== current.createdByUserId) {
          throw new ForbiddenError(
            "Take the routine over before changing what it does on its own",
            "routine.act_take_over",
          );
        }
        await requireActionApprover(db, actorId, orgId, agent.ownerUserId);
      }
      set.ownActions = ownActions;
    }
  }
  // A routine reaches what its creator reaches (their rooms, the agents they talk to), so only its
  // creator may decide what it does with that; anyone else takes it over first.
  if (
    actorId !== current.createdByUserId &&
    ((set.prompt !== undefined && set.prompt !== current.prompt) || set.agentId !== undefined)
  ) {
    throw new ForbiddenError("Take the routine over before setting what it does as it acts", "routine.act_take_over");
  }
  if (patch.trigger !== undefined) {
    Object.assign(set, await resolveTrigger(deps, actorId, orgId, patch.trigger, current.timezone));
  }
  // A mail routine's agent must be able to read the mailbox it watches.
  const watched = await watchesOf(db, [current.id]);
  const mailTrigger =
    patch.trigger?.type === "email"
      ? emailWatch(patch.trigger)
      : patch.trigger === undefined && watched.get(current.id)
        ? (({ accountId, folder, filter }) => ({ accountId, folder, filter }))(watched.get(current.id) as MailWatchRow)
        : null;
  if (mailTrigger && (patch.trigger?.type === "email" || set.agentId)) {
    await checkWatchable(db, orgId, agentId, mailTrigger.accountId);
  }
  // A connector routine's agent must be able to read the connection it waits on (ADR 0130).
  const hadConnector = await connectorOf(db, current.id);
  const connectorTrigger =
    patch.trigger?.type === "connector"
      ? connectorSource(patch.trigger)
      : patch.trigger === undefined
        ? hadConnector
        : null;
  if (connectorTrigger && (patch.trigger?.type === "connector" || set.agentId)) {
    await checkConnectorTrigger(db, orgId, agentId, connectorTrigger);
  }
  const active = patch.active ?? current.active;
  if (patch.active !== undefined) set.active = active;
  // A person resumes it: whatever paused it is behind it.
  if (patch.active === true) {
    set.pausedReason = null;
    set.failuresInRow = 0;
  }
  const resuming = active && (!current.active || Boolean(set.agentId));
  const triggerType = set.triggerType ?? current.triggerType;
  if (patch.trigger !== undefined || patch.target !== undefined || resuming) {
    checkFrequency({ ...current, ...set } as RoutineRow, target);
  }
  if (resuming && startsRuns(triggerType, target)) await checkRoutineCap(db, orgId, agentId, current.id);
  // Next slot: from the (new) trigger, only while active; paused routines have none.
  if (patch.trigger !== undefined || patch.active !== undefined) {
    set.nextRunAt = !active
      ? null
      : triggerType === "schedule"
        ? nextRoutineTime({ ...current, ...set } as RoutineRow, new Date())
        : triggerType === "once"
          ? (set.nextRunAt ?? current.nextRunAt)
          : null;
  }
  const hooks = patch.trigger?.type === "webhook" || patch.trigger?.type === "connector" ? hooksOf(deps) : null;
  const changed = Object.keys(set).filter((k) => k !== "nextRunAt") as (keyof typeof set)[];
  if (changed.length === 0 && set.nextRunAt === undefined) {
    const [view] = await views(db, [current], actorId, deps.hooks);
    return view as RoutineView;
  }
  const [row] = await db
    .update(routines)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(routines.id, current.id), eq(routines.orgId, orgId)))
    .returning();
  if (!row) throw new NotFoundError("Routine not found");
  // What was approved ahead covered its next run at that time, for that agent: a run moved or gone (paused: a
  // one-off resumed never fires again) or another agent needs a new approval.
  const moved = current.nextRunAt?.getTime() !== row.nextRunAt?.getTime();
  if (moved || row.agentId !== current.agentId) {
    await cancelRoutineAhead(deps, orgId, row.id, actorId);
  }
  if (mailTrigger || watched.has(current.id)) {
    if (mailTrigger && patch.active === true && !current.active) await resetMailWatchState(db, row.id);
    await syncMailWatch(deps, row, mailTrigger);
  }
  if (hooks)
    await ensureRoutineHook(
      db,
      hooks,
      row,
      patch.trigger?.type === "webhook" ? patch.trigger.methods : DEFAULT_HOOK_METHODS,
    );
  if (connectorTrigger || hadConnector) await syncConnector(deps, row, connectorTrigger);
  // Pausing also stops its work in progress (§6.7); resuming clears why it paused itself.
  if (patch.active === false && current.active) {
    await haltRoutineRuns(deps, orgId, row.id, { code: "paused", byUserId: actorId });
  } else if (patch.active === true && !current.active) {
    await resolveRoutinePaused(deps, orgId, row.id).catch(() => {});
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of changed) {
    before[key] = current[key as keyof RoutineRow];
    after[key] = row[key as keyof RoutineRow];
  }
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "routine.updated",
    target: { type: "routine", id: row.id },
    details: { before, after },
  });
  await publishListChanged(deps.pubsub, orgId, "routines");
  const [view] = await views(db, [row], actorId, deps.hooks);
  return view as RoutineView;
}

/** Why a widget's routine isn't changed here (ADR 0135 §4). */
export const WIDGET_ROUTINE_FIXED = "This routine keeps a widget up to date: change it from its widget";

/** Deletes a routine: it never fires again and its work in progress stops (§6.7); its run history stays. */
export async function deleteRoutine(deps: RoutineDeps, actorId: string, orgId: string, id: string) {
  const current = await loadRoutine(deps.db, orgId, id);
  await requireRoutineEditor(deps.db, actorId, orgId, current);
  await dropRoutine(deps, actorId, current);
}

/** A deleted agent's routines are deleted with it (ADR 0082), each as `deleteRoutine` does. */
export async function deleteAgentRoutines(deps: RoutineDeps, actorId: string, orgId: string, agentId: string) {
  const rows = await deps.db
    .select()
    .from(routines)
    .where(and(eq(routines.orgId, orgId), eq(routines.agentId, agentId), isNull(routines.deletedAt)));
  for (const row of rows) await dropRoutine(deps, actorId, row);
}

/** A deleted channel's routines go with it: those that post there or answer in its conversations. */
export async function deleteChannelRoutines(deps: RoutineDeps, actorId: string, orgId: string, channelId: string) {
  const rows = await deps.db
    .select()
    .from(routines)
    .where(
      and(eq(routines.orgId, orgId), isNull(routines.deletedAt), sql`${routines.target}->>'channelId' = ${channelId}`),
    );
  for (const row of rows) await dropRoutine(deps, actorId, row);
}

async function dropRoutine(deps: RoutineDeps, actorId: string, current: RoutineRow) {
  const orgId = current.orgId;
  await deps.db
    .update(routines)
    .set({ active: false, nextRunAt: null, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(routines.id, current.id));
  await haltRoutineRuns(deps, orgId, current.id, { code: "deleted", byUserId: actorId });
  // Its widget stays, updating only when asked (ADR 0135 §4).
  if (targetOf(current).type === "widget") await widgetRoutineGone(deps, orgId, current.id);
  await cancelRoutineAhead(deps, orgId, current.id, actorId);
  // A mail routine's watch (and its Composio trigger) goes with it.
  await syncMailWatch(deps, current, null);
  await syncConnector(deps, current, null);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "routine.deleted",
    target: { type: "routine", id: current.id },
    details: { name: current.name, agentId: current.agentId },
  });
  await publishListChanged(deps.pubsub, orgId, "routines");
}

/**
 * A copy of a routine, paused (so it doesn't fire twice until someone turns it on), owned by whoever copies it.
 * `name`: the copy's name in the person's language (the app sends it); default "{name} (copy)".
 */
export async function duplicateRoutine(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  id: string,
  options: { name?: string } = {},
) {
  const { db } = deps;
  const current = await loadRoutine(db, orgId, id);
  await requireRoutineManager(db, actorId, orgId, current.agentId);
  // A widget has one routine (ADR 0135 §4): a copy would redo it twice.
  if (targetOf(current).type === "widget") throw new ForbiddenError(WIDGET_ROUTINE_FIXED, "routine.widget_fixed");
  const agent = await getAgent(db, orgId, current.agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!canTalkTo(agent, actorId, await speakerFor(db, orgId, actorId))) throw await audienceError(db, agent);
  // Whoever copies it becomes its creator: they must be able to post where it reports.
  await checkTarget(db, orgId, agent.id, targetOf(current), actorId);
  const { id: _id, createdAt: _c, updatedAt: _u, lastRunAt: _l, deletedAt: _d, ...copy } = current;
  const [row] = await db
    .insert(routines)
    .values({
      ...copy,
      name: (options.name?.trim() || `${current.name} (copy)`).slice(0, 120),
      active: false,
      nextRunAt: null,
      pausedReason: null,
      failuresInRow: 0,
      createdByUserId: actorId,
    })
    .returning();
  if (!row) throw new Error("routine insert returned nothing");
  // A mail routine's copy watches the same mailbox (paused: no Composio trigger until it's turned on).
  const watch = (await watchesOf(db, [current.id])).get(current.id);
  if (watch) {
    await syncMailWatch(deps, row, { accountId: watch.accountId, folder: watch.folder, filter: watch.filter });
  }
  // A webhook routine's copy gets an address of its own, without a signing secret: never the original's.
  if (row.event === WEBHOOK_EVENT && deps.hooks) await ensureRoutineHook(db, deps.hooks, row);
  // A connector routine's copy waits on the same event (paused: no webhook at the provider until it's turned on).
  const connector = await connectorOf(db, current.id);
  if (connector) await syncConnector(deps, row, connector);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "routine.duplicated",
    target: { type: "routine", id: row.id },
    details: { from: current.id },
  });
  await publishListChanged(deps.pubsub, orgId, "routines");
  const [view] = await views(db, [row], actorId, deps.hooks);
  return view as RoutineView;
}

/**
 * Pause (no next run, and its work in progress stops: §6.7) or resume (next run computed from now:
 * missed slots don't pile up; why it paused itself and its failure streak are cleared).
 */
export async function setRoutineActive(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  id: string,
  active: boolean,
): Promise<RoutineView> {
  const current = await loadRoutine(deps.db, orgId, id);
  await requireRoutineManager(deps.db, actorId, orgId, current.agentId);
  const nextRunAt = active && current.triggerType === "schedule" ? nextRoutineTime(current, new Date()) : null;
  const [row] = await deps.db
    .update(routines)
    .set({ active, nextRunAt, updatedAt: new Date(), ...(active ? { pausedReason: null, failuresInRow: 0 } : {}) })
    .where(eq(routines.id, id))
    .returning();
  if (!active) {
    await haltRoutineRuns(deps, orgId, id, { code: "paused", byUserId: actorId });
    await cancelRoutineAhead(deps, orgId, id, actorId);
  } else await resolveRoutinePaused(deps, orgId, id).catch(() => {});
  const watch = row ? (await watchesOf(deps.db, [row.id])).get(row.id) : undefined;
  if (row && watch) {
    if (active && !current.active) await resetMailWatchState(deps.db, row.id);
    await syncMailWatch(deps, row, { accountId: watch.accountId, folder: watch.folder, filter: watch.filter });
  }
  const connector = row ? await connectorOf(deps.db, row.id) : null;
  if (row && connector) await syncConnector(deps, row, connector);
  await publishListChanged(deps.pubsub, orgId, "routines");
  const [view] = await views(deps.db, row ? [row] : [], actorId, deps.hooks);
  return view as RoutineView;
}

/**
 * Queues one slot or manual run of a routine (`routine.run` job); null when that slot already ran.
 * Events go through `fireRoutineEvent` (deduplicated and coalesced).
 */
export async function queueRoutineRun(
  deps: { db: Database },
  routine: RoutineRow,
  at: Date,
  trigger: "schedule" | "manual",
) {
  return deps.db.transaction(async (tx) => {
    const [run] = await tx
      .insert(routineRuns)
      .values({ orgId: routine.orgId, routineId: routine.id, at, trigger })
      .onConflictDoNothing()
      .returning();
    if (!run) return null;
    await enqueueRoutineJob(tx, run);
    return run;
  });
}

/** "Rodar agora". */
export async function runRoutineNow(deps: RoutineDeps, actorId: string, orgId: string, id: string) {
  const routine = await loadRoutine(deps.db, orgId, id);
  await requireRoutineManager(deps.db, actorId, orgId, routine.agentId);
  // A person is waiting on this one: told now, where a scheduled slot just passes.
  await assertCanWork(deps.db, orgId, routine.agentId);
  await queueRoutineRun(deps, routine, new Date(), "manual");
  await publishRoutineRuns(deps.pubsub, orgId, routine.id);
  const [view] = await views(deps.db, [routine], actorId, deps.hooks);
  return view as RoutineView;
}

/** A routine's run history (the last 100), as the person may see it: outcomes only where they don't read it. */
export async function listRoutineRuns(
  db: Database,
  actorId: string,
  orgId: string,
  id: string,
): Promise<RoutineRunView[]> {
  await requirePermission(db, actorId, orgId, "read");
  const routine = await loadRoutine(db, orgId, id, { deleted: true });
  if (!(await routineSeer(db, orgId, actorId))(routine)) throw new NotFoundError("Routine not found");
  const [runs, rights] = await Promise.all([
    db
      .select()
      .from(routineRuns)
      .where(and(eq(routineRuns.orgId, orgId), eq(routineRuns.routineId, routine.id), NOT_HELD))
      .orderBy(desc(routineRuns.at))
      .limit(100),
    viewerRights(db, orgId, [routine], actorId),
  ]);
  const details = await runDetails(db, orgId, runs);
  const reads = rights.get(routine.id)?.reads ?? false;
  return runs.map((r) => runView(r, details, reads));
}

/**
 * When a due routine fires: its slot plus a stable offset into that minute, from its id (0 to 59 s), so the
 * routines of one minute fire as a ramp instead of all at once. Its slot stays what it shows and records
 * (`next_run_at`, the run's `at`): the minute is right.
 */
const firesAt = sql`${routines.nextRunAt} + ((hashtext(${routines.id}::text) & 2147483647) % 60) * interval '1 second'`;

/**
 * Worker tick: fires every scheduled routine whose slot has come (`firesAt`). Each
 * routine is taken with `FOR UPDATE SKIP LOCKED` and a transaction-level
 * advisory lock, and `(routine_id, at)` is unique, so two replicas never
 * fire the same slot. The next slot is computed from now: a routine that
 * missed several slots while the server was down runs once, not in a burst.
 */
export async function fireDueRoutines(deps: RoutineDeps, now = new Date()) {
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.active, true),
          inArray(routines.triggerType, ["schedule", "once"]),
          isNotNull(routines.nextRunAt),
          lte(routines.nextRunAt, now),
          sql`${firesAt} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(firesAt)
      .limit(100)
      .for("update", { skipLocked: true });
    let fired = 0;
    for (const r of due) {
      const lock = rowsOf<{ ok: boolean }>(
        await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`routine:${r.id}`}, 0)) as ok`),
      );
      if (lock[0]?.ok === false) continue;
      const slot = r.nextRunAt as Date;
      const next = r.triggerType === "schedule" ? nextRoutineTime(r, now) : null;
      await tx.update(routines).set({ nextRunAt: next, updatedAt: now }).where(eq(routines.id, r.id));
      const [run] = await tx
        .insert(routineRuns)
        .values({ orgId: r.orgId, routineId: r.id, at: slot, trigger: "schedule" })
        .onConflictDoNothing()
        .returning();
      if (!run) continue;
      await enqueueRoutineJob(tx, run);
      fired++;
    }
    return fired;
  });
}

/**
 * An event happened (webhook, new issue): the routines listening to it run, with the event as data
 * (`routine_runs.event`; the context puts it in the outside-content envelope). `dedupeKey`: the
 * event's identity, so the same event never fires a routine twice; `visibleTo`: only routines whose
 * creator may see what it is about get it. Events arriving while a run is queued join it; while one
 * works, they gather in one run that starts when it ends (`queueEventRun`). Returns how many
 * routines got it.
 */
export async function fireRoutineEvent(
  deps: { db: Database },
  orgId: string,
  event: RoutineEvent,
  payload: { summary: string; [key: string]: unknown },
  options: { dedupeKey?: string | null; visibleTo?: (userId: string) => Promise<boolean> } = {},
) {
  const rows = await deps.db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.active, true),
        isNull(routines.deletedAt),
        eq(routines.triggerType, "event"),
        eq(routines.event, event),
      ),
    );
  let fired = 0;
  for (const r of rows) {
    if (options.visibleTo && !(r.createdByUserId && (await options.visibleTo(r.createdByUserId)))) continue;
    const { outcome } = await queueEventRun(deps, r, {
      event: { ...payload, type: event },
      dedupeKey: options.dedupeKey ?? null,
    });
    if (outcome !== "duplicate") fired++;
  }
  return fired;
}

/** Errors that will never pass on a retry: the run fails instead of the job retrying. */
const isPermanent = (error: unknown) =>
  error instanceof ForbiddenError ||
  error instanceof NotFoundError ||
  error instanceof ValidationError ||
  error instanceof ConflictError ||
  error instanceof PermanentJobError;

/**
 * Job `routine.run` (ADR 0053 §6): claims the routine run (`queued` → `starting`), then fires it.
 * A transient error gives the row back and rethrows, so the job retries; a permanent one fails the
 * run (its ledger and failure streak as on any ending).
 */
export async function executeRoutineRun(deps: RoutineDeps, routineRunId: string) {
  const { db } = deps;
  const run = await claimRoutineRun(db, routineRunId);
  if (!run) return;
  try {
    await fireClaimedRun(deps, run);
  } catch (error) {
    if (!isPermanent(error)) {
      await unclaimRoutineRun(db, run.id).catch(() => {});
      throw error;
    }
    const [row] = await db
      .select({ agentRunId: routineRuns.agentRunId })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id));
    // Its run started before the error: the run's own ending closes it.
    if (row?.agentRunId) return;
    const reason = error instanceof Error ? error.message : String(error);
    await endRoutineRun(
      deps,
      { orgId: run.orgId, routineId: run.routineId, routineRunId: run.id },
      { status: "failed", code: "error", detail: reason.slice(0, 300) },
    );
  }
}

/**
 * Fires a claimed routine run, in order (§6): a deleted or paused routine skips the slot (a manual
 * run is a person's ask, a one-off fires while active); structural checks pause the routine with
 * their coded reason and one notification (creator gone or unable to post where it reports, agent
 * archived, out of the agent's audience, agent not in the conversation); one run at a time
 * (`makeWayForRun`); then the work: a reminder (no run), or the background run in the
 * routine's room, which posts through `hand_off` in the conversation it reports to (`deliverTo`).
 */
async function fireClaimedRun(deps: RoutineDeps, run: RunRow) {
  const { db } = deps;
  const skip = async (code: string) => {
    const skipped = await skipRoutineRun(db, run.id, code);
    // The emails it carried wait for the next run (§6.8).
    if (skipped && run.event?.type === "email.received") await releaseRoutineEmails(deps, run.id);
    return skipped;
  };
  const [routine] = await db.select().from(routines).where(eq(routines.id, run.routineId));
  if (!routine || routine.deletedAt) return skip("deleted");
  // A widget's change request is a person's ask too: it runs while a person keeps that routine paused (ADR 0135 §6).
  if (!routine.active && run.trigger !== "manual" && !isWidgetChangeRun(run)) return skip("paused");
  // Its workspace is on hold or suspended, or its agent held: the slot passes, the routine keeps its
  // schedule (`standing.ts`).
  const refusal = await standingRefusal(db, run.orgId, routine.agentId);
  if (refusal) return skip(refusal.code.replace(".", "_"));
  const paused = async (reason: RoutinePausedReason) => {
    await pauseRoutine(deps, routine, reason);
    // A widget's routine says it on its widget (ADR 0135 §6).
    if (targetOf(routine).type === "widget") await widgetRoutineHeld(deps, routine, reason).catch(() => {});
    return skip(reason);
  };
  const creator = routine.createdByUserId;
  const membership = creator ? await getMembership(db, creator, routine.orgId) : null;
  // Their account waits for its deletion and may come back: the slot passes, the routine keeps its schedule.
  if (creator && !membership && (await deletionPending(db, creator))) return skip("creator_left");
  if (!creator || !membership) return paused("creator_left");
  const agent = await getAgent(db, routine.orgId, routine.agentId);
  if (!agent || agent.archivedAt) return paused("agent_archived");
  // Its creator can no longer talk to the agent.
  if (!canTalkTo(agent, creator, speakerOf(membership))) return paused("audience");
  const once = routine.triggerType === "once";
  // It ran: a one-off is done (it stays listed, inactive).
  const ran = async () => {
    await db
      .update(routines)
      .set({ lastRunAt: new Date(), updatedAt: new Date(), ...(once ? { active: false, nextRunAt: null } : {}) })
      .where(eq(routines.id, routine.id));
    // Run by hand before its time, a one-off never reaches it: what was approved ahead for that time can't run.
    if (once && run.trigger === "manual" && routine.active && routine.nextRunAt) {
      await cancelRoutineAhead(deps, routine.orgId, routine.id, null);
    }
  };
  const target = targetOf(routine);
  const ref = { orgId: routine.orgId, routineId: routine.id, routineRunId: run.id };

  if (target.type === "conversation" && target.reminder) {
    // A plain reminder: the agent's own message, mentioning the person; no run.
    const who = target.forUserId ?? creator;
    const [member] = await db
      .select({ handle: schema.organizationMembers.handle })
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, routine.orgId), eq(schema.organizationMembers.userId, who)));
    const mention = member?.handle ? `@${member.handle} ` : "";
    const message = await db.transaction(async (tx) => {
      const written = await insertMessageWithRuns(
        tx,
        {
          orgId: routine.orgId,
          channelId: target.channelId,
          threadId: target.threadId,
          author: { type: "agent", agentId: agent.id, runId: null, hop: 0, stretchId: null },
          body: `${mention}Reminder: ${routine.prompt}`,
          meta: {
            // The app shows its own "Reminder" label (translated) with this text, without the body's prefix.
            reminderText: routine.prompt,
            reminderFor: who,
            routineId: routine.id,
            routineRunId: run.id,
            routine: { id: routine.id, name: routine.name, runId: run.id },
            reminder: true,
          },
        },
        { startRuns: false },
      );
      await tx
        .update(routineRuns)
        .set({ status: "reported", code: "reminder_sent", messageId: written.message.id, finishedAt: new Date() })
        .where(eq(routineRuns.id, run.id));
      return written.message;
    });
    await publishMessageCreated(deps.pubsub, messageView(message));
    for (const userId of message.mentionedUserIds) {
      await publishUserEvent(deps.pubsub, routine.orgId, userId, {
        type: "mention",
        channelId: target.channelId,
        messageId: message.id,
        threadId: message.threadId,
        byAgentId: agent.id,
      });
    }
    await ran();
    await afterRoutineRunEnded(deps, { ...ref, status: "reported", code: "reminder_sent", event: null });
    return;
  }

  // A widget's refresh (ADR 0135 §4): its widget and board are still there and its creator still sees the board.
  let widget: RoutineBrief["widget"];
  if (target.type === "widget") {
    const firing = await widgetFiring(db, routine.orgId, target, creator, membership);
    if ("skip" in firing) return skip(firing.skip);
    if ("pause" in firing) return paused(firing.pause);
    widget = firing.widget;
  }

  // Where it reports: its channel or the conversation it was asked in, else the creator's DM with the agent.
  let deliverTo: RoutineBrief["deliverTo"];
  if (target.type === "channel" || target.type === "conversation") {
    if (!(await personCanPost(db, routine.orgId, creator, target.channelId))) return paused("creator_no_access");
    // Its run is the creator calling the agent there: a channel exception that takes that away pauses it (ADR 0134).
    const [talks] = await db
      .select({ ok: audienceSql("agents", sql`${creator}::text`, { channelId: sql`${target.channelId}::uuid` }) })
      .from(agents)
      .where(eq(agents.id, agent.id));
    if (!talks?.ok) return paused("audience");
    const [member] = await db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, target.channelId), eq(channelMembers.agentId, agent.id)));
    if (!member) return paused("agent_not_in_channel");
    deliverTo = { channelId: target.channelId, threadId: target.type === "conversation" ? target.threadId : null };
  } else {
    if (!can(membership, "post")) return paused("creator_no_access");
    deliverTo = { channelId: (await openDm(db, creator, routine.orgId, { agentId: agent.id })).id, threadId: null };
  }

  const gate = await makeWayForRun(deps, routine, run);
  if (gate === "gathered") {
    // An event run waits for the one working (it may have just ended).
    await startGatheredRun(deps, routine.id);
    return;
  }
  if (gate) {
    await skip(gate);
    if (once) await ran();
    return;
  }
  const brief: RoutineBrief = {
    routineId: routine.id,
    routineRunId: run.id,
    name: routine.name,
    creatorUserId: creator,
    deliverTo,
    ...(target.type === "artifact" ? { toDrive: true } : {}),
    access: routineAccessOf(routine.access),
    report: routineReportOf(routine.report),
    trigger: run.trigger,
    dueAt: run.at.toISOString(),
    ...(widget ? { widget } : {}),
  };
  // The widget shows it is being redone (its last data stays on screen).
  if (widget) await widgetRunStarting(deps, routine.orgId, widget.widgetId);
  const started = await startRoutineRun(deps, {
    orgId: routine.orgId,
    agentId: agent.id,
    brief,
    body: routine.prompt,
    brain: brainOf(agent.brain),
  });
  // Stopped while it was being started: nothing ran.
  if (!started) return;
  await publishRoutineRuns(deps.pubsub, routine.orgId, routine.id);
  await ran();
}

/**
 * Stop in Rotinas (§6.7): the routine's run in progress is canceled quietly (nothing is posted) and
 * its row ends `canceled` (`stopped`, with who stopped it). Its creator, the agent's owner or an
 * admin. Returns how many runs it stopped.
 */
export async function stopRoutineRun(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  routineId: string,
): Promise<{ stopped: number }> {
  const routine = await loadRoutine(deps.db, orgId, routineId, { deleted: true });
  await requireRoutineEditor(deps.db, actorId, orgId, routine);
  const stopped = await haltRoutineRuns(deps, orgId, routine.id, { code: "stopped", byUserId: actorId });
  if (stopped > 0) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "routine.stopped",
      target: { type: "routine", id: routine.id },
      details: { runs: stopped },
    });
  }
  return { stopped };
}

/**
 * Continuar agora on a routine paused near its plan's or budget's limit (ADR 0118): its creator, admins or the
 * agent's owner (as for stopping it). The run goes on now past the pause line until that window resets, up to the
 * plan's own allowance; going past it with extra usage off is refused with that reason (`assertMayContinuePause`, the
 * card's rule too). Nothing is posted where it reports. Once: a second press, or the run already picked up, does nothing.
 */
export async function continueRoutineUsagePause(
  deps: { db: Database },
  actorId: string,
  orgId: string,
  routineId: string,
): Promise<{ continued: boolean }> {
  const { db } = deps;
  const routine = await loadRoutine(db, orgId, routineId);
  await requireRoutineEditor(db, actorId, orgId, routine);
  const [paused] = await db
    .select({
      runId: agentRuns.id,
      waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
      source: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'source'`,
      resetsAt: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'resetsAt'`,
    })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.orgId, orgId),
        eq(routineRuns.routineId, routine.id),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'usage_pause'`,
      ),
    )
    .orderBy(desc(routineRuns.createdAt))
    .limit(1);
  if (!paused?.waitId) return { continued: false };
  await assertMayContinuePause(db, orgId, paused.runId, "routine");
  const continued = await db.transaction((tx) =>
    overrideUsagePause(tx, {
      orgId,
      runId: paused.runId,
      waitId: paused.waitId as string,
      until: paused.resetsAt,
      userId: actorId,
      details: { routineId: routine.id, source: paused.source ?? "plan" },
    }),
  );
  return { continued };
}

/**
 * Take over (§6.2): an admin or the agent's owner becomes the routine's creator (the one it reports
 * for and who hears about it), after the same checks as creating it: they can talk to the agent and
 * post where it reports. Why it paused itself is cleared; resuming stays a separate choice.
 */
export async function takeOverRoutine(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  routineId: string,
): Promise<RoutineView> {
  const { db } = deps;
  const current = await loadRoutine(db, orgId, routineId);
  await requireRoutineManager(db, actorId, orgId, current.agentId);
  const agent = await getAgent(db, orgId, current.agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!canTalkTo(agent, actorId, await speakerFor(db, orgId, actorId))) throw await audienceError(db, agent);
  const target = targetOf(current);
  if (
    (target.type === "channel" || target.type === "conversation") &&
    !(await personCanPost(db, orgId, actorId, target.channelId))
  ) {
    throw new ForbiddenError(
      "Join the conversation this routine reports to before taking it over",
      "routine.take_over_no_access",
    );
  }
  const [row] = await db
    .update(routines)
    .set({ createdByUserId: actorId, pausedReason: null, updatedAt: new Date() })
    .where(and(eq(routines.id, current.id), eq(routines.orgId, orgId)))
    .returning();
  if (!row) throw new NotFoundError("Routine not found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "routine.taken_over",
    target: { type: "routine", id: row.id },
    details: { from: current.createdByUserId },
  });
  await publishListChanged(deps.pubsub, orgId, "routines");
  await resolveRoutinePaused(deps, orgId, row.id).catch(() => {});
  const [view] = await views(db, [row], actorId, deps.hooks);
  return view as RoutineView;
}

// ── Reminders from the chat (agents' `schedule_reminder`) ────────────────────

export interface ReminderView {
  id: string;
  message: string;
  at: string | null;
  timezone: string;
  description: string;
  /** The person it reminds (default: whoever asked). */
  forUserId: string;
  channelId: string;
  threadId: string | null;
  done: boolean;
}

const reminderView = (r: RoutineRow): ReminderView => {
  const t = targetOf(r) as Extract<RoutineTarget, { type: "conversation" }>;
  return {
    id: r.id,
    message: r.prompt,
    at: r.nextRunAt?.toISOString() ?? null,
    timezone: r.timezone ?? "UTC",
    description: r.description ?? "",
    forUserId: t.forUserId ?? r.createdByUserId ?? "",
    channelId: t.channelId,
    threadId: t.threadId,
    done: !r.active,
  };
};

/**
 * A one-off reminder in the conversation it was asked in (a routine with
 * `trigger: once`, listed in Rotinas, cancellable). The person who asked is
 * its creator: they must be able to talk to the agent and post there.
 */
export async function createReminder(
  deps: RoutineDeps,
  requesterId: string,
  orgId: string,
  input: {
    agentId: string;
    channelId: string;
    threadId: string | null;
    at: Date;
    timezone: string;
    description: string;
    message: string;
    forUserId?: string;
    /** At the time, ask the agent to do it (a run) instead of only reminding. */
    askAgent?: boolean;
  },
): Promise<ReminderView> {
  const { db } = deps;
  const membership = await requirePermission(db, requesterId, orgId, "post");
  const agent = await getAgent(db, orgId, input.agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!canTalkTo(agent, requesterId, speakerOf(membership))) throw await audienceError(db, agent);
  const message = input.message.trim().slice(0, 2000);
  if (!message) throw new ValidationError("Say what to remind", "reminder.text_required");
  if (input.forUserId && input.forUserId !== requesterId) {
    const [member] = await db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, input.channelId), eq(channelMembers.userId, input.forUserId)));
    if (!member) throw new ValidationError("That person isn't in this conversation", "reminder.person_not_here");
  }
  const target: RoutineTarget = {
    type: "conversation",
    channelId: input.channelId,
    threadId: input.threadId,
    reminder: !input.askAgent,
    forUserId: input.forUserId ?? requesterId,
  };
  const [row] = await db
    .insert(routines)
    .values({
      orgId,
      agentId: agent.id,
      // The app marks it as a reminder (translated); the name is just its text.
      name: message.split("\n")[0]?.slice(0, 60) ?? "",
      prompt: message,
      target: target as unknown as Record<string, unknown>,
      triggerType: "once",
      access: "act",
      timezone: input.timezone,
      description: input.description,
      nextRunAt: input.at,
      createdByUserId: requesterId,
    })
    .returning();
  if (!row) throw new Error("reminder insert returned nothing");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: requesterId },
    action: "routine.created",
    target: { type: "routine", id: row.id },
    details: { agentId: agent.id, trigger: "once", via: "agent" },
  });
  return reminderView(row);
}

/**
 * The pending reminders in a range that this person may see: the ones they set or that remind them, and the plain
 * ones of conversations they are in, with an agent they may see (`sees`): those get posted there word for word, while
 * what an agent is asked to do later (`ask_agent`, `schedule_action`) never is. Only who set one can cancel it
 * (`cancelReminder`).
 */
export async function calendarReminders(
  db: Database,
  userId: string,
  orgId: string,
  from: Date,
  to: Date,
  channelIds: ReadonlySet<string>,
  sees: (r: RoutineRow) => boolean,
) {
  const rows = await db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.triggerType, "once"),
        eq(routines.active, true),
        isNull(routines.deletedAt),
        gte(routines.nextRunAt, from),
        lt(routines.nextRunAt, to),
        sql`${routines.target}->>'type' = 'conversation'`,
      ),
    )
    .orderBy(routines.nextRunAt);
  return rows.flatMap((r) => {
    const { id, message, at, forUserId, channelId, threadId } = reminderView(r);
    const canCancel = r.createdByUserId === userId;
    const posted = (targetOf(r) as Extract<RoutineTarget, { type: "conversation" }>).reminder;
    if (!at || !(canCancel || forUserId === userId || (posted && channelIds.has(channelId) && sees(r)))) return [];
    return [
      { id, message, at, forUserId, channelId, threadId, agentId: r.agentId, createdBy: r.createdByUserId, canCancel },
    ];
  });
}

/** The person's pending reminders (created by them), soonest first. */
export async function listReminders(db: Database, requesterId: string, orgId: string) {
  const rows = await db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.createdByUserId, requesterId),
        eq(routines.triggerType, "once"),
        eq(routines.active, true),
      ),
    )
    .orderBy(routines.nextRunAt)
    .limit(50);
  return rows.map(reminderView);
}

/**
 * Cancels one of the person's own reminders, and what was approved ahead for it (`schedule_action`'s one-off);
 * anyone else's is "not found".
 */
export async function cancelReminder(
  deps: { db: Database; pubsub: PubSub },
  requesterId: string,
  orgId: string,
  id: string,
) {
  const { db } = deps;
  const [row] = await db
    .update(routines)
    .set({ active: false, nextRunAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(routines.id, id),
        eq(routines.orgId, orgId),
        eq(routines.createdByUserId, requesterId),
        eq(routines.triggerType, "once"),
        eq(routines.active, true),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Reminder not found");
  await cancelRoutineAhead(deps, orgId, id, requesterId);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: requesterId },
    action: "routine.cancelled",
    target: { type: "routine", id },
  });
  return reminderView(row);
}

// ── Reminders from the app ("Lembrar") ───────────────────────────────────────

/** How far ahead the app may set a reminder. */
export const MAX_REMINDER_AHEAD_MS = 365 * 24 * 3600_000;

/**
 * "Lembrar" in the app: a one-off reminder about a message or a
 * conversation at a set time, the same thing an agent's `schedule_reminder`
 * makes (a routine with `trigger: once`, in Rotinas, cancellable by whoever
 * asked). At that time the agent posts "@you Reminder: …" where the message
 * is: its thread (a top-level channel message gets one), or the DM. That
 * mention notifies the person (and their phone).
 *
 * The agent that reminds: `agentId` when given, else the message's author
 * when it is an agent, else the first agent of the conversation this person
 * can talk to. It must be in the conversation. The text: `text`, else the
 * message's first line.
 */
export async function createReminderFromApp(
  deps: RoutineDeps,
  requesterId: string,
  orgId: string,
  input: {
    channelId: string;
    threadId?: string | null;
    messageId?: string | null;
    agentId?: string | null;
    at: Date;
    text?: string | null;
    timezone?: string | null;
  },
  now = new Date(),
): Promise<ReminderView> {
  const { db } = deps;
  const { channel, membership } = await requireChannelAccess(db, requesterId, orgId, input.channelId);
  if (!can(membership, "post")) throw new ForbiddenError();
  if (Number.isNaN(input.at.getTime()) || input.at.getTime() <= now.getTime()) {
    throw new ValidationError("That time has already passed.", "when.past");
  }
  if (input.at.getTime() - now.getTime() > MAX_REMINDER_AHEAD_MS) {
    throw new ValidationError("At most a year ahead", "when.too_far");
  }
  const inChannel = async (id: string) => {
    const m = await getMessage(db, orgId, id);
    if (!m || m.channelId !== channel.id || m.deletedAt) throw new NotFoundError("Message not found");
    return m;
  };
  const message = input.messageId ? await inChannel(input.messageId) : null;
  let threadId: string | null = null;
  if (input.threadId) {
    const root = await inChannel(input.threadId);
    if (root.threadId) throw new NotFoundError("Thread not found");
    threadId = root.id;
  } else if (message && channel.kind !== "dm") {
    threadId = message.threadId ?? message.id;
  }
  const text = (input.text ?? "").trim() || (message ? replyExcerpt(message.body) : "");
  if (!text) throw new ValidationError("Say what to remind", "reminder.text_required");

  const members = await db
    .select({ agentId: channelMembers.agentId })
    .from(channelMembers)
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channel.id), isNotNull(channelMembers.agentId)),
    );
  const here = members.flatMap((m) => (m.agentId ? [m.agentId] : []));
  let agentId: string | null = null;
  if (input.agentId) {
    if (!here.includes(input.agentId)) {
      throw new ValidationError("That agent isn't in this conversation", "reminder.agent_not_here");
    }
    agentId = input.agentId;
  } else if (message?.authorType === "agent" && message.authorAgentId && here.includes(message.authorAgentId)) {
    agentId = message.authorAgentId;
  } else {
    const talks = await speakerFor(db, orgId, requesterId);
    for (const id of here) {
      const agent = await getAgent(db, orgId, id);
      if (agent && !agent.archivedAt && canTalkTo(agent, requesterId, talks)) {
        agentId = agent.id;
        break;
      }
    }
  }
  if (!agentId) throw new ValidationError("No agent in this conversation can remind you", "reminder.no_agent");

  const timezone = await routineTimezone(db, requesterId, orgId, input.timezone);
  return createReminder(deps, requesterId, orgId, {
    agentId,
    channelId: channel.id,
    threadId,
    at: input.at,
    timezone,
    description: describeWhen(input.at, timezone, now),
    message: text,
  });
}

/** The person's pending reminders in conversations (from the app or asked to an agent), soonest first. */
export async function listMyReminders(db: Database, requesterId: string, orgId: string): Promise<ReminderView[]> {
  await requirePermission(db, requesterId, orgId, "read");
  const rows = await db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.createdByUserId, requesterId),
        eq(routines.triggerType, "once"),
        eq(routines.active, true),
        sql`${routines.target}->>'type' = 'conversation'`,
      ),
    )
    .orderBy(routines.nextRunAt)
    .limit(100);
  return rows.map(reminderView);
}
