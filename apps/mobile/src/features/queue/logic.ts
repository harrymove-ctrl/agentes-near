import type { Channel, DirectMessage, Machine, QueueWhere } from "@agenteschat/client";
import type { QueuePlace } from "@agenteschat/client/lib/computer-queue";

/**
 * A shared computer's line on the phone (ADR 0032, "Calm waits"): which computer a conversation's agents share and
 * where a turn answers as this person knows the conversation. The rest comes from the shared `computer-queue` lib,
 * as on the web.
 */

/** The computer the first of these agents thinks on: a Cloud workspace has one, shared by all of them. */
export function machineOfAgents(
  machines: readonly Pick<Machine, "id" | "agents">[] | undefined,
  agentIds: readonly string[],
): string | null {
  for (const id of agentIds) {
    const m = machines?.find((x) => x.agents.some((a) => a.id === id));
    if (m) return m.id;
  }
  return null;
}

/**
 * Where a turn answers: agents' private conversation for who may see that work, one of my DMs, a channel I can see
 * (or a thread in it), else a private conversation.
 */
export function queuePlace(
  where: QueueWhere,
  channels: readonly Pick<Channel, "id" | "name" | "visibility" | "isMember">[] | undefined,
  dms: readonly Pick<DirectMessage, "channelId">[] | undefined,
): QueuePlace {
  if (where.agents) return { kind: "agents" };
  if (dms?.some((d) => d.channelId === where.channelId)) return { kind: "dm", mine: true };
  const ch = channels?.find((c) => c.id === where.channelId);
  if (!ch || (ch.visibility === "private" && !ch.isMember)) return { kind: "hidden" };
  return { kind: "channel", name: ch.name, thread: where.threadId !== null };
}
