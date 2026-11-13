import { useSyncExternalStore } from "react";

/**
 * Whether the launch splash has left. Screens under it wait for this before they take the keyboard: an
 * input focused on mount raised the keyboard over the splash, before its screen was in view.
 */
let launched = false;
const listeners = new Set<() => void>();

export function markLaunched(): void {
  if (launched) return;
  launched = true;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useLaunched = (): boolean => useSyncExternalStore(subscribe, () => launched);
