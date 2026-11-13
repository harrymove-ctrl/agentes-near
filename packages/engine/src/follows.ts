import { and, type Executor, eq, rowsOf, type SQL, schema, sql } from "@agenteschat/db";

const { threadFollows, messages } = schema;

/**
 * Who follows a thread (the inbox and the phone app's "Seguir"). A person's
 * explicit choice (`thread_follows`) wins: following adds them, unfollowing
 * mutes them even where they wrote. Without one, they follow the threads
 * they started (not a routine's root) or wrote in.
 *
 * Following means: notified of replies (`thread_reply`), and replies count
 * as unread in the channel list.
 */
export function followsThreadSql(orgId: string | SQL, userId: string | SQL, root: SQL): SQL {
  return sql`coalesce(
    (select tf.following from ${threadFollows} tf
      where tf.org_id = ${orgId}::uuid and tf.root_message_id = ${root} and tf.user_id = ${userId}),
    exists (select 1 from ${messages} fr where fr.org_id = ${orgId}::uuid and fr.id = ${root}
      and fr.author_user_id = ${userId} and fr.meta->'routine' is null)
    or exists (select 1 from ${messages} fp where fp.org_id = ${orgId}::uuid and fp.thread_id = ${root}
      and fp.author_user_id = ${userId} and fp.deleted_at is null)
  )`;
}

/** Explicit choices about one thread: who follows it on purpose and who muted it. */
export async function threadFollowChoices(db: Executor, orgId: string, rootId: string) {
  const rows = await db
    .select({ userId: threadFollows.userId, following: threadFollows.following })
    .from(threadFollows)
    .where(and(eq(threadFollows.orgId, orgId), eq(threadFollows.rootMessageId, rootId)));
  return {
    followers: rows.filter((r) => r.following).map((r) => r.userId),
    muted: new Set(rows.filter((r) => !r.following).map((r) => r.userId)),
  };
}

/** When this person last read a thread's replies on their own (`thread_reads`); -infinity if never. */
export function threadReadAtSql(userId: string, root: SQL): SQL {
  return sql`coalesce((select tr.last_read_at from ${schema.threadReads} tr
    where tr.root_message_id = ${root} and tr.user_id = ${userId}), '-infinity'::timestamptz)`;
}

/**
 * Who hears a new message's `channel.activity` (their unread marks): the people in its channel, and for a thread's
 * reply only those following the thread or mentioned in it (a reply elsewhere never counts for them). `dm`: the
 * lists to read again.
 */
export async function activityAudience(
  db: Executor,
  channelId: string,
  threadId: string | null,
  mentioned: readonly string[] = [],
) {
  const named =
    mentioned.length > 0
      ? sql`cm.user_id in (${sql.join(
          mentioned.map((id) => sql`${id}`),
          sql`, `,
        )}) or `
      : sql``;
  const inThread = threadId
    ? sql`and (${named}${followsThreadSql(sql`cm.org_id`, sql`cm.user_id`, sql`${threadId}::uuid`)})`
    : sql``;
  const rows = rowsOf<{ org_id: string; user_id: string; dm: boolean }>(
    await db.execute(sql`select cm.org_id, cm.user_id, (c.kind = 'dm') as dm from ${schema.channelMembers} cm
      join ${schema.channels} c on c.org_id = cm.org_id and c.id = cm.channel_id
      where cm.channel_id = ${channelId}::uuid and cm.user_id is not null ${inThread}`),
  );
  return { orgId: rows[0]?.org_id ?? null, dm: rows[0]?.dm === true, userIds: new Set(rows.map((r) => r.user_id)) };
}
