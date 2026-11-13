import { useSyncExternalStore } from "react";
import type { InviteAddress } from "./logic";

/** Convidar pessoas while it's open: the addresses, the channels chosen and the note in the email. */
export interface InviteDraft {
  addresses: InviteAddress[];
  channelIds: string[];
  note: string;
}

export const EMPTY_INVITE: InviteDraft = { addresses: [], channelIds: [], note: "" };

/**
 * The form shared with the screens pushed over it (Canais, Recado), as Conta shares its own with Fuso: Convidar
 * pessoas starts it and drops it when it closes; they write here and go back.
 */
let inviteDraft: InviteDraft | null = null;
const listeners = new Set<() => void>();

export function setInviteDraft(next: InviteDraft | null) {
  inviteDraft = next;
  for (const listener of listeners) listener();
}

/** A change to the open form; nothing once it closed. */
export function updateInviteDraft(change: (draft: InviteDraft) => InviteDraft) {
  if (inviteDraft) setInviteDraft(change(inviteDraft));
}

export function useInviteDraft(): InviteDraft | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => inviteDraft,
  );
}
