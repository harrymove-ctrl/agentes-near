import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { caches } from "./cache";
import { endOfCategory, requireCategoryInOrg } from "./channel-categories";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishChannelsChanged, publishOrgEvent, publishUserEvent } from "./events";
import { followsThreadSql, threadReadAtSql } from "./follows";
import { landedAfterSql } from "./message-place";
import { type PreviewMeta, previewMediaKind, previewMeta, readableBody } from "./message-preview";
import { quietNoticeSql } from "./notices";
import { clearChannelNotifications, notificationSnippet } from "./notifications";
import {
  can,
  getMembership,
  lockOrgMembers,
  MEMBER_ROLE_IDS,
  type Membership,
  requireActiveMembership,
  requirePermission,
} from "./organizations";
import {
  type ChannelKey,
  channelMaySql,
  channelOverridesSql,
  channelPermissions,
  maySql,
  memberKeysSql,
  memberRankSql,
  parseOverrides,
  resolvePermissions,
} from "./permissions";
import { refuseRightHand } from "./right-hand";
import { isRoutineRoomKey } from "./routine-brief";
import { accountInUse, readRefusal, STANDING_COLUMNS } from "./standing";
import { adminChannelSql, channelReaderSql, channelReadersSql, taskReaderSql } from "./task-access";

const { channels, channelMembers, agents, organizationMembers, organizations, users } = schema;

export type Channel = typeof channels.$inferSelect;

export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

/** The most departments or roles a channel is limited to (ADR 0125), as for an agent's audience. */
export const CHANNEL_ROLES_MAX = 100;

/**
 * A private channel limited to departments or roles (ADR 0125) that `userId` may see and join: they hold one of its
 * roles now. Membership checks stay the only way in to its messages; this only lists it and lets them join.
 */
export function channelAudienceSql(alias: string, userId: SQL): SQL {
  const c = sql.raw(alias);
  return sql`(${c}.visibility = 'private' and cardinality(${c}.audience_role_ids) > 0 and exists (
    select 1 from organization_member_roles cmr where cmr.org_id = ${c}.org_id and cmr.user_id = ${userId}
      and cmr.role_id = any(${c}.audience_role_ids)))`;
}

/**
 * The roles a private channel is limited to (ADR 0125), checked: each a custom role of the workspace (not
 * `everyone`, which is "Público"). A public channel takes none.
 */
export async function channelRoleIds(
  db: Executor,
  orgId: string,
  visibility: "public" | "private",
  roleIds: readonly string[] | undefined,
): Promise<string[]> {
  const wanted = [...new Set(roleIds ?? [])];
  if (wanted.length === 0) return [];
  if (visibility === "public") throw new ValidationError("Only a private channel is limited to roles");
  if (wanted.length > CHANNEL_ROLES_MAX) throw new ValidationError(`At most ${CHANNEL_ROLES_MAX} roles`);
  const known = await db
    .select({ id: schema.orgRoles.id })
    .from(schema.orgRoles)
    .where(
      and(eq(schema.orgRoles.orgId, orgId), eq(schema.orgRoles.kind, "custom"), inArray(schema.orgRoles.id, wanted)),
    );
  if (known.length !== wanted.length) throw new ValidationError("Every role must be one of the workspace's");
  return wanted;
}

/** A person taken out of a channel: who, from where. */
export interface ChannelLeaver {
  channelId: string;
  userId: string;
}

/**
 * Takes people out of channels limited to roles they no longer hold (ADR 0125), in the caller's transaction:
 * `people` lost `roleIds` (taken from them, or deleted), or `channel` stopped taking `roleIds`. Only a channel still
 * limited to roles, and only someone who holds none of its roles now; its creator stays. Someone added by name who
 * never held a dropped role stays too.
 */
export async function dropRoleLeavers(
  tx: Executor,
  orgId: string,
  lost: { people: readonly string[]; roleIds: readonly string[] } | { channelId: string; roleIds: readonly string[] },
): Promise<ChannelLeaver[]> {
  if (lost.roleIds.length === 0) return [];
  const list = (ids: readonly string[]) =>
    sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
  const roles = sql`array[${list(lost.roleIds)}]::uuid[]`;
  const which =
    "people" in lost
      ? lost.people.length === 0
        ? undefined
        : sql`cm.user_id in (${list(lost.people)}) and c.audience_role_ids && ${roles}`
      : sql`c.id = ${lost.channelId}::uuid and exists (select 1 from organization_member_roles held
            where held.org_id = c.org_id and held.user_id = cm.user_id and held.role_id = any(${roles}))`;
  if (!which) return [];
  const rows = rowsOf<{ channel_id: string; user_id: string }>(
    await tx.execute(sql`delete from ${channelMembers} cm using ${channels} c
      where cm.channel_id = c.id and cm.org_id = c.org_id and c.org_id = ${orgId}::uuid and c.kind = 'channel'
        and c.visibility = 'private' and cardinality(c.audience_role_ids) > 0 and cm.user_id is not null
        and ${which}
        and c.created_by_user_id is distinct from cm.user_id
        and not exists (select 1 from organization_member_roles still where still.org_id = c.org_id
          and still.user_id = cm.user_id and still.role_id = any(c.audience_role_ids))
      returning cm.channel_id, cm.user_id`),
  );
  return rows.map((r) => ({ channelId: r.channel_id, userId: r.user_id }));
}

