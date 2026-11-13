import {
  type AccountKind,
  isAccountKind,
  type PlanUsage,
  type PlanWindow,
  type PlanWindowKind,
} from "@agenteschat/adapters";
import { and, type Database, eq, gte, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { catalogModelOf, nanoUsdToUsd, summedCostNanoUsd } from "@agenteschat/providers";
import { agentIdsWithDetails } from "./audience";
import { NotFoundError } from "./errors";
import { LISTED_ACCOUNT_STATUSES } from "./machine-accounts";
import { requirePermission } from "./organizations";
import { agentBudgetsThisMonth, budgetPercent, canViewCost, monthStartUtc } from "./usage";
import { WEB_USAGE_PROVIDER } from "./web-tools";

const { usageRecords, agents, machines, machineAccounts, users } = schema;

/*
 * The usage views (ADR 0063): Configurações › Uso (every plan account by
 * computer, then the API per agent) and an agent's "Uso" tab (its month by
 * account and day, the account it thinks with now). The windows are what the
 * runner last said about each account (`machine_accounts.usage`, and
 * `machines.executors.ownUsage` for a computer's own sign-in); plan tokens
 * say which account they spent (`usage_records.machine_id`,
 * `brain_account_id`). Providers only give the whole account's percentage,
 * so an agent's part of a window is an estimate: that percentage × the
 * agent's share of what the account spent since the window started, weighted
 * by API prices. Everyone sees tokens and percentages; an account's email
 * only its owner; money only `view_usage`.
 */

/** Where usage went that is no plan account: the organization's API. */
const API_SOURCE = "api";
/** An account's key: `machineId:kind:accountId`, or `machineId:kind:computer` for that computer's own sign-in. */
export const sourceKeyOf = (machineId: string, kind: string, accountId: string | null) =>
  `${machineId}:${kind}:${accountId ?? "computer"}`;

/** How long a window is, to know when it started; a provider's own (`other`) has no known length. */
const WINDOW_MINUTES: Partial<Record<PlanWindowKind, number>> = {
  five_hour: 300,
  seven_day: 10_080,
  seven_day_opus: 10_080,
  seven_day_sonnet: 10_080,
  monthly: 30 * 1440,
};
/** A model's own weekly window counts only that model's use. */
const WINDOW_MODEL: Partial<Record<PlanWindowKind, string>> = { seven_day_opus: "opus", seven_day_sonnet: "sonnet" };

export interface PlanWindowParts extends PlanWindow {
  /** Each agent's estimated part of `usedPercent`, biggest first; null for a window of unknown length (no estimate). */
  agents: { agentId: string; name: string; percent: number }[] | null;
}

export interface PlanAccountInfo {
  key: string;
  machineId: string;
  machineName: string;
  kind: AccountKind;
  /** Null: the computer's own sign-in ("Conta deste computador"). */
  accountId: string | null;
  /** Null for the computer's own sign-in (the app names it). */
  label: string | null;
  plan: string | null;
  /** A key account's coding plan (`zai`, `kimi`…). */
  provider: string | null;
  /** Whose it is: its owner, or the person who connected the computer for its own sign-in. */
  ownerName: string | null;
  /** The viewer owns it. */
  mine: boolean;
  /** Its owner's eyes only. */
  email: string | null;
  signedOut: boolean;
}

export interface PlanAccountUsage extends PlanAccountInfo {
  /** The plan's windows as last reported, each with the agents' parts; null: not known yet. */
  usage: (Omit<PlanUsage, "windows"> & { windows: PlanWindowParts[] }) | null;
  /** This month per agent, biggest first; `now`: the agent thinks with this account today. */
  agents: { agentId: string; name: string; tokens: number; now: boolean }[];
  monthTokens: number;
  /** `view_usage` only: what the month's tokens would cost through the API; null when no model has a price. */
  equivalentUsd?: number | null;
}

interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export const tokensOf = (u: Counts) => u.input + u.output + u.cacheRead + u.cacheWrite;

/** What these tokens (an hour's or a day's) would cost through the API, in nano-USD; null for a model without a price. */
export function apiNano(model: string | null, u: Counts): number | null {
  const id = catalogModelOf(model);
  return id
    ? summedCostNanoUsd(id, {
        inputTokens: u.input,
        outputTokens: u.output,
        cacheReadTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
      })
    : null;
}

/** Priced rows summed; null when none had a price. */
function equivalentNano(rows: (Counts & { model: string | null })[]) {
  let total: number | null = null;
  for (const r of rows) {
    const e = apiNano(r.model, r);
    if (e !== null) total = (total ?? 0) + e;
  }
  return total;
}

interface UsageRow extends Counts {
  agentId: string;
  /** An account's key, `plan:<kind>` (plan rows from before accounts were recorded) or `api`. */
  key: string;
  plan: boolean;
  machineId: string | null;
  kind: string;
  model: string | null;
  costNano: number;
  /** `YYYY-MM-DD`, or `YYYY-MM-DDTHH` by hour (UTC). */
  bucket: string;
}

async function readUsage(
  db: Database,
  orgId: string,
  since: Date,
  opts: { agentId?: string; hourly?: boolean; planOnly?: boolean } = {},
): Promise<UsageRow[]> {
  // A literal, never a parameter: Postgres must see the same expression in the select and the group by.
  const fmt = sql.raw(opts.hourly ? `'YYYY-MM-DD"T"HH24'` : `'YYYY-MM-DD'`);
  const bucket = sql<string>`to_char(${usageRecords.createdAt} at time zone 'UTC', ${fmt})`;
  const rows = await db
    .select({
      agentId: usageRecords.agentId,
      billedTo: usageRecords.billedTo,
      machineId: usageRecords.machineId,
      accountId: usageRecords.brainAccountId,
      provider: usageRecords.provider,
      model: usageRecords.model,
      bucket,
      input: sql<string>`sum(${usageRecords.inputTokens})`,
      output: sql<string>`sum(${usageRecords.outputTokens})`,
      cacheRead: sql<string>`sum(${usageRecords.cacheReadTokens})`,
      cacheWrite: sql<string>`sum(${usageRecords.cacheWriteTokens})`,
      cost: sql<string>`sum(${usageRecords.costNanoUsd})`,
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.orgId, orgId),
        gte(usageRecords.createdAt, since),
        sql`${usageRecords.agentId} is not null`,
        // A plan's rows, the router's too (they spend its limits), and the agent's own calls: Jev's and the router's
        // on a key are recorded with its id but are no API use of its own (`agentBudgetsThisMonth`).
        or(eq(usageRecords.billedTo, "plan"), eq(usageRecords.kind, "agent")),
        sql`${usageRecords.provider} <> ${WEB_USAGE_PROVIDER}`,
        ...(opts.agentId ? [eq(usageRecords.agentId, opts.agentId)] : []),
        ...(opts.planOnly ? [eq(usageRecords.billedTo, "plan")] : []),
      ),
    )
    .groupBy(
      usageRecords.agentId,
      usageRecords.billedTo,
      usageRecords.machineId,
      usageRecords.brainAccountId,
      usageRecords.provider,
      usageRecords.model,
      bucket,
    );
  return rows.map((r) => {
    const plan = r.billedTo === "plan";
    return {
      agentId: r.agentId ?? "",
      key: !plan ? API_SOURCE : r.machineId ? sourceKeyOf(r.machineId, r.provider, r.accountId) : `plan:${r.provider}`,
      plan,
      machineId: plan ? r.machineId : null,
      kind: r.provider,
      model: r.model,
      costNano: Number(r.cost),
      bucket: r.bucket,
      input: Number(r.input),
      output: Number(r.output),
      cacheRead: Number(r.cacheRead),
      cacheWrite: Number(r.cacheWrite),
    };
  });
}

