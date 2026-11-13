import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { STORAGE_KEYS } from "../src/lib/storage";

const INDEX = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
const NOW = 1_000_000;

/**
 * index.html as a browser starts it, its inline scripts run against fakes: the boot sky is up and the app's files
 * are loading. `retried`: when this tab last reloaded for them. `keeps: false`: storage that keeps nothing.
 */
function boot(
  env: {
    locale?: string;
    languages?: string[];
    retried?: number;
    keeps?: boolean;
    desktop?: { platform?: string };
  } = {},
) {
  const doc = new DOMParser().parseFromString(INDEX, "text/html");
  const stored = new Map<string, string>();
  if (env.retried !== undefined) stored.set(STORAGE_KEYS.bootRetry, String(env.retried));
  const errors: ((event: { target: unknown }) => void)[] = [];
  const frames: (() => void)[] = [];
  const invoked: string[] = [];
  let reloads = 0;
  const win: { __agentesBootFailed?: () => void; __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown } = {
    __agentesDesktop: env.desktop,
    __TAURI_INTERNALS__: env.desktop ? { invoke: async (cmd: string) => void invoked.push(cmd) } : undefined,
  };
  const globals = {
    window: win,
    document: doc,
    location: { href: "https://app.agentes.chat/org/acme", reload: () => void reloads++ },
    navigator: { languages: env.languages ?? ["pt-BR"], language: env.languages?.[0] ?? "pt-BR" },
    localStorage: { getItem: (key: string) => (key === "agentes.locale" ? (env.locale ?? null) : null) },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void (env.keeps !== false && stored.set(key, value)),
    },
    matchMedia: () => ({ matches: false }),
    Date: { now: () => NOW },
    requestAnimationFrame: (run: () => void) => frames.push(run),
    // Only a listener in the capture phase hears a script or a stylesheet that failed: their error doesn't bubble.
    addEventListener: (type: string, listener: (event: { target: unknown }) => void, capture?: boolean) => {
      if (type === "error" && capture === true) errors.push(listener);
    },
  };
  for (const script of doc.querySelectorAll("script:not([src])")) {
    new Function(...Object.keys(globals), script.textContent ?? "")(...Object.values(globals));
  }
  const alert = () => doc.querySelector("#root > .boot [role=alert]");
  return {
    doc,
    win,
    stored,
    invoked,
    reloads: () => reloads,
    alert,
    words: () => [...(alert()?.children ?? [])].map((el) => el.textContent),
    /** A file of the page failed to load. */
    fail: (tag: string, attribute: string, url: string) => {
      const el = doc.createElement(tag);
      el.setAttribute(attribute, url);
      for (const listener of errors) listener({ target: el });
    },
    paint: async () => {
      for (let i = 0; i < 2; i++) for (const run of frames.splice(0)) run();
      for (let i = 0; i < 3; i++) await Promise.resolve();
    },
  };
}

describe("a boot whose files didn't load (index.html)", () => {
  test("the first failure reloads, once in 30 s", () => {
    const page = boot();
    page.fail("script", "src", "/assets/index-4f2a.js");
    expect(page.reloads()).toBe(1);
    expect(page.stored.get(STORAGE_KEYS.bootRetry)).toBe(String(NOW));
    expect(page.alert()).toBeNull();
    // 30 s on, it reloads again: a deploy can take that long.
    const later = boot({ retried: NOW - 30_000 });
    later.fail("link", "href", "/assets/index-4f2a.css");
    expect(later.reloads()).toBe(1);
    // The language's file (main.tsx) does the same.
    const language = boot();
    language.win.__agentesBootFailed?.();
    expect(language.reloads()).toBe(1);
  });

  test("a second failure within 30 s says so over the boot sky, with Recarregar", () => {
    const page = boot({ retried: NOW - 10_000 });
    page.fail("script", "src", "/assets/index-4f2a.js");
    expect(page.reloads()).toBe(0);
    expect(page.alert()?.className).toBe("boot__box");
    expect(page.words()).toEqual([
      "O agentes.chat não abriu",
      "Uma parte do app não carregou. Confira a conexão e recarregue.",
      "Recarregar",
    ]);
    expect(page.doc.documentElement.lang).toBe("pt-BR");
    // The box is for everyone: the sky no longer hides from screen readers.
    expect(page.doc.querySelector(".boot")?.hasAttribute("aria-hidden")).toBe(false);
    expect(page.doc.querySelector(".boot img")).toBeNull();
    page.alert()?.querySelector("button")?.dispatchEvent(new Event("click"));
    expect(page.reloads()).toBe(1);
  });

  test("in English when the app, the landing's cookie or the browser says so", () => {
    for (const env of [{ locale: "en" }, { languages: ["en-US", "pt-BR"] }]) {
      const page = boot({ retried: NOW - 1000, ...env });
      page.fail("script", "src", "/assets/index-4f2a.js");
      expect(page.words()).toEqual([
        "agentes.chat didn't open",
        "Part of the app didn't load. Check your connection, then reload.",
        "Reload",
      ]);
      expect(page.doc.documentElement.lang).toBe("en");
    }
  });

  test("where this tab's storage keeps nothing, the box at once: it would reload forever", () => {
    const page = boot({ keeps: false });
    page.fail("script", "src", "/assets/index-4f2a.js");
    expect(page.reloads()).toBe(0);
    expect(page.alert()).not.toBeNull();
  });

  test("nothing happens once React replaced the boot sky, nor for files that aren't the app's", () => {
    const page = boot({ retried: NOW - 1000 });
    page.fail("img", "src", "/favicon.svg");
    page.fail("script", "src", "/sw.js");
    expect(page.reloads()).toBe(0);
    expect(page.alert()).toBeNull();
    page.doc.getElementById("root")?.replaceChildren(page.doc.createElement("main"));
    page.fail("script", "src", "/assets/route-77e1.js");
    page.win.__agentesBootFailed?.();
    expect(page.reloads()).toBe(0);
    expect(page.doc.querySelector("[role=alert]")).toBeNull();
    const fresh = boot();
    fresh.doc.getElementById("root")?.replaceChildren();
    fresh.fail("link", "href", "/assets/route-77e1.css");
    expect(fresh.reloads()).toBe(0);
  });

  test("in the desktop app it lifts the app's cover, and a Mac drags the window by the top", async () => {
    const mac = boot({ retried: NOW - 1000, desktop: {} });
    mac.fail("script", "src", "/assets/index-4f2a.js");
    expect(mac.doc.querySelector(".boot .boot__strip")?.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(mac.invoked).toEqual([]);
    await mac.paint();
    expect(mac.invoked).toEqual(["page_ready"]);

    const windows = boot({ retried: NOW - 1000, desktop: { platform: "windows" } });
    windows.fail("script", "src", "/assets/index-4f2a.js");
    expect(windows.doc.querySelector(".boot__strip")).toBeNull();
    await windows.paint();
    expect(windows.invoked).toEqual(["page_ready"]);
  });
});
