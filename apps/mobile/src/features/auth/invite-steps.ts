import { ApiError, type InvitationPreview, type JoinClaim } from "@agenteschat/client";
import type { HumanAction } from "@agenteschat/client/lib/human-check";
import { isInviteToken } from "./links";

/**
 * Asking through a link, signed out, where email goes out (ADR 0090 §1): three screens. The e-mail, the code from it
 * on its own, then everything about the person at once (name, password, an optional word for whoever approves) under
 * one button. Five screens, one field each, made a request to join feel like a form.
 */
export type AskStep = "email" | "code" | "you";

export const ASK_STEPS: readonly AskStep[] = ["email", "code", "you"];

/** "1 de 3". */
export const askProgress = (step: AskStep) => ({ n: ASK_STEPS.indexOf(step) + 1, total: ASK_STEPS.length });

/** Where Back goes from each step: past the code, which a proven address doesn't type again; null leaves the screen. */
const ASK_BACK: Record<AskStep, AskStep | null> = {
  email: null,
  code: "email",
  you: "email",
};

export const askBack = (step: AskStep) => ASK_BACK[step];

/** Only the code's sending is a public form a bot could flood (ADR 0075); the ask itself carries the proven code. */
export const askAction = (step: AskStep): HumanAction | null =>
  step === "email" || step === "code" ? "ask-code" : null;

/** An email invitation, signed out: what its address is missing (ADR 0090 §6), and the reset's two screens. */
export type EmailStep = "name" | "newPassword" | "password" | "social" | "forgot" | "sent";

type InvitedAccount = NonNullable<InvitationPreview["account"]>;

/** The preview says how the address signs in; without it, a name and a password make an account. */
const NO_ACCOUNT: InvitedAccount = { exists: false, password: false, providers: [] };

/** The first screen for this address: a new one's name, a password's field, or its provider. */
export function emailStart(account: InvitedAccount = NO_ACCOUNT): EmailStep {
  if (!account.exists) return "name";
  return account.password ? "password" : "social";
}

/** Where Back goes from each step, given the first one; null leaves the screen. */
export function emailBack(step: EmailStep, start: EmailStep): EmailStep | null {
  if (step === "newPassword") return "name";
  return step === "forgot" || step === "sent" ? start : null;
}

/** What each step's bot check is for (ADR 0075). The name leads to the sign-up, so its token is ready by then. */
export const EMAIL_ACTIONS: Partial<Record<EmailStep, HumanAction>> = {
  name: "sign-up",
  newPassword: "sign-up",
  password: "sign-in",
  forgot: "password-reset",
};

/**
 * The request this phone made through a link (ADR 0090 §3): the key the ask answered, which signs in once approved,
 * and what the waiting screen says without asking the server, so it shows offline too. `server`: a key means nothing
 * on another one. The password is never in here: the server holds its hash on the request.
 */
export interface Asked {
  token: string;
  key: string;
  name: string;
  email: string;
  org: string;
  server: string;
}

export const storedAsked = (asked: Asked) => JSON.stringify(asked);

/** A stored request read back; null for nothing, or anything malformed. */
export function askedOf(stored: string | null): Asked | null {
  if (!stored) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof saved !== "object" || saved === null) return null;
  const { token, key, name, email, org, server } = saved as Record<string, unknown>;
  if (!isInviteToken(token) || typeof key !== "string" || key === "") return null;
  if (typeof server !== "string" || server === "") return null;
  return { token, key, name: String(name ?? ""), email: String(email ?? ""), org: String(org ?? ""), server };
}

/**
 * A check that failed for a moment and may answer the next time: no connection, the server restarting, too many
 * checks from here. Any other refusal is the server's last word on the key.
 */
export const claimFailedForNow = (error: unknown) =>
  !(error instanceof ApiError) || error.status >= 500 || error.status === 408 || error.status === 429;

/** The phone's request, answered: in (signing in), in with a sign-in by hand, turned down, or ended. */
export type Answer =
  | { state: "in"; orgId: string }
  | { state: "signIn"; orgId: string }
  | { state: "denied"; reason: string | null }
  | { state: "ended" };

/** What a check says: null while it waits; `claim` null is a key that matches nothing, the last word too. */
export function claimAnswer(claim: JoinClaim | null): Answer | null {
  switch (claim?.status) {
    case "pending":
      return null;
    case "in":
      return { state: "in", orgId: claim.orgId };
    case "denied":
      return { state: "denied", reason: claim.reason };
    default:
      return { state: "ended" };
  }
}

/** Reopening the app returns to the wait only from where a signed-out launch lands, never over a link it opened. */
export const resumesAsk = (pathname: string) => pathname === "/sign-in";
