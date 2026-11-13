import type { PubSub } from "@agenteschat/adapters";
import { and, desc, type Executor, eq, gte, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import type { BrainKind, BrainSession, BrainTurn, ToolResult } from "./brains/types";
import { abortLocalRun, RUN_CANCEL_TOPIC } from "./cancel";
import { publishChannelEvent, publishMessageCreated } from "./events";
import type { RunIdentity } from "./executor";
import { wakesLater } from "./follow-through";
import { cutText } from "./format";
import { insertMessage, messageView } from "./messages";
import { MISSION_LIMITS } from "./mission-limits";
import { enqueueRunJob } from "./mission-runs";
import { hasLiveTasks, missionCwd, worktreeBlocksWork } from "./mission-worktree";
import {
  agentAnswers,
  getMissionRow,
  latestPlan,
  MISSION_STUCK,
  type MissionDeps,
  type MissionRow,
  missionOfThread,
  noMentions,
  OPEN_MISSION_STATUSES,
  pauseStuck,
  queueForSession,
  reactivateMission,
  recordMissionEvent,
  type WakeKind,
} from "./missions";
import { enqueue } from "./outbox";
import { resumeRunWithResult } from "./run-resume";
import { revokeRunToolTokens } from "./run-tool-tokens";
import { isTerminal, type RunStatus, transitionRun } from "./runs";
import { pauseStretch, runStretchOf, stretchStop } from "./stretch";

const {
  missions,
  missionEvents,
  agentRuns,
  approvals,
  agentQuestions,
  outbox,
  messages,
  missionDecisions,
  missionReviews,
  missionDeliveries,
  agentConsultations,
} = schema;

/**
 * Missions on the agent engine (ADR 0032 §6, block 4).
 *
 * A mission's main session is the agent's run in the mission's home thread
 * with the mission's brain: `model` (the API, what "executor agent" was),
 * `claude_code` or `codex` (a session on the mission's computer, resumed by
 * `missions.main_session_id`). Everything that wakes the main session — a
 * person's word, Start, accepted suggestions, decisions, reviews, an item's
 * end, the inbox — is a notice in the thread (`meta.missionInbox` / `meta.machineTask`) that starts a run of the
 * engine (`MissionEngine.startRun`), joins the run already working there, or
 * resumes a run paused on that very decision (`MissionEngine.resumeRun`).
 * Item work stays machine tasks (their own session, in the mission's one folder: ADR 0044), started by the
 * run with the gateway tool `start_task`.
 *
 * This is the only path: the main session is never a machine task.
 */

// ── The engine, as the mission side needs it ─────────────────────────────────

/** The engine's `RunIdentity` (executor.ts). */
export type MissionRunIdentity = RunIdentity;

/** A run of the mission's agent in its home thread, on a notice already in the thread. */
export interface MissionRunStart
  extends Pick<BrainTurn, "orgId" | "agentId" | "channelId" | "trigger" | "model" | "session"> {
  threadRootId: string;
  /** The notice this run answers. One run per (agent, trigger message): starting twice is a no-op. */
  triggerMessageId: string;
  /** Hop of the notice (the mission's own wake-ups are 0, so their runs are hop 1). */
  hop: number;
  /** The notice's stretch (ADR 0089), when its run counts toward one (`TellOptions.stretchId`). */
  stretchId?: string | null;
  brain: BrainKind;
  missionId: string;
  /** The person behind it (audience and acting rights), or null for the mission's own notices. */
  requestedBy: string | null;
  kind: WakeKind;
}

/** A run paused on a mission tool (a blocking `ask_decision`, `request_review`) gets its answer. */
export interface MissionRunResume {
  run: MissionRunIdentity;
  /** The pause the gateway returned for the call: the decision's or review's row id. */
  pause: NonNullable<ToolResult["pause"]>;
  /** What the brain reads as the tool's result ("Decision: … → … (by …)"). */
  result: ToolResult;
  /** Computer brains: the session to resume with the result. */
  session?: BrainSession;
}

/**
 * How missions start, resume and cancel runs of the agent engine
 * (`createMissionEngine`; tests pass fakes). The brain is the one the engine
 * resolves for the run (`missionTurnFor` first).
 */
export interface MissionEngine {
  /**
   * Starts (or joins, when the agent already works in that thread) a run on
   * the notice, inside the caller's transaction (the notice and its run commit
   * together). Null: nothing started (the run for that trigger already exists).
   */
  startRun(tx: Executor, input: MissionRunStart): Promise<{ runId: string; steered: boolean } | null>;
  /** Resumes a paused run with the answer. Null: that run doesn't wait on that pause (the caller starts a turn). */
  resumeRun(input: MissionRunResume): Promise<{ runId: string } | null>;
  /** Cancels the agent's active runs in the thread (stop, close, a new brain before Start). Returns their ids. */
  cancelRuns(input: {
    orgId: string;
    agentId: string;
    channelId: string;
    threadRootId: string;
    actorId: string | null;
    reason: string;
  }): Promise<string[]>;
}

export const engineOf = (deps: MissionDeps): MissionEngine => deps.missionEngine ?? createMissionEngine(deps);

// ── Which brain, which session ───────────────────────────────────────────────

const BRAIN_OF_EXECUTOR: Record<string, BrainKind> = { claude: "claude_code", codex: "codex", agent: "model" };
const BRAINS: readonly BrainKind[] = ["model", "claude_code", "codex", "cursor", "opencode", "grok", "antigravity"];

/** Mission columns block 3a adds (`missions.brain`, `missions.brain_model`): read when present. */
type BrainOverride = { brain?: string | null; brainModel?: string | null };

/**
 * The mission's brain: its own override (`missions.brain`), else its executor
 * (claude → claude_code, codex → codex, agent → model). The model is the
 * mission's (`missions.brain_model`), else the brain's default (undefined).
 */
export function missionBrain(mission: Pick<MissionRow, "executor"> & BrainOverride): {
  brain: BrainKind;
  model?: string;
} {
  const override = mission.brain && (BRAINS as readonly string[]).includes(mission.brain) ? mission.brain : null;
  const brain = (override as BrainKind | null) ?? BRAIN_OF_EXECUTOR[mission.executor] ?? "model";
  return mission.brainModel ? { brain, model: mission.brainModel } : { brain };
}

/** Marks the first engine turn of a session (so later turns resume it). */
const SESSION_EVENT = "engine_session";

/**
 * Whether the session already exists on the machine: an earlier engine turn
 * started it. `exceptRunId`: the run asking (its own start doesn't count).
 */
export async function sessionStarted(db: Executor, missionId: string, sessionId: string, exceptRunId?: string | null) {
  const rows = rowsOf<{ yes: boolean | string }>(
    await db.execute(sql`select exists (select 1 from ${missionEvents} e where e.mission_id = ${missionId}::uuid
        and e.kind = ${SESSION_EVENT} and e.data->>'sessionId' = ${sessionId}
        and coalesce(e.data->>'runId', '') <> ${exceptRunId ?? ""}) as yes`),
  );
  const yes = rows[0]?.yes;
  return yes === true || yes === "t";
}

/**
 * The session a computer brain works in: the mission's main session, in its
 * folder (the mission's own copy of the project once it is ready, ADR 0044),
 * on its computer.
 */
export async function missionSession(
  db: Executor,
  mission: Pick<MissionRow, "id" | "mainSessionId" | "machineId" | "repoDir" | "worktreePath" | "worktreeState">,
  brain: BrainKind,
  options: { fresh?: boolean; exceptRunId?: string | null } = {},
): Promise<BrainSession | undefined> {
  if (brain === "model" || !mission.machineId) return undefined;
  const resume = options.fresh
    ? false
    : await sessionStarted(db, mission.id, mission.mainSessionId, options.exceptRunId);
  return { id: mission.mainSessionId, resume, machineId: mission.machineId, cwd: missionCwd(mission) };
}

/**
 * The first step of `resolveBrain` (`brainFor(agent, run, mission?)`): a run of
 * the mission's agent in an open mission's home thread thinks with the
 * mission's brain, in its main session. Null: not a mission run (the agent's
 * own brain applies). A person's message in the thread starts its run in the
 * message insert as today; this is how that run gets the mission's brain.
 */
export async function missionTurnFor(
  db: Executor,
  run: { id?: string | null; orgId: string; agentId: string; threadRootId: string; triggerMessageId?: string },
): Promise<{ missionId: string; brain: BrainKind; model?: string; session?: BrainSession } | null> {
  // A run started by a top-level message can't be a mission's (its home thread exists only after it): no query.
  if (!run.threadRootId || run.threadRootId === run.triggerMessageId) return null;
  const mission = await missionOfThread(db, run.orgId, run.threadRootId);
  if (!mission || mission.agentId !== run.agentId || !OPEN_MISSION_STATUSES.includes(mission.status)) return null;
  const choice = missionBrain(mission as MissionRow & BrainOverride);
  const session = await missionSession(db, mission, choice.brain, { exceptRunId: run.id ?? null });
  return { missionId: mission.id, ...choice, ...(session ? { session } : {}) };
}

// ── Telling the main session ─────────────────────────────────────────────────

/**
 * Whether the main session may work now (an active mission, or a proposed one
 * being planned, with a computer), and not while its folder is being prepared
 * or failed to be (ADR 0044: what it is told waits in the inbox until ready).
 */
const canWork = (mission: Pick<MissionRow, "status" | "machineId" | "worktreeState">) =>
  Boolean(mission.machineId) &&
  (mission.status === "active" || mission.status === "awaiting_close" || mission.status === "proposed") &&
  !worktreeBlocksWork(mission);

export interface TellOptions {
  requestedBy?: string | null;
  from?: string;
  kind?: WakeKind;
  /** The notice's own body and meta (a task's end); default: the text as `meta.missionInbox`. */
  notice?: { body: string; meta: Record<string, unknown> };
  /** The answer to a paused call (a blocking decision or review): resume that run when it waits on it. */
  resume?: NonNullable<ToolResult["pause"]>;
  /** A new main session (planning after a proposal or a new brain): its first turn starts it. */
  freshSession?: boolean;
  /** The stretch the wake-up counts in (its run at hop 2, as agents' own wake-ups are): none, it counts in none. */
  stretchId?: string;
}

/** The latest run of the agent in the thread that waits for a person (approval or input). */
async function waitingRun(db: Executor, mission: MissionRow) {
  const [row] = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, mission.orgId),
        eq(agentRuns.agentId, mission.agentId),
        eq(agentRuns.channelId, mission.channelId),
        eq(agentRuns.threadRootId, mission.threadRootId),
        inArray(agentRuns.status, ["waiting_input", "waiting_approval"]),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Tells the mission's main session something: a run paused on this very
 * answer resumes; otherwise a notice in the home thread starts a run with the
 * mission's brain (or joins the one working there). These wake-ups are hop 0:
 * inside a mission its own notices don't count toward the agent-to-agent
 * limit; the budget is the brake, plus the stuck-loop guard (wake-ups in a row
 * with no plan item moving pause the mission). Paused, closed or without a
 * computer: the text waits in the inbox (delivered by `deliverMissionInbox`).
 */
export async function tellMainSession(
  deps: MissionDeps,
  mission: MissionRow,
  text: string,
  options: TellOptions = {},
): Promise<{ delivered: boolean; runId?: string; resumed?: boolean }> {
  const body = cutText(text, MISSION_LIMITS.sendText);
  let fresh = (await getMissionRow(deps.db, mission.id)) ?? mission;
  if (!OPEN_MISSION_STATUSES.includes(fresh.status)) return { delivered: false };
  const kind = options.kind ?? (options.requestedBy ? "person" : "system");
  if (fresh.status === "awaiting_close" && (options.requestedBy || kind === "person")) {
    fresh = await reactivateMission(deps, fresh, "message");
  }
  const entry = { sessionId: fresh.mainSessionId, cwd: missionCwd(fresh), text: body, at: new Date().toISOString() };
  if (!canWork(fresh)) {
    await queueForSession(deps.db, fresh, entry);
    return { delivered: false };
  }
  const choice = missionBrain(fresh as MissionRow & BrainOverride);
  const engine = engineOf(deps);
  if (options.resume) {
    const waiting = await waitingRun(deps.db, fresh);
    if (waiting) {
      const session = await missionSession(deps.db, fresh, choice.brain);
      const resumed = await engine.resumeRun({
        run: { orgId: fresh.orgId, agentId: fresh.agentId, runId: waiting.id, machineId: fresh.machineId ?? "" },
        pause: options.resume,
        result: { content: body },
        ...(session ? { session } : {}),
      });
      if (resumed) {
        await recordMissionEvent(deps.db, fresh, "engine_resumed", {
          runId: resumed.runId,
          pause: options.resume,
        });
        return { delivered: true, runId: resumed.runId, resumed: true };
      }
    }
  }
  // The stuck-loop guard: a person's word resets it; other wake-ups count until the plan moves.
  const [counted] = await deps.db
    .update(missions)
    .set({ idleWakeups: kind === "person" ? 0 : sql`${missions.idleWakeups} + 1` })
    .where(eq(missions.id, fresh.id))
    .returning({ idle: missions.idleWakeups });
  if (fresh.status === "active" && (counted?.idle ?? 0) > MISSION_STUCK.idleWakeups) {
    await queueForSession(deps.db, fresh, entry);
    await pauseStuck(deps, fresh, "no_progress");
    return { delivered: false };
  }
  const requester = options.requestedBy ?? fresh.ownerId;
  const answers = requester ? await agentAnswers(deps.db, fresh, requester) : false;
  const from = options.from ?? "the mission";
  const session = await missionSession(deps.db, fresh, choice.brain, { fresh: options.freshSession });
  const out = await deps.db.transaction(async (tx) => {
    const message = await insertMessage(tx, {
      orgId: fresh.orgId,
      channelId: fresh.channelId,
      threadId: fresh.threadRootId,
      author: {
        type: "agent",
        agentId: fresh.agentId,
        runId: null,
        hop: options.stretchId ? 1 : 0,
        stretchId: options.stretchId ?? null,
      },
      body: options.notice?.body ?? (noMentions(body).slice(0, 39_000) || "…"),
      meta: options.notice?.meta ?? {
        missionInbox: { missionId: fresh.id, from, text: noMentions(body), requestedBy: requester, kind },
        bodyCode: "mission_inbox",
        bodyParams: { from },
      },
    });
    const started = answers
      ? await engine.startRun(tx, {
          orgId: fresh.orgId,
          agentId: fresh.agentId,
          channelId: fresh.channelId,
          threadRootId: fresh.threadRootId,
          triggerMessageId: message.id,
          hop: message.hop,
          stretchId: message.stretchId,
          trigger: body,
          brain: choice.brain,
          ...(choice.model ? { model: choice.model } : {}),
          ...(session ? { session } : {}),
          missionId: fresh.id,
          requestedBy: options.requestedBy ?? null,
          kind,
        })
      : null;
    // The session's first turn: later turns resume it.
    if (session && !session.resume && started && !started.steered) {
      await recordMissionEvent(tx, fresh, SESSION_EVENT, { sessionId: session.id, runId: started.runId });
    }
    return { message, started };
  });
  if (deps.pubsub) {
    await publishMessageCreated(deps.pubsub, messageView(out.message));
    if (out.started && !out.started.steered) {
      await publishChannelEvent(deps.pubsub, {
        type: "agent.thinking",
        channelId: fresh.channelId,
        threadId: fresh.threadRootId,
        agentId: fresh.agentId,
        runId: out.started.runId,
      });
    }
  }
  await recordMissionEvent(deps.db, fresh, "agent_woken", {
    kind,
    brain: choice.brain,
    messageId: out.message.id,
    runId: out.started?.runId ?? null,
  });
  const runId = out.started?.runId;
  return { delivered: Boolean(runId), ...(runId ? { runId } : {}) };
}

/**
 * The inbox: what waits for the main session goes out at once (one notice,
 * one run or join); what waits for item sessions resumes them as machine
 * tasks (`deliverItemInbox`).
 */
export async function deliverMissionInbox(
  deps: MissionDeps,
  missionId: string,
  deliverItemInbox: (deps: MissionDeps, mission: MissionRow, except: string) => Promise<number>,
) {
  const mission = await getMissionRow(deps.db, missionId);
  if (!mission || mission.inbox.length === 0) return 0;
  let sent = 0;
  const main = mission.inbox.filter((e) => e.sessionId === mission.mainSessionId);
  if (main.length > 0 && canWork(mission)) {
    const ats = main.map((e) => e.at);
    // Claim these entries first (another delivery may run at the same time).
    const [claimed] = await deps.db
      .update(missions)
      .set({
        inbox: sql`coalesce((select jsonb_agg(x.value) from jsonb_array_elements(${missions.inbox}) x
          where not (x.value->>'sessionId' = ${mission.mainSessionId}
            and x.value->>'at' = any(${`{${ats.join(",")}}`}::text[]))), '[]'::jsonb)`,
      })
      .where(
        and(
          eq(missions.id, mission.id),
          sql`exists (select 1 from jsonb_array_elements(${missions.inbox}) x where x.value->>'at' = ${ats[0] as string})`,
        ),
      )
      .returning({ id: missions.id });
    if (claimed) {
      const text = main.map((e) => e.text).join("\n\n");
      const out = await tellMainSession(deps, mission, text, { from: "the mission", kind: "system" }).catch(
        async () => {
          for (const e of main) await queueForSession(deps.db, mission, e);
          return { delivered: false };
        },
      );
      if (out.delivered) sent++;
    }
  }
  sent += await deliverItemInbox(deps, mission, mission.mainSessionId);
  return sent;
}

// ── Keeping the work going between messages ──────────────────────────────────

/** The outbox job that checks, a while after a mission run ended, whether the work goes on by itself. */
export const KEEP_GOING_JOB = "mission.keep_going";
/** How long after a mission run ends it goes on by itself (a person writing meanwhile starts a run first). */
export const KEEP_GOING_DELAY_MS = 60_000;

/** What the main session reads when its turn ended with plan items open and nothing waiting on a person. */
export const KEEP_GOING_PROMPT =
  "Your last turn ended with plan items still open and nothing waiting on a person: go on with the next one now. If you can't go on without something only a person can give (a credential, an access, a decision, a test only they can run), ask for it directly now: ask_user with one clear question (request_secret for a credential, a blocking ask_decision for a choice, browser_ask_person or desktop_ask_person for a sign-in, a QR code or a code once the page or app is at that step), and mark that item waiting_you. A step that needs a person is never a reason to stop: do everything up to it, then hand it over. A list of what is missing is not a question. If the plan is out of date, fix it with update_plan.";

/** Schedules the keep-going check of a mission whose run just ended (`keepMissionGoing`). */
export async function scheduleKeepGoing(db: Executor, mission: { id: string; orgId: string }) {
  const at = Date.now() + KEEP_GOING_DELAY_MS;
  await enqueue(db, {
    orgId: mission.orgId,
    kind: KEEP_GOING_JOB,
    payload: { missionId: mission.id },
    dedupeKey: `${KEEP_GOING_JOB}:${mission.id}:${Math.floor(at / 10_000)}`,
    runAt: new Date(at),
    maxAttempts: 3,
  });
}

/** Whether a card in the mission waits on a person: a decision, a review or a delivery (its answer wakes the agent). */
export async function missionAsksPerson(db: Executor, missionId: string): Promise<boolean> {
  const [row] = rowsOf<{ asks: boolean | string }>(
    await db.execute(sql`select
      exists (select 1 from ${missionDecisions} d where d.mission_id = ${missionId}::uuid and d.status = 'pending')
        or exists (select 1 from ${missionReviews} v where v.mission_id = ${missionId}::uuid and v.status = 'pending')
        or exists (select 1 from ${missionDeliveries} l where l.mission_id = ${missionId}::uuid and l.status = 'pending')
        as asks`),
  );
  return row?.asks === true || row?.asks === "t";
}

/**
 * Why the mission doesn't go on by itself now, or null when it should: it isn't active or can't work, no plan item
 * is open (todo or doing), the agent works or waits in the thread, a card waits on a person, its last run ended
 * waiting on a person (the follow-through verdict), something already wakes it (a follow-up there, another agent's
 * answer it asked for, a reminder, a detached wait: `wakesLater`), or an item runs on the computer.
 */
export async function keepGoingBlocker(db: Executor, mission: MissionRow): Promise<string | null> {
  if (mission.status !== "active" || !canWork(mission)) return "not_working";
  const plan = await latestPlan(db, mission.id);
  const items = Array.isArray(plan?.items) ? (plan.items as { status?: string }[]) : [];
  if (!items.some((i) => i.status === "todo" || i.status === "doing")) return "no_open_items";
  const inThread = and(
    eq(agentRuns.orgId, mission.orgId),
    eq(agentRuns.agentId, mission.agentId),
    eq(agentRuns.channelId, mission.channelId),
    eq(agentRuns.threadRootId, mission.threadRootId),
  );
  const [active] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(inThread, inArray(agentRuns.status, ["queued", "running", "waiting_input", "waiting_approval"])))
    .limit(1);
  if (active) return "run_active";
  if (await missionAsksPerson(db, mission.id)) return "waiting_person";
  const [last] = await db.select().from(agentRuns).where(inThread).orderBy(desc(agentRuns.createdAt)).limit(1);
  const transcript = (last?.transcript ?? {}) as {
    followThroughVerdict?: string;
    detachedWaits?: { waitId: string }[];
  };
  if (transcript.followThroughVerdict === "waiting") return "asked_person";
  const [row] = rowsOf<{ wakes: boolean | string }>(
    await db.execute(sql`select
      exists (select 1 from ${messages} m where m.org_id = ${mission.orgId}::uuid and m.channel_id = ${mission.channelId}::uuid
        and m.thread_id = ${mission.threadRootId}::uuid and m.author_agent_id = ${mission.agentId}::uuid
        and m.deleted_at is null and m.meta->'notice'->>'kind' = 'follow_up'
        and m.meta->'notice'->'refs'->>'state' = 'pending')
      or exists (select 1 from ${agentConsultations} c join ${agentRuns} r on r.id = c.asker_run_id
        where c.org_id = ${mission.orgId}::uuid and c.status = 'open' and r.agent_id = ${mission.agentId}::uuid
          and r.channel_id = ${mission.channelId}::uuid and r.thread_root_id = ${mission.threadRootId}::uuid) as wakes`),
  );
  if (row?.wakes === true || row?.wakes === "t") return "wakes_later";
  if (last && (await wakesLater(db, last, transcript.detachedWaits))) return "wakes_later";
  if (await hasLiveTasks(db, mission.id)) return "task_running";
  return null;
}

