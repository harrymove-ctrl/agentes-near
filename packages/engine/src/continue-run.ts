import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, gte, inArray, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { runBrainOf } from "./brains/select";
import { canceledBy, mayStopRun, runRequester } from "./cancel";
import { catchUpText } from "./catch-up";
import { ANSWER_ANYWAY_MS, type ClosedNote } from "./catch-up-triage";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent } from "./events";
import { continuedTranscript, type Transcript } from "./executor";
import { setWorkIssueState } from "./issues";
import { getMessage } from "./messages";
import { requireActiveMembership } from "./organizations";
import { enqueue } from "./outbox";
import { personCanPost } from "./routine-state";
import { ACTIVE_RUN_STATUSES, takeInbox } from "./run-inbox";
import { continuableEnd } from "./runs";
import { announceWork, reopenWork, updatesThreadOf } from "./works";

const { agentRuns, agents, messages, channels, users } = schema;

/**
 * "Continuar" under a reply a person stopped (`POST …/runs/{runId}/continue`):
 * a new run of the same agent, in the same conversation, picks up from the
 * stopped run's conversation plus "[Ana asked you to continue from where you
 * stopped.]". Same people as stopping it (`mayStopRun`). Only a run a person
 * stopped while it ran, one that ended at its step limit (its reply has
 * `meta.stepLimit`), or long work its AI provider cut off (its end home has
 * `meta.workEnd`); that reply is the new run's trigger, so it continues once,
 * and never while the agent already works in that conversation. The reply gets
 * `continuedRunId` in that meta (`meta.canceled`, `stepLimit` or `workEnd`) and the
 * app hears `run.continued`. Audited.
 */
