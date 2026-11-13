import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";

/**
 * What an agent did outside the organization (ADR 0064): a connected app's
 * write through the Tool Gateway, an action a person approved, or a command
 * that left the computer. Searchable (kind `action`) by whoever sees
 * `channel_id`; before the next outside action on one of the same `targets`,
 * the agent is told (`team_action_checks`). Kept when the agent is deleted:
 * it is the team's history.
 */
export const teamActions = pgTable(
  "team_actions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    /** The run that did it; null for a mission task's executor without one. */
    runId: uuid(),
    /** Where it belongs, for visibility: the run's conversation, or where its routine delivers. Null = nowhere. */
    channelId: uuid(),
    /** `tool` (the gateway ran it), `approval` (a person approved it) or `command` (a computer command allowed). */
    source: text().$type<"tool" | "approval" | "command">().notNull(),
    /** The tool or command (`mail_sales_send`, `gh pr create`). */
    tool: text().notNull(),
    /** What people see for the step, cut short. */
    summary: text().notNull().default(""),
    /** Normalized identifiers it touched: `email:…`, `phone:…`, `url:…`, `github:owner/repo#12`, `github:owner/repo@branch`. */
    targets: text().array().notNull().default(sql`'{}'::text[]`),
    /** Why the agent went on after it was told the team already did this. */
    reason: text(),
    /** A command's pending prompt (its request id): the row goes away if a person says no. */
    ref: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orgId, t.createdAt),
    index("team_actions_targets_idx").using("gin", t.targets),
    index().on(t.orgId, t.ref),
  ],
);

/** An earlier action an agent was told about, as the message under its reply shows it. */
export interface TeamActionMatch {
  actionId: string;
  /** Null when it happened where the acting agent can't see: only "someone on the team" and when. */
  agentId: string | null;
  tool: string | null;
  summary: string | null;
  channelId: string | null;
  /** The targets both share. */
  targets: string[];
  at: string;
}

/**
 * An outside call held because the team already acted on one of its targets
 * (ADR 0064 §4): `held` the first time in a run, `repeated` when the agent
 * went on anyway. Rides on the run's reply like a receipt (`message_id`).
 */
export const teamActionChecks = pgTable(
  "team_action_checks",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid().notNull(),
    agentId: uuid().notNull(),
    /** The reply it rides on; null until the run posts one. */
    messageId: uuid(),
    tool: text().notNull(),
    targets: text().array().notNull().default(sql`'{}'::text[]`),
    matches: jsonb().$type<TeamActionMatch[]>().notNull().default([]),
    outcome: text().$type<"held" | "repeated">().notNull().default("held"),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.runId), index().on(t.orgId, t.messageId)],
);