interface Context {
  machines: Map<
    string,
    {
      name: string;
      pairer: string | null;
      pairerName: string | null;
      own: Partial<Record<AccountKind, PlanUsage>>;
      claudePlan: string | null;
      claudeOut: boolean;
    }
  >;
  accounts: Map<string, { row: typeof machineAccounts.$inferSelect; ownerName: string | null }>;
  agents: Map<
    string,
    {
      name: string;
      machineId: string | null;
      brain: string;
      accountId: string | null;
      ownerId: string | null;
      archived: boolean;
    }
  >;
}

async function loadContext(db: Database, orgId: string): Promise<Context> {
  const [machineRows, accountRows, agentRows] = await Promise.all([
    db
      .select({
        id: machines.id,
        name: machines.name,
        pairer: machines.pairedByUserId,
        pairerName: users.name,
        executors: machines.executors,
      })
      .from(machines)
      .leftJoin(users, eq(users.id, machines.pairedByUserId))
      .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt))),
    db
      .select({ row: machineAccounts, ownerName: users.name })
      .from(machineAccounts)
      .leftJoin(users, eq(users.id, machineAccounts.createdBy))
      .where(and(eq(machineAccounts.orgId, orgId), inArray(machineAccounts.status, LISTED_ACCOUNT_STATUSES))),
    db
      .select({
        id: agents.id,
        name: agents.name,
        machineId: agents.machineId,
        brain: agents.brain,
        accountId: agents.brainAccountId,
        ownerId: agents.ownerUserId,
        archivedAt: agents.archivedAt,
      })
      .from(agents)
      .where(eq(agents.orgId, orgId)),
  ]);
  return {
    machines: new Map(
      machineRows.map((m) => [
        m.id,
        {
          name: m.name,
          pairer: m.pairer,
          pairerName: m.pairerName,
          own: m.executors?.ownUsage ?? {},
          claudePlan: m.executors?.claude?.plan ?? null,
          claudeOut: m.executors?.claude?.loggedIn === false,
        },
      ]),
    ),
    accounts: new Map(accountRows.map((a) => [a.row.id, a])),
    agents: new Map(
      agentRows.map((a) => [
        a.id,
        {
          name: a.name,
          machineId: a.machineId,
          brain: a.brain,
          accountId: a.accountId,
          ownerId: a.ownerId,
          archived: a.archivedAt !== null,
        },
      ]),
    ),
  };
}

