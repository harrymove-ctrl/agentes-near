import { and, type Database, eq, gte, isNull, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import { can, getMembership, requirePermission } from "./organizations";
import { readRefusal } from "./standing";
import { WEB_USAGE_PROVIDER } from "./web-tools";

const { usageRecords, agents, organizationSettings } = schema;

/** Budget of agents without their own, until an admin sets the organization's default (US$ 50). */
export const DEFAULT_AGENT_BUDGET_NANO_USD = 50_000_000_000;

/**
 * Whether this person may see money (US$ spent, budgets): admins and owners
 * (`view_usage`). Everyone else sees budget use as a percentage only.
 */
export async function canViewCost(db: Database, actorId: string, orgId: string) {
  const membership = await getMembership(db, actorId, orgId);
  return membership !== null && !readRefusal(membership.standing) && can(membership, "view_usage");
}

/** The organization's default monthly budget per agent, in nano-USD (cached). */
export async function orgDefaultAgentBudget(db: Database, orgId: string): Promise<number> {
  return (await caches.orgs.getOrLoad(`${orgId}:agent-budget`, async () => {
    const [row] = await db
      .select({ budget: organizationSettings.defaultAgentBudgetNanoUsd })
      .from(organizationSettings)
      .where(eq(organizationSettings.orgId, orgId));
    return row?.budget ?? DEFAULT_AGENT_BUDGET_NANO_USD;
  })) as number;
}

/** Every agent has a budget: its own, else the organization's default. */
export async function effectiveAgentBudget(
  db: Database,
  agent: { orgId: string; monthlyBudgetNanoUsd: number | null },
): Promise<number> {
  return agent.monthlyBudgetNanoUsd ?? (await orgDefaultAgentBudget(db, agent.orgId));
}

/** The agent row with its effective budget in `monthlyBudgetNanoUsd` (gateway). */
export async function withEffectiveBudget<A extends { orgId: string; monthlyBudgetNanoUsd: number | null }>(
  db: Database,
  agent: A,
): Promise<A & { monthlyBudgetNanoUsd: number }> {
  return { ...agent, monthlyBudgetNanoUsd: await effectiveAgentBudget(db, agent) };
}

/** Share of a budget used, in percent with one decimal (may pass 100 when a budget is lowered). */
export const budgetPercent = (spentNanoUsd: number, budgetNanoUsd: number) =>
  budgetNanoUsd <= 0 ? (spentNanoUsd > 0 ? 100 : 0) : Math.round((spentNanoUsd / budgetNanoUsd) * 1000) / 10;

/**
 * This month's spend and effective budget of every active agent, in
 * nano-USD, keyed by agent id. The workspace's 100% is the sum of the budgets.
 * Only the agent's own calls count: the router's and Jev's, recorded with its
 * id, are not billed to its budget.
 */
export async function agentBudgetsThisMonth(db: Database, orgId: string, now = new Date()) {
  const fallback = await orgDefaultAgentBudget(db, orgId);
  const rows = await db
    .select({
      agentId: agents.id,
      budget: agents.monthlyBudgetNanoUsd,
      spent: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`,
    })
    .from(agents)
    .leftJoin(
      usageRecords,
      and(
        eq(usageRecords.orgId, orgId),
        eq(usageRecords.agentId, agents.id),
        eq(usageRecords.kind, "agent"),
        gte(usageRecords.createdAt, monthStartUtc(now)),
      ),
    )
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .groupBy(agents.id, agents.monthlyBudgetNanoUsd);
  return new Map(
    rows.map((r) => [
      r.agentId,
      { spentNanoUsd: Number(r.spent), budgetNanoUsd: r.budget ?? fallback, isDefault: r.budget === null },
    ]),
  );
}

/** The workspace's budget use: what its agents spent this month over the sum of their budgets. */
export async function workspaceBudgetPercent(db: Database, orgId: string, now = new Date()) {
  let spent = 0;
  let budget = 0;
  for (const a of (await agentBudgetsThisMonth(db, orgId, now)).values()) {
    spent += a.spentNanoUsd;
    budget += a.budgetNanoUsd;
  }
  return budgetPercent(spent, budget);
}

/** Start of the calendar month (UTC) containing `now`: budgets reset then. */
export const monthStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** What an agent's own calls spent this month, in nano-USD: what its budget pays (`agentBudgetsThisMonth`). */
export async function agentSpendThisMonth(db: Database, orgId: string, agentId: string, now = new Date()) {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.orgId, orgId),
        eq(usageRecords.agentId, agentId),
        eq(usageRecords.kind, "agent"),
        gte(usageRecords.createdAt, monthStartUtc(now)),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Tokens and cost per agent since `since` (default: start of this month). */
export async function usageSummary(db: Database, actorId: string, orgId: string, options: { since?: Date } = {}) {
  await requirePermission(db, actorId, orgId, "view_usage");
  const since = options.since ?? monthStartUtc(new Date());
  const rows = await db
    .select({
      agentId: usageRecords.agentId,
      handle: agents.handle,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<string>`sum(${usageRecords.inputTokens})`,
      outputTokens: sql<string>`sum(${usageRecords.outputTokens})`,
      costNanoUsd: sql<string>`sum(${usageRecords.costNanoUsd})`,
    })
    .from(usageRecords)
    .innerJoin(agents, eq(agents.id, usageRecords.agentId))
    .where(
      and(
        eq(usageRecords.orgId, orgId),
        gte(usageRecords.createdAt, since),
        sql`${usageRecords.provider} <> ${WEB_USAGE_PROVIDER}`,
      ),
    )
    .groupBy(usageRecords.agentId, agents.handle);
  return rows.map((r) => ({
    agentId: r.agentId ?? "",
    handle: r.handle,
    calls: r.calls,
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costNanoUsd: Number(r.costNanoUsd),
  }));
}

/**
 * Recomputes an agent's spend counter for this month from its usage records
 * (when a budget is set or changed, so earlier spend counts). Open
 * reservations are kept.
 */
export async function resyncBudgetCounter(db: Database, orgId: string, agentId: string, now = new Date()) {
  const spent = await agentSpendThisMonth(db, orgId, agentId, now);
  await db
    .insert(schema.agentBudgetPeriods)
    .values({ orgId, agentId, periodStart: monthStartUtc(now).toISOString().slice(0, 10), spentNanoUsd: spent })
    .onConflictDoUpdate({
      target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
      set: { spentNanoUsd: spent, updatedAt: now },
    });
}
