import { type ReactNode, useEffect, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useReducedMotion } from "@/ui";
import { useLaunched } from "../launch/launched";

/** Strong ease-out: the entrance starts fast, where the eye is, and settles slowly. */
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/** Once per launch: the first Conversas after the splash arrives; every other visit is just there. */
let played = false;

/**
 * Whether Conversas plays its arrival: the first time it is on screen after the splash left, once per launch, never
 * again while the app runs (coming back to the tab, a pull, a new day all show it still). Before the splash leaves
 * the parts wait hidden under it, so nothing is seen twice.
 */
export function useHomeEntrance(): { armed: boolean; play: boolean } {
  const launched = useLaunched();
  const [armed] = useState(() => !played);
  useEffect(() => {
    if (armed && launched) played = true;
  }, [armed, launched]);
  return { armed, play: armed && launched };
}

/**
 * One part of the arrival: from `rise` points below and clear, to its place, starting `delay` after the splash left
 * (fades only, no travel, with reduced motion). Touches go through from the first frame: the arrival never holds a
 * tap back. Unarmed, the part is simply there.
 */
export function Arrive({
  armed,
  play,
  delay = 0,
  rise = 8,
  duration = 480,
  style,
  children,
}: {
  armed: boolean;
  play: boolean;
  delay?: number;
  rise?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const shown = useSharedValue(armed ? 0 : 1);
  useEffect(() => {
    if (!play) return;
    shown.set(withDelay(reduced ? 0 : delay, withTiming(1, { duration: reduced ? 200 : duration, easing: EASE_OUT })));
  }, [play, delay, duration, reduced, shown]);
  const look = useAnimatedStyle(() => ({
    opacity: shown.get(),
    transform: [{ translateY: reduced ? 0 : (1 - shown.get()) * rise }],
  }));
  return <Animated.View style={[style, look]}>{children}</Animated.View>;
}

/**
 * The right hand waking as the app opens: asleep under the splash, it opens its eyes `delay` after it left and gives
 * one small hop (a spring, transform only), the one living thing that greets you. Unarmed, it is just awake.
 */
export function useWake(armed: boolean, play: boolean, delay = 300) {
  const reduced = useReducedMotion();
  const [awake, setAwake] = useState(!armed);
  const hop = useSharedValue(0);
  useEffect(() => {
    if (!play || awake) return;
    const timer = setTimeout(() => {
      setAwake(true);
      // Up 3 points fast and back on a light spring: a hop, not a bounce.
      if (!reduced)
        hop.set(
          withSequence(
            withTiming(-3, { duration: 140, easing: EASE_OUT }),
            withSpring(0, { duration: 360, dampingRatio: 0.6 }),
          ),
        );
    }, delay);
    return () => clearTimeout(timer);
  }, [play, awake, delay, reduced, hop]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: hop.get() }] }));
  return { mode: awake ? ("idle" as const) : ("sleep" as const), style };
}
