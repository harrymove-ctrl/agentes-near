import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, gte, inArray, isNull, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { runAuthority } from "./authority";
import { getChannelCached } from "./context";
import type { ContextDeps } from "./context/summaries";
import { deliverNotice, publishDelivery } from "./delivery";
import { eligibleChannelAgents } from "./dispatch";
import { isAgentOnlyDm } from "./dms";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { cutMarked, cutText } from "./format";
import { linkIssueToWork, setWorkIssueState } from "./issues";
import { deliverLive, renderSteered } from "./live-steer";
import { messageLink } from "./message-links";
import { insertMessage, type Message, messageView, replyExcerpt } from "./messages";
import { missionOfThread } from "./missions";
import { enqueue } from "./outbox";
import { lineLocale } from "./requester";
import { personCanPost } from "./routine-state";
import { ACTIVE_RUN_STATUSES, passedOnTo } from "./run-inbox";
import { deliverNoticeToRun } from "./run-resume";
import { type AgentRun, continuableEnd, isTerminal, replyThreadOf, runErrorDetail } from "./runs";
import { runStretchOf } from "./stretch";
import { ago, stepLine } from "./talker-snapshot";
import { nameConversation } from "./thread-assess";
import { maskCredentials } from "./tool-detail";

const { agentQuestions, agentRunSteps, agentWorks, agentRuns, messages, threadFollows, users } = schema;

export type WorkRow = typeof agentWorks.$inferSelect;
export type WorkPlanItem = schema.WorkPlanItem;
export type WorkStatus = "queued" | "live" | "done" | "failed" | "canceled";

/**
 * Long work (ADR 0121): the run that is already working steps out of its conversation's slot, posts an anchor
 * ("Vou cuidar disso…") and keeps going, with updates in the anchor's thread and its report back where it was asked.
 */
export const WORK_LIMITS = {
  /** Live works per agent: they share its computer and browser. Past it the work waits in line. */
  perAgent: 3,
  sayMax: 280,
  updateMax: 500,
  titleMax: 80,
  planMax: 12,
  /** Between two updates, unless one is `important` (then at most one a minute). */
  minGapMs: 5 * 60_000,
  importantGapMs: 60_000,
  nextMin: 5,
  nextMax: 20,
  nextDefault: 10,
  /** A live work this old without a card gets one (§4). */
  cardAfterMs: 15 * 60_000,
  /** After the nudge, how long before the server posts the update itself. */
  graceMs: 3 * 60_000,
} as const;

/** The deterministic safety net (§1): a run still in the conversation after this much active time, or this many calls. */
export const WORK_AUTO_AFTER_MS = 4 * 60_000;
export const WORK_AUTO_AFTER_CALLS = 20;
/** The call count moves a run only after this much active time: many fast calls are still a quick answer. */
export const WORK_AUTO_MIN_MS = 90_000;

/** An API-model work run hands its job back after this long (the outbox lease ceiling is hours away). */
export const WORK_JOB_YIELD_MS = 60 * 60_000;

export const WORK_CHECK_IN_JOB = "agent_work.check_in";
export const WORK_FOLLOW_UP_JOB = "agent_work.follow_up";
export const WORK_IN_BACKGROUND_TOOL = "work_in_background";
export const POST_UPDATE_TOOL = "post_update";
export const STEER_WORK_TOOL = "steer_work";
export const STOP_WORK_TOOL = "stop_work";

let perOrgCap = 10;
/** The workspace's cap of live works (`AGENT_WORK_MAX_PER_ORG`), set once at boot. */
export const setWorkOrgCap = (n: number) => {
  perOrgCap = Math.max(1, Math.floor(n));
};

/** The executor of a run hears its move here (the tool may have run on another replica, through the bridge). */
export const workTopic = (runId: string) => `run-work:${runId}`;

/** Where a work's updates go: its anchor's own thread, or the thread the ask was in. */
export const updatesThreadOf = (w: Pick<WorkRow, "ownThread" | "anchorMessageId" | "homeThreadId">) =>
  w.ownThread ? w.anchorMessageId : w.homeThreadId;

const clampNext = (n: unknown) =>
  Math.min(
    WORK_LIMITS.nextMax,
    Math.max(
      WORK_LIMITS.nextMin,
      typeof n === "number" && Number.isFinite(n) ? Math.round(n) : WORK_LIMITS.nextDefault,
    ),
  );

/** One plain line: credentials masked, and no @handle, so an update never calls another agent or person in. */
const plainText = (s: unknown, max: number) =>
  cutText(
    maskCredentials(String(s ?? ""))
      .replace(/(^|[^\w@.])@(?=[a-zA-Z0-9])/g, "$1")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );

/** Moves and releases count live works against the caps one at a time per workspace (§7). */
const lockWorkCaps = (tx: Executor, orgId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-works:${orgId}`}))`);

/** A plan as the agent gave it: at most 12 steps of plain text, each with its state. */
export function cleanPlan(input: unknown): WorkPlanItem[] | null {
  if (!Array.isArray(input)) return null;
  const states = new Set(["todo", "doing", "done"]);
  return input.slice(0, WORK_LIMITS.planMax).flatMap((p, i) => {
    const item = typeof p === "string" ? { text: p } : (p as { id?: unknown; text?: unknown; state?: unknown });
    const text = plainText(item?.text, 140);
    if (!text) return [];
    const state = typeof item.state === "string" && states.has(item.state) ? item.state : "todo";
    const id = typeof item.id === "string" && item.id ? item.id.slice(0, 40) : `s${i + 1}`;
    return [{ id, text, state: state as WorkPlanItem["state"] }];
  });
}

/** What the apps draw for a work: its line under the anchor, its card's block and the agent's status. */
export interface WorkView {
  id: string;
  agentId: string;
  channelId: string;
  title: string;
  status: WorkStatus;
  /** While live, what its run does: works, waits on a person, its plan or its computer, or waits in line. */
  state: "working" | "waiting_approval" | "waiting_input" | "paused" | "waiting_computer" | "queued" | null;
  how: "agent" | "auto";
  anchorMessageId: string;
  /** Where its updates are (the anchor's thread, or the thread the ask was in). */
  threadId: string | null;
  homeThreadId: string | null;
  runId: string | null;
  requestedByUserId: string | null;
  startedAt: string;
  finishedAt: string | null;
  nextUpdateAt: string | null;
  lastUpdate: { text: string; at: string; seq: number } | null;
  /** Waiting on an answer: what its run asked (the first if it asked several), and the message that holds the card. */
  question: { text: string; messageId: string | null; requestedForUserId: string | null } | null;
  plan: WorkPlanItem[];
  issue: { id: string; number: number } | null;
  resultMessageId: string | null;
  /** Queued: its place in its agent's line (1 = next). */
  queuePosition: number | null;
  /** Paused on usage: when it goes on, when known. */
  pausedUntil: string | null;
  /** Stopped by a person: who. */
  canceledByUserId: string | null;
  errorCode: string | null;
}

