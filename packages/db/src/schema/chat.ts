import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { organizationMembers, organizations, orgRoles } from "./tenancy";

export const channelVisibilityEnum = pgEnum("channel_visibility", ["public", "private"]);
/**
 * `channel`: a named channel. `dm`: a direct conversation (person↔person or person↔agent), participants only.
 * `task`: a task's conversation (ADR 0145): read by whoever sees the task, never listed; only agents are members.
 * `forum` is unused: the forum was removed (migration 0216), and Postgres drops an enum value only by recreating the
 * type, which would rewrite `channels` under a lock.
 */
export const channelKindEnum = pgEnum("channel_kind", ["channel", "dm", "forum", "task"]);
/** The kinds a channel has: no row is `forum` since migration 0216. */
export type ChannelKind = Exclude<(typeof channelKindEnum.enumValues)[number], "forum">;

/**
 * A named group of channels in the sidebar, the same for everyone in the organization. Deleting one leaves its
 * channels without a category.
 */
export const channelCategories = pgTable(
  "channel_categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** As people typed it ("Marketing"); unique per organization, ignoring case (checked by the engine). */
    name: text().notNull(),
    /** Order in the sidebar, from 0. */
    position: integer().notNull().default(0),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.orgId, t.id), unique().on(t.orgId, t.name)],
);

/** A conversation space. `public`: any member of the organization may join; `private`: invite only. */
export const channels = pgTable(
  "channels",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lower-case, unique per organization, e.g. `engineering`. */
    name: text().notNull(),
    topic: text().notNull().default(""),
    visibility: channelVisibilityEnum().notNull().default("public"),
    /**
     * A private channel limited to departments or roles (ADR 0125): whoever holds one of these roles at the time
     * also sees it and may join; losing them takes the person out. Empty: invite only. Always empty when public.
     */
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    kind: channelKindEnum().notNull().default("channel"),
    /** DMs: the sorted participants (`a:<agentId>|u:<userId>`), unique per org, so a DM is opened, not duplicated. */
    dmKey: text(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
    /**
     * Deleted by an owner or admin (archived too, so nothing lists it): its contents are purged by the `channel.delete`
     * job and the row stays as a tombstone, named `deleted-<id>`, for its runs, usage and audit. Never undone.
     */
    deletedAt: timestamp({ withTimezone: true }),
    /** Its sidebar category (channels only); null: on top, with no category. */
    categoryId: uuid().references(() => channelCategories.id, { onDelete: "set null" }),
    /** Order inside its category (or among the channels with none), from 0. */
    position: integer().notNull().default(0),
  },
  (t) => [unique().on(t.orgId, t.name), unique().on(t.orgId, t.id), unique().on(t.orgId, t.dmKey)],
);

/** Where each person stopped reading a channel (unread counts). */
export const channelReads = pgTable(
  "channel_reads",
  {
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Muted by this person: never looks unread to them; mentions of them still count. */
    muted: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
  ],
);

/**
 * Where each person stopped reading a thread's replies (the thread list's unread). A followed thread's reply stays
 * unread until this passes it, whatever the channel's read (`channel_reads`) says. Keyed by the root message (no
 * foreign key to the partitioned `messages`).
 */
export const threadReads = pgTable(
  "thread_reads",
  {
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    rootMessageId: uuid().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.rootMessageId, t.userId] }),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
  ],
);

/** Who is in a channel: exactly one of `user_id` (person) or `agent_id` (agent). */
export const channelMembers = pgTable(
  "channel_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid().references(() => agents.id, { onDelete: "cascade" }),
    /**
     * Agents only: the router may pick this agent for messages without a
     * mention in this channel. Off = the agent answers only when @mentioned here.
     */
    autoReply: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Composite FK: a membership can never point at another organization's channel.
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
    unique().on(t.channelId, t.userId),
    unique().on(t.channelId, t.agentId),
    index().on(t.userId),
    index().on(t.agentId),
    check("channel_members_one_member", sql`(${t.userId} is null) <> (${t.agentId} is null)`),
  ],
);

