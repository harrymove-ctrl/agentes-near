import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { getAgent } from "../agents";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { NotFoundError, ValidationError } from "../errors";
import { requirePermission } from "../organizations";
import { DATABASE_SCOPE, type DbConnectionRow, dbGrants, orgDbConnections } from "./connections";
import { identPath, parseIdentPath } from "./identifiers";

const { dbAgentPolicies, agentScopes } = schema;

/** What one agent may read in one database beyond its scope (checked on every query). */
export interface DatabasePolicy {
  /** `schema.table` (`identPath`: quoted where needed, names kept exact); empty = every table. */
  tables: string[];
  /** `schema.table.column`, never read. */
  hiddenColumns: string[];
  /** Queries per day (UTC); null = no cap. */
  dailyQueryCap: number | null;
  /** Each query is cancelled past this. */
  timeoutSeconds: number;
  /** Whole-server connections: the only databases it may read (exact names); absent or empty = every one. */
  databases?: string[];
}

export type DatabaseLevel = "none" | "read";

export interface AgentDatabase {
  connectionId: string;
  level: DatabaseLevel;
  policy: DatabasePolicy;
}

export const DEFAULT_TIMEOUT_SECONDS = 15;

/**
 * An agent without saved rules: every table, the columns the connection test
 * found sensitive hidden, no cap, 15 seconds per query.
 */
export const defaultDatabasePolicy = (row: Pick<DbConnectionRow, "suggestedHidden">): DatabasePolicy => ({
  tables: [],
  hiddenColumns: [...row.suggestedHidden],
  dailyQueryCap: null,
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
});

/** An agent's rules on the given databases (defaults where none is saved). */
export async function agentDatabasePolicies(
  db: Database,
  orgId: string,
  agentId: string,
  connections: DbConnectionRow[],
): Promise<Map<string, DatabasePolicy>> {
  const ids = connections.map((c) => c.id);
  const rows =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(dbAgentPolicies)
          .where(
            and(
              eq(dbAgentPolicies.orgId, orgId),
              eq(dbAgentPolicies.agentId, agentId),
              inArray(dbAgentPolicies.connectionId, ids),
            ),
          );
  const byId = new Map(rows.map((r) => [r.connectionId, r]));
  return new Map(
    connections.map((c) => {
      const r = byId.get(c.id);
      return [
        c.id,
        r
          ? {
              tables: r.tables,
              hiddenColumns: r.hiddenColumns,
              dailyQueryCap: r.dailyQueryCap,
              timeoutSeconds: r.timeoutSeconds,
              ...(r.databases.length > 0 ? { databases: r.databases } : {}),
            }
          : defaultDatabasePolicy(c),
      ];
    }),
  );
}

/** Each name as stored (`identPath`), deduplicated; blanks dropped; throws on one that isn't a name. */
function canonicalNames(names: string[], count: 2 | 3) {
  const out = new Set<string>();
  for (const name of names) {
    if (!name.trim()) continue;
    const parts = parseIdentPath(name, count);
    if (!parts) {
      const value = name.trim();
      if (count === 2) throw new ValidationError(`"${value}" is not schema.table`, "database.invalid_table", { value });
      throw new ValidationError(`"${value}" is not schema.table.column`, "database.invalid_column", { value });
    }
    out.add(identPath(parts));
  }
  return [...out];
}

/** Normalised and checked rules; throws on anything invalid. */
export function normalizeDatabasePolicy(input: DatabasePolicy): DatabasePolicy {
  const tables = canonicalNames(input.tables, 2);
  const hiddenColumns = canonicalNames(input.hiddenColumns, 3);
  if (tables.length > 500 || hiddenColumns.length > 500)
    throw new ValidationError("At most 500 tables or columns", "database.too_many");
  const cap = input.dailyQueryCap;
  if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 100_000))
    throw new ValidationError("dailyQueryCap must be 1 to 100000, or null", "database.daily_cap");
  const timeout = input.timeoutSeconds;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60)
    throw new ValidationError("timeoutSeconds must be 1 to 60", "database.timeout");
  const databases = [...new Set((input.databases ?? []).map((d) => d.trim()).filter(Boolean))];
  if (databases.length > 2000 || databases.some((d) => d.length > 63))
    throw new ValidationError("At most 2000 databases, each at most 63 characters", "database.too_many");
  return {
    tables,
    hiddenColumns,
    dailyQueryCap: cap,
    timeoutSeconds: timeout,
    ...(databases.length > 0 ? { databases } : {}),
  };
}

/** `GET …/agents/{agentId}/databases`: one entry per connected database. */
export async function getAgentDatabases(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const connections = await orgDbConnections(db, orgId);
  const grants = await dbGrants(
    db,
    orgId,
    connections.map((c) => c.id),
  );
  const policies = await agentDatabasePolicies(db, orgId, agentId, connections);
  return connections.map(
    (c): AgentDatabase => ({
      connectionId: c.id,
      level: grants.get(c.id)?.has(agentId) ? "read" : "none",
      policy: policies.get(c.id) ?? defaultDatabasePolicy(c),
    }),
  );
}

/**
 * `PUT …/agents/{agentId}/databases/{connectionId}` (admins): the level is
 * the `database:read` scope on that connection; the rest is the agent's rules there.
 */
export async function setAgentDatabase(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  connectionId: string,
  input: { level: DatabaseLevel; policy: DatabasePolicy },
): Promise<AgentDatabase> {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const connection = (await orgDbConnections(db, orgId)).find((c) => c.id === connectionId);
  if (!connection) throw new NotFoundError("Database not found", "database.not_found");
  const policy = normalizeDatabasePolicy(input.policy);
  caches.scopes.delete(`${orgId}:${agentId}`);
  await db.transaction(async (tx) => {
    await tx
      .delete(agentScopes)
      .where(
        and(eq(agentScopes.orgId, orgId), eq(agentScopes.agentId, agentId), eq(agentScopes.connectionId, connectionId)),
      );
    if (input.level === "read") {
      await tx
        .insert(agentScopes)
        .values({ orgId, agentId, connectionId, scope: DATABASE_SCOPE, grantedByUserId: actorId });
    }
    const values = { ...policy, databases: policy.databases ?? [], updatedByUserId: actorId, updatedAt: new Date() };
    await tx
      .insert(dbAgentPolicies)
      .values({ orgId, agentId, connectionId, ...values })
      .onConflictDoUpdate({ target: [dbAgentPolicies.agentId, dbAgentPolicies.connectionId], set: values });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.database_access_changed",
      target: { type: "agent", id: agentId },
      details: { connectionId, level: input.level, ...policy },
    });
  });
  caches.scopes.delete(`${orgId}:${agentId}`);
  return { connectionId, level: input.level, policy };
}
