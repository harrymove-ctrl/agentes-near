import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  type Executor,
  eq,
  inArray,
  isNull,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { TtlCache } from "./cache";
import { NotFoundError } from "./errors";
import { publishOrgEvent } from "./events";
import { getMachine } from "./machines";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { replyThreadOf } from "./runs";

const { agentRuns, agents, channelMembers, channels, messages } = schema;

/**
 * The line for a shared computer's room (ADR 0032, "Calm waits" and "Calm wakes"). The runner admits a turn only
 * while its memory floor holds and keeps no order, so the engine keeps it, in three ranks: runs a person is waiting
 * on, then agents' work a person asked for lately (`transcript.roomAsked`), then the rest; by when each started
 * waiting within a rank. Only the head of the line asks the runner again, and agents' turns start
 * `ROOM_ASK_SPACING_MS` apart, so a burst of mentions reaches the computer one by one instead of all refused at once.
 */
export const ROOM_ASK_SPACING_MS = 3_000;

/**
 * When a run behind another in line looks again. The line moves by kicks (a turn ended, the spacing is over), so this
 * is only the fallback: polling at the spacing would triple the line's jobs for no earlier start.
 */
export const ROOM_BEHIND_RETRY_MS = 10_000;

/**
 * A run of the last rank waiting this long ranks with work a person asked for, so a steady stream of that work can't
 * keep it in line for good (a run asks for room until it runs).
 */
export const ROOM_RANK_AGE_MS = 10 * 60_000;

const inLine = and(
  eq(agentRuns.status, "waiting_input"),
  sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'busy'`,
);
const waitingForRoom = (machineId: string) => and(eq(agentRuns.waitingMachineId, machineId), inLine);
/**
 * The line as people read it: also the run asking from it (`computerWaitOf`), which the computer may still refuse.
 * Read as gone, its row went away at every ask, and a person's message starts one the moment the apps read the line.
 */
const shownInLine = (machineId: string) =>
  and(eq(agentRuns.waitingMachineId, machineId), or(inLine, eq(agentRuns.status, "running")));
const waitIdSql = sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`;
const peopleSql = sql`coalesce((${agentRuns.transcript}->>'roomPeople')::boolean, false)`;
const askedSql = sql`coalesce((${agentRuns.transcript}->>'roomAsked')::boolean, false)`;
/**
 * Its place in the line: since it started waiting for room, or, a wake that waited outside any run first, since then
 * (`roomOrderSince`). The note after `COMPUTER_QUEUE_NOTE_MS` reads `roomWaitSince` alone.
 */
const sinceSql = sql`coalesce((${agentRuns.transcript}->>'roomOrderSince')::bigint, (${agentRuns.transcript}->>'roomWaitSince')::bigint, 0)`;
/** A run's rank in the line: 0 a person waits on it, 1 work a person asked for lately (or waiting long), 2 the rest. */
const rankSql = (now: number) =>
  sql<number>`(case when ${peopleSql} then 0 when ${askedSql} or ${sinceSql} < ${now - ROOM_RANK_AGE_MS}::bigint then 1 else 2 end)`;
export type RoomRank = 0 | 1 | 2;

/** The run first in line for room on this computer, with the wait its job must carry. */
export async function roomHead(
  db: Database,
  machineId: string,
): Promise<{ id: string; orgId: string; waitId: string | null } | null> {
  const [head] = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      waitId: waitIdSql,
    })
    .from(agentRuns)
    .where(waitingForRoom(machineId))
    .orderBy(rankSql(Date.now()), sinceSql, agentRuns.id)
    .limit(1);
  return head ?? null;
}

/**
 * A person's message went into this run waiting in line: a person waits on it now, so it goes to the front and looks
 * again at once (the same job as a steered message's). The job tells the line's viewers (`line`), after this commits.
 */
export async function frontOfLine(db: Executor, run: { id: string; orgId: string }, messageId: string) {
  const [row] = await db
    .update(agentRuns)
    .set({ transcript: sql`jsonb_set(${agentRuns.transcript}, '{roomPeople}', 'true'::jsonb)` })
    .where(and(eq(agentRuns.id, run.id), inLine))
    .returning({ waitId: waitIdSql, machineId: agentRuns.waitingMachineId });
  if (!row) return;
  await enqueue(db, {
    orgId: run.orgId,
    kind: "agent_run.execute",
    payload: {
      runId: run.id,
      ...(row.waitId ? { wait: row.waitId } : {}),
      ...(row.machineId ? { line: row.machineId } : {}),
    },
    dedupeKey: `agent_run.execute:${run.id}:steer:${messageId}`,
    maxAttempts: 4,
  });
}

