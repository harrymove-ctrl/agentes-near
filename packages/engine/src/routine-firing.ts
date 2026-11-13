import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, isNull, lt, ne, schema, sql } from "@agenteschat/db";
import { stopRun } from "./cancel";
import { widgetRoutineHeld } from "./dashboards/refresh-ledger";
import { notifyRoutineStalled, notifyRoutineWaitingPlan } from "./notification-producers";
import { deferEventRun } from "./routine-events";
import { endRoutineRun } from "./routine-ledger";
import { endOpenRoutineRun, pauseRoutine, ROUTINE_CATCH_UP_MS, routineJobAlive } from "./routine-state";
import type { AgentRun } from "./runs";

const { routines, routineRuns, agentRuns, machines } = schema;

type RoutineRow = typeof routines.$inferSelect;
type RunRow = typeof routineRuns.$inferSelect;
type AgentRunRow = typeof agentRuns.$inferSelect;
type FiringDeps = { db: Database; pubsub?: PubSub };

/*
 * Firing rules (ADR 0053 §6): the claim, one run at a time per routine, a computer that is away,
 * stopping a routine's work, and pausing the routines of a person who left.
 */

const ACTIVE_RUN: AgentRunRow["status"][] = ["queued", "running", "waiting_approval", "waiting_input"];

const waitingToStart = (event: unknown) => {
  const e = event as Record<string, unknown> | null;
  return e?.gathered === true || e?.held === true;
};

/**
 * Takes a routine run for its `routine.run` job (§6.1): `queued` → `starting`, atomically, so two
 * workers never start it twice. A retried job takes back the row it claimed but never started (its
 * worker died, or a transient error gave it back). Runs waiting to start (gathered, held) have no
 * job and are never claimed. Null: nothing to do (already started, ended or not found).
 */
export async function claimRoutineRun(db: Database, routineRunId: string): Promise<RunRow | null> {
  const [row] = await db
    .update(routineRuns)
    .set({ status: "starting" })
    .where(
      and(
        eq(routineRuns.id, routineRunId),
        sql`(${routineRuns.status} = 'queued' or (${routineRuns.status} = 'starting' and ${routineRuns.agentRunId} is null))`,
        sql`coalesce(${routineRuns.event}->>'gathered', '') <> 'true'`,
        sql`coalesce(${routineRuns.event}->>'held', '') <> 'true'`,
      ),
    )
    .returning();
  return row ?? null;
}

/** A transient error after the claim: the row goes back to the queue and the job retries it. */
export async function unclaimRoutineRun(db: Database, routineRunId: string) {
  await db
    .update(routineRuns)
    .set({ status: "queued" })
    .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.status, "starting"), isNull(routineRuns.agentRunId)));
}

/** The slot never started a run (deleted, paused, the previous one still working…). */
export const skipRoutineRun = (db: Database, routineRunId: string, code: string) =>
  endOpenRoutineRun(db, routineRunId, { status: "skipped", code });

/**
 * Ends an open routine run and, when its agent run still works, stops that run quietly (nothing is
 * posted: a background run never speaks on a stop). The ledger is closed first, so its code wins.
 * A run being started as the caller read the row (no agent run yet) is read again once the ledger
 * closed: when its start won the race, the agent run it got is stopped too.
 */
async function endWithRun(
  deps: FiringDeps,
  rr: Pick<RunRow, "id" | "orgId" | "routineId">,
  seen: AgentRunRow | null,
  end: { status: "canceled" | "superseded" | "missed"; code: string; byUserId?: string | null },
) {
  await endRoutineRun(deps, { orgId: rr.orgId, routineId: rr.routineId, routineRunId: rr.id }, end);
  const ar = seen ?? (await agentRunOfRoutineRun(deps.db, rr.id));
  if (ar && ACTIVE_RUN.includes(ar.status)) {
    const actor = end.byUserId
      ? ({ type: "person", id: end.byUserId } as const)
      : ({ type: "system", reason: `routine_${end.code}` } as const);
    await stopRun(deps, ar.orgId, ar, "dm", actor).catch(() => null);
  }
}

/** The agent run a routine run started, read now. */
async function agentRunOfRoutineRun(db: Database, routineRunId: string): Promise<AgentRunRow | null> {
  const [row] = await db
    .select({ ar: agentRuns })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(eq(routineRuns.id, routineRunId));
  return row?.ar ?? null;
}

/**
 * A routine's run waits for the agent's computer: its creator and the agent's owner hear it once per
 * outage. An outage lasts until a run of the routine really runs again (it reports, stays silent or
 * fails on its own), whatever the computer does meanwhile: one that is online but can't take the turn
 * (an old runner, its plan's limit, signed out) stays connected, and must not notify every slot.
 */
