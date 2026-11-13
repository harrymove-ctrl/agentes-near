import type { WebhookSetup } from "../api/types";

/** Where a Sentry organization makes an internal integration (Sentry sends any signed-in person to their own). */
export const SENTRY_NEW_INTEGRATION =
  "https://sentry.io/orgredirect/organizations/:orgslug/settings/developer-settings/new-internal/";

/** How long Testar waits for the service's first call before it says nothing came. */
export const WEBHOOK_TEST_MS = 3 * 60_000;

/**
 * A call this long before Testar was pressed still counts: GitHub pings the webhook the moment it's added, which can
 * be just before (the one-click add returns after GitHub made it).
 */
const RECENT_MS = 60_000;

/** A repository's page where GitHub adds a webhook, for `owner/name`; null for anything else. */
export function githubHookLink(repo: string): string | null {
  const name = repo.trim().replace(/^https:\/\/github\.com\//, "");
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? `https://github.com/${name}/settings/hooks/new` : null;
}

/**
 * What the setup shows: `working` (a call with the right secret came), `waiting` (Testar waits for one), `refused` (a
 * call came with another secret), `timeout` (Testar waited `WEBHOOK_TEST_MS` for nothing) or `idle`. `since`: when
 * Testar was pressed (null: not testing).
 */
export function webhookTestState(
  setup: Pick<WebhookSetup, "receivedAt" | "refusedAt"> | undefined,
  since: number | null,
  now: number,
): "idle" | "waiting" | "working" | "refused" | "timeout" {
  if (!setup) return "idle";
  const received = setup.receivedAt ? Date.parse(setup.receivedAt) : null;
  const refused = setup.refusedAt ? Date.parse(setup.refusedAt) : null;
  if (since === null) {
    if (refused !== null && (received === null || refused > received)) return "refused";
    return received !== null ? "working" : "idle";
  }
  if (received !== null && received >= since - RECENT_MS && (refused === null || received >= refused)) return "working";
  if (refused !== null && refused >= since - RECENT_MS) return "refused";
  return now - since >= WEBHOOK_TEST_MS ? "timeout" : "waiting";
}
