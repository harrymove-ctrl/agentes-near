import { type ComponentRef, forwardRef } from "react";
import { Platform, TextInput, type TextInputProps } from "react-native";
import { systemText } from "../Text";
import { useTheme } from "../theme";

/**
 * The one input of an auth screen: raised, large, 16-point text (no zoom on iOS). `paddingRight` leaves room for a
 * button inside; `minHeight` for a few lines of a `multiline` one. `code`: a code typed back, centred, its digits
 * spaced out in tabular figures (the placeholder keeps its own look).
 */
export const AuthField = forwardRef<
  ComponentRef<typeof TextInput>,
  Omit<TextInputProps, "style"> & { paddingRight?: number; minHeight?: number; code?: boolean }
>(function AuthField({ paddingRight = 16, minHeight = 52, code = false, ...props }, ref) {
  const { colors, shadows } = useTheme();
  const fontSize = systemText("body").fontSize ?? 17;
  const spacing = code && props.value ? Math.round(fontSize * 0.3) : 0;
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={colors.faint}
      {...props}
      style={{
        minHeight,
        borderRadius: 15,
        // iOS adds the spacing after every digit, the last one too: as much on the left keeps them centred.
        paddingLeft: 16 + (Platform.OS === "ios" ? spacing : 0),
        paddingRight,
        backgroundColor: colors.raised,
        boxShadow: `${shadows.e1}, ${shadows.top}`,
        paddingVertical: 12,
        fontSize,
        color: colors.ink,
        textAlign: code ? "center" : undefined,
        letterSpacing: spacing || undefined,
        fontWeight: spacing ? "600" : undefined,
        fontVariant: spacing ? ["tabular-nums"] : undefined,
      }}
    />
  );
});
