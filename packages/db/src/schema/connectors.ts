import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  foreignKey,
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
import { agents } from "./agents";
import { users } from "./auth";
import { channels } from "./chat";
import { organizations } from "./tenancy";

/**
 * An organization's connection to an MCP server (layer 1 of ADR 0016: the org
 * connects once; agents get subsets of its scopes in `agent_scopes`).
 * `connector` is a key of the catalog in `@agenteschat/engine`
 * (`CONNECTOR_CATALOG`), which maps each tool to one of our scopes.
 * Credentials (OAuth tokens or an API key, as JSON) are envelope-encrypted
 * like provider credentials and bound to (org_id, id). One active connection
 * per catalog connector per organization; an MCP server by address may have
 * several, one per account (ADR 0099). A service through Composio (ADR 0107)
 * is a server by address too, at its toolkit's address, with Composio's
 * connected account and no secret: Composio holds the tokens.
 */
export const connectorConnections = pgTable(
  "connector_connections",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connector: text().notNull(),
    label: text().notNull(),
    serverUrl: text().notNull(),
    /**
     * `oauth`, `api_key` or `none`; `github_app`: GitHub through the workspace's installations of the GitHub App
     * alone (ADR 0156), with no secret and the installations' accounts as `account_label`.
     */
    authType: text().notNull(),
    secretCiphertext: text(),
    wrappedDataKey: text(),
    kekId: text(),
    /** When the OAuth access token expires (refreshed before calls). */
    tokenExpiresAt: timestamp({ withTimezone: true }),
    /** Account on the other side, as the provider names it ("Acme"), for display. */
    accountLabel: text(),
    /** The provider's id of that account (`acct_…`): the same account connected again is that row. */
    accountId: text(),
    /**
     * What this connection's tool names start with (`stripe` → `stripe_list_customers`), set once: renaming
     * never changes a tool's name, so per-tool grants and denials keep applying. A catalog connector's is its id.
     * A row the previous version inserts while this one deploys (or after a rollback) gets one from a trigger
     * (migration 0157), named as that version named its tools.
     */
    toolPrefix: text().notNull(),
    /** Custom servers: when an admin last saved the tool classification (null = nothing exposed yet). */
    reviewedAt: timestamp({ withTimezone: true }),
    /** MCP-native OAuth: the client registered with the server's authorization server (`oauth_clients`). */
    oauthClientId: uuid(),
    /** MCP-native OAuth: the protected resource it was authorized for (RFC 8707), sent again with every refresh. */
    resource: text(),
    /**
     * While in the future, one call is refreshing the OAuth tokens and the others wait for them: one refresh at a time
     * across processes, with no transaction open while the provider answers.
     */
    refreshingUntil: timestamp({ withTimezone: true }),
    /** Custom servers: the server's own icon, kept by us (`/api/app/connector-icons/…`); null = a monogram. */
    icon: text(),
    /** A service through Composio: its connected account (`ca_…`). */
    composioAccountId: text(),
    /**
     * A catalog connector's OAuth sign-in: the scopes it granted, space-separated. Fewer than the catalog asks for
     * now: Reconectar adds the rest. Null: a key, a server's own sign-in or Composio.
     */
    oauthScopes: text(),
    /** `active`, or `needs_reconnect` (a Composio account that stopped working: no tools until Reconectar). */
    status: text().notNull().default("active"),
    /** Why it needs reconnecting. */
    lastError: text(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("connector_connections_one_active").on(t.orgId, t.connector).where(sql`${t.revokedAt} is null`),
    uniqueIndex("connector_connections_tool_prefix").on(t.orgId, t.toolPrefix).where(sql`${t.revokedAt} is null`),
    index().on(t.orgId),
    index().on(t.composioAccountId),
  ],
);

