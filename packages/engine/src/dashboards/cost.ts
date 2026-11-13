import { and, type Database, eq, gte, inArray, isNotNull, schema, sql } from "@agenteschat/db";
import { costNanoUsd, isAutoModel, modelForTier, modelInfo } from "@agenteschat/providers";
import { isWidgetSchedule, scheduleRunsPerDay } from "@agenteschat/ui/widgets/spec";
import { isComputerBrain } from "../brains/types";
import { ValidationError } from "../errors";
import { requireActiveMembership } from "../organizations";
import { orgModelProvider } from "../router";
import { requireReachableAgent } from "./service";
import type { DashboardDeps, WidgetCostEstimate, WidgetSchedule } from "./types";

const { usageRecords, routineRuns, routines } = schema;

/** How far back an agent's routine runs are averaged. */
const HISTORY_DAYS = 30;
/** Fewer routine runs than this say too little: the model's price is used instead. */
const HISTORY_MIN_RUNS = 3;
/** A typical refresh: what a widget's run reads and writes (ADR 0135 §7). */
export const TYPICAL_REFRESH = { inputTokens: 8_000, outputTokens: 1_000 } as const;

/**
 * The agent's average cost of one routine run over the last `HISTORY_DAYS`, in nano-USD, from what its routine runs
 * spent on the workspace's keys (`usage_records`, billed to the org); null with fewer than `HISTORY_MIN_RUNS` runs.
 */
export async function averageRoutineRunCost(
  db: Database,
  orgId: string,
  agentId: string,
  now = new Date(),
): Promise<number | null> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  const runs = db
    .select({ id: routineRuns.agentRunId })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(
      and(
        eq(routineRuns.orgId, orgId),
        eq(routines.agentId, agentId),
        isNotNull(routineRuns.agentRunId),
        gte(routineRuns.createdAt, since),
      ),
    );
  const [row] = await db
    .select({
      runs: sql<number>`count(distinct ${usageRecords.runId})::int`,
      cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`,
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.orgId, orgId),
        eq(usageRecords.agentId, agentId),
        eq(usageRecords.billedTo, "org"),
        gte(usageRecords.createdAt, since),
        inArray(usageRecords.runId, runs),
      ),
    );
  const count = Number(row?.runs ?? 0);
  if (count < HISTORY_MIN_RUNS) return null;
  return Number(row?.cost ?? 0) / count;
}

/** What a typical refresh costs on `model` (nano-USD), or null when the catalog doesn't price it. */
export function typicalRefreshCost(model: string | null): number | null {
  if (!model || !modelInfo(model)) return null;
  return costNanoUsd(model, { ...TYPICAL_REFRESH, cacheReadTokens: 0, cacheWriteTokens: 0 });
}

/**
 * What a widget's refreshes cost (ADR 0135 §7).
 *
 * Runs a day (`scheduleRunsPerDay`) × the agent's average cost of a background (routine) run over its last 30 days,
 * from `usage_records` (at least 3 runs: `basis: "history"`); else its model's price (`@agenteschat/providers`
 * catalog) for a typical refresh of 8,000 input and 1,000 output tokens (`basis: "model"`). A computer brain's plan
 * pays (`billedTo: "plan"`): no money. The person must be able to talk to the agent. The Model Gateway's budget
 * check still holds every run.
 */
export async function estimateWidgetCost(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  agentId: string,
  schedule: WidgetSchedule,
): Promise<WidgetCostEstimate> {
  if (!isWidgetSchedule(schedule)) throw new ValidationError("Unknown schedule");
  const membership = await requireActiveMembership(deps.db, actorId, orgId);
  const agent = await requireReachableAgent(deps.db, orgId, agentId, actorId, membership);
  const runsPerDay = scheduleRunsPerDay(schedule);
  const base = { agentId: agent.id, schedule, runsPerDay };
  if (isComputerBrain(agent.brain)) {
    return { ...base, perRunUsd: null, perDayUsd: null, perWeekUsd: null, basis: "none", billedTo: "plan" };
  }
  let basis: WidgetCostEstimate["basis"] = "history";
  let perRunNano = await averageRoutineRunCost(deps.db, orgId, agent.id, deps.now?.() ?? new Date());
  if (perRunNano === null) {
    const model = isAutoModel(agent.model)
      ? modelForTier(await orgModelProvider(deps.db, orgId), "medium")
      : agent.model;
    perRunNano = typicalRefreshCost(model);
    basis = perRunNano === null ? "none" : "model";
  }
  if (perRunNano === null) {
    return { ...base, perRunUsd: null, perDayUsd: null, perWeekUsd: null, basis, billedTo: "api" };
  }
  const perRunUsd = perRunNano / 1e9;
  return {
    ...base,
    perRunUsd,
    perDayUsd: perRunUsd * runsPerDay,
    perWeekUsd: perRunUsd * runsPerDay * 7,
    basis,
    billedTo: "api",
  };
}
