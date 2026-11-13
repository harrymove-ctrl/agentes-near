import { and, desc, type Executor, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated, publishUserEvent } from "./events";
import { cutText } from "./format";
import type { MachineTaskRow } from "./machine-tasks";
import { messageView } from "./messages";
import { pendingCommandsSql } from "./mission-command-rules";
import { missionCwd } from "./mission-worktree";
import {
  cleanMissionText,
  concludeMission,
  DONE_CHECK_DELAY_MS,
  getMission,
  getMissionRow,
  latestPlan,
  type MissionDeps,
  type MissionRow,
  missionAnswerers,
  missionFileRefs,
  missionPersonName,
  noMentions,
  oneLineText,
  postMissionMessage,
  publishMissionEvent,
  reactivateMission,
  recordMissionEvent,
  requestFilesSync,
  requireAct,
  requireMission,
  requireOpen,
  scheduleDoneCheck,
  tellSession,
} from "./missions";
import { notifyMissionEnded } from "./notification-producers";

const { missions, missionDeliveries, missionDecisions, missionReviews, machineTasks } = schema;

/**
 * Delivery cards (ADR 0029, "Delivery and awaiting_close"): the end of a
 * mission. The executor's `complete_mission` (what it delivered, the files,
 * what the person should check) or, when every plan item is done or dropped
 * and nothing runs without that call, an automatic small card ("Tudo
 * pronto"). Either way the mission waits in `awaiting_close` until its owner
 * or a decider concludes it (`done`) or asks for changes (back to `active`,
 * the note to the main session). Each person checks the checklist alone.
 */

export type DeliveryStatus = "pending" | "accepted" | "changes_requested" | "superseded";

export const DELIVERY_LIMITS = { summary: 4000, checklist: 12, item: 200, note: 4000, paths: 10 } as const;

/** How many times the done check waits for an agent run still going in the thread (agent mode). */
const DONE_CHECK_RETRIES = 10;

type DeliveryRow = typeof missionDeliveries.$inferSelect;

