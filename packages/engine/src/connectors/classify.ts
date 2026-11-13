import { cutText } from "../format";
import type { Judge, JudgeQuestion } from "../judge";
import { ALWAYS_SENSITIVE } from "../tools/gateway";

/**
 * How a connector's tools come classified before a person looks at them.
 * Most people just click Continuar, so the
 * suggestion must be right on its own:
 *
 * 1. The server's annotations: `readOnlyHint` → read; `destructiveHint` →
 *    approval (and sensitive).
 * 2. The verb in the tool's name: get/list/search… → read;
 *    create/update/add… → write; delete/remove/send/pay… → approval (and
 *    sensitive: such a tool may only ask for approval or be off).
 * 3. Anything else is ambiguous: the shared Judge suggests a level and a
 *    short reason (a code the web says in the person's language), in batches;
 *    the answer is kept per connection and tool name. When the judge fails:
 *    approval, "couldn't tell".
 *
 * Code owns the policy: the judge only suggests, a person confirms, and
 * sensitive tools never run without approval whatever anyone answers.
 */
export type ToolLevel = "read" | "write" | "approval";
export type SuggestionSource = "annotation" | "verb" | "preset" | "judge" | "judge_failed";

/** Reasons the judge may give for an ambiguous tool (the web translates each). */
export const JUDGE_REASONS = [
  "reads_only",
  "changes_undoable",
  "replaces_data",
  "copies_only",
  "spends_money",
  "shares_outside",
  "reaches_people",
  "deletes_data",
] as const;
export type JudgeReason = (typeof JUDGE_REASONS)[number];
export type ReasonCode =
  | "read_only_hint"
  | "destructive_hint"
  | "verb_read"
  | "verb_write"
  | "verb_sensitive"
  | "preset_read"
  | "unknown"
  | JudgeReason;

export interface ToolClass {
  level: ToolLevel;
  source: SuggestionSource;
  reason: ReasonCode;
  /** May only ask for approval or be off. */
  sensitive: boolean;
}

export interface ToolToClassify {
  name: string;
  description?: string | null;
  readOnlyHint?: boolean | null;
  destructiveHint?: boolean | null;
}

const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "describe",
  "query",
  "check",
  "estimate",
  "fetch",
  "find",
  "view",
  "show",
  "count",
  "preview",
  "download",
  "lookup",
]);
const WRITE_VERBS = new Set([
  "create",
  "update",
  "add",
  "set",
  "upload",
  "bind",
  "copy",
  "edit",
  "patch",
  "insert",
  "rename",
  "assign",
  "apply",
  "duplicate",
]);
/** Sensitive: they delete, send, spend or publish. Merge, deploy and rollback always ask (ADR 0015). */
const SENSITIVE_VERBS = new Set([
  "delete",
  "remove",
  "send",
  "pay",
  "publish",
  "transfer",
  "refund",
  "unbind",
  "share",
  "merge",
  "deploy",
  "rollback",
  "destroy",
  "drop",
  "purge",
]);
/** Verbs a readable name starts with, whatever their level (the web translates them). */
const OTHER_VERBS = new Set([
  "track",
  "sync",
  "refresh",
  "run",
  "export",
  "import",
  "enable",
  "disable",
  "pause",
  "resume",
  "cancel",
  "close",
  "open",
  "start",
  "stop",
  "archive",
  "restore",
  "revoke",
  "invite",
  "approve",
  "reject",
  "move",
  "execute",
  "write",
  "post",
  "reply",
  "trigger",
]);
const isVerb = (w: string) => READ_VERBS.has(w) || WRITE_VERBS.has(w) || SENSITIVE_VERBS.has(w) || OTHER_VERBS.has(w);

/** `campaignBudget_get` → ["campaign", "budget", "get"]. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The verb of a tool name: the last word when it is one (`ad_get`), else the
 * first (`list_tickets`), else the first verb in the middle (`github_create_issue`).
 */
export function verbIndex(words: string[], known: (w: string) => boolean = isVerb): number {
  if (words.length === 0) return -1;
  if (known(words[words.length - 1] ?? "")) return words.length - 1;
  if (known(words[0] ?? "")) return 0;
  return words.findIndex(known);
}

const ruleVerb = (w: string) => READ_VERBS.has(w) || WRITE_VERBS.has(w) || SENSITIVE_VERBS.has(w);

