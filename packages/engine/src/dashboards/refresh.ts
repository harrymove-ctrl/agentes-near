import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import {
  isWidgetSchedule,
  validateWidgetSpec,
  WIDGET_SCHEDULE_CRON,
  type WidgetSchedule,
} from "@agenteschat/ui/widgets/spec";
import { getAgent } from "../agents";
import { canTalkTo, speakerOf } from "../audience";
import { nextCronTime } from "../cron";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { publishRoutineRuns } from "../events";
import { notifyWidgetAlert, resolveRoutinePaused, resolveWidgetFailed } from "../notification-producers";
import { can, getMembership } from "../organizations";
import { type EventMerge, queueEventRun, routineInFlight } from "../routine-events";
import { haltRoutineRuns } from "../routine-firing";
import { queueRoutineRun } from "../routines";
import { dashboardRights, requireWidget, viewerOf } from "./access";
import { publishWidgetChanged, widgetEvent } from "./events";
import { WIDGET_CHANGE_EVENT } from "./refresh-fire";
import { failWidget, trimWidgetHistory, widgetChangeOf, widgetNoticesDone } from "./refresh-ledger";
import { widgetView } from "./service";
import {
  DASHBOARD_ERRORS,
  type DashboardDeps,
  type DashboardRow,
  WIDGET_AGENT_TITLE_MAX,
  WIDGET_CHANGE_MAX,
  WIDGET_FAILURES,
  WIDGET_PROMPT_MAX,
  type WidgetRow,
  type WidgetStatus,
  type WidgetUpdateInput,
  type WidgetView,
} from "./types";

export { widgetRoutineEnded } from "./refresh-ledger";

const {
  dashboards,
  dashboardWidgets,
  dashboardWidgetUpdates,
  routines,
  routineRuns,
  agents,
  organizationMembers,
  organizationSettings,
} = schema;

/**
 * How a widget is redone (ADR 0135 §4–§6): a routine of its own (`routines.target` `{ type: "widget", widgetId,
 * dashboardId }`) whose background run reads, then hands its data to `update_widget`, posting nothing in chat.
 */

/** The tool a widget's refresh run reports through (the only way it speaks). */
export const UPDATE_WIDGET_TOOL = "update_widget";

/** A widget routine's target. */
export interface WidgetRoutineTarget {
  type: "widget";
  widgetId: string;
  dashboardId: string;
}

export { WIDGET_CHANGE_EVENT };

/** Most sources a widget names (what its agent read), and how long each. */
const SOURCES_MAX = 12;
const SOURCE_MAX = 80;
/** A history line and an alert, at most. */
const SUMMARY_MAX = 280;
const ALERT_MAX = 280;

/** English words of each schedule, for the routine's description (the apps say it in the person's words). */
const SCHEDULE_WORDS: Record<WidgetSchedule, string> = {
  half: "Every 30 minutes",
  hour: "Every hour",
  day: "Every day at 08:00",
  week: "Every Monday at 08:00",
  manual: "Only when asked",
};

const nowOf = (deps: DashboardDeps) => deps.now?.() ?? new Date();

/** A routine run that is still open (it may still update its widget). */
const OPEN_RUN = ["queued", "starting", "started"];

const widgetNotFound = () => new NotFoundError("Widget not found", DASHBOARD_ERRORS.widgetNotFound);

/** A widget and its board (not deleted), with no person's check. */
async function loadWidget(db: Database, orgId: string, widgetId: string) {
  const [row] = await db
    .select({ widget: dashboardWidgets, board: dashboards })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.id, widgetId), isNull(dashboards.deletedAt)));
  if (!row) throw widgetNotFound();
  return row;
}

async function widgetRow(db: Database, widgetId: string): Promise<WidgetRow> {
  const [row] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId));
  if (!row) throw widgetNotFound();
  return row;
}

/** The zone a widget's schedule is read in (ADR 0135 §7): its routine creator's, else the workspace's, else UTC. */
async function zoneOf(db: Database, orgId: string, userId: string | null): Promise<string> {
  const [member] = userId
    ? await db
        .select({ timezone: organizationMembers.timezone })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
    : [];
  if (member?.timezone) return member.timezone;
  const [settings] = await db
    .select({ timezone: organizationSettings.timezone })
    .from(organizationSettings)
    .where(eq(organizationSettings.orgId, orgId));
  return settings?.timezone || "UTC";
}

