import type { ReactionCount } from "../api/types";

/** A message's reactions with mine given or taken back, as the server will answer: what shows before it does. */
export function setMyReaction(
  reactions: ReactionCount[] | undefined,
  reaction: string,
  meId: string,
  on: boolean,
): ReactionCount[] {
  const list = reactions ?? [];
  const hit = list.find((r) => r.reaction === reaction);
  if (Boolean(hit?.userIds.includes(meId)) === on) return list;
  if (!hit) return [...list, { reaction, count: 1, userIds: [meId], agentIds: [] }];
  const userIds = on ? [...hit.userIds, meId] : hit.userIds.filter((u) => u !== meId);
  const next = { ...hit, userIds, count: Math.max(0, hit.count + (on ? 1 : -1)) };
  return next.count === 0 && (next.agentIds?.length ?? 0) === 0
    ? list.filter((r) => r.reaction !== reaction)
    : list.map((r) => (r.reaction === reaction ? next : r));
}
