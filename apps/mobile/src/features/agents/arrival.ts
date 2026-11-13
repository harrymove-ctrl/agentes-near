import { useSyncExternalStore } from "react";

/**
 * The agent just created on this phone, so Agentes can greet it once: its row comes in and the others look at it.
 * Kept in memory only (a restart forgets it) and only for a while, since a greeting long after reads as a glitch.
 */
let arrived: { id: string; at: number } | null = null;
const listeners = new Set<() => void>();

/** How long after creating it the list still greets it. */
export const ARRIVAL_FRESH_MS = 3 * 60_000;
/** How long the others look at the newcomer's row. */
export const ARRIVAL_LOOK_MS = 1700;

/** Said by Criar agente when the agent exists. */
export function markArrived(id: string) {
  arrived = { id, at: Date.now() };
  for (const l of listeners) l();
}

/** Said by Agentes once it has greeted it: the greeting plays one time. */
export function clearArrived(id: string) {
  if (arrived?.id !== id) return;
  arrived = null;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The newcomer's id while it is fresh, else null. */
export function useArrived(): string | null {
  const now = useSyncExternalStore(subscribe, () => arrived);
  return now && Date.now() - now.at < ARRIVAL_FRESH_MS ? now.id : null;
}