/** The account an agent thinks with today; null on the API, or on a computer's own sign-in that isn't its owner's. */
function currentKey(ctx: Context, agentId: string): string | null {
  const a = ctx.agents.get(agentId);
  if (!a || a.archived || !a.machineId || !isAccountKind(a.brain)) return null;
  // A computer's own sign-in thinks only for the agents of the person who connected it (ADR 0059 §3).
  const pairer = ctx.machines.get(a.machineId)?.pairer;
  if (!a.accountId && (!pairer || pairer !== a.ownerId)) return null;
  return sourceKeyOf(a.machineId, a.brain, a.accountId);
}

interface FoundAccount {
  info: PlanAccountInfo;
  usage: PlanUsage | null;
}

/** An account by its key, as the viewer (null: nobody) may see it, with its last windows; null once it is gone. */
function accountOf(ctx: Context, key: string, viewerId: string | null): FoundAccount | null {
  const [machineId = "", kind, ref] = key.split(":");
  const machine = ctx.machines.get(machineId);
  if (!machine || !isAccountKind(kind)) return null;
  if (ref === "computer") {
    return {
      info: {
        key,
        machineId,
        machineName: machine.name,
        kind,
        accountId: null,
        label: null,
        plan: kind === "claude_code" ? machine.claudePlan : null,
        provider: null,
        ownerName: machine.pairerName,
        mine: viewerId !== null && machine.pairer === viewerId,
        email: null,
        signedOut: kind === "claude_code" && machine.claudeOut,
      },
      usage: machine.own[kind] ?? null,
    };
  }
  const found = ref ? ctx.accounts.get(ref) : undefined;
  if (!found || found.row.machineId !== machineId || found.row.kind !== kind) return null;
  const { row, ownerName } = found;
  const mine = viewerId !== null && row.createdBy === viewerId;
  return {
    info: {
      key,
      machineId,
      machineName: machine.name,
      kind,
      accountId: row.id,
      label: row.label,
      plan: row.plan,
      provider: row.provider,
      ownerName,
      mine,
      email: mine ? row.email : null,
      signedOut: row.status === "signed_out",
    },
    usage: row.usage ?? null,
  };
}

/** When a window started: `minutes` before it resets (unknown reset: the last `minutes`); null for an unknown length. */
function windowStart(w: PlanWindow, now: number): number | null {
  const minutes = WINDOW_MINUTES[w.kind];
  if (!minutes) return null;
  return (w.resetsAt ? Date.parse(w.resetsAt) : now) - minutes * 60_000;
}

