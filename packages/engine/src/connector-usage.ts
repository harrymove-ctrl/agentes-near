import { type ComposioExecution, MAIL_PRESETS } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { CONNECTOR_CATALOG } from "./connectors/catalog";
import { GITHUB_APP_AUTH } from "./connectors/connections";
import { CUSTOM_PREFIX } from "./connectors/custom";
import { MCP_PRESETS, mcpPreset, presetForServer } from "./connectors/presets";
import { ValidationError } from "./errors";
import { getOrMake, utcDayMs } from "./format";
import { orgOfComposioUser } from "./mail/accounts";
import { OPERATOR_EVENTS_KEEP_DAYS } from "./operator-events";
import type { ConnectorVia, ToolDefinition } from "./tools/types";

/**
 * How much each connector is used (ADR 0103): the keys connectors are counted under, the counts (one upsert per
 * tool call, per Composio execution and per trigger event) and the operator API's reads of them. Counts, keys and
 * ids only: no connection label, URL path, tool input, address or anyone's name goes in or comes out.
 */

const {
  connectorUsageDays: used,
  composioUsageDays: comp,
  connectorConnections,
  githubAppInstallations,
  mailAccounts,
  dbConnections,
  operatorEvents,
} = schema;

/** A connector key, as the operator API takes it in a path. */
export const CONNECTOR_KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const HOSTNAME = /^[a-z0-9][a-z0-9.-]{0,99}$/;
const NAME = /^[A-Za-z0-9_.-]+$/;
/** Composio's toolkits we have under a key of our own already. */
const COMPOSIO_ALIASES = new Map([
  ["googledrive", "drive"],
  ["metaads", "meta-ads"],
]);
const OWN_LABELS = new Map([
  ["gmail", "Gmail"],
  ["outlook", "Outlook"],
  ["postgres", "Postgres"],
  ["twitter", "X"],
]);

/** An IMAP mailbox's key: its preset's id, or `imap` when the person typed the hosts. */
const imapKey = (preset: string | null) => (preset && preset !== "custom" ? preset : "imap");

/**
 * A custom server's preset id (its URL's, else the first preset's on its host), else its lowercase hostname (never
 * its path or query), else `custom`.
 */
function customKey(serverUrl: string) {
  try {
    const preset = presetForServer(serverUrl);
    if (preset) return preset.id;
    const host = new URL(serverUrl).hostname;
    // Another URL on a preset's server (Supabase's `?project_ref=`, a path of its own) is still that service.
    const onHost = MCP_PRESETS.find((p) => new URL(p.serverUrl).hostname === host);
    if (onHost) return onHost.id;
    // A hostname has a dot and our ids never do, so the two can't meet.
    return HOSTNAME.test(host) && host.includes(".") ? host : "custom";
  } catch {
    return "custom";
  }
}

export type ConnectorKeySource =
  /** A `connector_connections` row: a catalog connector or a custom server. */
  | { connector: string; serverUrl: string }
  /** A `mail_accounts` row. */
  | { provider: string; via: string; preset: string | null }
  /** One of Composio's toolkits, by its slug. */
  | { toolkit: string };

/**
 * The key a connector's usage is counted under, the same for its tools and its accounts (ADR 0103 §1): a catalog
 * connector's id, a custom server's preset id or else its hostname, a mailbox's provider through Composio (`gmail`,
 * `outlook`), else its IMAP preset's id or `imap`, and a Composio toolkit's id where we have one already or else
 * its slug. Postgres databases are `postgres`, and GitHub's own tools `github`.
 */
export function connectorKeyOf(source: ConnectorKeySource): string {
  let key: string;
  if ("toolkit" in source) {
    const slug = source.toolkit.toLowerCase();
    key = COMPOSIO_ALIASES.get(slug) ?? slug;
  } else if ("provider" in source) {
    key = source.via === "imap" ? imapKey(source.preset) : source.provider;
  } else if (source.connector.startsWith(CUSTOM_PREFIX)) {
    key = customKey(source.serverUrl);
  } else {
    key = source.connector;
  }
  return CONNECTOR_KEY.test(key) ? key : "other";
}

/** A mailbox's key and way: Gmail and Outlook through this server's Composio project, IMAP through our own code. */
export const mailboxConnector = (account: { provider: string; via: string; preset: string | null }) => ({
  key: connectorKeyOf(account),
  via: (account.via === "composio" ? "composio" : "native") as ConnectorVia,
});

