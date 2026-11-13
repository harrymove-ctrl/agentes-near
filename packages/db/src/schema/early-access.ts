import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * Who may sign up, changed live through the operator API (ADR 0078): `invite` (an invitation is needed) or
 * `open`. One row for the whole installation, so no `org_id`; a missing row reads as `invite`.
 * `ALLOW_SIGNUP=true` opens sign-up whatever it says.
 */
export const signupSettings = pgTable(
  "signup_settings",
  {
    id: integer().primaryKey().default(1),
    mode: text({ enum: ["invite", "open"] })
      .notNull()
      .default("invite"),
    /** When `mode` last changed; null: never. */
    changedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("signup_settings_one_row", sql`${t.id} = 1`),
    check("signup_settings_mode", sql`${t.mode} in ('invite', 'open')`),
  ],
);

/**
 * Early access (ADR 0078): one invitation per address, sent by the people who run the installation, lets that
 * address create an account, or allows the account it already has, and then make workspaces of its own.
 * Installation-level, so no `org_id`. Only the SHA-256 of the link's token is kept; the token itself is only in
 * the email.
 */
export const earlyAccessInvitations = pgTable(
  "early_access_invitations",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Lowercase and trimmed; matched exactly. */
    email: text().notNull(),
    /** The language of the email (a code of `@agenteschat/i18n/locale`). */
    locale: text().notNull().default("en"),
    /** The current link's token hash; null once used or revoked. */
    tokenHash: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The latest send. */
    sentAt: timestamp({ withTimezone: true }).notNull(),
    sends: integer().notNull().default(1),
    /** `sentAt` + 14 days: the link signs nobody up after it. */
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    /** When an account was created with it, or the address's account was allowed (no link then). */
    usedAt: timestamp({ withTimezone: true }),
    userId: text().references(() => users.id, { onDelete: "set null" }),
    /** When its account created its first workspace. */
    workspaceCreatedAt: timestamp({ withTimezone: true }),
    workspaceId: uuid().references(() => organizations.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("early_access_invitations_email").on(t.email),
    uniqueIndex("early_access_invitations_token").on(t.tokenHash),
    index("early_access_invitations_user").on(t.userId),
    index("early_access_invitations_created").on(t.createdAt, t.id),
  ],
);
