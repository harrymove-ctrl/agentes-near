import {
  createDatabaseConnection,
  type DatabaseDeps,
  getAgentDatabases,
  listDatabaseConnections,
  listDatabaseTables,
  listServerDatabases,
  revokeDatabaseConnection,
  setAgentDatabase,
  updateDatabaseConnection,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Databases"];

const DbTestError = z
  .enum(["auth", "unreachable", "blocked_host", "tls", "no_databases", "unknown"])
  .openapi("DatabaseTestError");
const DbAction = z.enum(["list_tables", "describe_table", "query"]).openapi("DatabaseAction");
const DbProvider = z.enum(["supabase", "neon", "railway", "rds", "render", "other"]).openapi("DatabaseProvider");

const DatabaseConnection = z
  .object({
    id: z.uuid(),
    label: z.string(),
    provider: DbProvider,
    host: z.string(),
    port: z.number(),
    database: z
      .string()
      .openapi({ description: "On a whole server, the sample database the rules' tables come from." }),
    wholeServer: z.boolean().openapi({ description: "Agents read every database of the server, one per call." }),
    databasePrefix: z.string().nullable(),
    databaseCount: z
      .number()
      .nullable()
      .openapi({ description: "Whole server: how many databases agents see, when read in the last minutes." }),
    username: z.string(),
    sslmode: z.enum(["require", "disable"]),
    status: z.enum(["active", "needs_reconnect"]),
    lastError: z.string().nullable(),
    canWrite: z.boolean(),
    createdAt: z.string(),
    offActions: z.array(DbAction),
    suggestedHidden: z.array(z.string()),
    agents: z.array(z.object({ agentId: z.uuid() })),
  })
  .openapi("DatabaseConnection");

const DatabaseTable = z
  .object({ schema: z.string(), name: z.string(), kind: z.string(), rowsEstimate: z.number() })
  .openapi("DatabaseTable");

const DatabasePolicy = z
  .object({
    tables: z.array(z.string().max(130)).max(500),
    hiddenColumns: z.array(z.string().max(200)).max(500),
    dailyQueryCap: z.number().int().min(1).max(100_000).nullable(),
    timeoutSeconds: z.number().int().min(1).max(60),
    databases: z
      .array(z.string().min(1).max(63))
      .max(2000)
      .optional()
      .openapi({ description: "Whole-server connections: the only databases the agent reads; absent = every one." }),
  })
  .openapi("DatabasePolicy");

const AgentDatabase = z
  .object({ connectionId: z.uuid(), level: z.enum(["none", "read"]), policy: DatabasePolicy })
  .openapi("AgentDatabase");

const ConnectionInput = z.object({
  label: z.string().max(80).optional(),
  provider: DbProvider.optional(),
  url: z.string().max(2000).optional(),
  host: z.string().max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().max(63).optional(),
  username: z.string().max(63).optional(),
  password: z.string().min(1).max(500).optional(),
  sslmode: z.enum(["require", "disable"]).optional(),
  wholeServer: z.boolean().optional(),
  databasePrefix: z.string().max(63).optional(),
});

const testFailed = { 422: json(z.object({ error: DbTestError }), "The connection test failed") };
const ConnectionParams = OrgParams.extend({ connectionId: z.uuid() });

/**
 * People's Postgres databases for agents (ADR 0039): the org connects a
 * database once (tested, password sealed); each agent gets "read" and its
 * rules (tables, hidden columns, daily cap, time limit) per database.
 */
export function databaseRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const dbDeps: DatabaseDeps = {
    db,
    keyWrappers: [adapters.keyWrapper, ...adapters.legacyKeyWrappers],
    databases: adapters.databases,
    resolveHost: deps.extras?.resolveHost,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/databases",
      tags,
      security,
      summary: "Connected databases and which agents read them (no passwords)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ connections: z.array(DatabaseConnection) })), ...errors },
    }),
    async (c) => {
      const connections = await listDatabaseConnections(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ connections }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/databases",
      tags,
      security,
      summary: "Connect a Postgres database (admins); tested before saving",
      description:
        "Give `url` (postgres://user:password@host:5432/database) or the fields; fields win. 409 when databases are off on this server.",
      request: { params: OrgParams, body: body(ConnectionInput) },
      responses: { 201: json(z.object({ connection: DatabaseConnection }), "Connected"), ...testFailed, ...errors },
    }),
    async (c) => {
      const r = await createDatabaseConnection(
        dbDeps,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      if (!r.ok) return c.json({ error: r.error }, 422);
      return c.json({ connection: r.connection }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/databases/{connectionId}",
      tags,
      security,
      summary:
        "Rename a database, turn its tools on or off for every agent, or reconnect it with a new address or password (tested first) (admins)",
      request: {
        params: ConnectionParams,
        body: body(ConnectionInput.extend({ offActions: z.array(DbAction).max(3).optional() })),
      },
      responses: { 200: json(z.object({ connection: DatabaseConnection })), ...testFailed, ...errors },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      const r = await updateDatabaseConnection(dbDeps, c.get("user").id, orgId, connectionId, c.req.valid("json"));
      if (!r.ok) return c.json({ error: r.error }, 422);
      return c.json({ connection: r.connection }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/databases/{connectionId}",
      tags,
      security,
      summary: "Disconnect a database (agents lose access; the password is forgotten) (admins)",
      request: { params: ConnectionParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      await revokeDatabaseConnection(dbDeps, c.get("user").id, orgId, connectionId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/databases/{connectionId}/tables",
      tags,
      security,
      summary: "A database's tables (for limiting an agent to some of them) (admins)",
      description: "On a whole server, `database` picks one of its databases (default: the sample).",
      request: { params: ConnectionParams, query: z.object({ database: z.string().min(1).max(63).optional() }) },
      responses: { 200: json(z.object({ tables: z.array(DatabaseTable) })), ...errors },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      const { database } = c.req.valid("query");
      const tables = await listDatabaseTables(dbDeps, c.get("user").id, orgId, connectionId, database);
      return c.json({ tables }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/databases/{connectionId}/databases",
      tags,
      security,
      summary: "The databases of a whole-server connection (admins); `refresh=1` reads the list again",
      request: { params: ConnectionParams, query: z.object({ refresh: z.enum(["0", "1"]).optional() }) },
      responses: { 200: json(z.object({ databases: z.array(z.string()) })), ...errors },
    }),
    async (c) => {
      const { orgId, connectionId } = c.req.valid("param");
      const refresh = c.req.valid("query").refresh === "1";
      const databases = await listServerDatabases(dbDeps, c.get("user").id, orgId, connectionId, { refresh });
      return c.json({ databases }, 200);
    },
  );

  // ── Agents' access ─────────────────────────────────────────────────────────
  const AgentParams = OrgParams.extend({ agentId: z.uuid() });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/databases",
      tags,
      security,
      summary: "What an agent may read in each connected database",
      request: { params: AgentParams },
      responses: { 200: json(z.object({ databases: z.array(AgentDatabase) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ databases: await getAgentDatabases(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/databases/{connectionId}",
      tags,
      security,
      summary: "Set an agent's access to a database: read or not, and its rules (admins)",
      description:
        'Tables are `schema.table` and hidden columns `schema.table.column` (`public` when no schema), written as SQL: names with capitals, spaces, dots or symbols in double quotes (`dbo.customers."Tax ID"`).',
      request: {
        params: AgentParams.extend({ connectionId: z.uuid() }),
        body: body(z.object({ level: z.enum(["none", "read"]), policy: DatabasePolicy })),
      },
      responses: { 200: json(AgentDatabase), ...errors },
    }),
    async (c) => {
      const { orgId, agentId, connectionId } = c.req.valid("param");
      const r = await setAgentDatabase(db, c.get("user").id, orgId, agentId, connectionId, c.req.valid("json"));
      return c.json(r, 200);
    },
  );

  return app;
}
