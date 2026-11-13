import type { HumanAction, HumanCheck, HumanCheckRefusal } from "@agenteschat/adapters";
import { ConfigError } from "@agenteschat/config";
import type { Logger } from "../logger";
import { requestIp } from "./client-ip";

/** Where pages send the bot check's token: Better Auth's captcha plugin reads the same header. */
export const HUMAN_CHECK_HEADER = "x-captcha-response";

const REFUSALS: Record<HumanCheckRefusal, string> = {
  human_check: "Couldn't confirm a person is asking. Try again.",
  human_check_blocked: "The bot check didn't load. Try another browser or network.",
};

/** A public form's bot check (ADR 0075): the refusal to answer with a 403, or null when it passes or there is none. */
export async function humanCheckRefusal(
  check: HumanCheck | null | undefined,
  headers: { get(name: string): string | null | undefined },
  action: HumanAction,
  trustedProxies: readonly string[] | undefined,
): Promise<{ code: HumanCheckRefusal; message: string } | null> {
  if (!check) return null;
  const code = await check.verify(headers.get(HUMAN_CHECK_HEADER), action, requestIp(headers, trustedProxies));
  return code ? { code, message: REFUSALS[code] } : null;
}

/**
 * At boot, like a half pair of keys, a secret Cloudflare refuses stops the server (a `ConfigError`): the check
 * would otherwise let everything through unseen. Unreachable, the server starts and lets requests through. One of
 * Cloudflare's test secrets starts it with a warning, since a test server runs one on purpose.
 */
export async function checkHumanCheckAtBoot(check: HumanCheck | null | undefined, log: Logger) {
  if (!check) return;
  const state = await check.probe();
  if (state === "secret_refused") {
    throw new ConfigError([
      "TURNSTILE_SECRET_KEY: Cloudflare refuses this secret key. Copy the widget's secret key from Cloudflare's dashboard, or unset both Turnstile keys.",
    ]);
  }
  if (state === "unreachable")
    log.error("bot check: Cloudflare can't be reached, requests go through until it answers");
  else if (check.status().testing)
    log.warn(
      "bot check: TURNSTILE_SECRET_KEY is one of Cloudflare's test secrets. They refuse real tokens, so people can't pass, and the one that passes takes a public dummy token from anyone. Anywhere but a test server, copy the widget's secret key from Cloudflare's dashboard.",
    );
  else log.info("bot check on (Cloudflare Turnstile)");
}
