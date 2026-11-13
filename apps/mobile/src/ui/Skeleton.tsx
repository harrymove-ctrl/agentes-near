import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { LIST_AVATAR } from "./ListRow";
import { useReducedMotion, useTheme } from "./theme";

/**
 * The shape of a list while it loads: rows with the avatar's square and two bars where the name and the preview
 * go, pulsing softly together. A list that loads this way changes nothing when the data lands (the rows are the
 * same height), where a spinner or the word "Loading" left a blank page. With reduced motion the bars stay still.
 */
export function SkeletonRow({ name = 42, preview = 80 }: { name?: number; preview?: number }) {
  const { colors } = useTheme();
  const pulse = usePulse();
  const bone = { backgroundColor: colors.sunken };
  return (
    <Animated.View
      style={[styles.row, pulse]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View style={[styles.avatar, bone]} />
      <View style={styles.tx}>
        <View style={[styles.line, styles.name, bone, { width: `${name}%` }]} />
        <View style={[styles.line, styles.preview, bone, { width: `${preview}%` }]} />
      </View>
    </Animated.View>
  );
}

/** A few rows of a list, as `SkeletonRow`, each a little different so it reads as a list and not a pattern. */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <View>
      {SHAPES.slice(0, rows).map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed shapes, never reordered
        <SkeletonRow key={i} name={s[0]} preview={s[1]} />
      ))}
    </View>
  );
}

/** Row shapes: the name's and the preview's widths, in percent of the text column. */
const SHAPES: [number, number][] = [
  [42, 80],
  [55, 70],
  [38, 86],
  [60, 64],
  [48, 75],
  [34, 78],
];

/** The soft pulse every bone shares: 1 → 0.55 → 1 over 1.4 s, still with reduced motion. */
function usePulse() {
  const reduced = useReducedMotion();
  const k = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
      k.value = 0.8;
      return;
    }
    k.value = withRepeat(
      withSequence(
        withTiming(0.55, { duration: 700, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
    );
  }, [k, reduced]);
  return useAnimatedStyle(() => ({ opacity: k.value }));
}

const styles = StyleSheet.create({
  // The same box as `ListRow`: 16 at the sides, the 52 avatar, 12 to the text, 76 tall.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 76,
  },
  avatar: { width: LIST_AVATAR, height: LIST_AVATAR, borderRadius: Math.round(LIST_AVATAR * 0.3) },
  tx: { flex: 1, minWidth: 0, gap: 8 },
  line: { borderRadius: 6 },
  // Where the 17-point name and the 15-point preview sit.
  name: { height: 14 },
  preview: { height: 12 },
});
