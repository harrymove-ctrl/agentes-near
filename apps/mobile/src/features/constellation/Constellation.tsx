import { type AgentColorName, gradientOf } from "@agenteschat/ui/agent/engine";
import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type LayoutChangeEvent,
  Pressable,
  Text as RNText,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import { useLivePaused } from "@/agent/live";
import { Dither } from "@/sky/Dither";
import { haptics, Icon, Text } from "@/ui";
import { useReducedMotion } from "@/ui/theme";
import { Face } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import {
  fitStars,
  namedStars,
  type Point,
  pixelsAlong,
  placeStars,
  ringAround,
  type Star,
  type StarLink,
  type StarMap,
  spriteOf,
  worldSide,
} from "./logic";

/** The night stays in both themes: the stars need the dark. */
const NIGHT = "#070b14";
const NIGHT_TONES = ["#070b14", "#0a1120", "#0c1a35", "#0f2750"] as const;
const LINE = "#88a9e6";
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.8;
const FOCUS = { duration: 420, easing: Easing.out(Easing.cubic) };
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** A sky that assembled once doesn't again in this run of the app: the moment is the first look, not every visit. */
const assembled = new Set<string>();

/** A path of small squares, for what is drawn in one color. */
function squares(points: Point[], size: number) {
  const path = Skia.PathBuilder.Make();
  for (const p of points) path.addRect(Skia.XYWHRect(p.x, p.y, size, size));
  return path.build();
}

/** A light that passes along the links used lately, one at a time. */
function Pulse({ links, at }: { links: StarLink[]; at: Map<string, Point> }) {
  const reduced = useReducedMotion();
  const paused = useLivePaused();
  const progress = useSharedValue(0);
  const [link, setLink] = useState<StarLink | null>(null);
  const turn = useRef(0);
  const moving = !reduced && !paused && links.length > 0;
  useEffect(() => {
    if (!moving) {
      setLink(null);
      return;
    }
    const next = () => {
      turn.current += 1;
      setLink(links[turn.current % links.length] ?? null);
      progress.value = 0;
      progress.value = withTiming(1, { duration: 1400, easing: Easing.linear });
    };
    next();
    const timer = setInterval(next, 1900);
    return () => clearInterval(timer);
  }, [moving, links, progress]);
  const a = link ? at.get(link.from) : undefined;
  const b = link ? at.get(link.to) : undefined;
  const style = useAnimatedStyle(() => {
    if (!a || !b) return { opacity: 0 };
    return {
      opacity: 1 - progress.value ** 4,
      transform: [
        { translateX: a.x + (b.x - a.x) * progress.value - 2 },
        { translateY: a.y + (b.y - a.y) * progress.value - 2 },
      ],
    };
  });
  return <Animated.View pointerEvents="none" style={[styles.pulse, style]} />;
}

/** One star: its pixels are on the canvas; this is the tap, the agent's body, the ring when selected and the name. */
function StarSpot({
  star,
  at,
  named,
  selected,
  onPress,
}: {
  star: Star;
  at: Point;
  named: boolean;
  selected: boolean;
  onPress: ((id: string) => void) | undefined;
}) {
  const agent = star.kind === "agent";
  const body = agent ? 34 : 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={star.title}
      accessibilityState={{ selected }}
      disabled={!onPress}
      onPress={() => onPress?.(star.id)}
      style={[styles.spot, { left: at.x - SPOT / 2, top: at.y - SPOT / 2 }]}
    >
      {agent ? <Face who={{ type: "agent", id: star.id }} size={body} /> : null}
      {named || selected ? (
        <View style={[styles.name, { top: SPOT / 2 + (agent ? body / 2 + 3 : 9) }]} pointerEvents="none">
          <RNText
            numberOfLines={2}
            maxFontSizeMultiplier={1.2}
            style={[styles.nameText, (agent || selected) && styles.nameStrong]}
          >
            {star.title}
          </RNText>
        </View>
      ) : null}
    </Pressable>
  );
}

