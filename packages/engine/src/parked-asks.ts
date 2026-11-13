import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gte, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import { announceAgentStatus } from "./agent-status";
import { getAgentCached } from "./agents";
import { inMission } from "./auto-model";
import { withdrawHandoff } from "./browser/handoff";
import {
  askCatchUp,
  askRequestTriage,
  CATCH_UP_CLOSE_AT,
  type ClosedNote,
  catchUpBar,
  catchUpDecision,
  closedNoteOf,
  otherAgentAnswering,
  overruledHere,
  type ReleasedAsks,
  requestDecision,
  TRIAGE_MAX_CALLS,
  TRIAGE_REFRESH_MS,
  type TriageRecord,
  type TriageVerdict,
  triageBrief,
  triageGate,
  triageRecordOf,
  triageSnapshot,
} from "./catch-up-triage";
import { lineMachineOf, publishQueueChanged } from "./computer-queue";
import { getChannelCached } from "./context";
import { publishChannelEvent, publishMessageCreated } from "./events";
import type { Transcript } from "./executor";
import { cutText, fromNow, pgSafeJson, stringsOf } from "./format";
import type { Judge } from "./judge";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import { notifyCatchUpClosed, notifyCatchUpClosedAsker } from "./notification-producers";
import { openRequestsOf } from "./open-requests";
import { withdrawQuestion } from "./questions";
import { releaseInbox } from "./run-inbox";
import { resumeRunWithResult } from "./run-resume";
import { type AgentRun, addRunStep, computerWaitOf, replyThreadOf, transitionRun, usageWaitOf } from "./runs";
import { withdrawSecretRequest } from "./secrets";
import type { ToolDefinition, ToolSource } from "./tools/types";
import { lineHeadLooks, usageNoteHandOn, usageWaitClosed, wakeNextInLine } from "./usage-pause";

const { agentRuns, agents, messages, outbox, users } = schema;

/**
 * Asks a waiting run holds (ADR 0136): a run waiting on something a message can't move (its plan's limit, its budget,
 * its computer) keeps what it was asked (its trigger and the messages that joined it) for when it is back. Once one of
 * them is handled meanwhile, it lets it go instead of answering it later: the catch-up check runs early on it
 * (`checkParkedRun`), and another agent that handled it can release it (`release_waiting_agent`). What the agent itself
 * asked people (a question, a secret, help on its screens) gets the same check: a request whose need was met here is
 * withdrawn quietly.
 */

/** A wait no message can move (`parkedWaitOf`). */
export type ParkedWait = "plan" | "budget" | "queued" | "away";

/** What a waiting run waits on when a message can't move it: its plan, its budget or its computer. */
export const parkedWaitOf = (run: Pick<AgentRun, "status" | "waitingMachineId" | "transcript">): ParkedWait | null =>
  run.status === "waiting_input" ? (usageWaitOf(run) ?? computerWaitOf(run)) : null;

/** Messages landing this close together make one early check (`scheduleParkedChecks`). */
export const EARLY_CHECK_MS = 60_000;
export const EARLY_CHECK_JOB = "catch_up.check";

/** The tool another agent lets a waiting one go with. */
export const RELEASE_TOOL = "release_waiting_agent";

/** A closed note's code (`meta.bodyCode`) when the run had no note of its own to say it on. */
export const CLOSED_NOTE_CODE = "catch_up_closed";

/**
 * Something landed where a waiting run would read it (its conversation, or the thread under one of its asks): a person's
 * message or another agent's reply. Each such run gets one check (`checkParkedRun`) a little later, however many
 * messages come meanwhile. Its own words don't count, but for the card of a request it just made: what it asks may
 * already be answered here. One statement.
 */
export async function scheduleParkedChecks(db: Executor, m: Message) {
  if (m.deletedAt || m.meta.notice || m.meta.usageWait || m.meta.talker) return;
  if (m.authorType !== "person" && m.authorType !== "agent") return;
  const card = m.authorType === "agent" && Boolean(m.meta.questionId || m.meta.secretRequest || m.meta.browserHandoff);
  // One check per run and window, a whole window after the first message in it: the replies it brings come in.
  const now = Date.now();
  const slot = Math.floor(now / EARLY_CHECK_MS);
  const thread = m.threadId;
  await db.execute(sql`insert into ${outbox} (id, org_id, kind, payload, dedupe_key, max_attempts, next_attempt_at)
    select gen_random_uuid(), r.org_id, ${EARLY_CHECK_JOB}, jsonb_build_object('runId', r.id),
      ${`${EARLY_CHECK_JOB}:`} || r.id || ${`:${slot}`}, 2, ${new Date(now + EARLY_CHECK_MS).toISOString()}::timestamptz
    from ${agentRuns} r
    where r.org_id = ${m.orgId}::uuid and r.channel_id = ${m.channelId}::uuid and r.status = 'waiting_input'
      and not r.background and r.work_id is null
      and ${card ? sql`r.agent_id = ${m.authorAgentId}::uuid` : sql`r.agent_id is distinct from ${m.authorAgentId}::uuid`}
      and ${
        thread
          ? sql`((r.thread_root_id = ${thread}::uuid and r.thread_root_id <> r.trigger_message_id)
            or r.trigger_message_id = ${thread}::uuid or ${thread}::uuid = any(r.pending_message_ids))`
          : sql`r.thread_root_id = r.trigger_message_id`
      }
    on conflict do nothing`);
}

