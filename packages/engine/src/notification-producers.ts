import { and, asc, eq, inArray, isNotNull, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import type { PlanModel } from "@agenteschat/providers/plans";
import { approvalCardThreads, approvalOriginOf, notifiedIds } from "./approvals";
import { accountablePerson, runAuthorityById } from "./authority";
import { autonomyNoteFor, proposalCardOf } from "./brakes";
import { readableChannelIds } from "./channels";
import { threadFollowChoices } from "./follows";
import { type TaskEnd, taskEndLine } from "./machine-task-text";
import { isMediaAfterReply } from "./media";
import { type PreviewMeta, previewMediaKind, previewMeta, readableBody } from "./message-preview";
import { isQuietNotice } from "./notices";
import {
  dropRunFailure,
  joinRunFailure,
  type NotificationActor,
  type NotificationDeps,
  type NotificationSource,
  notificationSnippet,
  notify,
  remindNotifications,
  resolveNotifications,
  retargetNotifications,
} from "./notifications";
import { maySql, type RolePermission } from "./permissions";
import { secretLabelOf } from "./secrets";
import { stretchCardOf } from "./stretch";
import { adminChannelSql, taskReadersAmong } from "./task-access";
import { teamWeekCardOf } from "./team-week";

/**
 * Where notifications come from: each flow calls one of these after
 * its change committed. They read what they need themselves (no imports of
 * the flows' modules, so no import cycles) and never throw into the flow:
 * callers add `.catch(() => {})`.
 */

const {
  messages,
  channels,
  channelMembers,
  threads,
  agents,
  organizationMembers,
  issues,
  issueActivity,
  missions,
  missionParticipants,
  routines,
  messageReactions,
  machines,
  approvals,
  notifications,
} = schema;

type ApprovalRow = typeof schema.approvals.$inferSelect;
type QuestionRow = typeof schema.agentQuestions.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type MissionRow = typeof missions.$inferSelect;

const person = (id: string | null | undefined): NotificationActor | null => (id ? { type: "user", id } : null);
const agent = (id: string | null | undefined): NotificationActor | null => (id ? { type: "agent", id } : null);

/** `@handle` tokens (same rule as chat mentions), lower-cased. */
function handlesIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/g)) {
    if (m[2]) found.add(m[2].toLowerCase());
  }
  return [...found];
}

/** The people among `userIds` who read the channel: its members and, in a channel, administrators. A DM stays its own. */
async function inChannel(deps: NotificationDeps, channelId: string, userIds: string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = rowsOf<{ id: string }>(
    await deps.db.execute(sql`select u.id from ${schema.users} u join ${channels} on ${channels.id} = ${channelId}::uuid
      where u.id = any(${`{${ids.join(",")}}`}::text[]) and (exists (select 1 from ${channelMembers} m
        where m.channel_id = ${channels.id} and m.user_id = u.id) or ${adminChannelSql(sql`${channels.orgId}`, sql`u.id`)})`),
  );
  return rows.map((r) => r.id);
}

/**
 * Who hears about a run's requests (questions, browser handoffs): the person accountable for it
 * (`accountablePerson`: the person behind it, else the routine's creator), or null (the caller falls
 * back to the agent's owner).
 */
async function requesterOfRun(
  deps: Pick<NotificationDeps, "db">,
  orgId: string,
  runId: string | null,
): Promise<string | null> {
  return runId ? accountablePerson(await runAuthorityById(deps.db, orgId, runId)) : null;
}

/** The person behind a run (who asked for the work, through agents that asked each other), or null. */
export async function humanBehindRun(
  deps: Pick<NotificationDeps, "db">,
  orgId: string,
  runId: string | null,
): Promise<string | null> {
  return runId ? (await runAuthorityById(deps.db, orgId, runId)).personId : null;
}

async function isOrgMember(deps: Pick<NotificationDeps, "db">, orgId: string, userId: string) {
  const [row] = await deps.db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return Boolean(row);
}

async function agentOwner(deps: Pick<NotificationDeps, "db">, agentId: string) {
  const [a] = await deps.db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, agentId));
  return a?.owner ?? null;
}

// ── Chat: mentions, thread replies, DMs ───────────────────────────────────────

/**
 * One open `agent_reply` per conversation (a channel's top level, a thread, a DM): an agent's later answers there
 * merge into it until it's read. Reading the conversation resolves it (`markChannelRead`).
 */
export const agentReplyGroup = (channelId: string, threadId: string | null) =>
  `agent_reply:${channelId}:${threadId ?? "top"}`;

/**
 * Job `notifications.message` (enqueued in the message's own statement):
 * people mentioned (`mention`), the other person of a DM (`dm`), the person
 * an agent answers (`agent_reply`, merged per conversation, ADR 0071), and
 * the people in a thread (`thread_reply`, merged per thread). Cards of the
 * agent's own flows (questions, approvals, secret requests) notify through
 * those flows instead.
 */
