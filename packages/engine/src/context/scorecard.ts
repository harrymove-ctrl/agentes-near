import { and, type Database, eq, gt, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import { itemWords } from "./items";

const { contextItems } = schema;

/**
 * Which runs carry the memory as it was before ADR 0167 (the agent's own items whatever the topic): one in
 * `HOLDOUT_EVERY`, by its id, so the two arms can be compared (`memoryScorecard`). Rules, preferences and the team's
 * memory are in both.
 */
export const HOLDOUT_EVERY = 10;
export const memoryArmOf = (runId: string): "with" | "without" =>
  Number.parseInt(runId.replace(/-/g, "").slice(-6), 16) % HOLDOUT_EVERY === 0 ? "with" : "without";

export interface MemoryScorecard {
  days: number;
  runs: number;
  /** Runs that carried one of its how-tos, and their average cost, against the average cost of the runs that wrote them. */
  howTos: { runs: number; costNanoUsd: number; writersCostNanoUsd: number };
  /** Preferences people gave again after they were saved: each one a repeat they shouldn't have needed. */
  repeatedPreferences: number;
  /** People's corrections and refused approvals, per 100 runs. */
  correctionsPer100: number;
  /** Items its runs were sent, and how many of those it opened with `expand`. */
  sent: number;
  opened: number;
  /** The with/without comparison (`memoryArmOf`): runs and refused approvals per 100 runs in each arm. */
  arms: Record<"with" | "without", { runs: number; refusedPer100: number }>;
}

const per100 = (n: number, runs: number) => (runs > 0 ? Math.round((n / runs) * 1000) / 10 : 0);

/**
 * One agent's memory over the last `days` (ADR 0167): whether what it keeps pays off, from what is already recorded
 * (runs, their usage, what memory they were sent and opened, outcomes, lessons from corrections). No model call.
 */
export async function memoryScorecard(
  db: Database,
  orgId: string,
  agentId: string,
  days = 7,
): Promise<MemoryScorecard> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [counts] = rowsOf<{
    runs: number;
    with_runs: number;
    used_runs: number;
    used_cost: number;
    writers_cost: number;
    sent: number;
    opened: number;
    refused: number;
    with_refused: number;
  }>(
    await db.execute(sql`with runs as (
        select r.id, coalesce((select s.data->>'memoryArm' from agent_run_steps s
          where s.run_id = r.id and s.kind = 'context' and s.data ? 'memoryArm' limit 1), 'without') as arm
        from agent_runs r
        where r.org_id = ${orgId}::uuid and r.agent_id = ${agentId}::uuid and r.created_at > ${since.toISOString()}::timestamptz),
      used as (select distinct u.run_id from context_usage u join context_items i on i.id = u.item_id
        where u.org_id = ${orgId}::uuid and u.run_id in (select id from runs)
          and i.kind = 'note' and 'howto' = any(string_to_array(i.subject_key, ' '))),
      writers as (select distinct s.run_id from agent_run_steps s join agent_runs r on r.id = s.run_id
        where s.org_id = ${orgId}::uuid and r.agent_id = ${agentId}::uuid and s.kind = 'tool_call'
          and s.data->>'name' = 'save_how_to'),
      cost as (select u.run_id, sum(u.cost_nano_usd)::float8 as c from usage_records u
        where u.org_id = ${orgId}::uuid and u.run_id in (select run_id from used union select run_id from writers)
        group by u.run_id),
      refused as (select o.run_id from outcomes o
        where o.org_id = ${orgId}::uuid and o.kind = 'approval_refused' and o.run_id in (select id from runs))
      select (select count(*) from runs)::int as runs,
        (select count(*) from runs where arm = 'with')::int as with_runs,
        (select count(*) from used)::int as used_runs,
        coalesce((select avg(c) from cost where run_id in (select run_id from used)), 0)::float8 as used_cost,
        coalesce((select avg(c) from cost where run_id in (select run_id from writers)), 0)::float8 as writers_cost,
        (select count(*) from context_usage u where u.run_id in (select id from runs))::int as sent,
        (select count(*) from agent_run_steps s join context_usage u
          on u.run_id = s.run_id and u.item_id::text = s.data->'input'->>'item_id'
          where s.run_id in (select id from runs) and s.kind = 'tool_call' and s.data->>'name' = 'expand')::int as opened,
        (select count(*) from refused)::int as refused,
        (select count(*) from refused where run_id in (select id from runs where arm = 'with'))::int as with_refused`),
  );
  const c = counts ?? {
    runs: 0,
    with_runs: 0,
    used_runs: 0,
    used_cost: 0,
    writers_cost: 0,
    sent: 0,
    opened: 0,
    refused: 0,
    with_refused: 0,
  };
  const [lessons, preferences] = await Promise.all([
    db
      .select({ content: contextItems.content })
      .from(contextItems)
      .where(
        and(
          eq(contextItems.orgId, orgId),
          eq(contextItems.agentId, agentId),
          eq(contextItems.kind, "lesson"),
          gt(contextItems.createdAt, since),
        ),
      ),
    db
      .select({ id: contextItems.id })
      .from(contextItems)
      .where(
        and(
          eq(contextItems.orgId, orgId),
          inArray(contextItems.kind, ["preference"]),
          eq(contextItems.agentId, agentId),
          sql`${contextItems.recurrence} > 1`,
          gt(contextItems.updatedAt, since),
        ),
      ),
  ]);
  const corrected = lessons.filter((l) => itemWords(l).how === "corrected").length;
  const without = c.runs - c.with_runs;
  return {
    days,
    runs: c.runs,
    howTos: { runs: c.used_runs, costNanoUsd: Math.round(c.used_cost), writersCostNanoUsd: Math.round(c.writers_cost) },
    repeatedPreferences: preferences.length,
    correctionsPer100: per100(corrected + c.refused, c.runs),
    sent: c.sent,
    opened: c.opened,
    arms: {
      with: { runs: c.with_runs, refusedPer100: per100(c.with_refused, c.with_runs) },
      without: { runs: without, refusedPer100: per100(c.refused - c.with_refused, without) },
    },
  };
}
