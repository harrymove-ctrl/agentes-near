/**
 * Who is online in an organization. Ephemeral and write-heavy, so it never
 * goes to Postgres in the default build. Core: in-memory (accurate for a single
 * instance). Cloud: Redis with TTL.
 */
export interface Presence {
  connect(orgId: string, userId: string, connectionId: string): Promise<void>;
  disconnect(orgId: string, userId: string, connectionId: string): Promise<void>;
  /** User ids with at least one open connection. */
  online(orgId: string): Promise<string[]>;
}

export function createMemoryPresence(): Presence {
  const orgs = new Map<string, Map<string, Set<string>>>();
  return {
    async connect(orgId, userId, connectionId) {
      const users = orgs.get(orgId) ?? new Map<string, Set<string>>();
      orgs.set(orgId, users);
      const conns = users.get(userId) ?? new Set<string>();
      users.set(userId, conns);
      conns.add(connectionId);
    },
    async disconnect(orgId, userId, connectionId) {
      const conns = orgs.get(orgId)?.get(userId);
      conns?.delete(connectionId);
      if (conns?.size === 0) orgs.get(orgId)?.delete(userId);
    },
    async online(orgId) {
      return [...(orgs.get(orgId)?.keys() ?? [])].sort();
    },
  };
}
