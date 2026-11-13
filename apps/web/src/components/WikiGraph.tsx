import type { WikiGraph } from "@agenteschat/client";
import { useWikiGraph } from "@agenteschat/client";
import { layoutGraph, type Placed } from "@agenteschat/client/lib/wiki";
import { appearanceStyle, PageHeader, Segmented } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lookOf } from "@/lib/look";

export { layoutGraph, type Placed };

const GRAPH_H = 560;

/**
 * The full graph's drawing width for a box of `width` x `height` px: the
 * viewBox takes the box's shape, so the drawing fills it instead of sitting
 * letterboxed in a wide window, and the layout spreads into the extra width.
 */
export function graphWidth(width: number, height: number) {
  if (!(width > 0 && height > 0)) return 960;
  return Math.round(Math.min(4, Math.max(1, width / height)) * GRAPH_H);
}

/** Pages linked to `slug` (both directions). */
export const neighborsOf = (graph: WikiGraph, slug: string) =>
  new Set(graph.edges.flatMap((e) => (e.from === slug ? [e.to] : e.to === slug ? [e.from] : [])));

type Filter = "all" | "agent" | "obsidian" | `folder:${string}`;

/**
 * "Grafo": pages and their links; hover lights the neighbors, click opens;
 * filter by who wrote them (agents), where they came from (Obsidian) or the
 * top folder. `mini`: the home's preview (no filters, no labels, not interactive).
 */
export function WikiGraphView({ onOpen, mini = false }: { onOpen?: () => void; mini?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const graph = useWikiGraph(org.id, true);
  const [hover, setHover] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const data = graph.data;
  const filtered = useMemo<WikiGraph | null>(() => {
    if (!data) return null;
    if (filter === "all") return data;
    const keep = new Set(
      data.nodes
        .filter((n) =>
          filter === "agent"
            ? Boolean(n.agentId)
            : filter === "obsidian"
              ? n.sourceType === "obsidian"
              : (n.folder.split("/")[0] || "") === filter.slice("folder:".length),
        )
        .map((n) => n.slug),
    );
    return {
      nodes: data.nodes.filter((n) => keep.has(n.slug)),
      edges: data.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  }, [data, filter]);
  const [el, setEl] = useState<SVGSVGElement | null>(null);
  const [fullW, setFullW] = useState(960);
  useEffect(() => {
    if (mini || !el || typeof ResizeObserver === "undefined") return;
    const measure = () => setFullW(graphWidth(el.clientWidth, el.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mini, el]);
  const W = mini ? 520 : fullW;
  const H = mini ? 200 : GRAPH_H;
  const placed = useMemo(() => (filtered ? layoutGraph(filtered, W, H) : []), [filtered, W, H]);
  if (graph.isLoading) return mini ? null : <LoadingCards count={2} />;
  if (!data || !filtered) return mini ? null : <ErrorState error={graph.error} onRetry={() => void graph.refetch()} />;
  const at = new Map(placed.map((p) => [p.slug, p]));
  const near = hover ? neighborsOf(filtered, hover) : null;
  const degree = new Map<string, number>();
  for (const e of filtered.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const folders = [...new Set(data.nodes.map((n) => n.folder.split("/")[0] || ""))].filter(Boolean).sort();
  const hasObsidian = data.nodes.some((n) => n.sourceType === "obsidian");
  const hasAgents = data.nodes.some((n) => n.agentId);
  const open = (slug: string) => {
    onOpen?.();
    void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug } });
  };
  const svg = (
    <svg
      ref={setEl}
      className="wiki-graph__svg"
      viewBox={`0 0 ${W} ${H}`}
      role={mini ? "presentation" : "img"}
      aria-label={mini ? undefined : t("wiki.graphLabel", { count: filtered.nodes.length })}
      aria-hidden={mini || undefined}
    >
      <g className="wiki-graph__edges">
        {filtered.edges.map((e) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          if (!a || !b) return null;
          const lit = hover !== null && (e.from === hover || e.to === hover);
          return (
            <line
              key={`${e.from}>${e.to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              data-lit={lit || undefined}
              data-dim={(hover !== null && !lit) || undefined}
            />
          );
        })}
      </g>
      {filtered.nodes.map((node) => {
        const p = at.get(node.slug);
        if (!p) return null;
        const lit = hover === node.slug || near?.has(node.slug);
        const agent = node.agentId ? dir.agentById.get(node.agentId) : undefined;
        const r = 5 + Math.sqrt(degree.get(node.slug) ?? 0) * 2.4;
        const kind = node.sourceType === "obsidian" ? "obsidian" : agent ? "agent" : "person";
        const showLabel = !mini && ((degree.get(node.slug) ?? 0) >= 2 || lit || filtered.nodes.length <= 16);
        if (mini) {
          return (
            <circle
              key={node.slug}
              className="wiki-graph__dot"
              data-kind={kind}
              cx={p.x}
              cy={p.y}
              r={r * 0.8}
              style={agent ? appearanceStyle(lookOf(agent)) : undefined}
            />
          );
        }
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG node acting as a link
          <g
            key={node.slug}
            className="wiki-graph__node"
            data-kind={kind}
            data-lit={lit || undefined}
            data-dim={(hover !== null && !lit) || undefined}
            data-agent={agent ? "" : undefined}
            style={agent ? appearanceStyle(lookOf(agent)) : undefined}
            transform={`translate(${p.x} ${p.y})`}
            role="link"
            tabIndex={0}
            aria-label={node.title}
            onPointerEnter={() => setHover(node.slug)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(node.slug)}
            onBlur={() => setHover(null)}
            onClick={() => open(node.slug)}
            onKeyDown={(e) => {
              if (e.key === "Enter") open(node.slug);
            }}
          >
            <circle r={r} />
            {showLabel && (
              <text y={r + 14} textAnchor="middle">
                {node.title}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
  if (mini) return svg;
  const chips: [Filter, string][] = [
    ["all", t("wiki.allPages")],
    ...(hasAgents ? ([["agent", t("wiki.graphAgents")]] as [Filter, string][]) : []),
    ...(hasObsidian ? ([["obsidian", t("wiki.fromObsidian")]] as [Filter, string][]) : []),
    ...folders.map((f) => [`folder:${f}`, f] as [Filter, string]),
  ];
  return (
    <section className="wiki-graph" aria-label={t("wiki.graph")}>
      <PageHeader title={t("wiki.graph")} meta={t("wiki.graphText")} />
      <div className="wiki-graph__box">
        <Segmented
          size="sm"
          className="wiki-graph__filter"
          label={t("wiki.graphFilter")}
          value={filter}
          onValueChange={setFilter}
          options={chips.map(([value, label]) => ({ value, label }))}
        />
        {svg}
        <p className="wiki-graph__legend" aria-hidden="true">
          <span data-kind="person">{t("wiki.legend.people")}</span>
          {hasAgents && <span data-kind="agent">{t("wiki.legend.agents")}</span>}
          {hasObsidian && <span data-kind="obsidian">{t("wiki.legend.obsidian")}</span>}
        </p>
      </div>
    </section>
  );
}