/** Asks the head of the line to look again: now (a turn there ended), or `at` (the spacing is over). One job of each per wait. */
export async function kickRoomQueue(db: Database, machineId: string, at?: Date) {
  const head = await roomHead(db, machineId);
  if (!head?.waitId) return;
  await enqueue(db, {
    orgId: head.orgId,
    kind: "agent_run.execute",
    payload: { runId: head.id, wait: head.waitId },
    dedupeKey: `agent_run.execute:${head.id}:room-kick:${head.waitId}:${at ? "spaced" : "freed"}`,
    maxAttempts: 4,
    ...(at ? { runAt: at } : {}),
  });
}

/**
 * Whether this run may send its computer turn now. Null: go (its ask is recorded, and the next in line is asked
 * once the spacing is over). Otherwise it is behind: `retryAt` is when it may look again. Behind when a run waiting
 * for room ranks ahead of it (by rank, then the longest wait), or, for agents' work, when another run asked
 * this computer less than `ROOM_ASK_SPACING_MS` ago. A person's turn never waits for the spacing; the runner's
 * memory floor still decides whether it fits.
 */
export async function roomGate(
  db: Database,
  run: { id: string; orgId: string },
  machineId: string,
  place: { rank: RoomRank; since: number },
): Promise<{ retryAt: number } | null> {
  const now = Date.now();
  const rank = place.rank === 2 && place.since < now - ROOM_RANK_AGE_MS ? 1 : place.rank;
  const behind = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`room:${machineId}`}))`);
    const [ahead] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          waitingForRoom(machineId),
          sql`${agentRuns.id} <> ${run.id}`,
          sql`(${rankSql(now)}, ${sinceSql}, ${agentRuns.id}) < (${rank}::int, ${place.since}::bigint, ${run.id}::uuid)`,
        ),
      )
      .limit(1);
    if (ahead) return { retryAt: now + ROOM_BEHIND_RETRY_MS };
    if (rank > 0) {
      const [last] = await tx
        .select({ at: sql<string>`max((${agentRuns.transcript}->'roomAsk'->>'at')::bigint)` })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, run.orgId),
            eq(agentRuns.status, "running"),
            sql`${agentRuns.id} <> ${run.id}`,
            sql`${agentRuns.transcript}->'roomAsk'->>'machineId' = ${machineId}`,
          ),
        );
      const at = Number(last?.at ?? 0);
      if (now - at < ROOM_ASK_SPACING_MS) return { retryAt: at + ROOM_ASK_SPACING_MS };
    }
    await tx
      .update(agentRuns)
      .set({
        transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{roomAsk}', ${JSON.stringify({ machineId, at: now })}::jsonb)`,
      })
      .where(eq(agentRuns.id, run.id));
    return null;
  });
  if (!behind) await kickRoomQueue(db, machineId, new Date(now + ROOM_ASK_SPACING_MS));
  return behind;
}

/** The computer whose line shows this run: the one it is working on, or the one it waits in line for. */
export function lineMachineOf(run: { transcript: unknown; waitingMachineId: string | null }): string | null {
  const t = run.transcript as { roomAsk?: { machineId?: string }; waitingForBrain?: { code?: string } } | null;
  if (t?.waitingForBrain?.code === "busy" && run.waitingMachineId) return run.waitingMachineId;
  return t?.roomAsk?.machineId ?? null;
}

/** Tells every open app of the workspace that this computer's line changed, so whoever shows it reads it again. */
export async function publishQueueChanged(pubsub: PubSub | undefined, orgId: string, machineId: string) {
  await publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "computer.queue", machineId } });
}

/**
 * What a turn on the computer is for, in structured words and never its content: answering a person, asked by
 * another agent, a routine's run, or long work (ADR 0121). The ids are null when the author is gone.
 */
export type QueuePurpose =
  | { kind: "person"; userId: string | null }
  | { kind: "agent"; agentId: string | null }
  | { kind: "routine" }
  | { kind: "work" };

