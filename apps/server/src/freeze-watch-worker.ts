/**
 * The freeze watch's thread (`startFreezeWatch`): it reads only the shared memory the main thread writes, so it goes on
 * while that thread is stuck, and reports for it.
 */
import { createErrorReporter } from "@agenteschat/adapters/error-reports";
import { readInFlight } from "@agenteschat/adapters/in-flight";
import type { FreezeWatchStart } from "./freeze-watch";
import { createLogger } from "./logger";

const CHECK_MS = 500;
/** Operations named in a report, newest first: a stuck process may hold dozens. */
const NAMED = 12;

addEventListener(
  "message",
  async (event: MessageEvent) => {
    const start = event.data as FreezeWatchStart;
    const errors = await createErrorReporter({
      dsn: start.reports?.dsn,
      environment: start.reports?.environment ?? "",
      release: start.reports?.release ?? "",
      runtime: { name: "bun", version: Bun.version },
    });
    const log = createLogger(start.logLevel, errors);
    let beat = readInFlight(start.memory).beat;
    let beatAt = Date.now();
    let checkedAt = beatAt;
    let stuck = false;
    setInterval(() => {
      const now = Date.now();
      const seen = readInFlight(start.memory);
      // This thread's own check came late: the whole process was paused (a host's sleep), not its event loop.
      const paused = now - checkedAt > 4 * CHECK_MS;
      checkedAt = now;
      if (seen.beat !== beat || paused) {
        if (stuck) log.warn("event loop back", { stuckMs: now - beatAt });
        beat = seen.beat;
        beatAt = now;
        stuck = false;
        return;
      }
      if (stuck || now - beatAt < start.freezeMs) return;
      stuck = true;
      // Listed in the order they started.
      const newest = seen.running.reverse();
      const tool = newest.find((op) => op.what.startsWith("tool "));
      const job = newest.find((op) => op.what.startsWith("job "));
      const named = newest
        .slice(0, NAMED)
        .map((op) => `${op.what}${op.runId ? ` (run ${op.runId})` : ""} for ${Math.round((now - op.since) / 1000)} s`);
      const what = named.length > 0 ? named.join(", ") : "nothing recorded";
      log.error("event loop stuck", {
        error: new Error(`event loop stuck for ${Math.round((now - beatAt) / 1000)} s; in flight: ${what}`),
        inFlight: named,
        runId: tool?.runId ?? job?.runId,
        kind: job?.what.slice("job ".length),
        tool: tool?.what.slice("tool ".length),
        unhandled: true,
      });
    }, CHECK_MS);
  },
  { once: true },
);
