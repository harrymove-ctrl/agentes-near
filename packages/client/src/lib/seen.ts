import type { DmRead } from "../api/types";

/**
 * "Visto" in a DM between people: my latest message, once the other person has read it and
 * nothing of theirs came after (their answer already says they saw it). Null when there is none.
 */
export function seenMessageId(
  messages: readonly { id: string; createdAt: string; author: { type: string; id: string | null }; local?: string }[],
  meId: string,
  reads: readonly DmRead[],
): string | null {
  // The live `channel.read` events fold my own reads in too (the server's list leaves them out).
  const readAt = Math.max(0, ...reads.filter((r) => r.userId !== meId).map((r) => Date.parse(r.lastReadAt)));
  if (!readAt) return null;
  const last = messages.at(-1);
  if (!last || last.local || last.author.type !== "person" || last.author.id !== meId) return null;
  return Date.parse(last.createdAt) <= readAt ? last.id : null;
}

/** A `channel.read` event folded into the DM's reads (the later read wins). */
export function withRead(reads: readonly DmRead[] | undefined, read: DmRead): DmRead[] {
  const list = reads ?? [];
  const old = list.find((r) => r.userId === read.userId);
  if (old && Date.parse(old.lastReadAt) >= Date.parse(read.lastReadAt)) return [...list];
  return [...list.filter((r) => r.userId !== read.userId), read];
}
