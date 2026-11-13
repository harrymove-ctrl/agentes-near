import { isIP } from "node:net";
import { limitIp } from "./rate-limiter";

/**
 * A bot check before public forms (ADR 0075): Cloudflare Turnstile, on only when both of its keys are set. Pages
 * send the widget's token in `x-captcha-response`, and a page that couldn't make one sends `unavailable`.
 */

/** What a token was made for: the widget's `action`, checked against Cloudflare's answer. */
export type HumanAction = "email-lookup" | "sign-in" | "sign-up" | "password-reset" | "ask-code" | "waitlist";

/**
 * `ok`: Cloudflare answers and takes the secret. While `unreachable` (siteverify doesn't answer, or the widget's
 * script doesn't load from here) or `secret_refused`, every request goes through unchecked.
 */
export type HumanCheckState = "ok" | "unreachable" | "secret_refused";

/**
 * `human_check`: no token, or one Cloudflare refuses. `human_check_blocked`: the page couldn't make a token while
 * this server reaches Cloudflare, so something on the person's side stopped the widget.
 */
export type HumanCheckRefusal = "human_check" | "human_check_blocked";

/** What the operator API's `/health` reports as `botCheck`. */
export interface HumanCheckStatus {
  state: HumanCheckState;
  /** When it took this state. */
  since: Date;
  /**
   * Networks refused `human_check_blocked` in the last 10 minutes, an IPv6 one by its /64. Each counts once however
   * often it asks, since any client can claim its page couldn't make a token.
   */
  blocked: number;
  /** Tokens Cloudflare passed in the last 10 minutes. A widget down for everyone makes them fall as `blocked` rises. */
  passed: number;
  /** The secret is one of Cloudflare's test secrets: they refuse real tokens, and the one that passes takes a dummy token from anyone. */
  testing: boolean;
}

export interface HumanCheck {
  /** The widget's site key, for pages. */
  readonly siteKey: string;
  /** Null when the request may go on. */
  verify(token: string | null | undefined, action: HumanAction, ip: string): Promise<HumanCheckRefusal | null>;
  /** Whether Cloudflare answers and takes the secret: at boot, and again when a page couldn't make a token. */
  probe(): Promise<HumanCheckState>;
  status(): HumanCheckStatus;
}

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";
/** What a page sends when it couldn't make a token, with Turnstile's error code after a colon when it gave one. */
export const HUMAN_CHECK_UNAVAILABLE = "unavailable";
/** Cloudflare's dummy token: a real secret refuses it as a token, while a wrong secret is refused itself. */
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** Cloudflare's longest token. */
const MAX_TOKEN = 2048;
const TIMEOUT_MS = 5_000;
/** A page's `unavailable` asks Cloudflare again once the last probe is this old. */
const PROBE_EVERY_MS = 60_000;
/** What `status` counts over. */
const WINDOW_MINUTES = 10;
/** Any client can send a site-key code, so a wrong key is logged at most this often. */
const SITE_KEY_LOG_EVERY_MS = 60_000;
/** Turnstile's client error codes for a site key it refuses (110100, 400020) and a host it doesn't allow (110200). */
const SITE_KEY_CODES = new Set(["110100", "400020", "110200"]);
const SECRET_REFUSED = new Set(["missing-input-secret", "invalid-input-secret"]);

interface Siteverify {
  success: boolean;
  "error-codes"?: string[];
  hostname?: string;
  action?: string;
  metadata?: { result_with_testing_key?: boolean };
}

type Log = (message: string, data?: Record<string, unknown>) => void;

/**
 * Turnstile's siteverify, our own call rather than Better Auth's captcha plugin: one policy for every form, an
 * action per form, and a fake `fetch` in tests. A token counts only for its action, seen by Cloudflare on one of
 * `hostnames`, except the answers of Cloudflare's test keys (any host, no action). When Cloudflare can't be
 * reached, or refuses the secret, requests go through and each is logged: nobody is locked out of signing in by
 * someone else's outage, and every rate limit still holds.
 */
