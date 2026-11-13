import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup } from "@testing-library/react";
import { openWaitingPopup, sendPopup } from "@/lib/popup";
import { createFakeApi, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let realOpen: typeof window.open;
beforeEach(() => {
  realOpen = window.open;
});
afterEach(() => {
  cleanup();
  window.open = realOpen;
  delete (window as { __agentesDesktop?: unknown }).__agentesDesktop;
});

describe("a sign-in's popup", () => {
  test("opens on our page, never about:blank, and goes on to the provider in place of it", () => {
    const urls: string[] = [];
    const replaced: string[] = [];
    const popup = { closed: false, opener: {}, location: { replace: (u: string) => replaced.push(u) } };
    window.open = ((url: string) => {
      urls.push(url);
      return popup;
    }) as never;
    const w = openWaitingPopup("claude_code");
    expect(urls).toEqual(["/conectando?kind=claude_code"]);
    expect(popup.opener).toBeNull();
    sendPopup(w, "https://claude.ai/oauth");
    expect(replaced).toEqual(["https://claude.ai/oauth"]);
  });

  test("in the desktop app, none: a page of ours would take over the app's window", () => {
    (window as { __agentesDesktop?: unknown }).__agentesDesktop = { version: "1", platform: "macos" };
    window.open = (() => {
      throw new Error("opened");
    }) as never;
    expect(openWaitingPopup("claude_code")).toBeNull();
  });

  test("the page says what is happening, for whom, with a way out, with no session", async () => {
    const state = seedState();
    state.me = null;
    await renderApp("/conectando?kind=claude_code", { api: createFakeApi(state) });
    await settle(6);
    expect(document.body.textContent).toContain("Conectando Claude");
    expect(document.body.textContent).toContain("Estamos pedindo a página de entrada ao computador.");
    expect(screen().getByRole("button", { name: "Fechar" })).toBeTruthy();
  });
});
