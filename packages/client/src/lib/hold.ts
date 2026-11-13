import { useRef } from "react";

/**
 * `value` as it was before `hold` turned true, for as long as it stays true. A create form holds what it checks the
 * typed name against (the names taken, the addresses invited) from the moment it is sent: its own result reaches that
 * list (a refetch, a realtime event) while the form is still on screen, and must never read as "already exists".
 */
export function useHeldWhile<T>(value: T, hold: boolean): T {
  const held = useRef(value);
  if (!hold) held.current = value;
  return held.current;
}
