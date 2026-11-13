/**
 * The usage report's sender (ADR 0060 §5): samples the host, sends the report once a day (the first about
 * an hour after the server first started), and prints it for `agentes telemetry`. What goes in it is
 * `buildTelemetryReport`.
 */
import { LOAD_SAMPLE_MS } from "@agenteschat/adapters";
import { inContainer, LoadWindow, machineSize, sampleLoad } from "@agenteschat/adapters/host-stats";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import {
  buildTelemetryReport,
  isAgentesCloud,
  markServerStarted,
  saveHostLoad,
  setNextReport,
  type TelemetryFacts,
  telemetrySends,
  telemetryState,
} from "@agenteschat/engine";
import type { Logger } from "./logger";
import { version } from "./version";

/** From the server's first start to its first report. */
export const FIRST_REPORT_MS = 3600_000;
export const REPORT_EVERY_MS = 24 * 3600_000;
/** A report that came due while the server was down goes this long after it starts again. */
export const OVERDUE_REPORT_MS = 10 * 60_000;
/** After a failed send; once they run out, the next day's report takes its place (nothing piles up). */
export const RETRY_MS = [5 * 60_000, 30 * 60_000, 2 * 3600_000];
const SEND_TIMEOUT_MS = 10_000;

/** How this server was installed: `INSTALL_MODE`, else `docker` inside a container, else `native`. */
export const installMode = (config: Pick<Config, "INSTALL_MODE">, container = inContainer()) =>
  config.INSTALL_MODE ?? (container ? "docker" : "native");

/** What this process knows about itself and its host. */
export function telemetryFacts(config: Config): TelemetryFacts {
  const container = inContainer();
  return {
    version,
    edition: isAgentesCloud(config.PUBLIC_URL) ? "cloud" : "selfhost",
    install: installMode(config, container),
    os: process.platform,
    arch: process.arch,
    // FILES_DIR is the compose file's data volume.
    host: { size: machineSize(config.FILES_DIR ?? process.cwd()), container },
  };
}

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => {
    const t = setTimeout(run, ms);
    t.unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export interface TelemetryDeps {
  db: Database;
  config: Config;
  log: Logger;
  fetch?: typeof fetch;
  timers?: Timers;
  sample?: typeof sampleLoad;
  now?: () => number;
}

/**
 * Samples the host every `LOAD_SAMPLE_MS` (always: `agentes telemetry` prints the load too) and, on a
 * production server where the report is on, sends it when it is due. The samples and the due time live in
 * the database, so a restart keeps both. Failures stay in the debug log: nobody sees them and nothing waits
 * on them.
 */
export function startTelemetry(deps: TelemetryDeps) {
  const { db, config, log } = deps;
  const timers = deps.timers ?? REAL_TIMERS;
  const post = deps.fetch ?? fetch;
  const take = deps.sample ?? sampleLoad;
  const now = deps.now ?? Date.now;
  const quiet = (error: unknown) => log.debug("usage report", { error: String(error) });
  let window = new LoadWindow();
  const pending = new Set<unknown>();
  let stopped = false;

  const later = (ms: number, run: () => Promise<void>) => {
    if (stopped) return;
    const timer = timers.set(() => {
      pending.delete(timer);
      if (stopped) return;
      run().catch(quiet);
    }, ms);
    pending.add(timer);
  };

  const sample = async () => {
    try {
      window.add(await take(), now());
      await saveHostLoad(db, window, new Date(now()));
    } finally {
      later(LOAD_SAMPLE_MS, sample);
    }
  };

  const send = async () => {
    const state = await telemetryState(db);
    if (!telemetrySends(config, state.enabled)) return "off";
    const report = await buildTelemetryReport(db, telemetryFacts(config), new Date(now()));
    const res = await post(config.TELEMETRY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return "sent";
  };

  // A due time in the past (the server was down) goes soon; a clock set back never waits over a day.
  const schedule = (due: number) =>
    later(Math.min(REPORT_EVERY_MS, Math.max(OVERDUE_REPORT_MS, due - now())), () => deliver(due));

  /** The report due at `due`, with its retries; then the next, a day after it. */
  const deliver = async (due: number, retry = 0): Promise<void> => {
    try {
      log.debug("usage report", { outcome: await send() });
    } catch (error) {
      const delay = RETRY_MS[retry];
      log.debug("usage report not sent", { error: String(error), retryInMs: delay ?? null });
      if (delay !== undefined) return later(delay, () => deliver(due, retry + 1));
    }
    // After days down, a day from now: not one report per day missed.
    const next = due + REPORT_EVERY_MS > now() ? due + REPORT_EVERY_MS : now() + REPORT_EVERY_MS;
    await setNextReport(db, new Date(next)).catch(quiet);
    schedule(next);
  };

  const cloud = isAgentesCloud(config.PUBLIC_URL);
  // A development server is nobody's installation.
  const sends = (cloud || config.TELEMETRY === "on") && config.NODE_ENV === "production";
  const ready = (async () => {
    const kept = await markServerStarted(db, new Date(now())).catch((error: unknown) => {
      quiet(error);
      return null;
    });
    window = new LoadWindow(kept?.hostSamples ?? []);
    await sample().catch(quiet);
    if (!sends) return;
    // ponytail: every replica sends its own report under the one instance id; claim the day in the row
    // (`next_report_at`, compare-and-set) if that matters.
    const due = kept?.nextReportAt?.getTime() ?? now() + FIRST_REPORT_MS;
    if (!kept?.nextReportAt) await setNextReport(db, new Date(due)).catch(quiet);
    schedule(due);
  })();
  if (sends) {
    log.info(
      `anonymous usage report: once a day to ${config.TELEMETRY_URL}${cloud ? "" : " unless turned off (TELEMETRY=off, or Settings → General)"}`,
    );
  }
  return {
    ready,
    stop() {
      stopped = true;
      for (const t of pending) timers.clear(t);
      pending.clear();
    },
  };
}

/** `agentes telemetry`: the next report, exactly, on stdout, and whether it goes out on stderr. Sends nothing. */
export async function printTelemetry(
  db: Database,
  config: Config,
  out: { write(text: string): unknown } = process.stdout,
  err: { write(text: string): unknown } = process.stderr,
  now = new Date(),
) {
  const state = await telemetryState(db);
  const report = await buildTelemetryReport(db, telemetryFacts(config), now);
  out.write(`${JSON.stringify(report, null, 2)}\n`);
  const on = `On: sent once a day to ${config.TELEMETRY_URL}.`;
  err.write(
    isAgentesCloud(config.PUBLIC_URL)
      ? `${on}\n`
      : telemetrySends(config, state.enabled)
        ? `${on} TELEMETRY=off in .env turns it off.\n`
        : config.TELEMETRY === "off"
          ? "Off (TELEMETRY=off): nothing is sent.\n"
          : "Off (turned off in Settings): nothing is sent.\n",
  );
}
