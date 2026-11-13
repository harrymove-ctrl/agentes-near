import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, providerCredentials } from "./agents";
import { connectorConnections } from "./connectors";
import { machines } from "./machines";
import { missions } from "./missions";
import { organizationMembers, organizations } from "./tenancy";
import { issues } from "./work";

export const outboxStatusEnum = pgEnum("outbox_status", ["pending", "processing", "done", "failed"]);

/**
 * Transactional outbox and job queue in one (docs/adr/0005-postgres-outbox.md).
 * Rows are written in the same transaction as the change that causes them;
 * in-process workers claim due rows with `FOR UPDATE SKIP LOCKED` plus a
 * lease, and retry with backoff. No Redis, no BullMQ.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    /** Null for jobs that belong to no organization (e.g. a password-reset email). */
    orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
    /** Handler name, e.g. `message.posted` or `agent_run.execute`. */
    kind: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(8),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** While `processing`, other workers leave the row alone until this passes (crash recovery). */
    lockedUntil: timestamp({ withTimezone: true }),
    lockedBy: text(),
    lastError: text(),
    /** Optional idempotency key: enqueueing the same key twice is a no-op. */
    dedupeKey: text().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("outbox_due_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index("outbox_leased_idx").on(t.lockedUntil).where(sql`${t.status} = 'processing'`),
  ],
);

/**
 * Durable state machine of one agent turn (docs/adr/0008-agent-runs.md):
 * `queued → running → ((waiting_approval | waiting_input) → running)* → done | failed`.
 * Suspending is a status change; resuming is enqueueing a new job.
 */
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "done",
  "failed",
  /** Stopped by a person (`POST …/runs/{id}/cancel`). */
  "canceled",
]);
/** `forum` is unused since the forum was removed (migration 0216); dropping it would rewrite `agent_runs`. */
export const agentRunTriggerEnum = pgEnum("agent_run_trigger", ["mention", "router", "dm", "forum"]);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Thread the agent answers in (the trigger's thread, or the trigger itself when it is top-level). */
    threadRootId: uuid().notNull(),
    triggerMessageId: uuid().notNull(),
    trigger: agentRunTriggerEnum().notNull(),
    /** Hop of the reply this run will post (trigger hop + 1). */
    hop: integer().notNull(),
    /**
     * Its stretch (ADR 0089): the trigger's (a person's message is its own), or a fresh one when a person let it
     * go on. Null on older rows: their stretch is their trigger.
     */
    stretchId: uuid(),
    status: agentRunStatusEnum().notNull().default("queued"),
    error: text(),
    replyMessageId: uuid(),
    /**
     * The conversation sent to the model, appended to turn by turn (system,
     * messages, pending tool calls). Lets a run resume after an approval with
     * exactly the history it had (append-only, so provider thinking blocks and
     * prompt caches stay valid). See docs/adr/0015-tool-gateway-and-approvals.md.
     */
    transcript: jsonb().$type<Record<string, unknown>>(),
    /** Model calls made so far (capped by AGENT_MAX_TOOL_TURNS). */
    turns: integer().notNull().default(0),
    /**
     * People's messages for this run that arrived while it was active (one
     * active run per agent and conversation): delivered to the model at the
     * next call ("New message from …"), instead of starting a second run.
     */
    pendingMessageIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /**
     * The issue this run works on: set when someone asks the agent to
     * implement it, or when the run uses an issue tool on it. The issue shows
     * "working now" from a live run, and "stalled" when none is alive.
     */
    issueId: uuid(),
    /**
     * The browser this run is in (ADR 0110), set by `browser_profile`: a profile, or null for the agent's default.
     * `browserProfileTurnAt`: when it last took that profile's turn; a run that held a turn another took since
     * doesn't run its next command (the page may have changed under it).
     */
    browserProfileId: uuid(),
    browserProfileOwn: boolean(),
    browserProfileTurnAt: timestamp({ withTimezone: true }),
    /** Bumped by the worker while it executes the run; a stale one means the worker died (recovered on boot). */
    heartbeatAt: timestamp({ withTimezone: true }),
    /**
     * When the work it is doing now began, for the conversation's "thinking for …": set each time it goes back to
     * work (after waiting for a person, an approval or its computer) and each time it posts and goes on. Null until
     * then: its first stretch began when it was created. Never `startedAt`, which stays at its first start.
     */
    workingSince: timestamp({ withTimezone: true }),
    /**
     * The computer this run waits for (`waiting_input` with a computer brain
     * and nothing to fall back on, ADR 0032 §5): queued again when it comes
     * back (`resumeRunsWaitingForMachine`). Null otherwise.
     */
    waitingMachineId: uuid(),
    /**
     * The computer brain's session this run thinks in (Claude Code/Codex):
     * kept for the whole run (a pause resumes it), carried to the next run in
     * the conversation while it is recent and small, else a fresh one
     * (`resolveBrain`). Null for the model brain.
     */
    brainSessionId: text(),
    /**
     * Background work (a routine's run): it holds no conversation's slot. People's messages
     * never join it and it never joins theirs; it posts no final reply (only cards and `hand_off`),
     * and its computer session is never carried to the conversation's next run.
     */
    background: boolean().notNull().default(false),
    /**
     * The brain this run actually thinks with (`model`, `claude_code`, `codex`): the agent's, a
     * mission's override or a fallback. Null until its first turn. Shared code reads this, never
     * the agent's stored brain.
     */
    brain: text(),
    /**
     * Long work (ADR 0121): this run stepped out of its conversation into the background. Its replies land in the
     * work's thread and its end goes home; the newest run with this id is the work's current one.
     */
    workId: uuid().references((): AnyPgColumn => agentWorks.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index("agent_runs_work_idx").on(t.workId).where(sql`${t.workId} is not null`),
    // One run per (trigger, agent): redelivered outbox events can't double-answer.
    unique().on(t.triggerMessageId, t.agentId),
    index().on(t.orgId, t.status),
    index().on(t.threadRootId),
    // An agent's recent work across conversations (context: "Seu trabalho recente").
    index().on(t.orgId, t.agentId, t.createdAt),
    // The operator's work analytics read every workspace's runs in a range of dates.
    index().on(t.createdAt),
    index().on(t.issueId, t.createdAt),
    // A stretch's runs, counted before an agent starts another (`stretchStop`).
    index().on(t.orgId, t.stretchId).where(sql`${t.stretchId} is not null`),
    // Runs waiting for a computer, found when it reconnects (only those rows are indexed).
    index("agent_runs_waiting_machine_idx").on(t.waitingMachineId).where(sql`${t.waitingMachineId} is not null`),
  ],
);

