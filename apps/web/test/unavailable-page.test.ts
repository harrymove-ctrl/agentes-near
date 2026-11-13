import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALE_CODES } from "@agenteschat/i18n/locale";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

/** The page Caddy serves while the app is down (docker-compose.yml carries a copy, packages/setup tests it). */
const PAGE = readFileSync(join(import.meta.dir, "../public/unavailable.html"), "utf8");
const TOKENS = readFileSync(join(import.meta.dir, "../../../packages/ui/src/styles/tokens.css"), "utf8");

interface Env {
  /** Path, query and hash the page stands in for. */
  url?: string;
  locale?: string;
  theme?: string;
  cookie?: string;
  languages?: string[];
  dark?: boolean;
  desktop?: { platform?: string };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** The page opened at `env.url`, its scripts run against fakes: fetch, timers, frames, storage, location. */
function open(env: Env = {}) {
  const url = new URL(env.url ?? "/org/acme/c/general?tab=files#m-1", "https://app.agentes.chat");
  const doc = new DOMParser().parseFromString(PAGE, "text/html");
  let visibility = "visible";
  Object.defineProperty(doc, "cookie", { get: () => env.cookie ?? "" });
  Object.defineProperty(doc, "visibilityState", { get: () => visibility });

  let now = 0;
  let ids = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const setTimeout = (run: () => void, ms: number) => {
    timers.set(++ids, { at: now + ms, run });
    return ids;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  /** Moves the clock, running each timer that comes due on the way. */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].run();
    }
    now = until;
  };

  const asked: {
    url: string;
    init: RequestInit;
    answer: (status: number) => Promise<void>;
    fail: () => Promise<void>;
    redirect: () => Promise<void>;
  }[] = [];
  const fetch = (to: string, init: RequestInit) =>
    new Promise((resolve, reject) => {
      asked.push({
        url: to,
        init,
        answer: async (status) => {
          resolve({ status });
          await flush();
        },
        fail: async () => {
          reject(new TypeError("Failed to fetch"));
          await flush();
        },
        /** As fetch does: it follows a redirect unless told not to, and one to the apps' links or another site fails. */
        redirect: async () => {
          if (init.redirect === "manual") resolve({ status: 0, type: "opaqueredirect" });
          else reject(new TypeError("Failed to fetch"));
          await flush();
        },
      });
    });

  const frames: (() => void)[] = [];
  const invoked: string[] = [];
  const win = Object.assign(new EventTarget(), {
    __agentesDesktop: env.desktop,
    __TAURI_INTERNALS__: env.desktop ? { invoke: async (cmd: string) => void invoked.push(cmd) } : undefined,
  });
  const replaced: string[] = [];
  const globals = {
    window: win,
    document: doc,
    location: {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace: (to: string) => replaced.push(to),
    },
    navigator: { languages: env.languages ?? ["pt-BR"], language: env.languages?.[0] ?? "pt-BR" },
    localStorage: {
      getItem: (key: string) => ({ "agentes.locale": env.locale, "agentes.theme": env.theme })[key] ?? null,
    },
    matchMedia: (query: string) => ({ matches: env.dark === true && query.includes("dark") }),
    fetch,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (run: () => void) => frames.push(run),
    addEventListener: win.addEventListener.bind(win),
  };
  for (const script of doc.querySelectorAll("script")) {
    new Function(...Object.keys(globals), script.textContent ?? "")(...Object.values(globals));
  }
  return {
    doc,
    html: doc.documentElement,
    text: (id: string) => doc.getElementById(id)?.textContent,
    asked,
    replaced,
    invoked,
    advance,
    /** What is left of the wait before the next question, if one is set. */
    waiting: () => [...timers.values()].map((t) => t.at - now),
    hide: () => {
      visibility = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    show: () => {
      visibility = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    online: () => win.dispatchEvent(new Event("online")),
    /** Two frames on: the page has been on the glass. */
    paint: async () => {
      for (let i = 0; i < 2; i++) for (const run of frames.splice(0)) run();
      await flush();
    },
  };
}

const EN = {
  title: "agentes.chat will be right back",
  text: "The server isn't answering right now. This page opens by itself as soon as it's back.",
  paid: "If you just paid, there's no need to pay again.",
  retry: "Try now",
};
const PT = {
  title: "O agentes.chat já volta",
  text: "O servidor não está respondendo agora. Esta página abre sozinha assim que ele voltar.",
  paid: "Se você acabou de pagar, não precisa pagar de novo.",
  retry: "Tentar agora",
};

describe("the page Caddy serves while the app is down", () => {
  test("in the app's choice, else the landing's cookie, else the browser's first known language, else English", () => {
    const words = (page: ReturnType<typeof open>) => ({
      title: page.doc.title,
      heading: page.text("title"),
      text: page.text("text"),
      retry: page.text("retry"),
    });
    const pt = open({ languages: ["pt-BR"] });
    expect(pt.html.lang).toBe("pt-BR");
    expect(words(pt)).toEqual({ title: PT.title, heading: PT.title, text: PT.text, retry: PT.retry });
    const en = open({ locale: "en", languages: ["pt-BR"] });
    expect(en.html.lang).toBe("en");
    expect(words(en)).toEqual({ title: EN.title, heading: EN.title, text: EN.text, retry: EN.retry });
    expect(open({ languages: ["sv-SE"] }).html.lang).toBe("en");

    // Each of the twelve: picked in the app, from the cookie, from the browser.
    const ja = open({ locale: "ja", languages: ["pt-BR"] });
    expect(ja.html.lang).toBe("ja");
    expect(ja.doc.title).toBe("agentes.chat はまもなく戻ります");
    expect(ja.text("retry")).toBe("今すぐ試す");
    const fr = open({ cookie: "theme=x; agentes_locale=fr", languages: ["pt-BR"] });
    expect(fr.html.lang).toBe("fr");
    expect(fr.text("title")).toBe("agentes.chat revient tout de suite");
    expect(open({ languages: ["sv-SE", "fr-FR", "en"] }).html.lang).toBe("fr");
    expect(open({ languages: ["zh-TW"] }).html.lang).toBe("zh-Hans");
    expect(open({ languages: ["in-ID"] }).html.lang).toBe("id");
    expect(open({ cookie: "agentes_locale=pt", languages: ["en-US"] }).html.lang).toBe("pt-BR");

    // In that order: the app's choice, then the cookie, then the browser. "auto" skips the cookie.
    expect(open({ locale: "pt-BR", cookie: "agentes_locale=en", languages: ["en"] }).html.lang).toBe("pt-BR");
    expect(open({ locale: "auto", cookie: "agentes_locale=de", languages: ["ru"] }).html.lang).toBe("ru");
    expect(open({ cookie: "agentes_locale=english", languages: ["pt"] }).html.lang).toBe("pt-BR");
  });

  test("dark from the app's choice, else from the system", () => {
    expect(open().html.dataset.theme).toBe("light");
    expect(open({ theme: "dark" }).html.dataset.theme).toBe("dark");
    expect(open({ dark: true }).html.dataset.theme).toBe("dark");
    expect(open({ theme: "light", dark: true }).html.dataset.theme).toBe("light");
  });

  test("while the proxy answers for the server it keeps waiting, longer each time, up to 30 s", async () => {
    const page = open();
    expect(page.asked).toHaveLength(0);
    page.advance(2999);
    expect(page.asked).toHaveLength(0);
    page.advance(1);
    expect(page.asked).toHaveLength(1);
    expect(page.asked[0]?.url).toBe("/org/acme/c/general?tab=files");
    expect(page.asked[0]?.init).toEqual({ cache: "no-store", credentials: "same-origin", redirect: "manual" });
    const waits: number[] = [];
    // Caddy's, Cloudflare's, and no answer at all.
    for (const status of [503, 502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530, 0]) {
      const last = page.asked.at(-1);
      await (status === 0 ? last?.fail() : last?.answer(status));
      waits.push(page.waiting()[0] ?? -1);
      page.advance(page.waiting()[0] ?? 0);
    }
    expect(page.replaced).toEqual([]);
    expect(waits.slice(0, 4)).toEqual([4500, 6750, 10125, 15187.5]);
    expect(waits.at(-1)).toBe(30000);
    expect(page.asked).toHaveLength(14);
  });

  test("once the server answers, the address loads again: a GET of its path and query, without the hash", async () => {
    const page = open();
    page.advance(3000);
    await page.asked[0]?.answer(200);
    expect(page.replaced).toEqual(["/org/acme/c/general?tab=files"]);
    // Any answer of the server's own: it says what it has to say.
    const refused = open({ url: "/settings?x=1" });
    refused.advance(3000);
    await refused.asked[0]?.answer(404);
    expect(refused.replaced).toEqual(["/settings?x=1"]);
    expect(refused.doc.getElementById("retry")?.getAttribute("href")).toBe("/settings?x=1");
  });

  test("an answer that redirects is the server's: the address loads (the apps' links, another site)", async () => {
    const page = open();
    page.advance(3000);
    await page.asked[0]?.redirect();
    expect(page.replaced).toEqual(["/org/acme/c/general?tab=files"]);
  });

  test("an address under /api/ runs once, when it loads: until then the page asks for the server's health", async () => {
    // A provider's one-time return: asked twice, the load would find its link used.
    const callback = "/api/app/connectors/oauth/callback?state=s&code=c";
    const page = open({ url: callback });
    expect(page.doc.getElementById("retry")?.getAttribute("href")).toBe(callback);
    page.advance(3000);
    // The server's own 503 while it shuts down or has no database.
    await page.asked[0]?.answer(503);
    page.advance(page.waiting()[0] ?? 0);
    await page.asked[1]?.answer(200);
    expect(page.asked.map((asked) => asked.url)).toEqual(["/api/health", "/api/health"]);
    expect(page.replaced).toEqual([callback]);
  });

  test("opened at its own address, it goes to /", async () => {
    const page = open({ url: "/unavailable.html" });
    expect(page.doc.getElementById("retry")?.getAttribute("href")).toBe("/");
    page.advance(3000);
    expect(page.asked[0]?.url).toBe("/");
    await page.asked[0]?.answer(200);
    expect(page.replaced).toEqual(["/"]);
  });

  test("Tentar agora loads the address at once", () => {
    const page = open();
    const click = new Event("click", { cancelable: true });
    page.doc.getElementById("retry")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(page.replaced).toEqual(["/org/acme/c/general?tab=files"]);
  });

  test("a hidden tab doesn't ask; coming back or back online asks at once, one question at a time", async () => {
    const page = open();
    page.hide();
    page.advance(60_000);
    expect(page.asked).toHaveLength(0);
    page.show();
    expect(page.asked).toHaveLength(1);
    page.online();
    expect(page.asked).toHaveLength(1);
    await page.asked[0]?.answer(503);
    expect(page.waiting()).toEqual([4500]);
    page.online();
    expect(page.asked).toHaveLength(2);
    expect(page.waiting()).toEqual([]);
  });

  test("the line for someone who just paid shows only on billing's return from Checkout", () => {
    const done = open({ url: "/done?session_id=cs_test" });
    expect(done.doc.getElementById("paid")?.hidden).toBe(false);
    expect(done.text("paid")).toBe(PT.paid);
    expect(open({ url: "/done", locale: "en" }).text("paid")).toBe(EN.paid);
    expect(open().doc.getElementById("paid")?.hidden).toBe(true);
    expect(open({ url: "/done/x" }).doc.getElementById("paid")?.hidden).toBe(true);
  });

  test("in the desktop app it lifts the app's cover, and a Mac drags the window by the top", async () => {
    const style = PAGE.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const shown = /([^{}\n]+)\{display:block\}/.exec(style.slice(style.indexOf(".strip{")))?.[1] ?? "";
    const strip = (page: ReturnType<typeof open>) => page.doc.querySelector(shown);
    expect(style).toContain(".strip{display:none;");

    const mac = open({ desktop: {} });
    expect(mac.html.dataset.desktop).toBe("mac");
    expect(strip(mac)?.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(mac.invoked).toEqual([]);
    await mac.paint();
    expect(mac.invoked).toEqual(["page_ready"]);
    expect(open({ desktop: { platform: "mac" } }).html.dataset.desktop).toBe("mac");

    for (const platform of ["windows", "linux"]) {
      const other = open({ desktop: { platform } });
      expect(other.html.dataset.desktop).toBe(platform);
      expect(strip(other)).toBeNull();
    }
    const browser = open();
    expect(browser.html.dataset.desktop).toBeUndefined();
    expect(strip(browser)).toBeNull();
    await browser.paint();
    expect(browser.invoked).toEqual([]);
  });

  test("self-contained: nothing loads from elsewhere, nothing Compose would read as a variable, under 16 KB", () => {
    const svgNamespace = "http://www.w3.org/2000/svg";
    const attributes = /\b(?:src|href)="([^"]*)"/g;
    const refs = [...PAGE.matchAll(attributes), ...PAGE.replace(attributes, "").matchAll(/url\("?([^")]*)"?\)/g)].map(
      (m) => m[1] ?? "",
    );
    expect(refs.length).toBeGreaterThan(4);
    for (const ref of refs) {
      expect(ref === "" || ref.startsWith("data:") || ref.startsWith("#")).toBe(true);
      expect(ref.replaceAll(svgNamespace, "")).not.toMatch(/https?:|\/\//);
    }
    expect(PAGE).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet/);
    expect(PAGE).not.toContain("$");
    expect(new TextEncoder().encode(PAGE).length).toBeLessThan(16 * 1024);
    expect(PAGE).toContain('<meta name="robots" content="noindex">');
    // Without JavaScript it tries again every 30 s.
    expect(PAGE).toContain('<noscript><meta http-equiv="refresh" content="30"></noscript>');
  });

  test("every language of the app is in it: the markup in English, the script in the other 13", () => {
    for (const words of [EN, PT]) for (const line of Object.values(words)) expect(PAGE).toContain(line);
    const script = PAGE.slice(PAGE.indexOf("const WORDS"));
    for (const code of LOCALE_CODES.filter((c) => c !== "en")) {
      const line = new RegExp(`\\n\\s*"?${code}"?: \\[("[^"]+", ){3}"[^"]+"\\],`).test(script);
      expect([code, line]).toEqual([code, true]);
    }
  });

  test("its colors are the design system's, in both themes", () => {
    const style = PAGE.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const declarations = (block: string) =>
      Object.fromEntries(
        [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)].map((m) => [m[1], m[2]?.replace(/\s+/g, " ")]),
      );
    const rule = (css: string, selector: RegExp) =>
      declarations(selector.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""))?.[1] ?? "");
    const shared = rule(TOKENS, /:root,\s*\[data-theme\]\s*\{([^}]*)\}/);
    const light = { ...shared, ...rule(TOKENS, /:root,\s*\[data-theme="light"\]\s*\{([^}]*)\}/) };
    const dark = { ...shared, ...rule(TOKENS, /\[data-theme="dark"\]\s*\{([^}]*)\}/) };

    const pageLight = rule(style, /^:root\{([^}]*)\}/m);
    const pageDark = rule(style, /^\[data-theme=dark\]\{([^}]*)\}/m);
    const pageSystemDark = rule(style, /:root:not\(\[data-theme=light\]\)\{([^}]*)\}/);
    expect(Object.keys(pageLight)).toEqual(expect.arrayContaining(["--bg", "--ink", "--muted", "--agent-soft"]));
    for (const [name, value] of Object.entries(pageLight)) expect([name, value]).toEqual([name, light[name]]);
    expect(pageSystemDark).toEqual(pageDark);
    expect(Object.keys(pageDark).length).toBeGreaterThan(6);
    for (const [name, value] of Object.entries(pageDark)) expect([name, value]).toEqual([name, dark[name]]);
  });
});
