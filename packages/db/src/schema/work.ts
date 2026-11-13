import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { channels } from "./chat";
import { organizations } from "./tenancy";

export const issueStatusEnum = pgEnum("issue_status", ["todo", "in_progress", "in_review", "done", "canceled"]);
export const issuePriorityEnum = pgEnum("issue_priority", ["low", "normal", "high"]);

/** Next issue number per organization (#1, #2…), taken atomically. */
export const issueCounters = pgTable("issue_counters", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  last: integer().notNull().default(0),
});

/**
 * The board's columns. Each one sits in a fixed stage (the issue
 * status), so the status still moves on its own; an issue moved by the
 * system lands in the first column of its stage. `name` null: the stage's
 * own name, in the reader's language. Created on first use with one column
 * per stage.
 */
export const issueColumns = pgTable(
  "issue_columns",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stage: issueStatusEnum().notNull(),
    name: text(),
    /** Order inside its stage. */
    position: doublePrecision().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.stage, t.position)],
);

/**
 * Native issues. Visible to the whole org, or like the conversation they came from (`channel_id`: a DM or a private
 * channel, set by "Transformar em issue" and by an agent's `create_issue` there). Acceptance criteria are a checklist;
 * assignee is a person or an agent.
 */
export const issues = pgTable(
  "issues",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    status: issueStatusEnum().notNull().default("todo"),
    /** Its board column; null: the first column of its stage. Cleared when the status changes. */
    columnId: uuid().references(() => issueColumns.id, { onDelete: "set null" }),
    /** Order inside its column, lowest first; a move by the system puts it on top (minus the time). */
    boardRank: doublePrecision().notNull().default(0),
    priority: issuePriorityEnum().notNull().default("normal"),
    /** `person` or `agent`. */
    assigneeType: text(),
    assigneeId: text(),
    labels: text().array().notNull().default(sql`'{}'::text[]`),
    dueDate: date({ mode: "string" }),
    /** `[{ id, text, done }]`. */
    /** `doneBy`: who checked it (`{ type, id }`), when done. */
    criteria: jsonb()
      .$type<{ id: string; text: string; done: boolean; doneBy?: { type: "person" | "agent"; id: string } | null }[]>()
      .notNull()
      .default([]),
    /** `{ type: "manual" | "message" | "agent" | "webhook", … }`. */
    source: jsonb().$type<Record<string, unknown>>().notNull().default({ type: "manual" }),
    channelId: uuid(),
    /**
     * Limited to `audienceUserIds` (ADR 0151), with no `channelId`: who sees it is that list, and administrators always.
     * Not limited: the workspace, or the people of the conversation in `channelId`.
     */
    restricted: boolean().notNull().default(false),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** A sub-issue of this one (a step of a plan). */
    parentIssueId: uuid().references((): AnyPgColumn => issues.id, { onDelete: "set null" }),
    /** `[{ number, url, openedBy }]`. */
    pullRequests: jsonb().$type<Record<string, unknown>[]>().notNull().default([]),
    /** The GitHub issue or pull request this task is about: a link and nothing more, no sync. */
    githubUrl: text(),
    artifactIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Long work stopped on something (ADR 0121 §4): a badge on the card, the card stays in its stage. */
    blocked: jsonb().$type<{ reason: string; since: string; text?: string }>(),
    /**
     * Its conversation (ADR 0145): a channel of kind `task` and the thread root in it, made on first use. No
     * foreign key to the root (`messages` is partitioned).
     */
    conversationChannelId: uuid().references((): AnyPgColumn => channels.id, { onDelete: "set null" }),
    conversationRootId: uuid(),
    createdByType: text().notNull(),
    createdById: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.orgId, t.number),
    index().on(t.orgId, t.status),
    index().on(t.orgId, t.dueDate),
    index().on(t.parentIssueId),
    uniqueIndex().on(t.conversationChannelId),
    // Every run reads its agent's open tasks, latest activity first (`openTasksBrief`).
    index().on(t.orgId, t.assigneeType, t.assigneeId, t.updatedAt),
  ],
);

/** Comments (people and agents) and events ("asked Ada to implement") of an issue. */
export const issueActivity = pgTable(
  "issue_activity",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    issueId: uuid()
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    /** `comment` or `event`. */
    kind: text().notNull(),
    authorType: text().notNull(),
    authorId: text().notNull(),
    text: text().notNull(),
    /** Machine form of an event: `status_changed`, `assigned`, `agent_asked`… */
    event: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.issueId, t.createdAt)],
);

