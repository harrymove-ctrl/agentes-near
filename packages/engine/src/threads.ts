import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  ne,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { type Channel, requireChannelAccess } from "./channels";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated, publishUserEvent } from "./events";
import { followsThreadSql, threadReadAtSql } from "./follows";
import { landedAfterSql } from "./message-place";
import { type PreviewMeta, previewMeta, readableBody } from "./message-preview";
import { type Message, messageView, replyExcerpt } from "./messages";
import { pendingCommandsSql } from "./mission-command-rules";
import { quietNoticeSql } from "./notices";
import { can, type Membership, requirePermission } from "./organizations";
import { maySql } from "./permissions";
import { taskReaderSql } from "./task-access";

const { threads, messages, channels, channelMembers } = schema;

/**
 * Threads (ADR 0029, sections 1, 9, 11 and 12).
 *
 * A thread is still implicit: its replies carry `thread_id` = the root
 * message id. A `threads` row holds what a thread has of its own: a title,
 * a state (`open | closed | archived`) and a context range.
 *
 * Thread from a range ("Criar thread a partir daqui"): the new thread needs
 * a root, and no message of the range can be it (the range may change, may
 * come from another channel, and its first message may already have
 * replies). So the root is a NEW top-level message in the thread's channel,
 * written by the person who created it, with the title as its text and
 * `meta.threadStart` describing the range. It is written directly (no
 * outbox): it routes to no agent and starts no run. The web shows it as the
 * context marker ("Este trecho virou contexto da thread …") and, once the
 * range is moved, as the stub ("N mensagens movidas para a thread …").
 * Replies, runs and summaries then work exactly as for any thread.
 */

export type ThreadState = "open" | "closed" | "archived";
export type ThreadChange =
  | "created"
  | "title"
  | "context"
  | "moved"
  | "returned"
  | "closed"
  | "reopened"
  | "archived"
  | "unarchived"
  | "deleted";
export type ThreadTab = "all" | "working" | "missions" | "closed" | "archived";

/** The most messages a context range may hold (after exclusions). */
export const MAX_CONTEXT_MESSAGES = 500;
export const MAX_THREAD_TITLE_LENGTH = 200;
/** An automatic title: the first message of the range, on one line, this long at most. */
export const AUTO_TITLE_LENGTH = 60;
/** Message ids carried by a `thread.updated` event at most (more: clients refetch). */
const MAX_EVENT_IDS = 50;

export interface ThreadDeps {
  db: Database;
  pubsub?: PubSub;
}

type Actor = { type: "person" | "agent"; id: string | null };

export interface ThreadContextView {
  channelId: string;
  firstMessageId: string;
  lastMessageId: string;
  excludedMessageIds: string[];
  /** The range left the channel and lives in the thread (a stub stays in the channel). */
  moved: boolean;
  /** Messages in the range now (deleted and excluded ones don't count). */
  count: number;
}

export interface ThreadInfo {
  /** The root message id (what replies carry as `threadId`). */
  id: string;
  channelId: string;
  channelName: string;
  channelKind: schema.ChannelKind;
  /** Null: no title of its own (show `rootText`). Written by a person, or by a model (`threads.assess`). */
  title: string | null;
  /** The root message's text, on one line (≤ 200 chars). */
  rootText: string;
  rootAuthor: Actor;
  state: ThreadState;
  /**
   * When "Responder" opened it (its first reply from the thread panel): replies from then on live in
   * the panel and the channel shows one line. Null: the channel shows its replies in the timeline.
   */
  openedByReplyAt: string | null;
  createdBy: string | null;
  closedBy: string | null;
  closedAt: string | null;
  archivedBy: string | null;
  archivedAt: string | null;
  context: ThreadContextView | null;
  replyCount: number;
  lastActivityAt: string;
  /** `meta`: what the app needs to show a server-written body in the reader's language (null: plain). */
  lastMessage: { author: Actor; excerpt: string; meta: PreviewMeta | null; createdAt: string } | null;
  /** Distinct authors of the root and the replies: people and agents. */
  participants: Actor[];
  /** An agent run is in progress (or waiting for approval or an answer) in this thread. */
  working: boolean;
  /** An agent asked something here and the actor took part, or an approval here waits for the actor. */
  needsYou: boolean;
  /**
   * Open, and a cheap model judged its matter done after its last message
   * (`threads.assess`): the app offers to close it. Cleared by a new message,
   * closing or reopening; never closes anything by itself.
   */
  suggestedResolved: boolean;
  /** Whether the actor may close, archive, rename or change the context. */
  canManage: boolean;
  /**
   * The actor follows it: notified of its replies, which count as unread in
   * the channel. By default whoever started it or wrote in it; `PUT`/`DELETE
   * …/threads/{id}/follow` choose explicitly.
   */
  following: boolean;
  /**
   * Replies I haven't read in a thread I follow (0 otherwise), at most `MAX_THREAD_UNREAD`: not mine, after my read
   * of the thread (`markThreadRead`; reading its channel doesn't count, replies aren't shown there).
   */
  unread: number;
  /** The thread's mission (ADR 0029), in short: details at `GET …/threads/{id}/mission`. */
  mission: ThreadMissionSummary | null;
  createdAt: string;
}

export interface ThreadMissionSummary {
  id: string;
  /** The mission's agent (the row's avatar). */
  agentId: string;
  status: "proposed" | "active" | "paused" | "done" | "canceled" | "awaiting_close";
  planDone: number;
  planTotal: number;
  /**
   * Plan items waiting for people, pending decisions and pending reviews; command cards and a
   * mission waiting to be concluded (`awaiting_close`, counted once) for whoever answers them.
   */
  waitingYou: number;
}

/** `meta.threadStart` of a root written by `createThreadFromRange` (the web's context marker and stub). */
export interface ThreadStartMeta {
  title: string;
  contextChannelId: string;
  firstMessageId: string;
  lastMessageId: string;
  count: number;
  moved: boolean;
  movedCount: number;
}

// ── Access ─────────────────────────────────────────────────────────────────────

type ThreadRow = typeof threads.$inferSelect;

/**
 * Who sees a thread: whoever reads its channel (ADR 0029 §9; the same check
 * as the channel's messages). Returns the root, its row (if any), the channel
 * and the actor's membership.
 */
async function requireThread(db: Database, userId: string, orgId: string, rootId: string) {
  const [found] = await db
    .select({ root: messages, row: threads })
    .from(messages)
    .leftJoin(threads, and(eq(threads.orgId, orgId), eq(threads.rootMessageId, messages.id)))
    .where(and(eq(messages.id, rootId), eq(messages.orgId, orgId)));
  if (!found || found.root.deletedAt || found.root.threadId) throw new NotFoundError("Thread not found");
  const { channel, membership } = await requireChannelAccess(db, userId, orgId, found.root.channelId);
  return { root: found.root, row: found.row, channel, membership };
}

/** Plain threads have no owner (ADR 0029 §9): their creator, the root's author or an admin manage them. */
function mayManage(userId: string, membership: Membership, row: ThreadRow | null, root: Message) {
  return row?.createdBy === userId || root.authorUserId === userId || can(membership, "manage_channels");
}

function requireManage(userId: string, membership: Membership, row: ThreadRow | null, root: Message) {
  if (!mayManage(userId, membership, row, root)) {
    throw new ForbiddenError(
      "Only who created the thread, who wrote its first message or an admin can do this",
      "thread.not_allowed",
    );
  }
}

/**
 * While a mission is open in a thread (ADR 0029 §9), only its owner and
 * admins close, archive, move or re-range it; otherwise as for a plain thread.
 */
