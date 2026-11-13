import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Count } from "./Count";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { weights } from "./type-scale";

export interface SectionProps {
  title: string;
  count?: number;
  action?: { label: string; onPress: () => void };
  children?: ReactNode;
}

/** A titled block of the screen (header in faint, the count beside it, an optional action on the right). */
export function Section({ title, count, action, children }: SectionProps) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingBottom: 10 }}>
        <Text variant="label" accessibilityRole="header" style={{ flexShrink: 1 }}>
          {title}
        </Text>
        {count !== undefined ? <Count value={count} size={13} weight={weights.medium} color={colors.faint} /> : null}
        <View style={{ flex: 1 }} />
        {action ? (
          // The label's line is 18 tall: 13 of slop around it gives the 44-point target; it dims under the finger.
          <Pressable
            onPress={action.onPress}
            accessibilityRole="button"
            hitSlop={13}
            style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
          >
            <Text variant="label" tone="muted">
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}
