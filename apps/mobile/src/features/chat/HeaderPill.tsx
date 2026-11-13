import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { type ReactNode, useEffect, useState } from "react";
import { type LayoutChangeEvent, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type EntryExitAnimationFunction,
  LayoutAnimationConfig,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { Glass, haptics, PressScale, Text, useReducedMotion, useTheme } from "@/ui";

/** The pill's own padding, the face's box and the gaps: the face sits in the capsule's curve. */
const PAD_LEFT = 6;
const PAD_RIGHT = 16;
const LEAD = 32;
const GAP = 9;
const TRAILING_GAP = 2;
const HEIGHT = 44;
const BORDER = StyleSheet.hairlineWidth;
const MIN_WIDTH = 120;
const WIDTH_SPRING = { stiffness: 300, damping: 30, mass: 1 };
const LINE_SPRING = { stiffness: 260, damping: 26, mass: 1 };
const SKY_SPRING = { stiffness: 90, damping: 18, mass: 1 };
/** How far a line rolls in and out. */
const ROLL = 15;
/** Breathing while an agent works: a scale this small reads as alive, never as motion. */
const BREATH_SCALE = 1.012;
const BREATH_MS = 1400;
const BREATH_EASE = Easing.bezier(0.77, 0, 0.175, 1);
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

const rollIn: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: ROLL }] },
    animations: {
      opacity: withTiming(1, { duration: 200 }),
      transform: [{ translateY: withSpring(0, LINE_SPRING) }],
    },
  };
};

const rollOut: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: {
      opacity: withTiming(0, { duration: 140 }),
      transform: [{ translateY: withSpring(-ROLL, LINE_SPRING) }],
    },
  };
};

/**
 * The conversation's title as a glass pill in the header: who or where on the left, the name and a quiet line
 * under it. It moves instead of jumping: a new line rolls in over the old one, the width follows the words on a
 * spring and an agent's sky turns into the pixel sweep that crosses the pill while it works (the sidebar's trail).
 * In a DM the face wears its presence badge and the quiet line says how the other side is: an agent's presence
 * and line, a person's status (ADR 0084). A channel shows who is in on the right. Held (`onHold`), it opens the
 * conversation switcher.
 *
 * The bar lays its title out once: the slot keeps the width of the room beside the buttons, and only the pill
 * inside it changes, on the UI thread, so the native bar never lays out again during a spring.
 *
 * Reading up the conversation (`collapsed`), the pill closes to its lead alone, a glass circle: the screen is only
 * messages. While an agent works it breathes (a scale too small to call motion), and the sky sweeps.
 */
