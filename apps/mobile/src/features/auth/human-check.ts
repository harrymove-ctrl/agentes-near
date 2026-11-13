import { ApiError, type SignInOptions, type SignInProvider } from "@agenteschat/client";
import {
  EARLY_ACCESS_OTHER_EMAIL,
  knownErrorText,
  providerRefusalText,
  type RestrictionFacts,
  restrictionLine,
} from "@agenteschat/client/lib/errors";
import { earlyAccessHeaders, earlyAccessState } from "@agenteschat/client/lib/guards";
import {
  type createHumanCheck,
  HUMAN_CHECK_BLOCKED,
  type HumanAction,
  isHumanCheckRefusal,
} from "@agenteschat/client/lib/human-check";
import { originOf } from "@agenteschat/client/lib/server";
import type { TFunction } from "i18next";

/** Where Turnstile's script and its frame come from. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * What the check's WebView loads in place (its `originWhitelist`): the server's own page, Turnstile's frame and the
 * blank documents frames start as. react-native-webview opens an address outside it in the browser and blocks it,
 * frames included, so without Cloudflare's origin every check would open a browser tab and never load.
 */
export function humanCheckOrigins(server: string): string[] {
  return ["about:blank", "about:srcdoc", new URL(server).origin, TURNSTILE_ORIGIN];
}

/**
 * Whether an address the whitelist let through loads in the check's WebView (`onShouldStartLoadWithRequest`). The
 * library reads each entry as the start of an origin, so `https://app.agentes.chat.evil.example` and
 * `https://app.agentes.chat@evil.example` pass it: only its exact documents and origins load.
 */
export function humanCheckStays(server: string, url: string): boolean {
  const allowed = humanCheckOrigins(server);
  return allowed.includes(url) || allowed.includes(originOf(url) ?? "");
}

/** The server's `/human-check.html` for one action, in the app's theme and language: Cloudflare sees the server's host. */
export function humanCheckUrl(
  server: string,
  widget: { siteKey: string; action: HumanAction; theme: "light" | "dark"; language: string },
): string {
  const query = new URLSearchParams({ k: widget.siteKey, a: widget.action, t: widget.theme, l: widget.language });
  return `${server}/human-check.html?${query.toString()}`;
}

/** What the check's page says (`human-check.html`): `error` without a code means Turnstile's script didn't load. */
export type HumanCheckEvent =
  | { type: "token"; token: string }
  | { type: "expired" }
  | { type: "error"; code?: string }
  | { type: "interactive" }
  | { type: "done" };

