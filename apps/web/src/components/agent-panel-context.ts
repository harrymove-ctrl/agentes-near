import type { AgentTab } from "@agenteschat/client/lib/agent-edit";
import { createContext, useContext } from "react";

/**
 * Opens an agent's page in the panel beside the conversation (like a thread's): "Ver perfil" in a DM's
 * header and in the profile card, its memory from a receipt or a memory card (`tab`), at the memory or skill they
 * name (`item`). Null outside a conversation: callers link to the agent's page instead.
 */
export const AgentPanelContext = createContext<((agentId: string, tab?: AgentTab, item?: string) => void) | null>(null);

export const useOpenAgentPanel = () => useContext(AgentPanelContext);

/** The agent whose page that panel shows now (its openers' `aria-expanded`), null when it is closed. */
export const AgentPanelShownContext = createContext<string | null>(null);

export const useAgentPanelShown = () => useContext(AgentPanelShownContext);
