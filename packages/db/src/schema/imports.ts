import { boolean, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * What an import made (ADR 0055): one row per item of a source package, so
 * importing the same package again updates or keeps what it made instead of
 * duplicating it, and never touches what it didn't make. Matching by name
 * alone would break once a taken handle got a suffix (`scout` → `scout-2`).
 * Rows belong to the person who imported: many packages have generic ids (a
 * default agent `main`, a folder named `.openclaw`), so someone else's
 * package must land as new items, never as updates to theirs.
 */
export const importItems = pgTable(
  "import_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The app it came from (`openmausbot`, `openclaw`, `agenteschat`…). */
    sourceApp: text().notNull(),
    /** The package or workspace in that app. */
    sourceRef: text().notNull(),
    /** `agent`, `skill`, `channel`, `routine` or `note`. */
    kind: text().notNull(),
    /** The item's own id in the source. */
    key: text().notNull(),
    /** The agent, skill, channel, routine or context item it became. */
    targetId: uuid().notNull(),
    /** SHA-256 of the item as the source had it: a different one on the next import is an update. */
    hash: text().notNull(),
    /** A channel that already existed: the import only joined its agents to it (it must never delete it). */
    adopted: boolean().notNull().default(false),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("import_items_source_item").on(t.orgId, t.createdByUserId, t.sourceApp, t.sourceRef, t.kind, t.key)],
);