export async function notifyMessage(deps: NotificationDeps, orgId: string, messageId: string) {
  const { db } = deps;
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
  if (!message || message.deletedAt) return;
  const meta = message.meta;
  if (meta.questionId || meta.approvalId || meta.secretRequestId) return;
  // An agent's sticker or GIF after its own reply (ADR 0091) is silent: the reply already told whoever it was for.
  if (isMediaAfterReply(meta)) return;
  // Only for its agent, or never news (a follow-up's lines: the reply it brings notifies instead; a stopped task's
  // receipt; a mention its message's own line explains).
  if (isQuietNotice(meta)) return;
  // A long work's progress line (ADR 0121) never pushes: it counts as unread only for who follows its thread.
  if (meta.workUpdate) return;
  const [channel] = await db
    .select({ kind: channels.kind, name: channels.name, visibility: channels.visibility })
    .from(channels)
    .where(and(eq(channels.id, message.channelId), eq(channels.orgId, orgId)));
  if (!channel) return;
  // A task's conversation (ADR 0145): whoever sees the task, as its comments did.
  if (channel.kind === "task") return notifyTaskMessage(deps, message);
  const actor = message.authorType === "person" ? person(message.authorUserId) : agent(message.authorAgentId);
  const authorUser = message.authorUserId;
  // A reminder's own words, without the English prefix the chat replaces with its own label.
  const said = typeof meta.reminderText === "string" ? meta.reminderText : await quotedBody(deps, orgId, message);
  const text = notificationSnippet(readableBody(said, meta));
  // Only a GIF or a sticker (ADR 0091): the apps and the push say which, in the person's language.
  const media = previewMediaKind(message.body, meta);
  // A body the server wrote: the apps say it in the reader's language, as the conversation lists do.
  const written = previewMeta(meta);
  const latest = { text, ...(media ? { media } : {}), ...(written ? { meta: written } : {}) };
  const label = channel.kind === "channel" ? channel.name : undefined;
  const where: NotificationSource = {
    channelId: message.channelId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    messageId: message.id,
    ...(channel.kind === "dm" ? { dmId: message.channelId } : {}),
  };
  const done = new Set<string>(authorUser ? [authorUser] : []);

  // An agent's answer: the person behind its run hears it (ADR 0071), once per conversation until read, so they
  // can close the tab while it works. Not a routine's (its creator hears `routine_finished`), not a run that
  // person stopped, not when they're mentioned in it (the mention says it).
  const behind =
    message.authorType === "agent" && message.agentRunId && !meta.viaRoutine && !meta.canceled && !meta.agentDm
      ? await humanBehindRun(deps, orgId, message.agentRunId)
      : null;
  // A stretch's pause card (ADR 0089) also tells the routine's creator when nobody asked for the work, and when
  // nobody is behind it at all, the owner of the agent it last stopped at (ADR 0053, addendum of 2026-10-31): they
  // hear it in any public channel of the workspace, joined or not, since they answer for their agent's work there.
  const card = message.authorType === "agent" ? stretchCardOf(meta) : null;
  const stoppedAt = card?.agentIds.at(-1);
  const owner = !behind && !card?.forUserId && stoppedAt ? await agentOwner(deps, stoppedAt) : null;
  // The autonomy brakes' proposal card, digest and loop stop (ADR 0131) are for the person they name.
  // Lodi's weekly card (ADR 0137 §9) is for the admin whose DM it is in.
  const asker =
    behind ??
    card?.forUserId ??
    proposalCardOf(meta)?.forUserId ??
    autonomyNoteFor(meta) ??
    teamWeekCardOf(meta)?.forUserId ??
    owner;
  const ownerSees =
    asker !== null &&
    asker === owner &&
    channel.kind === "channel" &&
    channel.visibility === "public" &&
    (await isOrgMember(deps, orgId, asker));
  if (
    asker &&
    !message.mentionedUserIds.includes(asker) &&
    // A work the person stopped themselves tells them nothing new.
    (meta.workEnd as { byUserId?: unknown } | undefined)?.byUserId !== asker &&
    (ownerSees || (await inChannel(deps, message.channelId, [asker])).length > 0)
  ) {
    // A long work's report (ADR 0121) is news of its own, never merged into the conversation's open reply.
    const workEnd = (meta.workEnd as { id?: unknown } | undefined)?.id;
    await notify(deps, {
      orgId,
      userIds: [asker],
      kind: "agent_reply",
      groupKey:
        typeof workEnd === "string" ? `work_end:${workEnd}` : agentReplyGroup(message.channelId, message.threadId),
      actor,
      source: { ...where, ...(label ? { label } : {}) },
      latest,
    });
    done.add(asker);
  }

  // A DM from a person: the other person hears it (an agent's replies in a DM are the conversation itself,
  // answered above for the person behind them, except what nobody is waiting on: a message the agent started there on
  // someone's behalf, `send_dm`, and a reminder or a routine's report, which come while the app may be closed).
  if (channel.kind === "dm") {
    if (message.authorType !== "person" && !meta.agentDm && !meta.routine && !meta.viaRoutine) return;
    const others = await db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, message.channelId), isNotNull(channelMembers.userId)));
    const to = others.flatMap((o) => (o.userId && o.userId !== authorUser ? [o.userId] : []));
    await notify(deps, {
      orgId,
      userIds: to,
      kind: "dm",
      groupKey: `dm:${message.id}`,
      actor,
      source: where,
      latest,
    });
    return;
  }

  const mentioned = await inChannel(
    deps,
    message.channelId,
    message.mentionedUserIds.filter((u) => !done.has(u)),
  );
  let threadLabel: string | undefined;
  if (message.threadId) threadLabel = await threadTitle(deps, orgId, message.threadId);
  if (mentioned.length > 0) {
    await notify(deps, {
      orgId,
      userIds: mentioned,
      kind: "mention",
      groupKey: `mention:${message.id}`,
      actor,
      source: { ...where, label: threadLabel ?? label },
      latest,
    });
    for (const u of mentioned) done.add(u);
  }

  // A reply in a thread: the people in it (who started it or wrote in it).
  // A routine's answer reaches its creator as `routine_finished` instead.
  if (!message.threadId || meta.viaRoutine) return;
  const [root] = await db
    .select({ authorUserId: messages.authorUserId, meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, message.threadId)));
  const people = await db
    .selectDistinct({ userId: messages.authorUserId })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.threadId, message.threadId),
        eq(messages.authorType, "person"),
        isNotNull(messages.authorUserId),
      ),
    );
  const starter = root && !root.meta.routine ? root.authorUserId : null;
  // Explicit choices win: following adds someone, muting drops them even where they wrote.
  const choices = await threadFollowChoices(db, orgId, message.threadId);
  const inThread = [starter, ...people.map((p) => p.userId), ...choices.followers].filter(
    (u): u is string => !!u && !done.has(u) && !choices.muted.has(u),
  );
  const to = await inChannel(deps, message.channelId, inThread);
  if (to.length === 0) return;
  await notify(deps, {
    orgId,
    userIds: to,
    kind: "thread_reply",
    groupKey: `thread:${message.threadId}`,
    actor,
    source: { ...where, label: threadLabel ?? label },
    latest,
  });
}

/**
 * What a notification quotes of a message: its body, but a task's end (`meta.machineTask`) names its computer only
 * where the workspace has more than one, the apps' rule (`namesComputers`), in the body's language. The agent still
 * reads where it ran.
 */
async function quotedBody(deps: NotificationDeps, orgId: string, message: typeof messages.$inferSelect) {
  const task = message.meta.machineTask as (TaskEnd & { computer?: string; locale?: string }) | undefined;
  if (typeof task?.title !== "string") return message.body;
  const computers = await deps.db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
    .limit(2);
  return taskEndLine(
    appLocale([task.locale], true) ?? "en",
    task,
    computers.length > 1 ? (task.computer ?? null) : null,
  );
}

async function threadTitle(deps: NotificationDeps, orgId: string, rootId: string) {
  const [t] = await deps.db
    .select({ title: threads.title })
    .from(threads)
    .where(and(eq(threads.orgId, orgId), eq(threads.rootMessageId, rootId)));
  if (t?.title) return t.title;
  const [root] = await deps.db
    .select({ body: messages.body, meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.id, rootId)));
  return root ? notificationSnippet(readableBody(root.body, root.meta), 80) || undefined : undefined;
}

const REACTION_EMOJI: Record<string, string> = { "+1": "👍", "-1": "👎" };

/**
 * Someone (a person or an agent) reacted to a person's message: its author
 * hears it (merged per message, also for 30 min after reading).
 */
