import {
  findPullRequestUrl,
  type MachineReplies,
  type MachineRequest,
  MISSION_PROTOCOL,
  type PubSub,
  parseBaseBehind,
  type RunnerFrame,
  type RunnerTask,
  TASK_ACCOUNTS_PROTOCOL,
  TASK_LIMITS,
  TASKS_PROTOCOL,
  type TaskExecutor,
} from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { AppLocale } from "@agenteschat/i18n/locale";
import { isAutoModel } from "@agenteschat/providers";
import { autoPlanModel, claudeCodeModel, planOf } from "@agenteschat/providers/plans";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { createAgentRuns, eligibleChannelAgents } from "./dispatch";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { cutText } from "./format";
import { routineDeliveryBlock } from "./hand-off";
import { taskEndLine, taskEndText } from "./machine-task-text";
import {
  getMachineById,
  MachineDroppedError,
  MachineOfflineError,
  MachinePausedError,
  type MachineRow,
  machineOnline,
  publishMachineStatus,
} from "./machines";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import { blockedOfTask, missionAllowRules, recordTaskDenials } from "./mission-command-rules";
import { MISSION_RULES } from "./mission-rules";
import { recordTaskFinished } from "./operator-events";
import { enqueue } from "./outbox";
import { lineLocale, personBehindCall } from "./requester";
import { routineBriefOf } from "./routine-brief";
import { issueRunToolToken } from "./run-tool-tokens";
import { runnerUpdateWay } from "./runner-update";
import { replyThreadOf } from "./runs";
import { hopLimitReached, runStretchOf } from "./stretch";
import type { ToolContext } from "./tools/types";

const { machineTasks, agentRuns } = schema;

/**
 * Background tasks on connected machines, server side (ADR 0029 sections 4
 * and 5). The runner runs them detached and reports `task.event` and
 * `task.done`; the replica holding the machine's socket persists both
 * (`machine-hub.ts`). A task's end wakes its conversation through the
 * outbox (`machine.task_done`): a short notice in the thread, then a run of
 * the agent that started it, which tells the people. A machine that goes
 * away interrupts its tasks after a grace; when it comes back its journal is
 * reconciled and Claude Code tasks resume their session by themselves.
 */
export type MachineTaskRow = typeof machineTasks.$inferSelect;
export type MachineTaskStatus = MachineTaskRow["status"];

/**
 * Running tasks of a machine that went offline become `interrupted` after this (it may just be a network blip
 * or a runner dialing again); it is also when an offline computer becomes an outage people see.
 */
export const TASK_OFFLINE_GRACE_MS = 2 * 60_000;
/**
 * A start may still be underway on the computer this long after it began (its journal doesn't list the task
 * yet): a hello in that time says nothing about it.
 */
export const TASK_START_GRACE_MS = 2 * 60_000;
/** An interrupted task resumes at most this many times in a row. */
export const MAX_TASK_RESUMES = 3;
/** What a resumed Claude Code session is told. */
export const RESUME_PROMPT =
  "You were interrupted (the computer went offline). Look at your folder (git status when it is a git repository) and continue where you stopped.";
export const TASK_TEXT_LIMITS = { title: 120, command: 2000, prompt: 20_000, wakeResult: 4000 } as const;

/**
 * A live task: it runs or may (queued, in our queue or being started;
 * running; interrupted and may come back) and hasn't ended. The one
 * predicate for "a task of the mission is live" (ADR 0044): rows
 * (`isLiveTaskRow`), Drizzle queries (`liveTaskWhere`) and raw SQL over an
 * alias (`liveTaskSqlAs`).
 */
export const LIVE_TASK_STATUSES: readonly MachineTaskStatus[] = ["queued", "running", "interrupted"];
const ACTIVE = LIVE_TASK_STATUSES as MachineTaskStatus[];
export const isLiveTaskRow = (t: Pick<MachineTaskRow, "status" | "endedAt"> | null | undefined) =>
  Boolean(t && LIVE_TASK_STATUSES.includes(t.status) && !t.endedAt);
export const liveTaskWhere = () => and(isNull(machineTasks.endedAt), inArray(machineTasks.status, ACTIVE));
export const liveTaskSqlAs = (alias: string) =>
  sql.raw(`${alias}.ended_at is null and ${alias}.status in (${ACTIVE.map((s) => `'${s}'`).join(", ")})`);
/** Its start was cut by a drop (`launchTask`): never seen running, it may run there or may never have started. */
export const isCutStart = (t: Pick<MachineTaskRow, "status" | "startedAt" | "endedAt">) =>
  t.status === "interrupted" && !t.startedAt && !t.endedAt;

/** `checkCutTaskStart` for this task in `inMs`. */
const enqueueStartCheck = (db: Executor, row: Pick<MachineTaskRow, "id" | "orgId">, inMs: number) =>
  enqueue(db, {
    orgId: row.orgId,
    kind: "machine.task_start_check",
    payload: { taskId: row.id },
    dedupeKey: `machine.task_start_check:${row.id}:${Date.now()}`,
    runAt: new Date(Date.now() + inMs),
  });

/** `machine_tasks.recent_lines` keeps this many human lines ("Ver saída" while the computer is offline). */
export const RECENT_LINES = 50;

/**
 * A mission task's kind (ADR 0044): `write` items run one at a time in the
 * mission's folder and end in a commit, `read` items run in parallel with no
 * write access, `setup` prepares the folder before any item.
 */
export type MachineTaskMode = "write" | "read" | "setup";
export const MACHINE_TASK_MODES: readonly MachineTaskMode[] = ["write", "read", "setup"];
export const taskModeOf = (v: unknown): MachineTaskMode | null =>
  typeof v === "string" && (MACHINE_TASK_MODES as readonly string[]).includes(v) ? (v as MachineTaskMode) : null;

/** A task as the app and the agent's tools see it. */
export interface MachineTaskView {
  id: string;
  agentId: string;
  machineId: string;
  channelId: string;
  threadId: string | null;
  /** The mission it works for (ADR 0029), or null. */
  missionId: string | null;
  title: string;
  executor: string;
  status: MachineTaskStatus;
  exitCode: number | null;
  seconds: number | null;
  lastLine: string | null;
  files: string[];
  /** A pull request it opened (from the executor's tools or its output), or null. */
  prUrl: string | null;
  branch: string | null;
  cwd: string | null;
  /** A mission task's kind (ADR 0044): `write`, `read` or `setup`; null for other tasks. */
  mode: MachineTaskMode | null;
  /** A write item's `HEAD` when it started and after its commit (equal: it changed nothing). */
  startSha: string | null;
  endSha: string | null;
  resumedFromId: string | null;
  resumedTaskId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
}

