import { Pressable, StyleSheet, View } from "react-native";
import { ACT_LINE } from "./ActLine";
import { Count } from "./Count";
import { Icon } from "./Icon";
import { SCREEN_X } from "./rhythm";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { weights } from "./type-scale";

export interface SectionHeaderProps {
  title: string;
  count?: number;
  /**
   * A way on at the header's right ("Gerenciador de tarefas ›"), as Meu Início's "Ver todos ›". `chevron: false`
   * for an act done in place (the recent searches' "Clear"): it goes nowhere, so it has no chevron.
   */
  action?: { label: string; onPress: () => void; chevron?: boolean } | null;
}

/**
 * The header over a full-width list, as Conversas' sections: 15 semibold ink, the count after it (medium, faint), and a
 * way on at its right (medium, faint, with its chevron), under the title from its start once the title takes more
 * than its line (`ACT_LINE`).
 */
export function SectionHeader({ title, count, action }: SectionHeaderProps) {
  const { colors } = useTheme();
  return (
    <View style={[ACT_LINE.row, styles.h]}>
      <Text variant="small" tone="ink" accessibilityRole="header" style={[ACT_LINE.text, styles.title]}>
        {title}
        {/* In the title's words, so a wrapped title keeps it on its last line; an en space, the row's 8. */}
        {count !== undefined ? (
          <>
            {"\u2002"}
            <Count value={count} size={15} weight={weights.medium} color={colors.faint} />
          </>
        ) : null}
      </Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={12}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text variant="small" tone="faint" style={styles.actionText}>
            {action.label}
          </Text>
          {action.chevron === false ? null : <Icon name="right" size={15} color={colors.faint} />}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The way on sits on the title's baseline. At the screen's sides (SCREEN_X), 24 above and 8 below: the lists' rhythm
  // in eights.
  h: {
    alignItems: "baseline",
    columnGap: 16,
    rowGap: 8,
    paddingTop: 24,
    paddingHorizontal: SCREEN_X,
    paddingBottom: 8,
  },
  title: { fontWeight: "600" },
  action: { flexDirection: "row", alignItems: "baseline", gap: 2 },
  actionText: { fontWeight: weights.medium },
  pressed: { opacity: 0.6 },
});
