import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedList, GroupedRow, SheetScreen } from "@/ui";
import { router } from "@/ui/navigation";
import { SheetHeader } from "../new/parts";
import { goBack } from "../shared/parts";
import { useOpenWorkspaceRow, useWorkspacesAcross, WorkspaceGroups } from "./WorkspacesPages";

/**
 * The workspaces as a sheet, from holding the workspace's mark in the bar (ADR 0154): the same groups per server as
 * the page in Você, the check on the current one, the unread counts, "Adicionar workspace" at the end, and one line
 * saying every one stays signed in. The system's form sheet draws it (dragged 1:1, dismissed on a flick); tapping a
 * workspace closes it first, so the switch is seen on the screen under it.
 */
export function WorkspacesSheet() {
  const { t } = useTranslation();
  const { groups } = useWorkspacesAcross();
  const open = useOpenWorkspaceRow();
  return (
    <SheetScreen>
      <SheetHeader title={t("mobile.me.workspaces")} />
      <WorkspaceGroups groups={groups} onOpen={open} />
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          icon="plus"
          label={t("mobile.me.addWorkspace")}
          chevron
          onPress={() => {
            goBack();
            router.push("/me/add-workspace");
          }}
        />
      </GroupedList>
      <GroupedFooter>{t("mobile.me.workspacesSheetFoot")}</GroupedFooter>
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  gap: { height: 16 },
});