/** A connector key's name for people: the catalog's, a preset's or a mail provider's, else the key itself. */
export function connectorLabelOf(key: string): string {
  return (
    CONNECTOR_CATALOG[key]?.label ??
    mcpPreset(key)?.label ??
    OWN_LABELS.get(key) ??
    MAIL_PRESETS.find((p) => imapKey(p.id) === key)?.label ??
    key
  );
}

/** A tool's or an action's name as counted: as it is when plain and short, else `other`. */
const nameOf = (name: string, max: number) => (name.length <= max && NAME.test(name) ? name : "other");
/**
 * Whether a connector's tool names are kept: the catalog's and the presets' vendors name theirs for everyone, as do
 * our code and Composio. A custom server's owner names its tools, after a customer too (`Send_invoice_to_Acme`), so
 * they all count as `other`.
 */
const namedForEveryone = ({ key, via }: { key: string; via: ConnectorVia }) =>
  via !== "mcp" || Object.hasOwn(CONNECTOR_CATALOG, key) || mcpPreset(key) !== null;
const today = sql`(now() at time zone 'utc')::date`;

/** One call of a connector's tool, or an approval of one, added to today's row. Never fails what it counts. */
export async function countToolCall(
  db: Executor,
  call: {
    orgId: string;
    agentId: string;
    connector: NonNullable<ToolDefinition["connector"]>;
    calls?: number;
    errors?: number;
    approvalsAsked?: number;
    approvalsGiven?: number;
  },
) {
  try {
    await db
      .insert(used)
      .values({
        day: today,
        connector: CONNECTOR_KEY.test(call.connector.key) ? call.connector.key : "other",
        via: call.connector.via,
        orgId: call.orgId,
        agentId: call.agentId,
        tool: namedForEveryone(call.connector) ? nameOf(call.connector.tool, 64) : "other",
        calls: call.calls ?? 0,
        errors: call.errors ?? 0,
        approvalsAsked: call.approvalsAsked ?? 0,
        approvalsGiven: call.approvalsGiven ?? 0,
      })
      .onConflictDoUpdate({
        target: [used.day, used.connector, used.via, used.orgId, used.agentId, used.tool],
        set: {
          calls: sql`${used.calls} + excluded.calls`,
          errors: sql`${used.errors} + excluded.errors`,
          approvalsAsked: sql`${used.approvalsAsked} + excluded.approvals_asked`,
          approvalsGiven: sql`${used.approvalsGiven} + excluded.approvals_given`,
        },
      });
  } catch {}
}

/**
 * What one request to this server's Composio project added to today's row: an execution (failed or not), a trigger
 * event or a connected account. `toolkit`: Composio's slug, or our key for it. Never fails what it counts.
 */
export async function countComposio(
  db: Executor,
  use: {
    orgId: string;
    toolkit: string;
    action: string;
    executions?: number;
    failures?: number;
    events?: number;
    connections?: number;
  },
) {
  try {
    await db
      .insert(comp)
      .values({
        day: today,
        toolkit: connectorKeyOf({ toolkit: use.toolkit }),
        orgId: use.orgId,
        action: nameOf(use.action, 100),
        executions: use.executions ?? 0,
        failures: use.failures ?? 0,
        events: use.events ?? 0,
        connections: use.connections ?? 0,
      })
      .onConflictDoUpdate({
        target: [comp.day, comp.toolkit, comp.orgId, comp.action],
        set: {
          executions: sql`${comp.executions} + excluded.executions`,
          failures: sql`${comp.failures} + excluded.failures`,
          events: sql`${comp.events} + excluded.events`,
          connections: sql`${comp.connections} + excluded.connections`,
        },
      });
  } catch {}
}

/** The action a connected account is counted under: Composio's own slugs are uppercase, so none is this. */
const CONNECTION = "connection";

/** A connected account Composio made for a workspace, a reconnect's too: Composio bills each once past the free ones. */
export const countComposioConnection = (db: Executor, use: { orgId: string; toolkit: string }) =>
  countComposio(db, { ...use, action: CONNECTION, connections: 1 });