export function machineTaskView(row: MachineTaskRow): MachineTaskView {
  return {
    id: row.id,
    agentId: row.agentId,
    machineId: row.machineId,
    channelId: row.channelId,
    threadId: row.threadRootId,
    missionId: row.missionId,
    title: row.title,
    executor: row.executor,
    status: row.status,
    exitCode: row.exitCode,
    seconds: row.seconds,
    lastLine: row.lastLine,
    files: Array.isArray(row.files) ? row.files : [],
    prUrl: row.prUrl ?? null,
    branch: row.branch,
    cwd: row.cwd,
    mode: taskModeOf(row.mode),
    startSha: row.startSha ?? null,
    endSha: row.endSha ?? null,
    resumedFromId: row.resumedFromId,
    resumedTaskId: row.resumedTaskId,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `machine.task` to the task's conversation (ADR 0010). */
export async function publishTaskEvent(pubsub: PubSub | undefined, row: MachineTaskRow) {
  await publishChannelEvent(pubsub, {
    type: "machine.task",
    channelId: row.channelId,
    threadId: row.threadRootId,
    task: machineTaskView(row),
  });
}

/** Elapsed seconds now, or at the end. */
export function taskSeconds(row: Pick<MachineTaskRow, "seconds" | "startedAt" | "endedAt">, now = Date.now()) {
  if (row.seconds !== null && row.endedAt) return row.seconds;
  if (!row.startedAt) return row.seconds ?? 0;
  return Math.max(row.seconds ?? 0, Math.round(((row.endedAt?.getTime() ?? now) - row.startedAt.getTime()) / 1000));
}

export { formatDuration } from "./machine-task-text";

/** Titles go into the thread as plain text: no mentions. */
const plainTitle = (title: string) =>
  title
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/@/g, "")
    .trim()
    .slice(0, TASK_TEXT_LIMITS.title) || "Task";

/** How the server reaches the runner: the hub's `call` (any replica), or a local socket's. */
export type TaskCall = <Op extends "task.start" | "task.status" | "task.cancel">(
  machineId: string,
  request: Extract<MachineRequest, { op: Op }>,
) => Promise<MachineReplies[Op]>;

export interface TaskDeps {
  db: Database;
  pubsub?: PubSub;
}

export interface StartTaskInput {
  orgId: string;
  agent: { id: string; handle: string };
  machineId: string;
  /** The runner's protocol (from the machine's last hello): older than 4 can't run tasks. */
  protocol: number;
  machineName: string;
  channelId: string;
  threadRootId: string | null;
  runId: string | null;
  requestedByUserId: string | null;
  title: string;
  executor: TaskExecutor;
  command?: string;
  prompt?: string;
  sessionId?: string | null;
  branch?: string | null;
  maxSeconds?: number;
  resumedFromId?: string | null;
  resumeCount?: number;
  /** `claude`: resume the session (a hint; the runner checks its disk). */
  resume?: boolean;
  /** Where it runs, relative to the agent's folder (a mission's repository, or the worktree of the session to resume). */
  cwd?: string | null;
  /** A mission's task (protocol 5): the runner gives its executor the `agentes` MCP server and these rules. */
  mission?: {
    id: string;
    rules: string;
    mode?: "plan" | "work";
    branchPrefix?: string;
    /** Commands a person allowed for the whole mission (Claude Code rules). */
    allow?: string[];
  } | null;
  /** Tags the task as the mission's without the MCP server (our agent's own tasks in agent mode; protocol 4). */
  missionId?: string | null;
  /** A mission task's kind (ADR 0044). */
  mode?: MachineTaskMode | null;
  /** Protocol 14: commit what changed when it ends (`TaskStart.commit`). */
  commit?: { message: string } | null;
  /** Protocol 14: how far the mission's base moved (`TaskStart.baseCheck`). */
  baseCheck?: { branch: string; sha: string } | null;
  /** The mission's branch the folder is on (recorded on the row; the runner makes no branch for it). */
  worktreeBranch?: string | null;
  /** A person approved starting this very task: a shell task's command runs even when the computer would hold it. */
  approved?: boolean;
}

/** What a task waiting in our queue keeps to start later (`machine_tasks.start_request`). */
export type QueuedTaskStart = Omit<StartTaskInput, "protocol" | "machineName">;

/** A runner older than protocol 4 can't run background tasks: the computer needs an update (`runnerUpdateWay`). */
export class RunnerOutdatedError extends Error {
  constructor(
    readonly machineName: string,
    missions = false,
    computer?: Parameters<typeof runnerUpdateWay>[0],
  ) {
    super(
      missions
        ? `The runner on the computer ${machineName} is too old for missions. ${runnerUpdateWay(computer)}`
        : `The runner on the computer ${machineName} is too old for background tasks (until then use run_code). ${runnerUpdateWay(computer)}`,
    );
    this.name = "RunnerOutdatedError";
  }
}

/** A Claude Code or Codex task has nothing to sign in with on its computer: it would only fail "Not logged in". */
export class TaskSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSignInError";
  }
}

/** The CLI a task's executor runs: its accounts' kind, and the names people know it and its plans by. */
const TASK_CLIS = {
  claude: { kind: "claude_code", cli: "Claude Code", plan: "Claude" },
  codex: { kind: "codex", cli: "Codex", plan: "ChatGPT" },
} as const;

/**
 * What a Claude Code or Codex task signs in with (ADR 0041 §5.1), by its turns' rules (`computerBrainUnavailable`):
 * the agent's own account for that CLI on that computer (`brainAccountFor`) where the runner takes one
 * (`TASK_ACCOUNTS_PROTOCOL`), else the computer's own sign-in, as before, where that thinks for the agent (ADR 0059
 * §3). Throws `TaskSignInError`, with what the agent can do, when the task has nothing to sign in with there.
 */
export async function taskSignIn(
  db: Database,
  input: Pick<QueuedTaskStart, "orgId" | "agent" | "machineId" | "executor">,
): Promise<{ account?: string; model?: string }> {
  if (input.executor !== "claude" && input.executor !== "codex") return {};
  const [agent, machine] = await Promise.all([
    getAgentCached(db, input.orgId, input.agent.id),
    getMachineById(db, input.machineId),
  ]);
  if (!agent || !machine) return {};
  // Loaded here: the brains' selection builds on the missions, which build on this module.
  const { brainAccountFor, planIsOwners, storedPlanUsage } = await import("./brains/select");
  const { kind, cli, plan } = TASK_CLIS[input.executor];
  const own = await brainAccountFor(db, agent, kind, machine.id);
  const account = own && machine.protocol >= TASK_ACCOUNTS_PROTOCOL ? own : undefined;
  const refuse = (why: string, who: string) =>
    new TaskSignInError(`${why} Tell the person: ${who} (until then do this work with run_code or a shell task).`);
  // On a computer nobody connected, nobody signs its CLIs in: only an account of the agent's own can.
  if (!account && machine.pairedByUserId === null) {
    if (own) {
      throw refuse(
        `The runner on ${machine.name} is too old to sign tasks in with your ${plan} account.`,
        "the computer's runner needs an update before tasks can use your account, so try again later",
      );
    }
    const other = input.executor === "codex" ? "claude" : "codex";
    const instead = await brainAccountFor(db, agent, TASK_CLIS[other].kind, machine.id);
    throw refuse(
      `${cli} has nothing to sign in with on ${machine.name}: you have no ${plan} account there, and nobody signs ${cli} in on that computer itself.${instead ? ` Your own account there signs in ${TASK_CLIS[other].cli}: start the task with executor "${other}".` : ""}`,
      `your owner can connect a ${plan} account on your page`,
    );
  }
  // The owner-only plan rule binds where turns already apply it: an account, or an agent that thinks with this CLI.
  // Other agents' tasks keep the computer's own sign-in, as before this rule reached tasks.
  const thinksWithIt = account || agent.brain === kind;
  if (thinksWithIt && !(await planIsOwners(db, agent, machine.id, account))) {
    throw refuse(
      `${cli} on ${machine.name} would think with a plan that isn't your owner's (a plan thinks only for its owner's agents).`,
      `your owner can connect a ${plan} account of their own on your page`,
    );
  }
  if (account?.status === "signed_out") {
    throw refuse(
      `Your ${plan} account "${account.label}" on ${machine.name} is signed out, so ${cli} can't sign in for this task.`,
      "its owner can sign in to it again in Settings, AI accounts",
    );
  }
  if (!account && kind === "claude_code" && machine.executors?.claude?.loggedIn === false) {
    throw refuse(
      `${cli} isn't signed in on ${machine.name}.`,
      `its owner can sign it in there, or your owner can connect a ${plan} account on your page`,
    );
  }
  if (!account) return {};
  // On a coding plan's key, the agent's model there (its turns'), "Automático" as its turns run it.
  const keyPlan = input.executor === "claude" ? planOf(account.provider) : undefined;
  if (!keyPlan) return { account: account.id };
  const chosen = agent.brainModel && !isAutoModel(agent.brainModel) ? agent.brainModel : undefined;
  const usage = chosen ? null : await storedPlanUsage(db, input.orgId, machine.id, kind, account.id).catch(() => null);
  const model = chosen ?? autoPlanModel(account.provider, "sonnet", usage);
  return { account: account.id, ...(model ? { model: claudeCodeModel(keyPlan, model) } : {}) };
}

