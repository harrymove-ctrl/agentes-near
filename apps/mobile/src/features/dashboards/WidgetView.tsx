import type {
  BarsWidgetSpec,
  GoalWidgetSpec,
  KpiWidgetSpec,
  LineWidgetSpec,
  ListWidgetSpec,
  TextWidgetSpec,
  WidgetKind,
  WidgetSchedule,
  WidgetSpec,
  WidgetStatus,
} from "@agenteschat/client";
import type { ChartSpec } from "@agenteschat/client/lib/chart";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import {
  areaCells,
  CHART_CELL,
  cellPaths,
  chartAreaTones,
  chartInk,
  lineTops,
  smoothPath,
} from "@agenteschat/ui/sky/chart";
import { Canvas, Path, Rect, Skia } from "@shopify/react-native-skia";
import { type ComponentRef, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { CardHorizon, CHROME_MAX_SCALE, Icon, PixelOrbit, PressScale, Text, useReducedMotion, useTheme } from "@/ui";
import { Line } from "../chat/ChartCard";
import { AgentFace } from "../shared/Face";
import { useSurface } from "../shared/parts";
import { DitherShape } from "./Dither";
import { useAgentLook, useWidgetWords } from "./hooks";
import {
  barValueText,
  barWords,
  bleedPoints,
  bleedSeries,
  formatWidgetNumber,
  goalShare,
  isTall,
  roundRectPath,
  shownWidgetTitle,
  softCardColor,
  topRoundedPath,
  widgetTones,
} from "./logic";

/**
 * The phone's widget (ADR 0135): a block an agent keeps up to date, drawn from its spec like the web's. Numbers in
 * the app's sans at weight 700 with tabular figures; charts as the chat draws them (a clean stroke in the agent's
 * deep tone over a dither in its light one: the line is the chat's own); bars and a goal's fill as outlined shapes
 * filled with the same 2-point Bayer dither. A chart's unit is one small tag above it (each bar reads only its
 * number); a note is a muted caption under a hairline. A number's trend (and a bare line on a board) runs edge to
 * edge along the card's bottom. While the agent builds it, a dither sweep; while it updates, the last data stays,
 * dimmed; when it failed, dimmed with the reason under it.
 */

/** The card's padding: the edge-to-edge chart cancels it. */
const PAD_X = 18;
const PAD_Y = 16;

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(Math.round(e.nativeEvent.layout.width))];
}

/** A series as the chat's chart spec, for its line. */
const lineSpec = (labels: string[], values: number[], unit?: string): ChartSpec => ({
  type: "line",
  title: "",
  labels,
  series: [{ name: "", values }],
  ...(unit ? { unit } : {}),
});

/** A card on the home's strip: its height, the same for every widget there. */
export const COMPACT_HEIGHT = 152;
/** The rows a list shows on the home's strip. */
const COMPACT_ROWS = 3;
/** A strip card is short: a number and its line leave less room than a board's card, and that room still earns it. */
const COMPACT_HORIZON_ROOM = 56;

