import type { AuthMethod } from "@agenteschat/adapters";
import { and, type Database, desc, eq, gte, isNull, lt, schema, sql } from "@agenteschat/db";
import { GEMINI_ENTERPRISE_PROVIDER, isPlanId } from "@agenteschat/providers/plans";
import { z } from "zod";
import { onLiveMachine } from "./claude-auth-policy";
import { ANALYTICS_ROWS_MAX, analyticsRange, howMany } from "./connector-usage";
import { decodeCursor, encodeCursor } from "./cursor";

/**
 * The operator's reads of the AI accounts people connected (ADR 0150): counts over `machine_accounts` (the
 * computers' sign-ins and plan keys) and `provider_credentials` (API keys), and a keyset-paged list. Counts, ids
 * and stable codes only: never an email, a key hint, a token or the provider's organization id.
 */

const { machineAccounts: ma, machines, organizations, providerCredentials: pc, agents, operatorEvents } = schema;

const DAY_MS = 86_400_000;
const asDate = (v: string | Date) => new Date(v);
/** At most this many recent failures per answer. */
export const AI_ACCOUNTS_RECENT_FAILURES = 50;
export const AI_ACCOUNT_STATUSES = ["active", "signed_out", "signing_in", "removing"] as const;

const listed = sql`${ma.status} in ('active', 'signed_out')`;
const known = sql`${ma.email} is not null and ${ma.providerOrgId} is not null`;

const RUNTIME_PROVIDER: Record<string, string> = {
  claude_code: "anthropic",
  codex: "openai",
  grok: "xai",
  antigravity: "google",
  cursor: "cursor",
  opencode: "opencode",
};

type Billing = "subscription" | "coding_plan" | "metered_api" | "unknown";

/** Who serves an account, what runs it and who bills it, from its kind and `provider`. */
function dimensionOf(kind: string, provider: string | null): { provider: string; runtime: string; billing: Billing } {
  const coding = isPlanId(provider);
  const signIn = provider === null || provider === GEMINI_ENTERPRISE_PROVIDER;
  return {
    provider: coding ? (provider as string) : (RUNTIME_PROVIDER[kind] ?? kind),
    runtime: kind,
    // OpenCode's own sign-in is its free tier; a CLI's pasted key (Cursor, OpenCode Zen) says nothing of its billing.
    billing: coding ? "coding_plan" : signIn && kind !== "opencode" ? "subscription" : "unknown",
  };
}

