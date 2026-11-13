import { randomUUID } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import type { SteerMessage, SteerReply } from "./brains/types";
import { attachedLine, taskNotice } from "./context";
import { publishChannelEvent } from "./events";
import { ACTIVE_RUN_STATUSES, releaseInbox } from "./run-inbox";
import type { AgentRun } from "./runs";

const { agentRuns, messages, users, agents } = schema;

/**
 * Live steering: a person's message reaches a computer brain's turn in
 * progress (Claude Code reads it at its next tool boundary, Codex on its
 * app-server at its next model request) instead of waiting for the whole CLI
 * turn to end.
 *
 * - `deliverLive` (any instance) asks the instance executing the run, over
 *   pub/sub (`steerTopic`), and waits a moment for its answer.
 * - That instance's executor listens for the whole run (`listenLiveSteering`).
 *   While a computer turn that can take messages is in flight (the brain
 *   handed `BrainIO.steerable`), it takes the run's inbox, renders the
 *   messages exactly as the loop does between turns, and hands them to the
 *   turn, each with its own `uuid` (`agent.run.delivered`, "Ada recebeu").
 * - The turn says which it read (`steer_read`): those join the transcript
 *   (`agent.run.read`, a context step). At the turn's end the ones it never
 *   confirmed go back to the inbox, so the loop reads them with the next turn:
 *   never lost, never read twice.
 * - No such turn (the model brain, a turn between steps, an older runner or
 *   CLI, Codex run as `codex exec`): the messages stay in the inbox and
 *   `deliverLive` is false.
 * - A turn that becomes steerable takes what waited in the inbox at once, and
 *   one whose CLI is still starting (`no_turn`: Claude Code before its init,
 *   Codex before its thread) is asked again every `LIVE_STEER_RETRY_MS`, so a
 *   message sent in a turn's first seconds doesn't wait for the whole turn.
 */

/** Cross-instance: the instance executing the run hands it a message now (if its turn can take one). */
export const steerTopic = (runId: string) => `run-steer:${runId}`;
const steerReplyTopic = (requestId: string) => `run-steer-reply:${requestId}`;

/** How long `deliverLive` waits for the executing instance (no answer: nobody can take it now). */
export const LIVE_STEER_WAIT_MS = 3000;

/** A turn whose CLI is still starting is asked again this often, at most `LIVE_STEER_RETRIES` times. */
export const LIVE_STEER_RETRY_MS = 1000;
const LIVE_STEER_RETRIES = 30;

/**
 * Live delivery to a computer brain mid-turn (Claude Code reads a message at
 * its next tool boundary). Returns true when the message was handed to the
 * turn in progress (its read is confirmed later, `agent.run.read`); false
 * leaves it for the run's next step, as before.
 */
export async function deliverLive(
  deps: { db: Database; pubsub: PubSub; waitMs?: number },
  run: AgentRun,
  input: { messageId: string; urgent: boolean },
): Promise<boolean> {
  if (run.status !== "running") return false;
  const requestId = randomUUID();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const end = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(delivered);
    };
    const off = deps.pubsub.subscribe(steerReplyTopic(requestId), (e) => end(e.delivered === true));
    const timer = setTimeout(() => end(false), deps.waitMs ?? LIVE_STEER_WAIT_MS);
    deps.pubsub
      .publish(steerTopic(run.id), {
        type: "run.steer",
        runId: run.id,
        requestId,
        messageId: input.messageId,
        ...(input.urgent ? { urgent: true } : {}),
      })
      .catch(() => end(false));
  });
}

/**
 * The executing side before its listener (`listenLiveSteering`) exists: from the claim on, this instance answers
 * "no turn" at once, so a person's send never waits `LIVE_STEER_WAIT_MS` while the run is still starting. Only an
 * instance that owns the run may answer: another one running it would race this false against its true.
 */
export function answerNoTurn(pubsub: PubSub, runId: string): () => void {
  return pubsub.subscribe(steerTopic(runId), (e) => {
    if (e.type !== "run.steer" || typeof e.requestId !== "string") return;
    pubsub.publish(steerReplyTopic(e.requestId), { type: "run.steer.reply", delivered: false }).catch(() => {});
  });
}

/** A message taken from the inbox, as the run reads it. */
export interface SteeredText {
  id: string;
  text: string;
}

/**
 * What a background work reads under a message passed on to it with `steer_work` (`meta.steeredWorkIds`): only its
 * asker's reach it (`steerWork`, `workTakesPersonMessage`).
 */