/** What a widget shows: its data by kind, the building sweep, or a quiet line when it has nothing yet. */
export const WidgetBody = memo(function WidgetBody({
  spec,
  status,
  agentId,
  big = false,
  bleed = false,
  compact = false,
  onLayout,
}: {
  spec: WidgetSpec | null;
  status: WidgetStatus;
  agentId: string;
  /** The widget's own screen and the previews: bigger numbers and charts. */
  big?: boolean;
  /** The card draws the trend (or the bare line) along its bottom (`bleedSeries`): not here. */
  bleed?: boolean;
  /** The home's strip: a smaller number, one line of note, the first rows only. */
  compact?: boolean;
  /** Where the data ends: the card measures the room left under it (its horizon). */
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const look = useAgentLook(agentId);
  if (!spec) {
    if (status === "failed")
      return (
        <Text variant="footnote" tone="faint">
          {t("widgets.status.failed")}
        </Text>
      );
    return <BuildingSweep color={look.color} text={t("widgets.status.building", { name: look.name })} />;
  }
  if (status === "building") {
    return <BuildingSweep color={look.color} text={t("widgets.status.building", { name: look.name })} />;
  }
  // On a board the data dims while it updates or failed; the home's strip says so on its title line instead.
  const dim = compact ? 1 : status === "updating" ? 0.45 : status === "failed" ? 0.5 : 1;
  return (
    // On the strip the columns take the card's room; anything else ends where its data does.
    <View onLayout={onLayout} style={[{ opacity: dim }, compact && spec.kind === "bars" && styles.fill]}>
      <SpecBody spec={spec} color={look.color} big={big} bleed={bleed} compact={compact} />
    </View>
  );
});

function SpecBody({
  spec,
  color,
  big,
  bleed,
  compact,
}: {
  spec: WidgetSpec;
  color: AgentColorName;
  big: boolean;
  bleed: boolean;
  compact: boolean;
}) {
  switch (spec.kind) {
    case "kpi":
      return <Kpi spec={spec} color={color} big={big} bleed={bleed} compact={compact} />;
    case "goal":
      return <Goal spec={spec} color={color} big={big} />;
    case "bars":
      return compact ? <CompactBars spec={spec} color={color} /> : <Bars spec={spec} color={color} big={big} />;
    case "line":
      return <LineBody spec={spec} color={color} big={big} bleed={bleed} />;
    case "list":
      return <List spec={spec} compact={compact} />;
    case "text":
      return <Summary spec={spec} color={color} compact={compact} />;
  }
}

/** The big number: what comes before and after it smaller, how it moved, its trend. */
function Kpi({
  spec,
  color,
  big,
  bleed,
  compact = false,
}: {
  spec: KpiWidgetSpec;
  color: AgentColorName;
  big: boolean;
  bleed: boolean;
  compact?: boolean;
}) {
  const { i18n } = useTranslation();
  const { colors: c } = useTheme();
  const spark = spec.spark ?? [];
  const trend = useMemo(
    () =>
      !bleed && spark.length > 1
        ? lineSpec(
            spark.map((_, i) => String(i)),
            spark,
          )
        : null,
    [spark, bleed],
  );
  return (
    <View>
      <Text
        variant="display"
        numberOfLines={1}
        style={[styles.num, big ? styles.numBig : compact ? styles.numCompact : null, { color: c.ink }]}
      >
        {spec.prefix ? <Text style={[styles.affix, { color: c.muted }]}>{`${spec.prefix} `}</Text> : null}
        {formatWidgetNumber(spec.value, i18n.language)}
        {spec.suffix ? <Text style={[styles.affix, { color: c.muted }]}>{` ${spec.suffix}`}</Text> : null}
      </Text>
      {spec.delta || spec.note ? (
        <Text variant="footnote" tone="ink2" numberOfLines={compact ? 1 : 2}>
          {/* On the strip the change is a quiet word (one accent per screen: the waiting strip's); on a board, its color. */}
          {spec.delta ? (
            <Text
              variant="footnote"
              style={compact ? { color: c.muted } : [styles.strong, { color: spec.delta.up ? c.ok : c.danger }]}
            >
              {spec.delta.text}
            </Text>
          ) : null}
          {spec.delta && spec.note ? " " : null}
          {spec.note ?? null}
        </Text>
      ) : null}
      {trend ? (
        <View style={styles.spark}>
          <Line spec={trend} accent={color} big={false} spark height={big ? 60 : 30} />
        </View>
      ) : null}
    </View>
  );
}

/** Progress towards a goal: the share, a track filled with the dither, the line and the note. */
function Goal({ spec, color, big }: { spec: GoalWidgetSpec; color: AgentColorName; big: boolean }) {
  const { colors: c, scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const height = big ? 16 : 12;
  // Inside the track's 1.5-point border.
  const inner = height - 3;
  const fill = Math.round(Math.max(0, width - 3) * goalShare(spec.pct));
  return (
    <View>
      <Text variant="display" numberOfLines={1} style={[styles.num, big ? styles.numBig : null, { color: c.ink }]}>
        {Math.round(spec.pct)}
        <Text style={[styles.affix, { color: c.muted }]}>%</Text>
      </Text>
      <View onLayout={onLayout} style={[styles.track, { height, borderColor: c.line2 }]}>
        {fill > 3 ? (
          <Canvas style={{ width: fill, height: inner }}>
            <DitherShape
              width={fill}
              height={inner}
              shape={roundRectPath(0.75, 0.75, fill - 1.5, inner - 1.5, 3)}
              fill={tones.fill}
              stroke={tones.stroke}
            />
          </Canvas>
        ) : null}
      </View>
      <Text variant="footnote" tone="ink2" numberOfLines={big ? 3 : 2}>
        {spec.line}
        {spec.note ? (
          <Text variant="footnote" tone="faint">
            {` · ${spec.note}`}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}

/** Columns with their value over them and their label under; the one an alert is about in the warning color. */
function Bars({ spec, color, big }: { spec: BarsWidgetSpec; color: AgentColorName; big: boolean }) {
  const { i18n } = useTranslation();
  const { colors: c, scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const n = spec.values.length;
  const gap = n > 12 ? 3 : 8;
  const slot = n > 0 ? Math.max(0, (width - gap * (n - 1)) / n) : 0;
  const bw = Math.min(44, slot);
  const words = barWords(n, width);
  const height = big ? 140 : 84;
  const room = height - 18;
  const max = Math.max(0, ...spec.values) || 1;
  return (
    <View>
      <UnitTag unit={spec.unit} />
      <View onLayout={onLayout} style={[styles.bars, { height, gap }]}>
        {width > 0
          ? spec.values.map((v, i) => {
              const h = Math.max(4, Math.round((Math.max(0, v) / max) * room));
              const alert = spec.alertIndex === i;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the bars of one widget, in order
                <View key={i} style={styles.bar} accessible accessibilityLabel={`${spec.labels[i] ?? ""}: ${v}`}>
                  {words.values ? (
                    <Text
                      variant="caption"
                      numberOfLines={1}
                      // The short form already fits: this only guards a very large text size.
                      adjustsFontSizeToFit
                      minimumFontScale={0.75}
                      maxFontSizeMultiplier={CHROME_MAX_SCALE}
                      style={[styles.barValue, { color: alert ? c.warn : c.ink2 }]}
                    >
                      {barValueText(v, i18n.language, slot)}
                    </Text>
                  ) : null}
                  {bw > 1 ? (
                    <Canvas style={{ width: bw, height: h }}>
                      <DitherShape
                        width={bw}
                        height={h}
                        shape={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4)}
                        outline={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4, false)}
                        fill={tones.fill}
                        stroke={alert ? c.warn : tones.stroke}
                      />
                    </Canvas>
                  ) : null}
                </View>
              );
            })
          : null}
      </View>
      <View style={[styles.axis, { gap, borderTopColor: c.line2 }]}>
        {spec.labels.map((label, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the labels, in order
          <Text key={i} variant="caption" tone="faint" numberOfLines={1} style={styles.axisLabel}>
            {i % words.every === 0 || i === n - 1 ? label : ""}
          </Text>
        ))}
      </View>
      <Note text={spec.note} />
    </View>
  );
}

/**
 * The home's strip: the columns alone, as tall as the card has room for and standing on the card's bottom edge (the
 * card runs them down to it, as a trend); what they count is a quiet word above them, starting where the title does.
 * Their values and labels are on the widget's screen (the card is one button named by its title).
 */
function CompactBars({ spec, color }: { spec: BarsWidgetSpec; color: AgentColorName }) {
  const { colors: c, scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  const [box, setBox] = useState({ width: 0, height: 0 });
  const n = spec.values.length;
  const gap = n > 8 ? 3 : 6;
  const slot = n > 0 ? Math.max(0, (box.width - gap * (n - 1)) / n) : 0;
  const bw = Math.min(28, slot);
  const room = box.height;
  const max = Math.max(0, ...spec.values) || 1;
  const unit = spec.unit?.trim();
  return (
    <View style={[styles.fill, styles.compactBars]}>
      {unit ? (
        <Text variant="caption" tone="faint" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
          {unit}
        </Text>
      ) : null}
      <View
        onLayout={(e) =>
          setBox({ width: Math.round(e.nativeEvent.layout.width), height: Math.round(e.nativeEvent.layout.height) })
        }
        style={[styles.fill, styles.barsCompact, { gap }]}
      >
        {bw > 1 && room > 4
          ? spec.values.map((v, i) => {
              const h = Math.max(3, Math.round((Math.max(0, v) / max) * room));
              const alert = spec.alertIndex === i;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the bars of one widget, in order
                <Canvas key={i} style={{ width: bw, height: h }}>
                  <DitherShape
                    width={bw}
                    height={h}
                    shape={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4)}
                    outline={topRoundedPath(0.75, 0.75, bw - 1.5, h - 0.75, 4, false)}
                    fill={tones.fill}
                    stroke={alert ? c.warn : tones.stroke}
                  />
                </Canvas>
              );
            })
          : null}
      </View>
    </View>
  );
}

/** The chat's line: bare on a card, with its points and labels (tap one for its value) on the widget's screen. */
function LineBody({
  spec,
  color,
  big,
  bleed,
}: {
  spec: LineWidgetSpec;
  color: AgentColorName;
  big: boolean;
  bleed: boolean;
}) {
  // The unit is the tag above: a tapped point reads only its number.
  const chart = useMemo(() => lineSpec(spec.labels, spec.values), [spec.labels, spec.values]);
  return (
    <View>
      <UnitTag unit={spec.unit} />
      {bleed ? null : <Line spec={chart} accent={color} big={big} spark={!big} height={big ? 160 : 80} />}
      <Note text={spec.note} />
    </View>
  );
}

/** What a chart's values count, once, as a small tag above it ("runs per day"). */
function UnitTag({ unit }: { unit?: string | undefined }) {
  const { colors: c } = useTheme();
  if (!unit?.trim()) return null;
  return (
    <View style={[styles.unit, { backgroundColor: c.plate }]}>
      <Text
        variant="caption"
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={[styles.unitText, { color: c.ink2 }]}
      >
        {unit.trim()}
      </Text>
    </View>
  );
}

/** A chart's note: a muted caption of up to two lines, under a hairline. */
function Note({ text }: { text?: string | undefined }) {
  const { colors: c } = useTheme();
  if (!text) return null;
  return (
    <Text variant="footnote" tone="muted" numberOfLines={2} style={[styles.note, { borderTopColor: c.line2 }]}>
      {text}
    </Text>
  );
}

/**
 * A trend along the card's bottom, edge to edge (the card's rounded corners clip it): the chat's clean stroke in the
 * agent's deep tone over its dither, which fades out toward the bottom edge, and a square on the last point.
 */
function BleedLine({ values, color, height }: { values: number[]; color: AgentColorName; height: number }) {
  const { colors: c, scheme } = useTheme();
  const dark = scheme === "dark";
  const [width, onLayout] = useWidth();
  const points = useMemo(() => (width > 10 ? bleedPoints(values, width, height) : []), [values, width, height]);
  const stroke = useMemo(() => (points.length > 1 ? Skia.Path.MakeFromSVGString(smoothPath(points)) : null), [points]);
  const area = useMemo(() => {
    if (points.length < 2) return [];
    const cols = Math.ceil(width / CHART_CELL);
    const rows = Math.ceil(height / CHART_CELL);
    const cells = cellPaths(areaCells(cols, rows, lineTops(points, cols)), cols, rows, CHART_CELL, true);
    return [...cells].flatMap(([v, d]) => {
      const path = Skia.Path.MakeFromSVGString(d);
      return path ? [{ v, path }] : [];
    });
  }, [points, width, height]);
  const [near, far] = chartAreaTones(color, dark);
  const ink = chartInk(color, dark);
  const last = points[points.length - 1];
  // The square stands out of the line in a ring of the card's own color.
  const ring = softCardColor(c.raised, c.grouped, dark);
  return (
    <View onLayout={onLayout} style={[styles.bleed, { height }]} accessible={false}>
      {width > 0 && stroke ? (
        <Canvas style={{ width, height }}>
          {area.map((p) => (
            <Path key={p.v} path={p.path} color={p.v === 1 ? near : far} />
          ))}
          <Path path={stroke} color={ink} style="stroke" strokeWidth={2.4} strokeCap="round" strokeJoin="round" />
          {last ? (
            <>
              <Rect x={last[0] - 5} y={last[1] - 5} width={10} height={10} color={ring} />
              <Rect x={last[0] - 3.5} y={last[1] - 3.5} width={7} height={7} color={ink} />
            </>
          ) : null}
        </Canvas>
      ) : null}
    </View>
  );
}

/** A few rows with a word each, in the warning or the good color when the agent says so. */
function List({ spec, compact = false }: { spec: ListWidgetSpec; compact?: boolean }) {
  const { colors: c } = useTheme();
  return (
    <View>
      {(compact ? spec.rows.slice(0, COMPACT_ROWS) : spec.rows).map((row, i) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: the rows of one widget, in order
          key={i}
          style={[
            styles.row,
            compact ? styles.rowCompact : null,
            i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 } : null,
          ]}
        >
          <Text variant={compact ? "footnote" : "subhead"} tone="ink" numberOfLines={1} style={styles.grow}>
            {row.text}
          </Text>
          {row.meta ? (
            <Text
              variant="footnote"
              numberOfLines={1}
              style={[
                styles.meta,
                row.tone ? styles.strong : null,
                { color: row.tone === "warn" ? c.warn : row.tone === "ok" ? c.ok : c.faint },
              ]}
            >
              {row.meta}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** A few sentences, each after a small mark in the agent's tone. */
function Summary({ spec, color, compact = false }: { spec: TextWidgetSpec; color: AgentColorName; compact?: boolean }) {
  const { scheme } = useTheme();
  const tones = widgetTones(color, scheme === "dark");
  return (
    <View style={styles.items}>
      {(compact ? spec.items.slice(0, 2) : spec.items).map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the sentences of one widget, in order
        <View key={i} style={styles.item}>
          <View style={[styles.mark, { backgroundColor: tones.stroke }]} />
          <Text
            variant={compact ? "footnote" : "subhead"}
            tone="ink"
            numberOfLines={compact ? 2 : undefined}
            style={styles.grow}
          >
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The first build: a field of the agent's dither with a denser band sweeping across it (still with reduced
 * motion), and what is happening under it.
 */
export function BuildingSweep({ color, text, height = 56 }: { color: AgentColorName; text: string; height?: number }) {
  const { scheme } = useTheme();
  const reduced = useReducedMotion();
  const tones = widgetTones(color, scheme === "dark");
  const [width, onLayout] = useWidth();
  const band = Math.max(24, Math.round(width * 0.4));
  const at = useSharedValue(0);
  useEffect(() => {
    if (reduced || width === 0) return;
    at.value = 0;
    at.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.quad) }), -1, false);
    return () => cancelAnimation(at);
  }, [reduced, width, at]);
  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: -band + at.value * (width + band) }] }));
  const box = roundRectPath(0, 0, width, height, 6);
  return (
    <View style={styles.building} accessibilityRole="progressbar" accessibilityLabel={text}>
      <View onLayout={onLayout} style={[styles.field, { height }]}>
        {width > 0 ? (
          <>
            <Canvas style={StyleSheet.absoluteFill}>
              <DitherShape width={width} height={height} shape={box} fill={tones.fill} density={0.16} />
            </Canvas>
            <Animated.View
              style={[styles.band, { width: band, left: reduced ? (width - band) / 2 : 0 }, reduced ? null : sweep]}
            >
              <Canvas style={StyleSheet.absoluteFill}>
                <DitherShape
                  width={band}
                  height={height}
                  shape={roundRectPath(0, 0, band, height, 0)}
                  fill={tones.fill}
                  density={0.6}
                />
              </Canvas>
            </Animated.View>
          </>
        ) : null}
      </View>
      <Text variant="footnote" tone="muted" numberOfLines={3}>
        {text}
      </Text>
    </View>
  );
}