/**
 * Who a widget's routine runs for when nobody says (ADR 0053 §1): its creator, the board's owner, the agent's owner.
 */
async function defaultCreator(db: Database, widget: WidgetRow, board: DashboardRow): Promise<string | null> {
  const person = widget.createdByUserId ?? board.ownerUserId ?? widget.alertUserId;
  if (person) return person;
  const [a] = await db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, widget.agentId));
  return a?.owner ?? null;
}

/**
 * Makes the widget's routine match its row (at most one per widget: name = its title, prompt = its instructions,
 * created by `options.creatorUserId` ?? the widget's creator, access `act`, report `when_new`, trigger `schedule`). A
 * schedule other than `manual` sets `cron` = `WIDGET_SCHEDULE_CRON[schedule]` in its creator's time zone and its next
 * run (every schedule is 30 minutes apart at the least: the floor, ADR 0135 §7; anything else stored reads as
 * `manual`). A `manual` widget keeps an existing routine with no next run (`cron` and `rule` null), and gets none
 * until a run is asked (`options.ensure`, as `refreshWidgetNow` does). Returns the routine's id (written to
 * `dashboard_widgets.routine_id`), or null when it has none. Widget routines don't count in `MAX_ACTIVE_ROUTINES`
 * (the workspace's `WIDGET_SCHEDULED_MAX` holds them).
 */
export async function syncWidgetRoutine(
  deps: DashboardDeps,
  orgId: string,
  widgetId: string,
  options?: { creatorUserId?: string; ensure?: boolean },
): Promise<string | null> {
  const { db } = deps;
  const { widget, board } = await loadWidget(db, orgId, widgetId);
  // A draft's routine runs only its test build: never on a schedule (ADR 0135 §16).
  const schedule: WidgetSchedule = !widget.draft && isWidgetSchedule(widget.schedule) ? widget.schedule : "manual";
  const [existing] = widget.routineId
    ? await db
        .select()
        .from(routines)
        .where(and(eq(routines.id, widget.routineId), eq(routines.orgId, orgId), isNull(routines.deletedAt)))
    : [];
  if (!existing && schedule === "manual" && !options?.ensure) {
    if (widget.routineId) {
      await db.update(dashboardWidgets).set({ routineId: null }).where(eq(dashboardWidgets.id, widget.id));
    }
    return null;
  }
  // An existing routine keeps its creator, even one who left (it pauses until an editor presses Resolve, ADR 0135 §6).
  const creator =
    options?.creatorUserId ?? (existing ? existing.createdByUserId : await defaultCreator(db, widget, board));
  const zone =
    existing?.timezone && existing.createdByUserId === creator ? existing.timezone : await zoneOf(db, orgId, creator);
  const cron = schedule === "manual" ? null : WIDGET_SCHEDULE_CRON[schedule];
  const now = nowOf(deps);
  const target: WidgetRoutineTarget = { type: "widget", widgetId: widget.id, dashboardId: widget.dashboardId };
  const fields = {
    agentId: widget.agentId,
    name: (widget.title.trim() || "Widget").slice(0, 120),
    prompt: widget.prompt.trim() || `Keep the widget «${widget.title}» up to date.`,
    target: target as unknown as Record<string, unknown>,
    triggerType: "schedule",
    phrase: null,
    cron,
    rule: null,
    timezone: zone,
    description: SCHEDULE_WORDS[schedule],
    event: null,
    access: "act",
    report: "when_new",
    ownActions: [] as string[],
    createdByUserId: creator,
  };
  let routineId: string;
  if (existing) {
    const moved = existing.cron !== cron || existing.timezone !== zone;
    const nextRunAt =
      !cron || !existing.active
        ? null
        : moved || !existing.nextRunAt
          ? nextCronTime(cron, zone, now)
          : existing.nextRunAt;
    await db
      .update(routines)
      .set({ ...fields, nextRunAt, updatedAt: now })
      .where(eq(routines.id, existing.id));
    routineId = existing.id;
  } else {
    const [made] = await db
      .insert(routines)
      .values({ orgId, ...fields, active: true, nextRunAt: cron ? nextCronTime(cron, zone, now) : null })
      .returning({ id: routines.id });
    if (!made) throw new Error("widget routine insert returned nothing");
    routineId = made.id;
  }
  if (widget.routineId !== routineId) {
    await db.update(dashboardWidgets).set({ routineId }).where(eq(dashboardWidgets.id, widget.id));
  }
  await publishRoutineRuns(deps.pubsub, orgId, routineId).catch(() => {});
  return routineId;
}

