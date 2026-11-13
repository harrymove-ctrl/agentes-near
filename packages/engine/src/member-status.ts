import type { Presence, PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, schema } from "@agenteschat/db";
import { ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { rerouteApprovals } from "./notification-producers";
import { requirePermission } from "./organizations";

/**
 * A person's status in an organization: what they chose to show (`availability`) and a line they
 * wrote about what they are doing. Whether they are connected comes from the `Presence` adapter.
 */
export const AVAILABILITIES = ["auto", "away", "busy", "out", "hidden"] as const;
export type Availability = (typeof AVAILABILITIES)[number];

/**
 * What a viewer sees. `hidden` only reaches the person themselves: everyone else sees `offline`,
 * so a hidden person can't be told apart from one who is away. `out` (out of office, ADR 0084 §14) shows whether
 * they are connected or not, until their line's end.
 */
export type MemberPresence = "online" | "away" | "busy" | "out" | "hidden" | "offline";

export const STATUS_TEXT_MAX = 100;
export const STATUS_EMOJI_MAX = 16;

export interface MemberStatus {
  text: string;
  emoji: string | null;
  /** ISO; null = until changed. */
  until: string | null;
}

export interface StatusColumns {
  availability: Availability;
  statusText: string | null;
  statusEmoji: string | null;
  statusUntil: Date | null;
}

/**
 * What a person picked, as it holds at `now`: out of office ends with their line's end (`statusUntil`, "back
 * Monday"), then they read as `auto` again. Checked on read, no job.
 */
export function availabilityNow(
  row: Pick<StatusColumns, "availability"> & Partial<Pick<StatusColumns, "statusUntil">>,
  now = new Date(),
): Availability {
  return row.availability === "out" && row.statusUntil && row.statusUntil <= now ? "auto" : row.availability;
}

export function memberPresence(
  row: Pick<StatusColumns, "availability"> & Partial<Pick<StatusColumns, "statusUntil">>,
  connected: boolean,
  isSelf: boolean,
  now = new Date(),
): MemberPresence {
  const availability = availabilityNow(row, now);
  if (availability === "hidden") return isSelf ? "hidden" : "offline";
  // Out of office tells everyone, connected or not: that is its point.
  if (availability === "out") return "out";
  if (!connected) return "offline";
  return availability === "auto" ? "online" : availability;
}

/** The written status, or null when there is none or its time is up (cleared on read, no job needed). */
export function memberStatus(row: Omit<StatusColumns, "availability">, now = new Date()): MemberStatus | null {
  if (!row.statusText) return null;
  if (row.statusUntil && row.statusUntil <= now) return null;
  return { text: row.statusText, emoji: row.statusEmoji, until: row.statusUntil?.toISOString() ?? null };
}

export interface StatusInput {
  availability?: Availability;
  /** Null or empty clears the written status (with its emoji and end). */
  status?: { text: string; emoji?: string | null; until?: string | null } | null;
}

/** A person sets their own availability and/or written status; the members' lists refresh live. */
export async function setMyStatus(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  input: StatusInput,
  now = new Date(),
): Promise<void> {
  await requirePermission(deps.db, userId, orgId, "read");
  const set: Partial<StatusColumns> = {};
  if (input.availability !== undefined) {
    if (!AVAILABILITIES.includes(input.availability))
      throw new ValidationError("availability: auto, away, busy, out or hidden");
    set.availability = input.availability;
  }
  if (input.status !== undefined) {
    const text = input.status?.text.trim().replace(/\s+/g, " ") ?? "";
    if (!text) {
      Object.assign(set, { statusText: null, statusEmoji: null, statusUntil: null });
    } else {
      if (text.length > STATUS_TEXT_MAX) {
        throw new ValidationError(`status: at most ${STATUS_TEXT_MAX} characters`, "status.too_long", {
          max: STATUS_TEXT_MAX,
        });
      }
      const emoji = input.status?.emoji?.trim() || null;
      if (emoji && emoji.length > STATUS_EMOJI_MAX) throw new ValidationError("status emoji is too long");
      const until = input.status?.until ? new Date(input.status.until) : null;
      if (until && (Number.isNaN(until.getTime()) || until <= now)) {
        throw new ValidationError("status until must be a time in the future");
      }
      Object.assign(set, { statusText: text, statusEmoji: emoji, statusUntil: until });
    }
  }
  if (Object.keys(set).length === 0) return;
  await deps.db
    .update(schema.organizationMembers)
    .set(set)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, userId)));
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "member.status", orgId, userId },
  });
  // Out of office or back: whoever covers them gets (or gives back) what waits for them (ADR 0139).
  if (set.availability !== undefined) await rerouteApprovals(deps, orgId, userId).catch(() => {});
}

/**
 * Tells the workspace a person came online or went offline (their first connection opened, their last one
 * closed), so the people lists follow live. Never for a hidden person: the event alone would give them away.
 */
export async function announcePresence(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  userId: string,
): Promise<void> {
  const [row] = await deps.db
    .select({ availability: schema.organizationMembers.availability })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), eq(schema.organizationMembers.userId, userId)));
  if (!row || row.availability === "hidden") return;
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "member.status", orgId, userId } });
}

/** Whether `userId` has a connection open in `orgId` now. */
export const isConnected = async (presence: Presence, orgId: string, userId: string) =>
  (await presence.online(orgId)).includes(userId);
