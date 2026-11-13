/**
 * Test fake — databases (ADR 0039), same shapes as the server's
 * `…/databases/*` and `…/agents/{id}/databases` routes. A connect fails with
 * the code in `fake.nextError` (once).
 */
import type {
  AgentDatabase,
  ApiClient,
  DatabaseConnectError,
  DatabaseConnection,
  DatabaseTable,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { defaultDatabasePolicy } from "@agenteschat/client/lib/databases";
import { clone, MockNotFoundError } from "./context";

export interface FakeDatabases {
  client: ApiClient["databases"];
  connections: DatabaseConnection[];
  tables: DatabaseTable[];
  /** The next connect or password change fails with this (once). */
  nextError: DatabaseConnectError | null;
  /** The next connection's user can change data. */
  canWrite: boolean;
  /** A whole server's databases. */
  server: string[];
  /** Per agent, per connection. */
  agentDatabases: Map<string, Map<string, AgentDatabase>>;
}

export function createFakeDatabases(log: (method: string, ...args: unknown[]) => void, now: () => Date): FakeDatabases {
  const fake: FakeDatabases = {
    connections: [],
    tables: [
      { schema: "public", name: "customers", kind: "table", rowsEstimate: 9200 },
      { schema: "public", name: "orders", kind: "table", rowsEstimate: 48000 },
    ],
    nextError: null,
    canWrite: false,
    server: ["cliente_a", "cliente_b", "cliente_c"],
    agentDatabases: new Map(),
    client: undefined as never,
  };
  const failOnce = () => {
    const error = fake.nextError;
    if (!error) return;
    fake.nextError = null;
    throw new ApiError(422, error, error);
  };
  const find = (id: string) => {
    const c = fake.connections.find((x) => x.id === id);
    if (!c) throw new MockNotFoundError("Database not found");
    return c;
  };
  fake.client = {
    list: async (orgId) => {
      log("databases.list", orgId);
      return clone(fake.connections);
    },
    connect: async (orgId, input) => {
      log("databases.connect", orgId, input);
      failOnce();
      const url = input.url ? new URL(input.url) : null;
      const whole = input.wholeServer === true;
      const listed = fake.server.filter((n) => n.startsWith(input.databasePrefix ?? ""));
      const database = input.database || url?.pathname.slice(1) || (whole ? (listed[0] ?? "") : "postgres");
      const connection: DatabaseConnection = {
        id: crypto.randomUUID(),
        label: input.label ?? database,
        provider: input.provider ?? "other",
        host: input.host ?? url?.hostname ?? "",
        port: input.port ?? (url?.port ? Number(url.port) : 5432),
        database,
        wholeServer: whole,
        databasePrefix: whole ? (input.databasePrefix ?? null) : null,
        databaseCount: whole ? listed.length : null,
        username: input.username ?? decodeURIComponent(url?.username ?? ""),
        sslmode: input.sslmode ?? "require",
        status: "active",
        lastError: null,
        canWrite: fake.canWrite,
        createdAt: now().toISOString(),
        offActions: [],
        suggestedHidden: ["public.customers.cpf"],
        agents: [],
      };
      fake.connections.push(connection);
      return clone(connection);
    },
    update: async (orgId, connectionId, input) => {
      log("databases.update", orgId, connectionId, input);
      const c = find(connectionId);
      if (input.password !== undefined || input.url !== undefined) {
        failOnce();
        c.status = "active";
      }
      if (input.label !== undefined) c.label = input.label;
      if (input.offActions !== undefined) c.offActions = [...input.offActions];
      if (input.wholeServer !== undefined) {
        failOnce();
        c.wholeServer = input.wholeServer;
        c.databasePrefix = input.wholeServer ? input.databasePrefix || null : null;
        c.databaseCount = c.wholeServer ? fake.server.filter((n) => n.startsWith(c.databasePrefix ?? "")).length : null;
      }
      return clone(c);
    },
    disconnect: async (orgId, connectionId) => {
      log("databases.disconnect", orgId, connectionId);
      find(connectionId);
      fake.connections = fake.connections.filter((c) => c.id !== connectionId);
      for (const byConnection of fake.agentDatabases.values()) byConnection.delete(connectionId);
    },
    tables: async (orgId, connectionId) => {
      log("databases.tables", orgId, connectionId);
      find(connectionId);
      return clone(fake.tables);
    },
    serverDatabases: async (orgId, connectionId, refresh) => {
      log("databases.serverDatabases", orgId, connectionId, refresh);
      const c = find(connectionId);
      return fake.server.filter((n) => n.startsWith(c.databasePrefix ?? ""));
    },
    agent: async (orgId, agentId) => {
      log("databases.agent", orgId, agentId);
      const mine = fake.agentDatabases.get(agentId);
      return fake.connections.map(
        (c) => clone(mine?.get(c.id)) ?? { connectionId: c.id, level: "none", policy: defaultDatabasePolicy(c) },
      );
    },
    setAgent: async (orgId, agentId, connectionId, input) => {
      log("databases.setAgent", orgId, agentId, connectionId, input);
      const c = find(connectionId);
      const saved: AgentDatabase = { connectionId, level: input.level, policy: clone(input.policy) };
      const mine = fake.agentDatabases.get(agentId) ?? new Map<string, AgentDatabase>();
      mine.set(connectionId, saved);
      fake.agentDatabases.set(agentId, mine);
      c.agents = c.agents.filter((a) => a.agentId !== agentId);
      if (input.level === "read") c.agents.push({ agentId });
      return clone(saved);
    },
  };
  return fake;
}
