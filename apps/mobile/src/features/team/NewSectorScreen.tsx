import { useAgentGroupAction } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput } from "react-native";
import { GroupedField, GroupedList, useFieldText, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Gap, SettingsPage } from "../settings/parts";
import { useColors, useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";

/** The web's name field (the server takes up to this many characters). */
const NAME_MAX = 80;

/** The first setor from the phone: its name is all it needs. Its color, icon and lead are set on the web. */
export function NewSectorScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const words = useFieldText("body");
  const toast = useToast();
  const action = useAgentGroupAction(useOrgId());
  const [name, setName] = useState("");
  const save = () => {
    if (!name.trim() || action.isPending) return;
    action.mutate(
      { type: "create", name: name.trim() },
      {
        onSuccess: () => {
          successHaptic();
          router.back();
        },
        onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
      },
    );
  };
  return (
    <SettingsPage
      title={t("agentGroups.newGroup")}
      action={{ label: t("agentGroups.create"), onPress: save, disabled: action.isPending || !name.trim() }}
    >
      <Gap />
      <GroupedList>
        <GroupedField label={t("agentGroups.nameLabel")}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={t("agentGroups.namePlaceholder")}
            placeholderTextColor={c.faint}
            maxLength={NAME_MAX}
            editable={!action.isPending}
            autoFocus
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={save}
            style={[styles.input, words, { color: c.ink }]}
          />
        </GroupedField>
      </GroupedList>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
});
