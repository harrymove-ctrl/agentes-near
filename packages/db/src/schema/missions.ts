import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
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
import { agents } from "./agents";
import { users } from "./auth";
import { channels } from "./chat";
import { machines } from "./machines";
import { organizations } from "./tenancy";

/**
 * Missions (ADR 0029): the control layer of long work driven by an executor
 * (Claude Code, Codex) on a person's connected computer. A mission lives in
 * ONE thread (its home, `thread_root_id`); the executor's main session
 * (`main_session_id`) planned it and receives what people send; per-item work
 * runs as machine tasks (`machine_tasks.mission_id`). Seeing is inherited from
 * the home thread; acting is the owner's and the `decide` participants'.
 * No budget: what runs on the machine costs us nothing.
 */
/**
 * `awaiting_close` (migration 0054): every plan item is done or dropped and
 * nothing runs; the mission waits for its owner to conclude it (a delivery
 * card). New work brings it back to `active`. Counts as open.
 */
export const missionStatusEnum = pgEnum("mission_status", [
  "proposed",
  "active",
  "paused",
  "done",
  "canceled",
  "awaiting_close",
]);
export const missionRoleEnum = pgEnum("mission_role", ["decide", "comment"]);
export const missionDecisionStatusEnum = pgEnum("mission_decision_status", ["pending", "provisional", "taken"]);
export const missionReviewStatusEnum = pgEnum("mission_review_status", ["pending", "approved", "changes_requested"]);
export const missionJoinStatusEnum = pgEnum("mission_join_status", ["pending", "accepted", "declined"]);

/** A plan item as the executor keeps it (`update_plan`). */
export interface MissionPlanItem {
  id: string;
  title: string;
  status: "todo" | "doing" | "waiting_you" | "done" | "dropped";
  note?: string;
}

/**
 * What the agent found before proposing a mission (ADR 0037 round 2): it
 * investigates with read tools first, so the plan card arrives with evidence.
 * `read`: code or files it read; `data`: numbers from analytics, logs, errors;
 * `decision`: the one open question that is the person's (at most one).
 * `refs`: files with lines, links, ids it cites.
 */
export interface MissionFinding {
  kind: "read" | "data" | "decision";
  text: string;
  refs?: string[];
}

/** Something to tell a session when it can hear it (its task ended, the mission resumed, the machine came back). */
export interface MissionInboxEntry {
  sessionId: string;
  /** Where the session runs, relative to the agent's folder. */
  cwd: string;
  text: string;
  at: string;
}

export const missions = pgTable(
  "missions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The home thread (root message id); one mission per thread. */
    threadRootId: uuid().notNull(),
    channelId: uuid().notNull(),
    agentId: uuid().notNull(),
    ownerId: text().references(() => users.id, { onDelete: "set null" }),
    /** The computer the work runs on; handing the mission over doesn't move it. */
    machineId: uuid().references(() => machines.id, { onDelete: "set null" }),
    /** The machine belongs to this person (not the owner), who keeps lending it explicitly. */
    machineLentBy: text().references(() => users.id, { onDelete: "set null" }),
    /** `claude`, `codex` or `agent` (our agent works on the machine itself with its own tools); validated in code. */
    executor: text().notNull().default("claude"),
    title: text().notNull(),
    goal: text().notNull(),
    /** What the agent found before proposing it (read only); empty when a person started it. */
    findings: jsonb().$type<MissionFinding[]>().notNull().default([]),
    status: missionStatusEnum().notNull().default("proposed"),
    /** The executor's main session (a UUID): planned the mission, hears people, splits work. */
    mainSessionId: text().notNull(),
    /** The repository folder on the machine, relative to the agent's folder ('' = the folder itself). */
    repoDir: text().notNull().default(""),
    /**
     * The mission's own copy of the project (ADR 0044): one git worktree on
     * one branch, made at Start from the branch checked out in `repo_dir`
     * (`base_branch` at `base_sha`). The main session and every item work in
     * `worktree_path` (relative to the agent's folder). A folder without git
     * has no worktree: `worktree_path` = `repo_dir`, `branch` null.
     */
    branch: text(),
    baseBranch: text(),
    baseSha: text(),
    worktreePath: text(),
    /** `none | preparing | ready | failed | removed`; validated in code. Work waits while `preparing` or `failed`. */
    worktreeState: text().notNull().default("none"),
    /** The last lines of a failed setup (or why the folder couldn't be made). */
    worktreeError: text(),
    /** Why it is `failed`: `setup | ensure | branch_missing`; validated in code (null otherwise). */
    worktreeFailReason: text(),
    /** Interrupted mission tasks resume by themselves when the machine comes back. */
    resumeTasks: boolean().notNull().default(true),
    /**
     * Command cards (ADR 0029): `always` (every command off the allow list
     * asks), `low_risk_auto` (the judge allows low-risk ones within what code
     * allows) or `never` (everything but the deny list); validated in code.
     */
    commandApproval: text().notNull().default("low_risk_auto"),
    /** Overrides the agent's brain (ADR 0032; null = from `executor`); chosen before Start. */
    brain: text(),
    /** Overrides the brain's model (null = the agent's, or the brain's default); may change any time. */
    brainModel: text(),
    /**
     * Agent mode: the agent's wake-ups in a row with no plan item changing
     * state (the stuck-loop guard pauses the mission at 5).
     */
    idleWakeups: integer().notNull().default(0),
    /** From the latest plan version (cheap counts for lists). */
    planVersion: integer().notNull().default(0),
    planDone: integer().notNull().default(0),
    planTotal: integer().notNull().default(0),
    planWaiting: integer().notNull().default(0),
    /** Messages for sessions that couldn't hear them yet (a task running, paused, offline). */
    inbox: jsonb().$type<MissionInboxEntry[]>().notNull().default([]),
    /** `.agentes/` files need writing to the machine (set on every change; cleared once written). */
    filesDirtyAt: timestamp({ withTimezone: true }),
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    pausedAt: timestamp({ withTimezone: true }),
    closedAt: timestamp({ withTimezone: true }),
    closedBy: text().references(() => users.id, { onDelete: "set null" }),
    /** `done` / `canceled` and an optional note. */
    closeReason: text(),
    /** "Save to wiki" on close: the page it made. */
    wikiPageId: uuid(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
    unique().on(t.orgId, t.threadRootId),
    index().on(t.orgId, t.status),
    index().on(t.machineId),
  ],
);

