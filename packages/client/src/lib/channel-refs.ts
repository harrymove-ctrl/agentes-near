/**
 * `#channel` references in chat (web and phone): where they are in a text, which channel each one means, and the
 * "#" picker's rules. The server stores what each name meant when the message was written (`meta.channelRefs`,
 * lower-case name → channel id, `channelRefsSql` in the engine), so a renamed channel still links; a name it didn't
 * store resolves by the channel's current name. Only channels the viewer can see become links.
 */

import { CHANNEL_REF } from "@agenteschat/tokens/channel-refs";
import type { TFunction } from "i18next";
import type { ChannelCard } from "../api/types";

export { CHANNEL_REF, channelQuery, insertChannelRef } from "@agenteschat/tokens/channel-refs";

/** A piece of text: words, or a `#name` reference (`name` lower case, as channels are named). */
export type ChannelRefPart = { text: string; name?: undefined } | { text: string; name: string };

/** A text split around its `#name` references ("veja #Eng." → "veja ", "#Eng" (eng), "."). */
export function splitChannelRefs(text: string): ChannelRefPart[] {
  const out: ChannelRefPart[] = [];
  let last = 0;
  for (const m of text.matchAll(CHANNEL_REF)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    const name = m[2] ?? "";
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: `#${name}`, name: name.toLowerCase() });
    last = start + 1 + name.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

const NO_REFS: Record<string, string> = Object.freeze({}) as Record<string, string>;

/**
 * `meta.channelRefs` of a message: the channel each lower-case name meant when it was written. The same object for
 * the same meta (a memoized message text doesn't re-render).
 */
export function channelRefsOf(meta: Record<string, unknown> | null | undefined): Record<string, string> {
  const refs = meta?.channelRefs;
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return NO_REFS;
  return Object.values(refs).every((id) => typeof id === "string") ? (refs as Record<string, string>) : NO_REFS;
}

/**
 * Which channel `#name` means: the one stored with the message, else the channel named so now (ignoring case).
 * `known`: the channel when the viewer's list has it; only `id` when the message names one the list doesn't
 * (archived, or private and not theirs: the card asks the server, which says nothing of the latter). Null:
 * plain text.
 */
export function resolveChannelRef<C extends { id: string; name: string }>(
  name: string,
  refs: Record<string, string> | undefined,
  channels: readonly C[],
): { id: string; known: C | null } | null {
  const key = name.toLowerCase();
  const id = refs?.[key];
  if (id) return { id, known: channels.find((c) => c.id === id) ?? null };
  const known = channels.find((c) => c.name.toLowerCase() === key);
  return known ? { id: known.id, known } : null;
}

/** How many channels the "#" picker shows. */
export const CHANNEL_PICK_LIMIT = 8;

/**
 * Which channels "#<query>" can mean: names containing it, those starting with it first, then the ones I'm in,
 * then by name.
 */
export function channelOptions<C extends { name: string; isMember: boolean }>(
  query: string,
  channels: readonly C[],
  limit = CHANNEL_PICK_LIMIT,
): C[] {
  const q = query.toLowerCase();
  const rank = (c: C) => (c.name.startsWith(q) ? 0 : 1);
  return (
    channels
      // A name of digits only would never link (`CHANNEL_REF`).
      .filter((c) => c.name.includes(q) && /[a-z]/.test(c.name))
      .sort((a, b) => rank(a) - rank(b) || Number(b.isMember) - Number(a.isMember) || a.name.localeCompare(b.name))
      .slice(0, limit)
  );
}

/** A channel card's line of facts (web hover card and phone sheet): "2 pessoas · 1 agente · você participa". */
export function channelCardFacts(t: TFunction, card: Pick<ChannelCard, "people" | "agents" | "isMember">): string {
  return [
    t("channelRefs.people", { count: card.people }),
    t("channelRefs.agents", { count: card.agents }),
    card.isMember ? t("channelRefs.member") : t("channelRefs.notMember"),
  ].join(" · ");
}