export interface ParkedDeps {
  db: Database;
  pubsub?: PubSub;
  /** The catch-up check's calibrated judge (Jev): without one, nothing is checked early. */
  judge?: Judge;
}

/**
 * The early check of a waiting run (`EARLY_CHECK_JOB`). Parked on its plan, budget or computer: the catch-up check
 * (ADR 0136) reads what it holds now, and an asker whose ask was closed is let go (`releaseAsks`). Waiting on a request
 * of its own: one whose need was met here is withdrawn quietly. The catch-up's judge, call budget and bar; in any doubt
 * nothing changes.
 */
export async function checkParkedRun(deps: ParkedDeps, runId: string, jobId?: string) {
  const { db, judge } = deps;
  if (!judge || judge.name === "llm") return;
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (run?.status !== "waiting_input" || run.background || run.workId) return;
  if (await checkedElsewhere(db, run.id, jobId, !computerWaitOf(run))) return;
  const [trigger, agent] = await Promise.all([
    getMessage(db, run.orgId, run.triggerMessageId),
    getAgentCached(db, run.orgId, run.agentId),
  ]);
  if (!trigger || !agent) return;
  if (parkedWaitOf(run)) return checkAsks(deps, judge, run, trigger, agent.name);
  return checkRequests(deps, judge, run, trigger, agent.name);
}

/**
 * Its own resume is due or running (`resumes`: its claim runs the same check, or brings the answer it waited on), or an
 * earlier check of it runs right now: this one stands down instead of asking the judge twice. A computer wait's resume
 * is only its next ask for room, which checks nothing. Due and running jobs only, which their partial indexes keep few.
 */
async function checkedElsewhere(db: Executor, runId: string, jobId: string | undefined, resumes: boolean) {
  const [row] = rowsOf<{ busy: boolean }>(
    await db.execute(sql`select (exists (select 1 from ${outbox} o where o.status = 'processing'
        and o.payload->>'runId' = ${runId}
        and ((${resumes}::boolean and o.kind = 'agent_run.execute')
          or (o.kind = ${EARLY_CHECK_JOB} and o.id < ${jobId ?? null}::uuid)))
      or (${resumes}::boolean and exists (select 1 from ${outbox} o where o.status = 'pending'
        and o.next_attempt_at <= now() and o.kind = 'agent_run.execute' and o.payload->>'runId' = ${runId}))) as busy`),
  );
  return row?.busy === true;
}

const transcriptOf = (run: Pick<AgentRun, "transcript">) => (run.transcript ?? {}) as Partial<Transcript>;

/** A record as its run step keeps it: without what the agent is told. */
const stepOf = (record: TriageRecord) => {
  const { brief: _, ...step } = record;
  return step;
};

