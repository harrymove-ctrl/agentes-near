import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ACCESSORIES, AGENT_ACCESSORIES, Avatar, normalizeAppearance, randomAppearance } from "@agenteschat/ui";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

describe("accessories: pixel art from the agent engine", () => {
  test("every accessory the app offers is drawn by the engine; glasses are gone", () => {
    for (const a of AGENT_ACCESSORIES) if (a !== "none") expect(ACCESSORIES[a]).toBeTruthy();
    expect(AGENT_ACCESSORIES).not.toContain("glasses" as never);
    expect(normalizeAppearance({ accessory: "glasses" }).accessory).toBeUndefined();
    expect(normalizeAppearance({ accessory: "antenna" }).accessory).toBe("antenna");
  });
});

describe("the agent's look", () => {
  test("only known values; random differs from the current look", () => {
    expect(normalizeAppearance({ color: "rose", eyes: "laser", accessory: "crown", extra: 1 })).toEqual({
      color: "rose",
      eyes: undefined,
      accessory: "crown",
    });
    expect(normalizeAppearance(null)).toEqual({ color: undefined, eyes: undefined, accessory: undefined });
    let i = 0;
    const seq = [0, 0, 0, 0.5, 0.5, 0.5];
    const r = randomAppearance({ color: "sky", eyes: "round", accessory: "none" }, () => seq[i++ % seq.length] ?? 0);
    expect(r).not.toEqual({ color: "sky", eyes: "round", accessory: "none" });
  });

  test("the avatar draws color, eyes and the accessory, and keeps its live state", () => {
    const { container } = render(
      <Avatar
        kind="agent"
        name="Theo"
        size="sm"
        state="thinking"
        appearance={{ color: "rose", eyes: "happy", accessory: "crown" }}
      />,
    );
    const a = container.querySelector(".ac-avatar") as HTMLElement;
    expect(a.getAttribute("data-eyes")).toBe("happy");
    expect(a.style.getPropertyValue("--av-top")).toBeTruthy();
    expect(a.getAttribute("data-accessory")).toBe("crown");
    expect(a.className).toContain("ac-avatar--thinking");
    // The engine draws the agent on its canvas.
    expect(a.querySelector("canvas.ac-avatar__canvas")).not.toBeNull();
  });

  test("Configurações: pick color, eyes and accessory in place; the cover shows it; Salvar; the sidebar shows it", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { api: createFakeApi(state) });
    await settle(8);
    // In place: the colors, then the eyes and what it wears as one sliding row each.
    const page = screen();
    await click(within(page.getByRole("group", { name: "Cor" })).getByRole("button", { name: "Rosa" }));
    await click(within(page.getByRole("group", { name: "Olhos" })).getByRole("button", { name: /Felizes/ }));
    await click(within(page.getByRole("group", { name: "Acessório" })).getByRole("button", { name: /Coroa/ }));
    expect(document.querySelector(".ac-carousel")).not.toBeNull();
    // The agent's face over the cover's edge is the draft.
    const cover = document.querySelector(".agp-face .ac-avatar") as HTMLElement;
    expect(cover.getAttribute("data-eyes")).toBe("happy");
    expect(cover.getAttribute("data-accessory")).toBe("crown");
    expect(document.body.textContent).toContain("Antes: Céu · Redondos");
    const bar = screen().getByRole("region", { name: "Alterações não salvas" });
    await click(within(bar).getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      appearance: { color: "rose", eyes: "happy", accessory: "crown" },
    });
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(nav.querySelector('[data-accessory="crown"]')).not.toBeNull();
  });

  test("Sortear changes the look (the save bar shows up)", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(screen().queryByRole("region", { name: "Alterações não salvas" })).toBeNull();
    await click(screen().getByRole("button", { name: "Sortear" }));
    expect(screen().getByRole("region", { name: "Alterações não salvas" }).textContent).toContain("Jeito");
  });
});

describe("the agent's name and role", () => {
  const key = async (el: Element, k: string) => {
    await act(async () => {
      fireEvent.keyDown(el, { key: k });
      fireEvent.keyUp(el, { key: k });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
  };

  test("Mais ações → Editar nome e cargo: edited in Configurações, saved together; the @handle follows", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const trigger = screen().getAllByRole("button", { name: "Mais ações" })[0] as HTMLElement;
    trigger.focus();
    await key(trigger, "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Editar nome e cargo" }));
    await settle(4);
    expect(document.body.textContent).toContain("É como todo mundo vê o agente. O @ acompanha o nome.");
    // The name edits in place: the menu opens its field.
    const name = screen().getByLabelText("Nome") as HTMLInputElement;
    await act(async () => fireEvent.change(name, { target: { value: "Ada Lovelace" } }));
    await act(async () => fireEvent.keyDown(name, { key: "Enter" }));
    await click(screen().getByRole("button", { name: /^Editar cargo/ }));
    const role = screen().getByRole("combobox", { name: "Cargo" });
    await act(async () => fireEvent.change(role, { target: { value: "Tech lead" } }));
    await act(async () => fireEvent.keyDown(role, { key: "Enter" }));
    // The page title follows the draft.
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Ada Lovelace");
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(6);
    const call = state.calls.find((c) => c.method === "agents.update");
    expect(call?.args[2]).toEqual({ name: "Ada Lovelace", handle: "adalovelace", role: "Tech lead" });
    expect(state.agents.find((a) => a.id === ADA_ID)?.handle).toBe("adalovelace");
  });
});
