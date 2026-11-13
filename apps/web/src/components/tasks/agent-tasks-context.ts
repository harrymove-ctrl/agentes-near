import type { ManagedTask } from "@agenteschat/client";
import { createContext, useContext } from "react";

/**
 * A DM with an agent (ADR 0128): the agent's tasks and its side panel, held by the conversation (ChannelPage) and read
 * by the pill in the DM's header (`AgentTasksPill`).
 */
export interface AgentTasksControl {
  /** The agent's tasks the person can see, people's first (`tasksOf`). */
  tasks: ManagedTask[];
  /** Its panel is open. */
  open: boolean;
  toggle: () => void;
}

export const AgentTasksContext = createContext<AgentTasksControl | null>(null);

export const useAgentTasks = () => useContext(AgentTasksContext);
