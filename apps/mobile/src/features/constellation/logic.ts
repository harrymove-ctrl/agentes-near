import type { Agent, Memory, WikiAgentReads, WikiGraph } from "@agenteschat/client";
import { layoutGraph } from "@agenteschat/client/lib/wiki";

/** A sky of what the team knows: agents, the pages they read, what they learned, and the real links between them. */
export type StarKind = "agent" | "page" | "memory";

export interface Star {
  id: string;
  kind: StarKind;
  title: string;
  /** The agent it belongs to (a memory), or that it is. */
  agentId?: string;
  /** Pages: the folder. */
  folder?: string;
  /** How much it is used: reads or uses. */
  weight: number;
}

export interface StarLink {
  from: string;
  to: string;
  /** Used lately: a light passes along it. */
  recent: boolean;
}

export interface StarMap {
  stars: Star[];
  links: StarLink[];
}

export interface Point {
  x: number;
  y: number;
}

/** How many memories a map draws (the most used). */
export const MAP_MEMORIES = 60;
const DAY = 86_400_000;
const LABEL_WIDTH = 112;
const LABEL_HEIGHT = 38;

const short = (text: string, max = 34) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** The agents as stars (only those in the map), the deleted left out by their lookup. */
const agentStars = (ids: Iterable<string>, agents: Pick<Agent, "id" | "name">[]): Star[] =>
  [...new Set(ids)].flatMap((id) => {
    const a = agents.find((x) => x.id === id);
    return a ? [{ id, kind: "agent" as const, title: a.name, agentId: id, weight: 0 }] : [];
  });

/** Memória's sky: each agent with what it learned; a link is "this agent knows this", lit when used in the last day. */
export function memoryMap(memories: Memory[], agents: Pick<Agent, "id" | "name">[], now = Date.now()): StarMap {
  const known = new Set(agents.map((a) => a.id));
  const shown = memories
    .filter((m) => !m.archived && known.has(m.agentId))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, MAP_MEMORIES);
  return {
    stars: [
      ...agentStars(
        shown.map((m) => m.agentId),
        agents,
      ),
      ...shown.map((m) => ({
        id: m.id,
        kind: "memory" as const,
        title: short(m.text),
        agentId: m.agentId,
        weight: m.uses,
      })),
    ],
    links: shown.map((m) => ({
      from: m.agentId,
      to: m.id,
      recent: m.lastUsedAt !== null && now - new Date(m.lastUsedAt).getTime() < DAY,
    })),
  };
}

/** Wiki's sky: the pages and their links, and each agent tied to what it read this week (a light on those). */
export function wikiMap(
  graph: WikiGraph,
  reads: (WikiAgentReads & { slug: string })[],
  agents: Pick<Agent, "id" | "name">[],
): StarMap {
  const pages = new Set(graph.nodes.map((n) => n.slug));
  const total = new Map(reads.map((r) => [r.slug, r.total]));
  const readLinks = reads
    .filter((r) => pages.has(r.slug))
    .flatMap((r) => r.agents.map((a) => ({ from: a.agentId, to: r.slug, recent: true })));
  const stars = agentStars(
    readLinks.map((l) => l.from),
    agents,
  );
  const here = new Set(stars.map((s) => s.id));
  return {
    stars: [
      ...stars,
      ...graph.nodes.map((n) => ({
        id: n.slug,
        kind: "page" as const,
        title: n.title,
        folder: n.folder,
        weight: total.get(n.slug) ?? 0,
      })),
    ],
    links: [
      ...graph.edges
        .filter((e) => pages.has(e.from) && pages.has(e.to))
        .map((e) => ({ from: e.from, to: e.to, recent: false })),
      ...readLinks.filter((l) => here.has(l.from)),
    ],
  };
}

/**
 * The wiki as the web's graph draws it: only the pages and their [[links]], each star as big as it is linked and
 * tinted by the agent that wrote it (a person's page stays white).
 */
export function pagesMap(graph: WikiGraph): StarMap {
  const pages = new Set(graph.nodes.map((n) => n.slug));
  const edges = graph.edges.filter((e) => e.from !== e.to && pages.has(e.from) && pages.has(e.to));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  return {
    stars: graph.nodes.map((n) => ({
      id: n.slug,
      kind: "page" as const,
      title: n.title,
      folder: n.folder,
      weight: degree.get(n.slug) ?? 0,
      ...(n.agentId ? { agentId: n.agentId } : {}),
    })),
    links: edges.map((e) => ({ from: e.from, to: e.to, recent: false })),
  };
}

/** The most linked star (where a map opens, and where its lines start drawing from); null on an empty map. */
export const mostLinked = (map: StarMap): string | null =>
  [...map.stars].sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title))[0]?.id ?? null;

/** How many links touch a star. */
export const linkCount = (map: StarMap, id: string) => map.links.filter((l) => l.from === id || l.to === id).length;

/** What a page links to, each once, in the graph's order (the API gives a page its backlinks, not these). */
export const linksOutOf = (graph: WikiGraph, slug: string): string[] => [
  ...new Set(graph.edges.filter((e) => e.from === slug && e.to !== slug).map((e) => e.to)),
];

