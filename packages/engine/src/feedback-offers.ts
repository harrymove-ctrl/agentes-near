import type { PubSub, RateLimiter } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gt, isNull, schema, sql } from "@agenteschat/db";
import { ConflictError, ForbiddenError, NotFoundError, TooManyError } from "./errors";
import { publishChannelEvent } from "./events";
import { FEEDBACK_MAX, FEEDBACK_PER_HOUR, type Feedback, queueFeedback } from "./feedback";
import { getMembership } from "./organizations";

const { agents, messages, organizationMembers, users } = schema;

/*
 * A report an agent offers on its own (ADR 0160 §12): the app itself failed in the middle of its work, or the person
 * complained about the app and what the agent saw confirms it. The agent writes the report and it rides on its reply
 * (`meta.feedbackOffer`) as a quiet row with Send and Not now; nothing waits on it. Sent, it is the same email as the
 * form's, in that person's name. A person who chose "Always send" gets it sent with the reply, and the row says so.
 */

export const OFFER_FEEDBACK_TOOL = "offer_feedback";
/** The problem in a few words, as the row's one line. */
export const FEEDBACK_SUMMARY_MAX = 120;
/** One offer a day in a conversation; one the person turned down keeps the agent quiet there for a week. */
export const FEEDBACK_OFFER_EVERY_MS = 24 * 60 * 60_000;
export const FEEDBACK_OFFER_DECLINED_MS = 7 * 24 * 60 * 60_000;

export type FeedbackOfferState = "offered" | "sent" | "dismissed";

/** The offer as the reply carries it (`meta.feedbackOffer`) and the apps draw it. */
export interface FeedbackOfferView {
  id: string;
  /** The person it goes in the name of: only they see the row and decide it. */
  forUserId: string;
  summary: string;
  text: string;
  state: FeedbackOfferState;
  /** Sent with the reply, without asking: they chose "Always send". */
  auto?: true;
  decidedAt?: string;
}

/** What `offer_feedback` leaves on the run until its reply is posted: the row, and the email when it goes by itself. */
export interface PendingFeedbackOffer {
  view: FeedbackOfferView;
  send?: Feedback;
}

/**
 * What the Tool Gateway tells an agent after one of the app's own tools broke unexpectedly (`faultHint`): the tool is
 * loaded on demand, so the hint names it.
 */
export const APP_FAULT_HINT = `This looks like a fault of the app itself, not yours. If it got in the way of your answer, ${OFFER_FEEDBACK_TOOL} offers the person a report of it (a row under your reply); otherwise carry on.`;

/** A message's offer, read safely. */
export function feedbackOfferOf(meta: unknown): FeedbackOfferView | null {
  const o = (meta as { feedbackOffer?: Partial<FeedbackOfferView> } | null | undefined)?.feedbackOffer;
  if (!o || typeof o.id !== "string" || typeof o.forUserId !== "string") return null;
  if (typeof o.summary !== "string" || typeof o.text !== "string") return null;
  const state: FeedbackOfferState = o.state === "sent" || o.state === "dismissed" ? o.state : "offered";
  return {
    id: o.id,
    forUserId: o.forUserId,
    summary: o.summary,
    text: o.text,
    state,
    ...(o.auto === true ? { auto: true as const } : {}),
    ...(typeof o.decidedAt === "string" ? { decidedAt: o.decidedAt } : {}),
  };
}

/** The pending offer a tool result carries (`data.feedbackOffer`), read safely. */
export function pendingFeedbackOfferOf(data: unknown): PendingFeedbackOffer | null {
  const p = data as Partial<PendingFeedbackOffer> | null | undefined;
  const view = feedbackOfferOf({ feedbackOffer: p?.view });
  if (!view) return null;
  const send = p?.send;
  return { view, ...(send && typeof send.to === "string" && typeof send.text === "string" ? { send } : {}) };
}

/** Whether the person chose "Always send" in this workspace (kept with their chat preferences). */
export async function feedbackAutoOf(db: Executor, orgId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ on: sql<boolean>`coalesce((${organizationMembers.chatPrefs}->>'feedbackAuto')::boolean, false)` })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return row?.on === true;
}

/**
 * Why an agent may not offer a report to `userId` in this conversation now, or null: it offered one there in the last
 * day, or the person turned one down there in the last week.
 */
