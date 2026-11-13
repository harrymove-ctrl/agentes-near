import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * A picture or a video a person adds to their feedback (ADR 0160). Its bytes are in the platform's blob store under
 * `feedback/{id}`. Uploaded, it lasts an hour; sent with a feedback, thirty days, behind a link only the email
 * carries (`tokenHash`). It belongs to the person: a workspace (`orgId`) is only where they were when they sent it.
 */
export const feedbackFiles = pgTable(
  "feedback_files",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid().references(() => organizations.id, { onDelete: "set null" }),
    name: text().notNull(),
    /** What its first bytes say it is, never what the upload claimed. */
    contentType: text().notNull(),
    size: integer().notNull(),
    /** SHA-256 of the link's token, set when the feedback is sent. */
    tokenHash: text().unique(),
    sentAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);
