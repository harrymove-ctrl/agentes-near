import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gte, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { listApprovals } from "./approvals";
import { canTalkTo, speakerFor } from "./audience";
import { editContextItem, howToSql } from "./context/items";
import { LEARN_DEFAULTS } from "./context/learn";
import { NO_CHANNEL_REASON, OVER_BUDGET_REASON, proposeSettings } from "./context/proposals";
import { openPersonAgentDm } from "./dms";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import { cutText } from "./format";
import { commentIssue } from "./issues";
import { getMessage, insertMessage, messageView, postPersonMessage } from "./messages";
import { enqueue } from "./outbox";
import { maySql } from "./permissions";
import { pushLocale, pushStrings } from "./push-messages";
import { isRightHand } from "./right-hand";
import { createRoutine, type RoutineDeps } from "./routines";
import { localDate, nextOccurrence, type ScheduleRule } from "./rrule";
import { closedRefusal, openOrg, orgStanding } from "./standing";
import { taskSeenSql } from "./task-access";

/**
 * "Semana da equipe" (ADR 0137 §9): once a week Lodi posts one card in each admin's DM with it, from what the server
 * already stores (runs, approvals, budgets, channels, unanswered questions, requests repeated by hand, stalled steps),
 * with no model call. Each row is a fix applied as whoever clicks, through the paths the other cards use: a settings
 * proposal (budget, a channel), the approvals list, a routine, a message to Lodi or to a task's conversation.
 */

const { agents, contextItems, contextProposals, organizationMembers, organizationSettings } = schema;

export const TEAM_WEEK_JOB = "team_week.post";
export const TEAM_WEEK_CARD = "team_week";
/** The tool through which a person tells Lodi to stop the card or move it. */
export const SET_TEAM_WEEK_TOOL = "set_team_week";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** A slot missed for longer (the server was down) waits for the next week: a Friday card on Sunday is noise. */
const POST_WINDOW_MS = 6 * HOUR_MS;
/** Steps of a task that moved for this long are stalled. */
const STALL_MS = 4 * HOUR_MS;
/** A request typed by hand on this many days of the week is a routine waiting to be made. */
const REPEAT_DAYS = 3;
/** Questions left unanswered in one channel before it is worth an agent. */
const UNANSWERED_MIN = 3;
const MAX_ROWS = 6;
const NANO = 1_000_000_000;

export interface TeamWeekPrefs {
  off: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  day: number;
  /** 0–23, in the workspace's time zone. */
  hour: number;
  /**
   * "Resumo do dia": the same card every day at `hour`, over the last day, in place of the week's. Anyone may turn it
   * on (the week's is for admins); off by default.
   */
  daily: boolean;
}

export const TEAM_WEEK_DEFAULTS: TeamWeekPrefs = { off: false, day: 5, hour: 17, daily: false };

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

const whole = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** A person's stored choice, whatever it holds, with the defaults for what it lacks. */
export function teamWeekPrefsOf(raw: unknown): TeamWeekPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    off: r.off === true,
    day: whole(r.day, 0, 6) ?? TEAM_WEEK_DEFAULTS.day,
    hour: whole(r.hour, 0, 23) ?? TEAM_WEEK_DEFAULTS.hour,
    daily: r.daily === true,
  };
}

/** What the card looks back on: a day for "Resumo do dia", else a week. */
export const teamWeekSpan = (prefs: Pick<TeamWeekPrefs, "daily">) => (prefs.daily ? DAY_MS : WEEK_MS);

/** The latest slot at or before `now` within one span (a day or a week), in the workspace's time zone. */
export function lastTeamWeekSlot(prefs: TeamWeekPrefs, timezone: string, now: Date): Date | null {
  const times = [`${String(prefs.hour).padStart(2, "0")}:00`];
  const rule: ScheduleRule = prefs.daily
    ? { freq: "daily", times, timezone }
    : { freq: "weekly", byWeekday: [WEEKDAYS[prefs.day] as string], times, timezone };
  const at = nextOccurrence(rule, new Date(now.getTime() - teamWeekSpan(prefs)));
  return at && at.getTime() <= now.getTime() ? at : null;
}

const localHour = (at: Date, timezone: string) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(at));

