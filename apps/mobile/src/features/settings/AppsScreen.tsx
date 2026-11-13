import type { ConnectedApp, PersonalToken } from "@agenteschat/client";
import { useAppActions, useApps } from "@agenteschat/client";
import { appFacts, appMark, appsSettingsUrl, isAppsEmpty, tokenFacts } from "@agenteschat/client/lib/apps";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, ProviderLogo, useToast } from "@/ui";
import { Note, openPage } from "../ai/parts";
import { FirstUse } from "../shared/FirstUse";
import { useColors } from "../shared/hooks";
import { errorHaptic, Loaded, successHaptic } from "../shared/parts";
import { CommandBlock, chooseAction, confirmAction, Gap, SettingsPage } from "./parts";

/**
 * Configurações › Apps de IA (ADR 0119), as the web's: this server's address, the apps connected here and the personal
 * tokens, each disconnected or revoked from its row's actions. Connecting an app and creating a token open the web,
 * where the steps and the shown-once token fit.
 */
export function AppsScreen() {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const list = useApps(orgId);
  const { disconnect, revokeToken } = useAppActions(orgId);
  const title = t("settings.section.apps");
  const connect = () => openPage(appsSettingsUrl(serverUrl(), orgId));
  if (!list.data) {
    return (
      <SettingsPage title={title}>
        {list.isError ? (
          <View style={styles.note}>
            <Note icon="x">{t("common.loadFailed")}</Note>
          </View>
        ) : (
          <ActivityIndicator color={c.muted} style={styles.loading} />
        )}
      </SettingsPage>
    );
  }
  const data = list.data;
  const drop = (kind: "app" | "token", item: ConnectedApp | PersonalToken) => {
    const app = kind === "app";
    const mutation = app ? disconnect : revokeToken;
    chooseAction(
      item.name,
      [
        {
          label: app ? t("apps.disconnect") : t("apps.tokens.revoke"),
          destructive: true,
          onPress: () =>
            confirmAction({
              title: t(app ? "apps.disconnectTitle" : "apps.tokens.revokeTitle", { name: item.name }),
              text: t(app ? "apps.disconnectText" : "apps.tokens.revokeText"),
              action: app ? t("apps.disconnect") : t("apps.tokens.revoke"),
              cancel: t("common.cancel"),
              onConfirm: () =>
                mutation.mutate(item.id, {
                  onSuccess: () => {
                    successHaptic();
                    toast({
                      title: app ? t("apps.disconnected", { name: item.name }) : t("apps.tokens.revoked"),
                      icon: "check",
                    });
                  },
                  onError: (err) => {
                    errorHaptic();
                    toast({ title: errorText(t, err), icon: "x" });
                  },
                }),
            }),
        },
      ],
      t("common.cancel"),
    );
  };
  return (
    <SettingsPage title={title} frozen={settingsFrozen(org, "apps")}>
      <Loaded>
        <GroupedFooter>{t("settings.sectionText.apps")}</GroupedFooter>
        <GroupedHeader>{t("apps.server")}</GroupedHeader>
        <CommandBlock command={data.serverUrl} copiedTitle={t("apps.serverCopied")} />
        {isAppsEmpty(data) ? (
          <FirstUse place="apps" size="panel" acts label={t("apps.connect")} onPress={connect} />
        ) : (
          <>
            <Gap />
            <GroupedList>
              <GroupedRow icon="plus" label={t("apps.connect")} chevron onPress={connect} />
            </GroupedList>
          </>
        )}
        {data.apps.length > 0 ? (
          <>
            <GroupedHeader>{t("apps.connected")}</GroupedHeader>
            <GroupedList>
              {data.apps.map((app) => {
                const mark = appMark(app);
                return (
                  <GroupedRow
                    key={app.id}
                    label={app.name}
                    sub={t(`apps.access.${app.access}`)}
                    belowText={appFacts(t, i18n.language, app)}
                    {...(mark.kind === "computer"
                      ? { icon: "laptop" as const }
                      : { leading: <ProviderLogo id={mark.kind === "brand" ? mark.id : mark.letter} size="sm" /> })}
                    more
                    onPress={() => drop("app", app)}
                  />
                );
              })}
            </GroupedList>
          </>
        ) : null}
        <GroupedHeader>{t("apps.tokens.title")}</GroupedHeader>
        <GroupedList>
          {data.tokens.map((token) => (
            <GroupedRow
              key={token.id}
              icon="lock"
              label={token.name}
              sub={t(`apps.access.${token.access}`)}
              belowText={tokenFacts(t, i18n.language, token)}
              more
              onPress={() => drop("token", token)}
            />
          ))}
          <GroupedRow icon="plus" label={t("apps.tokens.create")} chevron onPress={connect} />
        </GroupedList>
        <GroupedFooter>{t("apps.tokens.text")}</GroupedFooter>
        <GroupedFooter>{t("apps.footer")}</GroupedFooter>
      </Loaded>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
  // The other settings screens' note: on the groups' edge, not indented past it.
  note: { paddingHorizontal: 4, paddingTop: 10 },
});