/** One message from the server's page, or null for anything else: another page's or frame's, or not an event. */
export function humanCheckEvent(server: string, from: { url: string; data: string }): HumanCheckEvent | null {
  if (originOf(from.url) !== new URL(server).origin) return null;
  let message: unknown;
  try {
    message = JSON.parse(from.data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;
  const { type, token, code } = message as Record<string, unknown>;
  switch (type) {
    case "token":
      return typeof token === "string" && token !== "" ? { type, token } : null;
    case "error": {
      const said = typeof code === "number" ? String(code) : code;
      return typeof said === "string" && said !== "" ? { type, code: said } : { type };
    }
    case "expired":
    case "interactive":
    case "done":
      return { type };
    default:
      return null;
  }
}

/**
 * Where the check's page stands. `asking`: Cloudflare waits for the person's click. `broken`: the page or
 * Turnstile's script didn't load, so a call goes with `unavailable` and the next one loads the page again.
 */
export interface CheckPage {
  asking: boolean;
  broken: boolean;
}

export const FRESH_PAGE: CheckPage = { asking: false, broken: false };

/** One event of the page, handed to the widget's tokens: the page's state after it. */
export function checkEvent(
  tokens: ReturnType<typeof createHumanCheck>,
  page: CheckPage,
  event: HumanCheckEvent,
): CheckPage {
  switch (event.type) {
    case "token":
      tokens.give(event.token);
      return { asking: false, broken: false };
    case "expired":
      tokens.expire();
      return page;
    case "error":
      tokens.fail(event.code);
      return { asking: false, broken: page.broken || event.code === undefined };
    case "interactive":
      // A call waits for the click however long it takes, since the check did load.
      tokens.hold();
      return { ...page, asking: true };
    case "done":
      return { ...page, asking: false };
  }
}

/**
 * Before each guarded call: a page that didn't load loads again, and the call waits for the new one rather than
 * failing at once, since the network may be back or the person moved to another, as the blocked line asks. True
 * when the page must load again.
 */
export function loadsAgain(tokens: ReturnType<typeof createHumanCheck>, page: CheckPage): boolean {
  if (!page.broken) return false;
  tokens.reset();
  return true;
}

/** A guarded call the person stopped in the check's sheet: nothing to say, they can press again. */
export class CheckCancelled extends Error {}

/**
 * A refused request in the phone's words: the bot check's blocked line names no browser (the app has none to
 * switch to), then a known code (a blocked account's, with its kind on agentes.chat Cloud), too many tries, else the
 * generic line. Never the server's text.
 */
export function refusalText(
  t: TFunction,
  refusal: { status: number; code?: string | null } & Pick<RestrictionFacts, "kind" | "cloud">,
): string {
  if (refusal.code === HUMAN_CHECK_BLOCKED) return t("mobile.humanCheck.blocked");
  // Better Auth's own limit, in the words the web's sign-in uses. The API's limits are `knownErrorText`'s.
  if (refusal.status === 429 && !(refusal instanceof ApiError)) return t("auth.tooManyTries");
  const { kind, cloud } = refusal;
  const error =
    refusal instanceof ApiError ? refusal : new ApiError(refusal.status, refusal.code ?? "", "", { kind, cloud });
  return knownErrorText(t, error) ?? t("mobile.auth.errors.generic");
}

/** A failed call to the app's API in the phone's words: the server's refusal, else no connection. */
export const failureText = (t: TFunction, error: unknown) =>
  error instanceof ApiError ? refusalText(t, error) : t("mobile.auth.errors.network");

/** The sign-in's e-mail step: any limit in the sign-in's own words, as the web's sign-in says it. */
export const lookUpFailureText = (t: TFunction, error: unknown) =>
  error instanceof ApiError && error.status === 429 ? t("auth.tooManyTries") : failureText(t, error);

/** Better Auth's answer as a refusal `withHumanCheck` reads (its status and code on top), or null when it passed. */
export const refusalOf = ({ error }: { error: ({ status: number; code?: string } & RestrictionFacts) | null }) =>
  error ? { status: error.status, code: error.code, kind: error.kind, cloud: error.cloud } : null;

/**
 * A social sign-in Better Auth refused, as Apple's native sign-in gets the server's answer itself: a blocked account's
 * line (its kind on agentes.chat Cloud), a refusal the web's sign-in says too, else that it didn't work. Better Auth
 * names a provider's own refusal in an `OAUTH_LINK_ERROR`'s message ("account not linked" is the web's
 * `account_not_linked`). `emails`: the server sends email.
 */
export function socialRefusalText(
  t: TFunction,
  error: { code?: string; message?: string } & RestrictionFacts,
  emails: boolean,
): string {
  const code = error.code === "OAUTH_LINK_ERROR" ? error.message?.replace(/ /g, "_") : error.code;
  return (
    restrictionLine(t, code, error) ??
    (code ? providerRefusalText(t, code, emails) : null) ??
    t("mobile.auth.social.failed")
  );
}

/**
 * A browser sign-in that came back: its refusal, or that it didn't finish (no session: the sheet was closed, or the
 * browser refused it, which comes back to the app too). Null once signed in.
 */
export const socialReturnText = (
  t: TFunction,
  res: { error?: ({ code?: string; message?: string } & RestrictionFacts) | null },
  signedIn: boolean,
  emails: boolean,
) => (res.error ? socialRefusalText(t, res.error, emails) : signedIn ? null : t("mobile.auth.social.unfinished"));

/**
 * The step after the e-mail lookup, as the web's sign-in takes it: the account's way in, else a name for a new
 * account, an early-access link that expired, or sign-up closed. `usable`: the account signs in with a provider
 * this server has.
 */
export function lookUpStep(found: SignInOptions, usable: boolean) {
  if (found.account) return found.password ? "password" : usable ? "social" : "noPassword";
  return found.canSignUp ? "name" : found.accessExpired ? "expired" : "closed";
}

/**
 * A refused sign-up means sign-up is closed only when it is a 403 that isn't the bot check's, nor an early-access
 * link's for another address (said in its own words, as on the web).
 */
export const signUpClosed = (refusal: { status: number; code?: string | null }) =>
  refusal.status === 403 &&
  !isHumanCheckRefusal(refusal.code ?? undefined) &&
  refusal.code !== EARLY_ACCESS_OTHER_EMAIL;

/**
 * What the phone's sign-in requests carry of an early-access link's token (ADR 0078 §3), as the web's do: the e-mail
 * lookup sends it as `access`, the password sign-up and Apple's native sign-in as the header, a provider's sign-in
 * through the browser in its state. `access` is required, so a screen without a link says `undefined`.
 */
export function earlyAccessRequests(access: string | undefined) {
  const headers = earlyAccessHeaders(access);
  return {
    lookUp: (email: string) => ({ email, ...(access ? { access } : {}) }),
    headers,
    browser: (provider: SignInProvider, callbackURL: string) => ({
      provider,
      callbackURL,
      ...earlyAccessState(access),
    }),
    apple: (idToken: string) => ({
      provider: "apple" as const,
      idToken: { token: idToken },
      fetchOptions: { headers },
    }),
  };
}