export interface WidgetCardData {
  /** Empty while the agent hasn't named it yet: the card says the kind's word or "New widget". */
  title: string;
  /** What it shows, when known (the word a widget without a title shows). */
  kind?: WidgetKind | null;
  spec: WidgetSpec | null;
  status: WidgetStatus;
  agentId: string;
  refreshedAt: string | null;
  schedule: WidgetSchedule;
  /** Its width on the board: 2 takes the whole row on the phone. */
  w: 1 | 2;
  /** Its height on the board: 2 (L) stands taller on the phone. */
  h?: 1 | 2;
}

/** The card's soft surface (no border, no shadow): its background, by theme. */
export function useWidgetSurface() {
  const { colors: c, scheme } = useTheme();
  return useMemo(
    () => ({ backgroundColor: softCardColor(c.raised, c.grouped, scheme === "dark") }),
    [c.raised, c.grouped, scheme],
  );
}

/**
 * A widget on a board: the agent's small face and the title in a quiet line, what it shows, and a light footer that
 * says when it last updated (and how often, when there's room): "updating…" while it does, the failure and Resolve
 * when it didn't. A number's trend runs edge to edge along the bottom. The card has the design system's cut corner
 * and a soft surface, neutral (the agent's tones are only in the data). `head` replaces the title line, `above` goes
 * between it and the data, `body` replaces the data and `footer` the footer (New widget's card is its form).
 */
