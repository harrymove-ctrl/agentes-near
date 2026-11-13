import {
  useRoles,
  useUpdateVaultConnection,
  useUpdateVaultItem,
  useVault,
  useVaultItem,
  type VaultAccess,
  type VaultScope,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { isEveryone, sortRoles } from "@agenteschat/client/lib/roles";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GroupedFooter, useToast } from "@/ui";
import { Note } from "../ai/parts";
import { SettingsPage } from "../settings/parts";
import { AccessList, type AccessListRow } from "../shared/AccessList";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { accessProblem, accessSentence, forScope, sameAccess } from "./logic";
import { AgentRows, useVaultNames } from "./parts";

type Level = "in" | "out";

/**
 * Who has access to an item (`?id=`) or, by default, to a connection's items (`?connection=`), ADR 0144 §2: for the
 * team's, everyone in the workspace or the roles and people chosen (on the shared `AccessList`); for both, the agents
 * that may use it, one switch each. The sentence at the end says what it adds up to before it's saved.
 */
export function VaultAccessScreen({ itemId, connectionId }: { itemId?: string; connectionId?: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const item = useVaultItem(orgId, itemId ?? null);
  const vault = useVault(orgId, Boolean(connectionId));
  const connection = connectionId ? vault.data?.connections.find((x) => x.id === connectionId) : undefined;
  const target = itemId ? item.data : connection;
  const failed = itemId ? item.isError : vault.isError || (vault.isSuccess && !connection);
  if (!target) {
    return (
      <SettingsPage title={t("mobile.vault.access.title")}>
        {failed ? (
          <View style={styles.note}>
            <Note icon="x">{t("common.loadFailed")}</Note>
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )}
      </SettingsPage>
    );
  }
  return (
    <AccessForm
      key={target.id}
      scope={target.scope}
      initial={target.access}
      {...(itemId ? { itemId } : {})}
      {...(connectionId ? { connectionId } : {})}
    />
  );
}

function AccessForm({
  scope,
  initial,
  itemId,
  connectionId,
}: {
  scope: VaultScope;
  initial: VaultAccess;
  itemId?: string;
  connectionId?: string;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const dir = useDirectory();
  const names = useVaultNames();
  const roles = useRoles(orgId);
  const updateItem = useUpdateVaultItem(orgId);
  const updateConnection = useUpdateVaultConnection(orgId);
  const [draft, setDraft] = useState<VaultAccess>(initial);
  const changed = !sameAccess(forScope(draft, scope), forScope(initial, scope));
  const busy = updateItem.isPending || updateConnection.isPending;

  const save = () => {
    const access = forScope(draft, scope);
    const problem = accessProblem(access);
    if (problem) return toast({ title: t(problem), icon: "x" });
    const done = {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("mobile.vault.access.saved") });
        goBack();
      },
      onError: (err: unknown) => toast({ title: errorText(t, err, i18n.language), icon: "x" }),
    };
    if (itemId) updateItem.mutate({ itemId, access }, done);
    else if (connectionId) updateConnection.mutate({ connectionId, access }, done);
  };

  const levelName = (level: Level) =>
    level === "in" ? t("mobile.vault.access.levelIn") : t("mobile.vault.access.levelOut");
  const pick = (list: "roleIds" | "userIds", id: string): AccessListRow<Level> => {
    const on = draft[list].includes(id);
    return {
      key: id,
      icon: list === "roleIds" ? "shield" : "person",
      label: list === "roleIds" ? names.role(id) : names.person(id),
      ...(list === "userIds" && dir.memberById.get(id)?.email ? { hint: dir.memberById.get(id)?.email ?? "" } : {}),
      level: on ? "in" : "out",
      levels: ["out", "in"],
      onChange: (next) =>
        setDraft((d) => ({
          ...d,
          [list]: next === "in" ? [...d[list].filter((x) => x !== id), id] : d[list].filter((x) => x !== id),
        })),
    };
  };
  const roleList = sortRoles((roles.data?.roles ?? []).filter((r) => !isEveryone(r)));
  const people = [...dir.memberById.values()];

  return (
    <SettingsPage
      title={connectionId ? t("mobile.vault.access.defaultTitle") : t("mobile.vault.access.title")}
      locked={busy}
      action={{ label: t("common.save"), onPress: save, disabled: !changed || busy }}
    >
      <GroupedFooter>
        {connectionId
          ? t("mobile.vault.access.defaultText")
          : scope === "personal"
            ? t("mobile.vault.scope.personalText")
            : t("mobile.vault.access.teamText")}
      </GroupedFooter>
      {scope === "team" ? (
        <View style={styles.bleed}>
          <AccessList
            title={t("mobile.vault.access.people")}
            levelName={(level: Level) =>
              level === "in" ? t("mobile.vault.access.everyoneIn") : t("mobile.vault.access.everyoneOut")
            }
            rows={[
              {
                key: "everyone",
                icon: "members",
                label: t("mobile.vault.access.everyone"),
                hint: t("mobile.vault.access.everyoneText"),
                level: draft.everyone ? "in" : "out",
                levels: ["in", "out"],
                onChange: (next) => setDraft((d) => ({ ...d, everyone: next === "in" })),
              },
            ]}
          />
          {draft.everyone ? null : (
            <>
              <AccessList
                title={t("mobile.vault.access.roles")}
                levelName={levelName}
                rows={roleList.map((r) => pick("roleIds", r.id))}
              />
              <AccessList
                title={t("mobile.vault.access.persons")}
                levelName={levelName}
                rows={people.map((m) => pick("userIds", m.userId))}
              />
            </>
          )}
          <View style={styles.inset}>
            <GroupedFooter>
              {draft.everyone ? t("mobile.vault.access.everyoneHelp") : t("mobile.vault.access.managersHelp")}
            </GroupedFooter>
          </View>
        </View>
      ) : null}
      <AgentRows scope={scope} access={draft} onChange={setDraft} disabled={busy} />
      <GroupedFooter>{accessSentence(t, scope, forScope(draft, scope), names)}</GroupedFooter>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginVertical: 16 },
  // The shared access list brings its own side margins; the settings page has them already.
  bleed: { marginHorizontal: -16 },
  inset: { paddingHorizontal: 16 },
});
