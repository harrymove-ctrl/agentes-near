import {
  createErrorReporter,
  type ErrorReporter,
  type ErrorTags,
  noErrorReports,
} from "@agenteschat/adapters/error-reports";
import type { ErrorReportsConfig } from "@agenteschat/client";
import Constants from "expo-constants";
import { Platform } from "react-native";

type Handler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = { getGlobalHandler(): Handler; setGlobalHandler(handler: Handler): void };

/** Reports kept while the server hasn't said yet where they go, at most. */
const MAX_WAITING = 20;

let reporter: ErrorReporter | null = null;
let waiting: { error: unknown; tags: ErrorTags; unhandled: boolean }[] = [];
let scope: ErrorTags = {};

/**
 * Reports an error of the phone app (ADR 0104): scrubbed as the server's and the web's are, to where the server says
 * (`auth-config`'s `mobileErrorReports`). Kept until that's known, dropped if it says nowhere.
 */
export function reportError(error: unknown, tags: ErrorTags = {}, unhandled = false) {
  const all = { ...scope, os: Platform.OS, ...tags };
  if (reporter) reporter.capture(error, all, unhandled);
  else if (waiting.length < MAX_WAITING) waiting.push({ error, tags: all, unhandled });
}

/** Who and where, for the reports from now on: internal ids only. */
export function setErrorScope(next: { orgId?: string; userId?: string }) {
  scope = { org_id: next.orgId, user_id: next.userId };
}

/** Reports go where this server says, under the app's own version; null: nowhere, and what was kept is dropped. */
export async function startErrorReports(config: ErrorReportsConfig | null) {
  const next = config
    ? await createErrorReporter({
        dsn: config.dsn,
        environment: config.environment,
        release: `mobile@${Constants.expoConfig?.version ?? "0"}`,
        platform: "javascript",
        runtime: { name: Platform.OS },
      }).catch(() => noErrorReports)
    : noErrorReports;
  reporter = next;
  const kept = waiting;
  waiting = [];
  for (const w of kept) next.capture(w.error, w.tags, w.unhandled);
}

/**
 * Errors nothing caught (a tap's handler, a timer) are reported too, before the system's handler goes on. A promise
 * nobody awaited never reaches this handler in a release build.
 */
export function catchGlobalErrors() {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils) return;
  const next = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    reportError(error, { fatal: Boolean(isFatal) }, true);
    next(error, isFatal);
  });
}