export async function notifyReaction(
  deps: NotificationDeps,
  input: { orgId: string; messageId: string; userId?: string | null; agentId?: string | null },
) {
  const { db } = deps;
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, input.orgId), eq(messages.id, input.messageId)));
  if (message?.authorType !== "person" || !message.authorUserId) return;
  if (input.userId && message.authorUserId === input.userId) return;
  const actor = input.userId ? person(input.userId) : agent(input.agentId);
  if (!actor) return;
  const [channel] = await db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, message.channelId));
  const given = await db
    .select({ reaction: messageReactions.reaction, userId: messageReactions.userId })
    .from(messageReactions)
    .where(and(eq(messageReactions.orgId, input.orgId), eq(messageReactions.messageId, message.id)))
    .orderBy(asc(messageReactions.createdAt));
  const emojis = [
    ...new Set(
      given.filter((g) => g.userId !== message.authorUserId).map((g) => REACTION_EMOJI[g.reaction] ?? g.reaction),
    ),
  ].slice(-5);
  await notify(deps, {
    orgId: input.orgId,
    userIds: [message.authorUserId],
    kind: "reaction",
    groupKey: `reaction:${message.id}`,
    actor,
    source: {
      channelId: message.channelId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      messageId: message.id,
      ...(channel?.kind === "dm" ? { dmId: message.channelId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
    },
    latest: { emojis, quote: notificationSnippet(readableBody(message.body, message.meta), 140) },
  });
}

// ── Agent questions ───────────────────────────────────────────────────────────

/** An agent asked (`ask_user`) and waits: the person it is for, else the person behind the run, else the agent's owner. */
export async function notifyQuestion(deps: NotificationDeps, q: QuestionRow) {
  const to =
    q.requestedForUserId ?? (await requesterOfRun(deps, q.orgId, q.runId)) ?? (await agentOwner(deps, q.agentId));
  if (!to) return;
  const [channel] = await deps.db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, q.channelId));
  await notify(deps, {
    orgId: q.orgId,
    userIds: [to],
    kind: "agent_question",
    groupKey: `agent_question:${q.id}`,
    waiting: true,
    actor: agent(q.agentId),
    source: {
      channelId: q.channelId,
      ...(q.threadId ? { threadId: q.threadId } : {}),
      ...(q.messageId ? { messageId: q.messageId } : {}),
      ...(channel?.kind === "dm" ? { dmId: q.channelId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
      questionId: q.id,
    },
    latest: { text: notificationSnippet(q.text), suggestions: q.choices ?? undefined },
  });
}

/** Answered (by anyone) or expired: out of everyone's inbox. */
export async function resolveQuestionNotifications(deps: NotificationDeps, orgId: string, questionId: string) {
  await resolveNotifications(deps, orgId, { groupKey: `agent_question:${questionId}` });
}

// ── Secret requests (ADR 0027) ────────────────────────────────────────────────

/**
 * An agent waits for a secret (`request_secret`): the one person who can answer it, in their "Waiting for you" and
 * with a push, as a browser handoff asks. Only its name and what it is for travel, never a field: it is typed in
 * the card, where it is sealed for the computer.
 */
export async function notifySecretRequest(deps: NotificationDeps, r: typeof schema.secretRequests.$inferSelect) {
  const [channel] = await deps.db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, r.channelId));
  await notify(deps, {
    orgId: r.orgId,
    userIds: [r.requestedForUserId],
    kind: "secret_request",
    groupKey: `secret_request:${r.id}`,
    waiting: true,
    actor: agent(r.agentId),
    source: {
      channelId: r.channelId,
      ...(r.threadId ? { threadId: r.threadId } : {}),
      ...(r.messageId ? { messageId: r.messageId } : {}),
      ...(channel?.kind === "dm" ? { dmId: r.channelId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
    },
    latest: { title: secretLabelOf(r), text: notificationSnippet(r.purpose), expiresAt: r.expiresAt.toISOString() },
  });
}

/** Delivered, declined, expired or its run stopped: out of the inbox. */
export async function resolveSecretRequestNotifications(deps: NotificationDeps, orgId: string, requestId: string) {
  await resolveNotifications(deps, orgId, { groupKey: `secret_request:${requestId}` });
}

// ── Approvals ─────────────────────────────────────────────────────────────────

/**
 * A sensitive action waits: whoever is told (`notifiedIds`), with the agent's why (short, in `text`) and,
 * asked while nobody watched, where it came from (`origin`: a routine, or no one): ADR 0053 §8.
 */
/**
 * One notification per approval card (`openApprovalCard`): a request joining a card that already waits
 * updates that card's notification (its count, the newest title) instead of adding one.
 */
const approvalGroupKey = (approval: Pick<ApprovalRow, "id" | "messageId">) =>
  approval.messageId ? `approval-card:${approval.messageId}` : `approval:${approval.id}`;

export async function notifyApproval(deps: NotificationDeps, approval: ApprovalRow, deciders: string[]) {
  const [[channel], cardThreads, [first]] = await Promise.all([
    deps.db
      .select({ kind: channels.kind, name: channels.name })
      .from(channels)
      .where(eq(channels.id, approval.channelId)),
    approvalCardThreads(deps.db, [approval]),
    approval.messageId
      ? deps.db
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.orgId, approval.orgId),
              eq(approvals.messageId, approval.messageId),
              eq(approvals.status, "pending"),
            ),
          )
          .orderBy(asc(approvals.createdAt))
          .limit(1)
      : Promise.resolve([]),
  ]);
  // Where its card is (the main timeline has no thread).
  const threadId = cardThreads.get(approval.id) ?? null;
  await notify(deps, {
    orgId: approval.orgId,
    userIds: deciders,
    kind: "approval",
    groupKey: approvalGroupKey(approval),
    waiting: true,
    actor: agent(approval.agentId),
    source: {
      // The card's oldest waiting request: the notification opens the card, which lists the rest.
      approvalId: first?.id ?? approval.id,
      channelId: approval.channelId,
      ...(threadId ? { threadId } : {}),
      ...(approval.messageId ? { messageId: approval.messageId } : {}),
      ...(approval.missionId ? { missionId: approval.missionId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
    },
    latest: approvalLatest(approval),
  });
}

const approvalLatest = (approval: ApprovalRow) => ({
  title: notificationSnippet(approval.title, 200),
  text: notificationSnippet(approval.why, 200),
  origin: approvalOriginOf(approval.origin) ?? undefined,
  expiresAt: approval.expiresAt.toISOString(),
});

/**
 * Out of the inbox once nothing on its card waits any more. Until then each person's entry describes the
 * card's oldest request still waiting that they are told about (`notifiedIds`), and leaves the inbox of whoever has
 * none left.
 */
export async function resolveApprovalNotifications(
  deps: NotificationDeps,
  approval: Pick<ApprovalRow, "id" | "orgId" | "messageId">,
) {
  const groupKey = approvalGroupKey(approval);
  // One with no card is its own group: still waiting (its deciders changed), its deciders keep their items.
  const waiting = await deps.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, approval.orgId),
        approval.messageId ? eq(approvals.messageId, approval.messageId) : eq(approvals.id, approval.id),
        eq(approvals.status, "pending"),
      ),
    )
    .orderBy(asc(approvals.createdAt));
  if (waiting.length === 0) return resolveNotifications(deps, approval.orgId, { groupKey });
  const told = await Promise.all(waiting.map(async (a) => new Set(await notifiedIds(deps.db, a))));
  await retargetNotifications(deps, approval.orgId, groupKey, (userId) => {
    const next = waiting.find((_, i) => told[i]?.has(userId));
    return next ? { source: { approvalId: next.id }, latest: approvalLatest(next) } : null;
  });
}

/**
 * `userId`'s cover started, changed or ended, or they went out of office or came back (ADR 0139): the approvals
 * waiting that they are asked personally reach whoever is asked now, and leave whoever isn't any more.
 */
export async function rerouteApprovals(deps: NotificationDeps, orgId: string, userId: string) {
  const rows = await deps.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, orgId),
        eq(approvals.status, "pending"),
        sql`(${approvals.ownerUserId} = ${userId} or ${approvals.approvers} -> 'userIds' @> to_jsonb(${userId}::text))`,
      ),
    );
  for (const row of rows) {
    await resolveApprovalNotifications(deps, row);
    await notifyNewcomers(deps, row);
  }
}

/** Whoever is told about a waiting approval now (`notifiedIds`) and holds no item for its card yet gets one. */
export async function notifyNewcomers(deps: NotificationDeps, row: ApprovalRow) {
  const holding = await deps.db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        eq(notifications.orgId, row.orgId),
        eq(notifications.groupKey, approvalGroupKey(row)),
        isNull(notifications.doneAt),
      ),
    );
  const held = new Set(holding.map((h) => h.userId));
  const newcomers = (await notifiedIds(deps.db, row)).filter((id) => !held.has(id));
  if (newcomers.length > 0) await notifyApproval(deps, row, newcomers);
}

// ── Issues ────────────────────────────────────────────────────────────────────

/** Who follows an issue: its author, its assignee, and the people who acted on it or wrote in its conversation. */
async function issueFollowers(deps: NotificationDeps, issue: IssueRow) {
  const [acted, wrote] = await Promise.all([
    deps.db
      .selectDistinct({ userId: issueActivity.authorId })
      .from(issueActivity)
      .where(and(eq(issueActivity.issueId, issue.id), eq(issueActivity.authorType, "person"))),
    issue.conversationChannelId
      ? deps.db
          .selectDistinct({ userId: messages.authorUserId })
          .from(messages)
          .where(
            and(
              eq(messages.orgId, issue.orgId),
              eq(messages.channelId, issue.conversationChannelId),
              isNotNull(messages.authorUserId),
            ),
          )
      : [],
  ]);
  const ids = new Set<string>([...acted.map((a) => a.userId), ...wrote.flatMap((w) => (w.userId ? [w.userId] : []))]);
  if (issue.createdByType === "person") ids.add(issue.createdById);
  if (issue.assigneeType === "person" && issue.assigneeId) ids.add(issue.assigneeId);
  return taskReadersAmong(deps.db, issue.id, [...ids]);
}

const issueSource = (issue: IssueRow): NotificationSource => ({
  issueId: issue.id,
  issueNumber: issue.number,
  ...(issue.channelId ? { channelId: issue.channelId } : {}),
  label: issue.title,
});

export type IssueNotifyActor = { type: "person"; id: string } | { type: "agent"; id: string };
const issueActor = (a: IssueNotifyActor): NotificationActor =>
  (a.type === "person" ? person(a.id) : agent(a.id)) as NotificationActor;