/** Each agent's part of a window: its percent × the agent's API-priced share of the account's use since it started. */
function partsOf(ctx: Context, w: PlanWindow, key: string, hourly: UsageRow[], now: number): PlanWindowParts["agents"] {
  const start = windowStart(w, now);
  if (start === null) return null;
  // A window that already reset is empty again: its parts are the next window's to tell.
  if (w.usedPercent <= 0 || (w.resetsAt && Date.parse(w.resetsAt) <= now)) return [];
  const from = new Date(start).toISOString().slice(0, 13);
  const only = WINDOW_MODEL[w.kind];
  const rows = hourly
    .filter((r) => r.key === key && r.bucket >= from && (!only || r.model?.includes(only)))
    .map((r) => ({ agentId: r.agentId, tokens: tokensOf(r), nano: apiNano(r.model, r) }));
  // A model without a price (Codex with no model chosen is stored as `codex`) weighs its tokens at the window's
  // average priced rate: a price is thousands of nano-USD per token, so a bare token count would weigh nothing.
  let pricedNano = 0;
  let pricedTokens = 0;
  for (const r of rows) {
    if (r.nano === null) continue;
    pricedNano += r.nano;
    pricedTokens += r.tokens;
  }
  const rate = pricedTokens > 0 ? pricedNano / pricedTokens : 1;
  const weights = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const weight = r.nano ?? r.tokens * rate;
    weights.set(r.agentId, (weights.get(r.agentId) ?? 0) + weight);
    total += weight;
  }
  return [...weights]
    .map(([agentId, weight]) => ({
      agentId,
      // Archived agents too: their use still counts, and the app no longer lists them.
      name: ctx.agents.get(agentId)?.name ?? "",
      percent: Math.round(((w.usedPercent * weight) / total) * 10) / 10,
    }))
    .filter((p) => p.percent > 0)
    .sort((a, b) => b.percent - a.percent);
}

/** Plan rows by hour since the earliest of these windows started (at most a month back); none without windows. */
async function hourlySince(db: Database, orgId: string, usages: (PlanUsage | null)[], now: Date) {
  const starts = usages.flatMap((u) => u?.windows.map((w) => windowStart(w, now.getTime()) ?? Infinity) ?? []);
  const earliest = Math.max(Math.min(...starts), now.getTime() - 32 * 86_400_000);
  if (!Number.isFinite(earliest)) return [];
  return readUsage(db, orgId, new Date(earliest), { hourly: true, planOnly: true });
}

function accountUsage(
  ctx: Context,
  { info, usage }: FoundAccount,
  money: boolean,
  month: UsageRow[],
  hourly: UsageRow[],
  now: Date,
): PlanAccountUsage {
  const rows = month.filter((r) => r.key === info.key);
  const tokens = new Map<string, number>();
  for (const r of rows) tokens.set(r.agentId, (tokens.get(r.agentId) ?? 0) + tokensOf(r));
  const usingNow = [...ctx.agents.keys()].filter((id) => currentKey(ctx, id) === info.key);
  for (const id of usingNow) if (!tokens.has(id)) tokens.set(id, 0);
  const list = [...tokens]
    .map(([agentId, n]) => ({
      agentId,
      name: ctx.agents.get(agentId)?.name ?? "",
      tokens: n,
      now: usingNow.includes(agentId),
    }))
    .sort((a, b) => b.tokens - a.tokens || Number(b.now) - Number(a.now) || a.name.localeCompare(b.name));
  const equivalent = equivalentNano(rows);
  return {
    ...info,
    usage: usage
      ? {
          ...usage,
          windows: usage.windows.map((w) => ({ ...w, agents: partsOf(ctx, w, info.key, hourly, now.getTime()) })),
        }
      : null,
    agents: list,
    monthTokens: list.reduce((s, a) => s + a.tokens, 0),
    ...(money ? { equivalentUsd: equivalent === null ? null : nanoUsdToUsd(equivalent) } : {}),
  };
}

// ── Configurações › Uso ──────────────────────────────────────────────────────

export interface ApiAgentUsage {
  agentId: string;
  name: string;
  /** API tokens this month. */
  tokens: number;
  /** This month's spend over its budget. */
  budgetPercent: number;
  /** `view_usage` only. */
  costUsd?: number;
  budgetUsd?: number;
  budgetIsDefault?: boolean;
}

/** An agent's API month as Uso shows it: tokens and budget use for everyone, money only with `view_usage`. */
const apiUsageOf = (
  agentId: string,
  name: string,
  tokens: number,
  b: { spentNanoUsd: number; budgetNanoUsd: number; isDefault: boolean },
  money: boolean,
): ApiAgentUsage => ({
  agentId,
  name,
  tokens,
  budgetPercent: budgetPercent(b.spentNanoUsd, b.budgetNanoUsd),
  ...(money
    ? { costUsd: nanoUsdToUsd(b.spentNanoUsd), budgetUsd: nanoUsdToUsd(b.budgetNanoUsd), budgetIsDefault: b.isDefault }
    : {}),
});