/** The Monday of the local week `at` falls in: one card per person per week, whatever day they move it to. */
export function weekKey(at: Date, timezone: string) {
  const day = new Date(`${localDate(at, timezone)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

// --- The card ------------------------------------------------------------------------------------------------

export type TeamWeekRow =
  /** Approvals of one agent waiting for this person: "Ver e aprovar" opens them on the card. */
  | { id: string; kind: "approvals"; agentId: string; approvalIds: string[]; since: string }
  /** It stopped at its monthly budget: a settings proposal to raise it, applied with Undo. */
  | { id: string; kind: "budget"; agentId: string; proposalId: string; stops: number; from: number; to: number }
  /** In no channel, so nobody talked to it: a settings proposal to add it to one. */
  | { id: string; kind: "channel"; agentId: string; proposalId: string; channelId: string }
  /** People's questions nobody answered in a channel: Lodi is asked for an agent for them. */
  | { id: string; kind: "unanswered"; channelId: string; count: number }
  /** The same request typed on several days: a daily routine at the hour it was asked. */
  | {
      id: string;
      kind: "routine";
      agentId: string;
      /** Where it was asked: a channel, or the person's DM with the agent (`dm`). */
      channelId: string;
      dm: boolean;
      text: string;
      count: number;
      hour: number;
    }
  /**
   * A how-to of the person's own agent reused past the bar that no person vouched for yet (ADR 0167): "Virar skill?"
   * confirms it (`editContextItem` confirmed), and the day's pass makes it a skill.
   */
  | { id: string; kind: "howto"; agentId: string; itemId: string; title: string; uses: number }
  /** Steps of a task waiting on another step for hours: its agent is told to go on with them in parallel. */
  | {
      id: string;
      kind: "stalled";
      issueId: string;
      number: number;
      title: string;
      steps: number[];
      onNumber: number;
      hours: number;
      agentId: string | null;
    };

export type TeamWeekHighlight =
  | { kind: "runs"; agentId: string; channelId: string; count: number }
  | { kind: "tasks"; agentId: string; count: number };

export interface TeamWeekCard {
  kind: typeof TEAM_WEEK_CARD;
  forUserId: string;
  /** "Resumo do dia" (`day`) or the week's (absent on cards from before it). */
  period?: "day" | "week";
  /** The week's first and last day, `YYYY-MM-DD` in the workspace's time zone. */
  from: string;
  to: string;
  timezone: string;
  stats: { done: number; stuck: number; waiting: number; spentNanoUsd: number; budgetNanoUsd: number };
  worked: TeamWeekHighlight[];
  rows: TeamWeekRow[];
  /** The settings proposals on its rows: their receipts (Undo) live on this message. */
  proposalIds: string[];
  /** Rows applied here (the routine made, the message sent), by row id. */
  done: Record<string, { byUserId: string; at: string; routineId?: string }>;
  /** "Agora não". */
  dismissedAt: string | null;
}

export function teamWeekCardOf(meta: Record<string, unknown> | null | undefined): TeamWeekCard | null {
  const c = meta?.actionCard as Partial<TeamWeekCard> | undefined;
  return c?.kind === TEAM_WEEK_CARD && typeof c.forUserId === "string" && Array.isArray(c.rows)
    ? (c as TeamWeekCard)
    : null;
}

interface Window {
  orgId: string;
  userId: string;
  rightHandId: string;
  start: Date;
  end: Date;
  timezone: string;
  /**
   * An administrator's card counts the whole team's runs and the workspace's spend; anyone else's only runs where they
   * read and no money (absent: an administrator's).
   */
  admin?: boolean;
}

/** Lowercase words without accents, mentions or punctuation: how two requests are told the same. */
export function requestKey(body: string) {
  const words = body
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/@[\w.-]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  return words.length >= 2 ? words.slice(0, 6).join(" ") : null;
}

/** The week's card for this person, or null when there is nothing to say (or no team yet). */
export async function buildTeamWeek(
  db: Database,
  w: Window,
): Promise<Omit<TeamWeekCard, "done" | "dismissedAt"> | null> {
  const start = w.start.toISOString();
  const end = w.end.toISOString();
  const team = rowsOf<{ id: string; created_at: string | Date; budget: number | string | null }>(
    await db.execute(sql`select id, created_at, monthly_budget_nano_usd as budget from agents
      where org_id = ${w.orgId} and builtin is null and archived_at is null and deleted_at is null`),
  );
  if (team.length === 0) return null;
  const teamIds = new Set(team.map((a) => a.id));
  const [settings] = await db
    .select({ budget: organizationSettings.defaultAgentBudgetNanoUsd })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, w.orgId));
  const defaultBudget = Number(settings?.budget ?? 50 * NANO);
  const [lodi] = await db
    .select({ budget: agents.monthlyBudgetNanoUsd })
    .from(agents)
    .where(eq(agents.id, w.rightHandId));
  const budgetOf = (b: number | string | null | undefined) => (b == null ? defaultBudget : Number(b));
  const visible = sql`(c.visibility = 'public' or exists (select 1 from channel_members vm
    where vm.channel_id = c.id and vm.user_id = ${w.userId})
    or (c.kind = 'channel' and ${maySql(w.orgId, sql`${w.userId}::text`, "administrator")}))`;
  const teamRuns = sql`r.org_id = ${w.orgId} and r.created_at >= ${start}::timestamptz and r.created_at < ${end}::timestamptz
    and r.agent_id in (select id from agents where org_id = ${w.orgId} and builtin is null)`;
  const admin = w.admin !== false;

  const [counts] = rowsOf<{ done: number | string; failed: number | string }>(
    await db.execute(sql`select count(*) filter (where r.status = 'done') as done,
      count(*) filter (where r.status = 'failed') as failed from agent_runs r
      ${admin ? sql`` : sql`join channels c on c.id = r.channel_id`}
      where ${teamRuns} ${admin ? sql`` : sql`and ${visible}`}`),
  );
  const monthStart = new Date(Date.UTC(w.end.getUTCFullYear(), w.end.getUTCMonth(), 1)).toISOString();
  const [spent] = rowsOf<{ n: number | string | null }>(
    await db.execute(sql`select coalesce(sum(cost_nano_usd), 0) as n from usage_records
      where org_id = ${w.orgId} and created_at >= ${monthStart}::timestamptz`),
  );

  // Funcionou: the agents that did the most where this person can read, and tasks agents closed.
  const busiest = rowsOf<{ agent_id: string; channel_id: string; n: number | string }>(
    await db.execute(sql`select r.agent_id, r.channel_id, count(*) as n from agent_runs r
      join channels c on c.id = r.channel_id and c.kind = 'channel' and c.archived_at is null
      where ${teamRuns} and r.status = 'done' and ${visible}
      group by r.agent_id, r.channel_id order by n desc limit 2`),
  );
  const closed = rowsOf<{ agent_id: string; n: number | string }>(
    await db.execute(sql`select assignee_id as agent_id, count(*) as n from issues
      where org_id = ${w.orgId} and status = 'done' and assignee_type = 'agent'
        and updated_at >= ${start}::timestamptz and updated_at < ${end}::timestamptz
        and ${taskSeenSql("issues", sql`${w.userId}::text`)}
      group by assignee_id order by n desc limit 1`),
  );
  const worked: TeamWeekHighlight[] = [
    ...busiest
      .filter((b) => Number(b.n) >= 3)
      .map((b) => ({ kind: "runs" as const, agentId: b.agent_id, channelId: b.channel_id, count: Number(b.n) })),
    ...closed
      .filter((c) => teamIds.has(c.agent_id) && Number(c.n) >= 2)
      .map((c) => ({ kind: "tasks" as const, agentId: c.agent_id, count: Number(c.n) })),
  ];

  const rows: TeamWeekRow[] = [];
  const proposalIds: string[] = [];

  // Waiting for this person: one row per agent, the longest waiting first.
  const waiting = (await listApprovals(db, w.userId, w.orgId, { status: "pending", limit: 200 })).filter(
    (a) => a.canDecide,
  );
  const byAgent = new Map<string, typeof waiting>();
  for (const a of waiting) byAgent.set(a.agentId, [...(byAgent.get(a.agentId) ?? []), a]);
  for (const [agentId, list] of [...byAgent].sort((a, b) => oldest(a[1]).localeCompare(oldest(b[1]))).slice(0, 2))
    rows.push({
      id: `approvals:${agentId}`,
      kind: "approvals",
      agentId,
      approvalIds: list.slice(0, 10).map((a) => a.id),
      since: oldest(list),
    });

  // Stopped at the budget: raise it by half (whole dollars), through the settings card's own proposal. A run at the
  // budget parks (its `budget_wait` note; still waiting: `waitingForBrain`, cleared on resume) rather than failing.
  const stops = rowsOf<{ agent_id: string; n: number | string }>(
    await db.execute(sql`select agent_id, count(distinct run_id) as n from (
        select r.agent_id, r.id::text as run_id from agent_runs r
        where ${teamRuns} and (r.error = 'budget_exceeded' or (r.status = 'waiting_input'
          and r.transcript->'waitingForBrain'->>'code' = 'budget'))
        union all
        select m.author_agent_id, coalesce(m.meta->'usageWait'->>'runId', m.id::text) from messages m
        where m.org_id = ${w.orgId} and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
          and m.meta->>'bodyCode' = 'budget_wait'
          and m.author_agent_id in (select id from agents where org_id = ${w.orgId} and builtin is null)
      ) s group by agent_id order by n desc limit 2`),
  );
  // A budget is the workspace's money: only an administrator's card offers to raise it.
  for (const s of admin ? stops : []) {
    const agent = team.find((a) => a.id === s.agent_id);
    if (!agent) continue;
    const from = budgetOf(agent.budget);
    const to = Math.max(Math.ceil((from * 1.5) / NANO), Math.ceil(from / NANO) + 5) * NANO;
    const id = await settingsProposal(db, w, s.agent_id, "budget", { field: "budget", to });
    if (id) {
      rows.push({
        id: `budget:${s.agent_id}`,
        kind: "budget",
        agentId: s.agent_id,
        proposalId: id,
        stops: Number(s.n),
        from,
        to,
      });
      proposalIds.push(id);
    }
  }

  // In no channel for a day or more: #general (else the oldest public channel).
  const lonely = rowsOf<{ id: string }>(
    await db.execute(sql`select a.id from agents a
      where a.org_id = ${w.orgId} and a.builtin is null and a.archived_at is null and a.deleted_at is null
        and a.created_at < ${new Date(w.end.getTime() - 24 * HOUR_MS).toISOString()}::timestamptz
        and not exists (select 1 from channel_members cm join channels c on c.id = cm.channel_id
          and c.kind = 'channel' and c.archived_at is null and c.deleted_at is null where cm.agent_id = a.id)
      order by a.created_at limit 2`),
  );
  const [home] = lonely.length
    ? rowsOf<{ id: string }>(
        await db.execute(sql`select id from channels where org_id = ${w.orgId} and kind = 'channel'
          and visibility = 'public' and archived_at is null and deleted_at is null
          order by (name = 'general') desc, created_at limit 1`),
      )
    : [];
  const homeId = home?.id;
  for (const a of homeId ? lonely : []) {
    if (!homeId) break;
    const id = await settingsProposal(db, w, a.id, "channel_add", {
      field: "channel_add",
      channelId: homeId,
      to: true,
    });
    if (id) {
      rows.push({ id: `channel:${a.id}`, kind: "channel", agentId: a.id, proposalId: id, channelId: homeId });
      proposalIds.push(id);
    }
  }

  // People's questions nobody answered within a day, where this person can read: the channel with the most.
  const [unanswered] = rowsOf<{ channel_id: string; n: number | string }>(
    await db.execute(sql`select q.channel_id, count(*) as n from messages q
      join channels c on c.id = q.channel_id and c.kind = 'channel' and c.archived_at is null and c.deleted_at is null
      where q.org_id = ${w.orgId} and q.author_type = 'person' and q.deleted_at is null
        and q.created_at >= ${start}::timestamptz
        and q.created_at < ${new Date(w.end.getTime() - 2 * HOUR_MS).toISOString()}::timestamptz
        and position('?' in q.body) > 0 and ${visible}
        and not exists (select 1 from messages a where a.org_id = q.org_id and a.channel_id = q.channel_id
          and a.deleted_at is null and a.created_at > q.created_at and a.created_at < q.created_at + interval '1 day'
          and a.author_user_id is distinct from q.author_user_id
          and ((q.thread_id is null and (a.thread_id = q.id
                or (a.thread_id is null and a.created_at < q.created_at + interval '30 minutes')))
            or (q.thread_id is not null and a.thread_id = q.thread_id)))
      group by q.channel_id having count(*) >= ${UNANSWERED_MIN} order by n desc limit 1`),
  );
  if (unanswered)
    rows.push({
      id: `unanswered:${unanswered.channel_id}`,
      kind: "unanswered",
      channelId: unanswered.channel_id,
      count: Number(unanswered.n),
    });

  const repeat = await repeatedRequest(db, w, teamIds);
  if (repeat) rows.push(repeat);

  const stalled = await stalledSteps(db, w);
  if (stalled) rows.push(stalled);
  rows.push(...(await provenHowTos(db, w)));

  const stats = {
    done: Number(counts?.done ?? 0),
    stuck: Number(counts?.failed ?? 0),
    waiting: waiting.length,
    // The workspace's money is the administrators' to read.
    spentNanoUsd: admin ? Number(spent?.n ?? 0) : 0,
    budgetNanoUsd: admin ? team.reduce((sum, a) => sum + budgetOf(a.budget), budgetOf(lodi?.budget)) : 0,
  };
  if (stats.done === 0 && stats.stuck === 0 && rows.length === 0) return null;
  return {
    kind: TEAM_WEEK_CARD,
    forUserId: w.userId,
    from: localDate(w.start, w.timezone),
    to: localDate(new Date(w.end.getTime() - 1), w.timezone),
    timezone: w.timezone,
    stats,
    worked,
    rows: rows.slice(0, MAX_ROWS),
    proposalIds,
  };
}

const oldest = (list: { createdAt: string }[]) => list.map((a) => a.createdAt).sort()[0] ?? "";

/**
 * A fresh settings proposal by Lodi for this person; null when the line can't be made or this person can't decide it
 * (the card only offers what its reader applies). The same fix still open on an earlier week's card goes stale there:
 * a decision records its receipt (Undo) on the oldest card that lists the proposal, and last week's amount may be
 * outdated. Proposals Lodi made in a conversation stay as they are.
 */
async function settingsProposal(
  db: Database,
  w: Window,
  agentId: string,
  field: "budget" | "channel_add",
  line: { field: typeof field; to: unknown; channelId?: string },
) {
  await db.execute(sql`update context_proposals p set status = 'stale', decided_at = now()
    where p.org_id = ${w.orgId} and p.agent_id = ${agentId} and p.proposed_by_agent_id = ${w.rightHandId}
      and p.requested_by_user_id = ${w.userId} and p.status = 'pending' and p.target = 'agent_settings'
      and p.settings @> ${JSON.stringify([{ field }])}::jsonb
      and exists (select 1 from messages m where m.org_id = p.org_id and m.author_agent_id = p.proposed_by_agent_id
        and m.meta->'actionCard'->>'kind' = ${TEAM_WEEK_CARD}
        and m.meta->'actionCard'->'proposalIds' @> jsonb_build_array(p.id::text))`);
  const { proposals } = await proposeSettings(
    { db },
    {
      orgId: w.orgId,
      agentId: w.rightHandId,
      targets: [{ agentId, lines: [line] }],
      rationale: field === "budget" ? OVER_BUDGET_REASON : NO_CHANNEL_REASON,
      requesterId: w.userId,
    },
  );
  const [p] = proposals;
  if (p && !p.canDecide) {
    // Not on the card: a row nobody sees would only pile up, one a day on a "Resumo do dia".
    await db.delete(contextProposals).where(eq(contextProposals.id, p.id));
    return null;
  }
  return p?.id ?? null;
}

/** The same request this person typed to one agent on `REPEAT_DAYS` days or more, with no routine doing it. */
async function repeatedRequest(db: Database, w: Window, teamIds: Set<string>): Promise<TeamWeekRow | null> {
  const sent = rowsOf<{
    body: string;
    created_at: string | Date;
    channel_id: string;
    kind: string;
    dm_key: string | null;
    mentioned: string[] | string | null;
  }>(
    await db.execute(sql`select m.body, m.created_at, m.channel_id, c.kind, c.dm_key, m.mentioned_agent_ids as mentioned
      from messages m join channels c on c.id = m.channel_id
      where m.org_id = ${w.orgId} and m.author_user_id = ${w.userId} and m.deleted_at is null and m.thread_id is null
        and m.created_at >= ${w.start.toISOString()}::timestamptz and m.created_at < ${w.end.toISOString()}::timestamptz
        and c.archived_at is null and (c.kind = 'dm' or (c.kind = 'channel' and cardinality(m.mentioned_agent_ids) = 1))
      order by m.created_at desc limit 500`),
  );
  const groups = new Map<
    string,
    { agentId: string; channelId: string; dm: boolean; text: string; days: Set<string>; hours: number[] }
  >();
  for (const m of sent) {
    const mentioned = typeof m.mentioned === "string" ? m.mentioned.replace(/[{}]/g, "").split(",") : m.mentioned;
    const agentId =
      m.kind === "dm"
        ? (m.dm_key
            ?.split("|")
            .find((p) => p.startsWith("a:"))
            ?.slice(2) ?? null)
        : (mentioned?.[0] ?? null);
    if (!agentId || !teamIds.has(agentId) || (m.kind === "dm" && !m.dm_key?.includes(`u:${w.userId}`))) continue;
    const key = requestKey(m.body);
    if (!key) continue;
    const at = new Date(m.created_at);
    const id = `${agentId}|${m.channel_id}|${key}`;
    const g = groups.get(id) ?? {
      agentId,
      channelId: m.channel_id,
      dm: m.kind === "dm",
      // Newest first: the latest wording.
      text: m.body.replace(/\s+/g, " ").trim().slice(0, 300),
      days: new Set<string>(),
      hours: [],
    };
    g.days.add(localDate(at, w.timezone));
    g.hours.push(localHour(at, w.timezone));
    groups.set(id, g);
  }
  const best = [...groups.values()]
    .filter((g) => g.days.size >= REPEAT_DAYS)
    .sort((a, b) => b.days.size - a.days.size)[0];
  if (!best) return null;
  const made = rowsOf<{ prompt: string }>(
    await db.execute(sql`select prompt from routines where org_id = ${w.orgId} and agent_id = ${best.agentId}`),
  );
  const key = requestKey(best.text);
  if (made.some((r) => requestKey(r.prompt) === key)) return null;
  return {
    id: `routine:${best.agentId}:${best.channelId}`,
    kind: "routine",
    agentId: best.agentId,
    channelId: best.channelId,
    dm: best.dm,
    text: best.text,
    count: best.days.size,
    hour: mode(best.hours),
  };
}

const mode = (list: number[]) => {
  const n = new Map<number, number>();
  for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 9;
};

/**
 * A task whose steps wait for hours while another step is in progress or in review (a reviewer rejecting step 1
 * while steps 2 to 4 wait on it): the one stalled the longest.
 */
async function stalledSteps(db: Database, w: Window): Promise<TeamWeekRow | null> {
  const [s] = rowsOf<{
    id: string;
    number: number;
    title: string;
    assignee_type: string | null;
    assignee_id: string | null;
    steps: number[] | string;
    on_number: number | null;
    on_agent: string | null;
    moved: string | Date;
  }>(
    await db.execute(sql`select p.id, p.number, p.title, p.assignee_type, p.assignee_id,
        array_agg(s.number order by s.number) filter (where s.status = 'todo') as steps,
        (array_agg(s.number order by s.number) filter (where s.status in ('in_progress', 'in_review') or s.blocked is not null))[1] as on_number,
        (array_agg(s.assignee_id order by s.number) filter (where s.assignee_type = 'agent' and (s.status in ('in_progress', 'in_review') or s.blocked is not null)))[1] as on_agent,
        max(s.updated_at) as moved
      from issues p join issues s on s.parent_issue_id = p.id and s.org_id = p.org_id
        and ${taskSeenSql("s", sql`${w.userId}::text`)}
      where p.org_id = ${w.orgId} and p.status not in ('done', 'canceled')
        and ${taskSeenSql("p", sql`${w.userId}::text`)}
      group by p.id
      having count(*) filter (where s.status = 'todo') >= 2
        and count(*) filter (where s.status in ('in_progress', 'in_review') or s.blocked is not null) >= 1
        and max(s.updated_at) < ${new Date(w.end.getTime() - STALL_MS).toISOString()}::timestamptz
      order by max(s.updated_at) limit 1`),
  );
  if (!s || s.on_number == null) return null;
  const steps = typeof s.steps === "string" ? s.steps.replace(/[{}]/g, "").split(",").map(Number) : s.steps;
  return {
    id: `stalled:${s.id}`,
    kind: "stalled",
    issueId: s.id,
    number: s.number,
    title: s.title.slice(0, 120),
    steps,
    onNumber: s.on_number,
    hours: Math.floor((w.end.getTime() - new Date(s.moved).getTime()) / HOUR_MS),
    agentId: s.assignee_type === "agent" ? s.assignee_id : s.on_agent,
  };
}

/** How many proven how-tos one card offers to make skills, at most. */
const HOWTOS_SHOWN = 3;

/**
 * The person's own agents' how-tos reused at least `LEARN_DEFAULTS.skillAfter` times that are still untrusted, so the
 * day's pass can't make them skills (ADR 0167), the most reused first.
 */
async function provenHowTos(db: Database, w: Window): Promise<TeamWeekRow[]> {
  const rows = await db
    .select({
      id: contextItems.id,
      agentId: contextItems.agentId,
      title: contextItems.title,
      content: contextItems.content,
      uses: contextItems.recurrence,
    })
    .from(contextItems)
    .innerJoin(agents, eq(agents.id, contextItems.agentId))
    .where(
      and(
        eq(contextItems.orgId, w.orgId),
        eq(agents.ownerUserId, w.userId),
        isNull(agents.archivedAt),
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        howToSql(),
        eq(contextItems.trust, "low"),
        eq(contextItems.disputed, false),
        gte(contextItems.recurrence, LEARN_DEFAULTS.skillAfter),
      ),
    )
    .orderBy(desc(contextItems.recurrence))
    .limit(HOWTOS_SHOWN);
  return rows.map((r) => ({
    id: `howto:${r.id}`,
    kind: "howto" as const,
    agentId: r.agentId ?? "",
    itemId: r.id,
    title: cutText(r.title || r.content, 120),
    uses: r.uses,
  }));
}

// --- When it goes out ------------------------------------------------------------------------------------------

/**
 * Queues the card of every admin whose slot just passed (dedupe: one per person and week), in workspaces with a team
 * and Lodi, open. Returns how many slots were due.
 */
export async function enqueueTeamWeeks(db: Database, now = new Date()) {
  const due = rowsOf<{ org_id: string; user_id: string; team_week: unknown; tz: string | null }>(
    await db.execute(sql`select m.org_id, m.user_id, m.team_week, s.timezone as tz
      from organization_members m
      join organizations on organizations.id = m.org_id and ${openOrg}
      left join organization_settings s on s.org_id = m.org_id
      where coalesce(m.team_week->>'off', 'false') <> 'true'
        and exists (select 1 from agents a where a.org_id = m.org_id and a.builtin is null
          and a.archived_at is null and a.deleted_at is null)
        and exists (select 1 from agents a where a.org_id = m.org_id and a.builtin = 'right_hand')
        and (coalesce(m.team_week->>'daily', 'false') = 'true'
          or ${maySql(sql`m.org_id`, sql`m.user_id`, "administrator")})`),
  );
  let n = 0;
  for (const d of due) {
    const timezone = d.tz || "UTC";
    const prefs = teamWeekPrefsOf(d.team_week);
    const slot = lastTeamWeekSlot(prefs, timezone, now);
    if (!slot || now.getTime() - slot.getTime() > POST_WINDOW_MS) continue;
    n++;
    await enqueue(db, {
      orgId: d.org_id,
      kind: TEAM_WEEK_JOB,
      payload: { userId: d.user_id, slot: slot.toISOString() },
      dedupeKey: `${TEAM_WEEK_JOB}:${d.org_id}:${d.user_id}:${prefs.daily ? `day:${localDate(slot, timezone)}` : weekKey(slot, timezone)}`,
      maxAttempts: 4,
    });
  }
  return n;
}

/**
 * The job: builds this person's card and posts it in their DM with Lodi. Returns the message id, or null (none in a
 * workspace closed to changes since it was queued).
 */
export async function postTeamWeek(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  payload: { userId?: unknown; slot?: unknown },
) {
  const { db } = deps;
  const userId = typeof payload.userId === "string" ? payload.userId : null;
  const slot = typeof payload.slot === "string" ? new Date(payload.slot) : null;
  if (!userId || !slot || Number.isNaN(slot.getTime())) return null;
  if (closedRefusal(await orgStanding(db, orgId))) return null;
  const [member] = rowsOf<{
    team_week: unknown;
    admin: boolean;
    tz: string | null;
    locale: string | null;
    mode: string | null;
  }>(
    await db.execute(sql`select m.team_week, ${maySql(sql`m.org_id`, sql`m.user_id`, "administrator")} as admin,
        s.timezone as tz, u.locale, s.mode
      from organization_members m left join organization_settings s on s.org_id = m.org_id
      join users u on u.id = m.user_id
      where m.org_id = ${orgId} and m.user_id = ${userId}`),
  );
  const prefs = teamWeekPrefsOf(member?.team_week);
  if (!member || prefs.off || (!member.admin && !prefs.daily)) return null;
  const [lodi] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.builtin, "right_hand"), isNull(agents.archivedAt)));
  if (!lodi || !isRightHand(lodi) || !canTalkTo(lodi, userId, await speakerFor(db, orgId, userId))) return null;
  const timezone = member.tz || "UTC";
  const start = new Date(slot.getTime() - teamWeekSpan(prefs));
  const period = prefs.daily ? "day" : "week";
  const posted = async (tx: Executor) =>
    rowsOf<{ id: string }>(
      await tx.execute(sql`select id from messages where org_id = ${orgId} and author_agent_id = ${lodi.id}
        and meta->'actionCard'->>'kind' = ${TEAM_WEEK_CARD} and meta->'actionCard'->>'forUserId' = ${userId}
        and meta->'actionCard'->>'from' = ${localDate(start, timezone)}
        and coalesce(meta->'actionCard'->>'period', 'week') = ${period} limit 1`),
    ).length > 0;
  // A retry after the card went out builds nothing: building again would stale the proposals that card shows.
  if (await posted(db)) return null;
  const built = await buildTeamWeek(db, {
    orgId,
    userId,
    rightHandId: lodi.id,
    start,
    end: slot,
    timezone,
    admin: member.admin,
  });
  if (!built) return null;
  const card: TeamWeekCard = { ...built, period, done: {}, dismissedAt: null };
  // A personal workspace's week is the person's own with their agents (ADR 0159), not a team's.
  const week = member.mode === "personal" ? "teamWeekReadyPersonal" : "teamWeekReady";
  const message = await db.transaction(async (tx) => {
    const dm = await openPersonAgentDm(tx, orgId, userId, lodi.id);
    if (await posted(tx)) return null;
    const m = await insertMessage(tx, {
      orgId,
      channelId: dm.id,
      author: { type: "agent", agentId: lodi.id, runId: null, hop: 1, stretchId: null },
      // Only this person reads it: the push and the conversation list say it in their language.
      body: pushStrings(pushLocale(member.locale))[prefs.daily ? "teamDayReady" : week],
      meta: {
        bodyCode: TEAM_WEEK_CARD,
        bodyParams: { from: card.from, to: card.to, ...(prefs.daily ? { period: "day" } : {}) },
        actionCard: card,
      },
    });
    await enqueue(tx, {
      orgId,
      kind: "notifications.message",
      payload: { messageId: m.id },
      dedupeKey: `notifications.message:${m.id}`,
      maxAttempts: 4,
    });
    return m;
  });
  if (message && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message?.id ?? null;
}

// --- What a person does with it --------------------------------------------------------------------------------

/** This person's choice, with the workspace's time zone it is read in. */
export async function getTeamWeekPrefs(db: Executor, orgId: string, userId: string) {
  const [row] = await db
    .select({ teamWeek: organizationMembers.teamWeek, tz: organizationSettings.timezone })
    .from(organizationMembers)
    .leftJoin(organizationSettings, eq(organizationSettings.orgId, organizationMembers.orgId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  if (!row) throw new NotFoundError("Not a member of this workspace");
  return { ...teamWeekPrefsOf(row.teamWeek), timezone: row.tz ?? "UTC" };
}

/** Stops the card, starts it again or moves its day and hour, for this person only. */
export async function setTeamWeekPrefs(db: Executor, orgId: string, userId: string, patch: Partial<TeamWeekPrefs>) {
  const now = await getTeamWeekPrefs(db, orgId, userId);
  const next = teamWeekPrefsOf({ ...now, ...patch });
  await db
    .update(organizationMembers)
    .set({ teamWeek: { off: next.off, day: next.day, hour: next.hour, daily: next.daily } })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return { ...next, timezone: now.timezone };
}

/**
 * A row applied from the card as `actorId` (only the person it is for: it lives in their DM), or "Agora não"
 * (`dismiss`). Settings and approvals rows go through their own paths; here the routine is made, Lodi is asked for an
 * agent, or the task's agent is told to go on (`text`: the person's own words, in their language). Returns the card.
 */
export async function actOnTeamWeek(
  deps: RoutineDeps,
  actorId: string,
  orgId: string,
  messageId: string,
  input: { dismiss: true } | { rowId: string; text?: string },
): Promise<TeamWeekCard> {
  const { db } = deps;
  const message = await getMessage(db, orgId, messageId);
  const card = message ? teamWeekCardOf(message.meta) : null;
  if (!message || !card) throw new NotFoundError("Card not found");
  if (card.forUserId !== actorId) throw new ForbiddenError("This card is someone else's");
  const next: TeamWeekCard = { ...card, done: { ...(card.done ?? {}) } };
  if ("dismiss" in input) next.dismissedAt = new Date().toISOString();
  else {
    const row = card.rows.find((r) => r.id === input.rowId);
    if (!row) throw new NotFoundError("Row not found");
    if (next.done[row.id]) throw new ConflictError("Already done", "team_week.done");
    const text = input.text?.trim().slice(0, 2000) ?? "";
    const done: TeamWeekCard["done"][string] = { byUserId: actorId, at: new Date().toISOString() };
    if (row.kind === "routine") {
      const routine = await createRoutine(deps, actorId, orgId, {
        agentId: row.agentId,
        prompt: row.text,
        name: row.text.slice(0, 60),
        target: row.dm ? { type: "dm" } : { type: "channel", channelId: row.channelId },
        trigger: {
          type: "schedule",
          rule: { freq: "daily", times: [`${String(row.hour).padStart(2, "0")}:00`], timezone: card.timezone },
        },
        report: "always",
      });
      done.routineId = routine.id;
    } else if (row.kind === "unanswered") {
      if (!text) throw new ValidationError("Say what to ask");
      await postPersonMessage({ db, pubsub: deps.pubsub }, actorId, orgId, message.channelId, { body: text });
    } else if (row.kind === "stalled") {
      if (!text) throw new ValidationError("Say what to tell its agent");
      await commentIssue({ db, pubsub: deps.pubsub }, { type: "person", userId: actorId }, orgId, row.issueId, text);
    } else if (row.kind === "howto") {
      // The person vouches for it (ADR 0167): trusted and verified, the day's pass makes it the agent's skill.
      await editContextItem(db, actorId, orgId, row.itemId, { confirmed: true });
    } else throw new ValidationError("This row is applied on its own card", "team_week.own_path");
    next.done[row.id] = done;
  }
  const [updated] = await db
    .update(schema.messages)
    .set({ meta: { ...message.meta, actionCard: next } })
    .where(and(eq(schema.messages.orgId, orgId), eq(schema.messages.id, messageId)))
    .returning();
  if (updated) await publishMessageCreated(deps.pubsub, messageView(updated));
  return next;
}