export interface DeliveryView {
  id: string;
  missionId: string;
  taskId: string | null;
  messageId: string | null;
  /** Made by us: every item done and no `complete_mission`. */
  auto: boolean;
  summary: string;
  artifactIds: string[];
  paths: string[];
  /** "O que conferir", with who checked each item. */
  checklist: { id: string; text: string; checkedBy: string[] }[];
  status: DeliveryStatus;
  note: string | null;
  saveToWiki: boolean;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export function deliveryView(row: DeliveryRow): DeliveryView {
  const checks = row.checks ?? {};
  return {
    id: row.id,
    missionId: row.missionId,
    taskId: row.taskId,
    messageId: row.messageId,
    auto: row.auto,
    summary: row.summary,
    artifactIds: row.artifactIds,
    paths: row.paths ?? [],
    checklist: (row.checklist ?? []).map((item) => ({
      id: item.id,
      text: item.text,
      checkedBy: Object.entries(checks)
        .filter(([, ids]) => Array.isArray(ids) && ids.includes(item.id))
        .map(([userId]) => userId)
        .sort(),
    })),
    status: (["pending", "accepted", "changes_requested", "superseded"].includes(row.status)
      ? row.status
      : "pending") as DeliveryStatus,
    note: row.note,
    saveToWiki: row.saveToWiki,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The checklist as the executor sent it: short lines, at most 12, numbered ids. */
function checklistOf(input: unknown) {
  if (!Array.isArray(input)) return [];
  return input
    .map((x) => noMentions(oneLineText(cleanMissionText(x, DELIVERY_LIMITS.item), DELIVERY_LIMITS.item)))
    .filter(Boolean)
    .slice(0, DELIVERY_LIMITS.checklist)
    .map((text, i) => ({ id: `c${i + 1}`, text }));
}

/** Owner and deciders hear a delivery waits for them. */
async function notifyDelivery(deps: Pick<MissionDeps, "db" | "pubsub">, mission: MissionRow, deliveryId: string) {
  for (const userId of await missionAnswerers(deps.db, mission)) {
    await publishUserEvent(deps.pubsub, mission.orgId, userId, {
      type: "mission.needs_you",
      kind: "delivery",
      missionId: mission.id,
      threadId: mission.threadRootId,
      deliveryId,
    });
  }
}

/**
 * Creates a delivery card: older pending ones are superseded, the card is
 * posted by the mission's agent, and the mission waits to be concluded
 * (`awaiting_close`).
 */
async function createDelivery(
  deps: MissionDeps,
  mission: MissionRow,
  input: {
    auto: boolean;
    taskId: string | null;
    summary: string;
    checklist: { id: string; text: string }[];
    artifactIds: string[];
    paths: string[];
  },
) {
  const out = await deps.db.transaction(async (tx) => {
    await tx
      .update(missionDeliveries)
      .set({ status: "superseded" })
      .where(and(eq(missionDeliveries.missionId, mission.id), eq(missionDeliveries.status, "pending")));
    const [row] = await tx
      .insert(missionDeliveries)
      .values({
        orgId: mission.orgId,
        missionId: mission.id,
        taskId: input.taskId,
        auto: input.auto,
        summary: input.summary,
        artifactIds: input.artifactIds,
        paths: input.paths,
        checklist: input.checklist,
      })
      .returning();
    if (!row) throw new Error("delivery insert returned nothing");
    const message = await postMissionMessage(
      deps,
      mission,
      input.auto
        ? "Everything in the plan is done. Conclude the mission, or ask for changes."
        : `Delivered: ${cutText(input.summary.split("\n")[0] ?? "", 300)}`,
      {
        // "O que mudou": the mission's whole change (`baseSha..branch`, ADR 0044) when it has a branch.
        missionDelivery: {
          missionId: mission.id,
          id: row.id,
          ...(mission.branch
            ? { branch: mission.branch, baseBranch: mission.baseBranch, baseSha: mission.baseSha }
            : {}),
        },
        ...(input.artifactIds.length ? { artifacts: await missionFileRefs(tx, mission.orgId, input.artifactIds) } : {}),
        bodyCode: input.auto ? "mission_all_done" : "mission_delivery",
        bodyParams: input.auto ? {} : { summary: cutText(input.summary.split("\n")[0] ?? "", 300) },
      },
      tx,
    );
    const [linked] = await tx
      .update(missionDeliveries)
      .set({ messageId: message.id })
      .where(eq(missionDeliveries.id, row.id))
      .returning();
    const [moved] = await tx
      .update(missions)
      .set({ status: "awaiting_close", updatedAt: new Date() })
      .where(and(eq(missions.id, mission.id), eq(missions.status, "active")))
      .returning();
    await recordMissionEvent(tx, mission, "delivered", { deliveryId: row.id, auto: input.auto, taskId: input.taskId });
    return { delivery: linked ?? row, message, mission: moved ?? null };
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(out.message));
  const now = out.mission ?? (await getMissionRow(deps.db, mission.id)) ?? mission;
  if (out.mission) await publishMissionEvent(deps, now, "status", { reason: "delivered" });
  await publishMissionEvent(deps, now, "delivery", { deliveryId: out.delivery.id });
  await notifyDelivery(deps, now, out.delivery.id);
  // The inbox: the agent finished; the owner concludes or asks for changes.
  await notifyMissionEnded(deps, now, "mission_finished", { type: "agent", id: now.agentId }, input.summary).catch(
    () => {},
  );
  await requestFilesSync(deps.db, now);
  return out.delivery;
}

/**
 * `complete_mission` (the executor's MCP tool, or the agent's own in agent
 * mode): the delivery card with what was delivered and what to check.
 * Files were uploaded to the Drive first (`artifactIds`).
 */
export async function completeMission(
  deps: MissionDeps,
  mission: MissionRow,
  task: Pick<MachineTaskRow, "id"> | null,
  input: { summary: unknown; checklist?: unknown; artifactIds?: string[]; paths?: string[] },
) {
  if (mission.status === "proposed") {
    throw new ConflictError("The plan isn't approved yet: wait for the people to press Start.", "mission.not_started");
  }
  if (mission.status === "paused") {
    throw new ConflictError("The mission is paused: don't deliver now.", "mission.paused");
  }
  requireOpen(mission);
  const summary = noMentions(cleanMissionText(input.summary, DELIVERY_LIMITS.summary));
  if (!summary) throw new ValidationError("Say what you delivered", "mission.invalid_delivery");
  return createDelivery(deps, mission, {
    auto: false,
    taskId: task?.id ?? null,
    summary,
    checklist: checklistOf(input.checklist),
    artifactIds: input.artifactIds ?? [],
    paths: (input.paths ?? []).slice(0, DELIVERY_LIMITS.paths),
  });
}

/**
 * Is the mission's work over? An active mission whose plan has items, all
 * done or dropped, with no task of it queued or running, no blocking
 * decision, review or command waiting and (agent mode) no run of its agent
 * still going in the home thread. Then it waits to be concluded and, unless
 * a delivery already waits, gets the automatic card. Idempotent: run after
 * plan changes, task ends and resumes (`mission.check_done`).
 */
export async function checkMissionDone(deps: MissionDeps, missionId: string, attempt = 0) {
  const mission = await getMissionRow(deps.db, missionId);
  if (!mission || (mission.status !== "active" && mission.status !== "awaiting_close")) return null;
  const plan = await latestPlan(deps.db, mission.id);
  const items = plan?.items ?? [];
  if (items.length === 0 || !items.some((i) => i.status === "done")) return null;
  if (!items.every((i) => i.status === "done" || i.status === "dropped")) return null;
  const rows = await deps.db.execute(sql`select
      exists (select 1 from ${machineTasks} t where t.mission_id = ${mission.id}::uuid
        and t.status in ('queued', 'running') and t.ended_at is null) as running,
      exists (select 1 from ${missionDecisions} d where d.mission_id = ${mission.id}::uuid
        and d.status = 'pending' and d.blocking) as deciding,
      exists (select 1 from ${missionReviews} r where r.mission_id = ${mission.id}::uuid
        and r.status = 'pending') as reviewing,
      ${pendingCommandsSql(sql`${mission.id}::uuid`)} > 0 as commanding,
      exists (select 1 from ${schema.agentRuns} ar where ar.org_id = ${mission.orgId}::uuid
        and ar.thread_root_id = ${mission.threadRootId}::uuid and ar.agent_id = ${mission.agentId}::uuid
        and ar.status in ('queued', 'running', 'waiting_approval', 'waiting_input')) as agent_running,
      exists (select 1 from ${missionDeliveries} dl where dl.mission_id = ${mission.id}::uuid
        and dl.status = 'pending') as delivered`);
  const r = rowsOf<Record<string, unknown>>(rows)[0];
  const yes = (k: string) => r?.[k] === true || r?.[k] === "t";
  if (yes("running") || yes("deciding") || yes("reviewing") || yes("commanding")) return null;
  if (yes("agent_running")) {
    // Agent mode: its run may still call complete_mission; look again a bit later.
    if (attempt < DONE_CHECK_RETRIES) await scheduleDoneCheck(deps.db, mission, DONE_CHECK_DELAY_MS * 2, attempt + 1);
    return null;
  }
  if (yes("delivered")) {
    if (mission.status === "active") {
      const [moved] = await deps.db
        .update(missions)
        .set({ status: "awaiting_close", updatedAt: new Date() })
        .where(and(eq(missions.id, mission.id), eq(missions.status, "active")))
        .returning();
      if (moved) {
        await recordMissionEvent(deps.db, moved, "awaiting_close", {});
        await publishMissionEvent(deps, moved, "status", { reason: "all_done" });
        await requestFilesSync(deps.db, moved);
      }
    }
    return null;
  }
  if (mission.status !== "active") return null;
  return createDelivery(deps, mission, {
    auto: true,
    taskId: null,
    summary: "",
    checklist: [],
    artifactIds: [],
    paths: [],
  });
}

async function requireDelivery(db: Executor, mission: MissionRow, deliveryId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw new NotFoundError("Delivery not found", "mission.delivery_not_found");
  const [row] = await db
    .select()
    .from(missionDeliveries)
    .where(and(eq(missionDeliveries.id, deliveryId), eq(missionDeliveries.missionId, mission.id)));
  if (!row) throw new NotFoundError("Delivery not found", "mission.delivery_not_found");
  return row;
}

const requirePending = (row: DeliveryRow) => {
  if (row.status !== "pending") {
    throw new ConflictError("This delivery was already answered", "mission.delivery_decided", { status: row.status });
  }
};

/** `GET …/deliveries`: newest first (who reads the conversation). */
export async function listDeliveries(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  const rows = await deps.db
    .select()
    .from(missionDeliveries)
    .where(eq(missionDeliveries.missionId, mission.id))
    .orderBy(desc(missionDeliveries.createdAt))
    .limit(100);
  return rows.map(deliveryView);
}

/** "O que conferir": one person's check on one item (others keep theirs). */
export async function checkDeliveryItem(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  deliveryId: string,
  itemId: string,
  checked: boolean,
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "check the delivery");
  const row = await requireDelivery(deps.db, mission, deliveryId);
  requirePending(row);
  if (!row.checklist.some((i) => i.id === itemId)) {
    throw new NotFoundError("Checklist item not found", "mission.delivery_item_not_found");
  }
  const mine = new Set(row.checks?.[userId] ?? []);
  if (checked) mine.add(itemId);
  else mine.delete(itemId);
  const [updated] = await deps.db
    .update(missionDeliveries)
    .set({
      checks: sql`${missionDeliveries.checks} || jsonb_build_object(${userId}::text, ${JSON.stringify([...mine].sort())}::jsonb)`,
    })
    .where(and(eq(missionDeliveries.id, row.id), eq(missionDeliveries.status, "pending")))
    .returning();
  if (!updated) throw new ConflictError("This delivery was already answered", "mission.delivery_decided");
  await publishMissionEvent(deps, mission, "delivery", { deliveryId: row.id });
  return deliveryView(updated);
}

/** "Concluir missão": the delivery accepted, the mission closed as done (optionally its lessons in the wiki). */
export async function acceptDelivery(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  deliveryId: string,
  input: { saveToWiki?: boolean } = {},
) {
  const { mission, role, isAdmin } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "conclude the mission");
  requireOpen(mission);
  const row = await requireDelivery(deps.db, mission, deliveryId);
  requirePending(row);
  const [claimed] = await deps.db
    .update(missionDeliveries)
    .set({ status: "accepted", saveToWiki: input.saveToWiki === true, decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(missionDeliveries.id, row.id), eq(missionDeliveries.status, "pending")))
    .returning();
  if (!claimed) throw new ConflictError("This delivery was already answered", "mission.delivery_decided");
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "mission.delivery_accepted",
    target: { type: "mission", id: mission.id },
    details: { deliveryId: row.id, saveToWiki: input.saveToWiki === true },
  });
  await recordMissionEvent(deps.db, mission, "delivery_accepted", { deliveryId: row.id, by: userId });
  const view = await concludeMission(deps, mission, userId, isAdmin, {
    outcome: "done",
    saveToWiki: input.saveToWiki === true,
  });
  await publishMissionEvent(deps, { ...mission, status: "done" }, "delivery", { deliveryId: row.id });
  return view;
}

