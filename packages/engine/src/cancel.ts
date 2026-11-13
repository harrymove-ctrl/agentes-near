import { DESKTOP_PROTOCOL, type PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gte, inArray, schema, sql } from "@agenteschat/db";
import { announceAgentStatus } from "./agent-status";
import { recordAudit } from "./audit";
import { personOfMessage } from "./authority";
import { lineMachineOf, publishQueueChanged } from "./computer-queue";
import { INBOX_JOB } from "./dispatch";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent } from "./events";
import type { MachineHub } from "./machine-hub";
import { cancelOrgTasks, type TaskCall } from "./machine-tasks";
import { resolveQuestionNotifications } from "./notification-producers";
import { can, type Membership, requireActiveMembership } from "./organizations";
import { type AgentQuestionRow, publishQuestion, syncQuestionMessage } from "./questions";
import { closeRoutineRun } from "./routine-ledger";
import { ACTIVE_RUN_STATUSES, releaseInbox } from "./run-inbox";
import { tellAgentStopped } from "./run-stopped";
import { isTerminal, type RunStatus, replyThreadOf, transitionRun } from "./runs";
import { cancelSecretRequests, publishSecret, type SecretRequestRow, syncSecretMessage } from "./secrets";
import { standingErrorDetail } from "./standing";
import { endWork } from "./works";

const { agentRuns, agents, approvals, agentQuestions, outbox, messages, channels, machines } = schema;

/** Cross-instance: the worker running the run aborts it (LISTEN/NOTIFY with the Postgres pub/sub). */
export const RUN_CANCEL_TOPIC = "system:run-cancel";

/** How often a running run's worker says it is alive; after `RUN_STALE_MS` without it, the run is recovered. */
export const RUN_HEARTBEAT_MS = 20_000;
export const RUN_STALE_MS = 2 * 60_000;

/** Runs executing in this process, by id: canceling aborts the model stream, tools and code. */
const active = new Map<string, AbortController>();

export function registerRunAbort(runId: string) {
  const controller = new AbortController();
  active.set(runId, controller);
  return controller;
}

export function unregisterRunAbort(runId: string, controller: AbortController) {
  if (active.get(runId) !== controller) return;
  active.delete(runId);
  missedInterrupts.delete(runId);
}

/** Aborts the run if it executes here. */
export function abortLocalRun(runId: string) {
  const controller = active.get(runId);
  if (!controller) return false;
  controller.abort(new Error("run canceled"));
  return true;
}

/** Abort reason when the server shuts down: the run is checkpointed and resumed elsewhere, not canceled. */
export const SHUTDOWN_REASON = "server_shutdown";
export const isShutdown = (reason: unknown) => reason === SHUTDOWN_REASON;

/**
 * Thrown inside a run interrupted by shutdown: the outbox hands its job back (`handback`), due at once and without
 * spending an attempt, and the next instance continues from the saved transcript.
 */
export class RunInterruptedError extends Error {
  readonly handback = true;
  constructor() {
    super("run interrupted by a server shutdown; it resumes from its last checkpoint");
    this.name = "RunInterruptedError";
  }
}

/** How many runs this process is executing. */
export const activeRunCount = () => active.size;

/** Whether this process is executing the run. */
export const executesHere = (runId: string) => active.has(runId);

/** Graceful shutdown: waits up to `ms` for runs to finish, then interrupts the rest (they resume elsewhere). */
export async function drainLocalRuns(ms: number, options: { graceMs?: number } = {}) {
  const deadline = Date.now() + ms;
  while (active.size > 0 && Date.now() < deadline) await Bun.sleep(100);
  const interrupted = [...active.keys()];
  for (const controller of active.values()) controller.abort(SHUTDOWN_REASON);
  // Give them a moment to checkpoint and hand the job back.
  const grace = Date.now() + (options.graceMs ?? 5_000);
  while (active.size > 0 && Date.now() < grace) await Bun.sleep(50);
  return interrupted;
}