export interface OrgPlanUsageView {
  /** `YYYY-MM` (UTC). */
  month: string;
  /** The viewer sees money (`view_usage`). */
  money: boolean;
  /** Every plan account worth showing, by computer: the accounts added there, and a computer's own sign-in agents used this month or think with now. */
  accounts: PlanAccountUsage[];
  /** The agents that spent through the API this month. */
  api: ApiAgentUsage[];
}

export async function orgPlanUsage(
  db: Database,
  userId: string,
  orgId: string,
  now = new Date(),
): Promise<OrgPlanUsageView> {
  await requirePermission(db, userId, orgId, "read");
  const since = monthStartUtc(now);
  const [ctx, money, month, budgets] = await Promise.all([
    loadContext(db, orgId),
    canViewCost(db, userId, orgId),
    readUsage(db, orgId, since),
    agentBudgetsThisMonth(db, orgId, now),
  ]);
  const keys = new Set<string>();
  for (const { row } of ctx.accounts.values()) keys.add(sourceKeyOf(row.machineId, row.kind, row.id));
  for (const r of month) if (r.machineId) keys.add(r.key);
  for (const id of ctx.agents.keys()) {
    const key = currentKey(ctx, id);
    if (key) keys.add(key);
  }
  const found = [...keys].flatMap((k) => accountOf(ctx, k, userId) ?? []);
  const hourly = await hourlySince(
    db,
    orgId,
    found.map((a) => a.usage),
    now,
  );
  const accounts = found
    .map((a) => accountUsage(ctx, a, money, month, hourly, now))
    .sort(
      (a, b) =>
        a.machineName.localeCompare(b.machineName) ||
        a.machineId.localeCompare(b.machineId) ||
        b.monthTokens - a.monthTokens ||
        a.key.localeCompare(b.key),
    );

  const apiTokens = new Map<string, number>();
  for (const r of month) if (!r.plan) apiTokens.set(r.agentId, (apiTokens.get(r.agentId) ?? 0) + tokensOf(r));
  // Without `view_usage`, only the agents whose details the viewer sees (`seesAgentDetails`).
  const seen = money ? null : await agentIdsWithDetails(db, userId, orgId);
  const api = [...budgets]
    .filter(([id, b]) => (b.spentNanoUsd > 0 || (apiTokens.get(id) ?? 0) > 0) && (!seen || seen.has(id)))
    .map(([agentId, b]) =>
      apiUsageOf(agentId, ctx.agents.get(agentId)?.name ?? "", apiTokens.get(agentId) ?? 0, b, money),
    )
    .sort((a, b) => b.budgetPercent - a.budgetPercent || b.tokens - a.tokens || a.name.localeCompare(b.name));
  return { month: since.toISOString().slice(0, 7), money, accounts, api };
}

// ── The agent's "Uso" tab ────────────────────────────────────────────────────

export interface AgentUsageSource {
  /** An account's key, `plan:<kind>` (plan rows from before accounts were recorded) or `api`. */
  key: string;
  type: "plan" | "api";
  kind: AccountKind | null;
  /** Null: the API, an account no longer there (`removed`), or plan usage from before accounts were recorded. */
  account: PlanAccountInfo | null;
  /** A plan account that was removed (or its computer). */
  removed: boolean;
  tokens: number;
  /** Share of the agent's month, 0–100. */
  share: number;
  /** The last day it was used this month (`YYYY-MM-DD`). */
  lastDay: string | null;
  /** The account it thinks with now. */
  now: boolean;
  /** `view_usage` only. Plan: what it would cost through the API (null: no price); API: what it cost. */
  equivalentUsd?: number | null;
  costUsd?: number;
  /** API: this month's spend over the agent's budget. */
  budgetPercent?: number;
}

export interface AgentPlanUsageView {
  month: string;
  money: boolean;
  tokens: number;
  /** `view_usage` only: its plan tokens priced at API rates (null: no price). */
  equivalentUsd?: number | null;
  /** Now first, then the biggest. */
  sources: AgentUsageSource[];
  /** Every day of the month so far (UTC): tokens per source key. */
  days: { date: string; tokens: Record<string, number> }[];
  /** The account it thinks with now, with its windows and every agent's part; null on the API. */
  current: PlanAccountUsage | null;
}

