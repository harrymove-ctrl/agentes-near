import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, NetworkError } from "@agenteschat/client";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { ErrorScreen } from "@/components/ErrorScreen";
import { ErrorState } from "@/components/Loading";
import { createI18n } from "@/i18n";
import { createVersionWatch, reloadForNewVersion, resetVersionReload, startVersionWatch } from "@/lib/app-version";
import { catchEarlyErrors, type ErrorSdk, reportError, startErrorReports } from "@/lib/error-reports";
import { Route as RootRoute } from "@/routes/__root";
import { createFakeApi } from "./fake-api";
import { renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const CONFIG = { dsn: "https://public@example.invalid/2", environment: "production", release: "2026.10.31.4" };
const TEXT = "Recarregue a página para continuar.";
const withCode = (id: string | undefined) => `${TEXT} Se pedir ajuda, informe o código ${id?.slice(0, 8)}.`;

type Load = NonNullable<Parameters<typeof startErrorReports>[1]>;

/** An SDK that keeps what it was given to send, and says it took it, as the real one does past its dedupe. */
function fakeSdk() {
  const sent: { error: unknown; id: string }[] = [];
  const startSdk = (_config: unknown, taken: (id: string) => void): ErrorSdk => ({
    capture(error, id) {
      sent.push({ error, id });
      taken(id);
    },
    scope: () => {},
  });
  return { sent, load: async () => ({ startSdk }) };
}

/** Reports that start once `answer()` is called: until then the server hasn't said where they go. */
function startLater(load: Load) {
  let respond = () => {};
  const answered = new Promise<void>((resolve) => {
    respond = resolve;
  });
  const starting = startErrorReports(CONFIG, async () => {
    await answered;
    return load();
  });
  return {
    answer: () =>
      act(async () => {
        respond();
        await starting;
      }),
  };
}

const broken = (error: unknown) => <ErrorScreen error={error} reset={() => {}} info={{ componentStack: "" }} />;

describe("the error screen (ADR 0104)", () => {
  test("a page that broke: a short message, Recarregar and the code of its report, never the error's words", async () => {
    const { sent, load } = fakeSdk();
    await startErrorReports(CONFIG, load);
    const error = new TypeError("Cannot destructure property 'context' of 'f' as it is undefined.");
    await renderPage(broken(error), { api: createFakeApi() });
    expect(screen().getByRole("heading", { name: "Algo deu errado" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Recarregar" })).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.error).toBe(error);
    expect(sent[0]?.id).toMatch(/^[0-9a-f]{32}$/);
    expect(screen().getByText(withCode(sent[0]?.id))).toBeTruthy();
    expect(document.body.textContent).not.toContain("destructure");
    // The same error again (another boundary, a second render) is the same report.
    expect(reportError(error)).toBe(sent[0]?.id ?? "");
    expect(sent).toHaveLength(1);
    // Every page that breaks gets it: the root route's boundary catches what its pages throw.
    expect(RootRoute.options.errorComponent).toBe(ErrorScreen);
  });

  test("errors before the server says where reports go wait for it, and the screen gives its code once it is sent", async () => {
    const { sent, load } = fakeSdk();
    const later = startLater(load);
    catchEarlyErrors();
    const early = new Error("before the SDK");
    await renderPage(broken(early), { api: createFakeApi() });
    const stray = new Error("a stray rejection");
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: stray }));
    expect(sent).toEqual([]);
    // No code for a report that may never go.
    expect(screen().getByText(TEXT)).toBeTruthy();
    await later.answer();
    expect(sent).toEqual([
      { error: early, id: reportError(early) ?? "" },
      { error: stray, id: expect.stringMatching(/^[0-9a-f]{32}$/) },
    ]);
    expect(screen().getByText(withCode(sent[0]?.id))).toBeTruthy();
  });

  test("a report that never goes (the SDK didn't load, or dropped it as a repeat) shows no code", async () => {
    const later = startLater(async () => {
      throw new Error("the SDK's chunk didn't load");
    });
    await renderPage(broken(new Error("broke while waiting")), { api: createFakeApi() });
    await later.answer();
    expect(screen().getByText(TEXT)).toBeTruthy();
    cleanup();

    // An SDK that takes nothing (its dedupe dropped the event): the code would lead nowhere.
    const silent = async () => ({ startSdk: (): ErrorSdk => ({ capture: () => {}, scope: () => {} }) });
    await startErrorReports(CONFIG, silent);
    await renderPage(broken(new Error("broke again")), { api: createFakeApi() });
    expect(screen().getByText(TEXT)).toBeTruthy();
  });

  test("without a DSN the SDK never loads and the screen has no code", async () => {
    let loaded = false;
    await startErrorReports(null, async () => {
      loaded = true;
      return fakeSdk().load();
    });
    expect(loaded).toBe(false);
    expect(reportError(new Error("nowhere to go"))).toBeUndefined();
    await renderPage(broken(new Error("broke")), { api: createFakeApi() });
    expect(screen().getByRole("heading", { name: "Algo deu errado" })).toBeTruthy();
    expect(screen().getByText(TEXT)).toBeTruthy();
  });

  test("a page's file from before a deploy: the boot sky while the new version loads, and no report", async () => {
    const { sent, load } = fakeSdk();
    await startErrorReports(CONFIG, load);
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    // The page leaves: the check that it stayed never comes.
    const stayed = spyOn(globalThis, "setTimeout").mockImplementation((() => 0) as unknown as typeof setTimeout);
    try {
      expect(reloadForNewVersion()).toBe(true);
      stayed.mockRestore();
      const stale = new TypeError("Failed to fetch dynamically imported module: /assets/route-77e1.js");
      await renderPage(broken(stale), { api: createFakeApi() });
      expect(document.querySelector(".sky-boot")).not.toBeNull();
      expect(screen().queryByRole("heading", { name: "Algo deu errado" })).toBeNull();
      expect(sent).toEqual([]);
      expect(reportError(new Error("another while reloading"))).toBeUndefined();
    } finally {
      stayed.mockRestore();
      reload.mockRestore();
      resetVersionReload();
      sessionStorage.clear();
    }
  });

  test("a crash in a tab a deploy left behind reloads into the new version; staying brings the crash screen back", async () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    let entry = "/assets/index-abc.js";
    startVersionWatch(
      createVersionWatch({
        loaded: "/assets/index-abc.js",
        fetchHtml: async () => `<script type="module" src="${entry}"></script>`,
        onStale: () => {},
      }),
    );
    const crash = () => broken(new TypeError("Cannot read properties of undefined (reading 'icon')"));
    try {
      // The version this tab runs: the crash is a real one and stays on screen.
      await renderPage(crash(), { api: createFakeApi() });
      await settle();
      expect(reload).not.toHaveBeenCalled();
      expect(screen().getByRole("heading", { name: "Algo deu errado" })).toBeTruthy();
      cleanup();
      entry = "/assets/index-def.js";
      await renderPage(crash(), { api: createFakeApi() });
      await waitFor(() => expect(document.querySelector(".sky-boot")).not.toBeNull());
      expect(reload).toHaveBeenCalledTimes(1);
      // The page didn't leave (it asked before leaving and the person stayed): the crash screen and its button again.
      act(() => resetVersionReload());
      expect(document.querySelector(".sky-boot")).toBeNull();
      expect(screen().getByRole("button", { name: "Recarregar" })).toBeTruthy();
    } finally {
      startVersionWatch(createVersionWatch({ loaded: null, fetchHtml: async () => "", onStale: () => {} }));
      reload.mockRestore();
      resetVersionReload();
      sessionStorage.clear();
    }
  });

  test("in the desktop app it lifts the app's cover, as the root does: the root never mounted", async () => {
    const win = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
    const asked: string[] = [];
    win.__agentesDesktop = { version: "0.6.0", platform: "mac" };
    win.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => void asked.push(cmd) };
    try {
      await renderPage(broken(new Error("broke on the first screen")), { api: createFakeApi() });
      await waitFor(() => expect(asked).toContain("page_ready"));
    } finally {
      delete win.__agentesDesktop;
      delete win.__TAURI_INTERNALS__;
    }
  });
});