/** Deletes the widget's routine (the widget is removed, or its board deleted); stops a run in progress quietly. */
export async function dropWidgetRoutine(deps: DashboardDeps, orgId: string, widgetId: string): Promise<void> {
  const { db } = deps;
  const now = nowOf(deps);
  // Deleted first: the ledger then leaves the widget alone as its runs stop (`widgetRoutineEnded`).
  const gone = await db
    .update(routines)
    .set({ active: false, nextRunAt: null, deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(routines.orgId, orgId),
        isNull(routines.deletedAt),
        sql`${routines.target}->>'type' = 'widget'`,
        sql`${routines.target}->>'widgetId' = ${widgetId}`,
      ),
    )
    .returning({ id: routines.id });
  for (const r of gone) await haltRoutineRuns(deps, orgId, r.id, { code: "deleted" });
  await db
    .update(dashboardWidgets)
    .set({ routineId: null })
    .where(and(eq(dashboardWidgets.orgId, orgId), eq(dashboardWidgets.id, widgetId)));
  await widgetNoticesDone(deps, orgId, widgetId);
}

/** Whether the routine's creator can still run it: a member who may post, talks to the agent and sees the board. */
async function creatorFits(
  db: Database,
  orgId: string,
  creatorId: string | null,
  agent: Parameters<typeof canTalkTo>[0],
  board: DashboardRow,
) {
  if (!creatorId) return false;
  const membership = await getMembership(db, creatorId, orgId);
  if (!membership || !can(membership, "post")) return false;
  if (!canTalkTo(agent, creatorId, speakerOf(membership))) return false;
  return dashboardRights(board, viewerOf(membership, creatorId)).see;
}

/**
 * The widget's routine, made when missing, ready for a run a person asks for (ADR 0135 §6, "Resolve"): one whose
 * creator left or can no longer talk to the agent or see the board is taken over by `actorId`, and one that paused
 * itself (`paused_reason`: failures, its creator gone) is resumed. One a person paused on purpose (in Routines:
 * inactive with no reason) stays paused: this run goes ahead once, the schedule waits for Resume in Routines. With
 * no `actorId` (a first build the server queues) nothing changes hands.
 */
async function readyRoutine(
  deps: DashboardDeps,
  orgId: string,
  widget: WidgetRow,
  board: DashboardRow,
  actorId: string | null,
) {
  const { db } = deps;
  const routineId = await syncWidgetRoutine(deps, orgId, widget.id, { ensure: true });
  const load = async () => {
    const [row] = await db
      .select()
      .from(routines)
      .where(eq(routines.id, routineId ?? ""));
    if (!row) throw widgetNotFound();
    return row;
  };
  const routine = await load();
  if (!actorId) return routine;
  const agent = await getAgent(db, orgId, widget.agentId);
  if (!agent || agent.archivedAt) {
    throw new ValidationError(`${agent?.name ?? "The agent"} is archived`, DASHBOARD_ERRORS.agentArchived, {
      agentName: agent?.name ?? "",
    });
  }
  const set: Partial<typeof routines.$inferInsert> = {};
  if (!(await creatorFits(db, orgId, routine.createdByUserId, agent, board))) {
    const membership = await getMembership(db, actorId, orgId);
    if (!membership || !canTalkTo(agent, actorId, speakerOf(membership))) {
      throw new ForbiddenError(`You can't talk to ${agent.name}`, DASHBOARD_ERRORS.agentUnreachable, {
        agentName: agent.name,
      });
    }
    set.createdByUserId = actorId;
  }
  if (routine.pausedReason) {
    set.active = true;
    set.pausedReason = null;
    set.failuresInRow = 0;
    set.nextRunAt = routine.cron ? nextCronTime(routine.cron, routine.timezone ?? "UTC", nowOf(deps)) : null;
  }
  if (Object.keys(set).length === 0) return routine;
  await db
    .update(routines)
    .set({ ...set, updatedAt: nowOf(deps) })
    .where(eq(routines.id, routine.id));
  await resolveRoutinePaused(deps, orgId, routine.id).catch(() => {});
  return load();
}

