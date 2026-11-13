import type { AgentGroup, TeamAgent } from "../api/types";
import { groupOf } from "./agent-groups";

/**
 * Equipe's views (ADR 0148): the list's filters and sort, the org chart's columns and the team map's columns, from
 * what `useTeam` and `useAgentGroups` return. The web and the phone draw the same ones.
 */

export type TeamFilter = "all" | "mine" | "working" | "waiting" | "noOwner";
export type TeamSort = "name" | "role" | "sector" | "owner";

/** The agents a filter and a search (name, handle, role or a channel's name) leave, in the team's order. */
export function filterTeam(
  agents: readonly TeamAgent[],
  opts: {
    filter: TeamFilter;
    q: string;
    meId: string;
    /** Agents with a request waiting for me (`waiting`). */
    waitingIds?: ReadonlySet<string>;
    channelName?: (id: string) => string | undefined;
  },
): TeamAgent[] {
  const q = opts.q.trim().toLowerCase();
  return agents.filter((a) => {
    if (opts.filter === "mine" && a.ownerUserId !== opts.meId) return false;
    if (opts.filter === "working" && !a.busy) return false;
    if (opts.filter === "waiting" && !opts.waitingIds?.has(a.id)) return false;
    if (opts.filter === "noOwner" && a.ownerUserId) return false;
    if (!q) return true;
    const words = [a.name, a.handle, a.role, ...(a.channelIds ?? []).map((id) => opts.channelName?.(id) ?? "")];
    return words.some((w) => w.toLowerCase().includes(q));
  });
}

/** Sorted by a column, ties by name; an empty value goes last either way. */
export function sortTeam(
  agents: readonly TeamAgent[],
  by: TeamSort,
  desc: boolean,
  names: { sector: (agentId: string) => string; owner: (userId: string | null) => string },
): TeamAgent[] {
  const value = (a: TeamAgent) =>
    by === "name" ? a.name : by === "role" ? a.role : by === "sector" ? names.sector(a.id) : names.owner(a.ownerUserId);
  return [...agents].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (!x !== !y) return x ? -1 : 1;
    const c = x.localeCompare(y) * (desc ? -1 : 1);
    return c || a.name.localeCompare(b.name);
  });
}

/** The agent `agent` reports to (Responde a), when it is still on the team; else null. */
export function supervisorOf<A extends Pick<TeamAgent, "id" | "reportsToAgentId">>(agent: A, agents: readonly A[]) {
  const id = agent.reportsToAgentId;
  return id && id !== agent.id ? (agents.find((a) => a.id === id) ?? null) : null;
}

/** The agents that report to `agentId` directly, in the team's order. */
export const reportsOf = <A extends Pick<TeamAgent, "id" | "reportsToAgentId">>(
  agentId: string,
  agents: readonly A[],
) => agents.filter((a) => a.reportsToAgentId === agentId && a.id !== agentId);

/** The top of an agent's line: itself when it reports to no agent. */
export function lineTop<A extends Pick<TeamAgent, "id" | "reportsToAgentId">>(agent: A, agents: readonly A[]) {
  let at = agent;
  const seen = new Set([at.id]);
  for (let up = supervisorOf(at, agents); up && !seen.has(up.id); up = supervisorOf(at, agents)) {
    seen.add(up.id);
    at = up;
  }
  return at;
}

/**
 * Who an agent reports to among people on the org chart: its line's top agent's owner, else that agent's setor's lead;
 * null for neither (or one who left).
 */
export function reportsTo(
  agent: TeamAgent,
  groups: readonly AgentGroup[],
  members: ReadonlySet<string>,
  agents: readonly TeamAgent[] = [],
) {
  const top = lineTop(agent, agents);
  if (top.ownerUserId && members.has(top.ownerUserId)) return top.ownerUserId;
  const lead = groupOf(groups, top.id)?.leadUserId;
  return lead && members.has(lead) ? lead : null;
}

