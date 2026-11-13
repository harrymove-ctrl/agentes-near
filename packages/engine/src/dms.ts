import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, isNull, ne, schema, sql } from "@agenteschat/db";
import type { Agent } from "./agents";
import { audienceError, canTalkTo, speakerOf } from "./audience";
import { caches } from "./cache";
import { sha256 } from "./crypto";
import { NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishUserEvent } from "./events";
import { landedAfterSql } from "./message-place";
import { type PreviewMeta, previewMediaKind, previewMeta, readableBody } from "./message-preview";
import { quietNoticeSql } from "./notices";
import { resolveNotifications } from "./notifications";
import { can, getMembership, requirePermission } from "./organizations";
import { accountInUse, closedRefusal } from "./standing";

const { channels, channelMembers, channelReads, messages, agents, users, organizationMembers } = schema;

export type DmTarget = { userId: string } | { agentId: string };

const keyOf = (participants: string[]) => [...new Set(participants)].sort().join("|");

const namedPeople = (dmKey: string | null) =>
  (dmKey ?? "").split("|").flatMap((p) => (p.startsWith("u:") ? [p.slice(2)] : []));

/** Of these people, the ones who are members of the workspace and not blocked. */
async function presentPeople(db: Executor, orgId: string, userIds: string[]) {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds), accountInUse));
  return rows.map((r) => r.userId);
}

async function readmit(db: Executor, orgId: string, channelId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  const back = await db
    .insert(channelMembers)
    .values(userIds.map((userId) => ({ orgId, channelId, userId })))
    .onConflictDoNothing()
    .returning({ id: channelMembers.id });
  if (back.length) caches.channelMembers.delete(`${orgId}:${channelId}`);
}

/**
 * An existing DM, opened again: the people its key names who are members of the workspace again come back into it.
 * Removal takes someone out of their DMs and a DM can't be joined, so without this a person invited back would find
 * every old DM closed to them for good.
 */
async function reopenDm(
  db: Executor,
  orgId: string,
  dm: { id: string; dmKey: string | null; archivedAt: Date | null },
) {
  if (dm.archivedAt) await db.update(channels).set({ archivedAt: null }).where(eq(channels.id, dm.id));
  await readmit(db, orgId, dm.id, await presentPeople(db, orgId, namedPeople(dm.dmKey)));
}

/**
 * A person opens a DM the other one started: until now their list left it out (`listDms`), from here on it holds it.
 * The read sits where the DM began, so it marks nothing read. True when it joined their list just now.
 */
async function openedByTheOther(
  db: Executor,
  orgId: string,
  dm: { id: string; createdAt: Date; createdByUserId: string | null },
  userId: string,
) {
  if (dm.createdByUserId === userId) return false;
  const seen = await db
    .insert(channelReads)
    .values({ orgId, channelId: dm.id, userId, lastReadAt: dm.createdAt })
    .onConflictDoNothing()
    .returning({ userId: channelReads.userId });
  return seen.length > 0;
}

/**
 * Someone joining the workspace again goes back into their old DMs whose other people are all still in it, so a
 * colleague writing in the old DM from the sidebar reaches them without anyone opening it anew.
 */
export async function restoreDms(db: Executor, orgId: string, userId: string) {
  const dms = await db
    .select({ id: channels.id, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.kind, "dm"), sql`${channels.dmKey} like ${`%u:${userId}%`}`));
  for (const dm of dms) {
    const named = namedPeople(dm.dmKey);
    if (!named.includes(userId)) continue;
    const present = await presentPeople(db, orgId, named);
    if (present.length === named.length) await readmit(db, orgId, dm.id, named);
  }
}

/**
 * Opens a direct conversation with a person or an agent (creates it the
 * first time). A DM is a private channel of kind `dm` with exactly its
 * participants; nobody else can join or read it. In a DM with an agent, the
 * agent answers every message from the person (no router).
 */
