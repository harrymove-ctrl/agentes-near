import { and, type Executor, eq, isNotNull, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import { maySql } from "./permissions";

const { issues, channels, channelMembers, agents } = schema;

/** Who a task or a wiki page is for (ADR 0151): "only me" is a list of one. Administrators always see it. */
export type Audience = { mode: "everyone" } | { mode: "people"; userIds: string[] };

/** The most people a task's audience names. */
export const AUDIENCE_MAX = 200;

/** A row of `channels` an administrator reads without being in it (ADR 0151): every channel, never a DM. */
export const adminChannelSql = (orgId: unknown, userId: unknown) =>
  and(eq(channels.kind, "channel"), maySql(orgId, userId, "administrator"));

/**
 * Whether `userId` sees the `issues` row `alias` (ADR 0151): an administrator always; a limited task, who it names; else
 * the whole workspace, or who reads the conversation it's tied to (`channel_id`: its members, anyone for a public
 * channel). The workspace membership is the caller's check. Mirrors `personSees` in `issues.ts`.
 */
export function taskSeenSql(alias: string, userId: SQL): SQL {
  const t = sql.raw(alias);
  return sql`(${maySql(sql`${t}.org_id`, userId, "administrator")}
    or (${t}.restricted and ${userId} = any(${t}.audience_user_ids))
    or (not ${t}.restricted and (${t}.channel_id is null
      or exists (select 1 from ${channelMembers} tm where tm.channel_id = ${t}.channel_id and tm.user_id = ${userId})
      or exists (select 1 from ${channels} tc where tc.id = ${t}.channel_id and tc.visibility = 'public'
        and tc.kind = 'channel'))))`;
}

/**
 * A task's conversation (ADR 0145) is read by whoever sees the task, never by its own membership: people are never
 * members of a `task` channel. True when `channelId` is a task's conversation and `userId` sees that task.
 */
export const taskReaderSql = (channelId: SQL, userId: SQL) => sql`exists (
  select 1 from ${issues} ti where ti.conversation_channel_id = ${channelId} and ${taskSeenSql("ti", userId)})`;

/**
 * Whether `userId` reads the channel `channelId`, by the rule of `requireChannelAccess` and `readableChannelIds`: a
 * member, an administrator in a channel (public or private, never a DM), or who sees the task of a task's conversation.
 */
export const channelReaderSql = (channelId: SQL, userId: SQL) => sql`(exists (
    select 1 from ${channelMembers} rm where rm.channel_id = ${channelId} and rm.user_id = ${userId})
  or exists (select 1 from ${channels} rc where rc.id = ${channelId}
    and ((rc.kind = 'channel' and ${maySql(sql`rc.org_id`, userId, "administrator")})
      or (rc.kind = 'task' and ${taskReaderSql(channelId, userId)}))))`;

/** The people of `orgId` who read the channel `channelId` (`channelReaderSql`), as a subquery of `user_id`. */
export const channelReadersSql = (orgId: SQL, channelId: SQL) => sql`(select cr.user_id from organization_members cr
  where cr.org_id = ${orgId} and ${channelReaderSql(channelId, sql`cr.user_id`)})`;

/**
 * The audience an agent picks for what it makes in a conversation (ADR 0151): the workspace from a public channel, and
 * from a room no person reads (a routine's); the people there from a DM or a private channel; from a task's own
 * conversation, who sees that task.
 */
export async function audienceOfConversation(db: Executor, channelId: string): Promise<Audience> {
  const [c] = await db
    .select({
      kind: channels.kind,
      visibility: channels.visibility,
      taskChannelId: issues.channelId,
      restricted: issues.restricted,
      userIds: issues.audienceUserIds,
    })
    .from(channels)
    .leftJoin(issues, eq(issues.conversationChannelId, channels.id))
    .where(eq(channels.id, channelId));
  if (c?.restricted) return { mode: "people", userIds: c.userIds ?? [] };
  if (c?.kind === "task") return c.taskChannelId ? audienceOfConversation(db, c.taskChannelId) : { mode: "everyone" };
  if (!c || (c.kind === "channel" && c.visibility === "public")) return { mode: "everyone" };
  const people = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), isNotNull(channelMembers.userId)));
  return people.length
    ? { mode: "people", userIds: people.flatMap((p) => (p.userId ? [p.userId] : [])) }
    : { mode: "everyone" };
}

