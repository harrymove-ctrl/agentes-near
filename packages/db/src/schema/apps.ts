import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * AI apps (ADR 0119): Claude, ChatGPT, Cursor and other MCP clients that call this server's `/mcp` as a person,
 * in one workspace. The server is its own OAuth 2.1 authorization server for them. Not the outgoing connectors'
 * `oauth_clients` / `oauth_states` (ADR 0016): those are apps this server signs in to.
 */

/**
 * An app that asked to connect: registered through `/api/oauth/register` (`dcr`, id `agcl_…`) or named by the
 * https address of its own metadata document (`cimd`, the id is that address). Global, like the apps themselves:
 * no `org_id` (allowlisted in the schema test). Nothing it says about itself beyond its name and return addresses
 * is kept, so nothing else it claims (a logo, a home page) can ever reach a consent screen.
 */
export const oauthAppClients = pgTable(
  "oauth_app_clients",
  {
    id: text().primaryKey(),
    kind: text().$type<"dcr" | "cimd">().notNull(),
    /** As it calls itself, cleaned (no control, invisible or direction characters) and cut to 64. */
    name: text(),
    redirectUris: text().array().notNull(),
    /** A metadata document's last good fetch (`cimd`). */
    fetchedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Bumped when a token is issued: a registration with no connection is purged 90 days after its last use. */
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [check("oauth_app_clients_kind", sql`${t.kind} in ('dcr', 'cimd')`), index().on(t.kind, t.lastUsedAt)],
);

/**
 * One authorization in progress: made by `/api/oauth/authorize` (30 minutes to decide), decided on the consent
 * page (`org_id` and `user_id` set then), and carrying the code once allowed (only its sha256, 120 s, used once).
 */
export const oauthAppRequests = pgTable(
  "oauth_app_requests",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    /** The workspace chosen on the consent page; null until then. */
    orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
    clientId: text()
      .notNull()
      .references(() => oauthAppClients.id, { onDelete: "cascade" }),
    redirectUri: text().notNull(),
    state: text(),
    codeChallenge: text().notNull(),
    scopes: text().array().notNull(),
    resource: text(),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    decidedAt: timestamp({ withTimezone: true }),
    codeHash: text().unique(),
    codeExpiresAt: timestamp({ withTimezone: true }),
    codeUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.expiresAt)],
);

/**
 * A person's connection of one app to one workspace (`oauth`, one per person, workspace and app), or a personal
 * token (`token`). How the app is shown (`display_*`, `brand`) is fixed at consent from that request's return
 * address, never from what the app said first.
 */
export const appGrants = pgTable(
  "app_grants",
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
    kind: text().$type<"oauth" | "token">().notNull(),
    /** Null for a personal token, and for an app whose registration was purged. */
    clientId: text().references(() => oauthAppClients.id, { onDelete: "set null" }),
    displayKind: text().$type<"verified" | "https" | "loopback" | "app_scheme" | "token">().notNull(),
    displayName: text().notNull(),
    displayHost: text(),
    /** A known app's mark (`claude`, `openai`, `cursor`, `vscode`), only from a verified address. */
    brand: text(),
    /** `read`, `write`. */
    scopes: text().array().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    consentedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    /** Who revoked it (a person's id), null when the server did (password reset, removed member, unused). */
    revokedBy: text(),
  },
  (t) => [
    check("app_grants_kind", sql`${t.kind} in ('oauth', 'token')`),
    uniqueIndex("app_grants_oauth_unique").on(t.userId, t.orgId, t.clientId).where(sql`${t.kind} = 'oauth'`),
    index("app_grants_active_idx").on(t.orgId, t.userId).where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * A grant's tokens, only as sha256: access (`aga_`, 1 h), refresh (`agf_`, 90 days sliding, rotated in a family
 * with reuse detection) and personal (`agp_`). `request_id`: the authorization whose code minted the family, so a
 * replayed code revokes it.
 */
export const appTokens = pgTable(
  "app_tokens",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantId: uuid()
      .notNull()
      .references(() => appGrants.id, { onDelete: "cascade" }),
    kind: text().$type<"access" | "refresh" | "personal">().notNull(),
    tokenHash: text().notNull().unique(),
    familyId: uuid().notNull(),
    parentId: uuid(),
    requestId: uuid(),
    /**
     * The access its family was consented with (`read`, `write`): one app connected on two computers keeps each
     * connection's own. Null: the grant's (a personal token).
     */
    scopes: text().array(),
    /** How long its family's access tokens live, fixed at the code exchange (Cursor's are longer). */
    accessSeconds: integer(),
    /** Null: a personal token with no expiry. */
    expiresAt: timestamp({ withTimezone: true }),
    /** A refresh token's rotation. */
    usedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("app_tokens_kind", sql`${t.kind} in ('access', 'refresh', 'personal')`),
    index().on(t.grantId),
    index().on(t.familyId),
    index().on(t.requestId),
  ],
);

/** Tasks sent to agents from an app (`send_to_agent`): `list_recent_tasks` and the audit of who sent what. */
export const appSends = pgTable(
  "app_sends",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    grantId: uuid()
      .notNull()
      .references(() => appGrants.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    messageId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.userId, t.createdAt.desc()), index().on(t.messageId)],
);

export type OauthAppClient = typeof oauthAppClients.$inferSelect;
export type OauthAppRequest = typeof oauthAppRequests.$inferSelect;
export type AppGrant = typeof appGrants.$inferSelect;
export type AppToken = typeof appTokens.$inferSelect;