export const PASSED_ON_NOTE =
  "This is now part of your work: do what it asks before you finish, and say in your report what you did with it, or why not.";

/**
 * Messages people (or events) sent while the run worked, oldest first, as the
 * agent reads them: "[New message from Ada, while you were working]: …", or
 * the notice a task or event carries. Deleted ones are left out. `beforeStart`:
 * read before its first model call (the rest of a burst, `waitForBurst`), they
 * are plain conversation lines, "[Ada]: …", part of the same request. `workId`:
 * the reading run's own background work, which reads what was passed on to it
 * as part of its job.
 */
export async function renderSteered(
  db: Executor,
  orgId: string,
  ids: string[],
  options: { beforeStart?: boolean; workId?: string | null } = {},
): Promise<SteeredText[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      meta: messages.meta,
      name: sql<string | null>`coalesce(${users.name}, ${agents.name})`,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(eq(messages.orgId, orgId), inArray(messages.id, ids), isNull(messages.deletedAt)));
  // Messages written in one transaction share its time (a report's notices): their ids keep the order.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  return rows.map((m) => {
    const name = m.name ?? "someone";
    const works = m.meta.steeredWorkIds;
    const passedOn = Boolean(options.workId) && Array.isArray(works) && works.includes(options.workId);
    const line = passedOn
      ? `[New message from ${name}, passed on to your background work, while you were working]: ${m.body}`
      : options.beforeStart
        ? `[${name}]: ${m.body}`
        : `[New message from ${name}, while you were working]: ${m.body}`;
    return {
      id: m.id,
      // A background task that ended while it worked: the notice with its result.
      text:
        taskNotice({ body: m.body, meta: m.meta }, true) ??
        `${line}${attachedLine(m)}${passedOn ? `\n${PASSED_ON_NOTE}` : ""}`,
    };
  });
}

/** The run fields `releaseInbox` needs. */
type InboxRun = Pick<
  AgentRun,
  "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "trigger"
>;

/**
 * Puts taken messages back at the front of the run's inbox (read with its next step). A run that
 * ended meanwhile (stopped while its turn ran) hands them on at once, as every ending does.
 */
export async function returnToInbox(db: Database, pubsub: PubSub | undefined, run: InboxRun, ids: string[]) {
  if (ids.length === 0) return;
  const list = sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
  const [row] = await db
    .update(agentRuns)
    .set({ pendingMessageIds: sql`${list} || ${agentRuns.pendingMessageIds}` })
    .where(eq(agentRuns.id, run.id))
    .returning({ status: agentRuns.status });
  if (row && !(ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status)) {
    await releaseInbox(db, pubsub, run, { reason: "interrupted" });
  }
}

type Steer = (messages: SteerMessage[]) => Promise<SteerReply>;

export interface LiveSteeringHooks {
  /** Takes the run's inbox (the loop's own: the same messages are never taken twice). */
  take(): Promise<string[]>;
  /** The background work the run is now (`renderSteered`): it may move there mid-turn. */
  workId?(): string | null;
  /** Handed to the turn (not read yet): a "stop and send" for them has nothing more to do. */
  onHanded?(ids: string[]): void;
  /** Back in the inbox (never confirmed read). */
  onReturned?(ids: string[]): void;
  /** The turn read these (oldest first): they join the conversation. */
  onRead(read: SteeredText[]): Promise<void> | void;
}

export interface LiveSteering {
  /** `BrainIO.steerable`: the turn in flight can take messages (null: it ended). */
  steerable(steer: Steer | null): void;
  /** `steer_read` from the turn. */
  read(uuids: string[]): void;
  /** The turn ended: no more handoffs; what it never confirmed goes back to the inbox. Returns those ids. */
  endTurn(): Promise<string[]>;
  /** The run is done here. */
  close(): void;
}

/**
 * The executing side, for one run: answers `deliverLive` requests while the
 * run executes here (false at once when no turn can take a message).
 */