/** The text of the last report card the run's agent posted in its thread since the run started (`report`). */
export async function missionReportSince(
  db: Executor,
  run: { orgId: string; agentId: string; channelId: string; createdAt: Date },
  threadId: string | null,
) {
  if (!threadId) return "";
  const [row] = await db
    .select({ body: messages.body })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        eq(messages.threadId, threadId),
        eq(messages.authorAgentId, run.agentId),
        gte(messages.createdAt, run.createdAt),
        sql`${messages.meta}->'missionReport' is not null`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return row?.body ?? "";
}

/**
 * Job `mission.keep_going`: a mission run ended a while ago. With plan items open and nothing waiting on a person,
 * the main session is told to go on (`tellMainSession`): a wake-up of the mission's own, so the stuck guard counts it
 * (wake-ups in a row with no plan item moving pause the mission), and in the stretch of its last run, so the stretch
 * limits hold it even while the plan keeps changing (a person's message opens a new one). Returns whether it woke.
 */
export async function keepMissionGoing(deps: MissionDeps, missionId: string) {
  const mission = await getMissionRow(deps.db, missionId);
  // What waits in its inbox goes out with the inbox's own delivery.
  if (!mission || mission.inbox.some((e) => e.sessionId === mission.mainSessionId)) return false;
  if (await keepGoingBlocker(deps.db, mission)) return false;
  // It counts in the stretch of the thread's last run: past its limit, the pause card instead (its Continuar goes on).
  const [last] = await deps.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, mission.orgId),
        eq(agentRuns.agentId, mission.agentId),
        eq(agentRuns.channelId, mission.channelId),
        eq(agentRuns.threadRootId, mission.threadRootId),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  const stretchId = last ? runStretchOf(last) : undefined;
  if (last && stretchId) {
    const stop = await stretchStop(deps.db, mission.orgId, stretchId, mission.agentId);
    if (stop) {
      await pauseStretch(deps.db, mission.orgId, {
        stretchId,
        channelId: mission.channelId,
        threadId: mission.threadRootId,
        authorAgentId: mission.agentId,
        runId: last.id,
        hop: last.hop,
        agentId: mission.agentId,
        messageId: null,
        trigger: "mention",
        stop,
      });
      return false;
    }
  }
  const out = await tellMainSession(deps, mission, KEEP_GOING_PROMPT, {
    kind: "system",
    from: "the mission",
    ...(stretchId ? { stretchId } : {}),
  });
  return out.delivered;
}

