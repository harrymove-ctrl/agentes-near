import {
  and,
  asc,
  type Database,
  type Executor,
  eq,
  inArray,
  isNull,
  like,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { NotFoundError, ValidationError } from "../errors";
import { requirePermission } from "../organizations";
import { isRightHand, RIGHT_HAND_GRANTS } from "../right-hand";
import type { ToolDefinition } from "./types";

const { agentScopes, agents, mailAccounts, dbConnections, users } = schema;

/**
 * Mail grants (`agent_scopes` rows whose connection is a mailbox, ADR 0038)
 * and database grants (a database connection, ADR 0039) are managed only by
 * their own APIs (`setAgentMail`, `setAgentDatabase`): replacing an agent's
 * other grants keeps them.
 */
export const notMailGrant = (orgId: string) =>
  sql`(${agentScopes.connectionId} is null or (${agentScopes.connectionId} not in (select ${mailAccounts.id} from ${mailAccounts} where ${mailAccounts.orgId} = ${orgId}) and ${agentScopes.connectionId} not in (select ${dbConnections.id} from ${dbConnections} where ${dbConnections.orgId} = ${orgId})))`;

/** Which of these connection ids are the org's mailboxes or databases (grants managed by their own APIs). */
export async function mailConnectionIds(db: Executor, orgId: string, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.orgId, orgId), inArray(mailAccounts.id, wanted)));
  const dbs = await db
    .select({ id: dbConnections.id })
    .from(dbConnections)
    .where(and(eq(dbConnections.orgId, orgId), inArray(dbConnections.id, wanted)));
  return new Set([...rows, ...dbs].map((r) => r.id));
}

/** Deletes the mail grants `where` picks, each mailbox taken from each agent audited with `reason`. */
async function dropMailGrants(db: Executor, orgId: string, where: SQL, actorId: string, reason: string) {
  const dropped = await db
    .delete(agentScopes)
    .where(and(eq(agentScopes.orgId, orgId), like(agentScopes.scope, "mail:%"), where))
    .returning({ agentId: agentScopes.agentId, accountId: agentScopes.connectionId });
  const pairs = new Map<string, { agentId: string; accountId: string }>();
  for (const { agentId, accountId } of dropped)
    if (accountId) pairs.set(`${agentId}:${accountId}`, { agentId, accountId });
  for (const { agentId, accountId } of pairs.values()) {
    caches.scopes.delete(`${orgId}:${agentId}`);
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.mail_access_changed",
      target: { type: "agent", id: agentId },
      details: { accountId, level: "none", reason },
    });
  }
  return [...pairs.values()];
}

/**
 * Someone new can talk to the agent (its audience widened, or it has a new owner): it loses the mailboxes of everyone
 * but `keeperId`. Only a mailbox's owner gives an agent access to it, for the people the agent answered then (ADR 0038
 * addendum); they give it again if they still want to. Returns the mailboxes taken, each audited.
 */
export async function dropForeignMailGrants(
  db: Executor,
  orgId: string,
  agentId: string,
  keeperId: string | null,
  actorId: string,
) {
  const foreign = db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.orgId, orgId), notKeepers(keeperId)));
  const where = and(eq(agentScopes.agentId, agentId), inArray(agentScopes.connectionId, foreign)) as SQL;
  return (await dropMailGrants(db, orgId, where, actorId, "audience_widened")).map((d) => d.accountId);
}

const notKeepers = (keeperId: string | null) => sql`${mailAccounts.createdByUserId} is distinct from ${keeperId}`;

/** A mailbox someone else gave the agent: what `dropForeignMailGrants` would take, with whose it is. */
export interface ForeignMailbox {
  accountId: string;
  address: string;
  ownerUserId: string | null;
  ownerName: string | null;
}

/** The mailboxes `dropForeignMailGrants` would take from the agent, taking nothing. */
export async function foreignMailboxes(
  db: Executor,
  orgId: string,
  agentId: string,
  keeperId: string | null,
): Promise<ForeignMailbox[]> {
  return db
    .selectDistinct({
      accountId: mailAccounts.id,
      address: mailAccounts.address,
      ownerUserId: mailAccounts.createdByUserId,
      ownerName: users.name,
    })
    .from(agentScopes)
    .innerJoin(mailAccounts, eq(mailAccounts.id, agentScopes.connectionId))
    .leftJoin(users, eq(users.id, mailAccounts.createdByUserId))
    .where(
      and(
        eq(agentScopes.orgId, orgId),
        eq(agentScopes.agentId, agentId),
        like(agentScopes.scope, "mail:%"),
        eq(mailAccounts.orgId, orgId),
        notKeepers(keeperId),
      ),
    )
    .orderBy(asc(mailAccounts.address));
}