/** One step of a long work's plan, as the agent wrote it (ADR 0121 §4). */
export type WorkPlanItem = { id: string; text: string; state: "todo" | "doing" | "done" };

/**
 * Long work (ADR 0121): a run that stepped out of its conversation to keep working in the background, with its
 * anchor message ("Vou cuidar disso…"), the updates it promised and where its report goes. The live sub-state
 * (working, waiting on a person, paused) is read from its current run.
 */
export const agentWorks = pgTable(
  "agent_works",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Where the ask was; null = the main timeline. The report goes here. */
    homeThreadId: uuid(),
    anchorMessageId: uuid().notNull().unique(),
    /** Updates go to the anchor's own thread (the ask was in the main timeline). */
    ownThread: boolean().notNull(),
    title: text().notNull(),
    plan: jsonb().$type<WorkPlanItem[]>().notNull().default([]),
    issueId: uuid().references(() => issues.id, { onDelete: "set null" }),
    /** `queued` | `live` | `done` | `failed` | `canceled`. */
    status: text().notNull(),
    /** `agent` (it called work_in_background) | `auto` (the safety net moved it). */
    how: text().notNull(),
    /** The person behind it, for lists and notifications. */
    requestedByUserId: text(),
    updateSeq: integer().notNull().default(0),
    lastUpdateAt: timestamp({ withTimezone: true }).notNull(),
    lastUpdateText: text(),
    /** When the promised update is due; null while it waits on something (no check-in runs). */
    nextUpdateAt: timestamp({ withTimezone: true }),
    resultMessageId: uuid(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.status).where(sql`${t.status} in ('queued', 'live')`),
    index().on(t.agentId, t.status).where(sql`${t.status} in ('queued', 'live')`),
    index().on(t.issueId).where(sql`${t.issueId} is not null`),
  ],
);

/**
 * Autonomy brakes (ADR 0131): what an agent's unrequested work met. A wake on an item (`wake`, `linked` to open work
 * on the same signature, `digest` held as noise for the next digest, `loop` stopped after repeated attempts, `later`
 * deferred by a cap), a costly step it took (`pr`, `install`) and a proposal waiting for a person's go (`proposal`,
 * `state` open → go / not_now / never / always).
 */
export const autonomySignals = pgTable(
  "autonomy_signals",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    kind: text().notNull(),
    /** The item's normalized fingerprint (`signatureOf`); null for steps that aren't about an item. */
    signature: text(),
    title: text().notNull().default(""),
    channelId: uuid(),
    runId: uuid(),
    messageId: uuid(),
    /** A proposal's: `open` | `go` | `not_now` | `never` | `always`. */
    state: text(),
    decidedByUserId: text(),
    /** A digest item once posted in a digest; a proposal once decided. */
    doneAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.agentId, t.signature, t.createdAt),
    index().on(t.orgId, t.agentId, t.kind, t.createdAt),
    index().on(t.kind).where(sql`${t.doneAt} is null`),
  ],
);