async function requireManageThread(
  db: Database,
  userId: string,
  membership: Membership,
  row: ThreadRow | null,
  root: Message,
) {
  const [mission] = await db
    .select({ ownerId: schema.missions.ownerId })
    .from(schema.missions)
    .where(
      and(
        eq(schema.missions.orgId, root.orgId),
        eq(schema.missions.threadRootId, root.id),
        inArray(schema.missions.status, ["proposed", "active", "paused", "awaiting_close"]),
      ),
    );
  if (mission) {
    if (mission.ownerId === userId || can(membership, "manage_channels")) return;
    throw new ForbiddenError(
      "Only the mission's owner or an admin can do this while the mission is open",
      "thread.not_allowed",
    );
  }
  requireManage(userId, membership, row, root);
}

/** The thread's row, created on first need (implicit threads get one when closed, archived or titled). */
async function ensureRow(db: Executor, root: Message): Promise<ThreadRow> {
  await db
    .insert(threads)
    .values({ orgId: root.orgId, channelId: root.channelId, rootMessageId: root.id })
    .onConflictDoNothing({ target: [threads.orgId, threads.rootMessageId] });
  const [row] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.orgId, root.orgId), eq(threads.rootMessageId, root.id)));
  if (!row) throw new Error("thread row missing after upsert");
  return row;
}

// ── Ranges ─────────────────────────────────────────────────────────────────────

interface Range {
  source: Channel;
  first: Message;
  last: Message;
  excluded: string[];
  count: number;
}

/** A message's exact `created_at` (microseconds), as SQL. */
const createdAtOf = (orgId: string, messageId: string) =>
  sql`(select x.created_at from ${messages} x where x.id = ${messageId}::uuid and x.org_id = ${orgId}::uuid)`;

/**
 * Checks a range: both ends are live top-level messages of the source
 * channel (in either order), exclusions are kept only when they fall in it,
 * and what is left holds 1 to MAX_CONTEXT_MESSAGES messages.
 */
async function resolveRange(
  db: Database,
  orgId: string,
  source: Channel,
  input: { firstMessageId: string; lastMessageId: string; excludedMessageIds?: string[] },
  options: { rootId?: string; movedIds?: string[] } = {},
): Promise<Range> {
  const ends = await db
    .select()
    .from(messages)
    .where(
      and(eq(messages.orgId, orgId), inArray(messages.id, [...new Set([input.firstMessageId, input.lastMessageId])])),
    );
  const moved = new Set(options.movedIds ?? []);
  const ok = (m: Message | undefined): m is Message =>
    !!m &&
    m.channelId === source.id &&
    !m.deletedAt &&
    m.id !== options.rootId &&
    (m.threadId === null || (m.threadId === options.rootId && moved.has(m.id)));
  let first = ends.find((m) => m.id === input.firstMessageId);
  let last = ends.find((m) => m.id === input.lastMessageId);
  if (!ok(first) || !ok(last)) {
    throw new ValidationError(
      "The range must start and end on messages of the conversation (not replies)",
      "thread.range_invalid",
    );
  }
  if (first.createdAt > last.createdAt || (+first.createdAt === +last.createdAt && first.id > last.id)) {
    [first, last] = [last, first];
  }
  const wanted = [...new Set(input.excludedMessageIds ?? [])].slice(0, MAX_CONTEXT_MESSAGES);
  const inRange = and(
    eq(messages.orgId, orgId),
    eq(messages.channelId, source.id),
    // Bounds read in the database: a JS Date drops the microseconds and would lose the last message.
    sql`${messages.createdAt} >= ${createdAtOf(orgId, first.id)}`,
    sql`${messages.createdAt} <= ${createdAtOf(orgId, last.id)}`,
    isNull(messages.deletedAt),
    options.rootId ? ne(messages.id, options.rootId) : undefined,
    options.movedIds?.length
      ? sql`(${messages.threadId} is null or ${inArray(messages.id, options.movedIds)})`
      : isNull(messages.threadId),
  );
  const [excludedRows, [total]] = await Promise.all([
    wanted.length > 0
      ? db
          .select({ id: messages.id })
          .from(messages)
          .where(and(inRange, inArray(messages.id, wanted)))
      : Promise.resolve([] as { id: string }[]),
    db.select({ n: sql<number>`count(*)::int` }).from(messages).where(inRange),
  ]);
  const excluded = excludedRows.map((r) => r.id);
  const count = Number(total?.n ?? 0) - excluded.length;
  if (count < 1) throw new ValidationError("The range has no messages left", "thread.range_empty");
  if (count > MAX_CONTEXT_MESSAGES) {
    throw new ValidationError(
      `A thread's context holds at most ${MAX_CONTEXT_MESSAGES} messages`,
      "thread.range_too_long",
      { max: MAX_CONTEXT_MESSAGES },
    );
  }
  return { source, first, last, excluded, count };
}

/**
 * A range may only come from a channel everyone in the destination can see
 * (ADR 0029 §1): a public channel, or one where every member of the
 * destination (people and agents) is also a member. Refused with
 * `thread.context_not_visible` and who can't see it.
 */
/**
 * At run time (ADR 0029): a range from another channel is used only while
 * everyone in the thread can still see that channel (cached briefly; a run
 * with it gone reads the thread without the range).
 */
export async function rangeStillVisible(db: Database, orgId: string, destinationId: string, sourceId: string) {
  if (sourceId === destinationId) return true;
  return (await caches.rangeVisible.getOrLoad(`${orgId}:${destinationId}:${sourceId}`, async () => {
    const [source] = await db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, sourceId)));
    if (!source) return false;
    return requireRangeVisible(db, orgId, destinationId, source as Channel).then(
      () => true,
      () => false,
    );
  })) as boolean;
}

async function requireRangeVisible(db: Database, orgId: string, destinationId: string, source: Channel) {
  if (source.id === destinationId) return;
  if (source.kind === "channel" && source.visibility === "public") return;
  const [dest, src] = await Promise.all(
    [destinationId, source.id].map((channelId) =>
      db
        .select({ userId: channelMembers.userId, agentId: channelMembers.agentId })
        .from(channelMembers)
        .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId))),
    ),
  );
  const seeing = new Set((src ?? []).map((m) => m.userId ?? `a:${m.agentId}`));
  const blind = (dest ?? []).filter((m) => !seeing.has(m.userId ?? `a:${m.agentId}`));
  if (blind.length === 0) return;
  throw new ForbiddenError(
    "Not everyone in this conversation can see where these messages come from",
    "thread.context_not_visible",
    {
      userIds: blind.flatMap((m) => (m.userId ? [m.userId] : [])),
      agentIds: blind.flatMap((m) => (m.agentId ? [m.agentId] : [])),
    },
  );
}

/** A short title from the first message: one line, no code fences. */
export function autoThreadTitle(body: string): string {
  return replyExcerpt(body, AUTO_TITLE_LENGTH) || "Thread";
}

const cleanTitle = (title: string | null | undefined) => {
  const t = title?.replace(/\s+/g, " ").trim() ?? "";
  if (t.length > MAX_THREAD_TITLE_LENGTH) {
    throw new ValidationError(`A title has at most ${MAX_THREAD_TITLE_LENGTH} characters`, "thread.title_too_long", {
      max: MAX_THREAD_TITLE_LENGTH,
    });
  }
  return t || null;
};

/** Keeps the root's `meta.threadStart` (what the channel shows) in step with the row. */
async function syncThreadStart(db: Executor, root: Message, patch: Partial<ThreadStartMeta>) {
  if (!root.meta.threadStart) return;
  await db
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{threadStart}',
        coalesce(${messages.meta}->'threadStart', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
    })
    .where(and(eq(messages.id, root.id), eq(messages.orgId, root.orgId)));
}

