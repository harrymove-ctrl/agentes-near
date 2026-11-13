import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedRow } from "@/ui";
import { router } from "@/ui/navigation";
import { usePersonalView } from "./hooks";
import { personalSections } from "./logic";
import { SettingsPage } from "./parts";
import { DeleteWorkspaceRow, SectionGroups } from "./WorkspaceScreen";

/**
 * Advanced, pushed from a personal workspace's settings (ADR 0159 §3): every section this person opens that the short
 * list leaves out, in the phone's usual groups, with delegated approvals (in a team's workspace a row of You) under
 * People, and deleting the workspace at the end for its owners. The same screens and permissions as a team's: only
 * where they are listed changes.
 */
export function AdvancedScreen() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { others } = usePersonalView();
  const { advanced } = personalSections(org, others);
  return (
    <SettingsPage title={t("settings.advanced")}>
      <SectionGroups
        areas={advanced}
        untitled="advanced"
        extra={{
          people: (
            <GroupedRow
              key="approvals"
              icon="shield"
              label={t("settings.section.approvals")}
              chevron
              onPress={() => router.push("/me/approvals")}
            />
          ),
        }}
      />
      <DeleteWorkspaceRow />
    </SettingsPage>
  );
}
