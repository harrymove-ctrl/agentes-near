import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import { textOf } from "@agenteschat/providers";
import { announceAgentStatus } from "./agent-status";
import { executesHere, RUN_STALE_MS } from "./cancel";
import { onConsultedRunFinished } from "./consultations";
import { ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import type { Transcript } from "./executor";
import { getMessage, insertMessage, messageView } from "./messages";
import { enqueue } from "./outbox";
import { closeRoutineRun } from "./routine-ledger";
import { releaseInbox } from "./run-inbox";
import { revokeRunToolTokens } from "./run-tool-tokens";
import {
  type AgentRun,
  addRunStep,
  INTERRUPTED_BY_RESTART,
  replyThreadOf,
  runErrorDetail,
  shownStatusSql,
  transitionRun,
} from "./runs";
import { cancelSecretRequests, publishSecret, syncSecretMessage } from "./secrets";
import { USAGE_WAIT_CODES } from "./usage-pause";
import { endWork } from "./works";

const { agentRuns, agentRunSteps, outbox, channels, approvals } = schema;

/** A run is resumed at most this many times after a dead worker; then it fails. */
const MAX_RECOVERIES = 2;
/**
 * A run dead longer than this fails with the notice instead of resuming. A restart's runs are swept within minutes,
 * and a long outage's resume as they were; past this, work went on without the run (another may have done its task
 * since), so taking it up again could repeat what was done.
 */
export const RESUME_MAX_AGE_MS = 6 * 60 * 60_000;

type StoredTranscript = {
  messages?: { role: string; content: Parameters<typeof textOf>[0] }[];
  postedUpTo?: number;
};

/** When the run's worker last said it was alive. */
const lastBeat = sql`coalesce(${agentRuns.heartbeatAt}, ${agentRuns.startedAt}, ${agentRuns.updatedAt})`;

/** The sweep's clock: a run whose last beat is older than `cutoff` has no live worker. */
type SweepTime = { now: Date; cutoff: Date };

/**
 * Finds runs whose worker died (a deploy or a crash: no heartbeat for
 * `RUN_STALE_MS`) and recovers them. Called on boot and every minute.
 * - Running, between steps (no tool call cut in half): resumed in a new job
 *   from the saved transcript. A computer brain's turn is sent again as cut
 *   off, with what it was asked and the tools it already ran.
 * - Running with a tool call cut in half (it may have had effects), or
 *   recovered too often: failed with "Interrupted by a server restart";
 *   what the agent wrote so far is posted (a routine's background run
 *   posts nothing: its ledger fails with `interrupted`); the app hears it.
 * - Queued with no job left: its job is enqueued again.
 * A worker that picks a run up beats first, and the sweep takes a run only while its beat is still old (`claimStale`),
 * never one this process executes: two sweeps never both take a run, nor a sweep one whose worker beats.
 */
export async function recoverStaleRuns(
  deps: { db: Database; pubsub?: PubSub },
  options: { now?: Date; staleMs?: number; onError?: (runId: string, error: unknown) => void } = {},
): Promise<{ resumed: string[]; failed: string[]; requeued: string[] }> {
  const { db } = deps;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.staleMs ?? RUN_STALE_MS));
  const at: SweepTime = { now, cutoff };
  const out = { resumed: [] as string[], failed: [] as string[], requeued: [] as string[] };
  const liveJob = sql`exists (select 1 from ${outbox} o where o.kind = 'agent_run.execute'
      and o.payload->>'runId' = ${agentRuns.id}::text
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until > ${now.toISOString()}::timestamptz)))`;

  // Running with no heartbeat: its worker is gone even if the job's lease hasn't expired yet. A pending job runs it
  // when due, so it keeps the sweep away, but not one for a single wait for the computer: that one does nothing to a
  // running run.
  const stale = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "running"),
        sql`${lastBeat} < ${cutoff.toISOString()}::timestamptz`,
        sql`not exists (select 1 from ${outbox} o where o.kind = 'agent_run.execute'
          and o.payload->>'runId' = ${agentRuns.id}::text and o.status = 'pending' and o.payload->>'wait' is null)`,
      ),
    )
    .orderBy(asc(agentRuns.createdAt))
    .limit(100);
  for (const run of stale) {
    // Its executor is alive in this process: a beat that didn't get through (the database was away) is no death.
    if (executesHere(run.id)) continue;
    // One run that can't be recovered never holds back the others: the next sweep tries it again.
    try {
      const steps = await db
        .select({ kind: agentRunSteps.kind, data: agentRunSteps.data })
        .from(agentRunSteps)
        .where(eq(agentRunSteps.runId, run.id))
        .orderBy(desc(agentRunSteps.seq))
        .limit(500);
      const recovered = steps.filter((s) => s.kind === "error" && s.data.reason === "recovered").length;
      const results = new Set(steps.filter((s) => s.kind === "tool_result").map((s) => String(s.data.toolUseId)));
      const cutTool = steps.some((s) => s.kind === "tool_call" && !results.has(String(s.data.toolUseId)));
      const beat = run.heartbeatAt ?? run.startedAt ?? run.updatedAt;
      const recent = now.getTime() - beat.getTime() < RESUME_MAX_AGE_MS;
      if (!cutTool && recent && recovered < MAX_RECOVERIES && run.transcript) {
        if (await resume(db, run, at, ranSinceLastCall(steps))) out.resumed.push(run.id);
      } else if (await failInterrupted(deps, run, at)) {
        out.failed.push(run.id);
      }
    } catch (error) {
      options.onError?.(run.id, error);
    }
  }

  // Queued long ago with no job to run it (lost): enqueue it again.
  const lost = await db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "queued"),
        sql`${agentRuns.createdAt} < ${cutoff.toISOString()}::timestamptz`,
        sql`not ${liveJob}`,
      ),
    )
    .limit(100);
  for (const run of lost) {
    await enqueue(db, {
      orgId: run.orgId,
      kind: "agent_run.execute",
      payload: { runId: run.id },
      dedupeKey: `agent_run.execute:${run.id}:requeue:${now.getTime()}`,
      maxAttempts: 4,
    });
    out.requeued.push(run.id);
  }
  // Waiting on its plan or budget past its time with no job left to wake it (that job failed or was lost): it would
  // wait forever, and Rotinas and the agent's status would say so. Woken now; still limited, it parks again.
  const overdue = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      waitId: sql<string>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "waiting_input"),
        inArray(sql<string>`${agentRuns.transcript}->'waitingForBrain'->>'code'`, [...USAGE_WAIT_CODES]),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'waitId' is not null`,
        sql`(${agentRuns.transcript}->'waitingForBrain'->>'until')::timestamptz < ${cutoff.toISOString()}::timestamptz`,
        sql`not ${liveJob}`,
      ),
    )
    .limit(100);
  for (const run of overdue) {
    await enqueue(db, {
      orgId: run.orgId,
      kind: "agent_run.execute",
      payload: { runId: run.id, wait: run.waitId },
      dedupeKey: `agent_run.execute:${run.id}:overdue:${run.waitId}:${now.getTime()}`,
      maxAttempts: 4,
    });
    out.requeued.push(run.id);
  }
  return out;
}

/** A computer brain's run (Claude Code, Codex): its turns hold bridge tokens. Older rows tell by their session. */
const thinksOnComputer = (run: Pick<AgentRun, "brain" | "brainSessionId">) =>
  run.brain ? run.brain !== "model" : Boolean(run.brainSessionId);

/** The tools that ran since the run's last model call (its steps, newest first): what a cut computer turn did. */
function ranSinceLastCall(steps: { kind: string; data: Record<string, unknown> }[]) {
  const names: string[] = [];
  for (const s of steps) {
    if (s.kind === "model_call") break;
    if (s.kind === "tool_result" && s.data.isError !== true && typeof s.data.name === "string")
      names.unshift(s.data.name);
  }
  return [...new Set(names)];
}

/**
 * Takes a stale run for this sweep, in the caller's transaction: still running and its beat still old. One
 * statement, so another sweep, or a worker that picked the run up meanwhile (it beats first), keeps it instead.
 */
async function claimStale(tx: Executor, runId: string, at: SweepTime) {
  const [claimed] = await tx
    .update(agentRuns)
    .set({ heartbeatAt: at.now })
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(agentRuns.status, "running"),
        sql`${lastBeat} < ${at.cutoff.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: agentRuns.id });
  return Boolean(claimed);
}