/**
 * After an issue changed: a new person assignee hears it (and the previous
 * one's "assigned to you" resolves); a status change reaches the followers.
 */
export async function notifyIssueChanged(
  deps: NotificationDeps,
  actor: IssueNotifyActor,
  before: Pick<IssueRow, "status" | "assigneeType" | "assigneeId"> | null,
  issue: IssueRow,
) {
  const at = issue.updatedAt.getTime();
  const prevPerson = before?.assigneeType === "person" ? before.assigneeId : null;
  const nowPerson = issue.assigneeType === "person" ? issue.assigneeId : null;
  if (prevPerson && prevPerson !== nowPerson) {
    await resolveNotifications(deps, issue.orgId, {
      groupKeyPrefix: `issue_assigned:${issue.id}:`,
      userIds: [prevPerson],
    });
  }
  if (nowPerson && nowPerson !== prevPerson) {
    await notify(deps, {
      orgId: issue.orgId,
      userIds: await taskReadersAmong(deps.db, issue.id, [nowPerson]),
      kind: "issue_assigned",
      groupKey: `issue_assigned:${issue.id}:${at}`,
      actor: issueActor(actor),
      source: issueSource(issue),
      latest: { title: issue.title, text: notificationSnippet(issue.description) },
    });
  }
  if (before && before.status !== issue.status) {
    await notify(deps, {
      orgId: issue.orgId,
      userIds: await issueFollowers(deps, issue),
      kind: "issue_status",
      groupKey: `issue_status:${issue.id}:${at}`,
      actor: issueActor(actor),
      source: issueSource(issue),
      latest: { title: issue.title, statusFrom: before.status, statusTo: issue.status },
    });
  }
}

/**
 * A comment: people it @mentions get a `mention` (source: the issue); the
 * other followers an `issue_comment`, merged per issue.
 */
export async function notifyIssueComment(
  deps: NotificationDeps,
  actor: IssueNotifyActor,
  issueId: string,
  activityId: string,
  text: string,
  /** The reply in the task's conversation (ADR 0145): the apps open the task at it. */
  options: { messageId?: string } = {},
) {
  const [issue] = await deps.db.select().from(issues).where(eq(issues.id, issueId));
  if (!issue) return;
  const source = { ...issueSource(issue), ...(options.messageId ? { messageId: options.messageId } : {}) };
  const snippet = notificationSnippet(text);
  const handles = handlesIn(text);
  const named = handles.length
    ? await deps.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, issue.orgId), inArray(organizationMembers.handle, handles)))
    : [];
  const mentioned = await taskReadersAmong(
    deps.db,
    issue.id,
    named.map((n) => n.userId),
  );
  const self = actor.type === "person" ? actor.id : null;
  const told = new Set<string>(self ? [self] : []);
  if (mentioned.length) {
    await notify(deps, {
      orgId: issue.orgId,
      userIds: mentioned,
      kind: "mention",
      groupKey: `mention:issue-comment:${activityId}`,
      actor: issueActor(actor),
      source,
      latest: { text: snippet, title: issue.title },
    });
    for (const u of mentioned) told.add(u);
  }
  const followers = (await issueFollowers(deps, issue)).filter((u) => !told.has(u));
  await notify(deps, {
    orgId: issue.orgId,
    userIds: followers,
    kind: "issue_comment",
    groupKey: `issue-comments:${issue.id}`,
    actor: issueActor(actor),
    source,
    latest: { text: snippet, title: issue.title },
  });
}

/**
 * A reply in a task's conversation: mentions and the task's followers (and who wrote there) hear it like a comment,
 * by who sees the task, never by the conversation's own members. A routine's or a quiet line tells nobody.
 */
async function notifyTaskMessage(deps: NotificationDeps, message: typeof messages.$inferSelect) {
  if (!message.threadId || message.meta.viaRoutine) return;
  const [issue] = await deps.db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.orgId, message.orgId), eq(issues.conversationChannelId, message.channelId)));
  const author =
    message.authorType === "person" ? message.authorUserId : message.authorAgentId ? message.authorAgentId : null;
  if (!issue || !author) return;
  const text = readableBody(message.body, message.meta);
  if (!text.trim()) return;
  await notifyIssueComment(deps, { type: message.authorType, id: author }, issue.id, message.id, text, {
    messageId: message.id,
  });
}

// ── Missions ──────────────────────────────────────────────────────────────────

/** A mission finished (closed as done) or stopped: its owner and participants. */
export async function notifyMissionEnded(
  deps: NotificationDeps,
  mission: MissionRow,
  kind: "mission_finished" | "mission_stopped",
  actor: NotificationActor | null,
  text?: string | null,
  /** `text` is the server's English: the apps word it by its code, as the chat's message (`previewMeta`). */
  written?: PreviewMeta,
) {
  const parts = await deps.db
    .select({ userId: missionParticipants.userId })
    .from(missionParticipants)
    .where(eq(missionParticipants.missionId, mission.id));
  await notify(deps, {
    orgId: mission.orgId,
    userIds: [mission.ownerId, ...parts.map((p) => p.userId)],
    kind,
    groupKey: `${kind}:${mission.id}:${mission.updatedAt.getTime()}`,
    actor,
    source: {
      missionId: mission.id,
      channelId: mission.channelId,
      threadId: mission.threadRootId,
      label: mission.title,
    },
    latest: {
      title: mission.title,
      ...(text ? { text: notificationSnippet(text) } : {}),
      ...(text && written ? { meta: written } : {}),
      ...(mission.planTotal > 0 ? { steps: { done: mission.planDone, total: mission.planTotal } } : {}),
    },
  });
}

// ── Routines (ADR 0053) ─────────────────────────────────────────────────────────

/** A routine's name, creator and agent, and the agent's owner: who hears about it. */
async function routineAudience(deps: Pick<NotificationDeps, "db">, orgId: string, routineId: string) {
  const [r] = await deps.db
    .select({ name: routines.name, creator: routines.createdByUserId, agentId: routines.agentId })
    .from(routines)
    .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)));
  if (!r) return null;
  return { ...r, owner: await agentOwner(deps, r.agentId) };
}

/**
 * A routine's run failed after a good one (§6.6): its creator (else the agent's owner) hears it
 * once per failure streak (`streakKey`: the streak's first failed run), with the run's coded reason
 * (`latest.reason`: the app says it in the person's language). Resolved by the next good run.
 */
export async function notifyRoutineFailed(
  deps: NotificationDeps,
  input: { orgId: string; routineId: string; streakKey: string; reason?: string | null },
) {
  const r = await routineAudience(deps, input.orgId, input.routineId);
  if (!r) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [r.creator ?? r.owner],
    kind: "routine_failed",
    groupKey: `routine_failed:${input.routineId}:${input.streakKey}`,
    actor: agent(r.agentId),
    source: { routineId: input.routineId, label: r.name },
    latest: { title: r.name, reason: input.reason ?? undefined },
  });
}

/**
 * A routine couldn't call an agent its creator can't talk to (`reach.ts`, and its own tell_agent or
 * ask_agent, `consultations.ts`): the agent's owner hears it once per routine and agent, or who manages agents when
 * it has none. It opens the agent's page (who talks to it), the place they may not otherwise reach being private;
 * `source.userId` is the routine's creator, whom its one-click action lets talk to the agent.
 */
export async function notifyAgentUnreached(
  deps: NotificationDeps,
  input: {
    orgId: string;
    agentId: string;
    routineId: string;
    routineName: string;
    creatorUserId: string;
    channelId: string;
    threadId?: string | null;
    messageId?: string;
  },
) {
  const owner = await agentOwner(deps, input.agentId);
  await notify(deps, {
    orgId: input.orgId,
    userIds: owner ? [owner] : await adminsOf(deps, input.orgId, "manage_agents"),
    kind: "agent_unreached",
    groupKey: `agent_unreached:${input.routineId}:${input.agentId}`,
    actor: agent(input.agentId),
    source: {
      routineId: input.routineId,
      agentId: input.agentId,
      userId: input.creatorUserId,
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      label: input.routineName,
    },
    latest: { title: input.routineName, reason: "routine_creator_reach" },
  });
}