export const agentRunStepKindEnum = pgEnum("agent_run_step_kind", [
  "context",
  "model_call",
  "message",
  "error",
  "tool_call",
  "tool_result",
  "approval",
]);

/** What a run did, step by step: audit trail and the base for resuming after approvals. */
export const agentRunSteps = pgTable(
  "agent_run_steps",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    kind: agentRunStepKindEnum().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.runId, t.seq),
    // The operator's work analytics look up a run's waits for room among all its steps.
    index().on(t.runId).where(sql`${t.kind} = 'error' and ${t.data}->>'reason' = 'brain_unavailable'`),
  ],
);

export const usageKindEnum = pgEnum("usage_kind", ["agent", "router", "embedding", "summary"]);

/**
 * One row per model call, written by the Model Gateway only. Same numbers in
 * both editions; Cloud turns them into invoices and plan limits.
 * `agent_id` is null for calls made for the organization rather than an agent
 * (router, embeddings, summaries); `kind` tells them apart.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid(),
    kind: usageKindEnum().notNull().default("agent"),
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    /** Null when the platform key paid (Cloud). */
    credentialId: uuid().references(() => providerCredentials.id, { onDelete: "set null" }),
    provider: text().notNull(),
    /** Model that actually answered (may differ from the requested one after a server-side fallback). */
    model: text().notNull(),
    requestedModel: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    /** Cost in nano-USD (1e-9 USD), computed from `MODEL_CATALOG` at call time. */
    costNanoUsd: bigint({ mode: "number" }).notNull(),
    /**
     * The stream failed midway: tokens are what the provider reported before
     * failing, or counted/estimated (docs/adr/0012-budget-reservation-and-usage.md).
     */
    partial: boolean().notNull().default(false),
    /**
     * Who it is billed to: `org` for model calls and embeddings, also when the
     * platform model key paid (`credentialId` null), `platform` for internal
     * services on this server's own keys (Jev, with its TypeSafe key), and
     * `plan` for a computer brain's plan. Org usage reports keep `platform`
     * rows apart.
     */
    billedTo: text().notNull().default("org"),
    /**
     * A plan row's computer and the account it spent (`machine_accounts.id`; null with a computer: that
     * computer's own sign-in). Null on API rows, and on plan rows from before accounts were recorded.
     * No foreign keys: the history outlives a removed account or computer.
     */
    machineId: uuid(),
    brainAccountId: uuid(),
    /**
     * The person behind the run at call time (ADR 0141): who asked, or a routine's creator. Null for calls nobody is
     * behind (an agent's own work, the router, embeddings) and rows from before it was recorded. No foreign key: the
     * history outlives a member who left.
     */
    personId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.agentId, t.createdAt),
    index().on(t.orgId, t.createdAt),
    index().on(t.orgId, t.personId, t.createdAt),
    // The operator's work analytics read every workspace's usage in a range of dates.
    index().on(t.createdAt),
  ],
);

/**
 * Per-agent spend counter for one calendar month (UTC). The Model Gateway
 * reserves the worst-case cost of a call here (row lock) before calling and
 * settles to the actual cost after, so concurrent runs can't overshoot the
 * budget (docs/adr/0012-budget-reservation-and-usage.md).
 */
export const agentBudgetPeriods = pgTable(
  "agent_budget_periods",
  {
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    periodStart: date({ mode: "string" }).notNull(),
    spentNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    reservedNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.periodStart] }),
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
  ],
);

/**
 * A person's AI use for one calendar month (UTC), across every agent (ADR 0141): what the Model Gateway and the plan
 * brains add after each call (API cost, or the API-equivalent of a plan's tokens), read before the next one against
 * the person's monthly limit. `raised_limit_nano_usd`: an admin raised it for this month only; `requested_at`: the
 * person asked for more ("Pedir mais") and nobody answered yet.
 */
export const personUsageMonths = pgTable(
  "person_usage_months",
  {
    orgId: uuid().notNull(),
    personId: text().notNull(),
    periodStart: date({ mode: "string" }).notNull(),
    spentNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    raisedLimitNanoUsd: bigint({ mode: "number" }),
    raisedByUserId: text(),
    requestedAt: timestamp({ withTimezone: true }),
    /** When this month's use first reached the limit in force then (cleared by a raise). */
    reachedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.personId, t.periodStart] }),
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.userId],
    }).onDelete("cascade"),
  ],
);

/** An open reservation. Released on settle, or when it expires (a worker died mid-call). */
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    periodStart: date({ mode: "string" }).notNull(),
    amountNanoUsd: bigint({ mode: "number" }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.agentId, t.expiresAt),
  ],
);

