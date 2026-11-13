import { mixHex } from "@agenteschat/ui/agent/engine";
import { LinearGradient } from "expo-linear-gradient";
import type { ReactNode } from "react";
import { ActivityIndicator, Text as RNText, StyleSheet, View } from "react-native";
import type { IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { TOOL_H, TOUCH } from "./rhythm";
import { systemText } from "./Text";
import { type Theme, useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/** `text`: the ghost's words with no side padding, so they start where the text above does (under a message). */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "text";

export interface ButtonProps {
  variant: ButtonVariant;
  size?: ButtonSize;
  /**
   * Kept for callers, never drawn: a button is its words (the design language has no icons inside buttons; a brand's
   * mark, which is a name and not a picture, goes in `leading`).
   */
  icon?: IconName;
  /** Drawn before the label instead of an icon (a brand's mark), given the label's color. */
  leading?: (color: string) => ReactNode;
  label: string;
  onPress: () => void;
  /** Full width. */
  wide?: boolean;
  disabled?: boolean;
  /** Working on it: a spinner in the icon's place, and it can't be pressed again meanwhile. */
  loading?: boolean;
  /** What a screen reader hears after the label: the state the label is too short to say. */
  hint?: string;
}

/** In a card or a row: the web's small button, 32 tall, its target grown to 44 past it (`slopOf`). */
const SMALL = { height: TOOL_H, radius: 10, padding: 12, text: "subhead", icon: 16 } as const;

export const BUTTON_SIZES = {
  md: { height: 48, radius: 15, padding: 20, text: "headline", icon: 18 },
  // A request's footer in the conversation: the in-card small button, so the card stays a message.
  card: SMALL,
  sm: SMALL,
} as const;

export type ButtonSize = keyof typeof BUTTON_SIZES;

/** A button shorter than a finger's target grows it above and below, never sideways: two 8 apart never share one. */
export function slopOf(height: number) {
  const grow = (TOUCH - height) / 2;
  return grow > 0 ? { top: grow, bottom: grow } : undefined;
}

/** Primary's tonal gradient (ink 82% → ink) and its shadow, as on the web (`.b1`). */
export function primaryLook(theme: Pick<Theme, "colors">) {
  const { ink, bg } = theme.colors;
  return {
    gradient: [mixHex(ink, bg, 0.18), ink] as const,
    shadow: "0px 1px 2px 0px rgba(0, 0, 0, 0.18), 0px 6px 14px -6px rgba(0, 0, 0, 0.45)",
    highlight: "rgba(255, 255, 255, 0.18)",
    lowlight: "rgba(0, 0, 0, 0.3)",
    text: bg,
  };
}

/** The tactile button: tonal gradient, a lit top edge, a spring press and a light haptic. */
export function Button({
  variant,
  size = "md",
  leading,
  label,
  onPress,
  wide = false,
  disabled = false,
  loading = false,
  hint,
}: ButtonProps) {
  const theme = useTheme();
  const { colors, shadows } = theme;
  const s = BUTTON_SIZES[size];
  const primary = variant === "primary";
  const look = primaryLook(theme);
  const textColor = primary ? look.text : variant === "ghost" || variant === "text" ? colors.muted : colors.ink;
  return (
    <PressScale
      onPress={onPress}
      disabled={disabled || loading}
      sink
      fill={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      hitSlop={slopOf(s.height)}
      style={[
        {
          borderRadius: s.radius,
          alignSelf: wide ? "stretch" : "flex-start",
          opacity: disabled ? 0.5 : 1,
        },
        primary ? { boxShadow: look.shadow } : variant === "secondary" ? { boxShadow: shadows.e1 } : null,
      ]}
    >
      <View
        style={[
          styles.face,
          { minHeight: s.height, borderRadius: s.radius, paddingHorizontal: variant === "text" ? 0 : s.padding },
          variant === "secondary" ? { backgroundColor: colors.raised } : null,
        ]}
      >
        {primary ? (
          <>
            <LinearGradient colors={look.gradient} style={StyleSheet.absoluteFill} />
            <View style={[styles.edge, { top: 0, backgroundColor: look.highlight }]} />
            <View style={[styles.edge, { bottom: 0, backgroundColor: look.lowlight }]} />
          </>
        ) : variant === "secondary" ? (
          <View
            style={[
              styles.edge,
              { top: 0, backgroundColor: theme.scheme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.9)" },
            ]}
          />
        ) : null}
        {loading ? <ActivityIndicator size="small" color={textColor} /> : leading ? leading(textColor) : null}
        <RNText
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText(s.text, weights.semibold), { color: textColor }]}
        >
          {label}
        </RNText>
      </View>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  // Sized by its content and the minimum height, never grown: a growing face inside the press's growing
  // Pressable fills whatever height Yoga offers when it measures to fit, so a button beside a row's text
  // stood as tall as the screen.
  face: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    overflow: "hidden",
  },
  edge: { position: "absolute", left: 0, right: 0, height: 1 },
});
