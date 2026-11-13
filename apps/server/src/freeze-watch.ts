import { beatInFlight, inFlightMemory } from "@agenteschat/adapters/in-flight";
import type { Logger } from "./logger";

/** How often this thread's event loop beats for the watch. */
const BEAT_MS = 1000;
/** How long without a beat the watch takes for a frozen event loop. */
export const FREEZE_MS = 5000;

export interface FreezeWatchOptions {
  logLevel: "debug" | "info" | "warn" | "error";
  /** Where the error goes besides the log (`SENTRY_DSN`); absent: the log line only. */
  reports?: { dsn: string; environment: string; release: string };
  freezeMs?: number;
}

/** What the watch's thread is handed once it starts. */
export type FreezeWatchStart = FreezeWatchOptions & { memory: SharedArrayBuffer; freezeMs: number };

/**
 * A thread of its own that watches this one's event loop. Synchronous work that never yields (a parse that grows with
 * the square of a huge input, a loop that doesn't end) stops every request, job and timer here, so nothing on this
 * thread can tell. When the beats stop for `freezeMs`, the watch logs an error (reported) naming the jobs and tool calls
 * in flight (`startInFlight`), and a line when they come back. `log` hears of a watch that couldn't run.
 */
export function startFreezeWatch(options: FreezeWatchOptions, log?: Pick<Logger, "warn">): () => void {
  // No extension: the source has the `.ts`, a bundle (native mode) its `.js` beside it, built as an entry of its own.
  const worker = new Worker(new URL("./freeze-watch-worker", import.meta.url).href, { smol: true });
  worker.addEventListener("error", (event) => log?.warn("the freeze watch stopped", { error: event.message }));
  const start: FreezeWatchStart = { ...options, memory: inFlightMemory, freezeMs: options.freezeMs ?? FREEZE_MS };
  worker.postMessage(start);
  worker.unref();
  const beat = setInterval(beatInFlight, BEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    worker.terminate();
  };
}