export function HeaderPill({
  lead,
  title,
  subtitle,
  color,
  working = false,
  trailing,
  onPress,
  label,
  extraActions = 0,
  onHold,
  holdHint,
  collapsed = false,
}: {
  lead?: ReactNode;
  title: string;
  subtitle?: string | undefined;
  /** An agent's color: its sky lives in the pill. */
  color?: AgentColorName | undefined;
  working?: boolean;
  /** Only the lead, in a circle (reading far up the conversation); the words fade and come back with the width. */
  collapsed?: boolean;
  /** Faces of who is in (channels). */
  trailing?: ReactNode;
  onPress?: () => void;
  /** What a screen reader says (name, state and what a tap does). */
  label: string;
  /** Bar buttons beside "…" (an agent's computer): the pill gives up their 44 points each. */
  extraActions?: number;
  onHold?: () => void;
  /** What a screen reader says the hold does. */
  holdHint?: string;
}) {
  const { colors, shadows } = useTheme();
  const reduced = useReducedMotion();
  const { width: screen } = useWindowDimensions();
  // The bar's margins, the back and "…" circles and a gap on each side.
  const room = Math.max(160, screen - 152 - extraActions * 44);

  const [nameWidth, setNameWidth] = useState<number | null>(null);
  const [lineWidth, setLineWidth] = useState(0);
  const [trailingWidth, setTrailingWidth] = useState(0);
  // The hairline border is inside the pill's width too: without it a name sized to fit loses its last letters to "…".
  const chrome =
    PAD_LEFT + PAD_RIGHT + 2 * BORDER + (lead ? LEAD + GAP : 0) + (trailing ? trailingWidth + GAP + TRAILING_GAP : 0);
  const words = Math.max(nameWidth ?? 0, subtitle ? lineWidth : 0);
  // Closed, the pill is a circle around its lead (no lead to close around: it stays open).
  const closed = collapsed && Boolean(lead);
  const target = nameWidth === null ? null : closed ? HEIGHT : Math.min(room, Math.max(MIN_WIDTH, chrome + words));

  // -1 until the words are measured: the first width is set, not sprung.
  const pillWidth = useSharedValue(-1);
  const work = useSharedValue(working ? 1 : 0);
  // The words' presence: they fade before the width closes on them and come back as it opens.
  const open = useSharedValue(closed ? 0 : 1);
  const breath = useSharedValue(1);
  useEffect(() => {
    if (target === null) return;
    pillWidth.value = reduced || pillWidth.value < 0 ? target : withSpring(target, WIDTH_SPRING);
  }, [target, reduced, pillWidth]);
  useEffect(() => {
    work.value = reduced ? (working ? 1 : 0) : withSpring(working ? 1 : 0, SKY_SPRING);
  }, [working, reduced, work]);
  useEffect(() => {
    open.value = withTiming(closed ? 0 : 1, { duration: closed ? 120 : 200, easing: EASE_OUT });
  }, [closed, open]);
  useEffect(() => {
    if (working && !reduced) {
      breath.value = withRepeat(
        withSequence(
          withTiming(BREATH_SCALE, { duration: BREATH_MS, easing: BREATH_EASE }),
          withTiming(1, { duration: BREATH_MS, easing: BREATH_EASE }),
        ),
        -1,
        false,
      );
      return;
    }
    cancelAnimation(breath);
    breath.value = withTiming(1, { duration: 200, easing: EASE_OUT });
  }, [working, reduced, breath]);

  const sized = useAnimatedStyle(() => ({
    width: pillWidth.value < 0 ? room : pillWidth.value,
    opacity: pillWidth.value < 0 ? 0 : 1,
  }));
  // On the glass inside the press: the press's own scale lives on the outer view, and one transform would hide the other.
  const breathing = useAnimatedStyle(() => ({ transform: [{ scale: breath.value }] }));
  const wordsShown = useAnimatedStyle(() => ({ opacity: open.value }));

  const measured = (set: (width: number) => void) => (e: LayoutChangeEvent) =>
    set(Math.ceil(e.nativeEvent.layout.width));

  return (
    <View style={[styles.slot, { width: room }]} pointerEvents="box-none">
      {/* What the words measure, whole, with no room limit. */}
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text variant="callout" numberOfLines={1} style={styles.title} onLayout={measured(setNameWidth)}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" numberOfLines={1} onLayout={measured(setLineWidth)}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <PressScale
        to={0.97}
        onPress={onPress}
        disabled={!onPress && !onHold}
        {...(onHold
          ? {
              delayLongPress: 300,
              onLongPress: () => {
                haptics.medium();
                onHold();
              },
            }
          : {})}
        accessibilityRole={onPress ? "button" : "header"}
        accessibilityLabel={label}
        accessibilityHint={holdHint}
        style={[
          sized,
          // Android's pill is opaque: a short shadow floats it over the conversation, as the glass does on iOS.
          Platform.OS === "android" && { borderRadius: HEIGHT / 2, boxShadow: shadows.e1 },
        ]}
      >
        {/* The same Liquid Glass as the bar's own buttons beside it (iOS 26); the blur and a hairline before. */}
        <Animated.View style={breathing}>
          <Glass
            liquid
            intensity={70}
            style={[styles.pill, closed && styles.pillClosed, { borderColor: colors.line2 }]}
          >
            {color ? (
              <Dither
                kind="pill"
                tones={softTones(color, colors.glassSolid)}
                pixel={3}
                clear
                liveWidth={pillWidth}
                liveWork={work}
                style={[styles.sky, { width: room }]}
              />
            ) : null}
            {lead ? <View style={styles.lead}>{lead}</View> : null}
            <Animated.View
              style={[styles.text, wordsShown]}
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
            >
              <Text variant="callout" numberOfLines={1} style={styles.title}>
                {title}
              </Text>
              {subtitle ? (
                <StatusLine
                  text={subtitle}
                  natural={lineWidth}
                  // Closed, the line is faded out: no sliding to read it.
                  box={(closed ? room : (target ?? room)) - chrome}
                  reduced={reduced}
                />
              ) : null}
            </Animated.View>
            {trailing ? (
              <Animated.View style={[styles.trailing, wordsShown]} onLayout={measured(setTrailingWidth)}>
                {trailing}
              </Animated.View>
            ) : null}
          </Glass>
        </Animated.View>
      </PressScale>
    </View>
  );
}

