import { useSyncExternalStore } from "react";

/**
 * "Who looks after it" while its screen is open (ADR 0135): the agent picked now and how a choice goes back to the
 * form that pushed the screen (New widget). The form starts it before pushing and ends it when it closes, as "Who edits
 * › Some roles…" shares its draft (`edit-roles.ts`): a route can't carry a callback.
 */
export interface AgentPick {
  agentId: string | null;
  apply: (agentId: string) => void;
}

let current: AgentPick | null = null;
const listeners = new Set<() => void>();

function set(next: AgentPick | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function openAgentPick(pick: AgentPick) {
  set(pick);
}

/** An agent chosen on the screen: back to the form at once. */
export function chooseAgent(agentId: string) {
  if (!current) return;
  current.apply(agentId);
  set({ ...current, agentId });
}

export function closeAgentPick() {
  set(null);
}

export const agentPickNow = (): AgentPick | null => current;

export function useAgentPick(): AgentPick | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
  );
}
