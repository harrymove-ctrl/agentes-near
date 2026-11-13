import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async () => {
  const api = createFakeApi(seedState());
  api.pins = { list: async () => [], pin: async () => ({}) as never, unpin: async () => {} };
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  return document.querySelector(".channel__header") as HTMLElement;
};

describe("the channel header, as Discord's", () => {
  test("the name and topic, then threads, pins, settings, members and the search, with no faces", async () => {
    const header = await open();
    expect(within(header).getByRole("heading", { level: 1, name: "eng" })).toBeTruthy();
    expect(within(header).getByText("Código, erros e deploys")).toBeTruthy();
    // The name and the glyphs are an action line: the glyphs go under a name that can't keep its row beside them.
    const line = header.querySelector(":scope > .ac-actline.channel__line") as HTMLElement;
    expect(line.firstElementChild?.matches(".channel__head-text")).toBe(true);
    expect(line.lastElementChild?.matches(".channel__acts")).toBe(true);
    const icons = [...header.querySelectorAll<HTMLElement>(".channel__acts > .channel__icon")]
      .filter((b) => !b.classList.contains("channel__search-icon"))
      .map((b) => b.getAttribute("aria-label"));
    expect(icons).toEqual([
      expect.stringMatching(/^Threads: \d+ neste canal$/),
      "Mensagens fixadas",
      "Configurações do canal",
      "Membros do canal (4)",
    ] as never);
    expect(within(header).getByRole("combobox", { name: "Buscar" })).toBeTruthy();
    expect(header.querySelectorAll(".ac-avatar")).toHaveLength(0);
    expect(within(header).queryByRole("button", { name: "Detalhes do canal" })).toBeNull();
    expect(within(header).queryByRole("link", { name: "Buscar nesta conversa" })).toBeNull();
  });

  test("the cog opens the channel's details; the pin lists the pins, or says there are none", async () => {
    const header = await open();
    await act(async () => fireEvent.click(within(header).getByRole("button", { name: "Configurações do canal" })));
    await settle(3);
    expect(screen().getByRole("dialog", { name: /eng/ })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" }));
    await settle(2);
    await act(async () => fireEvent.click(within(header).getByRole("button", { name: "Mensagens fixadas" })));
    await settle(2);
    const pins = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
    expect(pins.textContent).toContain("Nada fixado aqui ainda");
  });
});
