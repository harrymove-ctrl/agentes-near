import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { useTheme } from "./theme";

export interface GlassProps {
  style?: StyleProp<ViewStyle>;
  /** Blur strength on iOS (1–100). */
  intensity?: number;
  /** An opaque surface instead (sheets with forms, `solid`). */
  solid?: boolean;
  /** The system's Liquid Glass where iOS has it (iOS 26), like the bar's own buttons; the blur before it. */
  liquid?: boolean;
  children?: ReactNode;
}

/** Read once: the system doesn't gain or lose Liquid Glass while the app runs. */
const liquidHere = Platform.OS === "ios" && isLiquidGlassAvailable();

/**
 * The design system's glass (bars, sheets, toasts): a real blur under the theme's glass tint on iOS; an
 * opaque surface on Android, where blur is slow and weak.
 */
export function Glass({ style, intensity = 60, solid = false, liquid = false, children }: GlassProps) {
  const { colors, scheme } = useTheme();
  if (solid || Platform.OS !== "ios")
    return <View style={[{ backgroundColor: solid ? colors.bg : colors.glassSolid }, style]}>{children}</View>;
  if (liquid && liquidHere)
    return (
      <GlassView glassEffectStyle="regular" isInteractive colorScheme={scheme} style={[{ overflow: "hidden" }, style]}>
        {children}
      </GlassView>
    );
  return (
    <View style={[{ overflow: "hidden" }, style]}>
      <BlurView
        intensity={intensity}
        tint={scheme === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.glass }]} />
      {children}
    </View>
  );
}
