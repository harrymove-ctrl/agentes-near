import type { FeedbackOffer } from "../api/types";

/** The report about the app a message offers (`meta.feedbackOffer`), if any. */
export function feedbackOfferOf(meta: Record<string, unknown> | undefined): FeedbackOffer | null {
  const o = meta?.feedbackOffer as Partial<FeedbackOffer> | undefined;
  if (!o || typeof o.id !== "string" || typeof o.forUserId !== "string") return null;
  if (typeof o.summary !== "string" || typeof o.text !== "string") return null;
  return { ...(o as FeedbackOffer), state: o.state === "sent" || o.state === "dismissed" ? o.state : "offered" };
}

/**
 * What `viewerId` sees under the reply: the row while it waits for them, the quiet line once it went, nothing once
 * they put it away. Nobody else sees any of it: it is theirs to send, in their name.
 */
export function feedbackOfferFor(
  meta: Record<string, unknown> | undefined,
  viewerId: string | null | undefined,
): FeedbackOffer | null {
  const offer = feedbackOfferOf(meta);
  return offer && viewerId && offer.forUserId === viewerId && offer.state !== "dismissed" ? offer : null;
}
