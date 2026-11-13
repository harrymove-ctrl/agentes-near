import type { FilterOption } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ActorAvatar, AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";

/** People and agents as filter options ("agent:id" / "person:id"), with their avatars, grouped. */
export function useActorFilterOptions(): FilterOption[] {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return [
    ...dir.agents.map((a) => ({
      value: `agent:${a.id}`,
      label: a.name,
      group: t("drive.agents"),
      leading: <AgentAvatar agentId={a.id} size="sm" name={a.name} />,
    })),
    ...dir.members.map((m) => ({
      value: `person:${m.userId}`,
      label: m.name,
      group: t("drive.people"),
      leading: <ActorAvatar actor={{ type: "person", id: m.userId }} size="sm" name={m.name} />,
    })),
  ];
}

/** The texts every filter chip shares. */
export function useFilterCopy() {
  const { t } = useTranslation();
  return {
    clearOf: (name: string) => t("filters.clear", { name }),
    searchLabel: t("filters.search"),
    searchPlaceholder: t("filters.searchPlaceholder"),
    noResults: t("filters.noResults"),
    clearAll: t("filters.clearAll"),
    clearSearch: t("filters.clearSearch"),
    people: (count: number) => t("filters.people", { count }),
  };
}