export async function agentPlanUsage(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
  now = new Date(),
): Promise<AgentPlanUsageView> {
  await requirePermission(db, userId, orgId, "read");
  return (await agentUsageFor(db, userId, orgId, agentId, now)).view;
}

/**
 * The agent's "Uso" tab as `viewer` sees it (null: nobody, so no money), with the brain it thinks with and its API
 * month against its budget (null: an archived agent has none). The caller checks the viewer may read.
 */
export async function agentUsageFor(
  db: Database,
  viewer: string | null,
  orgId: string,
  agentId: string,
  now = new Date(),
): Promise<{ view: AgentPlanUsageView; brain: string; api: ApiAgentUsage | null }> {
  const since = monthStartUtc(now);
  const [ctx, money, rows, budgets] = await Promise.all([
    loadContext(db, orgId),
    viewer ? canViewCost(db, viewer, orgId) : false,
    readUsage(db, orgId, since, { agentId }),
    agentBudgetsThisMonth(db, orgId, now),
  ]);
  if (!ctx.agents.has(agentId)) throw new NotFoundError("Agent not found");

  const total = rows.reduce((s, r) => s + tokensOf(r), 0);
  const curKey = currentKey(ctx, agentId);
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
  if (curKey && !groups.has(curKey)) groups.set(curKey, []);
  const budget = budgets.get(agentId);
  let equivalent: number | null = null;
  const sources: AgentUsageSource[] = [...groups].map(([key, list]) => {
    const tokens = list.reduce((s, r) => s + tokensOf(r), 0);
    const base = {
      key,
      tokens,
      share: total > 0 ? Math.round((tokens / total) * 1000) / 10 : 0,
      lastDay:
        list
          .map((r) => r.bucket)
          .sort()
          .at(-1) ?? null,
      now: key === curKey,
    };
    if (key === API_SOURCE) {
      const cost = list.reduce((n, r) => n + r.costNano, 0);
      return {
        ...base,
        type: "api" as const,
        kind: null,
        account: null,
        removed: false,
        ...(budget ? { budgetPercent: budgetPercent(budget.spentNanoUsd, budget.budgetNanoUsd) } : {}),
        ...(money ? { costUsd: nanoUsdToUsd(cost) } : {}),
      };
    }
    const nano = equivalentNano(list);
    if (nano !== null) equivalent = (equivalent ?? 0) + nano;
    const account = accountOf(ctx, key, viewer)?.info ?? null;
    return {
      ...base,
      type: "plan" as const,
      kind: account?.kind ?? list.map((r) => r.kind).find(isAccountKind) ?? null,
      account,
      removed: !account && list.some((r) => r.machineId !== null),
      ...(money ? { equivalentUsd: nano === null ? null : nanoUsdToUsd(nano) } : {}),
    };
  });
  // Now first, then the biggest; a plan before the API on a tie.
  sources.sort(
    (a, b) =>
      Number(b.now) - Number(a.now) ||
      b.tokens - a.tokens ||
      Number(a.type === "api") - Number(b.type === "api") ||
      a.key.localeCompare(b.key),
  );

  const perDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const day = perDay.get(r.bucket) ?? {};
    day[r.key] = (day[r.key] ?? 0) + tokensOf(r);
    perDay.set(r.bucket, day);
  }
  const days: AgentPlanUsageView["days"] = [];
  for (let t = since.getTime(); t <= now.getTime(); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.push({ date, tokens: perDay.get(date) ?? {} });
  }

  // The account it thinks with now: every agent's use of it, for its windows and who shares it.
  const found = curKey ? accountOf(ctx, curKey, viewer) : null;
  let current: PlanAccountUsage | null = null;
  if (found) {
    const [month, hourly] = await Promise.all([
      readUsage(db, orgId, since, { planOnly: true }),
      hourlySince(db, orgId, [found.usage], now),
    ]);
    current = accountUsage(ctx, found, money, month, hourly, now);
  }
  const view: AgentPlanUsageView = {
    month: since.toISOString().slice(0, 7),
    money,
    tokens: total,
    ...(money ? { equivalentUsd: equivalent === null ? null : nanoUsdToUsd(equivalent) } : {}),
    sources,
    days,
    current,
  };
  const agent = ctx.agents.get(agentId);
  const apiTokens = sources.find((s) => s.type === "api")?.tokens ?? 0;
  return {
    view,
    brain: agent?.brain ?? "model",
    api: budget ? apiUsageOf(agentId, agent?.name ?? "", apiTokens, budget, money) : null,
  };
}
