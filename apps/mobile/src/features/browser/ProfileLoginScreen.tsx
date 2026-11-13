import { useBrowserProfiles } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { goBack } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { BrowserCard } from "./BrowserCard";

/**
 * "Fazer login" from the phone (ADR 0110): a shared browser profile's live view, full screen, in the person's
 * control; Devolver hands it back to its agents. The take over itself happened on the computer's page.
 */
export function ProfileLoginScreen({ profileId }: { profileId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const profiles = useBrowserProfiles(orgId);
  const profile = profiles.data?.find((p) => p.id === profileId);
  return (
    <SheetHostProvider>
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
          <IconButton icon="x" plate label={t("mobile.common.close")} onPress={goBack} />
          <View style={styles.title}>
            <Text variant="subhead" style={styles.bold} accessibilityRole="header">
              {profile?.name ?? t("browser.profiles.title")}
            </Text>
            <Text variant="footnote" tone="faint">
              {t("browser.profiles.controlSub")}
            </Text>
          </View>
        </View>
        <ScrollView
          style={styles.fill}
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          {profile ? (
            <BrowserCard
              agentId={`profile:${profile.id}`}
              profile={{ id: profile.id, name: profile.name }}
              surface
              style={styles.flush}
            />
          ) : null}
        </ScrollView>
      </View>
    </SheetHostProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  fill: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingBottom: 10 },
  title: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  body: { paddingHorizontal: 12, gap: 12 },
  flush: { marginTop: 0 },
});