/** The widget shows a refresh is under way: `updating` (its last data stays), or `building` while it has none. */
async function markBusy(deps: DashboardDeps, widget: WidgetRow, board: DashboardRow): Promise<WidgetRow> {
  const status: WidgetStatus = widget.spec ? "updating" : "building";
  const [row] = await deps.db
    .update(dashboardWidgets)
    .set({ status, updatedAt: nowOf(deps) })
    .where(eq(dashboardWidgets.id, widget.id))
    .returning();
  await publishWidgetChanged(deps.pubsub, board, widgetEvent(widget, status)).catch(() => {});
  return row ?? widget;
}

/**
 * "Update now" and "Resolve": queues a manual run of the widget's routine (made first when missing; one whose creator
 * left or can no longer talk to the agent is taken over by `actorId`, a routine that paused itself is resumed, and one
 * a person paused on purpose runs once and stays paused).
 * The widget turns `updating` (`building` while it has no data) and its event goes out. A run already queued or
 * working answers with the widget as it is. `actorId` null: a first build queued by the server (no checks).
 */
export async function refreshWidgetNow(
  deps: DashboardDeps,
  actorId: string | null,
  orgId: string,
  widgetId: string,
): Promise<WidgetView> {
  const { widget, board } = actorId
    ? await requireWidget(deps.db, actorId, orgId, widgetId, "edit")
    : await loadWidget(deps.db, orgId, widgetId);
  const routine = await readyRoutine(deps, orgId, widget, board, actorId);
  if (await routineInFlight(deps.db, routine.id)) return widgetView(deps.db, await widgetRow(deps.db, widget.id));
  await queueRoutineRun({ db: deps.db }, routine, nowOf(deps), "manual");
  const row = await markBusy(deps, await widgetRow(deps.db, widget.id), board);
  await publishRoutineRuns(deps.pubsub, orgId, routine.id).catch(() => {});
  return widgetView(deps.db, row);
}

/** Change requests asked while one waits join it, in the order they came (the newest asker keeps it). */
const mergeChanges: EventMerge = (current, incoming) => {
  const text = [current.text, incoming.text]
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .join("\n")
    .slice(-WIDGET_CHANGE_MAX * 2);
  return { type: WIDGET_CHANGE_EVENT, text, summary: text, byUserId: incoming.byUserId ?? current.byUserId ?? null };
};

/**
 * "Ask for a change": queues a manual run carrying the person's words (`routine_runs.event` `{ type:
 * "widget.change", text, byUserId }`); that run may change the widget's title, kind (when the format is `auto` or the
 * change asks for another one) and instructions through `update_widget`. Editors only. Asked while a refresh works,
 * it waits for that one to end and runs next (one run at a time, ADR 0053 §6.3).
 */
export async function askWidgetChange(
  deps: DashboardDeps,
  actorId: string,
  orgId: string,
  widgetId: string,
  text: string,
): Promise<WidgetView> {
  const { widget, board } = await requireWidget(deps.db, actorId, orgId, widgetId, "edit");
  const words = text.trim().slice(0, WIDGET_CHANGE_MAX);
  if (!words) throw new ValidationError("Say what to change", DASHBOARD_ERRORS.promptRequired);
  await requireTalksTo(deps.db, orgId, actorId, widget.agentId);
  const routine = await readyRoutine(deps, orgId, widget, board, actorId);
  const event = { type: WIDGET_CHANGE_EVENT, summary: words, text: words, byUserId: actorId };
  await queueEventRun({ db: deps.db }, routine, { event, merge: mergeChanges });
  const row = await markBusy(deps, await widgetRow(deps.db, widget.id), board);
  await publishRoutineRuns(deps.pubsub, orgId, routine.id).catch(() => {});
  return widgetView(deps.db, row);
}

/** Who hears a widget's alert (ADR 0135 §6): whoever set it (else its creator), while they still see its board. */
async function alertRecipients(db: Database, orgId: string, widget: WidgetRow, board: DashboardRow) {
  const userId = widget.alertUserId ?? widget.createdByUserId;
  if (!userId) return [];
  const membership = await getMembership(db, userId, orgId);
  return membership && dashboardRights(board, viewerOf(membership, userId)).see ? [userId] : [];
}