export function listenLiveSteering(
  deps: { db: Database; pubsub: PubSub; retryMs?: number },
  run: InboxRun,
  threadId: string | null,
  hooks: LiveSteeringHooks,
): LiveSteering {
  const where = { channelId: run.channelId, threadId, agentId: run.agentId, runId: run.id };
  let steer: Steer | null = null;
  /** This turn can't take messages (an older CLI): not asked again until the next turn. */
  let refused = false;
  /** Handed to the turn in flight and not confirmed yet, by uuid. */
  const handed = new Map<string, SteeredText>();
  let chain: Promise<unknown> = Promise.resolve();
  const reads = new Set<Promise<unknown>>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  const stopRetry = () => {
    clearTimeout(retry);
    retry = undefined;
  };

  /**
   * Hands the run's inbox to `turn` while it is still the turn in flight. `messageId`: the one a send asks
   * about (true when it was handed); null flushes whatever waits.
   */
  const deliver = async (turn: Steer | null, messageId: string | null, urgent: boolean): Promise<boolean> => {
    if (messageId && [...handed.values()].some((h) => h.id === messageId)) return true;
    if (!turn || turn !== steer || refused) return false;
    const ids = await hooks.take();
    if (ids.length === 0) return false;
    const rows = await renderSteered(deps.db, run.orgId, ids, { workId: hooks.workId?.() ?? null });
    if (rows.length === 0) return false;
    const sent = rows.map((r) => ({ row: r, uuid: randomUUID() }));
    const reply = await turn(
      sent.map(({ row, uuid }) => ({ uuid, text: row.text, ...(urgent && row.id === messageId ? { urgent } : {}) })),
    ).catch((): SteerReply => ({ status: "no_turn" }));
    const ok = new Set(reply.status === "accepted" ? reply.accepted : []);
    if (reply.status === "unsupported") refused = true;
    const back = sent.filter((s) => !ok.has(s.uuid)).map((s) => s.row.id);
    const taken = sent.filter((s) => ok.has(s.uuid));
    for (const s of taken) handed.set(s.uuid, s.row);
    // Deleted meanwhile (not rendered): dropped, as the loop drops them.
    await returnToInbox(deps.db, deps.pubsub, run, back);
    if (back.length) hooks.onReturned?.(back);
    if (reply.status === "no_turn" && back.length) retryLater(turn);
    if (taken.length === 0) return false;
    const takenIds = taken.map((s) => s.row.id);
    hooks.onHanded?.(takenIds);
    await publishChannelEvent(deps.pubsub, { type: "agent.run.delivered", ...where, messageIds: takenIds });
    return messageId !== null && takenIds.includes(messageId);
  };

  // One at a time: each takes the inbox whole.
  const flush = (turn: Steer) => {
    chain = chain.then(() => deliver(turn, null, false)).catch(() => {});
  };
  const retryLater = (turn: Steer) => {
    if (retry || turn !== steer || retries >= LIVE_STEER_RETRIES) return;
    retries++;
    retry = setTimeout(() => {
      retry = undefined;
      flush(turn);
    }, deps.retryMs ?? LIVE_STEER_RETRY_MS);
  };

  const off = deps.pubsub.subscribe(steerTopic(run.id), (e) => {
    if (e.type !== "run.steer" || typeof e.requestId !== "string" || typeof e.messageId !== "string") return;
    const { requestId, messageId } = e;
    const urgent = e.urgent === true;
    const next = chain.then(async () => {
      const delivered = await deliver(steer, messageId, urgent).catch(() => false);
      await deps.pubsub.publish(steerReplyTopic(requestId), { type: "run.steer.reply", delivered }).catch(() => {});
    });
    chain = next.catch(() => {});
  });

  return {
    steerable(next) {
      if (next !== steer) {
        stopRetry();
        retries = 0;
      }
      steer = next;
      if (next) {
        refused = false;
        flush(next);
      }
    },
    read(uuids) {
      const rows = uuids.flatMap((u) => {
        const row = handed.get(u);
        handed.delete(u);
        return row ? [row] : [];
      });
      if (rows.length === 0) return;
      const done = Promise.resolve(hooks.onRead(rows))
        .then(() =>
          publishChannelEvent(deps.pubsub, { type: "agent.run.read", ...where, messageIds: rows.map((r) => r.id) }),
        )
        .catch(() => {});
      reads.add(done);
      done.finally(() => reads.delete(done));
    },
    async endTurn() {
      steer = null;
      stopRetry();
      await chain;
      await Promise.all([...reads]);
      const left = [...handed.values()].map((r) => r.id);
      handed.clear();
      await returnToInbox(deps.db, deps.pubsub, run, left).catch(() => {});
      if (left.length) hooks.onReturned?.(left);
      return left;
    },
    close() {
      steer = null;
      stopRetry();
      off();
    },
  };
}
