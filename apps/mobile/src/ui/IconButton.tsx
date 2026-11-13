import { Platform, StyleSheet, View } from "react-native";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { TOOL_H, TOUCH } from "./rhythm";
import { useTheme } from "./theme";

export interface IconButtonProps {
  icon: IconName;
  onPress: () => void;
  /** For screen readers (always required: the button has no visible text). */
  label: string;
  /** A floating button (close, back, more over a sheet or the sky): a glass circle. */
  plate?: boolean;
  /** In a row or a list's heading: the toolbar's 32, its target still a finger's 44. */
  small?: boolean;
  disabled?: boolean;
}

/** Its side: a bar that holds more of them on one side than the other balances with an empty one this wide. */
export const ICON_BUTTON_SIZE = 40;
const SIZE = ICON_BUTTON_SIZE;

/**
 * A 40-point icon button (32 in a row, `small`): transparent, or a floating glass circle (`plate`), round like the
 * system's own sheet and bar buttons: Liquid Glass on iOS 26, the blur before it, an opaque plate on Android (with a
 * hairline and a short shadow, `usePlateEdge`, so it floats over the sky or the conversation as the glass does).
 */
export function IconButton({ icon, onPress, label, plate = false, small = false, disabled = false }: IconButtonProps) {
  const { colors } = useTheme();
  const edge = usePlateEdge();
  const side = small ? TOOL_H : SIZE;
  const glyph = small ? 18 : 20;
  return (
    <PressScale
      to={0.9}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={small ? (TOUCH - TOOL_H) / 2 : 4}
      style={{ width: side, height: side, borderRadius: side / 2 }}
    >
      {plate ? (
        <Glass
          liquid
          intensity={40}
          style={[{ flexGrow: 1, borderRadius: side / 2, alignItems: "center", justifyContent: "center" }, edge]}
        >
          <Icon name={icon} size={glyph} color={colors.ink2} />
        </Glass>
      ) : (
        <View style={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={glyph} color={colors.ink2} />
        </View>
      )}
    </PressScale>
  );
}

/** The edge of an opaque plate on Android (a hairline and a short shadow); nothing on iOS, where it is glass. */
export function usePlateEdge() {
  const { colors, shadows } = useTheme();
  if (Platform.OS === "ios") return null;
  return { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line2, boxShadow: shadows.e1 };
}
