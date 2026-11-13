import { type ChartSpec, chartShares, chartTable, formatChartValue } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import {
  areaCells,
  barCells,
  CHART_CELL,
  cellPaths,
  chartAreaTones,
  chartInk,
  chartRamp,
  chartSlices,
  linePoints,
  lineTops,
  ringCells,
  smoothPath,
} from "@agenteschat/ui/sky/chart";
import { Canvas, Circle, Group, Path, Skia } from "@shopify/react-native-skia";
import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { Easing, FadeIn, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, IconButton, PressScale, Text, useReducedMotion, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors } from "../shared/hooks";
import type { Inline } from "./logic";
import { Table } from "./MessageSpans";

/** Charts already drawn once (by their data): a row the list mounts again doesn't grow its chart in twice. */
const drawn = new Set<string>();
const keyOf = (spec: ChartSpec) => JSON.stringify([spec.type, spec.title, spec.labels, spec.series, spec.value]);

/** The chart open in full screen (a route can't carry the data in its URL). */
let opened: { spec: ChartSpec; accent: AgentColorName } | null = null;

const EASE = Easing.out(Easing.cubic);

/**
 * A chart in a message: clean shapes (rounded bars, a smooth
 * line, a round ring) with a fine dither inside in the agent's tones, drawn on Skia from the same cells as
 * the web (`@agenteschat/ui/sky/chart`). Tap a bar, a point or a slice for its value; "Tabela" flips the card
 * to the same data as a table; full screen is a native form sheet with the chart big and its table under it.
 */
export const ChartCard = memo(function ChartCard({
  spec,
  accent = "sky",
}: {
  spec: ChartSpec;
  accent?: AgentColorName;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [table, setTable] = useState(false);
  const [still] = useState(() => {
    const key = keyOf(spec);
    const seen = drawn.has(key);
    drawn.add(key);
    return seen;
  });
  return (
    <View style={[styles.card, { backgroundColor: c.sunken, borderColor: c.line }]}>
      <View style={styles.top}>
        <View style={styles.titles}>
          <Text variant="label" tone="ink">
            {spec.title}
          </Text>
          {spec.subtitle ? (
            <Text variant="caption" tone="faint">
              {spec.subtitle}
            </Text>
          ) : null}
        </View>
        <PressScale
          to={0.92}
          onPress={() => setTable((v) => !v)}
          accessibilityRole="switch"
          accessibilityState={{ checked: table }}
          // 30 tall in the card's head: the slop gives it the 44-point target, only up and down so it doesn't reach
          // into the full-screen button beside it.
          hitSlop={{ top: 7, bottom: 7 }}
          style={[styles.pill, table ? { backgroundColor: c.plate } : null]}
          contentStyle={styles.center}
        >
          <Text variant="label" tone={table ? "ink" : "muted"}>
            {t("mobile.chart.table")}
          </Text>
        </PressScale>
        <PressScale
          to={0.88}
          onPress={() => {
            opened = { spec, accent };
            router.push("/chart");
          }}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.code.fullScreen")}
          hitSlop={7}
          style={styles.tool}
          contentStyle={styles.center}
        >
          <Icon name="expand" size={18} color={c.muted} />
        </PressScale>
      </View>
      <View style={styles.body}>
        {table ? <ChartTable spec={spec} /> : <ChartView spec={spec} accent={accent} still={still} />}
      </View>
    </View>
  );
});

/** The full screen chart (`/chart`, a native form sheet): the chart big, its table under it. */
export function ChartSheet() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const chart = opened;
  if (!chart) {
    return (
      <View style={[styles.sheet, styles.gone]}>
        <Text variant="body" tone="muted">
          {t("mobile.chart.gone")}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.sheet}>
      <View style={styles.sheetTop}>
        <IconButton icon="x" plate label={t("mobile.common.close")} onPress={() => router.back()} />
      </View>
      {/* The title on a row of its own under the bar, the sheet's whole width: never cut beside its buttons. */}
      <Text variant="title" style={styles.sheetTitle}>
        {chart.spec.title}
      </Text>
      <ScrollView contentContainerStyle={[styles.sheetBody, { paddingBottom: 24 + insets.bottom }]}>
        {chart.spec.subtitle ? (
          <Text variant="footnote" tone="faint">
            {chart.spec.subtitle}
          </Text>
        ) : null}
        <ChartView spec={chart.spec} accent={chart.accent} big />
        <ChartTable spec={chart.spec} />
      </ScrollView>
    </View>
  );
}