/**
 * Records a task and asks the machine to start it. On failure the row is
 * kept as `failed` with the reason, and the error goes up.
 */
export async function startMachineTask(
  deps: TaskDeps & { call: TaskCall },
  input: StartTaskInput,
  options: { requeue?: boolean } = {},
) {
  await checkTaskProtocol(deps.db, input);
  const row = await insertTask(deps.db, input, null);
  return (await launchTask(deps, row, input, options)).row;
}

async function checkTaskProtocol(
  db: Executor,
  input: Pick<StartTaskInput, "protocol" | "machineName" | "machineId" | "mission">,
) {
  const missions = input.protocol >= TASKS_PROTOCOL && Boolean(input.mission) && input.protocol < MISSION_PROTOCOL;
  if (input.protocol >= TASKS_PROTOCOL && !missions) return;
  const [computer] = await db
    .select({ kind: schema.machines.kind, executors: schema.machines.executors })
    .from(schema.machines)
    .where(eq(schema.machines.id, input.machineId));
  throw new RunnerOutdatedError(input.machineName, missions, computer);
}

async function insertTask(
  db: Executor,
  input: QueuedTaskStart,
  queued: QueuedTaskStart | null,
  options: { createdAt?: Date } = {},
) {
  const now = new Date();
  const [row] = await db
    .insert(machineTasks)
    .values({
      orgId: input.orgId,
      agentId: input.agent.id,
      machineId: input.machineId,
      channelId: input.channelId,
      threadRootId: input.threadRootId,
      runId: input.runId,
      requestedByUserId: input.requestedByUserId,
      missionId: input.mission?.id ?? input.missionId ?? null,
      title: plainTitle(input.title),
      executor: input.executor,
      command: (input.command ?? "").slice(0, TASK_TEXT_LIMITS.command),
      prompt: input.prompt ? input.prompt.slice(0, TASK_TEXT_LIMITS.prompt) : null,
      sessionId: input.sessionId ?? null,
      branch: input.branch ?? input.worktreeBranch ?? null,
      cwd: input.cwd ?? null,
      mode: input.mode ?? null,
      startRequest: queued as unknown as Record<string, unknown> | null,
      resumedFromId: input.resumedFromId ?? null,
      resumeCount: input.resumeCount ?? 0,
      createdAt: options.createdAt ?? now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("machine_tasks insert returned nothing");
  return row;
}

/** The runner said its slots are full, or the computer is away: a queued task waits for the next chance. */
export const isWaitError = (error: unknown) =>
  error instanceof MachineOfflineError ||
  ["no_slot", "offline", "paused"].includes(String((error as { code?: unknown })?.code ?? "")) ||
  error instanceof MachinePausedError;

/**
 * Asks the machine to start a recorded task (status `queued`). `requeue`: a
 * full or absent computer puts it back in our queue (`start_request`) instead
 * of failing it; any other refusal fails the row and goes up. A start cut by
 * the link dropping comes back `interrupted` (it may run there).
 */
export async function launchTask(
  deps: TaskDeps & { call: TaskCall },
  row: MachineTaskRow,
  input: QueuedTaskStart,
  options: { requeue?: boolean } = {},
): Promise<{ row: MachineTaskRow; queued: boolean; baseBehind?: number }> {
  try {
    // Its CLI signs in with the agent's own account, as its turns (refused here when there's nothing to sign in with).
    const signIn = await taskSignIn(deps.db, input);
    // The mission tools' token (ADR 0032): the runner sends it with each of the executor's calls.
    const mcpToken = input.mission
      ? await issueRunToolToken(deps.db, {
          orgId: input.orgId,
          agentId: input.agent.id,
          machineId: input.machineId,
          taskId: row.id,
        })
      : null;
    const started = await deps.call<"task.start">(input.machineId, {
      agent: input.agent,
      op: "task.start",
      taskId: row.id,
      executor: input.executor,
      ...(input.command ? { command: input.command } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.sessionId ? { session: input.sessionId } : {}),
      ...(input.resume ? { resume: true } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.maxSeconds ? { maxSeconds: input.maxSeconds } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.mission ? { mission: { ...input.mission, ...(mcpToken ? { mcpToken } : {}) } } : {}),
      ...(input.commit ? { commit: input.commit } : {}),
      ...(input.baseCheck ? { baseCheck: input.baseCheck } : {}),
      ...(input.approved ? { approved: true } : {}),
      ...signIn,
    });
    const at = new Date(started.startedAt);
    const [running] = await deps.db
      .update(machineTasks)
      .set({
        status: "running",
        command: String(started.command ?? row.command).slice(0, TASK_TEXT_LIMITS.command),
        cwd: started.cwd ?? null,
        // A runner answers the branch it made; none when the folder had no git (the item got its own subfolder).
        // A task in the mission's worktree asked for no branch: it keeps the mission's (ADR 0044).
        branch: started.branch ?? (input.branch ? null : (input.worktreeBranch ?? null)),
        startedAt: Number.isNaN(at.getTime()) ? new Date() : at,
        lastEventAt: new Date(),
        updatedAt: new Date(),
      })
      // A fast task may already have reported its end.
      .where(and(eq(machineTasks.id, row.id), eq(machineTasks.status, "queued")))
      .returning();
    const fresh = running ?? (await getTask(deps.db, row.id)) ?? row;
    await publishTaskEvent(deps.pubsub, fresh);
    const behind = parseBaseBehind(started);
    return { row: fresh, queued: false, ...(behind !== undefined ? { baseBehind: behind } : {}) };
  } catch (error) {
    // Cut while starting: it may be running there. It stays live as `interrupted` (never queued again, which
    // would start a second copy) until its first frame, or until its computer's journal says, once its start
    // can't still be underway (`checkCutTaskStart`).
    if (error instanceof MachineDroppedError) {
      const [cut] = await deps.db
        .update(machineTasks)
        .set({ status: "interrupted", updatedAt: new Date() })
        .where(and(eq(machineTasks.id, row.id), eq(machineTasks.status, "queued"), isNull(machineTasks.endedAt)))
        .returning();
      if (cut) await enqueueStartCheck(deps.db, cut, TASK_START_GRACE_MS);
      const now = cut ?? (await getTask(deps.db, row.id)) ?? row;
      await publishTaskEvent(deps.pubsub, now);
      return { row: now, queued: false };
    }
    if (options.requeue && isWaitError(error)) {
      const [back] = await deps.db
        .update(machineTasks)
        .set({ startRequest: input as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(and(eq(machineTasks.id, row.id), eq(machineTasks.status, "queued"), isNull(machineTasks.endedAt)))
        .returning();
      if (back) {
        await publishTaskEvent(deps.pubsub, back);
        return { row: back, queued: true };
      }
    }
    const [failed] = await deps.db
      .update(machineTasks)
      .set({
        status: "failed",
        endedAt: new Date(),
        lastLine: (error instanceof Error ? error.message : String(error)).slice(0, TASK_LIMITS.line),
        updatedAt: new Date(),
      })
      .where(and(eq(machineTasks.id, row.id), eq(machineTasks.status, "queued")))
      .returning();
    if (failed) await recordTaskFinished(deps.db, failed);
    if (failed && options.requeue) {
      // A queued task started by the server: its end is told like any other (the mission hears it failed).
      await enqueueWake(deps.db, failed);
      await publishTaskEvent(deps.pubsub, failed);
    }
    throw error;
  }
}

/**
 * Records a task in our queue (ADR 0044): status `queued` with what to send
 * the runner when it may start (`claimQueuedTask`). Returns the row.
 */
export async function queueMachineTask(deps: TaskDeps, input: StartTaskInput) {
  await checkTaskProtocol(deps.db, input);
  const { protocol: _p, machineName: _n, ...queued } = input;
  const row = await insertTask(deps.db, queued, queued);
  await publishTaskEvent(deps.pubsub, row);
  return row;
}

/**
 * Claims the next task of a machine's queue that may start now, oldest first
 * (ADR 0044): its mission is active and its folder ready (a setup task needs
 * neither; a task of no mission, `start_task` on another device, neither), and a write item waits while another write item of its mission
 * holds the folder (running, being started, or interrupted and may come
 * back) and while a turn of the mission's main session that began before it
 * was queued still runs (that turn may be writing in the folder: the item
 * starts when it ends, `afterMissionRunEnded`; a turn that began after sees
 * the item and only reads). One claim at a time per machine (an advisory
 * lock), so two write items of a mission never start together. Null:
 * nothing may start.
 */
export async function claimQueuedTask(
  db: Database,
  machineId: string,
): Promise<{ row: MachineTaskRow; start: QueuedTaskStart } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`machine-queue:${machineId}`}))`);
    const [next] = await tx
      .select()
      .from(machineTasks)
      .where(
        sql`${machineTasks.id} = (select q.id from ${machineTasks} q
          left join ${schema.missions} m on m.id = q.mission_id
          where q.machine_id = ${machineId}::uuid and q.status = 'queued' and q.ended_at is null
            and q.start_request is not null
            and (q.mission_id is null or q.mode = 'setup' or (m.status in ('active', 'awaiting_close') and m.worktree_state = 'ready'))
            and (q.mode is distinct from 'write' or (
              not exists (select 1 from ${machineTasks} w
                where w.mission_id = q.mission_id and w.id <> q.id and w.mode = 'write'
                  and w.start_request is null and ${liveTaskSqlAs("w")})
              and not exists (select 1 from ${agentRuns} r
                where r.thread_root_id = m.thread_root_id and r.agent_id = m.agent_id
                  and r.status = 'running' and r.started_at <= q.created_at)))
          order by q.created_at, q.id
          limit 1)`,
      );
    if (!next?.startRequest) return null;
    const [row] = await tx
      .update(machineTasks)
      .set({ startRequest: null, updatedAt: new Date() })
      .where(and(eq(machineTasks.id, next.id), sql`${machineTasks.startRequest} is not null`))
      .returning();
    return row ? { row, start: next.startRequest as unknown as QueuedTaskStart } : null;
  });
}

export async function getTask(db: Executor, taskId: string): Promise<MachineTaskRow | null> {
  const [row] = await db.select().from(machineTasks).where(eq(machineTasks.id, taskId));
  return row ?? null;
}

/** An agent's own task (tools never reach another agent's). */
export async function getAgentTask(db: Executor, orgId: string, agentId: string, taskId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return null;
  const [row] = await db
    .select()
    .from(machineTasks)
    .where(and(eq(machineTasks.orgId, orgId), eq(machineTasks.agentId, agentId), eq(machineTasks.id, taskId)));
  return row ?? null;
}

/** The agent's recent tasks, running ones first. */
export async function listAgentTasks(db: Executor, orgId: string, agentId: string, limit = 20) {
  return db
    .select()
    .from(machineTasks)
    .where(and(eq(machineTasks.orgId, orgId), eq(machineTasks.agentId, agentId)))
    .orderBy(
      sql`case when ${machineTasks.status} in ('queued', 'running') then 0 else 1 end`,
      desc(machineTasks.createdAt),
    )
    .limit(limit);
}

/**
 * The agent's tasks this conversation may see (`list_tasks`, `task_status`,
 * `cancel_task`): those of its channel, and a mission's tasks only in that
 * mission's thread (ADR 0029). Running ones first.
 */
export async function listConversationTasks(
  db: Executor,
  scope: { orgId: string; agentId: string; channelId: string; threadRootId: string },
  limit = 20,
) {
  return db
    .select()
    .from(machineTasks)
    .where(and(eq(machineTasks.orgId, scope.orgId), eq(machineTasks.agentId, scope.agentId), taskVisibleSql(scope)))
    .orderBy(
      sql`case when ${machineTasks.status} in ('queued', 'running') then 0 else 1 end`,
      desc(machineTasks.createdAt),
    )
    .limit(limit);
}

const taskVisibleSql = (scope: { channelId: string; threadRootId: string }) =>
  and(
    eq(machineTasks.channelId, scope.channelId),
    sql`(${machineTasks.missionId} is null or ${machineTasks.threadRootId} = ${scope.threadRootId}::uuid)`,
  );

/** One of the agent's tasks, if this conversation may see it (see `listConversationTasks`). */
export async function getConversationTask(
  db: Executor,
  scope: { orgId: string; agentId: string; channelId: string; threadRootId: string },
  taskId: string,
) {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return null;
  const [row] = await db
    .select()
    .from(machineTasks)
    .where(
      and(
        eq(machineTasks.orgId, scope.orgId),
        eq(machineTasks.agentId, scope.agentId),
        eq(machineTasks.id, taskId),
        taskVisibleSql(scope),
      ),
    );
  return row ?? null;
}

/** A thread's tasks (the app's live card, the agent's context). */
export async function listThreadTasks(db: Executor, orgId: string, channelId: string, threadRootId: string | null) {
  return db
    .select()
    .from(machineTasks)
    .where(
      and(
        eq(machineTasks.orgId, orgId),
        eq(machineTasks.channelId, channelId),
        threadRootId ? eq(machineTasks.threadRootId, threadRootId) : isNull(machineTasks.threadRootId),
      ),
    )
    .orderBy(desc(machineTasks.createdAt))
    .limit(50);
}

/** One line more in `recent_lines` (oldest dropped past `RECENT_LINES`; the same line twice in a row is kept once). */
const pushRecentLine = (line: string) => {
  const col = machineTasks.recentLines;
  return sql`case when ${col}->> -1 = ${line}::text then ${col}
    else (case when jsonb_array_length(${col}) >= ${sql.raw(String(RECENT_LINES))} then ${col} - 0 else ${col} end)
      || jsonb_build_array(${line}::text) end`;
};

/** Keeps the first pull request URL a task showed. */
const keepPrUrl = (url: string) => sql`coalesce(${machineTasks.prUrl}, ${url}::text)`;

/** A pull request a task opened, from its frames or the executor's tools: kept once, published. */
export async function setTaskPrUrl(deps: TaskDeps, taskId: string, url: string | null | undefined) {
  const pr = findPullRequestUrl(url) ?? (url && /^https?:\/\/\S+$/i.test(url) ? url.slice(0, TASK_LIMITS.prUrl) : null);
  if (!pr) return null;
  const [row] = await deps.db
    .update(machineTasks)
    .set({ prUrl: pr, updatedAt: new Date() })
    .where(and(eq(machineTasks.id, taskId), isNull(machineTasks.prUrl)))
    .returning();
  if (row) await publishTaskEvent(deps.pubsub, row);
  return row ?? null;
}

/**
 * `task.event`: the last line, files and elapsed time; an event proves the
 * task runs. A line also goes into `recent_lines`; a pull request URL (the
 * runner's `prUrl`, or one in the line) is kept as `pr_url`.
 */
export async function applyTaskEvent(
  deps: TaskDeps,
  machineId: string,
  frame: Extract<RunnerFrame, { type: "task.event" }>,
) {
  const now = new Date();
  const pr = frame.prUrl ?? findPullRequestUrl(frame.line);
  // A start whose answer was lost has no start time: its seconds so far say when.
  const began = new Date(now.getTime() - Math.max(0, Math.round(frame.seconds ?? 0)) * 1000);
  const [row] = await deps.db
    .update(machineTasks)
    .set({
      status: "running",
      startedAt: sql`coalesce(${machineTasks.startedAt}, ${began.toISOString()}::timestamptz)`,
      ...(frame.line !== undefined ? { lastLine: frame.line } : {}),
      ...(frame.line ? { recentLines: pushRecentLine(frame.line) } : {}),
      ...(pr ? { prUrl: keepPrUrl(pr) } : {}),
      ...(frame.files ? { files: frame.files.slice(0, TASK_LIMITS.files) } : {}),
      ...(frame.seconds !== undefined ? { seconds: Math.round(frame.seconds) } : {}),
      lastEventAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(machineTasks.id, frame.taskId),
        eq(machineTasks.machineId, machineId),
        inArray(machineTasks.status, ["running", "interrupted"]),
        isNull(machineTasks.endedAt),
      ),
    )
    .returning();
  if (row) await publishTaskEvent(deps.pubsub, row);
  return row ?? null;
}

const statusOfDone = (frame: Extract<RunnerFrame, { type: "task.done" }>): MachineTaskStatus =>
  frame.canceled ? "canceled" : frame.exitCode === 0 ? "done" : "failed";

/**
 * `task.done` (not interrupted): the row ends, and the conversation is woken
 * in the same transaction (outbox), unless the agent canceled it itself.
 * Idempotent: a re-sent frame finds the row already ended.
 */
export async function applyTaskDone(
  deps: TaskDeps,
  machineId: string,
  frame: Extract<RunnerFrame, { type: "task.done" }>,
) {
  const now = new Date();
  const pr = findPullRequestUrl(frame.result) ?? findPullRequestUrl(frame.lastLine);
  const row = await deps.db.transaction(async (tx) => {
    const [ended] = await tx
      .update(machineTasks)
      .set({
        status: statusOfDone(frame),
        exitCode: frame.exitCode,
        signal: frame.signal ?? null,
        seconds: frame.seconds,
        ...(frame.lastLine !== undefined ? { lastLine: frame.lastLine } : {}),
        ...(frame.lastLine ? { recentLines: pushRecentLine(frame.lastLine) } : {}),
        ...(pr ? { prUrl: keepPrUrl(pr) } : {}),
        ...(frame.files ? { files: frame.files.slice(0, TASK_LIMITS.files) } : {}),
        result: frame.result ? frame.result.slice(0, TASK_LIMITS.result) : null,
        ...(frame.session ? { sessionId: frame.session } : {}),
        // Protocol 14: a write item's commit at its end (ADR 0044).
        ...(frame.startSha && frame.endSha ? { startSha: frame.startSha, endSha: frame.endSha } : {}),
        endedAt: now,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(machineTasks.id, frame.taskId),
          eq(machineTasks.machineId, machineId),
          inArray(machineTasks.status, ACTIVE),
          isNull(machineTasks.endedAt),
        ),
      )
      .returning();
    if (!ended) return null;
    await recordTaskFinished(tx, ended);
    // Commands it was refused with nobody to ask: its end notice lists them ("Liberar e repetir").
    await recordTaskDenials(tx, ended, frame.denials);
    // A task the agent canceled itself wakes nobody; a mission's still gets its end handled (notes, inbox).
    if (!ended.canceledBy?.startsWith("agent:") || ended.missionId) await enqueueWake(tx, ended);
    return ended;
  });
  if (row) await publishTaskEvent(deps.pubsub, row);
  return row;
}

export const enqueueWake = (tx: Executor, row: Pick<MachineTaskRow, "id" | "orgId">) =>
  enqueue(tx, {
    orgId: row.orgId,
    kind: "machine.task_done",
    payload: { taskId: row.id },
    dedupeKey: `machine.task_done:${row.id}`,
    maxAttempts: 6,
  });

/**
 * A task the agent started itself with `start_task` (a shell command, or
 * Claude Code in the conversation's session), not one of a mission
 * executor's sessions (those have their own session id, in the mission's
 * thread). Started from the main timeline, it reports to no thread.
 */
export const isAgentTask = (row: Pick<MachineTaskRow, "sessionId" | "threadRootId">) =>
  !row.sessionId || row.threadRootId === null || row.sessionId === row.threadRootId;

/** Starts a task on the machine whose socket is here (resume after an interruption). */
export type LocalTaskStarter = (input: StartTaskInput) => Promise<MachineTaskRow>;

/**
 * A task whose process went away without an exit (from `task.done
 * { interrupted }`, or missing from the journal on reconnect): final as
 * `interrupted`. Claude Code with a session resumes by itself (the machine's
 * `resume_tasks`, at most `MAX_TASK_RESUMES` in a row) and the thread hears
 * "resumed"; an agent's shell command (a dev server, a build) starts again
 * the same way in the folder it ran in, and the thread hears "started again"
 * (ADR 0168); anything else wakes the agent to tell the people. A mission's
 * task resumes through the mission's queue (ADR 0044: one writer at a time,
 * only in a ready folder), ahead of what queued after it; `startQueued`
 * walks the machine's queue then (without it, the caller does: the computer
 * coming back walks it once its folders are checked).
 */
export async function settleInterruptedTask(
  deps: TaskDeps & { start?: LocalTaskStarter; startQueued?: (machineId: string) => Promise<unknown> },
  row: MachineTaskRow,
  frame?: Extract<RunnerFrame, { type: "task.done" }>,
) {
  const now = new Date();
  const [claimed] = await deps.db
    .update(machineTasks)
    .set({
      status: "interrupted",
      ...(frame ? { seconds: frame.seconds, ...(frame.lastLine ? { lastLine: frame.lastLine } : {}) } : {}),
      ...(frame?.files ? { files: frame.files } : {}),
      ...(frame?.result ? { result: frame.result.slice(0, TASK_LIMITS.result) } : {}),
      ...(frame?.session ? { sessionId: frame.session } : {}),
      ...(frame?.startSha && frame.endSha ? { startSha: frame.startSha, endSha: frame.endSha } : {}),
      endedAt: now,
      updatedAt: now,
    })
    .where(and(eq(machineTasks.id, row.id), isNull(machineTasks.endedAt), inArray(machineTasks.status, ACTIVE)))
    .returning();
  if (!claimed) return null;
  await recordTaskFinished(deps.db, claimed);
  const machine = await getMachineById(deps.db, claimed.machineId);
  // A mission's task resumes when the mission says so and still runs (ADR 0029).
  const [mission] = claimed.missionId
    ? await deps.db
        .select({
          id: schema.missions.id,
          status: schema.missions.status,
          resumeTasks: schema.missions.resumeTasks,
          branch: schema.missions.branch,
          worktreeState: schema.missions.worktreeState,
        })
        .from(schema.missions)
        .where(eq(schema.missions.id, claimed.missionId))
    : [];
  const resumable = resumesByItself(claimed, machine, mission) && Boolean(deps.start);
  if (resumable && deps.start && machine) {
    const handle = (await deps.db
      .select({ handle: schema.agents.handle })
      .from(schema.agents)
      .where(eq(schema.agents.id, claimed.agentId))
      .then((r) => r[0]?.handle)) as string | undefined;
    // Never seen running (its start was cut by a drop): the session may not have its task, so it comes along.
    const asked = claimed.startedAt ? null : claimed.prompt;
    const shell = claimed.executor === "shell";
    try {
      const again = {
        orgId: claimed.orgId,
        agent: { id: claimed.agentId, handle: handle ?? "agent" },
        machineId: claimed.machineId,
        protocol: machine.protocol,
        machineName: machine.name,
        channelId: claimed.channelId,
        threadRootId: claimed.threadRootId,
        runId: null,
        requestedByUserId: claimed.requestedByUserId,
        title: claimed.title,
        resumedFromId: claimed.id,
        resumeCount: claimed.resumeCount + 1,
      };
      // The same command in the folder it ran in (a branch's worktree is there already). Nothing a person approved
      // for the first start carries over: a command the computer holds is refused, and the agent hears it stopped.
      const input: StartTaskInput = shell
        ? { ...again, executor: "shell", command: claimed.command, cwd: claimed.cwd || null }
        : {
            ...again,
            executor: "claude",
            prompt: asked?.startsWith(RESUME_PROMPT)
              ? asked
              : asked
                ? `${RESUME_PROMPT}\n\nWhat you were asked:\n${asked}`.slice(0, TASK_TEXT_LIMITS.prompt)
                : RESUME_PROMPT,
            sessionId: claimed.sessionId,
            resume: true,
            // The session lives in its folder (a worktree for a branch): resume it there.
            cwd: claimed.cwd || null,
            // In the mission's worktree (ADR 0044): the same kind, and a write item still ends in a commit.
            mode: taskModeOf(claimed.mode),
            ...(claimed.mode === "write" && mission?.branch
              ? { commit: { message: `agentes: ${claimed.title}` }, worktreeBranch: mission.branch }
              : {}),
            // The main session's own task: only tagged; an item session gets the mission's tools again.
            ...(mission && isAgentTask(claimed)
              ? { missionId: mission.id }
              : {
                  mission: mission
                    ? {
                        id: mission.id,
                        rules: MISSION_RULES,
                        branchPrefix: `agentes/${mission.id.replace(/-/g, "").slice(-8)}/`,
                        allow: await missionAllowRules(deps.db, mission.id),
                        ...(claimed.mode === "read" ? { mode: "plan" as const } : {}),
                      }
                    : null,
                }),
          };
      // A started mission's queue (planning before Start has no folder or queue: it resumes at once).
      const queue = mission?.status === "active";
      const next = queue ? await queueResumed(deps.db, input, claimed) : await deps.start(input);
      const [linked] = await deps.db
        .update(machineTasks)
        .set({ resumedTaskId: next.id, updatedAt: new Date() })
        .where(eq(machineTasks.id, claimed.id))
        .returning();
      await recordAudit(deps.db, {
        orgId: claimed.orgId,
        actor: { type: "system", id: null },
        action: "machine.task_started",
        target: { type: "machine", id: claimed.machineId },
        details: { taskId: next.id, resumedFromId: claimed.id, executor: claimed.executor, title: claimed.title },
      }).catch(() => undefined);
      // Queued behind a folder that isn't ready (being prepared again, or failed and left for the person):
      // it resumes once the project is ready, not now.
      const waits = queue && mission?.worktreeState !== "ready";
      const code = shell ? "machine_task_restarted" : waits ? "machine_task_resume_waits" : "machine_task_resumed";
      const params = { title: claimed.title, computer: machine.name };
      const locale = await lineLocale(deps.db, claimed.orgId, claimed.requestedByUserId, claimed.runId);
      await postTaskNotice(deps, claimed, {
        body: serverText(locale, `chat.body.${code}`, params),
        code,
        params,
        meta: { machineTaskResumed: { fromId: claimed.id, taskId: next.id, ...(waits ? { waits: true } : {}) } },
      });
      await publishTaskEvent(deps.pubsub, linked ?? claimed);
      if (queue) {
        await publishTaskEvent(deps.pubsub, next);
        await deps.startQueued?.(claimed.machineId).catch(() => undefined);
      }
      return claimed;
    } catch {
      // Couldn't resume (no slot, runner refused): the agent hears it was interrupted.
    }
  }
  await enqueueWake(deps.db, claimed);
  await publishTaskEvent(deps.pubsub, claimed);
  return claimed;
}

/**
 * Whether an interrupted task resumes by itself once its computer is back: Claude Code with a session, or an
 * agent's own shell command (never a mission's: its queue has its own order), at most `MAX_TASK_RESUMES` in a row,
 * not canceled, when its computer and its mission (still open) allow it.
 */
function resumesByItself(
  row: MachineTaskRow,
  machine: Pick<MachineRow, "resumeTasks"> | null,
  mission: { status: string; resumeTasks: boolean } | undefined,
) {
  const missionAllows =
    !row.missionId || (mission?.resumeTasks === true && (mission.status === "active" || mission.status === "proposed"));
  const resumes =
    (row.executor === "claude" && Boolean(row.sessionId)) ||
    (row.executor === "shell" && !row.missionId && row.command.trim() !== "");
  return (
    missionAllows && resumes && machine?.resumeTasks !== false && row.resumeCount < MAX_TASK_RESUMES && !row.canceledBy
  );
}

/** Whether this task resumes by itself if its computer restarts (`resumesByItself`), for what the agent is told. */
export async function taskResumesByItself(db: Database, row: MachineTaskRow) {
  if (row.executor === "codex") return false;
  const machine = await getMachineById(db, row.machineId);
  const [mission] = row.missionId
    ? await db
        .select({ status: schema.missions.status, resumeTasks: schema.missions.resumeTasks })
        .from(schema.missions)
        .where(eq(schema.missions.id, row.missionId))
    : [];
  return resumesByItself(row, machine, mission);
}

/**
 * A mission task's resume in our queue (ADR 0044): `queued` with what to send
 * when it may start, at the interrupted task's place in the queue (its
 * `created_at`), so it goes before items queued after it.
 */
async function queueResumed(db: Executor, input: StartTaskInput, from: MachineTaskRow) {
  await checkTaskProtocol(db, input);
  const { protocol: _p, machineName: _n, ...queued } = input;
  return insertTask(db, queued, queued, { createdAt: from.createdAt });
}

/**
 * A line the server writes in the task's thread, as the task's agent (no
 * run, no routing): offline, resumed. Its text in the language of whom the
 * task is for, plus a code the apps show in each reader's language.
 */
export async function postTaskNotice(
  deps: TaskDeps,
  row: Pick<MachineTaskRow, "orgId" | "agentId" | "channelId" | "threadRootId">,
  notice: { body: string; code: string; params: Record<string, string>; meta?: Record<string, unknown> },
  tx?: Executor,
): Promise<Message> {
  const message = await insertMessage(tx ?? deps.db, {
    orgId: row.orgId,
    channelId: row.channelId,
    threadId: row.threadRootId,
    author: { type: "agent", agentId: row.agentId, runId: null, hop: 0, stretchId: null },
    body: notice.body,
    meta: { ...(notice.meta ?? {}), bodyCode: notice.code, bodyParams: notice.params },
  });
  if (!tx && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message;
}

/**
 * `machine.tasks_offline` (enqueued when a machine's socket closes, due after
 * the grace): still offline, its running tasks become `interrupted` (not
 * final: the machine may come back) and each affected thread gets ONE notice
 * per outcome: tasks keep running if only the connection dropped, and if the
 * computer restarted, Claude Code tasks resume by themselves and others don't.
 * `statusOnly`: after our own stop, only the apps hear (its tasks wait longer).
 */
export async function interruptOfflineMachineTasks(
  deps: TaskDeps,
  machineId: string,
  options: { statusOnly?: boolean } = {},
) {
  const machine = await getMachineById(deps.db, machineId);
  if (!machine || machineOnline(machine)) return [];
  // Away past the grace: open apps look again, and it is an outage now (`listMachineOutages`).
  await publishMachineStatus(deps.pubsub, machine.orgId, machineId, false).catch(() => undefined);
  if (options.statusOnly) return [];
  const rows = await deps.db
    .update(machineTasks)
    .set({ status: "interrupted", updatedAt: new Date() })
    .where(and(eq(machineTasks.machineId, machineId), eq(machineTasks.status, "running"), isNull(machineTasks.endedAt)))
    .returning();
  const missionIds = [...new Set(rows.flatMap((r) => (r.missionId ? [r.missionId] : [])))];
  const missions = new Map(
    missionIds.length
      ? (
          await deps.db
            .select({
              id: schema.missions.id,
              status: schema.missions.status,
              resumeTasks: schema.missions.resumeTasks,
            })
            .from(schema.missions)
            .where(inArray(schema.missions.id, missionIds))
        ).map((m) => [m.id, m])
      : [],
  );
  const threads = new Map<string, { resumes: boolean; list: MachineTaskRow[] }>();
  for (const row of rows) {
    const resumes = resumesByItself(row, machine, row.missionId ? missions.get(row.missionId) : undefined);
    const key = `${row.channelId}:${row.threadRootId ?? ""}:${resumes}`;
    const group = threads.get(key) ?? { resumes, list: [] };
    group.list.push(row);
    threads.set(key, group);
  }
  const since = (machine.lastSeenAt ?? new Date()).toISOString();
  for (const { resumes, list } of threads.values()) {
    const first = list[0] as MachineTaskRow;
    const locale = await lineLocale(deps.db, first.orgId, first.requestedByUserId, first.runId);
    // The apps' event line for it (`missions.notice.machine_offline…`): the chat's own is too short for the agent.
    const body = serverText(locale, `missions.notice.machine_offline${resumes ? "_resumes" : ""}`, {
      computer: machine.name,
      title: first.title,
      count: String(list.length),
    });
    await postTaskNotice(deps, first, {
      body,
      code: "machine_offline",
      // `context`: the apps' wording for tasks that resume by themselves (`machine_offline_resumes`).
      params: {
        computer: machine.name,
        since,
        count: String(list.length),
        title: first.title,
        ...(resumes ? { context: "resumes" } : {}),
      },
      meta: { machineOffline: { machineId, taskIds: list.map((r) => r.id) } },
    }).catch(() => undefined);
    for (const row of list) await publishTaskEvent(deps.pubsub, row);
  }
  return rows;
}

/**
 * Stops every live task of a workspace (it was suspended) or of one agent (being deleted), all at once: its
 * computer stops each one it runs, and that task's `task.done` ends the row; one it doesn't run (queued here,
 * its computer offline or not answering) ends `canceled` now, and an interrupted one never resumes. Returns how many.
 */
export async function cancelOrgTasks(
  deps: TaskDeps & { call?: TaskCall },
  orgId: string,
  canceledBy: string,
  agentId?: string,
) {
  const rows = await deps.db
    .select({ task: machineTasks, handle: schema.agents.handle })
    .from(machineTasks)
    .innerJoin(schema.agents, eq(schema.agents.id, machineTasks.agentId))
    .where(
      and(eq(machineTasks.orgId, orgId), liveTaskWhere(), agentId ? eq(machineTasks.agentId, agentId) : undefined),
    );
  await Promise.all(
    rows.map(async ({ task, handle }) => {
      await deps.db.update(machineTasks).set({ canceledBy, updatedAt: new Date() }).where(eq(machineTasks.id, task.id));
      // A task with a start request still waits in our queue: its computer never had it.
      const reply =
        deps.call && !task.startRequest
          ? await deps
              .call<"task.cancel">(task.machineId, {
                agent: { id: task.agentId, handle },
                op: "task.cancel",
                taskId: task.id,
              })
              .catch(() => null)
          : null;
      if (reply?.canceled) return;
      const now = new Date();
      const [ended] = await deps.db
        .update(machineTasks)
        .set({ status: "canceled", endedAt: now, wokeAt: now, updatedAt: now })
        .where(and(eq(machineTasks.id, task.id), isNull(machineTasks.endedAt)))
        .returning();
      if (ended) {
        await recordTaskFinished(deps.db, ended);
        await publishTaskEvent(deps.pubsub, ended);
      }
    }),
  );
  return rows.length;
}

/**
 * On `hello` from a runner with tasks: what the server thinks runs is
 * checked against the runner's journal. Running there: running here (an
 * offline grace may have said interrupted). Ended there: its `task.done`
 * follows. Not there at all: interrupted (and resumed when it can be).
 */
export async function reconcileMachineTasks(
  deps: TaskDeps & { start?: LocalTaskStarter },
  machineId: string,
  reported: RunnerTask[],
) {
  const rows = await deps.db
    .select()
    .from(machineTasks)
    .where(
      and(eq(machineTasks.machineId, machineId), inArray(machineTasks.status, ACTIVE), isNull(machineTasks.endedAt)),
    );
  const byId = new Map(reported.map((t) => [t.taskId, t]));
  for (const row of rows) {
    const there = byId.get(row.id);
    // A start cut by a drop: this list may come before the runner has written it down, and a supervisor lists
    // every task it handed a worker, started or not. Only the agent's own journal settles it, once its start
    // can't still be underway (`checkCutTaskStart`).
    if (isCutStart(row)) {
      if (Date.now() - row.updatedAt.getTime() >= TASK_START_GRACE_MS) await enqueueStartCheck(deps.db, row, 0);
      continue;
    }
    if (there?.status === "running") {
      if (row.status !== "running") await markRunning(deps, row, there);
      continue;
    }
    if (there) continue;
    // Waiting in our queue (ADR 0044): the runner never had it.
    if (row.status === "queued" && row.startRequest) continue;
    // Being started right now (its `task.start` may still be on the way). One from our queue began when it was
    // taken from there, not when it was queued.
    if (row.status === "queued" && Date.now() - row.updatedAt.getTime() < TASK_START_GRACE_MS) continue;
    await settleInterruptedTask(deps, row);
  }
}

/** Running there: running here, since when its journal says (a start whose answer was lost has no time). */
async function markRunning(deps: TaskDeps, row: MachineTaskRow, there: RunnerTask) {
  const at = new Date(there.startedAt);
  const [back] = await deps.db
    .update(machineTasks)
    .set({
      status: "running",
      ...(row.startedAt || Number.isNaN(at.getTime()) ? {} : { startedAt: at }),
      lastEventAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(machineTasks.id, row.id), isNull(machineTasks.endedAt)))
    .returning();
  if (back) await publishTaskEvent(deps.pubsub, back);
}

/**
 * `machine.task_start_check`: a start cut by a drop, once it can't still be underway. The agent's own journal
 * on the computer says (`task.status`, answered by the process that runs the agent's tasks there): running
 * there is running here; ended there, its `task.done` is on its way; not there, it never started, and it is
 * settled like a task that went away (Claude Code starts with what it was asked, others wake the agent). Its
 * computer away: its next hello asks for this check again.
 */
export async function checkCutTaskStart(
  deps: TaskDeps & {
    call: TaskCall;
    start?: LocalTaskStarter;
    startQueued?: (machineId: string) => Promise<unknown>;
  },
  taskId: string,
) {
  const row = await getTask(deps.db, taskId);
  if (!row || !isCutStart(row)) return;
  const [agent] = await deps.db
    .select({ handle: schema.agents.handle })
    .from(schema.agents)
    .where(eq(schema.agents.id, row.agentId));
  const reply = await deps
    .call<"task.status">(row.machineId, {
      agent: { id: row.agentId, handle: agent?.handle ?? "agent" },
      op: "task.status",
      taskId: row.id,
    })
    .catch((error: unknown) => {
      // Away, or gone again: its next hello asks again. Anything else: the job is tried again later.
      if (error instanceof MachineOfflineError) return null;
      throw error;
    });
  if (!reply) return;
  const there = reply.tasks.find((t) => t.taskId === row.id);
  if (there?.status === "running") return markRunning(deps, row, there);
  if (there) return;
  await settleInterruptedTask(deps, row);
}

/**
 * A task's end as the notice the agent reads (`text`, and `meta.machineTask` with the result) and people see (`body`,
 * in `locale`, the language of whom the task is for, kept in `machineTask.locale`). `computer`: null when it's gone.
 */
export function taskEndNotice(row: MachineTaskRow, computer: string | null, locale: AppLocale = "en") {
  const files = Array.isArray(row.files) ? row.files : [];
  const at = computer ?? "the computer";
  return {
    body: taskEndLine(locale, row, computer),
    text: taskEndText({ title: row.title, status: row.status, seconds: taskSeconds(row), exitCode: row.exitCode }, at),
    meta: {
      machineTask: {
        id: row.id,
        title: row.title,
        status: row.status,
        exitCode: row.exitCode,
        seconds: taskSeconds(row),
        computer: at,
        executor: row.executor,
        locale,
        ...(row.branch ? { branch: row.branch } : {}),
        ...(row.lastLine ? { lastLine: row.lastLine } : {}),
        ...(files.length ? { files: files.slice(0, 20) } : {}),
        ...(row.result ? { result: cutText(row.result, TASK_TEXT_LIMITS.wakeResult) } : {}),
      },
      bodyCode: `machine_task_${row.status}`,
      bodyParams: {
        title: row.title,
        computer: at,
        seconds: String(taskSeconds(row)),
        exitCode: String(row.exitCode ?? ""),
      },
    } as Record<string, unknown> & { machineTask: Record<string, unknown> },
  };
}

/**
 * `machine.task_done`: wakes the conversation once per task. A notice in the
 * task's thread (a routine's task: where the routine reports), as its agent,
 * carries the result for the model (`meta.machineTask`, with the run that
 * started it), and a run of that agent starts on it, unless the hop
 * limit or the agent's audience says no, or the agent left the
 * channel. A run of that agent already active in the thread gets it as a
 * new message instead (one run per agent and conversation).
 */
export async function wakeConversationForTask(deps: TaskDeps, taskId: string, options: { maxHops: number }) {
  const row = await getTask(deps.db, taskId);
  if (!row || row.wokeAt || !row.endedAt) return null;
  // A mission's task (the main session's own, or an item session's) ends through the mission.
  if (row.missionId) return claimMissionTaskEnd(deps, row);
  // A task the agent canceled itself wakes nobody.
  if (row.canceledBy?.startsWith("agent:")) {
    await deps.db.update(machineTasks).set({ wokeAt: new Date() }).where(eq(machineTasks.id, row.id));
    return null;
  }
  const machine = await getMachineById(deps.db, row.machineId);
  const [origin] = row.runId
    ? await deps.db
        .select({
          hop: agentRuns.hop,
          stretchId: agentRuns.stretchId,
          triggerMessageId: agentRuns.triggerMessageId,
          background: agentRuns.background,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, row.runId))
    : [];
  const hop = origin?.hop ?? 1;
  // The work it ends is the origin run's, in its stretch (ADR 0089).
  const stretchId = origin ? runStretchOf(origin) : null;
  // A routine's task ends where the routine reports, like its approval cards: nobody reads its room (ADR 0053 §4).
  // Only while the routine may still speak there (deleted, paused, or its creator can't post there: its room keeps
  // the record and nobody is woken), and the run it wakes follows the routine's report policy.
  const brief = origin?.background
    ? routineBriefOf((await getMessage(deps.db, row.orgId, origin.triggerMessageId))?.meta)
    : null;
  const blocked = brief ? await routineDeliveryBlock(deps.db, brief) : null;
  const report = brief && !blocked ? brief.deliverTo : undefined;
  const channelId = report?.channelId ?? row.channelId;
  const eligible = await eligibleChannelAgents(
    deps.db,
    row.orgId,
    channelId,
    [row.agentId],
    row.requestedByUserId ? { requesterUserId: row.requestedByUserId } : {},
  );
  const locale = await lineLocale(deps.db, row.orgId, row.requestedByUserId, row.runId);
  const notice = taskEndNotice(row, machine?.name ?? null, locale);
  const machineTask = {
    ...notice.meta.machineTask,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(report && brief ? { routine: { name: brief.name, report: brief.report } } : {}),
  };
  const result = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(machineTasks)
      .set({ wokeAt: new Date() })
      .where(and(eq(machineTasks.id, row.id), isNull(machineTasks.wokeAt)))
      .returning({ id: machineTasks.id });
    if (!claimed) return null;
    const message = await insertMessage(tx, {
      orgId: row.orgId,
      channelId,
      threadId: report ? report.threadId : row.threadRootId,
      author: { type: "agent", agentId: row.agentId, runId: null, hop, stretchId },
      body: notice.body,
      // The run that started it: the work it ends continues for whoever is behind that run (`authority.ts`). Its
      // result is command output, so the run it wakes counts as having read outside (ADR 0117).
      meta: { ...notice.meta, machineTask, readOutside: true },
    });
    const runs =
      !blocked && eligible.length > 0 && !(await hopLimitReached(tx, message, options.maxHops))
        ? await createAgentRuns(tx, message, [row.agentId], "mention")
        : [];
    return { message, runs };
  });
  if (!result) return null;
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(result.message));
  for (const run of result.runs) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId,
      threadId: replyThreadOf(run),
      agentId: run.agentId,
      runId: run.id,
    });
  }
  return result;
}

/**
 * A mission's task ended (ADR 0029): no agent run (the executor reported
 * through the `agentes` tools, and the mission tells its main session). Only
 * a failure or an interruption the executor couldn't report gets a notice in
 * the thread. Returns `{ missionTask }` once (the caller then runs the
 * mission's own follow-up: notes, the main session, queued messages).
 */
async function claimMissionTaskEnd(deps: TaskDeps, row: MachineTaskRow) {
  const machine = await getMachineById(deps.db, row.machineId);
  const computer = machine?.name ?? "the computer";
  // The main session's own task (its run's start_task): the mission posts the end itself, as the notice that wakes it.
  const agentLike = isAgentTask(row);
  // Commands it was refused: the people see them and can allow them ("Liberar e repetir").
  const blocked = row.missionId && !agentLike ? await blockedOfTask(deps.db, row.missionId, row.id) : [];
  // A setup task's end is the mission's own card (ADR 0044): no task notice.
  const notice =
    !agentLike &&
    row.mode !== "setup" &&
    (row.status === "failed" || row.status === "interrupted" || blocked.length > 0);
  const locale = notice ? await lineLocale(deps.db, row.orgId, row.requestedByUserId, row.runId) : "en";
  const claimed = await deps.db.transaction(async (tx) => {
    const [won] = await tx
      .update(machineTasks)
      .set({ wokeAt: new Date() })
      .where(and(eq(machineTasks.id, row.id), isNull(machineTasks.wokeAt)))
      .returning({ id: machineTasks.id });
    if (!won) return null;
    const message = notice
      ? await insertMessage(tx, {
          orgId: row.orgId,
          channelId: row.channelId,
          threadId: row.threadRootId,
          author: { type: "agent", agentId: row.agentId, runId: null, hop: 0, stretchId: null },
          body: taskEndLine(locale, row, machine?.name ?? null),
          meta: {
            machineTask: {
              id: row.id,
              title: row.title,
              status: row.status,
              exitCode: row.exitCode,
              seconds: taskSeconds(row),
              computer,
              executor: row.executor,
              locale,
              missionId: row.missionId,
              ...(row.branch ? { branch: row.branch } : {}),
              ...(row.lastLine ? { lastLine: row.lastLine } : {}),
              ...(blocked.length ? { blocked } : {}),
            },
            bodyCode: `machine_task_${row.status}`,
            bodyParams: {
              title: row.title,
              computer,
              seconds: String(taskSeconds(row)),
              exitCode: String(row.exitCode ?? ""),
            },
          },
        })
      : null;
    return { message };
  });
  if (!claimed) return null;
  if (claimed.message && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(claimed.message));
  return { message: claimed.message, runs: [], missionTask: { taskId: row.id, missionId: row.missionId } };
}

/**
 * Who a task works for: the person behind the run (`authority.ts`: nobody for
 * a routine's or unattended run), or, for a run woken by a task, that task's person.
 */
export async function taskRequester(ctx: ToolContext): Promise<string | null> {
  const trigger = await getMessage(ctx.db, ctx.orgId, ctx.triggerMessageId);
  if (!trigger) return null;
  const woke = trigger.meta?.machineTask as { id?: unknown } | undefined;
  if (typeof woke?.id === "string") return (await getTask(ctx.db, woke.id))?.requestedByUserId ?? null;
  // Woken by its mission: the person the mission said it works for.
  const inbox = trigger.meta?.missionInbox as { requestedBy?: unknown } | undefined;
  if (inbox && trigger.authorAgentId === ctx.agentId)
    return typeof inbox.requestedBy === "string" ? inbox.requestedBy : null;
  return personBehindCall(ctx);
}
