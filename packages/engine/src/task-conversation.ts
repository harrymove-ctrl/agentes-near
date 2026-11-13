import { and, type Database, type Executor, eq, inArray, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { quietNoticeSql } from "./notices";
import { admitTaskAgents } from "./task-access";

const { issues, issueActivity, channels, messages, artifacts, users, agents } = schema;

type IssueRow = typeof issues.$inferSelect;

/**
 * A task's conversation (ADR 0145): a channel of kind `task` of its own, read by whoever sees the task, and one
 * thread in it, whose root (`meta.taskConversation`) stands for the task and is never shown; the conversation is
 * that thread's replies, so posting, mentions, runs, receipts, reactions and the thread's screens are the chat's.
 */
export interface TaskConversationMeta {
  issueId: string;
  number: number;
  title: string;
}

export const taskConversationOf = (meta: Record<string, unknown> | null | undefined): TaskConversationMeta | null => {
  const v = meta?.taskConversation as Partial<TaskConversationMeta> | undefined;
  if (!v || typeof v.issueId !== "string" || typeof v.number !== "number" || typeof v.title !== "string") return null;
  return { issueId: v.issueId, number: v.number, title: v.title };
};

export interface TaskConversationRef {
  channelId: string;
  rootId: string;
}

/**
 * The task's conversation, made on first use: its channel, the root, the assignee agent as a member, and the
 * task's old comments (`issue_activity` kind `comment`) moved into it as replies with their authors, times and
 * ids (deleted from the activity in the same transaction; its events stay there as the history). Taken under
 * the issue's row lock, so two first uses make one.
 */
export async function ensureTaskConversation(db: Database, issueId: string): Promise<TaskConversationRef> {
  return db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
    if (!issue) throw new Error("issue not found");
    if (issue.conversationChannelId && issue.conversationRootId) {
      return { channelId: issue.conversationChannelId, rootId: issue.conversationRootId };
    }
    // The creator's account may be gone (deleted): the root and the channel then have no author.
    const creator = issue.createdByType === "person" ? await liveUser(tx, issue.createdById) : null;
    const [channel] = await tx
      .insert(channels)
      .values({
        orgId: issue.orgId,
        // Internal (never listed): unique per workspace, readable in an agent's prompt.
        name: `task-${issue.number}-${issue.id.slice(-6)}`,
        kind: "task",
        visibility: "private",
        createdByUserId: creator,
      })
      .returning({ id: channels.id });
    if (!channel) throw new Error("channel insert returned nothing");
    // Written directly: the root is never shown, indexed, routed or notified (a title's "@ana" mentions nobody).
    const agentAuthor = issue.createdByType === "agent";
    const [root] = await tx
      .insert(messages)
      .values({
        createdAt: issue.createdAt,
        orgId: issue.orgId,
        channelId: channel.id,
        authorType: agentAuthor ? "agent" : "person",
        authorUserId: creator,
        authorAgentId: agentAuthor ? await liveAgent(tx, issue.createdById) : null,
        body: `Task #${issue.number}: ${issue.title}`.slice(0, 2_000),
        meta: { taskConversation: { issueId: issue.id, number: issue.number, title: issue.title } },
      })
      .returning({ id: messages.id });
    if (!root) throw new Error("root insert returned nothing");
    await moveComments(tx, issue, channel.id, root.id);
    await tx
      .update(issues)
      .set({ conversationChannelId: channel.id, conversationRootId: root.id })
      .where(eq(issues.id, issue.id));
    if (issue.assigneeType === "agent" && issue.assigneeId) {
      await admitTaskAgents(tx, issue.orgId, channel.id, { ids: [issue.assigneeId] });
    }
    return { channelId: channel.id, rootId: root.id };
  });
}

async function liveUser(tx: Executor, userId: string) {
  const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return u?.id ?? null;
}

async function liveAgent(tx: Executor, agentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  const [a] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
  return a?.id ?? null;
}