export async function openDm(
  db: Database,
  actorId: string,
  orgId: string,
  target: DmTarget,
  options: { pubsub?: PubSub } = {},
) {
  const membership = await requirePermission(db, actorId, orgId, "post");
  let other: string;
  let blockedAgent: Agent | null = null;
  if ("userId" in target) {
    if (target.userId === actorId) throw new ValidationError("Pick someone else");
    if (!(await getMembership(db, target.userId, orgId)))
      throw new NotFoundError("That person is not in this organization");
    other = `u:${target.userId}`;
  } else {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, target.agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)));
    if (!agent) throw new NotFoundError("Agent not found");
    // Who manages agents opens it anyway (its composer says why it won't answer and offers to let them in).
    if (!canTalkTo(agent, actorId, speakerOf(membership)) && !can(membership, "manage_agents")) blockedAgent = agent;
    other = `a:${target.agentId}`;
  }
  const dmKey = keyOf([`u:${actorId}`, other]);
  const existing = async () =>
    (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.orgId, orgId), eq(channels.dmKey, dmKey)))
    )[0];
  const found = await existing();
  // Being deleted, the workspace opens the DMs it has as they are, bringing nobody back, and starts none (ADR 0088 §7).
  const closed = closedRefusal(membership.standing);
  if (closed) {
    if (!found) throw closed;
    return found;
  }
  // A new DM with an agent this person can't talk to isn't started (unless they manage agents); an old one stays readable.
  if (!found && blockedAgent) throw await audienceError(db, blockedAgent);
  if (found) await reopenDm(db, orgId, found);
  const created = found
    ? null
    : await db.transaction(async (tx) => {
        const [channel] = await tx
          .insert(channels)
          .values({
            orgId,
            name: `dm-${sha256(`${orgId}|${dmKey}`).slice(0, 20)}`,
            visibility: "private",
            kind: "dm",
            dmKey,
            createdByUserId: actorId,
          })
          .onConflictDoNothing()
          .returning();
        if (!channel) return null;
        await tx.insert(channelMembers).values({ orgId, channelId: channel.id, userId: actorId });
        await tx
          .insert(channelMembers)
          .values(
            "userId" in target
              ? { orgId, channelId: channel.id, userId: target.userId }
              : { orgId, channelId: channel.id, agentId: target.agentId },
          );
        return channel;
      });
  if (created && "agentId" in target) caches.scopes.deletePrefix(`${orgId}:${target.agentId}:visible`);
  const channel = found ?? created ?? (await existing()); // a concurrent open won the race
  if (!channel) throw new Error("could not open the conversation");
  // In my list on my other devices, before anyone writes in it. Never the other's: it reaches them with its first
  // message (`channel.activity`), an unused DM being noise there.
  if (created || found?.archivedAt || ("userId" in target && (await openedByTheOther(db, orgId, channel, actorId))))
    await publishUserEvent(options.pubsub, orgId, actorId, { type: "channels.changed" });
  return channel;
}

/**
 * The DM between a person and an agent, opened by the agent (`send_dm`): created the first time with
 * both as members, the same conversation the person opens with `openDm`. Who may talk to the agent
 * isn't checked: the agent may write to anyone in the organization; the person's replies only get an
 * answer when they may talk to it.
 */
export async function openPersonAgentDm(db: Executor, orgId: string, userId: string, agentId: string) {
  const dmKey = personAgentDmKey(userId, agentId);
  const existing = async () =>
    (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.orgId, orgId), eq(channels.dmKey, dmKey)))
    )[0];
  const found = await existing();
  if (found) {
    await reopenDm(db, orgId, found);
    return found;
  }
  const [channel] = await db
    .insert(channels)
    .values({
      orgId,
      name: `dm-${sha256(`${orgId}|${dmKey}`).slice(0, 20)}`,
      visibility: "private",
      kind: "dm",
      dmKey,
    })
    .onConflictDoNothing()
    .returning();
  if (channel) {
    await db.insert(channelMembers).values([
      { orgId, channelId: channel.id, userId },
      { orgId, channelId: channel.id, agentId },
    ]);
    caches.scopes.deletePrefix(`${orgId}:${agentId}:visible`);
    return channel;
  }
  const raced = await existing(); // a concurrent open won the race
  if (!raced) throw new Error("could not open the conversation");
  return raced;
}

/** The DM key of a conversation between a person and an agent. */
export const personAgentDmKey = (userId: string, agentId: string) => keyOf([`u:${userId}`, `a:${agentId}`]);

/** The DM key of a conversation between two agents (`ask_agent`, ADR 0034): no person in it. */
export const agentDmKey = (a: string, b: string) => keyOf([`a:${a}`, `a:${b}`]);

/** A DM between agents only: no person reads it, so nobody there can answer a question. */
export const isAgentOnlyDm = (channel: { kind: string; dmKey: string | null }) =>
  channel.kind === "dm" && channel.dmKey !== null && !channel.dmKey.includes("u:");

/**
 * Opens the private conversation between two agents (creates it the first
 * time): a `dm` channel with both agents as its only members. Where one
 * agent consults another; no person is a member.
 */
export async function openAgentDm(db: Executor, orgId: string, a: string, b: string) {
  const dmKey = agentDmKey(a, b);
  const existing = async () =>
    (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.orgId, orgId), eq(channels.dmKey, dmKey)))
    )[0];
  const found = await existing();
  if (found) {
    if (found.archivedAt) await db.update(channels).set({ archivedAt: null }).where(eq(channels.id, found.id));
    return found;
  }
  const [channel] = await db
    .insert(channels)
    .values({
      orgId,
      name: `dm-${sha256(`${orgId}|${dmKey}`).slice(0, 20)}`,
      visibility: "private",
      kind: "dm",
      dmKey,
    })
    .onConflictDoNothing()
    .returning();
  if (channel) {
    await db.insert(channelMembers).values([
      { orgId, channelId: channel.id, agentId: a },
      { orgId, channelId: channel.id, agentId: b },
    ]);
    return channel;
  }
  const raced = await existing(); // a concurrent open won the race
  if (!raced) throw new Error("could not open the conversation");
  return raced;
}