/**
 * Annotations, a preset's read-only list, its posts (`writeTools`, writes whatever their name), then the verb. Null =
 * ambiguous (the judge decides).
 */
export function classifyByRules(
  tool: ToolToClassify,
  readTools: readonly string[] = [],
  writeTools: readonly string[] = [],
): ToolClass | null {
  if (tool.readOnlyHint === true)
    return { level: "read", source: "annotation", reason: "read_only_hint", sensitive: false };
  if (tool.destructiveHint === true)
    return { level: "approval", source: "annotation", reason: "destructive_hint", sensitive: true };
  if (readTools.includes(tool.name))
    return { level: "read", source: "preset", reason: "preset_read", sensitive: false };
  if (writeTools.includes(tool.name))
    return { level: "write", source: "preset", reason: "verb_write", sensitive: false };
  const words = nameWords(tool.name);
  const verb = words[verbIndex(words, ruleVerb)];
  if (!verb) return null;
  if (SENSITIVE_VERBS.has(verb))
    return { level: "approval", source: "verb", reason: "verb_sensitive", sensitive: true };
  if (WRITE_VERBS.has(verb)) return { level: "write", source: "verb", reason: "verb_write", sensitive: false };
  return { level: "read", source: "verb", reason: "verb_read", sensitive: false };
}

/**
 * Composio actions that publish a person's own post, as writes: posting doesn't ask (product decision), and admins
 * can still make them ask like any write. Every other action whose words publish or share stays sensitive.
 */
export const POSTING_ACTIONS: ReadonlySet<string> = new Set([
  "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
  "LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE",
]);

/** Sends, deletes and payments that actions name with other words (`GMAIL_REPLY_TO_THREAD`, `VERCEL_BUY_DOMAINS`). */
const SENSITIVE_ACTIONS = new Set([
  ...SENSITIVE_VERBS,
  "reply",
  "forward",
  "trash",
  "invite",
  "buy",
  "charge",
  "purchase",
  "renew",
]);
const sensitiveWord = (w: string) =>
  SENSITIVE_ACTIONS.has(w) || SENSITIVE_ACTIONS.has(w.replace(/s$/, "")) || SENSITIVE_ACTIONS.has(w.replace(/es$/, ""));
/** Posted or scheduled, a message is sent (`SLACK_CHAT_POST_MESSAGE`); a post alone may be a blog's. */
const MESSAGE = /^(message|email|tweet)s?$/;
/** The verb right after the app (`GITHUB_LIST_…`) of an action that only reads. Not `query`: it may also change. */
const LEADING_READS = new Set([
  "get",
  "list",
  "search",
  "find",
  "fetch",
  "check",
  "download",
  "count",
  "describe",
  "view",
  "lookup",
  "read",
]);
const OPEN_ENDED = new Set(["graph", "ql", "graphql", "sql", "mutation", "proxy"]);

/**
 * An action whose arguments say what it does (`GITHUB_RUN_GRAPH_QL_QUERY` can merge, `GOOGLEBIGQUERY_QUERY` can
 * drop a table): GraphQL, SQL, a raw request, a query it runs. Never a read, never approved for good.
 */
export function openEnded(slug: string): boolean {
  const words = nameWords(slug);
  return words.at(-1) === "query" || words.some((w) => OPEN_ENDED.has(w));
}

/**
 * Servers known to run Postgres, by their preset (`presets.ts`), each with its tool that runs the SQL in one
 * argument. `provenReadOnly` reads SQL as Postgres does: another engine reads it otherwise (MySQL runs what Postgres
 * takes for a `/*!…` comment, and a backslash in a string ends it there), so only Postgres is ever offered.
 */
const POSTGRES_SQL_TOOLS: Record<string, Record<string, string>> = {
  supabase: { execute_sql: "query" },
  "supabase-readonly": { execute_sql: "query" },
  neon: { run_sql: "sql" },
};
/** A custom server's tools that run SQL by their usual names (the reference Postgres server's `query`). */
const SQL_TOOLS: Record<string, string> = { execute_sql: "query", run_sql: "sql", query: "sql" };
const POSTGRES = /postgres/i;
const OTHER_ENGINES =
  /mysql|maria|sql ?server|mssql|t-sql|sqlite|oracle|bigquery|snowflake|clickhouse|duckdb|redshift|databricks|trino|presto|athena|cockroach|tidb|spanner/i;