/** Views of these works (by id), with their current runs' sub-states. */
export async function workViews(db: Executor, orgId: string, ids: string[]): Promise<Map<string, WorkView>> {
  const out = new Map<string, WorkView>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const rows = await db
    .select()
    .from(agentWorks)
    .where(and(eq(agentWorks.orgId, orgId), inArray(agentWorks.id, unique)));
  if (rows.length === 0) return out;
  const runs = await db
    .select({
      id: agentRuns.id,
      workId: agentRuns.workId,
      status: agentRuns.status,
      error: agentRuns.error,
      waitingMachineId: agentRuns.waitingMachineId,
      code: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'code'`,
      until: sql<
        string | null
      >`coalesce(${agentRuns.transcript}->'waitingForBrain'->>'resetsAt', ${agentRuns.transcript}->'waitingForBrain'->>'until')`,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(
          agentRuns.workId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(desc(agentRuns.createdAt));
  const asking = runs.filter((r) => r.status === "waiting_input" && !r.code && !r.waitingMachineId).map((r) => r.id);
  const questions = asking.length
    ? await db
        .select({
          runId: agentQuestions.runId,
          channelId: agentQuestions.channelId,
          text: agentQuestions.text,
          messageId: agentQuestions.messageId,
          requestedForUserId: agentQuestions.requestedForUserId,
        })
        .from(agentQuestions)
        .where(
          and(
            eq(agentQuestions.orgId, orgId),
            inArray(agentQuestions.runId, asking),
            eq(agentQuestions.status, "open"),
          ),
        )
        .orderBy(asc(agentQuestions.createdAt))
    : [];
  const queued = rows.filter((r) => r.status === "queued");
  const lines = queued.length
    ? await db
        .select({ id: agentWorks.id, agentId: agentWorks.agentId })
        .from(agentWorks)
        .where(
          and(
            eq(agentWorks.orgId, orgId),
            eq(agentWorks.status, "queued"),
            inArray(agentWorks.agentId, [...new Set(queued.map((q) => q.agentId))]),
          ),
        )
        .orderBy(asc(agentWorks.createdAt), asc(agentWorks.id))
    : [];
  const issueIds = rows.flatMap((r) => (r.issueId ? [r.issueId] : []));
  const numbers = issueIds.length
    ? new Map(
        (
          await db
            .select({ id: schema.issues.id, number: schema.issues.number })
            .from(schema.issues)
            .where(inArray(schema.issues.id, issueIds))
        ).map((i) => [i.id, i.number]),
      )
    : new Map<string, number>();
  // A run that ended `done` with a work that didn't finish (out of steps, stuck, cut off) says why on its report.
  const reportIds = rows.flatMap((r) => (r.status === "failed" && r.resultMessageId ? [r.resultMessageId] : []));
  const reportCodes = reportIds.length
    ? new Map(
        (
          await db
            .select({ id: messages.id, code: sql<string | null>`${messages.meta}->'workEnd'->>'errorCode'` })
            .from(messages)
            .where(and(eq(messages.orgId, orgId), inArray(messages.id, reportIds)))
        ).map((m) => [m.id, m.code]),
      )
    : new Map<string, string | null>();
  for (const w of rows) {
    const run = runs.find((r) => r.workId === w.id);
    const status = w.status as WorkStatus;
    let state: WorkView["state"] = null;
    if (status === "queued") state = "queued";
    else if (status === "live" && run) {
      if (run.status === "waiting_approval") state = "waiting_approval";
      else if (run.status === "waiting_input") {
        state =
          run.code === "work_queue"
            ? "queued"
            : run.code === "usage_pause" || run.code === "plan_limit" || run.code === "budget"
              ? "paused"
              : run.waitingMachineId || run.code
                ? "waiting_computer"
                : "waiting_input";
      } else state = "working";
    }
    const mine = lines.filter((l) => l.agentId === w.agentId);
    // Only one asked in the work's own conversation: a view reaches whoever reads that one.
    const asked =
      state === "waiting_input" ? questions.find((q) => q.runId === run?.id && q.channelId === w.channelId) : undefined;
    const detail = status === "failed" ? runErrorDetail(run?.error) : null;
    out.set(w.id, {
      id: w.id,
      agentId: w.agentId,
      channelId: w.channelId,
      title: w.title,
      status,
      state,
      how: w.how === "auto" ? "auto" : "agent",
      anchorMessageId: w.anchorMessageId,
      threadId: updatesThreadOf(w),
      homeThreadId: w.homeThreadId,
      runId: run?.id ?? null,
      requestedByUserId: w.requestedByUserId,
      startedAt: w.startedAt.toISOString(),
      finishedAt: w.finishedAt?.toISOString() ?? null,
      nextUpdateAt: w.nextUpdateAt?.toISOString() ?? null,
      lastUpdate:
        w.lastUpdateText && w.updateSeq > 0
          ? { text: w.lastUpdateText, at: w.lastUpdateAt.toISOString(), seq: w.updateSeq }
          : null,
      question: asked
        ? {
            text: plainText(asked.text, WORK_LIMITS.updateMax),
            messageId: asked.messageId,
            requestedForUserId: asked.requestedForUserId,
          }
        : null,
      plan: w.plan,
      issue: w.issueId && numbers.has(w.issueId) ? { id: w.issueId, number: numbers.get(w.issueId) as number } : null,
      resultMessageId: w.resultMessageId,
      queuePosition: state === "queued" ? Math.max(1, mine.findIndex((l) => l.id === w.id) + 1) : null,
      pausedUntil: state === "paused" ? (run?.until ?? null) : null,
      canceledByUserId: status === "canceled" && run?.error?.startsWith("canceled_by:") ? run.error.slice(12) : null,
      errorCode: detail?.errorCode ?? (w.resultMessageId ? (reportCodes.get(w.resultMessageId) ?? null) : null),
    });
  }
  return out;
}

export async function workView(db: Executor, orgId: string, id: string) {
  return (await workViews(db, orgId, [id])).get(id) ?? null;
}

/** Tells the conversation a work changed (its line redraws) and the workspace that its agent's status moved. */
export async function announceWork(pubsub: PubSub | undefined, db: Executor, orgId: string, id: string) {
  if (!pubsub) return;
  const view = await workView(db, orgId, id);
  if (!view) return;
  await publishChannelEvent(pubsub, {
    type: "agent.work",
    channelId: view.channelId,
    threadId: view.homeThreadId,
    agentId: view.agentId,
    runId: view.runId,
    work: view,
  });
  const { announceAgentStatus } = await import("./agent-status");
  await announceAgentStatus(pubsub, orgId, view.agentId).catch(() => {});
}

type RunLike = Pick<
  AgentRun,
  | "id"
  | "orgId"
  | "agentId"
  | "channelId"
  | "threadRootId"
  | "triggerMessageId"
  | "background"
  | "workId"
  | "status"
  | "transcript"
>;

/**
 * Whether a run may become long work (§1): a person is behind it, in a channel or DM people read,
 * not a mission's thread, not a routine's run and not one that already is.
 */
export async function workEligible(db: Executor, run: RunLike): Promise<boolean> {
  return !run.workId && !isTerminal(run.status) && movableRun(db, run);
}

/** Whether a run's work may leave where it answers now (`moveRun`, `moveToBackground`). */
export async function movableRun(db: Executor, run: RunLike): Promise<boolean> {
  if (run.background) return false;
  const channel = await getChannelCached(db as Database, run.orgId, run.channelId);
  if (!channel || (channel.kind !== "channel" && channel.kind !== "dm") || isAgentOnlyDm(channel)) return false;
  const thread = replyThreadOf(run);
  if (thread && (await missionOfThread(db, run.orgId, thread))) return false;
  return (await runAuthority(db, run)).kind === "person";
}

export interface MoveInput {
  how: "agent" | "auto";
  title: string;
  /** The agent's line to the people (plain text); empty on an automatic move (the apps word it). */
  say?: string;
  nextUpdateMin?: number;
  plan?: WorkPlanItem[] | null;
  /** `true`: a card on the board; a number: that issue. */
  card?: boolean | number;
  description?: string;
}

/**
 * Moves a run to the background (§0), in one transaction: claims it (`work_id is null`), writes the work and its
 * anchor where the run answers now, and, for an ask in a main timeline, makes the anchor the run's thread so all it
 * does from now on lands there. The run keeps going. Null: it already moved (or ended).
 */
export async function moveToBackground(
  deps: { db: Database; pubsub?: PubSub; context?: ContextDeps },
  runId: string,
  input: MoveInput,
  now = new Date(),
): Promise<{ work: WorkRow; anchor: Message; queued: boolean } | null> {
  const { db } = deps;
  const title = await workTitle(deps, runId, input.title);
  const moved = await db.transaction(async (tx) => {
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).for("update");
    if (!run || run.workId || isTerminal(run.status)) return null;
    await lockWorkCaps(tx, run.orgId);
    const home = replyThreadOf(run);
    const ownThread = home === null;
    const requester = (await runAuthority(tx, run)).personId;
    const next = clampNext(input.nextUpdateMin);
    const [live] = await tx
      .select({
        agent: sql<number>`count(*) filter (where ${agentWorks.agentId} = ${run.agentId})::int`,
        org: sql<number>`count(*)::int`,
      })
      .from(agentWorks)
      .where(and(eq(agentWorks.orgId, run.orgId), eq(agentWorks.status, "live")));
    const queued = (live?.agent ?? 0) >= WORK_LIMITS.perAgent || (live?.org ?? 0) >= perOrgCap;
    const workId = Bun.randomUUIDv7();
    const say = plainText(input.say, WORK_LIMITS.sayMax);
    const locale = await lineLocale(tx, run.orgId, requester, run.id);
    const anchor = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId: home,
      author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
      body: say || autoMovedText(locale, next),
      meta: {
        longWork: { id: workId, ...(input.how === "auto" ? { auto: true } : {}) },
        ...(say ? {} : { bodyCode: "work_auto_moved", bodyParams: { minutes: String(next) } }),
      },
    });
    const [work] = await tx
      .insert(agentWorks)
      .values({
        id: workId,
        orgId: run.orgId,
        agentId: run.agentId,
        channelId: run.channelId,
        homeThreadId: home,
        anchorMessageId: anchor.id,
        ownThread,
        title,
        plan: input.plan ?? [],
        status: queued ? "queued" : "live",
        how: input.how,
        requestedByUserId: requester,
        lastUpdateAt: now,
        nextUpdateAt: queued ? null : new Date(now.getTime() + next * 60_000),
        startedAt: now,
      })
      .returning();
    if (!work) return null;
    await tx
      .update(agentRuns)
      .set({ workId, ...(ownThread ? { threadRootId: anchor.id } : {}), updatedAt: now })
      .where(and(eq(agentRuns.id, run.id), isNull(agentRuns.workId)));
    if (!queued) await scheduleCheckIn(tx, work);
    // The 15-minute card (§4) doesn't wait on a missed update: a work that reports on time gets it too.
    await enqueue(tx, {
      orgId: work.orgId,
      kind: WORK_CHECK_IN_JOB,
      payload: { workId: work.id, seq: 0, phase: "card" },
      dedupeKey: `${WORK_CHECK_IN_JOB}:${work.id}:card`,
      runAt: new Date(work.startedAt.getTime() + WORK_LIMITS.cardAfterMs),
      maxAttempts: 4,
    });
    // The work's thread is named after the work, not after "Vou cuidar disso…".
    if (ownThread) {
      await tx
        .insert(schema.threads)
        .values({ orgId: run.orgId, channelId: run.channelId, rootMessageId: anchor.id, title: title || null })
        .onConflictDoNothing({ target: [schema.threads.orgId, schema.threads.rootMessageId] });
    }
    // The asker follows the work's thread: its updates count as unread for them, never as a push.
    if (requester && ownThread) {
      await tx
        .insert(threadFollows)
        .values({
          orgId: run.orgId,
          channelId: run.channelId,
          rootMessageId: anchor.id,
          userId: requester,
          following: true,
        })
        .onConflictDoNothing();
    }
    return { work, anchor, queued, run, home };
  });
  if (!moved) return null;
  localMoves.add(runId);
  const { work, anchor, run, home } = moved;
  // A card for substantial work, or the issue the run already works on (§4).
  if (input.card !== undefined && input.card !== false) {
    await ensureWorkCard(deps, work.id, {
      number: typeof input.card === "number" ? input.card : undefined,
      description: input.description,
    }).catch(() => null);
  } else if (run.issueId) {
    await ensureWorkCard(deps, work.id, {}).catch(() => null);
  }
  if (deps.pubsub) {
    // The conversation drops the run's live bubble ("background" marks the run) and draws the anchor with its line.
    await publishChannelEvent(deps.pubsub, {
      type: "agent.idle",
      channelId: run.channelId,
      threadId: home,
      agentId: run.agentId,
      runId: run.id,
      background: true,
    });
    await publishMessageCreated(deps.pubsub, messageView(anchor));
    await announceWork(deps.pubsub, db, run.orgId, work.id);
    await deps.pubsub.publish(workTopic(run.id), { type: "run.work", runId: run.id, workId: work.id }).catch(() => {});
  }
  const [fresh] = await db.select().from(agentWorks).where(eq(agentWorks.id, work.id));
  return { work: fresh ?? work, anchor, queued: moved.queued };
}

/**
 * A person asked it to go on elsewhere (`post_message` with `move_here`): from now on the run answers at `to`'s
 * channel's top level (`replyThreadOf`: its root is its trigger), its long work's updates and report too, and every
 * later wake of it, which reads this row. A line where it was links to `to`.
 */
export async function moveRun(
  deps: { db: Database; pubsub?: PubSub },
  run: Pick<
    AgentRun,
    "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "hop" | "workId"
  >,
  to: Message,
) {
  const from = { channelId: run.channelId, threadId: replyThreadOf(run), agentId: run.agentId, runId: run.id };
  const link = messageLink(run.orgId, to);
  const now = new Date();
  const line = await deps.db.transaction(async (tx) => {
    await tx
      .update(agentRuns)
      .set({ channelId: to.channelId, threadRootId: run.triggerMessageId, updatedAt: now })
      .where(eq(agentRuns.id, run.id));
    if (run.workId)
      await tx
        .update(agentWorks)
        .set({ channelId: to.channelId, homeThreadId: null, ownThread: false, updatedAt: now })
        .where(eq(agentWorks.id, run.workId));
    return insertMessage(tx, {
      orgId: run.orgId,
      channelId: from.channelId,
      threadId: from.threadId,
      author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
      body: `Continues in ${link}`,
      meta: { movedOn: true, bodyCode: "moved_on", bodyParams: { link } },
    });
  });
  localMoves.add(run.id);
  if (!deps.pubsub) return;
  await publishMessageCreated(deps.pubsub, messageView(line));
  // Live rows keep the place they started in: this one ends where it was and, unless it is long work, starts over.
  const background = run.workId ? { background: true as const } : {};
  await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...from, ...background });
  if (!run.workId)
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      ...from,
      channelId: to.channelId,
      threadId: null,
    });
  await deps.pubsub.publish(workTopic(run.id), { type: "run.moved", runId: run.id }).catch(() => {});
}

/**
 * A work's title: the one given, else its thread's when a person wrote it, else a short name the org's cheap model
 * gives the conversation, in its language. Never the ask's own words (a raw message, a link, a GIF): what the apps
 * say the agent works on and what its task is called. Empty when nothing names it (the apps say "in the background").
 */
async function workTitle(deps: { db: Database; context?: ContextDeps }, runId: string, given: string) {
  const title = plainText(given, WORK_LIMITS.titleMax);
  if (title) return title;
  const [run] = await deps.db
    .select({ orgId: agentRuns.orgId, rootId: agentRuns.threadRootId, agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  if (!run) return "";
  const [thread] = await deps.db
    .select({ title: schema.threads.title, auto: schema.threads.titleAuto })
    .from(schema.threads)
    .where(and(eq(schema.threads.orgId, run.orgId), eq(schema.threads.rootMessageId, run.rootId)));
  if (thread?.title?.trim() && !thread.auto) return plainText(thread.title, WORK_LIMITS.titleMax);
  if (!deps.context) return "";
  const named = await nameConversation(deps.context, { ...run, runId }).catch(() => null);
  return plainText(named, WORK_LIMITS.titleMax);
}

/** The anchor's words when the safety net moved the run (stored as the fallback; the apps word `work_auto_moved`). */
export const autoMovedText = (locale: AppLocale, minutes: number) =>
  serverText(locale, "chat.body.work_auto_moved", { minutes: String(minutes) });

/** The update the server posts for a silent work (stored as the fallback; the apps word `work_auto_update`). */
export const autoUpdateText = (locale: AppLocale, minutes: number) =>
  serverText(locale, "work.autoUpdate", {
    duration: serverText(locale, "work.duration.minutes", { count: String(minutes) }),
  });

async function scheduleCheckIn(tx: Executor, work: Pick<WorkRow, "id" | "orgId" | "updateSeq" | "nextUpdateAt">) {
  if (!work.nextUpdateAt) return;
  await enqueue(tx, {
    orgId: work.orgId,
    kind: WORK_CHECK_IN_JOB,
    payload: { workId: work.id, seq: work.updateSeq, phase: "nudge" },
    dedupeKey: `${WORK_CHECK_IN_JOB}:${work.id}:${work.updateSeq}:${work.nextUpdateAt.getTime()}`,
    runAt: work.nextUpdateAt,
    maxAttempts: 4,
  });
}

/** The live work a run is (its newest work row), or null. */
export async function workOfRun(db: Executor, runId: string): Promise<WorkRow | null> {
  const [row] = await db
    .select({ work: agentWorks })
    .from(agentRuns)
    .innerJoin(agentWorks, eq(agentWorks.id, agentRuns.workId))
    .where(eq(agentRuns.id, runId));
  return row?.work ?? null;
}

export type UpdateOutcome = { ok: true; message: Message; work: WorkRow } | { ok: false; reason: string };

/**
 * `post_update` (§3): one plain line in the work's thread, at least 5 min after the last unless `important` (then a
 * minute), with the next promise clamped to 5–20 min. Moves the card's plan and activity too.
 */
export async function postWorkUpdate(
  deps: { db: Database; pubsub?: PubSub },
  runId: string,
  input: { text: string; nextUpdateMin?: number; plan?: WorkPlanItem[] | null; important?: boolean },
  now = new Date(),
): Promise<UpdateOutcome> {
  const text = plainText(input.text, WORK_LIMITS.updateMax);
  if (!text) return { ok: false, reason: "Write the update: one plain line." };
  const out = await deps.db.transaction(async (tx) => {
    const work = await workOfRun(tx, runId);
    if (!work || (work.status !== "live" && work.status !== "queued"))
      return {
        ok: false as const,
        reason: "This isn't background work: just reply (or call work_in_background first).",
      };
    const [locked] = await tx.select().from(agentWorks).where(eq(agentWorks.id, work.id)).for("update");
    if (!locked) return { ok: false as const, reason: "This work ended." };
    const since = now.getTime() - (locked.updateSeq > 0 ? locked.lastUpdateAt.getTime() : 0);
    const gap = input.important ? WORK_LIMITS.importantGapMs : WORK_LIMITS.minGapMs;
    if (locked.updateSeq > 0 && since < gap) {
      const due = locked.nextUpdateAt ?? new Date(locked.lastUpdateAt.getTime() + WORK_LIMITS.minGapMs);
      return {
        ok: false as const,
        reason: `Too soon; your last update was ${Math.floor(since / 60_000)} min ago. Keep working; the next is due at ${due.toISOString().slice(11, 16)} UTC.`,
      };
    }
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId));
    if (!run) return { ok: false as const, reason: "This work ended." };
    const seq = locked.updateSeq + 1;
    const next = clampNext(input.nextUpdateMin);
    const message = await insertMessage(tx, {
      orgId: locked.orgId,
      channelId: locked.channelId,
      threadId: updatesThreadOf(locked),
      author: { type: "agent", agentId: locked.agentId, runId, hop: run.hop },
      body: text,
      meta: { workUpdate: { id: locked.id, seq } },
    });
    const [updated] = await tx
      .update(agentWorks)
      .set({
        updateSeq: seq,
        lastUpdateAt: now,
        lastUpdateText: text,
        nextUpdateAt: locked.status === "live" ? new Date(now.getTime() + next * 60_000) : null,
        ...(input.plan ? { plan: input.plan } : {}),
        updatedAt: now,
      })
      .where(and(eq(agentWorks.id, locked.id), eq(agentWorks.updateSeq, locked.updateSeq)))
      .returning();
    if (!updated) return { ok: false as const, reason: "Another update just landed: keep working." };
    await scheduleCheckIn(tx, updated);
    return { ok: true as const, message, work: updated };
  });
  if (!out.ok) return out;
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(out.message));
  if (out.work.issueId)
    await setWorkIssueState(deps, out.work, { update: text, plan: Boolean(input.plan) }).catch(() => null);
  await announceWork(deps.pubsub, deps.db, out.work.orgId, out.work.id);
  return out;
}

/**
 * Job `agent_work.check_in` (§3): the promised update didn't come. First a nudge only the agent reads (live on a
 * steerable turn, else at its next step) and one more look after the grace; then the server posts the update itself,
 * worded from the run's automatic status line, and promises the next in 10 min. Also gives a work going 15 min its
 * card. A work that waits on something has no timer; an update meanwhile (`update_seq` moved) makes this a no-op.
 */
export async function checkInWork(
  deps: { db: Database; pubsub?: PubSub; context?: ContextDeps },
  orgId: string,
  input: { workId: string; seq: number; phase: "nudge" | "fallback" | "card"; due?: number },
  now = new Date(),
): Promise<"none" | "nudged" | "posted"> {
  const { db } = deps;
  const [work] = await db
    .select()
    .from(agentWorks)
    .where(and(eq(agentWorks.orgId, orgId), eq(agentWorks.id, input.workId)));
  if (work?.status !== "live") return "none";
  // A live work this old gets its card whatever its updates did (§4).
  if (!work.issueId && now.getTime() - work.startedAt.getTime() >= WORK_LIMITS.cardAfterMs)
    await ensureWorkCard(deps, work.id, {}).catch(() => null);
  if (input.phase === "card" || work.updateSeq !== input.seq || !work.nextUpdateAt) return "none";
  if (work.nextUpdateAt.getTime() > now.getTime() + 1000 && input.phase === "nudge") return "none";
  // The fallback belongs to the promise it was queued for: a wait in between restarted the timer (same seq).
  if (input.phase === "fallback" && input.due !== undefined && work.nextUpdateAt.getTime() !== input.due) return "none";
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.workId, work.id), eq(agentRuns.orgId, orgId)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  if (!run || isTerminal(run.status)) return "none";
  // Waiting on a person, its plan or its computer: the card that stopped it is the update.
  if (run.status !== "running" && run.status !== "queued") return "none";
  if (input.phase === "nudge") {
    const due = work.nextUpdateAt.toISOString().slice(11, 16);
    const delivered = await db.transaction((tx) =>
      deliverNoticeToRun(tx, run, {
        kind: "work_check_in",
        text: `You promised an update by ${due} UTC. Post one line with post_update: what's done, what's next, when the next update comes.`,
        refs: { workId: work.id, seq: String(work.updateSeq) },
      }),
    );
    await enqueue(db, {
      orgId,
      kind: WORK_CHECK_IN_JOB,
      payload: { workId: work.id, seq: work.updateSeq, phase: "fallback", due: work.nextUpdateAt.getTime() },
      dedupeKey: `${WORK_CHECK_IN_JOB}:${work.id}:${work.updateSeq}:fallback:${work.nextUpdateAt.getTime()}`,
      runAt: new Date(now.getTime() + WORK_LIMITS.graceMs),
      maxAttempts: 4,
    });
    await publishDelivery(deps.pubsub, delivered).catch(() => {});
    if (deps.pubsub)
      await deliverLive({ db, pubsub: deps.pubsub }, run, { messageId: delivered.message.id, urgent: false });
    return "nudged";
  }
  return (await postFallbackUpdate(deps, work, run, now)) ? "posted" : "none";
}

async function postFallbackUpdate(deps: { db: Database; pubsub?: PubSub }, work: WorkRow, run: AgentRun, now: Date) {
  const [agent] = await deps.db
    .select({ kind: schema.agents.statusKind, subject: schema.agents.statusSubject, runId: schema.agents.statusRunId })
    .from(schema.agents)
    .where(eq(schema.agents.id, work.agentId));
  const line = agent?.runId === run.id && agent.kind ? { kind: agent.kind, subject: agent.subject ?? "" } : null;
  const minutes = Math.max(1, Math.round((now.getTime() - work.startedAt.getTime()) / 60_000));
  const locale = await lineLocale(deps.db, work.orgId, work.requestedByUserId, run.id);
  const posted = await deps.db.transaction(async (tx) => {
    const seq = work.updateSeq + 1;
    const [updated] = await tx
      .update(agentWorks)
      .set({
        updateSeq: seq,
        lastUpdateAt: now,
        lastUpdateText: autoUpdateText(locale, minutes),
        nextUpdateAt: new Date(now.getTime() + WORK_LIMITS.nextDefault * 60_000),
        updatedAt: now,
      })
      .where(and(eq(agentWorks.id, work.id), eq(agentWorks.updateSeq, work.updateSeq), eq(agentWorks.status, "live")))
      .returning();
    if (!updated) return null;
    const message = await insertMessage(tx, {
      orgId: work.orgId,
      channelId: work.channelId,
      threadId: updatesThreadOf(work),
      author: { type: "agent", agentId: work.agentId, runId: run.id, hop: run.hop },
      body: autoUpdateText(locale, minutes),
      meta: {
        workUpdate: {
          id: work.id,
          seq,
          auto: true,
          minutes,
          ...(line ? { kind: line.kind, subject: line.subject } : {}),
        },
        bodyCode: "work_auto_update",
        bodyParams: { minutes: String(minutes), ...(line ? { kind: line.kind, subject: line.subject } : {}) },
      },
    });
    await scheduleCheckIn(tx, updated);
    return { message, work: updated };
  });
  if (!posted) return false;
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(posted.message));
  if (posted.work.issueId)
    await setWorkIssueState(deps, posted.work, { update: posted.work.lastUpdateText ?? "" }).catch(() => null);
  await announceWork(deps.pubsub, deps.db, work.orgId, work.id);
  return true;
}

/** The work's run stopped on something (a person, its plan, its computer, the line): no timer while it waits. */
export async function pauseWorkTimer(deps: { db: Database; pubsub?: PubSub }, run: Pick<AgentRun, "workId" | "orgId">) {
  if (!run.workId) return;
  const [w] = await deps.db
    .update(agentWorks)
    .set({ nextUpdateAt: null, updatedAt: new Date() })
    .where(and(eq(agentWorks.id, run.workId), eq(agentWorks.status, "live")))
    .returning();
  if (w?.issueId) await setWorkIssueState(deps, w, {}).catch(() => null);
  await announceWork(deps.pubsub, deps.db, run.orgId, run.workId);
}

/** Back to work after a wait: the promise starts again with 10 min. */
export async function resumeWorkTimer(
  deps: { db: Database; pubsub?: PubSub },
  run: Pick<AgentRun, "workId" | "orgId">,
  now = new Date(),
) {
  if (!run.workId) return;
  const w = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentWorks)
      .set({ nextUpdateAt: new Date(now.getTime() + WORK_LIMITS.nextDefault * 60_000), updatedAt: now })
      .where(
        and(eq(agentWorks.id, run.workId as string), eq(agentWorks.status, "live"), isNull(agentWorks.nextUpdateAt)),
      )
      .returning();
    if (row) await scheduleCheckIn(tx, row);
    return row ?? null;
  });
  if (!w) return;
  if (w.issueId) await setWorkIssueState(deps, w, {}).catch(() => null);
  await announceWork(deps.pubsub, deps.db, run.orgId, w.id);
}

/** Whether the work waits in line (its run parks at the loop top until it is released). */
export async function workQueued(db: Executor, workId: string) {
  const [w] = await db.select({ status: agentWorks.status }).from(agentWorks).where(eq(agentWorks.id, workId));
  return w?.status === "queued";
}

/**
 * The work's run ended (§3, §7): closes it once (`finished_at is null`), with its report home. A report the run
 * already posted home (`meta.workEnd`) is kept, and its own status counts (a run that ran out of steps, got stuck or
 * was cut off by its brain ends `done` but its work didn't finish); otherwise (a stop, a failure, an end with nothing
 * to say) the server posts the end there, with why and the last update. Its card moves with it and the next work in
 * line starts.
 */
export async function endWork(
  deps: { db: Database; pubsub?: PubSub },
  run: Pick<AgentRun, "id" | "orgId" | "workId" | "error" | "replyMessageId" | "hop" | "transcript">,
  runStatus: "done" | "failed" | "canceled",
  now = new Date(),
): Promise<WorkRow | null> {
  if (!run.workId) return null;
  const { db } = deps;
  const ended = await db.transaction(async (tx) => {
    const [reply] = run.replyMessageId
      ? await tx
          .select({ id: messages.id, meta: messages.meta })
          .from(messages)
          .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.replyMessageId)))
      : [];
    const posted = reply?.meta.workEnd as { id?: unknown; status?: unknown } | undefined;
    const report = posted?.id === run.workId ? reply : undefined;
    const status = report && runStatus === "done" && posted?.status === "failed" ? "failed" : runStatus;
    const [work] = await tx
      .update(agentWorks)
      .set({ status, finishedAt: now, nextUpdateAt: null, updatedAt: now })
      .where(and(eq(agentWorks.id, run.workId as string), isNull(agentWorks.finishedAt)))
      .returning();
    if (!work) return null;
    let resultId = report?.id ?? null;
    let end: Message | null = null;
    if (!resultId) {
      const detail = status === "failed" ? runErrorDetail(run.error) : null;
      const minutes = Math.max(1, Math.round((now.getTime() - work.startedAt.getTime()) / 60_000));
      const byUserId = run.error?.startsWith("canceled_by:") ? run.error.slice(12) : null;
      const locale = await lineLocale(tx, work.orgId, work.requestedByUserId, run.id);
      const last = status !== "done" && work.updateSeq > 0 ? work.lastUpdateText : null;
      const [by] = byUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, byUserId)) : [];
      end = await insertMessage(tx, {
        orgId: work.orgId,
        channelId: work.channelId,
        threadId: work.homeThreadId,
        author: { type: "agent", agentId: work.agentId, runId: run.id, hop: run.hop },
        body: [
          endText(locale, status, minutes, by?.name),
          last ? `${serverText(locale, "work.lastUpdate")}: ${last}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        meta: {
          workEnd: {
            id: work.id,
            status,
            minutes,
            ...(detail ? { errorCode: detail.errorCode } : {}),
            ...(detail?.errorParams ? { errorParams: detail.errorParams } : {}),
            ...(byUserId ? { byUserId } : {}),
            ...(last ? { lastUpdate: last } : {}),
          },
          bodyCode: `work_end_${status}`,
          bodyParams: { minutes: String(minutes), title: work.title, ...(by?.name ? { byName: by.name } : {}) },
        },
      });
      resultId = end.id;
    }
    const [closed] = await tx
      .update(agentWorks)
      .set({ resultMessageId: resultId })
      .where(eq(agentWorks.id, work.id))
      .returning();
    // What people passed on to it: a person's stop and any end Continuar can't go on from follow it up now.
    await queueWorkFollowUp(
      tx,
      work,
      run.id,
      status === "canceled"
        ? "stopped"
        : status === "failed" && continuableEnd({ ...run, status: runStatus }, reply)
          ? "continued"
          : "ended",
    );
    const released = await releaseQueuedWorks(tx, work.orgId);
    return { work: closed ?? work, end, released, status };
  });
  if (!ended) return null;
  if (ended.end && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(ended.end));
  if (ended.work.issueId) await setWorkIssueState(deps, ended.work, { ended: ended.status }).catch(() => null);
  await announceWork(deps.pubsub, db, ended.work.orgId, ended.work.id);
  for (const id of ended.released) await announceWork(deps.pubsub, db, ended.work.orgId, id);
  return ended.work;
}