export interface DmSummary {
  channelId: string;
  with: { type: "person" | "agent"; id: string; name: string; handle: string | null };
  lastMessage: {
    id: string;
    body: string;
    /** What the app needs to show a server-written body in the reader's language; null for a plain message. */
    meta: PreviewMeta | null;
    /** A GIF or a sticker sent with no text (ADR 0091): the app says which where `body` is empty; else null. */
    mediaKind: "gif" | "sticker" | "voice" | null;
    createdAt: Date;
    authorType: string;
  } | null;
  unread: number;
  /** Where the unread starts: when I last read it; null when I never did. */
  lastReadAt: Date | null;
  /** False until I first open it (no read of mine yet): the right hand waves on that first visit (ADR 0137 §6). */
  everRead: boolean;
  /** When the DM began: where it sorts until its first message. */
  openedAt: Date;
}

/**
 * My direct conversations, newest activity first (one with no message yet sorts by when it began, so a new one is on
 * top), with unread counts. An empty DM the other person opened isn't one yet: it shows with its first message, or
 * once I open it myself. A DM with an agent always shows. `only`: that one DM, as the list has it (`POST /dms`).
 */
export async function listDms(db: Database, actorId: string, orgId: string, only?: string): Promise<DmSummary[]> {
  await requirePermission(db, actorId, orgId, "read");
  const mine = await db
    .select({ id: channels.id, createdAt: channels.createdAt, createdByUserId: channels.createdByUserId })
    .from(channels)
    .innerJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, actorId)))
    .where(
      and(
        eq(channels.orgId, orgId),
        eq(channels.kind, "dm"),
        isNull(channels.archivedAt),
        only ? eq(channels.id, only) : undefined,
      ),
    );
  if (mine.length === 0) return [];
  const ids = mine.map((c) => c.id);
  const [others, reads, last] = await Promise.all([
    db
      .select({
        channelId: channelMembers.channelId,
        userId: channelMembers.userId,
        agentId: channelMembers.agentId,
        userName: users.name,
        agentName: agents.name,
        agentHandle: agents.handle,
      })
      .from(channelMembers)
      .leftJoin(users, eq(users.id, channelMembers.userId))
      .leftJoin(agents, eq(agents.id, channelMembers.agentId))
      .where(
        and(
          inArray(channelMembers.channelId, ids),
          sql`(${channelMembers.userId} is null or ${channelMembers.userId} <> ${actorId})`,
        ),
      ),
    db
      .select()
      .from(channelReads)
      .where(and(inArray(channelReads.channelId, ids), eq(channelReads.userId, actorId))),
    db
      .selectDistinctOn([messages.channelId], {
        channelId: messages.channelId,
        id: messages.id,
        body: messages.body,
        meta: messages.meta,
        createdAt: messages.createdAt,
        authorType: messages.authorType,
      })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          inArray(messages.channelId, ids),
          isNull(messages.deletedAt),
          // A routine's call is hidden in the chat (only the agent's answer shows), so not the preview either.
          sql`not (${messages.authorType} = 'person' and ${messages.meta}->'routine' is not null)`,
          // Nor what only its agent reads, nor a receipt like a stopped task (ADR 0128).
          sql`not ${quietNoticeSql(sql`${messages.meta}`)}`,
          // An agent's sticker or GIF after its own reply (ADR 0091) is part of that reply: the reply is the preview.
          sql`${messages.meta}->>'mediaAfter' is null`,
        ),
      )
      .orderBy(messages.channelId, desc(messages.createdAt)),
  ]);
  const readAt = new Map(reads.map((r) => [r.channelId, r.lastReadAt]));
  const unreadRows = await Promise.all(
    ids.map(async (id) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.orgId, orgId),
            eq(messages.channelId, id),
            isNull(messages.deletedAt),
            sql`(${messages.authorUserId} is null or ${messages.authorUserId} <> ${actorId})`,
            sql`not ${quietNoticeSql(sql`${messages.meta}`)}`,
            landedAfterSql(messages, readAt.get(id) ?? new Date(0)),
            // Nor one more unread (ADR 0091): it is silent.
            sql`${messages.meta}->>'mediaAfter' is null`,
          ),
        );
      return [id, row?.n ?? 0] as const;
    }),
  );
  const unread = new Map(unreadRows);
  const lastBy = new Map(last.map((m) => [m.channelId, m]));
  return mine
    .flatMap((c) => {
      const o = others.find((x) => x.channelId === c.id);
      if (!o) return [];
      const m = lastBy.get(c.id);
      if (!m && o.userId && c.createdByUserId !== actorId && !readAt.has(c.id)) return [];
      return [
        {
          channelId: c.id,
          with: o.agentId
            ? { type: "agent" as const, id: o.agentId, name: o.agentName ?? "", handle: o.agentHandle }
            : { type: "person" as const, id: o.userId ?? "", name: o.userName ?? "", handle: null },
          lastMessage: m
            ? {
                id: m.id,
                body: readableBody(m.body, m.meta as Record<string, unknown> | null).slice(0, 200),
                meta: previewMeta(m.meta as Record<string, unknown> | null),
                mediaKind: previewMediaKind(m.body, m.meta as Record<string, unknown> | null),
                createdAt: m.createdAt,
                authorType: m.authorType,
              }
            : null,
          unread: unread.get(c.id) ?? 0,
          lastReadAt: readAt.get(c.id) ?? null,
          everRead: readAt.has(c.id),
          openedAt: c.createdAt,
          sortAt: m?.createdAt ?? c.createdAt,
        },
      ];
    })
    .sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime())
    .map(({ sortAt: _, ...dm }) => dm);
}

