import { isTailnet, type ServerProblem } from "@agenteschat/client/lib/server";
import { signOutOf } from "@/features/account";
import { signInOneTime } from "@/lib/auth";
import { orgValueName, serverUrl, setServer, signedInServers } from "@/lib/server";
import { connectPlan } from "@/lib/server-choice";
import { writeValue } from "@/lib/storage";
import { router } from "@/ui/navigation";

/** Why a server can't be used, in the person's words (each takes `{ host }`). */
export const PROBLEM_TEXT: Record<ServerProblem, string> = {
  unreachable: "mobile.auth.server.unreachable",
  certificate: "mobile.auth.server.certificate",
  "not-agentes": "mobile.auth.server.notAgentes",
  "server-too-old": "mobile.auth.server.serverTooOld",
  "app-too-old": "mobile.auth.server.appTooOld",
};

/**
 * The text for a server that can't be used: Tailscale's own advice only on a tailnet (`isTailnet`, the
 * web's test for its Tailscale step), the plain one anywhere else. `server` is the full address.
 */
export const problemText = (problem: ServerProblem, server: string): string =>
  problem === "unreachable" && isTailnet(server) ? "mobile.auth.server.unreachableTailscale" : PROBLEM_TEXT[problem];

/**
 * Moves the app to `target.server` (ADR 0154: every other server stays signed in, each with its own session), and
 * signs in there with the one-time token from the web app's QR code, when there is one: a token on a server someone
 * is signed in to replaces them there (`connectPlan`). False when the token was refused (expired or already used).
 */
export async function connectToServer(target: { server: string; token?: string }) {
  const plan = connectPlan(serverUrl(), target, signedInServers().includes(target.server));
  if (plan.signOut) await signOutOf(target.server);
  if (plan.move) await setServer(target.server);
  return plan.token ? signInOneTime(plan.token, target.server) : true;
}

/**
 * Opens a workspace, on this server or another one signed in to (ADR 0154): remembered as that server's workspace,
 * the screens of this one closed, then the app moves there. Nothing signs out.
 */
export async function openWorkspace(server: string, orgId: string | null) {
  if (orgId) await writeValue(orgValueName(server), orgId);
  if (server === serverUrl()) return;
  let closing = false;
  try {
    if (router.canDismiss()) {
      router.dismissTo("/");
      closing = true;
    }
  } catch {
    // Nothing pushed.
  }
  // The app's tree remounts for the new server: doing it while a sheet or a pushed screen is still closing leaves the
  // native stack half drawn (a bare header over an empty screen), so the close finishes first.
  if (closing) await new Promise((done) => setTimeout(done, 450));
  await setServer(server);
}
