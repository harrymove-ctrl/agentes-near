import { and, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { taskRequester } from "./machine-tasks";
import { getMessage } from "./messages";
import type { ToolContext } from "./tools/types";

const { missions, missionParticipants } = schema;

/** The open mission a run works in: its thread's, when the mission is this agent's (ADR 0029). */
export type RunMission = Pick<
  typeof missions.$inferSelect,
  "id" | "orgId" | "agentId" | "ownerId" | "machineId" | "status" | "executor" | "threadRootId" | "channelId" | "title"
>;

export async function missionOfRun(
  ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "threadRootId">,
): Promise<RunMission | null> {
  if (!/^[0-9a-f-]{36}$/i.test(ctx.threadRootId)) return null;
  const [row] = await ctx.db
    .select({
      id: missions.id,
      orgId: missions.orgId,
      agentId: missions.agentId,
      ownerId: missions.ownerId,
      machineId: missions.machineId,
      status: missions.status,
      executor: missions.executor,
      threadRootId: missions.threadRootId,
      channelId: missions.channelId,
      title: missions.title,
    })
    .from(missions)
    .where(
      and(
        eq(missions.orgId, ctx.orgId),
        eq(missions.threadRootId, ctx.threadRootId),
        inArray(missions.status, ["proposed", "active", "paused", "awaiting_close"]),
      ),
    );
  return row && row.agentId === ctx.agentId ? row : null;
}

/** Owner or `decide` in the mission. */
export async function actsInMission(db: Executor, mission: Pick<RunMission, "id" | "ownerId">, userId: string | null) {
  if (!userId) return false;
  if (mission.ownerId === userId) return true;
  const [p] = await db
    .select({ role: missionParticipants.role })
    .from(missionParticipants)
    .where(and(eq(missionParticipants.missionId, mission.id), eq(missionParticipants.userId, userId)));
  return p?.role === "decide";
}

/** What a run that doesn't act for the mission (`runActsForMission`) is told when it tries to make it act. */
export const NOT_FOR_MISSION =
  "Only the mission's owner or someone who can decide can make the mission act. Tell the person; the owner can accept their suggestion.";

/**
 * A run may do the mission's work (its tools, tasks on its computer, cancel
 * its tasks) when the person behind it is the owner or decides, or when the
 * mission itself woke it (its inbox or one of its tasks ending, agent mode).
 */
export async function runActsForMission(ctx: ToolContext, mission: RunMission): Promise<boolean> {
  const trigger = await getMessage(ctx.db, ctx.orgId, ctx.triggerMessageId);
  if (trigger && trigger.authorAgentId === ctx.agentId && trigger.authorUserId === null) {
    const inbox = trigger.meta?.missionInbox as { missionId?: unknown } | undefined;
    const task = trigger.meta?.machineTask as { missionId?: unknown } | undefined;
    if (inbox?.missionId === mission.id || task?.missionId === mission.id) return true;
  }
  return actsInMission(ctx.db, mission, await taskRequester(ctx));
}
