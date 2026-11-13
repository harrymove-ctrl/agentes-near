import { serverUrl } from "@/lib/server";
import { readValue, readValueSync, STORED, writeValue } from "@/lib/storage";
import { type Asked, askedOf, storedAsked } from "./invite-steps";
import { afterSignIn, type InviteKind, storedInvite, storedInviteOf } from "./links";

/** The request waiting on this phone (ADR 0090 §3), for this server: closing the app returns to it. */
export function waitingAsk(): Asked | null {
  const asked = askedOf(readValueSync(STORED.joinAsked));
  return asked?.server === serverUrl() ? asked : null;
}

/** Kept in the device's secure storage, as the session is: the key signs in once an admin approves. */
export const keepAsk = (asked: Asked) => void writeValue(STORED.joinAsked, storedAsked(asked));

/** Any ending: approved, denied, closed, or a key the server no longer knows. */
export const forgetAsk = () => void writeValue(STORED.joinAsked, null);

/**
 * An invitation opened in the app before the person is signed in, kept until they are in (the root layout's
 * `useAcceptPendingInvite`, through `afterSignIn`). Kept in memory too: signing out to switch accounts clears what
 * the app stored.
 */
let pending: string | null = null;

export function rememberInvite(token: string, kind: InviteKind, mail?: string) {
  pending = storedInvite(token, kind, mail);
  void writeValue(STORED.invite, pending);
}

export function forgetInvite() {
  pending = null;
  void writeValue(STORED.invite, null);
}

/** Read again from storage (the app may have been closed between the link and signing in). */
export async function loadPendingInvite() {
  pending = (await readValue(STORED.invite)) ?? pending;
  return afterSignIn(pending);
}

/** The invitation this sign-in leads to, if one waits (the sign-in says so): what was opened, or what was stored. */
export const pendingInvite = () => storedInviteOf(pending ?? readValueSync(STORED.invite));