/** The `count` most linked stars and the links between them: a small sky that stays legible on a big wiki. */
export function strongest(map: StarMap, count: number): StarMap {
  if (map.stars.length <= count) return map;
  const keep = new Set(
    [...map.stars]
      .sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title))
      .slice(0, count)
      .map((s) => s.id),
  );
  return {
    stars: map.stars.filter((s) => keep.has(s.id)),
    links: map.links.filter((l) => keep.has(l.from) && keep.has(l.to)),
  };
}

/** Room a still sky keeps at its edges: a name's half width at the sides, a name's height under the lowest star. */
const FIT = { side: 60, top: 28, bottom: 40 };

/**
 * The stars spread over a window of its own shape (a still sky inside a page): no zoom, so every star and name keeps
 * its real size; the layout stretches to the window instead of shrinking a square into it.
 */
export function fitStars(at: Map<string, Point>, width: number, height: number): Map<string, Point> {
  const points = [...at.values()];
  if (points.length === 0) return at;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const w = Math.max(width - FIT.side * 2, 1);
  const h = Math.max(height - FIT.top - FIT.bottom, 1);
  const place = (v: number, lo: number, hi: number, room: number, start: number) =>
    hi - lo < 1 ? start + room / 2 : start + ((v - lo) / (hi - lo)) * room;
  return new Map(
    [...at].map(([id, p]) => [
      id,
      { x: Math.round(place(p.x, x0, x1, w, FIT.side)), y: Math.round(place(p.y, y0, y1, h, FIT.top)) },
    ]),
  );
}

/** A star and what touches it, for the small sky over a page or a memory. */
export function aroundStar(map: StarMap, id: string): StarMap {
  const links = map.links.filter((l) => l.from === id || l.to === id);
  const near = new Set([id, ...links.flatMap((l) => [l.from, l.to])]);
  return { stars: map.stars.filter((s) => near.has(s.id)), links };
}

/** The side of the square a map is laid out in: enough room per star for a label. */
export const worldSide = (stars: number) => Math.round(Math.max(340, 96 * Math.sqrt(stars)));

/** Where each star sits (the web graph's layout, so the same map always lands the same way). */
export function placeStars(map: StarMap): Map<string, Point> {
  const side = worldSide(map.stars.length);
  const margin = 56;
  const placed = layoutGraph({ nodes: map.stars.map((s) => ({ slug: s.id })), edges: map.links }, side, side, 240);
  if (placed.length === 0) return new Map();
  const xs = placed.map((p) => p.x);
  const ys = placed.map((p) => p.y);
  const [x0, y0] = [Math.min(...xs), Math.min(...ys)];
  const sx = (side - margin * 2) / (Math.max(...xs) - x0 || 1);
  const sy = (side - margin * 2) / (Math.max(...ys) - y0 || 1);
  return new Map(
    placed.map((p) => [p.slug, { x: Math.round(margin + (p.x - x0) * sx), y: Math.round(margin + (p.y - y0) * sy) }]),
  );
}

/** Names that fit without covering each other: the selected, the agents, its neighbors, then the most used. */
export function namedStars(map: StarMap, at: Map<string, Point>, selected: string | null): Set<string> {
  const near = new Set(map.links.flatMap((l) => (l.from === selected ? [l.to] : l.to === selected ? [l.from] : [])));
  const rank = (s: Star) => (s.id === selected ? 0 : s.kind === "agent" ? 1 : near.has(s.id) ? 2 : 3);
  const order = [...map.stars].sort((a, b) => rank(a) - rank(b) || b.weight - a.weight);
  const taken: Point[] = [];
  const named = new Set<string>();
  for (const s of order) {
    const p = at.get(s.id);
    if (!p) continue;
    if (taken.some((o) => Math.abs(o.x - p.x) < LABEL_WIDTH && Math.abs(o.y - p.y) < LABEL_HEIGHT)) continue;
    taken.push(p);
    named.add(s.id);
  }
  return named;
}

/** The small squares a line between two stars is drawn with, on a 2-point grid. */
export function pixelsAlong(a: Point, b: Point): Point[] {
  const steps = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 4);
  const out: Point[] = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    out.push({
      x: Math.round((a.x + (b.x - a.x) * t) / 2) * 2,
      y: Math.round((a.y + (b.y - a.y) * t) / 2) * 2,
    });
  }
  return out;
}

/** The selected star's ring: twelve small squares around it. */
export function ringAround(at: Point, radius: number): Point[] {
  return Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2;
    return { x: Math.round(at.x + Math.cos(angle) * radius) - 1, y: Math.round(at.y + Math.sin(angle) * radius) - 1 };
  });
}

/** The zoom and the world's point at the middle that frame every star in a window (never closer than 1:1). */
export function frameStars(at: Map<string, Point>, width: number, height: number) {
  const points = [...at.values()];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const room = 96;
  const zoom = Math.min(1, (width - room) / Math.max(x1 - x0, 1), (height - room) / Math.max(y1 - y0, 1));
  return { zoom, center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } };
}

const STAR_SPRITE: readonly (readonly [number, number])[] = [
  [0, -3],
  [0, -2],
  [0, -1],
  [-3, 0],
  [-2, 0],
  [-1, 0],
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];
const MEMORY_SPRITE: readonly (readonly [number, number])[] = [
  [0, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [0, 1],
];

/** A star's pixels: a page is a four-pointed star, a memory a small diamond. */
export const spriteOf = (kind: StarKind) => (kind === "page" ? STAR_SPRITE : MEMORY_SPRITE);
