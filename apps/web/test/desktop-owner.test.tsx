import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { ThisMacStatus } from "@/lib/desktop";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * The server the desktop app runs on this computer: its owner has no password, and the app signs them in
 * (ADR 0060 §6). The sign-in screen offers it only there; anywhere else it is the ordinary sign-in.
 */

const win = () =>
  window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown; __agentesNavigate?: (p: string) => void };
afterEach(() => {
  cleanup();
  delete win().__agentesDesktop;
  delete win().__TAURI_INTERNALS__;
  localStorage.removeItem("agentes.signedOut");
});
/** The person signed out by hand: the screen waits for their click (no sign-in at once). */
const byHand = () => localStorage.setItem("agentes.signedOut", "1");

/** The app around the site: answers `this_mac` with `status`, records every request. */
function inTheApp(status: ThisMacStatus) {
  const asked: Record<string, unknown>[] = [];
  win().__agentesDesktop = { version: "0.6.0", platform: "mac" };
  win().__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { request: Record<string, unknown> }) => {
      if (cmd === "page_ready") return null;
      if (cmd !== "this_mac") throw new Error(`unexpected ${cmd}`);
      asked.push(args.request);
      return args.request.kind === "status" ? status : {};
    },
  };
  return asked;
}

const signedOut = (options?: SignInOptions) => {
  const state = seedState({ me: null });
  const api = createFakeApi(state);
  if (options) api.account.signInOptions = async () => options;
  return api;
};
const continueHere = () => screen().queryByRole("button", { name: /^Continuar neste/ });

describe("Entrar no servidor que o app roda neste computador", () => {
  test("the owner's session ended: the app signs them in again at once, with no click", async () => {
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(asked.filter((r) => r.kind === "signIn")).toEqual([{ kind: "signIn" }]);
  });

  test("after Sign out by hand, or with an address to sign in with, the screen waits", async () => {
    byHand();
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(continueHere()).toBeTruthy();
    cleanup();
    localStorage.removeItem("agentes.signedOut");
    await renderApp("/login?email=bruno%40acme.com", { api: signedOut() });
    await settle(6);
    expect(asked.filter((r) => r.kind === "signIn")).toEqual([]);
  });

  test("one click asks the app, which signs the owner in; the e-mail stays for anyone else", async () => {
    byHand();
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    const button = continueHere();
    expect(button).toBeTruthy();
    expect(screen().getByText(/não precisa de senha/)).toBeTruthy();
    expect(screen().getByLabelText("E-mail")).toBeTruthy();
    await act(async () => fireEvent.click(button as HTMLElement));
    await settle(2);
    expect(asked.filter((r) => r.kind === "signIn")).toEqual([{ kind: "signIn" }]);
  });

  test("an account with no password, typed in: the same one click, never 'open the app'", async () => {
    byHand();
    inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut({ account: true, password: false, providers: [], canSignUp: false }) });
    await act(async () => fireEvent.change(screen().getByLabelText("E-mail"), { target: { value: "ana@acme.com" } }));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Continuar(?! neste| com)/ })));
    await settle(6);
    expect(continueHere()).toBeTruthy();
    expect(screen().queryByText(/abra o app e escolha Adicionar uma senha/)).toBeNull();
  });

  test("no Google or GitHub on the server here, even with their keys set; another server keeps them", async () => {
    const withProviders = () => {
      const state = seedState({ me: null });
      state.authConfig = { socialProviders: { google: true, github: true } };
      return createFakeApi(state);
    };
    const google = () => screen().queryByRole("button", { name: /Continuar com Google/ });
    byHand();
    inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: withProviders() });
    await settle(6);
    expect(continueHere()).toBeTruthy();
    expect(google()).toBeNull();
    expect(screen().queryByRole("button", { name: /Continuar com GitHub/ })).toBeNull();
    cleanup();
    inTheApp({ orgs: [], agentsHere: true, local: false });
    await renderApp("/login", { api: withProviders() });
    await settle(6);
    expect(google()).toBeTruthy();
  });

  test("the line over the sign-in names the server, Trocar opens the app's servers (ADR 0158)", async () => {
    byHand();
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    (win().__agentesDesktop as Record<string, unknown>).servers = true;
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    const line = document.querySelector(".auth__server");
    expect(line?.textContent).toContain("Entrando no agentes.chat deste Mac");
    await act(async () => fireEvent.click(within(line as HTMLElement).getByRole("button", { name: "Trocar" })));
    await settle(2);
    expect(asked.filter((r) => r.kind === "servers")).toEqual([{ kind: "servers" }]);
    cleanup();
    // Another server: by its address, never "this Mac".
    inTheApp({ orgs: [], agentsHere: true, local: false });
    (win().__agentesDesktop as Record<string, unknown>).servers = true;
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(document.querySelector(".auth__server")?.textContent).toContain(`Entrando em ${window.location.host}`);
  });

  test("forgot password on this computer's server: Continue on this Mac, then a new password (ADR 0158)", async () => {
    byHand();
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut({ account: true, password: true, providers: [], canSignUp: false }) });
    await act(async () => fireEvent.change(screen().getByLabelText("E-mail"), { target: { value: "ana@acme.com" } }));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Continuar(?! neste| com)/ })));
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Esqueci a senha" })));
    await settle(2);
    expect(screen().getByRole("heading").textContent).toBe("Aqui você não precisa de senha.");
    await act(async () => fireEvent.click(continueHere() as HTMLElement));
    await settle(2);
    expect(asked.filter((r) => r.kind === "signIn")).toEqual([{ kind: "signIn" }]);
    expect(sessionStorage.getItem("agentes.newPasswordAsk")).toBe("1");
    sessionStorage.removeItem("agentes.newPasswordAsk");
  });

  test("another server in the app, or a browser: the ordinary sign-in", async () => {
    inTheApp({ orgs: [], agentsHere: true, local: false });
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(continueHere()).toBeNull();
    cleanup();
    delete win().__agentesDesktop;
    delete win().__TAURI_INTERNALS__;
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(continueHere()).toBeNull();
  });
});

test("the app's “Show QR code” opens “Abrir no celular” over the page the person is on", async () => {
  inTheApp({ orgs: [], agentsHere: false, local: true });
  const state = seedState();
  const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(state) });
  await settle(6);
  expect(screen().queryByRole("dialog", { name: "Abrir no celular" })).toBeNull();
  await act(async () => win().__agentesNavigate?.("/?open=phone"));
  await settle(6);
  expect(screen().getByRole("dialog", { name: "Abrir no celular" })).toBeTruthy();
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/issues`);
  expect(state.calls.filter((c) => c.method === "account.phoneSignIn")).toHaveLength(1);
});
