import { useApi } from "@agenteschat/client";
import { can, makesAgents } from "@agenteschat/client/lib/permissions";
import { helpUrl } from "@agenteschat/client/lib/server";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { appHeaders, readCookie } from "@/lib/auth";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Note, openPage } from "../ai/parts";
import { successHaptic } from "../shared/parts";
import { exportFileName } from "./logic";
import { SettingsPage } from "./parts";

/**
 * Importar e exportar (who creates agents; the export, who manages them), as the web's, as far as a phone goes: this
 * workspace as a file (the share sheet saves it to Arquivos or sends it on), with what it never carries and what goes
 * in it. Bringing agents from another app opens Criar agente on that step, never in a workspace being deleted.
 */
export function ImportScreen() {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const { orgId, org } = useOrg();
  // Bringing agents in is `create_agents`; the workspace as a file holds every agent, so it is who manages them.
  const allowed = can(org, "create_agents");
  const mayExport = can(org, "manage_agents");
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error("sharing unavailable");
      const name = exportFileName(new Date());
      const dir = new Directory(Paths.cache, "export");
      dir.create({ intermediates: true, idempotent: true });
      const file = new File(dir, name);
      if (file.exists) file.delete();
      const done = await File.downloadFileAsync(api.imports.exportUrl(orgId), file, {
        headers: appHeaders(await readCookie()),
        idempotent: true,
      });
      successHaptic();
      // On iOS the name already carries the extension; a MIME type there would add a second one.
      await Sharing.shareAsync(
        done.uri,
        Platform.OS === "android" ? { mimeType: "application/json", dialogTitle: name } : {},
      );
    } catch {
      toast({ title: t("mobile.settings.import.failed"), icon: "x" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage title={t("settings.section.import")}>
      <GroupedFooter>{t("settings.sectionText.import")}</GroupedFooter>
      {!allowed ? (
        <View style={styles.note}>
          <Note icon="lock">{t("settings.readOnly")}</Note>
        </View>
      ) : (
        <>
          {mayExport ? (
            <>
              <GroupedHeader>{t("settings.import.exportTitle")}</GroupedHeader>
              <GroupedList>
                <GroupedRow
                  icon="down"
                  label={busy ? t("mobile.settings.import.preparing") : t("settings.import.download")}
                  disabled={busy}
                  onPress={() => void download()}
                />
                <GroupedRow
                  icon="help"
                  label={t("settings.import.whatsIn")}
                  chevron
                  onPress={() => openPage(helpUrl("import", i18n.language, "export"))}
                />
              </GroupedList>
              <GroupedFooter>{t("settings.import.neverLine")}</GroupedFooter>
            </>
          ) : null}
          {makesAgents(org) ? (
            <>
              <GroupedHeader>{t("settings.import.title")}</GroupedHeader>
              <GroupedList>
                <GroupedRow
                  icon="archive"
                  label={t("shell.importAgents")}
                  chevron
                  onPress={() => router.push("/new-agent?import=1" as never)}
                />
              </GroupedList>
            </>
          ) : null}
        </>
      )}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
});