/**
 * Routines: an agent runs `prompt` on a schedule (cron in the org's
 * time zone, from a phrase) or when an event happens (webhooks, new issue),
 * and delivers to a channel, a DM with the creator, or a Drive file.
 */
export const routines = pgTable(
  "routines",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    name: text().notNull(),
    prompt: text().notNull(),
    /** `{ type: "channel", channelId }`, `{ type: "dm" }` or `{ type: "artifact" }`. */
    target: jsonb().$type<Record<string, unknown>>().notNull(),
    /** `schedule` or `event`. */
    triggerType: text().notNull(),
    phrase: text(),
    cron: text(),
    timezone: text(),
    description: text(),
    event: text(),
    /** A structured schedule (`ScheduleRule`): wins over `cron`, which is kept when it can express it. */
    rule: jsonb().$type<Record<string, unknown>>(),
    active: boolean().notNull().default(true),
    /**
     * What it may do while nobody watches (ADR 0053): `read` (the default) looks and reports through
     * `hand_off`; `act` may also change things inside agentes.chat and on the agent's own branches,
     * and asks before any change in a connected app.
     */
    access: text().notNull().default("read"),
    /**
     * Connected-app actions its job needs (tool names, or a Composio action's slug), allowed by its creator when they
     * set it up: its runs do them without a card while the creator may still decide the agent's approvals. Any other
     * write to a connected app asks; merge, deploy, rollback and the like always ask (`aheadRefusal`).
     */
    ownActions: jsonb().$type<string[]>().notNull().default([]),
    /** When it speaks: `when_new` (only when there is news) or `always` (a report every time). */
    report: text().notNull().default("when_new"),
    /** Why it paused itself (a coded reason the app translates); cleared when a person resumes it. */
    pausedReason: text(),
    /** Failed runs in a row since its last good one: after a few it pauses itself. */
    failuresInRow: integer().notNull().default(0),
    nextRunAt: timestamp({ withTimezone: true }),
    lastRunAt: timestamp({ withTimezone: true }),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Deleted: never fires again; its run history stays. */
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId), index().on(t.active, t.nextRunAt)],
);

/** One firing of a routine; `(routine_id, at)` is unique, so a slot never fires twice. */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    routineId: uuid()
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    /** The scheduled slot (or the moment of a manual or event run). */
    at: timestamp({ withTimezone: true }).notNull(),
    /** `schedule`, `manual` or `event`. */
    trigger: text().notNull(),
    agentRunId: uuid(),
    /**
     * The routine run's own ledger (ADR 0053): `queued` → `starting` → `started`, then exactly one end:
     * `reported` (it handed off) or `silent` (nothing new; its record in `summary`), `failed`,
     * `canceled` (a person stopped it), `superseded` (the next slot replaced it while it waited),
     * `missed` (it could not run in time). `skipped`: the slot never started a run.
     */
    status: text().notNull().default("queued"),
    summary: text().notNull().default(""),
    /** The coded reason of a skip, miss, failure or stop (the app translates it). */
    code: text(),
    /** The brain that ran it (`model`, `claude_code` or `codex`). */
    brain: text(),
    event: jsonb().$type<Record<string, unknown>>(),
    /** An event's identity (a delivery or issue id): the same event never fires the routine twice. */
    dedupeKey: text(),
    /** Where people saw its result: the agent's message in the routine's conversation. */
    messageId: uuid(),
    finishedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.routineId, t.at), unique().on(t.routineId, t.dedupeKey), index().on(t.routineId, t.createdAt)],
);

/**
 * A routine started by a webhook (ADR 0106): its own address, `<PUBLIC_URL>/api/hooks/<token>`. The token is an
 * HMAC of `key_id` under a key derived from AGENTES_SECRET, so the address can be shown again while only its hash is
 * stored; a new `key_id` (a new address) makes the old one unknown at once. The optional signing secret is sealed.
 */