/**
 * Tells everyone that people left channels (after the transaction that took them out): their live subscriptions end
 * first, then their sidebars and the channels hear it. Their notifications from those channels go with them.
 */
export async function announceChannelLeavers(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  leavers: ChannelLeaver[],
) {
  const { pubsub } = deps;
  // Loaded here: questions build on this module.
  const { releaseQuestionsOf } = await import("./questions");
  for (const { channelId, userId } of leavers) {
    caches.channelMembers.delete(`${orgId}:${channelId}`);
    await clearChannelNotifications(deps, orgId, userId, channelId);
    await releaseQuestionsOf(deps, orgId, userId, channelId);
    const removed = {
      type: "channel.member_removed" as const,
      channelId,
      member: { type: "person" as const, id: userId },
    };
    await publishOrgEvent(pubsub, { type: "membership.revoked", orgId, userId, channelId });
    await publishUserEvent(pubsub, orgId, userId, removed);
    await publishChannelEvent(pubsub, removed);
  }
  if (leavers.length > 0) await publishChannelsChanged(pubsub, orgId);
}

export async function createChannel(
  db: Database,
  actorId: string,
  orgId: string,
  input: {
    name: string;
    topic?: string;
    visibility?: "public" | "private";
    /** Private only: people holding one of these roles also see it and may join (ADR 0125). */
    audienceRoleIds?: string[];
    categoryId?: string | null;
  },
  options: { pubsub?: PubSub } = {},
): Promise<Channel> {
  await requirePermission(db, actorId, orgId, "create_channels");
  // Whoever may create a channel may put it in an existing category (arranging categories is for admins).
  const categoryId = input.categoryId ?? null;
  if (categoryId) await requireCategoryInOrg(db, orgId, categoryId);
  const name = input.name.trim().toLowerCase();
  if (name.startsWith("dm-")) throw new ValidationError("Channel names can't start with dm-");
  if (!CHANNEL_NAME_PATTERN.test(name)) {
    throw new ValidationError("channel name: lower-case letters, digits, - or _ (max 80)");
  }
  const visibility = input.visibility ?? "public";
  const audienceRoleIds = await channelRoleIds(db, orgId, visibility, input.audienceRoleIds);
  try {
    const made = await db.transaction(async (tx) => {
      const [channel] = await tx
        .insert(channels)
        .values({
          orgId,
          name,
          topic: input.topic ?? "",
          visibility,
          audienceRoleIds,
          createdByUserId: actorId,
          categoryId,
          position: await endOfCategory(tx, orgId, categoryId),
        })
        .returning();
      if (!channel) throw new Error("channel insert returned nothing");
      await tx.insert(channelMembers).values({ orgId, channelId: channel.id, userId: actorId });
      return channel;
    });
    await publishChannelsChanged(options.pubsub, orgId);
    return made;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`#${name} already exists`);
    throw error;
  }
}

/** The most unread messages counted per channel (clients show "99+"). */
export const MAX_CHANNEL_UNREAD = 100;
/** Length of a channel's last-message preview (plain text). */
export const CHANNEL_PREVIEW_LENGTH = 140;

export interface ChannelLastMessage {
  id: string;
  authorType: "person" | "agent";
  authorId: string | null;
  /** Null when the author was deleted. */
  authorName: string | null;
  /** Plain text, at most `CHANNEL_PREVIEW_LENGTH` chars. */
  preview: string;
  /** What the app needs to show a server-written body in the reader's language; null for a plain message. */
  meta: PreviewMeta | null;
  /** A GIF or a sticker sent with no text (ADR 0091): the app says which where `preview` is empty; else null. */
  mediaKind: "gif" | "sticker" | "voice" | null;
  createdAt: Date;
}

export interface ChannelListItem {
  id: string;
  orgId: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  /** Private and limited to these roles (ADR 0125); empty otherwise. */
  audienceRoleIds: string[];
  createdByUserId: string | null;
  createdAt: Date;
  /** Its sidebar category; null: on top, with none. */
  categoryId: string | null;
  /** Order inside its category. */
  position: number;
  isMember: boolean;
  /** Listed only because I'm an administrator (ADR 0151): the apps keep it off the sidebar until opened or joined. */
  seenAsAdmin: boolean;
  /**
   * Messages since I last read it (from when I joined, if never), not mine;
   * a thread reply counts only in a thread I follow. At most
   * `MAX_CHANNEL_UNREAD`; 0 when I'm not a member.
   */
  unreadCount: number;
  /** Of those, the ones that mention me (the sidebar's number, even while muted). */
  mentionCount: number;
  /** Where the unread starts: when I last read it (or joined); null when I'm not a member. */
  lastReadAt: Date | null;
  /** I muted it: it never looks unread to me. */
  muted: boolean;
  /**
   * What I may do here, with its exceptions (ADR 0134): send messages (`post`), wake its agents (`talk_to_agents`)
   * and manage it (`managesChannel`).
   */
  can: { post: boolean; callAgents: boolean; manage: boolean };
  /**
   * The latest top-level message, skipping a routine's call (hidden in the chat, only the agent's answer
   * shows); null when I'm not a member (I can't read it) or it's empty.
   */
  lastMessage: ChannelLastMessage | null;
}