/**
 * A channel's exceptions to the workspace's keys (ADR 0134): for one role (`everyone` too) or one person, keys
 * allowed or denied in this channel only. Only `post`, `talk_to_agents` and `manage_channels` (`CHANNEL_KEYS`).
 */
export const channelPermissionOverrides = pgTable(
  "channel_permission_overrides",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    roleId: uuid(),
    userId: text(),
    allow: text().array().notNull().default(sql`'{}'::text[]`),
    deny: text().array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.roleId], foreignColumns: [orgRoles.orgId, orgRoles.id] }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.userId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.userId],
    }).onDelete("cascade"),
    unique().on(t.channelId, t.roleId),
    unique().on(t.channelId, t.userId),
    check("channel_permission_overrides_one_target", sql`(${t.roleId} is null) <> (${t.userId} is null)`),
    check(
      "channel_permission_overrides_keys",
      sql`not (${t.allow} && ${t.deny}) and ${t.allow} <@ array['post', 'talk_to_agents', 'manage_channels']::text[]
        and ${t.deny} <@ array['post', 'talk_to_agents', 'manage_channels']::text[]`,
    ),
  ],
);

export const authorTypeEnum = pgEnum("author_type", ["person", "agent"]);

/**
 * Chat messages. Partitioned by month on `created_at` (see migration 0000 and
 * docs/adr/0009-messages-partitioning.md), so the primary key includes
 * `created_at` and no table can hold a foreign key to a message: references
 * such as `thread_id` and `agent_runs.trigger_message_id` are plain uuids.
 *
 * Author is polymorphic: a person (`author_user_id`) or an agent (`author_agent_id`).
 */
export const messages = pgTable(
  "messages",
  {
    /** UUIDv7, generated by the application, so ids sort by creation time. */
    id: uuid()
      .notNull()
      .$defaultFn(() => Bun.randomUUIDv7()),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Root message of the thread this message replies in; null for a top-level message. */
    threadId: uuid(),
    authorType: authorTypeEnum().notNull(),
    authorUserId: text().references(() => users.id, { onDelete: "set null" }),
    authorAgentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    body: text().notNull(),
    /** Agents explicitly @mentioned in `body` (resolved at write time). */
    mentionedAgentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** People mentioned by handle (`@ana`) who are members of the channel. */
    mentionedUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    /**
     * Consecutive agent replies leading to this message in its thread: 0 for a
     * person's message, trigger hop + 1 for an agent's. Enforces AGENT_MAX_HOPS.
     */
    hop: integer().notNull().default(0),
    /**
     * The stretch it belongs to (ADR 0089): the work agents do on their own since a person last acted. An
     * agent's message carries its run's; null for a root (a person's message, a routine's report), whose
     * stretch is its own id.
     */
    stretchId: uuid(),
    /** The run that produced this message (agent messages only). */
    agentRunId: uuid(),
    /** Structured attachments, e.g. `{ "approvalId": "…" }` for an approval card. */
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    editedAt: timestamp({ withTimezone: true }),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
    index().on(t.channelId, t.createdAt),
    index().on(t.threadId, t.createdAt),
    // The Threads page: replies grouped by thread within the channels a person sees.
    index().on(t.channelId, t.threadId, t.createdAt).where(sql`${t.threadId} is not null`),
    // Deleting a person or an agent sets their messages' author to null: without these it scans every partition.
    index().on(t.authorUserId).where(sql`${t.authorUserId} is not null`),
    index().on(t.authorAgentId).where(sql`${t.authorAgentId} is not null`),
    check(
      "messages_author",
      sql`(${t.authorType} = 'person' and ${t.authorAgentId} is null) or (${t.authorType} = 'agent' and ${t.authorUserId} is null)`,
    ),
  ],
);

export const threadStateEnum = pgEnum("thread_state", ["open", "closed", "archived"]);

