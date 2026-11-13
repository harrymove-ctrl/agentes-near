import { useCreateDashboard, useMembers } from "@agenteschat/client";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedHeader, Locked, useTheme, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { boardHref } from "../links/logic";
import { useFailed } from "../routines/hooks";
import { useOrgId } from "../shared/hooks";
import { PushedHeader, successHaptic } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { TextArea } from "../shared/TextArea";
import { type AudienceDraft, audienceDraftOf, audienceReady, shareInputOf } from "./logic";
import { AudienceFields } from "./parts";

/** The longest name the server takes (ADR 0135). */
const TITLE_MAX = 80;

/**
 * "New dashboard", pushed (ADR 0135): its name (with a line saying an agent builds one when asked in a chat), who sees
 * it and who edits it. "Create" in the bar opens the new, empty board.
 */
export function NewBoardScreen() {
  return (
    <SheetHostProvider>
      <NewBoard />
    </SheetHostProvider>
  );
}

function NewBoard() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const members = useMembers(orgId);
  const create = useCreateDashboard(orgId);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState<AudienceDraft>(() => audienceDraftOf(null));
  const ready = title.trim().length > 0 && audienceReady(draft) && !create.isPending;
  const submit = () => {
    if (!ready) return;
    const name = title.trim();
    create.mutate(
      { title: name, ...shareInputOf(draft) },
      {
        onSuccess: (board) => {
          successHaptic();
          toast({ title: t("dashboards.create.created", { title: name }) });
          router.replace(boardHref(board.id));
        },
        onError: failed,
      },
    );
  };
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("dashboards.create.title")}
        solid={false}
        grouped
        action={{ label: t("mobile.dashboards.create"), disabled: !ready, onPress: submit }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        <Locked when={create.isPending}>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: t("dashboards.create.name") }),
              text: t("dashboards.create.askHint"),
            }}
          >
            {t("dashboards.create.name")}
          </GroupedHeader>
          <TextArea
            value={title}
            onChangeText={setTitle}
            placeholder={t("dashboards.create.namePlaceholder")}
            accessibilityLabel={t("dashboards.create.name")}
            multiline={false}
            minHeight={50}
            maxLength={TITLE_MAX}
            returnKeyType="done"
            autoFocus
          />

          <AudienceFields draft={draft} onChange={setDraft} members={members.data?.length ?? 0} />
        </Locked>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
});