// ── Create, adjust, move ──────────────────────────────────────────────────────

/**
 * One click: a thread whose context is a range of a conversation (a
 * reference; nothing leaves the channel). The range may come from another
 * channel only when everyone in this one can see it. No title: one is made
 * from the first message of the range.
 */
export async function createThreadFromRange(
  deps: ThreadDeps,
  actorId: string,
  input: {
    orgId: string;
    /** Where the thread lives. */
    channelId: string;
    /** Where the range comes from (default: `channelId`). */
    contextChannelId?: string;
    firstMessageId: string;
    lastMessageId: string;
    excludedMessageIds?: string[];
    title?: string | null;
  },
): Promise<ThreadInfo> {
  const { db } = deps;
  const { orgId } = input;
  const { channel, membership } = await requireChannelAccess(db, actorId, orgId, input.channelId);
  if (!can(membership, "post")) throw new ForbiddenError();
  const source =
    input.contextChannelId && input.contextChannelId !== channel.id
      ? (await requireChannelAccess(db, actorId, orgId, input.contextChannelId)).channel
      : channel;
  const range = await resolveRange(db, orgId, source, input);
  await requireRangeVisible(db, orgId, channel.id, source);
  const given = cleanTitle(input.title);
  const title = given ?? autoThreadTitle(readableBody(range.first.body, range.first.meta));
  const start: ThreadStartMeta = {
    title,
    contextChannelId: source.id,
    firstMessageId: range.first.id,
    lastMessageId: range.last.id,
    count: range.count,
    moved: false,
    movedCount: 0,
  };
  const root = await db.transaction(async (tx) => {
    const [message] = await tx
      .insert(messages)
      .values({
        // `created_at` from the database clock (now()), like every message: it sorts after the range.
        id: Bun.randomUUIDv7(),
        orgId,
        channelId: channel.id,
        authorType: "person",
        authorUserId: actorId,
        body: title,
        meta: { threadStart: start },
      })
      .returning();
    if (!message) throw new Error("thread root insert returned nothing");
    await tx.insert(threads).values({
      orgId,
      channelId: channel.id,
      rootMessageId: message.id,
      title,
      // Made from the first message: a model may write a better one later; a person's title stays.
      titleAuto: given === null,
      createdBy: actorId,
      contextChannelId: source.id,
      contextFirstMessageId: range.first.id,
      contextLastMessageId: range.last.id,
      contextFirstAt: createdAtOf(orgId, range.first.id),
      contextLastAt: createdAtOf(orgId, range.last.id),
      contextExcludedMessageIds: range.excluded,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "thread.created",
      target: { type: "thread", id: message.id },
      details: { channelId: channel.id, contextChannelId: source.id, count: range.count },
    });
    return message;
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(root));
  return publishThread(deps, actorId, orgId, root.id, "created", { alsoChannelId: source.id });
}

/**
 * Renames a thread, or changes its range ("Ajustar trecho"). A moved range is
 * returned and moved again, so the channel and the thread stay consistent.
 * An empty title goes back to the root's text.
 */
export async function updateThread(
  deps: ThreadDeps,
  actorId: string,
  orgId: string,
  rootId: string,
  input: {
    title?: string | null;
    firstMessageId?: string;
    lastMessageId?: string;
    excludedMessageIds?: string[];
  },
): Promise<ThreadInfo> {
  const { db } = deps;
  const { root, row, channel, membership } = await requireThread(db, actorId, orgId, rootId);
  await requireManageThread(db, actorId, membership, row, root);
  if (row?.state === "archived") throw new ConflictError("This thread is archived", "thread.archived");
  const rangeChange =
    input.firstMessageId !== undefined || input.lastMessageId !== undefined || input.excludedMessageIds !== undefined;
  const titleChange = input.title !== undefined;
  if (!rangeChange && !titleChange) return getThread(db, actorId, orgId, rootId);
  let range: Range | null = null;
  if (rangeChange) {
    const sourceId = row?.contextChannelId ?? channel.id;
    const source =
      sourceId === channel.id ? channel : (await requireChannelAccess(db, actorId, orgId, sourceId)).channel;
    const first = input.firstMessageId ?? row?.contextFirstMessageId;
    const last = input.lastMessageId ?? row?.contextLastMessageId;
    if (!first || !last) {
      throw new ValidationError("Give the first and the last message of the range", "thread.range_invalid");
    }
    range = await resolveRange(
      db,
      orgId,
      source,
      {
        firstMessageId: first,
        lastMessageId: last,
        excludedMessageIds: input.excludedMessageIds ?? row?.contextExcludedMessageIds ?? [],
      },
      { rootId: root.id, movedIds: row?.contextMovedMessageIds ?? [] },
    );
    await requireRangeVisible(db, orgId, channel.id, source);
  }
  // A moved range moves again with its new bounds: none of the new messages may have replies of their own.
  if (range && row?.contextMoved) {
    const nested = rowsOf<{ id: string }>(
      await db.execute(sql`select m.id from ${messages} m
        where m.org_id = ${orgId}::uuid and m.channel_id = ${range.source.id}::uuid
          and m.created_at >= ${createdAtOf(orgId, range.first.id)} and m.created_at <= ${createdAtOf(orgId, range.last.id)}
          and (m.thread_id is null or m.thread_id = ${root.id}::uuid) and m.deleted_at is null and m.id <> ${root.id}::uuid
          and not (m.id = any(${`{${range.excluded.join(",")}}`}::uuid[]))
          and exists (select 1 from ${messages} r where r.org_id = m.org_id and r.thread_id = m.id and r.deleted_at is null)
        limit 20`),
    ).map((r) => r.id);
    if (nested.length > 0) {
      throw new ConflictError("Some of these messages have replies of their own", "thread.range_has_replies", {
        messageIds: nested,
      });
    }
  }
  const title = titleChange ? cleanTitle(input.title) : undefined;
  let movedIds: string[] = [];
  let returnedIds: string[] = [];
  await db.transaction(async (tx) => {
    const current = await ensureRow(tx, root);
    const wasMoved = current.contextMoved;
    if (range && wasMoved) returnedIds = await returnMoved(tx, current);
    await tx
      .update(threads)
      .set({
        // A person's title: the model never overwrites it (an empty one gives the model the floor again).
        ...(title !== undefined ? { title, titleAuto: false } : {}),
        ...(range
          ? {
              contextChannelId: range.source.id,
              contextFirstMessageId: range.first.id,
              contextLastMessageId: range.last.id,
              contextFirstAt: createdAtOf(orgId, range.first.id),
              contextLastAt: createdAtOf(orgId, range.last.id),
              contextExcludedMessageIds: range.excluded,
              contextMoved: false,
              contextMovedMessageIds: [],
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, current.id));
    if (range && wasMoved) {
      const [fresh] = await tx.select().from(threads).where(eq(threads.id, current.id));
      if (fresh) movedIds = await moveRange(tx, fresh, root);
    }
    await syncThreadStart(tx, root, {
      ...(title !== undefined ? { title: title ?? readableBody(root.body, root.meta) } : {}),
      ...(range
        ? {
            contextChannelId: range.source.id,
            firstMessageId: range.first.id,
            lastMessageId: range.last.id,
            count: range.count,
            moved: wasMoved,
            movedCount: movedIds.length,
          }
        : {}),
    });
  });
  if (rangeChange && (movedIds.length > 0 || returnedIds.length > 0)) {
    // The channel redraws: some messages came back, others left.
    const back = returnedIds.filter((id) => !movedIds.includes(id));
    const left = movedIds.filter((id) => !returnedIds.includes(id));
    if (back.length > 0) await publishThread(deps, actorId, orgId, rootId, "returned", { messageIds: back });
    if (left.length > 0) await publishThread(deps, actorId, orgId, rootId, "moved", { messageIds: left });
  }
  return publishThread(deps, actorId, orgId, rootId, rangeChange ? "context" : "title");
}

/** Moves the range's messages into the thread (`thread_id` = root). Returns their ids. */
async function moveRange(tx: Executor, row: ThreadRow, root: Message): Promise<string[]> {
  if (!row.contextFirstAt || !row.contextLastAt) return [];
  const moved = rowsOf<{ id: string }>(
    await tx.execute(sql`update ${messages} m set thread_id = ${root.id}::uuid
      from ${threads} t
      where t.id = ${row.id}::uuid and m.org_id = t.org_id and m.channel_id = t.context_channel_id
        and m.created_at >= t.context_first_at and m.created_at <= t.context_last_at
        and m.thread_id is null and m.deleted_at is null and m.id <> ${root.id}::uuid
        and not (m.id = any(t.context_excluded_message_ids))
      returning m.id`),
  ).map((r) => r.id);
  await tx
    .update(threads)
    .set({ contextMoved: true, contextMovedMessageIds: moved, updatedAt: new Date() })
    .where(eq(threads.id, row.id));
  return moved;
}

/** Puts moved messages back in the channel: exactly the ones moved, never real replies. */
async function returnMoved(tx: Executor, row: ThreadRow): Promise<string[]> {
  if (!row.contextMoved || !row.contextFirstAt || !row.contextLastAt) return [];
  const back = rowsOf<{ id: string }>(
    await tx.execute(sql`update ${messages} m set thread_id = null
      from ${threads} t
      where t.id = ${row.id}::uuid and m.org_id = t.org_id and m.channel_id = t.context_channel_id
        and m.created_at >= t.context_first_at and m.created_at <= t.context_last_at
        and m.thread_id = t.root_message_id and m.id = any(t.context_moved_message_ids)
      returning m.id`),
  ).map((r) => r.id);
  await tx
    .update(threads)
    .set({ contextMoved: false, contextMovedMessageIds: [], updatedAt: new Date() })
    .where(eq(threads.id, row.id));
  return back;
}

/**
 * "Tirar do canal": the range leaves the channel and lives in the thread; the
 * root stays in the channel as the stub ("N messages moved"). Only for a
 * range of the thread's own channel; a message of the range that has
 * replies of its own can't move (its thread would be lost).
 */
export async function moveContextIntoThread(
  deps: ThreadDeps,
  actorId: string,
  orgId: string,
  rootId: string,
): Promise<ThreadInfo> {
  const { db } = deps;
  const { root, row, membership } = await requireThread(db, actorId, orgId, rootId);
  await requireManageThread(db, actorId, membership, row, root);
  if (!row?.contextFirstAt || !row.contextLastAt) {
    throw new ValidationError("This thread has no context range", "thread.no_context");
  }
  if (row.state === "archived") throw new ConflictError("This thread is archived", "thread.archived");
  if (row.contextChannelId !== root.channelId) {
    throw new ValidationError("Only messages of this thread's channel can move into it", "thread.move_other_channel");
  }
  if (row.contextMoved) return getThread(db, actorId, orgId, rootId);
  const nested = rowsOf<{ id: string }>(
    await db.execute(sql`select m.id from ${messages} m
      join ${threads} t on t.id = ${row.id}::uuid
      where m.org_id = t.org_id and m.channel_id = t.context_channel_id
        and m.created_at >= t.context_first_at and m.created_at <= t.context_last_at
        and m.thread_id is null and m.deleted_at is null and m.id <> t.root_message_id
        and not (m.id = any(t.context_excluded_message_ids))
        and exists (select 1 from ${messages} r where r.org_id = m.org_id and r.thread_id = m.id
          and r.deleted_at is null)
      limit 20`),
  ).map((r) => r.id);
  if (nested.length > 0) {
    throw new ConflictError("Some of these messages have replies of their own", "thread.range_has_replies", {
      messageIds: nested,
    });
  }
  const moved = await db.transaction(async (tx) => {
    const ids = await moveRange(tx, row, root);
    await syncThreadStart(tx, root, { moved: true, movedCount: ids.length });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "thread.context_moved",
      target: { type: "thread", id: root.id },
      details: { channelId: root.channelId, count: ids.length },
    });
    return ids;
  });
  return publishThread(deps, actorId, orgId, rootId, "moved", { messageIds: moved });
}

/** Undo of "Tirar do canal": the moved messages go back to the channel; the thread keeps them as context. */
export async function returnContextToChannel(
  deps: ThreadDeps,
  actorId: string,
  orgId: string,
  rootId: string,
): Promise<ThreadInfo> {
  const { db } = deps;
  const { root, row, membership } = await requireThread(db, actorId, orgId, rootId);
  await requireManageThread(db, actorId, membership, row, root);
  if (!row?.contextMoved) return getThread(db, actorId, orgId, rootId);
  if (row.state === "archived") throw new ConflictError("This thread is archived", "thread.archived");
  const back = await db.transaction(async (tx) => {
    const ids = await returnMoved(tx, row);
    await syncThreadStart(tx, root, { moved: false, movedCount: 0 });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "thread.context_returned",
      target: { type: "thread", id: root.id },
      details: { channelId: root.channelId, count: ids.length },
    });
    return ids;
  });
  return publishThread(deps, actorId, orgId, rootId, "returned", { messageIds: back });
}