export function createTurnstileCheck(options: {
  siteKey: string;
  secretKey: string;
  /** Where our pages run the widget: `PUBLIC_URL`'s host. */
  hostnames: string[];
  fetch?: typeof fetch;
  now?: () => number;
  log?: { error: Log };
}): HumanCheck {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const logError: Log = (message, data) => options.log?.error(message, data);
  let current: { state: HumanCheckState; since: Date } = { state: "ok", since: new Date(now()) };
  let probedAt = Number.NEGATIVE_INFINITY;
  let probing: Promise<HumanCheckState> | null = null;
  let testing = false;
  let siteKeyLoggedAt = Number.NEGATIVE_INFINITY;
  /** Networks refused `human_check_blocked`, with when, oldest first. */
  const blocked = new Map<string, number>();
  /** Tokens passed per minute (minutes since the epoch). */
  const passed = new Map<number, number>();

  const become = (state: HumanCheckState) => {
    if (state !== current.state) current = { state, since: new Date(now()) };
  };

  /** Cloudflare's answer, or `unreachable` after one retry (no answer in time, 5xx or `internal-error`). */
  const siteverify = async (token: string, ip?: string): Promise<Siteverify | "unreachable"> => {
    const body = JSON.stringify({
      secret: options.secretKey,
      response: token,
      ...(ip && isIP(ip) ? { remoteip: ip } : {}),
      // The retry carries the same key, so Cloudflare answers it as the same check.
      idempotency_key: crypto.randomUUID(),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await http(TURNSTILE_VERIFY_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status >= 500) continue;
        const answer = (await res.json()) as Siteverify;
        if (answer["error-codes"]?.includes("internal-error")) continue;
        // Only Cloudflare's test secrets mark their answers so.
        testing = answer.metadata?.result_with_testing_key === true;
        return answer;
      } catch {
        // Another try, then unreachable.
      }
    }
    return "unreachable";
  };

  const stateOf = (answer: Siteverify | "unreachable"): HumanCheckState =>
    answer === "unreachable"
      ? "unreachable"
      : answer["error-codes"]?.some((code) => SECRET_REFUSED.has(code))
        ? "secret_refused"
        : "ok";

  const scriptLoads = async () => {
    try {
      const res = await http(TURNSTILE_SCRIPT_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  };

  const probe = () => {
    probing ??= (async () => {
      const [answer, script] = await Promise.all([siteverify(DUMMY_TOKEN), scriptLoads()]);
      const state = stateOf(answer);
      probedAt = now();
      become(state === "ok" && !script ? "unreachable" : state);
      return current.state;
    })().finally(() => {
      probing = null;
    });
    return probing;
  };

  /** Drops what is older than the last 10 minutes. */
  const prune = () => {
    const at = now();
    for (const [network, when] of blocked) {
      if (when > at - WINDOW_MINUTES * 60_000) break;
      blocked.delete(network);
    }
    for (const minute of passed.keys()) if (minute <= Math.floor(at / 60_000) - WINDOW_MINUTES) passed.delete(minute);
  };

  /** A page that couldn't make a token: through only while this server can't reach Cloudflare either. */
  const unavailable = async (token: string, action: HumanAction, ip: string): Promise<HumanCheckRefusal | null> => {
    const code = token.slice(HUMAN_CHECK_UNAVAILABLE.length + 1);
    if (SITE_KEY_CODES.has(code) && now() - siteKeyLoggedAt >= SITE_KEY_LOG_EVERY_MS) {
      siteKeyLoggedAt = now();
      logError("bot check: Turnstile refuses TURNSTILE_SITE_KEY on this page (wrong key, or a host it doesn't allow)", {
        code,
        action,
      });
    }
    if (now() - probedAt >= PROBE_EVERY_MS) await probe();
    if (current.state !== "ok") {
      logError("bot check unavailable, request let through", { reason: current.state, action });
      return null;
    }
    prune();
    const network = limitIp(ip);
    // Deleted first, so the map stays oldest first.
    blocked.delete(network);
    blocked.set(network, now());
    return "human_check_blocked";
  };

  return {
    siteKey: options.siteKey,
    async verify(token, action, ip) {
      if (token === HUMAN_CHECK_UNAVAILABLE || token?.startsWith(`${HUMAN_CHECK_UNAVAILABLE}:`)) {
        return unavailable(token, action, ip);
      }
      if (!token || token.length > MAX_TOKEN) return "human_check";
      const answer = await siteverify(token, ip);
      become(stateOf(answer));
      if (answer === "unreachable" || current.state !== "ok") {
        logError("bot check unavailable, request let through", { reason: current.state, action });
        return null;
      }
      if (!answer.success) return "human_check";
      const ours = answer.action === action && options.hostnames.includes(answer.hostname ?? "");
      if (!ours && answer.metadata?.result_with_testing_key !== true) return "human_check";
      prune();
      const minute = Math.floor(now() / 60_000);
      passed.set(minute, (passed.get(minute) ?? 0) + 1);
      return null;
    },
    probe,
    status() {
      // The operator API reads it often: while Cloudflare fails, a read notices its return even with no traffic.
      if (current.state !== "ok" && now() - probedAt >= PROBE_EVERY_MS) void probe();
      prune();
      const passes = [...passed.values()].reduce((sum, n) => sum + n, 0);
      return { ...current, blocked: blocked.size, passed: passes, testing };
    },
  };
}
