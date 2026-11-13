import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * A Postgres database the organization connected for its agents (ADR 0039):
 * read-only queries through the `pg_*` tools. The password is
 * envelope-encrypted and bound to (org_id, id); it never leaves the server.
 * Agents get `database:read` in `agent_scopes` with `connection_id = id`.
 */
export const dbConnections = pgTable(
  "db_connections",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Shown to people and agents ("Produção", "Analytics"). */
    label: text().notNull(),
    /** Where it lives, for the help in the app (`supabase`, `neon`, `railway`, `rds`, `render`, `other`). */
    provider: text().notNull().default("other"),
    host: text().notNull(),
    port: integer().notNull().default(5432),
    /**
     * The database read; on a whole-server connection, where the list of databases is read and where the
     * rules' tables and sensitive columns were found (the sample).
     */
    database: text().notNull(),
    /** Agents read every database on the server they can open, choosing one per call (`database` input). */
    wholeServer: boolean().notNull().default(false),
    /** Whole server only: just the databases whose names start with this; null = every one. */
    databasePrefix: text(),
    username: text().notNull(),
    /** `require` (TLS, the default) or `disable` (an explicit choice, for test databases). */
    sslmode: text().notNull().default("require"),
    secretCiphertext: text().notNull(),
    wrappedDataKey: text().notNull(),
    kekId: text().notNull(),
    /** `active` or `needs_reconnect` (the password was refused). */
    status: text().notNull().default("active"),
    lastError: text(),
    /** The role can change data (the last test said so): the app recommends a read-only user. */
    canWrite: boolean().notNull().default(false),
    /** Tools turned off for every agent ("O que faz"): `list_tables`, `describe_table`, `query`. */
    offActions: text().array().notNull().default(sql`'{}'::text[]`),
    /** Columns new agent rules hide by default (`schema.table.column`), found on connect. */
    suggestedHidden: text().array().notNull().default(sql`'{}'::text[]`),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * What one agent may read in one database beyond its scope (checked on every
 * query): tables (`schema.table`, empty = all), hidden columns
 * (`schema.table.column`), a daily cap and the per-query time limit.
 */
export const dbAgentPolicies = pgTable(
  "db_agent_policies",
  {
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    connectionId: uuid()
      .notNull()
      .references(() => dbConnections.id, { onDelete: "cascade" }),
    tables: text().array().notNull().default(sql`'{}'::text[]`),
    hiddenColumns: text().array().notNull().default(sql`'{}'::text[]`),
    /** Whole-server connections: the only databases this agent may read (exact names); empty = every one. */
    databases: text().array().notNull().default(sql`'{}'::text[]`),
    /** Queries per agent per connection per day (UTC), summed over its databases; null = no cap. */
    dailyQueryCap: integer(),
    timeoutSeconds: integer().notNull().default(15),
    updatedByUserId: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.connectionId] }), index().on(t.orgId)],
);

/** Every query an agent ran (the daily cap; audit). The rows it returned are never stored. */
export const dbQueries = pgTable(
  "db_queries",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    connectionId: uuid()
      .notNull()
      .references(() => dbConnections.id, { onDelete: "cascade" }),
    runId: uuid(),
    /** `query`, `list_tables`, `describe_table` or `list_databases`. */
    kind: text().notNull(),
    /** Which database of a whole-server connection it read; null on single-database connections. */
    database: text(),
    statement: text().notNull(),
    rowCount: integer(),
    durationMs: integer(),
    /** Why it failed or was refused; null = ran. */
    error: text(),
    ranAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.agentId, t.connectionId, t.ranAt), index().on(t.orgId)],
);