/**
 * `ownerUserId` leaves the workspace: every agent loses their mailboxes, so none goes on reading or sending in the name
 * of someone who left. Rejoining doesn't give them back; the owner grants them again.
 */
export async function dropMailOfOwner(db: Executor, orgId: string, ownerUserId: string, actorId: string) {
  const theirs = db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(and(eq(mailAccounts.orgId, orgId), eq(mailAccounts.createdByUserId, ownerUserId)));
  return dropMailGrants(db, orgId, inArray(agentScopes.connectionId, theirs), actorId, "owner_left");
}

/**
 * Scopes of built-in tools (no connector). Connector scopes come from each
 * connector's catalog (`connectors/catalog.ts`).
 */
export const BUILTIN_SCOPES: Record<string, { label: string; description: string; sensitive?: boolean }> = {
  "context:read": {
    label: "Read context",
    description: "Search messages, summaries and facts in the agent's channels.",
  },
  "memory:write": { label: "Remember", description: "Save and forget its own notes (memories)." },
  "drive:read": { label: "Read files", description: "Read files in the Drive." },
  "drive:write": {
    label: "Write files",
    description: "Create reports, tables, org charts, diffs and pages in the Drive.",
  },
  "issues:read": { label: "Read issues", description: "List and read issues." },
  "calendar:read": { label: "View calendar", description: "View events and free time." },
  "calendar:write": {
    label: "Propose events",
    description: "Suggest events. The person asking confirms before any invitation.",
  },
  "issues:write": { label: "Issues", description: "Create and update issues." },
  "skills:read": { label: "Use skills", description: "Load the skills enabled for the agent." },
  "wiki:read": { label: "Read the wiki", description: "Search and read the organization's wiki pages." },
  "wiki:write": {
    label: "Write to the wiki",
    description: "Create and edit wiki pages, only when a person asks.",
  },
  "schedule:write": {
    label: "Schedule",
    description: "Create reminders and routines from the chat, for the person asking, in that person's time zone.",
  },
  "sandbox:run": {
    label: "Run code",
    description: "Run code and skill scripts on the agent's computer (files kept between conversations).",
  },
  "browser:use": {
    label: "Use a browser",
    description:
      "Browse websites in its own browser on the agent's computer (logins kept per agent). Needs the browser turned on on that computer.",
  },
  "desktop:use": {
    label: "Use its desktop",
    description:
      "Use any app on its own desktop on the agent's computer; people can watch and take control. It can run anything there, so it also needs Run code, and the desktop turned on on that computer.",
  },
  "setup:write": {
    label: "Set up the workspace",
    description:
      "Offer to connect an AI, an app or an MCP server, or to invite people, with a card a person clicks, and create channels for the person who asked, with Undo.",
  },
  "vault:read": {
    label: "See the Vault",
    description:
      "See the logins, keys and contact details the Vault shares with it, and use them: it types saved passwords and uses saved keys without ever seeing them.",
  },
  "vault:write": {
    label: "Edit Vault contacts",
    description:
      "Save and update contact details in the Vault, change a saved login's username or a description, make passwords for accounts it creates, and delete what it saved.",
  },
};

/**
 * The Vault (ADR 0144): seeing what it shares with the agent and using it (`vault:read`, also what typing a saved
 * login or giving a command a saved key needs), and editing its contacts (`vault:write`).
 */
export const VAULT_READ_SCOPE = "vault:read";
export const VAULT_WRITE_SCOPE = "vault:write";
/** The tool whose grant stands for using the Vault at all: a login typed or a key given to a command checks it. */
export const VAULT_LIST_TOOL = "vault_list";
/** The tool whose grant stands for keeping things in the Vault: a password an agent makes checks it. */
export const VAULT_SAVE_TOOL = "vault_save";

/** A built-in scope by name: own keys only, so "constructor" or "toString" never passes as one. */
export const isBuiltinScope = (scope: string) => Object.hasOwn(BUILTIN_SCOPES, scope);

/**
 * Granted to every new agent: reading context, keeping its own notes,
 * reading and writing Drive files, reading and writing issues (any agent checks
 * the org's issues before answering about them, and a task someone asks for
 * lands on the workspace's board, not in another tool; low risk), setting up the
 * workspace for whoever asks (cards a person clicks, channels with Undo), the
 * Vault (what people share with it there, ADR 0144), and its computer (running commands, its own browser and desktop): on a connected
 * computer each still needs the switch the person at that computer turned on.
 * Admins and owners can revoke them.
 */