async function checkAsks(deps: ParkedDeps, judge: Judge, run: AgentRun, trigger: Message, agentName: string) {
  const { db } = deps;
  const t = transcriptOf(run);
  // Owing what it started (calls made, a cut turn), it answers all of it when it is back. A person it owes an answer
  // (`answerOwed`) is never let go, but whoever joined after still is (`TriageAsker.owed`).
  if (t.executedCalls || t.interruptedTurn) return;
  const asks = [run.triggerMessageId, ...run.pendingMessageIds];
  // Another agent still writing there: its answer lands as a message, which checks again.
  if (await otherAgentAnswering(db, run, asks)) return;
  const since = t.usageWait?.since ?? t.roomWaitSince ?? run.updatedAt.getTime();
  const snapshot = await triageSnapshot(db, run, trigger, agentName, since);
  const prior = t.catchUpTriage;
  const gate = triageGate({
    snapshot,
    prior,
    mission: await inMission(db, run),
    overruled: await overruledHere(db, run).catch(() => true),
    noJev: false,
  });
  if (gate) return;
  const bar = await catchUpBar(db, run.orgId).catch(() => CATCH_UP_CLOSE_AT);
  const base = {
    at: Date.now(),
    bar,
    judge: judge.name,
    calls: (prior?.calls ?? 0) + 1,
    seenThrough: snapshot.latest,
    ...(prior?.busyRetries ? { busyRetries: prior.busyRetries } : {}),
  };
  let verdict: TriageVerdict;
  try {
    const answers = await askCatchUp(judge, snapshot, { orgId: run.orgId, agentId: run.agentId, runId: run.id });
    verdict = catchUpDecision(answers, snapshot, bar);
  } catch {
    await keepRecord(db, run, { ...base, outcome: "judge_error" });
    return;
  }
  const cleared = verdict.outcome === "closed" ? verdict.askers : verdict.askers.filter((a) => a.reason);
  // Several let go at once only as surely as one close needs (the product of their p).
  const sure = cleared.reduce((n, a) => n * (a.sure ?? 0), 1);
  const release = cleared.length > 0 && sure >= bar ? cleared : [];
  const open: TriageVerdict = { ...verdict, askers: verdict.askers.filter((a) => !release.includes(a)) };
  const keep = triageRecordOf(open, base, triageBrief(snapshot, open));
  if (release.length > 0) {
    const ids = snapshot.askers
      .filter((a) => release.some((r) => r.userId === a.userId))
      .flatMap((a) => a.asks.flatMap((x) => (x.id ? [x.id] : [])));
    const closedVerdict: TriageVerdict = { outcome: "closed", askers: release, p: sure };
    const credits = release.flatMap((a) => {
      const who = snapshot.participants.find((p) => p.key === a.who);
      if (!who || (who.kind === "person" && who.id === a.userId)) return [];
      return a.reason === "solved" || a.reason === "task_canceled"
        ? [{ userId: a.userId, reason: a.reason, who: who.name }]
        : [];
    });
    const done = await releaseAsks(deps, run, {
      ids,
      closed: closedNoteOf(snapshot, closedVerdict),
      record: triageRecordOf(closedVerdict, base, ""),
      ...(open.askers.length > 0 ? { keep } : {}),
      credits,
    });
    if (done) return;
    // Something moved meanwhile (a message joined, it resumed): the agent runs, with nothing let go.
    await keepRecord(db, run, { ...keep, outcome: "unsure", brief: triageBrief(snapshot, null) || undefined });
    return;
  }
  await keepRecord(db, run, keep);
}

/** The check's record on a run still waiting, and its step (a judge's answer only). */
async function keepRecord(db: Database, run: AgentRun, record: TriageRecord) {
  const clean = Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as TriageRecord;
  const kept = await db
    .update(agentRuns)
    .set({
      transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{catchUpTriage}', ${JSON.stringify(clean)}::jsonb)`,
    })
    .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, "waiting_input")))
    .returning({ id: agentRuns.id });
  // Back at work meanwhile: its claim's own check is the one on record.
  if (kept.length > 0 && clean.outcome !== "judge_error")
    await addRunStep(db, run, "context", { catchUpTriage: stepOf(clean) });
}

/** What a waiting run lets go: the asks, why (its note), the record of the check, and who hears it. */
interface Release {
  ids: string[];
  closed: ClosedNote;
  record: TriageRecord;
  /** The record it keeps for the asks it still holds. */
  keep?: TriageRecord;
  /** Askers credited to someone else: they hear it (`notifyCatchUpClosedAsker`). */
  credits: { userId: string; reason: "solved" | "task_canceled"; who: string }[];
}

/**
 * A waiting run lets asks go. Its trigger among them: it ends quietly as a closed catch-up does (the closed note,
 * "Responder mesmo assim") and whatever else it held gets a run of its own, as when a person says not to run it. Only
 * messages that joined it: they leave it for a closed run of their own (`closeAside`), and it waits on for the rest.
 */
async function releaseAsks(deps: ParkedDeps, run: AgentRun, r: Release): Promise<boolean> {
  if (r.ids.length === 0) return false;
  return r.ids.includes(run.triggerMessageId) ? closeParked(deps, run, r) : closeAside(deps, run, r);
}

