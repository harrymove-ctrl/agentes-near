import { type Database, rowsOf, type SQL, sql } from "@agenteschat/db";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { ANALYTICS_ROWS_MAX, analyticsRange } from "./connector-usage";
import { getOrMake } from "./format";
import { apiNano, tokensOf } from "./plan-usage";
import { runErrorDetail } from "./runs";

/**
 * The operator API's work analytics: agent turns (runs) by where they came from and how they ended, the waits for
 * room on a computer, and the tokens they spent by type and by who pays, fleet-wide per workspace or for one
 * workspace per agent. Counts and ids only: no message content, no names.
 */

export const WORK_ANALYTICS_MAX_DAYS = 90;
/** Up to this many days the series is by hour. */
export const WORK_ANALYTICS_HOURLY_DAYS = 2;

const ORIGINS = ["person", "agent", "routine", "longWork", "followUp", "other"] as const;
const FAILURES = ["computerBusy", "noAi", "paused", "failedOther"] as const;
type Failure = (typeof FAILURES)[number];

const FAILURE_OF: Record<string, Failure> = {
  "run.computer_busy": "computerBusy",
  "run.no_ai": "noAi",
  "run.missing_credential": "noAi",
  "run.credential_revoked": "noAi",
  "run.credential_wrong_provider": "noAi",
  "run.agent_paused": "paused",
  "run.org_paused": "paused",
  "run.org_suspended": "paused",
  "run.org_deleting": "paused",
  "run.budget_exceeded": "paused",
};
const failureOf = (error: string | null): Failure =>
  FAILURE_OF[runErrorDetail(error)?.errorCode ?? ""] ?? "failedOther";

const zeroTurns = () => ({
  total: 0,
  ...(Object.fromEntries(ORIGINS.map((o) => [o, 0])) as Record<(typeof ORIGINS)[number], number>),
  done: 0,
  canceled: 0,
  active: 0,
  failed: 0,
  ...(Object.fromEntries(FAILURES.map((o) => [o, 0])) as Record<Failure, number>),
});
const zeroWaits = () => ({
  waited: 0,
  peakWaiting: 0,
  personReplies: 0,
  personFailed: 0,
  replyMedianSec: null as number | null,
  replyP90Sec: null as number | null,
});
const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, apiEquivalentUsd: 0 });
type Tokens = ReturnType<typeof zeroTokens>;
const zeroRow = () => ({ turns: zeroTurns(), waits: zeroWaits(), tokens: zeroTokens() });
type Row = ReturnType<typeof zeroRow>;

/** Which of the grouping sets a row is: the whole range, one bucket of the series, or one workspace or agent. */
interface Grouped {
  gAt: number;
  gKey: number;
  at: string | null;
  key: string | null;
}
const slot = <T extends Grouped>(r: T) => (r.gAt === 0 ? "at" : r.gKey === 0 ? "key" : "all");
const GROUPS = sql.raw('grouping(at)::int as "gAt", grouping(key)::int as "gKey", at, key');

/** Agent work in the dates across workspaces, with a row per workspace (`workAnalytics`). */
export async function operatorWorkAnalytics(db: Database, query: { from: string; to: string }) {
  const { rows, ...rest } = await workAnalytics(db, query);
  return { ...rest, workspaces: rows.map(({ id, ...row }) => ({ orgId: id, ...row })) };
}

/** One workspace's agent work in the dates, with a row per agent (`workAnalytics`). */
export async function operatorOrgWorkAnalytics(db: Database, orgId: string, query: { from: string; to: string }) {
  const { rows, ...rest } = await workAnalytics(db, query, orgId);
  return { ...rest, orgId, agents: rows.map(({ id, ...row }) => ({ agentId: id, ...row })) };
}

/**
 * Agent work in the dates (UTC days, at most `WORK_ANALYTICS_MAX_DAYS`), fleet-wide with a row per workspace, or
 * for one workspace (`orgId`) with a row per agent. Turns, waits and replies count runs created in the dates;
 * tokens count usage recorded in them.
 */
