import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { loadStrings } from "@agenteschat/i18n/load";
import { type AppLocale, LOCALE_CODES } from "@agenteschat/i18n/locale";
import { loadI18n, savedLocale } from "../src/i18n";
import { LOCALE_FILES, localeOfModule, preloadLocale } from "../vite-locale-preload";

const INDEX = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
const FILES = Object.fromEntries(LOCALE_CODES.map((code) => [code, `/assets/${code}-x1.js`]));

afterEach(() => localStorage.clear());

/** The language index.html preloads, its inline scripts run against this browser, the build's map filled in. */
function preloaded(env: { stored?: string; cookie?: string; languages: string[] }) {
  const doc = new DOMParser().parseFromString(INDEX.replace(LOCALE_FILES, JSON.stringify(FILES)), "text/html");
  Object.defineProperty(doc, "cookie", { value: env.cookie ?? "" });
  const globals = {
    window: {},
    document: doc,
    location: { href: "https://app.agentes.chat/", reload: () => {} },
    navigator: { languages: env.languages, language: env.languages[0] },
    localStorage: { getItem: (key: string) => (key === "agentes.locale" ? (env.stored ?? null) : null) },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
  };
  for (const script of doc.querySelectorAll("script:not([src])"))
    new Function(...Object.keys(globals), script.textContent ?? "")(...Object.values(globals));
  const links = [...doc.querySelectorAll('link[rel="modulepreload"]')].map((l) => l.getAttribute("href"));
  expect(links).toHaveLength(1);
  return Object.entries(FILES).find(([, file]) => file === links[0])?.[0];
}

/** What the app starts in, for the same browser. */
function started(env: { stored?: string; cookie?: string; languages: string[] }) {
  if (env.stored) localStorage.setItem("agentes.locale", env.stored);
  else localStorage.removeItem("agentes.locale");
  return savedLocale(env.languages, env.cookie ?? "");
}

describe("the language file loads with the app (#1)", () => {
  test("index.html preloads the very language the app starts in", () => {
    const browsers = [
      { stored: "de", languages: ["pt-BR"] },
      { stored: "auto", cookie: "agentes_locale=fr", languages: ["ja-JP"] },
      { cookie: "theme=dark; agentes_locale=es", languages: ["en-US"] },
      { languages: ["pt-PT"] },
      { languages: ["en-GB"] },
      { languages: ["zh-TW"] },
      { languages: ["in"] },
      { languages: ["xx", "ko-KR"] },
      { stored: "klingon", languages: ["it-IT"] },
      { languages: [] },
    ];
    for (const env of browsers) expect({ env, file: preloaded(env) }).toEqual({ env, file: started(env) });
  });

  test("in development there is no map: nothing is preloaded, and the page's boot fallback is untouched", () => {
    const doc = new DOMParser().parseFromString(INDEX, "text/html");
    expect(INDEX).toContain(LOCALE_FILES);
    expect(doc.querySelector('link[rel="modulepreload"]')).toBeNull();
  });

  test("the build gives index.html each language's own file, the bundle's chunk made from it", () => {
    expect(localeOfModule("/srv/app/packages/i18n/src/pt-BR.ts")).toBe("pt-BR");
    expect(localeOfModule("/srv/app/packages/i18n/src/en.ts")).toBe("en");
    expect(localeOfModule("/srv/app/packages/i18n/src/locales/zh-Hans.json")).toBe("zh-Hans");
    expect(localeOfModule("/srv/app/packages/i18n/src/locales/de.source.json")).toBeNull();
    expect(localeOfModule("/srv/app/packages/i18n/src/plurals.ts")).toBeNull();
    const plugin = preloadLocale();
    (plugin.configResolved as unknown as (config: { base: string }) => void)({ base: "/" });
    const chunk = (fileName: string, facadeModuleId: string | null) => ({ type: "chunk", fileName, facadeModuleId });
    const bundle = {
      a: chunk("assets/pt-BR-a1.js", "/srv/app/packages/i18n/src/pt-BR.ts"),
      b: chunk("assets/en-b2.js", "/srv/app/packages/i18n/src/en.ts"),
      c: chunk("assets/de-c3.js", "/srv/app/packages/i18n/src/locales/de.json"),
      d: chunk("assets/index-d4.js", "/srv/app/apps/web/index.html"),
      e: chunk("assets/vendor-e5.js", null),
      f: { type: "asset", fileName: "assets/index-f6.css" },
    };
    const hook = plugin.transformIndexHtml as unknown as {
      handler: (html: string, ctx: { bundle: typeof bundle }) => string;
    };
    expect(hook.handler(`<script>const f = (${LOCALE_FILES})[x];</script>`, { bundle })).toBe(
      '<script>const f = ({"pt-BR":"/assets/pt-BR-a1.js","en":"/assets/en-b2.js","de":"/assets/de-c3.js"})[x];</script>',
    );
  });

  test("a ready language downloads alone, no English beside it", async () => {
    const fetched: AppLocale[] = [];
    const real = { ...loadStrings };
    for (const code of LOCALE_CODES)
      loadStrings[code] = () => {
        fetched.push(code);
        return real[code]();
      };
    try {
      const i18n = await loadI18n("pt-BR");
      expect(fetched).toEqual(["pt-BR"]);
      expect(i18n.t("common.close")).toBe("Fechar");
    } finally {
      Object.assign(loadStrings, real);
    }
  });
});