async function closeParked(deps: ParkedDeps, run: AgentRun, r: Release): Promise<boolean> {
  const { db } = deps;
  const ended = await db.transaction(async (tx) => {
    const [held] = await tx
      .select({
        pending: agentRuns.pendingMessageIds,
        status: agentRuns.status,
        waitingMachineId: agentRuns.waitingMachineId,
        transcript: agentRuns.transcript,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
      .for("update");
    // Compare-and-set: a message that joined since it was judged makes it run instead, as the catch-up check does. Gone
    // on meanwhile and waiting on something else (a person's answer), it isn't ended either.
    if (!held || !parkedWaitOf(held) || held.pending.join() !== run.pendingMessageIds.join()) return null;
    // A waiting run ends only from `running` (ADR 0008): both moves in one transaction, so nobody sees it working.
    if (!(await transitionRun(tx, run.id, "waiting_input", "running"))) return null;
    return transitionRun(tx, run.id, "running", "done", {
      error: null,
      transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{catchUpTriage}', ${JSON.stringify(r.record)}::jsonb)`,
    });
  });
  if (!ended) return false;
  await addRunStep(db, run, "context", {
    continuation: { outcome: "done", rule: "catch_up_closed" },
    catchUpTriage: stepOf(r.record),
    passed: { how: "released", silent: true },
  }).catch(() => {});
  const where = { channelId: run.channelId, threadId: replyThreadOf(run), agentId: run.agentId, runId: run.id };
  await publishChannelEvent(deps.pubsub, { type: "agent.passed", ...where });
  await publishChannelEvent(deps.pubsub, { type: "agent.run", ...where, status: "done" });
  await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where });
  await publishChannelEvent(deps.pubsub, { type: "run.finished", ...where, status: "done", passed: true });
  // Its trigger and whatever else those askers sent it: none of their receipts says it still waits.
  for (const messageId of r.ids)
    await publishChannelEvent(deps.pubsub, {
      type: "message.handled",
      channelId: run.channelId,
      messageId,
      agentId: run.agentId,
      runId: run.id,
      status: "done",
      passed: true,
    });
  await announceAgentStatus(deps.pubsub, run.orgId, run.agentId).catch(() => {});
  const line = lineMachineOf(run);
  if (line) await publishQueueChanged(deps.pubsub, run.orgId, line);
  // A note that also speaks for later turns waiting here is theirs now; this run's says why it didn't answer.
  if (usageWaitOf(run)) await usageNoteHandOn(deps, ended).catch(() => {});
  const note =
    (await usageWaitClosed(deps, ended, r.closed as unknown as Record<string, unknown>).catch(() => null)) ??
    (await postClosedNote(deps, ended, r.closed).catch(() => null));
  const wait = transcriptOf(run).waitingForBrain;
  await tellClosed(deps, ended, r, note, wait?.waitKey ?? null);
  if (wait?.waitKey) {
    await wakeNextInLine(db, run.orgId, wait.waitKey, wait.model).catch(() => null);
    await lineHeadLooks(db, run.orgId, wait.waitKey).catch(() => null);
  }
  // What else it held goes on: a run of its own answers it.
  await releaseInbox(db, deps.pubsub, ended, { reason: "done", exclude: r.ids }).catch(() => null);
  return true;
}

class AsksMoved extends Error {}

/**
 * Asks that joined a waiting run, let go while it waits on for its trigger: they leave its inbox for a run of their
 * own that ends at once as a closed catch-up (its note, "Responder mesmo assim" going on from what the waiting run had
 * read), and the waiting run remembers them (`releasedAsks`): its catch-up neither answers them nor reads them as news.
 */