/**
 * What the router decided for one message without mentions (docs/adr/0013-router.md):
 * which strategy ranked the candidates, every candidate's score, and who was
 * picked after policy (threshold, at most 2, hop limit). Kept to compare
 * strategies over time.
 */
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    messageId: uuid().notNull(),
    /**
     * Who decided (ADR 0074): `jev`, `llm:<model>`, `plan:<kind>`, `rule:<name>`, `none` (nobody could read
     * it), `no_ai`, a mention's judge, or another implementation's name.
     */
    strategy: text().notNull(),
    candidates: jsonb().$type<{ agentId: string; score: number }[]>().notNull(),
    /** Need-any-agent probability, when the strategy reports one. */
    needsAgentScore: real(),
    selectedAgentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Code's markers first (`follow-up`), then the deciding step's words after its name (`jev: …`). */
    reason: text(),
    /** The router's steps that failed before one decided (`jev: TypeSafe answered 529`), or `no_ai`. */
    error: text(),
    usageRecordId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.messageId), index().on(t.orgId, t.createdAt)],
);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "refused",
  "expired",
  /** Its run was canceled. */
  "canceled",
]);

/**
 * Who decides an approval an agent asked with `request_approval` (ADR 0126), or one in a person's own mailbox (its
 * owner, ADR 0038).
 */
export interface ApprovalApprovers {
  /** The people asked: those named and the holders of the role named; empty: the agent's owner and admins. */
  userIds: string[];
  /** Who decides, as the card says it ("Diretoria", "Ana, Bruno"). */
  label: string;
  /** The person behind the run that asked: never decides it, unless `requesterDecides`. */
  requestedBy: string | null;
  /** The requester holds the role named: they may decide it, and the card says so. */
  requesterDecides: boolean;
  /** Only `userIds` decide it, admins too: someone else asked to act in that person's own mailbox. */
  required?: boolean;
}

/**
 * A sensitive action an agent wants to take (docs/adr/0015). Bound to the
 * exact action: `action_hash` = SHA-256 of the canonical JSON of (tool,
 * scope, connection, params); only that is ever executed. Who may decide:
 * the agent's owner (`owner_user_id`, snapshot at creation) and org admins.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    /** The run that asked; null for a mission's executor asking through the `agentes` MCP server (ADR 0029). */
    runId: uuid().references(() => agentRuns.id, { onDelete: "cascade" }),
    /** Asked by a mission's executor (`request_approval`): the decision resumes that task's session, not a run. */
    missionId: uuid(),
    missionTaskId: uuid(),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    threadRootId: uuid().notNull(),
    /** The chat message showing the request (a card). */
    messageId: uuid(),
    /** Tool-use id in the run's transcript, to answer the model. */
    toolUseId: text().notNull(),
    tool: text().notNull(),
    scope: text().notNull(),
    connectionId: uuid(),
    params: jsonb().$type<Record<string, unknown>>().notNull(),
    actionHash: text().notNull(),
    /** Human summary, e.g. "Merge PR #42 into main". */
    title: text().notNull(),
    detail: text().notNull().default(""),
    /** The agent's own reason, required on every request (ADR 0053): what it found and why this action. */
    why: text().notNull().default(""),
    /**
     * Asked while nobody was watching (ADR 0053): `{ kind: "routine" | "unattended", routineId?,
     * routineName? }`. The card and the notification say so. Null when a person was behind the run.
     */
    origin: jsonb().$type<Record<string, unknown>>(),
    status: approvalStatusEnum().notNull().default("pending"),
    ownerUserId: text(),
    decidedByUserId: text(),
    decidedAt: timestamp({ withTimezone: true }),
    /** Why it was refused (fed back to the model and to agent lessons). */
    reason: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** When approvers were last emailed about it (reminder digest). */
    remindedAt: timestamp({ withTimezone: true }),
    /** Set once when the approved action runs: never twice. */
    executedAt: timestamp({ withTimezone: true }),
    result: jsonb().$type<Record<string, unknown>>(),
    /**
     * "Aprovar sempre", decided by the Tool Gateway when it asked: the kind a decider may approve for good (the
     * server's own tool name and the actions it wraps, `approval_rules`). Null = not offered.
     */
    approveAlways: jsonb().$type<{ tool: string; actions: string[]; routineId?: string }>(),
    /**
     * Approved ahead (ADR 0015 addendum, 2026-10-31): the routine whose run at `run_at` (that run's slot) this exact
     * action is for. Once approved, that run does it without asking until `run_at` plus a short grace. Both null for
     * an action that runs as soon as it is approved.
     */
    routineId: uuid(),
    runAt: timestamp({ withTimezone: true }),
    /**
     * Asked with `request_approval` (ADR 0126): who decides it, snapshot when it was asked. Null: the agent's owner
     * and whoever may approve actions, as for any other approval.
     */
    approvers: jsonb().$type<ApprovalApprovers>(),
    /**
     * The person behind the run that asked (`accountablePerson`), when there was one: whoever covers someone never
     * decides their own request (`approval_covers`).
     */
    requestedByUserId: text(),
    /**
     * Merge, deploy, rollback, sends, deletes and the like (`highRisk` in the Tool Gateway): a cover decides these only
     * when the person turned that on. Rows from before the column count as high risk.
     */
    highRisk: boolean().notNull().default(true),
    /** Decided by someone covering this person (`approval_covers`): "Aprovado por Bruno, cobrindo Ana". */
    decidedForUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.runId, t.toolUseId),
    index().on(t.orgId, t.status, t.createdAt),
    index().on(t.expiresAt).where(sql`${t.status} = 'pending'`),
    index().on(t.routineId, t.runAt).where(sql`${t.runAt} is not null`),
  ],
);

