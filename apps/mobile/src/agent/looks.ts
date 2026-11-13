import type { AgentColorName, EyeStyle } from "@agenteschat/ui/agent/engine";

/** What the engine needs to draw an agent. */
export interface AgentLookInput {
  color: AgentColorName;
  eyes: EyeStyle;
  /** An accessory name from the engine (`hat`, `cap`, …); "none" or unknown draws nothing. */
  accessory?: string;
  /** Optional: keeps this agent's idle life out of step with the others. */
  id?: string;
}

/**
 * Agents' looks by id, for places that only know an id (a toast with `agentId`). Screens that load the
 * agents call `rememberAgentLooks`; nothing else is stored.
 */
const looks = new Map<string, AgentLookInput>();

export function rememberAgentLooks(list: Iterable<{ id: string } & AgentLookInput>): void {
  for (const a of list) looks.set(a.id, { color: a.color, eyes: a.eyes, accessory: a.accessory, id: a.id });
}

export const lookOf = (id: string): AgentLookInput | undefined => looks.get(id);
