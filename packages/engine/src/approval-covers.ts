import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gt, inArray, isNull, or, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { availabilityNow } from "./member-status";
import { rerouteApprovals } from "./notification-producers";
import { notify, resolveNotifications } from "./notifications";
import { can, getMembership, requirePermission } from "./organizations";

const { approvalCovers, organizationMembers } = schema;

/*
 * "Quem aprova por mim" (ADR 0139): one person decides, in someone's name, the approvals asked of that person
 * personally. Who decides what is `coveredFor` in approvals.ts; this file keeps the covers themselves.
 */

export const COVER_MODES = ["always", "while_out"] as const;
export type CoverMode = (typeof COVER_MODES)[number];

/** A cover in force now: who it covers, who covers, and whether merge, deploy and other risky actions are in. */
export interface ActiveCover {
  fromUserId: string;
  toUserId: string;
  risky: boolean;
  /** The covered person's status says they are out of office: their approvals reach only the cover. */
  fromOut: boolean;
}

export interface CoverView {
  /** The other person: who covers me (`cover`), or whom I cover (`covering`). */
  userId: string;
  mode: CoverMode;
  risky: boolean;
  endsAt: string | null;
  /** Deciding for them now: not past its end, and `always` or they are out. */
  active: boolean;
}

export interface MyCovers {
  cover: CoverView | null;
  covering: CoverView[];
}

type CoverRow = typeof approvalCovers.$inferSelect;

const coverGroup = (orgId: string, fromUserId: string) => `approval_cover:${orgId}:${fromUserId}`;

/** Covers not past their end, with whether the covered person is out now. */
async function liveCovers(db: Executor, orgId: string, where: ReturnType<typeof eq>, now: Date) {
  const rows = await db
    .select({
      cover: approvalCovers,
      availability: organizationMembers.availability,
      statusUntil: organizationMembers.statusUntil,
    })
    .from(approvalCovers)
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.orgId, approvalCovers.orgId),
        eq(organizationMembers.userId, approvalCovers.fromUserId),
      ),
    )
    .where(
      and(eq(approvalCovers.orgId, orgId), where, or(isNull(approvalCovers.endsAt), gt(approvalCovers.endsAt, now))),
    );
  return rows.map((r) => ({ cover: r.cover, out: availabilityNow(r, now) === "out" }));
}

const activeOf = ({ cover, out }: { cover: CoverRow; out: boolean }): ActiveCover | null =>
  cover.mode === "always" || out
    ? { fromUserId: cover.fromUserId, toUserId: cover.toUserId, risky: cover.risky, fromOut: out }
    : null;

/** The covers `toUserId` decides through now. */
export async function activeCoversTo(db: Executor, orgId: string, toUserId: string, now = new Date()) {
  const rows = await liveCovers(db, orgId, eq(approvalCovers.toUserId, toUserId), now);
  return rows.map(activeOf).filter((c): c is ActiveCover => c !== null);
}

/** The covers of these people in force now. */
export async function activeCoversFrom(db: Executor, orgId: string, fromUserIds: string[], now = new Date()) {
  if (fromUserIds.length === 0) return [];
  const rows = await liveCovers(db, orgId, inArray(approvalCovers.fromUserId, fromUserIds), now);
  return rows.map(activeOf).filter((c): c is ActiveCover => c !== null);
}

const viewOf = (row: CoverRow, userId: string, active: boolean): CoverView => ({
  userId,
  mode: row.mode,
  risky: row.risky,
  endsAt: row.endsAt?.toISOString() ?? null,
  active,
});

/** Who covers me, and whom I cover (Configurações › Você › Aprovações). */
export async function getMyCovers(db: Database, userId: string, orgId: string, now = new Date()): Promise<MyCovers> {
  await requirePermission(db, userId, orgId, "read");
  const [mine, theirs] = await Promise.all([
    liveCovers(db, orgId, eq(approvalCovers.fromUserId, userId), now),
    liveCovers(db, orgId, eq(approvalCovers.toUserId, userId), now),
  ]);
  const [own] = mine;
  return {
    cover: own ? viewOf(own.cover, own.cover.toUserId, activeOf(own) !== null) : null,
    covering: theirs.map((r) => viewOf(r.cover, r.cover.fromUserId, activeOf(r) !== null)),
  };
}

