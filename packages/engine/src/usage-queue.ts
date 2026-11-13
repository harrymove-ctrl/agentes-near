import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, gt, gte, inArray, ne, schema, sql } from "@agenteschat/db";
import { cancelRun, mayStopRun, runRequester } from "./cancel";
import { writtenSince } from "./catch-up";
import { ANSWER_ANYWAY_MS, type ClosedNote } from "./catch-up-triage";
import { readableChannelIds } from "./channels";
import { ForbiddenError, NotFoundError } from "./errors";
import { can, requirePermission } from "./organizations";
import { replyThreadOf } from "./runs";

const { agentRuns, agents, agentWorks, channels, messages, routineRuns, routines } = schema;

/** One conversation (or routine, or long work) an agent picks up when its plan or budget is back. */
export interface UsageQueueRow {
  runId: string;
  kind: "conversation" | "routine" | "work";
  channelId: string;
  threadId: string | null;
  channelKind: string;
  /** The channel's name (a DM has none). */
  channelName: string | null;
  /** What it answers: where "Ver conversa" goes. */
  messageId: string;
  /** Who asked (people's ids): the trigger's author, then whoever joined it, in order. */
  askers: string[];
  /** When it first paused, ISO. */
  since: string;
  /** What was posted after it in its conversation: how many messages, and by whom. */
  after: { count: number; names: string[] };
  /** In line, or answering right now (the line reached it). */
  state: "queued" | "answering";
  /** The routine's or the work's title. */
  title: string | null;
  /** The viewer may say not to run it (`mayStopRun`). */
  mayStop: boolean;
}

/** A catch-up the check skipped as already handled (ADR 0136), in the queue for a day with "Responder mesmo assim". */
export interface UsageQueueClosedRow {
  runId: string;
  channelId: string;
  threadId: string | null;
  channelKind: string;
  channelName: string | null;
  /** The skipped note: where "Ver conversa" goes, and what it says. */
  messageId: string;
  closed: ClosedNote;
  /** Someone asked it to answer anyway: the run that does. */
  continuedRunId: string | null;
  /** The viewer may press "Responder mesmo assim": who asked, the agent's owner, an admin; for 7 days. */
  mayAnswer: boolean;
}

/** An agent's line of work waiting on its plan or budget (ADR 0118): what it picks up, in order, when it is back. */
export interface UsageQueue {
  agentId: string;
  reason: "plan" | "budget" | null;
  /** The plan in words ("Claude"). */
  plan: string | null;
  /** When it resumes, when known. */
  resetsAt: string | null;
  /** Other agents waiting in the same plan's line (it belongs to the sign-in, not the agent). */
  sharedWith: string[];
  rows: UsageQueueRow[];
  /** In conversations the viewer can't read: counted, never shown. */
  hidden: number;
  /** "Don't run any": the agent's owner and admins. */
  mayStopAll: boolean;
  /** Skipped in the last day as already handled, newest first (readable conversations only). */
  closed: UsageQueueClosedRow[];
}

const USAGE_CODES = sql`(${agentRuns.transcript}->'waitingForBrain'->>'code' in ('plan_limit', 'budget', 'usage_pause'))`;

/** People's conversations first, then long work, then routines, each by when it first paused. */
const rank = (r: { background: boolean; workId: string | null }) => (r.background ? 2 : r.workId ? 1 : 0);