/**
 * A personal workspace's agents also start with its calendar (ADR 0159 §3a), besides every app connected there
 * (`connector:*` per connection, as a new connection gives every agent): one person's agents work for that person.
 */
export const PERSONAL_AGENT_SCOPES = ["calendar:read", "calendar:write"];

export const DEFAULT_AGENT_SCOPES = [
  "context:read",
  "issues:read",
  "issues:write",
  "memory:write",
  "drive:read",
  "drive:write",
  "skills:read",
  "schedule:write",
  "wiki:read",
  "wiki:write",
  "setup:write",
  "sandbox:run",
  "browser:use",
  "desktop:use",
  "vault:read",
  "vault:write",
];

export interface ScopeGrant {
  connectionId: string | null;
  scope: string;
}

/** Key of a grant in sets: built-in scopes have no connection. */
export const grantKey = (connectionId: string | null | undefined, scope: string) =>
  `${connectionId ?? "builtin"}|${scope}`;

/** The agent's grants, read from the database (never from a prompt). */
export async function grantedScopeKeys(db: Executor, orgId: string, agentId: string): Promise<Set<string>> {
  return caches.scopes.getOrLoad(`${orgId}:${agentId}`, () => loadScopeKeys(db, orgId, agentId)) as Promise<
    Set<string>
  >;
}

/**
 * Grant rows beyond plain scopes (all in `agent_scopes`):
 * `*` (no connection) = every tool of the org, now and later;
 * `connector:*` (a connection) = every tool of that connection;
 * `tool:{name}` = one tool; `deny:{name}` = never that tool, whatever else is granted.
 */
export const ALL_TOOLS = "*";
export const CONNECTOR_ALL = "connector:*";
export const toolAllowScope = (name: string) => `tool:${name}`;
export const toolDenyScope = (name: string) => `deny:${name}`;

export type AccessState = "granted" | "inherited" | "denied" | "off";

/**
 * Effective access of an agent to one tool: deny > tool allow > connector
 * wildcard > scope > all. Built-in tools without a scope (`ask_user`) are
 * always on unless denied. Approvals are separate: a sensitive tool still
 * asks a person whatever the grant.
 */
export function toolAccess(
  granted: Set<string>,
  tool: { name: string; scope: string; connectionId?: string | null },
): AccessState {
  const conn = tool.connectionId ?? null;
  if (granted.has(grantKey(conn, toolDenyScope(tool.name)))) return "denied";
  if (granted.has(grantKey(conn, toolAllowScope(tool.name)))) return "granted";
  if (tool.scope === "" && !conn) return "inherited";
  if (conn && granted.has(grantKey(conn, CONNECTOR_ALL))) return "inherited";
  if (granted.has(grantKey(conn, tool.scope))) return "granted";
  // Write implies read for built-ins (`issues:write` ⇒ `list_issues`, `drive:write` ⇒ `read_artifact`…).
  const writeScope = impliedByWrite(tool.scope);
  if (!conn && writeScope && granted.has(grantKey(null, writeScope))) return "inherited";
  // "All tools" never includes running code (ADR 0021), the agent's screens (ADR 0040), anyone's mailbox (ADR 0038)
  // nor a database (ADR 0039):
  // always separate, explicit grants.
  if (
    granted.has(grantKey(null, ALL_TOOLS)) &&
    !NOT_IN_ALL.has(tool.scope) &&
    !tool.scope.startsWith("mail:") &&
    !tool.scope.startsWith("database:")
  )
    return "inherited";
  return "off";
}

/** `drive:read` → `drive:write` for built-in scopes that have both; otherwise null. */
export function impliedByWrite(scope: string) {
  const m = /^(drive|issues|calendar|wiki):read$/.exec(scope);
  return m ? `${m[1]}:write` : null;
}

/** Scopes that "all tools" (`*`) doesn't cover. */
export const NOT_IN_ALL: ReadonlySet<string> = new Set(["sandbox:run", "browser:use", "desktop:use"]);

export const isAllowed = (state: AccessState) => state === "granted" || state === "inherited";

/** `toolAccess` with the tool it needs too (`ToolDefinition.needs`): the first not allowed decides, `of` says which. */
export function accessWithNeeds(
  granted: Set<string>,
  tool: Pick<ToolDefinition, "name" | "scope" | "connectionId" | "needs">,
) {
  const own = toolAccess(granted, tool);
  return tool.needs && isAllowed(own)
    ? { state: toolAccess(granted, tool.needs), of: tool.needs }
    : { state: own, of: tool };
}

