import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const go = async (edit?: (state: ReturnType<typeof seedState>) => void) => {
  const state = seedState();
  edit?.(state);
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const openSettings = async () => {
  await click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" }));
  await settle(3);
  return screen().getByRole("dialog", { name: "#eng" });
};

describe("channel permissions (ADR 0134)", () => {
  test("who manages it gets a nav: Visão geral, Permissões, Membros; archive and delete at its foot", async () => {
    await go();
    const dialog = await openSettings();
    const nav = within(dialog).getByRole("navigation", { name: "Configurações do canal" });
    expect(
      within(nav)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Visão geral", "Permissões", "Membros", "Sair do canal", "Arquivar canal", "Apagar canal"]);
    expect(within(nav).getByRole("button", { name: "Visão geral" }).getAttribute("aria-current")).toBe("page");
    expect(within(dialog).getByLabelText("Nome")).toBeTruthy();
  });

  test("Permissões: Todos first; Negar on Enviar mensagens saves an exception, Padrão takes it back", async () => {
    const state = await go();
    const dialog = await openSettings();
    await click(within(dialog).getByRole("button", { name: "Permissões" }));
    await settle(3);
    expect(dialog.textContent).toContain("Exceções valem só neste canal. Padrão segue os papéis do workspace.");
    const targets = within(dialog).getByRole("list", { name: "Papéis e pessoas com exceção" });
    expect(
      within(targets)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Todos"]);
    expect(dialog.textContent).toContain("Padrão: permitido pelo papel Todos");
    const post = within(dialog).getByRole("radiogroup", { name: "Enviar mensagens para Todos" });
    await click(within(post).getByRole("radio", { name: "Negar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "chat.setPermission").map((c) => c.args.at(-1))).toEqual([
      { target: { type: "role", id: "role-everyone" }, allow: [], deny: ["post"] },
    ]);
    const after = within(dialog).getByRole("radiogroup", { name: "Enviar mensagens para Todos" });
    expect(within(after).getByRole("radio", { name: "Negar" }).getAttribute("aria-checked")).toBe("true");
    await click(within(after).getByRole("radio", { name: "Padrão" }));
    await settle(4);
    expect(
      state.calls
        .filter((c) => c.method === "chat.setPermission")
        .at(-1)
        ?.args.at(-1),
    ).toEqual({
      target: { type: "role", id: "role-everyone" },
      allow: [],
      deny: [],
    });
  });

  test("arrow keys move the three-state control at once and keep the focus on it while it saves", async () => {
    const state = await go();
    const dialog = await openSettings();
    await click(within(dialog).getByRole("button", { name: "Permissões" }));
    await settle(3);
    const post = within(dialog).getByRole("radiogroup", { name: "Enviar mensagens para Todos" });
    const inherit = within(post).getByRole("radio", { name: "Padrão" });
    inherit.focus();
    await act(async () => fireEvent.keyDown(inherit, { key: "ArrowRight" }));
    // The optimistic write reaches React in TanStack's setTimeout(0) notify, which act alone doesn't wait for.
    await settle(1);
    const allow = within(post).getByRole("radio", { name: "Permitir" });
    expect(allow.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement === allow).toBe(true);
    expect((allow as HTMLButtonElement).disabled).toBe(false);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "chat.setPermission").map((c) => c.args.at(-1))).toEqual([
      { target: { type: "role", id: "role-everyone" }, allow: ["post"], deny: [] },
    ]);
  });

  test("when the channel keeps me from sending, a quiet line stands where the composer was", async () => {
    await go((state) => {
      const eng = state.channels.find((c) => c.id === ENG_ID);
      if (eng) eng.can = { post: false, callAgents: true, manage: false };
    });
    expect(screen().getByText("Você não pode enviar mensagens neste canal")).toBeTruthy();
    expect(screen().queryByRole("combobox", { name: "Mensagem para #eng" })).toBeNull();
  });

  test("the members column has one title, Members, over its groups", async () => {
    await go();
    const column = document.querySelector(".members-side");
    expect(column?.querySelector(".members-side__title")?.textContent).toBe("Membros");
    expect(within(column as HTMLElement).queryByText("Quem pode ver este canal")).toBeNull();
  });

  test("Membros says who the list is by access: open to the workspace when public, who can see it otherwise", async () => {
    await go();
    let dialog = await openSettings();
    await click(within(dialog).getByRole("button", { name: "Membros" }));
    await settle(3);
    expect(within(dialog).getByText("Aberto para todo o workspace")).toBeTruthy();
    expect(within(dialog).queryByText("Quem pode ver este canal")).toBeNull();
    cleanup();
    await go((state) => {
      const eng = state.channels.find((c) => c.id === ENG_ID);
      if (eng) eng.visibility = "private";
    });
    dialog = await openSettings();
    await click(within(dialog).getByRole("button", { name: "Membros" }));
    await settle(3);
    expect(within(dialog).getByText("Quem pode ver este canal")).toBeTruthy();
    expect(within(dialog).queryByText("Aberto para todo o workspace")).toBeNull();
  });
});
