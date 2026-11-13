import { type ReactNode, useEffect } from "react";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring } from "react-native-reanimated";
import { useReducedMotion } from "../theme";

/**
 * A field that says no: three short moves on the x axis, a spring with no overshoot on the way back, the same
 * instant as the warning haptic the caller fires. `when` flips true once per refusal (a wrong password). Transform
 * only, so nothing around it is laid out again; with reduced motion it stays still (the words and the haptic say it).
 */
export function Shake({ when, children }: { when: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const x = useSharedValue(0);
  useEffect(() => {
    if (!when || reduced) return;
    const quick = { duration: 90, dampingRatio: 1 };
    x.set(
      withSequence(
        withSpring(-8, quick),
        withSpring(7, quick),
        withSpring(-4, quick),
        withSpring(0, { duration: 160, dampingRatio: 0.9 }),
      ),
    );
  }, [when, reduced, x]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}