/**
 * "Quem aprova por mim" (ADR 0139): one person who decides, in this person's name, the approvals asked of them
 * personally (as the agent's owner, or named by `request_approval`), always or only while their status says they are
 * out of office, until `ends_at`. Never what the cover asked for, a mailbox's actions or access for good; merge,
 * deploy and other high-risk actions only with `risky`. Gone when either person leaves the workspace.
 */
export const approvalCovers = pgTable(
  "approval_covers",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    fromUserId: text().notNull(),
    toUserId: text().notNull(),
    mode: text().$type<"always" | "while_out">().notNull().default("while_out"),
    risky: boolean().notNull().default(false),
    endsAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.fromUserId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.userId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.toUserId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.userId],
    }).onDelete("cascade"),
    unique().on(t.orgId, t.fromUserId),
    index().on(t.orgId, t.toUserId),
  ],
);

/**
 * "O Gerente aprova por você" (ADR 0139 §2): whether the workspace's right hand decides, in this person's name, the
 * cards other agents post from their own request, for which of the two kinds, up to which budget per agent. The day
 * and month caps are code (`RIGHT_HAND_CAPS`). `paused_at`: three of its decisions undone in a week stopped it until
 * the person turns it back on.
 */
export const rightHandApprovals = pgTable(
  "right_hand_approvals",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    userId: text().notNull(),
    enabled: boolean().notNull().default(false),
    newAgents: boolean().notNull().default(true),
    agentChanges: boolean().notNull().default(true),
    budgetCapNanoUsd: bigint({ mode: "number" }).notNull().default(20_000_000_000),
    guidance: text().notNull().default(""),
    pausedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.userId],
    }).onDelete("cascade"),
    unique().on(t.orgId, t.userId),
  ],
);

/**
 * One per card the right hand looked at for someone (ADR 0139 §2): approved (applied as them) or passed to them, with
 * its reason ("Por quê?"). The caps, Desfazer, the daily entry and the auto-pause read these rows. `budget_added`:
 * what the decision added to the workspace's monthly budgets, counted against the month's cap.
 */
export const rightHandDecisions = pgTable(
  "right_hand_decisions",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    forUserId: text().notNull(),
    rightHandId: uuid().notNull(),
    kind: text().$type<"agent_new" | "agent_settings">().notNull(),
    /** The card's message (messages are partitioned: no foreign key). */
    messageId: uuid().notNull(),
    proposedByAgentId: uuid(),
    /** `deciding` while its call runs (it holds its place under the caps). */
    outcome: text().$type<"deciding" | "approved" | "passed">().notNull(),
    reason: text().notNull().default(""),
    /** A decision call was made (the day's cap counts these). */
    called: boolean().notNull().default(false),
    budgetAddedNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    /** The agent it created or changed. */
    targetAgentId: uuid(),
    undoneAt: timestamp({ withTimezone: true }),
    undoneByUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.orgId, t.messageId), index().on(t.orgId, t.forUserId, t.createdAt)],
);

/**
 * "Aprovar sempre" (docs/adr/0015): a kind of call one agent makes without asking again, approved for good by
 * someone who decides its approvals. The kind is the connection, the server's own tool name and, for a tool that
 * runs other actions (Composio's executor), one wrapped action (`''`: the tool itself). Params are never part of
 * it. The Tool Gateway reads it fresh before every request it would make; it never grants access. A command on
 * the agent's computer has no connection: `tool` is `command` and `action` its kind (`gh issue create`).
 */
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    connectionId: uuid().references(() => connectorConnections.id, { onDelete: "cascade" }),
    tool: text().notNull(),
    action: text().notNull().default(""),
    createdByUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.agentId, t.connectionId, t.tool, t.action),
    uniqueIndex("approval_rules_no_connection").on(t.agentId, t.tool, t.action).where(sql`${t.connectionId} is null`),
    index().on(t.connectionId),
  ],
);

