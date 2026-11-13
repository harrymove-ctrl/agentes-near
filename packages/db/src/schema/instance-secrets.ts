import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * Secrets of the whole installation, sealed like provider keys (ADR 0007), that its owner adds in Settings: the
 * TypeSafe key for Jev (ADR 0073), the GIPHY key for GIFs (ADR 0091), the speech provider's key (ADR 0100) and the
 * GitHub App made from Settings (ADR 0156; its `key_hint` is the app's public slug). Not a tenant's, so no `org_id`.
 * They travel with backups and open only with the same `AGENTES_SECRET`.
 */
export const instanceSecrets = pgTable(
  "instance_secrets",
  {
    name: text().primaryKey(),
    ciphertext: text().notNull(),
    wrappedDataKey: text().notNull(),
    kekId: text().notNull(),
    /** Its last 4 characters (the GitHub App's slug): the only part ever shown. */
    keyHint: text().notNull(),
    updatedBy: text().references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_secrets_name", sql`${t.name} in ('typesafe', 'giphy', 'speech', 'github_app')`)],
);