/**
 * Undo of "Criar thread" (the toast's "Desfazer"): only a thread made from a
 * range that nobody replied to yet. Moved messages go back first; the root
 * is deleted (soft) and the row removed.
 */
export async function deleteThread(deps: ThreadDeps, actorId: string, orgId: string, rootId: string) {
  const { db } = deps;
  const { root, row, membership } = await requireThread(db, actorId, orgId, rootId);
  await requireManageThread(db, actorId, membership, row, root);
  if (!row || !root.meta.threadStart) {
    throw new ValidationError("Only a thread made from a range can be undone", "thread.not_undoable");
  }
  const [replies] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.threadId, root.id),
        isNull(messages.deletedAt),
        row.contextMovedMessageIds.length > 0
          ? sql`not (${messages.id} = any(${`{${row.contextMovedMessageIds.join(",")}}`}::uuid[]))`
          : undefined,
      ),
    );
  if (Number(replies?.n ?? 0) > 0) {
    throw new ConflictError("Someone already replied in this thread", "thread.has_replies");
  }
  const back = await db.transaction(async (tx) => {
    const ids = await returnMoved(tx, row);
    await tx
      .update(messages)
      .set({ deletedAt: new Date() })
      .where(and(eq(messages.id, root.id), eq(messages.orgId, orgId)));
    await tx.delete(threads).where(eq(threads.id, row.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "thread.deleted",
      target: { type: "thread", id: root.id },
      details: { channelId: root.channelId },
    });
    return ids;
  });
  const event = {
    type: "thread.updated" as const,
    threadId: root.id,
    change: "deleted" as const,
    ...(back.length > 0 && back.length <= MAX_EVENT_IDS ? { messageIds: back } : {}),
  };
  await publishChannelEvent(deps.pubsub, { ...event, channelId: root.channelId });
  if (row.contextChannelId && row.contextChannelId !== root.channelId) {
    await publishChannelEvent(deps.pubsub, { ...event, channelId: row.contextChannelId });
  }
}

// ── Close and archive ─────────────────────────────────────────────────────────

type StateAction = "close" | "reopen" | "archive" | "unarchive";