/** The Composio client's `onExecute`: each execution counted for the workspace whose user id ran it, no other. */
export const composioUsageHook =
  (db: Executor) =>
  async ({ userId, toolkit, slug, ok }: ComposioExecution) => {
    const orgId = orgOfComposioUser(userId);
    if (orgId) await countComposio(db, { orgId, toolkit, action: slug, executions: 1, failures: ok ? 0 : 1 });
  };

// ── The operator API's reads ────────────────────────────────────────────────

export const ANALYTICS_MAX_DAYS = 400;
/** At most this many connectors, and this many workspaces of one, per answer. */
export const ANALYTICS_ROWS_MAX = 500;
/** At most this many tools, and this many Composio actions, of one connector. */
export const ANALYTICS_LIST_MAX = 200;
const DAY_MS = 86_400_000;

/** The dates of a read, checked: real UTC days, `from` not after `to`, at most `maxDays` of them. */
export function analyticsRange(from: string, to: string, maxDays = ANALYTICS_MAX_DAYS) {
  const start = utcDayMs(from);
  const end = utcDayMs(to);
  if (start === null || end === null || start > end || (end - start) / DAY_MS + 1 > maxDays) {
    throw new ValidationError(
      `from and to are UTC days (YYYY-MM-DD), from not after to, at most ${maxDays} days`,
      "analytics.range",
    );
  }
  // As instants too, for what is kept by timestamp: the first day's start to the last one's end.
  return { from, to, start: new Date(start), end: new Date(end + DAY_MS) };
}
type Range = ReturnType<typeof analyticsRange>;

const total = (column: unknown) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
/** Rows, or distinct values of `column`, among the rows where `filter` holds when there is one. */
export const howMany = (filter?: SQL, column?: unknown) => {
  const what = column === undefined ? sql`*` : sql`distinct ${column}`;
  return (filter ? sql<number>`count(${what}) filter (where ${filter})` : sql<number>`count(${what})`).mapWith(Number);
};
/** Distinct workspaces or agents with at least one call. */
const using = (column: typeof used.orgId | typeof used.agentId) => howMany(sql`${used.calls} > 0`, column);
const usedIn = (r: Range) => and(gte(used.day, r.from), lte(used.day, r.to));
// Connected accounts are only the month's: every other read is of executions and events.
const compIn = (r: Range) => and(gte(comp.day, r.from), lte(comp.day, r.to), ne(comp.action, CONNECTION));
const usage = {
  calls: total(used.calls),
  errors: total(used.errors),
  approvalsAsked: total(used.approvalsAsked),
  approvalsGiven: total(used.approvalsGiven),
};
const composio = { executions: total(comp.executions), failures: total(comp.failures), events: total(comp.events) };

/**
 * Accounts connected now, and how many of them were added in the dates, per connector key and way (and per
 * workspace with `byOrg`), from every table that keeps them. A custom server's URL becomes its key here by the
 * same `connectorKeyOf` its tools use. A mailbox whose sign-in never finished isn't connected.
 * ponytail: every active row's group is read and keyed here. Read only the key's table once a drill-down slows.
 */
