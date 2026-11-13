import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, schema } from "@agenteschat/db";
import { caches } from "./cache";
import { sha256 } from "./crypto";
import { createAgentRuns } from "./dispatch";
import { insertMessageWithRuns, type Message } from "./messages";
import { type RoutineBrief, routineRoomKey } from "./routine-brief";

const { channels, channelMembers, routineRuns } = schema;

/**
 * The routine room (ADR 0053 §4): an agent-only private conversation per routine (`routineRoomKey`),
 * where the routine's brief is written and its background run works. No person is a member, so
 * nobody reads it and it never shows in anyone's lists; other runs' searches never reach it
 * (`agentSearchChannels` keeps only a run's own channel, public ones and, for a routine's run, where it reports).
 * Created the first time.
 */
export async function openRoutineRoom(tx: Executor, orgId: string, agentId: string, routineId: string) {
  const dmKey = routineRoomKey(agentId, routineId);
  const existing = async () =>
    (
      await tx
        .select()
        .from(channels)
        .where(and(eq(channels.orgId, orgId), eq(channels.dmKey, dmKey)))
    )[0];
  const found = await existing();
  if (found) {
    if (found.archivedAt) await tx.update(channels).set({ archivedAt: null }).where(eq(channels.id, found.id));
    return found;
  }
  const [channel] = await tx
    .insert(channels)
    .values({
      orgId,
      name: `routine-${sha256(`${orgId}|${dmKey}`).slice(0, 20)}`,
      visibility: "private",
      kind: "dm",
      dmKey,
    })
    .onConflictDoNothing()
    .returning();
  if (channel) {
    await tx.insert(channelMembers).values({ orgId, channelId: channel.id, agentId });
    caches.scopes.deletePrefix(`${orgId}:${agentId}:visible`);
    return channel;
  }
  const raced = await existing(); // a concurrent firing opened it first
  if (!raced) throw new Error("could not open the routine's room");
  return raced;
}

/**
 * Starts a routine's background run (ADR 0053 §4): in its room, the brief is written as its
 * creator (`meta.routineBrief`, the legacy `meta.routine` and `meta.background`) with only the
 * routine's instructions as its text (the event stays in `routine_runs.event`; the context puts it
 * in the outside-content envelope), and the agent's background run starts on it. Nothing reaches
 * the conversation it reports to. The routine run moves to `started` with the brain it starts on.
 * Null when its row was no longer being started (stopped meanwhile).
 */
export async function startRoutineRun(
  deps: { db: Database; pubsub?: PubSub },
  input: { orgId: string; agentId: string; brief: RoutineBrief; body: string; brain: string },
): Promise<{ message: Message; runId: string; roomId: string } | null> {
  const { brief } = input;
  const creator = brief.creatorUserId;
  if (!creator) throw new Error("a routine's brief needs its creator");
  const start = async (tx: Executor) => {
    const room = await openRoutineRoom(tx, input.orgId, input.agentId, brief.routineId);
    const { message } = await insertMessageWithRuns(
      tx,
      {
        orgId: input.orgId,
        channelId: room.id,
        threadId: null,
        author: { type: "person", userId: creator },
        body: input.body,
        meta: {
          routineBrief: brief,
          routine: { id: brief.routineId, name: brief.name, runId: brief.routineRunId },
          background: true,
        },
      },
      { startRuns: false, deliver: false },
    );
    const [agentRun] = await createAgentRuns(tx, message, [input.agentId], "mention", { background: true });
    if (!agentRun) throw new Error("the routine's run did not start");
    const [moved] = await tx
      .update(routineRuns)
      .set({ status: "started", agentRunId: agentRun.id, summary: "", brain: input.brain })
      .where(
        and(
          eq(routineRuns.id, brief.routineRunId),
          eq(routineRuns.orgId, input.orgId),
          eq(routineRuns.status, "starting"),
        ),
      )
      .returning({ id: routineRuns.id });
    // Stopped while it was being started: nothing starts (the transaction rolls back).
    if (!moved) throw new NotStarting();
    return { message, runId: agentRun.id, roomId: room.id };
  };
  try {
    return await deps.db.transaction((tx) => start(tx));
  } catch (error) {
    if (error instanceof NotStarting) return null;
    throw error;
  }
}

/** The routine run left `starting` before its run started (a person stopped it). */
class NotStarting extends Error {}