export async function continueRun(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  runId: string,
): Promise<{ runId: string }> {
  const { db } = deps;
  const membership = await requireActiveMembership(db, userId, orgId);
  const [row] = await db
    .select({
      run: agentRuns,
      ownerUserId: agents.ownerUserId,
      requester: runRequester,
      request: messages.body,
      channelKind: channels.kind,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .leftJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!row) throw new NotFoundError("Run not found");
  const stopped = row.run;
  const carriedAtStart = stopped.transcript as unknown as Transcript | null;
  // A catch-up the check skipped (ADR 0136): "Responder mesmo assim" on its note, for everyone who asked in it too.
  const skipped = stopped.status === "done" && carriedAtStart?.catchUpTriage?.outcome === "closed";
  const asked = skipped && carriedAtStart?.catchUpTriage?.askers?.some((a) => a.userId === userId);
  if (!asked && !(await mayStopRun(db, userId, membership, row)))
    throw skipped
      ? new ForbiddenError("Only who asked, the agent's owner or an admin can ask for this", "run.answer_forbidden")
      : new ForbiddenError("Only who asked, the agent's owner or an admin can continue it", "run.continue_forbidden");

  const notContinuable = () => new ConflictError("This task can't be continued", "run.not_continuable");
  const byPerson = stopped.status === "canceled";
  // Long work its AI provider cut off (ADR 0121): its end, posted home, is where it goes on from.
  const providerCut = stopped.status === "failed";
  if (!(byPerson || providerCut || stopped.status === "done") || !stopped.transcript) throw notContinuable();
  const [work] = stopped.workId
    ? await db.select().from(schema.agentWorks).where(eq(schema.agentWorks.id, stopped.workId))
    : [];
  const replyId = skipped
    ? await skippedNoteOf(db, stopped)
    : providerCut
      ? work?.resultMessageId
      : stopped.replyMessageId;
  if (!replyId) throw notContinuable();
  const reply = await getMessage(db, orgId, replyId);
  // How it ended decides, as at a work's end (`continuableEnd`); a catch-up the check skipped is answered anyway.
  if (!reply || (!skipped && !continuableEnd(stopped, reply))) throw notContinuable();
  // Its reply says how it ended: stopped by a person (`meta.canceled`), at its step limit (`meta.stepLimit`), its
  // work's end after a provider error (`meta.workEnd`), or skipped as handled (`meta.usageWait.closed`).
  const ending = skipped ? "usageWait" : byPerson ? "canceled" : providerCut ? "workEnd" : "stepLimit";
  const ended = reply.meta[ending] as { continuedRunId?: unknown; closed?: ClosedNote } | undefined;
  if (reply.deletedAt || !ended || ended.continuedRunId) throw notContinuable();
  if (skipped && !(Date.now() - Date.parse(ended.closed?.at ?? "") < ANSWER_ANYWAY_MS)) throw notContinuable();

  // The new run answers where the stopped reply is: its thread, or (flat: a DM) the reply itself. Long work (ADR 0121)
  // goes on in its own thread, as the same work.
  const threadRootId = (work ? updatesThreadOf(work) : null) ?? reply.threadId ?? reply.id;
  const roots = [...new Set([stopped.threadRootId, threadRootId])];
  // A DM is one conversation; a channel's are its threads.
  const inConversation = row.channelKind === "dm" ? undefined : inArray(agentRuns.threadRootId, roots);
  const [busy] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, stopped.agentId),
        eq(agentRuns.channelId, stopped.channelId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        // A background run (a routine's) holds no conversation.
        eq(agentRuns.background, false),
        inConversation,
      ),
    )
    .limit(1);
  if (busy) throw new ConflictError("This agent is already working here", "run.agent_busy");

  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const carried = stopped.transcript as unknown as Transcript;
  const line = skipped
    ? await answerAnywayText(db, stopped, carried, ended.closed, person?.name ?? "A person")
    : `[${person?.name ?? "A person"} asked you to continue from where you stopped.]`;
  const transcript = continuedTranscript(carried, line);
  const request = carried.request ?? row.request;
  if (request) transcript.request = request;
  // What people passed on to the work that it never read before it stopped (`endWork`): the next run reads it first,
  // each from someone who can still post here.
  const unread = stopped.workId ? stopped.transcript?.unreadAsks : undefined;
  const ids = Array.isArray(unread) ? unread.filter((id): id is string => typeof id === "string") : [];
  const authors = ids.length
    ? await db
        .select({ id: messages.id, userId: messages.authorUserId })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), inArray(messages.id, ids)))
    : [];
  const allowed = new Set<string>();
  for (const a of authors)
    if (a.userId && (await personCanPost(db, orgId, a.userId, stopped.channelId))) allowed.add(a.id);
  const unreadAsks = ids.filter((id) => allowed.has(id));
  // Asked for by name: it answers, never passes.
  if (skipped) transcript.answerOwed = true;
  const newRunId = Bun.randomUUIDv7();
  const created = await db.transaction(async (tx) => {
    // One continuation per stopped reply: it is the new run's trigger, unique per agent.
    const [inserted] = await tx
      .insert(agentRuns)
      .values({
        id: newRunId,
        orgId,
        agentId: stopped.agentId,
        channelId: stopped.channelId,
        threadRootId,
        triggerMessageId: reply.id,
        // Nobody brings it in this time: a person asked for it, so it starts a stretch of its own (ADR 0089).
        trigger: stopped.trigger === "router" ? "mention" : stopped.trigger,
        hop: 1,
        stretchId: newRunId,
        transcript: transcript as unknown as Record<string, unknown>,
        issueId: stopped.issueId,
        // A computer brain resumes the session it was stopped in.
        brainSessionId: stopped.brainSessionId,
        workId: stopped.workId,
        pendingMessageIds: unreadAsks,
      })
      .onConflictDoNothing()
      .returning({ id: agentRuns.id });
    if (!inserted) return false;
    if (work) await reopenWork(tx, work.id);
    // A skipped note says who asked for the answer, in its own words ("Ana pediu para eu responder mesmo assim").
    const mark = JSON.stringify({
      continuedRunId: newRunId,
      continuedByUserId: userId,
      ...(skipped ? { continuedByName: person?.name ?? "" } : {}),
    });
    await tx
      .update(messages)
      .set({
        meta: sql`jsonb_set(${messages.meta}, array[${ending}::text], (${messages.meta}->${ending}::text) || ${mark}::jsonb)`,
      })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, reply.id)));
    // Overruled: for a while no check skips this agent's catch-ups here, and the workspace's bar learns from it.
    if (skipped)
      await tx
        .update(agentRuns)
        .set({
          transcript: sql`jsonb_set(${agentRuns.transcript}, '{catchUpTriage}', (${agentRuns.transcript}->'catchUpTriage')
            || jsonb_build_object('overruledBy', ${userId}::text, 'overruledAt', ${new Date().toISOString()}::text))`,
        })
        .where(eq(agentRuns.id, stopped.id));
    await enqueue(tx, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: newRunId },
      dedupeKey: `agent_run.execute:${newRunId}`,
      maxAttempts: 4,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "run.continued",
      target: { type: "agent_run", id: newRunId },
      details: { agentId: stopped.agentId, continues: stopped.id, ...(skipped ? { answerAnyway: true } : {}) },
    });
    return true;
  });
  if (!created) throw notContinuable();
  if (work) {
    if (work.issueId) await setWorkIssueState(deps, work, {}).catch(() => null);
    await announceWork(deps.pubsub, db, orgId, work.id).catch(() => {});
  }

  const where = { channelId: stopped.channelId, threadId: reply.threadId, agentId: stopped.agentId };
  await publishChannelEvent(deps.pubsub, {
    type: "run.continued",
    ...where,
    runId: stopped.id,
    newRunId,
    messageId: reply.id,
  });
  // The new run shows as any live run: "pensando…" right away.
  await publishChannelEvent(deps.pubsub, { type: "agent.thinking", ...where, runId: newRunId });
  return { runId: newRunId };
}