/** The quiet line: each new one rolls in over the last. */
function StatusLine({ text, natural, box, reduced }: { text: string; natural: number; box: number; reduced: boolean }) {
  return (
    <View style={styles.lineBox}>
      <LayoutAnimationConfig skipEntering>
        <Animated.View key={text} {...(reduced ? {} : { entering: rollIn, exiting: rollOut })} style={styles.line}>
          <SlidingText text={text} natural={natural} box={box} reduced={reduced} />
        </Animated.View>
      </LayoutAnimationConfig>
    </View>
  );
}

/** A line longer than the pill slides once to its end and back, so all of it gets read; it rests with "…". */
function SlidingText({
  text,
  natural,
  box,
  reduced,
}: {
  text: string;
  natural: number;
  box: number;
  reduced: boolean;
}) {
  const x = useSharedValue(0);
  const [free, setFree] = useState(false);
  const over = natural - box;
  const long = over > 1;
  useEffect(() => {
    if (!long || reduced) return;
    const ease = Easing.inOut(Easing.quad);
    const timer = setTimeout(() => {
      setFree(true);
      const out = Math.max(1400, over * 32);
      x.value = withSequence(
        withTiming(-over - 4, { duration: out, easing: ease }),
        withDelay(
          800,
          withTiming(0, { duration: out * 0.6, easing: ease }, (done) => {
            if (done) scheduleOnRN(setFree, false);
          }),
        ),
      );
    }, 1100);
    return () => {
      clearTimeout(timer);
      cancelAnimation(x);
      x.value = 0;
      setFree(false);
    };
  }, [long, over, reduced, x]);
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Animated.View style={[free && { width: natural + 2 }, moved]}>
      <Text variant="caption" tone="muted" numberOfLines={1}>
        {text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slot: { alignItems: Platform.OS === "ios" ? "center" : "flex-start" },
  measure: { position: "absolute", top: 0, left: 0, width: 1000, alignItems: "flex-start", opacity: 0 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: GAP,
    height: HEIGHT,
    paddingLeft: PAD_LEFT,
    paddingRight: PAD_RIGHT,
    borderRadius: HEIGHT / 2,
    borderWidth: BORDER,
    overflow: "hidden",
  },
  // A circle: the lead's box centered in the pill's height (the words, clipped, sit outside it).
  pillClosed: { paddingRight: PAD_LEFT },
  // The drawing keeps the room's width and reads the pill's as a uniform: no canvas resize during a spring.
  sky: { position: "absolute", top: 0, left: 0, height: HEIGHT },
  lead: { alignItems: "center", justifyContent: "center", width: LEAD },
  text: { flex: 1, minWidth: 0 },
  title: { fontWeight: "600", lineHeight: 20 },
  lineBox: { height: 16, overflow: "hidden" },
  line: { position: "absolute", top: 0, left: 0, right: 0 },
  trailing: { flexDirection: "row", alignItems: "center", marginLeft: TRAILING_GAP },
});
