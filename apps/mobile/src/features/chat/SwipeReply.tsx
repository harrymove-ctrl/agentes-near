import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { haptics, Icon, useTheme } from "@/ui";

/** How far the row follows the finger freely; past it the pull resists. */
const TRAVEL = 72;
/** Dragged this far the reply is on; a flick faster than `FLICK` from half way is the same intent. */
const COMMIT = 52;
const FLICK = 900;
/** The reply mark: a plate at the row's left edge, under where the row slides from. */
const MARK = 28;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** The further past the edge, the less the row follows (Apple's rubber band). */
function rubberband(over: number, dimension: number, constant = 0.55) {
  "worklet";
  return (over * dimension * constant) / (dimension + constant * Math.abs(over));
}

/**
 * Swipe a message to the right to answer it in the conversation (the quote above the field). The row follows the
 * finger one to one on the UI thread, resists past `TRAVEL`, and commits on distance or on a flick, with one light
 * tap on the frame the reply catches; letting go springs it back with the finger's speed. A vertical move fails the
 * gesture at once, so the list scrolls as before. Off (`enabled` false) the row is just the row.
 */
export function SwipeReply({
  enabled,
  onReply,
  children,
}: {
  enabled: boolean;
  onReply: () => void;
  children: ReactNode;
}) {
  const { colors, reducedMotion } = useTheme();
  const x = useSharedValue(0);
  const armed = useSharedValue(false);
  const catchReply = () => {
    haptics.light();
    onReply();
  };
  const pan = usePanGesture({
    enabled,
    // Offsets are [start, end]: the pan activates past `end` to the right (or before `start` to the left, never here),
    // so only a rightward move of 20 takes the row. A move left, or 8 up or down before that, fails it at once and the
    // list keeps the scroll: vertical motion is always the list's.
    activeOffsetX: [-1e6, 20],
    failOffsetX: [-8, 1e6],
    failOffsetY: [-8, 8],
    // Not from the screen's left edge: that swipe is the system's way back.
    hitSlop: { left: -24 },
    onUpdate: (e) => {
      "worklet";
      const tx = Math.max(0, e.translationX);
      x.value = tx <= TRAVEL ? tx : TRAVEL + rubberband(tx - TRAVEL, TRAVEL);
      // Once, on the frame the line is crossed: the tap lands with the mark filling in.
      if (!armed.value && tx >= COMMIT) {
        armed.value = true;
        scheduleOnRN(catchReply);
      }
    },
    onDeactivate: (e) => {
      "worklet";
      const flick = !armed.value && e.velocityX > FLICK && e.translationX >= COMMIT / 2;
      if (flick) scheduleOnRN(catchReply);
      armed.value = false;
      x.value = reducedMotion
        ? withTiming(0, { duration: 150, easing: EASE_OUT })
        : withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: e.velocityX });
    },
  });
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  // The mark grows in with the pull and settles whole once the reply is on.
  const mark = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, COMMIT * 0.6], [0, 1], "clamp"),
    transform: [{ scale: armed.value ? 1 : interpolate(x.value, [0, COMMIT], [0.95, 1], "clamp") }],
  }));
  if (!enabled) return <>{children}</>;
  return (
    <GestureDetector gesture={pan}>
      <View>
        <Animated.View
          pointerEvents="none"
          style={[styles.mark, { backgroundColor: colors.sunken }, mark]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Icon name="reply" size={15} color={colors.ink2} />
        </Animated.View>
        <Animated.View style={slide}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  mark: {
    position: "absolute",
    left: 16,
    top: "50%",
    marginTop: -MARK / 2,
    width: MARK,
    height: MARK,
    borderRadius: MARK / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