/** Of `userIds`, who sees the task `issueId` now. */
export async function taskReadersAmong(db: Executor, issueId: string, userIds: readonly string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = rowsOf<{ user_id: string }>(
    await db.execute(sql`select u.id as user_id from ${schema.users} u, ${issues} t
      where t.id = ${issueId}::uuid and u.id = any(${`{${ids.join(",")}}`}::text[])
        and ${taskSeenSql("t", sql`u.id`)}`),
  );
  return rows.map((r) => r.user_id);
}

/**
 * Agents join a task's conversation as members (so a mention there reaches them like anywhere else) when they see
 * the task: one of the whole workspace, one limited to people (who mentioned it reads it, and an agent reaches what
 * they reach), or one of a channel they are in (or a public one), by current handle (a person's mention). By id: the
 * task's assignee, whoever assigned it saw the task. Returns the agents added now.
 */
export async function admitTaskAgents(
  db: Executor,
  orgId: string,
  channelId: string,
  who: { handles?: string[]; ids?: string[] },
): Promise<string[]> {
  const handles = (who.handles ?? []).filter((h) => /^[a-z0-9_-]+$/.test(h));
  const ids = (who.ids ?? []).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  if (handles.length === 0 && ids.length === 0) return [];
  const rows = rowsOf<{ agent_id: string }>(
    await db.execute(sql`insert into ${channelMembers} (org_id, channel_id, agent_id)
      select a.org_id, ${channelId}::uuid, a.id from ${agents} a
      join ${issues} i on i.conversation_channel_id = ${channelId}::uuid and i.org_id = a.org_id
      where a.org_id = ${orgId}::uuid and a.archived_at is null
        and (a.id = any(${`{${ids.join(",")}}`}::uuid[])
          or (a.handle = any(${`{${handles.join(",")}}`}::text[]) and (i.restricted or i.channel_id is null
            or exists (select 1 from ${channelMembers} am where am.channel_id = i.channel_id and am.agent_id = a.id)
            or exists (select 1 from ${channels} ac where ac.id = i.channel_id and ac.visibility = 'public'
              and ac.kind = 'channel'))))
      on conflict do nothing
      returning agent_id`),
  );
  if (rows.length > 0) caches.channelMembers.delete(`${orgId}:${channelId}`);
  // Its search reaches the conversation it's in now (`agentSearchChannels`).
  for (const r of rows) caches.scopes.deletePrefix(`${orgId}:${r.agent_id}:visible`);
  return rows.map((r) => r.agent_id);
}

/** A column of `artifacts` by its table's name: drizzle writes a bare one in a one-table query, which a subquery takes as its own. */
export const artifactCol = (name: string) => sql.raw(`"artifacts"."${name}"`);

/**
 * Whether a file's sharing (ADR 0157) shows it to `userId` past its conversation, as a condition over `artifacts`: the
 * whole workspace, or a list that names them, holds a role of theirs, or them as an administrator. The workspace
 * membership is the caller's check. `userId` may be a column.
 */
export function fileSharedSql(userId: SQL) {
  const c = artifactCol;
  return sql<boolean>`(${c("share")} = 'everyone' or (${c("share")} = 'people' and (${userId} = any(${c("share_user_ids")})
    or ${maySql(c("org_id"), userId, "administrator")}
    or exists (select 1 from organization_member_roles sr where sr.org_id = ${c("org_id")} and sr.user_id = ${userId}
      and sr.role_id = any(${c("share_role_ids")})))))`;
}

/**
 * Whether `userId` reads a file at all, where it lives (`channelReaderSql`, or a public channel) or through its
 * sharing, as a condition over `artifacts`. Mirrors `personCanRead` in `artifacts.ts`.
 */
export function fileSeenSql(userId: SQL) {
  const c = artifactCol;
  return sql<boolean>`(${c("channel_id")} is null or ${fileSharedSql(userId)}
    or ${channelReaderSql(c("channel_id"), userId)}
    or exists (select 1 from ${channels} pc where pc.id = ${c("channel_id")} and pc.kind = 'channel'
      and pc.visibility = 'public'))`;
}
