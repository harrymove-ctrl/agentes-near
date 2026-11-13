import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, isNull, notInArray, schema, sql } from "@agenteschat/db";
import { WIDGET_HISTORY_KEPT } from "@agenteschat/ui/widgets/spec";
import { notifyWidgetFailed, resolveWidgetNotices } from "../notification-producers";
import { getMembership } from "../organizations";
import type { RoutineRunEndStatus } from "../routine-ledger";
import { ROUTINE_FATIGUE_LIMIT } from "../routine-state";
import { dashboardRights, viewerOf } from "./access";
import { publishWidgetChanged, widgetEvent } from "./events";
import { type DashboardRow, WIDGET_FAILURES, type WidgetRow, type WidgetStatus } from "./types";

const { dashboards, dashboardWidgets, dashboardWidgetUpdates, routines, routineRuns, usageRecords, agents } = schema;

/*
 * A widget's side of the routine ledger (ADR 0135 §5, §6): what a widget routine's ending, pause or deletion does to
 * its widget. Kept apart from `refresh.ts` (which reads `routines.ts`) so the ledger and the firing code can call it
 * without an import cycle.
 */

type LedgerDeps = { db: Database; pubsub?: PubSub };

/**
 * Codes a widget keeps as they are (`widgets.failure.*` in the apps); any other run code is folded into one of these
 * by `widgetFailureCode`.
 */
const WIDGET_CODES = new Set<string>([
  WIDGET_FAILURES.agentReported,
  WIDGET_FAILURES.noUpdate,
  WIDGET_FAILURES.error,
  "budget_exceeded",
  "waiting_computer",
  "waiting_plan",
  "waiting_budget",
  "creator_left",
  "creator_no_access",
  "agent_archived",
  "audience",
  "failing",
  "stopped",
  "missing_credential",
  "timeout",
  "invalid_data",
]);

/** Run codes said in a widget's words: no AI or key to think with, too slow, came back too late. */
const FOLDED: Readonly<Record<string, string>> = {
  no_ai: "missing_credential",
  credential_revoked: "missing_credential",
  credential_wrong_provider: "missing_credential",
  computer_timeout: "timeout",
  stale: "waiting_computer",
  waiting_plan_late: "waiting_plan",
  waiting_budget_late: "waiting_budget",
};

/** A routine run's coded reason as a widget's failure (`dashboard_widgets.failure_code`); unknown ones are `error`. */
export function widgetFailureCode(code: string | null | undefined): string {
  if (!code) return WIDGET_FAILURES.error;
  if (WIDGET_CODES.has(code)) return code;
  return FOLDED[code] ?? WIDGET_FAILURES.error;
}

/** A widget routine's target, read from its row. */
export function widgetTargetOf(target: unknown): { widgetId: string; dashboardId: string } | null {
  const t = target as { type?: unknown; widgetId?: unknown; dashboardId?: unknown } | null;
  if (t?.type !== "widget" || typeof t.widgetId !== "string" || typeof t.dashboardId !== "string") return null;
  return { widgetId: t.widgetId, dashboardId: t.dashboardId };
}

/** The widget behind a routine (its target), with its board; `routine` null when the routine isn't a widget's. */
export async function widgetOfRoutine(db: Executor, orgId: string, routineId: string) {
  const [routine] = await db
    .select({
      id: routines.id,
      target: routines.target,
      active: routines.active,
      failuresInRow: routines.failuresInRow,
      createdByUserId: routines.createdByUserId,
      agentId: routines.agentId,
      deletedAt: routines.deletedAt,
    })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)));
  const target = widgetTargetOf(routine?.target);
  if (!routine || !target) return { routine: null, widget: null, board: null };
  const [row] = await db
    .select({ widget: dashboardWidgets, board: dashboards })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.id, target.widgetId)));
  return { routine, widget: row?.widget ?? null, board: row?.board ?? null };
}

/** Keeps a widget's latest `WIDGET_HISTORY_KEPT` updates. */
export async function trimWidgetHistory(db: Executor, orgId: string, widgetId: string) {
  const kept = db
    .select({ id: dashboardWidgetUpdates.id })
    .from(dashboardWidgetUpdates)
    .where(and(eq(dashboardWidgetUpdates.orgId, orgId), eq(dashboardWidgetUpdates.widgetId, widgetId)))
    .orderBy(desc(dashboardWidgetUpdates.createdAt), desc(dashboardWidgetUpdates.id))
    .limit(WIDGET_HISTORY_KEPT);
  await db
    .delete(dashboardWidgetUpdates)
    .where(
      and(
        eq(dashboardWidgetUpdates.orgId, orgId),
        eq(dashboardWidgetUpdates.widgetId, widgetId),
        notInArray(dashboardWidgetUpdates.id, kept),
      ),
    );
}

