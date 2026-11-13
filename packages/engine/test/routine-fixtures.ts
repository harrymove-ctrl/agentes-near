import { eq, schema } from "@agenteschat/db";
import { createRoutine, executeRoutineRun, queueRoutineRun, type RoutineInput } from "../src";
import type { Fixture } from "./fixtures";

/** Routine helpers for the engine tests (ADR 0053): a routine, one firing, its rows. */

export const routineDeps = (f: Fixture) => ({ db: f.db, pubsub: f.pubsub, context: f.context });

/** A daily routine of `@dev` that reports to `general` (override any part). */
export function channelRoutine(f: Fixture, input: Partial<RoutineInput> = {}, creatorId = f.owner.id) {
  return createRoutine(routineDeps(f), creatorId, f.org.id, {
    name: "Avaliações",
    agentId: f.agent.id,
    prompt: "Veja as avaliações novas.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
    ...input,
  });
}

export async function routineRow(f: Fixture, routineId: string) {
  const [row] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routineId));
  if (!row) throw new Error("no routine");
  return row;
}

export async function routineRunRow(f: Fixture, routineRunId: string) {
  const [row] = await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, routineRunId));
  if (!row) throw new Error("no routine run");
  return row;
}

export async function agentRunRow(f: Fixture, agentRunId: string | null) {
  const [row] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, agentRunId ?? ""));
  if (!row) throw new Error("no agent run");
  return row;
}

/**
 * Fires one slot (or manual run) of a routine: only its `routine.run` job, so the agent run it
 * starts stays queued (nothing executes). Returns its routine run.
 */
export async function fire(f: Fixture, routineId: string, at: Date, trigger: "schedule" | "manual" = "manual") {
  const queued = await queueRoutineRun({ db: f.db }, await routineRow(f, routineId), at, trigger);
  if (!queued) throw new Error("slot already queued");
  await executeRoutineRun(routineDeps(f), queued.id);
  return routineRunRow(f, queued.id);
}

/** The routine's brief messages (`meta.routineBrief`), oldest first. */
export async function briefs(f: Fixture) {
  return (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.meta.routineBrief !== undefined,
  );
}

/** Messages in a conversation, oldest first. */
export async function messagesIn(f: Fixture, channelId: string) {
  return (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.channelId === channelId,
  );
}

/** Notifications of a kind, for everyone. */
export async function notificationsOf(f: Fixture, kind: string) {
  return (await f.db.select().from(schema.notifications)).filter((n) => n.kind === kind);
}

/** A moment `minutes` from now (negative: in the past). */
export const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);
