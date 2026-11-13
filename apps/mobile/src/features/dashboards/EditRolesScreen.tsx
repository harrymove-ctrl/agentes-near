import { roleSeesBoard } from "@agenteschat/client";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedHeader, GroupedList, GroupedRow, useTheme } from "@/ui";
import { goBack, PushedHeader } from "../shared/parts";
import { updateEditRoles, useEditRolesPick } from "./edit-roles";
import { useCustomRoles } from "./hooks";
import { toggledEditRoles } from "./logic";
import { RoleMark } from "./parts";

/**
 * "Who edits › Some roles…", pushed over Share or New dashboard (ADR 0135 §8): the workspace's roles to check; people
 * holding a checked one edit the board when they also see it. A role whose people don't see it is shown, faint, with
 * why, and can't be checked. Each change goes back to the form at once; "Done" goes back to it.
 */
export function EditRolesScreen() {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const roles = useCustomRoles();
  const pick = useEditRolesPick();
  // Opened with no form under it (its address on its own): nothing to pick for.
  useEffect(() => {
    if (!pick) goBack();
  }, [pick]);
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("dashboards.edit.label")}
        solid={false}
        grouped
        action={{ label: t("mobile.common.done"), onPress: goBack }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: 24 + insets.bottom }]}
      >
        {pick ? (
          <>
            <GroupedHeader
              hint={{
                name: t("common.about", { label: t("dashboards.edit.roles") }),
                text: t("dashboards.edit.rolesNote"),
              }}
            >
              {t("dashboards.edit.roles")}
            </GroupedHeader>
            <GroupedList>
              {roles.map((r) => {
                const sees = roleSeesBoard(pick, r.id);
                return (
                  <GroupedRow
                    key={r.id}
                    leading={<RoleMark color={r.color} />}
                    label={r.name}
                    {...(sees ? {} : { sub: t("dashboards.edit.cantSee") })}
                    checked={pick.editRoleIds.includes(r.id)}
                    faint={!sees}
                    disabled={!sees}
                    onPress={() => updateEditRoles(toggledEditRoles(pick.editRoleIds, r.id))}
                  />
                );
              })}
            </GroupedList>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4 },
});
