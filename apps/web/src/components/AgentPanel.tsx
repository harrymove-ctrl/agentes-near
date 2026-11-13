import type { AgentSection, AgentTab } from "@agenteschat/client/lib/agent-edit";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { Button } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { SidePanel } from "@/components/SidePanel";
import { useDirectory } from "@/hooks/useDirectory";
import { useEscClose } from "@/hooks/useEscClose";
import { AgentPage } from "@/pages/AgentPage";

/**
 * The agent's page in the side panel (`SidePanel`), wider than a thread. Its ×, the scrim, Esc (`useEscClose`) and its
 * opener again (`closeRequest`, a new number each time) close it, asking first when something is unsaved.
 */
export function AgentPanel({
  agentId,
  tab,
  item,
  closeRequest: asked,
  onClose,
}: {
  agentId: string;
  tab?: AgentTab;
  /** The memory or skill to land on in Memória. */
  item?: string;
  closeRequest?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const name = dir.agentById.get(agentId)?.name ?? "";
  const [place, setPlace] = useState<{ tab: AgentTab; section?: AgentSection }>({ tab: tab ?? "overview" });
  const [closeRequest, setCloseRequest] = useState(0);
  const request = () => setCloseRequest((n) => n + 1);
  useEscClose(request);
  useEffect(() => {
    if (asked) setCloseRequest((n) => n + 1);
  }, [asked]);
  return (
    <SidePanel className="thread-panel--wide" label={t("agentPage.panel.label", agentGrammar(name))} onClose={request}>
      <Button
        size="sm"
        iconOnly
        icon="close"
        className="agp-glass thread-panel__close"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={request}
      />
      <div className="thread-panel__page">
        <AgentPage
          agentId={agentId}
          tab={place.tab}
          section={place.section}
          item={item}
          onNavigate={(tab, section) => setPlace({ tab, section })}
          onClose={onClose}
          closeRequest={closeRequest}
        />
      </div>
    </SidePanel>
  );
}