/**
 * Asks passed on to the work still unread in its ending run's inbox leave it, so the inbox release doesn't hand them
 * on too: a reply turn's own message can't start a second run, and would be lost. `keep`: written on the run
 * (`unreadAsks`) for Continuar, which hands them to the run that goes on (`continueRun`).
 */
async function takeUnreadAsks(tx: Executor, work: WorkRow, runId: string, options: { keep?: boolean } = {}) {
  const [row] = await tx
    .select({ pending: agentRuns.pendingMessageIds })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .for("update");
  const pending = row?.pending ?? [];
  const asks = await passedOnTo(tx, work.orgId, work.id, pending);
  if (asks.length === 0) return [];
  await tx
    .update(agentRuns)
    .set({
      pendingMessageIds: pending.filter((id) => !asks.includes(id)),
      ...(options.keep
        ? { transcript: sql`jsonb_set(${agentRuns.transcript}, '{unreadAsks}', ${JSON.stringify(asks)}::jsonb)` }
        : {}),
    })
    .where(eq(agentRuns.id, runId));
  return asks;
}

/**
 * The end of a work follows up what people passed on to it, once. Anyone else's than its asker's never reached it
 * (`heldAsks`): theirs now, at any end. Its asker's did: at an end Continuar can go on from (`continued`) they go on
 * with it (its transcript, `unreadAsks`); at a stop, what it never read (what it read stays in its transcript, for a
 * Continuar); at any other end, what its runs read (reading one doesn't mean the work did it) and what is still unread,
 * since nothing else brings the agent back to it.
 */
