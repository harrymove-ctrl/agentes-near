import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, lt, schema, sql } from "@agenteschat/db";
import { routineBriefOfRun, routineOfRun } from "./background";
import { widgetRoutineEnded } from "./dashboards/refresh-ledger";
import { publishDelivery } from "./delivery";
import { publishRoutineRuns } from "./events";
import { deliverRoutineReport, routineDeliveryBlock } from "./hand-off";
import { releaseRoutineEmails } from "./mail/inbound";
import { notifyRoutineFailed, notifyRoutineFinished, resolveRoutineTrouble } from "./notification-producers";
import { startGatheredRun } from "./routine-events";
import { pauseRoutine, ROUTINE_FATIGUE_LIMIT, routineJobAlive } from "./routine-state";
import { type AgentRun, runErrorDetail } from "./runs";

const { routineRuns, routines, agentRuns } = schema;

/** What a background run's record keeps of its final text (the routine's history, read by its next run). */
export const MAX_RUN_RECORD = 4000;

/** How a routine's background run ended, on any path (ADR 0053). */
export type RoutineRunEnd =
  /** Its final answer: the run's own record (empty when it had nothing to say). */
  | { status: "done"; text: string }
  /** It failed: `code` is the coded reason the app translates (a run error code, `no_report`…). */
  | { status: "failed"; code: string; detail?: string }
  /** A person stopped it, or the next slot replaced it (`superseded`), or it gave way (`missed`). */
  | { status: "canceled" | "superseded" | "missed"; code: string; byUserId?: string | null };

/** A routine run's end state (`routine_runs.status`); `skipped` when its report could no longer be delivered. */
export type RoutineRunEndStatus = "reported" | "silent" | "failed" | "canceled" | "superseded" | "missed" | "skipped";

/** Statuses a routine run can still end from. */
const OPEN = ["queued", "starting", "started", "reported"];

type LedgerDeps = { db: Database; pubsub?: PubSub };

/** A routine run's ids. */
interface RoutineRunRef {
  orgId: string;
  routineId: string;
  routineRunId: string;
}

/** The record a final text leaves (routines written for the old protocol may still answer the bare word NO_REPLY). */
const recordOf = (text: string) => {
  const said = text.trim();
  return /^[`*]*NO_REPLY[`*]*\.?$/.test(said) ? "" : said.slice(0, MAX_RUN_RECORD);
};

/** The coded reason of a run error (`budget_exceeded`, `provider_error`, `runner_outdated`…), for a failed routine run. */
export function routineFailureCode(error: string | null | undefined): string {
  const coded = runErrorDetail(error)?.errorCode.replace(/^run\./, "");
  // A computer's failure reads as one, whatever its own code (`runner_error`, `timeout`); a CLI's too, whatever its
  // brain's (`claude_failed`, `codex_failed`) and whether it said why.
  if (coded === "computer_failed" || coded === "computer_timeout") return coded;
  if (coded?.startsWith("cli_")) return "cli_failed";
  const plain = /^([a-z][a-z_]*)(?::|$)/.exec(error ?? "");
  if (plain?.[1]) return plain[1];
  return coded && coded !== "failed" ? coded : "error";
}

/** A failed run's end for its routine's ledger: the coded reason, with the run error's detail when it has one. */
export function routineFailureEnd(error: string): { code: string; detail?: string } {
  const detail = runErrorDetail(error)?.errorParams?.detail;
  return detail ? { code: routineFailureCode(error), detail } : { code: routineFailureCode(error) };
}

/**
 * Closes the routine run of a background run, on every ending (ADR 0053 §5): its answer, a failure,
 * a stop, a deploy, a computer cut off, a supersede. The one place a routine's ledger moves to its
 * end, so the run strip, the failure streak and the next run's "last time" all read one truth. A run
 * that already handed off stays `reported` whatever happens after (people heard it).
 *
 * A routine that reports every time (`always`, §7) and ended with a final text but no `hand_off`
 * delivers that text as its report (`auto_report`); with no text it fails (`no_report`). Then
 * `afterRoutineRunEnded`: the failure streak, emails released, the gathered event run started.
 * Returns the routine run and its end status, or null when the run is not a routine's or its row
 * already ended.
 */