export interface ConstellationProps {
  map: StarMap;
  selected: string | null;
  height: number;
  /** Tapping a star; without it the sky is only to look at (no drag, no zoom). */
  onSelect?: (id: string) => void;
  /**
   * Drag and pinch to explore (default, with `onSelect`). False: every star framed and still, taps only, so a sky
   * inside a scrolling page never takes the page's scroll.
   */
  explore?: boolean;
  /**
   * The first time this key's sky is seen in a run of the app, the stars fade in and the lines draw outward from the
   * selected star (the wiki's connections lighting up). Off with reduced motion.
   */
  assemble?: string;
}

/**
 * The sky: to explore, a world bigger than the window, dragged and pinched, with the selected star brought to the
 * middle; still (inside a page, or only to look at), the stars spread over the window at their real size. Lines and
 * stars are one Skia drawing; bodies, names and taps are views on top, moved with it, so the screen reader reaches
 * every star.
 */
export function Constellation({ map, selected, height, onSelect, explore = true, assemble }: ConstellationProps) {
  const dir = useDirectory();
  const reduced = useReducedMotion();
  const still = !(onSelect && explore);
  const [width, setWidth] = useState(0);
  const placedStars = useMemo(() => placeStars(map), [map]);
  const at = useMemo(
    () => (still && width ? fitStars(placedStars, width, height) : placedStars),
    [still, placedStars, width, height],
  );
  // A still sky's world is the window itself; an explored one, a square with room per star.
  const side = worldSide(map.stars.length);
  const worldW = still ? width : side;
  const worldH = still ? height : side;
  const named = useMemo(() => namedStars(map, at, selected), [map, at, selected]);
  const recent = useMemo(() => map.links.filter((l) => l.recent), [map]);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const zoom = useSharedValue(1);
  const placed = useRef(false);
  // The first look: stars, then the lines drawn from the heart outward (`assemble`); otherwise all there at once.
  const play = useRef(assemble !== undefined && !assembled.has(assemble) && !reduced).current;
  const lit = useSharedValue(play ? 0 : 1);
  const drawn = useSharedValue(play ? 0 : 1);
  // A tapped star's own lines draw bright from it; the first selection is just there.
  const hotDrawn = useSharedValue(1);
  const chosenOnce = useRef(false);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  useEffect(() => {
    if (!width) return;
    // Still: the window is the world, nothing moves. To explore: the selected star in the middle.
    if (still) {
      zoom.value = 1;
      x.value = 0;
      y.value = 0;
      return;
    }
    const p = (selected ? at.get(selected) : undefined) ?? { x: side / 2, y: side / 2 };
    const toX = width / 2 - p.x * zoom.value;
    const toY = height / 2 - p.y * zoom.value;
    x.value = placed.current ? withTiming(toX, FOCUS) : toX;
    y.value = placed.current ? withTiming(toY, FOCUS) : toY;
    placed.current = true;
  }, [selected, at, width, height, side, x, y, zoom, still]);

  useEffect(() => {
    if (!play || !width || assemble === undefined) return;
    assembled.add(assemble);
    lit.value = withTiming(1, { duration: 420, easing: EASE_OUT });
    drawn.value = withDelay(180, withTiming(1, { duration: 900, easing: EASE_OUT }));
  }, [play, width, assemble, lit, drawn]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `selected` is the trigger: a new selection draws its links again
  useEffect(() => {
    if (!chosenOnce.current || reduced) {
      chosenOnce.current = true;
      hotDrawn.value = 1;
      return;
    }
    hotDrawn.value = 0;
    hotDrawn.value = withTiming(1, { duration: 240, easing: EASE_OUT });
  }, [selected, reduced, hotDrawn]);

  // One light tap on the frame a star is chosen; the lines answer in the same frame.
  const choose = onSelect
    ? (id: string) => {
        if (id !== selected) haptics.light();
        onSelect(id);
      }
    : undefined;

  const art = useMemo(() => {
    // Outward from the selected star (or the middle), so a drawing line reads as one wave from the heart.
    const from = (selected ? at.get(selected) : undefined) ?? { x: worldW / 2, y: worldH / 2 };
    const reach = (l: StarLink) => {
      const a = at.get(l.from);
      const b = at.get(l.to);
      return a && b ? Math.min(Math.hypot(a.x - from.x, a.y - from.y), Math.hypot(b.x - from.x, b.y - from.y)) : 0;
    };
    const outward = [...map.links].sort((p, q) => reach(p) - reach(q));
    const line = (hot: boolean) =>
      outward.flatMap((l) => {
        const a = at.get(l.from);
        const b = at.get(l.to);
        if (!a || !b || (l.from === selected || l.to === selected) !== hot) return [];
        return pixelsAlong(a, b);
      });
    // One drawing per color and pixel size: a page an agent wrote takes its color, a page with three links or more
    // (or read that often) is drawn a size up, the brighter stars of the sky.
    const groups = new Map<string, { color: string; size: number; points: Point[] }>();
    for (const s of map.stars) {
      const p = at.get(s.id);
      if (!p || s.kind === "agent") continue;
      const color = s.kind === "memory" || s.agentId ? gradientOf(agentColor(s, dir))[0] : "#ffffff";
      const cell = s.kind === "page" && s.weight >= 3 ? 3 : 2;
      const key = `${color}|${cell}`;
      const group = groups.get(key) ?? { color, size: cell, points: [] };
      for (const [dx, dy] of spriteOf(s.kind))
        group.points.push({ x: p.x + dx * cell - cell / 2, y: p.y + dy * cell - cell / 2 });
      groups.set(key, group);
    }
    const chosen = map.stars.find((s) => s.id === selected);
    const spot = chosen ? at.get(chosen.id) : undefined;
    return {
      ring: squares(spot && chosen ? ringAround(spot, chosen.kind === "agent" ? 27 : 14) : [], 2),
      dim: squares(line(false), 1.5),
      hot: squares(line(true), 2),
      stars: [...groups].map(([key, g]) => ({ key, color: g.color, path: squares(g.points, g.size) })),
    };
  }, [map, at, selected, dir, worldW, worldH]);

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minDistance(6)
      .onChange((e) => {
        x.value += e.changeX;
        y.value += e.changeY;
      });
    const pinch = Gesture.Pinch().onChange((e) => {
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom.value * e.scaleChange));
      const ratio = next / zoom.value;
      x.value = e.focalX - (e.focalX - x.value) * ratio;
      y.value = e.focalY - (e.focalY - y.value) * ratio;
      zoom.value = next;
    });
    return Gesture.Simultaneous(pan, pinch);
  }, [x, y, zoom]);

  const world = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: zoom.value }],
  }));
  const spots = useAnimatedStyle(() => ({ opacity: lit.value }));

  const sky = (
    <View onLayout={onLayout} style={[styles.window, { height }]}>
      <Dither kind="sky" tones={NIGHT_TONES} pixel={4} style={StyleSheet.absoluteFill} />
      {/* A still sky waits for its width: it is laid out over the window, never drawn as a square first. */}
      {still && !width ? null : (
        <Animated.View style={[styles.world, { width: worldW, height: worldH }, world]}>
          <Canvas style={{ width: worldW, height: worldH }} pointerEvents="none">
            <Path path={art.dim} color={LINE} opacity={0.26} end={drawn} />
            <Path path={art.hot} color={LINE} opacity={0.85} end={hotDrawn} />
            {art.stars.map((g) => (
              <Path key={g.key} path={g.path} color={g.color} opacity={lit} />
            ))}
            <Path path={art.ring} color="#ffffff" opacity={lit} />
          </Canvas>
          <Pulse links={recent} at={at} />
          <Animated.View style={[StyleSheet.absoluteFill, spots]} pointerEvents="box-none">
            {map.stars.map((s) => {
              const p = at.get(s.id);
              return p ? (
                <StarSpot
                  key={s.id}
                  star={s}
                  at={p}
                  named={named.has(s.id)}
                  selected={s.id === selected}
                  onPress={choose}
                />
              ) : null;
            })}
          </Animated.View>
        </Animated.View>
      )}
    </View>
  );
  return onSelect && explore ? <GestureDetector gesture={gesture}>{sky}</GestureDetector> : sky;
}