interface ChannelListRow {
  id: string;
  org_id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  audience_role_ids: string[] | string;
  created_by_user_id: string | null;
  created_at: Date | string;
  category_id: string | null;
  position: number | string;
  is_member: boolean;
  seen_as_admin: boolean;
  unread_count: number | string | null;
  mention_count: number | string | null;
  last_read_at: Date | string | null;
  muted: boolean | null;
  last_id: string | null;
  last_body: string | null;
  last_meta: Record<string, unknown> | null;
  last_at: Date | string | null;
  last_author_type: "person" | "agent" | null;
  last_user_id: string | null;
  last_agent_id: string | null;
  last_author_name: string | null;
  can_post: boolean;
  can_call: boolean;
  can_manage: boolean;
}

const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));
/** A uuid[] from a raw query: an array, or its text form (`{a,b}`) on some drivers. */
const uuidArray = (v: string[] | string | null) =>
  Array.isArray(v) ? v : v && v !== "{}" ? v.slice(1, -1).split(",") : [];

/**
 * Channels the user can see: every public channel, private ones they
 * belong to and those limited to a role they hold (ADR 0125), and for an administrator all of them (ADR 0151), in sidebar order (then by name), with their unread count and last message, in one
 * query (a lateral read per channel on `(channel_id, created_at)`).
 */
export async function listChannels(db: Database, userId: string, orgId: string): Promise<ChannelListItem[]> {
  await requirePermission(db, userId, orgId, "read");
  // Message `u` I haven't read in channel `c`: not mine, landed after my read (or my joining), a thread's reply only in
  // one I follow or that mentions me, and haven't read there.
  const u = { createdAt: sql`u.created_at`, id: sql`u.id` };
  const unread = sql`cm.id is not null and u.org_id = ${orgId}::uuid and u.channel_id = c.id and u.deleted_at is null
    and ${landedAfterSql(u, sql`coalesce(cr.last_read_at, cm.created_at)`)}
    and (u.author_user_id is null or u.author_user_id <> ${userId})
    and not ${quietNoticeSql(sql`u.meta`)}
    and (u.thread_id is null or ((${userId} = any(u.mentioned_user_ids)
        or ${followsThreadSql(orgId, userId, sql`u.thread_id`)})
      and ${landedAfterSql(u, threadReadAtSql(userId, sql`u.thread_id`))}))
    -- Nor one more unread (ADR 0091): it is silent.
    and u.meta->>'mediaAfter' is null`;
  const rows = rowsOf<ChannelListRow>(
    await db.execute(sql`select c.id, c.org_id, c.name, c.topic, c.visibility, c.audience_role_ids, c.created_by_user_id, c.created_at,
        c.category_id, c.position,
        (cm.id is not null) as is_member,
        (cm.id is null and c.visibility <> 'public' and not ${channelAudienceSql("c", sql`${userId}`)}) as seen_as_admin,
        coalesce(un.n, 0) as unread_count, coalesce(un.m, 0) as mention_count,
        coalesce(cr.muted, false) as muted, coalesce(cr.last_read_at, cm.created_at) as last_read_at,
        lm.id as last_id, lm.body as last_body, lm.meta as last_meta, lm.created_at as last_at, lm.author_type as last_author_type,
        lm.author_user_id as last_user_id, lm.author_agent_id as last_agent_id,
        coalesce(lu.name, la.name) as last_author_name,
        ${channelCanSql(orgId, userId, "post")} as can_post,
        ${channelCanSql(orgId, userId, "talk_to_agents")} as can_call,
        (${maySql(sql`${orgId}::uuid`, sql`${userId}::text`, "manage_channels")} or (cm.id is not null
          and (c.created_by_user_id = ${userId} or ${channelCanSql(orgId, userId, "manage_channels")}))) as can_manage
      from ${channels} c
      left join ${channelMembers} cm on cm.org_id = c.org_id and cm.channel_id = c.id and cm.user_id = ${userId}
      left join ${schema.channelReads} cr on cr.channel_id = c.id and cr.user_id = ${userId}
      left join lateral (
        select m.id, m.body, m.meta, m.created_at, m.author_type, m.author_user_id, m.author_agent_id
        from ${schema.messages} m
        where cm.id is not null and m.org_id = ${orgId}::uuid and m.channel_id = c.id
          and m.thread_id is null and m.deleted_at is null
          and not (m.author_type = 'person' and m.meta->'routine' is not null)
          and not ${quietNoticeSql(sql`m.meta`)}
          -- An agent's sticker or GIF after its own reply (ADR 0091) is part of that reply: the reply is the preview.
          and m.meta->>'mediaAfter' is null
        order by m.created_at desc, m.id desc
        limit 1
      ) lm on true
      left join ${schema.users} lu on lu.id = lm.author_user_id
      left join ${agents} la on la.id = lm.author_agent_id
      left join lateral (
        select
          (select count(*)::int from (select 1 from ${schema.messages} u where ${unread} limit ${MAX_CHANNEL_UNREAD}) x) as n,
          -- Mentions apart, capped on their own: a busy channel's first 100 unread may not hold the one that names me.
          (select count(*)::int from (select 1 from ${schema.messages} u
            where ${unread} and ${userId} = any(u.mentioned_user_ids) limit ${MAX_CHANNEL_UNREAD}) y) as m
      ) un on true
      where c.org_id = ${orgId}::uuid and c.archived_at is null and c.kind = 'channel'
        and (c.visibility = 'public' or cm.id is not null or ${channelAudienceSql("c", sql`${userId}`)}
          or ${maySql(sql`${orgId}::uuid`, sql`${userId}::text`, "administrator")})
      order by c.position asc, c.name asc`),
  );
  return rows.map((r) => {
    const stored = r.last_meta;
    const lastMeta: Record<string, unknown> | null = typeof stored === "string" ? JSON.parse(stored) : stored;
    return {
      id: r.id,
      orgId: r.org_id,
      name: r.name,
      topic: r.topic,
      visibility: r.visibility,
      audienceRoleIds: uuidArray(r.audience_role_ids),
      createdByUserId: r.created_by_user_id,
      createdAt: asDate(r.created_at),
      categoryId: r.category_id,
      position: Number(r.position),
      isMember: r.is_member === true,
      seenAsAdmin: r.seen_as_admin === true,
      unreadCount: Number(r.unread_count ?? 0),
      mentionCount: Number(r.mention_count ?? 0),
      lastReadAt: r.last_read_at ? asDate(r.last_read_at) : null,
      muted: r.muted === true,
      can: { post: r.can_post === true, callAgents: r.can_call === true, manage: r.can_manage === true },
      lastMessage:
        r.last_id && r.last_at && r.last_author_type
          ? {
              id: r.last_id,
              authorType: r.last_author_type,
              authorId: r.last_author_type === "person" ? r.last_user_id : r.last_agent_id,
              authorName: r.last_author_name,
              preview: notificationSnippet(readableBody(r.last_body ?? "", lastMeta), CHANNEL_PREVIEW_LENGTH),
              meta: previewMeta(lastMeta),
              mediaKind: previewMediaKind(r.last_body, lastMeta),
              createdAt: asDate(r.last_at),
            }
          : null,
    };
  });
}