/** The note of a catch-up the check skipped: it says why, and is where "Responder mesmo assim" goes on from. */
async function skippedNoteOf(db: Database, run: typeof agentRuns.$inferSelect) {
  const [note] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        gte(messages.createdAt, run.createdAt),
        sql`${messages.meta}->'usageWait'->>'runId' = ${run.id}`,
        sql`${messages.meta}->'usageWait'->'closed' is not null`,
      ),
    )
    .limit(1);
  return note?.id ?? null;
}

/**
 * What a run answering a skipped catch-up anyway reads: who asked for it and what the check had judged, then the
 * catch-up block (how long it was paused, everything posted since, asks included) with no `pass`.
 */
async function answerAnywayText(
  db: Database,
  run: typeof agentRuns.$inferSelect,
  t: Transcript,
  closed: ClosedNote | undefined,
  name: string,
) {
  const judged =
    closed?.reason === "solved"
      ? `already handled by ${closed.who?.name ?? "someone"}`
      : closed?.reason === "withdrawn"
        ? "no longer needed"
        : closed?.reason === "task_canceled"
          ? `no longer needed, since ${closed.who?.name ?? "someone"} canceled the task`
          : "already handled";
  const anyway = `[${name} asked you to answer this anyway. A quick check had judged it ${judged}.]`;
  const [trigger] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
  const since = t.usageWait?.since;
  if (!trigger || since === undefined) return anyway;
  return catchUpText(db, { ...run, pendingMessageIds: [] }, trigger, {
    since,
    why: t.waitingForBrain?.code === "budget" ? "budget" : "plan",
    ...(t.waitingForBrain?.plan ? { plan: t.waitingForBrain.plan } : {}),
    mayPass: false,
    anyway,
  }).catch(() => anyway);
}

/** The stop-and-send message left the stopped run's inbox before the restart (handed on already). */
class AlreadyHandedOn extends Error {}

/**
 * "Parar e mandar" to a computer brain (Claude Code, Codex): its turn can't be cut halfway, so the
 * task was stopped (`postPersonMessage`). Once its stop is posted (`stopped`, the reply), a new run
 * of the same agent starts from that message: same conversation, the stopped run's context and its
 * computer session, plus "[Ana stopped you to say this:] …". Only for a message of the person who
 * stopped it, still unread (`meta.steerNow`). The stopped reply is marked continued (no "Continuar"),
 * and the app hears it read the message. The stopped run's other unread messages go along (the new
 * run reads them at its first step). Returns the new run's id, or null when there is nothing to do.
 */
