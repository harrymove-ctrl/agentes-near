import { sql } from "drizzle-orm";
import { customType, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Postgres's 64-bit transaction id, which never wraps around. Read back as its decimal text. */
const xid8 = customType<{ data: string }>({ dataType: () => "xid8" });

/**
 * The operator API's events feed (ADR 0056): what happened on this instance (sign-ups, sessions,
 * workspaces, invitations, agents, mail sent, runs and tasks finished, content read by an operator), as
 * metadata, never what anyone wrote. Rows are written only while the operator API is on. No foreign keys
 * on purpose: an event outlives the workspace or account it names, which is when it is needed most.
 */
export const operatorEvents = pgTable(
  "operator_events",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    type: text().notNull(),
    orgId: uuid(),
    /** The person the event is about or who acted. */
    userId: text(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /**
     * The transaction that wrote the row. Ids and timestamps are taken before commit, so they don't say
     * when a row became visible; the feed is ordered by this and served only below the commit horizon.
     */
    xactId: xid8().notNull().default(sql`pg_current_xact_id()`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.xactId, t.id), index().on(t.createdAt)],
);