async function queueWorkFollowUp(tx: Executor, work: WorkRow, runId: string, end: "ended" | "continued" | "stopped") {
  const [anchor] = await tx
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, work.orgId), eq(messages.id, work.anchorMessageId)));
  const kept = anchor?.meta.heldAsks;
  const held = Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
  if (held.length > 0)
    await tx
      .update(messages)
      .set({ meta: sql`${messages.meta} - 'heldAsks'` })
      .where(and(eq(messages.orgId, work.orgId), eq(messages.id, work.anchorMessageId)));
  let own: string[] = [];
  if (end === "continued") await takeUnreadAsks(tx, work, runId, { keep: true });
  else if (end === "stopped") own = await takeUnreadAsks(tx, work, runId);
  else {
    const reads = await tx
      .select({ data: agentRunSteps.data })
      .from(agentRunSteps)
      .innerJoin(agentRuns, eq(agentRuns.id, agentRunSteps.runId))
      .where(
        and(
          eq(agentRuns.orgId, work.orgId),
          eq(agentRuns.workId, work.id),
          eq(agentRunSteps.kind, "context"),
          sql`${agentRunSteps.data} ? 'steeredMessageIds'`,
        ),
      );
    const read = [
      ...new Set(reads.flatMap((r) => (Array.isArray(r.data.steeredMessageIds) ? r.data.steeredMessageIds : []))),
    ].filter((id): id is string => typeof id === "string");
    own = [...(await passedOnTo(tx, work.orgId, work.id, read)), ...(await takeUnreadAsks(tx, work, runId))];
  }
  const asks = [...new Set([...own, ...held])];
  if (asks.length === 0) return;
  await enqueue(tx, {
    orgId: work.orgId,
    kind: WORK_FOLLOW_UP_JOB,
    payload: { workId: work.id, runId, messageIds: asks, ...(end === "stopped" ? { stopped: true } : {}) },
    // Per end: a work that Continuar goes on with ends again in another run, with only what came in since.
    dedupeKey: `${WORK_FOLLOW_UP_JOB}:${work.id}:${runId}`,
    maxAttempts: 4,
  });
}

