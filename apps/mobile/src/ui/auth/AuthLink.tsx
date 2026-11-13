import { Pressable, View } from "react-native";
import { Text } from "../Text";
import { useTheme } from "../theme";

/** "No account yet? Create account": a quiet line with one link. */
export function AuthLink({ lead, label, onPress }: { lead?: string; label: string; onPress: () => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
      {lead ? (
        <Text variant="subhead" tone="muted">
          {lead}
        </Text>
      ) : null}
      {/* A 20-point line: 12 of slop around it reaches the 44-point target. */}
      <Pressable
        onPress={onPress}
        accessibilityRole="link"
        hitSlop={12}
        style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
      >
        <Text variant="subhead" style={{ fontWeight: "600" }}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

/** A thin "or" between the main answer and the social buttons. */
export function OrDivider({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 6 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <Text variant="caption" style={{ fontWeight: "500" }}>
        {label}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}