export async function feedbackOfferRefusal(
  db: Executor,
  where: { orgId: string; channelId: string; userId: string },
  now = new Date(),
): Promise<string | null> {
  const [last] = await db
    .select({ meta: messages.meta, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, where.orgId),
        eq(messages.channelId, where.channelId),
        gt(messages.createdAt, new Date(now.getTime() - FEEDBACK_OFFER_DECLINED_MS)),
        isNull(messages.deletedAt),
        sql`${messages.meta}->'feedbackOffer'->>'forUserId' = ${where.userId}`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const offer = last ? feedbackOfferOf(last.meta) : null;
  if (!last || !offer) return null;
  if (offer.state === "dismissed")
    return "They turned down a report in this conversation a few days ago: nothing was offered. Don't bring it up again.";
  if (now.getTime() - last.createdAt.getTime() < FEEDBACK_OFFER_EVERY_MS)
    return "A report was already offered in this conversation today: nothing was offered. Don't bring it up again.";
  return null;
}

/** The email a report written by an agent becomes, in the person's name. */
export function agentFeedback(input: {
  to: string;
  version: string;
  user: { name: string; email: string };
  orgName: string;
  role: string;
  agent: { name: string; handle: string } | null | undefined;
  text: string;
  /** How it came to be sent, after the agent's name in "Written by". */
  how: string;
}): Feedback {
  const by = input.agent ? `${input.agent.name} (@${input.agent.handle}), an agent` : "an agent";
  return {
    to: input.to,
    name: input.user.name,
    email: input.user.email,
    orgName: input.orgName,
    text: input.text.trim().slice(0, FEEDBACK_MAX),
    app: "agent",
    facts: [
      ["Role", input.role],
      ["Written by", `${by}, ${input.how}`],
    ],
    version: input.version,
  };
}

const agentOf = async (db: Executor, orgId: string, agentId: string | null) => {
  if (!agentId) return null;
  const [agent] = await db
    .select({ name: agents.name, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return agent ?? null;
};

/**
 * The person an offer is for sends it or turns it down, once. Sending queues the form's email (one per offer, within
 * their ten an hour). The row's new state goes to everyone who has the conversation open.
 */
export async function decideFeedbackOffer(
  deps: {
    db: Database;
    pubsub?: PubSub;
    rateLimiter?: RateLimiter;
    /** `FEEDBACK_EMAIL`. */
    to?: string | null;
    version: string;
  },
  input: { orgId: string; messageId: string; userId: string; decision: "send" | "dismiss" },
): Promise<FeedbackOfferView> {
  const { db } = deps;
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, input.orgId), eq(messages.id, input.messageId), isNull(messages.deletedAt)));
  const offer = message ? feedbackOfferOf(message.meta) : null;
  if (!message || !offer) throw new NotFoundError("No report was offered on this message");
  if (offer.forUserId !== input.userId) throw new ForbiddenError("This report is someone else's to send");
  if (offer.state !== "offered") return offer;
  const sending = input.decision === "send";
  const member = await getMembership(db, input.userId, input.orgId);
  if (!member) throw new ForbiddenError();
  let feedback: Feedback | null = null;
  if (sending) {
    if (!deps.to) throw new ConflictError("This server takes no feedback");
    const [user] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, input.userId));
    if (!user) throw new ForbiddenError();
    if (deps.rateLimiter && !(await deps.rateLimiter.consume(`feedback:${input.userId}`, FEEDBACK_PER_HOUR)).allowed)
      throw new TooManyError("Too much feedback in the last hour: try again later");
    feedback = agentFeedback({
      to: deps.to,
      version: deps.version,
      user,
      orgName: member.orgName,
      role: member.role,
      agent: await agentOf(db, input.orgId, message.authorAgentId),
      text: offer.text,
      how: "on its own; they read it and sent it",
    });
  }
  const next: FeedbackOfferView = {
    ...offer,
    state: sending ? "sent" : "dismissed",
    decidedAt: new Date().toISOString(),
  };
  const done = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{feedbackOffer}', ${JSON.stringify(next)}::jsonb)` })
      .where(
        and(
          eq(messages.orgId, input.orgId),
          eq(messages.id, input.messageId),
          sql`coalesce(${messages.meta}->'feedbackOffer'->>'state', 'offered') = 'offered'`,
        ),
      )
      .returning({ id: messages.id });
    // Decided from another device in the meantime: that decision stands, and nothing is sent twice.
    if (!row) return false;
    if (feedback) await queueFeedback(tx, { orgId: input.orgId, key: `offer:${offer.id}`, feedback });
    return true;
  });
  if (!done) {
    const [now] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.orgId, input.orgId), eq(messages.id, input.messageId)));
    return feedbackOfferOf(now?.meta) ?? next;
  }
  await publishChannelEvent(deps.pubsub, {
    type: "feedback_offer.updated",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    offer: next,
  });
  return next;
}
