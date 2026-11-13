import { REPORT_OPTIONS, scrubEvent } from "@agenteschat/adapters/error-scrub";
import type { ErrorReportsConfig } from "@agenteschat/client";
import { captureException, init, setTags, setUser } from "@sentry/browser";
import { reloadingForNewVersion } from "./app-version";
import { type ErrorSdk, shortErrorId } from "./error-reports";

/**
 * The Sentry browser SDK for errors only (no sessions, traces or replays), every event scrubbed (ADR 0104). Its own
 * handlers report the page's errors and unhandled rejections from now on. `taken`: each report it sends, by id.
 */
export function startSdk(config: ErrorReportsConfig, taken: (eventId: string) => void): ErrorSdk {
  init({
    ...REPORT_OPTIONS,
    // After the SDK's own dedupe, which drops a repeat of the last report: what reaches here is sent.
    beforeSend: (event) => {
      // Its own handlers too: what fails while the app reloads into a new version is the old version's.
      if (reloadingForNewVersion()) return null;
      if (event.event_id) taken(event.event_id);
      return scrubEvent(event);
    },
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "BrowserSession"),
  });
  return {
    capture(error, eventId) {
      captureException(error, { event_id: eventId, captureContext: { tags: { error_id: shortErrorId(eventId) } } });
    },
    scope({ route, orgId, userId }) {
      setTags({ route, org_id: orgId });
      setUser(userId ? { id: userId } : null);
    },
  };
}
