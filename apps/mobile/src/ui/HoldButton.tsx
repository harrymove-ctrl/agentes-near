import { mixHex } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { BUTTON_SIZES, type ButtonSize, primaryLook, slopOf } from "./Button";
import { haptics } from "./haptics";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

export interface HoldButtonProps {
  /** "Segure para aprovar". One label: a shorter one while held would shrink the button under the finger. */
  label: string;
  onConfirm: () => void;
  /** How long to hold (default 1100 ms). */
  durationMs?: number;
  /** Not yet: dimmed, and holding does nothing (as `Button`'s). */
  disabled?: boolean;
  /** The button's height and type (default `md`); a request card's footer uses `card`. */
  size?: ButtonSize;
}

/**
 * Hold to confirm (high-risk approvals): the button rests a shade lighter and fills from the left in the ink's own
 * tone while held, linearly (it shows time passing), with a light tap at the start and a success one when full.
 * Released early it snaps back fast on an ease-out, nothing asked. No icon: the words are the button.
 */
export function HoldButton({ label, onConfirm, durationMs = 700, disabled = false, size = "md" }: HoldButtonProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const look = primaryLook(theme);
  const s = BUTTON_SIZES[size];
  const fill = useSharedValue(0);
  const press = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const start = () => {
    haptics.light();
    fill.value = withTiming(1, { duration: durationMs, easing: Easing.linear });
    press.value = theme.reducedMotion ? 1 : withSpring(1, theme.motion.press);
    timer.current = setTimeout(() => {
      timer.current = null;
      press.value = withTiming(0, { duration: 120 });
      fill.value = withTiming(0, { duration: 250 });
      haptics.success();
      confirmRef.current();
    }, durationMs);
  };
  const stop = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    cancelAnimation(fill);
    fill.value = withTiming(0, { duration: 180, easing: Easing.bezier(0.23, 1, 0.32, 1) });
    press.value = theme.reducedMotion ? 0 : withSpring(0, theme.motion.press);
  };

  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.03 * press.value }] }));
  const { bg } = theme.colors;

  return (
    <Animated.View
      style={[
        {
          minHeight: s.height,
          borderRadius: s.radius,
          boxShadow: look.shadow,
          alignSelf: "stretch",
          opacity: disabled ? 0.5 : 1,
        },
        pressStyle,
      ]}
    >
      <Pressable
        onPressIn={start}
        onPressOut={stop}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={t("mobile.a11y.hold")}
        accessibilityState={{ disabled }}
        hitSlop={slopOf(s.height)}
        style={[styles.face, { borderRadius: s.radius }]}
      >
        <LinearGradient
          colors={[mixHex(look.gradient[0], bg, 0.3), mixHex(look.gradient[1], bg, 0.3)] as const}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: "left" }, fillStyle]} pointerEvents="none">
          <LinearGradient colors={look.gradient} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <View style={[styles.edge, { backgroundColor: look.highlight }]} />
        <RNText
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText(s.text, weights.semibold), { color: look.text }]}
        >
          {label}
        </RNText>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  face: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    overflow: "hidden",
  },
  edge: { position: "absolute", left: 0, right: 0, top: 0, height: 1 },
});