async function closeAside(deps: ParkedDeps, run: AgentRun, r: Release): Promise<boolean> {
  const { db } = deps;
  const asks = await db
    .select({ id: messages.id, body: messages.body, threadId: messages.threadId, name: users.name })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .where(and(eq(messages.orgId, run.orgId), inArray(messages.id, r.ids)))
    .orderBy(messages.createdAt);
  const last = asks.at(-1);
  if (!last) return false;
  const t = transcriptOf(run);
  const released: ReleasedAsks = {
    messageIds: r.ids,
    askers: [...new Set(asks.map((a) => a.name ?? "Someone"))],
    who: r.closed.who?.name ?? null,
  };
  const { appendUserText } = await import("./executor");
  const carried = {
    system: t.system,
    messages: structuredClone(t.messages ?? []),
    repo: t.repo,
    toolGroups: t.toolGroups,
    notesAt: t.notesAt,
    passListed: t.passListed,
    autoModel: t.autoModel,
    promptKey: t.promptKey,
    usageWait: t.usageWait,
    waitingForBrain: t.waitingForBrain,
    postedUpTo: 0,
    postedCount: 0,
    catchUpTriage: r.record,
  };
  appendUserText(carried, asks.map((a) => `[${a.name ?? "Someone"}]: ${a.body}`).join("\n\n"));
  const id = Bun.randomUUIDv7();
  const made = await db
    .transaction(async (tx) => {
      const [held] = await tx
        .select({ status: agentRuns.status, pending: agentRuns.pendingMessageIds })
        .from(agentRuns)
        .where(eq(agentRuns.id, run.id))
        .for("update");
      // Read, handed on or answered meanwhile: nothing to let go.
      if (held?.status !== "waiting_input" || !r.ids.every((x) => held.pending.includes(x))) return null;
      const remembered = sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{releasedAsks}',
        coalesce(${agentRuns.transcript}->'releasedAsks', '[]'::jsonb) || ${JSON.stringify([released])}::jsonb)`;
      await tx
        .update(agentRuns)
        .set({
          pendingMessageIds: held.pending.filter((x) => !r.ids.includes(x)),
          transcript: r.keep
            ? sql`jsonb_set(${remembered}, '{catchUpTriage}', ${JSON.stringify(r.keep)}::jsonb)`
            : remembered,
        })
        .where(eq(agentRuns.id, run.id));
      const [inserted] = await tx
        .insert(agentRuns)
        .values({
          id,
          orgId: run.orgId,
          agentId: run.agentId,
          channelId: run.channelId,
          threadRootId: last.threadId ?? last.id,
          triggerMessageId: last.id,
          trigger: run.trigger,
          hop: run.hop,
          stretchId: run.stretchId ?? last.id,
          status: "running",
          transcript: pgSafeJson(carried) as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing()
        .returning({ id: agentRuns.id });
      if (!inserted) throw new AsksMoved();
      return transitionRun(tx, id, "running", "done", { error: null });
    })
    .catch((error: unknown) => {
      if (error instanceof AsksMoved) return null;
      throw error;
    });
  if (!made) return false;
  await addRunStep(db, made, "context", {
    continuation: { outcome: "done", rule: "catch_up_closed" },
    catchUpTriage: stepOf(r.record),
    passed: { how: "released", silent: true },
    releasedFrom: run.id,
  }).catch(() => {});
  await addRunStep(db, run, "context", {
    ...(r.keep ? { catchUpTriage: stepOf(r.keep) } : {}),
    released: { messageIds: r.ids, toRunId: made.id },
  }).catch(() => {});
  // Their receipts follow the run that let them go: it didn't answer, and no longer waits.
  for (const messageId of r.ids)
    await publishChannelEvent(deps.pubsub, {
      type: "message.handled",
      channelId: run.channelId,
      messageId,
      agentId: run.agentId,
      runId: made.id,
      status: "done",
      passed: true,
    });
  const note = await postClosedNote(deps, made, r.closed).catch(() => null);
  await tellClosed(deps, made, r, note, null);
  return true;
}

const CLOSED_TEXT: Record<ClosedNote["reason"], (name: string) => string> = {
  solved: (name) => `I didn't answer: ${name} already took care of it.`,
  withdrawn: (name) => `I didn't answer: ${name} said it's no longer needed.`,
  task_canceled: (name) => `I didn't answer: ${name} canceled the task.`,
  mixed: () => "I didn't answer: what was asked here was already handled.",
};

/**
 * A closed note where the run had none of its own to say it on (it waited on its computer, its note went on with later
 * turns, or it let only some asks go): where the run answers, worded by the apps from `usageWait.closed`.
 */
async function postClosedNote(deps: ParkedDeps, run: AgentRun, closed: ClosedNote) {
  const note = await insertMessage(deps.db, {
    orgId: run.orgId,
    channelId: run.channelId,
    threadId: replyThreadOf(run),
    author: { type: "agent", agentId: run.agentId, runId: null, hop: run.hop, stretchId: run.stretchId },
    body: CLOSED_TEXT[closed.reason](closed.who?.name ?? "someone"),
    meta: {
      bodyCode: CLOSED_NOTE_CODE,
      usageWait: { code: CLOSED_NOTE_CODE, runId: run.id, forUserId: closed.askers[0] ?? null, ended: true, closed },
    },
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(note));
  return note;
}

/** Who hears a close: the agent's owner, once per line (`waitKey`), and each asker credited to someone else. */
async function tellClosed(
  deps: ParkedDeps,
  run: AgentRun,
  r: Release,
  note: { id: string; threadId: string | null } | null,
  waitKey: string | null,
) {
  if (!note) return;
  const nd = { db: deps.db, pubsub: deps.pubsub };
  const at = { channelId: run.channelId, threadId: note.threadId, messageId: note.id };
  if (waitKey) {
    const agent = await getAgentCached(deps.db, run.orgId, run.agentId);
    await notifyCatchUpClosed(nd, {
      orgId: run.orgId,
      agentId: run.agentId,
      agentName: agent?.name ?? "",
      waitKey,
      askers: r.closed.askers,
      ...at,
    }).catch(() => {});
  }
  if (r.credits.length === 0) return;
  const channel = await getChannelCached(deps.db, run.orgId, run.channelId);
  const label = channel && channel.kind !== "dm" && channel.name ? `#${channel.name}` : null;
  for (const c of r.credits)
    await notifyCatchUpClosedAsker(nd, {
      orgId: run.orgId,
      userId: c.userId,
      agentId: run.agentId,
      runId: run.id,
      reason: c.reason,
      who: c.who,
      label,
      ...at,
    }).catch(() => {});
}

// ── Its own requests ─────────────────────────────────────────────────────────────────────────────────────────────

async function checkRequests(deps: ParkedDeps, judge: Judge, run: AgentRun, trigger: Message, agentName: string) {
  const { db } = deps;
  const t = transcriptOf(run);
  const waiting = new Set(
    (t.pending?.calls ?? []).flatMap((c) =>
      c.result ? [] : [c.questionId ?? c.secretRequestId ?? c.waitId ?? ""].filter(Boolean),
    ),
  );
  if (waiting.size === 0) return;
  const open = (await openRequestsOf(db, run.orgId, run.agentId, run.channelId)).filter(
    (r) => r.runId === run.id && waiting.has(r.id),
  );
  if (open.length === 0) return;
  const prior = t.requestTriage;
  if (prior && prior.calls >= TRIAGE_MAX_CALLS) return;
  const since = Math.min(...open.map((r) => r.createdAt.getTime()));
  const snapshot = await triageSnapshot(db, run, trigger, agentName, since);
  if (snapshot.posts.length === 0) return;
  if (prior && (snapshot.latest <= prior.seenThrough || Date.now() - prior.at < TRIAGE_REFRESH_MS)) return;
  const bar = await catchUpBar(db, run.orgId).catch(() => CATCH_UP_CLOSE_AT);
  const requests = open.map((r) => ({ id: r.id, kind: r.kind, what: r.what, at: r.createdAt }));
  const record = { at: Date.now(), calls: (prior?.calls ?? 0) + 1, seenThrough: snapshot.latest };
  await db
    .update(agentRuns)
    .set({
      transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{requestTriage}', ${JSON.stringify(record)}::jsonb)`,
    })
    .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, "waiting_input")));
  const answers = await askRequestTriage(judge, snapshot, requests, {
    orgId: run.orgId,
    agentId: run.agentId,
    runId: run.id,
  }).catch(() => null);
  if (!answers) return;
  for (const moot of requestDecision(answers, snapshot, requests, bar)) {
    const request = open.find((r) => r.id === moot.id);
    if (!request) continue;
    const given = request.kind === "question" ? "answered it" : "took care of it";
    const text = `Not needed anymore: ${moot.who.name} already ${given} here ("${cutText(moot.said, 300)}"). Your request was withdrawn quietly and nobody waits on it. Go on with that; if nothing is left to do or say, ${quietEnd(run)}.`;
    await withdrawMoot(deps, run, request, text, `${moot.who.name} already ${given}`).catch(() => false);
  }
}

