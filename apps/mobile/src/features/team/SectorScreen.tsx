import { type AgentGroup, useAgentGroupAction, useAgentGroups, useMembers } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  EmptyState,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  haptics,
  useFieldText,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { plainRole } from "../agents/logic";
import { SettingsPage } from "../settings/parts";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, goBack, successHaptic } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";

/** The picker's key for "Ninguém" (no person). */
const NOBODY = "\u0000nobody";
/** The web's name field (the server takes up to this many characters). */
const NAME_MAX = 80;

/** "Excluir setor", asked in the system's alert: its agents go back to Agentes. `done` runs once it is gone. */
export function useDeleteSector() {
  const { t } = useTranslation();
  const toast = useToast();
  const action = useAgentGroupAction(useOrgId());
  const ask = (group: AgentGroup, done?: () => void) =>
    Alert.alert(t("agentGroups.deleteTitle", { name: group.name }), t("agentGroups.deleteText"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("agentGroups.delete"),
        style: "destructive",
        onPress: () =>
          action.mutate(
            { type: "remove", groupId: group.id },
            {
              onSuccess: () => {
                haptics.medium();
                done?.();
              },
              onError: (e) => toast({ title: errorText(t, e), icon: "x" }),
            },
          ),
      },
    ]);
  return { ask, pending: action.isPending };
}

/** A setor header's "…" and long press in Agentes (who manages agents): Editar (its page) and Excluir setor. */
export function useSectorMenu() {
  const { t } = useTranslation();
  const sheet = useSheet();
  const remove = useDeleteSector();
  return (group: AgentGroup) =>
    sheet.open(
      <>
        <SheetTitle title={group.name} />
        <ActionList
          items={[
            {
              key: "edit",
              icon: "pen",
              label: t("agentGroups.rename"),
              onPress: () => {
                sheet.close();
                router.push(`/sector/${group.id}`);
              },
            },
            {
              key: "delete",
              icon: "trash",
              label: t("agentGroups.delete"),
              danger: true,
              onPress: () => {
                sheet.close();
                remove.ask(group);
              },
            },
          ]}
        />
      </>,
    );
}

/**
 * One setor (ADR 0148), from Equipe's list and a setor's menu in Agentes: its name (who manages agents renames it
 * here, saved from the bar), who cares for it and who stands in (a tap picks another person, in place, for who manages
 * agents), its agents (each opens its profile), and, last, deleting it as a red row the system's alert confirms,
 * saying its agents go back to Agentes. Its look and its channels stay on the web.
 */
export function SectorScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const words = useFieldText("body");
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const groups = useAgentGroups(orgId);
  const members = useMembers(orgId);
  const action = useAgentGroupAction(orgId);
  const remove = useDeleteSector();
  const [name, setName] = useState<string | null>(null);
  const group = groups.data?.find((g) => g.id === id);
  const manages = can(org, "manage_agents");
  if (!group) {
    return (
      <SettingsPage title={t("agentGroups.group")}>
        {groups.isLoading ? (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        ) : (
          <EmptyState size="panel" icon="members" title={t("common.loadFailed")} />
        )}
      </SettingsPage>
    );
  }
  const people = (members.data ?? []).filter((m) => m.userId);
  const nameOf = (userId: string | null | undefined) =>
    userId ? dir.nameOf({ type: "person", id: userId }) || t("channel.unknownPerson") : t("team.sectors.nobody");
  const failed = (e: unknown) => toast({ title: errorText(t, e), icon: "x" });
  // A person for the lead or the stand-in, in the app's picker: "Ninguém" first to clear it, then each person with
  // their photo and @handle, the one in place checked.
  const pick = (title: string, current: string | null | undefined, set: (userId: string | null) => void) =>
    void pickOne({
      title,
      value: current ?? NOBODY,
      options: [
        { key: NOBODY, label: t("team.sectors.nobody"), leading: { kind: "icon", name: "x" } },
        ...people.map((m) => ({
          key: m.userId,
          label: m.name,
          sub: `@${m.handle}`,
          leading: { kind: "person" as const, userId: m.userId },
        })),
      ],
    }).then((key) => {
      if (key !== null) set(key === NOBODY ? null : key);
    });
  const setPerson = (field: "leadUserId" | "backupUserId") => (userId: string | null) => {
    action.mutate({ type: "update", groupId: group.id, [field]: userId }, { onError: failed });
  };
  const renamed = (name ?? group.name).trim();
  const rename = () => {
    if (!renamed || renamed === group.name) return;
    action.mutate(
      { type: "update", groupId: group.id, name: renamed },
      {
        onSuccess: () => {
          successHaptic();
          setName(null);
        },
        onError: failed,
      },
    );
  };
  const agents = group.agentIds.flatMap((agentId) => {
    const a = dir.agentById.get(agentId);
    return a ? [a] : [];
  });
  return (
    <SettingsPage
      title={group.name}
      subtitle={t("team.agents", { count: agents.length })}
      locked={action.isPending || remove.pending}
      {...(manages && renamed && renamed !== group.name
        ? { action: { label: t("common.save"), onPress: rename, disabled: action.isPending } }
        : {})}
    >
      <GroupedHeader>{t("agentGroups.group")}</GroupedHeader>
      <GroupedList>
        {manages ? (
          <GroupedField label={t("agentGroups.nameLabel")}>
            <TextInput
              value={name ?? group.name}
              onChangeText={setName}
              maxLength={NAME_MAX}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={rename}
              accessibilityLabel={t("agentGroups.nameLabel")}
              style={[styles.input, words, { color: c.ink }]}
            />
          </GroupedField>
        ) : null}
        <GroupedRow
          icon="person"
          label={t("team.sectors.leadLabel")}
          value={nameOf(group.leadUserId)}
          {...(manages
            ? {
                menu: true,
                onPress: () => pick(t("team.sectors.leadLabel"), group.leadUserId, setPerson("leadUserId")),
              }
            : {})}
        />
        <GroupedRow
          icon="members"
          label={t("team.sectors.backupLabel")}
          value={nameOf(group.backupUserId)}
          {...(manages
            ? {
                menu: true,
                onPress: () => pick(t("team.sectors.backupLabel"), group.backupUserId, setPerson("backupUserId")),
              }
            : {})}
        />
      </GroupedList>
      {!group.leadUserId ? <GroupedFooter>{t("team.sectors.gap.noLead")}</GroupedFooter> : null}
      <GroupedHeader>{t("mobile.agents.title")}</GroupedHeader>
      <GroupedList>
        {agents.map((a) => {
          // What it does in plain words, else its role; nothing under the name when it has neither.
          const does = plainRole(a.instructions) ?? a.role.trim();
          return (
            <GroupedRow
              key={a.id}
              leading={<AgentFace agentId={a.id} size={36} live={false} />}
              label={a.name}
              {...(does ? { sub: does } : {})}
              chevron
              onPress={() => router.push(`/agent/${a.id}`)}
            />
          );
        })}
        {agents.length === 0 ? <GroupedRow label={t("team.sectors.none")} faint /> : null}
      </GroupedList>
      {manages ? (
        <View style={styles.apart}>
          <GroupedList>
            <GroupedRow label={t("agentGroups.delete")} danger onPress={() => remove.ask(group, goBack)} />
          </GroupedList>
        </View>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
  apart: { marginTop: 24 },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
});