/** The old comments, as replies of the root: same id and time, the author when still there, their files. */
async function moveComments(tx: Executor, issue: IssueRow, channelId: string, rootId: string) {
  const comments = await tx
    .select()
    .from(issueActivity)
    .where(and(eq(issueActivity.issueId, issue.id), eq(issueActivity.kind, "comment")));
  if (comments.length === 0) return;
  const personIds = [...new Set(comments.filter((c) => c.authorType === "person").map((c) => c.authorId))];
  const agentIds = [...new Set(comments.filter((c) => c.authorType === "agent").map((c) => c.authorId))];
  const fileIds = [
    ...new Set(comments.flatMap((c) => ((c.data.attachments as { id: string }[] | undefined) ?? []).map((f) => f.id))),
  ];
  const [people, bots, files] = await Promise.all([
    personIds.length ? tx.select({ id: users.id }).from(users).where(inArray(users.id, personIds)) : [],
    agentIds.length ? tx.select({ id: agents.id }).from(agents).where(inArray(agents.id, agentIds)) : [],
    fileIds.length
      ? tx
          .select({ id: artifacts.id, title: artifacts.title, version: artifacts.currentVersion })
          .from(artifacts)
          .where(and(inArray(artifacts.id, fileIds), isNull(artifacts.deletedAt)))
      : [],
  ]);
  const livePeople = new Set(people.map((p) => p.id));
  const liveAgents = new Set(bots.map((b) => b.id));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const rows = comments.map((c) => {
    const attached = ((c.data.attachments as { id: string }[] | undefined) ?? []).flatMap((f) => {
      const file = fileById.get(f.id);
      return file ? [file] : [];
    });
    const agent = c.authorType === "agent";
    return {
      id: c.id,
      createdAt: c.createdAt,
      orgId: issue.orgId,
      channelId,
      threadId: rootId,
      authorType: agent ? ("agent" as const) : ("person" as const),
      authorUserId: !agent && livePeople.has(c.authorId) ? c.authorId : null,
      authorAgentId: agent && liveAgents.has(c.authorId) ? c.authorId : null,
      body: c.text,
      hop: agent ? 1 : 0,
      meta: { movedFromIssue: true, ...(attached.length ? { artifacts: attached } : {}) },
    };
  });
  // In slices: a statement takes at most 65,535 parameters.
  for (let i = 0; i < rows.length; i += 1_000) await tx.insert(messages).values(rows.slice(i, i + 1_000));
  await tx.delete(issueActivity).where(
    inArray(
      issueActivity.id,
      comments.map((c) => c.id),
    ),
  );
}

/**
 * The tasks with comments from before their conversation existed, moved once (boot, off its path): one query once
 * every task has moved. Postgres can't use the `task` channel kind in the migration that adds it, so the move
 * runs here, after it committed.
 */
export async function moveIssueComments(db: Database): Promise<number> {
  const pending = rowsOf<{ id: string }>(
    await db.execute(sql`select i.id from ${issues} i
      where i.conversation_channel_id is null
        and exists (select 1 from ${issueActivity} a where a.issue_id = i.id and a.kind = 'comment')`),
  );
  let moved = 0;
  let failed: unknown = null;
  // One task that fails keeps its comments where they are (tried again next boot); the others still move.
  for (const p of pending) {
    try {
      await ensureTaskConversation(db, p.id);
      moved++;
    } catch (error) {
      failed ??= error;
    }
  }
  if (failed) throw failed;
  return moved;
}

/** What a task's card and dialog show of its conversation: its replies, who took part, an agent at work now. */
export interface TaskConversationSummary extends TaskConversationRef {
  count: number;
  lastAt: string | null;
  /** The first ones to write, oldest first (at most 5). */
  participants: { type: "person" | "agent"; id: string }[];
  working: boolean;
}

const LIVE = sql`('queued', 'running', 'waiting_approval', 'waiting_input')`;

/** The conversations of these tasks, in one query (a whole board). */
export async function taskConversationSummaries(
  db: Database,
  rows: Pick<IssueRow, "id" | "orgId" | "conversationChannelId" | "conversationRootId">[],
): Promise<Map<string, TaskConversationSummary>> {
  const out = new Map<string, TaskConversationSummary>();
  const withOne = rows.filter((r) => r.conversationChannelId && r.conversationRootId);
  if (withOne.length === 0) return out;
  const orgId = withOne[0]?.orgId as string;
  const ids = `{${withOne.map((r) => r.id).join(",")}}`;
  const shown = sql`m.org_id = i.org_id and m.channel_id = i.conversation_channel_id
    and m.thread_id = i.conversation_root_id and m.deleted_at is null and not ${quietNoticeSql(sql`m.meta`)}`;
  const found = rowsOf<{
    id: string;
    channel_id: string;
    root_id: string;
    count: number | string;
    last_at: Date | string | null;
    participants: { type: "person" | "agent"; id: string }[] | string | null;
    working: boolean | string;
  }>(
    await db.execute(sql`select i.id, i.conversation_channel_id as channel_id, i.conversation_root_id as root_id,
        s.count, s.last_at,
        (select coalesce(json_agg(json_build_object('type', p.author_type, 'id', p.who) order by p.first), '[]')
          from (select m.author_type, coalesce(m.author_user_id, m.author_agent_id::text) as who,
              min(m.created_at) as first
            from ${messages} m where ${shown} and coalesce(m.author_user_id, m.author_agent_id::text) is not null
            group by 1, 2 order by min(m.created_at) limit 5) p) as participants,
        exists (select 1 from ${schema.agentRuns} r where r.org_id = i.org_id
          and r.channel_id = i.conversation_channel_id and r.status in ${LIVE}) as working
      from ${issues} i
      cross join lateral (select count(*)::int as count, max(m.created_at) as last_at from ${messages} m
        where ${shown}) s
      where i.org_id = ${orgId}::uuid and i.id = any(${ids}::uuid[])`),
  );
  for (const r of found) {
    const lastAt = r.last_at === null ? null : new Date(r.last_at).toISOString();
    out.set(r.id, {
      channelId: r.channel_id,
      rootId: r.root_id,
      count: Number(r.count),
      lastAt,
      participants: typeof r.participants === "string" ? JSON.parse(r.participants) : (r.participants ?? []),
      working: r.working === true || r.working === "t",
    });
  }
  return out;
}