export async function closeRoutineRun(
  deps: LedgerDeps,
  run: Pick<AgentRun, "id" | "orgId" | "triggerMessageId" | "background">,
  end: RoutineRunEnd,
): Promise<{ routineId: string; routineRunId: string; status: RoutineRunEndStatus } | null> {
  if (!run.background) return null;
  const routine = await routineOfRun(deps.db, run);
  if (!routine?.routineRunId) return null;
  const ref = { orgId: run.orgId, routineId: routine.routineId, routineRunId: routine.routineRunId };
  const [agentRun] = await deps.db
    .select({ agentId: agentRuns.agentId, brain: agentRuns.brain })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, run.id), eq(agentRuns.orgId, run.orgId)));
  let final: RoutineRunEnd = end;
  if (end.status === "done" && agentRun) {
    const reported = await reportEveryTime(deps, run, agentRun.agentId, ref, recordOf(end.text));
    if (reported === "no_report") final = { status: "failed", code: "no_report" };
    else if (reported) {
      await afterRoutineRunEnded(deps, { ...ref, status: "skipped", code: reported, event: null });
      return { routineId: ref.routineId, routineRunId: ref.routineRunId, status: "skipped" };
    }
  }
  const row = await finishRoutineRow(deps, ref, final, agentRun?.brain ?? null);
  if (!row) {
    // Ended already (a stop, a report that couldn't be delivered): a run gathered meanwhile still starts.
    await startGatheredRun(deps, ref.routineId).catch(() => false);
    return null;
  }
  return { routineId: ref.routineId, routineRunId: ref.routineRunId, status: row.status as RoutineRunEndStatus };
}

/**
 * `always`: a run that ended without handing off delivers its final text as the report. Returns null
 * when nothing else is needed, `no_report` when there was no text, or the block code when the report
 * could no longer be delivered (the row then ended `skipped`).
 */
async function reportEveryTime(
  deps: LedgerDeps,
  run: Pick<AgentRun, "id" | "orgId" | "triggerMessageId">,
  agentId: string,
  ref: RoutineRunRef,
  record: string,
): Promise<string | null> {
  const brief = await routineBriefOfRun(deps.db, run);
  if (brief?.report !== "always") return null;
  const [row] = await deps.db
    .select({ status: routineRuns.status, finishedAt: routineRuns.finishedAt })
    .from(routineRuns)
    .where(and(eq(routineRuns.id, ref.routineRunId), eq(routineRuns.orgId, ref.orgId)));
  if (!row || row.finishedAt || row.status === "reported" || !OPEN.includes(row.status)) return null;
  if (!record) return "no_report";
  const outcome = await deps.db.transaction(async (tx) => {
    const block = await routineDeliveryBlock(tx, brief);
    if (block) {
      await tx
        .update(routineRuns)
        .set({ status: "skipped", code: block, summary: record, finishedAt: new Date() })
        .where(
          and(eq(routineRuns.id, ref.routineRunId), inArray(routineRuns.status, ["queued", "starting", "started"])),
        );
      return { block };
    }
    return {
      delivered: await deliverRoutineReport(tx, {
        run: { id: run.id, orgId: run.orgId, agentId },
        brief,
        text: record,
        code: "auto_report",
        // Its final text is its record, written for the next run, not for people: the agent tells them.
        wake: true,
      }),
    };
  });
  if (outcome.block) return outcome.block;
  if (outcome.delivered) await publishDelivery(deps.pubsub, outcome.delivered).catch(() => {});
  return null;
}

/**
 * Moves a routine run to its end (while still open) and runs what follows an ending. `brain`: the
 * brain the run really thought with, when known (else the one recorded when it started).
 */
