import { useWikiGraph } from "@agenteschat/client";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Filters, Icon, Text } from "@/ui";
import { Constellation } from "../constellation/Constellation";
import { linkCount, mostLinked, pagesMap, type StarMap } from "../constellation/logic";
import { useOrgId } from "../shared/hooks";
import { PushedHeader } from "../shared/parts";
import { openWikiPage } from "./WikiScreen";

/** The night stays in both themes behind the stars (the constellation's own). */
const NIGHT = "#070b14";

type MapFilter = "all" | "agent" | `folder:${string}`;

/** The stars a filter keeps, and only the links between them (as the web's graph filters). */
export function filterMap(map: StarMap, filter: MapFilter): StarMap {
  if (filter === "all") return map;
  const keep = new Set(
    map.stars
      .filter((s) =>
        filter === "agent" ? Boolean(s.agentId) : (s.folder ?? "").split("/")[0] === filter.slice("folder:".length),
      )
      .map((s) => s.id),
  );
  return {
    stars: map.stars.filter((s) => keep.has(s.id)),
    links: map.links.filter((l) => keep.has(l.from) && keep.has(l.to)),
  };
}

/**
 * The wiki's whole graph, as the web's "Grafo": every page a star (the most linked bigger, an agent's page in its
 * color), every [[link]] a line, filtered by who wrote them or the top folder. The sky fills the screen under the
 * bar: drag and pinch to explore, a tap lights a page's links and brings it to the middle, the line at the bottom
 * opens it.
 */
export function WikiMapScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const graph = useWikiGraph(orgId, true);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [filter, setFilter] = useState<MapFilter>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const full = useMemo(() => (graph.data ? pagesMap(graph.data) : null), [graph.data]);
  const map = useMemo(() => (full ? filterMap(full, filter) : null), [full, filter]);
  const heart = map ? mostLinked(map) : null;
  const star = map?.stars.find((s) => s.id === picked) ?? map?.stars.find((s) => s.id === heart);
  const folders = useMemo(
    () => [...new Set((full?.stars ?? []).map((s) => (s.folder ?? "").split("/")[0] ?? ""))].filter(Boolean).sort(),
    [full],
  );
  const items = [
    { key: "all", label: t("wiki.allPages") },
    ...(full?.stars.some((s) => s.agentId) ? [{ key: "agent", label: t("wiki.graphAgents") }] : []),
    ...folders.map((f) => ({ key: `folder:${f}`, label: f })),
  ];
  return (
    <View style={styles.fill}>
      {map && map.stars.length > 0 ? (
        <Constellation
          map={map}
          selected={star?.id ?? null}
          height={height}
          onSelect={(id) => (id === star?.id ? openWikiPage(id) : setPicked(id))}
        />
      ) : null}
      <PushedHeader title={t("wiki.graph")} solid={false} />
      {items.length > 1 ? (
        <View style={[styles.filters, { top: insets.top + 52 }]}>
          <Filters
            items={items}
            value={filter}
            onChange={(key) => {
              setFilter(key as MapFilter);
              setPicked(null);
            }}
          />
        </View>
      ) : null}
      {graph.isLoading ? <ActivityIndicator color="#ffffff" style={styles.center} /> : null}
      {graph.isError && !graph.data ? (
        <View style={styles.center}>
          <Text variant="subhead" style={styles.dim}>
            {t("common.loadFailed")}
          </Text>
          <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void graph.refetch()} />
        </View>
      ) : null}
      {map && map.stars.length === 0 ? (
        <View style={styles.center}>
          <Text variant="subhead" style={styles.dim}>
            {t("wiki.noMatch")}
          </Text>
        </View>
      ) : null}
      {star && map ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint={t("mobile.constellation.openHint")}
          onPress={() => openWikiPage(star.id)}
          style={({ pressed }) => [styles.foot, { paddingBottom: insets.bottom + 12 }, pressed && styles.pressed]}
        >
          <View style={styles.footText}>
            <Text variant="body" style={styles.footTitle} numberOfLines={1}>
              {star.title}
            </Text>
            <Text variant="footnote" style={styles.footSub} numberOfLines={1}>
              {[star.folder, t("mobile.wiki.links", { count: linkCount(map, star.id) })].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Icon name="right" size={16} color="rgba(255,255,255,0.55)" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: NIGHT },
  filters: { position: "absolute", left: 0, right: 0 },
  center: { position: "absolute", left: 16, right: 16, top: "45%", alignItems: "center", gap: 12 },
  dim: { color: "rgba(255,255,255,0.72)", textAlign: "center" },
  foot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: "rgba(7,11,20,0.86)",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.14)",
  },
  footText: { flex: 1, minWidth: 0, gap: 2 },
  footTitle: { color: "#ffffff", fontWeight: "600" },
  footSub: { color: "rgba(255,255,255,0.66)" },
  pressed: { opacity: 0.8 },
});