export async function restartAfterStopAndSend(
  deps: { db: Database; pubsub?: PubSub },
  stoppedRunId: string,
  reply: { id: string; threadId: string | null },
  transcript: Transcript,
): Promise<string | null> {
  const { db } = deps;
  const [stopped] = await db.select().from(agentRuns).where(eq(agentRuns.id, stoppedRunId));
  const by = canceledBy(stopped?.error);
  if (!stopped || !by || stopped.pendingMessageIds.length === 0) return null;
  // A model brain reads a "Parar e mandar" mid-task (its call is cut); only a computer brain is restarted.
  // The brain the stopped run thought with (a fallback ran on the model brain), the agent's before its first turn.
  const [agent] = await db.select({ brain: agents.brain }).from(agents).where(eq(agents.id, stopped.agentId));
  if (!agent || runBrainOf(stopped, agent) === "model") return null;
  const [said] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, stopped.orgId),
        inArray(messages.id, stopped.pendingMessageIds),
        eq(messages.authorUserId, by),
        sql`${messages.meta}->>'steerNow' = 'true'`,
      ),
    )
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(1);
  if (!said) return null;
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, by));
  const line = `[${person?.name ?? "A person"} stopped you to say this:]\n\n${said.body}`;
  const newRunId = Bun.randomUUIDv7();
  const created = await db
    .transaction(async (tx) => {
      // The message is its trigger (it started no run of this agent: it went into the stopped one).
      const [inserted] = await tx
        .insert(agentRuns)
        .values({
          id: newRunId,
          orgId: stopped.orgId,
          agentId: stopped.agentId,
          channelId: stopped.channelId,
          threadRootId: said.threadId ?? said.id,
          triggerMessageId: said.id,
          trigger: stopped.trigger === "router" ? "mention" : stopped.trigger,
          // The person's message is its stretch (ADR 0089).
          hop: 1,
          stretchId: said.id,
          transcript: continuedTranscript(transcript, line) as unknown as Record<string, unknown>,
          issueId: stopped.issueId,
          brainSessionId: stopped.brainSessionId,
        })
        .onConflictDoNothing()
        .returning({ id: agentRuns.id });
      if (!inserted) return false;
      // The stopped run's unread messages move to the new run (taken: nothing is handed on twice).
      // Already handed on (the message is no longer there): nothing to restart; undo the insert.
      const unread = await takeInbox(tx, stopped.id);
      if (!unread.includes(said.id)) throw new AlreadyHandedOn();
      const rest = unread.filter((id) => id !== said.id);
      if (rest.length > 0)
        await tx.update(agentRuns).set({ pendingMessageIds: rest }).where(eq(agentRuns.id, newRunId));
      const mark = JSON.stringify({ continuedRunId: newRunId, continuedByUserId: by });
      await tx
        .update(messages)
        .set({ meta: sql`jsonb_set(${messages.meta}, '{canceled}', (${messages.meta}->'canceled') || ${mark}::jsonb)` })
        .where(and(eq(messages.orgId, stopped.orgId), eq(messages.id, reply.id)));
      await enqueue(tx, {
        orgId: stopped.orgId,
        kind: "agent_run.execute",
        payload: { runId: newRunId },
        dedupeKey: `agent_run.execute:${newRunId}`,
        maxAttempts: 4,
      });
      return true;
    })
    .catch((error: unknown) => {
      if (error instanceof AlreadyHandedOn) return false;
      throw error;
    });
  if (!created) return null;
  const where = { channelId: stopped.channelId, threadId: reply.threadId, agentId: stopped.agentId };
  await publishChannelEvent(deps.pubsub, {
    type: "run.continued",
    ...where,
    runId: stopped.id,
    newRunId,
    messageId: reply.id,
  });
  await publishChannelEvent(deps.pubsub, {
    type: "agent.run.read",
    ...where,
    runId: stopped.id,
    messageIds: [said.id],
  });
  await publishChannelEvent(deps.pubsub, { type: "agent.thinking", ...where, runId: newRunId });
  return newRunId;
}