/**
 * Act with undo (ADR 0037 round 2): an internal, reversible change an agent
 * made with a tool (an issue, a memory, a routine, a channel member, a wiki
 * page, a thread). Written with the change; linked to the run's reply
 * (`message_id`) so the message shows it as a receipt with "Desfazer".
 * `before`/`after`: what is needed to invert and to detect someone else's
 * change since. `undone_at` set = currently undone (redo clears it);
 * `undoable_until` moves forward on every undo or redo.
 */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    /** The run that made the change (no foreign key: receipts outlive pruned runs). */
    runId: uuid(),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** The run's reply (set when it is posted). */
    messageId: uuid(),
    /** The person the agent worked for (the trigger message's author); null for routines and agents. */
    requestedByUserId: text(),
    kind: text().notNull(),
    targetType: text().notNull(),
    targetId: text().notNull(),
    /** Label of the target for the receipt (`number`, `title`, `name`…) and the summary's params. */
    target: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    before: jsonb().$type<Record<string, unknown>>(),
    after: jsonb().$type<Record<string, unknown>>(),
    /** Bookkeeping of undo/redo (e.g. the wiki version an undo wrote). */
    state: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    undoableUntil: timestamp({ withTimezone: true }).notNull(),
    undoneAt: timestamp({ withTimezone: true }),
    undoneByUserId: text(),
    redoneAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.messageId),
    index().on(t.runId),
    // A skill's page lists the agents' changes to it.
    index().on(t.orgId, t.targetId),
  ],
);

/**
 * What an agent may do: one row per granted scope (docs/adr/0015, 0016).
 * `connection_id` null = a built-in tool scope (e.g. `context:read`);
 * otherwise a scope of one org connector connection (e.g. `github:pr.merge`).
 * The Tool Gateway checks this table on every call; prompts never matter.
 */
export const agentScopes = pgTable(
  "agent_scopes",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    connectionId: uuid(),
    scope: text().notNull(),
    grantedByUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.agentId, t.connectionId, t.scope).nullsNotDistinct(),
  ],
);

/**
 * The GitHub repositories an agent may use (`owner/name`, or `owner/*` for a
 * whole account), in order: the first is where it starts when nobody names
 * one. No rows = every repository the organization's GitHub reaches. The git
 * proxy and the Tool Gateway check it on every call (reads included).
 */
export const agentRepositories = pgTable(
  "agent_repositories",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    repo: text().notNull(),
    position: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.agentId, t.repo),
  ],
);

export const agentQuestionStatusEnum = pgEnum("agent_question_status", [
  "open",
  "answered",
  "expired",
  /** Its run was canceled. */
  "canceled",
  /** A person skipped it: the run goes on without an answer. */
  "dismissed",
]);

/**
 * A question an agent asked a person (`ask_user`). The run waits
 * (`waiting_input`) until someone answers in the thread or through the API,
 * or the question expires; the answer goes back to the model as the tool
 * result.
 */
export const agentQuestions = pgTable(
  "agent_questions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Thread it was asked in; null = the main timeline (flat DMs). */
    threadId: uuid(),
    /** The chat message carrying the question. */
    messageId: uuid(),
    toolUseId: text().notNull(),
    text: text().notNull(),
    choices: text().array(),
    /** The one person it is for: only they answer it, and it waits on nobody else. Null: anyone in the conversation. */
    requestedForUserId: text(),
    status: agentQuestionStatusEnum().notNull().default("open"),
    answer: text(),
    answeredByUserId: text(),
    answeredAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.runId, t.toolUseId),
    index().on(t.channelId, t.status),
    index().on(t.expiresAt).where(sql`${t.status} = 'open'`),
  ],
);

export const agentConsultationStatusEnum = pgEnum("agent_consultation_status", [
  "open",
  "answered",
  "expired",
  "failed",
]);

/** A question (`ask_agent`) or work handed off (`tell_agent`): both come back by themselves (ADR 0095). */
export const agentConsultationKindEnum = pgEnum("agent_consultation_kind", ["question", "note"]);

/**
 * One agent asking another (`ask_agent`, ADR 0034) or handing it work (`tell_agent`, ADR 0095): the message goes to
 * a private DM between the two agents, the other agent runs there, and what comes of it goes back to the
 * conversation of the run that sent it.
 */
