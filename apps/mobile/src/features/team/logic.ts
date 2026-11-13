import type { AgentGroup, Channel, Member, TeamAgent } from "@agenteschat/client";
import { agentSections } from "@agenteschat/client/lib/agent-groups";
import { type ChartNode, chartByPerson, mapColumns } from "@agenteschat/client/lib/team-views";

export type TeamView = "list" | "chart" | "map";

/** One section of the phone's Equipe: a title (a setor, a person or a channel) and its agents. */
export interface TeamSection {
  key: string;
  /** A setor's, a person's or a channel's name; null: the "none" section, which each view words itself. */
  title: string | null;
  group?: AgentGroup;
  /** A setor's lead and substitute by name (Lista), null for nobody or someone who left: the web's Setores card. */
  lead?: string | null;
  backup?: string | null;
  agents: TeamAgent[];
}

/**
 * The phone's Equipe (ADR 0148) as sections, one view at a time, from the same lists as the web: Lista by setor
 * (the agents in none last), Organograma by the person each agent reports to, Mapa by channel (the web's columns
 * stacked). The right hand is never in them: it heads the org chart on its own.
 */
export function teamSections(
  view: TeamView,
  input: {
    agents: readonly TeamAgent[];
    groups: readonly AgentGroup[];
    members: readonly Member[];
    channels: readonly Channel[];
    rightHandId: string | null;
  },
): TeamSection[] {
  const skip = (a: TeamAgent) => a.id === input.rightHandId;
  const agents = input.agents.filter((a) => !skip(a));
  const people = new Map(input.members.map((m) => [m.userId, m.name]));
  const nameOf = (id: string | null | undefined) => (id ? (people.get(id) ?? null) : null);
  if (view === "list") {
    const by = agentSections(agents, input.groups, (a) => a.id);
    return [
      ...by.groups
        .filter((g) => g.items.length > 0)
        .map(({ group, items }) => ({
          key: group.id,
          title: group.name,
          group,
          lead: nameOf(group.leadUserId),
          backup: nameOf(group.backupUserId),
          agents: items,
        })),
      ...(by.ungrouped.length ? [{ key: "none", title: null, agents: by.ungrouped }] : []),
    ];
  }
  if (view === "chart") {
    return chartByPerson(agents, input.groups, new Set(people.keys())).map((c) => ({
      key: c.personId ?? "none",
      title: nameOf(c.personId),
      agents: c.agents,
    }));
  }
  const names = new Map(input.channels.map((c) => [c.id, c.name]));
  return mapColumns(
    agents,
    input.channels.map((c) => c.id),
  ).map((c) => ({
    key: c.channelId ?? "none",
    title: c.channelId ? `#${names.get(c.channelId) ?? ""}` : null,
    agents: c.agents,
  }));
}

/** The phone's org chart column as rows: each line top to bottom, a supervisor's report one step in (ADR 0148 addendum). */
export function chartRows(nodes: readonly ChartNode[], depth = 0): { agent: TeamAgent; depth: number }[] {
  return nodes.flatMap((n) => [{ agent: n.agent, depth }, ...chartRows(n.reports, depth + 1)]);
}

/** Whether the line of `level` runs on past row `i`: a row of that level follows before the line climbs above it. */
export function lineContinues(rows: readonly { depth: number }[], i: number, level: number) {
  for (const r of rows.slice(i + 1)) {
    if (r.depth < level) return false;
    if (r.depth === level) return true;
  }
  return false;
}
