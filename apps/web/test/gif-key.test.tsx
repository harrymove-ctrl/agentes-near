import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { GifKey } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const OFF: GifKey = { source: null, hint: null, state: "off" };
const ON: GifKey = { source: "settings", hint: "7a1e", state: "ok" };

const go = async (patch: Partial<FakeState> = {}) => {
  const state = seedState(patch);
  const r = await renderApp(`/org/${ORG_ID}/settings/media`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
};
const card = () => screen().getByRole("region", { name: "Chave do GIPHY" });
const click = async (el: Element, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const field = () => within(card()).getByLabelText("Cole a chave aqui") as HTMLInputElement;
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method).map((c) => c.args);
const gifsSwitch = () => screen().getByRole("switch", { name: "GIFs" });

describe("the GIPHY key in Configurações › GIFs e figurinhas (ADR 0091)", () => {
  test("nobody but the server's owner sees it", async () => {
    await go({ media: { gifsAvailable: false } });
    expect(screen().queryByRole("region", { name: "Chave do GIPHY" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/GIPHY Developers|GIPHY_API_KEY/);
  });

  test("off: where a key comes from, its steps in place; saved, GIFs can be turned on at once", async () => {
    const { state } = await go({ gifKey: OFF, media: { gifsAvailable: false } });
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    expect(card().textContent).toContain(
      "A chave é grátis no GIPHY Developers. Sem ela, os agentes mandam só as próprias figurinhas.",
    );
    expect(gifsSwitch().hasAttribute("disabled")).toBe(true);
    expect(within(card()).queryByLabelText("Cole a chave aqui")).toBeNull();

    await click(within(card()).getByRole("button", { name: "Adicionar a chave" }));
    // The button pressed gives way to the steps: the field takes the focus.
    expect(document.activeElement === field()).toBe(true);
    expect(within(card()).getByRole("link", { name: "Abrir o GIPHY Developers" }).getAttribute("href")).toBe(
      "https://developers.giphy.com/dashboard/",
    );
    expect(field().type).toBe("password");
    const save = () => within(card()).getByRole("button", { name: "Salvar chave" });
    await type(field(), "short");
    expect(save().hasAttribute("disabled")).toBe(true);
    await type(field(), "  giphy_key_7a1e  ");
    await click(save(), 6);
    expect(calls(state, "system.saveGifKey")).toEqual([["giphy_key_7a1e"]]);
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Ligado");
    expect(card().textContent).toContain("Termina em 7a1e");
    expect(within(card()).queryByLabelText("Cole a chave aqui")).toBeNull();
    expect(document.activeElement === within(card()).getByRole("button", { name: "Trocar a chave" })).toBe(true);
    // The workspace's settings are read again: GIFs can be turned on without reloading.
    expect(gifsSwitch().hasAttribute("disabled")).toBe(false);
    // The key itself is never on the page.
    expect(document.body.innerHTML).not.toContain("giphy_key_7a1e");
  });

  test("a key GIPHY refuses: said under the field, nothing kept, no toast", async () => {
    const { state } = await go({ gifKey: OFF, gifKeyRefused: ["giphy_wrong_0000"], media: { gifsAvailable: false } });
    await click(within(card()).getByRole("button", { name: "Adicionar a chave" }));
    await type(field(), "giphy_wrong_0000");
    await click(within(card()).getByRole("button", { name: "Salvar chave" }), 6);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field().getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "O GIPHY não aceitou esta chave. Copie de novo no GIPHY Developers.",
    );
    expect(state.gifKey?.source).toBeNull();
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    expect(document.querySelector(".ac-toast")).toBeNull();
  });

  test("on: its last 4; Apagar asks first, and GIFs go away in the workspace with it", async () => {
    const { state } = await go({ gifKey: ON });
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Ligado");
    expect(card().textContent).toContain("Termina em 7a1e");
    expect(gifsSwitch().hasAttribute("disabled")).toBe(false);
    await click(within(card()).getByRole("button", { name: "Apagar" }));
    const ask = screen().getByRole("dialog", { name: "Remover a chave do GIPHY?" });
    expect(ask.textContent).toContain("Os GIFs somem do seletor em todos os workspaces deste servidor.");
    expect(calls(state, "system.removeGifKey")).toEqual([]);
    await click(within(ask).getByRole("button", { name: "Apagar" }), 6);
    expect(calls(state, "system.removeGifKey")).toEqual([[]]);
    expect(card().querySelector(".ac-chip")?.textContent).toBe("Desligado");
    expect(gifsSwitch().hasAttribute("disabled")).toBe(true);
  });

  test("from the server's settings: read-only; without Jev, the way to its key", async () => {
    await go({ gifKey: { ...ON, source: "env" }, media: { agentMediaAvailable: false } });
    expect(card().textContent).toContain("Definida nas configurações deste servidor (GIPHY_API_KEY).");
    expect(within(card()).queryByRole("button", { name: "Trocar a chave" })).toBeNull();
    expect(within(card()).queryByRole("button", { name: "Apagar" })).toBeNull();
    expect(card().textContent).toContain("Os agentes só mandam figurinhas por conta própria com o Jev.");
    expect(within(card()).getByRole("link", { name: "Configurar o Jev" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/usage#jev`,
    );
  });

  test("with Jev on the server, no word about it", async () => {
    await go({ gifKey: ON });
    expect(within(card()).queryByRole("link", { name: "Configurar o Jev" })).toBeNull();
    expect(card().textContent).not.toMatch(/\bJev\b/);
  });
});
