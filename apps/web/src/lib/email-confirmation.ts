import type { Me } from "@agenteschat/client";
import { authErrorText } from "@agenteschat/client/lib/errors";
import type { TFunction } from "i18next";
import type { AuthClient } from "@/auth/client";
import type { ToastStore } from "@/lib/toast";

/** How the confirmation email's link went, for the page it opened. */
export interface ConfirmationLanding {
  key: "auth.emailConfirmed" | "auth.emailLinkExpired";
  tone: "info" | "error";
}

/**
 * A page opened from that link, or null: the server lands it on `/?email_confirmed=1` (apps/server/src/auth.ts),
 * and Better Auth adds `error=` when the link no longer works.
 */
export function emailConfirmedToast(search: string): ConfirmationLanding | null {
  const params = new URLSearchParams(search);
  if (!params.has("email_confirmed")) return null;
  return params.has("error")
    ? { key: "auth.emailLinkExpired", tone: "error" }
    : { key: "auth.emailConfirmed", tone: "info" };
}

interface Deps {
  auth: Pick<AuthClient, "sendVerificationEmail">;
  t: TFunction;
  show: ToastStore["show"];
}

/** A new link for the signed-in person's own address, and a toast saying how that went; true once it's sent. */
export async function sendNewLink({ auth, t, show }: Deps, email: string): Promise<boolean> {
  const result = await auth.sendVerificationEmail(email);
  if (result.ok) show(t("auth.newLinkSent", { email }));
  else show(authErrorText(t, result), "error");
  return result.ok;
}

/**
 * Says how the link went. One that no longer works signed nobody in: whoever is signed in here with the address
 * still unconfirmed gets a new link from the toast.
 */
export async function announceConfirmation(
  landing: ConfirmationLanding,
  deps: Deps & { me: () => Promise<Me | null> },
): Promise<void> {
  const user = landing.tone === "error" ? (await deps.me().catch(() => null))?.user : undefined;
  const email = user && !user.emailVerified ? user.email : null;
  deps.show(
    deps.t(landing.key),
    landing.tone,
    email ? { label: deps.t("auth.sendNewLink"), run: () => void sendNewLink(deps, email) } : undefined,
  );
}
