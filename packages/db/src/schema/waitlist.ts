import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * People waiting for access (the landing page has no sign-up, only this
 * list). Not tenant-owned: it exists before any organization. Only what the
 * invitation needs is kept: the email (lowercase) and the language to write in.
 * An entry counts only once the email is confirmed (double opt-in): the link
 * in the confirmation email carries a token whose hash is kept here.
 */
export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    /** The language of the invitation email (a code of `@agenteschat/i18n/locale`). */
    locale: text().notNull().default("en"),
    /** Where they joined from ("landing"). */
    source: text().notNull().default("landing"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Set when the invitation for their wave goes out. */
    invitedAt: timestamp({ withTimezone: true }),
    /** Set when they open the link in the confirmation email. Unconfirmed entries are never invited. */
    confirmedAt: timestamp({ withTimezone: true }),
    /** sha256 of the token in the latest confirmation link (the token itself is only in the email). */
    confirmTokenHash: text(),
    /** When the latest confirmation email was queued (the link expires 48 h after). */
    confirmSentAt: timestamp({ withTimezone: true }),
    /** How many confirmation emails went out, capped so the form can't flood an inbox. */
    confirmSends: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("waitlist_entries_email").on(t.email),
    uniqueIndex("waitlist_entries_confirm_token").on(t.confirmTokenHash),
  ],
);
