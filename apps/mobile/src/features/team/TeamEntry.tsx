import { useAgentGroups } from "@agenteschat/client";
import { useTranslation } from "react-i18next";
import { ListRow } from "@/ui";
import { router } from "@/ui/navigation";
import { useOrgId } from "../shared/hooks";
import { Tile } from "../shared/parts";

/**
 * Agentes' way into Equipe (ADR 0148): a row of the list itself (its 52 pt face column, its name and line, a chevron
 * since it opens a screen), saying how many setores the team has, never a row of its own insets and sizes.
 */
export function TeamEntry() {
  const { t } = useTranslation();
  const groups = useAgentGroups(useOrgId()).data ?? [];
  const line = groups.length > 0 ? t("team.sectorsCount", { count: groups.length }) : t("mobile.team.entry");
  return (
    <ListRow
      onPress={() => router.push("/team")}
      accessibilityRole="button"
      accessibilityLabel={[t("team.title"), line].join(", ")}
      leading={<Tile icon="members" size={52} />}
      title={t("team.title")}
      sub={line}
      subLines={1}
      chevron
    />
  );
}
