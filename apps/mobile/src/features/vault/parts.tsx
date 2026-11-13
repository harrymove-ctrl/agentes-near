import { useRoles, type VaultAccess, type VaultScope } from "@agenteschat/client";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, type TextInputProps, View } from "react-native";
import {
  Button,
  fieldText,
  GROUPED_ROW,
  GroupedField,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  OPTION_ROW,
  Text,
} from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, MONO } from "../shared/parts";
import { agentOn, type Names, toggleAgent } from "./logic";

/*
 * What the Vault's screens share (ADR 0144): names for the summaries, a field row, the scope choice, the agents'
 * switches, and a saved value, always behind its dots.
 */

/** Agents', roles' and people's names for the summaries (unknown ones still read as someone). */
export function useVaultNames(): Names {
  const { t } = useTranslation();
  const dir = useDirectory();
  const roles = useRoles(useOrgId()).data?.roles;
  return useMemo(
    () => ({
      agent: (id: string) => dir.anyAgent(id)?.name ?? t("channel.unknownAgent"),
      person: (id: string) => dir.memberById.get(id)?.name ?? t("channel.unknownPerson"),
      role: (id: string) => roles?.find((r) => r.id === id)?.name ?? "",
    }),
    [dir, roles, t],
  );
}

/** The workspace's agents that can be picked (not archived or deleted). */
export function usePickableAgents() {
  const dir = useDirectory();
  return useMemo(() => dir.agents.filter((a) => !a.former), [dir.agents]);
}

/** A labeled field row with its input (read-only as plain text when it can't change). */
export function InputField({
  label,
  value,
  onChange,
  editable = true,
  mono = false,
  hint,
  ...input
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  editable?: boolean;
  /** Code (a variable's name). */
  mono?: boolean;
  /** What the field is for, behind an ⓘ beside its label. */
  hint?: { name: string; text: string };
} & Pick<
  TextInputProps,
  | "placeholder"
  | "maxLength"
  | "keyboardType"
  | "autoCapitalize"
  | "secureTextEntry"
  | "textContentType"
  | "autoComplete"
  | "autoFocus"
  | "inputMode"
>) {
  const c = useColors();
  const font = mono ? styles.mono : fieldText("callout");
  return (
    <GroupedField label={label} {...(hint ? { hint } : {})}>
      {editable ? (
        <TextInput
          value={value}
          onChangeText={onChange}
          autoCorrect={false}
          spellCheck={false}
          placeholderTextColor={c.faint}
          accessibilityLabel={label}
          style={[font, styles.input, { color: c.ink }]}
          {...input}
        />
      ) : (
        <Text variant="callout" selectable numberOfLines={2} style={[mono ? styles.mono : null, styles.readOnly]}>
          {value}
        </Text>
      )}
    </GroupedField>
  );
}

/** "Personal" or "Team": the team only for who manages the workspace's keys (`manage_credentials`). */
export function ScopeRows({
  scope,
  onChange,
  canTeam,
}: {
  scope: VaultScope;
  onChange: (scope: VaultScope) => void;
  canTeam: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <GroupedHeader>{t("mobile.vault.scope.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="lock"
          label={t("mobile.vault.scope.personal")}
          sub={t("mobile.vault.scope.personalText")}
          subLines={2}
          media
          checked={scope === "personal"}
          onPress={() => onChange("personal")}
        />
        <GroupedRow
          icon="members"
          label={t("mobile.vault.scope.team")}
          sub={canTeam ? t("mobile.vault.scope.teamText") : t("mobile.vault.scope.teamLocked")}
          subLines={2}
          media
          checked={scope === "team"}
          disabled={!canTeam}
          faint={!canTeam}
          onPress={() => onChange("team")}
        />
      </GroupedList>
    </>
  );
}

/**
 * The agents that may use it: "All agents" (new ones included), then each agent's own switch, which "All agents"
 * keeps on. Personal items say they're used only when their owner asks.
 */
export function AgentRows({
  scope,
  access,
  onChange,
  disabled = false,
}: {
  scope: VaultScope;
  access: VaultAccess;
  onChange: (access: VaultAccess) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const agents = usePickableAgents();
  return (
    <>
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("mobile.vault.agents.title") }),
          text: scope === "personal" ? t("mobile.vault.agents.personalHelp") : t("mobile.vault.agents.teamHelp"),
        }}
      >
        {t("mobile.vault.agents.title")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="agent"
          label={t("mobile.vault.access.allAgents")}
          sub={t("mobile.vault.agents.allText")}
          subLines={2}
          media
          toggle={access.allAgents}
          disabled={disabled}
          onPress={() => onChange({ ...access, allAgents: !access.allAgents })}
        />
        {agents.map((a) => (
          <GroupedRow
            key={a.id}
            leading={<AgentFace agentId={a.id} size={32} live={false} />}
            label={a.name}
            {...(a.role ? { sub: a.role } : {})}
            toggle={agentOn(access, a.id)}
            disabled={disabled || access.allAgents}
            onPress={() => onChange(toggleAgent(access, a.id))}
          />
        ))}
      </GroupedList>
    </>
  );
}

/**
 * The agents' switches in the request card's sheet (a short choice over the conversation): it keeps its own state
 * and tells the card each change.
 */
export function AgentPickSheet({
  initial,
  onChange,
  onDone,
}: {
  initial: Pick<VaultAccess, "allAgents" | "agentIds">;
  onChange: (pick: Pick<VaultAccess, "allAgents" | "agentIds">) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const agents = usePickableAgents();
  const [pick, setPick] = useState(initial);
  const change = (next: Pick<VaultAccess, "allAgents" | "agentIds">) => {
    setPick(next);
    onChange(next);
  };
  return (
    <>
      <SheetTitle title={t("mobile.vault.agents.title")} subtitle={t("mobile.vault.card.agentsText")} />
      <ActionList
        items={[
          {
            key: "all",
            icon: "agent",
            label: t("mobile.vault.access.allAgents"),
            checked: pick.allAgents,
            onPress: () => change({ ...pick, allAgents: !pick.allAgents }),
          },
          ...agents.map((a) => ({
            key: a.id,
            leading: <AgentFace agentId={a.id} size={OPTION_ROW.face} live={false} />,
            label: a.name,
            ...(a.role ? { hint: a.role } : {}),
            checked: agentOn(pick, a.id),
            disabled: pick.allAgents,
            onPress: () => {
              const on = pick.agentIds.includes(a.id);
              change({ ...pick, agentIds: on ? pick.agentIds.filter((id) => id !== a.id) : [...pick.agentIds, a.id] });
            },
          })),
        ]}
      />
      <Button variant="primary" wide label={t("mobile.common.done")} onPress={onDone} />
    </>
  );
}

/** A saved password or key, always hidden: once saved, it never comes back to a screen (ADR 0144 §2). */
export function SavedValue({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <GroupedField label={label}>
      <View style={styles.valueRow}>
        <Text
          variant="callout"
          numberOfLines={1}
          style={styles.grow}
          accessibilityLabel={t("mobile.vault.item.hidden")}
        >
          ••••••••••
        </Text>
        <Text variant="footnote" tone="faint">
          {t("mobile.vault.item.saved")}
        </Text>
      </View>
    </GroupedField>
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, paddingVertical: GROUPED_ROW.tallPadY, paddingHorizontal: 0 },
  readOnly: { paddingVertical: GROUPED_ROW.tallPadY },
  mono: { fontFamily: MONO, fontSize: 14 },
  grow: { flex: 1, minWidth: 0 },
  valueRow: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: GROUPED_ROW.minHeight },
});