/** How a run stays quiet: `pass` when it has the tool, else an empty turn (`policy.mayPass` ends it with no message). */
export const quietEnd = (run: Pick<AgentRun, "transcript">) =>
  transcriptOf(run).passListed ? "call `pass`" : "end your turn without writing anything";

/**
 * Withdraws a request of the run's that nobody needs to answer anymore (its need was met here, or the agent withdrew it
 * in another turn): its waiting call reads `text` instead of "nobody will answer" (`mootRequests`), and the run may
 * stay quiet after it (`requestMoot`). A person answering at the same moment wins: their answer is what the call reads,
 * and the run owes them one. False, with nothing withdrawn, when the run no longer waits.
 */
export async function withdrawMoot(
  deps: Pick<ParkedDeps, "db" | "pubsub">,
  run: Pick<AgentRun, "id" | "agentId">,
  request: { id: string; kind: "browser" | "desktop" | "secret" | "question" },
  text: string,
  reason: string | null,
) {
  const marked = await deps.db
    .update(agentRuns)
    .set({
      transcript: sql`jsonb_set(jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{mootRequests}',
        coalesce(${agentRuns.transcript}->'mootRequests', '{}'::jsonb) || jsonb_build_object(${request.id}::text, ${text}::text)),
        '{requestMoot}', 'true'::jsonb)`,
    })
    .where(
      and(
        eq(agentRuns.id, run.id),
        eq(agentRuns.status, "waiting_input"),
        // Still waiting on it: a run that stopped waiting on it and waits on something else still owes what it owed.
        sql`exists (select 1 from jsonb_array_elements(coalesce(${agentRuns.transcript}->'pending'->'calls', '[]'::jsonb)) c
          where jsonb_typeof(c->'result') is distinct from 'object'
            and coalesce(c->>'questionId', c->>'secretRequestId', c->>'waitId') = ${request.id})`,
      ),
    )
    .returning({ id: agentRuns.id });
  if (marked.length === 0) return false;
  const d = { db: deps.db, pubsub: deps.pubsub };
  if (request.kind === "question") return Boolean(await withdrawQuestion(d, run.agentId, request.id));
  if (request.kind === "secret") return Boolean(await withdrawSecretRequest(d, run.agentId, request.id));
  // Help on its screens: withdrawn as by the run itself (no "nobody will do it"), then resumed with what met it.
  if (!(await withdrawHandoff(d, request.id, run.id, reason))) return false;
  await resumeRunWithResult(deps.db, {
    runId: run.id,
    waitId: request.id,
    result: { content: text },
    waitingOnly: true,
  });
  return true;
}