/** An agent on the chart with the agents that report to it under it, all the way down. */
export interface ChartNode {
  agent: TeamAgent;
  reports: ChartNode[];
}

/** `top` and its line as a tree (an agent drawn once even if the stored lines loop). */
function nodeOf(top: TeamAgent, shown: readonly TeamAgent[], seen: Set<string>): ChartNode {
  seen.add(top.id);
  return {
    agent: top,
    reports: reportsOf(top.id, shown)
      .filter((a) => !seen.has(a.id))
      .map((a) => nodeOf(a, shown, seen)),
  };
}

/** How many agents report to a node, all the way down ("4 agentes"). */
export const lineSize = (node: ChartNode): number => node.reports.reduce((n, r) => n + 1 + lineSize(r), 0);

/**
 * The org chart by person: one column per person someone reports to, in the order their first agent was made, and
 * the agents with nobody last (`personId` null). A supervisor sits in its person's column with its reports under it
 * (`nodes`); `agents` is every agent of the column, flat. `skip` leaves agents out (the right hand, drawn on its own).
 */
export function chartByPerson(
  agents: readonly TeamAgent[],
  groups: readonly AgentGroup[],
  members: ReadonlySet<string>,
  skip: (a: TeamAgent) => boolean = () => false,
): { personId: string | null; agents: TeamAgent[]; nodes: ChartNode[] }[] {
  const shown = agents.filter((a) => !skip(a));
  const columns = new Map<string | null, TeamAgent[]>();
  for (const a of shown) {
    const to = reportsTo(a, groups, members, shown);
    columns.set(to, [...(columns.get(to) ?? []), a]);
  }
  const seen = new Set<string>();
  const col = (personId: string | null, list: TeamAgent[]) => {
    const nodes = list.filter((a) => lineTop(a, shown).id === a.id).map((a) => nodeOf(a, shown, seen));
    // A line that loops in storage has no top: each of its agents is drawn on its own, once.
    for (const a of list) if (!seen.has(a.id)) nodes.push(nodeOf(a, shown, seen));
    return { personId, agents: list, nodes };
  };
  const none = columns.get(null);
  columns.delete(null);
  const out = [...columns].map(([personId, list]) => col(personId, list));
  return none ? [...out, col(null, none)] : out;
}

/** The agents others report to, in the team's order: the Mapa's band. */
export const supervisors = (agents: readonly TeamAgent[]) =>
  agents.filter((s) => agents.some((a) => a.id !== s.id && a.reportsToAgentId === s.id));

/** The one agent every one of `agents` reports to (a Mapa column's or a setor's face), else null. */
export function sharedSupervisor(agents: readonly TeamAgent[], team: readonly TeamAgent[]) {
  const ids = new Set(agents.map((a) => a.reportsToAgentId ?? null));
  const [only] = ids;
  return ids.size === 1 && only ? (team.find((a) => a.id === only) ?? null) : null;
}

/**
 * A setor's supervisor (its "Supervisor" row): the agent most of its agents report to, and how many of the others
 * (not the supervisor itself) don't, for "1 agente sem supervisor · Aplicar". Null when none of them reports to one.
 */
export function sectorSupervisor(group: AgentGroup, team: readonly TeamAgent[]) {
  const mine = group.agentIds.flatMap((id) => team.find((a) => a.id === id) ?? []);
  const count = new Map<string, number>();
  for (const a of mine) if (a.reportsToAgentId) count.set(a.reportsToAgentId, (count.get(a.reportsToAgentId) ?? 0) + 1);
  const [top] = [...count].sort((x, y) => y[1] - x[1]);
  const supervisor = top ? team.find((a) => a.id === top[0]) : undefined;
  if (!supervisor) return null;
  const off = mine.filter((a) => a.id !== supervisor.id && a.reportsToAgentId !== supervisor.id);
  return { supervisor, off };
}

/**
 * The changes that make every agent of a setor report to `supervisorId` (the supervisor itself left as it is), or that
 * clear the ones reporting to `clearOf` (`supervisorId` null).
 */