export function WidgetCard({
  widget: w,
  big = false,
  head,
  above,
  body,
  footer,
  onPress,
  label,
  compact = false,
}: {
  widget: WidgetCardData;
  big?: boolean;
  head?: ReactNode;
  above?: ReactNode;
  body?: ReactNode;
  footer?: ReactNode;
  onPress?: () => void;
  /** What a screen reader says for the whole card when it opens. */
  label?: string;
  /**
   * The home's strip (ADR 0135 §15): every card as tall as the others (`COMPACT_HEIGHT`), the app's card, the data
   * small and clipped to it, never dimmed; its state (updating, failed) a mark on the title line; the trend kept.
   */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const soft = useWidgetSurface();
  const card = useSurface();
  // The home's strip: the app's card (lit top, cut corner), as every card that stands on the page.
  const surface = compact ? [card, styles.compact] : soft;
  const look = useAgentLook(w.agentId);
  // A 2-high (L) widget on a board draws its data big, as on its own screen.
  const large = big || isTall(w.h ?? 1);
  const title = shownWidgetTitle(w.title, w.kind, (key) => t(key));
  const drawn = body === undefined && (w.status === "ok" || w.status === "updating" || w.status === "failed");
  const bleed = drawn ? bleedSeries(w.spec, large) : null;
  const bleedHeight = compact ? 34 : w.spec?.kind === "line" ? (large ? 120 : 76) : large ? 72 : 48;
  const foot = footer !== undefined ? footer : compact ? null : <WidgetFoot widget={w} />;
  // A card with room to spare under its data gets the agents' horizon at its foot, as on the web: not under a trend
  // (it already runs along the foot), not on the big preview, not while it builds.
  const horizon = Boolean(onPress) && !big && drawn && !bleed;
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const frameRef = useRef<ComponentRef<typeof View>>(null);
  // Where the card stands on the screen: cards side by side continue one wave, as on the web.
  const [waveX, setWaveX] = useState(0);
  const [bodyTop, setBodyTop] = useState(0);
  const [dataHeight, setDataHeight] = useState(0);
  // From where the data ends to the card's bottom edge, its padding included (as the web measures it).
  const room = frame.height + PAD_Y - (bodyTop + dataHeight);
  const content = (
    <>
      {horizon ? (
        <>
          <View
            ref={frameRef}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              setFrame((f) => (f.width === width && f.height === height ? f : { width, height }));
              frameRef.current?.measureInWindow((x) => setWaveX(Math.round(x - PAD_X)));
            }}
          />
          {dataHeight > 0 && frame.width > 0 ? (
            <CardHorizon
              width={frame.width + 2 * PAD_X}
              room={room}
              surface={compact ? c.raised : soft.backgroundColor}
              x={waveX}
              {...(compact ? { minRoom: COMPACT_HORIZON_ROOM } : {})}
              style={styles.horizon}
            />
          ) : null}
        </>
      ) : null}
      {head === undefined ? (
        <View style={[styles.head, large ? styles.headTop : null]}>
          {/* On the home's strip the title stands alone: whose it is shows when it works (the orbit), not before. */}
          {compact ? null : <AgentFace agentId={w.agentId} size={16} live={false} />}
          <Text variant="caption" tone="muted" numberOfLines={large ? 2 : 1} style={[styles.title, styles.grow]}>
            {title}
          </Text>
          {/* The strip has no footer: updating is its orbit, a failure its mark, on the title line. */}
          {compact && w.status === "updating" ? <PixelOrbit color={look.color} size={16} /> : null}
          {compact && w.status === "failed" ? <Icon name="info" size={13} color={c.warn} /> : null}
        </View>
      ) : (
        head
      )}
      {above}
      <View
        style={compact ? [styles.bodyCompact, w.spec?.kind === "bars" && styles.toEdge] : styles.body}
        onLayout={horizon ? (e) => setBodyTop(e.nativeEvent.layout.y) : undefined}
      >
        {body === undefined ? (
          <WidgetBody
            spec={w.spec}
            status={w.status}
            agentId={w.agentId}
            big={large}
            bleed={Boolean(bleed)}
            compact={compact}
            {...(horizon ? { onLayout: (e: LayoutChangeEvent) => setDataHeight(e.nativeEvent.layout.height) } : {})}
          />
        ) : (
          body
        )}
      </View>
      {foot}
      {bleed ? (
        <View style={[styles.bleedBox, w.status === "ok" || compact ? null : styles.dim]}>
          <BleedLine values={bleed} color={look.color} height={bleedHeight} />
        </View>
      ) : null}
    </>
  );
  if (!onPress) return <View style={[styles.card, surface]}>{content}</View>;
  return (
    <PressScale
      to={0.98}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      style={[styles.card, surface]}
      contentStyle={compact ? [styles.cardIn, styles.cardInCompact] : styles.cardIn}
      fill={false}
    >
      {content}
    </PressScale>
  );
}

