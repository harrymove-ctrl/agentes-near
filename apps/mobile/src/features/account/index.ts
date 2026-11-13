import type { DeletionProofInput } from "@agenteschat/client";
import { authClient, authedFetch } from "@/lib/auth";
import { outboxStoreFor } from "@/lib/outbox";
import { SIGN_OUT_WAIT_MS, unregisterPush, unregisterPushOn } from "@/lib/push";
import { markSignedOut, orgValueName, serverUrl, setServer, signedInServers } from "@/lib/server";
import { serverAfter } from "@/lib/server-choice";
import { snapshotStoreFor } from "@/lib/snapshot";
import { clearStoredValues, writeValue } from "@/lib/storage";
import { type DeleteAccountResult, readDeleteResponse } from "./result";

export type { DeleteAccountResult };

/**
 * Signs out of the current server (ADR 0154): only that one. The app moves to the next server still signed in; with
 * none left it forgets the app's remembered values too, and the session gate shows sign-in.
 */
export async function signOut(): Promise<void> {
  const server = serverUrl();
  const next = serverAfter(signedInServers(), server);
  await signOutOf(server, next === null);
  if (next) await setServer(next);
}

/**
 * Signs out of one server: it stops pushing to this phone, its session ends (the Expo plugin clears its stored cookie
 * and session before asking the server), and what the phone kept of it goes (its remembered workspace, its saved
 * chats, its waiting messages). `last`: no server is left, so the phone's own remembered values go as well.
 */
export async function signOutOf(server: string, last = false): Promise<void> {
  if (last) await unregisterPush({ optOut: false });
  else await unregisterPushOn(server);
  await authClient(server)
    .signOut({ fetchOptions: { timeout: SIGN_OUT_WAIT_MS } })
    .catch(() => {});
  await forgetServer(server, last);
}

async function forgetServer(server: string, last: boolean) {
  markSignedOut(server);
  await writeValue(orgValueName(server), null);
  await snapshotStoreFor(server).remove();
  outboxStoreFor(server).write("[]");
  if (last) await clearStoredValues();
}

/**
 * Deletes the account in 7 days (App Store 5.1.1(v), ADR 0088 §10), with the proof that it's them: the code emailed to them, or their
 * password on a server that sends no email (`reason: "proof"` when refused). Refused while the person is the only
 * owner of an organization with other members (`sole_owner`). On success the phone is signed out.
 */
export async function deleteAccount(proof: DeletionProofInput = {}): Promise<DeleteAccountResult> {
  const res = await authedFetch(`${serverUrl()}/api/app/account`, {
    method: "DELETE",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(proof),
  }).catch(() => null);
  if (!res) return { ok: false, reason: "failed", status: 0 };
  const result = await readDeleteResponse(res);
  if (result.ok) {
    // The account is gone from this server; the others stay signed in (ADR 0154).
    const server = serverUrl();
    const next = serverAfter(signedInServers(), server);
    await authClient(server)
      .signOut()
      .catch(() => {});
    await forgetServer(server, next === null);
    if (next) await setServer(next);
  }
  return result;
}