async function accountCounts(db: Database, r: Range, byOrg: boolean) {
  const cc = connectorConnections;
  const custom = sql`${cc.connector} like ${`${CUSTOM_PREFIX}%`}`;
  const accounts = howMany();
  const [start, end] = [r.start.toISOString(), r.end.toISOString()];
  const added = (createdAt: unknown) =>
    howMany(sql`${createdAt} >= ${start}::timestamptz and ${createdAt} < ${end}::timestamptz`);
  const org = (orgId: unknown) => (byOrg ? sql<string>`${orgId}` : sql<string>`''`);
  const [connections, installations, mailboxes, databases] = await Promise.all([
    db
      .select({
        orgId: org(cc.orgId),
        connector: sql<string>`case when ${custom} then ${CUSTOM_PREFIX} else ${cc.connector} end`,
        serverUrl: sql<string>`case when ${custom} then ${cc.serverUrl} else '' end`,
        accounts,
        added: added(cc.createdAt),
      })
      .from(cc)
      // GitHub through the app alone is no account: its installations are counted below.
      .where(and(isNull(cc.revokedAt), ne(cc.authType, GITHUB_APP_AUTH)))
      .groupBy(sql`1`, sql`2`, sql`3`),
    db
      .select({ orgId: org(githubAppInstallations.orgId), accounts, added: added(githubAppInstallations.createdAt) })
      .from(githubAppInstallations)
      .where(isNull(githubAppInstallations.suspendedAt))
      .groupBy(sql`1`),
    db
      .select({
        orgId: org(mailAccounts.orgId),
        provider: mailAccounts.provider,
        via: mailAccounts.via,
        preset: mailAccounts.preset,
        accounts,
        added: added(mailAccounts.createdAt),
      })
      .from(mailAccounts)
      .where(and(isNull(mailAccounts.revokedAt), ne(mailAccounts.status, "pending")))
      .groupBy(sql`1`, mailAccounts.provider, mailAccounts.via, mailAccounts.preset),
    db
      .select({ orgId: org(dbConnections.orgId), accounts, added: added(dbConnections.createdAt) })
      .from(dbConnections)
      .where(isNull(dbConnections.revokedAt))
      .groupBy(sql`1`),
  ]);
  return [
    ...connections.map(({ orgId, accounts, added, ...c }) => ({
      orgId,
      accounts,
      added,
      connector: connectorKeyOf(c),
      via: "mcp" as const,
    })),
    ...installations.map((i) => ({ ...i, connector: "github", via: "native" as const })),
    ...mailboxes.map(({ orgId, accounts, added, ...m }) => {
      const { key, via } = mailboxConnector(m);
      return { orgId, accounts, added, connector: key, via };
    }),
    ...databases.map((d) => ({ ...d, connector: "postgres", via: "native" as const })),
  ];
}

const WORK_EVENTS = ["run.finished", "task.finished"];

/**
 * The product's numbers per UTC day from the operator's events feed (kept `OPERATOR_EVENTS_KEEP_DAYS`), and its
 * active workspaces.
 */
async function productDays(db: Database, r: Range) {
  const e = operatorEvents;
  const inRange = and(gte(e.createdAt, r.start), lt(e.createdAt, r.end));
  const day = sql<string>`to_char(${e.createdAt} at time zone 'utc', 'YYYY-MM-DD')`;
  const of = (type: string) => howMany(eq(e.type, type));
  const active = howMany(inArray(e.type, WORK_EVENTS), e.orgId);
  const [days, [all]] = await Promise.all([
    db
      .select({
        day,
        runs: of("run.finished"),
        tasks: of("task.finished"),
        activeWorkspaces: active,
        newWorkspaces: of("organization.created"),
        signUps: of("user.signed_up"),
      })
      .from(e)
      .where(and(inRange, inArray(e.type, [...WORK_EVENTS, "organization.created", "user.signed_up"])))
      .groupBy(day)
      .orderBy(day),
    db
      .select({ n: active })
      .from(e)
      .where(and(inRange, inArray(e.type, WORK_EVENTS))),
  ]);
  return { days, activeWorkspaces: all?.n ?? 0, keptDays: OPERATOR_EVENTS_KEEP_DAYS };
}

/** Composio's month (UTC) so far: what was counted since the 1st, connected accounts made included. */
async function composioMonth(db: Database) {
  const [month] = await db
    .select({
      month: sql<string>`to_char(now() at time zone 'utc', 'YYYY-MM')`,
      ...composio,
      connections: total(comp.connections),
    })
    .from(comp)
    .where(gte(comp.day, sql`date_trunc('month', now() at time zone 'utc')::date`));
  return {
    month: month?.month ?? new Date().toISOString().slice(0, 7),
    executions: month?.executions ?? 0,
    failures: month?.failures ?? 0,
    events: month?.events ?? 0,
    connections: month?.connections ?? 0,
  };
}

/**
 * Workspaces using each Composio connector in the dates: with a call of its tools, or with what Composio bills
 * without one (inbound mail's trigger events, account checks).
 */
function composioWorkspaces(db: Database, r: Range) {
  const both = db
    .select({ toolkit: used.connector, orgId: used.orgId })
    .from(used)
    .where(and(usedIn(r), eq(used.via, "composio"), gt(used.calls, 0)))
    .union(db.select({ toolkit: comp.toolkit, orgId: comp.orgId }).from(comp).where(compIn(r)))
    .as("composio_workspaces");
  return db.select({ toolkit: both.toolkit, workspaces: howMany() }).from(both).groupBy(both.toolkit);
}

