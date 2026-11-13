import { DatabaseError } from "@agenteschat/adapters";
import { and, type Database, eq, gte, schema, sql } from "@agenteschat/db";
import { sha256 } from "../crypto";
import { cutText } from "../format";
import type { CallCheck, ToolContext, ToolDefinition, ToolOutput, ToolSource } from "../tools/types";
import {
  CATALOG_LIMITS,
  clientFor,
  DATABASE_SCOPE,
  type DatabaseDeps,
  type DbConnectionRow,
  isServerDatabase,
  LIST_TABLES_SQL,
  markDatabaseNeedsReconnect,
  orgDbConnections,
  serverDatabases,
} from "./connections";
import { allowedRelations, guardSql, hiddenColumnsOf, relationAllowed } from "./guard";
import { identPath, parseIdentPath, quoteIdent } from "./identifiers";
import { agentDatabasePolicies, type DatabasePolicy } from "./policies";
import { formatRows, MAX_ROWS, wrapRows } from "./text";

const { dbQueries } = schema;

export type DatabaseToolDeps = Omit<DatabaseDeps, "db">;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/**
 * Tool name slugs per connection (`pg_<slug>_query`): the label as `[a-z0-9]`,
 * at most 20 characters; a clash gets a short hash of the id. Deterministic
 * for the same set of connections.
 */
export function databaseSlugs(connections: { id: string; label: string }[]) {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const c of connections) {
    const base =
      c.label
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 20) || "db";
    let slug = base;
    for (let n = 1; used.has(slug); n++) slug = `${base.slice(0, 14)}${sha256(`${c.id}:${n}`).slice(0, 6)}`;
    used.add(slug);
    out.set(c.id, slug);
  }
  return out;
}

const DESCRIBE_SQL = `select a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull, col_description(a.attrelid, a.attnum),
  exists (select 1 from pg_index i where i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey))
from pg_attribute a
where a.attrelid = to_regclass($1) and a.attnum > 0 and not a.attisdropped
order by a.attnum`;
const FOREIGN_KEYS_SQL = `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = to_regclass($1) and contype = 'f' order by 1`;

/**
 * The org's databases as tools (ADR 0039): `pg_<slug>_list_tables`,
 * `pg_<slug>_describe_table` and `pg_<slug>_query` per active connection,
 * with `connectionId` = the connection, so an agent sees only the databases
 * it was granted. Queries are checked by Postgres's parser and the agent's
 * rules (`checkCall`) before reaching the database, and run in a read-only
 * transaction with a time limit. Rows reach the model only as untrusted data.
 * A whole-server connection keeps the same tools plus `pg_<slug>_list_databases`,
 * and each of the others takes the one database it reads (`database`).
 */
