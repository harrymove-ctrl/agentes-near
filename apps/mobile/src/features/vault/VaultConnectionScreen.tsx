import { useDeleteVaultConnection, useSyncVaultConnection, useVault } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { confirmAction, Gap, SettingsPage } from "../settings/parts";
import { useColors, useNow, useOrgId } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { accessSentence, agentsSummary, connectionLine, connectionState, peopleSummary, vaultHref } from "./logic";
import { useVaultNames } from "./parts";

/**
 * A connected password manager (ADR 0144 §3): how it is (connected, syncing, or what went wrong in plain words), what
 * it reads and when it last did, "Sync now", Reconnect, the default access its items follow, and Disconnect.
 */
export function VaultConnectionScreen({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const toast = useToast();
  const names = useVaultNames();
  const now = useNow(60_000);
  const vault = useVault(orgId);
  const sync = useSyncVaultConnection(orgId);
  const remove = useDeleteVaultConnection(orgId);
  const conn = vault.data?.connections.find((x) => x.id === id);
  if (!conn) {
    return (
      <SettingsPage title={t("settings.section.vault")}>
        {vault.isError || vault.isSuccess ? (
          <View style={styles.note}>
            <Note icon="x">{vault.isError ? t("common.loadFailed") : t("mobile.vault.connection.gone")}</Note>
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )}
      </SettingsPage>
    );
  }
  const failed = (err: unknown) => toast({ title: errorText(t, err, i18n.language), icon: "x" });
  const state = connectionState(conn);
  const editable = conn.can.edit;
  const syncing = conn.status === "syncing" || sync.isPending;
  const scopeName = conn.scope === "personal" ? t("mobile.vault.tab.personal") : t("mobile.vault.tab.team");
  const openAccess = () => router.push(vaultHref.connectionAccess(conn.id) as never);
  const askDisconnect = () =>
    confirmAction({
      title: t("mobile.vault.connection.disconnectTitle", { name: conn.name }),
      text: t("mobile.vault.connection.disconnectText", { name: conn.name, count: conn.itemCount }),
      action: t("mobile.vault.connection.disconnect"),
      cancel: t("mobile.common.cancel"),
      onConfirm: () =>
        remove.mutate(conn.id, {
          onSuccess: () => {
            successHaptic();
            toast({ title: t("mobile.vault.connection.disconnected", { name: conn.name }) });
            goBack();
          },
          onError: failed,
        }),
    });

  return (
    <SettingsPage title={conn.name} subtitle={scopeName}>
      <Gap />
      <GroupedList>
        <GroupedRow
          icon={state.icon}
          label={t(state.key)}
          labelLines={3}
          sub={connectionLine(t, i18n.language, conn, new Date(now))}
          subLines={2}
        />
        {editable ? (
          <GroupedRow
            icon="down"
            label={syncing ? t("mobile.vault.connection.syncing") : t("mobile.vault.connection.sync")}
            disabled={syncing}
            onPress={() =>
              sync.mutate(conn.id, {
                onSuccess: (done) =>
                  toast({
                    title:
                      done.status === "error" ? t(connectionState(done).key) : t("mobile.vault.connection.syncDone"),
                    icon: done.status === "error" ? "x" : "check",
                  }),
                onError: failed,
              })
            }
          />
        ) : null}
        {editable ? (
          <GroupedRow
            icon="pen"
            label={
              // A full Vault isn't fixed by reconnecting (ADR 0144 §3).
              conn.status === "error" && conn.errorCode !== "too_many_items"
                ? t("mobile.vault.connection.reconnect")
                : t("mobile.vault.connection.change")
            }
            chevron
            onPress={() => router.push(vaultHref.reconnect(conn.kind, conn.id) as never)}
          />
        ) : null}
      </GroupedList>
      <GroupedFooter>{t("mobile.vault.connection.readOnly", { name: conn.name })}</GroupedFooter>

      <GroupedHeader>{t("mobile.vault.access.defaultTitle")}</GroupedHeader>
      <GroupedList>
        {conn.scope === "team" ? (
          <GroupedRow
            icon="person"
            label={t("mobile.vault.access.people")}
            value={peopleSummary(t, conn.scope, conn.access, names)}
            chevron={editable}
            {...(editable ? { onPress: openAccess } : {})}
          />
        ) : null}
        <GroupedRow
          icon="agent"
          label={t("mobile.vault.access.agents")}
          value={agentsSummary(t, conn.access, names)}
          chevron={editable}
          {...(editable ? { onPress: openAccess } : {})}
        />
      </GroupedList>
      <GroupedFooter>
        {`${accessSentence(t, conn.scope, conn.access, names)} ${t("mobile.vault.access.defaultText")}`}
      </GroupedFooter>

      {editable ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="trash"
              label={t("mobile.vault.connection.disconnect")}
              danger
              disabled={remove.isPending}
              onPress={askDisconnect}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  loading: { marginVertical: 16 },
});