/** The chart itself, with no card around it: a message's chart card, and a chart inside a live block (ADR 0113). */
export function ChartView({
  spec,
  accent,
  big = false,
  still = false,
}: {
  spec: ChartSpec;
  accent: AgentColorName;
  big?: boolean;
  /** Drawn at once, without growing in (already seen). */
  still?: boolean;
}) {
  switch (spec.type) {
    case "bar":
      return <Bars spec={spec} accent={accent} big={big} still={still} />;
    case "line":
      return <Line spec={spec} accent={accent} big={big} still={still} />;
    case "pie":
      return <Pie spec={spec} accent={accent} big={big} />;
    default:
      return <BigNumber spec={spec} accent={accent} big={big} still={still} />;
  }
}

function ChartTable({ spec }: { spec: ChartSpec }) {
  const c = useColors();
  const { t, i18n } = useTranslation();
  const { header, rows } = chartTable(spec, i18n.language, {
    item: t("mobile.chart.item"),
    share: t("mobile.chart.share"),
  });
  const cell = (text: string): Inline[] => [{ kind: "text", text }];
  return (
    <Table
      header={header.map(cell)}
      rows={rows.map((r) => r.map(cell))}
      align={header.map((_, j) => (j ? "right" : "left"))}
      surface={c.sunken}
    />
  );
}

/* ---------- pieces ---------- */

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(Math.round(e.nativeEvent.layout.width))];
}

/** Cells drawn as one Skia path per tone. */
function Cells({ paths, tone }: { paths: Map<number, string>; tone: (v: number) => string | undefined }) {
  const drawn = useMemo(
    () =>
      [...paths].flatMap(([v, d]) => {
        const path = Skia.Path.MakeFromSVGString(d);
        const color = tone(v);
        return path && color ? [{ v, path, color }] : [];
      }),
    [paths, tone],
  );
  return (
    <>
      {drawn.map((p) => (
        <Path key={p.v} path={p.path} color={p.color} />
      ))}
    </>
  );
}

/** What was tapped, under the chart ("first_trip_soft · 15%"). */
function Picked({ text }: { text: string | null }) {
  const reduced = useReducedMotion();
  // Each pick's words fade in over the last one's place.
  return (
    <Animated.View key={text ?? ""} entering={reduced || !text ? undefined : FadeIn.duration(160)}>
      <Text variant="footnote" tone="muted" style={styles.picked} numberOfLines={1}>
        {text ?? " "}
      </Text>
    </Animated.View>
  );
}

/* ---------- bars ---------- */

