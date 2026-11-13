import { StyleSheet, TextInput, View } from "react-native";
import { fieldText, GROUPED_ROW, Icon, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/**
 * An agent's @ field (a new agent's, Editar's Menções): the @ drawn before what is typed. `grouped`: a row of a
 * grouped list, which draws the surface; `ok` checks a free @ at its end.
 */
export function HandleInput({
  value,
  onChangeText,
  label,
  placeholder,
  grouped = false,
  ok = false,
}: {
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  placeholder?: string;
  grouped?: boolean;
  ok?: boolean;
}) {
  const c = useColors();
  return (
    <View
      style={
        grouped
          ? [styles.affix, styles.row]
          : [styles.affix, styles.field, { backgroundColor: c.raised, borderColor: c.line }]
      }
    >
      <Text variant="body" tone="faint">
        @
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        maxLength={32}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={label}
        style={[styles.affixInput, grouped && styles.rowInput, fieldText("body"), { color: c.ink }]}
      />
      {ok ? <Icon name="check" size={18} color={c.ok} /> : null}
    </View>
  );
}

/** What keeps a field from going through, in the danger color, read out when it shows. */
export function ErrorLine({ text }: { text: string }) {
  const c = useColors();
  return (
    <Text variant="footnote" style={{ color: c.danger }} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  affix: { flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 14 },
  field: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  row: { minHeight: GROUPED_ROW.minHeight, paddingHorizontal: GROUPED_ROW.padX },
  affixInput: { flex: 1, paddingVertical: 12 },
  rowInput: { paddingVertical: GROUPED_ROW.tallPadY },
});