export interface CoverInput {
  userId: string;
  mode: CoverMode;
  risky: boolean;
  /** ISO; null: until I change it. */
  endsAt: string | null;
}

/**
 * Sets who covers me: one person of the workspace, never me. A new person hears it in their inbox; the one it
 * replaces stops covering at once.
 */
export async function setMyCover(
  deps: { db: Database; pubsub?: PubSub; now?: () => Date },
  userId: string,
  orgId: string,
  input: CoverInput,
): Promise<MyCovers> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  await requirePermission(db, userId, orgId, "read");
  if (input.userId === userId) throw new ValidationError("You can't cover yourself", "approval_cover.self");
  if (!(await getMembership(db, input.userId, orgId))) {
    throw new ValidationError("That person isn't in this workspace", "approval_cover.not_member");
  }
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt <= now)) {
    throw new ValidationError("The end must be in the future", "approval_cover.ends_past");
  }
  const values = { mode: input.mode, risky: input.risky, endsAt, toUserId: input.userId };
  const { before, row } = await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(approvalCovers)
      .where(and(eq(approvalCovers.orgId, orgId), eq(approvalCovers.fromUserId, userId)))
      .for("update");
    const [row] = await tx
      .insert(approvalCovers)
      .values({ orgId, fromUserId: userId, ...values })
      .onConflictDoUpdate({ target: [approvalCovers.orgId, approvalCovers.fromUserId], set: values })
      .returning();
    if (!row) throw new Error("approval cover upsert returned nothing");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "approval_cover.set",
      target: { type: "user", id: input.userId },
      details: { mode: input.mode, risky: input.risky, endsAt: input.endsAt },
    });
    return { before, row };
  });
  if (before?.toUserId !== row.toUserId) {
    const group = coverGroup(orgId, userId);
    if (before) await resolveNotifications(deps, orgId, { groupKey: group }).catch(() => 0);
    await notify(deps, {
      orgId,
      userIds: [row.toUserId],
      kind: "approval_cover",
      groupKey: group,
      actor: { type: "user", id: userId },
      source: {},
      latest: { statusTo: row.mode, ...(row.endsAt ? { expiresAt: row.endsAt.toISOString() } : {}) },
    }).catch(() => []);
  }
  await rerouteApprovals(deps, orgId, userId).catch(() => {});
  return getMyCovers(db, userId, orgId, now);
}

/**
 * Ends `fromUserId`'s cover: they themselves, the person covering them ("Não quero cobrir", and the covered person
 * hears it) or who manages the workspace's members (the covered person hears that too).
 */
export async function endCover(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  fromUserId: string,
) {
  const { db } = deps;
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [row] = await db
    .select()
    .from(approvalCovers)
    .where(and(eq(approvalCovers.orgId, orgId), eq(approvalCovers.fromUserId, fromUserId)));
  if (!row) throw new NotFoundError("No one covers this person", "approval_cover.not_found");
  const declined = actorId === row.toUserId;
  if (actorId !== fromUserId && !declined && !can(membership, "manage_members")) {
    throw new ForbiddenError("Only this person, who covers them or an admin can end it");
  }
  await db.transaction(async (tx) => {
    await tx.delete(approvalCovers).where(eq(approvalCovers.id, row.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "approval_cover.ended",
      target: { type: "user", id: row.toUserId },
      details: { fromUserId },
    });
  });
  await rerouteApprovals(deps, orgId, fromUserId).catch(() => {});
  const group = coverGroup(orgId, fromUserId);
  await resolveNotifications(deps, orgId, { groupKey: group }).catch(() => 0);
  if (actorId !== fromUserId) {
    await notify(deps, {
      orgId,
      userIds: [fromUserId],
      kind: "approval_cover",
      groupKey: `${group}:ended`,
      actor: { type: "user", id: actorId },
      source: {},
      latest: { statusTo: declined ? "declined" : "ended" },
    }).catch(() => []);
  }
}
