import { StyleSheet, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Icon, Text, useTheme } from "@/ui";

/** What went wrong, in the sheet itself (a toast would sit under it). */
export function Problem({ text }: { text: string }) {
  const { colors, reducedMotion } = useTheme();
  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeIn.duration(180)}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.notice, { borderColor: colors.line }]}
    >
      <View style={[styles.badge, { backgroundColor: colors.danger }]}>
        {/* The page's own color on the red: white on dark's light red was hard to read. */}
        <Icon name="x" size={16} color={colors.bg} />
      </View>
      <Text variant="small" style={styles.grow}>
        {text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  // A neutral card with a colored badge, as the sheet's other outcomes.
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
});
