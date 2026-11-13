import type { Agent, RoutineAccess } from "../api/types";
import { audienceAdmits, canTalk } from "./audience";
import { MENTION } from "./markdown";

/**
 * Why an agent's message didn't wake an agent it named (the server's `meta.reach`, `reach.ts`): `not_in_channel`, it
 * went to it as a note instead; `audience`, the person behind it can't talk to it (with a `consultationId`: it was
 * consulted privately for them instead); `routine_creator_reach`, a
 * routine's creator can't (or the routine only looks and tells).
 */
export type ReachReason = "not_in_channel" | "audience" | "routine_creator_reach";

export interface ReachEntry {
  agentId: string;
  handle: string;
  reason: ReachReason;
  /** Delivered as a hand-off note: its consultation (opens the two agents' conversation). */
  consultationId?: string;
  /** Not a member of the conversation either. */
  outside?: true;
  /** `not_in_channel` from a private conversation, on messages from before such mentions were forwarded too. */
  private?: true;
  /** `not_in_channel` to an agent with no AI connected: nothing could answer it. */
  noAi?: true;
  /** Old messages: the own message of a routine then set to only look and tell named it, which woke nobody. */
  routinePost?: true;
  /** Whose reach fell short: the agent's owner may let them talk to it. */
  userId?: string;
  routine?: { id: string; name: string; creatorUserId: string | null; access: RoutineAccess };
}

/** `meta.reach`, read safely. */
export function reachOf(meta: Record<string, unknown> | null | undefined): ReachEntry[] {
  const list = meta?.reach;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is ReachEntry =>
      !!e && typeof e === "object" && typeof e.agentId === "string" && typeof e.handle === "string",
  );
}

/** Old messages: the routine then only looked and told, so its access, not anyone's audience, kept the agent out. */
export const reachByAccess = (e: ReachEntry) => e.reason === "routine_creator_reach" && e.routine?.access === "read";

/** Whether the line opens the hand-off beside it: not for an agent consulted for someone outside its audience (its words are the agents'). */
export const reachOpens = (e: ReachEntry) => !!e.consultationId && e.reason === "not_in_channel";

/**
 * The hand-offs by direct message a message's reach lines show as the two agents' pair row (`reachOpens`): the
 * reply's own pair row leaves them out, so none shows twice.
 */
export const reachHandoffs = (meta: Record<string, unknown> | null | undefined): ReadonlySet<string> =>
  new Set(reachOf(meta).flatMap((e) => (reachOpens(e) && e.consultationId ? [e.consultationId] : [])));

/** The line's text key: handed (or consulted for someone outside its audience), a routine's message, no AI, kept private, the routine only looks, or who couldn't call it. */
export const reachKey = (e: ReachEntry) =>
  e.consultationId
    ? e.reason === "not_in_channel"
      ? ("reach.handed" as const)
      : ("reach.consulted" as const)
    : e.routinePost
      ? ("reach.routinePost" as const)
      : e.noAi
        ? ("reach.noAi" as const)
        : e.private
          ? ("reach.private" as const)
          : reachByAccess(e)
            ? ("reach.routineRead" as const)
            : ("reach.blocked" as const);

/**
 * The agents a routine's prompt names that it won't be able to call, for its dialog (a warning, never a block): the
 * ones its creator can't talk to (`creatorUserId` when someone else's routine is being edited, else the viewer).
 * Never the routine's own agent.
 */
export function routineReachWarnings(
  prompt: string,
  agents: readonly Agent[],
  options: { agentId: string | null; creatorUserId?: string | null; creatorRoleIds?: readonly string[] },
): { agent: Agent }[] {
  const handles = new Set([...prompt.matchAll(MENTION)].map((m) => (m[2] ?? "").toLowerCase()));
  return agents.flatMap((agent) => {
    if (agent.id === options.agentId || !handles.has(agent.handle.toLowerCase())) return [];
    const reaches = options.creatorUserId
      ? audienceAdmits(agent, options.creatorUserId, options.creatorRoleIds)
      : canTalk(agent);
    return reaches ? [] : [{ agent }];
  });
}
