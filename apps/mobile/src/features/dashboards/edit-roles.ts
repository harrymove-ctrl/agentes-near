import type { DashboardAudience } from "@agenteschat/client";
import { useSyncExternalStore } from "react";

/**
 * "Who edits › Some roles…" while its screen is open (ADR 0135 §8): who sees the board in the form that pushed it
 * (only roles that see it can edit it), the roles checked now, and how each change goes back to that form. The form
 * (Share or New dashboard) starts it and ends it when it closes, as Invite people shares its draft with the screens
 * pushed over it.
 */
export interface EditRolesPick {
  audience: DashboardAudience;
  roleIds: string[];
  editRoleIds: string[];
  apply: (editRoleIds: string[]) => void;
}

let current: EditRolesPick | null = null;
const listeners = new Set<() => void>();

function set(next: EditRolesPick | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function openEditRoles(pick: EditRolesPick) {
  set(pick);
}

/** The roles checked on the screen: kept here and sent back to the form at once. */
export function updateEditRoles(editRoleIds: string[]) {
  if (!current) return;
  current.apply(editRoleIds);
  set({ ...current, editRoleIds });
}

export function closeEditRoles() {
  set(null);
}

export function useEditRolesPick(): EditRolesPick | null {
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
