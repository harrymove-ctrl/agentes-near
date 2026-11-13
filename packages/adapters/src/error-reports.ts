import { REPORT_OPTIONS } from "./error-scrub";

/**
 * A report's tags: pseudonymous internal ids (org_id, user_id, agent_id, run_id, machine_id), the route as a
 * pattern, the HTTP method and status, a job's kind and attempt. Empty values are left out.
 */
export type ErrorTags = Record<string, string | number | boolean | null | undefined>;

/** Where the server's unexpected errors go besides its log (ADR 0104). */
export interface ErrorReporter {
  /** Reports `error`; `unhandled`: nothing caught it. Returns the report's id, or undefined when none is sent. */
  capture(error: unknown, tags?: ErrorTags, unhandled?: boolean): string | undefined;
  /** Waits up to `timeoutMs` for the reports still on their way, before the process exits. */
  flush(timeoutMs: number): Promise<boolean>;
}

export const noErrorReports: ErrorReporter = { capture: () => undefined, flush: async () => true };

export interface ErrorReportsOptions {
  /** A project's DSN on a Sentry-compatible server (`SENTRY_DSN`); absent: no reports. */
  dsn?: string;
  environment: string;
  release: string;
  fetch?: typeof fetch;
  /** What runs the reporting code: the server's Bun, the phone app's JavaScript engine. */
  platform?: string;
  runtime: { name: string; version?: string };
}

/** Reports wait at most this long for the server that takes them. */
const SEND_TIMEOUT_MS = 10_000;

/**
 * Error reports to a Sentry-compatible server, through the Sentry SDK: errors only, scrubbed (`scrubEvent`), each
 * deduplicated and held back while the server rate-limits. Without a DSN nothing is sent and the SDK is never loaded.
 */
export async function createErrorReporter(
  options: ErrorReportsOptions,
  load = () => import("@sentry/core"),
): Promise<ErrorReporter> {
  if (!options.dsn) return noErrorReports;
  const sentry = await load();
  const send = options.fetch ?? fetch;
  const client = new sentry.ServerRuntimeClient({
    ...REPORT_OPTIONS,
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    platform: options.platform ?? "node",
    runtime: options.runtime,
    _metadata: { sdk: { name: "sentry.javascript.core", version: sentry.SDK_VERSION } },
    integrations: [sentry.dedupeIntegration(), sentry.linkedErrorsIntegration()],
    stackParser: sentry.createStackParser(sentry.nodeStackLineParser()),
    transport: (transport) =>
      sentry.createTransport(transport, async ({ body }) => {
        const res = await send(transport.url, {
          method: "POST",
          // A string, or bytes only for an attachment, which these reports never carry.
          body: body as string,
          headers: transport.headers,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        return {
          statusCode: res.status,
          headers: {
            "x-sentry-rate-limits": res.headers.get("x-sentry-rate-limits"),
            "retry-after": res.headers.get("retry-after"),
          },
        };
      }),
  });
  client.init();
  return {
    capture(error, tags = {}, unhandled = false) {
      const scope = new sentry.Scope();
      scope.setClient(client);
      for (const [name, value] of Object.entries(tags)) {
        if (value !== undefined && value !== null && value !== "") scope.setTag(name, String(value));
      }
      return scope.captureException(error, { data: { mechanism: { type: "generic", handled: !unhandled } } });
    },
    flush: async (timeoutMs) => client.flush(timeoutMs),
  };
}

/** For tests: keeps what was reported. */
export function createFakeErrorReporter() {
  const reports: { error: unknown; tags: ErrorTags; unhandled: boolean }[] = [];
  const reporter: ErrorReporter = {
    capture(error, tags = {}, unhandled = false) {
      reports.push({ error, tags, unhandled });
      return `report-${reports.length}`;
    },
    flush: async () => true,
  };
  return { ...reporter, reports };
}