/**
 * The argument holding the SQL a server's tool runs on Postgres (Supabase's `execute_sql`: `query`), or null: a
 * preset's tool from `POSTGRES_SQL_TOOLS`; on a custom server, a tool whose own description says Postgres and names
 * no other engine, known by name (`SQL_TOOLS`) or whose name says SQL (or ends in query, GraphQL aside), with one
 * string argument named `sql` or `query`.
 */
export function sqlArgOf(
  tool: { name: string; description?: string; inputSchema?: { properties?: unknown } },
  preset?: string | null,
): string | null {
  const props = (tool.inputSchema?.properties ?? {}) as Record<string, { type?: unknown } | undefined>;
  const isText = (arg: string | undefined): arg is string => arg !== undefined && props[arg]?.type === "string";
  if (preset) {
    const arg = POSTGRES_SQL_TOOLS[preset]?.[tool.name];
    return isText(arg) ? arg : null;
  }
  const said = tool.description ?? "";
  if (!POSTGRES.test(said) || OTHER_ENGINES.test(said)) return null;
  const known = SQL_TOOLS[tool.name];
  if (known) return isText(known) ? known : null;
  const words = nameWords(tool.name);
  const graph = words.some((w) => w === "graph" || w === "ql" || w === "graphql");
  if (!words.includes("sql") && (words.at(-1) !== "query" || graph)) return null;
  const args = ["sql", "query"].filter(isText);
  return args.length === 1 ? (args[0] ?? null) : null;
}

/**
 * What an action named by its slug does (`GITHUB_LIST_PULL_REQUESTS`), when a tool runs it for us (Composio's
 * executor), by every word rather than the first verb: `sensitive` when any word sends, deletes or pays, in any
 * form (`SLACK_DELETES_A_MESSAGE_FROM_A_CHAT`); `read` only when the verb right after the app reads, no other word
 * is a verb (`GITHUB_LIST_OPEN_ISSUES` opens nothing, but "open" keeps it a write), and nothing in it is open-ended
 * or always asks; anything else, a slug without a verb too, is a `write`, as is a post (`POSTING_ACTIONS`). A wrong
 * guess only asks a person.
 */
export function actionLevel(slug: string): "read" | "write" | "sensitive" {
  if (POSTING_ACTIONS.has(slug)) return "write";
  const words = nameWords(slug);
  const posts = words.some((w) => w === "post" || w === "schedule") && words.some((w) => MESSAGE.test(w));
  if (posts || words.some(sensitiveWord)) return "sensitive";
  const acts = words.some((w) => WRITE_VERBS.has(w) || OTHER_VERBS.has(w) || w === "query" || w === "replace");
  const reads = LEADING_READS.has(words[1] ?? "") && !acts && !openEnded(slug) && !ALWAYS_SENSITIVE.test(slug);
  return reads ? "read" : "write";
}

/** What we suggest when the judge can't answer: ask first. */
export const UNKNOWN_CLASS: ToolClass = {
  level: "approval",
  source: "judge_failed",
  reason: "unknown",
  sensitive: false,
};

const BATCH = 20;
const LEVEL_CRITERIA: Record<ToolLevel, string> = {
  read: "It only looks at data: it changes nothing anywhere.",
  write: "It creates or changes data in the service, but doesn't spend money, delete things, or reach other people.",
  approval:
    "A person should approve each call first: it can spend money, delete or overwrite data, share data with other accounts, or reach customers or the public.",
};
const REASON_CRITERIA: Record<JudgeReason, string> = {
  reads_only: "It only reads or computes numbers; nothing changes.",
  changes_undoable: "It changes data, but nothing is lost and money isn't spent.",
  replaces_data: "It replaces or overwrites data that already exists.",
  copies_only: "It copies or syncs data without deleting anything.",
  spends_money: "It can make the account spend money (or spend it again).",
  shares_outside: "It shares data with another account, company or person.",
  reaches_people: "Customers, the public or other people see or receive what it does.",
  deletes_data: "It can delete data or switch things off for good.",
};

/**
 * Asks the judge about ambiguous tools, a batch per request: a level and a
 * reason for each. Tools it doesn't answer (or every tool, when it fails)
 * get `UNKNOWN_CLASS`.
 */