/** What a routine run carried for its widget: the person's change request, if it was one. */
export async function changeOfRun(db: Executor, orgId: string, routineRunId: string | null) {
  if (!routineRunId) return null;
  const [rr] = await db
    .select({ event: routineRuns.event })
    .from(routineRuns)
    .where(and(eq(routineRuns.id, routineRunId), eq(routineRuns.orgId, orgId)));
  return widgetChangeOf(rr?.event ?? null);
}

/** A routine run's event as a person's change request (`{ type: "widget.change", text, byUserId }`), or null. */
export function widgetChangeOf(
  event: Record<string, unknown> | null,
): { text: string; byUserId: string | null } | null {
  if (event?.type !== "widget.change" || typeof event.text !== "string" || !event.text.trim()) return null;
  return { text: event.text, byUserId: typeof event.byUserId === "string" ? event.byUserId : null };
}

/**
 * Who hears that a widget stopped updating: its creator, else who looks after its routine, else the board's owner,
 * else the agent's owner; the first of them still in the workspace who sees the board (a private board's widget is
 * never named to anyone else).
 */
async function failureRecipient(db: Executor, widget: WidgetRow, board: DashboardRow): Promise<string | null> {
  const [r] = widget.routineId
    ? await db.select({ creator: routines.createdByUserId }).from(routines).where(eq(routines.id, widget.routineId))
    : [];
  const [a] = await db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, widget.agentId));
  const named = [widget.createdByUserId, r?.creator, board.ownerUserId, a?.owner].filter((u): u is string => !!u);
  for (const userId of new Set(named)) {
    const membership = await getMembership(db, userId, widget.orgId);
    if (membership && dashboardRights(board, viewerOf(membership, userId)).see) return userId;
  }
  return null;
}

/**
 * Fails a widget (ADR 0135 §6): `failed` with its reason, a failed row in its history, and, on the first failure of a
 * streak (it had no failure since its last good update), one `widget_failed` to its creator. `fatigued`: this failure
 * pauses its routine (the fifth in a row), so the widget says it stopped (`failing`) and its history keeps why.
 */
export async function failWidget(
  deps: LedgerDeps,
  widget: WidgetRow,
  board: DashboardRow,
  failure: {
    code: string;
    detail?: string | null;
    routineRunId?: string | null;
    agentRunId?: string | null;
    change?: string | null;
    fatigued?: boolean;
  },
) {
  const { db } = deps;
  const code = widgetFailureCode(failure.code);
  const shown = failure.fatigued ? "failing" : code;
  const detail = failure.detail?.trim() ? failure.detail.trim().slice(0, 500) : null;
  const firstOfStreak = !widget.failureCode;
  const [row] = await db
    .update(dashboardWidgets)
    .set({ status: "failed", failureCode: shown, failureDetail: detail, updatedAt: new Date() })
    .where(and(eq(dashboardWidgets.id, widget.id), eq(dashboardWidgets.orgId, widget.orgId)))
    .returning();
  if (!row) return null;
  await db.insert(dashboardWidgetUpdates).values({
    orgId: widget.orgId,
    widgetId: widget.id,
    routineRunId: failure.routineRunId ?? null,
    agentRunId: failure.agentRunId ?? null,
    status: "failed",
    summary: detail ?? "",
    failureCode: code,
    change: failure.change ?? null,
  });
  await trimWidgetHistory(db, widget.orgId, widget.id);
  // A draft's failure shows in the test's preview only: nobody is told (ADR 0135 §16).
  if (firstOfStreak && !widget.draft) {
    await notifyWidgetFailed(deps, {
      orgId: widget.orgId,
      userId: await failureRecipient(db, widget, board),
      widgetId: widget.id,
      dashboardId: board.id,
      agentId: widget.agentId,
      title: widget.title,
      streakKey: failure.routineRunId ?? String(Date.now()),
      reason: shown,
      text: code === WIDGET_FAILURES.agentReported ? detail : null,
    }).catch(() => {});
  }
  await publishWidgetChanged(deps.pubsub, board, widgetEvent(widget, "failed")).catch(() => {});
  return row;
}