export interface QueueWhere {
  channelId: string;
  threadId: string | null;
  /** Two agents' private conversation, said only to who may see that work. */
  agents: boolean;
}

/** What the caller may do with a row of the line: everyone reads the line, these depend on who reads it. */
export interface QueueAccess {
  /** It sees this run in the task manager (`seesRunSql`): the row opens it. */
  canOpen: boolean;
  /** It may stop it (who asked, the agent's owner, an admin; the server checks again). */
  canStop: boolean;
}

export interface QueueWorking extends QueueAccess {
  runId: string;
  agentId: string;
  purpose: QueuePurpose;
  where: QueueWhere;
  /** When this turn asked the computer (ISO). */
  startedAt: string;
  /** Its start plus the agent's typical computer turn, never sooner than 30 s from now; null with no basis. */
  estimatedEndAt: string | null;
  /** Past its agent's typical turn: there is no honest end to give (`estimatedEndAt` is null). */
  overdue: boolean;
}

export interface QueueWaiting extends QueueAccess {
  runId: string;
  agentId: string;
  purpose: QueuePurpose;
  where: QueueWhere;
  /** A person waits on it: it goes first. */
  people: boolean;
  /** 1 = next. */
  position: number;
  estimatedStartAt: string | null;
  /** Who it waits for: for the head, the running turn expected to end first; behind it, the agents ahead in line. */
  after: string[];
}

export interface ComputerQueue {
  machineId: string;
  name: string;
  working: QueueWorking[];
  waiting: QueueWaiting[];
}

/**
 * Two agents' private conversation (or a routine's room): `isAgentOnlyDm` for a select. No person is a member, so
 * membership can't say who sees the work there.
 */
const agentsOnlySql = (kind: SQL, dmKey: SQL) =>
  sql<boolean>`(${kind} = 'dm' and ${dmKey} is not null and ${dmKey} not like '%u:%')`;

/**
 * Who sees a run's work, for a select naming its columns: the members of its conversation and, for work no person is
 * a member of (a routine's background run, two agents' private conversation), admins (`manage_agents`) and the agent's
 * owner. Other people's DMs stay theirs. The task manager, a task's steps and the rows of the line read it. Never
 * NULL: an agent with no owner would make it so, and `not` of that drops the run from the hidden counts too.
 */
export const seesRunSql = (
  run: { channelId: SQL; kind: SQL; dmKey: SQL; background: SQL; ownerUserId: SQL },
  userId: string,
  orgId: string,
  manages: boolean,
) => sql<boolean>`coalesce(exists (select 1 from ${channelMembers} cm
    where cm.org_id = ${orgId}::uuid and cm.channel_id = ${run.channelId} and cm.user_id = ${userId})
  or ((${run.background} or ${agentsOnlySql(run.kind, run.dmKey)}) and (${manages} or ${run.ownerUserId} = ${userId})), false)`;

/** A running turn's estimated end is never sooner than this from now: an estimate never reads as "any second". */
export const QUEUE_END_FLOOR_MS = 30_000;
/** How many of an agent's latest finished computer turns its typical duration is read from. */
const TYPICAL_TURNS = 20;

/** Median computer-turn durations (ms): per agent, and the org's as the fallback. */
export interface TypicalTurns {
  byAgent: Record<string, number>;
  org: number | null;
}

/**
 * When each running turn should end and each waiting one start, by simulating the computer's slots: each running
 * turn frees one at its expected end, the line takes them in order (the soonest free slot first), and an agent's turn
 * starts at least `ROOM_ASK_SPACING_MS` after the previous ask. A turn past its typical length (`overdue`) has no end
 * to give, and neither has one with no basis (an agent with no history in an org with none): its slot frees at an
 * unknown time, and so does every turn after it. Pure, for a fixed clock.
 */