export const agentConsultations = pgTable(
  "agent_consultations",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    /** The run that asked or handed it off. */
    askerRunId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    askerAgentId: uuid().notNull(),
    targetAgentId: uuid().notNull(),
    /** The private DM between the two agents. */
    channelId: uuid().notNull(),
    /** The question or the note as posted there (the other agent's run's trigger). */
    messageId: uuid().notNull(),
    targetRunId: uuid(),
    waitId: text().notNull(),
    question: text().notNull(),
    /** Agents already in this chain of consultations (no cycles). */
    chain: uuid().array().notNull(),
    status: agentConsultationStatusEnum().notNull().default("open"),
    kind: agentConsultationKindEnum().notNull().default("question"),
    /** Once closed, what came of it; while open, what came back so far from agents its run handed part to. */
    answer: text(),
    answeredAt: timestamp({ withTimezone: true }),
    /** The sender heard what came of it, or there was nothing worth telling it (a note's acknowledgement). */
    reportedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.askerAgentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.targetAgentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.messageId),
    index().on(t.askerRunId),
    index().on(t.expiresAt).where(sql`${t.status} = 'open'`),
    index().on(t.targetRunId),
    index().on(t.orgId, t.askerAgentId, t.createdAt),
  ],
);

export const secretRequestStatusEnum = pgEnum("secret_request_status", [
  "pending",
  "delivered",
  "declined",
  "expired",
  "canceled",
]);

/**
 * An agent asked a person for a secret for its computer (ADR 0027). The value
 * never comes here: the browser seals it to `publicKey` (made on the
 * computer, which keeps the private key) and we only relay the box. No column
 * holds the value or the box, on purpose.
 */
export const secretRequests = pgTable(
  "secret_requests",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Thread it was asked in; null = the main timeline (flat DMs). */
    threadId: uuid(),
    /** The chat message carrying the card. */
    messageId: uuid(),
    toolUseId: text().notNull(),
    /** The only person who may answer: whoever started the run. */
    requestedForUserId: text().notNull(),
    /** `GITHUB_TOKEN`…: the agent's own name for it. People read `label`. */
    name: text().notNull(),
    /** What people read instead of `name` ("Senha da Conta Google"), in the agent's words; null: the apps derive one. */
    label: text(),
    purpose: text().notNull(),
    /**
     * `site`: only the agent browser types it, on `site`, never its commands (a runner that says it can, ADR 0027);
     * a site's password on an older runner is `env`, with `site` set.
     */
    targetKind: text().notNull().$type<"env" | "file" | "site">(),
    targetPath: text(),
    /** The connected machine holding the key (ADR 0025). */
    machineId: uuid(),
    /**
     * For a password the agent's browser types (ADR 0040): the only site
     * (`https://host[:port]`) it may be typed on. Shown to the person.
     */
    site: text(),
    /** A site password's username, when the agent knows it: the card prefills "Save to the Vault" with it (ADR 0144). */
    username: text(),
    /** A one-time code typed into this many boxes (ADR 0144); null unless the request is for a code. Never saved. */
    codeDigits: smallint(),
    /** The computer's public key for this request (raw P-256, base64). */
    publicKey: text().notNull(),
    status: secretRequestStatusEnum().notNull().default("pending"),
    deliveredAt: timestamp({ withTimezone: true }),
    deliveredSize: integer(),
    /** Removed from the computer (the row stays for the record). */
    removedAt: timestamp({ withTimezone: true }),
    /** When asked, the agent already held this name on this computer: a delivery replaces that value. */
    replaces: boolean().notNull().default(false),
    /** Why a `canceled` request closed; null on what closed before this was kept. */
    endReason: text().$type<"run_stopped" | "withdrawn" | "person_left" | "superseded" | "computer_changed">(),
    /** The newer request that took this one's place (`endReason: superseded`). */
    supersededBy: uuid(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.runId, t.toolUseId),
    index().on(t.agentId, t.status),
    index().on(t.expiresAt).where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Background tasks on a connected machine (ADR 0029 section 4): started by an
 * agent's `start_task`, run detached by the runner, and finished by its
 * `task.done`, which wakes the conversation. `interrupted`: the process went
 * away without an exit (the machine went offline); `ended_at` null means it
 * may still come back or be resumed, set means that was final.
 */
export const machineTaskStatusEnum = pgEnum("machine_task_status", [
  "queued",
  "running",
  "interrupted",
  "done",
  "failed",
  "canceled",
]);

export const machineTasks = pgTable(
  "machine_tasks",
  {
    /** Also the runner's task id. */
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    channelId: uuid().notNull(),
    /** The thread it reports to; null = the main timeline (a flat DM). */
    threadRootId: uuid(),
    /** The run whose `start_task` started it (null: resumed by the server). */
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    /** The person behind that run (who the agent works for); null for routines and other agents' chains. */
    requestedByUserId: text(),
    /** A mission's task (its main session or an item's): its end goes to the mission, not to an agent run. */
    missionId: uuid().references(() => missions.id, { onDelete: "set null" }),
    title: text().notNull(),
    /** `claude`, `codex` or `shell`. */
    executor: text().notNull(),
    /** What the runner ran (capped); never secrets of ours. */
    command: text().notNull().default(""),
    /** The prompt for an executor (kept to resume it); capped. */
    prompt: text(),
    /** Claude Code's session (the thread id), resumed after an interruption. */
    sessionId: text(),
    branch: text(),
    /** Where it ran, relative to the agent's folder. */
    cwd: text(),
    status: machineTaskStatusEnum().notNull().default("queued"),
    exitCode: integer(),
    signal: text(),
    seconds: integer(),
    lastLine: text(),
    /**
     * The latest human lines (at most 50, oldest first), from `task.event`:
     * "Ver saída" when the computer is offline. Throttled like the events.
     */
    recentLines: jsonb().$type<string[]>().notNull().default([]),
    /** A pull request the task opened (from the executor's tools or its output). */
    prUrl: text(),
    /** Files it touched (relative paths, at most 50). */
    files: jsonb().$type<string[]>().notNull().default([]),
    /** The executor's final answer or the last lines of output (capped). */
    result: text(),
    /** `agent:<runId>` or a person's id, when someone canceled it. */
    canceledBy: text(),
    /** The task this one resumes after an interruption, and how many resumes the chain had. */
    resumedFromId: uuid(),
    resumedTaskId: uuid(),
    resumeCount: integer().notNull().default(0),
    /**
     * A mission task's executor stopped to wait for people (a blocking
     * `ask_decision`, `request_review` or `request_approval`): `decision`,
     * `review` or `approval`. Its end then means "waiting", not "done".
     */
    waitingFor: text(),
    /**
     * A mission task's kind (ADR 0044): `write` (one at a time in the
     * mission's folder, ending in a commit), `read` (in parallel, read only)
     * or `setup` (prepares the folder); null for other tasks. Validated in code.
     */
    mode: text(),
    /** `HEAD` when a write item started and after its commit at the end (equal: nothing changed). */
    startSha: text(),
    endSha: text(),
    /**
     * A task waiting in our queue (status `queued`): what to send the runner
     * when it may start (its mission's folder is free, the computer has a
     * slot or is back). Cleared when it is claimed to start.
     */
    startRequest: jsonb().$type<Record<string, unknown>>(),
    /** The conversation was woken for its end (the `machine.task_done` job ran). */
    wokeAt: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    lastEventAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.machineId, t.status),
    index().on(t.orgId, t.agentId, t.createdAt),
    index().on(t.orgId, t.channelId, t.threadRootId),
    index().on(t.missionId),
    // One live task per mission session: two resumes of the same session never run at once (ADR 0029).
    uniqueIndex("machine_tasks_live_session")
      .on(t.missionId, t.sessionId)
      .where(sql`${t.missionId} is not null and ${t.sessionId} is not null and ${t.endedAt} is null`),
  ],
);

