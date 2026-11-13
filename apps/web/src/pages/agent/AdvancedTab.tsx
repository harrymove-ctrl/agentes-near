import type { AgentSection, AgentTab } from "@agenteschat/client/lib/agent-edit";
import { Button, GroupHeading, type IconName } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AccessTab } from "./AccessTab";
import { SettingsTab } from "./SettingsTab";

/** The tabs a personal workspace's bar leaves out, a click away from Advanced. */
const ELSEWHERE: { tab: AgentTab; icon: IconName }[] = [
  { tab: "activity", icon: "clock" },
  { tab: "files", icon: "file" },
  { tab: "usage", icon: "chart" },
];

/**
 * A personal workspace's Advanced tab (ADR 0159 §3): what one person rarely needs, all of it still here. Activity,
 * Files and Usage a click away; then Configurações' advanced part (owner and who it reports to, who talks to it, its
 * brakes, conversations, computer, danger zone) and the access tab's (built-in areas, databases, rules, skills).
 */
export function AdvancedTab({
  section,
  onSection,
  onOpen,
  onArchive,
  onDelete,
}: {
  section: AgentSection | undefined;
  onSection: (sec: AgentSection) => void;
  onOpen: (tab: AgentTab) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="agp-adv">
      <nav className="agp-adv__links" aria-label={t("agentPage.advanced.elsewhere")}>
        {ELSEWHERE.map(({ tab, icon }) => (
          <Button key={tab} size="sm" icon={icon} onClick={() => onOpen(tab)}>
            {t(`agentPage.tabs.${tab}`)}
          </Button>
        ))}
      </nav>
      <SettingsTab part="advanced" section={section} onSection={onSection} onArchive={onArchive} onDelete={onDelete} />
      <GroupHeading title={t("agentPage.advanced.tools")} />
      <AccessTab part="advanced" />
    </div>
  );
}
