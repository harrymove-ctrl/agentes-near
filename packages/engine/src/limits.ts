import { and, count, type Database, type Executor, eq, gt, gte, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import { ConflictError } from "./errors";
import { formatBytes } from "./format";
import type { Judge } from "./judge";
import { recordOperatorEvent } from "./operator-events";
import { can, requirePermission } from "./organizations";
import { storedBytes, usesOwnBucket } from "./storage";
import { monthStartUtc } from "./usage";

/**
 * A workspace's limits (ADR 0079): plain numbers a billing service sets through the operator API, enforced here
 * without knowing any plan. Null is no limit, all a self-hosted server ever has.
 *
 * - `members`: membership rows, blocked accounts included; agents, invitations and requests to join never count.
 * - `membersMax`: the most people the plan takes with seats added (`members` up to it); null: the service sets none.
 * - `payerUserId`: not a limit, the person who pays for the plan, the only one the billing service lets add seats or
 *   change plans; null: not said.
 * - `storageBytes`: the files kept on this server's storage, files in the trash and the workspace's own bucket left out.
 * - `uploadBytesPerDay`: what was written to that storage in the last 24 hours.
 * - `platformUsdPerMonth`: what the platform's own AI (Jev) may cost for the workspace in a UTC calendar month.
 */
export interface OrgLimits {
  members: number | null;
  membersMax: number | null;
  payerUserId: string | null;
  storageBytes: number | null;
  uploadBytesPerDay: number | null;
  platformUsdPerMonth: number | null;
}

const { organizations, organizationMembers, artifactVersions, skillFiles, usageRecords } = schema;

/** `usage_records.cost_nano_usd`'s unit, in which the platform cap is kept. */
const NANO_PER_USD = 1e9;

const LIMIT_COLUMNS = {
  members: organizations.limitMembers,
  membersMax: organizations.limitMembersMax,
  payerUserId: organizations.payerUserId,
  storageBytes: organizations.limitStorageBytes,
  uploadBytesPerDay: organizations.limitUploadBytesPerDay,
  platformNanoUsd: organizations.limitPlatformNanoUsd,
  updatedAt: organizations.limitsUpdatedAt,
};

const limitsOf = (row: {
  members: number | null;
  membersMax: number | null;
  payerUserId: string | null;
  storageBytes: number | null;
  uploadBytesPerDay: number | null;
  platformNanoUsd: number | null;
  updatedAt: Date | null;
}) => ({
  members: row.members,
  membersMax: row.membersMax,
  payerUserId: row.payerUserId,
  storageBytes: row.storageBytes,
  uploadBytesPerDay: row.uploadBytesPerDay,
  platformUsdPerMonth: row.platformNanoUsd === null ? null : row.platformNanoUsd / NANO_PER_USD,
  updatedAt: row.updatedAt,
});

/** The workspace's limits and when one last changed; none for an unknown id. */
export async function getOrgLimits(db: Executor, orgId: string): Promise<OrgLimits & { updatedAt: Date | null }> {
  const [row] = await db.select(LIMIT_COLUMNS).from(organizations).where(eq(organizations.id, orgId));
  return row
    ? limitsOf(row)
    : {
        members: null,
        membersMax: null,
        payerUserId: null,
        storageBytes: null,
        uploadBytesPerDay: null,
        platformUsdPerMonth: null,
        updatedAt: null,
      };
}

/**
 * Sets all the limits (the operator API), whatever the workspace's standing. Setting what is already set changes
 * nothing, `updatedAt` included. A new platform cap applies at once in this process, within a minute in the others.
 * Null when there is no such workspace.
 */
export async function setOrgLimits(
  db: Database,
  orgId: string,
  limits: OrgLimits,
): Promise<(OrgLimits & { updatedAt: Date | null }) | null> {
  const nanoUsd = limits.platformUsdPerMonth === null ? null : Math.round(limits.platformUsdPerMonth * NANO_PER_USD);
  const [row] = await db
    .update(organizations)
    .set({
      limitMembers: limits.members,
      limitMembersMax: limits.membersMax,
      payerUserId: limits.payerUserId,
      limitStorageBytes: limits.storageBytes,
      limitUploadBytesPerDay: limits.uploadBytesPerDay,
      limitPlatformNanoUsd: nanoUsd,
      // The right side of SET reads the row as it was.
      limitsUpdatedAt: sql`case when (${organizations.limitMembers}, ${organizations.limitMembersMax},
        ${organizations.payerUserId}, ${organizations.limitStorageBytes}, ${organizations.limitUploadBytesPerDay},
        ${organizations.limitPlatformNanoUsd})
        is not distinct from (${limits.members}::integer, ${limits.membersMax}::integer, ${limits.payerUserId}::text,
        ${limits.storageBytes}::bigint, ${limits.uploadBytesPerDay}::bigint, ${nanoUsd}::bigint)
        then ${organizations.limitsUpdatedAt} else now() end`,
    })
    .where(eq(organizations.id, orgId))
    .returning(LIMIT_COLUMNS);
  caches.platformSpend.delete(`${orgId}:`);
  return row ? limitsOf(row) : null;
}

const memberCount = async (db: Executor, orgId: string) =>
  (await db.select({ n: count() }).from(organizationMembers).where(eq(organizationMembers.orgId, orgId)))[0]?.n ?? 0;

/**
 * Refuses one more person in a full workspace (`org.members_full`, 409). Exact only under the workspace's
 * `org-members` lock, which `joinOrganization` takes; before an invitation is sent it only spares sending one that
 * couldn't be accepted.
 */
export async function assertMemberRoom(db: Executor, orgId: string) {
  const [org] = await db
    .select({ limit: organizations.limitMembers })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org || org.limit === null) return;
  const members = await memberCount(db, orgId);
  if (members >= org.limit) {
    throw new ConflictError("This workspace is full", "org.members_full", { members, limit: org.limit });
  }
}

