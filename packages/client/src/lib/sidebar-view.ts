import type { Agent, AgentGroup, SidebarPins, SidebarView } from "../api/types";
import { groupOf } from "./agent-groups";

/** At most this many pinned rows on top of each section (`SIDEBAR_PIN_LIMIT`, packages/engine/src/sidebar-items.ts). */
export const SIDEBAR_PIN_LIMIT = 5;
export type PinKind = keyof SidebarPins;
/** AGENTES' orders, as its ⋯ menu lists them (`AGENT_SORTS`, packages/engine/src/sidebar-items.ts). */
export const AGENT_SORTS = ["workspace", "mine", "working"] as const satisfies readonly SidebarView["agentSort"][];

/** The view of someone who never changed it. */
export const SIDEBAR_VIEW_DEFAULT: SidebarView = { agentSort: "workspace", showAllAgents: false, pins: null };
const NO_PINS: SidebarPins = { agents: [], channels: [], people: [] };

/**
 * Day one ("Fixar no topo" never used nor dismissed): the person's own agents on top of AGENTES, the most recently
 * active first (`lastActive`: agent id → ISO time of its DM's last message), then in the workspace's order (the
 * agents' list: as they were made, a template team in its template's order), at most the limit. Only the ones in no
 * group: these follow the DMs' activity, so a grouped agent pinned here would move inside its group whenever its
 * agents talked.
 */
export function dayOnePins(
  agents: readonly Pick<Agent, "id" | "name" | "ownerUserId">[],
  myUserId: string,
  lastActive: ReadonlyMap<string, string> = new Map(),
  groups: readonly AgentGroup[] = [],
): string[] {
  return agents
    .filter((a) => a.ownerUserId === myUserId && !groupOf(groups, a.id))
    .sort((a, b) => (lastActive.get(b.id) ?? "").localeCompare(lastActive.get(a.id) ?? ""))
    .slice(0, SIDEBAR_PIN_LIMIT)
    .map((a) => a.id);
}

/**
 * What shows pinned: the saved pins, or on day one only `dayOne` agents. With `known` (the ids each list holds), a pin
 * of something gone (a deleted agent, a channel I left) is left out: it never shows, so no one could take it off, and
 * it would hold one of the five places for good. A list not loaded yet (missing or empty) keeps its pins.
 */
export function pinsOf(
  view: SidebarView,
  dayOne: readonly string[],
  known: { [K in PinKind]?: readonly string[] | undefined } = {},
): SidebarPins {
  const pins = view.pins ?? { ...NO_PINS, agents: [...dayOne] };
  const kept = (kind: PinKind) => {
    const ids = known[kind];
    return ids?.length ? pins[kind].filter((id) => ids.includes(id)) : pins[kind];
  };
  return { agents: kept("agents"), channels: kept("channels"), people: kept("people") };
}

/**
 * `id` pinned first in its section (where the person looks: at the end of the pinned rows, the row next to them
 * hardly moved), or taken off; null when the section already holds the limit.
 */
export function togglePin(pins: SidebarPins, kind: PinKind, id: string): SidebarPins | null {
  const list = pins[kind];
  if (list.includes(id)) return { ...pins, [kind]: list.filter((x) => x !== id) };
  if (list.length >= SIDEBAR_PIN_LIMIT) return null;
  return { ...pins, [kind]: [id, ...list] };
}

/**
 * A section's rows split into its pinned ones (`top`, in the pins' order) and the rest (in theirs). A pin puts an
 * agent on top of its own setor (or of the agents in none), never out of it: a setor holds its agents whoever put
 * them there, and whenever.
 */
export function splitPinned<T>(items: readonly T[], pins: readonly string[], idOf: (item: T) => string) {
  const top = pins.flatMap((id) => items.filter((item) => idOf(item) === id));
  return { top, rest: items.filter((item) => !top.includes(item)) };
}

/**
 * `view` with these agents out of its pins; null when none of them is pinned. An agent the person just put in a group
 * by hand lands where they put it, not on top of the group as a pinned one would.
 */
export function unpinAgents(view: SidebarView, ids: readonly string[]): SidebarView | null {
  const agents = view.pins?.agents.filter((id) => !ids.includes(id));
  if (!view.pins || !agents || agents.length === view.pins.agents.length) return null;
  return { ...view, pins: { ...view.pins, agents } };
}

/** `view` with the agent pinned again at `at` among the pinned agents (Desfazer after a move took its pin off). */
export function repinAgent(view: SidebarView, id: string, at: number): SidebarView {
  const pins = view.pins;
  if (!pins || pins.agents.includes(id) || pins.agents.length >= SIDEBAR_PIN_LIMIT) return view;
  return { ...view, pins: { ...pins, agents: [...pins.agents.slice(0, at), id, ...pins.agents.slice(at)] } };
}

/**
 * One group's agents in the person's order (stable): the workspace's, the ones I'm responsible for first (`mine`), or
 * the ones working now first (`working`, `busy` their ids).
 */
export function sortAgents<A extends Pick<Agent, "id" | "ownerUserId">>(
  agents: readonly A[],
  sort: SidebarView["agentSort"],
  myUserId: string,
  busy: ReadonlySet<string> = new Set(),
): A[] {
  if (sort === "workspace") return [...agents];
  const first = (a: A) => (sort === "mine" ? a.ownerUserId === myUserId : busy.has(a.id));
  return [...agents.filter(first), ...agents.filter((a) => !first(a))];
}