/** Stop, close or a new brain: the main session's runs in the thread are canceled. */
export async function cancelMainRuns(deps: MissionDeps, mission: MissionRow, actorId: string | null, reason: string) {
  const ids = await engineOf(deps).cancelRuns({
    orgId: mission.orgId,
    agentId: mission.agentId,
    channelId: mission.channelId,
    threadRootId: mission.threadRootId,
    actorId,
    reason,
  });
  if (ids.length > 0) await recordMissionEvent(deps.db, mission, "engine_runs_canceled", { runIds: ids, reason });
  return ids;
}

// ── The engine missions use ──────────────────────────────────────────────────

/**
 * `MissionEngine` on the agent engine (ADR 0032): a start is a run row and its
 * `agent_run.execute` job in the caller's transaction (`enqueueRunJob`; one
 * run per agent and trigger message: a second start for the same notice is a
 * no-op), or the notice joins the run already working in the thread. The
 * engine resolves the mission's brain and session when the run executes
 * (`resolveBrain` → `missionTurnFor`). A resume answers the run's waiting
 * call (`resumeRunWithResult`, pause id = the decision's or review's id);
 * cancel stops the agent's runs in the thread and revokes their tool tokens.
 */
export function createMissionEngine(deps: { pubsub?: PubSub; db: MissionDeps["db"] }): MissionEngine {
  return {
    async startRun(tx, input) {
      const [existing] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, input.orgId),
            eq(agentRuns.agentId, input.agentId),
            eq(agentRuns.triggerMessageId, input.triggerMessageId),
          ),
        )
        .limit(1);
      if (existing) return null;
      const out = await enqueueRunJob(
        tx,
        {
          id: input.triggerMessageId,
          orgId: input.orgId,
          channelId: input.channelId,
          threadId: input.threadRootId,
          hop: input.hop,
          stretchId: input.stretchId ?? null,
        },
        input.agentId,
      );
      if (out.run) return { runId: out.run.id, steered: false };
      if (out.steered) return { runId: out.steered, steered: true };
      return null;
    },
    async resumeRun(input) {
      return resumeRunWithResult(deps.db, { runId: input.run.runId, waitId: input.pause.id, result: input.result });
    },
    async cancelRuns(input) {
      const ids = await cancelThreadRuns(deps, input);
      for (const runId of ids) await revokeRunToolTokens(deps.db, { runId }).catch(() => undefined);
      return ids;
    },
  };
}