/** What a follow-up's notice quotes of one message at most. */
const ASK_QUOTE_MAX = 4000;

/**
 * Job `agent_work.follow_up`: an end of a work after people passed messages on to it. For each person who wrote them,
 * while they may still ask the agent there, an agent-only notice where the work reports quotes theirs alone
 * (`work_follow_up`) and starts or joins a run on their own authority (`authority.ts`): it does what the work left
 * undone and didn't say why, or passes. A retry, or another replica, finds the notices already written, per person.
 */
export async function followUpWork(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  input: { workId: string; runId: string; messageIds: string[]; stopped?: boolean },
): Promise<Message[]> {
  if (input.messageIds.length === 0) return [];
  const delivered = await deps.db.transaction(async (tx) => {
    const [work] = await tx
      .select()
      .from(agentWorks)
      .where(and(eq(agentWorks.orgId, orgId), eq(agentWorks.id, input.workId)))
      .for("update");
    // The run whose end queued it: a Continuar since may have the work going again, but this end is over.
    const [run] = work
      ? await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.workId, work.id)))
      : [];
    if (!work || !run || !isTerminal(run.status)) return [];
    const asks = await tx
      .select({
        id: messages.id,
        userId: messages.authorUserId,
        channelId: messages.channelId,
        threadId: messages.threadId,
      })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          inArray(messages.id, input.messageIds),
          eq(messages.authorType, "person"),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(asc(messages.createdAt));
    const sent = await tx
      .select({ personId: sql<string | null>`${messages.meta}->'notice'->'refs'->>'personId'` })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          inArray(messages.channelId, [...new Set([work.channelId, ...asks.map((a) => a.channelId)])]),
          gte(messages.createdAt, work.startedAt),
          sql`${messages.meta}->'notice'->>'kind' = 'work_follow_up'`,
          sql`${messages.meta}->'notice'->'refs'->>'workId' = ${work.id}`,
          sql`${messages.meta}->'notice'->'refs'->>'endRunId' = ${run.id}`,
        ),
      );
    const followed = new Set(sent.map((s) => s.personId));
    const out: { message: Message; runs: AgentRun[] }[] = [];
    // They may still ask the agent there and post there.
    const reaches = async (personId: string, channelId: string) =>
      (await eligibleChannelAgents(tx, orgId, channelId, [work.agentId], { requesterUserId: personId })).length > 0 &&
      (await personCanPost(tx, orgId, personId, channelId));
    for (const personId of new Set(asks.flatMap((a) => (a.userId ? [a.userId] : [])))) {
      if (followed.has(personId)) continue;
      const theirs = asks.filter((a) => a.userId === personId);
      const last = theirs.at(-1);
      if (!last) continue;
      // Where the work reports; when it went on where they aren't (`moveRun`), where they asked.
      const home = await reaches(personId, work.channelId);
      if (!home && (last.channelId === work.channelId || !(await reaches(personId, last.channelId)))) continue;
      const place = home
        ? { channelId: work.channelId, threadId: work.homeThreadId }
        : { channelId: last.channelId, threadId: last.threadId };
      // Their words as conversation lines ("[Bia]: …"), each with what it attached.
      const quoted = await renderSteered(
        tx,
        orgId,
        theirs.map((a) => a.id),
        { beforeStart: true },
      );
      out.push(
        await deliverNotice(tx, {
          orgId,
          agentId: work.agentId,
          ...place,
          hop: run.hop,
          stretchId: runStretchOf(run),
          // Nobody reads the body: its agent reads `meta.notice`.
          body: "Asks passed on to a background work that ended.",
          notice: {
            kind: "work_follow_up",
            text: quoted.map((q) => cutMarked(q.text, ASK_QUOTE_MAX)).join("\n\n"),
            refs: {
              workId: work.id,
              endRunId: run.id,
              personId,
              ...(work.title ? { title: work.title } : {}),
              ...(input.stopped ? { stopped: "1" } : {}),
              ...(home ? {} : { away: "1" }),
            },
          },
          trigger: run.trigger === "dm" ? "dm" : "mention",
        }),
      );
    }
    return out;
  });
  for (const d of delivered) await publishDelivery(deps.pubsub, d).catch(() => {});
  return delivered.map((d) => d.message);
}