export function sectorLineChanges(
  group: AgentGroup,
  team: readonly TeamAgent[],
  supervisorId: string | null,
  clearOf?: string,
) {
  const mine = group.agentIds.flatMap((id) => team.find((a) => a.id === id) ?? []);
  return supervisorId
    ? mine
        .filter((a) => a.id !== supervisorId && a.reportsToAgentId !== supervisorId)
        .map((a) => ({ agentId: a.id, reportsToAgentId: supervisorId }))
    : mine
        .filter((a) => clearOf !== undefined && a.reportsToAgentId === clearOf)
        .map((a) => ({ agentId: a.id, reportsToAgentId: null }));
}

/**
 * Whether `agentId` may report to `to` as the chart sees it (the server checks again): not itself, not into its own
 * line below it, and at most `MAX_LINE` agents top to bottom.
 */
export const MAX_LINE = 3;
export function mayReportTo(
  agents: readonly Pick<TeamAgent, "id" | "reportsToAgentId">[],
  agentId: string,
  to: string,
): boolean {
  if (to === agentId) return false;
  const byId = new Map(agents.map((a) => [a.id, a]));
  let above = 0;
  for (let at: string | null | undefined = to; at; at = byId.get(at)?.reportsToAgentId) {
    if (at === agentId || above > MAX_LINE) return false;
    above++;
  }
  const height = (id: string, depth: number): number =>
    depth > MAX_LINE ? depth : Math.max(1, ...reportsOf(id, agents).map((r) => 1 + height(r.id, depth + 1)));
  return above + height(agentId, 1) <= MAX_LINE;
}

/**
 * The team map's columns: one per channel with agents in it, in `channelOrder` (the sidebar's), an agent in every
 * channel it is in; then the agents in none (`channelId` null). Channels the viewer doesn't know are left out.
 */
export function mapColumns(
  agents: readonly TeamAgent[],
  channelOrder: readonly string[],
  skip: (a: TeamAgent) => boolean = () => false,
): { channelId: string | null; agents: TeamAgent[] }[] {
  const known = new Set(channelOrder);
  const shown = agents.filter((a) => !skip(a));
  const columns = channelOrder
    .map((channelId) => ({ channelId, agents: shown.filter((a) => a.channelIds?.includes(channelId)) }))
    .filter((c) => c.agents.length > 0);
  const nowhere = shown.filter((a) => !(a.channelIds ?? []).some((id) => known.has(id)));
  return nowhere.length > 0 ? [...columns, { channelId: null, agents: nowhere }] : columns;
}

/**
 * A setor's people and channels: its lead, its substitute and its agents' owners (each once, in that order), and the
 * channels its agents are in (in the team's order of first appearance).
 */
export function sectorReach(group: AgentGroup, agents: readonly TeamAgent[]) {
  const mine = group.agentIds.flatMap((id) => agents.find((a) => a.id === id) ?? []);
  const people = [
    ...new Set(
      [group.leadUserId, group.backupUserId, ...mine.map((a) => a.ownerUserId)].filter((id): id is string => !!id),
    ),
  ];
  const channelIds = [...new Set(mine.flatMap((a) => a.channelIds ?? []))];
  return { agents: mine, people, channelIds };
}

/** What an empty Setores says: what they give to who can create one, who does to who can't. */
export const noSectorsCopy = (arranges: boolean) =>
  arranges
    ? ({ title: "team.sectors.emptyTitle", text: "team.sectors.empty" } as const)
    : ({ title: "team.sectors.emptyViewerTitle", text: "team.sectors.emptyViewer" } as const);

/** What a setor is missing, as a word the apps translate: no lead first, then no substitute; null when covered. */
export const sectorGap = (group: AgentGroup): "noLead" | "noBackup" | null =>
  !group.leadUserId ? "noLead" : !group.backupUserId ? "noBackup" : null;