/** Cross-instance: "stop and send" (`steer: "now"`) cuts the run's current model call short; the run goes on. */
export const RUN_INTERRUPT_TOPIC = "system:run-interrupt";

/**
 * The model call in flight of each run executing here: aborting it ends only
 * that turn (its text so far is kept), never the run nor a tool that runs.
 * `hasRead`: whether the run already read that message (then there is nothing to interrupt for).
 */
const turns = new Map<string, { controller: AbortController; hasRead(messageId: string): boolean }>();

/**
 * "Stop and send" for a run executing here while no model call is registered (a tool runs, or the loop is
 * between taking the steering and starting the next call): the next call checks them when it registers,
 * so a message that landed just after the steering was taken still cuts that call short.
 */
const missedInterrupts = new Map<string, Set<string>>();

/**
 * The next model call of the run. Already aborted if an interrupt came in between for a message the run
 * hasn't read (the caller then reads it before calling the model).
 */
export function registerTurnAbort(runId: string, hasRead: (messageId: string) => boolean) {
  const controller = new AbortController();
  turns.set(runId, { controller, hasRead });
  const missed = missedInterrupts.get(runId);
  if (missed) {
    missedInterrupts.delete(runId);
    if ([...missed].some((id) => !hasRead(id))) controller.abort(new Error("turn interrupted"));
  }
  return controller;
}

export function unregisterTurnAbort(runId: string, controller: AbortController) {
  if (turns.get(runId)?.controller === controller) turns.delete(runId);
}

/** Aborts the run's current model call if it runs here and hasn't read `messageId` yet. */
export function interruptLocalTurn(runId: string, messageId: string) {
  const turn = turns.get(runId);
  if (!turn) {
    // Executing here between two model calls: the next one checks it (read by then, nothing is cut).
    if (!active.has(runId)) return false;
    const missed = missedInterrupts.get(runId) ?? new Set<string>();
    missed.add(messageId);
    missedInterrupts.set(runId, missed);
    return true;
  }
  if (turn.controller.signal.aborted || turn.hasRead(messageId)) return false;
  turn.controller.abort(new Error("turn interrupted"));
  return true;
}

/**
 * A person asked the run to stop and read their message now: the instance
 * executing it aborts the current model call, and the loop reads the message
 * right away. Between calls (a tool runs, it waits for a person) nothing is
 * cut: the message is read at the next step, as any other.
 */
export async function interruptRun(pubsub: PubSub | undefined, runId: string, messageId: string) {
  if (interruptLocalTurn(runId, messageId)) return;
  if (pubsub) await pubsub.publish(RUN_INTERRUPT_TOPIC, { type: "run.interrupt", runId, messageId }).catch(() => {});
}

/** Each worker process listens, so a cancel (or an interrupt) reaches the instance that runs it. */
export function listenForRunCancels(pubsub: PubSub) {
  const offCancel = pubsub.subscribe(RUN_CANCEL_TOPIC, (event) => {
    if (typeof event.runId === "string") abortLocalRun(event.runId);
  });
  const offInterrupt = pubsub.subscribe(RUN_INTERRUPT_TOPIC, (event) => {
    if (typeof event.runId === "string" && typeof event.messageId === "string")
      interruptLocalTurn(event.runId, event.messageId);
  });
  return () => {
    offCancel();
    offInterrupt();
  };
}

/**
 * Who asked for the run: the trigger's author, or, for a run that continues a stopped one or one at its step
 * limit (its trigger is that reply), who pressed "Continuar".
 */
const continuedBy = sql`coalesce(${messages.meta}->'canceled'->>'continuedByUserId',
  ${messages.meta}->'stepLimit'->>'continuedByUserId')`;
export const runRequester = sql<string | null>`coalesce(${messages.authorUserId}, ${continuedBy})`;