/** The end's own words (`chat.body.work_end_*`, as the apps say them without a reason). */
const endText = (locale: AppLocale, status: "done" | "failed" | "canceled", minutes: number, by?: string) =>
  serverText(locale, `chat.body.work_end_${status}${status === "canceled" && by ? "By" : ""}`, {
    minutes: String(minutes),
    ...(by ? { name: by } : {}),
  });

/**
 * Releases queued works that now fit (oldest first) in the caller's transaction: each goes live with a fresh promise,
 * and its parked run is queued again. Returns the released ids.
 */
export async function releaseQueuedWorks(tx: Executor, orgId: string, now = new Date()): Promise<string[]> {
  await lockWorkCaps(tx, orgId);
  const queued = await tx
    .select()
    .from(agentWorks)
    .where(and(eq(agentWorks.orgId, orgId), eq(agentWorks.status, "queued")))
    .orderBy(asc(agentWorks.createdAt), asc(agentWorks.id))
    .for("update", { skipLocked: true });
  if (queued.length === 0) return [];
  const live = await tx
    .select({ agentId: agentWorks.agentId })
    .from(agentWorks)
    .where(and(eq(agentWorks.orgId, orgId), eq(agentWorks.status, "live")));
  const perAgent = new Map<string, number>();
  for (const l of live) perAgent.set(l.agentId, (perAgent.get(l.agentId) ?? 0) + 1);
  let total = live.length;
  const released: string[] = [];
  for (const w of queued) {
    if (total >= perOrgCap) break;
    if ((perAgent.get(w.agentId) ?? 0) >= WORK_LIMITS.perAgent) continue;
    const [row] = await tx
      .update(agentWorks)
      .set({
        status: "live",
        nextUpdateAt: new Date(now.getTime() + WORK_LIMITS.nextDefault * 60_000),
        updatedAt: now,
      })
      .where(and(eq(agentWorks.id, w.id), eq(agentWorks.status, "queued")))
      .returning();
    if (!row) continue;
    total++;
    perAgent.set(w.agentId, (perAgent.get(w.agentId) ?? 0) + 1);
    released.push(row.id);
    await scheduleCheckIn(tx, row);
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.workId, row.id))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (run) await wakeQueuedRun(tx, orgId, run.id, row.id);
  }
  return released;
}