type Used = { calls: number; executions: number; events: number; accounts: number };
/** Most used first: calls, then Composio executions, events and accounts. */
const mostUsed = (a: Used, b: Used) =>
  b.calls - a.calls || b.executions - a.executions || b.events - a.events || b.accounts - a.accounts;

/**
 * The operator API's analytics (ADR 0103): connector use in the dates (totals, per day and way, per connector and
 * way, with accounts), what this server asked of its Composio project, its month so far, and the product's days
 * from the events feed. `since`: the first day anything was counted.
 */
export async function operatorAnalytics(db: Database, query: { from: string; to: string }) {
  const r = analyticsRange(query.from, query.to);
  const [first, [totals], days, connectors, toolkits, billed, compDays, month, accounts, product] = await Promise.all([
    db.execute(sql`select least((select min(${used.day}) from ${used}), (select min(${comp.day}) from ${comp}))::text
      as since`),
    db
      .select({ ...usage, workspaces: using(used.orgId), agents: using(used.agentId) })
      .from(used)
      .where(usedIn(r)),
    db
      .select({ day: used.day, via: used.via, ...usage, workspaces: using(used.orgId) })
      .from(used)
      .where(usedIn(r))
      .groupBy(used.day, used.via)
      .orderBy(used.day, used.via),
    db
      .select({
        connector: used.connector,
        via: used.via,
        ...usage,
        workspaces: using(used.orgId),
        agents: using(used.agentId),
      })
      .from(used)
      .where(usedIn(r))
      .groupBy(used.connector, used.via),
    db
      .select({ toolkit: comp.toolkit, ...composio })
      .from(comp)
      .where(compIn(r))
      .groupBy(comp.toolkit),
    composioWorkspaces(db, r),
    db
      .select({ day: comp.day, ...composio })
      .from(comp)
      .where(compIn(r))
      .groupBy(comp.day)
      .orderBy(comp.day),
    composioMonth(db),
    accountCounts(db, r, false),
    productDays(db, r),
  ]);

  const rows = new Map<string, ConnectorRow>();
  const row = (connector: string, via: ConnectorVia) =>
    getOrMake(rows, `${via} ${connector}`, () => ({
      connector,
      label: connectorLabelOf(connector),
      via,
      calls: 0,
      errors: 0,
      approvalsAsked: 0,
      approvalsGiven: 0,
      workspaces: 0,
      agents: 0,
      accounts: 0,
      accountsAdded: 0,
      executions: 0,
      executionFailures: 0,
      events: 0,
    }));
  for (const c of connectors) Object.assign(row(c.connector, c.via), c);
  for (const { toolkit, failures, ...t } of toolkits)
    Object.assign(row(toolkit, "composio"), t, { executionFailures: failures });
  for (const { toolkit, workspaces } of billed) row(toolkit, "composio").workspaces = workspaces;
  for (const a of accounts) {
    const found = row(a.connector, a.via);
    found.accounts += a.accounts;
    found.accountsAdded += a.added;
  }
  const ranked = [...rows.values()].sort(
    (a, b) => mostUsed(a, b) || a.connector.localeCompare(b.connector) || a.via.localeCompare(b.via),
  );
  return {
    from: r.from,
    to: r.to,
    since: rowsOf<{ since: string | null }>(first)[0]?.since ?? null,
    totals: totals ?? { calls: 0, errors: 0, approvalsAsked: 0, approvalsGiven: 0, workspaces: 0, agents: 0 },
    days,
    connectors: ranked.slice(0, ANALYTICS_ROWS_MAX),
    connectorsMore: ranked.length > ANALYTICS_ROWS_MAX,
    composio: { days: compDays, month },
    product,
  };
}

interface ConnectorRow {
  connector: string;
  label: string;
  via: ConnectorVia;
  calls: number;
  errors: number;
  approvalsAsked: number;
  approvalsGiven: number;
  workspaces: number;
  agents: number;
  accounts: number;
  accountsAdded: number;
  executions: number;
  executionFailures: number;
  events: number;
}

/**
 * One connector's analytics (ADR 0103): per day and way, per tool, per Composio action and per workspace and way,
 * with its accounts. `approvals` are the approvals its calls asked for. An unknown key answers with empty lists.
 */