/**
 * Hands the run to a new job: the executor continues from the transcript. False when the run was taken first
 * (`claimStale`).
 */
async function resume(db: Database, run: AgentRun, at: SweepTime, ran: string[]) {
  return db.transaction(async (tx) => {
    if (!(await claimStale(tx, run.id, at))) return false;
    if (thinksOnComputer(run)) {
      // The orphaned turn may still run on the computer: its tokens die now, so it can't keep calling our
      // tools while the turn is sent again (with a new token).
      await revokeRunToolTokens(tx, { runId: run.id });
      // Sent again as a turn cut off, with what it was asked and what already ran in it: the request itself again
      // would be done twice.
      const t = run.transcript as unknown as Transcript;
      const prev = t.interruptedTurn;
      const turn: Transcript["interruptedTurn"] = {
        prompt: prev?.prompt ?? t.turnPrompt ?? (await getMessage(tx, run.orgId, run.triggerMessageId))?.body ?? "",
        executed: [...new Set([...(prev?.executed ?? []), ...ran])],
        drops: prev?.drops ?? 0,
        cause: "restart",
      };
      await tx
        .update(agentRuns)
        .set({
          transcript: sql`jsonb_set(${agentRuns.transcript}, '{interruptedTurn}', ${JSON.stringify(turn)}::jsonb)`,
        })
        .where(eq(agentRuns.id, run.id));
    }
    // Its jobs end, so a worker that still holds one finds it gone at pickup, and one new job goes on with it. Never
    // a job for one wait for the computer: it would find the run running and do nothing.
    await tx
      .update(outbox)
      .set({ status: "failed", lockedUntil: null, lastError: "its worker stopped: the run went on in a new job" })
      .where(
        and(
          eq(outbox.kind, "agent_run.execute"),
          sql`${outbox.payload}->>'runId' = ${run.id}`,
          eq(outbox.status, "processing"),
        ),
      );
    await enqueue(tx, {
      orgId: run.orgId,
      kind: "agent_run.execute",
      payload: { runId: run.id },
      dedupeKey: `agent_run.execute:${run.id}:recover:${at.now.getTime()}`,
      maxAttempts: 4,
    });
    await addRunStep(tx, run, "error", { reason: "recovered", message: "worker stopped; resumed from the last step" });
    return true;
  });
}

