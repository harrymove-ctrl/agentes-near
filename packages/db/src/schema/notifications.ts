import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * In-app notifications: one inbox per person per organization. People
 * only, never agents. A row may stand for several events of one `group_key`
 * (thread replies, issue comments, reactions): while it is unread and not
 * done, new events merge into it (`actors`, `count`, `latest`).
 *
 * `kind`, `actors`, `source` and `latest` are validated in code
 * (packages/engine/src/notifications.ts). `done_at` set = out of the inbox
 * (by the person, or auto-resolved: question answered, approval decided…);
 * `done_by_user` tells the person's own "Concluir" apart (the "Concluídas" view).
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    /** Blocks an agent or a decision ("Esperando você"). */
    waiting: boolean().notNull().default(false),
    groupKey: text().notNull(),
    /** `[{ type: "user" | "agent", id }]`, most recent first, at most 10. */
    actors: jsonb().$type<{ type: "user" | "agent"; id: string }[]>().notNull().default([]),
    count: integer().notNull().default(1),
    source: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    latest: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp({ withTimezone: true }),
    doneAt: timestamp({ withTimezone: true }),
    doneByUser: boolean().notNull().default(false),
    snoozedUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The inbox: a person's open notifications, newest first.
    index("notifications_inbox").on(t.orgId, t.userId, t.updatedAt).where(sql`${t.doneAt} is null`),
    // "Concluídas": what the person marked done, the latest first.
    index("notifications_done").on(t.orgId, t.userId, t.doneAt).where(sql`${t.doneByUser} and ${t.doneAt} is not null`),
    // At most one open, unread row per group: new events merge into it.
    uniqueIndex("notifications_open_group")
      .on(t.orgId, t.userId, t.groupKey)
      .where(sql`${t.doneAt} is null and ${t.readAt} is null`),
    // Idempotency of one-off notifications and auto-resolve across people (an approval's deciders).
    index("notifications_group").on(t.orgId, t.groupKey),
    // Snoozed rows coming back (worker).
    index("notifications_snoozed").on(t.snoozedUntil).where(sql`${t.snoozedUntil} is not null and ${t.doneAt} is null`),
  ],
);