async function workAnalytics(db: Database, query: { from: string; to: string }, orgId?: string) {
  const r = analyticsRange(query.from, query.to, WORK_ANALYTICS_MAX_DAYS);
  const hourly = (r.end.getTime() - r.start.getTime()) / 86_400_000 <= WORK_ANALYTICS_HOURLY_DAYS;
  // A literal, never a parameter: Postgres must see the same expression in the select and the group by.
  const fmt = sql.raw(hourly ? `'YYYY-MM-DD"T"HH24'` : `'YYYY-MM-DD'`);
  const bucket = (column: SQL) => sql`to_char(${column} at time zone 'utc', ${fmt})`;
  const [start, end] = [r.start.toISOString(), r.end.toISOString()];
  const runsIn = sql`ar.created_at >= ${start}::timestamptz and ar.created_at < ${end}::timestamptz${
    orgId ? sql` and ar.org_id = ${orgId}` : sql``
  }`;
  const runKey = orgId ? sql`ar.agent_id` : sql`ar.org_id`;
  // Waits for room are steps (`brain_unavailable`, `busy`), written once per wait; it lasts until the run's next step
  // (`roomFound` when the computer takes the turn), its end or now.
  const busyStep = sql`s.kind = 'error' and s.data->>'reason' = 'brain_unavailable' and s.data->>'code' = 'busy'`;

  const [turnRows, failureRows, peakRows, tokenRows] = await Promise.all([
    db.execute(sql`
      with r as (
        select ${runKey} as key, ${bucket(sql`ar.created_at`)} as at, ar.status,
          case
            when tm.meta->'routine' is not null or tm.meta->'routineBrief' is not null
              or tm.meta->'notice'->>'kind' = 'routine_handoff' then 'routine'
            when ar.work_id is not null or ar.background then 'longWork'
            -- A notice the agent posts to itself (deliverNotice): another agent's answer, a person's question
            -- relayed (wiki-dm), else the agent coming back to its own work (follow-ups, waits, results).
            when tm.meta ? 'notice' and tm.author_agent_id = ar.agent_id then case
              when tm.meta->'notice'->>'kind' = 'consult_reply'
                or (tm.meta->'notice'->>'kind' = 'agent_note' and tm.meta->'notice'->>'from' like '@%') then 'agent'
              when tm.meta->'notice'->>'kind' = 'agent_note' then 'person'
              else 'followUp' end
            when ar.hop >= 2 or tm.author_type = 'agent' then 'agent'
            when tm.author_type = 'person' then 'person'
            else 'other'
          end as origin,
          exists (select 1 from agent_run_steps s where s.run_id = ar.id and ${busyStep}) as waited,
          extract(epoch from rm.created_at - ar.created_at)::float8 as reply_sec
        from agent_runs ar
        -- The time bounds let Postgres prune the monthly partitions of messages per run.
        left join messages tm on tm.id = ar.trigger_message_id and tm.org_id = ar.org_id
          and tm.created_at <= ar.created_at
        left join messages rm on rm.id = ar.reply_message_id and rm.org_id = ar.org_id
          and rm.created_at >= ar.created_at
        where ${runsIn}
      )
      select ${GROUPS}, count(*)::int as total,
        ${sql.join(
          ORIGINS.map((o) => sql`count(*) filter (where origin = ${o})::int as ${sql.identifier(o)}`),
          sql`, `,
        )},
        count(*) filter (where status = 'done')::int as done,
        count(*) filter (where status = 'canceled')::int as canceled,
        count(*) filter (where status = 'failed')::int as failed,
        count(*) filter (where status not in ('done', 'canceled', 'failed'))::int as active,
        count(*) filter (where waited)::int as waited,
        count(reply_sec) filter (where origin = 'person')::int as "personReplies",
        count(*) filter (where origin = 'person' and status = 'failed')::int as "personFailed",
        percentile_cont(0.5) within group (order by reply_sec) filter (where origin = 'person') as "replyMedianSec",
        percentile_cont(0.9) within group (order by reply_sec) filter (where origin = 'person') as "replyP90Sec"
      from r group by grouping sets ((at), (key), ())`),
    // Failure reasons are read from the stored error like the app does (`runErrorDetail`); the texts with a
    // free-form tail are cut to their prefix so the groups stay few.
    db.execute(sql`
      select ${GROUPS}, error, count(*)::int as n from (
        select ${runKey} as key, ${bucket(sql`ar.created_at`)} as at,
          case when ar.error like 'provider_error:%' then 'provider_error:'
            when ar.error like 'gave_up:%' then 'gave_up:' else ar.error end as error
        from agent_runs ar where ${runsIn} and ar.status = 'failed'
      ) f group by grouping sets ((at, error), (key, error), (error))`),
    // ponytail: only waits of runs created in the dates, a peak only where a wait starts or ends.
    db.execute(sql`
      with w as (
        select ${runKey} as key, s.created_at as since,
          least(coalesce(
            (select min(n.created_at) from agent_run_steps n where n.run_id = s.run_id and n.seq > s.seq),
            ar.finished_at, now()), ${end}::timestamptz) as until
        from agent_runs ar join agent_run_steps s on s.run_id = ar.id
        where ${runsIn} and ${busyStep}
      ), e as (
        select key, since as t, 1 as d from w union all select key, until, -1 from w
      ), c as (
        select key, t,
          sum(d) over (order by t, d rows unbounded preceding) as everyone,
          sum(d) over (partition by key order by t, d rows unbounded preceding) as own
        from e
      )
      select ${GROUPS}, max(everyone)::int as everyone, max(own)::int as own
      from (select key, ${bucket(sql`t`)} as at, everyone, own from c where t < ${end}::timestamptz) p
      group by grouping sets ((at), (key), ())`),
    db.execute(sql`
      select ${GROUPS}, payer, model,
        sum(input_tokens)::float8 as input, sum(output_tokens)::float8 as output,
        sum(cache_read_tokens)::float8 as "cacheRead", sum(cache_write_tokens)::float8 as "cacheWrite",
        sum(cost_nano_usd)::float8 as cost, count(distinct run_id)::int as runs,
        sum(input_tokens) filter (where run_id is not null)::float8 as "runInput",
        sum(output_tokens) filter (where run_id is not null)::float8 as "runOutput",
        sum(cache_read_tokens) filter (where run_id is not null)::float8 as "runCacheRead",
        sum(cache_write_tokens) filter (where run_id is not null)::float8 as "runCacheWrite"
      from (
        select ${orgId ? sql`agent_id` : sql`org_id`} as key, ${bucket(sql`created_at`)} as at, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_nano_usd, run_id,
          case when billed_to = 'org' then case when credential_id is null then 'platform_key' else 'workspace_key' end
            else billed_to end as payer
        from usage_records
        where created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz${
          orgId ? sql` and org_id = ${orgId}` : sql``
        }
      ) u group by grouping sets ((at, payer, model), (key, payer, model), (payer, model), ())`),
  ]);

  const all = zeroRow();
  const series = new Map<string, Row & { byPayer: Map<string, Tokens> }>();
  const keyed = new Map<string, Row>();
  const byPayer = new Map<string, Tokens>();
  const rowOf = (g: Grouped): Row | null => {
    const where = slot(g);
    if (where === "all") return all;
    if (where === "at") {
      return getOrMake(series, g.at ?? "", () => ({ ...zeroRow(), byPayer: new Map<string, Tokens>() }));
    }
    // Usage made for the workspace rather than an agent (the router, embeddings): only in the totals.
    if (g.key === null) return null;
    return getOrMake(keyed, g.key, zeroRow);
  };

  type TurnRow = Grouped & Record<string, number | null>;
  for (const t of rowsOf<TurnRow>(turnRows)) {
    const row = rowOf(t);
    if (!row) continue;
    for (const k of ["total", ...ORIGINS, "done", "canceled", "failed", "active"] as const) row.turns[k] = Number(t[k]);
    row.waits.waited = Number(t.waited);
    row.waits.personReplies = Number(t.personReplies);
    row.waits.personFailed = Number(t.personFailed);
    row.waits.replyMedianSec = t.replyMedianSec === null ? null : Math.round(Number(t.replyMedianSec));
    row.waits.replyP90Sec = t.replyP90Sec === null ? null : Math.round(Number(t.replyP90Sec));
  }
  for (const f of rowsOf<Grouped & { error: string | null; n: number }>(failureRows)) {
    const row = rowOf(f);
    if (row) row.turns[failureOf(f.error)] += Number(f.n);
  }
  for (const p of rowsOf<Grouped & { everyone: number; own: number }>(peakRows)) {
    const row = rowOf(p);
    if (row) row.waits.peakWaiting = Number(slot(p) === "key" ? p.own : p.everyone);
  }
  let turnsWithUsage = 0;
  // Per turn: only usage made in a run (not the router, embeddings or this server's own services).
  const inRuns = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  type TokenRow = Grouped & {
    payer: string | null;
    model: string | null;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    runs: number;
    runInput: number | null;
    runOutput: number | null;
    runCacheRead: number | null;
    runCacheWrite: number | null;
  };
  for (const u of rowsOf<TokenRow>(tokenRows)) {
    // The grand total's row: only the distinct turns that spent tokens (the sums come from the payers' rows).
    if (u.payer === null) {
      turnsWithUsage = Number(u.runs);
      inRuns.input = Number(u.runInput ?? 0);
      inRuns.output = Number(u.runOutput ?? 0);
      inRuns.cacheRead = Number(u.runCacheRead ?? 0);
      inRuns.cacheWrite = Number(u.runCacheWrite ?? 0);
      continue;
    }
    const counts = {
      input: Number(u.input),
      output: Number(u.output),
      cacheRead: Number(u.cacheRead),
      cacheWrite: Number(u.cacheWrite),
    };
    const cost = Number(u.cost);
    // A plan's tokens cost nothing here: priced like the plan card's "≈ … pela API" (`apiNano`).
    const equivalent = u.payer === "plan" ? (apiNano(u.model, counts) ?? 0) : cost;
    const add = (t: Tokens) => {
      t.input += counts.input;
      t.output += counts.output;
      t.cacheRead += counts.cacheRead;
      t.cacheWrite += counts.cacheWrite;
      t.costUsd += nanoUsdToUsd(cost);
      t.apiEquivalentUsd += nanoUsdToUsd(equivalent);
    };
    const payerOf = (map: Map<string, Tokens>) => getOrMake(map, u.payer as string, zeroTokens);
    const where = slot(u);
    const row = rowOf(u);
    if (!row) continue;
    add(row.tokens);
    if (where === "all") add(payerOf(byPayer));
    if (where === "at") add(payerOf((row as Row & { byPayer: Map<string, Tokens> }).byPayer));
  }

  const money = (t: Tokens): Tokens => ({
    ...t,
    costUsd: Math.round(t.costUsd * 1e6) / 1e6,
    apiEquivalentUsd: Math.round(t.apiEquivalentUsd * 1e6) / 1e6,
  });
  const payers = (map: Map<string, Tokens>) =>
    [...map].map(([payer, t]) => ({ payer, ...money(t) })).sort((a, b) => tokensOf(b) - tokensOf(a));
  const out = (row: Row) => ({
    turns: row.turns,
    waits: row.waits,
    tokens: money(row.tokens),
    agentShare: row.turns.total > 0 ? Math.round((row.turns.agent / row.turns.total) * 1000) / 1000 : 0,
  });
  const perTurn = (n: number) => (turnsWithUsage > 0 ? Math.round(n / turnsWithUsage) : 0);
  const ranked = [...keyed]
    .map(([id, row]) => ({ id, ...out(row) }))
    .sort((a, b) => tokensOf(b.tokens) - tokensOf(a.tokens) || b.turns.total - a.turns.total);
  return {
    from: r.from,
    to: r.to,
    bucket: hourly ? ("hour" as const) : ("day" as const),
    totals: {
      ...out(all),
      byPayer: payers(byPayer),
      turnsWithUsage,
      perTurn: {
        input: perTurn(inRuns.input),
        output: perTurn(inRuns.output),
        cacheRead: perTurn(inRuns.cacheRead),
        cacheWrite: perTurn(inRuns.cacheWrite),
      },
    },
    series: [...series]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([at, row]) => ({ at, ...out(row), byPayer: payers(row.byPayer) })),
    rows: ranked.slice(0, ANALYTICS_ROWS_MAX),
    more: ranked.length > ANALYTICS_ROWS_MAX,
  };
}
