import { useSyncExternalStore } from "react";

/** The browser says it has no network. */
export const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

const onNetworkChange = (changed: () => void) => {
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);
  return () => {
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", changed);
  };
};

/** `browserOffline`, kept current. */
export const useBrowserOffline = () => useSyncExternalStore(onNetworkChange, browserOffline);

/**
 * A request that failed for the network (no answer from the server at all: `fetch` throws a `TypeError`, or the
 * browser is offline), not the server refusing it nor a bug.
 */
export const failedOffline = (error: unknown) => browserOffline() || error instanceof TypeError;
