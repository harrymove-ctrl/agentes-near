import { type Dashboard, useDashboard, useUpdateDashboard } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedHeader, Locked, Text, useTheme, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";

/** The longest name and description the server takes (ADR 0135). */
const TITLE_MAX = 80;
const ABOUT_MAX = 280;

/** "Rename" a dashboard, pushed from its "…" (ADR 0135): its name and what it is for. "Save" in the bar. */
export function BoardEditScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const q = useDashboard(useOrgId(), id);
  if (!q.data) {
    return (
      <View style={[styles.screen, { backgroundColor: c.grouped }]}>
        <PushedHeader title={t("dashboards.rename")} solid={false} grouped />
        <View style={styles.center}>
          {q.isLoading ? (
            <ActivityIndicator color={c.muted} />
          ) : (
            <Text tone="muted" style={styles.centerText}>
              {t("dashboards.errors.notFound")}
            </Text>
          )}
        </View>
      </View>
    );
  }
  return <Form key={q.data.id} board={q.data} />;
}

function Form({ board }: { board: Dashboard }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const failed = useFailed();
  const update = useUpdateDashboard(useOrgId());
  const [title, setTitle] = useState(board.title);
  const [about, setAbout] = useState(board.about);
  const changed = title.trim() !== board.title || about.trim() !== board.about;
  const ready = title.trim().length > 0 && !update.isPending;
  const save = () => {
    if (!ready) return;
    if (!changed) {
      goBack();
      return;
    }
    update.mutate(
      { dashboardId: board.id, title: title.trim(), about: about.trim() },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("mobile.dashboards.edit.saved") });
          goBack();
        },
        onError: failed,
      },
    );
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("dashboards.rename")}
        solid={false}
        grouped
        action={{ label: t("common.save"), disabled: !ready, onPress: save }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        <Locked when={update.isPending}>
          <GroupedHeader>{t("dashboards.create.name")}</GroupedHeader>
          <TextArea
            value={title}
            onChangeText={setTitle}
            placeholder={t("dashboards.create.namePlaceholder")}
            accessibilityLabel={t("dashboards.create.name")}
            multiline={false}
            minHeight={50}
            maxLength={TITLE_MAX}
            returnKeyType="done"
          />
          <GroupedHeader>{t("dashboards.about")}</GroupedHeader>
          <TextArea
            value={about}
            onChangeText={setAbout}
            placeholder={t("dashboards.aboutPlaceholder")}
            accessibilityLabel={t("dashboards.about")}
            maxLength={ABOUT_MAX}
            minHeight={96}
          />
        </Locked>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  centerText: { textAlign: "center" },
});
