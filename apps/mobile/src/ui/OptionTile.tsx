import type { ReactNode } from "react";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { haptics } from "./haptics";
import { Icon } from "./Icon";
import { useTheme } from "./theme";

/**
 * The web's `OptionCard` (`.ac-option`): a raised choice that, chosen, sinks into the page in both themes (the sunken
 * face and an inner shadow, the web's `--chosen-*`), with the ink check in its corner, never a thick ring.
 */
export function OptionTile({
  pressed,
  onPress,
  children,
  label,
  style,
}: {
  pressed: boolean;
  onPress: () => void;
  children: ReactNode;
  /** What a screen reader says (the tile's words). */
  label: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, shadows } = useTheme();
  const face = pressed
    ? {
        backgroundColor: colors.sunken,
        boxShadow: `inset 0px 2px 5px rgba(0, 0, 0, 0.16), inset 0px 1px 1.5px rgba(0, 0, 0, 0.12), inset 0px 0px 0px 1px ${colors.line}`,
      }
    : { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` };
  return (
    <Pressable
      onPress={() => {
        haptics.light();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: pressed }}
      accessibilityLabel={label}
      style={({ pressed: down }) => [styles.tile, face, down && !pressed && styles.down, style]}
    >
      {children}
      {pressed ? (
        <View style={[styles.check, { backgroundColor: colors.ink }]}>
          <Icon name="check" size={12} color={colors.bg} />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: 14, padding: 12 },
  down: { transform: [{ scale: 0.98 }] },
  check: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
