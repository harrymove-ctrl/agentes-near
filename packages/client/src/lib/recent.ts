import type { Channel, DirectMessage } from "../api/types";
import { hiddenDm } from "./audience";

/**
 * The conversations to load as soon as the app opens: unread ones first, then
 * the latest activity (channels I'm in and DMs), at most `count` channel ids.
 */
export function recentConversations(
  channels: readonly Channel[],
  dms: readonly DirectMessage[],
  count: number,
): string[] {
  const all = new Map<string, { at: string; unread: number }>();
  for (const c of channels) {
    if (c.isMember && c.lastMessage)
      all.set(c.id, { at: c.lastMessage.createdAt, unread: c.muted ? 0 : (c.unreadCount ?? 0) });
  }
  for (const d of dms) {
    if (d.lastMessage) all.set(d.channelId, { at: d.lastMessage.createdAt, unread: d.unread });
  }
  return [...all]
    .sort(([, a], [, b]) => Number(b.unread > 0) - Number(a.unread > 0) || b.at.localeCompare(a.at))
    .slice(0, count)
    .map(([id]) => id);
}

/** Where a DM sorts: its latest message, or when it began while it has none, so a new DM lands on top. */
export const dmActivityAt = (d: Pick<DirectMessage, "lastMessage" | "openedAt">) =>
  d.lastMessage?.createdAt ?? d.openedAt ?? null;

/** How long a DM nobody wrote in stays in the sidebar: no row can be closed, and every visit to a person opens one. */
export const EMPTY_DM_SHOWN_MS = 24 * 3600_000;

/**
 * The sidebar's "Mensagens diretas": latest activity first, DMs with agents hidden from me left out, and one with no
 * message only while it is new.
 */
export const recentDms = <D extends Pick<DirectMessage, "with" | "lastMessage" | "openedAt">>(
  dms: readonly D[],
  hiddenAgents?: ReadonlySet<string>,
  now = Date.now(),
): D[] =>
  dms
    .filter(
      (d) =>
        !hiddenDm(d, hiddenAgents) &&
        (d.lastMessage !== null || now - Date.parse(d.openedAt ?? "") < EMPTY_DM_SHOWN_MS),
    )
    .sort((a, b) => (dmActivityAt(b) ?? "").localeCompare(dmActivityAt(a) ?? ""));
