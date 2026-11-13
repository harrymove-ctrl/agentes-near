// The subpath, not the package: the freeze watch's thread loads this file and nothing else of the adapters.
import { type ErrorReporter, type ErrorTags, noErrorReports } from "@agenteschat/adapters/error-reports";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Log fields a reported error takes as tags (internal ids and what was running), under these names. */
const TAG_FIELDS: Record<string, string> = {
  orgId: "org_id",
  userId: "user_id",
  agentId: "agent_id",
  runId: "run_id",
  machineId: "machine_id",
  requestId: "request_id",
  route: "route",
  method: "method",
  status: "status",
  job: "job",
  kind: "job_kind",
  jobId: "job_id",
  attempt: "job_attempt",
  outcome: "job_outcome",
  socket: "socket",
  handler: "handler",
  type: "event_type",
  tool: "tool",
};

/**
 * Minimal structured logger: one JSON object per line on stdout, which every
 * log collector understands without configuration. An error line that carries
 * what was thrown (`error`) is also reported to `errors` (ADR 0104), tagged with
 * its `TAG_FIELDS`; `unhandled: true` says nothing caught it.
 */
export function createLogger(minLevel: Level, errors: ErrorReporter = noErrorReports) {
  const log = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (order[level] >= order[minLevel]) {
      const thrown = fields && "error" in fields ? { error: String(fields.error) } : {};
      const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields, ...thrown });
      (level === "error" ? console.error : console.log)(line);
    }
    if (level !== "error" || !fields || !("error" in fields)) return;
    const tags: ErrorTags = { log: msg };
    for (const [field, tag] of Object.entries(TAG_FIELDS)) {
      const value = fields[field];
      if (typeof value === "string" || typeof value === "number") tags[tag] = value;
    }
    try {
      errors.capture(fields.error, tags, fields.unhandled === true);
    } catch {
      // A report that can't be made never fails what logged it: the line above holds the error.
    }
  };
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
    /** Waits up to `timeoutMs` for the reports still on their way: before the process exits. */
    flush: (timeoutMs: number) => errors.flush(timeoutMs),
  };
}

export type Logger = ReturnType<typeof createLogger>;

/** A request's path as a log line keeps it: a routine's webhook address carries its credential (`/api/hooks/<token>`). */
export const loggedPath = (path: string) => path.replace(/^\/api\/hooks\/[^/]+/, "/api/hooks/…");
