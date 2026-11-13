import { and, type Database, desc, type Executor, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { cutText } from "./format";
import { enqueue } from "./outbox";
import { routineJobAlive } from "./routine-state";

const { routines, routineRuns, agentRuns, routineHookCalls } = schema;

type RoutineRow = typeof routines.$inferSelect;

/**
 * Events that fire routines (ADR 0053 §6.3, §6.5, §6.8): a routine never runs twice at once, so an
 * event that arrives while one of its runs is queued joins that run's event; while one works, events
 * gather in ONE waiting run (`event.gathered`, no job yet) that starts when it ends. Emails of a run
 * that failed or was stopped wait in a held run (`event.held`) that the next email starts. An event
 * with a dedupe key (a provider's delivery id, an issue id) never fires a routine twice.
 */

/** At most this many events go into one run (the rest are only counted). */
export const MAX_EVENTS_PER_RUN = 20;

/** An event as a routine run keeps it (`routine_runs.event`). */
export type RoutineEventPayload = Record<string, unknown> & { type: string; summary: string };

/** How an incoming event joins the event of a run that hasn't started yet. */
export type EventMerge = (
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
) => Record<string, unknown>;

const FLAGS = ["gathered", "held", "events", "extra", "dedupeKeys", "summary", "type"];
const one = (e: Record<string, unknown>) => Object.fromEntries(Object.entries(e).filter(([k]) => !FLAGS.includes(k)));
const listOf = (e: Record<string, unknown>) =>
  Array.isArray(e.events) ? (e.events as Record<string, unknown>[]) : [{ summary: String(e.summary ?? ""), ...one(e) }];
const countOf = (e: Record<string, unknown>) => (typeof e.extra === "number" ? e.extra : 0);

/** Events of any kind, merged into one list (newest last, the oldest dropped past the cap) and one summary. */
export const mergeEvents: EventMerge = (current, incoming) => {
  const all = [...listOf(current), ...listOf(incoming)];
  const kept = all.slice(-MAX_EVENTS_PER_RUN);
  const extra = countOf(current) + countOf(incoming) + all.length - kept.length;
  const lines = kept.map((e) => `- ${cutText(String(e.summary ?? ""), 300)}`);
  return {
    type: current.type ?? incoming.type,
    events: kept,
    extra,
    summary: [
      `${kept.length + extra} events since the last run (newest last):`,
      ...lines,
      ...(extra > 0 ? [`(and ${extra} older ones not listed)`] : []),
    ].join("\n"),
  };
};

const flag = (event: unknown, key: "gathered" | "held") =>
  Boolean(event && typeof event === "object" && (event as Record<string, unknown>)[key] === true);

/** The event with its waiting flags set (and its dedupe keys kept). */
function withState(event: Record<string, unknown>, keys: string[], state: { gathered?: boolean; held?: boolean }) {
  const { gathered: _g, held: _h, dedupeKeys: _k, ...rest } = event;
  return {
    ...rest,
    ...(keys.length > 0 ? { dedupeKeys: [...new Set(keys)] } : {}),
    ...(state.gathered ? { gathered: true } : {}),
    ...(state.held ? { held: true } : {}),
  };
}

const keysOf = (event: unknown) =>
  event && typeof event === "object" && Array.isArray((event as Record<string, unknown>).dedupeKeys)
    ? ((event as Record<string, unknown>).dedupeKeys as unknown[]).filter((k): k is string => typeof k === "string")
    : [];

const lockRoutine = (tx: Executor, routineId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`routine-event:${routineId}`}, 0))`);

/** The job that runs a routine run (one per row). */
export const enqueueRoutineJob = (tx: Executor, row: { id: string; orgId: string }) =>
  enqueue(tx, {
    orgId: row.orgId,
    kind: "routine.run",
    payload: { routineRunId: row.id },
    dedupeKey: `routine.run:${row.id}`,
    maxAttempts: 3,
  });

/**
 * A run of this routine is working or about to: being started, started with its agent run still
 * active, or queued with its job alive.
 */
export async function routineInFlight(db: Executor, routineId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: routineRuns.id })
    .from(routineRuns)
    .leftJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.routineId, routineId),
        isNull(routineRuns.finishedAt),
        or(
          eq(routineRuns.status, "starting"),
          and(
            inArray(routineRuns.status, ["started", "reported"]),
            inArray(agentRuns.status, ["queued", "running", "waiting_approval", "waiting_input"]),
          ),
          and(eq(routineRuns.status, "queued"), routineJobAlive(routineRuns.id)),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Inserts a routine run at `at` (moved by a millisecond when that slot is taken: `(routine_id, at)` is unique). */
async function insertRun(
  tx: Executor,
  routine: Pick<RoutineRow, "id" | "orgId">,
  values: { at: Date; trigger: string; event: Record<string, unknown>; dedupeKey: string | null },
) {
  for (let i = 0; i < 5; i++) {
    const [row] = await tx
      .insert(routineRuns)
      .values({
        orgId: routine.orgId,
        routineId: routine.id,
        at: new Date(values.at.getTime() + i),
        trigger: values.trigger,
        event: values.event,
        dedupeKey: values.dedupeKey,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    // The same dedupe key won meanwhile: nothing to add.
    if (values.dedupeKey) {
      const [seen] = await tx
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .where(and(eq(routineRuns.routineId, routine.id), eq(routineRuns.dedupeKey, values.dedupeKey)));
      if (seen) return null;
    }
  }
  return null;
}

/** What became of an event: a new run, joined to a queued one, gathered for after the one working, or a repeat. */
export type EventOutcome = "queued" | "merged" | "gathered" | "duplicate";

/**
 * An event for a routine (§6.3, §6.5): a repeat of an event it already got is dropped; else it joins
 * the run still queued with its job alive, or the run waiting to start (gathered, or held emails),
 * which starts now when nothing of the routine is working; else a run starts, or, while one works,
 * a gathered run waits for it to end (`startGatheredRun`). `runId`: the routine run it went into.
 */
export async function queueEventRun(
  deps: { db: Database },
  routine: Pick<RoutineRow, "id" | "orgId">,
  input: { event: RoutineEventPayload; dedupeKey?: string | null; merge?: EventMerge; at?: Date },
): Promise<{ outcome: EventOutcome; runId: string | null }> {
  const merge = input.merge ?? mergeEvents;
  const key = input.dedupeKey ?? null;
  return deps.db.transaction(async (tx) => {
    await lockRoutine(tx, routine.id);
    if (key) {
      const [seen] = await tx
        .select({ id: routineRuns.id })
        .from(routineRuns)
        .where(
          and(
            eq(routineRuns.routineId, routine.id),
            or(
              eq(routineRuns.dedupeKey, key),
              sql`${routineRuns.event}->'dedupeKeys' @> jsonb_build_array(${key}::text)`,
            ),
          ),
        )
        .limit(1);
      if (seen) return { outcome: "duplicate" as const, runId: seen.id };
    }
    const waiting = await tx
      .select({ id: routineRuns.id, event: routineRuns.event, alive: routineJobAlive(routineRuns.id) })
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routine.id), eq(routineRuns.status, "queued")))
      .orderBy(desc(routineRuns.createdAt))
      .for("update");
    const join = async (row: { id: string; event: Record<string, unknown> | null }, state: { gathered?: boolean }) => {
      const current = row.event ?? {};
      const keys = [...keysOf(current), ...(key ? [key] : [])];
      await tx
        .update(routineRuns)
        .set({ event: withState(merge(current, input.event), keys, state) })
        .where(eq(routineRuns.id, row.id));
    };
    const live = waiting.find((w) => w.alive && !flag(w.event, "gathered") && !flag(w.event, "held"));
    if (live) {
      await join(live, {});
      return { outcome: "merged" as const, runId: live.id };
    }
    const inFlight = await routineInFlight(tx, routine.id);
    const pending = waiting.find((w) => flag(w.event, "gathered") || flag(w.event, "held"));
    if (pending) {
      await join(pending, { gathered: inFlight });
      if (inFlight) return { outcome: "gathered" as const, runId: pending.id };
      await enqueueRoutineJob(tx, { id: pending.id, orgId: routine.orgId });
      return { outcome: "queued" as const, runId: pending.id };
    }
    const row = await insertRun(tx, routine, {
      at: input.at ?? new Date(),
      trigger: "event",
      event: withState(input.event, key ? [key] : [], { gathered: inFlight }),
      dedupeKey: key,
    });
    if (!row) return { outcome: "duplicate" as const, runId: null };
    if (inFlight) return { outcome: "gathered" as const, runId: row.id };
    await enqueueRoutineJob(tx, row);
    return { outcome: "queued" as const, runId: row.id };
  });
}

/**
 * Emails of a run that failed or was stopped (§6.8) wait for the next run: they join the run waiting
 * to start, or a held run that the next email starts (never one on its own: a stop is respected).
 */
export async function holdForNextRun(
  deps: { db: Database },
  routine: Pick<RoutineRow, "id" | "orgId">,
  event: RoutineEventPayload,
  merge: EventMerge,
) {
  await deps.db.transaction(async (tx) => {
    await lockRoutine(tx, routine.id);
    const waiting = await tx
      .select({ id: routineRuns.id, event: routineRuns.event, alive: routineJobAlive(routineRuns.id) })
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routine.id), eq(routineRuns.status, "queued")))
      .orderBy(desc(routineRuns.createdAt))
      .for("update");
    const target =
      waiting.find((w) => w.alive && !flag(w.event, "gathered") && !flag(w.event, "held")) ??
      waiting.find((w) => flag(w.event, "gathered") || flag(w.event, "held"));
    if (target) {
      const current = target.event ?? {};
      await tx
        .update(routineRuns)
        .set({
          event: withState(merge(current, event), keysOf(current), {
            gathered: flag(current, "gathered"),
            held: flag(current, "held"),
          }),
        })
        .where(eq(routineRuns.id, target.id));
      return;
    }
    await insertRun(tx, routine, {
      at: new Date(),
      trigger: "event",
      event: withState(event, [], { held: true }),
      dedupeKey: null,
    });
  });
}

/**
 * An event run whose job came while another run of the routine works (a manual run started in
 * between): it waits for that one instead (§6.3), as a gathered run of its own. Moved to a new row,
 * since its job's key is spent (`startGatheredRun` gives the new row a job). Returns whether it moved.
 */
export async function deferEventRun(
  deps: { db: Database },
  run: Pick<typeof routineRuns.$inferSelect, "id" | "orgId" | "routineId">,
): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    await lockRoutine(tx, run.routineId);
    const [taken] = await tx
      .delete(routineRuns)
      .where(and(eq(routineRuns.id, run.id), eq(routineRuns.status, "starting"), isNull(routineRuns.agentRunId)))
      .returning();
    if (!taken) return false;
    const event = taken.event ?? {};
    const keys = [...keysOf(event), ...(taken.dedupeKey ? [taken.dedupeKey] : [])];
    const moved = await insertRun(
      tx,
      { id: taken.routineId, orgId: taken.orgId },
      {
        at: taken.at,
        trigger: taken.trigger,
        event: withState(event, keys, { gathered: true }),
        dedupeKey: taken.dedupeKey,
      },
    );
    // The webhook calls it carried point to where it went.
    if (moved) {
      await tx
        .update(routineHookCalls)
        .set({ routineRunId: moved.id })
        .where(and(eq(routineHookCalls.routineId, taken.routineId), eq(routineHookCalls.routineRunId, taken.id)));
    }
    return true;
  });
}

/**
 * A run of the routine ended (§6.3): the run gathered while it worked starts now, unless another one
 * already works. Returns whether one started.
 */
export async function startGatheredRun(deps: { db: Database }, routineId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    await lockRoutine(tx, routineId);
    if (await routineInFlight(tx, routineId)) return false;
    const [gathered] = await tx
      .select({ id: routineRuns.id, orgId: routineRuns.orgId })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.routineId, routineId),
          eq(routineRuns.status, "queued"),
          sql`${routineRuns.event}->>'gathered' = 'true'`,
        ),
      )
      .orderBy(routineRuns.createdAt)
      .limit(1)
      .for("update");
    if (!gathered) return false;
    await tx
      .update(routineRuns)
      .set({ event: sql`${routineRuns.event} - 'gathered'` })
      .where(eq(routineRuns.id, gathered.id));
    await enqueueRoutineJob(tx, gathered);
    return true;
  });
}
