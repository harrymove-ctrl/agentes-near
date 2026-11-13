import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  createVersionWatch,
  entryOf,
  reloadForNewVersion,
  reloadIfStale,
  reloadingForNewVersion,
  resetVersionReload,
  startVersionWatch,
} from "../src/lib/app-version";
import { STORAGE_KEYS } from "../src/lib/storage";

const page = (entry: string) =>
  `<!doctype html><html><head><script>var t = 1;</script><script type="module" crossorigin src="${entry}"></script></head></html>`;

describe("app version", () => {
  test("finds the app's module script in index.html", () => {
    expect(entryOf(page("/assets/index-abc.js"))).toBe("/assets/index-abc.js");
    expect(entryOf('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
    expect(entryOf("<html></html>")).toBeNull();
  });

  test("a new bundle on the server makes the tab stale, once", async () => {
    let html = page("/assets/index-abc.js");
    let staleCalls = 0;
    const watch = createVersionWatch({
      loaded: "/assets/index-abc.js",
      fetchHtml: async () => html,
      onStale: () => staleCalls++,
    });
    await watch.check();
    expect(watch.stale).toBe(false);
    html = page("/assets/index-def.js");
    await watch.check();
    await watch.check();
    expect(watch.stale).toBe(true);
    expect(staleCalls).toBe(1);
  });

  test("a failed fetch or an unknown page bundle never marks it stale", async () => {
    const failing = createVersionWatch({
      loaded: "/assets/index-abc.js",
      fetchHtml: async () => {
        throw new Error("offline");
      },
      onStale: () => {},
    });
    await failing.check();
    expect(failing.stale).toBe(false);
    const dev = createVersionWatch({ loaded: null, fetchHtml: async () => page("/assets/x.js"), onStale: () => {} });
    await dev.check();
    expect(dev.stale).toBe(false);
  });
});

describe("a page's file from before a deploy (vite:preloadError)", () => {
  afterEach(() => {
    // The app's watch is the module's: a stale one left here would reload the next file's error screens.
    startVersionWatch(createVersionWatch({ loaded: null, fetchHtml: async () => "", onStale: () => {} }));
    resetVersionReload();
    sessionStorage.clear();
  });

  test("reloads into the new version at most once a minute, and says it is reloading", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      expect(reloadingForNewVersion()).toBe(false);
      expect(reloadForNewVersion(1_000_000)).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadingForNewVersion()).toBe(true);
      expect(sessionStorage.getItem(STORAGE_KEYS.versionReload)).toBe("1000000");
      // The new page, its file missing again within the minute: a crash, not a deploy.
      resetVersionReload();
      expect(reloadForNewVersion(1_059_999)).toBe(false);
      expect(reloadingForNewVersion()).toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadForNewVersion(1_060_000)).toBe(true);
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      reload.mockRestore();
    }
  });

  test("a page still here a moment after asking to reload stayed (it asked before leaving): reports and the error screen come back", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    const later: (() => void)[] = [];
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void) => {
      later.push(run);
      return 0;
    }) as unknown as typeof setTimeout);
    try {
      expect(reloadForNewVersion(1_000_000)).toBe(true);
      expect(reloadingForNewVersion()).toBe(true);
      for (const run of later.splice(0)) run();
      expect(reloadingForNewVersion()).toBe(false);
    } finally {
      timers.mockRestore();
      reload.mockRestore();
    }
  });

  test("a crash in a tab a deploy left behind reloads into the new version; one in the current version stays", async () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    let html = page("/assets/index-abc.js");
    startVersionWatch(
      createVersionWatch({ loaded: "/assets/index-abc.js", fetchHtml: async () => html, onStale: () => {} }),
    );
    try {
      expect(await reloadIfStale()).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      html = page("/assets/index-def.js");
      expect(await reloadIfStale()).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloadingForNewVersion()).toBe(true);
    } finally {
      reload.mockRestore();
    }
  });

  test("never reloads where this tab's storage keeps nothing: it would reload forever", () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    const real = globalThis.sessionStorage;
    globalThis.sessionStorage = { getItem: () => null, setItem: () => {} } as unknown as Storage;
    try {
      expect(reloadForNewVersion(1_000_000)).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(reloadingForNewVersion()).toBe(false);
    } finally {
      globalThis.sessionStorage = real;
      reload.mockRestore();
    }
  });
});