/** A `#channel` link's card: what the channel is, how many are in it, and whether I am. */
export interface ChannelCard {
  id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  /** Private and limited to these roles (ADR 0125): I hold one, or I'm in it. */
  audienceRoleIds: string[];
  isMember: boolean;
  archived: boolean;
  /** People in it. */
  people: number;
  /** Agents in it (not archived). */
  agents: number;
}

/**
 * The card of a channel I can see: public, private and mine, limited to a role I hold, or any for an administrator; archived ones too. Any other id (a private
 * channel I'm not in, a DM, another organization's) is "not found", so a link tells nothing about it.
 */
export async function channelCard(
  db: Database,
  userId: string,
  orgId: string,
  channelId: string,
): Promise<ChannelCard> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = rowsOf<{
    id: string;
    name: string;
    topic: string;
    visibility: "public" | "private";
    audience_role_ids: string[] | string;
    archived: boolean;
    is_member: boolean;
    by_role: boolean;
    admin: boolean;
    people: number | string;
    agents: number | string;
  }>(
    await db.execute(sql`select c.id, c.name, c.topic, c.visibility, c.audience_role_ids,
        (c.archived_at is not null) as archived, ${channelAudienceSql("c", sql`${userId}`)} as by_role,
        ${maySql(sql`${orgId}::uuid`, sql`${userId}::text`, "administrator")} as admin,
        exists (select 1 from ${channelMembers} m where m.channel_id = c.id and m.user_id = ${userId}) as is_member,
        (select count(*) from ${channelMembers} m where m.channel_id = c.id and m.user_id is not null) as people,
        (select count(*) from ${channelMembers} m join ${agents} a on a.id = m.agent_id
          where m.channel_id = c.id and a.archived_at is null) as agents
      from ${channels} c
      where c.id = ${channelId}::uuid and c.org_id = ${orgId}::uuid and c.kind = 'channel'`),
  );
  if (!row || (row.visibility === "private" && row.is_member !== true && row.by_role !== true && row.admin !== true))
    throw new NotFoundError("Channel not found");
  return {
    id: row.id,
    name: row.name,
    topic: row.topic,
    visibility: row.visibility,
    audienceRoleIds: uuidArray(row.audience_role_ids),
    isMember: row.is_member === true,
    archived: row.archived === true,
    people: Number(row.people),
    agents: Number(row.agents),
  };
}

export async function isChannelMember(db: Executor, orgId: string, channelId: string, userId: string) {
  const [row] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
    );
  return row !== undefined;
}

/**
 * Every person who reads `hereId` also reads `thereId` (`channelReaderSql`, so an administrator outside a channel
 * counts): what `thereId` says may be repeated in `hereId`.
 */