async function finishRoutineRow(deps: LedgerDeps, ref: RoutineRunRef, end: RoutineRunEnd, brain: string | null) {
  const reported = sql`${routineRuns.status} = 'reported'`;
  let set: Record<string, unknown>;
  if (end.status === "done") {
    const record = recordOf(end.text);
    set = {
      status: sql`case when ${reported} then 'reported' else 'silent' end`,
      // No final text: a hand-off keeps its report as the record; silence keeps nothing.
      summary: record ? record : sql`case when ${reported} then ${routineRuns.summary} else '' end`,
    };
  } else {
    // A failure keeps its detail; a stop keeps who stopped it (the app shows "Stopped by …").
    const note = end.status === "failed" ? end.detail?.slice(0, 500) : (end.byUserId ?? undefined);
    set = {
      status: sql`case when ${reported} then 'reported' else ${end.status} end`,
      code: sql`case when ${reported} then ${routineRuns.code} else ${end.code} end`,
      ...(note ? { summary: sql`case when ${reported} then ${routineRuns.summary} else ${note} end` } : {}),
    };
  }
  const [row] = await deps.db
    .update(routineRuns)
    .set({ ...set, brain: sql`coalesce(${brain}::text, ${routineRuns.brain})`, finishedAt: new Date() })
    .where(
      and(
        eq(routineRuns.id, ref.routineRunId),
        eq(routineRuns.orgId, ref.orgId),
        inArray(routineRuns.status, OPEN),
        // A reported run that already ended keeps its ending.
        isNull(routineRuns.finishedAt),
      ),
    )
    .returning({ status: routineRuns.status, code: routineRuns.code, event: routineRuns.event });
  if (!row) return null;
  await afterRoutineRunEnded(deps, { ...ref, status: row.status, code: row.code, event: row.event });
  return row;
}

/**
 * Ends a routine run that has no agent run (it never started one: stopped while queued, lost, …)
 * through the same ledger. Null when it already ended.
 */
export async function endRoutineRun(
  deps: LedgerDeps,
  ref: RoutineRunRef,
  end: Exclude<RoutineRunEnd, { status: "done" }>,
) {
  return finishRoutineRow(deps, ref, end, null);
}

/**
 * What follows a routine run's end (ADR 0053 §6): a good run (reported or silent) resets the failure
 * streak and resolves its failure and outage notifications; a failure counts in `failures_in_row`
 * (the first after a good run notifies once, with its coded reason for the app to say; the fifth in a
 * row pauses the routine: `failing`); the emails of an email run that didn't finish are released to
 * the next run (§6.8); and the event run gathered while it worked starts (§6.3). A widget's routine (ADR 0135 §5)
 * tells its widget first (`widgetRoutineEnded`): an end without data counts as a failure, and its widget's own
 * `widget_failed` replaces the routine's notification. Never throws into the ending.
 */
export async function afterRoutineRunEnded(
  deps: LedgerDeps,
  ended: RoutineRunRef & { status: string; code: string | null; event: Record<string, unknown> | null },
) {
  const { db } = deps;
  try {
    const widget = await widgetRoutineEnded(deps, {
      ...ended,
      agentRunId: null,
      status: ended.status as RoutineRunEndStatus,
    });
    const status: string = widget ?? ended.status;
    if (status === "reported" || status === "silent") {
      await db.update(routines).set({ failuresInRow: 0 }).where(eq(routines.id, ended.routineId));
      await resolveRoutineTrouble(deps, ended.orgId, ended.routineId).catch(() => {});
    } else if (status === "failed") {
      const [r] = await db
        .update(routines)
        .set({ failuresInRow: sql`${routines.failuresInRow} + 1` })
        .where(and(eq(routines.id, ended.routineId), isNull(routines.deletedAt)))
        .returning({
          id: routines.id,
          orgId: routines.orgId,
          active: routines.active,
          failures: routines.failuresInRow,
        });
      if (r?.failures === 1 && !widget) {
        await notifyRoutineFailed(deps, {
          orgId: ended.orgId,
          routineId: ended.routineId,
          streakKey: ended.routineRunId,
          reason: ended.code,
        }).catch(() => {});
      }
      if (r?.active && r.failures >= ROUTINE_FATIGUE_LIMIT) await pauseRoutine(deps, r, "failing");
    }
    if (
      ["failed", "canceled", "superseded", "missed"].includes(ended.status) &&
      ended.event?.type === "email.received"
    ) {
      await releaseRoutineEmails(deps, ended.routineRunId);
    }
  } finally {
    await startGatheredRun(deps, ended.routineId).catch(() => false);
    await publishRoutineRuns(deps.pubsub, ended.orgId, ended.routineId);
  }
}

