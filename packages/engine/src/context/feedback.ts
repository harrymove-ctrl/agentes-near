import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { requireChannelAccess } from "../channels";
import { NotFoundError, ValidationError } from "../errors";
import { publishChannelEvent } from "../events";
import type { Judge } from "../judge";
import { getMessage, groupReactions } from "../messages";
import { notifyReaction } from "../notification-producers";
import { enqueue } from "../outbox";
import type { Approval } from "../tools/gateway";
import {
  type ConsolidateResult,
  changesPermissions,
  consolidateItem,
  looksLikeSecret,
  type MemoryJudging,
} from "./items";
import { recordOutcome } from "./outcomes";
import { proposeFromItem } from "./proposals";

const { messageReactions, contextUsage, contextItems, messages } = schema;

const excerpt = (t: string, n = 120) => (t.length > n ? `${t.slice(0, n - 1)}…` : t).replace(/\s+/g, " ");

/**
 * A refused approval teaches the agent (with the reason) and is recorded as
 * an outcome. Verified: a person decided. Called after the decision commits.
 */
export async function learnFromRefusal(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge; memory?: MemoryJudging },
  approval: Approval,
): Promise<ConsolidateResult | null> {
  if (approval.status !== "refused") return null;
  const outcome = await recordOutcome(deps.db, {
    orgId: approval.orgId,
    kind: "approval_refused",
    agentId: approval.agentId,
    runId: approval.runId,
    subject: `${approval.tool}`,
    summary: `${approval.title}${approval.reason ? ` — ${approval.reason}` : ""}`,
    source: "approval",
    channelId: approval.channelId,
    threadRootId: approval.threadRootId,
  });
  const reason = approval.reason?.trim();
  if (reason && (looksLikeSecret(reason) || (await changesPermissions(deps.judge, approval.orgId, reason))))
    return null;
  const at = new Date().toISOString();
  const res = await consolidateItem(
    deps.db,
    {
      orgId: approval.orgId,
      kind: "lesson",
      scopeType: "agent",
      scopeId: approval.agentId,
      agentId: approval.agentId,
      subject: `refused ${approval.tool} ${reason ?? ""}`,
      content: reason
        ? `"${excerpt(approval.title)}" was refused: ${excerpt(reason, 300)}`
        : `"${excerpt(approval.title)}" was refused by a person.`,
      sourceIds: [approval.id, outcome.id],
      channelIds: [approval.channelId],
      trust: "high",
      evidence: [
        { type: "human", ref: approval.id, at },
        { type: "outcome", ref: outcome.id, at },
      ],
      confidence: 0.9,
    },
    deps.memory ?? { judge: deps.judge },
  );
  await proposeFromItem(deps, res.item);
  return res;
}

/**
 * A person corrects an agent's reply ("edits to an agent's output"): stored
 * as a verified lesson for that agent, with the reply and the correction as
 * sources.
 */
export async function correctAgentMessage(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge; memory?: MemoryJudging },
  userId: string,
  orgId: string,
  messageId: string,
  correction: string,
): Promise<ConsolidateResult> {
  const message = await getMessage(deps.db, orgId, messageId);
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  await requireChannelAccess(deps.db, userId, orgId, message.channelId);
  if (message.authorType !== "agent" || !message.authorAgentId)
    throw new ValidationError("Only agent replies can be corrected");
  const text = correction.trim();
  if (!text) throw new ValidationError("The correction is empty");
  const res = await consolidateItem(
    deps.db,
    {
      orgId,
      kind: "lesson",
      scopeType: "agent",
      scopeId: message.authorAgentId,
      agentId: message.authorAgentId,
      subject: `correction ${excerpt(text, 80)}`,
      content: `A person corrected "${excerpt(message.body)}": ${excerpt(text, 500)}`,
      sourceIds: [message.id],
      channelIds: [message.channelId],
      trust: "high",
      evidence: [{ type: "human", ref: `${message.id}:${userId}`, at: new Date().toISOString() }],
      confidence: 0.85,
      createdByKind: "person",
      createdById: userId,
    },
    deps.memory ?? { judge: deps.judge },
  );
  await proposeFromItem(deps, res.item);
  return res;
}

/** `+1`, `-1` or one emoji (no spaces, short). */
export const isValidReaction = (reaction: string) =>
  reaction === "+1" ||
  reaction === "-1" ||
  (/\p{Extended_Pictographic}/u.test(reaction) && !/\s/.test(reaction) && reaction.length <= 16);

/** How an agent's emoji is stored: 👍/👎 as `+1`/`-1`, like the app does for people. */
export const normalizeReaction = (emoji: string) => {
  const e = emoji.trim().replace(/\uFE0F/g, "");
  return e === "👍" ? "+1" : e === "👎" ? "-1" : emoji.trim();
};

/** Adds a reaction. 👍/👎 on an agent's reply adjust the relevance of the context it used, via a job. */
export async function addReaction(
  db: Database,
  userId: string,
  orgId: string,
  messageId: string,
  reaction: string,
  pubsub?: PubSub,
) {
  const message = await getMessage(db, orgId, messageId);
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  await requireChannelAccess(db, userId, orgId, message.channelId);
  if (!isValidReaction(reaction)) throw new ValidationError("reaction must be +1, -1 or an emoji");
  const added = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(messageReactions)
      .values({ orgId, messageId, userId, reaction })
      .onConflictDoNothing()
      .returning({ messageId: messageReactions.messageId });
    if (inserted.length > 0 && message.authorType === "agent" && (reaction === "+1" || reaction === "-1")) {
      await enqueue(tx, { orgId, kind: "context.feedback", payload: { messageId, reaction } });
    }
    return inserted.length > 0;
  });
  const reactions = await listReactions(db, orgId, messageId);
  await publishChannelEvent(pubsub, { type: "message.reactions", channelId: message.channelId, messageId, reactions });
  // The author of a person's message hears it; never of their own reaction.
  if (added && message.authorType === "person" && message.authorUserId !== userId) {
    await notifyReaction({ db, pubsub }, { orgId, messageId, userId }).catch(() => {});
  }
  return reactions;
}

