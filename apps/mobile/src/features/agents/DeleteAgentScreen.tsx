import { keys, useApi } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { matchesName } from "@agenteschat/client/lib/text";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native";
import { EmptyState, GroupedList, GroupedRow, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Gap, SettingsPage } from "../settings/parts";
import { useDirectory, useOrgId } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";

/** Opens "Apagar" for an agent; with `proposal`, Apagar accepts that removal card's row instead (applied as you). */
export const openAgentDelete = (id: string, proposal?: string) =>
  router.push({ pathname: "/agent-delete", params: proposal ? { id, proposal } : { id } });

/**
 * Deleting an agent for good (ADR 0082), as the web's Configurações › Zona de perigo: what goes and what stays, its
 * name typed to confirm, then the row that deletes it. Admins reach it from "Editar agente", and an archived agent's
 * (it has no profile) from Agentes › Arquivados.
 */
export function DeleteAgentScreen({ id, proposal }: { id: string; proposal?: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const orgId = useOrgId();
  const found = useDirectory().anyAgent(id);
  const agent = found?.former === "deleted" ? undefined : found;
  const [typed, setTyped] = useState("");
  const purge = useMutation({
    mutationFn: async () => {
      if (proposal) await api.proposals.accept(orgId, proposal);
      else await api.agents.purge(orgId, id);
    },
  });

  if (!agent) {
    return (
      <SettingsPage title={t("agent.edit")}>
        <EmptyState icon="agent" title={t("mobile.agentEdit.missing")} />
      </SettingsPage>
    );
  }
  const g = agentGrammar(agent.name);
  const ready = matchesName(typed, agent.name) && !purge.isPending;
  const confirm = () => {
    if (!ready) return;
    purge.mutate(undefined, {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("agentPage.delete.done", g), icon: "check" });
        void qc.invalidateQueries({ queryKey: keys.agents(orgId) });
        if (proposal) {
          void qc.invalidateQueries({ queryKey: keys.proposals(orgId) });
          router.back();
        } else router.dismissTo("/agents");
      },
    });
  };

  return (
    <SettingsPage title={t("agentPage.delete.title", g)} locked={purge.isPending}>
      <GroupedList>
        <GroupedRow icon="x" label={t("agentPage.delete.goes")} labelLines={4} />
        <GroupedRow icon="chat" label={t("agentPage.delete.stays")} labelLines={4} />
      </GroupedList>
      <Gap />
      <TextArea
        value={typed}
        onChangeText={(v) => {
          setTyped(v);
          purge.reset();
        }}
        placeholder={t("agentPage.delete.typeName", g)}
        multiline={false}
        minHeight={50}
        maxLength={64}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={confirm}
        accessibilityLabel={t("agentPage.delete.typeName", g)}
      />
      {purge.error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {errorText(t, purge.error)}
        </Text>
      ) : null}
      <Gap />
      <GroupedList>
        <GroupedRow icon="x" label={t("agentPage.delete.button")} danger disabled={!ready} onPress={confirm} />
      </GroupedList>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  error: { paddingHorizontal: 16, paddingTop: 8 },
});