/** Connections now (whatever the dates), and their failures and additions in the dates. */
export async function operatorAiAccounts(db: Database, query: { from: string; to: string }, now = new Date()) {
  const r = analyticsRange(query.from, query.to);
  const since = (ms: number) => sql`${ma.lastUsedAt} >= ${new Date(now.getTime() - ms).toISOString()}::timestamptz`;
  const failed = and(
    eq(operatorEvents.type, "account.failure"),
    gte(operatorEvents.createdAt, r.start),
    lt(operatorEvents.createdAt, r.end),
  );
  const field = (name: string) => sql<string | null>`${operatorEvents.data}->>${name}`;
  const day = sql<string>`to_char(${ma.createdAt} at time zone 'utc', 'YYYY-MM-DD')`;
  const method = sql<AuthMethod | "unknown">`coalesce(${ma.authMethod}, 'unknown')`;
  // ponytail: every account row is read once per answer, grouped in SQL. A rollup if the table ever outgrows that.
  const [[t], dims, [creds], credDims, [inherited], causes, recent, added, [oldest]] = await Promise.all([
    db
      .select({
        connections: howMany(listed),
        usable: howMany(sql`${ma.status} = 'active' and not ${ma.statusUnknown}`),
        unknown: howMany(sql`${listed} and ${ma.statusUnknown}`),
        signedOut: howMany(sql`${ma.status} = 'signed_out'`),
        inProgress: howMany(sql`${ma.status} = 'signing_in'`),
        removing: howMany(sql`${ma.status} = 'removing'`),
        workspaces: howMany(listed, ma.orgId),
        usedLast24h: howMany(sql`${listed} and ${since(DAY_MS)}`),
        usedLast7d: howMany(sql`${listed} and ${since(7 * DAY_MS)}`),
        withProviderIdentity: howMany(sql`${listed} and ${known}`),
        distinctProviderAccounts: howMany(
          sql`${listed} and ${known}`,
          sql`${ma.kind} || ':' || lower(${ma.email}) || ':' || ${ma.providerOrgId}`,
        ),
      })
      .from(ma)
      .where(onLiveMachine),
    db
      .select({
        kind: ma.kind,
        provider: ma.provider,
        authMethod: method,
        connections: howMany(),
        usable: howMany(sql`${ma.status} = 'active' and not ${ma.statusUnknown}`),
        signedOut: howMany(sql`${ma.status} = 'signed_out'`),
        unknown: howMany(sql`${ma.statusUnknown}`),
        usedLast7d: howMany(since(7 * DAY_MS)),
      })
      .from(ma)
      .where(and(listed, onLiveMachine))
      .groupBy(ma.kind, ma.provider, method),
    db
      .select({ n: howMany(), workspaces: howMany(undefined, pc.orgId) })
      .from(pc)
      .where(isNull(pc.revokedAt)),
    db.select({ provider: pc.provider, n: howMany() }).from(pc).where(isNull(pc.revokedAt)).groupBy(pc.provider),
    // The computer's own sign-in, with no account row: only Claude's CLI reports whether it is signed in.
    db
      .select({ n: howMany() })
      .from(machines)
      .where(and(isNull(machines.deletedAt), sql`${machines.executors}->'claude'->>'loggedIn' = 'true'`)),
    db
      .select({
        cause: sql<string>`coalesce(${field("cause")}, 'unknown')`,
        authMethod: sql<string>`coalesce(${field("authMethod")}, 'unknown')`,
        attempts: howMany(),
        accounts: howMany(undefined, field("accountId")),
        workspaces: howMany(undefined, operatorEvents.orgId),
      })
      .from(operatorEvents)
      .where(failed)
      .groupBy(sql`1`, sql`2`)
      .orderBy(desc(howMany()))
      .limit(ANALYTICS_ROWS_MAX),
    db
      .select({
        at: operatorEvents.createdAt,
        orgId: operatorEvents.orgId,
        machineId: field("machineId"),
        accountId: field("accountId"),
        kind: field("kind"),
        authMethod: field("authMethod"),
        cause: field("cause"),
        code: field("code"),
        runnerVersion: field("runnerVersion"),
      })
      .from(operatorEvents)
      .where(failed)
      .orderBy(desc(operatorEvents.createdAt))
      .limit(AI_ACCOUNTS_RECENT_FAILURES),
    // No event marks an account added, so these are the accounts still kept, by the day they were made.
    db
      .select({ day, authMethod: method, count: howMany() })
      .from(ma)
      .where(and(listed, onLiveMachine, gte(ma.createdAt, r.start), lt(ma.createdAt, r.end)))
      .groupBy(day, method)
      .orderBy(day, method),
    db.select({ at: sql<Date | null>`min(${operatorEvents.createdAt})`.mapWith(asDate) }).from(operatorEvents),
  ]);

  const zero = { connections: 0, usable: 0, signedOut: 0, unknown: 0, usedLast7d: 0 };
  type Dimension = { provider: string; runtime: string; authMethod: AuthMethod | "unknown"; billing: Billing };
  const byDimension = new Map<string, Dimension & typeof zero>();
  const add = (row: Dimension, n: typeof zero) => {
    const key = `${row.provider}|${row.runtime}|${row.authMethod}|${row.billing}`;
    const had = byDimension.get(key) ?? { ...row, ...zero };
    for (const k of Object.keys(zero) as (keyof typeof zero)[]) had[k] += n[k];
    byDimension.set(key, had);
  };
  for (const d of dims) add({ ...dimensionOf(d.kind, d.provider), authMethod: d.authMethod }, d);
  for (const c of credDims) {
    add(
      {
        provider: c.provider,
        runtime: "api",
        authMethod: "api_key",
        billing: isPlanId(c.provider) ? "coding_plan" : "metered_api",
      },
      { ...zero, connections: c.n, usable: c.n },
    );
  }

  // An aggregate without `group by` always answers one row.
  const { withProviderIdentity, distinctProviderAccounts, ...totals } = t as NonNullable<typeof t>;
  const { connections } = totals;
  return {
    generatedAt: now.toISOString(),
    from: r.from,
    to: r.to,
    totals: {
      ...totals,
      apiCredentials: creds?.n ?? 0,
      apiCredentialWorkspaces: creds?.workspaces ?? 0,
      inheritedMachineLogins: inherited?.n ?? 0,
    },
    byDimension: [...byDimension.values()].sort((a, b) => b.connections - a.connections),
    identity: {
      withProviderIdentity,
      withoutIdentity: connections - withProviderIdentity,
      distinctProviderAccounts,
    },
    failures: {
      from: r.from,
      to: r.to,
      byCause: causes,
      recent: recent.map((e) => ({
        at: e.at.toISOString(),
        orgId: e.orgId,
        machineId: e.machineId,
        accountId: e.accountId,
        kind: e.kind,
        authMethod: e.authMethod,
        cause: e.cause,
        code: e.code,
        runnerVersion: e.runnerVersion,
      })),
    },
    added,
    addedSource: "retained_rows" as const,
    coverage: {
      eventsSince: oldest?.at?.toISOString() ?? null,
      notes: ["inherited_logins_by_machine", "api_credentials_no_usage_identity", "added_from_retained_rows"],
    },
  };
}