export async function peopleAllIn(db: Executor, orgId: string, hereId: string, thereId: string) {
  const [row] = rowsOf<{ ok: boolean }>(
    await db.execute(sql`select not exists (
        select 1 from ${channelReadersSql(sql`${orgId}::uuid`, sql`${hereId}::uuid`)} h
        where not ${channelReaderSql(sql`${thereId}::uuid`, sql`h.user_id`)}
      ) as ok`),
  );
  return row?.ok === true;
}

/** Of `channelIds`, what a person reads (`readableChannelIds`), and public channels, which they may join at will. */
export async function readsOrMayJoin(db: Database, orgId: string, userId: string, channelIds: readonly string[]) {
  const reads = await readableChannelIds(db, orgId, userId, channelIds);
  for (const id of await publicChannelIds(db, orgId, channelIds)) reads.add(id);
  return reads;
}

/** Which of `channelIds` are public channels, which anyone in the workspace may join and read. */
export async function publicChannelIds(db: Database, orgId: string, channelIds: readonly string[]) {
  const open = channelIds.length
    ? await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.orgId, orgId),
            inArray(channels.id, [...new Set(channelIds)]),
            eq(channels.kind, "channel"),
            eq(channels.visibility, "public"),
            isNull(channels.archivedAt),
          ),
        )
    : [];
  return new Set(open.map((c) => c.id));
}

/**
 * What the right hand reads for a person in their DM with it (ADR 0137 §13): `readsOrMayJoin` over the workspace, never
 * a routine's room, which is its own runs' (`agentSearchChannels`).
 */
export async function personReach(db: Database, orgId: string, userId: string) {
  const rows = await db
    .select({ id: channels.id, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), isNull(channels.archivedAt), isNull(channels.deletedAt)));
  const ids = rows.filter((c) => !isRoutineRoomKey(c.dmKey)).map((c) => c.id);
  return [...(await readsOrMayJoin(db, orgId, userId, ids))];
}

/**
 * Which of `channelIds` a person reads, by the rule of `requireChannelAccess`: a member, an administrator in a channel,
 * or a task's reader; archived channels left out. For screens that quote a conversation outside it (run history).
 */