/** A change request is the person talking to the agent: only someone it may talk to asks one (ADR 0085). */
async function requireTalksTo(db: Database, orgId: string, actorId: string, agentId: string) {
  const [agent, membership] = await Promise.all([getAgent(db, orgId, agentId), getMembership(db, actorId, orgId)]);
  if (!agent || agent.archivedAt) {
    throw new ValidationError(`${agent?.name ?? "The agent"} is archived`, DASHBOARD_ERRORS.agentArchived, {
      agentName: agent?.name ?? "",
    });
  }
  if (!membership || !canTalkTo(agent, actorId, speakerOf(membership))) {
    throw new ForbiddenError(`You can't talk to ${agent.name}`, DASHBOARD_ERRORS.agentUnreachable, {
      agentName: agent.name,
    });
  }
}

/** The names of what the agent read, cleaned (at most `SOURCES_MAX`); none given: the ones it had. */
function sourcesOf(raw: readonly string[] | undefined, current: readonly string[]): string[] {
  if (!raw) return [...current];
  const out = raw.map((s) => s.replace(/\s+/g, " ").trim().slice(0, SOURCE_MAX)).filter(Boolean);
  return [...new Set(out)].slice(0, SOURCES_MAX);
}

/** Marks an open routine run whose data didn't pass the check: if it ends that way, it fails as `invalid_data`. */
async function markInvalid(db: Database, routineRunId: string) {
  await db
    .update(routineRuns)
    .set({ code: "invalid_data" })
    .where(and(eq(routineRuns.id, routineRunId), inArray(routineRuns.status, OPEN_RUN)));
}

/** Refuses data (or a title, `widget.invalid_title`) the agent must fix, and remembers it on the run. */
async function refuseData(
  db: Database,
  routineRunId: string,
  message: string,
  code: "widget.invalid_data" | "widget.invalid_title" = "widget.invalid_data",
): Promise<never> {
  await markInvalid(db, routineRunId);
  throw new ValidationError(message, code);
}

/**
 * `update_widget` from a widget's refresh run: checks the spec (`validateWidgetSpec`; the kind may change only on a
 * first build with `auto` or a change request), writes the widget (`ok`, `refreshed_at`, sources, title and
 * instructions when allowed) and a `dashboard_widget_updates` row (keeping `WIDGET_HISTORY_KEPT`), closes the routine
 * run as `reported` with the summary, raises an alert (`widget_alert` to `alert_user_id`) when one is given and the
 * widget's alert is on, resolves an open `widget_failed`, and publishes. With `failed`, the widget fails with
 * `agent_reported` and those words. Invalid data throws a `ValidationError` whose message tells the agent what to fix;
 * a second update in one run is a `ConflictError`.
 */