export async function operatorConnectorAnalytics(db: Database, connector: string, query: { from: string; to: string }) {
  const r = analyticsRange(query.from, query.to);
  if (!CONNECTOR_KEY.test(connector)) throw new ValidationError("Not a connector key", "analytics.connector");
  const ofUsed = and(eq(used.connector, connector), usedIn(r));
  const ofComp = and(eq(comp.toolkit, connector), compIn(r));
  const lastDay = (day: unknown) => sql<string>`max(${day})::text`;
  const calls = { calls: usage.calls, errors: usage.errors, approvals: usage.approvalsAsked };
  const [days, composioDays, tools, actions, orgs, composioOrgs, accounts] = await Promise.all([
    db
      .select({ day: used.day, via: used.via, ...calls })
      .from(used)
      .where(ofUsed)
      .groupBy(used.day, used.via),
    db
      .select({ day: comp.day, executions: composio.executions, events: composio.events })
      .from(comp)
      .where(ofComp)
      .groupBy(comp.day),
    db
      .select({ via: used.via, tool: used.tool, ...calls, workspaces: using(used.orgId) })
      .from(used)
      .where(ofUsed)
      .groupBy(used.via, used.tool)
      .orderBy(desc(usage.calls), used.via, used.tool)
      .limit(ANALYTICS_LIST_MAX),
    db
      .select({ action: comp.action, ...composio, workspaces: howMany(undefined, comp.orgId) })
      .from(comp)
      .where(ofComp)
      .groupBy(comp.action)
      .orderBy(desc(composio.executions), desc(composio.events), comp.action)
      .limit(ANALYTICS_LIST_MAX),
    db
      .select({ orgId: used.orgId, via: used.via, ...calls, agents: using(used.agentId), lastDay: lastDay(used.day) })
      .from(used)
      .where(ofUsed)
      .groupBy(used.orgId, used.via),
    db
      .select({
        orgId: comp.orgId,
        executions: composio.executions,
        events: composio.events,
        lastDay: lastDay(comp.day),
      })
      .from(comp)
      .where(ofComp)
      .groupBy(comp.orgId),
    accountCounts(db, r, true),
  ]);

  const dayRows = new Map<string, { day: string; via: ConnectorVia } & Record<DayCount, number>>();
  const dayRow = (day: string, via: ConnectorVia) =>
    getOrMake(dayRows, `${day} ${via}`, () => ({
      day,
      via,
      calls: 0,
      errors: 0,
      approvals: 0,
      executions: 0,
      events: 0,
    }));
  for (const d of days) Object.assign(dayRow(d.day, d.via), d);
  for (const d of composioDays) Object.assign(dayRow(d.day, "composio"), d);

  const orgRows = new Map<string, OrgRow>();
  const orgRow = (orgId: string, via: ConnectorVia) =>
    getOrMake(
      orgRows,
      `${orgId} ${via}`,
      (): OrgRow => ({
        orgId,
        via,
        calls: 0,
        errors: 0,
        approvals: 0,
        executions: 0,
        events: 0,
        agents: 0,
        accounts: 0,
        lastDay: null,
      }),
    );
  for (const o of orgs) Object.assign(orgRow(o.orgId, o.via), o);
  for (const { lastDay: day, ...o } of composioOrgs) {
    const found = Object.assign(orgRow(o.orgId, "composio"), o);
    if (!found.lastDay || day > found.lastDay) found.lastDay = day;
  }
  for (const a of accounts) if (a.connector === connector) orgRow(a.orgId, a.via).accounts += a.accounts;
  const ranked = [...orgRows.values()].sort(
    (a, b) => mostUsed(a, b) || a.orgId.localeCompare(b.orgId) || a.via.localeCompare(b.via),
  );
  return {
    connector,
    label: connectorLabelOf(connector),
    from: r.from,
    to: r.to,
    days: [...dayRows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.via.localeCompare(b.via)),
    tools,
    actions,
    orgs: ranked.slice(0, ANALYTICS_ROWS_MAX),
    orgsMore: ranked.length > ANALYTICS_ROWS_MAX,
  };
}

type DayCount = "calls" | "errors" | "approvals" | "executions" | "events";
interface OrgRow {
  orgId: string;
  via: ConnectorVia;
  calls: number;
  errors: number;
  approvals: number;
  executions: number;
  events: number;
  agents: number;
  accounts: number;
  lastDay: string | null;
}