export async function readableChannelIds(
  db: Executor,
  orgId: string,
  userId: string,
  channelIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .leftJoin(
      channelMembers,
      and(
        eq(channelMembers.channelId, channels.id),
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.userId, userId),
      ),
    )
    .where(
      and(
        eq(channels.orgId, orgId),
        inArray(channels.id, ids),
        isNull(channels.archivedAt),
        or(
          isNotNull(channelMembers.id),
          and(eq(channels.kind, "task"), taskReaderSql(sql`${channels.id}`, sql`${userId}::text`)),
          adminChannelSql(sql`${orgId}::uuid`, sql`${userId}::text`),
        ),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * The single authorization check for reading a channel (HTTP and WebSocket):
 * the user belongs to the organization (a blocked account belongs nowhere,
 * as in `getMembership`), the channel belongs to that organization, and the
 * user is a member of the channel or an administrator, who reads every channel
 * without joining it but never someone else's DM (ADR 0151).
 */
export async function requireChannelAccess(db: Database, userId: string, orgId: string, channelId: string) {
  // One round trip: membership of the org, the channel, and membership of the channel.
  const [row] = await db
    .select({
      role: organizationMembers.role,
      keys: memberKeysSql({ orgId: organizationMembers.orgId, userId: organizationMembers.userId }),
      rank: memberRankSql({ orgId: organizationMembers.orgId, userId: organizationMembers.userId }),
      roleIds: MEMBER_ROLE_IDS,
      orgName: organizations.name,
      standing: STANDING_COLUMNS,
      channel: channels,
      memberId: channelMembers.id,
      overrides: channelOverridesSql(organizationMembers.orgId, sql`${channelId}::uuid`, organizationMembers.userId),
      taskReader: sql<boolean>`${channels.kind} = 'task' and ${taskReaderSql(sql`${channelId}::uuid`, sql`${userId}::text`)}`,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(channels, and(eq(channels.id, channelId), eq(channels.orgId, orgId)))
    .leftJoin(
      channelMembers,
      and(eq(channelMembers.channelId, channelId), eq(channelMembers.orgId, orgId), eq(channelMembers.userId, userId)),
    )
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId), accountInUse));
  if (!row) throw new ForbiddenError("You are not a member of this organization");
  const closed = readRefusal(row.standing);
  if (closed) throw closed;
  const channel = row.channel;
  if (!channel || channel.archivedAt) throw new NotFoundError("Channel not found");
  const permissions = resolvePermissions(row.role === "owner", row.keys);
  const reads = row.memberId || (channel.kind === "channel" && permissions.has("administrator"));
  // A task's conversation is read by whoever sees the task (ADR 0145), always checked again: people are never its members.
  if (channel.kind === "task" ? !(row.taskReader === true || String(row.taskReader) === "t") : !reads)
    throw new ForbiddenError("Join this channel first");
  const workspace: Membership = {
    orgId,
    orgName: row.orgName,
    role: row.role,
    permissions,
    rank: row.rank,
    roleIds: row.roleIds,
    standing: row.standing,
  };
  // Their keys in this channel (ADR 0134): what every check after this one reads (`can`, `speakerOf`).
  const membership = {
    ...workspace,
    permissions: channelPermissions(workspace.permissions, parseOverrides(row.overrides)),
  };
  return { channel, membership, workspace };
}

/** The refusal to post for someone `requireChannelAccess` found can't: `channel.post_denied` when only this channel's exceptions stop them. */
export const postRefusal = (workspace: Membership) =>
  can(workspace, "post")
    ? new ForbiddenError("You can't send messages in this channel", "channel.post_denied")
    : new ForbiddenError();

/**
 * Joins a public channel, or a private one limited to a role the person holds (ADR 0125), or any channel for an
 * administrator (ADR 0151). Other private channels need an invitation from a member.
 */
export async function joinChannel(
  db: Database,
  userId: string,
  orgId: string,
  channelId: string,
  options: { pubsub?: PubSub } = {},
) {
  const membership = await requirePermission(db, userId, orgId, "read");
  const [channel] = await db
    .select({
      kind: channels.kind,
      visibility: channels.visibility,
      byRole: channelAudienceSql("channels", sql`${userId}`),
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel) throw new NotFoundError("Channel not found");
  const admin = channel.kind === "channel" && can(membership, "administrator");
  if (channel.kind === "dm" || (channel.visibility !== "public" && channel.byRole !== true && !admin))
    throw new ForbiddenError("This channel is private");
  // The channel's members column shows them at once (a join from a channel's preview or the browser).
  const joined = async () => {
    caches.channelMembers.delete(`${orgId}:${channelId}`);
    await publishChannelEvent(options.pubsub, {
      type: "channel.member_added",
      channelId,
      member: { type: "person", id: userId },
    });
    await publishChannelsChanged(options.pubsub, orgId);
  };
  if (channel.visibility === "public" || admin) {
    await db.insert(channelMembers).values({ orgId, channelId, userId }).onConflictDoNothing();
    await joined();
    return;
  }
  // Checked again in the insert, under the lock that taking a role away holds (setMemberRoles, deleteRole,
  // updateChannel): a removal at the same moment either sees this membership and drops it, or wins and this refuses.
  const byRole = await db.transaction(async (tx) => {
    await lockOrgMembers(tx, orgId);
    const rows = rowsOf(
      await tx.execute(sql`insert into ${channelMembers} (org_id, channel_id, user_id)
        select c.org_id, c.id, ${userId} from ${channels} c
        where c.id = ${channelId}::uuid and c.org_id = ${orgId}::uuid and ${channelAudienceSql("c", sql`${userId}`)}
        on conflict do nothing returning 1`),
    );
    if (rows.length > 0) return true;
    return isChannelMember(tx, orgId, channelId, userId);
  });
  if (!byRole) throw new ForbiddenError("This channel is private");
  await joined();
}

/**
 * Who manages a channel (its name, members, category, archiving, exceptions): `manage_channels`, or, only while still
 * in it, its creator or someone a channel exception lets manage it (ADR 0134), so nobody taken out of it can put
 * himself back. The apps read it from `ChannelListItem.can.manage`.
 */
export async function managesChannel(
  db: Database,
  membership: Membership,
  actorId: string,
  channel: { id: string; orgId: string; createdByUserId: string | null },
) {
  if (can(membership, "manage_channels")) return true;
  const [row] = rowsOf<{ member: boolean; overrides: Parameters<typeof parseOverrides>[0] }>(
    await db.execute(sql`select exists (select 1 from ${channelMembers} cm where cm.org_id = ${channel.orgId}::uuid
        and cm.channel_id = ${channel.id}::uuid and cm.user_id = ${actorId}) as member,
      ${channelOverridesSql(sql`${channel.orgId}::uuid`, sql`${channel.id}::uuid`, sql`${actorId}::text`)} as overrides`),
  );
  if (row?.member !== true) return false;
  return (
    channel.createdByUserId === actorId ||
    channelPermissions(membership.permissions, parseOverrides(row.overrides)).has("manage_channels")
  );
}

/** `channelMaySql` for one channel and person, for the channel list's `can`. */
const channelCanSql = (orgId: string, userId: string, key: ChannelKey) =>
  channelMaySql(sql`${orgId}::uuid`, sql`c.id`, sql`${userId}::text`, key);

/**
 * Where `actorId` may put an agent of theirs (or any, with `manage_agents`) or take it out (ADR 0085 §5): a channel
 * they're in and may post in or created, or any with `manage_channels`. One rule for an agent's page
 * (`setAgentChannels`) and a channel's members; the apps mirror it (`addsAgentsTo` in packages/client).
 */
export const placesAgentsIn = (
  membership: Membership,
  actorId: string,
  channel: { createdByUserId: string | null },
  actorIn: boolean,
) =>
  (actorIn && (can(membership, "post") || channel.createdByUserId === actorId)) || can(membership, "manage_channels");

/**
 * Refuses unless `actorId` may put `agentId` in `channel` or take it out: the agent theirs or `manage_agents`, and
 * `placesAgentsIn`.
 */
async function requirePlacesAgent(
  db: Database,
  membership: Membership,
  actorId: string,
  channel: Channel,
  agentId: string,
) {
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, channel.orgId), isNull(agents.archivedAt)));
  if (!agent) throw new ValidationError("That agent does not exist in this organization");
  if (agent.ownerUserId !== actorId && !can(membership, "manage_agents")) {
    throw new ForbiddenError("Only an admin or the agent's owner can change where it works");
  }
  if (!placesAgentsIn(membership, actorId, channel, await isChannelMember(db, channel.orgId, channel.id, actorId))) {
    throw new ForbiddenError("An agent joins or leaves only the channels you're in or manage");
  }
}