export async function usageQueue(db: Database, viewerId: string, orgId: string, agentId: string): Promise<UsageQueue> {
  const membership = await requirePermission(db, viewerId, orgId, "read");
  const [agent] = await db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  if (!agent) throw new NotFoundError("Agent not found");
  const runs = await db
    .select({
      run: agentRuns,
      requester: runRequester,
      code: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'code'`,
      source: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'source'`,
      waitKey: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitKey'`,
      plan: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'plan'`,
      resetsAt: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'resetsAt'`,
      since: sql<string>`coalesce(${agentRuns.transcript}->'waitingForBrain'->>'since',
        ${agentRuns.transcript}->'usageWait'->>'since', ${agentRuns.transcript}->'catchUp'->>'since',
        (extract(epoch from ${agentRuns.createdAt}) * 1000)::bigint::text)`,
      channelKind: channels.kind,
      channelName: channels.name,
    })
    .from(agentRuns)
    .innerJoin(channels, eq(channels.id, agentRuns.channelId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, agentId),
        sql`((${agentRuns.status} = 'waiting_input' and ${USAGE_CODES})
          or (${agentRuns.status} = 'running' and ${agentRuns.transcript}->'catchUp' is not null))`,
      ),
    )
    .limit(500);
  const ordered = runs
    .map((r) => ({ ...r, sinceMs: Number(r.since) }))
    .sort(
      (a, b) =>
        Number(a.run.status !== "running") - Number(b.run.status !== "running") ||
        rank(a.run) - rank(b.run) ||
        a.sinceMs - b.sinceMs,
    );
  const readable = await readableChannelIds(
    db,
    orgId,
    viewerId,
    ordered.map((r) => r.run.channelId),
  );
  const shown = ordered.filter((r) => readable.has(r.run.channelId));
  const workIds = shown.flatMap((r) => (r.run.workId ? [r.run.workId] : []));
  const bgIds = shown.filter((r) => r.run.background).map((r) => r.run.id);
  const pendingIds = shown.flatMap((r) => r.run.pendingMessageIds);
  const [works, routineNames, joined] = await Promise.all([
    workIds.length
      ? db
          .select({ id: agentWorks.id, title: agentWorks.title })
          .from(agentWorks)
          .where(inArray(agentWorks.id, workIds))
      : [],
    bgIds.length
      ? db
          .select({ runId: routineRuns.agentRunId, name: routines.name })
          .from(routineRuns)
          .innerJoin(routines, eq(routines.id, routineRuns.routineId))
          .where(inArray(routineRuns.agentRunId, bgIds))
      : [],
    pendingIds.length
      ? db
          .select({ id: messages.id, userId: messages.authorUserId })
          .from(messages)
          .where(and(eq(messages.orgId, orgId), inArray(messages.id, pendingIds)))
      : [],
  ]);
  const authorOf = new Map(joined.map((m) => [m.id, m.userId]));
  const rows: UsageQueueRow[] = [];
  for (const r of shown) {
    const threadId = replyThreadOf(r.run);
    const askers = [
      ...new Set(
        [r.requester, ...r.run.pendingMessageIds.map((id) => authorOf.get(id) ?? null)].filter(
          (id): id is string => typeof id === "string",
        ),
      ),
    ];
    const trigger = await db
      .select({ at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, r.run.triggerMessageId)))
      .then((m) => m[0]?.at ?? r.run.createdAt);
    rows.push({
      runId: r.run.id,
      kind: r.run.background ? "routine" : r.run.workId ? "work" : "conversation",
      channelId: r.run.channelId,
      threadId,
      channelKind: r.channelKind,
      channelName: r.channelKind === "dm" ? null : r.channelName,
      messageId: r.run.triggerMessageId,
      askers,
      since: new Date(r.sinceMs).toISOString(),
      after: await writtenSince(db, orgId, {
        channelId: r.run.channelId,
        threadId,
        after: trigger,
        triggerId: r.run.triggerMessageId,
        exceptAgentId: agentId,
      }),
      state: r.run.status === "running" ? "answering" : "queued",
      title: r.run.workId
        ? (works.find((w) => w.id === r.run.workId)?.title ?? null)
        : r.run.background
          ? (routineNames.find((n) => n.runId === r.run.id)?.name ?? null)
          : null,
      mayStop:
        r.run.status === "waiting_input" &&
        (await mayStopRun(db, viewerId, membership, {
          run: r.run,
          requester: r.requester,
          ownerUserId: agent.ownerUserId,
        })),
    });
  }
  const head = ordered.find((r) => r.run.status === "waiting_input") ?? ordered[0];
  const keys = [...new Set(ordered.flatMap((r) => (r.waitKey ? [r.waitKey] : [])))];
  const shared = keys.length
    ? await db
        .selectDistinct({ agentId: agentRuns.agentId })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, orgId),
            eq(agentRuns.status, "waiting_input"),
            ne(agentRuns.agentId, agentId),
            inArray(sql<string>`${agentRuns.transcript}->'waitingForBrain'->>'waitKey'`, keys),
          ),
        )
    : [];
  const budget = head?.code === "budget" || head?.source === "budget";
  const mayAll = agent.ownerUserId === viewerId || can(membership, "manage_agents");
  return {
    agentId,
    reason: head ? (budget ? "budget" : "plan") : null,
    plan: head?.plan ?? null,
    resetsAt: ordered.find((r) => r.resetsAt)?.resetsAt ?? null,
    sharedWith: shared.map((s) => s.agentId),
    rows,
    hidden: ordered.length - shown.length,
    mayStopAll: mayAll,
    closed: await closedRows(db, viewerId, orgId, agentId, mayAll),
  };
}

