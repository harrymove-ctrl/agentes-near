import type { BlobStoreResolver, PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import type { AgentDeletionDeps } from "./agent-deletion";
import { ARTIFACT_TRASH_DAYS } from "./artifacts";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { stopRun } from "./cancel";
import { NotFoundError, ValidationError } from "./errors";
import { publishChannelsChanged, publishListChanged, publishOrgEvent } from "./events";
import { concludeMission, OPEN_MISSION_STATUSES } from "./missions";
import { clearChannelNotifications } from "./notifications";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { deleteChannelRoutines } from "./routines";
import { ACTIVE_RUN_STATUSES } from "./run-inbox";
import { enqueueIndex } from "./search";
import { dropChannelVoice } from "./voice";

const {
  agentRuns,
  approvals,
  artifacts,
  channelMembers,
  channelReads,
  channels,
  contextItems,
  issues,
  messagePins,
  messageReactions,
  messages,
  missions,
  notifications,
  searchDocuments,
  threadFollows,
  threadReads,
  threadReflections,
  threads,
} = schema;

/*
 * Deleting a channel for good, unlike archiving it: owners and admins, typing its name, never #general. Like an
 * agent's deletion (ADR 0082) it is a soft delete then a purge. At once the channel is archived and marked deleted
 * (nothing lists it, nothing brings it back), renamed `deleted-<id>` so its name is free again, its routines go, its
 * runs and missions stop, and the audit log says who did it. Then the `channel.delete` job takes what it held:
 * messages and their reactions, threads, pins, reads, members (people and agents), the agents' memory from it, what
 * search finds of it and the notifications that point at it; its files become tombstones whose contents the files'
 * purge takes, and its voice recordings leave storage. Issues of a private channel go too (nobody could see them
 * again); a public channel's stay for the whole workspace, as it could already read them. The row stays, so runs,
 * usage and audit that name it still resolve.
 */

/** The job that purges a deleted channel's contents (`purgeChannel`). */
export const CHANNEL_DELETE_JOB = "channel.delete";

export const deletedChannelName = (channelId: string) => `deleted-${channelId}`;

export async function deleteChannel(
  deps: AgentDeletionDeps,
  actorId: string,
  orgId: string,
  channelId: string,
  /** The channel's name as the person typed it to confirm. */
  typed: string,
) {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "manage_channels");
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId), isNull(channels.deletedAt)));
  if (channel?.kind !== "channel") throw new NotFoundError("Channel not found");
  if (channel.name === "general") throw new ValidationError("#general can't be deleted", "channel.general");
  if (typed.trim().replace(/^#/, "").toLowerCase() !== channel.name) {
    throw new ValidationError("Type the channel's name to delete it", "channel.delete_name");
  }
  await db.transaction(async (tx) => {
    if (!(await markChannelDeleted(tx, orgId, channelId))) throw new NotFoundError("Channel not found");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "channel.deleted",
      target: { type: "channel", id: channelId },
      details: { name: channel.name, visibility: channel.visibility },
    });
  });
  await endChannelWork(deps, actorId, orgId, channelId);
}

/** Inside the caller's transaction: nothing lists the channel from here on, and the purge is queued. False: already gone. */
export async function markChannelDeleted(tx: Executor, orgId: string, channelId: string) {
  const [gone] = await tx
    .update(channels)
    .set({
      archivedAt: sql`coalesce(${channels.archivedAt}, now())`,
      deletedAt: new Date(),
      name: deletedChannelName(channelId),
      categoryId: null,
    })
    .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
    .returning({ id: channels.id });
  if (!gone) return false;
  await enqueue(tx, {
    orgId,
    kind: CHANNEL_DELETE_JOB,
    payload: { channelId },
    dedupeKey: `${CHANNEL_DELETE_JOB}:${channelId}`,
  });
  return true;
}