/**
 * In-flight OAuth authorizations (state + PKCE). Only the SHA-256 of `state`
 * is stored; the PKCE verifier is sealed. Single use, 10-minute lifetime, and
 * bound to the person who started it. A Composio sign-in has no verifier: it
 * keeps the connected account its Connect Link made instead.
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connector: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stateHash: text().notNull().unique(),
    verifierCiphertext: text(),
    wrappedDataKey: text(),
    kekId: text(),
    /** MCP endpoint to store on the connection (connectors without a default URL). */
    serverUrl: text(),
    /** Where the web app wants to land afterwards (a path on our origin). */
    returnTo: text().notNull().default("/"),
    /** MCP-native OAuth: the registered client, the protected resource (RFC 8707) and the label to give the connection. */
    oauthClientId: uuid(),
    resource: text(),
    label: text(),
    /** "Reconectar": the connection whose sign-in this authorization replaces (null: a new account). */
    connectionId: uuid(),
    /** A Composio sign-in: the connected account its Connect Link made, the only one the return may complete. */
    composioAccountId: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * OAuth clients agentes.chat registered with an MCP server's authorization
 * server (Dynamic Client Registration, RFC 7591), one per org and issuer.
 * A client secret, when the server issues one, is sealed like other secrets.
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    issuer: text().notNull(),
    authorizationEndpoint: text().notNull(),
    tokenEndpoint: text().notNull(),
    clientId: text().notNull(),
    secretCiphertext: text(),
    wrappedDataKey: text(),
    kekId: text(),
    /** The scope it was registered with, space separated (each authorization asks for the scope of its day). */
    scope: text(),
    /**
     * How we authenticate at its token endpoint: `none`, `client_secret_post` or `client_secret_basic`. Null:
     * registered before we chose, as `none`, and a secret it gave anyway goes in the form.
     */
    tokenAuthMethod: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("oauth_clients_org_issuer").on(t.orgId, t.issuer)],
);

/**
 * Tools of a custom MCP server and how an admin classified each one:
 * `read`, `write`, or `approval` (write that always asks a person). Null =
 * not classified yet: never shown to agents.
 */
export const customTools = pgTable(
  "custom_tools",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    connectionId: uuid()
      .notNull()
      .references(() => connectorConnections.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    readOnlyHint: boolean(),
    /** The server's `destructiveHint` annotation, when it sends one. */
    destructiveHint: boolean(),
    /** What we suggest before an admin decides: `read`, `write` or `approval`. */
    suggestedAccess: text(),
    access: text(),
    /** Shown to people (approval cards, permissions), in pt-BR. */
    label: text().notNull().default(""),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The server stopped listing it. */
    removedAt: timestamp({ withTimezone: true }),
    /**
     * Where the suggestion came from: `annotation` (the server's hints), `verb`
     * (the tool's name), `preset` (a one-click server's read-only list),
     * `judge` (the name was ambiguous; the judge's answer, kept as a cache) or
     * `judge_failed` (asked again on the next listing).
     */
    suggestionSource: text(),
    /** A short reason code for the suggestion (the web says it in the person's language). */
    suggestionReason: text(),
    /** Deletes, sends, pays, publishes…: may only ask for approval or be off. */
    sensitive: boolean().notNull().default(false),
    /** A person confirmed the level of an ambiguous tool (until then it waits in "needs your decision"). */
    confirmedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.connectionId, t.name), index().on(t.orgId)],
);

/**
 * An MCP tool's description and input schema as last listed (ADR 0117): a listing that differs is a change, which
 * applies itself, moves the pin and goes to the audit log. `pending_*` and `changed_at` are no longer written: a
 * row that still has them is settled by its connection's next listing. Composio's tools and the ones we serve are
 * never pinned.
 */
export const connectorToolPins = pgTable(
  "connector_tool_pins",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    connectionId: uuid()
      .notNull()
      .references(() => connectorConnections.id, { onDelete: "cascade" }),
    toolName: text().notNull(),
    /** sha256 of the canonical JSON of `{description, inputSchema}`. */
    fingerprint: text().notNull(),
    description: text().notNull().default(""),
    inputSchema: jsonb().$type<Record<string, unknown>>().notNull(),
    pinnedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    pendingFingerprint: text(),
    pendingDescription: text(),
    pendingSchema: jsonb().$type<Record<string, unknown>>(),
    changedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.orgId, t.connectionId, t.toolName), index().on(t.connectionId)],
);

/**
 * Composio tool calls per workspace and calendar month (UTC, `2026-11`), counted before each call (ADR 0107 §7):
 * every workspace shares this server's Composio project and its bill. `capped_at`: when it reached
 * `COMPOSIO_CALLS_PER_MONTH` (its admins were told).
 */
export const composioUsage = pgTable(
  "composio_usage",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    month: text().notNull(),
    calls: integer().notNull().default(0),
    cappedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("composio_usage_org_month").on(t.orgId, t.month)],
);