export function estimateQueue(
  now: number,
  working: readonly { agentId: string; startedAt: number }[],
  waiting: readonly { agentId: string; people: boolean }[],
  typical: TypicalTurns,
): { ends: (number | null)[]; overdue: boolean[]; starts: (number | null)[]; after: string[][] } {
  const typicalOf = (agentId: string) => typical.byAgent[agentId] ?? typical.org;
  const expected = working.map((w) => {
    const d = typicalOf(w.agentId);
    return d === null ? null : w.startedAt + d;
  });
  const overdue = expected.map((end) => end !== null && end <= now);
  const ends = expected.map((end, i) => (end === null || overdue[i] ? null : Math.max(end, now + QUEUE_END_FLOOR_MS)));
  // Unknown ends go last, the longest running of them first.
  const slots = working.map((w, i) => ({
    agentId: w.agentId,
    end: ends[i] ?? Number.POSITIVE_INFINITY,
    since: w.startedAt,
  }));
  let lastAsk = working.reduce((max, w) => Math.max(max, w.startedAt), Number.NEGATIVE_INFINITY);
  const starts: (number | null)[] = [];
  const after: string[][] = [];
  waiting.forEach((w, i) => {
    after.push(i === 0 ? [] : [...new Set(waiting.slice(0, i).map((a) => a.agentId))]);
    if (slots.length === 0) {
      starts.push(null);
      return;
    }
    slots.sort((a, b) => a.end - b.end || a.since - b.since);
    const slot = slots[0] as (typeof slots)[number];
    if (i === 0) after[0] = [slot.agentId];
    if (!Number.isFinite(slot.end)) {
      starts.push(null);
      slots[0] = { agentId: w.agentId, end: Number.POSITIVE_INFINITY, since: Number.POSITIVE_INFINITY };
      return;
    }
    let start = Math.max(slot.end, now);
    if (!w.people) start = Math.max(start, lastAsk + ROOM_ASK_SPACING_MS);
    lastAsk = start;
    starts.push(start);
    const d = typicalOf(w.agentId);
    slots[0] = { agentId: w.agentId, end: d === null ? Number.POSITIVE_INFINITY : start + d, since: start };
  });
  return { ends, overdue, starts, after };
}

// ponytail: per-process cache, a minute stale at most; the read touches at most 300 finished runs' transcripts.
const typicalCache = new TtlCache<TypicalTurns>(60_000, 1000);

/**
 * The median of each agent's latest `TYPICAL_TURNS` finished computer turns, from its ask (`roomAsk.at`) to the
 * run's end, and the org's median over those, from the last 14 days.
 */
export async function typicalTurns(db: Database, orgId: string): Promise<TypicalTurns> {
  return typicalCache.getOrLoad(orgId, async () => {
    const rows = rowsOf<{ agent_id: string | null; ms: string | number | null }>(
      await db.execute(sql`
        with recent as (
          select agent_id, finished_at, transcript from agent_runs
          where org_id = ${orgId}::uuid and status = 'done' and brain is not null and brain <> 'model'
            and finished_at > now() - interval '14 days'
          order by finished_at desc
          limit 300
        ), turns as (
          select agent_id,
            extract(epoch from finished_at) * 1000 - (transcript->'roomAsk'->>'at')::bigint as ms,
            row_number() over (partition by agent_id order by finished_at desc) as n
          from recent
          where transcript ? 'roomAsk'
        )
        select agent_id, percentile_cont(0.5) within group (order by ms) as ms
        from turns where n <= ${TYPICAL_TURNS} and ms > 0
        group by rollup(agent_id)`),
    );
    const out: TypicalTurns = { byAgent: {}, org: null };
    for (const r of rows) {
      if (r.ms === null) continue;
      if (r.agent_id === null) out.org = Number(r.ms);
      else out.byAgent[r.agent_id] = Number(r.ms);
    }
    return out;
  });
}

const purposeOf = (r: {
  workId: string | null;
  background: boolean;
  authorType: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  viaRoutine: unknown;
}): QueuePurpose =>
  r.workId
    ? { kind: "work" }
    : r.background || (r.authorType === "person" && r.viaRoutine)
      ? { kind: "routine" }
      : r.authorType === "agent"
        ? { kind: "agent", agentId: r.authorAgentId }
        : { kind: "person", userId: r.authorUserId };

/**
 * A computer's line as every member of the workspace sees it: the turns working on it now and the runs waiting for
 * room, in the order the engine admits them (`roomHead`), with estimates. Only the org's own computers.
 */