function agentColor(s: Star, dir: ReturnType<typeof useDirectory>): AgentColorName {
  return agentLook(s.agentId ? dir.anyAgent(s.agentId) : undefined).color;
}

/**
 * The sky in a card: its name and count on top (when it has one), and under it what was tapped, which opens.
 * `explore` and `assemble` as `Constellation`'s.
 */
export function StarCard({
  label,
  count,
  map,
  selected,
  height = 340,
  onSelect,
  title,
  subtitle,
  onOpen,
  explore = true,
  assemble,
  accessibilityLabel,
  style,
}: {
  label?: string;
  count?: number;
  map: StarMap;
  selected: string | null;
  height?: number;
  onSelect: (id: string) => void;
  title: string;
  subtitle: string;
  onOpen: () => void;
  explore?: boolean;
  assemble?: string;
  /** What the sky is, for the screen reader, when the card has no name on top. */
  accessibilityLabel?: string;
  /** Room around the card where its place differs (under a section header: no top margin). */
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  return (
    <View style={[styles.card, style]} accessibilityLabel={accessibilityLabel}>
      <Constellation
        map={map}
        selected={selected}
        height={height}
        onSelect={onSelect}
        explore={explore}
        {...(assemble ? { assemble } : {})}
      />
      {label ? (
        <View style={styles.cardHead} pointerEvents="none">
          <Icon name="sparkle" size={16} color="#ffffff" />
          <Text variant="callout" style={styles.cardTitle} numberOfLines={1}>
            {label}
          </Text>
          {count !== undefined ? (
            <Text variant="subhead" style={styles.cardCount}>
              {count}
            </Text>
          ) : null}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityHint={t("mobile.constellation.openHint")}
        onPress={onOpen}
        style={({ pressed }) => [styles.foot, pressed && styles.pressed]}
      >
        <View style={styles.footText}>
          <Text variant="body" style={styles.footTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text variant="footnote" style={styles.footSub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Icon name="right" size={16} color="rgba(255,255,255,0.55)" />
      </Pressable>
    </View>
  );
}

/** A small sky to look at, over a page or a memory. */
export function StarStrip({ map, selected }: { map: StarMap; selected: string }) {
  return (
    <View style={styles.strip}>
      <Constellation map={map} selected={selected} height={170} />
    </View>
  );
}

const SPOT = 44;

const styles = StyleSheet.create({
  window: { overflow: "hidden", backgroundColor: NIGHT },
  world: { position: "absolute", left: 0, top: 0, transformOrigin: "left top" },
  spot: { position: "absolute", width: SPOT, height: SPOT, alignItems: "center", justifyContent: "center" },
  name: {
    position: "absolute",
    width: 112,
    left: (SPOT - 112) / 2,
    alignItems: "center",
  },
  nameText: {
    color: "rgba(255,255,255,0.84)",
    fontSize: 12,
    lineHeight: 15,
    fontWeight: "500",
    textAlign: "center",
    backgroundColor: "rgba(7,11,20,0.62)",
    borderRadius: 5,
    overflow: "hidden",
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  nameStrong: { color: "#ffffff", fontWeight: "600" },
  pulse: { position: "absolute", left: 0, top: 0, width: 4, height: 4, backgroundColor: "#cfe0ff" },
  card: { marginHorizontal: 16, marginTop: 12, borderRadius: 20, overflow: "hidden", backgroundColor: NIGHT },
  cardHead: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 13,
    paddingBottom: 18,
  },
  cardTitle: { flex: 1, color: "#ffffff", fontWeight: "600" },
  cardCount: { color: "rgba(255,255,255,0.62)" },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.14)",
  },
  footText: { flex: 1, minWidth: 0, gap: 1 },
  footTitle: { color: "#ffffff", fontWeight: "600" },
  footSub: { color: "rgba(255,255,255,0.66)" },
  pressed: { opacity: 0.8 },
  strip: { marginHorizontal: 16, marginTop: 8, borderRadius: 20, overflow: "hidden", backgroundColor: NIGHT },
});
