import type { PlanUsage } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import type { Agent } from "./agents";
import { brainOf } from "./brain-settings";
import { planLimitOf } from "./brains/select";
import { isComputerBrain } from "./brains/types";
import { monthStartUtc, orgDefaultAgentBudget } from "./usage";
import { nextMonthStart } from "./usage-pause";

/**
 * An agent out of office (ADR 0084 §12): nothing left to think with until a reset, so a message to it waits. Its
 * plan (Claude Code, Codex…) hit its limit with no model to fall back on, or its monthly budget for the model is
 * spent. `until`: when it comes back (the plan's window reset, the next month), null when the plan didn't say.
 */
export interface OutOfOffice {
  reason: "plan" | "budget";
  until: Date | null;
}

export type OutOfOfficeAgent = Pick<
  Agent,
  | "id"
  | "orgId"
  | "model"
  | "credentialId"
  | "brain"
  | "brainFallback"
  | "brainAccountId"
  | "machineId"
  | "monthlyBudgetNanoUsd"
>;

export interface OutOfOfficeOptions {
  now?: Date;
  /**
   * Whether the agent's model brain has a key (the gateway's `hasModelCredential`): a plan at its limit falls back to
   * it in a conversation. Absent: a plan at its limit with the fallback on isn't read as out (it may still answer).
   */
  hasModel?: (agent: OutOfOfficeAgent) => Promise<boolean>;
}

/**
 * Which of `list` are out of office now, by agent id. Read from what is stored (the runner's plan readings, this
 * month's spend) plus this process's plan limits, in a few queries for the whole list: it runs on every presence read.
 */
export async function outOfOffice(
  db: Database,
  orgId: string,
  list: OutOfOfficeAgent[],
  options: OutOfOfficeOptions = {},
): Promise<Map<string, OutOfOffice>> {
  const out = new Map<string, OutOfOffice>();
  if (list.length === 0) return out;
  const now = options.now ?? new Date();
  const ms = now.getTime();
  const computer = list.filter((a) => isComputerBrain(brainOf(a.brain)) && a.machineId);
  const [accounts, machines, spent, orgBudget] = await Promise.all([
    accountUsages(db, orgId, computer),
    machineUsages(db, orgId, computer),
    spentThisMonth(db, orgId, now),
    orgDefaultAgentBudget(db, orgId),
  ]);
  const budgetSpent = (a: OutOfOfficeAgent) => {
    const budget = a.monthlyBudgetNanoUsd ?? orgBudget;
    return (spent.get(a.id) ?? 0) >= budget;
  };
  const budgetOut: OutOfOffice = { reason: "budget", until: new Date(nextMonthStart(ms)) };
  for (const a of list) {
    const kind = brainOf(a.brain);
    if (!isComputerBrain(kind)) {
      if (budgetSpent(a)) out.set(a.id, budgetOut);
      continue;
    }
    if (!a.machineId) continue;
    // The agent's own account thinks when it has one on its computer (`brainAccountFor`), else the computer's sign-in.
    const account = a.brainAccountId ? accounts.get(a.brainAccountId) : undefined;
    const usable = account && account.machineId === a.machineId && account.kind === kind ? account : undefined;
    const usage = usable ? usable.usage : (machines.get(a.machineId)?.[kind] ?? null);
    const limited = planLimitOf(a.machineId, kind, usable?.id, usage, ms);
    if (!limited) continue;
    const plan: OutOfOffice = { reason: "plan", until: limited.until !== null ? new Date(limited.until) : null };
    // A conversation falls back to the model brain (ADR 0032 §5): out only when that can't answer either.
    if (a.brainFallback === false) {
      out.set(a.id, plan);
      continue;
    }
    if (!options.hasModel) continue;
    const hasModel = await options.hasModel(a).catch(() => true);
    if (!hasModel) out.set(a.id, plan);
    else if (budgetSpent(a)) out.set(a.id, budgetOut);
  }
  return out;
}

interface AccountUsage {
  id: string;
  machineId: string;
  kind: string;
  usage: PlanUsage | null;
}

async function accountUsages(db: Database, orgId: string, list: OutOfOfficeAgent[]) {
  const ids = [...new Set(list.map((a) => a.brainAccountId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map<string, AccountUsage>();
  const { machineAccounts } = schema;
  const rows = await db
    .select({
      id: machineAccounts.id,
      machineId: machineAccounts.machineId,
      kind: machineAccounts.kind,
      usage: machineAccounts.usage,
    })
    .from(machineAccounts)
    .where(and(eq(machineAccounts.orgId, orgId), inArray(machineAccounts.id, ids)));
  return new Map<string, AccountUsage>(
    rows.map((r) => [r.id, { ...r, usage: (r.usage as PlanUsage | null | undefined) ?? null }]),
  );
}

async function machineUsages(db: Database, orgId: string, list: OutOfOfficeAgent[]) {
  const ids = [
    ...new Set(
      list
        .filter((a) => !a.brainAccountId)
        .map((a) => a.machineId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const out = new Map<string, Partial<Record<string, PlanUsage>>>();
  if (ids.length === 0) return out;
  const { machines } = schema;
  const rows = await db
    .select({ id: machines.id, executors: machines.executors })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), inArray(machines.id, ids)));
  for (const r of rows) out.set(r.id, (r.executors?.ownUsage ?? {}) as Partial<Record<string, PlanUsage>>);
  return out;
}

/** This UTC month's spend of every agent in the organization (nano-USD), as the gateway counts it. */
async function spentThisMonth(db: Database, orgId: string, now: Date) {
  const { agentBudgetPeriods } = schema;
  const period = monthStartUtc(now).toISOString().slice(0, 10);
  const rows = await db
    .select({ agentId: agentBudgetPeriods.agentId, spent: agentBudgetPeriods.spentNanoUsd })
    .from(agentBudgetPeriods)
    .where(and(eq(agentBudgetPeriods.orgId, orgId), eq(agentBudgetPeriods.periodStart, period)));
  return new Map(rows.map((r) => [r.agentId, Number(r.spent)]));
}

/**
 * Which of `agentIds` are out of office now: the router leaves them out of a message nobody mentioned them in (§12),
 * so they don't jump in to answer only after the reset. A mention or a DM still reaches them and waits.
 */
export async function outOfOfficeIds(
  db: Database,
  orgId: string,
  agentIds: string[],
  options: OutOfOfficeOptions = {},
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const { agents } = schema;
  const list = await db
    .select({
      id: agents.id,
      orgId: agents.orgId,
      model: agents.model,
      credentialId: agents.credentialId,
      brain: agents.brain,
      brainFallback: agents.brainFallback,
      brainAccountId: agents.brainAccountId,
      machineId: agents.machineId,
      monthlyBudgetNanoUsd: agents.monthlyBudgetNanoUsd,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)));
  return new Set((await outOfOffice(db, orgId, list, options)).keys());
}