export const routineHooks = pgTable("routine_hooks", {
  routineId: uuid()
    .primaryKey()
    .references(() => routines.id, { onDelete: "cascade" }),
  orgId: uuid().notNull(),
  keyId: text().notNull(),
  tokenHash: text().notNull().unique(),
  secretCiphertext: text(),
  secretWrappedKey: text(),
  secretKekId: text(),
  /**
   * A connector's event behind the address (ADR 0130): the connection, the event, its filter and the webhook the
   * provider keeps for it (`ConnectorTriggerSource`). Null: a plain webhook routine.
   */
  source: jsonb(),
  /** The HTTP methods the address answers (GET passes its query string as the call's data). */
  methods: text().array().notNull().default(sql`'{POST}'::text[]`),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * The calls a routine's address answered (the latest show on its page), with their idempotency keys: a call repeated
 * within 24 hours answers with the first one's run and starts nothing.
 */
export const routineHookCalls = pgTable(
  "routine_hook_calls",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    routineId: uuid()
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    /** `accepted`, `duplicate`, `bad_signature`, `too_large` or `rate_limited`. */
    outcome: text().notNull(),
    /** The HTTP status it got. */
    status: integer().notNull(),
    bytes: integer().notNull().default(0),
    routineRunId: uuid(),
    idempotencyKey: text(),
    /** Sent from the routine's page ("Testar"). */
    test: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.routineId, t.createdAt), index().on(t.routineId, t.idempotencyKey)],
);

/**
 * Incoming webhooks of an organization (GitHub, Sentry). The signing secret
 * is sealed; each request's signature is checked before anything runs. GitHub's
 * secret is ours (people paste it there); Sentry's is its integration's Client
 * Secret, pasted here (`secret_set_at`).
 */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    secretCiphertext: text().notNull(),
    wrappedDataKey: text().notNull(),
    kekId: text().notNull(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
    /** The last call that carried a valid signature (any event, GitHub's ping too): the webhook works. */
    lastDeliveryAt: timestamp({ withTimezone: true }),
    /** The last call whose signature didn't match: set up with another secret. */
    lastRefusedAt: timestamp({ withTimezone: true }),
    /** When a person pasted the provider's own secret (Sentry's Client Secret). */
    secretSetAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * Native calendar: events people create (agents only propose), with
 * attendees (people and agents) and their RSVP, a linked channel or issue,
 * and a simple recurrence.
 */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text().notNull().default(""),
    startAt: timestamp({ withTimezone: true }).notNull(),
    endAt: timestamp({ withTimezone: true }).notNull(),
    allDay: boolean().notNull().default(false),
    location: text(),
    timezone: text().notNull().default("UTC"),
    /** `none`, `weekdays`, `weekly` or `monthly` (stored as an RRULE in `rrule`). */
    recurrence: text().notNull().default("none"),
    rrule: text(),
    /** The series rule (`ScheduleRule`, no times: the event's own); null = the legacy `recurrence`. */
    rule: jsonb().$type<Record<string, unknown>>(),
    /** Original starts (ISO) of occurrences removed from the series ("only this one"). */
    exdates: jsonb().$type<string[]>().notNull().default([]),
    /** An edited occurrence ("only this one"): the series it belongs to, and that occurrence's original start. */
    overrideOf: uuid(),
    originalStart: timestamp({ withTimezone: true }),
    channelId: uuid(),
    issueId: uuid(),
    createdByType: text().notNull(),
    createdById: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.startAt)],
);

export const calendarAttendees = pgTable(
  "calendar_attendees",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    eventId: uuid()
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    /** `person` or `agent`. */
    attendeeType: text().notNull(),
    attendeeId: text().notNull(),
    /** `needs_action`, `accepted` or `declined`. */
    status: text().notNull().default("needs_action"),
    respondedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.eventId, t.attendeeType, t.attendeeId), index().on(t.orgId, t.attendeeId)],
);

/** A slot an agent suggested; nothing is created until the person who asked confirms it. */
export const calendarProposals = pgTable(
  "calendar_proposals",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    runId: uuid(),
    requesterUserId: text().notNull(),
    channelId: uuid().notNull(),
    messageId: uuid(),
    title: text().notNull(),
    description: text().notNull().default(""),
    startAt: timestamp({ withTimezone: true }).notNull(),
    endAt: timestamp({ withTimezone: true }).notNull(),
    participants: jsonb().$type<{ type: string; id: string }[]>().notNull().default([]),
    /** A repeating proposal (`ScheduleRule`). */
    rule: jsonb().$type<Record<string, unknown>>(),
    note: text(),
    /** `pending`, `confirmed` or `dismissed`. */
    status: text().notNull().default("pending"),
    eventId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.requesterUserId, t.status)],
);