/**
 * Who may stop a run, continue it, or start it again ("Responder agora"): who asked for it (`runRequester`), the
 * person behind its work (a run another agent woke works for them too, ADR 0089), the agent's owner, or an admin.
 */
export async function mayStopRun(
  db: Executor,
  userId: string,
  membership: Membership,
  row: { run: { orgId: string; triggerMessageId: string }; requester: string | null; ownerUserId: string | null },
) {
  if (row.requester === userId || row.ownerUserId === userId || can(membership, "manage_agents")) return true;
  return (await personOfMessage(db, row.run.orgId, row.run.triggerMessageId)) === userId;
}

export { canceledBy } from "./runs";

/**
 * Stops an agent's run (`POST …/runs/{runId}/cancel`), for who may (`mayStopRun`).
 * - Queued: it never starts (its job is dropped).
 * - Waiting for an approval or an answer: it ends; the approval or question is canceled.
 * - Running: the worker aborts the model stream (usage so far is recorded),
 *   stops before the next tool, kills running code, and posts what the agent
 *   wrote so far with "Stopped by …".
 * The UI hears `run.canceled` at once. Audited. Messages sent to it that it hasn't read get a run
 * of their own (`releaseInbox`), except `stopMessageId`: the message that asked it to stop.
 */
export async function cancelRun(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  runId: string,
  /** `chain`: what the run asked of other agents stops with it, all the way down (`stopHelpers`). */
  options: { stopMessageId?: string; reason?: string; tell?: boolean; chain?: boolean } = {},
): Promise<{ id: string; status: RunStatus; previousStatus: RunStatus }> {
  const { db } = deps;
  const membership = await requireActiveMembership(db, userId, orgId);
  const [row] = await db
    .select({
      run: agentRuns,
      ownerUserId: agents.ownerUserId,
      requester: runRequester,
      channelKind: channels.kind,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .leftJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!row) throw new NotFoundError("Run not found");
  if (!(await mayStopRun(db, userId, membership, row)))
    throw new ForbiddenError("Only who asked, the agent's owner or an admin can stop it", "run.cancel_forbidden");

  // Loaded here: consultations stop their runs through this module.
  const helpers = options.chain
    ? await (await import("./consultations")).stopHelpers(deps, userId, orgId, runId, options.reason)
    : [];
  // It ended as the person pressed stop, but what it asked was still on: that stopped, and its agent reads so.
  if (helpers.length > 0 && isTerminal(row.run.status)) {
    await tellAgentStopped(deps, row.run, row.run.status, userId, options.reason, helpers).catch(() => null);
    return { id: row.run.id, status: row.run.status, previousStatus: row.run.status };
  }
  // The agent's owner or an admin decides for the whole conversation; who asked, only for what they sent.
  const forAll = row.ownerUserId === userId || can(membership, "manage_agents");
  const stopped = await stopRun(
    deps,
    orgId,
    row.run,
    row.channelKind,
    { type: "person", id: userId },
    {
      ...options,
      forAll,
    },
  );
  // The agent is told (ADR 0128), unless the stop came with a message to it ("Parar e mandar": that message says it)
  // or the agent stopped it itself on a person's word (`tell: false`).
  if (!options.stopMessageId && options.tell !== false) {
    await tellAgentStopped(deps, row.run, stopped.previousStatus, userId, options.reason, helpers).catch(() => null);
  }
  // Its usage note's "Don't run it" speaks for every turn that note took in, each for who may stop it.
  for (const id of stopped.joined ?? []) await cancelRun(deps, userId, orgId, id, { tell: false }).catch(() => null);
  return stopped;
}

/**
 * Ends a run that hasn't finished: its pending approvals, questions and
 * secret requests close, its queued jobs are dropped, the worker running it
 * aborts, and the app hears it stopped. `actor`: the person who stopped it,
 * or the system (a consultation nobody waits for anymore, ADR 0034).
 * Its unread messages are handed on, and an agent whose question it answered
 * hears it couldn't: by the worker executing it once it has posted the stop
 * (it may restart from a "Parar e mandar"), else here.
 */
export async function stopRun(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  start: typeof agentRuns.$inferSelect,
  channelKind: string | null,
  actor: { type: "person"; id: string } | { type: "system"; reason: string },
  /** `forAll`: the person stops a conversation's catch-up for everyone in it (the agent's owner, an admin). */
  options: { stopMessageId?: string; forAll?: boolean } = {},
): Promise<{ id: string; status: RunStatus; previousStatus: RunStatus; joined?: string[] }> {
  const { db } = deps;
  const error = actor.type === "person" ? `canceled_by:${actor.id}` : actor.reason;
  let run = start;
  let previous: RunStatus = run.status;
  let line: string | null = null;
  for (let attempt = 0; ; attempt++) {
    if (isTerminal(run.status)) throw new ConflictError("This task already ended", "run_finished");
    previous = run.status;
    line = lineMachineOf(run);
    const status = run.status;
    let closedSecrets: SecretRequestRow[] = [];
    let closedQuestions: AgentQuestionRow[] = [];
    const done = await db.transaction(async (tx) => {
      const moved = await transitionRun(tx, run.id, status, "canceled", { error });
      if (!moved) return null;
      // The "stop" itself needs no answer: it never gets a run of its own.
      if (options.stopMessageId) {
        await tx
          .update(agentRuns)
          .set({ pendingMessageIds: sql`array_remove(${agentRuns.pendingMessageIds}, ${options.stopMessageId}::uuid)` })
          .where(eq(agentRuns.id, run.id));
      }
      const now = new Date();
      await tx
        .update(approvals)
        .set({ status: "canceled", decidedAt: now })
        .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending")));
      // Their cards close too, or "Responder" would stay offered on a question nobody can answer anymore.
      closedQuestions = await tx
        .update(agentQuestions)
        .set({ status: "canceled" })
        .where(and(eq(agentQuestions.runId, run.id), eq(agentQuestions.status, "open")))
        .returning();
      for (const q of closedQuestions) await syncQuestionMessage(tx, q);
      // Its secret requests close too; each terminal row queues runner key cleanup.
      closedSecrets = await cancelSecretRequests(tx, run.id);
      for (const r of closedSecrets) await syncSecretMessage(tx, r);
      // Jobs of this run that haven't started never will.
      await tx
        .delete(outbox)
        .where(
          and(
            eq(outbox.kind, "agent_run.execute"),
            eq(outbox.status, "pending"),
            sql`${outbox.payload}->>'runId' = ${run.id}`,
          ),
        );
      await recordAudit(tx, {
        orgId,
        actor: actor.type === "person" ? actor : { type: "system", id: null },
        action: "run.canceled",
        target: { type: "agent_run", id: run.id },
        details: { agentId: run.agentId, from: status, ...(actor.type === "system" ? { reason: actor.reason } : {}) },
      });
      return moved;
    });
    if (done) {
      run = done;
      for (const r of closedSecrets) await publishSecret(deps, r, "secret.updated");
      for (const q of closedQuestions) {
        await publishQuestion(deps.pubsub, q, "question.answered");
        // Out of everyone's inbox too: a question nobody can answer any more never waits on a person.
        await resolveQuestionNotifications(deps, orgId, q.id).catch(() => {});
      }
      break;
    }
    if (attempt >= 3) throw new ConflictError("This task changed state. Try again.", "run.state_changed");
    const [fresh] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    if (!fresh) throw new NotFoundError("Run not found");
    run = fresh;
  }

  // The worker running it (here or on another instance) aborts and posts what was written.
  abortLocalRun(run.id);
  if (deps.pubsub) await deps.pubsub.publish(RUN_CANCEL_TOPIC, { type: "run.cancel", runId: run.id }).catch(() => {});
  // Waiting on its plan or budget: its note or card says it won't run when the limit is back.
  const wait = (run.transcript as { waitingForBrain?: { code?: string; waitKey?: string } } | null)?.waitingForBrain;
  let joined: string[] = [];
  /**
   * A conversation's catch-up a person said not to run: what they sent it goes with it (`all`: everything it took in,
   * when the agent's owner or an admin said so). Someone else's ask that joined it still gets its answer.
   */
  let dropped: "all" | string[] = [];
  if (previous === "waiting_input" && wait?.code) {
    // Loaded here: the usage pause checks who may stop a run through this module.
    const { USAGE_WAIT_CODES, lineHeadLooks, usageNoteHandOn, usageWaitCanceled } = await import("./usage-pause");
    if (USAGE_WAIT_CODES.has(wait.code)) {
      if (actor.type === "person") {
        joined = (await usageWaitCanceled(deps, run).catch(() => null)) ?? [];
        if (wait.code !== "usage_pause") {
          dropped = options.forAll
            ? "all"
            : run.pendingMessageIds.length === 0
              ? []
              : (
                  await db
                    .select({ id: messages.id })
                    .from(messages)
                    .where(
                      and(
                        eq(messages.orgId, orgId),
                        inArray(messages.id, run.pendingMessageIds),
                        eq(messages.authorUserId, actor.id),
                      ),
                    )
                ).map((m) => m.id);
        }
      } else {
        // Stopped by the system: the turns its note took in still wait, so the note speaks on for them.
        const reason = actor.reason === "agent_archived" ? "archived" : undefined;
        await usageNoteHandOn(deps, run, reason ? { reason } : {}).catch(() => null);
      }
      if (wait.waitKey) await lineHeadLooks(db, orgId, wait.waitKey).catch(() => null);
    }
  }
  // Long work (ADR 0121): its end goes home now ("Parado por …"), whoever runs it; the card goes back to A fazer.
  if (run.workId) await endWork(deps, run, "canceled").catch(() => null);
  // A routine's background run is stopped quietly (ADR 0053 §6.7): nothing in a conversation, its ledger
  // ends `canceled` with who stopped it. Any other stop of it (a pause, a delete, the next slot) is closed
  // by whoever stopped it, with its own reason.
  if (run.background && actor.type === "person") {
    await closeRoutineRun(deps, run, { status: "canceled", code: "stopped", byUserId: actor.id }).catch(() => null);
  }
  // The app drops "pensando…" right away.
  const where = {
    channelId: run.channelId,
    threadId: replyThreadOf(run),
    agentId: run.agentId,
    runId: run.id,
  };
  const bg = run.background ? { background: true as const } : {};
  if (actor.type === "person" && !run.background)
    await publishChannelEvent(deps.pubsub, { type: "run.canceled", ...where, byUserId: actor.id });
  await publishChannelEvent(deps.pubsub, { type: "agent.run", ...where, ...bg, status: "canceled" });
  // Its line ends with the run (ADR 0084 §11).
  await announceAgentStatus(deps.pubsub, run.orgId, run.agentId).catch(() => {});
  if (line) await publishQueueChanged(deps.pubsub, run.orgId, line);
  if (previous !== "running" && run.background) {
    await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where, ...bg });
    await publishChannelEvent(deps.pubsub, { type: "run.finished", ...where, ...bg, status: "canceled" });
  } else if (previous !== "running") {
    // Nobody is executing it: finish it for the app here.
    await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where });
    const passed = run.startedAt ? {} : { passed: true as const };
    await publishChannelEvent(deps.pubsub, { type: "run.finished", ...where, status: "canceled", ...passed });
    await publishChannelEvent(deps.pubsub, {
      type: "message.handled",
      channelId: run.channelId,
      messageId: run.triggerMessageId,
      agentId: run.agentId,
      runId: run.id,
      status: "canceled",
      ...passed,
    });
    // It may have been answering another agent's question (ADR 0034): the asker hears it couldn't now, not when
    // the question expires. A running one is heard from its worker, once (`executor.ts`); a run its workspace
    // stopped hands nothing on.
    if ((channelKind === "dm" || channelKind === "task") && !standingErrorDetail(error)) {
      // Loaded here: consultations stop their runs through this module.
      const { onConsultedRunStopped } = await import("./consultations");
      await onConsultedRunStopped(deps, run, error).catch(() => null);
    }
    // Nobody executes it: what was sent to it and not read gets a run of its own now, unless its workspace
    // or its agent's end stopped it (that run would only fail too), or a person said not to run its catch-up.
    if (!standingErrorDetail(error) && dropped !== "all" && error !== "agent_archived") {
      const exclude = [...(options.stopMessageId ? [options.stopMessageId] : []), ...dropped];
      await releaseInbox(db, deps.pubsub, run, { reason: "canceled", ...(exclude.length ? { exclude } : {}) }).catch(
        () => null,
      );
    }
  }
  return { id: run.id, status: run.status, previousStatus: previous, ...(joined.length ? { joined } : {}) };
}

