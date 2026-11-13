import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/**
 * agentes for Mac (ADR 0036): in the app's window, Google/GitHub/Apple sign in
 * through the browser; the browser page hands the fresh sign-in back.
 */

const app = () => window as { __agentesDesktop?: unknown };
afterEach(() => {
  cleanup();
  delete app().__agentesDesktop;
  sessionStorage.clear();
});

const ACCOUNT: SignInOptions = { account: true, password: true, providers: [], canSignUp: false };
const ACCESS = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
const KEY = /^[A-Za-z0-9_-]{43}$/;
const heading = () => screen().getByRole("heading").textContent;

/** `window.location.assign` recorded instead of followed. */
function recordAssign() {
  const urls: string[] = [];
  const spy = spyOn(window.location, "assign").mockImplementation((url: string | URL) => {
    urls.push(String(url));
  });
  return { urls, restore: () => spy.mockRestore() };
}

describe("in the Mac app's window", () => {
  test("GitHub opens in the browser and the window waits, then enters", async () => {
    app().__agentesDesktop = { version: "0.6.0" };
    const assign = recordAssign();
    let redeemed = false;
    const { auth, calls } = createFakeAuth();
    auth.desktopRedeem = async (verifier) => {
      calls.push({ method: "desktopRedeem", args: [verifier] });
      return redeemed;
    };
    const state = seedState({ me: null });
    const api = createFakeApi(state);
    api.account.signInOptions = async () => ACCOUNT;
    try {
      await renderApp("/login", { api, auth });
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
      await settle(6);
      expect(calls.some((c) => c.method === "signInSocial")).toBe(false);
      expect(heading()).toBe("Continue no navegador");
      // The window opens a request for the challenge and shows the code it got back.
      const opened = calls.find((c) => c.method === "desktopOpen");
      expect(opened?.args[0]).toMatch(KEY);
      expect(document.querySelector(".auth__codeValue")?.textContent).toBe("KQ7M-3XPF");
      const url = new URL(assign.urls[0] ?? "", "https://app.agentes.chat");
      expect(url.pathname).toBe("/desktop/sign-in");
      expect(url.searchParams.get("provider")).toBe("github");
      // The request id travels through the browser, never the challenge or the verifier.
      expect(url.searchParams.get("request")).toBe("r".repeat(43));
      expect(url.searchParams.get("challenge")).toBeNull();

      // Not yet: stays. Back in front after the browser finished: enters.
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle(3);
      expect(assign.urls).toHaveLength(1);
      redeemed = true;
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle(3);
      expect(assign.urls[1]).toBe("/desktop/signed-in?to=%2F");
      const verifiers = calls.filter((c) => c.method === "desktopRedeem").map((c) => c.args[0]);
      expect(verifiers[0]).toMatch(KEY);
      // The verifier never left the window: only the request id went to the browser.
      expect(url.searchParams.get("request")).not.toBe(verifiers[0]);
    } finally {
      assign.restore();
    }
  });

  test("from an early-access link: the browser it opens, and opens again, carries the link's token", async () => {
    app().__agentesDesktop = { version: "0.6.0" };
    const assign = recordAssign();
    const api = createFakeApi(seedState({ me: null }));
    api.account.signInOptions = async () => ({ account: false, password: false, providers: [], canSignUp: true });
    try {
      await renderApp(`/signup?email=ana%40acme.com&access=${ACCESS}`, { api, auth: createFakeAuth().auth });
      await settle(6);
      await act(async () => fireEvent.click(screen().getByRole("button", { name: "Trocar" })));
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
      await settle(6);
      await act(async () => fireEvent.click(screen().getByRole("button", { name: "Abrir o navegador de novo" })));
      expect(assign.urls.map((u) => new URL(u, "https://app.agentes.chat").searchParams.get("access"))).toEqual([
        ACCESS,
        ACCESS,
      ]);
    } finally {
      assign.restore();
    }
  });

  test("outside the app, GitHub signs in right here as before", async () => {
    const { auth, calls } = createFakeAuth();
    const api = createFakeApi(seedState({ me: null }));
    await renderApp("/login", { api, auth });
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
    await settle(3);
    expect(calls[0]).toEqual({ method: "signInSocial", args: ["github", "/"] });
  });
});

describe("in the browser, for the app", () => {
  const request = "r".repeat(43);

  test("goes to the provider, and back from it asks to confirm the code before handing over", async () => {
    const first = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&request=${request}`, {
      api: createFakeApi(seedState({ me: null })),
      auth: first.auth,
    });
    await settle(3);
    // A refusal comes back to this page, without `done`.
    expect(first.calls[0]).toEqual({
      method: "signInSocial",
      args: [
        "github",
        `/desktop/sign-in?provider=github&request=${request}&done=1`,
        undefined,
        `/desktop/sign-in?provider=github&request=${request}`,
      ],
    });
    cleanup();

    const back = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&request=${request}&done=1`, {
      api: createFakeApi(seedState()),
      auth: back.auth,
    });
    await settle(3);
    // The code is read and shown, but nothing is handed over yet.
    expect(back.calls).toEqual([{ method: "desktopRequestCode", args: [request] }]);
    expect(document.querySelector(".auth__codeValue")?.textContent).toBe("KQ7M-3XPF");
    expect(back.calls.some((c) => c.method === "desktopHandoff")).toBe(false);
    // Only the person's confirmation hands it over.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Sim, entrar no app/ })));
    await settle(3);
    expect(back.calls.some((c) => c.method === "desktopHandoff" && c.args[0] === request)).toBe(true);
    expect(heading()).toBe("Tudo certo.");
  });

  test("refused by the provider or the server: why, and back to the app, never the provider again", async () => {
    const { auth, calls } = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&request=${request}&error=access_denied`, {
      api: createFakeApi(seedState({ me: null })),
      auth,
    });
    await settle(3);
    expect(heading()).toBe("O login não terminou.");
    expect(document.querySelector(".auth__lead")?.textContent).toBe(
      "O login foi cancelado. Volte ao app para tentar de novo.",
    );
    expect(calls).toEqual([]);
  });

  test("an early-access token from the app's window goes on to the provider, for the sign-up it makes", async () => {
    const { auth, calls } = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=google&request=${request}&access=${ACCESS}`, {
      api: createFakeApi(seedState({ me: null })),
      auth,
    });
    await settle(3);
    expect(calls[0]).toEqual({
      method: "signInSocial",
      args: [
        "google",
        `/desktop/sign-in?provider=google&request=${request}&done=1`,
        ACCESS,
        `/desktop/sign-in?provider=google&request=${request}`,
      ],
    });
  });

  test("a link straight to the end hands nothing over without a real request", async () => {
    const { auth, calls } = createFakeAuth({ requestCode: null });
    await renderApp(`/desktop/sign-in?provider=google&request=${request}&done=1`, {
      api: createFakeApi(seedState()),
      auth,
    });
    await settle(3);
    // It only looked the request up; with no pending request it expires and hands nothing over.
    expect(calls).toEqual([{ method: "desktopRequestCode", args: [request] }]);
    expect(heading()).toBe("Esse pedido expirou.");
  });
});