/**
 * Adds a person or an agent of the same organization to a channel. A person:
 * the channel's creator or `manage_channels`. An agent: `requirePlacesAgent`,
 * as on its page (an agent works only where its owner or an admin allowed it).
 * `autoReply` (agents): the router may pick it here without a mention.
 * Members see `channel.member_added`; an added person also gets it on their
 * own topic so the channel shows up in their sidebar. The router reads
 * members from the database, so it sees the change on the next message.
 */
export async function addChannelMember(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  member: { userId: string } | { agentId: string; autoReply?: boolean },
  options: { pubsub?: PubSub } = {},
) {
  // Admins manage members of any channel, also private ones they're not in.
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId), isNull(channels.archivedAt)));
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.kind === "dm") throw new ValidationError("A direct conversation keeps its participants");
  if ("userId" in member) {
    if (!(await managesChannel(db, membership, actorId, channel))) {
      throw new ForbiddenError("Only the channel's creator or an admin can add members", "channel.members_forbidden");
    }
    if (!(await getMembership(db, member.userId, orgId))) {
      throw new ValidationError("That person is not a member of this organization");
    }
    await db.insert(channelMembers).values({ orgId, channelId, userId: member.userId }).onConflictDoNothing();
    caches.channelMembers.delete(`${orgId}:${channelId}`);
    const event = {
      type: "channel.member_added" as const,
      channelId,
      member: { type: "person" as const, id: member.userId },
    };
    await publishChannelEvent(options.pubsub, event);
    await publishUserEvent(options.pubsub, orgId, member.userId, event);
    await publishChannelsChanged(options.pubsub, orgId);
    return;
  }
  // In no channel: an @mention reaches it anywhere (ADR 0137).
  await refuseRightHand(db, orgId, member.agentId, "added to a channel");
  await requirePlacesAgent(db, membership, actorId, channel, member.agentId);
  const autoReply = member.autoReply ?? true;
  await db
    .insert(channelMembers)
    .values({ orgId, channelId, agentId: member.agentId, autoReply })
    .onConflictDoUpdate({ target: [channelMembers.channelId, channelMembers.agentId], set: { autoReply } });
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  caches.scopes.deletePrefix(`${orgId}:${member.agentId}:visible`);
  await publishChannelEvent(options.pubsub, {
    type: "channel.member_added",
    channelId,
    member: { type: "agent", id: member.agentId, autoReply },
  });
  await publishChannelsChanged(options.pubsub, orgId);
}

/**
 * Turns an agent's auto-reply in one channel on or off (creator, admin or
 * the agent's owner). Off: it answers there only when @mentioned.
 */
export async function setChannelAgentAutoReply(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  agentId: string,
  autoReply: boolean,
  options: { pubsub?: PubSub } = {},
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [row] = await db
    .select({ createdBy: channels.createdByUserId, ownerUserId: agents.ownerUserId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .innerJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(
      and(
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.agentId, agentId),
      ),
    );
  if (!row) throw new NotFoundError("That agent is not in this channel");
  if (
    row.ownerUserId !== actorId &&
    !(await managesChannel(db, membership, actorId, { id: channelId, orgId, createdByUserId: row.createdBy }))
  ) {
    throw new ForbiddenError("Only the channel's creator, an admin or the agent's owner can change this");
  }
  await db
    .update(channelMembers)
    .set({ autoReply })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, agentId)));
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  await publishChannelEvent(options.pubsub, {
    type: "channel.member_updated",
    channelId,
    member: { type: "agent", id: agentId, autoReply },
  });
  await publishChannelsChanged(options.pubsub, orgId);
}

export async function listChannelMembers(db: Database, actorId: string, orgId: string, channelId: string) {
  await requireChannelAccess(db, actorId, orgId, channelId);
  const rows = await db
    .select({ userId: channelMembers.userId, agentId: channelMembers.agentId })
    .from(channelMembers)
    .leftJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), isNull(agents.archivedAt)));
  return rows.map((r) =>
    r.userId ? { type: "person" as const, id: r.userId } : { type: "agent" as const, id: r.agentId ?? "" },
  );
}

/**
 * Removes a person or an agent from a channel. Allowed for yourself (leave),
 * the channel's creator, and admins; an agent also for whoever may put it
 * there (`requirePlacesAgent`). Publishes `membership.revoked` so open
 * WebSocket subscriptions of that person end immediately.
 */
