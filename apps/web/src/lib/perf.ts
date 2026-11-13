/**
 * Dev-only timing: "click → first paint of messages" per conversation.
 * `markOpen` on the sidebar click, `reportPainted` when the messages are on
 * screen. Silent in production builds and tests.
 */
const opened = new Map<string, number>();

const enabled = () => import.meta.env?.DEV === true && import.meta.env?.MODE !== "test";

export function markOpen(key: string) {
  if (!enabled() || typeof performance === "undefined") return;
  opened.set(key, performance.now());
}

/** Logs once per open: `[perf] #eng: 84 ms (cache)`. Returns the time, or null. */
export function reportPainted(key: string, label: string, fromCache: boolean): number | null {
  const at = opened.get(key);
  if (at === undefined || typeof performance === "undefined") return null;
  opened.delete(key);
  const ms = Math.round(performance.now() - at);
  console.debug(`[perf] ${label}: click → messages ${ms} ms${fromCache ? " (cache)" : ""}`);
  return ms;
}
