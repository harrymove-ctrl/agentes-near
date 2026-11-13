import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { channels } from "./chat";
import { organizations } from "./tenancy";

/**
 * A voice message's recording (ADR 0100), on the workspace's storage but outside the Drive: it belongs to its message.
 * `pending`: stored, waiting for its words. `sent`: the message went out. `dropped`: nothing was said, or the channel
 * can't take it. Rows stay after the recording is gone (`audioDeletedAt`): they are what fair use counts.
 */
export const voiceClips = pgTable(
  "voice_clips",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    threadId: uuid(),
    /** Who spoke. */
    userId: text().references(() => users.id, { onDelete: "set null" }),
    /** The app's id for this send: a resend after a lost answer finds the same clip. */
    clientId: text().notNull(),
    replyTo: uuid(),
    /** Null: platform storage, as on `artifact_versions`. */
    storageConfigId: uuid(),
    blobKey: text().notNull(),
    contentType: text().notNull(),
    size: integer().notNull(),
    durationMs: integer().notNull(),
    /** The wave the player draws, from 0 to 1. */
    peaks: jsonb().$type<number[]>().notNull(),
    /** The language the person's app is in (`pt`, `en`). */
    language: text(),
    status: text().$type<"pending" | "sent" | "dropped">().notNull().default("pending"),
    messageId: uuid(),
    /** Which engine made the words, and what they cost us. Never shown. */
    engine: text(),
    costNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    /** When the recording left storage: past retention, or nothing to keep. The row and the message's words stay. */
    audioDeletedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.orgId, t.userId, t.clientId),
    index().on(t.orgId, t.createdAt),
    index().on(t.userId, t.createdAt),
    index().on(t.createdAt),
  ],
);
