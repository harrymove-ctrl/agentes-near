import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { channels } from "./chat";
import { organizations } from "./tenancy";
import { issues } from "./work";

// Unused (forum removed): dropped in a later migration, so the previous release works during a deploy or rollback.
export const forumTopics = pgTable(
  "forum_topics",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    title: text().notNull(),
    goal: text().notNull(),
    /** `open`, `stalled` (a person stopped the turn; waits for "resume"), `done` or `canceled`. */
    status: text().notNull().default("open"),
    /** `discussing`, `waiting_person` (a seated person's turn), `synthesizing` or `finished`. */
    phase: text().notNull().default("discussing"),
    /** Round in progress, from 1 (0 = not started). */
    round: integer().notNull().default(0),
    /** Whose turn in the round (index in the seats' order): the seat speaking, or the next one when nobody is. */
    turn: integer().notNull().default(0),
    maxRounds: integer().notNull().default(3),
    deadline: timestamp({ withTimezone: true }),
    /** What the synthesis is: `decision` or `plan`. */
    format: text().notNull().default("decision"),
    /** Where it came from: `direct`, `channel`, `agent` (asked in a conversation), `suggestion`, `issue` or `routine`. */
    originKind: text().notNull().default("direct"),
    originIssueId: uuid().references(() => issues.id, { onDelete: "set null" }),
    originRoutineId: uuid(),
    /** The agent that suggested it (`suggest_forum_topic`); a person opened it. */
    suggestedByAgentId: uuid(),
    /** "Pedido de": who asked for it (e.g. the origin issue's author); null = the responsible person. */
    requestedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** The seated person whose turn it is (phase `waiting_person`). */
    waitingUserId: text(),
    /** Why it is stalled: `{ reason: "stopped" | "failed", byUserId?, agentId, round, synthesis?, at }`. */
    stall: jsonb().$type<Record<string, unknown>>(),
    /** Reopened by a new round asked from a comment (cleared when the new synthesis is written). */
    reopenedByUserId: text(),
    reopenedAt: timestamp({ withTimezone: true }),
    /** Only these agents speak in that round (a new round asked from a comment). */
    roundSpeakers: jsonb().$type<{ round: number; agentIds: string[] }>(),
    /** `person` or `agent`. */
    createdByType: text().notNull(),
    createdById: text().notNull(),
    /** The responsible person: who set up the table; runs run on their behalf. */
    requesterUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Writes the synthesis; null = the first agent. */
    ownerAgentId: uuid(),
    originChannelId: uuid(),
    originMessageId: uuid(),
    /** The run whose turn it is (or the synthesis run). */
    currentRunId: uuid(),
    /** A person posted: the round ends early and the next one reads it. */
    pendingPerson: boolean().notNull().default(false),
    /** "Concluir": stop after the current turn and write the synthesis. */
    stopRequested: boolean().notNull().default(false),
    synthesisArtifactId: uuid(),
    synthesisVersion: integer(),
    suggestedIssues: jsonb().$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    /** Every synthesis written, oldest first (structured, with the markdown): version 2+ after a reopening. */
    syntheses: jsonb().$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    /** Issues created from the synthesis: `[{ id, number, title }]`. */
    createdIssues: jsonb().$type<{ id: string; number: number; title: string }[]>().notNull().default(sql`'[]'::jsonb`),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    concludedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId, t.status, t.lastActivityAt), uniqueIndex().on(t.channelId), index().on(t.originIssueId)],
);

/**
 * Agents and people in a topic. The table's speaking order: agents by
 * `seat` (else `position`), mixed with the people who sat down (`seat` set).
 */
export const forumParticipants = pgTable(
  "forum_participants",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    topicId: uuid()
      .notNull()
      .references(() => forumTopics.id, { onDelete: "cascade" }),
    agentId: uuid(),
    userId: text(),
    position: integer().notNull().default(0),
    /** Place at the table; a person with no seat posts whenever they want (not in the order). */
    seat: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("forum_participants_agent").on(t.topicId, t.agentId).where(sql`${t.agentId} is not null`),
    uniqueIndex("forum_participants_user").on(t.topicId, t.userId).where(sql`${t.userId} is not null`),
    index().on(t.orgId),
  ],
);

/**
 * How each turn went (the round track): one row per seat per round when it
 * ended, plus people's free posts and the syntheses. Kinds: `spoke`,
 * `skipped_budget` (the agent's own budget was out), `passed` (a seated
 * person passed), `skipped` (deadline, not chosen), `stopped`, `failed`,
 * `person_post` and `synthesis`.
 */
export const forumTurns = pgTable(
  "forum_turns",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    topicId: uuid()
      .notNull()
      .references(() => forumTopics.id, { onDelete: "cascade" }),
    round: integer().notNull(),
    /** `agent` or `person`. */
    seatType: text().notNull(),
    seatId: text().notNull(),
    kind: text().notNull(),
    runId: uuid(),
    messageId: uuid(),
    /** Characters of the post (the track's column height). */
    length: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.topicId, t.round), index().on(t.orgId)],
);
