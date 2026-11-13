import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";
import { routines } from "./work";

/**
 * A mailbox the organization connected for its agents (ADR 0038): Gmail or
 * Outlook through Composio (`via = composio`, the OAuth stays at Composio,
 * `external_account_id` is its connected account), or any IMAP/SMTP server
 * (`via = imap`, the app password is envelope-encrypted here and bound to
 * (org_id, id)). Agents get scopes on it in `agent_scopes` with
 * `connection_id = id` (`mail:read`, `mail:draft`, `mail:send`,
 * `mail:organize`, `mail:delete`).
 */
export const mailAccounts = pgTable(
  "mail_accounts",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `gmail`, `outlook` or `imap`. */
    provider: text().notNull(),
    /** `composio` or `imap`. */
    via: text().notNull(),
    /** The mailbox address; for Composio, read from the account once it is active. Lowercase. */
    address: text().notNull().default(""),
    /** Shown to people ("Suporte", "Walter"). */
    label: text().notNull().default(""),
    /** `pending` (OAuth not finished), `active`, `needs_reconnect` (expired, revoked or wrong password). */
    status: text().notNull().default("pending"),
    lastError: text(),
    /** Composio: connected account id (`ca_…`). */
    externalAccountId: text(),
    /** IMAP: preset id (`icloud`, `locaweb`, `custom`…), hosts and login. */
    preset: text(),
    imapHost: text(),
    imapPort: integer(),
    smtpHost: text(),
    smtpPort: integer(),
    username: text(),
    /** IMAP: the app password, sealed. */
    secretCiphertext: text(),
    wrappedDataKey: text(),
    kekId: text(),
    /**
     * Actions turned off for this mailbox for every agent (the connect flow's
     * "O que faz"): `search`, `read`, `folders`, `draft`, `organize`, `send`,
     * `reply`, `forward`, `delete`.
     */
    offActions: text().array().notNull().default(sql`'{}'::text[]`),
    /**
     * Actions that ask a person every time in this mailbox, whatever the
     * agent's rules (`draft`, `organize`; sends and deletes always ask).
     */
    askActions: text().array().notNull().default(sql`'{}'::text[]`),
    /** IMAP: the server's name for the sent folder (SMTP doesn't keep a copy). */
    sentFolder: text(),
    /**
     * Other addresses this mailbox sends and receives as (iCloud custom
     * domains, Gmail "send as"), lowercase. A reply goes out from the one the
     * message arrived at.
     */
    aliases: text().array().notNull().default(sql`'{}'::text[]`),
    /** What new mail goes out from (`address` or one of `aliases`); null = `address`. */
    defaultFrom: text(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.orgId),
    uniqueIndex("mail_accounts_one_active_address")
      .on(t.orgId, t.address)
      .where(sql`${t.revokedAt} is null and ${t.address} <> ''`),
  ],
);

/**
 * What one agent may do with one mailbox beyond its scopes (checked per call
 * by the mail tools' `checkCall`). Empty arrays = no limit of that kind.
 * Sending asks a person every time unless `send_without_asking`, which only
 * counts with a non-empty `allowed_recipients`.
 */
export const mailAgentPolicies = pgTable(
  "mail_agent_policies",
  {
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    /** Folders it may read and move into (names as the server says them); empty = all. */
    folders: text().array().notNull().default(sql`'{}'::text[]`),
    /** It only reads mail from these addresses or `@domains`; empty = any sender. */
    senders: text().array().notNull().default(sql`'{}'::text[]`),
    /** It only reads mail from the last N days; null = no limit. */
    windowDays: integer(),
    /** It may only send to these addresses or `@domains`; empty = anyone (with approval). */
    allowedRecipients: text().array().notNull().default(sql`'{}'::text[]`),
    /** Sends per agent per mailbox per day (UTC), approved or not. */
    dailySendCap: integer().notNull().default(25),
    sendWithoutAsking: boolean().notNull().default(false),
    /**
     * The only address this agent sends from (the mailbox's or one of its
     * aliases); null = replies from the address the message arrived at, new
     * mail from the mailbox's `default_from`.
     */
    fromAddress: text(),
    updatedByUserId: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.accountId] }), index().on(t.orgId)],
);

/** Every message an agent sent (counts the daily cap; audit). */
export const mailSends = pgTable(
  "mail_sends",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    runId: uuid(),
    /** `send`, `reply` or `forward`. */
    kind: text().notNull(),
    recipients: text().array().notNull(),
    subject: text().notNull().default(""),
    /** The provider's id of the sent message, when it gives one. */
    providerMessageId: text(),
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.agentId, t.accountId, t.sentAt), index().on(t.orgId)],
);

/**
 * A routine woken by new mail (`routines.trigger_type = 'event'`,
 * `event = 'email.received'`): which mailbox and folder, the filter, and the
 * provider-side state. Composio: a trigger whose id is `external_trigger_id`
 * (the filter is pushed to Gmail as a search). IMAP: polled; `last_uid` and
 * `uid_validity` say where the last check stopped.
 */
export const mailWatches = pgTable(
  "mail_watches",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    routineId: uuid()
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => mailAccounts.id, { onDelete: "cascade" }),
    folder: text().notNull().default("INBOX"),
    /** `{ from?: string[], subject?: string, text?: string }` (from: addresses or `@domains`). */
    filter: jsonb().$type<{ from?: string[]; subject?: string; text?: string }>().notNull().default({}),
    externalTriggerId: text(),
    lastUid: bigint({ mode: "number" }),
    uidValidity: bigint({ mode: "number" }),
    lastCheckedAt: timestamp({ withTimezone: true }),
    /** `active`, `needs_reconnect` or `error`. */
    status: text().notNull().default("active"),
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.routineId), index().on(t.accountId), index().on(t.orgId)],
);

/** Messages already handed to a watch's routine: a webhook retried or a poll overlapping never runs it twice. */
export const mailSeen = pgTable(
  "mail_seen",
  {
    orgId: uuid().notNull(),
    watchId: uuid()
      .notNull()
      .references(() => mailWatches.id, { onDelete: "cascade" }),
    /** The provider's message id (Gmail/Graph id, or `uidValidity:uid` on IMAP). */
    messageKey: text().notNull(),
    seenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.watchId, t.messageKey] }), index().on(t.orgId), index().on(t.seenAt)],
);