/**
 * The agent told people what a routine found (§7): its message (`meta.routine`, posted by the run
 * the report woke) is the routine run's `message_id`, and the routine's creator hears it, opening it
 * (unless they are in that conversation). Once per routine run.
 */
export async function recordRoutineReportMessage(
  deps: LedgerDeps,
  input: {
    orgId: string;
    routineRunId: string;
    messageId: string;
    channelId: string;
    threadId: string | null;
    text?: string;
  },
) {
  const [row] = await deps.db
    .update(routineRuns)
    .set({ messageId: input.messageId })
    .where(
      and(eq(routineRuns.id, input.routineRunId), eq(routineRuns.orgId, input.orgId), isNull(routineRuns.messageId)),
    )
    .returning({ routineId: routineRuns.routineId });
  if (!row) return false;
  await notifyRoutineFinished(deps, {
    orgId: input.orgId,
    routineId: row.routineId,
    routineRunId: input.routineRunId,
    messageId: input.messageId,
    channelId: input.channelId,
    threadId: input.threadId,
    text: input.text,
  }).catch(() => {});
  return true;
}

/** An ended agent run's ending, as the ledger reads it. */
function endOfAgentRun(status: string, error: string | null): RoutineRunEnd {
  if (status === "done") return { status: "done", text: "" };
  if (status === "failed") return { status: "failed", code: routineFailureCode(error), detail: error ?? undefined };
  const by = error?.startsWith("canceled_by:") ? error.slice("canceled_by:".length) : null;
  return { status: "canceled", code: "stopped", byUserId: by };
}

/** The reaper leaves an ending this long to its own path before closing it. */
const REAPER_GRACE_MS = 2 * 60_000;

/**
 * Safety net for the ledger (§5), on the sweeper's tick: open routine runs whose agent run already
 * ended are closed from it; runs queued or being started whose `routine.run` job is gone (it failed
 * for good) fail as `lost`; a run gathered while another worked starts when nothing works anymore.
 * Returns how many rows it closed.
 */
export async function reapRoutineRuns(deps: LedgerDeps, now = new Date()): Promise<number> {
  const { db } = deps;
  const before = new Date(now.getTime() - REAPER_GRACE_MS);
  let closed = 0;
  const ended = await db
    .select({
      routineRunId: routineRuns.id,
      orgId: routineRuns.orgId,
      routineId: routineRuns.routineId,
      status: agentRuns.status,
      error: agentRuns.error,
      brain: agentRuns.brain,
    })
    .from(routineRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, routineRuns.agentRunId))
    .where(
      and(
        inArray(routineRuns.status, ["starting", "started", "reported"]),
        isNull(routineRuns.finishedAt),
        inArray(agentRuns.status, ["done", "failed", "canceled"]),
        lt(agentRuns.updatedAt, before),
      ),
    )
    .limit(200);
  for (const r of ended) {
    if (await finishRoutineRow(deps, r, endOfAgentRun(r.status, r.error), r.brain)) closed++;
  }
  const lost = await db
    .select({ routineRunId: routineRuns.id, orgId: routineRuns.orgId, routineId: routineRuns.routineId })
    .from(routineRuns)
    .where(
      and(
        inArray(routineRuns.status, ["queued", "starting"]),
        isNull(routineRuns.agentRunId),
        lt(routineRuns.createdAt, before),
        // Waiting to start (gathered while another worked, or held emails): no job yet, on purpose.
        sql`coalesce(${routineRuns.event}->>'gathered', '') <> 'true'`,
        sql`coalesce(${routineRuns.event}->>'held', '') <> 'true'`,
        sql`not ${routineJobAlive(routineRuns.id)}`,
      ),
    )
    .limit(200);
  for (const r of lost) {
    if (await finishRoutineRow(deps, r, { status: "failed", code: "lost" }, null)) closed++;
  }
  const gathered = await db
    .selectDistinct({ routineId: routineRuns.routineId })
    .from(routineRuns)
    .where(and(eq(routineRuns.status, "queued"), sql`${routineRuns.event}->>'gathered' = 'true'`))
    .limit(100);
  for (const g of gathered) await startGatheredRun(deps, g.routineId).catch(() => false);
  return closed;
}
