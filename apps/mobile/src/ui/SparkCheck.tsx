import { gradientOf } from "@agenteschat/ui/agent/engine";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "./Icon";
import { useReducedMotion } from "./theme";

/** The burst's length: short, once, and over before the eye leaves the line. */
const BURST_MS = 600;
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** Eight pixels on the sky's grid (2 pt squares), out on the compass and its diagonals. */
const RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

/**
 * The check of a request you just approved, with a burst of square pixels in the agent's two tones around it: out
 * fast and fading in 600 ms, once, then the plain check (the decision's weight, never a loop or confetti). The
 * diagonals go a little shorter than the compass points, so the burst reads as dither, not as a star. Under reduced
 * motion it is only the check.
 */
export function SparkCheck({ size, color, tone }: { size: number; color: string; tone?: string | null }) {
  const reduced = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    t.set(withTiming(1, { duration: BURST_MS, easing: EASE_OUT }));
  }, [reduced, t]);
  const [light, deep] = gradientOf(tone ?? undefined);
  return (
    <View style={{ width: size, height: size }}>
      <Icon name="check" size={size} color={color} />
      {reduced
        ? null
        : RAYS.map((deg, i) => (
            <Spark
              key={deg}
              t={t}
              deg={deg}
              reach={(i % 2 === 0 ? 1 : 0.72) * size}
              fill={i % 2 === 0 ? deep : light}
            />
          ))}
    </View>
  );
}

function Spark({ t, deg, reach, fill }: { t: SharedValue<number>; deg: number; reach: number; fill: string }) {
  const rad = (deg * Math.PI) / 180;
  const style = useAnimatedStyle(() => {
    const p = t.get();
    const d = interpolate(p, [0, 1], [reach * 0.35, reach]);
    return {
      opacity: interpolate(p, [0, 0.15, 1], [0, 1, 0]),
      transform: [{ translateX: Math.cos(rad) * d }, { translateY: Math.sin(rad) * d }],
    };
  });
  return <Animated.View pointerEvents="none" style={[styles.spark, { backgroundColor: fill }, style]} />;
}

const styles = StyleSheet.create({
  // Centered on the check; each pixel travels from there.
  spark: { position: "absolute", left: "50%", top: "50%", width: 2, height: 2, marginLeft: -1, marginTop: -1 },
});