/**
 * Fechar / Reabrir / Arquivar / Desarquivar (ADR 0029 §11). Closed: resolved,
 * reopens when a person replies. Archived: hidden from lists by default and
 * read only. Unarchiving returns to what it was before (closed or open).
 * Idempotent: asking for the state it is already in changes nothing.
 */
async function setThreadState(
  deps: ThreadDeps,
  actorId: string,
  orgId: string,
  rootId: string,
  action: StateAction,
): Promise<ThreadInfo> {
  const { db } = deps;
  const { root, row, membership } = await requireThread(db, actorId, orgId, rootId);
  await requireManageThread(db, actorId, membership, row, root);
  const state: ThreadState = row?.state ?? "open";
  if ((action === "close" || action === "reopen") && state === "archived") {
    throw new ConflictError("This thread is archived", "thread.archived");
  }
  const next: ThreadState =
    action === "close"
      ? "closed"
      : action === "reopen"
        ? "open"
        : action === "archive"
          ? "archived"
          : state === "archived"
            ? row?.closedAt
              ? "closed"
              : "open"
            : state;
  if (next === state) return getThread(db, actorId, orgId, rootId);
  const now = new Date();
  await db.transaction(async (tx) => {
    const current = await ensureRow(tx, root);
    await tx
      .update(threads)
      .set({
        state: next,
        // Any decision about the state answers the "resolved?" suggestion.
        resolvedSuggestedAt: null,
        ...(action === "close" ? { closedBy: actorId, closedAt: now } : {}),
        ...(action === "reopen" ? { closedBy: null, closedAt: null } : {}),
        ...(action === "archive" ? { archivedBy: actorId, archivedAt: now } : {}),
        ...(action === "unarchive" ? { archivedBy: null, archivedAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(threads.id, current.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: `thread.${{ close: "closed", reopen: "reopened", archive: "archived", unarchive: "unarchived" }[action]}`,
      target: { type: "thread", id: root.id },
      details: { channelId: root.channelId },
    });
  });
  const change: ThreadChange = (
    { close: "closed", reopen: "reopened", archive: "archived", unarchive: "unarchived" } as const
  )[action];
  return publishThread(deps, actorId, orgId, rootId, change);
}

export const closeThread = (deps: ThreadDeps, actorId: string, orgId: string, rootId: string) =>
  setThreadState(deps, actorId, orgId, rootId, "close");
export const reopenThread = (deps: ThreadDeps, actorId: string, orgId: string, rootId: string) =>
  setThreadState(deps, actorId, orgId, rootId, "reopen");
export const archiveThread = (deps: ThreadDeps, actorId: string, orgId: string, rootId: string) =>
  setThreadState(deps, actorId, orgId, rootId, "archive");
export const unarchiveThread = (deps: ThreadDeps, actorId: string, orgId: string, rootId: string) =>
  setThreadState(deps, actorId, orgId, rootId, "unarchive");

async function publishThread(
  deps: ThreadDeps,
  actorId: string,
  orgId: string,
  rootId: string,
  change: ThreadChange,
  options: { messageIds?: string[]; alsoChannelId?: string } = {},
): Promise<ThreadInfo> {
  const view = await getThread(deps.db, actorId, orgId, rootId);
  const event = {
    type: "thread.updated" as const,
    threadId: view.id,
    change,
    state: view.state,
    // `canManage` is the actor's own: everyone else reads theirs from the API. A large view
    // (many exclusions or participants) is left out: clients fetch it.
    // `following` is the actor's own too: left out.
    ...(Buffer.byteLength(JSON.stringify(view)) <= 4000
      ? { thread: { ...withoutFollowing(view), canManage: false } }
      : {}),
    // Pub/sub payloads stay small (NOTIFY < 8 KB): a long list is left out and clients refetch.
    ...(options.messageIds && options.messageIds.length <= MAX_EVENT_IDS ? { messageIds: options.messageIds } : {}),
  };
  await publishChannelEvent(deps.pubsub, { ...event, channelId: view.channelId });
  const other = options.alsoChannelId ?? view.context?.channelId;
  if (other && other !== view.channelId) await publishChannelEvent(deps.pubsub, { ...event, channelId: other });
  return view;
}

// ── Listing ────────────────────────────────────────────────────────────────────

export interface ListThreadsInput {
  orgId: string;
  tab?: ThreadTab;
  channelId?: string;
  /** The agent wrote in the thread or ran in it. */
  agentId?: string;
  /** "Precisa de você": an open question where the actor took part, or an approval waiting for them. */
  needsYou?: boolean;
  /** The actor created the thread, wrote its root or replied in it. */
  mine?: boolean;
  /** Words in the title or the root's text. */
  q?: string;
  cursor?: string | null;
  limit?: number;
}

interface ThreadSqlRow {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_kind: schema.ChannelKind;
  created_at: Date | string;
  body: string;
  root_meta: Record<string, unknown> | null;
  author_type: "person" | "agent";
  author_user_id: string | null;
  author_agent_id: string | null;
  reply_count: number | string;
  last_at: Date | string;
  title: string | null;
  state: ThreadState | null;
  opened_by_reply_at?: Date | string | null;
  created_by: string | null;
  closed_by: string | null;
  closed_at: Date | string | null;
  archived_by: string | null;
  archived_at: Date | string | null;
  context_channel_id: string | null;
  context_first_message_id: string | null;
  context_last_message_id: string | null;
  context_excluded_message_ids: string[] | string | null;
  context_moved: boolean | null;
  context_count: number | string | null;
  working: boolean;
  needs_you: boolean;
  suggested_resolved?: boolean | null;
  following?: boolean | null;
  unread?: number | string | null;
  mission_id?: string | null;
  mission_agent_id?: string | null;
  mission_status?: ThreadMissionSummary["status"] | null;
  mission_plan_done?: number | string | null;
  mission_plan_total?: number | string | null;
  mission_waiting?: number | string | null;
  /** `last_at` with microseconds, for the cursor. */
  cursor_at: string;
}

const toDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));
const isoOrNull = (v: Date | string | null) => (v === null ? null : toDate(v).toISOString());
const uuidArray = (v: string[] | string | null) =>
  Array.isArray(v) ? v : v ? v.replace(/^{|}$/g, "").split(",").filter(Boolean) : [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(lastAt: string, id: string) {
  return Buffer.from(`${lastAt}|${id}`).toString("base64url");
}

/** Microseconds kept (the database's precision), so a page never skips a row inside the same millisecond. */
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id] = Buffer.from(cursor, "base64url").toString().split("|");
  if (!at || !id || !UUID.test(id) || !CURSOR_AT.test(at)) {
    throw new ValidationError("Invalid cursor", "invalid_cursor");
  }
  return { at, id };
}

const ACTIVE_RUN = sql`('queued', 'running', 'waiting_approval', 'waiting_input')`;

/**
 * Threads of the channels the actor reads (members only, like the channel's
 * messages; DMs: its participants), built from the messages that have
 * replies plus the `threads` rows (a thread made from a range may have no
 * reply yet). Most recent activity first, paginated by a cursor.
 *
 * Unread: replies after my read of the thread, or my joining its channel (`unreadReplySql`).
 */