export async function removeReaction(
  db: Database,
  userId: string,
  orgId: string,
  messageId: string,
  reaction: string,
  pubsub?: PubSub,
) {
  const message = await getMessage(db, orgId, messageId);
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  await requireChannelAccess(db, userId, orgId, message.channelId);
  await db
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.orgId, orgId),
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, userId),
        eq(messageReactions.reaction, reaction),
      ),
    );
  const reactions = await listReactions(db, orgId, messageId);
  await publishChannelEvent(pubsub, { type: "message.reactions", channelId: message.channelId, messageId, reactions });
  return reactions;
}

/** Reactions visible to a person only while they can read the message's channel. */
export async function listMessageReactions(db: Database, userId: string, orgId: string, messageId: string) {
  const message = await getMessage(db, orgId, messageId);
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  await requireChannelAccess(db, userId, orgId, message.channelId);
  return listReactions(db, orgId, messageId);
}

/** Reactions on a message, in the order they were first given, with who reacted (people and agents). */
export async function listReactions(db: Database, orgId: string, messageId: string) {
  const rows = await db
    .select({ reaction: messageReactions.reaction, userId: messageReactions.userId, agentId: messageReactions.agentId })
    .from(messageReactions)
    .where(and(eq(messageReactions.orgId, orgId), eq(messageReactions.messageId, messageId)))
    .orderBy(asc(messageReactions.createdAt));
  return groupReactions(rows);
}

/**
 * A reaction by an agent (the `react` tool): an acknowledgement instead of a
 * reply. Never feedback: only people's 👍/👎 teach an agent (`context.feedback`).
 */
export async function addAgentReaction(
  db: Database,
  input: { orgId: string; agentId: string; messageId: string; reaction: string },
  pubsub?: PubSub,
  options: { notify?: boolean } = {},
) {
  const message = await getMessage(db, input.orgId, input.messageId);
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  if (!isValidReaction(input.reaction)) throw new ValidationError("reaction must be one emoji");
  const inserted = await db
    .insert(messageReactions)
    .values({ orgId: input.orgId, messageId: input.messageId, agentId: input.agentId, reaction: input.reaction })
    .onConflictDoNothing()
    .returning({ messageId: messageReactions.messageId });
  const reactions = await listReactions(db, input.orgId, input.messageId);
  await publishChannelEvent(pubsub, {
    type: "message.reactions",
    channelId: message.channelId,
    messageId: input.messageId,
    reactions,
  });
  // A person's message: its author hears the agent reacted.
  if (inserted.length > 0 && message.authorType === "person" && options.notify !== false) {
    await notifyReaction(
      { db, pubsub },
      { orgId: input.orgId, messageId: input.messageId, agentId: input.agentId },
    ).catch(() => {});
  }
  return { message, reactions };
}

/**
 * Job `context.feedback`: a 👍 raises (a 👎 lowers) the relevance of the
 * context items the run behind that reply used. The reaction also shows up
 * in the next reflection of the thread as human feedback.
 */
export async function applyReactionFeedback(
  db: Database,
  input: { orgId: string; messageId: string; reaction: string },
) {
  const [m] = await db
    .select({ runId: messages.agentRunId })
    .from(messages)
    .where(and(eq(messages.orgId, input.orgId), eq(messages.id, input.messageId)));
  if (!m?.runId) return 0;
  const used = await db
    .select({ itemId: contextUsage.itemId })
    .from(contextUsage)
    .where(eq(contextUsage.runId, m.runId));
  if (used.length === 0) return 0;
  const delta = input.reaction === "+1" ? 0.1 : -0.15;
  await db
    .update(contextItems)
    .set({ relevance: sql`least(1, greatest(0, ${contextItems.relevance} + ${delta}))`, updatedAt: new Date() })
    .where(
      and(
        eq(contextItems.orgId, input.orgId),
        inArray(
          contextItems.id,
          used.map((u) => u.itemId),
        ),
      ),
    );
  return used.length;
}

/**
 * Logs which items a run's context included (reactions' feedback reads it). Only `used` count as a use and raise
 * relevance: what matched the request or was opened with `expand` (ADR 0167). The rest, sent whatever the request
 * (the fixed core, rules), only stays fresh, so it doesn't decay away while every run reads it.
 */
export async function recordContextUse(
  db: Database,
  orgId: string,
  runId: string,
  itemIds: string[],
  used: string[] = itemIds,
) {
  if (itemIds.length === 0) return;
  await db
    .insert(contextUsage)
    .values(itemIds.map((itemId) => ({ orgId, runId, itemId })))
    .onConflictDoNothing();
  const counted = itemIds.filter((id) => used.includes(id));
  const sent = itemIds.filter((id) => !used.includes(id));
  if (counted.length > 0)
    await db
      .update(contextItems)
      .set({
        useCount: sql`${contextItems.useCount} + 1`,
        // Each use moves it less the more it already has, so the most used items stop climbing (ADR 0120).
        relevance: sql`${contextItems.relevance} + 0.05 * (1 - ${contextItems.relevance})`,
        lastUsedAt: new Date(),
      })
      .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, counted)));
  if (sent.length > 0)
    await db
      .update(contextItems)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, sent)));
}