/** Who may act in a mission besides its owner (default: nobody). */
export const missionParticipants = pgTable(
  "mission_participants",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: missionRoleEnum().notNull(),
    addedBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.missionId, t.userId), index().on(t.orgId, t.userId)],
);

/** Every version of the plan (the executor's `update_plan`). */
export const missionPlanVersions = pgTable(
  "mission_plan_versions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    items: jsonb().$type<MissionPlanItem[]>().notNull(),
    /** `executor` or `person`. */
    source: text().notNull().default("executor"),
    taskId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.missionId, t.version)],
);

/** Decision cards (`ask_decision`): blocking ones wait; provisional ones are collected for review. */
export const missionDecisions = pgTable(
  "mission_decisions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    /** The task (and its session) that asked: resumed with the answer. */
    taskId: uuid(),
    sessionId: text(),
    /** The card in the thread. */
    messageId: uuid(),
    question: text().notNull(),
    options: jsonb().$type<string[]>().notNull(),
    recommendation: text(),
    why: text(),
    impact: text(),
    blocking: boolean().notNull().default(true),
    status: missionDecisionStatusEnum().notNull().default("pending"),
    chosen: text(),
    chosenBy: text().references(() => users.id, { onDelete: "set null" }),
    chosenAt: timestamp({ withTimezone: true }),
    /** People who can comment say what they prefer; only the owner and deciders choose. */
    opinions: jsonb().$type<{ userId: string; option: string; at: string }[]>().notNull().default([]),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.missionId, t.status)],
);

/** Review cards (`request_review`): "ready for you to see", approved or with changes asked. */
export const missionReviews = pgTable(
  "mission_reviews",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    taskId: uuid(),
    sessionId: text(),
    messageId: uuid(),
    title: text().notNull(),
    summary: text().notNull().default(""),
    prUrl: text(),
    artifactIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    status: missionReviewStatusEnum().notNull().default("pending"),
    note: text(),
    decidedBy: text().references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.missionId, t.status)],
);

/** The `.agentes/` files: what we last wrote (mission.md, decisions.md) and the executor's notes.md as read back. */
export const missionFiles = pgTable(
  "mission_files",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    /** `mission.md`, `decisions.md` or `notes.md`. */
    name: text().notNull(),
    content: text().notNull().default(""),
    sha256: text().notNull().default(""),
    /** `server` (we wrote it) or `machine` (read back). */
    source: text().notNull().default("server"),
    /** SHA-256 of what we last wrote to the machine: a different file there was edited by hand. */
    lastWrittenSha: text(),
    writtenAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.missionId, t.name)],
);

/** Append-only feed of what happened (reports, plan changes, decisions, files edited on the machine…). */
export const missionEvents = pgTable(
  "mission_events",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.missionId, t.createdAt)],
);

/**
 * "Pedir para participar": someone who sees a mission but takes no part asks
 * its owner and deciders to join. At most one pending request per person.
 */
export const missionJoinRequests = pgTable(
  "mission_join_requests",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: missionJoinStatusEnum().notNull().default("pending"),
    /** The role given on accept. */
    role: missionRoleEnum(),
    decidedBy: text().references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mission_join_requests_one_pending").on(t.missionId, t.userId).where(sql`${t.status} = 'pending'`),
    index().on(t.missionId, t.status),
  ],
);

/** A delivery's checklist item ("O que conferir"). */
export interface MissionDeliveryItem {
  id: string;
  text: string;
}

/**
 * Delivery cards (migration 0054): the executor's `complete_mission` (what it
 * delivered, the files, what to check) or, when every plan item is done and
 * nothing runs without that call, an automatic one ("Tudo pronto"). The owner
 * or a decider concludes the mission (`accepted`) or asks for changes. Each
 * person checks the checklist on their own (`checks`: user id → item ids).
 * Status (text, validated in code): `pending | accepted | changes_requested | superseded`.
 */
export const missionDeliveries = pgTable(
  "mission_deliveries",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    missionId: uuid()
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    taskId: uuid(),
    /** The card in the thread. */
    messageId: uuid(),
    /** Made by us (all items done, no `complete_mission`). */
    auto: boolean().notNull().default(false),
    summary: text().notNull().default(""),
    artifactIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** The paths the executor gave (as uploaded). */
    paths: jsonb().$type<string[]>().notNull().default([]),
    checklist: jsonb().$type<MissionDeliveryItem[]>().notNull().default([]),
    checks: jsonb().$type<Record<string, string[]>>().notNull().default({}),
    status: text().notNull().default("pending"),
    note: text(),
    saveToWiki: boolean().notNull().default(false),
    decidedBy: text().references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.missionId, t.status)],
);