/**
 * A routine paused itself (§6.2, §6.6): its creator and the agent's owner hear it once per pause
 * (`key`), with the coded reason (`latest.reason`, the app translates it) and its English fallback.
 */
export async function notifyRoutinePaused(
  deps: NotificationDeps,
  input: {
    orgId: string;
    routineId: string;
    name: string;
    agentId: string;
    creatorUserId: string | null;
    reason: string;
    text: string;
    key: string;
  },
) {
  // A widget's routine says it through its widget (`widget_failed`, ADR 0135 §6), not as a routine.
  const [r] = await deps.db
    .select({ type: sql<string | null>`${routines.target}->>'type'` })
    .from(routines)
    .where(and(eq(routines.id, input.routineId), eq(routines.orgId, input.orgId)));
  if (r?.type === "widget") return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.creatorUserId, await agentOwner(deps, input.agentId)],
    kind: "routine_paused",
    groupKey: `routine_paused:${input.routineId}:${input.key}`,
    actor: agent(input.agentId),
    source: { routineId: input.routineId, label: input.name },
    latest: { title: input.name, reason: input.reason, text: input.text },
  });
}

/**
 * A routine's run waits for the agent's computer (§6.4): its creator and the agent's owner hear it
 * once per outage (`outageKey`: the routine's last run that really ran; the next one that does starts a
 * new outage). Resolved by the next good run.
 */
export async function notifyRoutineStalled(
  deps: NotificationDeps,
  input: { orgId: string; routineId: string; machineId: string; machineName: string; outageKey: string },
) {
  const r = await routineAudience(deps, input.orgId, input.routineId);
  if (!r) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [r.creator, r.owner],
    kind: "routine_stalled",
    groupKey: `routine_stalled:${input.routineId}:${input.machineId}:${input.outageKey}`,
    actor: agent(r.agentId),
    source: { routineId: input.routineId, machineId: input.machineId, label: r.name },
    latest: { title: r.name, ...(input.machineName ? { text: notificationSnippet(input.machineName) } : {}) },
  });
}

/**
 * A routine's run waits for its agent's plan to reset: its creator and the agent's owner hear it once per
 * outage (`outageKey`, as `notifyRoutineStalled`). Resolved by the next good run.
 */
export async function notifyRoutineWaitingPlan(
  deps: NotificationDeps,
  input: { orgId: string; routineId: string; outageKey: string },
) {
  const r = await routineAudience(deps, input.orgId, input.routineId);
  if (!r) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [r.creator, r.owner],
    kind: "routine_waiting_plan",
    groupKey: `routine_waiting_plan:${input.routineId}:${input.outageKey}`,
    actor: agent(r.agentId),
    source: { routineId: input.routineId, label: r.name },
    latest: { title: r.name },
  });
}

/**
 * An agent's work has waited `UNKNOWN_RESET_NOTICE_MS` on its plan's limit and the plan never said when it resets:
 * the agent's owner hears it once per plan line (the count says how many conversations), opening the first one.
 */
export async function notifyPlanResetUnknown(
  deps: NotificationDeps,
  input: {
    orgId: string;
    agentId: string;
    agentName: string;
    plan: string;
    /** The plan's line (`usageWaitKey`): one notice per line, each conversation that waits a day merges in. */
    waitKey: string;
    channelId: string;
    threadId: string | null;
  },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [await agentOwner(deps, input.agentId)],
    kind: "plan_reset_unknown",
    groupKey: `plan_reset_unknown:${input.waitKey}`,
    actor: agent(input.agentId),
    source: {
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      label: input.agentName,
    },
    latest: { title: input.plan },
  });
}

/** The inbox note of an agent's model that left its plan's list (`plan_model_dropped`); no model: all of the agent's. */
export const planModelDroppedGroup = (agentId: string, model = "") => `plan_model_dropped:${agentId}:${model}`;

/**
 * A model the agent thinks with left its plan's live list and its turns run another one: its owner hears it once per
 * model, with what it runs now, so the switch is never silent.
 */
export async function notifyPlanModelDropped(
  deps: NotificationDeps,
  input: { orgId: string; agentId: string; agentName: string; plan: string; model: PlanModel; runs: string },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [await agentOwner(deps, input.agentId)],
    kind: "plan_model_dropped",
    groupKey: planModelDroppedGroup(input.agentId, input.model.id),
    actor: agent(input.agentId),
    source: { agentId: input.agentId, label: input.agentName },
    latest: { title: input.model.label, plan: input.plan, nowModel: input.runs },
  });
}

/**
 * An agent back from its plan or budget skipped a catch-up that looked handled (ADR 0136): its owner hears it once per
 * line, each skip merging in, and only for conversations they can read.
 */
export async function notifyCatchUpClosed(
  deps: NotificationDeps,
  input: {
    orgId: string;
    agentId: string;
    agentName: string;
    waitKey: string;
    channelId: string;
    threadId: string | null;
    messageId: string;
    /** Who asked in it: an owner among them hears it as the asker, or withdrew it themselves. */
    askers?: string[];
  },
) {
  const owner = await agentOwner(deps, input.agentId);
  if (!owner || input.askers?.includes(owner)) return;
  if (!(await readableChannelIds(deps.db, input.orgId, owner, [input.channelId])).has(input.channelId)) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [owner],
    kind: "catch_up_closed",
    groupKey: `catch_up_closed:${input.agentId}:${input.waitKey}`,
    actor: agent(input.agentId),
    source: {
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      messageId: input.messageId,
      label: input.agentName,
    },
  });
}

/**
 * The person who asked, when their catch-up was skipped crediting someone else (ADR 0136): an inbox row opening the
 * note, so a wrong skip reaches who would miss the answer. Never when they withdrew or confirmed it themselves.
 */
export async function notifyCatchUpClosedAsker(
  deps: NotificationDeps,
  input: {
    orgId: string;
    userId: string;
    agentId: string;
    runId: string;
    reason: "solved" | "task_canceled";
    who: string;
    channelId: string;
    threadId: string | null;
    messageId: string;
    /** The conversation's name ("#suporte"), none for a DM. */
    label: string | null;
  },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.userId],
    kind: "catch_up_closed_asker",
    groupKey: `catch_up_closed_asker:${input.runId}:${input.userId}`,
    actor: agent(input.agentId),
    source: {
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      messageId: input.messageId,
      ...(input.label ? { label: input.label } : {}),
    },
    latest: { title: input.who, reason: input.reason },
  });
}

/**
 * The agent told people what a routine found (the message its report woke, §7): its creator hears
 * it, opening that message, unless they are a member of that conversation (they see it there).
 */
export async function notifyRoutineFinished(
  deps: NotificationDeps,
  input: {
    orgId: string;
    routineId: string;
    routineRunId: string;
    messageId: string;
    channelId: string;
    threadId: string | null;
    text?: string | null;
  },
) {
  const r = await routineAudience(deps, input.orgId, input.routineId);
  if (!r?.creator) return;
  if ((await inChannel(deps, input.channelId, [r.creator])).length > 0) return;
  await notify(deps, {
    orgId: input.orgId,
    userIds: [r.creator],
    kind: "routine_finished",
    groupKey: `routine_finished:${input.routineRunId}`,
    actor: agent(r.agentId),
    source: {
      routineId: input.routineId,
      channelId: input.channelId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      messageId: input.messageId,
      label: r.name,
    },
    latest: { title: r.name, ...(input.text ? { text: notificationSnippet(input.text) } : {}) },
  });
}

// ── Runs (ADR 0097) ─────────────────────────────────────────────────────────────

const runFailedGroup = (run: { agentId: string; channelId: string; threadRootId: string }) =>
  `run_failed:${run.agentId}:${run.channelId}:${run.threadRootId}`;