async function stalled(deps: FiringDeps, routineId: string, orgId: string, machineId: string) {
  const [m] = await deps.db.select({ name: machines.name }).from(machines).where(eq(machines.id, machineId));
  await notifyRoutineStalled(deps, {
    orgId,
    routineId,
    machineId,
    machineName: m?.name ?? "",
    outageKey: await outageKey(deps, routineId),
  }).catch(() => {});
}

/** An outage of a routine lasts until one of its runs really runs again: the last such run names it. */
async function outageKey(deps: FiringDeps, routineId: string) {
  const [ran] = await deps.db
    .select({ id: routineRuns.id })
    .from(routineRuns)
    .where(and(eq(routineRuns.routineId, routineId), inArray(routineRuns.status, ["reported", "silent", "failed"])))
    .orderBy(desc(routineRuns.createdAt))
    .limit(1);
  return ran?.id ?? "none";
}

/** A background run started waiting for its agent's plan to reset: the routine's people hear it once per outage. */
export async function routineRunWaitingForPlan(deps: FiringDeps, run: Pick<AgentRun, "id" | "orgId" | "background">) {
  if (!run.background) return;
  const [rr] = await deps.db
    .select({ routineId: routineRuns.routineId })
    .from(routineRuns)
    .where(and(eq(routineRuns.orgId, run.orgId), eq(routineRuns.agentRunId, run.id)));
  if (!rr) return;
  await notifyRoutineWaitingPlan(deps, {
    orgId: run.orgId,
    routineId: rr.routineId,
    outageKey: await outageKey(deps, rr.routineId),
  }).catch(() => {});
}

/**
 * A background run started waiting for its computer (§6.4; the engine calls this when it parks a
 * background run on `waiting_input` for a machine): the routine's people hear it once per outage.
 */
export async function routineRunWaitingForComputer(
  deps: FiringDeps,
  run: Pick<AgentRun, "id" | "orgId" | "background">,
  machineId: string,
) {
  if (!run.background) return;
  const [rr] = await deps.db
    .select({ routineId: routineRuns.routineId })
    .from(routineRuns)
    .where(and(eq(routineRuns.orgId, run.orgId), eq(routineRuns.agentRunId, run.id)));
  if (rr) await stalled(deps, rr.routineId, run.orgId, machineId);
}

/**
 * One run at a time per routine (§6.3, §6.4), checked when a slot starts. Earlier runs still open:
 * - queued with a live job, or being started, or working: the slot is `skipped` (`previous_running`);
 * - waiting for the agent's computer: it gives way (`superseded`, `waiting_computer`), the freshest
 *   slot is the one that runs when the computer is back, and the routine's people hear it once;
 * - waiting for a person (an approval, an answer) since before the previous slot: it gives way
 *   (`superseded`; its approvals expire); a newer wait keeps it and the slot is `previous_waiting`.
 * An event run never replaces another: it waits for the one working to end (gathered again).
 * Returns null when the run may start, else the code it was skipped with (or `gathered`).
 */
export async function makeWayForRun(deps: FiringDeps, routine: RoutineRow, run: RunRow): Promise<string | null> {
  const { db } = deps;
  const earlier = await db
    .select({ rr: routineRuns, ar: agentRuns, alive: routineJobAlive(routineRuns.id) })
    .from(routineRuns)
    .leftJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.routineId, routine.id),
        ne(routineRuns.id, run.id),
        inArray(routineRuns.status, ["queued", "starting", "started", "reported"]),
        isNull(routineRuns.finishedAt),
        sql`(${routineRuns.createdAt}, ${routineRuns.id}) < (${run.createdAt.toISOString()}::timestamptz, ${run.id}::uuid)`,
      ),
    )
    .orderBy(routineRuns.createdAt);
  const event = run.trigger === "event";
  const blocked = async (code: string) => {
    if (!event) return code;
    await deferEventRun(deps, run);
    return "gathered";
  };
  for (const { rr, ar, alive } of earlier) {
    if (rr.status === "queued") {
      // Waiting to start has no job on purpose; a queued run whose job died is the reaper's.
      if (!waitingToStart(rr.event) && alive) return blocked("previous_running");
      continue;
    }
    if (rr.status === "starting") return blocked("previous_running");
    // Its agent run ended and the ledger lags behind: the reaper closes it; it holds nothing.
    if (!ar || !ACTIVE_RUN.includes(ar.status)) continue;
    if (ar.status === "queued" || ar.status === "running") return blocked("previous_running");
    if (event) return blocked("previous_running");
    // Waiting for its plan's limit or its budget: the freshest slot runs once there's room again.
    const usageWait = (ar.transcript as { waitingForBrain?: { code?: string; source?: string } } | null)
      ?.waitingForBrain;
    const usageCode = usageWait?.code === "usage_pause" ? usageWait.source : usageWait?.code;
    if (
      ar.status === "waiting_input" &&
      (usageCode === "plan_limit" || usageCode === "plan" || usageCode === "budget")
    ) {
      await endWithRun(deps, rr, ar, {
        status: "superseded",
        code: usageCode === "budget" ? "waiting_budget" : "waiting_plan",
      });
      continue;
    }
    // In line for room on an online computer: it keeps its place and this slot gives way.
    if (ar.status === "waiting_input" && usageWait?.code === "busy") return blocked("previous_waiting");
    if (ar.status === "waiting_input" && ar.waitingMachineId) {
      await endWithRun(deps, rr, ar, { status: "superseded", code: "waiting_computer" });
      await stalled(deps, routine.id, routine.orgId, ar.waitingMachineId);
      continue;
    }
    // Waiting for a person: since before the slot before this one, it gives way.
    const [previousSlot] = await db
      .select({ at: routineRuns.at })
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routine.id), ne(routineRuns.id, run.id), lt(routineRuns.at, run.at)))
      .orderBy(desc(routineRuns.at))
      .limit(1);
    if (previousSlot && ar.updatedAt.getTime() < previousSlot.at.getTime()) {
      await endWithRun(deps, rr, ar, { status: "superseded", code: "superseded" });
      continue;
    }
    return blocked("previous_waiting");
  }
  return null;
}

