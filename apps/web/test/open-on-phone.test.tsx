import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { connectLink } from "@agenteschat/client/lib/server";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { encode } from "uqr";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => {
  cleanup();
  setSystemTime();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const APP_STEP = "Instale o app agentes no celular.App StoreEm breveGoogle PlayEm breve";

/** Configurações › Sua conta → Abrir no celular. */
async function openPhoneDialog(state: ReturnType<typeof seedState>) {
  const app = await renderApp(`/org/${ORG_ID}/settings/account`, { api: createFakeApi(state) });
  await settle(6);
  await click(screen().getByRole("button", { name: /^Abrir no celular/ }));
  await settle(4);
  return Object.assign(screen().getByRole("dialog", { name: "Abrir no celular" }), { app });
}

describe("Abrir no celular", () => {
  test("a QR code of the connect link with a fresh sign-in, how long it lasts and what to do", async () => {
    const state = seedState();
    const dialog = await openPhoneDialog(state);
    expect(state.calls.filter((c) => c.method === "account.phoneSignIn")).toHaveLength(1);

    const qr = within(dialog).getByRole("img", { name: "QR code para entrar no app agentes" });
    const expected = encode(connectLink("https://app.agentes.chat", { token: "tok-1" }), { ecc: "M", border: 2 });
    expect(qr.getAttribute("viewBox")).toBe(`0 0 ${expected.size} ${expected.size}`);
    const modules = qr.querySelector("path")?.getAttribute("d")?.match(/M/g)?.length;
    expect(modules).toBe(expected.data.flat().filter(Boolean).length);

    expect(dialog.textContent).toMatch(/Vale por [23]:\d\d/);
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([APP_STEP, "Aponte a câmera do celular para o código."]);
    // Our phone app is in neither store yet: each one disabled, marked Em breve, and no link.
    const app = within(dialog).getAllByRole("listitem")[0] as HTMLElement;
    expect(
      within(app)
        .getAllByRole("button")
        .map((b) => [b.textContent, (b as HTMLButtonElement).disabled]),
    ).toEqual([
      ["App StoreEm breve", true],
      ["Google PlayEm breve", true],
    ]);
    expect(within(app).queryAllByRole("link")).toEqual([]);
    expect(dialog.textContent).toContain("Quem escanear este código entra na sua conta.");
  });

  test("on a tailnet, installing Tailscale comes before scanning", async () => {
    const state = seedState();
    state.phoneServer = "https://box.tail1234.ts.net";
    const dialog = await openPhoneDialog(state);
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      APP_STEP,
      "Instale o Tailscale no celular e entre com a mesma conta do Tailscale deste servidor. App Store · Google Play",
      "Aponte a câmera do celular para o código.",
    ]);
    expect(within(dialog).getByRole("link", { name: "Google Play" }).getAttribute("href")).toBe(
      "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
    );
  });

  test("the longest store marks (Dutch), beside the Tailscale step, for the layout check", async () => {
    const state = seedState();
    state.phoneServer = "https://box.tail1234.ts.net";
    const dialog = await openPhoneDialog(state);
    await showIn(dialog.app.services, "nl");
    const app = within(dialog).getAllByRole("listitem")[0] as HTMLElement;
    expect(
      within(app)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["App StoreBinnenkort", "Google PlayBinnenkort"]);
  });

  test("a server only its own computer answers at: how to turn on access, never a QR code that opens nothing", async () => {
    const state = seedState();
    state.phoneServer = "http://127.0.0.1:4310";
    const dialog = await openPhoneDialog(state);
    expect(within(dialog).queryByRole("img", { name: "QR code para entrar no app agentes" })).toBeNull();
    expect(dialog.textContent).toContain("o celular não chega a ele");
    expect(dialog.textContent).toContain("Acessar pelo celular e pela equipe");
  });

  test("back on the tab after the code ran low, a new one takes its place", async () => {
    const state = seedState();
    await openPhoneDialog(state);
    const mints = () => state.calls.filter((c) => c.method === "account.phoneSignIn").length;
    // The renewal timer doesn't run in a hidden tab; showing the tab again is what renews.
    const showTab = () => act(async () => void window.dispatchEvent(new Event("visibilitychange")));
    setSystemTime(new Date(Date.now() + 100_000));
    await showTab();
    await settle(4);
    expect(mints()).toBe(1);
    setSystemTime(new Date(Date.now() + 70_000));
    await showTab();
    await settle(4);
    expect(mints()).toBe(2);
  });
});
