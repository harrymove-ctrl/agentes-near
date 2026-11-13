import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, gt, inArray, isNull, ne, or, schema, sql } from "@agenteschat/db";
import { scalarParams } from "./approvals";
import { runAuthorityById } from "./authority";
import { mayJoin, type RunTrigger, startOrJoinRun } from "./dispatch";
import { isAgentOnlyDm } from "./dms";
import { publishChannelEvent } from "./events";
import { cutText } from "./format";
import type { Message } from "./messages";
import { stripSentinel } from "./reply-policy";
import { holdsMessages } from "./run-hold";
import { inChannelRun } from "./run-scope";
import { type AgentRun, addRunStep, replyThreadOf } from "./runs";

const { agentConsultations, agentRunSteps, agentRuns, agentWorks, agents, approvals, channels, messages, users } =
  schema;

/**
 * A run's inbox (`agent_runs.pending_message_ids`): messages sent to the agent's conversation while
 * the run is active (one active run per agent and conversation), read at its next step. The rule
 * that makes delivery safe: a message is only ever queued on a run that is still active, and when
 * a run ends (done, failed, canceled, interrupted) whatever it hasn't read goes to a run of its own.
 * Nothing sent to an agent is dropped (unless it was archived), nor left on a dead run; the sweeper is the
 * safety net.
 */
export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_approval", "waiting_input"] as const;

/**
 * Why a run's unread messages were handed on (kept on the run's trail). `held`: the run waits on
 * something a message can't move (an approval, a secret, a mission's decision: `holdsMessages`).
 */
export type ReleaseReason = "done" | "failed" | "canceled" | "interrupted" | "swept" | "held";

/**
 * Queues a message on a run, only while the run is still active (status-guarded: a run that ended
 * meanwhile is never appended to). Idempotent. False: the run ended; the caller starts a run instead.
 */
export async function queueOnRun(tx: Executor, runId: string, messageId: string): Promise<boolean> {
  const queued = await tx
    .update(agentRuns)
    .set({
      pendingMessageIds: sql`case when ${messageId}::uuid = any(${agentRuns.pendingMessageIds})
        then ${agentRuns.pendingMessageIds} else array_append(${agentRuns.pendingMessageIds}, ${messageId}::uuid) end`,
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])))
    .returning({ id: agentRuns.id });
  return queued.length > 0;
}

/** Takes the run's unread messages (the inbox is emptied): the executor reads them, or hands them on. */
export async function takeInbox(db: Executor, runId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ pending: agentRuns.pendingMessageIds })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    const ids = row?.pending ?? [];
    if (ids.length === 0) return [];
    await tx.update(agentRuns).set({ pendingMessageIds: [] }).where(eq(agentRuns.id, runId));
    return ids;
  });
}

/**
 * A run ended without reading some messages: they get a run of their own (the last person's
 * message is its trigger; it reads the conversation, so the earlier ones too), or join the agent's run already
 * active there. `exclude`: messages that need no answer (the one that asked it to stop). The app
 * hears `agent.run.redispatched`.
 * Returns the run that took them, or null when there was nothing to hand on.
 */
export async function releaseInbox(
  db: Database,
  pubsub: PubSub | undefined,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "trigger">,
  options: { reason: ReleaseReason; exclude?: string[] },
): Promise<{ runId: string; messageIds: string[] } | null> {
  const taken = await takeToHandOn(db, run).catch(() => [] as string[]);
  return handOn(db, pubsub, run, taken, options);
}

/**
 * Some messages queued on a run that holds them (`holdsMessages`: it waits on an approval, a secret, a
 * mission's decision) leave its inbox and get a run of their own, like an ending's (`releaseInbox`): the
 * agent answers now, the held run still waits for its decision. Those no longer queued there (read, or
 * already handed on) are left alone.
 */
export async function handOnMessages(
  db: Database,
  pubsub: PubSub | undefined,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "trigger">,
  messageIds: string[],
): Promise<{ runId: string; messageIds: string[] } | null> {
  if (messageIds.length === 0) return null;
  const taken = await takeToHandOn(db, run, messageIds);
  return handOn(db, pubsub, run, taken, { reason: "held" });
}

/**
 * Takes unread messages out of a run's inbox (all of them, or those of `only` still there) to hand them on. A
 * question or note from another agent among them is no longer this run's to answer: its row waits on no run until
 * the run that takes it adopts it (`handOn`), and past its deadline it expires (ADR 0095).
 */