const LAST_DAY = sql`now() - interval '24 hours'`;

/**
 * What a workspace keeps on this server's storage (`storedBytes`' platform bytes: the trash left out, so deleting a
 * file frees its space at once), and the bytes written there in the last 24 hours, the trash included: what was
 * written stays written.
 */
export async function storageUsage(
  db: Executor,
  orgId: string,
): Promise<{ usedBytes: number; uploadBytes24h: number }> {
  const [stored, [files], [skills]] = await Promise.all([
    storedBytes(db, orgId),
    db
      .select({ day: sql<string>`coalesce(sum(${artifactVersions.size}), 0)` })
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.orgId, orgId),
          isNull(artifactVersions.storageConfigId),
          gt(artifactVersions.createdAt, LAST_DAY),
        ),
      ),
    db
      .select({ day: sql<string>`coalesce(sum(${skillFiles.size}), 0)` })
      .from(skillFiles)
      .where(
        and(
          eq(skillFiles.orgId, orgId),
          isNull(skillFiles.storageConfigId),
          isNotNull(skillFiles.blobKey),
          gt(skillFiles.createdAt, LAST_DAY),
        ),
      ),
  ]);
  return { usedBytes: stored.platformBytes, uploadBytes24h: Number(files?.day ?? 0) + Number(skills?.day ?? 0) };
}

/**
 * Refuses writing `incoming` more bytes to this server's storage past the workspace's limits, before anything is
 * written: `storage.full` or `storage.daily_full` (409), in words an agent can pass on. Its callers skip it for a
 * workspace's own bucket. `daily: false` for files that come back rather than arrive (out of the trash, or copied
 * back from the workspace's own bucket): they keep the day they were first written, so the day never counts them.
 * ponytail: the sums are read without a lock, so uploads at the same moment can pass the line together by at most
 * their own sizes (each at most 50 MB); a lock would serialize every upload of a workspace.
 */
export async function assertStorageRoom(db: Executor, orgId: string, incoming: number, { daily = true } = {}) {
  const { storageBytes, uploadBytesPerDay } = await getOrgLimits(db, orgId);
  const perDay = daily ? uploadBytesPerDay : null;
  if (storageBytes === null && perDay === null) return;
  const { usedBytes, uploadBytes24h } = await storageUsage(db, orgId);
  if (storageBytes !== null && usedBytes + incoming > storageBytes) {
    throw new ConflictError(
      `The workspace's file storage is full (${formatBytes(usedBytes)} of ${formatBytes(storageBytes)}): nothing was saved. Tell the person who asked: an admin can free space or raise the limit.`,
      "storage.full",
      { usedBytes, limitBytes: storageBytes },
    );
  }
  if (perDay !== null && uploadBytes24h + incoming > perDay) {
    throw new ConflictError(
      `Today's uploads to this workspace reached ${formatBytes(perDay)}: nothing was saved. Try again in a few hours.`,
      "storage.daily_full",
      { limitBytes: perDay },
    );
  }
}

/** What the platform's own AI (usage billed to the platform) cost for the workspace this UTC month, in nano-US$. */
async function platformSpendNano(db: Executor, orgId: string, now: Date) {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.orgId, orgId),
        eq(usageRecords.billedTo, "platform"),
        gte(usageRecords.createdAt, monthStartUtc(now)),
      ),
    );
  return Number(row?.total ?? 0);
}

/** That cost in US$. */
export const platformSpendThisMonth = async (db: Executor, orgId: string, now = new Date()) =>
  (await platformSpendNano(db, orgId, now)) / NANO_PER_USD;