/** Ends the run as failed, keeps what it wrote, and tells the channel (so the live row goes away). */
async function failInterrupted(deps: { db: Database; pubsub?: PubSub }, run: AgentRun, at: SweepTime) {
  const { db } = deps;
  const threadId = replyThreadOf(run);
  const t = (run.transcript ?? {}) as StoredTranscript;
  const said = (t.messages ?? [])
    .slice(t.postedUpTo ?? 0)
    .filter((m) => m.role === "assistant")
    .map((m) => textOf(m.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const note = `_${INTERRUPTED_BY_RESTART}. Ask again to continue._`;
  const result = await db.transaction(async (tx) => {
    if (!(await claimStale(tx, run.id, at))) return null;
    const failed = await transitionRun(tx, run.id, "running", "failed", { error: INTERRUPTED_BY_RESTART });
    if (!failed) return null;
    // A running run's open requests mostly come from the step that was cut, whose cards were never posted: nobody can
    // answer them. A secret's card may be up, though (a run with two asks, one already answered): it says so at once.
    await tx
      .update(approvals)
      .set({ status: "canceled", decidedAt: at.now })
      .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending")));
    const closedSecrets = await cancelSecretRequests(tx, run.id);
    for (const row of closedSecrets) await syncSecretMessage(tx, row);
    // A routine's background run never posts by itself (ADR 0053 §5): its ledger says it was cut off.
    const post = (thread: string | null) =>
      insertMessage(tx, {
        orgId: run.orgId,
        channelId: run.channelId,
        threadId: thread,
        author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
        body: said ? `${said}\n\n${note}` : note,
        // `text`: what the agent wrote; the app explains the interruption in the person's language.
        meta: { interrupted: { reason: "deploy", text: said } },
      });
    let message: Awaited<ReturnType<typeof post>> | null = null;
    if (!run.background) {
      try {
        message = await post(threadId);
      } catch (error) {
        // Its thread is gone, or no longer a thread of this channel: the notice goes to the channel itself. The
        // refusal is the insert finding no row, no statement error, so the transaction goes on.
        if (!(error instanceof ValidationError) || !threadId) throw error;
        message = await post(null);
      }
    }
    if (message) await tx.update(agentRuns).set({ replyMessageId: message.id }).where(eq(agentRuns.id, run.id));
    await addRunStep(tx, run, "error", { reason: "interrupted", message: INTERRUPTED_BY_RESTART });
    // Its job is done for good.
    await tx
      .update(outbox)
      .set({ status: "failed", lockedUntil: null, lastError: INTERRUPTED_BY_RESTART })
      .where(
        and(
          eq(outbox.kind, "agent_run.execute"),
          sql`${outbox.payload}->>'runId' = ${run.id}`,
          inArray(outbox.status, ["pending", "processing"]),
        ),
      );
    return { message, closedSecrets };
  });
  if (!result) return false;
  for (const row of result.closedSecrets) await publishSecret(deps, row, "secret.updated");
  if (run.background) {
    await closeRoutineRun(deps, run, { status: "failed", code: "interrupted" }).catch(() => null);
  }
  const where = { channelId: run.channelId, threadId, agentId: run.agentId, runId: run.id };
  const bg = run.background ? { background: true as const } : {};
  if (deps.pubsub && result.message) await publishMessageCreated(deps.pubsub, messageView(result.message));
  // Its worker died: its line went with the heartbeat already (ADR 0084 §11); the apps refresh now.
  await announceAgentStatus(deps.pubsub, run.orgId, run.agentId).catch(() => {});
  await publishChannelEvent(deps.pubsub, {
    type: "agent.run",
    ...where,
    ...bg,
    status: "failed",
    error: INTERRUPTED_BY_RESTART,
    ...runErrorDetail(INTERRUPTED_BY_RESTART),
  });
  await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where, ...bg });
  await publishChannelEvent(deps.pubsub, {
    type: "run.finished",
    ...where,
    ...bg,
    status: "failed",
    error: INTERRUPTED_BY_RESTART,
    ...runErrorDetail(INTERRUPTED_BY_RESTART),
  });
  await publishChannelEvent(deps.pubsub, {
    type: "message.handled",
    channelId: run.channelId,
    messageId: run.triggerMessageId,
    agentId: run.agentId,
    runId: run.id,
    status: "failed",
  });
  // It was answering another agent: the asker hears it now instead of waiting for the question to expire.
  await onConsultedRunFinished({ db, pubsub: deps.pubsub }, run, "failed", INTERRUPTED_BY_RESTART).catch(() => {});
  // A work ends before the release, which would drop a reply turn's own message passed on to it (`endWork` keeps it).
  if (run.workId) {
    const [ended] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    if (ended) await endWork(deps, ended, "failed").catch(() => null);
  }
  // What was sent to it and not read gets a run of its own.
  await releaseInbox(db, deps.pubsub, run, { reason: "interrupted" }).catch(() => null);
  return true;
}