async function queryThreads(
  db: Database,
  userId: string,
  input: ListThreadsInput & { rootId?: string; anyState?: boolean },
): Promise<{ rows: ThreadSqlRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const orgId = input.orgId;
  const tab = input.tab ?? "all";
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const q = input.q?.trim().slice(0, 200);
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const participated = sql`(root.author_user_id = ${userId} or exists (select 1 from ${messages} pm
    where pm.org_id = ${orgId}::uuid and pm.thread_id = root.id and pm.author_user_id = ${userId}
      and pm.deleted_at is null))`;
  const stateFilter = input.anyState
    ? sql`true`
    : tab === "closed"
      ? sql`l.state = 'closed'`
      : tab === "archived"
        ? sql`l.state = 'archived'`
        : tab === "working"
          ? sql`l.state <> 'archived' and l.working`
          : tab === "missions"
            ? sql`l.state <> 'archived' and l.mission_id is not null`
            : sql`l.state <> 'archived'`;
  // The agent wrote the root or a reply, or ran in the thread.
  const agentFilter = input.agentId
    ? sql`and (l.author_agent_id = ${input.agentId}::uuid
        or exists (select 1 from ${messages} am where am.org_id = ${orgId}::uuid and am.thread_id = l.id
          and am.author_agent_id = ${input.agentId}::uuid)
        or exists (select 1 from ${schema.agentRuns} ar2 where ar2.org_id = ${orgId}::uuid
          and ar2.thread_root_id = l.id and ar2.agent_id = ${input.agentId}::uuid))`
    : sql``;
  // One channel's list: an administrator reads it without being in it (ADR 0151). The Threads page stays their own.
  const inList = input.channelId
    ? sql`c.id = ${input.channelId}::uuid and (cm.id is not null
        or (c.kind = 'channel' and ${maySql(sql`${orgId}::uuid`, sql`${userId}::text`, "administrator")}))`
    : sql`cm.id is not null`;
  const rows = rowsOf<ThreadSqlRow>(
    await db.execute(sql`with visible as (
        select c.id, c.name, c.kind, cm.created_at as joined_at from ${channels} c
        left join ${channelMembers} cm on cm.org_id = c.org_id and cm.channel_id = c.id and cm.user_id = ${userId}
        where c.org_id = ${orgId}::uuid and c.archived_at is null and c.kind in ('channel', 'dm') and ${inList}
      ), replies as (
        select m.thread_id as root_id, count(*)::int as reply_count, max(m.created_at) as last_at
        from ${messages} m
        where m.org_id = ${orgId}::uuid and m.channel_id in (select id from visible)
          and m.thread_id is not null and m.deleted_at is null
          and not ${quietNoticeSql(sql`m.meta`)}
          -- An agent's sticker or GIF after its own reply (ADR 0091) is part of that reply: no reply, no activity.
          and m.meta->>'mediaAfter' is null
          ${input.rootId ? sql`and m.thread_id = ${input.rootId}::uuid` : sql``}
        group by m.thread_id
      ), candidates as (
        select root_id from replies
        union
        select t.root_message_id from ${threads} t
        where t.org_id = ${orgId}::uuid and t.channel_id in (select id from visible)
          ${input.rootId ? sql`and t.root_message_id = ${input.rootId}::uuid` : sql``}
      ), listed as (
        select root.id, root.channel_id, v.name as channel_name, v.kind as channel_kind, v.joined_at, root.created_at,
          root.body, root.meta as root_meta, root.author_type, root.author_user_id, root.author_agent_id,
          coalesce(r.reply_count, 0) as reply_count, coalesce(r.last_at, root.created_at) as last_at,
          t.title, coalesce(t.state, 'open') as state, t.opened_by_reply_at, t.created_by, t.closed_by, t.closed_at,
          t.archived_by, t.archived_at, t.context_channel_id, t.context_first_message_id,
          t.context_last_message_id, t.context_excluded_message_ids, t.context_moved,
          case when t.context_first_at is null then null else (
            select count(*)::int from ${messages} cx
            where cx.org_id = ${orgId}::uuid and cx.channel_id = t.context_channel_id
              and cx.created_at >= t.context_first_at and cx.created_at <= t.context_last_at
              and cx.deleted_at is null and cx.id <> root.id
              and (cx.thread_id is null or cx.id = any(t.context_moved_message_ids))
              and not (cx.id = any(t.context_excluded_message_ids))
          ) end as context_count,
          exists (select 1 from ${schema.agentRuns} ar where ar.org_id = ${orgId}::uuid
            and ar.thread_root_id = root.id and ar.status in ${ACTIVE_RUN}
            -- Waiting for its computer to come back isn't working.
            and ar.waiting_machine_id is null) as working,
          (
            exists (select 1 from ${schema.agentQuestions} aq where aq.org_id = ${orgId}::uuid
              and aq.channel_id = root.channel_id and aq.thread_id = root.id and aq.status = 'open'
              and aq.expires_at > now()
              and (aq.requested_for_user_id = ${userId} or (aq.requested_for_user_id is null and ${participated})))
            or exists (select 1 from ${schema.approvals} ap where ap.org_id = ${orgId}::uuid
              and ap.status = 'pending' and ap.thread_root_id = root.id
              and (${maySql(orgId, userId, "approve_actions")} or ap.owner_user_id = ${userId}))
          ) as needs_you,
          -- The model's "resolved?" holds while no message came after the one it read.
          (coalesce(t.state, 'open') = 'open' and t.resolved_suggested_at is not null
            and t.resolved_suggested_at >= coalesce(r.last_at, root.created_at)) as suggested_resolved,
          ${participated} as participated,
          ${followsThreadSql(orgId, userId, sql`root.id`)} as following,
          mi.id as mission_id, mi.agent_id as mission_agent_id, mi.status as mission_status, mi.plan_done as mission_plan_done,
          mi.plan_total as mission_plan_total,
          case when mi.id is null then null else mi.plan_waiting
            + (select count(*)::int from ${schema.missionDecisions} md where md.mission_id = mi.id and md.status = 'pending')
            + (select count(*)::int from ${schema.missionReviews} mr where mr.mission_id = mi.id and mr.status = 'pending')
            + case when mi.owner_id = ${userId} or exists (select 1 from ${schema.missionParticipants} mpc
                where mpc.mission_id = mi.id and mpc.user_id = ${userId} and mpc.role = 'decide')
              then ${pendingCommandsSql(sql`mi.id`)} + case when mi.status = 'awaiting_close' then 1 else 0 end else 0 end
          end as mission_waiting
        from candidates c
        join ${messages} root on root.id = c.root_id and root.org_id = ${orgId}::uuid
        join visible v on v.id = root.channel_id
        left join replies r on r.root_id = root.id
        left join ${threads} t on t.org_id = ${orgId}::uuid and t.root_message_id = root.id
        left join ${schema.missions} mi on mi.org_id = ${orgId}::uuid and mi.thread_root_id = root.id
        where root.thread_id is null and root.deleted_at is null
      )
      select l.*, to_char(l.last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
        case when l.following then (select count(*)::int from (select 1 from ${messages} ur
          where ${unreadReplySql(orgId, userId, sql`l.id`, sql`l.joined_at`)} limit ${MAX_THREAD_UNREAD}) x) else 0 end
          as unread
      from listed l
      where ${stateFilter}
        ${agentFilter}
        ${input.needsYou ? sql`and l.needs_you` : sql``}
        ${input.mine ? sql`and (l.created_by = ${userId} or l.participated)` : sql``}
        ${like ? sql`and (l.title ilike ${like} or l.body ilike ${like})` : sql``}
        ${cursor ? sql`and (l.last_at, l.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
      order by l.last_at desc, l.id desc
      limit ${limit + 1}`),
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const tail = page.at(-1);
  return { rows: page, nextCursor: more && tail ? encodeCursor(tail.cursor_at, tail.id) : null };
}

/** Distinct authors and the latest reply of each thread on the page (two queries for the whole page). */
async function threadExtras(db: Database, orgId: string, rows: ThreadSqlRow[]) {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { authors: new Map<string, Actor[]>(), latest: new Map<string, Message>() };
  const scope = and(
    eq(messages.orgId, orgId),
    inArray(messages.threadId, ids),
    isNull(messages.deletedAt),
    sql`not ${quietNoticeSql(sql`${messages.meta}`)}`,
  );
  const [authorRows, latestRows] = await Promise.all([
    db
      .selectDistinct({
        threadId: messages.threadId,
        authorType: messages.authorType,
        userId: messages.authorUserId,
        agentId: messages.authorAgentId,
      })
      .from(messages)
      .where(scope),
    db
      .selectDistinctOn([messages.threadId])
      .from(messages)
      // The reply, not the agent's sticker or GIF after it (ADR 0091).
      .where(and(scope, sql`${messages.meta}->>'mediaAfter' is null`))
      .orderBy(messages.threadId, desc(messages.createdAt), desc(messages.id)),
  ]);
  const authors = new Map<string, Actor[]>();
  const push = (threadId: string, a: Actor) => {
    if (!a.id) return;
    const list = authors.get(threadId) ?? [];
    if (!list.some((x) => x.type === a.type && x.id === a.id)) list.push(a);
    authors.set(threadId, list);
  };
  for (const r of rows) {
    push(r.id, { type: r.author_type, id: r.author_type === "person" ? r.author_user_id : r.author_agent_id });
  }
  for (const a of authorRows) {
    if (!a.threadId) continue;
    push(a.threadId, { type: a.authorType, id: a.authorType === "person" ? a.userId : a.agentId });
  }
  const latest = new Map(latestRows.map((m) => [m.threadId ?? "", m]));
  return { authors, latest };
}

function toView(
  r: ThreadSqlRow,
  extras: Awaited<ReturnType<typeof threadExtras>>,
  userId: string,
  isAdmin: boolean,
): ThreadInfo {
  const last = extras.latest.get(r.id);
  return {
    id: r.id,
    channelId: r.channel_id,
    channelName: r.channel_name,
    channelKind: r.channel_kind,
    title: r.title,
    rootText: replyExcerpt(readableBody(r.body, r.root_meta)),
    rootAuthor: { type: r.author_type, id: r.author_type === "person" ? r.author_user_id : r.author_agent_id },
    state: r.state ?? "open",
    openedByReplyAt: isoOrNull(r.opened_by_reply_at ?? null),
    createdBy: r.created_by,
    closedBy: r.closed_by,
    closedAt: isoOrNull(r.closed_at),
    archivedBy: r.archived_by,
    archivedAt: isoOrNull(r.archived_at),
    context:
      r.context_channel_id && r.context_first_message_id && r.context_last_message_id
        ? {
            channelId: r.context_channel_id,
            firstMessageId: r.context_first_message_id,
            lastMessageId: r.context_last_message_id,
            excludedMessageIds: uuidArray(r.context_excluded_message_ids),
            moved: r.context_moved === true,
            count: Number(r.context_count ?? 0),
          }
        : null,
    replyCount: Number(r.reply_count),
    lastActivityAt: toDate(r.last_at).toISOString(),
    lastMessage: last
      ? {
          author: { type: last.authorType, id: last.authorType === "person" ? last.authorUserId : last.authorAgentId },
          excerpt: replyExcerpt(readableBody(last.body, last.meta)),
          meta: previewMeta(last.meta),
          createdAt: last.createdAt.toISOString(),
        }
      : null,
    participants: extras.authors.get(r.id) ?? [],
    working: r.working === true,
    needsYou: r.needs_you === true,
    suggestedResolved: r.suggested_resolved === true,
    canManage: r.created_by === userId || (r.author_type === "person" && r.author_user_id === userId) || isAdmin,
    following: r.following === true,
    unread: Number(r.unread ?? 0),
    mission:
      r.mission_id && r.mission_status
        ? {
            id: r.mission_id,
            agentId: r.mission_agent_id ?? "",
            status: r.mission_status,
            planDone: Number(r.mission_plan_done ?? 0),
            planTotal: Number(r.mission_plan_total ?? 0),
            waitingYou: Number(r.mission_waiting ?? 0),
          }
        : null,
    createdAt: toDate(r.created_at).toISOString(),
  };
}

/**
 * The Threads page and a channel's "Threads (N)" (ADR 0029 §11): tabs
 * `all` (not archived), `working` (an agent run in progress), `closed`,
 * `archived`; filters by channel, agent, "needs you", "mine" and words.
 */
export async function listThreads(
  db: Database,
  actorId: string,
  input: ListThreadsInput,
): Promise<{ threads: ThreadInfo[]; nextCursor: string | null }> {
  const membership = await requirePermission(db, actorId, input.orgId, "read");
  // A channel's list: the same check as reading the channel (403 for non-members).
  if (input.channelId) await requireChannelAccess(db, actorId, input.orgId, input.channelId);
  const isAdmin = can(membership, "manage_channels");
  const { rows, nextCursor } = await queryThreads(db, actorId, input);
  const extras = await threadExtras(db, input.orgId, rows);
  return { threads: rows.map((r) => toView(r, extras, actorId, isAdmin)), nextCursor };
}

/** One thread as the list shows it (any state), for whoever reads its channel. */
export async function getThread(db: Database, actorId: string, orgId: string, rootId: string): Promise<ThreadInfo> {
  if (!UUID.test(rootId)) throw new NotFoundError("Thread not found");
  const { channel, membership } = await requireThread(db, actorId, orgId, rootId);
  const isAdmin = can(membership, "manage_channels");
  const { rows } = await queryThreads(db, actorId, {
    orgId,
    channelId: channel.id,
    rootId,
    anyState: true,
    limit: 1,
  });
  const [found] = rows;
  if (!found) {
    // A plain message without replies nor state: not a thread yet; it shows as an empty one.
    const [root] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.id, rootId), eq(messages.orgId, orgId)));
    if (!root) throw new NotFoundError("Thread not found");
    const r: ThreadSqlRow = {
      id: root.id,
      channel_id: root.channelId,
      channel_name: channel.name,
      channel_kind: channel.kind as schema.ChannelKind,
      created_at: root.createdAt,
      body: root.body,
      root_meta: root.meta,
      author_type: root.authorType,
      author_user_id: root.authorUserId,
      author_agent_id: root.authorAgentId,
      reply_count: 0,
      last_at: root.createdAt,
      title: null,
      state: "open",
      created_by: null,
      closed_by: null,
      closed_at: null,
      archived_by: null,
      archived_at: null,
      context_channel_id: null,
      context_first_message_id: null,
      context_last_message_id: null,
      context_excluded_message_ids: null,
      context_moved: null,
      context_count: null,
      working: false,
      needs_you: false,
      following: await followsRoot(db, orgId, actorId, root.id),
      cursor_at: root.createdAt.toISOString(),
    };
    return toView(r, await threadExtras(db, orgId, [r]), actorId, isAdmin);
  }
  return toView(found, await threadExtras(db, orgId, rows), actorId, isAdmin);
}

/** What everyone may hear of a thread: nothing only the actor has (following it, its unread for them). */
const withoutFollowing = ({
  following: _,
  unread: __,
  ...view
}: ThreadInfo): Omit<ThreadInfo, "following" | "unread"> => view;

async function followsRoot(db: Database, orgId: string, userId: string, rootId: string) {
  const [row] = rowsOf<{ following: boolean | null }>(
    await db.execute(sql`select ${followsThreadSql(orgId, userId, sql`${rootId}::uuid`)} as following`),
  );
  return row?.following === true;
}

// ── Following ─────────────────────────────────────────────────────────────────

/**
 * Follows (`true`) or mutes (`false`) a thread for the actor, explicitly
 * (whoever reads its channel). Following: notified of its replies, which
 * count as unread in the channel list. Muting wins over having written
 * there; a mention still notifies. The actor's other devices hear
 * `thread.follow` on their own topic.
 */
export async function setThreadFollow(
  deps: ThreadDeps,
  actorId: string,
  orgId: string,
  rootId: string,
  following: boolean,
): Promise<{ threadId: string; channelId: string; following: boolean }> {
  if (!UUID.test(rootId)) throw new NotFoundError("Thread not found");
  const { root } = await requireThread(deps.db, actorId, orgId, rootId);
  const now = new Date();
  await deps.db
    .insert(schema.threadFollows)
    .values({ orgId, channelId: root.channelId, rootMessageId: root.id, userId: actorId, following, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.threadFollows.rootMessageId, schema.threadFollows.userId],
      set: { following, updatedAt: now },
    });
  const result = { threadId: root.id, channelId: root.channelId, following };
  await publishUserEvent(deps.pubsub, orgId, actorId, { type: "thread.follow", ...result });
  return result;
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** The most unread replies counted per thread, and threads counted by `countUnreadThreads` (clients show "99+"). */
export const MAX_THREAD_UNREAD = 100;

/**
 * Reply `ur` of thread `root` that this person hasn't read: not theirs, shown to people, not an agent's silent
 * sticker after its reply (ADR 0091), and landed after their read of the thread, else their joining its channel
 * (`joinedAt`). Reading the channel doesn't count: its main timeline doesn't show replies. Messages moved in from the
 * channel ("Tirar do canal") aren't replies: they were read, or not, in the channel.
 */
function unreadReplySql(orgId: string, userId: string, root: SQL, joinedAt: SQL): SQL {
  return sql`ur.org_id = ${orgId}::uuid and ur.thread_id = ${root} and ur.deleted_at is null
    and (ur.author_user_id is null or ur.author_user_id <> ${userId})
    and not ${quietNoticeSql(sql`ur.meta`)} and ur.meta->>'mediaAfter' is null
    and ${landedAfterSql({ createdAt: sql`ur.created_at`, id: sql`ur.id` }, sql`greatest(${joinedAt}, ${threadReadAtSql(userId, root)})`)}
    and not exists (select 1 from ${threads} mt where mt.root_message_id = ${root}
      and ur.id = any(mt.context_moved_message_ids))`;
}

/**
 * Marks a thread's replies read up to now for the actor (the thread open at its end). Their other devices hear
 * `thread.read` on their own topic, so its unread clears there too.
 */
export async function markThreadRead(
  deps: ThreadDeps,
  actorId: string,
  orgId: string,
  rootId: string,
  at = new Date(),
): Promise<void> {
  if (!UUID.test(rootId)) throw new NotFoundError("Thread not found");
  const { root } = await requireThread(deps.db, actorId, orgId, rootId);
  await deps.db
    .insert(schema.threadReads)
    .values({ orgId, channelId: root.channelId, rootMessageId: root.id, userId: actorId, lastReadAt: at })
    .onConflictDoUpdate({
      target: [schema.threadReads.rootMessageId, schema.threadReads.userId],
      set: { lastReadAt: at },
    });
  await publishUserEvent(deps.pubsub, orgId, actorId, {
    type: "thread.read",
    threadId: root.id,
    channelId: root.channelId,
    lastReadAt: at.toISOString(),
  });
}

/** How many threads I follow have a reply I haven't read (the Threads entry's mark), at most `MAX_THREAD_UNREAD`. */
export async function countUnreadThreads(db: Database, userId: string, orgId: string): Promise<number> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = rowsOf<{ n: number | string }>(
    await db.execute(sql`select count(*)::int as n from (
        select distinct ur.thread_id from ${channelMembers} cm
        join ${channels} c on c.id = cm.channel_id and c.org_id = ${orgId}::uuid and c.archived_at is null
          and c.kind in ('channel', 'dm')
        join ${messages} ur on ur.channel_id = c.id
          and ${unreadReplySql(orgId, userId, sql`ur.thread_id`, sql`cm.created_at`)}
        where cm.org_id = ${orgId}::uuid and cm.user_id = ${userId}
          and ${followsThreadSql(orgId, userId, sql`ur.thread_id`)}
        limit ${MAX_THREAD_UNREAD}
      ) x`),
  );
  return Number(row?.n ?? 0);
}

/** A task's conversation with something I haven't read (ADR 0145): replies, and of them the ones that mention me. */
export interface UnreadTask {
  issueId: string;
  /** Replies I haven't read: every one in a conversation I follow, else only those that mention me. */
  unread: number;
  mentions: number;
}

/**
 * The tasks whose conversation has a reply I haven't read, by the threads' rule (`unreadReplySql`, at most
 * `MAX_THREAD_UNREAD` each), only where I see the task now: people are never members of a task's channel, so there is
 * no joining to count from, and a mention counts until I read it there.
 */
export async function unreadTaskConversations(db: Database, userId: string, orgId: string): Promise<UnreadTask[]> {
  await requirePermission(db, userId, orgId, "read");
  const rows = rowsOf<{ id: string; following: boolean; n: number | string; m: number | string }>(
    await db.execute(sql`select i.id, f.following, u.n, u.m from ${schema.issues} i
        cross join lateral (select ${followsThreadSql(orgId, userId, sql`i.conversation_root_id`)} as following) f
        cross join lateral (select count(*)::int as n,
            count(*) filter (where ${userId} = any(ur.mentioned_user_ids))::int as m
          from (select ur.mentioned_user_ids from ${messages} ur
            where ${unreadReplySql(orgId, userId, sql`i.conversation_root_id`, sql`'-infinity'::timestamptz`)}
            limit ${MAX_THREAD_UNREAD}) ur) u
        where i.org_id = ${orgId}::uuid and i.conversation_channel_id is not null and i.conversation_root_id is not null
          and (u.m > 0 or (f.following and u.n > 0))
          and ${taskReaderSql(sql`i.conversation_channel_id`, sql`${userId}`)}`),
  );
  return rows.map((r) => ({
    issueId: r.id,
    unread: Number(r.following === true ? r.n : r.m),
    mentions: Number(r.m),
  }));
}

// ── Run context ───────────────────────────────────────────────────────────────

/**
 * What the run's context builder needs from a thread's row, in one indexed
 * read by root (no cache: ranges change): its context range, and its mission
 * (ADR 0029: a mission's thread always has a row).
 */
export async function threadRunInfo(db: Database, orgId: string, rootId: string) {
  const [row] = await db
    .select({
      contextChannelId: threads.contextChannelId,
      contextFirstAt: threads.contextFirstAt,
      contextLastAt: threads.contextLastAt,
      contextExcludedMessageIds: threads.contextExcludedMessageIds,
      title: threads.title,
      missionId: schema.missions.id,
      missionMachineId: schema.missions.machineId,
    })
    .from(threads)
    .leftJoin(
      schema.missions,
      and(eq(schema.missions.orgId, threads.orgId), eq(schema.missions.threadRootId, threads.rootMessageId)),
    )
    .where(and(eq(threads.orgId, orgId), eq(threads.rootMessageId, rootId)));
  const range =
    row?.contextChannelId && row.contextFirstAt && row.contextLastAt
      ? {
          channelId: row.contextChannelId,
          firstAt: row.contextFirstAt,
          lastAt: row.contextLastAt,
          excluded: row.contextExcludedMessageIds,
          title: row.title,
        }
      : null;
  return { range, missionId: row?.missionId ?? null, missionMachineId: row?.missionMachineId ?? null };
}

/** A thread's context range for the run's context builder (see `threadRunInfo`). */
export async function threadContextOf(db: Database, orgId: string, rootId: string) {
  return (await threadRunInfo(db, orgId, rootId)).range;
}
