/**
 * Databases for agents (ADR 0039): the rules the screens share. DOM-free.
 */
import type { TFunction } from "i18next";
import { ApiError } from "../api/http";
import type {
  DatabaseActionName,
  DatabaseConnectError,
  DatabaseConnection,
  DatabasePolicy,
  DatabaseProvider,
  ToolDecision,
} from "../api/types";
import type { ReviewTool } from "./tool-review";

/** PostgreSQL's own elephant (`apps/web/public/brands/README.md`), for the product, never for databases in general. */
export const POSTGRES_MARK = "/brands/postgresql.svg";

/** "Onde fica o banco", in the order the connect step offers them. */
export const DATABASE_PROVIDERS: DatabaseProvider[] = ["supabase", "neon", "railway", "rds", "render", "other"];

/** Where each provider shows the address (for the "Abrir" link); null = nothing to link. */
export const DATABASE_PROVIDER_URLS: Record<DatabaseProvider, string | null> = {
  supabase: "https://supabase.com/dashboard/project/_/settings/database",
  neon: "https://console.neon.tech",
  railway: "https://railway.com/dashboard",
  rds: "https://console.aws.amazon.com/rds/home",
  render: "https://dashboard.render.com",
  other: null,
};

export const DATABASE_ERRORS: DatabaseConnectError[] = [
  "auth",
  "unreachable",
  "blocked_host",
  "tls",
  "no_databases",
  "unknown",
];

/** The error code of a failed connect or reconnect (`422 { error }`); anything else is `unknown`. */
export function databaseErrorOf(error: unknown): DatabaseConnectError {
  if (error instanceof ApiError) {
    const code = error.code as DatabaseConnectError;
    if (DATABASE_ERRORS.includes(code)) return code;
  }
  return "unknown";
}

/**
 * A user that can only read, to paste in the provider's SQL editor (the password is the person's to choose).
 * `wholeServer`: every database of the server, through the `pg_read_all_data` role (Postgres 14 or newer).
 */
export function readOnlyRoleSql(database: string, options: { wholeServer?: boolean } = {}) {
  if (options.wholeServer)
    return [
      "create role agentes_leitura login password 'troque-esta-senha';",
      "grant pg_read_all_data to agentes_leitura;",
    ].join("\n");
  const db = /^[a-z_][a-z0-9_$]*$/i.test(database) ? database : `"${database.replace(/"/g, '""')}"`;
  return [
    "create role agentes_leitura login password 'troque-esta-senha';",
    `grant connect on database ${db} to agentes_leitura;`,
    "grant usage on schema public to agentes_leitura;",
    "grant select on all tables in schema public to agentes_leitura;",
    "alter default privileges in schema public grant select on tables to agentes_leitura;",
  ].join("\n");
}

/** The database name at the end of a `postgres://` address, if it has one. */
export const databaseNameOf = (url: string) =>
  /\/([^/?]+)(\?|$)/.exec(url.trim().replace(/^postgres(ql)?:\/\/[^/]+/, ""))?.[1] ?? "";

/** `postgres://…` looks complete enough to try (the server says exactly what's wrong). */
export const isDatabaseUrl = (value: string) => /^postgres(ql)?:\/\/[^/\s]+/.test(value.trim());

/**
 * Saving `next` may let agents read databases `current` didn't: one database becomes the whole server, or the
 * prefix is dropped or changed to one that isn't a longer version of the old one.
 */
export function widensDatabaseScope(
  current: Pick<DatabaseConnection, "wholeServer" | "databasePrefix">,
  next: { wholeServer: boolean; databasePrefix: string },
) {
  if (!next.wholeServer) return false;
  return !current.wholeServer || !next.databasePrefix.trim().startsWith(current.databasePrefix ?? "");
}

/**
 * How many agents with a grant on a connection can use it: an archived agent keeps its grant but reads nothing. `team`
 * is the workspace's active agents; until it loads every grant counts, so a question about them is never skipped.
 */
export const activeGrantCount = (
  connection: Pick<DatabaseConnection, "agents"> | null | undefined,
  team: { id: string }[] | undefined,
) => connection?.agents.filter((x) => !team || team.some((a) => a.id === x.agentId)).length ?? 0;

/** A new agent's rules for a database: every table, the sensitive columns found when connecting hidden. */
export const defaultDatabasePolicy = (connection?: Pick<DatabaseConnection, "suggestedHidden">): DatabasePolicy => ({
  tables: [],
  hiddenColumns: [...(connection?.suggestedHidden ?? [])],
  dailyQueryCap: null,
  timeoutSeconds: 15,
});

/** The time limits people can pick, in seconds. */
export const DATABASE_TIMEOUTS = [15, 30, 60] as const;

// Rule names (`schema.table`, `schema.table.column`) as SQL, mirrored from `@agenteschat/engine`'s
// `databases/identifiers.ts` (`apps/server/test/database-identifiers.test.ts` keeps the two the same).
const PLAIN = /^[a-z_][a-z0-9_$]*$/;