/**
 * Marks a channel (or DM) read up to now for me. In a DM between people the other one hears it
 * (`channel.read`): their app says "Visto" under the last message I read. An agent's answers there
 * (`agent_reply`) are seen, so they leave the inbox and never push (ADR 0071).
 */
export async function markChannelRead(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  at = new Date(),
  pubsub?: PubSub,
) {
  const [member] = await db
    .select({ id: channelMembers.id, kind: channels.kind })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), eq(channelMembers.userId, actorId)),
    );
  if (!member) throw new NotFoundError("Channel not found");
  await db
    .insert(channelReads)
    .values({ orgId, channelId, userId: actorId, lastReadAt: at })
    .onConflictDoUpdate({ target: [channelReads.channelId, channelReads.userId], set: { lastReadAt: at } });
  await resolveNotifications({ db, pubsub }, orgId, {
    groupKeyPrefix: `agent_reply:${channelId}:`,
    userIds: [actorId],
    kind: "agent_reply",
  });
  const read = { type: "channel.read" as const, channelId, userId: actorId, lastReadAt: at.toISOString() };
  if (member.kind === "dm") await publishChannelEvent(pubsub, read);
  // My other devices: the conversation stops looking unread there too.
  await publishUserEvent(pubsub, orgId, actorId, read);
}

/**
 * Mutes (or unmutes) a channel for me: it never looks unread to me, though a mention of me still counts. My other
 * devices hear `channel.muted`. Not a DM: its lists count every unread message, muted or not.
 */
export async function setChannelMuted(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  muted: boolean,
  pubsub?: PubSub,
) {
  const [member] = await db
    .select({ id: channelMembers.id, joinedAt: channelMembers.createdAt, kind: channels.kind })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), eq(channelMembers.userId, actorId)),
    );
  if (!member) throw new NotFoundError("Channel not found");
  if (member.kind === "dm") throw new ValidationError("Only a channel can be muted", "channel.mute_dm");
  // Never read yet: the new row reads from my joining (listChannels' fallback), so muting marks nothing read.
  await db
    .insert(channelReads)
    .values({ orgId, channelId, userId: actorId, muted, lastReadAt: member.joinedAt })
    .onConflictDoUpdate({ target: [channelReads.channelId, channelReads.userId], set: { muted } });
  await publishUserEvent(pubsub, orgId, actorId, { type: "channel.muted", channelId, muted });
}

/**
 * Where the other people of my DM stopped reading ("Visto"). Only in a DM: a channel never shows
 * who read what. Empty for a DM with an agent (its receipts say it).
 */
export async function dmReads(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
): Promise<{ userId: string; lastReadAt: string }[]> {
  const [member] = await db
    .select({ kind: channels.kind })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), eq(channelMembers.userId, actorId)),
    );
  if (!member) throw new NotFoundError("Channel not found");
  if (member.kind !== "dm") return [];
  const rows = await db
    .select({ userId: channelReads.userId, lastReadAt: channelReads.lastReadAt })
    .from(channelReads)
    .where(and(eq(channelReads.orgId, orgId), eq(channelReads.channelId, channelId), ne(channelReads.userId, actorId)));
  return rows.map((r) => ({ userId: r.userId, lastReadAt: r.lastReadAt.toISOString() }));
}

/** The agents of a DM other than the author (who answers without a mention). */
export async function dmAgents(db: Database, orgId: string, channelId: string) {
  return db
    .select({ id: agents.id })
    .from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.agentId))
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(
      and(
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.channelId, channelId),
        eq(channels.kind, "dm"),
        isNull(agents.archivedAt),
      ),
    );
}