/**
 * A conversation run failed for good (`reportRunFailure`): `userId` (else the agent's owner) hears it once per agent
 * and conversation, with the run's coded reason (`latest.reason`, `cause.code` when the run knew it better, and the
 * plan it names). Failures of one cause close together share one row (`joinRunFailure`). Resolved by the agent's next
 * good run there.
 */
export async function notifyRunFailed(
  deps: NotificationDeps,
  run: { orgId: string; agentId: string; channelId: string; threadRootId: string; triggerMessageId: string },
  userId: string | null,
  reason: string,
  cause?: { code?: string; plan?: string },
) {
  const to = userId ?? (await agentOwner(deps, run.agentId));
  if (!to) return;
  const [channel] = await deps.db.select({ name: channels.name }).from(channels).where(eq(channels.id, run.channelId));
  const groupKey = runFailedGroup(run);
  const source = {
    channelId: run.channelId,
    ...(run.threadRootId !== run.triggerMessageId ? { threadId: run.threadRootId } : {}),
    messageId: run.triggerMessageId,
    agentId: run.agentId,
    ...(channel?.name ? { label: channel.name } : {}),
  };
  const said = { reason: cause?.code ?? reason.split(":")[0] ?? reason, ...(cause?.plan ? { plan: cause.plan } : {}) };
  // One at a time per person, so a burst of failures finds the row the first one made.
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`run-failed:${run.orgId}:${to}`}))`);
    const d = { ...deps, db: tx };
    if (await joinRunFailure(d, run.orgId, to, { key: groupKey, ...source }, said)) return;
    await notify(d, {
      orgId: run.orgId,
      userIds: [to],
      kind: "run_failed",
      groupKey,
      actor: agent(run.agentId),
      source,
      latest: { ...said, failures: [{ key: groupKey, ...source }] },
    });
  });
}

/** The agent's run in that conversation ended well: its failure there is done (it leaves a shared row). */
export async function resolveRunFailed(
  deps: NotificationDeps,
  run: { orgId: string; agentId: string; channelId: string; threadRootId: string },
) {
  await dropRunFailure(deps, run.orgId, runFailedGroup(run));
}

/** A routine ran well again: its failure streak and computer outage notifications are done. */
export async function resolveRoutineTrouble(deps: NotificationDeps, orgId: string, routineId: string) {
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `routine_failed:${routineId}:` });
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `routine_stalled:${routineId}:` });
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `routine_waiting_plan:${routineId}:` });
}

/** A person resumed or took over a routine: its pause notifications are done. */
export async function resolveRoutinePaused(deps: NotificationDeps, orgId: string, routineId: string) {
  await resolveNotifications(deps, orgId, { groupKeyPrefix: `routine_paused:${routineId}:` });
}

// ── Dashboards and widgets (ADR 0135) ──────────────────────────────────────────

/** Open alerts of a widget: one row merging while open. */
export const widgetAlertGroup = (widgetId: string) => `widget-alert:${widgetId}`;
/**
 * A widget's failure streaks: one row per streak (`<streakKey>` its first failed run), resolved by a good update.
 * Without a key, the prefix every streak's row starts with.
 */
export const widgetFailedGroup = (widgetId: string, streakKey?: string) =>
  streakKey ? `widget-failed:${widgetId}:${streakKey}` : `widget-failed:${widgetId}`;
/**
 * An agent's requests to show a board to more people: one row per request (`<at>` when it asked). Without `at`, the
 * prefix every request's row starts with.
 */
export const dashboardProposalGroup = (dashboardId: string, at?: string) =>
  at ? `dashboard-proposal:${dashboardId}:${at}` : `dashboard-proposal:${dashboardId}`;

/**
 * A widget's alert condition was met (ADR 0135 §6): `userIds` (whoever set the alert, while they see the board) hear
 * the agent's words in "Waiting on you", one row per widget merging while open. Never in the chat.
 */
export async function notifyWidgetAlert(
  deps: NotificationDeps,
  input: {
    orgId: string;
    userIds: (string | null)[];
    widgetId: string;
    dashboardId: string;
    agentId: string;
    title: string;
    text: string;
  },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: input.userIds,
    kind: "widget_alert",
    groupKey: widgetAlertGroup(input.widgetId),
    waiting: true,
    actor: agent(input.agentId),
    source: { dashboardId: input.dashboardId, widgetId: input.widgetId, agentId: input.agentId, label: input.title },
    latest: { title: input.title, text: notificationSnippet(input.text) },
  });
}

/**
 * A widget stopped updating (ADR 0135 §6): `userId` (its creator, else who looks after its routine) hears it once per
 * failure streak (`streakKey`), with the coded reason (`agent_reported`: the agent's words in `latest.text`). Inbox
 * only; resolved by its next good update.
 */
export async function notifyWidgetFailed(
  deps: NotificationDeps,
  input: {
    orgId: string;
    userId: string | null;
    widgetId: string;
    dashboardId: string;
    agentId: string;
    title: string;
    streakKey: string;
    reason: string;
    text?: string | null;
  },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.userId],
    kind: "widget_failed",
    groupKey: widgetFailedGroup(input.widgetId, input.streakKey),
    actor: agent(input.agentId),
    source: { dashboardId: input.dashboardId, widgetId: input.widgetId, agentId: input.agentId, label: input.title },
    latest: {
      title: input.title,
      reason: input.reason,
      ...(input.text ? { text: notificationSnippet(input.text) } : {}),
    },
  });
}

/** A widget updated well again: its failure notification is done. */
export async function resolveWidgetFailed(deps: NotificationDeps, orgId: string, widgetId: string) {
  await resolveNotifications(deps, orgId, { groupKeyPrefix: widgetFailedGroup(widgetId) });
}

/** A widget or its board is gone: its open alert and failure rows are done. */
export async function resolveWidgetNotices(deps: NotificationDeps, orgId: string, widgetId: string) {
  await resolveNotifications(deps, orgId, { groupKey: widgetAlertGroup(widgetId) });
  await resolveWidgetFailed(deps, orgId, widgetId);
}

/**
 * An agent asks to show a board to more people (ADR 0135 §11): the person it was made for decides, from "Waiting on
 * you", with the audience (`statusTo`, the roles' names in `names`) and the agent's reason.
 */
export async function notifyDashboardProposal(
  deps: NotificationDeps,
  input: {
    orgId: string;
    userId: string | null;
    dashboardId: string;
    agentId: string;
    title: string;
    audience: "workspace" | "roles";
    roleNames: string[];
    why: string;
    at: string;
  },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.userId],
    kind: "dashboard_proposal",
    groupKey: dashboardProposalGroup(input.dashboardId, input.at),
    waiting: true,
    actor: agent(input.agentId),
    source: { dashboardId: input.dashboardId, agentId: input.agentId, label: input.title },
    latest: {
      title: input.title,
      statusTo: input.audience,
      ...(input.roleNames.length > 0 ? { names: input.roleNames.slice(0, 10) } : {}),
      ...(input.why ? { text: notificationSnippet(input.why) } : {}),
    },
  });
}

/** The board's request was decided, replaced or dropped (shared by a person, deleted): its notification is done. */
export async function resolveDashboardProposal(deps: NotificationDeps, orgId: string, dashboardId: string) {
  await resolveNotifications(deps, orgId, { groupKeyPrefix: dashboardProposalGroup(dashboardId) });
}

/** Who in the organization may `permission` (ADR 0085), or only its owners. */
const adminsOf = async (deps: NotificationDeps, orgId: string, permission: RolePermission | "owners") =>
  (
    await deps.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          permission === "owners"
            ? eq(organizationMembers.role, "owner")
            : maySql(orgId, organizationMembers.userId, permission),
        ),
      )
  ).map((a) => a.userId);

// ── Connected computers ───────────────────────────────────────────────────────

/**
 * A computer was connected to the organization (ADR 0036 §5): every admin
 * hears, except who connected it, so a computer nobody expected (a phished
 * code) is seen and can be removed at once.
 */
export async function notifyMachineConnected(
  deps: NotificationDeps,
  machine: { id: string; orgId: string; name: string; hostname: string },
  actorId: string,
) {
  await notify(deps, {
    orgId: machine.orgId,
    userIds: await adminsOf(deps, machine.orgId, "configure"),
    kind: "machine_connected",
    groupKey: `machine_connected:${machine.id}`,
    actor: person(actorId),
    source: { machineId: machine.id, label: machine.name },
    latest: { title: machine.name, ...(machine.hostname ? { text: notificationSnippet(machine.hostname) } : {}) },
  });
}

/** A computer ran a connect link and asks to join: the link's maker decides, in the app (`device-links.ts`). */
export async function notifyDeviceJoinRequest(
  deps: NotificationDeps,
  request: { id: string; name: string },
  to: {
    orgId: string;
    orgName: string;
    makerId: string;
    facts: string;
    os: string;
    ip: string;
    location: string | null;
  },
) {
  await notify(deps, {
    orgId: to.orgId,
    userIds: [to.makerId],
    kind: "device.join_request",
    groupKey: `device.join_request:${request.id}`,
    waiting: true,
    source: { requestId: request.id, label: request.name },
    // The workspace's name: the push says "build-box wants to join Acme".
    latest: {
      title: to.orgName,
      ...(to.facts ? { text: notificationSnippet(to.facts) } : {}),
      // The app draws the system's mark and says its words in the person's language; `text` is for pushes and emails.
      os: to.os,
      ...(to.ip ? { ip: to.ip } : {}),
      ...(to.location ? { location: to.location } : {}),
    },
  });
}

export const resolveDeviceJoinRequest = (deps: NotificationDeps, orgId: string, requestId: string) =>
  resolveNotifications(deps, orgId, { groupKey: `device.join_request:${requestId}` });

/** The share of a computer's workspace disk in use past which its admins hear it (ADR 0115). */
export const DISK_WARN_USE = 0.85;
/** Under this share the warning is armed again, so a disk hovering at the line doesn't notify on every report. */
export const DISK_REARM_USE = 0.8;

/**
 * A computer's disk passed `DISK_WARN_USE` (ADR 0115): who configures the workspace hears it, once each time it
 * crosses (the caller compares with the last report), since agents filling the shared folder fail together.
 */
export async function notifyComputerDiskFull(
  deps: NotificationDeps,
  machine: { id: string; orgId: string; name: string },
  disk: { diskUse: number; diskFreeGb?: number },
  at: Date,
) {
  await notify(deps, {
    orgId: machine.orgId,
    userIds: await adminsOf(deps, machine.orgId, "configure"),
    kind: "computer_disk_full",
    groupKey: `computer_disk_full:${machine.id}:${at.getTime()}`,
    source: { machineId: machine.id, label: machine.name },
    latest: {
      title: machine.name,
      diskUse: disk.diskUse,
      ...(disk.diskFreeGb === undefined ? {} : { diskFreeGb: disk.diskFreeGb }),
    },
  });
}

/**
 * A computer said it has no Google Chrome for its agents' browsers (ADR 0133: a runner that updated itself drives the
 * computer's own Chrome): who connected it hears it, since it is theirs to install, else who configures the workspace.
 * Once each time it goes missing (the caller compares with the last `hello`).
 */
export async function notifyComputerNoChrome(
  deps: NotificationDeps,
  machine: { id: string; orgId: string; name: string; pairedByUserId: string | null },
  at: Date,
) {
  await notify(deps, {
    orgId: machine.orgId,
    userIds: machine.pairedByUserId ? [machine.pairedByUserId] : await adminsOf(deps, machine.orgId, "configure"),
    kind: "computer_no_chrome",
    groupKey: `computer_no_chrome:${machine.id}:${at.getTime()}`,
    source: { machineId: machine.id, label: machine.name },
    latest: { title: machine.name },
  });
}

/**
 * Someone other than its owner took control of an agent's desktop (ADR 0059 §8): the owner hears it in the inbox
 * only, once a day per agent (`desktop_taken:{agentId}:{UTC day}`), since an admin may do so even while the agent
 * thinks with the owner's plan.
 */
export async function notifyDesktopTaken(
  deps: NotificationDeps,
  input: { orgId: string; agentId: string; agentName: string; ownerUserId: string; actorId: string; at: Date },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.ownerUserId],
    kind: "desktop_taken",
    groupKey: `desktop_taken:${input.agentId}:${input.at.toISOString().slice(0, 10)}`,
    actor: { type: "user", id: input.actorId },
    source: { agentId: input.agentId, screen: "desktop", label: input.agentName },
  });
}

/** The inbox note of one plan lent to one agent (`plan_lent`), done when it is taken back; no agent: all of them. */
export const planLentGroup = (accountId: string, agentId = "") => `plan_lent:${accountId}:${agentId}`;

/** Someone gave an agent this person's plan (`plan_lent`): the plan's owner, in the inbox, with "Tirar de volta". */
export async function notifyPlanLent(
  deps: NotificationDeps,
  input: {
    orgId: string;
    agentId: string;
    agentName: string;
    accountId: string;
    ownerUserId: string;
    actorId: string;
    plan: string;
  },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.ownerUserId],
    kind: "plan_lent",
    groupKey: planLentGroup(input.accountId, input.agentId),
    actor: { type: "user", id: input.actorId },
    source: { agentId: input.agentId, accountId: input.accountId, label: input.agentName },
    latest: { plan: input.plan },
  });
}

/**
 * The workspace's own computer is ready (ADR 0056 §10): its owners hear it, since preparing it may take
 * from seconds to an approval hours later. One row each time it gets ready.
 */
export async function notifyComputerReady(
  deps: NotificationDeps,
  machine: { id: string; orgId: string; name: string },
  readyAt: Date,
) {
  await notify(deps, {
    orgId: machine.orgId,
    userIds: await adminsOf(deps, machine.orgId, "owners"),
    kind: "computer_ready",
    groupKey: `computer_ready:${machine.id}:${readyAt.getTime()}`,
    source: { machineId: machine.id, label: machine.name },
    latest: { title: machine.name },
  });
}

/**
 * The workspace used its Composio calls for the month (ADR 0107 §7): who manages its connectors hears it once that
 * month (the caller marks the month capped first).
 */
export async function notifyComposioLimit(deps: NotificationDeps, orgId: string, month: string, calls: number) {
  await notify(deps, {
    orgId,
    userIds: await adminsOf(deps, orgId, "manage_connectors"),
    kind: "composio_limit",
    groupKey: `composio_limit:${month}`,
    source: {},
    latest: { title: month, calls },
  });
}

const skillWaitingGroup = (skillId: string) => `skill_update:waiting:${skillId}:`;

/**
 * An update of a skill from its link: applied (`updated`), waiting because it changes what runs (`waiting`, the files)
 * or would replace what agents changed (`latest.reason` `edited`),
 * or refused (`failed`, its code). Who hears it: `to` an update, who manages skills a waiting one, both a refusal
 * (`to` may have lost the right or left the workspace, which only who manages skills can fix). `edited`: an agent
 * changed a skill a person made ("Agentes melhoram as skills sozinhos"), told to `to` (its author) in one row per
 * skill that gathers the agents' changes while unread.
 */
export async function notifySkillUpdate(
  deps: NotificationDeps,
  skill: { id: string; orgId: string; name: string },
  what:
    | { state: "updated"; version: number }
    | { state: "waiting"; hash: string; scripts: string[]; edited?: boolean }
    | { state: "failed"; reason: string }
    | { state: "edited"; agentId: string; version: number },
  to: string | null,
) {
  const key =
    what.state === "waiting"
      ? `${skillWaitingGroup(skill.id)}${what.hash}`
      : what.state === "edited"
        ? `skill_update:edited:${skill.id}`
        : `skill_update:${what.state}:${skill.id}:${what.state === "updated" ? what.version : what.reason}:${Date.now()}`;
  if (what.state === "edited" && !to) return;
  await notify(deps, {
    orgId: skill.orgId,
    ...(what.state === "edited" ? { actor: { type: "agent" as const, id: what.agentId } } : {}),
    userIds:
      to && (what.state === "updated" || what.state === "edited")
        ? [to]
        : [...(await adminsOf(deps, skill.orgId, "manage_agents")), ...(to && what.state === "failed" ? [to] : [])],
    kind: "skill_update",
    groupKey: key,
    waiting: what.state === "waiting",
    source: { skillId: skill.id, label: skill.name },
    latest: {
      statusTo: what.state,
      ...(what.state === "waiting" ? { title: what.scripts.join(", ") } : {}),
      ...(what.state === "waiting" && what.edited ? { reason: "edited" } : {}),
      ...(what.state === "failed" ? { reason: what.reason } : {}),
    },
  });
}

/** The skill's waiting update was applied or refused: its notices are done. */
export const resolveSkillWaiting = (deps: NotificationDeps, orgId: string, skillId: string) =>
  resolveNotifications(deps, orgId, { groupKeyPrefix: skillWaitingGroup(skillId) });

// ── Workspace standing (ADR 0056 §8) ──────────────────────────────────────────

/**
 * The people who run this server held, suspended or restored the workspace, with the notice shown: its
 * owners and admins hear it, with the reason (`latest.text`), or a billing hold's code (`latest.billingHold`,
 * ADR 0079), which the apps say in the person's words, and on agentes.chat Cloud `latest.cloud`, so the apps
 * read a restriction as the restriction itself reads. One row per change.
 */
export async function notifyOrgStanding(
  deps: NotificationDeps,
  orgId: string,
  standing: { state: string; reason: string | null; changedAt: Date | null; billing?: boolean; cloud?: boolean },
) {
  const why = standing.billing
    ? { billingHold: standing.reason ?? "" }
    : standing.reason
      ? { text: notificationSnippet(standing.reason) }
      : {};
  await notify(deps, {
    orgId,
    userIds: await adminsOf(deps, orgId, "configure"),
    kind: "org_standing",
    groupKey: `org_standing:${orgId}:${standing.changedAt?.getTime() ?? 0}`,
    source: {},
    latest: { statusTo: standing.state, ...why, ...(standing.cloud ? { cloud: true } : {}) },
  });
}

const agentHoldGroup = (agentId: string) => `org_standing:agent:${agentId}:`;

/**
 * An agent was held on agentes.chat Cloud (ADR 0056 §9): its responsible person and the workspace's owners and admins
 * hear it, with the hold's kind (`latest.holdKind`), never its reason. One row each time they are told (`at`): when
 * it is held, and when it is held again for another kind.
 */
export async function notifyAgentHold(
  deps: NotificationDeps,
  hold: { orgId: string; agentId: string; name: string; kind: string; at: Date },
) {
  await notify(deps, {
    orgId: hold.orgId,
    userIds: [await agentOwner(deps, hold.agentId), ...(await adminsOf(deps, hold.orgId, "manage_agents"))],
    kind: "org_standing",
    groupKey: `${agentHoldGroup(hold.agentId)}${hold.at.getTime()}:${hold.kind}`,
    source: { agentId: hold.agentId, label: hold.name },
    latest: { statusTo: "agent_hold", holdKind: hold.kind },
  });
}

/** The agent was let go: what its people were told of the hold is done. */
export const resolveAgentHold = (deps: NotificationDeps, orgId: string, agentId: string) =>
  resolveNotifications(deps, orgId, { groupKeyPrefix: agentHoldGroup(agentId), kind: "org_standing" });

// ── Agent browser (ADR 0040) ──────────────────────────────────────────────────

/**
 * Who an agent's browser handoff is asked of: the person behind the run, else the agent's owner, the first whose
 * roles give them the agents' browsers (`own_browsers`); null: nobody in particular.
 */
export async function browserHandoffRecipient(
  deps: Pick<NotificationDeps, "db">,
  orgId: string,
  runId: string | null,
  agentId: string,
) {
  const asked = [await requesterOfRun(deps, orgId, runId), await agentOwner(deps, agentId)];
  const may = await mayOf(deps, orgId, asked, "own_browsers");
  return asked.find((id) => id && may.includes(id)) ?? null;
}

/** Those of `userIds` who may `permission` in the organization (ADR 0085). */
async function mayOf(
  deps: Pick<NotificationDeps, "db">,
  orgId: string,
  userIds: (string | null)[],
  permission: RolePermission,
) {
  const ids = userIds.filter((id): id is string => !!id);
  if (ids.length === 0) return [];
  const rows = await deps.db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.userId, ids),
        maySql(orgId, organizationMembers.userId, permission),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * An agent needs a person in its browser (`browser_ask_person`): in the
 * "Waiting for you" of whoever asked for the work and of the agent's
 * responsible person, with a push. Either may open it; the first in control
 * does it, the other sees who is helping. `to`: exactly who instead (a
 * desktop's request goes only to who may drive its computer).
 */
export async function notifyBrowserHandoff(
  deps: NotificationDeps,
  h: typeof schema.browserHandoffs.$inferSelect,
  where: { channelId: string; threadId: string | null },
  to?: string[],
) {
  // Who asked for the work and the agent's responsible person (once when it's the same person), if their roles
  // give them the agents' browsers.
  const userIds = [
    ...new Set(
      to ?? (await mayOf(deps, h.orgId, [h.requestedForUserId, await agentOwner(deps, h.agentId)], "own_browsers")),
    ),
  ];
  if (userIds.length === 0) return;
  const [channel] = await deps.db
    .select({ kind: channels.kind, name: channels.name })
    .from(channels)
    .where(eq(channels.id, where.channelId));
  const handoff = { handoffId: h.id, agentId: h.agentId, ...(h.screen !== "browser" ? { screen: h.screen } : {}) };
  const base = {
    orgId: h.orgId,
    kind: "browser_handoff",
    groupKey: `browser_handoff:${h.id}`,
    waiting: true,
    actor: agent(h.agentId),
    latest: { text: notificationSnippet(h.instructions), expiresAt: h.expiresAt.toISOString() },
  } as const;
  const members = await inChannel(deps, where.channelId, userIds);
  await notify(deps, {
    ...base,
    userIds: members,
    source: {
      channelId: where.channelId,
      ...(where.threadId ? { threadId: where.threadId } : {}),
      messageId: h.id,
      ...(channel?.kind === "dm" ? { dmId: where.channelId } : {}),
      ...(channel?.kind === "channel" ? { label: channel.name } : {}),
      ...handoff,
    },
  });
  // Who can't open the card's conversation gets no link to it: the request opens on the agent's computer.
  const others = userIds.filter((id) => !members.includes(id));
  if (others.length > 0) await notify(deps, { ...base, userIds: others, source: handoff });
}

/** Still unanswered an hour later: back on top, unread, and pushed once more saying the agent still needs them. */
export const remindBrowserHandoffNotifications = (deps: NotificationDeps, orgId: string, handoffId: string) =>
  remindNotifications(deps, orgId, `browser_handoff:${handoffId}`, { reminder: true }, "reminder");

/** Done, couldn't, canceled or expired: out of everyone's inbox. */
export async function resolveBrowserHandoffNotifications(deps: NotificationDeps, orgId: string, handoffId: string) {
  await resolveNotifications(deps, orgId, { groupKey: `browser_handoff:${handoffId}` });
}

/**
 * Something an AI app created as the person (ADR 0119): it tells them in their own inbox, one row per connection that
 * sums what it made while unread ("Claude criou 3 agentes e 2 rotinas pelo app"), opening the newest agent or routine.
 */
export async function notifyAppCreated(
  deps: NotificationDeps,
  input: { orgId: string; userId: string; grantId: string; app: string; kind: string; id: string },
) {
  await notify(deps, {
    orgId: input.orgId,
    userIds: [input.userId],
    kind: "app_created",
    groupKey: `app_created:${input.grantId}`,
    source: input.kind === "agent" ? { agentId: input.id } : input.kind === "routine" ? { routineId: input.id } : {},
    latest: { title: input.app, created: { [input.kind]: 1 } },
  });
}
