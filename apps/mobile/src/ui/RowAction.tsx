import { type AccessibilityRole, Text as RNText, StyleSheet, View } from "react-native";
import { PressScale } from "./PressScale";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/**
 * A row's action beside a line (Abrir on a team check, "Deixar Ana falar com ela" under a mention's reach): words
 * only, as tall as the line's first row so they share a middle. `onPress` brings its own haptic, if any.
 */
export function RowAction({
  label,
  onPress,
  accessibilityLabel,
  accessibilityRole = "button",
  strong = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  /** Read aloud instead of the label. */
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  /** The row's main action among several (Send beside Not now): its word in ink. */
  strong?: boolean;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <PressScale
      to={0.95}
      haptic={false}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={6}
      style={styles.row}
    >
      {/* The press area fills the row; the word alone in it sat at its top. */}
      <View style={styles.face}>
        <RNText
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={[systemText("footnote", weights.semibold), { color: strong ? colors.ink : colors.muted }]}
        >
          {label}
        </RNText>
      </View>
    </PressScale>
  );
}

/** The room around the action's word inside its press area. */
const FACE_PAD = 4;

/**
 * The side padding of a card whose row can end in a `RowAction` (a team check, a mention's reach): its first icon and
 * the action's word as far from the card's edges, 12 each.
 */
export const ROW_CARD_INSET = { paddingLeft: 12, paddingRight: 12 - FACE_PAD } as const;

const styles = StyleSheet.create({
  row: { height: 32 },
  face: { flexGrow: 1, paddingHorizontal: FACE_PAD, alignItems: "center", justifyContent: "center" },
});