/**
 * Installations of our GitHub App (git and pull requests), each bound to the
 * one organization that installed it from the app. The app is public, so a
 * repository's installation only yields tokens for the org it belongs to;
 * an installation made outside our install flow binds to nobody.
 */
export const githubAppInstallations = pgTable(
  "github_app_installations",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** GitHub's installation id: one installation belongs to one organization. */
    installationId: bigint({ mode: "number" }).notNull().unique(),
    /** The GitHub account it's installed on (user or organization), for display. */
    accountLogin: text().notNull(),
    /** `User` or `Organization`. */
    accountType: text().notNull(),
    /** `all` or `selected`. */
    repositorySelection: text().notNull().default("selected"),
    /** Suspended on GitHub: no tokens until it's unsuspended. */
    suspendedAt: timestamp({ withTimezone: true }),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * The GitHub items agents opened or wrote on (pull requests, issues, discussions, their reviews and comments), with the
 * conversation each came from: what happens on one later wakes that agent there. Issues, pull requests and
 * discussions share a repository's numbers, so `repo` and `number` name one item. The agent that opened an item keeps
 * it; one it only wrote on goes to whichever agent wrote on it last.
 */
export const githubItems = pgTable(
  "github_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `owner/name`, lowercased: GitHub's names don't tell case apart. */
    repo: text().notNull(),
    number: integer().notNull(),
    agentId: uuid().notNull(),
    /** The agent opened it: its being merged or closed tells the agent. */
    authored: boolean().notNull().default(false),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Where the run's replies went: a thread's root, or null for the conversation's main timeline. */
    threadId: uuid(),
    /** The last run on a task that wrote on it, else the last that did: its task is what a merge or a close changes. */
    runId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.orgId, t.repo, t.number),
  ],
);

/** How a connector's tools reach it: our own code, an MCP server, or this server's Composio project. */
export type ConnectorVia = "native" | "mcp" | "composio";

/**
 * How much agents use each connector, per UTC day (ADR 0103): one row per connector key (`github`, a preset's id, a
 * custom server's hostname, `gmail`…), way (`native`, `mcp`, `composio`), workspace, agent and tool, whose counters
 * one upsert per call adds to. Counts and keys only: never a label, a URL's path, a tool's input or its answer.
 * `agent_id` has no foreign key: the counts outlive a deleted agent. Day first, so reads across workspaces are
 * range scans.
 * ponytail: kept for good, about 5K rows a day at a few hundred active workspaces. Fold days older than a year into
 * months once the table passes about 10M rows.
 */
export const connectorUsageDays = pgTable(
  "connector_usage_days",
  {
    day: date({ mode: "string" }).notNull(),
    connector: text().notNull(),
    via: text().$type<ConnectorVia>().notNull(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    /**
     * The server's own tool name or our verb (`search`, `git_clone`), never the name the model sees. `other` for a
     * custom server's tools without a preset: their owner names them.
     */
    tool: text().notNull(),
    calls: integer().notNull().default(0),
    /** Results with `isError`, and tools that threw. */
    errors: integer().notNull().default(0),
    /** Approval requests the gateway created. */
    approvalsAsked: integer().notNull().default(0),
    /** Approved actions that ran. */
    approvalsGiven: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.connector, t.via, t.orgId, t.agentId, t.tool] }), index().on(t.orgId)],
);

/**
 * What this server asked of its own Composio project, per UTC day (ADR 0103): tool executions, trigger events
 * (webhook deliveries) and connected accounts, which Composio bills, by toolkit (the connector key) and action (the
 * action's or trigger's slug, `connection` for connected accounts). Composio has no usage API, so this is the only
 * count. Same ceiling as `connector_usage_days`.
 */
export const composioUsageDays = pgTable(
  "composio_usage_days",
  {
    day: date({ mode: "string" }).notNull(),
    toolkit: text().notNull(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    action: text().notNull(),
    executions: integer().notNull().default(0),
    /** Executions Composio answered as failed. */
    failures: integer().notNull().default(0),
    events: integer().notNull().default(0),
    /** Connected accounts made, a reconnect's too: Composio bills each once past the free ones. */
    connections: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.toolkit, t.orgId, t.action] }), index().on(t.orgId)],
);
