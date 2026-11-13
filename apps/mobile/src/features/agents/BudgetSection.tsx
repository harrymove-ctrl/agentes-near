import { type Agent, useUpdateAgent } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { readBudget } from "@agenteschat/client/lib/new-agent";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { fieldText, Text, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useColors, useOrgId } from "../shared/hooks";

/** The web's Orçamento mensal, where a spent budget's "Aumentar orçamento" lands: saved at once by who manages agents. */
export function BudgetSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const failed = useFailed();
  const update = useUpdateAgent(useOrgId(), agent.id);
  const [typed, setTyped] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const save = () => {
    const { amount, invalid } = readBudget(typed);
    if (invalid) return toast({ title: t("agent.budgetInvalid"), icon: "x" });
    if (amount !== (agent.monthlyBudgetUsd ?? null)) update.mutate({ monthlyBudgetUsd: amount }, { onError: failed });
  };
  return (
    <View style={styles.section}>
      <Text variant="title" accessibilityRole="header">
        {t("rightHand.settings.budget")}
      </Text>
      <View style={[styles.field, { backgroundColor: c.raised }]}>
        <Text variant="body" tone="muted">
          US$
        </Text>
        <TextInput
          value={typed}
          onChangeText={setTyped}
          onEndEditing={save}
          keyboardType="decimal-pad"
          placeholder={t("rightHand.value.budgetDefault")}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("rightHand.settings.budget")}
          style={[styles.amount, fieldText("body"), { color: c.ink }]}
        />
        <Text variant="body" tone="muted">
          {t("rightHand.settings.perMonth")}
        </Text>
      </View>
      <Text variant="footnote" tone="faint">
        {t("agent.budgetHelp", { ...agentGrammar(agent.name), ownerNote: "" }).trim()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 22, gap: 10 },
  field: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 14, paddingHorizontal: 14, minHeight: 48 },
  amount: { flex: 1, paddingVertical: 12 },
});
