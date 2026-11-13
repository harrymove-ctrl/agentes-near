import type { AgentGroup } from "../api/types";

/** The value of "no group" where a group is picked (never a group's id). */
export const NO_GROUP = "none";

/** The group an agent is in, if any. */
export const groupOf = (groups: readonly AgentGroup[] | undefined, agentId: string) =>
  groups?.find((g) => g.agentIds.includes(agentId));

/**
 * `items` (agents, or rows that carry one) by group (ADR 0083): each group in the workspace's order with its items in
 * the group's, and the items in no group as they came. A group's agents missing from `items` are skipped.
 */
export function agentSections<T>(
  items: readonly T[],
  groups: readonly AgentGroup[] | undefined,
  idOf: (item: T) => string,
): { ungrouped: T[]; groups: { group: AgentGroup; items: T[] }[] } {
  const byId = new Map(items.map((item) => [idOf(item), item]));
  const placed = new Set<string>();
  const sections = (groups ?? []).map((group) => ({
    group,
    items: group.agentIds.flatMap((id) => {
      const item = byId.get(id);
      if (item === undefined || placed.has(id)) return [];
      placed.add(id);
      return [item];
    }),
  }));
  return { ungrouped: items.filter((item) => !placed.has(idOf(item))), groups: sections };
}

/**
 * The groups once an agent moves, as the server orders them: into `groupId` at `index` among its other agents (the
 * end without one), or out of any group (`groupId` null).
 */
export function moveInGroups(
  groups: readonly AgentGroup[],
  agentId: string,
  groupId: string | null,
  index?: number,
): AgentGroup[] {
  return groups.map((g) => {
    const others = g.agentIds.filter((id) => id !== agentId);
    if (g.id !== groupId) return others.length === g.agentIds.length ? g : { ...g, agentIds: others };
    const at = Math.max(0, Math.min(others.length, Math.trunc(index ?? others.length)));
    return { ...g, agentIds: [...others.slice(0, at), agentId, ...others.slice(at)] };
  });
}
