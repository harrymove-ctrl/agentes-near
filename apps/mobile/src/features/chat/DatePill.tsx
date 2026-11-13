import { dayLabel } from "@agenteschat/client/lib/format";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { Text, useTheme } from "@/ui";

/** How long the floating date stays once the list stops (as the web's `DATE_PILL_IDLE_MS`). */
export const DATE_PILL_IDLE_MS = 1200;

/**
 * The day of the messages at the top of the list, floating at its top centre while the person scrolls (as WhatsApp
 * does): "Hoje", "Ontem", a weekday this week, else a date in the person's locale. `shown` fades it; the day lines in
 * the list say it to screen readers.
 */
export function DatePill({ day, shown, top }: { day: string | null; shown: SharedValue<number>; top: number }) {
  const { t, i18n } = useTranslation();
  const { colors, shadows } = useTheme();
  const style = useAnimatedStyle(() => ({ opacity: shown.value }));
  if (!day) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.dock, { top }, style]}
    >
      <View style={[styles.pill, { backgroundColor: colors.raised, borderColor: colors.line2, boxShadow: shadows.e1 }]}>
        <Text variant="footnote" tone="muted" style={styles.text}>
          {dayLabel(t, i18n.language || "en", day)}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dock: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  pill: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  text: { fontWeight: "600" },
});
