import { and, asc, type Database, type Executor, eq, lt, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { decodeCursor, encodeCursor } from "./cursor";
import { ValidationError } from "./errors";
import type { WakeWhy } from "./machine-wake";

/**
 * The operator API's events feed (ADR 0056 §5): what happened on this instance, for the operator's own
 * services to pull. Metadata only: ids, counts, domains and where a sign-in came from, never what anyone
 * wrote (no message, prompt, subject or file).
 */

const { operatorEvents, agentRunSteps, users, accounts } = schema;

let enabled = false;

/** Off unless the server turns it on with the operator API (`OPERATOR_API_TOKEN`): a self-host records nothing. */
export function enableOperatorEvents(on = true) {
  enabled = on;
}

export type OperatorEventType =
  | "user.signed_up"
  | "session.created"
  | "user.deletion_requested"
  | "user.deletion_canceled"
  | "user.deleted"
  | "organization.created"
  | "organization.deletion_requested"
  | "organization.deletion_canceled"
  | "organization.deleted"
  | "invitation.created"
  | "agent.created"
  | "agent.deleted"
  | "mail.sent"
  | "run.finished"
  | "run.hop_limit"
  | "task.finished"
  | "desktop_control.ended"
  | "content.viewed"
  | "platform_ai.threshold"
  | "account.failure"
  | "machine.wake_wanted";

export interface OperatorEvent {
  type: OperatorEventType;
  orgId?: string | null;
  /** The person the event is about or who acted. */
  userId?: string | null;
  data?: Record<string, unknown> | SQL;
}

/** Days an event is kept: the operator's services copy what they need well before. */
export const OPERATOR_EVENTS_KEEP_DAYS = 90;
export const OPERATOR_EVENTS_PAGE_MAX = 1000;
const USER_AGENT_CHARS = 512;

const insertEvents = (db: Executor, events: OperatorEvent[]) =>
  db
    .insert(operatorEvents)
    .values(
      events.map((e) => ({ type: e.type, orgId: e.orgId ?? null, userId: e.userId ?? null, data: e.data ?? {} })),
    );

/** Appends events while they are on, in the caller's transaction when given one (so they commit with it). */
export async function recordOperatorEvent(db: Executor, ...events: OperatorEvent[]) {
  if (enabled && events.length > 0) await insertEvents(db, events);
}

/** `content.viewed`, whether events are on or not: content never leaves through the operator API without it. */
export async function recordContentViewed(
  db: Executor,
  view: { orgId: string; ref: string; reason: string; operator: string },
) {
  const { orgId, ...data } = view;
  await insertEvents(db, [{ type: "content.viewed", orgId, data }]);
}

/** `user.signed_up`, from a new sign-in method: the account's first one is its sign-up, later ones are links. */
export async function recordSignUp(db: Database, account: { userId: string; providerId: string }) {
  if (!enabled) return;
  const methods = sql`(select count(*) from ${accounts} where ${accounts.userId} = ${account.userId})`;
  const [user] = await db
    .select({ email: users.email, methods: methods.mapWith(Number) })
    .from(users)
    .where(eq(users.id, account.userId));
  if (user?.methods !== 1) return;
  await recordOperatorEvent(db, {
    type: "user.signed_up",
    userId: account.userId,
    data: { email: user.email, method: account.providerId === "credential" ? "email" : account.providerId },
  });
}

/** `session.created`: where a sign-in came from. */
export const recordSession = (
  db: Executor,
  session: { userId: string; ipAddress?: string | null; userAgent?: string | null },
) =>
  recordOperatorEvent(db, {
    type: "session.created",
    userId: session.userId,
    data: { ip: session.ipAddress ?? null, userAgent: session.userAgent?.slice(0, USER_AGENT_CHARS) ?? null },
  });

/**
 * `run.finished`, in the transaction that ended the run (`transitionRun`). `failure`, only on a failed one: a stable
 * code (never the error's text) and the provider's cause, if any.
 */
export async function recordRunFinished(
  db: Executor,
  run: Pick<typeof schema.agentRuns.$inferSelect, "id" | "orgId" | "agentId" | "brain" | "status">,
  failure?: { code: string | null; cause: string | null },
) {
  if (!enabled) return;
  const toolCalls = sql`(select count(*)::int from ${agentRunSteps}
    where ${agentRunSteps.runId} = ${run.id} and ${agentRunSteps.kind} = 'tool_call')`;
  const failed = failure
    ? sql` || jsonb_build_object('failure', jsonb_build_object('code', ${failure.code}::text, 'cause', ${failure.cause}::text))`
    : sql``;
  await recordOperatorEvent(db, {
    type: "run.finished",
    orgId: run.orgId,
    data: sql`jsonb_build_object('runId', ${run.id}::text, 'agentId', ${run.agentId}::text,
      'brain', ${run.brain}::text, 'status', ${run.status}::text, 'toolCalls', ${toolCalls})${failed}`,
  });
}

/** One `account.failure` per account and cause in this long. */
export const ACCOUNT_FAILURE_EVERY_MS = 10 * 60_000;
// ponytail: per process; each replica writes its own at most every 10 minutes. A shared table if that ever matters.
const accountFailureAt = new Map<string, number>();

/**
 * `account.failure`: a turn on a computer's AI account failed for a provider's reason (a refused sign-in, a limit,
 * a disabled account…). Metadata only, at most one per account and cause every `ACCOUNT_FAILURE_EVERY_MS`.
 */
export async function recordAccountFailure(
  db: Executor,
  failure: {
    orgId: string;
    accountId: string;
    machineId: string;
    kind: string;
    authMethod: string | null;
    cause: string;
    code: string;
    httpStatus?: number;
  },
  now = Date.now(),
) {
  if (!enabled) return;
  const key = `${failure.accountId}:${failure.cause}`;
  const last = accountFailureAt.get(key);
  if (last !== undefined && now - last < ACCOUNT_FAILURE_EVERY_MS) return;
  if (accountFailureAt.size >= 10_000) accountFailureAt.clear();
  accountFailureAt.set(key, now);
  const [machine] = await db
    .select({ runnerVersion: schema.machines.runnerVersion, protocol: schema.machines.protocol })
    .from(schema.machines)
    .where(eq(schema.machines.id, failure.machineId));
  const { orgId, httpStatus, ...data } = failure;
  await recordOperatorEvent(db, {
    type: "account.failure",
    orgId,
    data: {
      ...data,
      ...(httpStatus ? { httpStatus } : {}),
      ...(machine?.runnerVersion ? { runnerVersion: machine.runnerVersion } : {}),
      ...(machine ? { protocol: machine.protocol } : {}),
    },
  });
}

/** Tests: forgets which account failures were already told. */
export const resetAccountFailures = () => accountFailureAt.clear();

/** One `machine.wake_wanted` per computer in this long. */
export const WAKE_WANTED_EVERY_MS = 10_000;
// ponytail: per process; each replica tells at most every 10 seconds. A shared table if that ever matters.
const wakeWantedAt = new Map<string, number>();

/**
 * `machine.wake_wanted`: a run, a person looking at it or a request to it (`why`) wants the workspace's own computer
 * the operator put in standby (ADR 0161), at most once per computer every `WAKE_WANTED_EVERY_MS`.
 */
export async function recordWakeWanted(
  db: Executor,
  wake: { orgId: string; machineId: string; why: WakeWhy },
  now = Date.now(),
) {
  if (!enabled) return;
  const last = wakeWantedAt.get(wake.machineId);
  if (last !== undefined && now - last < WAKE_WANTED_EVERY_MS) return;
  if (wakeWantedAt.size >= 10_000) wakeWantedAt.clear();
  wakeWantedAt.set(wake.machineId, now);
  const { orgId, ...data } = wake;
  await recordOperatorEvent(db, { type: "machine.wake_wanted", orgId, data });
}

/** `task.finished`: a task on a computer ended (done, failed, canceled, or interrupted for good). */
export const recordTaskFinished = (
  db: Executor,
  task: Pick<typeof schema.machineTasks.$inferSelect, "id" | "orgId" | "agentId" | "executor" | "status">,
) =>
  recordOperatorEvent(db, {
    type: "task.finished",
    orgId: task.orgId,
    data: { taskId: task.id, agentId: task.agentId, executor: task.executor, status: task.status },
  });

const EventCursor = z.tuple([z.string().regex(/^\d{1,20}$/), z.uuid()]);

/** The first transaction id this database hasn't given out: none of its own rows is at or past it. */
const NEXT_XACT = sql`pg_snapshot_xmax(pg_current_snapshot())`;

async function pastNextXact(db: Executor, xactId: string) {
  const [row] = rowsOf<{ past: boolean }>(await db.execute(sql`select ${xactId}::xid8 >= ${NEXT_XACT} as past`));
  return row?.past === true;
}

/**
 * Events after `after` (the previous page's `next`), in commit order, at most `limit`. Only rows below the
 * commit horizon are served: every transaction that began before them has ended, so a row that commits
 * later always sorts after the cursor and paging never skips one. A long transaction anywhere on the
 * database holds the feed back until it ends; nothing is lost meanwhile.
 */
export async function listOperatorEvents(db: Database, query: { after?: string; limit: number }) {
  const after = query.after ? decodeCursor(query.after, EventCursor) : null;
  const rows = await db
    .select({
      id: operatorEvents.id,
      at: operatorEvents.createdAt,
      type: operatorEvents.type,
      orgId: operatorEvents.orgId,
      userId: operatorEvents.userId,
      data: operatorEvents.data,
      xactId: operatorEvents.xactId,
    })
    .from(operatorEvents)
    .where(
      and(
        sql`${operatorEvents.xactId} < pg_snapshot_xmin(pg_current_snapshot())`,
        after
          ? sql`(${operatorEvents.xactId}, ${operatorEvents.id}) > (${after[0]}::xid8, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(operatorEvents.xactId), asc(operatorEvents.id))
    .limit(Math.min(query.limit, OPERATOR_EVENTS_PAGE_MAX));
  const last = rows.at(-1);
  // Only an empty page can come from a cursor past every id this database gave out: one from before it
  // was restored from a dump, which numbers transactions anew. Kept, it would never see a new event.
  if (!last && after && (await pastNextXact(db, after[0]))) {
    throw new ValidationError(
      "This cursor is from before the database was restored: start again without `after`",
      "stale_cursor",
    );
  }
  return {
    events: rows.map(({ xactId: _, ...event }) => event),
    // An empty page keeps the caller's place.
    next: last ? encodeCursor([last.xactId, last.id]) : (query.after ?? null),
  };
}

/**
 * Rows a restore from a dump brought along sort past every transaction id of the restored database, so
 * the commit horizon would hold them back until its counter got there: they go first instead, by id.
 * Returns how many (none but right after such a restore).
 */
export async function adoptRestoredOperatorEvents(db: Executor): Promise<number> {
  const moved = await db
    .update(operatorEvents)
    .set({ xactId: sql`'0'::xid8` })
    .where(sql`${operatorEvents.xactId} >= ${NEXT_XACT}`)
    .returning({ id: operatorEvents.id });
  return moved.length;
}

/** Deletes events older than `days`; returns how many. */
export async function pruneOperatorEvents(db: Executor, days = OPERATOR_EVENTS_KEEP_DAYS): Promise<number> {
  const deleted = await db
    .delete(operatorEvents)
    .where(lt(operatorEvents.createdAt, new Date(Date.now() - days * 86_400_000)))
    .returning({ id: operatorEvents.id });
  return deleted.length;
}
