import { randomBytes } from "node:crypto";
import { isRunToolToken, RUN_TOOL_TOKEN_PREFIX } from "@agenteschat/adapters";
import { and, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";
import { sha256 } from "./crypto";

const { runToolTokens, agentRuns, machineTasks } = schema;

/** A computer-brain turn's token lives as long as a long run may (it dies with the run anyway). */
export const RUN_TOOL_TOKEN_TTL_MS = 24 * 3600_000;
/** A mission task can run for days (resumes get a new task, and a new token). */
export const TASK_TOOL_TOKEN_TTL_MS = 7 * 24 * 3600_000;

/**
 * Who calls through the runner's MCP bridge (ADR 0032). Same shape as the
 * engine's `RunIdentity`, plus `taskId` when the token is a mission task's:
 * then the tools are that task's mission tools, and `runId` is the run that
 * started the task ("" when the server started it).
 */
export interface BridgeIdentity {
  orgId: string;
  agentId: string;
  runId: string;
  machineId: string;
  taskId?: string;
}

export type RunToolTokenCheck =
  | { ok: true; identity: BridgeIdentity }
  | { ok: false; error: { code: string; message: string } };

const refuse = (code: string, message: string): RunToolTokenCheck => ({ ok: false, error: { code, message } });

/**
 * Issues the bridge token for a computer-brain run or a mission task, bound
 * to org, agent, machine and that run (or task). Only its SHA-256 is kept.
 */
export async function issueRunToolToken(
  db: Executor,
  input: {
    orgId: string;
    agentId: string;
    machineId: string;
    runId?: string | null;
    taskId?: string | null;
    ttlMs?: number;
    now?: Date;
  },
): Promise<string> {
  if (!input.runId && !input.taskId) throw new Error("A run tool token needs a run or a task");
  const token = `${RUN_TOOL_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const now = input.now ?? new Date();
  await db.insert(runToolTokens).values({
    orgId: input.orgId,
    agentId: input.agentId,
    machineId: input.machineId,
    runId: input.runId ?? null,
    taskId: input.taskId ?? null,
    tokenHash: sha256(token),
    expiresAt: new Date(
      now.getTime() + (input.ttlMs ?? (input.taskId ? TASK_TOOL_TOKEN_TTL_MS : RUN_TOOL_TOKEN_TTL_MS)),
    ),
  });
  return token;
}

/**
 * Checks a token the runner sent (ADR 0032): known, not revoked or expired,
 * issued to the machine holding this socket, and its run still running (or
 * its task not ended). Every refusal is `bridge.*`.
 */
export async function verifyRunToolToken(
  db: Executor,
  machineId: string,
  token: string,
  now = new Date(),
): Promise<RunToolTokenCheck> {
  if (!isRunToolToken(token)) return refuse("bridge.invalid_token", "Not allowed: unknown tool token.");
  const [row] = await db
    .select()
    .from(runToolTokens)
    .where(eq(runToolTokens.tokenHash, sha256(token)));
  if (!row || row.revokedAt) return refuse("bridge.invalid_token", "Not allowed: unknown tool token.");
  if (row.machineId !== machineId) {
    return refuse("bridge.wrong_machine", "Not allowed: this token belongs to another computer.");
  }
  if (row.expiresAt.getTime() <= now.getTime()) return refuse("bridge.expired", "This run's tool token expired.");
  if (row.taskId) {
    const [task] = await db
      .select({ machineId: machineTasks.machineId, endedAt: machineTasks.endedAt, runId: machineTasks.runId })
      .from(machineTasks)
      .where(eq(machineTasks.id, row.taskId));
    if (!task || task.machineId !== machineId) return refuse("bridge.invalid_token", "Not allowed: unknown task.");
    if (task.endedAt) return refuse("mission.task_ended", "This task already ended.");
    return {
      ok: true,
      identity: {
        orgId: row.orgId,
        agentId: row.agentId,
        runId: task.runId ?? "",
        machineId,
        taskId: row.taskId,
      },
    };
  }
  if (!row.runId) return refuse("bridge.invalid_token", "Not allowed: unknown tool token.");
  const [run] = await db
    .select({ status: agentRuns.status, orgId: agentRuns.orgId, agentId: agentRuns.agentId })
    .from(agentRuns)
    .where(eq(agentRuns.id, row.runId));
  if (!run || run.orgId !== row.orgId || run.agentId !== row.agentId) {
    return refuse("bridge.invalid_token", "Not allowed: unknown run.");
  }
  if (run.status === "waiting_approval" || run.status === "waiting_input") {
    return refuse("bridge.run_waiting", "This run is waiting for a person: stop now and end your turn.");
  }
  if (run.status !== "running") return refuse("bridge.run_ended", "This run has ended: stop now.");
  return { ok: true, identity: { orgId: row.orgId, agentId: row.agentId, runId: row.runId, machineId } };
}

/** Revokes a run's (or a task's) tokens: call it when the run finishes or the task ends. */
export async function revokeRunToolTokens(db: Executor, of: { runId: string } | { taskId: string }) {
  await db
    .update(runToolTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        "runId" in of ? eq(runToolTokens.runId, of.runId) : eq(runToolTokens.taskId, of.taskId),
        isNull(runToolTokens.revokedAt),
      ),
    );
}
