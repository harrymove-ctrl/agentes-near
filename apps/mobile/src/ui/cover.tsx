import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect } from "react";
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { needsHeaderBlur } from "@/lib/nav";
import { coverTransform, progress } from "@/lib/parallax";
import { Glass } from "./Glass";
import { withAlpha } from "./palette";
import { Text } from "./Text";
import { useReducedMotion, useTheme } from "./theme";

/**
 * Cover headers (Início's sky, the agent's sky) that react to the scroll on the UI thread: the cover lags
 * behind the content (parallax), stretches on pull-down, and things fade as they pass under the bar.
 * With reduce motion on, the cover stays still (fades still follow the scroll: they don't move anything).
 */

/**
 * The scroll of a cover screen, as `y` from rest (0 at rest, see `lib/parallax`). `rest` is the scroll
 * view's resting offset: iOS insets a scroll view with `contentInsetAdjustmentBehavior="automatic"` by
 * the bar, so at rest its offset is minus that inset; pass it (the header height there), else 0.
 */
export function useCoverScroll(rest = 0) {
  const y = useSharedValue(0);
  const restOffset = useSharedValue(rest);
  useEffect(() => {
    restOffset.value = rest;
  }, [rest, restOffset]);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      y.value = e.contentOffset.y + restOffset.value;
    },
  });
  return { y, onScroll };
}

/**
 * The cover's art (the sky) inside the scrolling content: parallax and stretch from `y`. `style` places
 * it (usually absolute, filling the cover and reaching up behind the bar).
 */
export function CoverParallax({
  y,
  style,
  children,
}: {
  y: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const height = useSharedValue(0);
  const animated = useAnimatedStyle(() => {
    if (reduced) return { transform: [{ translateY: 0 }, { scale: 1 }] };
    const t = coverTransform(y.value, height.value);
    return { transform: [{ translateY: t.translateY }, { scale: t.scale }] };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[style, animated]}
      onLayout={(e) => {
        height.value = e.nativeEvent.layout.height;
      }}
    >
      {children}
    </Animated.View>
  );
}

/** Opacity from the scroll: 1 → 0 as `y` goes `from` → `to` (or 0 → 1 with `appear`). */
export function useScrollFade(y: SharedValue<number>, from: number, to: number, appear = false) {
  return useAnimatedStyle(() => {
    const k = progress(y.value, from, to);
    return { opacity: appear ? k : 1 - k };
  });
}

/** A title for the native bar that fades in with the scroll (Início: once the greeting is gone). */
export function FadingHeaderTitle({
  y,
  from,
  to,
  text,
}: {
  y: SharedValue<number>;
  from: number;
  to: number;
  text: string;
}) {
  const fade = useScrollFade(y, from, to, true);
  return (
    <Animated.View style={fade}>
      <Text variant="body" numberOfLines={1} style={styles.title}>
        {text}
      </Text>
    </Animated.View>
  );
}

const legacyBlur = needsHeaderBlur(Platform.OS, Platform.Version);
const liquidGlass = Platform.OS === "ios" && !legacyBlur;

/**
 * What a clear native bar becomes once content scrolls under it: the bar's blur on iOS before 26; on
 * Android, which has no blur, no bar at all: the content fades into the screen's color under the floating
 * buttons (as iOS 26's scroll edge does); fading in as `y` goes `from` → `to`. On iOS 26 the system
 * draws it (the scroll edge effect of the Liquid Glass bar), so this renders nothing. Place it after the
 * scroll view (it lies over the content, under the native bar), `height` = the header height.
 */
export function CoverBarBackdrop({
  y,
  from,
  to,
  height,
  tone,
}: {
  y: SharedValue<number>;
  from: number;
  to: number;
  height: number;
  /** The screen's color the content fades into on Android (`#rrggbb`; the plain background by default). */
  tone?: string;
}) {
  const { colors } = useTheme();
  const fade = useScrollFade(y, from, to, true);
  if (liquidGlass) return null;
  if (Platform.OS === "android") {
    const base = tone ?? colors.bg;
    return (
      <Animated.View pointerEvents="none" style={[styles.backdrop, { height: height + EDGE_FADE }, fade]}>
        <LinearGradient
          colors={[base, withAlpha(base, 0.86), withAlpha(base, 0)]}
          locations={[0, 0.62, 1]}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    );
  }
  return (
    <Animated.View pointerEvents="none" style={[styles.backdrop, { height }, fade]}>
      <Glass intensity={80} style={StyleSheet.absoluteFill} />
      <View style={[styles.hairline, { backgroundColor: colors.line }]} />
    </Animated.View>
  );
}

/** How far below the bar the content's fade reaches (Android), as the conversation's under its glass header. */
const EDGE_FADE = 28;

const styles = StyleSheet.create({
  title: { fontWeight: "600" },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0 },
  hairline: { position: "absolute", left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
