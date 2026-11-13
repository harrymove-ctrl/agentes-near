import { keys, type Me, useUpdateSettings, type WorkspaceMode } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { modeSwitchLines } from "@agenteschat/client/lib/personal-view";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GROUPED_ROW,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Text,
  useToast,
} from "@/ui";
import { Note } from "../ai/parts";
import { useColors } from "../shared/hooks";
import { errorHaptic, goBack, successHaptic } from "../shared/parts";
import { usePersonalView } from "./hooks";
import { MODE_LINE_ICON } from "./logic";
import { Gap, SettingsPage } from "./parts";

/**
 * Switching the workspace between team and personal (ADR 0159 §4), the web's dialog as a pushed screen: from About
 * you (General in a team's) and from inviting people you work with to a personal workspace, for who configures it.
 * Going to a team's it says what comes into sight and asks the workspace's name; going to personal it says what
 * changes and, with other members, that they see it too. What stays is said apart. Only the view changes: every
 * agent, conversation, file and permission stays as it is, and every member's apps reshape on the server's `org.mode`.
 * Done, it goes back where it came from (inviting goes on there, now in a team's words).
 */
export function ModeScreen() {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const update = useUpdateSettings(orgId);
  const qc = useQueryClient();
  const { others } = usePersonalView();
  // The way it goes is set as the screen opens: the switch changes the workspace's mode before this screen leaves.
  const [to] = useState<WorkspaceMode>(() => (isPersonal(org) ? "team" : "personal"));
  const [name, setName] = useState(org?.name ?? "");
  const editable = can(org, "configure");
  const team = to === "team";
  const words = team ? "toTeam" : "toPersonal";
  const named = name.trim();
  const ready = editable && (!team || named.length > 0);
  const submit = () => {
    if (!ready || update.isPending) return;
    const patch = team ? { mode: to, ...(named !== org?.name ? { name: named } : {}) } : { mode: to };
    update.mutate(patch, {
      onSuccess: (settings) => {
        // The workspace takes its new shape before this screen leaves, as the server's `org.mode` does for everyone:
        // inviting, under it, goes on in a team's words.
        qc.setQueryData<Me>(keys.me, (me) =>
          me ? { ...me, organizations: me.organizations.map((o) => (o.id === orgId ? { ...o, mode: to } : o)) } : me,
        );
        successHaptic();
        toast({
          title: team ? t("personalMode.toTeam.done", { name: settings.name }) : t("personalMode.toPersonal.done"),
          icon: "check",
        });
        goBack();
      },
      onError: () => {
        errorHaptic();
        toast({ title: t("mobile.app.failed"), icon: "x" });
      },
    });
  };

  return (
    <SettingsPage title={t(`personalMode.${words}.title`)} locked={update.isPending}>
      <Gap />
      <Text variant="body" tone="ink2" style={styles.intro}>
        {t(`personalMode.${words}.lead`)}
      </Text>
      <Gap />
      <GroupedList>
        {modeSwitchLines(to, others ?? 0).map((line) => (
          <GroupedRow
            key={line.key}
            icon={MODE_LINE_ICON[line.icon]}
            label={t(line.key, { count: line.count })}
            labelLines={3}
          />
        ))}
      </GroupedList>
      <GroupedFooter>{t(`personalMode.${words}.stays`)}</GroupedFooter>
      {team && editable ? (
        <>
          <GroupedHeader>{t("personalMode.toTeam.name")}</GroupedHeader>
          <GroupedList>
            <TextInput
              value={name}
              onChangeText={setName}
              onSubmitEditing={submit}
              maxLength={80}
              autoCapitalize="words"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="done"
              selectTextOnFocus
              accessibilityLabel={t("personalMode.toTeam.name")}
              style={[styles.field, fieldText("body"), { color: c.ink }]}
            />
          </GroupedList>
        </>
      ) : null}
      <View style={styles.action}>
        {editable ? (
          <Button
            variant="primary"
            wide
            label={t(`personalMode.${words}.confirm`)}
            disabled={!ready}
            loading={update.isPending}
            onPress={submit}
          />
        ) : (
          <Note icon="lock">{t("settings.readOnly")}</Note>
        )}
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  intro: { paddingHorizontal: 16 },
  field: {
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.tallPadY,
  },
  action: { paddingTop: 24 },
});