export function createDatabaseToolSource(deps: DatabaseToolDeps): ToolSource {
  const now = () => deps.now?.() ?? new Date();

  async function log(
    db: Database,
    ctx: ToolContext,
    connection: DbConnectionRow,
    entry: {
      kind: string;
      statement: string;
      database?: string;
      rowCount?: number;
      durationMs?: number;
      error?: string;
    },
  ) {
    await db
      .insert(dbQueries)
      .values({
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        connectionId: connection.id,
        runId: ctx.runId || null,
        kind: entry.kind,
        database: entry.database ?? null,
        statement: entry.statement.slice(0, 20_000),
        rowCount: entry.rowCount ?? null,
        durationMs: entry.durationMs ?? null,
        error: entry.error?.slice(0, 500) ?? null,
      })
      .catch(() => {});
  }

  async function usedToday(db: Database, ctx: ToolContext, connectionId: string) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(dbQueries)
      .where(
        and(
          eq(dbQueries.agentId, ctx.agentId),
          eq(dbQueries.connectionId, connectionId),
          gte(dbQueries.ranAt, utcDayStart(now())),
        ),
      );
    return row?.n ?? 0;
  }

  /** A database failure as the model sees it; a refused password marks the connection for reconnecting. */
  async function failure(
    db: Database,
    connection: DbConnectionRow,
    error: unknown,
    database = connection.database,
  ): Promise<ToolOutput> {
    // A whole server's access rules (pg_hba) may refuse the role on some databases only: that one is closed,
    // the connection still works. A refused password (28P01) or the sample database refusing it is a reconnect.
    if (
      error instanceof DatabaseError &&
      error.code === "auth" &&
      connection.wholeServer &&
      database !== connection.database &&
      error.sqlState !== "28P01"
    )
      return { content: `Postgres refused this user on the database ${database}: ${error.message}`, isError: true };
    if (error instanceof DatabaseError && error.code === "auth") {
      await markDatabaseNeedsReconnect(db, connection.id, error.message).catch(() => {});
      return {
        content: `The database ${connection.label} needs to be reconnected by a person (its password was refused). Tell the person; don't retry.`,
        isError: true,
        data: { dbConnectionId: connection.id, needsReconnect: true },
      };
    }
    if (error instanceof DatabaseError && error.code === "timeout")
      return { content: `${error.message} Simplify it (filter, aggregate, add a LIMIT) and try again.`, isError: true };
    if (error instanceof DatabaseError && error.code === "query")
      return { content: `Postgres error: ${error.message}`, isError: true };
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Database error (temporary; you may retry later): ${message}`, isError: true };
  }

  function toolsFor(connection: DbConnectionRow, slug: string, policy: DatabasePolicy): ToolDefinition[] {
    const whole = connection.wholeServer;
    /** The one database a call reads: its `database` input on a whole server, else the connection's own. */
    const dbOf = (input: Record<string, unknown>) => (whole ? str(input.database) : connection.database);
    const labelOf = (database: string) =>
      whole ? `[Database ${connection.label} · ${database}]` : `[Database ${connection.label}]`;
    const mayRead = new Set(policy.databases ?? []);
    const databaseCheck = async (input: Record<string, unknown>, ctx: ToolContext): Promise<CallCheck> => {
      if (!whole) return { ok: true };
      const name = str(input.database);
      const known =
        name !== "" &&
        (mayRead.size === 0 || mayRead.has(name)) &&
        (await isServerDatabase({ ...deps, db: ctx.db }, connection, name));
      return known
        ? { ok: true }
        : {
            ok: false,
            message: `Not allowed: ${name || "(none)"} is not a database of ${connection.label}. Call pg_${slug}_list_databases.`,
          };
    };
    const databaseInput = whole
      ? {
          database: {
            type: "string",
            minLength: 1,
            maxLength: 63,
            description: "One database of this server (from list_databases). Each call reads only that one.",
          },
        }
      : {};
    const databaseRequired = whole ? ["database"] : [];
    const tenantNote = whole
      ? " Each database may belong to a different customer: answer about the database the person asked about and name it. Combine databases only when the person asks."
      : "";
    const allowed = allowedRelations(policy.tables);
    const rules = { tables: policy.tables, hiddenColumns: policy.hiddenColumns };
    const capCheck = async (ctx: ToolContext): Promise<CallCheck> => {
      if (policy.dailyQueryCap === null) return { ok: true };
      const used = await usedToday(ctx.db, ctx, connection.id);
      return used >= policy.dailyQueryCap
        ? {
            ok: false,
            message: `Not allowed: this agent already ran its ${policy.dailyQueryCap} queries on ${connection.label} today.`,
          }
        : { ok: true };
    };
    const make = (
      verb: string,
      description: string,
      inputSchema: Record<string, unknown>,
      extra: Pick<ToolDefinition, "execute"> & Partial<ToolDefinition>,
    ): ToolDefinition => ({
      name: `pg_${slug}_${verb}`,
      description: `[Database ${connection.label}] ${description}${tenantNote}`.slice(0, 1024),
      inputSchema: { type: "object", additionalProperties: false, ...inputSchema },
      scope: DATABASE_SCOPE,
      connectionId: connection.id,
      connector: { key: "postgres", via: "native", tool: verb },
      connectorLabel: connection.label,
      service: "postgres",
      sensitive: false,
      ...extra,
    });

    const listTables = make(
      "list_tables",
      `List the tables and views this agent may read (schema.name, kind, estimated rows, comment). ${whole ? "Start with list_databases." : "Start here."}`,
      { properties: { ...databaseInput }, ...(whole ? { required: databaseRequired } : {}) },
      {
        checkCall: async (input, ctx) => {
          const d = await databaseCheck(input, ctx);
          return d.ok ? capCheck(ctx) : d;
        },
        execute: async (input, ctx) => {
          const d = await databaseCheck(input, ctx);
          if (!d.ok) return { content: d.message, isError: true };
          const database = dbOf(input);
          const label = labelOf(database);
          const started = Date.now();
          try {
            const client = await clientFor({ ...deps, db: ctx.db }, connection, database);
            const rows = await client.readOnly(CATALOG_LIMITS, async (run) => (await run(LIST_TABLES_SQL)).rows);
            const visible = rows.filter((r) => relationAllowed(allowed, String(r[0]), String(r[1])));
            await log(ctx.db, ctx, connection, {
              kind: "list_tables",
              statement: "list tables",
              ...(whole ? { database } : {}),
              rowCount: visible.length,
              durationMs: Date.now() - started,
            });
            if (visible.length === 0) return { content: `${label} No tables this agent may read.` };
            const lines = visible.map(
              (r) =>
                `${identPath([String(r[0]), String(r[1])])} (${r[2]}, ~${Number(r[3] ?? 0).toLocaleString("en-US")} rows)${r[4] ? ` — ${cutText(String(r[4]), 200)}` : ""}`,
            );
            return {
              content: `${label} ${visible.length} tables. Use schema.table names in queries (unqualified names are public.*).\n${wrapRows(lines.join("\n"))}`,
              data: { dbConnectionId: connection.id, tables: visible.length, ...(whole ? { database } : {}) },
            };
          } catch (error) {
            return failure(ctx.db, connection, error, database);
          }
        },
      },
    );

    const tableAllowed = (table: string): CallCheck => {
      const [schemaName, tableName] = parseIdentPath(table, 2) ?? [];
      return allowed.size > 0 && !(schemaName && tableName && relationAllowed(allowed, schemaName, tableName))
        ? { ok: false, message: `Not allowed: this agent may only read the tables ${[...allowed].join(", ")}.` }
        : { ok: true };
    };

    const describeTable = make(
      "describe_table",
      "Show a table's columns (type, nullable, comment, primary key) and foreign keys.",
      {
        properties: {
          table: {
            type: "string",
            minLength: 1,
            maxLength: 130,
            description: "schema.table (public.table if no schema).",
          },
          ...databaseInput,
        },
        required: [...databaseRequired, "table"],
      },
      {
        checkCall: async (input, ctx) => {
          const t = tableAllowed(str(input.table));
          if (!t.ok) return t;
          const d = await databaseCheck(input, ctx);
          return d.ok ? capCheck(ctx) : d;
        },
        execute: async (input, ctx) => {
          const d = await databaseCheck(input, ctx);
          if (!d.ok) return { content: d.message, isError: true };
          const database = dbOf(input);
          const label = labelOf(database);
          const parts = parseIdentPath(str(input.table), 2);
          if (!parts)
            return {
              content: `${label} "${str(input.table)}" is not a table name: write schema.table, quoting names with capitals or spaces ("My Table").`,
              isError: true,
            };
          const [schemaName = "", tableName = ""] = parts;
          const name = identPath(parts);
          const hidden = new Set(
            hiddenColumnsOf(policy.hiddenColumns, schemaName, tableName).map((c) => c.toLowerCase()),
          );
          const started = Date.now();
          try {
            const client = await clientFor({ ...deps, db: ctx.db }, connection, database);
            const { columns, fks } = await client.readOnly(CATALOG_LIMITS, async (run) => ({
              columns: (await run(DESCRIBE_SQL, [name])).rows,
              fks: (await run(FOREIGN_KEYS_SQL, [name])).rows,
            }));
            await log(ctx.db, ctx, connection, {
              kind: "describe_table",
              statement: name,
              ...(whole ? { database } : {}),
              rowCount: columns.length,
              durationMs: Date.now() - started,
            });
            if (columns.length === 0) return { content: `${label} Table ${name} not found.`, isError: true };
            const lines = columns.map(
              (c) =>
                `${quoteIdent(String(c[0]))} ${c[1]}${c[2] ? "" : " not null"}${c[4] ? " primary key" : ""}${hidden.has(String(c[0]).toLowerCase()) ? " [hidden from you: never select it]" : ""}${c[3] ? ` — ${cutText(String(c[3]), 200)}` : ""}`,
            );
            const keys = fks.map((f) => `${f[0]}: ${f[1]}`);
            return {
              content: `${label} ${name}\n${wrapRows([...lines, ...(keys.length > 0 ? ["foreign keys:", ...keys] : [])].join("\n"))}`,
              data: { dbConnectionId: connection.id, ...(whole ? { database } : {}) },
            };
          } catch (error) {
            return failure(ctx.db, connection, error, database);
          }
        },
      },
    );

    const query = make(
      "query",
      `Run one read-only SQL query (SELECT, WITH, or EXPLAIN without ANALYZE). At most ${MAX_ROWS} rows come back: aggregate or add a LIMIT. Unqualified tables are public.*. Times out after ${policy.timeoutSeconds} s.`,
      {
        properties: {
          sql: { type: "string", minLength: 1, maxLength: 20_000, description: "One SELECT statement." },
          params: {
            type: "array",
            maxItems: 50,
            items: { type: ["string", "number", "boolean", "null"] },
            description: "Values for $1, $2…",
          },
          ...databaseInput,
        },
        required: [...databaseRequired, "sql"],
      },
      {
        describe: (input) => ({
          title: whole ? `Query ${connection.label} · ${str(input.database)}` : `Query ${connection.label}`,
          detail: str(input.sql).slice(0, 1500),
        }),
        checkCall: async (input, ctx) => {
          const g = await guardSql(str(input.sql), rules, { wholeServer: whole });
          if (!g.ok) return { ok: false, message: `Not allowed: ${g.reason}` };
          const d = await databaseCheck(input, ctx);
          return d.ok ? capCheck(ctx) : d;
        },
        execute: async (input, ctx) => {
          const g = await guardSql(str(input.sql), rules, { wholeServer: whole });
          if (!g.ok) return { content: `Not allowed: ${g.reason}`, isError: true };
          const d = await databaseCheck(input, ctx);
          if (!d.ok) return { content: d.message, isError: true };
          const database = dbOf(input);
          const label = labelOf(database);
          const params = Array.isArray(input.params) ? input.params : [];
          const text =
            g.kind === "select" ? `select * from (\n${g.body}\n) as agentes_q limit ${MAX_ROWS + 1}` : g.body;
          const started = Date.now();
          try {
            const client = await clientFor({ ...deps, db: ctx.db }, connection, database);
            const result = await client.readOnly(
              { statementTimeoutMs: policy.timeoutSeconds * 1000, searchPath: "public" },
              (run) => run(text, params),
            );
            const ms = Date.now() - started;
            const out = formatRows(result);
            await log(ctx.db, ctx, connection, {
              kind: "query",
              statement: g.body,
              ...(whole ? { database } : {}),
              rowCount: result.rows.length,
              durationMs: ms,
            });
            const count = out.cut
              ? `the first ${out.shown} rows (there are more: aggregate or add a LIMIT)`
              : `${out.shown} rows`;
            return {
              content: `${label} ${count}, ${ms} ms.\n${wrapRows(out.text)}`,
              data: {
                dbConnectionId: connection.id,
                rows: out.shown,
                cut: out.cut,
                ms,
                sql: g.body,
                ...(whole ? { database } : {}),
              },
            };
          } catch (error) {
            await log(ctx.db, ctx, connection, {
              kind: "query",
              statement: g.body,
              ...(whole ? { database } : {}),
              durationMs: Date.now() - started,
              error: error instanceof Error ? error.message : String(error),
            });
            return failure(ctx.db, connection, error, database);
          }
        },
      },
    );

    const listDatabases = make(
      "list_databases",
      "List the databases of this server this agent may read. Pass one as `database` to the other tools.",
      {
        properties: {
          search: { type: "string", maxLength: 63, description: "Only names containing this (any case)." },
        },
      },
      {
        checkCall: (_input, ctx) => capCheck(ctx),
        execute: async (input, ctx) => {
          const started = Date.now();
          try {
            const all = await serverDatabases({ ...deps, db: ctx.db }, connection);
            const search = str(input.search).trim().toLowerCase();
            const names = all.filter(
              (n) => (mayRead.size === 0 || mayRead.has(n)) && (!search || n.toLowerCase().includes(search)),
            );
            await log(ctx.db, ctx, connection, {
              kind: "list_databases",
              statement: search ? `list databases: ${search}` : "list databases",
              rowCount: names.length,
              durationMs: Date.now() - started,
            });
            const label = `[Database ${connection.label}]`;
            if (names.length === 0) return { content: `${label} No databases this agent may read.` };
            return {
              content: `${label} ${names.length} databases.\n${wrapRows(names.join("\n"))}`,
              data: { dbConnectionId: connection.id, databases: names.length },
            };
          } catch (error) {
            return failure(ctx.db, connection, error);
          }
        },
      },
    );

    const off = new Set(connection.offActions);
    return [
      ...(whole ? [listDatabases] : []),
      ...(off.has("list_tables") ? [] : [listTables]),
      ...(off.has("describe_table") ? [] : [describeTable]),
      ...(off.has("query") ? [] : [query]),
    ];
  }

  return {
    name: "databases",
    async tools(ctx) {
      if (!deps.databases) return [];
      const connections = await orgDbConnections(ctx.db, ctx.orgId);
      if (connections.length === 0) return [];
      const slugs = databaseSlugs(connections);
      const usable = connections.filter((c) => c.status === "active");
      if (usable.length === 0) return [];
      const policies = await agentDatabasePolicies(ctx.db, ctx.orgId, ctx.agentId, usable);
      return usable.flatMap((c) => {
        const policy = policies.get(c.id);
        return policy ? toolsFor(c, slugs.get(c.id) ?? "db", policy) : [];
      });
    },
  };
}
