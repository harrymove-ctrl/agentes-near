/**
 * A tab opened before a deploy keeps running the old app: it reads events the new server sends
 * with old code (another agent's answer shown as the agent's raw words). The page's own bundle
 * (`/assets/index-<hash>.js`) is compared with the one the server's index.html names now; once
 * they differ the app is stale, and the next page change loads the new one.
 */
import { STORAGE_KEYS, sessionStore } from "./storage";

/** How often an open tab asks, besides on focus and after the realtime socket reconnects (a deploy). */
export const VERSION_CHECK_MS = 5 * 60_000;

/** The app's module script in a page's HTML, or null (a dev server, an unexpected page). */
export function entryOf(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/type="module"/.test(tag)) continue;
    const src = /\bsrc="([^"]+)"/.exec(tag)?.[1];
    if (src?.includes("/assets/")) return src;
  }
  return null;
}

export interface VersionWatch {
  check(): Promise<void>;
  readonly stale: boolean;
}

export function createVersionWatch(options: {
  /** The bundle this page runs (null: unknown, never stale). */
  loaded: string | null;
  fetchHtml: () => Promise<string>;
  /** Once, when a new version is first seen. */
  onStale: () => void;
}): VersionWatch {
  let stale = false;
  let inFlight: Promise<void> | null = null;
  return {
    get stale() {
      return stale;
    },
    check() {
      if (stale || !options.loaded) return Promise.resolve();
      inFlight ??= options
        .fetchHtml()
        .then((html) => {
          const current = entryOf(html);
          if (!current || current === options.loaded || stale) return;
          stale = true;
          options.onStale();
        })
        // Offline or a deploy in progress: the next check asks again.
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/** This page's bundle, as index.html named it. */
export function loadedEntry(doc: Document = document): string | null {
  return doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? null;
}

/** The server's index.html now (revalidated: never the browser's cached copy). */
export async function fetchIndexHtml(): Promise<string> {
  const res = await fetch("/index.html", { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`index.html: ${res.status}`);
  return res.text();
}

let current: VersionWatch | null = null;

/** The app's watch (main.tsx); `checkAppVersion` asks it from anywhere (the realtime reconnect). */
export function startVersionWatch(watch: VersionWatch) {
  current = watch;
  return watch;
}

export const checkAppVersion = () => current?.check() ?? Promise.resolve();

/** A page's file missing again within this long is a crash, not a deploy. */
const VERSION_RELOAD_MS = 60_000;
let reloading = false;
let stayed: ReturnType<typeof setTimeout> | undefined;
const reloadWatchers = new Set<() => void>();
const setReloading = (now: boolean) => {
  reloading = now;
  for (const watcher of reloadWatchers) watcher();
};

/** True once the app is reloading into a new version: nothing is reported, and the error screen is the boot sky. */
export const reloadingForNewVersion = () => reloading;

/** Calls `watcher` when `reloadingForNewVersion()` changes (`useSyncExternalStore`); returns the unsubscribe. */
export function onVersionReload(watcher: () => void) {
  reloadWatchers.add(watcher);
  return () => void reloadWatchers.delete(watcher);
}

/**
 * A page's code or styles from before a deploy are gone from the server (Vite's `vite:preloadError`): the app
 * reloads into the new version, at most once a minute. True when it reloads.
 */
export function reloadForNewVersion(now = Date.now()): boolean {
  if (now - Number(sessionStore.get(STORAGE_KEYS.versionReload)) < VERSION_RELOAD_MS) return false;
  sessionStore.set(STORAGE_KEYS.versionReload, String(now));
  // Storage that keeps nothing would reload forever.
  if (sessionStore.get(STORAGE_KEYS.versionReload) !== String(now)) return false;
  setReloading(true);
  window.location.reload();
  // Still here a moment later: the reload didn't happen (the person stayed when a page asked before leaving).
  stayed = setTimeout(resetVersionReload, 3000);
  return true;
}

/**
 * A crash in a tab a deploy left behind is most likely its old code meeting the new server's data (a sidebar tool it
 * has no page for): it reloads into the new version, at most once a minute, instead of staying on the error screen.
 * True when it reloads.
 */
export async function reloadIfStale(): Promise<boolean> {
  await checkAppVersion();
  return current?.stale === true && reloadForNewVersion();
}

/** Not reloading: the page stayed, or a test starts. */
export function resetVersionReload() {
  clearTimeout(stayed);
  setReloading(false);
}