/** After `markChannelDeleted` commits: its routines go, its runs and missions stop, and clients drop it. */
export async function endChannelWork(deps: AgentDeletionDeps, actorId: string, orgId: string, channelId: string) {
  const { db } = deps;
  caches.channels.delete(`${orgId}:${channelId}`);
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  await deleteChannelRoutines(deps, actorId, orgId, channelId);
  const live = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.channelId, channelId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    );
  for (const run of live) {
    await stopRun(deps, orgId, run, "channel", { type: "system", reason: "channel_deleted" }).catch(() => null);
  }
  const open = await db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.orgId, orgId),
        eq(missions.channelId, channelId),
        inArray(missions.status, OPEN_MISSION_STATUSES),
      ),
    );
  for (const mission of open) {
    await concludeMission(deps, mission, actorId, true, { outcome: "canceled" }).catch(() => null);
  }
  // Clients drop it as they drop an archived channel, and live subscriptions to it end.
  await publishOrgEvent(deps.pubsub, { type: "channel.archived", orgId, channelId });
  await publishChannelsChanged(deps.pubsub, orgId);
  // Its files leave the Drive with it.
  await publishListChanged(deps.pubsub, orgId, "artifacts");
}

/** Job: a deleted channel's contents go, in one transaction; a no-op for a channel that isn't deleted. */
export async function purgeChannel(
  deps: { db: Database; pubsub?: PubSub; blobs?: BlobStoreResolver },
  orgId: string,
  channelId: string,
) {
  const { db } = deps;
  const [channel] = await db
    .select({ deletedAt: channels.deletedAt, visibility: channels.visibility })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel?.deletedAt) return;
  // Each person's inbox loses what pointed at it, live; approvals go with the rest below.
  const told = await db
    .selectDistinct({ userId: notifications.userId })
    .from(notifications)
    .where(and(eq(notifications.orgId, orgId), sql`${notifications.source}->>'channelId' = ${channelId}`));
  for (const { userId } of told) await clearChannelNotifications(deps, orgId, userId, channelId);
  const inChannel = sql`${channelId}::uuid = any(${searchDocuments.channelIds})`;
  // ponytail: one transaction for the whole channel; page by `created_at` if a channel ever holds millions of messages.
  await db.transaction(async (tx) => {
    const ids = tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.channelId, channelId)));
    await tx
      .delete(messageReactions)
      .where(and(eq(messageReactions.orgId, orgId), inArray(messageReactions.messageId, ids)));
    const memory = tx
      .select({ id: contextItems.id })
      .from(contextItems)
      .where(and(eq(contextItems.orgId, orgId), sql`${channelId}::uuid = any(${contextItems.channelIds})`));
    await tx
      .delete(searchDocuments)
      .where(and(eq(searchDocuments.kind, "context_item"), inArray(searchDocuments.sourceId, memory)));
    await tx.delete(searchDocuments).where(and(eq(searchDocuments.orgId, orgId), inChannel));
    await tx
      .delete(contextItems)
      .where(and(eq(contextItems.orgId, orgId), sql`${channelId}::uuid = any(${contextItems.channelIds})`));
    // Its files: tombstones as if deleted longer ago than the trash keeps them, so the files' purge takes their contents.
    const gone = new Date(Date.now() - ARTIFACT_TRASH_DAYS * 86_400_000 - 1000).toISOString();
    await tx
      .update(artifacts)
      .set({ deletedAt: sql`least(coalesce(${artifacts.deletedAt}, ${gone}::timestamptz), ${gone}::timestamptz)` })
      .where(and(eq(artifacts.orgId, orgId), eq(artifacts.channelId, channelId)));
    await tx
      .update(approvals)
      .set({ status: "canceled", decidedAt: new Date() })
      .where(and(eq(approvals.orgId, orgId), eq(approvals.channelId, channelId), eq(approvals.status, "pending")));
    await tx
      .delete(notifications)
      .where(and(eq(notifications.orgId, orgId), sql`${notifications.source}->>'channelId' = ${channelId}`));
    const itsIssues = and(eq(issues.orgId, orgId), eq(issues.channelId, channelId));
    if (channel.visibility === "public") {
      const kept = await tx.update(issues).set({ channelId: null }).where(itsIssues).returning({ id: issues.id });
      for (const issue of kept) await enqueueIndex(tx, { orgId, kind: "issue", sourceId: issue.id });
    } else {
      await tx.delete(issues).where(itsIssues);
    }
    for (const table of [
      messages,
      threads,
      threadReflections,
      messagePins,
      threadFollows,
      threadReads,
      channelReads,
      channelMembers,
    ]) {
      await tx.delete(table).where(and(eq(table.orgId, orgId), eq(table.channelId, channelId)));
    }
  });
  if (deps.blobs) await dropChannelVoice({ db, blobs: deps.blobs }, orgId, channelId);
}