/** Runs still active in a channel, for the app to reconcile its live rows on load and reconnect. */
export async function activeRunsIn(db: Database, orgId: string, channelId: string) {
  const rows = rowsOf<{
    id: string;
    agent_id: string;
    status: AgentRun["status"];
    thread_root_id: string;
    trigger_message_id: string;
    started_at: string | Date | null;
    heartbeat_at: string | Date | null;
    working_since: string | Date | null;
    created_at: string | Date;
    kind: string;
    pending: string[] | string | null;
    background: boolean | string;
  }>(
    // Asking its computer from the line (`computerWaitOf`) it still waits: no "thinking" row for the ask.
    await db.execute(sql`select r.id, r.agent_id, ${shownStatusSql} as status, r.thread_root_id, r.trigger_message_id, r.started_at,
        r.heartbeat_at, r.working_since, r.created_at, c.kind, array_to_json(r.pending_message_ids) as pending,
        (r.background or r.work_id is not null) as background
      from ${agentRuns} r join ${channels} c on c.id = r.channel_id
      where r.org_id = ${orgId}::uuid and r.channel_id = ${channelId}::uuid
        and r.status in ('queued', 'running', 'waiting_approval', 'waiting_input')
      order by r.created_at`),
  );
  const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
  const now = Date.now();
  return rows.map((r) => ({
    runId: r.id,
    agentId: r.agent_id,
    channelId,
    status: r.status,
    threadId: r.kind === "dm" && r.thread_root_id === r.trigger_message_id ? null : r.thread_root_id,
    triggerMessageId: r.trigger_message_id,
    startedAt: iso(r.started_at),
    heartbeatAt: iso(r.heartbeat_at),
    createdAt: iso(r.created_at) as string,
    // How long the work it is doing now has taken (`agent_runs.working_since`, else since it was created), as a
    // length and not a time: the app counts on from it by its own clock, whatever that clock says.
    workingMs: Math.max(0, now - new Date(r.working_since ?? r.created_at).getTime()),
    // Sent while it works and not read yet ("lê na próxima pausa"); the rest it already read.
    pendingMessageIds: pendingIds(r.pending),
    // A routine's work, or long work (ADR 0121): it holds no conversation's working row.
    background: r.background === true || r.background === "t",
  }));
}

/** `array_to_json(uuid[])`: parsed by the driver, or still text. */
export const pendingIds = (v: string[] | string | null): string[] =>
  Array.isArray(v) ? v : typeof v === "string" ? (JSON.parse(v) as string[]) : [];