/**
 * The computer of a waiting routine run is back (§6.4): a run whose slot is more than 12 hours old
 * no longer runs; it is `missed` (`stale`) and its agent run ends quietly. Returns whether it was.
 */
export async function missStaleRoutineRun(
  deps: FiringDeps,
  agentRunId: string,
  now = new Date(),
  /** Why it came too late: its computer (`stale`), or its plan or budget (`waiting_plan_late`, `waiting_budget_late`). */
  code = "stale",
): Promise<boolean> {
  const [row] = await deps.db
    .select({ rr: routineRuns, ar: agentRuns })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.agentRunId, agentRunId),
        inArray(routineRuns.status, ["started", "reported"]),
        isNull(routineRuns.finishedAt),
      ),
    );
  if (!row?.ar.background || row.rr.at.getTime() > now.getTime() - ROUTINE_CATCH_UP_MS) return false;
  await endWithRun(deps, row.rr, row.ar, { status: "missed", code });
  return true;
}

/**
 * Stops a routine's work in progress (§6.7): its open runs end `canceled` with `code` (`stopped`,
 * `paused`, `deleted`, `creator_left`; `byUserId`: who stopped it) and their agent runs are canceled
 * quietly. Runs waiting to start for its events are canceled too (their emails wait for the next
 * run); emails held for the next email stay. Returns how many runs it stopped.
 */
export async function haltRoutineRuns(
  deps: FiringDeps,
  orgId: string,
  routineId: string,
  end: { code: string; byUserId?: string | null },
): Promise<number> {
  const open = await deps.db
    .select({ rr: routineRuns, ar: agentRuns })
    .from(routineRuns)
    .leftJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        eq(routineRuns.orgId, orgId),
        eq(routineRuns.routineId, routineId),
        inArray(routineRuns.status, ["queued", "starting", "started", "reported"]),
        isNull(routineRuns.finishedAt),
      ),
    )
    // Not yet started first: a run gathered behind the one stopped never starts from its ending.
    .orderBy(sql`${routineRuns.agentRunId} is not null`, routineRuns.createdAt);
  let stopped = 0;
  for (const { rr, ar } of open) {
    const event = rr.event as Record<string, unknown> | null;
    if (rr.status === "queued" && event?.held === true) continue;
    // A run that handed off and ended is the reaper's; one that still works is stopped.
    if (rr.status === "reported" && (!ar || !ACTIVE_RUN.includes(ar.status))) continue;
    await endWithRun(deps, rr, ar, { status: "canceled", code: end.code, byUserId: end.byUserId ?? null });
    stopped++;
  }
  return stopped;
}

/**
 * A person left the organization (§6.2): their routines pause at once (`creator_left`, the agent's
 * owner hears it and can take them over) and their work in progress stops.
 */
export async function pauseRoutinesOfCreator(deps: FiringDeps, orgId: string, userId: string): Promise<number> {
  const rows = await deps.db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.createdByUserId, userId),
        eq(routines.active, true),
        isNull(routines.deletedAt),
      ),
    );
  for (const r of rows) {
    await pauseRoutine(deps, r, "creator_left");
    await haltRoutineRuns(deps, orgId, r.id, { code: "creator_left" });
    // A widget's routine says it on its widget now, not at its next Resolve (ADR 0135 §6).
    if ((r.target as { type?: unknown } | null)?.type === "widget") {
      await widgetRoutineHeld(deps, r, "creator_left").catch(() => {});
    }
  }
  return rows.length;
}