/**
 * State of a thread (ADR 0029). Threads stay implicit (`messages.thread_id` =
 * the root message id); a row exists only once a thread has state of its
 * own: created from a range of a conversation, closed, archived or titled.
 * Keyed by the root message (unique per org; no foreign key to `messages`,
 * which is partitioned).
 *
 * Context range (`context_*`): messages of `context_channel_id` from the
 * first to the last (by time), minus the excluded ones. The run's context
 * reads that range instead of "the channel messages before the root".
 * `context_moved`: the range left the channel and lives in the thread
 * (`thread_id` = root); `context_moved_message_ids` are exactly the moved
 * ones, so returning them never touches real replies.
 */
export const threads = pgTable(
  "threads",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    rootMessageId: uuid().notNull(),
    /** Null: the web shows the root message's text. */
    title: text(),
    /** The title was written by a model (`threads.assess`); a person's title is never overwritten. */
    titleAuto: boolean().notNull().default(false),
    /**
     * A cheap model judged the thread's matter done: the time of the last message
     * it read. Suggests "resolved?" while no newer message came (never closes).
     */
    resolvedSuggestedAt: timestamp({ withTimezone: true }),
    state: threadStateEnum().notNull().default("open"),
    /**
     * When someone first answered in it with "Responder" (the web's thread panel): replies from then
     * on live in the panel, and the channel shows one line where the thread left it. Null (an agent
     * answering the message that called it): the channel shows the replies in its own timeline.
     */
    openedByReplyAt: timestamp({ withTimezone: true }),
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    closedBy: text().references(() => users.id, { onDelete: "set null" }),
    closedAt: timestamp({ withTimezone: true }),
    archivedBy: text().references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp({ withTimezone: true }),
    contextChannelId: uuid().references(() => channels.id, { onDelete: "set null" }),
    contextFirstMessageId: uuid(),
    contextLastMessageId: uuid(),
    /** Times of the first and last message of the range (the range query scans `(channel_id, created_at)`). */
    contextFirstAt: timestamp({ withTimezone: true }),
    contextLastAt: timestamp({ withTimezone: true }),
    contextExcludedMessageIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    contextMoved: boolean().notNull().default(false),
    contextMovedMessageIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
    unique().on(t.orgId, t.rootMessageId),
    index().on(t.orgId, t.channelId, t.state),
  ],
);

/**
 * A person's explicit choice about a thread (the phone app's "Seguir"). No
 * row: they follow the threads they started or wrote in. `following`
 * true adds them (notified of replies, replies count as unread in the
 * channel); false mutes them even where they wrote. Keyed by the root
 * message (no foreign key to the partitioned `messages`).
 */
export const threadFollows = pgTable(
  "thread_follows",
  {
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    rootMessageId: uuid().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    following: boolean().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.rootMessageId, t.userId] }),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
  ],
);

/**
 * Messages pinned in a channel (anyone who can post there pins). The
 * message's `created_at` (its partition key) is kept for a direct lookup;
 * no foreign key to the partitioned `messages`.
 */
export const messagePins = pgTable(
  "message_pins",
  {
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    messageId: uuid().notNull(),
    messageCreatedAt: timestamp({ withTimezone: true }).notNull(),
    pinnedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.messageId] }),
    foreignKey({ columns: [t.orgId, t.channelId], foreignColumns: [channels.orgId, channels.id] }).onDelete("cascade"),
    index().on(t.channelId, t.createdAt),
  ],
);

/**
 * Idempotent sends: the `clientId` a person's app gave a message it posted. A resend with the same
 * (org, person, clientId), e.g. a retry after the response was lost, gets the message already written
 * instead of a second one (and second runs). Claimed in the same statement that writes the message
 * (`insertMessageWithRuns`); old rows are pruned (`pruneMessageClientIds`). No foreign key to the
 * partitioned `messages`.
 */
export const messageClientIds = pgTable(
  "message_client_ids",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text().notNull(),
    messageId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId, t.clientId] }), index().on(t.createdAt)],
);