// ── Other agents waiting on what a run answers ──────────────────────────────────────────────────────────────────

/** Another agent's run waiting on some of `handled` (as its trigger, or as messages that joined it). */
interface ParkedOn {
  run: AgentRun;
  name: string;
  handle: string;
  wait: ParkedWait;
}

/** Other agents' runs in this channel waiting (their plan, budget or computer) on some of the messages `handled`. */
async function parkedOn(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId">,
  handled: string[],
): Promise<ParkedOn[]> {
  if (handled.length === 0) return [];
  const list = `{${handled.join(",")}}`;
  const rows = await db
    .select({ run: agentRuns, name: agents.name, handle: agents.handle })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(
      and(
        eq(agentRuns.orgId, run.orgId),
        eq(agentRuns.channelId, run.channelId),
        sql`${agentRuns.agentId} <> ${run.agentId}::uuid`,
        eq(agentRuns.status, "waiting_input"),
        eq(agentRuns.background, false),
        sql`${agentRuns.workId} is null`,
        sql`(${agentRuns.waitingMachineId} is not null
          or ${agentRuns.transcript}->'waitingForBrain'->>'code' in ('plan_limit', 'budget', 'usage_pause'))`,
        sql`(${agentRuns.triggerMessageId} = any(${list}::uuid[]) or ${agentRuns.pendingMessageIds} && ${list}::uuid[])`,
      ),
    )
    .limit(10);
  return rows.flatMap((r) => {
    const wait = parkedWaitOf(r.run);
    return wait ? [{ run: r.run, name: r.name, handle: r.handle, wait }] : [];
  });
}

/** Why another agent waits, and when it is back when known, in the English the agents read. */
function waitWords(p: ParkedOn, now = Date.now()) {
  const back = Date.parse(transcriptOf(p.run).waitingForBrain?.resetsAt ?? "");
  const when = back > now ? ` (back ${fromNow(new Date(back), now)})` : "";
  if (p.wait === "plan") return `is waiting for its plan's limit to reset${when}`;
  if (p.wait === "budget") return `is waiting for its monthly budget to renew${when}`;
  if (p.wait === "queued") return "is in line for its computer";
  return "is waiting for its computer to come back";
}

/** What a run answers: its trigger, the messages waiting for it, and the root of the thread it answers in. */
const answeredBy = (run: Pick<AgentRun, "threadRootId" | "triggerMessageId" | "pendingMessageIds">) => [
  ...new Set([run.triggerMessageId, run.threadRootId, ...run.pendingMessageIds]),
];

/**
 * "# Also waiting on these messages": the other agents waiting (their plan, budget or computer) on what this run
 * answers, so it can let them go once it handled it (`release_waiting_agent`). Read only when another agent could hold
 * them: its trigger or its thread's root went into another agent's run or names another agent, or more joined this
 * run.
 */
export async function parkedOnBlock(
  db: Executor,
  run: Pick<
    AgentRun,
    "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "pendingMessageIds"
  >,
  trigger: Pick<Message, "meta" | "mentionedAgentIds">,
  root: Pick<Message, "meta" | "mentionedAgentIds"> | null = null,
  now = Date.now(),
): Promise<string | null> {
  const steered = [trigger, root].some((m) => stringsOf(m?.meta.steeredRunIds).some((id) => id !== run.id));
  const named = [trigger, root].some((m) => m?.mentionedAgentIds.some((id) => id !== run.agentId));
  if (!steered && !named && run.pendingMessageIds.length === 0) return null;
  const rows = await parkedOn(db, run, answeredBy(run));
  if (rows.length === 0) return null;
  return [
    "# Also waiting on these messages",
    ...rows.map((p) => `- ${p.name} (@${p.handle}) ${waitWords(p, now)}: it answers them when it is back.`),
    `Once you took care of what one of them waits to answer, release it with \`${RELEASE_TOOL}\` (the agent, and why): it won't answer it again later, and who asked can still ask it to.`,
  ].join("\n");
}

