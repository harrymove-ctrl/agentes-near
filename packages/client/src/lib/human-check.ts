/**
 * The bot check before public forms (ADR 0075), for the web and phone apps alike: each app's widget (Turnstile on
 * the web, a hidden WebView on the phone) feeds `createHumanCheck`, and `withHumanCheck` sends each guarded call
 * with its token. Without a site key in `auth-config` there is no widget and calls go without one.
 */

/** The header the server reads the token from (mirrors `apps/server/src/http/human-check.ts`). */
export const HUMAN_CHECK_HEADER = "x-captcha-response";
/** What a page sends when it couldn't make a token, with Turnstile's error code after a colon when it gave one. */
export const HUMAN_CHECK_UNAVAILABLE = "unavailable";
/** The server's refusals: no token or a refused one, and a page that couldn't make one while it reaches Cloudflare. */
export const HUMAN_CHECK_REFUSED = "human_check";
export const HUMAN_CHECK_BLOCKED = "human_check_blocked";
/** How long a guarded call waits for the widget's token before it goes with `unavailable`. */
export const HUMAN_CHECK_WAIT_MS = 30_000;

/** What a token is made for: Cloudflare's answer must name the same action. */
export type HumanAction = "email-lookup" | "sign-in" | "sign-up" | "password-reset" | "ask-code" | "waitlist";

/** What a guarded call needs from a page's widget. */
export interface HumanCheck {
  /** The current token, or the next one, or `unavailable…` when the widget failed or 30 s passed. */
  token(): Promise<string>;
  /** After every guarded call: a token passes one check only. */
  reset(): void;
}

export const humanCheckHeaders = (token: string | undefined) => (token ? { [HUMAN_CHECK_HEADER]: token } : undefined);

export const isHumanCheckRefusal = (code: string | undefined) =>
  code === HUMAN_CHECK_REFUSED || code === HUMAN_CHECK_BLOCKED;

/**
 * One widget's tokens. The app tells it what the widget did: a token (`give`), an error (`fail`, with
 * Turnstile's code), a token running out (`expire`), or the widget asking the person to click (`hold`: then a
 * call waits for them however long it takes, since the check did load).
 */
export function createHumanCheck(waitMs = HUMAN_CHECK_WAIT_MS) {
  let current: string | null = null;
  let failure: string | null = null;
  let held = false;
  const waiting = new Map<(value: string) => void, ReturnType<typeof setTimeout> | undefined>();
  const settle = (value: string) => {
    for (const [resolve, timer] of waiting) {
      clearTimeout(timer);
      resolve(value);
    }
    waiting.clear();
  };
  return {
    give(token: string) {
      current = token;
      failure = null;
      held = false;
      settle(token);
    },
    fail(code?: string | number) {
      current = null;
      failure = code ? `${HUMAN_CHECK_UNAVAILABLE}:${code}` : HUMAN_CHECK_UNAVAILABLE;
      held = false;
      settle(failure);
    },
    expire() {
      current = null;
    },
    hold() {
      held = true;
      for (const [resolve, timer] of waiting) {
        clearTimeout(timer);
        waiting.set(resolve, undefined);
      }
    },
    reset() {
      current = null;
      failure = null;
      held = false;
    },
    token(): Promise<string> {
      if (current) return Promise.resolve(current);
      if (failure) return Promise.resolve(failure);
      return new Promise((resolve) => {
        const timer = held
          ? undefined
          : setTimeout(() => {
              waiting.delete(resolve);
              resolve(HUMAN_CHECK_UNAVAILABLE);
            }, waitMs);
        waiting.set(resolve, timer);
      });
    },
  };
}

/** A refusal for a token that expired or was spent: as an `ApiError`, or in Better Auth's `{ ok: false, code }`. */
const refusedToken = (outcome: unknown) => (outcome as { code?: unknown } | null)?.code === HUMAN_CHECK_REFUSED;

/**
 * Sends a guarded call with the widget's token, then resets the widget. On `human_check` it sends once more with
 * a fresh token, never on `human_check_blocked` (another try can't load the check). `check` null: the server
 * has no check, and the call goes without a token.
 */
export async function withHumanCheck<T>(
  check: HumanCheck | null | undefined,
  send: (token: string | undefined) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const token = check ? await check.token() : undefined;
    let outcome: T;
    try {
      outcome = await send(token);
    } catch (error) {
      check?.reset();
      if (check && attempt === 1 && refusedToken(error)) continue;
      throw error;
    }
    check?.reset();
    if (check && attempt === 1 && refusedToken(outcome)) continue;
    return outcome;
  }
}