/**
 * "Pedir ajustes": the delivery is answered with a note, the mission is
 * active again and the note goes to the main session (or the agent).
 */
export async function requestDeliveryChanges(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  deliveryId: string,
  input: { note: string },
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "ask for changes");
  requireOpen(mission);
  const note = cleanMissionText(input.note, DELIVERY_LIMITS.note);
  if (!note) throw new ValidationError("Say what should change", "mission.delivery_note_required");
  const row = await requireDelivery(deps.db, mission, deliveryId);
  requirePending(row);
  const [claimed] = await deps.db
    .update(missionDeliveries)
    .set({ status: "changes_requested", note, decidedBy: userId, decidedAt: new Date() })
    .where(and(eq(missionDeliveries.id, row.id), eq(missionDeliveries.status, "pending")))
    .returning();
  if (!claimed) throw new ConflictError("This delivery was already answered", "mission.delivery_decided");
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "mission.delivery_changes",
    target: { type: "mission", id: mission.id },
    details: { deliveryId: row.id, chars: note.length },
  });
  await recordMissionEvent(deps.db, mission, "delivery_changes", { deliveryId: row.id, by: userId });
  const live = await reactivateMission(deps, mission, "changes");
  const name = await missionPersonName(deps.db, userId);
  await tellSession(
    deps,
    live,
    { sessionId: live.mainSessionId, cwd: missionCwd(live) },
    `Changes requested on the delivery (by ${name}): ${note}`,
    { requestedBy: userId, from: name, kind: "person" },
  );
  await publishMissionEvent(deps, live, "delivery", { deliveryId: row.id });
  return getMission(deps, userId, orgId, missionId);
}