const cents = (nanoUsd: number) => Math.round(nanoUsd / 1e7) / 100;

/** A routing decision's error past the workspace's platform AI for the month: only @mentions start agents there. */
export const PLATFORM_CAP = "platform_cap" as const;

/**
 * Whether the workspace used up its platform AI for this UTC month (`platformUsdPerMonth`), cached a minute per
 * process. The first time a month's spend reaches 50% and 100% of it, the operator's feed gets
 * `platform_ai.threshold`, once per workspace, month and threshold.
 * ponytail: the cache lets the spend run up to a minute of calls past the cap; a counter row moved by every call
 * would be exact.
 */
export async function platformCapReached(db: Database, orgId: string, now = new Date()): Promise<boolean> {
  return (await caches.platformSpend.getOrLoad(`${orgId}:`, async () => {
    const [org] = await db
      .select({
        limit: organizations.limitPlatformNanoUsd,
        month: organizations.platformAlertMonth,
        percent: organizations.platformAlertPercent,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org || org.limit === null) return false;
    const spent = await platformSpendNano(db, orgId, now);
    const percent = spent <= 0 ? 0 : spent >= org.limit ? 100 : spent * 2 >= org.limit ? 50 : 0;
    const month = monthStartUtc(now).toISOString().slice(0, 7);
    if (percent > 0 && (org.month !== month || (org.percent ?? 0) < percent)) {
      const data = { month, percent, spentUsd: cents(spent), limitUsd: cents(org.limit) };
      await db.transaction(async (tx) => {
        // Another process may have seen the same crossing: only the one that moves the row tells it.
        const moved = await tx
          .update(organizations)
          .set({ platformAlertMonth: month, platformAlertPercent: percent })
          .where(
            and(
              eq(organizations.id, orgId),
              sql`(${organizations.platformAlertMonth} is distinct from ${month} or ${organizations.platformAlertPercent} < ${percent})`,
            ),
          )
          .returning({ id: organizations.id });
        if (moved.length > 0) await recordOperatorEvent(tx, { type: "platform_ai.threshold", orgId, data });
      });
    }
    return spent >= org.limit;
  })) as boolean;
}

/**
 * The platform's judge (Jev), refused for a workspace past its platform AI for the month: under `withJudgeFallback`
 * the workspace's own cheap model answers in its place, and what only Jev answers (calibrated requests, images,
 * boxes) fails like a Jev outage, which its callers already handle.
 */
export function platformCapJudge(db: Database, jev: Judge): Judge {
  return {
    name: jev.name,
    async ask(request) {
      if (await platformCapReached(db, request.orgId)) throw new Error("platform_cap");
      return jev.ask(request);
    },
  };
}

/** What the operator reads of a workspace's use against its limits (`GET /orgs/{orgId}`). */
export async function orgMeters(db: Database, orgId: string) {
  const [usage, ownStorage, platformUsdThisMonth] = await Promise.all([
    storageUsage(db, orgId),
    usesOwnBucket(db, orgId),
    platformSpendThisMonth(db, orgId),
  ]);
  return { storageBytes: usage.usedBytes, uploadBytes24h: usage.uploadBytes24h, ownStorage, platformUsdThisMonth };
}

/** The payer's name while they are in the workspace, as the members list shows them; else null. */
async function memberName(db: Executor, orgId: string, userId: string) {
  const [row] = await db
    .select({ name: schema.users.name })
    .from(organizationMembers)
    .innerJoin(schema.users, eq(schema.users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return row?.name ?? null;
}

/**
 * People, files and today's uploads against the workspace's limits (null: none), for any member: the apps show a
 * full workspace before anyone tries. `members.payer`, when the billing service said who pays: whether it is the
 * viewer, and to whoever manages billing, the payer's name while they are in the workspace.
 */
export async function orgLimitsView(db: Database, actorId: string, orgId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [limits, members, usage, ownStorage] = await Promise.all([
    getOrgLimits(db, orgId),
    memberCount(db, orgId),
    storageUsage(db, orgId),
    usesOwnBucket(db, orgId),
  ]);
  const payerId = limits.payerUserId;
  const you = payerId === actorId;
  const payer =
    payerId === null
      ? null
      : {
          you,
          name: !you && can(membership, "manage_billing") ? await memberName(db, orgId, payerId) : null,
        };
  return {
    members: {
      used: members,
      limit: limits.members,
      max: limits.membersMax,
      canAddSeats: limits.members !== null && limits.membersMax !== null && limits.members < limits.membersMax,
      payer,
    },
    storage: { usedBytes: usage.usedBytes, limitBytes: limits.storageBytes, ownStorage },
    uploads: { usedBytes24h: usage.uploadBytes24h, limitBytesPerDay: limits.uploadBytesPerDay },
  };
}
