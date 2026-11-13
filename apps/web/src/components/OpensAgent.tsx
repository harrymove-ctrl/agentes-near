import { opensDetails } from "@agenteschat/client/lib/audience";
import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { requestAgentPanel, takeAgentPanel } from "@/lib/agent-panel-ask";

/**
 * An agent's picture on a surface about it: a press opens its details, in the panel beside the conversation, or its
 * page with no conversation on screen. Plain for who has no details to reach (`opensDetails`). `onOpen`: the card or
 * dialog it sits on gives way.
 */
export function OpensAgent({
  agentId,
  onOpen,
  children,
}: {
  agentId: string;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const agent = dir.anyAgent(agentId);
  if (!agent || !opensDetails(agent)) return <>{children}</>;
  const open = (e: MouseEvent) => {
    if ((e.target as Element).closest(".ac-avatar__badge")) return;
    onOpen?.();
    if (requestAgentPanel(agentId, undefined, true)) return;
    takeAgentPanel();
    void navigate({ to: "/org/$orgId/agents/$agentId", params: { orgId: org.id, agentId } });
  };
  return (
    <button
      type="button"
      className="profile-trigger opens-agent"
      aria-label={t("profile.of", { name: agent.name })}
      onClick={open}
    >
      {children}
    </button>
  );
}