// ── The list ─────────────────────────────────────────────────────────────────

const createdAtMs = sql<Date>`date_trunc('milliseconds', ${ma.createdAt})`.mapWith(asDate);
/** A page of AI accounts ends at this key: `[createdAt (ms), id]`. */
export const AiAccountCursor = z.tuple([z.iso.datetime(), z.uuid()]);

export interface OperatorAiAccountQuery {
  limit: number;
  cursor?: string;
  orgId?: string;
  kind?: string;
  /** `unknown`: the runner never said. */
  authMethod?: string;
  status?: (typeof AI_ACCOUNT_STATUSES)[number];
}

/** AI accounts on the computers not removed, newest first, in keyset pages. */
export async function operatorListAiAccounts(db: Database, query: OperatorAiAccountQuery) {
  const after = query.cursor ? decodeCursor(query.cursor, AiAccountCursor) : null;
  const rows = await db
    .select({
      id: ma.id,
      orgId: ma.orgId,
      orgName: organizations.name,
      machineId: ma.machineId,
      machineName: machines.name,
      kind: ma.kind,
      provider: ma.provider,
      authMethod: ma.authMethod,
      label: ma.label,
      plan: ma.plan,
      status: ma.status,
      statusUnknown: ma.statusUnknown,
      shared: ma.shared,
      ownerId: ma.createdBy,
      // A scalar count per listed row: a join would repeat the account once per agent.
      agents: sql<number>`(select count(*) from ${agents}
        where ${agents.orgId} = ${ma.orgId} and ${agents.brainAccountId} = ${ma.id}
        and ${agents.archivedAt} is null)`.mapWith(Number),
      createdAt: createdAtMs,
      lastUsedAt: ma.lastUsedAt,
      lastSuccessAt: ma.lastSuccessAt,
      lastFailureCause: ma.lastFailureCause,
      lastFailureAt: ma.lastFailureAt,
      usageAt: sql<string | null>`${ma.usage}->>'at'`,
      usageSource: sql<string | null>`${ma.usage}->>'source'`,
      runnerVersion: machines.runnerVersion,
      protocol: machines.protocol,
    })
    .from(ma)
    .innerJoin(organizations, eq(organizations.id, ma.orgId))
    .innerJoin(machines, and(eq(machines.orgId, ma.orgId), eq(machines.id, ma.machineId)))
    .where(
      and(
        isNull(machines.deletedAt),
        query.orgId ? eq(ma.orgId, query.orgId) : undefined,
        query.kind ? eq(ma.kind, query.kind) : undefined,
        query.authMethod === "unknown"
          ? isNull(ma.authMethod)
          : query.authMethod
            ? eq(ma.authMethod, query.authMethod)
            : undefined,
        query.status ? eq(ma.status, query.status) : undefined,
        after ? sql`(${createdAtMs}, ${ma.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(createdAtMs), desc(ma.id))
    .limit(query.limit + 1);
  const accounts = rows.slice(0, query.limit);
  const last = accounts.at(-1);
  const next = rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null;
  return { accounts: accounts.map((a) => ({ ...a, runnerVersion: a.runnerVersion || null })), next };
}
