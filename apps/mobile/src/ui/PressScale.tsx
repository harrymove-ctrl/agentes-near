import type { ReactNode } from "react";
import { Pressable, type PressableProps, type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import Animated, {
  type AnimatedStyle,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { haptics } from "./haptics";
import { useTheme } from "./theme";

export interface PressScaleProps extends Omit<PressableProps, "style" | "children"> {
  /** Scale while pressed (default 0.97). */
  to?: number;
  /** Also sink half a point (buttons). */
  sink?: boolean;
  /** A light haptic on press in (default true). */
  haptic?: boolean;
  /**
   * The press area fills the view (default true: a sized circle or tile centers its content). Off for
   * content-sized controls: a growing press area takes whatever height Yoga offers when it measures a row
   * to fit, so a button stood as tall as the screen.
   */
  fill?: boolean;
  /**
   * How the content sits in the press area. `style` is the button from the outside (size, color, shadow): alignment
   * set there moves the press area, not what is inside it, so a sized circle's icon stayed in its top corner.
   */
  contentStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<AnimatedStyle<ViewStyle>>;
  children?: ReactNode;
}

/**
 * The design system's tactile press: a spring down on press in and back on release (no spring with
 * reduced motion), with a light haptic. Everything pressable in src/ui uses it.
 */
export function PressScale({
  to = 0.97,
  sink = false,
  haptic = true,
  fill = true,
  contentStyle,
  style,
  children,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressScaleProps) {
  const { motion, reducedMotion } = useTheme();
  const k = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - (1 - to) * k.value }, { translateY: sink ? 0.5 * k.value : 0 }],
  }));
  return (
    <Animated.View style={[style, animated]}>
      <Pressable
        {...rest}
        disabled={disabled}
        style={[fill ? styles.fill : undefined, contentStyle]}
        onPressIn={(e) => {
          k.value = reducedMotion ? withTiming(1, { duration: 0 }) : withSpring(1, motion.press);
          if (haptic && !disabled) haptics.light();
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          k.value = reducedMotion ? withTiming(0, { duration: 0 }) : withSpring(0, motion.press);
          onPressOut?.(e);
        }}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({ fill: { flexGrow: 1 } });