export async function judgeTools(
  judge: Judge | undefined,
  input: { orgId: string; server: string; tools: ToolToClassify[] },
): Promise<Map<string, ToolClass>> {
  const out = new Map<string, ToolClass>();
  for (let start = 0; start < input.tools.length; start += BATCH) {
    const batch = input.tools.slice(start, start + BATCH);
    let answers: Awaited<ReturnType<Judge["ask"]>> = {};
    if (judge) {
      const questions: Record<string, JudgeQuestion> = {};
      batch.forEach((t, i) => {
        const about = { tool: `t${i}`, name: t.name };
        questions[`level_${i}`] = {
          type: "choice",
          instructions: {
            ...about,
            question:
              "An AI agent may call this tool of the `server` on its own. How much freedom should it have? Use the tool's name and description.",
          },
          criteria: LEVEL_CRITERIA,
        };
        questions[`reason_${i}`] = {
          type: "choice",
          instructions: { ...about, question: "Which phrase best says what calling this tool does?" },
          criteria: REASON_CRITERIA,
        };
      });
      try {
        answers = await judge.ask({
          orgId: input.orgId,
          kind: "connector_tool_level",
          state: {
            server: input.server,
            tools: batch.map((t, i) => ({
              id: `t${i}`,
              name: t.name,
              description: cutText(t.description ?? "", 600),
            })),
          },
          questions,
        });
      } catch {
        answers = {};
      }
    }
    batch.forEach((t, i) => {
      const level = answers[`level_${i}`]?.choice;
      const reason = answers[`reason_${i}`]?.choice;
      if (level === "read" || level === "write" || level === "approval") {
        out.set(t.name, {
          level,
          source: "judge",
          reason: JUDGE_REASONS.includes(reason as JudgeReason) ? (reason as JudgeReason) : "unknown",
          sensitive: false,
        });
      } else out.set(t.name, UNKNOWN_CLASS);
    });
  }
  return out;
}

/**
 * Every tool of a server, classified: rules first, then the judge for the
 * ambiguous ones (skipping those `cached` already answered).
 */
export async function classifyTools(
  tools: ToolToClassify[],
  options: {
    orgId: string;
    server: string;
    judge?: Judge;
    readTools?: readonly string[];
    writeTools?: readonly string[];
    /** Earlier judge answers for this connection, by tool name. */
    cached?: Map<string, ToolClass>;
  },
): Promise<Map<string, ToolClass>> {
  const out = new Map<string, ToolClass>();
  const ask: ToolToClassify[] = [];
  for (const tool of tools) {
    const byRules = classifyByRules(tool, options.readTools, options.writeTools);
    const hit = options.cached?.get(tool.name);
    if (byRules) out.set(tool.name, byRules);
    else if (hit && hit.source === "judge") out.set(tool.name, hit);
    else ask.push(tool);
  }
  if (ask.length > 0) {
    const judged = await judgeTools(options.judge, { orgId: options.orgId, server: options.server, tools: ask });
    for (const [name, c] of judged) out.set(name, c);
  }
  return out;
}

// ── Readable names and subjects ───────────────────────────────────────────────

/**
 * What the web needs to say a tool's name in the person's language: the verb
 * (`get`, `create`…, or null) and the other words in order. The technical
 * name is shown only on hover or when a search matches it.
 */
export interface ToolNameParts {
  verb: string | null;
  words: string[];
}

/** The first word every tool of a server shares (`github` in `github_create_issue`), when it isn't a verb. */
export function sharedPrefix(names: string[]): string | null {
  if (names.length < 2) return null;
  const firsts = names.map((n) => nameWords(n));
  const first = firsts[0]?.[0];
  if (!first || isVerb(first)) return null;
  return firsts.every((w) => w[0] === first && w.length > 1) ? first : null;
}

const singular = (w: string) =>
  w.endsWith("ies") && w.length > 4
    ? `${w.slice(0, -3)}y`
    : /(ss|us|is|data|info|news|status|analytics)$/.test(w)
      ? w
      : w.endsWith("s") && w.length > 3
        ? w.slice(0, -1)
        : w;

/** Readable parts and the subject (the resource the tool is about: `campaign`, `ticket`; `other` when none). */
export function describeToolName(name: string, prefix: string | null = null): ToolNameParts & { subject: string } {
  let words = nameWords(name);
  if (prefix && words[0] === prefix && words.length > 1) words = words.slice(1);
  const v = verbIndex(words);
  const verb = v >= 0 ? (words[v] ?? null) : null;
  const rest = v >= 0 ? words.filter((_, i) => i !== v) : words;
  const head = rest[0];
  return { verb, words: rest, subject: head ? singular(head) : "other" };
}