/**
 * An agent's request for a folder on its connected computer (ADR 0036 §8,
 * `request_folder_access`). The person decides on the machine; the runner
 * reports `access.decided`, and the server posts the outcome in the thread
 * the request came from and wakes the agent there (`woke_at`, once).
 */
export const machineAccessRequests = pgTable(
  "machine_access_requests",
  {
    /** Also the runner's request id. */
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** Where the agent asked: the outcome is posted there and wakes it there. */
    channelId: uuid().notNull(),
    /** The thread; null = the main timeline (a flat DM). */
    threadRootId: uuid(),
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    /** The person the agent worked for (the woken run's audience). */
    requestedByUserId: text(),
    /** Absolute path on the machine, as the agent asked for it. */
    path: text().notNull(),
    reason: text().notNull().default(""),
    /** `pending`, `granted`, `denied`, `expired` or `failed` (never reached the machine). */
    status: text().notNull().default("pending"),
    /** `agent` or `all` when granted. */
    scope: text(),
    decidedAt: timestamp({ withTimezone: true }),
    /** The outcome was posted and the agent woken (the `machine.access_decided` job ran). */
    wokeAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.machineId, t.status),
    index().on(t.orgId, t.agentId, t.createdAt),
  ],
);

/**
 * Tokens of the runner's `agentes` MCP bridge (ADR 0032): issued when a
 * computer-brain run or a mission task starts, bound to the org, agent,
 * machine and that run (or task). The runner sends it with every tool call;
 * the server checks the hash, the machine, the expiry and that the run (or
 * task) is still live. Stored as SHA-256 only.
 */
export const runToolTokens = pgTable(
  "run_tool_tokens",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** The run it acts for (a computer-brain turn); null for a mission task started by the server. */
    runId: uuid().references(() => agentRuns.id, { onDelete: "cascade" }),
    /** The mission task it acts for (its tools are the mission's); null for a run. */
    taskId: uuid().references(() => machineTasks.id, { onDelete: "cascade" }),
    /** SHA-256 (hex) of `agr_…`. */
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.runId), index().on(t.taskId)],
);
