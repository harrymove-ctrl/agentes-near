/**
 * When our notifications ask shows by itself, before the system's or the browser's prompt (pure, so it is
 * unit-tested): the phone's sheet (`PushAskSheet`) and the web's card under a message (`PushAskInline`, ADR 0071).
 * Never on arrival: once the person has used the app a bit, under the first answer from an agent they wrote to, and
 * once more at the first request to approve, while the device hasn't been asked yet. "Agora não" doesn't spend the
 * prompt: the switch (Você › Avisos on the phone, Configurações › Notificações on the web) turns them on any time.
 */

export type PushPermissionLike = "granted" | "denied" | "undetermined";

/** The moments it may show: an agent answered the person, or a request to approve waits on them. */
export type PushOfferMoment = "answer" | "approval";

/** How many times it shows by itself, at most (the first answer, then the first request to approve). */
export const MAX_PUSH_OFFERS = 2;

/** The offers made so far, from the stored count; a phone the old flow already asked gets none. */
export function pushOffersFrom(raw: string | null, alreadyAsked: boolean): number {
  if (alreadyAsked) return MAX_PUSH_OFFERS;
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_PUSH_OFFERS, n)) : 0;
}

/** Whether the sheet opens at `moment`: the system hasn't been asked, the person didn't turn them off. */
export function pushOfferDue(
  state: { permission: PushPermissionLike | null; turnedOff: boolean; offers: number },
  moment: PushOfferMoment,
): boolean {
  if (state.permission !== "undetermined" || state.turnedOff) return false;
  return state.offers === (moment === "answer" ? 0 : 1);
}

/** What `pushAskAt` reads of a message. */
interface AskMessage {
  id: string;
  author: { type: string; id: string | null };
  local?: string;
  meta?: Record<string, unknown>;
}

/**
 * Where the ask shows in a conversation, under which message, or null: the newest message is an agent's reply (not a
 * team's hello, not a card) to someone who wrote here first (`answer`), or it asks the person to approve something
 * (`approval`, `waitsOnMe`). Never on a billing hold, where agents can't answer yet.
 */
export function pushAskAt(
  messages: readonly AskMessage[],
  meId: string,
  s: {
    held: boolean;
    offers: number;
    permission: PushPermissionLike | null;
    turnedOff: boolean;
    waitsOnMe: (m: AskMessage) => boolean;
  },
): { messageId: string; moment: PushOfferMoment } | null {
  const last = messages.at(-1);
  if (s.held || !last || last.local || last.author.type !== "agent") return null;
  const state = { permission: s.permission, turnedOff: s.turnedOff, offers: s.offers };
  if (pushOfferDue(state, "approval") && s.waitsOnMe(last)) return { messageId: last.id, moment: "approval" };
  if (!pushOfferDue(state, "answer") || last.meta?.greeting || last.meta?.actionCard || last.meta?.approvalId)
    return null;
  const wrote = messages.some((m) => m.author.type === "person" && m.author.id === meId);
  return wrote ? { messageId: last.id, moment: "answer" } : null;
}

/** The three example notifications' senders: the workspace's own agents, else `someone` ("Um agente"). */
export function exampleSenders(names: readonly string[], someone: string): [string, string, string] {
  const own = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const at = (i: number) => own[i] ?? own[0] ?? someone;
  return [at(0), at(1), at(2)];
}