/** "12 min ago · every hour" (how often only when there's room), "Theo updating…", or "Didn't update · Resolve". */
function WidgetFoot({ widget: w }: { widget: WidgetCardData }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const look = useAgentLook(w.agentId);
  const words = useWidgetWords();
  if (w.status === "building") return null;
  if (w.status === "updating")
    return (
      <View style={styles.foot}>
        <PixelOrbit color={look.color} size={12} />
        <Text variant="caption" tone="faint" numberOfLines={1} style={styles.grow}>
          {t("widgets.status.updating", { name: look.name })}
        </Text>
      </View>
    );
  if (w.status === "failed")
    return (
      <View style={styles.foot}>
        <Icon name="info" size={13} color={c.warn} />
        <Text variant="caption" numberOfLines={1} style={[styles.grow, { color: c.warn }]}>
          {`${t("widgets.status.failed")} · ${t("widgets.failure.resolve")}`}
        </Text>
      </View>
    );
  const when = w.refreshedAt ? words.ago(w.refreshedAt) : "";
  const often = w.w === 2 || !when ? t(`widgets.schedulesInline.${w.schedule}`) : "";
  const line = [when, often].filter(Boolean).join(" · ");
  if (!line) return null;
  return (
    <View style={styles.foot}>
      <Text variant="caption" tone="faint" numberOfLines={1} style={styles.grow}>
        {line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
    paddingHorizontal: PAD_X,
    paddingTop: PAD_Y,
    paddingBottom: PAD_Y,
    gap: 10,
    minWidth: 0,
    // The edge-to-edge trend is clipped by the rounded corners.
    overflow: "hidden",
    // Two widgets side by side stand as tall as each other.
    flexGrow: 1,
  },
  cardIn: { gap: 10, flexGrow: 1 },
  cardInCompact: { gap: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  // A big card's title may take two lines: the 16 face on the first (its line is 16 tall).
  headTop: { alignItems: "flex-start" },
  title: { fontWeight: "600", letterSpacing: 0.1 },
  body: { flexGrow: 1, minWidth: 0 },
  num: { fontSize: 30, lineHeight: 34, fontWeight: "700", letterSpacing: -0.9, fontVariant: ["tabular-nums"] },
  numBig: { fontSize: 40, lineHeight: 44, letterSpacing: -1.2 },
  affix: { fontSize: 15, fontWeight: "600", letterSpacing: 0 },
  strong: { fontWeight: "600" },
  spark: { marginTop: 6 },
  track: {
    borderRadius: 4,
    borderWidth: 1.5,
    overflow: "hidden",
    marginTop: 8,
    marginBottom: 6,
    justifyContent: "center",
  },
  unit: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 1,
    marginBottom: 4,
  },
  unitText: { fontWeight: "600" },
  bars: { flexDirection: "row", alignItems: "flex-end", paddingTop: 18 },
  bar: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "flex-end", height: "100%" },
  barValue: { fontWeight: "700", fontVariant: ["tabular-nums"], marginBottom: 3 },
  axis: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4 },
  axisLabel: { flex: 1, minWidth: 0, textAlign: "center" },
  note: { marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 6 },
  meta: { flexShrink: 0, maxWidth: "45%" },
  grow: { flex: 1, minWidth: 0 },
  items: { gap: 4 },
  item: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  mark: { width: 5, height: 5, borderRadius: 1.5, marginTop: 8 },
  building: { gap: 8 },
  field: { borderRadius: 6, overflow: "hidden" },
  band: { position: "absolute", top: 0, bottom: 0 },
  foot: { flexDirection: "row", alignItems: "center", gap: 6 },
  // Out to the card's edges and its bottom: the card's padding cancelled.
  bleedBox: { marginHorizontal: -PAD_X, marginBottom: -PAD_Y, marginTop: -4 },
  bleed: { width: "100%" },
  dim: { opacity: 0.45 },
  // Out to the card's sides and bottom edge, under its text: the card's corners clip it.
  horizon: { left: -PAD_X, bottom: -PAD_Y },
  compact: { height: COMPACT_HEIGHT, flexGrow: 0, gap: 6 },
  fill: { flex: 1, minHeight: 0 },
  compactBars: { gap: 6 },
  // The first column starts where the title does and the last ends where it would; all stand on the card's edge.
  barsCompact: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  bodyCompact: { flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" },
  // The strip's columns run down to the card's bottom edge, as a trend does: the card's padding cancelled there.
  toEdge: { marginBottom: -PAD_Y },
  numCompact: { fontSize: 28, lineHeight: 34, letterSpacing: -0.7 },
  rowCompact: { paddingVertical: 3 },
});
