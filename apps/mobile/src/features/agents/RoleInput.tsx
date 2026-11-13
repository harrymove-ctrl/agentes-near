import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput } from "react-native";
import { fieldText, GROUPED_ROW, GroupedHeader, GroupedList, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/**
 * An agent's role as Criar agente and Editar ask it, up to the API's 200 characters. `grouped`: a field of a grouped
 * list, its label the group's header (Create agent, on the grouped gray).
 */
export function RoleInput({
  value,
  onChangeText,
  placeholder,
  grouped = false,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  grouped?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const field = (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      maxLength={200}
      placeholder={placeholder}
      placeholderTextColor={c.faint}
      accessibilityLabel={t("agent.roleLabel")}
      style={
        grouped
          ? [styles.row, fieldText("body"), { color: c.ink }]
          : [styles.input, fieldText("body"), { backgroundColor: c.raised, color: c.ink, borderColor: c.line }]
      }
    />
  );
  if (grouped)
    return (
      <>
        <GroupedHeader>{t("agent.roleLabel")}</GroupedHeader>
        <GroupedList>{field}</GroupedList>
      </>
    );
  return (
    <>
      <Text variant="footnote" tone="faint" style={styles.label}>
        {t("agent.roleLabel")}
      </Text>
      {field}
    </>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: 10 },
  input: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12 },
  row: { minHeight: GROUPED_ROW.minHeight, paddingHorizontal: GROUPED_ROW.padX, paddingVertical: GROUPED_ROW.tallPadY },
});
