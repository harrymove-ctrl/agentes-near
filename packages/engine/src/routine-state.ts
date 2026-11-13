import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, or, type SQL, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { notifyRoutinePaused } from "./notification-producers";
import { channelMaySql } from "./permissions";

const { routines, routineRuns, outbox, channels, channelMembers, organizationMembers } = schema;

/**
 * A routine's own state while nobody watches (ADR 0053 §6): why it paused itself, who can still
 * post where it reports, and the English fallback of every coded reason (the app translates the
 * codes; these words are only for the model, logs and old clients).
 */

/** Why a routine paused itself (`routines.paused_reason`). */
export type RoutinePausedReason =
  | "creator_left"
  | "creator_no_access"
  | "agent_archived"
  | "agent_not_in_channel"
  | "audience"
  | "failing";

/** Failed runs in a row that pause a routine (`failing`). */
export const ROUTINE_FATIGUE_LIMIT = 5;

/** A waiting run whose slot is older than this when its computer returns is `missed`, not run. */
export const ROUTINE_CATCH_UP_MS = 12 * 3600_000;

/** Statuses a routine run is still open in (it may still end). */
export const OPEN_ROUTINE_RUN = ["queued", "starting", "started", "reported"] as const;

/** English fallback of the coded reasons a routine or its runs carry. */
export const ROUTINE_CODE_TEXT: Record<string, string> = {
  creator_left: "The routine's creator left the organization",
  creator_no_access: "The routine's creator can no longer post where it reports",
  agent_archived: "The agent was archived",
  agent_not_in_channel: "The agent isn't in the conversation it reports to",
  audience: "The routine's creator can no longer talk to the agent",
  failing: "It failed several times in a row",
  previous_running: "Skipped: the previous run was still working",
  previous_waiting: "Skipped: the previous run is waiting for a person",
  waiting_computer: "Replaced: it was waiting for the agent's computer",
  waiting_plan: "Replaced: it was waiting for the agent's plan to reset",
  waiting_budget: "Replaced: it was waiting for the agent's budget to renew",
  superseded: "Replaced by the next run",
  stale: "Missed: the computer came back too late",
  waiting_plan_late: "Missed: the plan reset too late",
  waiting_budget_late: "Missed: the budget renewed too late",
  stopped: "Stopped",
  no_report: "Ended without a report",
  auto_report: "Reported its final answer",
  handoff_blocked: "Its report could not be delivered",
  deleted: "Routine deleted",
  paused: "Routine paused",
  lost: "Lost: it never started",
  reminder_sent: "Reminder sent",
};

export const routineCodeText = (code: string | null | undefined) => (code && ROUTINE_CODE_TEXT[code]) || code || "";

/** The routine run's `routine.run` job is still queued or running (else nothing will ever start it). */
export const routineJobAlive = (routineRunId: typeof routineRuns.id | SQL) => {
  // Always the outer row's id: a bare "id" inside the subquery would be the job's own.
  const id = routineRunId === routineRuns.id ? sql.raw(`"routine_runs"."id"`) : routineRunId;
  return sql`exists (select 1 from ${outbox} o where o.dedupe_key = 'routine.run:' || ${id}::text
    and o.status in ('pending', 'processing'))`;
};

/** Whether this person can still post in that conversation: a member of the organization and of it who may post there (ADR 0134). */
export async function personCanPost(db: Executor, orgId: string, userId: string, channelId: string): Promise<boolean> {
  const [row] = await db
    .select({
      may: channelMaySql(orgId, channelId, userId, "post"),
      member: channelMembers.id,
      archivedAt: channels.archivedAt,
    })
    .from(organizationMembers)
    .innerJoin(channels, and(eq(channels.id, channelId), eq(channels.orgId, orgId)))
    .leftJoin(
      channelMembers,
      and(
        eq(channelMembers.channelId, channels.id),
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.userId, userId),
      ),
    )
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return Boolean(row && !row.archivedAt && row.member && row.may);
}

/**
 * The routine pauses itself (ADR 0053 §6.2, §6.6): no next slot, with its coded reason, and its
 * creator and the agent's owner hear it once. Nothing happens when it already paused for that
 * reason. Returns whether it paused now.
 */
export async function pauseRoutine(
  deps: { db: Database; pubsub?: PubSub },
  routine: Pick<typeof routines.$inferSelect, "id" | "orgId">,
  reason: RoutinePausedReason,
): Promise<boolean> {
  const now = new Date();
  const [row] = await deps.db
    .update(routines)
    .set({ active: false, nextRunAt: null, pausedReason: reason, updatedAt: now })
    .where(
      and(
        eq(routines.id, routine.id),
        eq(routines.orgId, routine.orgId),
        isNull(routines.deletedAt),
        or(eq(routines.active, true), sql`${routines.pausedReason} is distinct from ${reason}`),
      ),
    )
    .returning();
  if (!row) return false;
  await recordAudit(deps.db, {
    orgId: row.orgId,
    actor: { type: "system", id: null },
    action: "routine.paused",
    target: { type: "routine", id: row.id },
    details: { reason },
  });
  await notifyRoutinePaused(deps, {
    orgId: row.orgId,
    routineId: row.id,
    name: row.name,
    agentId: row.agentId,
    creatorUserId: row.createdByUserId,
    reason,
    text: routineCodeText(reason),
    key: String(now.getTime()),
  }).catch(() => {});
  return true;
}

/** Ends a routine run that never started an agent run (skipped, failed, canceled…), when still open. */
export async function endOpenRoutineRun(
  db: Executor,
  routineRunId: string,
  end: { status: "skipped" | "failed" | "canceled" | "superseded" | "missed"; code: string; summary?: string },
) {
  const [row] = await db
    .update(routineRuns)
    .set({
      status: end.status,
      code: end.code,
      ...(end.summary !== undefined ? { summary: end.summary.slice(0, 500) } : {}),
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(routineRuns.id, routineRunId),
        // A run that handed off its report stays reported.
        inArray(routineRuns.status, ["queued", "starting", "started"]),
      ),
    )
    .returning();
  return row ?? null;
}