async function takeToHandOn(db: Database, run: Pick<AgentRun, "id" | "orgId">, only?: string[]) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ pending: agentRuns.pendingMessageIds })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
      .for("update");
    const pending = row?.pending ?? [];
    const ids = only ? pending.filter((id) => only.includes(id)) : pending;
    if (ids.length === 0) return [];
    await tx
      .update(agentRuns)
      .set({ pendingMessageIds: pending.filter((id) => !ids.includes(id)) })
      .where(eq(agentRuns.id, run.id));
    await tx
      .update(agentConsultations)
      .set({ targetRunId: null })
      .where(
        and(
          eq(agentConsultations.orgId, run.orgId),
          inArray(agentConsultations.messageId, ids),
          eq(agentConsultations.targetRunId, run.id),
          eq(agentConsultations.status, "open"),
        ),
      );
    return ids;
  });
}

/**
 * The run just paused on something a message can't move (`holdsMessages`): what it hadn't read yet gets
 * a run of its own instead of waiting behind the decision. A no-op for any other pause. What was passed on to its
 * background work stays: the work reads it once the decision comes, or its end takes it (`endWork`).
 */
export async function releaseHeldInbox(db: Database, pubsub: PubSub | undefined, runId: string) {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!row || row.pendingMessageIds.length === 0 || !(await holdsMessages(db, row))) return null;
  const kept = row.workId ? await passedOnTo(db, row.orgId, row.workId, row.pendingMessageIds) : [];
  if (kept.length === 0) return releaseInbox(db, pubsub, row, { reason: "held" });
  return handOnMessages(
    db,
    pubsub,
    row,
    row.pendingMessageIds.filter((id) => !kept.includes(id)),
  );
}

/** Of these messages, the ones passed on to that background work with `steer_work` (`meta.steeredWorkIds`). */
export async function passedOnTo(db: Executor, orgId: string, workId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        inArray(messages.id, ids),
        sql`${messages.meta}->'steeredWorkIds' ? ${workId}::text`,
      ),
    );
  return rows.map((m) => m.id);
}

/**
 * What this agent's other runs in the same conversation still wait on (a person's approval). A run waiting
 * on a decision takes no new message (`holdsMessages`: the decision may take hours), so a message sent
 * meanwhile gets a run of its own: it must know what is already asked, so it neither asks for it again nor
 * restates it; and the held run, once it resumes, must know what its sibling asked meanwhile. The
 * conversation is the one `startOrJoinRun` finds a run by: its thread (a run asked in the main timeline
 * also answers the replies under its trigger), plus the main timeline for a run asked there.
 */