/** The wait a queued work's run parks on, and the job that brings it back. */
export const workQueueWaitId = (workId: string) => `work_queue:${workId}`;

/** `by`: the release, or the run that parked after it was released (each its own job: dedupe keys stay). */
export async function wakeQueuedRun(
  tx: Executor,
  orgId: string,
  runId: string,
  workId: string,
  by: "release" | "parked" = "release",
) {
  await enqueue(tx, {
    orgId,
    kind: "agent_run.execute",
    payload: { runId, wait: workQueueWaitId(workId) },
    dedupeKey: `agent_run.execute:${runId}:wait:${workQueueWaitId(workId)}:${by}`,
    maxAttempts: 4,
  });
}

/** Moves made by the tool in this process, taken by the run's executor at its next step (no read needed). */
const localMoves = new Set<string>();
export const takeLocalMove = (runId: string) => localMoves.delete(runId);

/**
 * Boot sweep (§7): a live or queued work whose run is terminal gets its missing end (once, by `finished_at`), and
 * queued works that fit are released. Returns how many it closed.
 */
export async function reconcileWorks(deps: { db: Database; pubsub?: PubSub }): Promise<number> {
  const open = await deps.db
    .select({ id: agentWorks.id, orgId: agentWorks.orgId })
    .from(agentWorks)
    .where(inArray(agentWorks.status, ["live", "queued"]))
    .orderBy(asc(agentWorks.createdAt))
    .limit(500);
  let closed = 0;
  const orgs = new Set<string>();
  for (const w of open) {
    orgs.add(w.orgId);
    // One bad row never stops the sweep: the next tick tries it again.
    try {
      const [run] = await deps.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.workId, w.id))
        .orderBy(desc(agentRuns.createdAt))
        .limit(1);
      if (run && !isTerminal(run.status)) continue;
      if (!run) {
        // Its run is gone: closed without a message (nothing to post it as).
        const [gone] = await deps.db
          .update(agentWorks)
          .set({ status: "failed", finishedAt: new Date(), nextUpdateAt: null, updatedAt: new Date() })
          .where(and(eq(agentWorks.id, w.id), isNull(agentWorks.finishedAt)))
          .returning({ id: agentWorks.id });
        if (gone) {
          closed++;
          await announceWork(deps.pubsub, deps.db, w.orgId, w.id);
        }
        continue;
      }
      const status = run.status === "done" ? "done" : run.status === "canceled" ? "canceled" : "failed";
      if (await endWork(deps, run, status)) closed++;
    } catch {}
  }
  for (const orgId of orgs) {
    try {
      const released = await deps.db.transaction((tx) => releaseQueuedWorks(tx, orgId));
      for (const id of released) await announceWork(deps.pubsub, deps.db, orgId, id);
    } catch {}
  }
  return closed;
}

/**
 * At its turn's end a work's run drops the check-ins and move notes it never read (agent-only `work_check_in`
 * notices): its report, or the next turn, answers them, and they are no new input to go on with.
 */
export async function dropWorkNotices(db: Executor, runId: string) {
  await db.execute(sql`update ${agentRuns} set pending_message_ids = coalesce(array(
      select p from unnest(${agentRuns.pendingMessageIds}) p
      where not exists (select 1 from ${messages} m where m.id = p and m.meta->'notice'->>'kind' = 'work_check_in')
    ), '{}')
    where ${agentRuns.id} = ${runId} and cardinality(${agentRuns.pendingMessageIds}) > 0`);
}

/** Live and queued works of an agent in one conversation (channel), newest first. */
export async function liveWorksHere(db: Executor, run: Pick<AgentRun, "orgId" | "agentId" | "channelId" | "id">) {
  return db
    .select()
    .from(agentWorks)
    .where(
      and(
        eq(agentWorks.orgId, run.orgId),
        eq(agentWorks.agentId, run.agentId),
        eq(agentWorks.channelId, run.channelId),
        inArray(agentWorks.status, ["live", "queued"]),
        sql`not exists (select 1 from ${agentRuns} r where r.work_id = ${agentWorks.id} and r.id = ${run.id})`,
      ),
    )
    .orderBy(desc(agentWorks.createdAt))
    .limit(5);
}

/** Of each live work, the latest steps and updates a reply turn reads: what it does and found so far. */
const BRIEF_STEPS = 8;
const BRIEF_UPDATES = 3;

/**
 * "# Your background work here" (§6): what a new run in the conversation knows of the agent's live works, enough to
 * answer a person about one at once (its title, plan, updates and latest steps) and to pass a change on.
 */