/**
 * A refresh that ended without changing the widget (stopped, replaced): it shows what it showed before (its data,
 * or its failure); a first build that never got data fails as `stopped`.
 */
async function settleWidget(deps: LedgerDeps, widget: WidgetRow, board: DashboardRow, code: string) {
  if (widget.status !== "updating" && widget.status !== "building") return;
  if (!widget.spec && !widget.failureCode) {
    await failWidget(deps, widget, board, { code });
    return;
  }
  const status = widget.failureCode ? "failed" : "ok";
  await deps.db
    .update(dashboardWidgets)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(dashboardWidgets.id, widget.id), eq(dashboardWidgets.orgId, widget.orgId)));
  await publishWidgetChanged(deps.pubsub, board, widgetEvent(widget, status)).catch(() => {});
}

/** What the run cost and how many tokens it used, written on the update it made (known only once it ended). */
async function recordUpdateCost(db: Executor, orgId: string, routineRunId: string, agentRunId: string | null) {
  if (!agentRunId) return;
  const [used] = await db
    .select({
      cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)`,
      tokens: sql<string>`coalesce(sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens}), 0)`,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.orgId, orgId), eq(usageRecords.runId, agentRunId)));
  await db
    .update(dashboardWidgetUpdates)
    .set({ costNanoUsd: Number(used?.cost ?? 0), tokens: Number(used?.tokens ?? 0), agentRunId })
    .where(and(eq(dashboardWidgetUpdates.orgId, orgId), eq(dashboardWidgetUpdates.routineRunId, routineRunId)));
}

/** Ends that say something is in the way of the widget's agent (not the routine failing): shown, never counted. */
const WAITING_ENDS = new Set([
  "waiting_computer",
  "waiting_plan",
  "waiting_budget",
  "stale",
  "waiting_plan_late",
  "waiting_budget_late",
]);

/**
 * Called from the routine ledger when a widget routine's run ends (`afterRoutineRunEnded`), in place of the routine's
 * own notifications: an end without an update fails the widget (`no_update`, `invalid_data` when its data never
 * passed the check, or the run's code: `budget_exceeded`, `waiting_computer`, `creator_left`…) with one
 * `widget_failed` per failure streak and a failed history row; a stop or a replaced run leaves it as it was. A
 * `reported` end already applied its update; its cost is written on it now. Returns how the ledger counts the end
 * (`failed` for an end without data, which the routine's failure streak counts), or null when the routine isn't a
 * widget's. Never throws.
 */
export async function widgetRoutineEnded(
  deps: LedgerDeps,
  end: {
    orgId: string;
    routineId: string;
    routineRunId: string;
    agentRunId: string | null;
    status: RoutineRunEndStatus;
    code: string | null;
  },
): Promise<RoutineRunEndStatus | null> {
  try {
    const { db } = deps;
    const { routine, widget, board } = await widgetOfRoutine(db, end.orgId, end.routineId);
    if (!routine) return null;
    // Deleted with its widget or board, or in Routines (`widgetRoutineGone` settles the widget): nothing to say.
    if (!widget || !board || board.deletedAt || routine.deletedAt) return end.status;
    const [rr] = await db
      .select({ agentRunId: routineRuns.agentRunId, code: routineRuns.code, event: routineRuns.event })
      .from(routineRuns)
      .where(and(eq(routineRuns.id, end.routineRunId), eq(routineRuns.orgId, end.orgId)));
    const agentRunId = end.agentRunId ?? rr?.agentRunId ?? null;
    await recordUpdateCost(db, end.orgId, end.routineRunId, agentRunId);
    const [applied] = await db
      .select({ status: dashboardWidgetUpdates.status })
      .from(dashboardWidgetUpdates)
      .where(
        and(eq(dashboardWidgetUpdates.orgId, end.orgId), eq(dashboardWidgetUpdates.routineRunId, end.routineRunId)),
      )
      .limit(1);
    if (applied && widget.draft) {
      // The test's cost is known only now: its creator's preview reads it again ("This test cost …", ADR 0135 §16).
      const [current] = await db
        .select({ status: dashboardWidgets.status })
        .from(dashboardWidgets)
        .where(eq(dashboardWidgets.id, widget.id));
      const status = (current?.status ?? widget.status) as WidgetStatus;
      await publishWidgetChanged(deps.pubsub, board, widgetEvent(widget, status)).catch(() => {});
    }
    const change = widgetChangeOf(rr?.event ?? null)?.text ?? null;
    // This failure is the one that pauses the routine (the ledger counts it next).
    const fatigued = routine.active && routine.failuresInRow + 1 >= ROUTINE_FATIGUE_LIMIT;
    const failedRun = async (code: string) => {
      // The ledger's row says it failed, with why (it ended `silent`: the agent said nothing to people).
      await db
        .update(routineRuns)
        .set({ status: "failed", code })
        .where(and(eq(routineRuns.id, end.routineRunId), eq(routineRuns.status, "silent")));
    };
    switch (end.status) {
      case "reported":
        return applied?.status === "failed" ? "failed" : "reported";
      case "silent": {
        if (applied?.status === "ok") return "reported";
        if (applied?.status === "failed") {
          // The agent said why it couldn't (`update_widget` with `failed`): the widget already says so.
          if (fatigued) {
            await db
              .update(dashboardWidgets)
              .set({ failureCode: "failing", updatedAt: new Date() })
              .where(eq(dashboardWidgets.id, widget.id));
          }
          await failedRun(WIDGET_FAILURES.agentReported);
          return "failed";
        }
        const code = rr?.code === "invalid_data" ? "invalid_data" : WIDGET_FAILURES.noUpdate;
        await failWidget(deps, widget, board, {
          code,
          routineRunId: end.routineRunId,
          agentRunId,
          change,
          fatigued,
        });
        await failedRun(code);
        return "failed";
      }
      case "failed":
        // The agent already said why (`update_widget` with `failed`): the widget says it once.
        if (applied) return "failed";
        await failWidget(deps, widget, board, {
          code: end.code ?? WIDGET_FAILURES.error,
          routineRunId: end.routineRunId,
          agentRunId,
          change,
          fatigued,
        });
        return "failed";
      default: {
        // Waiting on the agent's computer, plan or budget: the widget says what holds it.
        if (applied) return end.status;
        if (end.code && WAITING_ENDS.has(end.code)) {
          await failWidget(deps, widget, board, { code: end.code, routineRunId: end.routineRunId, agentRunId });
          return end.status;
        }
        await settleWidget(deps, widget, board, end.code === "deleted" ? "stopped" : (end.code ?? "stopped"));
        return end.status;
      }
    }
  } catch {
    return null;
  }
}

/**
 * A widget's routine paused itself as it fired (ADR 0053 §6.2: its creator left, can no longer see the board or
 * talk to the agent, the agent was archived): the widget fails with that reason until an editor presses Resolve.
 */
export async function widgetRoutineHeld(
  deps: LedgerDeps,
  routine: { id: string; orgId: string },
  reason: string,
): Promise<void> {
  const { widget, board } = await widgetOfRoutine(deps.db, routine.orgId, routine.id);
  if (!widget || !board || board.deletedAt) return;
  if (widget.failureCode === reason && widget.status === "failed") return;
  await failWidget(deps, widget, board, { code: reason });
}

/**
 * A person deleted a widget's routine in Routines: the widget stays, updating only when asked (`manual`, no routine
 * until one is needed again). A refresh it stopped leaves the widget as it was; a first build that never got data
 * says it stopped.
 */
export async function widgetRoutineGone(deps: LedgerDeps, orgId: string, routineId: string): Promise<void> {
  const busy = sql`${dashboardWidgets.status} in ('updating', 'building')`;
  const [row] = await deps.db
    .update(dashboardWidgets)
    .set({
      routineId: null,
      schedule: "manual",
      status: sql`case when not ${busy} then ${dashboardWidgets.status}
        when ${dashboardWidgets.spec} is not null and ${dashboardWidgets.failureCode} is null then 'ok'
        else 'failed' end`,
      failureCode: sql`case when ${busy} and ${dashboardWidgets.spec} is null
        then coalesce(${dashboardWidgets.failureCode}, 'stopped') else ${dashboardWidgets.failureCode} end`,
      updatedAt: new Date(),
    })
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.routineId, routineId)))
    .returning();
  if (!row) return;
  const [board] = await deps.db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.id, row.dashboardId), isNull(dashboards.deletedAt)));
  if (board) {
    await publishWidgetChanged(deps.pubsub, board, widgetEvent(row, row.status as WidgetStatus)).catch(() => {});
  }
}

/** A widget is gone (removed, or its board deleted): its open alert and failure notices are done. */
export async function widgetNoticesDone(deps: LedgerDeps, orgId: string, widgetId: string) {
  await resolveWidgetNotices(deps, orgId, widgetId).catch(() => {});
}
