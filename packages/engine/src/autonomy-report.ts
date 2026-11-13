import { type Executor, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { emailLocale, emailsByLocale, queueEmail } from "./email";
import { enqueue } from "./outbox";
import { ACK_MAX_WORDS, DEFAULT_NEED } from "./router";
import { STUCK_ERROR } from "./runs";
import { openOrg } from "./standing";
import { REFUSALS } from "./tools/run-policy";

/**
 * The daily stall-and-noise report (ADR 0089, addendum 2026-10-31): where agents stopped although someone was
 * waiting on them, and where they acted for nothing, per workspace and UTC day, from what the server already
 * stores. Counts and workspace names only: nothing anyone wrote leaves the database.
 *
 * Stalls:
 * - `mentionNoRun`: an agent @mentioned another agent and that agent got no run and never read the message in
 *   one; mentions the judge read as only a reference ("Só mencionado") are left out, never those it failed to read,
 *   and so are those a stretch's limit held (its pause card counts them, in `limitStops`).
 * - `readOnly`: conversation runs the policy kept from tools the agent's scopes grant, for who was behind them
 *   (ADR 0053), from the run's first `context` step (`heldBack`), and runs with a tool call refused for that
 *   (`tool.call` audit rows with a run-policy refusal).
 * - `promiseUnkept`: runs the follow-through judge found ending on work left undone (the `nudged: promise` step);
 *   `promiseIgnored`: those that ended after the nudge without doing anything (`ACTED`).
 * - `handoffUnanswered`: notes (`tell_agent`) with no reply in the agents' DM, questions (`ask_agent`) not answered,
 *   and @mentions that reached the agent without a word from it in the conversation, each within 30 minutes.
 * - `limitStops`: runs whose reply offers Continuar after a limit (`meta.stepLimit`: at the cap, or told to wrap up
 *   near it), runs told to wrap up (a routine's hands off instead), runs failed on a limit (steps, budget, stuck),
 *   stretches paused at their limit (one card each), and missions their stuck guard paused (`meta.missionStuck`).
 * - `personUnanswered`: a person's message meant for agents (a mention, a DM with an agent, the router's pick, or a
 *   channel message the router never decided on) with no agent message there within 10 minutes.
 * - `taskStartFailed`: background tasks that failed within a minute ("Not logged in", a missing CLI).
 *
 * Each event goes on one side: a message or hand-off whose woken run ended done without a word (it passed, or only
 * reacted) is that run's noise (`quietRuns`), never also an unanswered stall.
 *
 * Untried (ADR 0109, not stalls): `untriedNudged`, runs the turn-end judge found saying they couldn't with ways left
 * (the `nudged: untried` step, a routine's held `hand_off` too); `untriedResolved`, those that acted after the nudge
 * and ended done (`ACTED`): how often the nudge turned a give-up into work.
 *
 * Noise (conversation runs): `quietRuns` ended without a message (`pass`, the silence word, nothing);
 * `ackReplies` replied to a message that is only a thanks, an ok or a sign-off, and did nothing else; `idleWakes`
 * were woken by an agent's @mention and did nothing (no message, or only an acknowledgement). `noiseRuns`,
 * `noiseTokens` and `noiseCostNanoUsd` count each such run once, with all its model usage.
 */

export const AUTONOMY_STALLS = [
  "mentionNoRun",
  "readOnly",
  "promiseUnkept",
  "promiseIgnored",
  "handoffUnanswered",
  "limitStops",
  "personUnanswered",
  "taskStartFailed",
] as const;
export const AUTONOMY_NOISE = [
  "noiseRuns",
  "quietRuns",
  "ackReplies",
  "idleWakes",
  "noiseTokens",
  "noiseCostNanoUsd",
] as const;

export const AUTONOMY_UNTRIED = ["untriedNudged", "untriedResolved"] as const;

export type AutonomyMetric =
  | (typeof AUTONOMY_STALLS)[number]
  | (typeof AUTONOMY_NOISE)[number]
  | (typeof AUTONOMY_UNTRIED)[number];
/** Every count, plus `stalls`: the stall counts added up, each stall once (`promiseIgnored` is part of `promiseUnkept`). */
export type AutonomyCounts = Record<AutonomyMetric | "stalls", number>;
export interface AutonomyRow extends AutonomyCounts {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  orgId: string;
  orgName: string;
}

/** The outbox job that emails one day's report to `OPS_REPORT_EMAIL`. */
export const AUTONOMY_REPORT_JOB = "ops.autonomy_report";

/** How long a hand-off and a person's message wait for an answer before they count as stalls. */
export const ANSWER_WITHIN = { handoff: "30 minutes", person: "10 minutes" } as const;
/** A task that failed sooner than this after it started failed at its start. */
const TASK_START_SECONDS = 60;
/** The report goes out this long after the UTC day ends, so its last messages had their whole answer window. */
const REPORT_DELAY_MS = 3600_000;

/** Runs of punctuation, symbols and emoji (Postgres ARE): what is left of a message without them are its words. */
const NOT_WORDS =
  "[\\s\\u0021-\\u002f\\u003a-\\u0040\\u005b-\\u0060\\u007b-\\u007e\\u00a1-\\u00bf\\u2010-\\u206f\\u2190-\\u2bff\\u3000-\\u303f\\ufe0f\\uff01-\\uff0f\\U0001f000-\\U0001faff]+";
/**
 * SQL: the text in `column` is only a thanks, an ok or a sign-off, told the way the router tells it, in any language
 * (no word list): at most 80 characters with no question mark, and once its @mentions are gone either only emoji and
 * punctuation, or at most `ACK_MAX_WORDS` words the router heard as needing no agent (`need`, its
 * `needs_agent_score`, under `DEFAULT_NEED`). A message the router never read counts only when it is emoji. Words
 * are split at spaces here (a script without them is one word): the router's need tells those apart.
 */
const isAck = (column: string, need: string) => {
  const [text, score] = [sql.raw(column), sql.raw(need)];
  const words = sql`btrim(regexp_replace(regexp_replace(lower(${text}), '@[a-z0-9_.-]+', ' ', 'g'), ${NOT_WORDS}, ' ', 'g'))`;
  return sql`coalesce(length(${text}) <= 80 and ${text} !~ '[?？؟]' and btrim(${text}) <> ''
    and (${words} = '' or (${score} < ${DEFAULT_NEED} and array_length(regexp_split_to_array(${words}, ' +'), 1) <= ${ACK_MAX_WORDS})),
    false)`;
};

/**
 * SQL: a run step that did something: an approval, a command the computer ran itself, any tool call but those that
 * never are the work (reacting, passing, its own status line, a tool directory's search, loading a skill). A look-up
 * counts: it is often what was promised or asked ("I'll check the logs").
 */
const ACTED = sql.raw(`((s.kind = 'tool_call' and coalesce(s.data->>'name', '') not in
    ('react', 'pass', 'set_status', 'load_skill', 'read_skill_file')
    and coalesce(s.data->>'name', '') not like '%find_tools')
  or s.kind = 'approval' or (s.kind = 'model_call' and coalesce((s.data->>'executed')::int, 0) > 0))`);

/**
 * SQL: an agent message `a` that is a word from the agent, not a server line (a notice, a no-AI card, a pause card).
 * The talker's quick reply while a task works is a notice too, and an answer.
 */
const SPOKE = sql.raw(`(a.author_type = 'agent' and a.deleted_at is null
  and not ((a.meta ? 'notice' and not a.meta ? 'talker') or a.meta ? 'noAi')
  and coalesce(a.meta->'actionCard'->>'kind', '') <> 'stretch_paused')`);

/**
 * SQL: a run `w` of the report's runs, matching `on`, ended done without a word (it passed, or only reacted): the
 * message that woke it counts with that noise run, never also as a stall (each event on one side).
 */
const wokeQuiet = (on: string) => sql.raw(`exists (select 1 from runs w where w.quiet and ${on})`);

/** SQL: message `a` is in message `m`'s conversation: its timeline, or a thread opened under it. */
const SAME_CONVERSATION = sql.raw(
  "(a.org_id = m.org_id and a.channel_id = m.channel_id and (a.thread_id is not distinct from m.thread_id or a.thread_id = m.id))",
);

const DAY_MS = 86_400_000;
const isoDay = (at: Date) => at.toISOString().slice(0, 10);

/**
 * Every count for `days` UTC days from `from` (`YYYY-MM-DD`), one row per day and workspace that has any. Without
 * `orgId`, every workspace that is active (not held, suspended or being deleted); with it, that one whatever its
 * state. `router`: whether the router is on (`ROUTER_ENABLED`): with it off, a channel message nobody decided on
 * was meant for people.
 */
export async function autonomyRows(db: Executor, range: AutonomyRange): Promise<AutonomyRow[]> {
  const rows = rowsOf<{ day: string; org_id: string; org_name: string; metric: AutonomyMetric; n: number | string }>(
    await db.execute(autonomySql(range)),
  );
  const byKey = new Map<string, AutonomyRow>();
  for (const r of rows) {
    const key = `${r.day}|${r.org_id}`;
    const row = byKey.get(key) ?? { day: r.day, orgId: r.org_id, orgName: r.org_name, ...emptyCounts() };
    row[r.metric] = Number(r.n);
    byKey.set(key, row);
  }
  return [...byKey.values()].map((r) => ({ ...r, stalls: stallsOf(r) }));
}

export type AutonomyRange = { from: string; days: number; orgId?: string | null; router?: boolean };

/** The one statement behind `autonomyRows`: a row per day, workspace and count (`day`, `org_id`, `org_name`, `metric`, `n`). */
export function autonomySql(range: AutonomyRange) {
  const from = new Date(`${range.from}T00:00:00Z`);
  const to = new Date(from.getTime() + range.days * DAY_MS);
  const [start, end] = [from.toISOString(), to.toISOString()];
  const refusals = sql.join(
    Object.values(REFUSALS).map((r) => sql`${r}`),
    sql`, `,
  );
  const orgs = range.orgId ? sql`${schema.organizations.id} = ${range.orgId}::uuid` : openOrg;
  return sql`with orgs as (
      select ${schema.organizations.id} as id, ${schema.organizations.name} as name from ${schema.organizations} where ${orgs}
    ),
    runs as (
      select r.id, r.org_id, r.agent_id, r.trigger_message_id, r.trigger, r.status, r.error, r.background,
        (r.created_at at time zone 'UTC')::date as day, rm.body as reply_body, rd.needs_agent_score as reply_need,
        coalesce(rm.meta ? 'stepLimit', false) as reply_limit,
        r.status = 'done' and not f.posted and not r.background as quiet, f.*
      from agent_runs r
      join orgs o on o.id = r.org_id
      left join messages rm on rm.org_id = r.org_id and rm.id = r.reply_message_id
      left join routing_decisions rd on rd.message_id = r.reply_message_id
      cross join lateral (
        select coalesce(bool_or(s.kind = 'message'), false) as posted,
          coalesce(bool_or(${ACTED}), false) as acted,
          min(s.seq) filter (where s.kind = 'context' and s.data->>'nudged' = 'promise') as nudged_at,
          min(s.seq) filter (where s.kind = 'context' and s.data->>'nudged' = 'untried') as untried_at,
          coalesce(bool_or(s.kind = 'context' and s.data ? 'heldBack'), false) as held_back,
          coalesce(bool_or(s.kind = 'context' and s.data ? 'wrapUp'), false) as wrapped_up
        from agent_run_steps s where s.run_id = r.id
      ) f
      where r.created_at >= ${start}::timestamptz and r.created_at < ${end}::timestamptz
    ),
    refused as (
      select distinct l.run_id from audit_log l
      join orgs o on o.id = l.org_id
      where l.created_at >= ${start}::timestamptz and l.created_at < ${end}::timestamptz + interval '1 day'
        and l.run_id is not null and l.action = 'tool.call' and l.outcome = 'refused'
        and l.details->>'reason' in (${refusals})
    ),
    noise as (
      select r.id, r.org_id, r.day, r.quiet,
        r.posted and not r.acted and ${isAck("t.body", "td.needs_agent_score")} as ack,
        r.status = 'done' and r.trigger = 'mention' and t.author_type = 'agent' and not r.acted
          and (not r.posted or ${isAck("r.reply_body", "r.reply_need")}) as idle
      from runs r
      left join messages t on t.org_id = r.org_id and t.id = r.trigger_message_id
      left join routing_decisions td on td.message_id = t.id
      where not r.background
    ),
    noise_runs as (select id, org_id, day from noise where quiet or ack or idle),
    mentions as (
      select m.org_id, m.id, m.channel_id, m.thread_id, m.created_at, (m.created_at at time zone 'UTC')::date as day,
        a.agent_id,
        exists (select 1 from agent_runs r where r.trigger_message_id = m.id and r.agent_id = a.agent_id)
          or exists (select 1 from agent_runs r join agent_run_steps s on s.run_id = r.id
            where r.org_id = m.org_id and r.agent_id = a.agent_id and r.channel_id = m.channel_id
              and r.created_at > m.created_at - interval '1 day' and r.created_at < m.created_at
              and s.kind = 'context' and s.data->'steeredMessageIds' ? m.id::text) as reached,
        exists (select 1 from routing_decisions d
          where d.message_id = m.id and d.error is null and not (a.agent_id = any(d.selected_agent_ids))) as referenced,
        -- Held by its stretch's limit: that pause card counts it (limitStops). A card stays open for 7 days.
        exists (select 1 from messages k where k.org_id = m.org_id and k.channel_id = m.channel_id
          and k.created_at > m.created_at - interval '7 days' and k.created_at < ${end}::timestamptz + interval '1 day'
          and k.author_type = 'agent' and k.meta->'actionCard'->>'kind' = 'stretch_paused'
          and k.meta->'actionCard'->'held' @> jsonb_build_array(jsonb_build_object('messageId', m.id, 'agentId', a.agent_id))
        ) as held
      from messages m
      join orgs o on o.id = m.org_id
      join channels c on c.org_id = m.org_id and c.id = m.channel_id
      cross join lateral unnest(m.mentioned_agent_ids) as a(agent_id)
      where m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
        and m.author_type = 'agent' and m.deleted_at is null and a.agent_id is distinct from m.author_agent_id
        and not (m.meta ?| array['notice', 'noAi', 'actionCard', 'talker', 'background', 'missionSuggestion',
          'issueWork', 'issueWorkStart', 'issueTaken'])
        and (c.kind = 'channel' or (c.kind = 'dm' and c.dm_key like '%u:%'))
    ),
    people as (
      select m.org_id, m.id, m.channel_id, m.thread_id, m.created_at, (m.created_at at time zone 'UTC')::date as day,
        case when cardinality(t.addressed) > 0 then t.addressed
          when c.kind = 'channel' and cardinality(d.selected_agent_ids) > 0 then d.selected_agent_ids end as targets,
        cardinality(t.addressed) > 0
          or (c.kind = 'dm' and c.dm_key like '%a:%')
          or cardinality(d.selected_agent_ids) > 0
          or (${range.router ?? true}::boolean and c.kind = 'channel' and d.id is null and not (m.meta ? 'background')
            and exists (select 1 from channel_members cm join agents g on g.id = cm.agent_id
              where cm.channel_id = m.channel_id and cm.auto_reply and g.archived_at is null)
            and not exists (select 1 from messages n
              where n.org_id = m.org_id and n.channel_id = m.channel_id and n.thread_id is not distinct from m.thread_id
                and n.author_user_id = m.author_user_id and n.id <> m.id
                and n.created_at > m.created_at and n.created_at <= m.created_at + interval '5 seconds')) as meant
      from messages m
      join orgs o on o.id = m.org_id
      join channels c on c.org_id = m.org_id and c.id = m.channel_id
      left join routing_decisions d on d.message_id = m.id
      cross join lateral (
        select array(select x from unnest(m.mentioned_agent_ids) x
          where not coalesce(m.meta->'referencedAgentIds', '[]'::jsonb) ? x::text) as addressed
      ) t
      where m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
        and m.author_type = 'person' and m.deleted_at is null and c.kind in ('channel', 'dm')
    ),
    counts as (
      select day, org_id, 'readOnly' as metric, count(*) as n from runs
        where (not background and held_back) or id in (select run_id from refused) group by 1, 2
      union all
      select day, org_id, 'promiseUnkept', count(*) from runs where nudged_at is not null group by 1, 2
      union all
      select r.day, r.org_id, 'promiseIgnored', count(*) from runs r
        where r.nudged_at is not null and r.status = 'done'
          and not exists (select 1 from agent_run_steps s where s.run_id = r.id and s.seq > r.nudged_at and ${ACTED})
        group by 1, 2
      union all
      select day, org_id, 'untriedNudged', count(*) from runs where untried_at is not null group by 1, 2
      union all
      select r.day, r.org_id, 'untriedResolved', count(*) from runs r
        where r.untried_at is not null and r.status = 'done'
          and exists (select 1 from agent_run_steps s where s.run_id = r.id and s.seq > r.untried_at and ${ACTED})
        group by 1, 2
      union all
      select day, org_id, 'limitStops', count(*) from runs
        where wrapped_up or reply_limit
          or (status = 'failed' and error in ('too_many_tool_calls', 'budget_exceeded', ${STUCK_ERROR}))
        group by 1, 2
      union all
      select (m.created_at at time zone 'UTC')::date, m.org_id, 'limitStops', count(*) from messages m
        join orgs o on o.id = m.org_id
        where m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
          and m.author_type = 'agent' and (m.meta->'actionCard'->>'kind' = 'stretch_paused' or m.meta ? 'missionStuck')
        group by 1, 2
      union all
      select day, org_id, 'mentionNoRun', count(*) from mentions where not reached and not referenced and not held
        group by 1, 2
      union all
      select m.day, m.org_id, 'handoffUnanswered', count(*) from mentions m
        where m.reached and not exists (select 1 from messages a where ${SAME_CONVERSATION} and ${SPOKE}
          and a.author_agent_id = m.agent_id and a.created_at > m.created_at
          and a.created_at <= m.created_at + ${ANSWER_WITHIN.handoff}::interval)
          and not ${wokeQuiet("w.trigger_message_id = m.id and w.agent_id = m.agent_id")}
        group by 1, 2
      union all
      select (m.created_at at time zone 'UTC')::date, m.org_id, 'handoffUnanswered', count(*) from messages m
        join orgs o on o.id = m.org_id
        where m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
          and m.author_type = 'agent' and m.deleted_at is null and m.meta ? 'agentNote'
          -- A note that carries its consultation row is counted with the questions below.
          and not (m.meta ? 'consultation')
          and not exists (select 1 from messages a where a.org_id = m.org_id and a.channel_id = m.channel_id
            and ${SPOKE} and a.author_agent_id is distinct from m.author_agent_id and a.created_at > m.created_at
            and a.created_at <= m.created_at + ${ANSWER_WITHIN.handoff}::interval)
          and not ${wokeQuiet("w.trigger_message_id = m.id")}
        group by 1, 2
      union all
      select (q.created_at at time zone 'UTC')::date, q.org_id, 'handoffUnanswered', count(*)
        from agent_consultations q
        join orgs o on o.id = q.org_id
        where q.created_at >= ${start}::timestamptz and q.created_at < ${end}::timestamptz
          -- Closing stamps answered_at whatever the outcome: an expired or failed question has one too.
          and (q.status <> 'answered' or q.answered_at > q.created_at + ${ANSWER_WITHIN.handoff}::interval)
          and not ${wokeQuiet("w.id = q.target_run_id")}
        group by 1, 2
      union all
      select m.day, m.org_id, 'personUnanswered', count(*) from people m
        where m.meant and not exists (select 1 from messages a where ${SAME_CONVERSATION} and ${SPOKE}
          and (m.targets is null or a.author_agent_id = any(m.targets))
          and a.created_at > m.created_at and a.created_at <= m.created_at + ${ANSWER_WITHIN.person}::interval)
          and not ${wokeQuiet("w.trigger_message_id = m.id and (m.targets is null or w.agent_id = any(m.targets))")}
        group by 1, 2
      union all
      select (t.created_at at time zone 'UTC')::date, t.org_id, 'taskStartFailed', count(*) from machine_tasks t
        join orgs o on o.id = t.org_id
        where t.created_at >= ${start}::timestamptz and t.created_at < ${end}::timestamptz and t.status = 'failed'
          and coalesce(t.seconds, extract(epoch from coalesce(t.ended_at, t.updated_at) - coalesce(t.started_at, t.created_at)))
            < ${TASK_START_SECONDS}
        group by 1, 2
      union all
      select day, org_id, 'quietRuns', count(*) from noise where quiet group by 1, 2
      union all
      select day, org_id, 'ackReplies', count(*) from noise where ack group by 1, 2
      union all
      select day, org_id, 'idleWakes', count(*) from noise where idle group by 1, 2
      union all
      select day, org_id, 'noiseRuns', count(*) from noise_runs group by 1, 2
      union all
      select n.day, n.org_id, 'noiseTokens',
          sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens)
        from noise_runs n join usage_records u on u.org_id = n.org_id and u.run_id = n.id
        where u.created_at >= ${start}::timestamptz and u.created_at < ${end}::timestamptz + interval '1 day'
        group by 1, 2
      union all
      select n.day, n.org_id, 'noiseCostNanoUsd', sum(u.cost_nano_usd)
        from noise_runs n join usage_records u on u.org_id = n.org_id and u.run_id = n.id
        where u.created_at >= ${start}::timestamptz and u.created_at < ${end}::timestamptz + interval '1 day'
        group by 1, 2
    )
    select x.day::text as day, x.org_id, o.name as org_name, x.metric, sum(x.n) as n
    from counts x join orgs o on o.id = x.org_id
    group by 1, 2, 3, 4`;
}

const emptyCounts = (): AutonomyCounts =>
  Object.fromEntries(
    [...AUTONOMY_STALLS, ...AUTONOMY_NOISE, ...AUTONOMY_UNTRIED, "stalls"].map((k) => [k, 0]),
  ) as AutonomyCounts;

const stallsOf = (c: Record<AutonomyMetric, number>) =>
  AUTONOMY_STALLS.reduce((sum, k) => (k === "promiseIgnored" ? sum : sum + c[k]), 0);

/** One day's report: its workspaces (most stalls first), their total, and the daily average of the 7 days before. */
export interface AutonomyReport {
  day: string;
  workspaces: AutonomyRow[];
  total: AutonomyCounts;
  average: AutonomyCounts;
}

export async function autonomyReport(
  db: Executor,
  input: { day: string; orgId?: string | null; router?: boolean },
): Promise<AutonomyReport> {
  const first = isoDay(new Date(Date.parse(`${input.day}T00:00:00Z`) - 7 * DAY_MS));
  const rows = await autonomyRows(db, { from: first, days: 8, orgId: input.orgId, router: input.router });
  const sum = (list: AutonomyRow[], divisor = 1) => {
    const out = emptyCounts();
    for (const r of list) for (const k of Object.keys(out) as (keyof AutonomyCounts)[]) out[k] += r[k] / divisor;
    return out;
  };
  const workspaces = rows
    .filter((r) => r.day === input.day)
    .sort((a, b) => b.stalls - a.stalls || b.noiseRuns - a.noiseRuns || a.orgName.localeCompare(b.orgName));
  return {
    day: input.day,
    workspaces,
    total: sum(workspaces),
    average: sum(
      rows.filter((r) => r.day !== input.day),
      7,
    ),
  };
}

/** The headers of the operators' table, and what each column counts. */
const COLUMNS: { key: keyof AutonomyCounts; head: string; means: string }[] = [
  { key: "stalls", head: "stalls", means: "the stall columns added up (ignored is part of promise)" },
  { key: "mentionNoRun", head: "mention", means: "agent @mentions of agents that started no run" },
  { key: "readOnly", head: "readonly", means: "runs kept from their tools for who was behind them, or refused one" },
  { key: "promiseUnkept", head: "promise", means: "runs the follow-through judge found ending on work undone" },
  { key: "promiseIgnored", head: "ignored", means: "...that did nothing after being told to do it" },
  { key: "handoffUnanswered", head: "handoff", means: "notes, questions and @mentions unanswered in 30 min" },
  {
    key: "limitStops",
    head: "limit",
    means: "runs at or near the step limit, stuck, out of budget; stretches, stuck missions paused",
  },
  { key: "personUnanswered", head: "person", means: "people's messages for agents unanswered in 10 min" },
  { key: "taskStartFailed", head: "task", means: 'background tasks failed in their first minute ("Not logged in")' },
  {
    key: "untriedNudged",
    head: "untried",
    means: "runs told to keep trying after saying they couldn't with ways left",
  },
  { key: "untriedResolved", head: "tried", means: "...that acted after it and ended done" },
  { key: "noiseRuns", head: "noise", means: "runs in any noise column, once each" },
  { key: "quietRuns", head: "quiet", means: "runs that ended without a message (pass)" },
  { key: "ackReplies", head: "ack", means: "replies to only a thanks, an ok or a sign-off" },
  { key: "idleWakes", head: "idle", means: "runs an agent's @mention woke that did nothing" },
  { key: "noiseTokens", head: "tokens", means: "tokens of the noise runs" },
  { key: "noiseCostNanoUsd", head: "cost", means: "their cost (a plan's runs cost nothing here)" },
];

const usd = (nano: number) => `$${nanoUsdToUsd(nano).toFixed(2)}`;
const cell = (key: keyof AutonomyCounts, n: number) =>
  key === "noiseCostNanoUsd" ? usd(n) : Number.isInteger(n) ? String(n) : n.toFixed(1);

/** The report as a plain-text table for operators (`bun run report:autonomy`). */
export function autonomyTable(report: AutonomyReport): string {
  const NAME = 28;
  const lines: [string, AutonomyCounts][] = [
    ...report.workspaces.map((w): [string, AutonomyCounts] => [w.orgName, w]),
    ["TOTAL", report.total],
    ["7-day average", report.average],
  ];
  const width = (c: (typeof COLUMNS)[number]) =>
    Math.max(c.head.length, ...lines.map(([, counts]) => cell(c.key, counts[c.key]).length));
  const row = (name: string, values: string[]) =>
    [
      name.slice(0, NAME).padEnd(NAME),
      ...values.map((v, i) => v.padStart(width(COLUMNS[i] as (typeof COLUMNS)[number]))),
    ].join("  ");
  return [
    `Stalls and noise on ${report.day} (UTC), ${report.workspaces.length} workspaces with any`,
    "",
    row(
      "workspace",
      COLUMNS.map((c) => c.head),
    ),
    ...lines.map(([name, counts]) =>
      row(
        name,
        COLUMNS.map((c) => cell(c.key, counts[c.key])),
      ),
    ),
    "",
    ...COLUMNS.map((c) => `${c.head.padEnd(9)} ${c.means}`),
  ].join("\n");
}

/**
 * Queues yesterday's report (UTC), due an hour after the day ended so its last messages had their whole answer
 * window. Once per day: the outbox's dedupe key holds across replicas and restarts.
 */
export async function enqueueAutonomyReport(db: Executor, ops: { to: string[]; publicUrl: string }, now = new Date()) {
  const today = Date.parse(`${isoDay(now)}T00:00:00Z`);
  const day = isoDay(new Date(today - DAY_MS));
  await enqueue(db, {
    orgId: null,
    kind: AUTONOMY_REPORT_JOB,
    payload: { day, to: ops.to, url: ops.publicUrl },
    dedupeKey: `${AUTONOMY_REPORT_JOB}:${day}`,
    runAt: new Date(today + REPORT_DELAY_MS),
    maxAttempts: 4,
  });
}

/** How many workspaces each list of the email names. */
const TOP = 5;

/**
 * Job `ops.autonomy_report`: one day's report as an email (`email.send`) to the operators, in each one's language
 * when the address has an account here (else English). Workspace names and counts only.
 */
export async function queueAutonomyEmail(db: Executor, payload: Record<string, unknown>, options: { router: boolean }) {
  const day = String(payload.day);
  const to = Array.isArray(payload.to) ? payload.to.map(String) : [];
  if (to.length === 0) return;
  const report = await autonomyReport(db, { day, router: options.router });
  const top = (key: "stalls" | "noiseRuns") =>
    [...report.workspaces]
      .filter((w) => w[key] > 0)
      .sort((a, b) => b[key] - a[key] || a.orgName.localeCompare(b.orgName))
      .slice(0, TOP);
  const accounts = await db
    .select({ email: schema.users.email, locale: schema.users.locale })
    .from(schema.users)
    .where(
      inArray(
        schema.users.email,
        to.map((a) => a.toLowerCase()),
      ),
    );
  const localeOf = new Map(accounts.map((a) => [a.email, emailLocale(a.locale)]));
  const counts = (metrics: readonly AutonomyMetric[]) =>
    metrics.map((metric) => ({ metric, today: report.total[metric], average: report.average[metric] }));
  for (const group of emailsByLocale(
    to.map((email) => ({ email, locale: localeOf.get(email.toLowerCase()) ?? "en" })),
    `ops-autonomy:${day}`,
  )) {
    await queueEmail(db, {
      orgId: null,
      key: group.key,
      to: group.to,
      template: {
        kind: "autonomy_report",
        locale: group.locale,
        day,
        totalStalls: report.total.stalls,
        stalls: counts(AUTONOMY_STALLS),
        noise: counts(AUTONOMY_NOISE),
        topStalls: top("stalls").map((w) => ({ name: w.orgName, count: w.stalls })),
        topNoise: top("noiseRuns").map((w) => ({
          name: w.orgName,
          count: w.noiseRuns,
          costNanoUsd: w.noiseCostNanoUsd,
        })),
        url: String(payload.url ?? ""),
      },
    });
  }
}