/** One name as SQL: as is when Postgres would read it back unchanged, else double-quoted. */
export const quoteIdent = (name: string) => (PLAIN.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

/** Names → `a.b.c`, quoted where needed (the form rules are stored in). */
export const identPath = (parts: string[]) => parts.map(quoteIdent).join(".");

/**
 * `a.b`, `"A b".c`… → the exact names, as Postgres resolves them: quoted parts as written, plain ones lowercased.
 * An unquoted part that isn't a plain identifier is taken as written (rules saved before quoting existed).
 * One part short gets `public` in front; null when the count is wrong, a part is empty or a quote is open.
 * Columns saved that way may hold dots or quotes (`dbo.t.tel. celular`): when three parts are asked for and the
 * text doesn't parse, the first two dot-separated parts are the schema and table and the rest is the column.
 */
export function parseIdentPath(text: string, count: number): string[] | null {
  const parts = parseStrict(text, count);
  if (parts || count !== 3) return parts;
  const legacy = /^([^".]+)\.([^".]+)\.([^"].*)$/.exec(text.trim());
  return legacy ? legacy.slice(1).map((p) => plainOrRaw(p.trim())) : null;
}

const plainOrRaw = (raw: string) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(raw) ? raw.toLowerCase() : raw);

function parseStrict(text: string, count: number): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const s = text.trim();
  while (i <= s.length) {
    while (s[i] === " ") i++;
    if (s[i] === '"') {
      let name = "";
      i++;
      for (;;) {
        if (i >= s.length) return null;
        if (s[i] === '"') {
          if (s[i + 1] !== '"') break;
          name += '"';
          i += 2;
        } else name += s[i++];
      }
      i++;
      while (s[i] === " ") i++;
      if (i < s.length && s[i] !== ".") return null;
      if (!name) return null;
      parts.push(name);
    } else {
      const end = s.indexOf(".", i);
      const raw = s.slice(i, end === -1 ? s.length : end).trim();
      if (!raw || raw.includes('"')) return null;
      parts.push(plainOrRaw(raw));
      i = end === -1 ? s.length : end;
    }
    i++;
  }
  if (parts.length === count - 1) parts.unshift("public");
  return parts.length === count ? parts : null;
}

/**
 * The stored names that allow one table: its exact name, and the all-lowercase plain form rules saved before names
 * were kept exact used (`dbo.clientesnfse` for `ClientesNFSe`), which matched case-insensitively.
 */
export function tableRuleNames(schema: string, table: string): string[] {
  const exact = identPath([schema, table]);
  const folded = [schema.toLowerCase(), table.toLowerCase()];
  return folded.every((p) => PLAIN.test(p)) && folded.join(".") !== exact ? [exact, folded.join(".")] : [exact];
}

/** `table.column` or `schema.table.column` (quoted where needed), as the rules store them; null if it isn't one. */
export function hiddenColumnOf(value: string): string | null {
  const parts = parseIdentPath(value, 3);
  return parts && identPath(parts);
}

/** Typed text → the columns in it (split on commas, spaces, semicolons outside "quoted names"). */
export function splitColumns(text: string): { valid: string[]; invalid: string[] } {
  const parts = (text.match(/(?:"(?:[^"]|"")*"?|[^\s,;"])+/g) ?? []).map((p) => p.trim()).filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const c = hiddenColumnOf(p);
    if (c) valid.push(c);
    else invalid.push(p);
  }
  return { valid, invalid };
}

/** Typed text → database names (split on commas, spaces, semicolons; at most 63 characters each). */
export function splitDatabaseNames(text: string): { valid: string[]; invalid: string[] } {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  return { valid: parts.filter((p) => p.length <= 63), invalid: parts.filter((p) => p.length > 63) };
}

/** How many rules narrow what the agent reads (the "Regras" summary). */
export const databaseRulesCount = (p: DatabasePolicy) =>
  [
    (p.databases?.length ?? 0) > 0,
    p.tables.length > 0,
    p.hiddenColumns.length > 0,
    p.dailyQueryCap !== null,
    p.timeoutSeconds !== 15,
  ].filter(Boolean).length;

const ACTIONS: DatabaseActionName[] = ["list_tables", "describe_table", "query"];

/** A database's tools as the standard tool review shows them: each only reads (Consulta · Desligada). */
export function databaseReviewTools(t: TFunction, connection: Pick<DatabaseConnection, "offActions">): ReviewTool[] {
  return ACTIONS.map((name) => {
    const label = t(`database.action.${name}.name`);
    const level: ToolDecision = connection.offActions.includes(name) ? "off" : "read";
    return {
      name,
      label,
      description: t(`database.action.${name}.text`),
      subject: "database",
      level,
      suggested: "read",
      reason: null,
      sensitive: false,
      pending: false,
      savedLabel: label,
      levels: ["read", "off"],
    };
  });
}

/** The tools the review turned off. */
export function databaseOffActions(tools: ReviewTool[], levels: Record<string, ToolDecision>) {
  return tools.filter((tool) => (levels[tool.name] ?? tool.level) === "off").map((t) => t.name as DatabaseActionName);
}
