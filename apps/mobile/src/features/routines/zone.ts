import { useSyncExternalStore } from "react";

/**
 * The routine form's time zone while "Fuso horário" (a screen pushed over the form) is open: the form puts its
 * zone here before opening it, the picker shows it checked and writes the one picked, and the form takes it back.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

export function setRoutineZone(zone: string | null) {
  current = zone;
  for (const listener of listeners) listener();
}

export function useRoutineZone(): string | null {
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
