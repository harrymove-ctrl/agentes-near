import type { PubSub } from "@agenteschat/adapters";
import { and, count, type Database, desc, eq, gte, lt, or, schema } from "@agenteschat/db";
import { requireChannelAccess } from "./channels";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { getMessage, type MessageView, withMessageDetails } from "./messages";
import { can } from "./organizations";

const { messagePins, messages } = schema;

/**
 * Pinned messages of a channel or DM. Anyone who can post there pins and
 * unpins; everyone who reads it sees the pins (`message.pinned`,
 * `message.unpinned` live).
 */

/** Pins a channel holds at most. */
export const MAX_PINS_PER_CHANNEL = 100;

export interface PinDeps {
  db: Database;
  pubsub?: PubSub;
}

export interface PinView {
  messageId: string;
  channelId: string;
  /** The message's thread (null: the main timeline). */
  threadId: string | null;
  /** Null when that person was deleted. */
  pinnedByUserId: string | null;
  pinnedAt: string;
  message: MessageView;
}

async function requirePinChannel(db: Database, actorId: string, orgId: string, channelId: string, write: boolean) {
  const { channel, membership } = await requireChannelAccess(db, actorId, orgId, channelId);
  if (write && !can(membership, "post")) throw new ForbiddenError();
  return channel;
}

/** A message of this channel, not deleted. */
async function requireMessageIn(db: Database, orgId: string, channelId: string, messageId: string) {
  const message = await getMessage(db, orgId, messageId);
  if (!message || message.channelId !== channelId || message.deletedAt) throw new NotFoundError("Message not found");
  return message;
}

/** Pins a message (idempotent: pinning it again keeps the first pin). */
export async function pinMessage(
  deps: PinDeps,
  actorId: string,
  orgId: string,
  channelId: string,
  messageId: string,
): Promise<PinView> {
  const { db } = deps;
  await requirePinChannel(db, actorId, orgId, channelId, true);
  const message = await requireMessageIn(db, orgId, channelId, messageId);
  const [existing] = await db
    .select()
    .from(messagePins)
    .where(and(eq(messagePins.channelId, channelId), eq(messagePins.messageId, messageId)));
  if (existing) return (await pinViews(db, orgId, [existing]))[0] as PinView;
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(messagePins)
    .where(and(eq(messagePins.orgId, orgId), eq(messagePins.channelId, channelId)));
  if (Number(n) >= MAX_PINS_PER_CHANNEL) {
    throw new ValidationError(`A conversation holds at most ${MAX_PINS_PER_CHANNEL} pins`, "pins.limit", {
      max: MAX_PINS_PER_CHANNEL,
    });
  }
  const [row] = await db
    .insert(messagePins)
    .values({ orgId, channelId, messageId, messageCreatedAt: message.createdAt, pinnedByUserId: actorId })
    .onConflictDoNothing()
    .returning();
  const pin =
    row ??
    (
      await db
        .select()
        .from(messagePins)
        .where(and(eq(messagePins.channelId, channelId), eq(messagePins.messageId, messageId)))
    )[0];
  if (!pin) throw new Error("pin insert returned nothing");
  if (row) {
    await publishChannelEvent(deps.pubsub, {
      type: "message.pinned",
      channelId,
      messageId,
      threadId: message.threadId,
      pinnedByUserId: actorId,
      pinnedAt: row.createdAt.toISOString(),
    });
  }
  return (await pinViews(db, orgId, [pin]))[0] as PinView;
}

/** Unpins a message. Not pinned: nothing changes (no error). */
export async function unpinMessage(
  deps: PinDeps,
  actorId: string,
  orgId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await requirePinChannel(deps.db, actorId, orgId, channelId, true);
  const removed = await deps.db
    .delete(messagePins)
    .where(
      and(eq(messagePins.orgId, orgId), eq(messagePins.channelId, channelId), eq(messagePins.messageId, messageId)),
    )
    .returning({ messageId: messagePins.messageId });
  if (removed.length > 0) await publishChannelEvent(deps.pubsub, { type: "message.unpinned", channelId, messageId });
}

/** A channel's pins, newest pin first (deleted messages left out). */
export async function listPins(db: Database, actorId: string, orgId: string, channelId: string): Promise<PinView[]> {
  await requirePinChannel(db, actorId, orgId, channelId, false);
  const rows = await db
    .select()
    .from(messagePins)
    .where(and(eq(messagePins.orgId, orgId), eq(messagePins.channelId, channelId)))
    .orderBy(desc(messagePins.createdAt), desc(messagePins.messageId))
    .limit(MAX_PINS_PER_CHANNEL);
  return pinViews(db, orgId, rows);
}

/** Pins with their messages (one read on the messages' exact keys, then the list details). */
async function pinViews(db: Database, orgId: string, pins: (typeof messagePins.$inferSelect)[]): Promise<PinView[]> {
  if (pins.length === 0) return [];
  const found = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        // `messageCreatedAt` was read back cut to milliseconds while Postgres keeps microseconds: its millisecond.
        or(
          ...pins.map((p) =>
            and(
              eq(messages.id, p.messageId),
              gte(messages.createdAt, p.messageCreatedAt),
              lt(messages.createdAt, new Date(p.messageCreatedAt.getTime() + 1)),
            ),
          ),
        ),
      ),
    );
  const views = await withMessageDetails(
    db,
    orgId,
    found.filter((m) => !m.deletedAt),
  );
  const byId = new Map(views.map((v) => [v.id, v]));
  return pins.flatMap((p) => {
    const message = byId.get(p.messageId);
    if (!message) return [];
    return [
      {
        messageId: p.messageId,
        channelId: p.channelId,
        threadId: message.threadId,
        pinnedByUserId: p.pinnedByUserId,
        pinnedAt: p.createdAt.toISOString(),
        message,
      },
    ];
  });
}