export async function applyWidgetUpdate(
  deps: DashboardDeps,
  input: { orgId: string; widgetId: string; routineRunId: string; agentRunId: string; update: WidgetUpdateInput },
): Promise<WidgetView> {
  const { db } = deps;
  const { orgId, update } = input;
  const { widget, board } = await loadWidget(db, orgId, input.widgetId);
  const [rr] = await db
    .select()
    .from(routineRuns)
    .where(and(eq(routineRuns.id, input.routineRunId), eq(routineRuns.orgId, orgId)));
  if (!rr || !widget.routineId || rr.routineId !== widget.routineId) {
    throw new ValidationError("This run doesn't update this widget", "widget.not_this_run");
  }
  const [done] = await db
    .select({ id: dashboardWidgetUpdates.id })
    .from(dashboardWidgetUpdates)
    .where(and(eq(dashboardWidgetUpdates.orgId, orgId), eq(dashboardWidgetUpdates.routineRunId, rr.id)))
    .limit(1);
  if (done || rr.finishedAt || !OPEN_RUN.includes(rr.status)) {
    throw new ConflictError("This run already updated its widget", "widget.already_updated");
  }
  const change = widgetChangeOf(rr.event)?.text ?? null;

  if (update.failed !== undefined) {
    const why = update.failed.trim().slice(0, 500);
    if (!why) throw new ValidationError("Say why you couldn't update it, in the person's words", "widget.failed_why");
    await failWidget(deps, widget, board, {
      code: WIDGET_FAILURES.agentReported,
      detail: why,
      routineRunId: rr.id,
      agentRunId: input.agentRunId,
      change,
    });
    // The ledger counts it as a failure when the run ends (`widgetRoutineEnded`).
    await db
      .update(routineRuns)
      .set({ code: WIDGET_FAILURES.agentReported, summary: why })
      .where(and(eq(routineRuns.id, rr.id), inArray(routineRuns.status, OPEN_RUN)));
    return widgetView(db, await widgetRow(db, widget.id));
  }

  const check = validateWidgetSpec(update.spec);
  if (!check.ok) return refuseData(db, rr.id, check.error);
  const spec = check.spec;
  const firstBuild = widget.spec === null || widget.kind === null;
  // The agent names it on its first build (a draft's test too) and on a change request, never over a person's title
  // and never on a plain refresh (ADR 0135 §17). Too long is refused, never cut mid-word.
  const naming = (firstBuild || change !== null) && !widget.titleSetByUser;
  const named = (update.title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<!\.)\.$/, "")
    .trim();
  if (naming && named.length > WIDGET_AGENT_TITLE_MAX) {
    return refuseData(
      db,
      rr.id,
      `The \`title\` is at most ${WIDGET_AGENT_TITLE_MAX} characters: write a shorter one (a few words, like "Site visits").`,
      "widget.invalid_title",
    );
  }
  if (naming && firstBuild && !named) {
    return refuseData(
      db,
      rr.id,
      `Give the widget a short \`title\` (at most ${WIDGET_AGENT_TITLE_MAX} characters, sentence case, in the person's language, no period at the end), like "Site visits": its first build names it.`,
      "widget.invalid_title",
    );
  }
  if (!change && widget.format !== "auto" && spec.kind !== widget.format) {
    return refuseData(db, rr.id, `This widget shows a ${widget.format}: send data of kind "${widget.format}".`);
  }
  if (!change && !firstBuild && widget.kind && spec.kind !== widget.kind) {
    return refuseData(
      db,
      rr.id,
      `This widget shows a ${widget.kind}: keep that kind (only a person's change request moves it to another).`,
    );
  }
  const title = naming && named ? named : widget.title;
  const prompt = change && update.prompt?.trim() ? update.prompt.trim().slice(0, WIDGET_PROMPT_MAX) : widget.prompt;
  // A change that asked for another kind moves a fixed format with it.
  const format = change && widget.format !== "auto" && spec.kind !== widget.format ? spec.kind : widget.format;
  // A draft raises no alert: nobody is watching it yet (ADR 0135 §16).
  const alert =
    widget.alertEnabled && !widget.draft && update.alert?.trim() ? update.alert.trim().slice(0, ALERT_MAX) : null;
  const summary = (update.summary ?? "").replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);
  const now = nowOf(deps);

  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(dashboardWidgets)
      .set({
        spec: spec as unknown as Record<string, unknown>,
        kind: spec.kind,
        format,
        title,
        prompt,
        sources: sourcesOf(update.sources, widget.sources),
        status: "ok",
        failureCode: null,
        failureDetail: null,
        refreshedAt: now,
        ...(alert ? { lastAlertAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(dashboardWidgets.id, widget.id))
      .returning();
    await tx.insert(dashboardWidgetUpdates).values({
      orgId,
      widgetId: widget.id,
      routineRunId: rr.id,
      agentRunId: input.agentRunId,
      status: "ok",
      summary,
      spec: spec as unknown as Record<string, unknown>,
      alert,
      change,
      createdAt: now,
    });
    await trimWidgetHistory(tx, orgId, widget.id);
    // Its run reported: what it found reached people, in place (ADR 0135 §5).
    await tx
      .update(routineRuns)
      .set({ status: "reported", code: null, summary })
      .where(and(eq(routineRuns.id, rr.id), inArray(routineRuns.status, OPEN_RUN)));
    return updated ?? widget;
  });

  if (widget.failureCode) await resolveWidgetFailed(deps, orgId, widget.id).catch(() => {});
  if (alert) {
    await notifyWidgetAlert(deps, {
      orgId,
      userIds: await alertRecipients(db, orgId, row, board),
      widgetId: widget.id,
      dashboardId: board.id,
      agentId: widget.agentId,
      title: row.title,
      text: alert,
    }).catch(() => {});
  }
  // Its routine follows a new title or instructions.
  if (title !== widget.title || prompt !== widget.prompt) await syncWidgetRoutine(deps, orgId, widget.id);
  await publishWidgetChanged(deps.pubsub, board, widgetEvent(row, "ok")).catch(() => {});
  return widgetView(db, row);
}
