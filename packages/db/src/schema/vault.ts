import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { agentRuns } from "./runtime";
import { organizations } from "./tenancy";
import { routines } from "./work";

/**
 * A source the Vault reads items from (ADR 0144): 1Password, Bitwarden or a module's own. What it needs to sign in
 * (a token, an API key, a master password) is envelope-encrypted (ADR 0007) and bound to (org, id, owner): it never
 * leaves the server. `ownerUserId` null = a team connection (`manage_credentials`), else only its owner's.
 * The audience columns are the default access of its items (`vault_items.access_from_connection`).
 */
export const vaultConnections = pgTable(
  "vault_connections",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The source's kind (`onepassword`, `bitwarden`, a module's). */
    kind: text().notNull(),
    /** Null = the team's. */
    ownerUserId: text().references(() => users.id, { onDelete: "cascade" }),
    /** What it reads, for people: a vault's or a folder's name. */
    label: text().notNull(),
    /** Non-secret settings the source kept (a server address, a folder's name), shown on screen. */
    config: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** The source's `secret` as JSON, sealed. */
    secretCiphertext: text().notNull(),
    wrappedDataKey: text().notNull(),
    kekId: text().notNull(),
    audienceEveryone: boolean().notNull().default(false),
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    allAgents: boolean().notNull().default(false),
    agentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** `ready`, `error` (`errorCode` says why) or `syncing`. */
    status: text().notNull().default("ready"),
    /** A `VaultSourceErrorCode` while `status` is `error`; never the provider's own words. */
    errorCode: text(),
    syncedAt: timestamp({ withTimezone: true }),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * A Vault item (ADR 0144): a login, a key or a contact. Built-in ones (`connection_id` null) keep their value here:
 * the password, the key's value or the contact's fields as JSON, envelope-encrypted (ADR 0007) and bound to
 * (org, id, owner, `secret_version`), so a row moved to another workspace or owner doesn't open. An external one
 * keeps only metadata: its value is read from its source when it is used.
 * `ownerUserId` null = a team item; else only its owner sees it and agents use it only when they ask.
 */
export const vaultItems = pgTable(
  "vault_items",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `login`, `key` or `contact`. */
    kind: text().notNull(),
    /** Null = built-in. */
    connectionId: uuid().references(() => vaultConnections.id, { onDelete: "cascade" }),
    /** The item's id in its source. */
    externalRef: text(),
    /** Null = the team's. */
    ownerUserId: text().references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text().notNull().default(""),
    /** Login: `https://host[:port]`. */
    website: text(),
    /** Login: `exact` (that origin, the default) or `site` (its registrable domain). */
    match: text().notNull().default("exact"),
    username: text(),
    /** Key: the environment variable (`UPPER_SNAKE`). */
    keyName: text(),
    /** Key: the last 4 characters of its value, to tell keys apart. */
    keyHint: text(),
    /** Built-in only: the value, sealed. */
    secretCiphertext: text(),
    wrappedDataKey: text(),
    kekId: text(),
    /** Bumped on every new value: part of what the seal is bound to. */
    secretVersion: integer().notNull().default(0),
    /**
     * The values an agent's own `make password` replaced, oldest first, each still sealed as its version: a site that
     * turned the new one down leaves the old one in force, so it can come back. A person's new value clears them.
     */
    previousSecrets: jsonb()
      .$type<{ secretCiphertext: string; wrappedDataKey: string; kekId: string; secretVersion: number }[]>()
      .notNull()
      .default([]),
    /** External items follow their connection's access until someone sets theirs. */
    accessFromConnection: boolean().notNull().default(false),
    audienceEveryone: boolean().notNull().default(false),
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    allAgents: boolean().notNull().default(false),
    agentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Gone from its source at the last sync: nobody uses it until it comes back. */
    missing: boolean().notNull().default(false),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** An agent's own contact: it may delete it. */
    createdByAgentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    lastUsedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.kind), uniqueIndex().on(t.connectionId, t.externalRef)],
);

/**
 * Every time a Vault item was used (ADR 0144): typed (`fill`), given to a command (`key`), read by an agent
 * (`read`, contacts), shown or copied by a person, created or edited. Never the value.
 */
export const vaultUses = pgTable(
  "vault_uses",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemId: uuid()
      .notNull()
      .references(() => vaultItems.id, { onDelete: "cascade" }),
    /** `fill`, `key`, `read`, `show`, `copy`, `create` or `edit`. */
    action: text().notNull(),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    /** The person who showed, copied, created or edited it. */
    userId: text().references(() => users.id, { onDelete: "set null" }),
    /** The person an agent worked for. */
    onBehalfOfUserId: text().references(() => users.id, { onDelete: "set null" }),
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    routineId: uuid().references(() => routines.id, { onDelete: "set null" }),
    /** Where a login was typed (`https://host`). */
    origin: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.itemId, t.createdAt), index().on(t.orgId, t.createdAt)],
);
