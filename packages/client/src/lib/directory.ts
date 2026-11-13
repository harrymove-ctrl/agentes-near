import type { Agent, FormerAgent } from "../api/types";

/** An agent no longer in the team as the directories hold it: its name, role and look; nobody talks to it. */
export const formerAgent = (a: FormerAgent): Agent => ({
  id: a.id,
  name: a.name,
  handle: "",
  role: a.role,
  instructions: "",
  model: "",
  ownerUserId: null,
  hasCredential: false,
  createdAt: "",
  canTalk: false,
  former: a.deleted ? "deleted" : "archived",
  ...(a.appearance ? { appearance: a.appearance } : {}),
});

/** Agents no longer in the team by id (ADR 0082), apart from the team's so no list or picker offers them. */
export const formerById = (former: FormerAgent[] = []) => new Map(former.map((a) => [a.id, formerAgent(a)] as const));

/**
 * Agents by each handle that names them, lower case: their own, and the ones they had before a rename (an agent's own
 * handle wins), so an old message's @ada still shows the agent now called Claudio.
 */
export function agentsByAnyHandle<A extends { handle: string; previousHandles?: string[] }>(agents: readonly A[]) {
  const out = new Map<string, A>();
  for (const a of agents) for (const h of a.previousHandles ?? []) out.set(h.toLowerCase(), a);
  for (const a of agents) out.set(a.handle.toLowerCase(), a);
  return out;
}