/** The messages a run answers (`answeredBy`), and the ones that joined it already read. */
async function handledBy(db: Executor, run: AgentRun) {
  const joined = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        // Joined it, so posted since it began: the channel's index reads only those, not the whole channel.
        gte(messages.createdAt, run.createdAt),
        sql`${messages.meta}->'steeredRunIds' ? ${run.id}::text`,
      ),
    )
    .limit(50);
  return [...new Set([...answeredBy(run), ...joined.map((m) => m.id)])];
}

/**
 * `release_waiting_agent`: an agent lets another go that waits (its plan, budget or computer) to answer a message it
 * handled, so that one doesn't answer it again later. Any agent in the conversation may; only what still waits is let
 * go (`releaseAsks`), with the same closed note and "Responder mesmo assim" as a closed catch-up. Always listed: one
 * definition every run shares, and no read before a model call.
 */
export function createReleaseAsksToolSource(deps: { pubsub?: PubSub } = {}): ToolSource {
  const tool: ToolDefinition = {
    name: RELEASE_TOOL,
    description: `Let another agent go that waits (on its plan, its budget or its computer) to answer a message you handled, so it doesn't answer it again later: only when "# Also waiting on these messages" lists it and you took care of what it waits to answer. Give the agent (@handle or name) and a short reason. Only what still waits is released: nothing running stops, and who asked can still ask it to answer.`,
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", minLength: 1, maxLength: 200 },
        reason: { type: "string", minLength: 1, maxLength: 300, description: "What you did about it, short." },
      },
      required: ["agent", "reason"],
      additionalProperties: false,
    },
    describe: () => ({ title: "Release a waiting agent" }),
    async execute(input, ctx) {
      const named = String(input.agent ?? "")
        .trim()
        .replace(/^@/, "")
        .toLowerCase();
      const [me] = await ctx.db.select().from(agentRuns).where(eq(agentRuns.id, ctx.runId));
      if (!me) return { content: "This run isn't known anymore: nothing was released.", isError: true };
      const handled = await handledBy(ctx.db, me);
      const found = (await parkedOn(ctx.db, me, handled)).filter(
        (p) => p.handle.toLowerCase() === named || p.name.toLowerCase() === named,
      );
      if (found.length === 0)
        return {
          content: `No agent called "${String(input.agent)}" waits on the messages you handled here: nothing to release.`,
        };
      const caller = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
      const who = { name: caller?.name ?? "Another agent", agentId: ctx.agentId };
      const reason = cutText(String(input.reason ?? "").trim(), 300);
      let released = 0;
      for (const p of found) {
        const held = [p.run.triggerMessageId, ...p.run.pendingMessageIds].filter((id) => handled.includes(id));
        // People's asks only: another agent's may be a consultation it waits to hear back on.
        const asks = await ctx.db
          .select({ id: messages.id, userId: messages.authorUserId })
          .from(messages)
          .where(and(eq(messages.orgId, ctx.orgId), inArray(messages.id, held), eq(messages.authorType, "person")));
        const ids = asks.map((a) => a.id);
        if (ids.length === 0) continue;
        const askers = [...new Set(asks.flatMap((a) => (a.userId ? [a.userId] : [])))];
        const prior = transcriptOf(p.run).catchUpTriage;
        const ok = await releaseAsks({ db: ctx.db, pubsub: deps.pubsub }, p.run, {
          ids,
          closed: { reason: "solved", who, askers, at: new Date().toISOString() },
          record: {
            at: Date.now(),
            outcome: "closed",
            calls: prior?.calls ?? 0,
            askers: askers.map((userId) => ({
              userId,
              p: { needs_agent: 0, solved: 1, not_needed: 0 },
              reason: "solved" as const,
            })),
            releasedBy: ctx.agentId,
          },
          credits: askers.map((userId) => ({ userId, reason: "solved" as const, who: who.name })),
        });
        if (ok) {
          released++;
          await addRunStep(ctx.db, p.run, "context", { releasedBy: { agentId: ctx.agentId, reason } }).catch(() => {});
        }
      }
      if (released === 0)
        return {
          content:
            "Nothing was released: it just moved on (it's answering now, or it already ended), or it waits only on what another agent asked, which it answers itself.",
        };
      const name = found[0]?.name ?? String(input.agent);
      return {
        content: `Released: ${name} won't answer it later. Its note says you took care of it, and who asked can still ask it to answer.`,
        data: { released },
      };
    },
  };
  return { name: "release-asks", tools: async (ctx) => (ctx.background ? [] : [tool]) };
}