/** Cancels the agent's active runs in a thread, for the mission (not a person's own stop: no permission check here). */
async function cancelThreadRuns(
  deps: { pubsub?: PubSub; db: MissionDeps["db"] },
  input: { orgId: string; agentId: string; channelId: string; threadRootId: string; actorId: string | null },
) {
  const active = await deps.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, input.orgId),
        eq(agentRuns.agentId, input.agentId),
        eq(agentRuns.channelId, input.channelId),
        eq(agentRuns.threadRootId, input.threadRootId),
        inArray(agentRuns.status, ["queued", "running", "waiting_approval", "waiting_input"]),
      ),
    );
  const ids: string[] = [];
  for (const run of active) {
    const from: RunStatus = run.status;
    if (isTerminal(from)) continue;
    const moved = await deps.db.transaction(async (tx) => {
      const row = await transitionRun(tx, run.id, from, "canceled", {
        error: `canceled_by:${input.actorId ?? "mission"}`,
      });
      if (!row) return null;
      const now = new Date();
      await tx
        .update(approvals)
        .set({ status: "canceled", decidedAt: now })
        .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending")));
      await tx
        .update(agentQuestions)
        .set({ status: "canceled" })
        .where(and(eq(agentQuestions.runId, run.id), eq(agentQuestions.status, "open")));
      await tx
        .delete(outbox)
        .where(
          and(
            eq(outbox.kind, "agent_run.execute"),
            eq(outbox.status, "pending"),
            sql`${outbox.payload}->>'runId' = ${run.id}`,
          ),
        );
      return row;
    });
    if (!moved) continue;
    ids.push(run.id);
    abortLocalRun(run.id);
    if (deps.pubsub) await deps.pubsub.publish(RUN_CANCEL_TOPIC, { type: "run.cancel", runId: run.id }).catch(() => {});
    const where = { channelId: run.channelId, threadId: run.threadRootId, agentId: run.agentId, runId: run.id };
    await publishChannelEvent(deps.pubsub, { type: "agent.run", ...where, status: "canceled" });
    if (from !== "running") {
      await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where });
      await publishChannelEvent(deps.pubsub, { type: "run.finished", ...where, status: "canceled" });
    }
  }
  return ids;
}