export async function workBrief(db: Executor, run: Pick<AgentRun, "orgId" | "agentId" | "channelId" | "id">) {
  const list = await liveWorksHere(db, run);
  if (list.length === 0) return null;
  const now = new Date();
  const lines = await Promise.all(
    list.map(async (w) => {
      const minutes = Math.max(0, Math.round((now.getTime() - w.startedAt.getTime()) / 60_000));
      const plan = w.plan.length
        ? ` Plan: ${w.plan.map((p) => `[${p.state === "done" ? "x" : p.state === "doing" ? "~" : " "}] ${p.text}`).join("; ")}.`
        : "";
      const [updates, steps] = await Promise.all([
        db
          .select({ body: messages.body })
          .from(messages)
          .where(
            and(
              eq(messages.orgId, w.orgId),
              eq(messages.channelId, w.channelId),
              gte(messages.createdAt, w.startedAt),
              sql`${messages.meta}->'workUpdate'->>'id' = ${w.id}`,
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(BRIEF_UPDATES),
        db
          .select({ kind: agentRunSteps.kind, data: agentRunSteps.data, createdAt: agentRunSteps.createdAt })
          .from(agentRunSteps)
          .innerJoin(agentRuns, eq(agentRuns.id, agentRunSteps.runId))
          .where(and(eq(agentRuns.workId, w.id), eq(agentRuns.orgId, w.orgId)))
          .orderBy(desc(agentRunSteps.createdAt))
          .limit(BRIEF_STEPS),
      ]);
      const told = updates.length
        ? ` Updates so far: ${updates
            .reverse()
            .map((u) => `"${cutText(u.body, 300)}"`)
            .join("; ")}.`
        : "";
      const lately = steps.reverse().flatMap((st) => {
        const line = stepLine(st.kind, st.data);
        return line ? [`${ago(now, st.createdAt)}: ${line}`] : [];
      });
      const doing = lately.length ? ` Latest steps: ${lately.join("; ")}.` : "";
      return `- work_id ${w.id}: ${w.title ? `"${w.title}"` : "(untitled)"} (${w.status === "queued" ? "waiting in line" : `${minutes} min in`}).${plan}${told}${doing}`;
    }),
  );
  return [
    "# Your background work here",
    "You are already working on this in the background (each one reports here by itself when it ends):",
    ...lines,
    `A person's message here comes to you, not to the work, which keeps running: answer it now. A question about the work (how it goes, what it covers, what it found): answer from the lines above, plainly, without starting that work again. If the message changes the work (a correction, a narrower or wider scope, more detail) or asks for a next step once it is done, pass it on with ${STEER_WORK_TOOL} and tell them in one short line what it answers: the work takes it on, or, from someone who didn't ask for the work, it runs once the work ends or is stopped, as them. Never say you will do it yourself later: this turn ends here. To stop one, ${STOP_WORK_TOOL}. Anything else, answer it normally here. Never poll or wait for your own work.`,
  ].join("\n");
}

/**
 * `steer_work` (§6): the person's message (and the ones it came with) goes on, unchanged. Into the work's inbox when
 * its author asked for the work (live on a steerable turn), so it keeps their words and their authority. Anyone else's
 * never reaches the work, which acts on its asker's access: it waits on the work's anchor (`heldAsks`) and its end
 * gives them a follow-up of their own, with their own access (`queueWorkFollowUp`). `kept`: their names.
 */
export async function steerWork(
  deps: { db: Database; pubsub?: PubSub },
  from: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "triggerMessageId" | "pendingMessageIds">,
  workId: string,
): Promise<{ ok: true; delivered: number; kept: string[] } | { ok: false; reason: string }> {
  const [work] = await deps.db
    .select()
    .from(agentWorks)
    .where(and(eq(agentWorks.orgId, from.orgId), eq(agentWorks.id, workId)));
  if (!work || work.agentId !== from.agentId || work.channelId !== from.channelId)
    return { ok: false, reason: "No background work of yours here has that id." };
  if (work.status !== "live" && work.status !== "queued") return { ok: false, reason: "That work already ended." };
  const [target] = await deps.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.workId, work.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  if (!target) return { ok: false, reason: "That work already ended." };
  const ids = [from.triggerMessageId, ...from.pendingMessageIds];
  const people = await deps.db
    .select({ id: messages.id, userId: messages.authorUserId, name: users.name })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .where(and(eq(messages.orgId, from.orgId), inArray(messages.id, ids), eq(messages.authorType, "person")));
  if (people.length === 0) return { ok: false, reason: "Only a person's message can be passed on." };
  let delivered = 0;
  const kept = new Set<string>();
  for (const m of people) {
    const asker = m.userId !== null && m.userId === work.requestedByUserId;
    const taken = await deps.db.transaction(async (tx) => {
      if (asker) {
        // Only into a run still at work: one that ended meanwhile never reads its inbox again.
        const [row] = await tx
          .update(agentRuns)
          .set({
            pendingMessageIds: sql`case when ${m.id}::uuid = any(${agentRuns.pendingMessageIds})
          then ${agentRuns.pendingMessageIds} else array_append(${agentRuns.pendingMessageIds}, ${m.id}::uuid) end`,
          })
          .where(and(eq(agentRuns.id, target.id), inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])))
          .returning({ id: agentRuns.id });
        if (!row) return false;
      } else {
        // Under the work's lock, as its end takes them: nothing kept after it ended is left behind.
        const [open] = await tx
          .select({ id: agentWorks.id })
          .from(agentWorks)
          .where(and(eq(agentWorks.id, work.id), isNull(agentWorks.finishedAt)))
          .for("update");
        if (!open) return false;
        await tx
          .update(messages)
          .set({
            meta: sql`jsonb_set(${messages.meta}, '{heldAsks}',
              (coalesce(${messages.meta}->'heldAsks', '[]'::jsonb) - ${m.id}::text) || jsonb_build_array(${m.id}::text))`,
          })
          .where(and(eq(messages.orgId, from.orgId), eq(messages.id, work.anchorMessageId)));
      }
      // The message keeps where it went, before the live delivery renders it: the work (`steeredWorkIds`), and for the
      // asker's, which joins its run, that run too (`steeredRunIds`, as a message that joins a run gets).
      await tx
        .update(messages)
        .set({
          meta: asker
            ? sql`${messages.meta} || jsonb_build_object(
              'steeredWorkIds', (coalesce(${messages.meta}->'steeredWorkIds', '[]'::jsonb) - ${work.id}::text) || jsonb_build_array(${work.id}::text),
              'steeredRunIds', (coalesce(${messages.meta}->'steeredRunIds', '[]'::jsonb) - ${target.id}::text) || jsonb_build_array(${target.id}::text))`
            : sql`${messages.meta} || jsonb_build_object(
              'steeredWorkIds', (coalesce(${messages.meta}->'steeredWorkIds', '[]'::jsonb) - ${work.id}::text) || jsonb_build_array(${work.id}::text))`,
        })
        .where(and(eq(messages.orgId, from.orgId), eq(messages.id, m.id)));
      return true;
    });
    if (!taken) return { ok: false, reason: "That work already ended." };
    // Passed on: this run doesn't answer it as its own.
    await deps.db
      .update(agentRuns)
      .set({ pendingMessageIds: sql`array_remove(${agentRuns.pendingMessageIds}, ${m.id}::uuid)` })
      .where(eq(agentRuns.id, from.id));
    if (!asker) {
      kept.add(m.name ?? "someone");
      continue;
    }
    delivered++;
    if (deps.pubsub)
      await deliverLive({ db: deps.db, pubsub: deps.pubsub }, target, { messageId: m.id, urgent: false });
  }
  return { ok: true, delivered, kept: [...kept] };
}

/** The current run of a work, for `stop_work` (its stop goes through `cancelRun`, for whoever may). */
export async function workRunId(db: Executor, orgId: string, agentId: string, workId: string) {
  const [row] = await db
    .select({ id: agentRuns.id, status: agentRuns.status, agentId: agentWorks.agentId })
    .from(agentWorks)
    .innerJoin(agentRuns, eq(agentRuns.workId, agentWorks.id))
    .where(and(eq(agentWorks.orgId, orgId), eq(agentWorks.id, workId), eq(agentWorks.agentId, agentId)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row && !isTerminal(row.status) ? row.id : null;
}

/** Live works per agent (for the status line and presence), newest first. */
export async function liveWorksByAgent(db: Executor, orgId: string, agentIds?: string[]) {
  if (agentIds?.length === 0) return new Map<string, WorkView[]>();
  const rows = await db
    .select({ id: agentWorks.id, agentId: agentWorks.agentId })
    .from(agentWorks)
    .where(
      and(
        eq(agentWorks.orgId, orgId),
        inArray(agentWorks.status, ["live", "queued"]),
        ...(agentIds ? [inArray(agentWorks.agentId, agentIds)] : []),
      ),
    )
    .orderBy(desc(agentWorks.startedAt));
  const views = await workViews(
    db,
    orgId,
    rows.map((r) => r.id),
  );
  const out = new Map<string, WorkView[]>();
  for (const r of rows) {
    const v = views.get(r.id);
    if (v) out.set(r.agentId, [...(out.get(r.agentId) ?? []), v]);
  }
  return out;
}

/**
 * The card for a work (§4): the issue it names or the run already works on (linked, its criteria untouched), else a
 * new one assigned to the agent, visible to exactly who reads the conversation.
 */
export async function ensureWorkCard(
  deps: { db: Database; pubsub?: PubSub; context?: ContextDeps },
  workId: string,
  input: { number?: number; description?: string },
) {
  let [work] = await deps.db.select().from(agentWorks).where(eq(agentWorks.id, workId));
  if (!work || work.issueId) return work?.issueId ?? null;
  const [run] = await deps.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.workId, work.id))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  if (!run) return null;
  // A card needs a name: an unnamed work (its model failed at the move) is named now, else at its next check-in.
  if (!work.title) {
    const title = await workTitle(deps, run.id, "");
    if (!title) return null;
    [work] = await deps.db.update(agentWorks).set({ title }).where(eq(agentWorks.id, work.id)).returning();
    if (!work) return null;
  }
  let description = input.description ? cutText(input.description.trim(), 4000) : "";
  if (!description) {
    const [ask] = await deps.db
      .select({ body: messages.body })
      .from(messages)
      .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
    description = ask ? replyExcerpt(ask.body, 500) : "";
  }
  return linkIssueToWork(deps, work, run, { number: input.number, description });
}

/** Continuar on a work's end (§7): the new run carries the same work, line and card, live again. */
export async function reopenWork(tx: Executor, workId: string, now = new Date()) {
  const [row] = await tx
    .update(agentWorks)
    .set({
      status: "live",
      finishedAt: null,
      resultMessageId: null,
      nextUpdateAt: new Date(now.getTime() + WORK_LIMITS.nextDefault * 60_000),
      updatedAt: now,
    })
    .where(eq(agentWorks.id, workId))
    .returning();
  if (row) await scheduleCheckIn(tx, row);
  return row ?? null;
}