function Bars({ spec, accent, big, still }: { spec: ChartSpec; accent: AgentColorName; big: boolean; still: boolean }) {
  const { i18n } = useTranslation();
  const values = spec.series[0]?.values ?? [];
  const max = Math.max(0, ...values) || 1;
  const [rail, onRail] = useWidth();
  const [picked, setPicked] = useState<number | null>(null);
  const height = big ? 20 : 14;
  return (
    <View style={styles.bars}>
      {spec.labels.map((label, i) => {
        const value = values[i] ?? 0;
        return (
          <Pressable
            // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one chart, in order
            key={i}
            onPress={() => setPicked((p) => (p === i ? null : i))}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${formatChartValue(value, spec.unit, i18n.language)}`}
            style={({ pressed }) => [
              styles.barRow,
              picked !== null && picked !== i ? styles.dim : null,
              pressed && styles.pressed,
            ]}
          >
            <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.barLabel}>
              {label}
            </Text>
            <View style={[styles.rail, { height }]} onLayout={i === 0 ? onRail : undefined}>
              <Bar
                width={rail * (Math.max(0, value) / max)}
                height={height}
                accent={accent}
                lead={value === max}
                still={still}
              />
            </View>
            <Text variant="footnote" tone="ink" style={styles.barValue}>
              {formatChartValue(value, spec.unit, i18n.language)}
            </Text>
          </Pressable>
        );
      })}
      <Picked
        text={
          picked === null
            ? null
            : `${spec.labels[picked]} · ${formatChartValue(values[picked] ?? 0, spec.unit, i18n.language)}`
        }
      />
    </View>
  );
}

function Bar({
  width,
  height,
  accent,
  lead,
  still,
}: {
  width: number;
  height: number;
  accent: AgentColorName;
  lead: boolean;
  still: boolean;
}) {
  const c = useColors();
  const reduced = useReducedMotion() || still;
  const grown = useSharedValue(reduced ? width : 0);
  useEffect(() => {
    grown.value = reduced ? width : withTiming(width, { duration: 600, easing: EASE });
  }, [width, reduced, grown]);
  const style = useAnimatedStyle(() => ({ width: grown.value }));
  const cols = Math.max(1, Math.round(width / CHART_CELL));
  const rows = Math.max(1, Math.round(height / CHART_CELL));
  const ramp = useMemo(() => chartRamp(accent), [accent]);
  const paths = useMemo(() => cellPaths(barCells(cols, rows, lead), cols, rows), [cols, rows, lead]);
  const tone = useMemo(() => (v: number) => ramp[v], [ramp]);
  return (
    <View style={[StyleSheet.absoluteFill, styles.railTrack, { backgroundColor: c.plate }]}>
      <Animated.View style={[styles.fill, style]}>
        {width > 0 ? (
          <Canvas style={{ width, height }}>
            <Cells paths={paths} tone={tone} />
          </Canvas>
        ) : null}
      </Animated.View>
    </View>
  );
}

/* ---------- line ---------- */

/** The line and its dithered area; `spark` draws it bare (no points, no labels), as a widget's trend (ADR 0135). */
export function Line({
  spec,
  accent,
  big,
  spark = false,
  height,
  still = false,
}: {
  spec: ChartSpec;
  accent: AgentColorName;
  big: boolean;
  spark?: boolean;
  height?: number;
  still?: boolean;
}) {
  const { i18n } = useTranslation();
  const { scheme } = useTheme();
  const c = useColors();
  const dark = scheme === "dark";
  const reduced = useReducedMotion() || still;
  const [width, onLayout] = useWidth();
  const h = height ?? (big ? 240 : 150);
  const values = spec.series[0]?.values ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const points = useMemo(
    () => (width > 10 && values.length > 1 ? linePoints(values, width, h) : []),
    [width, h, values],
  );
  const stroke = useMemo(() => (points.length ? Skia.Path.MakeFromSVGString(smoothPath(points)) : null), [points]);
  const area = useMemo(() => {
    const cols = Math.round(width / CHART_CELL);
    const rows = Math.round(h / CHART_CELL);
    return points.length
      ? cellPaths(areaCells(cols, rows, lineTops(points, cols)), cols, rows, CHART_CELL, true)
      : new Map();
  }, [points, width, h]);
  const [near, far] = chartAreaTones(accent, dark);
  const tone = useMemo(() => (v: number) => (v === 1 ? near : far), [near, far]);
  const ink = chartInk(accent, dark);
  const drawn = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!stroke) return;
    drawn.value = reduced ? 1 : withTiming(1, { duration: 700, easing: EASE });
  }, [stroke, reduced, drawn]);
  const peak = values.indexOf(Math.max(...values));
  const pick = (x: number) => {
    let i = 0;
    points.forEach((p, j) => {
      if (Math.abs(p[0] - x) < Math.abs((points[i]?.[0] ?? 0) - x)) i = j;
    });
    setPicked((p) => (p === i ? null : i));
  };
  return (
    <View>
      <Pressable
        onLayout={onLayout}
        onPress={spark ? undefined : (e) => pick(e.nativeEvent.locationX)}
        style={{ height: h }}
      >
        {width > 0 && stroke ? (
          <Canvas style={{ width, height: h }}>
            <Cells paths={area} tone={tone} />
            <Path path={stroke} color={ink} style="stroke" strokeWidth={big ? 3 : 2.4} strokeCap="round" end={drawn} />
            {!spark &&
              points.map(([x, y], i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the points, in order
                <Group key={i}>
                  <Circle cx={x} cy={y} r={i === peak || i === picked ? 4.5 : 3} color={i === peak ? ink : c.sunken} />
                  <Circle
                    cx={x}
                    cy={y}
                    r={i === peak || i === picked ? 4.5 : 3}
                    color={ink}
                    style="stroke"
                    strokeWidth={2}
                  />
                </Group>
              ))}
          </Canvas>
        ) : null}
      </Pressable>
      {!spark ? (
        <>
          <View style={styles.xLabels}>
            {spec.labels.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the labels, in order
              <Text key={i} variant="caption" tone="faint">
                {l}
              </Text>
            ))}
          </View>
          <Picked
            text={
              picked === null
                ? null
                : `${spec.labels[picked]} · ${formatChartValue(values[picked] ?? 0, spec.unit, i18n.language)}`
            }
          />
        </>
      ) : null}
    </View>
  );
}

/* ---------- pie ---------- */

function Pie({ spec, accent, big }: { spec: ChartSpec; accent: AgentColorName; big: boolean }) {
  const { i18n } = useTranslation();
  const { scheme } = useTheme();
  const size = big ? 200 : 128;
  const shares = useMemo(() => chartShares(spec), [spec]);
  const slices = useMemo(() => chartSlices(accent, scheme === "dark"), [accent, scheme]);
  const values = spec.series[0]?.values ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  const [picked, setPicked] = useState<number | null>(null);
  const cells = Math.round(size / CHART_CELL);
  const paths = useMemo(() => cellPaths(ringCells(cells, shares), cells, cells), [cells, shares]);
  const tone = useMemo(() => (v: number) => slices[v % slices.length], [slices]);
  // The ring's clean edges as the clip: the outer circle clockwise, the inner one the other way (a hole).
  const ring = useMemo(() => {
    const c = size / 2;
    const r = c * 0.575;
    return Skia.Path.MakeFromSVGString(
      `M0,${c} a${c},${c} 0 1,1 ${2 * c},0 a${c},${c} 0 1,1 ${-2 * c},0 Z` +
        `M${c - r},${c} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 Z`,
    );
  }, [size]);
  return (
    <View>
      <View style={styles.pie}>
        <View style={{ width: size, height: size }}>
          <Canvas style={{ width: size, height: size }}>
            {ring ? (
              <Group clip={ring}>
                <Cells paths={paths} tone={tone} />
              </Group>
            ) : (
              <Cells paths={paths} tone={tone} />
            )}
          </Canvas>
          <View style={[StyleSheet.absoluteFill, styles.pieCenter]} pointerEvents="none">
            <Text variant="title" tone="ink" style={styles.num}>
              {formatChartValue(total, spec.unit, i18n.language)}
            </Text>
            <Text variant="caption" tone="faint">
              {spec.series[0]?.name}
            </Text>
          </View>
        </View>
        <View style={styles.legend}>
          {spec.labels.map((label, i) => (
            <Pressable
              // biome-ignore lint/suspicious/noArrayIndexKey: the slices, in order
              key={i}
              onPress={() => setPicked((p) => (p === i ? null : i))}
              style={({ pressed }) => [
                styles.legendRow,
                picked !== null && picked !== i ? styles.dim : null,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.swatch, { backgroundColor: slices[i % slices.length] }]} />
              <Text variant="footnote" tone="ink2" numberOfLines={1} style={styles.flex}>
                {label}
              </Text>
              <Text variant="footnote" tone="ink" style={styles.num}>
                {formatChartValue(Math.round((shares[i] ?? 0) * 100), "%", i18n.language)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Picked
        text={
          picked === null
            ? null
            : `${spec.labels[picked]} · ${formatChartValue(values[picked] ?? 0, spec.unit, i18n.language)}`
        }
      />
    </View>
  );
}

/* ---------- number ---------- */

function BigNumber({
  spec,
  accent,
  big,
  still,
}: {
  spec: ChartSpec;
  accent: AgentColorName;
  big: boolean;
  still: boolean;
}) {
  const { i18n } = useTranslation();
  const c = useColors();
  const hasLine = spec.labels.length > 1 && (spec.series[0]?.values.length ?? 0) > 1;
  return (
    <View style={styles.number}>
      <View>
        <Text style={[styles.numValue, { color: c.ink, fontSize: big ? 64 : 40, lineHeight: big ? 68 : 44 }]}>
          {formatChartValue(spec.value ?? 0, spec.unit, i18n.language)}
        </Text>
        {spec.delta ? (
          <Text variant="label" style={{ color: c.ok }}>
            {spec.delta}
          </Text>
        ) : null}
      </View>
      {hasLine ? (
        <View style={styles.flex}>
          <Line spec={spec} accent={accent} big={big} spark height={big ? 100 : 52} still={still} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 4, paddingLeft: 14, paddingRight: 4, paddingTop: 10 },
  titles: { flex: 1, gap: 2, paddingTop: 4 },
  pill: { minHeight: 30, paddingHorizontal: 10, borderRadius: 15 },
  tool: { height: 30, width: 32, borderRadius: 15 },
  center: { alignItems: "center", justifyContent: "center" },
  body: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 12 },
  bars: { gap: 8 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  dim: { opacity: 0.5 },
  pressed: { opacity: 0.6 },
  barLabel: { width: "34%" },
  rail: { flex: 1 },
  railTrack: { borderRadius: 6, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 6, overflow: "hidden" },
  barValue: { minWidth: 44, textAlign: "right", fontWeight: "600", fontVariant: ["tabular-nums"] },
  xLabels: { flexDirection: "row", justifyContent: "space-between", paddingTop: 6, paddingHorizontal: 2 },
  picked: { paddingTop: 8, fontVariant: ["tabular-nums"] },
  pie: { flexDirection: "row", alignItems: "center", gap: 16 },
  pieCenter: { alignItems: "center", justifyContent: "center" },
  legend: { flex: 1, gap: 6 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  swatch: { width: 9, height: 9, borderRadius: 2 },
  num: { fontVariant: ["tabular-nums"] },
  flex: { flex: 1 },
  number: { flexDirection: "row", alignItems: "flex-end", gap: 14 },
  numValue: { fontWeight: "700", letterSpacing: -0.5, fontVariant: ["tabular-nums"] },
  sheet: { flex: 1, paddingTop: 14 },
  gone: { alignItems: "center", justifyContent: "center", padding: 24 },
  sheetTop: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 },
  sheetTitle: { paddingHorizontal: 16, paddingTop: 8 },
  sheetBody: { paddingHorizontal: 16, paddingTop: 14, gap: 20 },
});
