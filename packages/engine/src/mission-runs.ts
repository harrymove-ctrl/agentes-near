import { and, type Executor, eq, inArray, schema, sql } from "@agenteschat/db";
import { enqueue } from "./outbox";
import { holdsMessages } from "./run-hold";
import { ACTIVE_RUN_STATUSES, queueOnRun } from "./run-inbox";

const { agentRuns } = schema;

/**
 * A run of the mission's agent on a notice in its home thread (agent mode,
 * ADR 0029): when the agent already works in that thread, the notice joins
 * that run (read at its next step, like a person's message); otherwise a new
 * run starts on it. Only that exact thread counts (a run elsewhere in a DM is
 * another conversation). Returns the new run, or `steered` with the run that
 * got it.
 */
export async function enqueueRunJob(
  tx: Executor,
  message: {
    id: string;
    orgId: string;
    channelId: string;
    threadId: string | null;
    hop: number;
    /** Its stretch (ADR 0089); none: it is its own (a mission's notice). */
    stretchId?: string | null;
  },
  agentId: string,
): Promise<{ run: typeof agentRuns.$inferSelect | null; steered: string | null }> {
  const threadRootId = message.threadId ?? message.id;
  const [active] = await tx
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      status: agentRuns.status,
      waitCode: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'code'`,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, message.orgId),
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.channelId, message.channelId),
        eq(agentRuns.threadRootId, threadRootId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        eq(agentRuns.background, false),
      ),
    )
    .orderBy(sql`${agentRuns.createdAt} desc`)
    .limit(1);
  // Queued only while that run is still active; one that just ended, or one held by a decision (an
  // approval, the mission's own: `holdsMessages`), and the notice starts a run.
  // Paused near a usage limit (ADR 0118), the mission's work reads its notices when it picks up: a run of their own
  // would be more of the same long work, paused at once.
  const usagePaused = active?.status === "waiting_input" && active.waitCode === "usage_pause";
  if (active && (usagePaused || !(await holdsMessages(tx, active))) && (await queueOnRun(tx, active.id, message.id)))
    return { run: null, steered: active.id };
  const [run] = await tx
    .insert(agentRuns)
    .values({
      orgId: message.orgId,
      agentId,
      channelId: message.channelId,
      threadRootId,
      triggerMessageId: message.id,
      trigger: "mention",
      // The notice is hop 0: inside an active mission its own wake-ups count toward no stretch's limit (the
      // mission's stuck guard holds them).
      hop: message.hop + 1,
      stretchId: message.stretchId ?? message.id,
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return { run: null, steered: null };
  await enqueue(tx, {
    orgId: message.orgId,
    kind: "agent_run.execute",
    payload: { runId: run.id },
    dedupeKey: `agent_run.execute:${run.id}`,
    maxAttempts: 4,
  });
  return { run, steered: null };
}
