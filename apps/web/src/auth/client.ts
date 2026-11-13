/**
 * Sign-in for people (Better Auth at `/api/auth/*`, same origin, HttpOnly
 * session cookie: nothing auth-related is stored in JavaScript). Pages use
 * this interface; `better-auth.ts` implements it and tests pass a fake.
 */
/** A refusal's `status` is 0 when the request got no answer at all (`code: "network"`). */
export type AuthResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      message: string;
      code?: string;
      /** A blocked account on agentes.chat Cloud: the block's kind, with `cloud` (`restrictionLine`). */
      kind?: string;
      cloud?: boolean;
    };

/** `humanCheck` on the email forms: the bot check's token, when the server has one (ADR 0075). */
export interface AuthClient {
  signIn(input: { email: string; password: string }, humanCheck?: string): Promise<AuthResult>;
  /**
   * Creates the account, signed in; a server that sends e-mail sends the address a link that confirms it. `access`:
   * the early-access link's token, which opens sign-up for the address it was sent to (ADR 0078). `invitation`: the
   * email invitation's token and the proof on its own email's link (`mail`); with both, the address is proved, so no
   * link to confirm it goes (ADR 0090 §6).
   */
  signUp(
    input: {
      name: string;
      email: string;
      password: string;
      access?: string;
      invitation?: { token: string; mail?: string };
    },
    humanCheck?: string,
  ): Promise<AuthResult>;
  /** The signed-in person's name (the account's, shown in every workspace). */
  updateName(name: string): Promise<AuthResult>;
  /** A new link confirming the signed-in person's own address (`email`). */
  sendVerificationEmail(email: string): Promise<AuthResult>;
  /**
   * Redirects the browser to the provider; comes back to `callbackURL`, or to `errorCallbackURL` (`/login` by default)
   * with `?error=` when the provider or the server refuses. `earlyAccess`: the early-access link's token, carried
   * through the provider's redirect.
   */
  signInSocial(
    provider: "google" | "github" | "apple",
    callbackURL: string,
    earlyAccess?: string,
    errorCallbackURL?: string,
  ): Promise<AuthResult>;
  /** E-mails a link to `redirectTo?token=…` (only when the server can send e-mail: `passwordReset`). */
  requestPasswordReset(input: { email: string; redirectTo: string }, humanCheck?: string): Promise<AuthResult>;
  /** The new password for the link's token; signs out every other session. */
  resetPassword(input: { token: string; newPassword: string }): Promise<AuthResult>;
  signOut(): Promise<void>;
  /** In the Mac app's window: opens a hand-over request for the window's challenge, returning its id and the code to show (ADR 0036). */
  desktopOpen(challenge: string): Promise<{ requestId: string; code: string } | null>;
  /** In the browser: the code of a pending request, to show for the person to match against the app's window. */
  desktopRequestCode(requestId: string): Promise<string | null>;
  /** In the browser, after a fresh sign-in and the person's confirmation: hands it to the window that opened `requestId`. */
  desktopHandoff(requestId: string): Promise<AuthResult>;
  /** In the Mac app's window: true once the browser handed a sign-in over for this verifier (sets the cookie). */
  desktopRedeem(verifier: string): Promise<boolean>;
  /** In the app's window: a one-time sign-in from another device's link, traded once for a session of its own. */
  signInOneTime(token: string): Promise<AuthResult>;
  /** The installation's owner, from the installer's link (`/owner#claim=`): made once, then signed in. */
  ownerClaim(input: { token: string; name: string; email: string; password: string }): Promise<AuthResult>;
}