export async function heldHere(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId">,
): Promise<string | null> {
  const rows = await db
    .select({ title: approvals.title, params: approvals.params })
    .from(approvals)
    .innerJoin(agentRuns, eq(agentRuns.id, approvals.runId))
    .where(
      and(
        eq(approvals.orgId, run.orgId),
        eq(approvals.agentId, run.agentId),
        eq(approvals.channelId, run.channelId),
        eq(approvals.status, "pending"),
        ne(agentRuns.id, run.id),
        eq(agentRuns.status, "waiting_approval"),
        or(
          eq(agentRuns.threadRootId, run.threadRootId),
          replyThreadOf(run) ? undefined : inChannelRun(sql`${agentRuns}`),
        ),
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(10);
  if (rows.length === 0) return null;
  const lines = rows.map((r) => {
    const params = Object.entries(scalarParams(r.params))
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return `- ${r.title}${params ? ` (${params})` : ""}`;
  });
  return [
    "# Already waiting for approval here",
    "Another run of yours in this conversation asked for these and waits for a person's decision; it carries on by itself once decided and says how it went:",
    ...lines,
    "Don't ask for them again, don't do them yourself and don't repeat their status: answer only what is new.",
  ].join("\n");
}

/**
 * What the agent's other runs did in this conversation while this one waited on a decision (`holdsMessages`):
 * the messages that started them (handed on from here, or sent meanwhile), what they posted and what they
 * still wait on (`heldHere`). The run resumes from its own transcript, so without this it would answer as if
 * the conversation had stopped when it paused: restating what another run of its own already said, or
 * redoing it. Read once, when it resumes; null when nothing happened.
 */
export async function whileHeld(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "workId">,
): Promise<string | null> {
  // The pause: its last step of its own. Handing its inbox on (`handOn`) writes a step after the run it
  // started, which would hide that run and its trigger.
  const [paused] = await db
    .select({ at: sql<string | null>`max(${agentRunSteps.createdAt})` })
    .from(agentRunSteps)
    .where(and(eq(agentRunSteps.runId, run.id), sql`not (${agentRunSteps.data} ? 'redispatchedMessageIds')`));
  if (!paused?.at) return null;
  const since = new Date(paused.at);
  const threadId = replyThreadOf(run);
  const rows = await db
    .select({
      body: messages.body,
      person: users.name,
      userId: messages.authorUserId,
      agent: agents.name,
      runId: messages.agentRunId,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        // Its conversation, as `startOrJoinRun` finds the run: its thread (a run asked in the main timeline
        // answers there and in the replies under its trigger).
        or(eq(messages.threadId, run.threadRootId), threadId ? undefined : isNull(messages.threadId)),
        isNull(messages.deletedAt),
        or(
          and(eq(messages.authorAgentId, run.agentId), ne(messages.agentRunId, run.id), gt(messages.createdAt, since)),
          // A run started since: its trigger may be older (queued here while it ran, then handed on).
          sql`${messages.id} in (select r.trigger_message_id from agent_runs r where r.org_id = ${run.orgId}::uuid
            and r.agent_id = ${run.agentId}::uuid and r.channel_id = ${run.channelId}::uuid and r.id <> ${run.id}::uuid
            and r.created_at > ${since.toISOString()}::timestamptz)`,
        ),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(10);
  // Background work reads only what was said for its asker: anyone else's ask runs after it, as them (`steerWork`), so
  // neither their words nor the agent's answers to them reach it.
  const [work] = run.workId
    ? await db.select({ asker: agentWorks.requestedByUserId }).from(agentWorks).where(eq(agentWorks.id, run.workId))
    : [];
  const forAsker = new Map<string, boolean>();
  for (const m of rows)
    if (work && m.agent && m.runId && !forAsker.has(m.runId))
      forAsker.set(m.runId, (await runAuthorityById(db, run.orgId, m.runId)).personId === work.asker);
  const lines = rows.flatMap((m) => {
    if (work && (m.agent ? !m.runId || !forAsker.get(m.runId) : m.userId !== work.asker)) return [];
    const text = cutText(stripSentinel(m.body), 1500);
    if (!text) return [];
    return [m.agent ? `[You, in another run]: ${text}` : `[${m.person ?? "Someone"}]: ${text}`];
  });
  const pending = await heldHere(db, run);
  if (lines.length === 0 && !pending) return null;
  return [
    ...(lines.length > 0
      ? [
          "While you waited, the conversation went on (another run of yours answered these; don't answer them again):",
          ...lines,
        ]
      : []),
    ...(pending ? [pending] : []),
    "Don't redo or restate what another run of yours did or still waits on. Carry on with what is left of your own task, and say what your waiting call changed.",
  ].join("\n\n");
}

/** Messages taken from a run's inbox go on: to a run of their own, or the agent's run already active there. */
async function handOn(
  db: Database,
  pubsub: PubSub | undefined,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "trigger">,
  taken: string[],
  options: { reason: ReleaseReason; exclude?: string[] },
): Promise<{ runId: string; messageIds: string[] } | null> {
  const ids = taken.filter((id) => !options.exclude?.includes(id));
  if (ids.length === 0) return null;
  // An archived (or deleted) agent answers nobody: a run of its own would only fail, so what it was sent is dropped.
  const [agent] = await db.select({ archivedAt: agents.archivedAt }).from(agents).where(eq(agents.id, run.agentId));
  if (!agent || agent.archivedAt) return null;
  const [channel] = await db
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(eq(channels.id, run.channelId));
  const betweenAgents = Boolean(channel && isAgentOnlyDm(channel));
  // Between agents, a colleague's result the run didn't read is already in the answer it owes (`handBack`): no run
  // starts to read it.
  const rows = (
    await db
      .select()
      .from(messages)
      .where(and(eq(messages.orgId, run.orgId), inArray(messages.id, ids), isNull(messages.deletedAt)))
      .orderBy(asc(messages.createdAt))
  ).filter((m) => !(betweenAgents && (m.meta.notice as { kind?: unknown } | undefined)?.kind === "consult_reply"));
  // The trigger: the last person's message, else the last notice (a routine's report, another agent's
  // answer: events the agent must act on), else another agent's call. The agent's own fast reply
  // (talker) is context only: it never starts a run by itself.
  const callers = rows.filter((m) => !m.meta.talker);
  const last =
    callers.filter((m) => m.authorType === "person").at(-1) ??
    callers.filter((m) => m.meta.notice).at(-1) ??
    callers.at(-1);
  if (!last) return null;
  const trigger = await triggerFor(db, run, last);
  const started = await db.transaction(async (tx) => {
    // A question or note from another agent is answered by the run that has it now (ADR 0095).
    const adopt = (runId: string, messageIds: string[]) =>
      tx
        .update(agentConsultations)
        .set({ targetRunId: runId })
        .where(
          and(
            eq(agentConsultations.orgId, run.orgId),
            inArray(agentConsultations.messageId, messageIds),
            isNull(agentConsultations.targetRunId),
            eq(agentConsultations.status, "open"),
          ),
        );
    const out = await startOrJoinRun(tx, last, run.agentId, trigger);
    if (!out) return out;
    const taker = "created" in out ? out.created.id : out.joined;
    const taken = [last.id];
    for (const m of rows) {
      if (m.id === last.id) continue;
      // One that may not reach the run that took them (a routine's report next to a person's message,
      // ADR 0053 §4) goes its own way.
      if (!(await mayJoin(tx, m, taker))) {
        const own = await startOrJoinRun(tx, m, run.agentId, await triggerFor(tx, run, m));
        if (own) await adopt("created" in own ? own.created.id : own.joined, [m.id]);
        continue;
      }
      // Joined a run that already read its context: the rest go to it too (a new run reads them in the conversation).
      if ("joined" in out) await queueOnRun(tx, out.joined, m.id);
      taken.push(m.id);
    }
    await adopt(taker, taken);
    return out;
  });
  if (!started) return null;
  const newRunId = "created" in started ? started.created.id : started.joined;
  const messageIds = rows.map((m) => m.id);
  await addRunStep(db, run, "context", {
    redispatchedMessageIds: messageIds,
    reason: options.reason,
    toRunId: newRunId,
  }).catch(() => undefined);
  const threadId = replyThreadOf(run);
  await publishChannelEvent(pubsub, {
    type: "agent.run.redispatched",
    channelId: run.channelId,
    threadId,
    agentId: run.agentId,
    runId: run.id,
    newRunId,
    messageIds,
  });
  if ("created" in started) {
    await publishChannelEvent(pubsub, {
      type: "agent.thinking",
      channelId: run.channelId,
      threadId: replyThreadOf(started.created),
      agentId: run.agentId,
      runId: newRunId,
    });
  }
  return { runId: newRunId, messageIds };
}

/**
 * The trigger of the run a handed-on message starts (ADR 0053 §10): it matches the message, never the run
 * that ended. A person's message in a DM is `dm`; a person's message or a notice elsewhere is `mention`
 * (it was sent to this agent: it must answer, never pass as a router pick would). Another agent's message
 * keeps how the ended run was called.
 */
async function triggerFor(
  db: Executor,
  run: Pick<AgentRun, "channelId" | "trigger">,
  message: Pick<Message, "authorType" | "meta" | "channelId">,
): Promise<RunTrigger> {
  if (message.authorType === "person") {
    const [channel] = await db.select({ kind: channels.kind }).from(channels).where(eq(channels.id, message.channelId));
    return channel?.kind === "dm" ? "dm" : "mention";
  }
  if (message.meta.notice) return "mention";
  return run.trigger;
}

/** How long an ended run's unread messages are left to the path that ended it before the sweeper takes them. */
export const INBOX_SWEEP_GRACE_MS = 30_000;
/**
 * A run that ended longer ago than this is stale: its unread messages are only emptied, never answered
 * now (inboxes left from before delivery existed woke agents on requests days old).
 */
export const INBOX_SWEEP_MAX_AGE_MS = 60 * 60_000;

/**
 * Safety net: ended runs (done, failed, canceled) still holding unread messages, finished more
 * than `graceMs` ago (whatever ended them didn't hand them on: a crash between the end and the
 * release, or a path that ends runs without it), are released; ones that ended more than
 * `maxAgeMs` ago are only emptied. Idempotent: a released inbox is empty. Returns how many runs were swept.
 */
export async function sweepEndedInboxes(
  deps: { db: Database; pubsub?: PubSub },
  options: { now?: Date; graceMs?: number; maxAgeMs?: number; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.graceMs ?? INBOX_SWEEP_GRACE_MS));
  const stale = now.getTime() - (options.maxAgeMs ?? INBOX_SWEEP_MAX_AGE_MS);
  const ended = await deps.db
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ["done", "failed", "canceled"]),
        sql`cardinality(${agentRuns.pendingMessageIds}) > 0`,
        sql`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(agentRuns.updatedAt))
    .limit(options.limit ?? 100);
  let swept = 0;
  for (const run of ended) {
    // Nobody waits for an answer this late: the inbox is just emptied (an archived agent's always is, `handOn`).
    const endedAt = (run.finishedAt ?? run.updatedAt).getTime();
    if (endedAt < stale) await takeInbox(deps.db, run.id);
    else await releaseInbox(deps.db, deps.pubsub, run, { reason: "swept" });
    swept++;
  }
  return swept;
}