export async function removeChannelMember(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  member: { userId: string } | { agentId: string },
  options: { pubsub?: PubSub } = {},
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel) throw new NotFoundError("Channel not found");
  const self = "userId" in member && member.userId === actorId;
  if (self && channel.kind !== "channel") throw new ValidationError("Only a channel can be left", "channel.leave_kind");
  // Every person joins #general with the workspace: it is how they all hear the same thing.
  if (self && channel.name === "general")
    throw new ValidationError("Everyone stays in #general", "channel.general_stays");
  if (!self && !(await managesChannel(db, membership, actorId, channel))) {
    if ("userId" in member)
      throw new ForbiddenError(
        "Only the channel's creator or an admin can remove members",
        "channel.members_forbidden",
      );
    await requirePlacesAgent(db, membership, actorId, channel, member.agentId);
  }
  const gone = await db
    .delete(channelMembers)
    .where(
      and(
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.channelId, channelId),
        "userId" in member ? eq(channelMembers.userId, member.userId) : eq(channelMembers.agentId, member.agentId),
      ),
    )
    .returning({ channelId: channelMembers.channelId });
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  // The last person out of a private channel: nobody could reach it again, so it closes (its messages are kept).
  if (self && gone.length > 0 && channel.visibility === "private" && !channel.archivedAt) {
    const [stays] = await db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), isNotNull(channelMembers.userId)))
      .limit(1);
    if (!stays) await closeChannel(db, orgId, channelId, options);
  }
  if ("userId" in member) {
    await announceChannelLeavers({ db, pubsub: options.pubsub }, orgId, [{ channelId, userId: member.userId }]);
    return;
  }
  caches.scopes.deletePrefix(`${orgId}:${member.agentId}:visible`);
  await publishChannelEvent(options.pubsub, {
    type: "channel.member_removed",
    channelId,
    member: { type: "agent", id: member.agentId },
  });
  await publishChannelsChanged(options.pubsub, orgId);
}

/** The channel, when `actorId` may archive it or bring it back: its creator or an admin. */
async function archivableChannel(db: Database, actorId: string, orgId: string, channelId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel) throw new NotFoundError("Channel not found");
  if (!(await managesChannel(db, membership, actorId, channel))) {
    throw new ForbiddenError("Only the channel's creator or an admin can archive it");
  }
  return channel;
}

/** Archives a channel (creator or admin). Live subscriptions to it end at once. `general` can't be archived. */
export async function archiveChannel(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  options: { pubsub?: PubSub } = {},
) {
  const channel = await archivableChannel(db, actorId, orgId, channelId);
  if (channel.name === "general") throw new ValidationError("#general can't be archived");
  await closeChannel(db, orgId, channelId, options);
}

/** Takes a channel off everyone's list, at once for who has it open. */
async function closeChannel(db: Database, orgId: string, channelId: string, options: { pubsub?: PubSub }) {
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channelId));
  caches.channels.delete(`${orgId}:${channelId}`);
  await publishOrgEvent(options.pubsub, { type: "channel.archived", orgId, channelId });
  await publishChannelsChanged(options.pubsub, orgId);
}

/**
 * The archived channels a person may bring back (`unarchiveChannel`: their creator or who manages channels), the
 * latest first: the way back once the archive's Desfazer is gone. A deleted one is being purged and never shows.
 */
export async function listArchivedChannels(db: Database, actorId: string, orgId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  // Who doesn't manage every channel manages only some of those they're in: the others are never read.
  const theirs = can(membership, "manage_channels")
    ? undefined
    : sql`exists (select 1 from ${channelMembers} cm where cm.org_id = ${orgId}::uuid and cm.channel_id = ${channels.id}
        and cm.user_id = ${actorId})`;
  const rows = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.kind, "channel"),
        isNotNull(channels.archivedAt),
        isNull(channels.deletedAt),
        theirs,
      ),
    )
    .orderBy(desc(channels.archivedAt))
    .limit(200);
  const mine: { id: string; name: string; topic: string; visibility: "public" | "private"; archivedAt: string }[] = [];
  for (const c of rows) {
    if (isRoutineRoomKey(c.dmKey) || !c.archivedAt || !(await managesChannel(db, membership, actorId, c))) continue;
    mine.push({
      id: c.id,
      name: c.name,
      topic: c.topic,
      visibility: c.visibility,
      archivedAt: c.archivedAt.toISOString(),
    });
  }
  return mine;
}

/** Brings an archived channel back as it was (creator or admin): "Refazer" after an agent's channel was undone. */
export async function unarchiveChannel(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  options: { pubsub?: PubSub } = {},
) {
  const channel = await archivableChannel(db, actorId, orgId, channelId);
  // A deleted channel is archived for good: its contents are being purged.
  if (channel.deletedAt) throw new NotFoundError("Channel not found");
  await db.update(channels).set({ archivedAt: null }).where(eq(channels.id, channelId));
  caches.channels.delete(`${orgId}:${channelId}`);
  await publishChannelsChanged(options.pubsub, orgId);
}