export async function computerQueue(
  db: Database,
  actorId: string,
  orgId: string,
  machineId: string,
  now = Date.now(),
): Promise<ComputerQueue> {
  const manages = can(await requirePermission(db, actorId, orgId, "read"), "manage_agents");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  const cols = {
    runId: agentRuns.id,
    agentId: agentRuns.agentId,
    channelId: agentRuns.channelId,
    threadRootId: agentRuns.threadRootId,
    triggerMessageId: agentRuns.triggerMessageId,
    workId: agentRuns.workId,
    background: agentRuns.background,
    authorType: messages.authorType,
    authorUserId: messages.authorUserId,
    authorAgentId: messages.authorAgentId,
    viaRoutine: sql<unknown>`${messages.meta}->'routine'`,
    ownerUserId: agents.ownerUserId,
    sees: seesRunSql(
      {
        channelId: sql`${agentRuns.channelId}`,
        kind: sql`${channels.kind}`,
        dmKey: sql`${channels.dmKey}`,
        background: sql`${agentRuns.background}`,
        ownerUserId: sql`${agents.ownerUserId}`,
      },
      actorId,
      orgId,
      manages,
    ),
    agentsOnly: agentsOnlySql(sql`${channels.kind}`, sql`${channels.dmKey}`),
  };
  const trigger = and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId));
  const lineRows = <T extends object>(fields: T) =>
    db
      .select({ ...cols, ...fields })
      .from(agentRuns)
      .innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .leftJoin(channels, eq(channels.id, agentRuns.channelId))
      .leftJoin(messages, trigger);
  const askAt = sql<string>`(${agentRuns.transcript}->'roomAsk'->>'at')::bigint`;
  const [workingRows, waitingRows, typical] = await Promise.all([
    lineRows({ askAt })
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.status, "running"),
          isNull(agentRuns.waitingMachineId),
          sql`${agentRuns.transcript}->'roomAsk'->>'machineId' = ${machineId}`,
        ),
      )
      .orderBy(askAt),
    lineRows({ people: sql<boolean>`${peopleSql}` })
      .where(and(eq(agentRuns.orgId, orgId), shownInLine(machineId)))
      .orderBy(rankSql(now), sinceSql, agentRuns.id),
    typicalTurns(db, orgId),
  ]);
  const working = workingRows.map((r) => ({ ...r, startedAt: Number(r.askAt) }));
  const est = estimateQueue(now, working, waitingRows, typical);
  const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
  const where = (r: {
    channelId: string;
    threadRootId: string;
    triggerMessageId: string;
    sees: boolean;
    agentsOnly: boolean;
  }) => ({
    channelId: r.channelId,
    threadId: replyThreadOf(r),
    agents: r.sees && r.agentsOnly,
  });
  const access = (r: { sees: boolean; ownerUserId: string | null; authorUserId: string | null }) => ({
    canOpen: r.sees,
    canStop: manages || r.ownerUserId === actorId || r.authorUserId === actorId,
  });
  return {
    machineId,
    name: machine.name,
    working: working.map((r, i) => ({
      runId: r.runId,
      agentId: r.agentId,
      purpose: purposeOf(r),
      where: where(r),
      startedAt: new Date(r.startedAt).toISOString(),
      estimatedEndAt: iso(est.ends[i]),
      overdue: est.overdue[i] ?? false,
      ...access(r),
    })),
    waiting: waitingRows.map((r, i) => ({
      runId: r.runId,
      agentId: r.agentId,
      purpose: purposeOf(r),
      where: where(r),
      people: Boolean(r.people),
      position: i + 1,
      estimatedStartAt: iso(est.starts[i]),
      after: est.after[i] ?? [],
      ...access(r),
    })),
  };
}

/** The best rank among this agent's runs in a computer's line, null when none is in line. */
export async function agentLineRank(db: Executor, orgId: string, agentId: string): Promise<RoomRank | null> {
  const [row] = await db
    .select({ rank: sql<number | null>`min(${rankSql(Date.now())})` })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, agentId), inLine));
  return row?.rank == null ? null : (Number(row.rank) as RoomRank);
}

/** For a select naming an agent: its computer has runs waiting for room (it is full, and work queues on it). */
export const computerCrowdedSql = (agentId: SQL) => sql<boolean>`exists (select 1 from ${agentRuns} w
  join ${agents} ca on ca.machine_id = w.waiting_machine_id
  where ca.id = ${agentId} and w.status = 'waiting_input' and w.transcript->'waitingForBrain'->>'code' = 'busy')`;

/** Of these agents, the ones whose computer has runs waiting for room. */
export async function crowdedAgents(db: Executor, orgId: string, agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds), computerCrowdedSql(sql`${agents}.id`)));
  return new Set(rows.map((r) => r.id));
}