const CLOSED_SHOWN_MS = 24 * 3600_000;

/** The catch-ups the check skipped in the last day, newest first, in conversations the viewer reads. */
async function closedRows(
  db: Database,
  viewerId: string,
  orgId: string,
  agentId: string,
  mayAll: boolean,
  now = Date.now(),
): Promise<UsageQueueClosedRow[]> {
  const found = await db
    .select({ run: agentRuns, channelKind: channels.kind, channelName: channels.name })
    .from(agentRuns)
    .innerJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.status, "done"),
        gt(agentRuns.finishedAt, new Date(now - CLOSED_SHOWN_MS)),
        sql`${agentRuns.transcript}->'catchUpTriage'->>'outcome' = 'closed'`,
      ),
    )
    .orderBy(desc(agentRuns.finishedAt))
    .limit(50);
  const readable = await readableChannelIds(
    db,
    orgId,
    viewerId,
    found.map((r) => r.run.channelId),
  );
  const out: UsageQueueClosedRow[] = [];
  for (const r of found) {
    if (!readable.has(r.run.channelId)) continue;
    const [note] = await db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        wait: sql<Record<string, unknown>>`${messages.meta}->'usageWait'`,
      })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.channelId, r.run.channelId),
          gte(messages.createdAt, r.run.createdAt),
          sql`${messages.meta}->'usageWait'->>'runId' = ${r.run.id}`,
          sql`${messages.meta}->'usageWait'->'closed' is not null`,
        ),
      )
      .limit(1);
    if (!note) continue;
    const closed = note.wait.closed as ClosedNote;
    const continuedRunId = typeof note.wait.continuedRunId === "string" ? note.wait.continuedRunId : null;
    out.push({
      runId: r.run.id,
      channelId: r.run.channelId,
      threadId: note.threadId,
      channelKind: r.channelKind,
      channelName: r.channelKind === "dm" ? null : r.channelName,
      messageId: note.id,
      closed,
      continuedRunId,
      mayAnswer:
        !continuedRunId &&
        now - Date.parse(closed.at) < ANSWER_ANYWAY_MS &&
        (mayAll || closed.askers.includes(viewerId)),
    });
  }
  return out;
}

/**
 * "Don't run any" (`POST …/agents/{agentId}/usage-queue/cancel`): every conversation, routine and long work waiting on
 * the agent's plan or budget won't run. The agent's owner and admins; each stop is audited as any other.
 */
export async function cancelUsageQueue(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  agentId: string,
): Promise<{ canceled: number; skipped: number }> {
  const { db } = deps;
  const queue = await usageQueue(db, userId, orgId, agentId);
  if (!queue.mayStopAll)
    throw new ForbiddenError("Only the agent's owner or an admin can do this", "usage_queue.cancel_forbidden");
  const waitingNow = () =>
    db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.agentId, agentId),
          eq(agentRuns.status, "waiting_input"),
          USAGE_CODES,
        ),
      );
  const waiting = await waitingNow();
  // A note's "Don't run it" stops the turns it took in too: one already stopped that way is no failure.
  for (const r of waiting) await cancelRun(deps, userId, orgId, r.id, { tell: false }).catch(() => null);
  const left = (await waitingNow()).length;
  return { canceled: waiting.length - left, skipped: left };
}