/**
 * Ends what a closed workspace's agents (or, with `agentId`, an agent being deleted) still have going: every run
 * not finished stops with `reason` (the refusal's text, or `agent_archived`) and hands nothing on, a routine's run
 * closes under `code`, its computers stop its tasks, and its agents' desktops end with whatever runs on them
 * (nothing else stops a desktop: they stay on).
 */
export async function stopOrgWork(
  deps: { db: Database; pubsub?: PubSub; hub?: Pick<MachineHub, "call"> },
  orgId: string,
  reason: string,
  code: "org_suspended" | "org_deleting" | "deleted" = "org_suspended",
  agentId?: string,
) {
  const live = await deps.db
    .select({ run: agentRuns, channelKind: channels.kind })
    .from(agentRuns)
    .leftJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        agentId ? eq(agentRuns.agentId, agentId) : undefined,
      ),
    );
  // Wakes still waiting outside any run (ADR 0032 "Calm wakes") never start.
  await deps.db
    .delete(outbox)
    .where(
      and(
        eq(outbox.orgId, orgId),
        eq(outbox.kind, INBOX_JOB),
        eq(outbox.status, "pending"),
        agentId ? sql`${outbox.payload}->>'agentId' = ${agentId}` : undefined,
      ),
    );
  for (const { run, channelKind } of live) {
    await stopRun(deps, orgId, run, channelKind, { type: "system", reason }).catch(() => null);
    // A routine's run: its ledger says why (`stopRun` closes it only for a person).
    if (run.background) {
      await closeRoutineRun(deps, run, { status: "canceled", code }).catch(() => null);
    }
  }
  const { hub } = deps;
  // A computer that doesn't answer soon can't hold up the caller: its tasks end here instead.
  const call: TaskCall | undefined = hub
    ? (machineId, request) => hub.call(machineId, request, { timeoutMs: 15_000 })
    : undefined;
  await cancelOrgTasks({ db: deps.db, pubsub: deps.pubsub, call }, orgId, "system", agentId);
  if (!hub) return;
  const desktops = await deps.db
    .select({ id: agents.id, handle: agents.handle, name: agents.name, machineId: machines.id })
    .from(agents)
    .innerJoin(machines, eq(machines.id, agents.machineId))
    .where(
      and(
        eq(agents.orgId, orgId),
        gte(machines.protocol, DESKTOP_PROTOCOL),
        agentId ? eq(agents.id, agentId) : undefined,
      ),
    );
  await Promise.all(
    desktops.map(({ machineId, ...agent }) =>
      hub.call(machineId, { op: "desktop.session.stop", agent }, { timeoutMs: 15_000 }).catch(() => null),
    ),
  );
}