/** Whether the agent holds some access to a connection (a scope, a tool, all of it), denials aside. */
export const holdsConnection = (granted: Set<string>, connectionId: string | null | undefined) =>
  !!connectionId &&
  [...granted].some((k) => k.startsWith(grantKey(connectionId, "")) && !k.startsWith(grantKey(connectionId, "deny:")));

/** The agent's grants straight from the database (no cache): for checks right before a call runs. */
export async function freshGrantedKeys(db: Executor, orgId: string, agentId: string) {
  return loadScopeKeys(db, orgId, agentId);
}

async function loadScopeKeys(db: Executor, orgId: string, agentId: string): Promise<Set<string>> {
  const [rows, [agent]] = await Promise.all([
    db
      .select({ connectionId: agentScopes.connectionId, scope: agentScopes.scope })
      .from(agentScopes)
      .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId))),
    db
      .select({ builtin: schema.agents.builtin })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.id, agentId))),
  ]);
  // The right hand's tools are fixed in code (ADR 0137): a grant row gives it nothing.
  if (isRightHand(agent)) return new Set(RIGHT_HAND_GRANTS.map((scope) => grantKey(null, scope)));
  return new Set(rows.map((r) => grantKey(r.connectionId, r.scope)));
}

export async function hasScope(
  db: Executor,
  orgId: string,
  agentId: string,
  connectionId: string | null | undefined,
  scope: string,
) {
  return (await loadScopeKeys(db, orgId, agentId)).has(grantKey(connectionId, scope));
}

export async function listAgentScopes(db: Database, orgId: string, agentId: string): Promise<ScopeGrant[]> {
  return db
    .select({ connectionId: agentScopes.connectionId, scope: agentScopes.scope })
    .from(agentScopes)
    .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId)))
    .orderBy(asc(agentScopes.createdAt));
}

/**
 * Checks that a grant names a scope that exists: a built-in scope, or one of
 * the connection's catalog scopes. Set by the connectors module.
 */
export type GrantValidator = (db: Database, orgId: string, grant: ScopeGrant) => Promise<string | null>;

const builtinOnly: GrantValidator = async (_db, _orgId, grant) =>
  grant.connectionId === null && !isBuiltinScope(grant.scope) ? `Unknown scope ${grant.scope}` : null;

/**
 * Replaces an agent's grants (admins: `manage_agents`). Each grant is checked
 * against the scope catalogs; nothing outside them can be granted.
 */
export async function setAgentScopes(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  grants: ScopeGrant[],
  validate: GrantValidator = builtinOnly,
) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  if (!agent) throw new NotFoundError("Agent not found");
  // Mail grants stay as they are (the mail API manages them); any sent back here are ignored.
  const mail = await mailConnectionIds(
    db,
    orgId,
    grants.map((g) => g.connectionId),
  );
  for (const grant of grants) {
    if (grant.connectionId && mail.has(grant.connectionId)) continue;
    const problem =
      (await builtinOnly(db, orgId, grant)) ?? (grant.connectionId ? await validate(db, orgId, grant) : null);
    if (problem) throw new ValidationError(problem);
  }
  caches.scopes.delete(`${orgId}:${agentId}`);
  await db.transaction(async (tx) => {
    await tx
      .delete(agentScopes)
      .where(and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId), notMailGrant(orgId)));
    const unique = new Map(
      grants
        .filter((g) => !g.connectionId || !mail.has(g.connectionId))
        .map((g) => [grantKey(g.connectionId, g.scope), g]),
    );
    if (unique.size > 0) {
      await tx.insert(agentScopes).values(
        [...unique.values()].map((g) => ({
          orgId,
          agentId,
          connectionId: g.connectionId,
          scope: g.scope,
          grantedByUserId: actorId,
        })),
      );
    }
  });
  caches.scopes.delete(`${orgId}:${agentId}`);
}

/** Adds grants without permission checks: for internal setup (new agents, tests). */
export async function grantScopes(
  db: Executor,
  orgId: string,
  agentId: string,
  grants: ScopeGrant[],
  grantedByUserId: string | null = null,
) {
  if (grants.length === 0) return;
  caches.scopes.delete(`${orgId}:${agentId}`);
  await db
    .insert(agentScopes)
    .values(grants.map((g) => ({ orgId, agentId, connectionId: g.connectionId, scope: g.scope, grantedByUserId })))
    .onConflictDoNothing();
}