const UNREACHABLE = "Ele pode estar reiniciando. Esta página abre sozinha assim que ele voltar.";

describe("a request that got no answer, or only the proxy's", () => {
  test("no network or only the proxy: Sem conexão com o agentes.chat and Tentar de novo, no report, no code", async () => {
    const { sent, load } = fakeSdk();
    await startErrorReports(CONFIG, load);
    for (const error of [
      new NetworkError(new TypeError("Failed to fetch")),
      new ApiError(503, "http_503", "Service Unavailable"),
      new ApiError(502, "http_502", "Bad Gateway"),
    ]) {
      await renderPage(broken(error), { api: createFakeApi() });
      expect(screen().getByRole("heading", { name: "Sem conexão com o agentes.chat" })).toBeTruthy();
      expect(screen().getByText(UNREACHABLE)).toBeTruthy();
      expect(screen().getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/código|Bad Gateway|Failed to fetch|Service Unavailable/);
      cleanup();
    }
    expect(sent).toEqual([]);
    // A TypeError of the app's own code is a crash, and is reported.
    const bug = new TypeError("Cannot read properties of undefined (reading 'name')");
    await renderPage(broken(bug), { api: createFakeApi() });
    expect(screen().getByRole("heading", { name: "Algo deu errado" })).toBeTruthy();
    expect(sent.map((s) => s.error)).toEqual([bug]);
  });

  test("offline: Você está sem internet, until the network is back", async () => {
    let online = false;
    const own = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
    try {
      await renderPage(broken(new NetworkError(new TypeError("Load failed"))), { api: createFakeApi() });
      expect(screen().getByRole("heading", { name: "Você está sem internet" })).toBeTruthy();
      expect(screen().getByText("Esta página abre sozinha quando a internet voltar.")).toBeTruthy();
      expect(screen().getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
      online = true;
      await act(async () => window.dispatchEvent(new Event("online")));
      expect(screen().getByRole("heading", { name: "Sem conexão com o agentes.chat" })).toBeTruthy();
    } finally {
      if (own) Object.defineProperty(navigator, "onLine", own);
      else delete (navigator as { onLine?: boolean }).onLine;
    }
  });

  test("it opens again by itself once the server's health answers", async () => {
    const answers = [503, 200];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response(null, { status: answers.shift() ?? 200 })) as unknown as typeof globalThis.fetch,
    );
    const reload = spyOn(window.location, "reload").mockImplementation(() => {});
    try {
      await renderPage(broken(new ApiError(504, "http_504", "Gateway Timeout")), { api: createFakeApi() });
      await act(async () => window.dispatchEvent(new Event("online")));
      await settle();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0]).toBe("/api/health");
      expect(reload).not.toHaveBeenCalled();
      await act(async () => window.dispatchEvent(new Event("online")));
      await settle();
      expect(reload).toHaveBeenCalledTimes(1);
      // Tentar de novo loads the page again at once.
      fireEvent.click(screen().getByRole("button", { name: "Tentar de novo" }));
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
      reload.mockRestore();
    }
  });

  test("a section that didn't load says why in the person's words, and a query's null error is a failed load", async () => {
    const said = async (error: unknown) => {
      await renderPage(<ErrorState error={error} onRetry={() => {}} />, { api: createFakeApi() });
      const text = document.querySelector(".ac-empty__text")?.textContent;
      cleanup();
      return text;
    };
    expect(await said(new NetworkError(new TypeError("Failed to fetch")))).toBe(
      "Sem conexão com o agentes.chat agora. Tente de novo em instantes.",
    );
    expect(await said(new TypeError("Cannot read properties of undefined"))).toBe("Algo deu errado. Tente de novo.");
    const failedLoad = "Não foi possível carregar. Confira a conexão e tente de novo.";
    expect(await said(undefined)).toBe(failedLoad);
    expect(await said(null)).toBe(failedLoad);
  });

  test("Tentar de novo only where a try can change it: never for what is gone or a workspace being deleted", async () => {
    const offered = async (error: unknown) => {
      await renderPage(<ErrorState error={error} onRetry={() => {}} />, { api: createFakeApi() });
      const said = {
        text: document.querySelector(".ac-empty__text")?.textContent,
        retry: document.querySelector(".ac-empty button")?.textContent ?? null,
      };
      cleanup();
      return said;
    };
    expect(await offered(undefined)).toEqual({
      text: "Não foi possível carregar. Confira a conexão e tente de novo.",
      retry: "Tentar de novo",
    });
    expect(await offered(new ApiError(403, "org.deleting", "The workspace is being deleted"))).toEqual({
      text: "Este workspace está sendo apagado.",
      retry: null,
    });
    expect((await offered(new ApiError(404, "not_found", "Not found"))).retry).toBeNull();
  });

  test("a crash asks nothing of the server", async () => {
    const fetch = spyOn(globalThis, "fetch");
    try {
      await renderPage(broken(new Error("broke")), { api: createFakeApi() });
      await act(async () => window.dispatchEvent(new Event("online")));
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("a render error above the router (the app's providers)", () => {
  function Throws({ when }: { when: boolean }): null {
    if (when) throw new Error("the theme provider broke");
    return null;
  }

  test("the crash screen, never a blank page: main.tsx puts the boundary around the providers", async () => {
    const i18n = createI18n("pt-BR");
    render(
      <ErrorBoundary
        fallback={(error) => (
          <I18nextProvider i18n={i18n}>
            <ErrorScreen error={error as Error} reset={() => {}} />
          </I18nextProvider>
        )}
      >
        <Throws when />
      </ErrorBoundary>,
    );
    expect(screen().getByRole("heading", { name: "Algo deu errado" })).toBeTruthy();
    expect(screen().getByRole("button", { name: "Recarregar" })).toBeTruthy();
    const main = readFileSync(join(import.meta.dir, "../src/main.tsx"), "utf8");
    expect(main).toMatch(
      /<ErrorBoundary[\s\S]*fallback=[\s\S]*<ErrorScreen[\s\S]*<AppProviders[\s\S]*<\/ErrorBoundary>/,
    );
  });

  test("the boundary: its fallback gets the error and a reset that draws the children again, and onError hears it", () => {
    const heard: unknown[] = [];
    function Flaky() {
      const [broken, setBroken] = useState(false);
      return (
        <button type="button" onClick={() => setBroken(true)}>
          {broken ? <Throws when /> : "fine"}
        </button>
      );
    }
    render(
      <ErrorBoundary
        fallback={(error, reset) => (
          <button type="button" onClick={reset}>
            {(error as Error).message}
          </button>
        )}
        onError={(error, info) => heard.push(error, typeof info.componentStack)}
      >
        <Flaky />
      </ErrorBoundary>,
    );
    fireEvent.click(screen().getByRole("button", { name: "fine" }));
    expect(heard).toEqual([new Error("the theme provider broke"), "string"]);
    fireEvent.click(screen().getByRole("button", { name: "the theme provider broke" }));
    expect(screen().getByRole("button", { name: "fine" })).toBeTruthy();
  });
});
