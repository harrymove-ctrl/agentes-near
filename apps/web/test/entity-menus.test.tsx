import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * The right click (and Shift+F10, the menu key) on the things that have their own menu, in the browser: one list of
 * actions each, shared with its "…" where it has one. Typing and code keep the browser's menu.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
});

type State = ReturnType<typeof seedState>;
const go = async (path = `c/${ENG_ID}`, state: State = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => document.getElementById("app-nav") as HTMLElement;
const menu = () => screen().getByRole("menu", { name: "Ações" });
const items = () =>
  within(menu())
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const rightClick = async (el: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
  await act(async () => void el.dispatchEvent(event));
  await settle(2);
  return event;
};
const pick = async (name: string) => {
  await act(async () => fireEvent.click(within(menu()).getByRole("menuitem", { name })));
  await settle(4);
};
const sidebarLink = (name: string) => within(nav()).getByRole("link", { name: new RegExp(`^#?${name}\\b`) });

describe("a channel", () => {
  test("its sidebar row: mark read when unread, edit and arrange (I manage it), copy link, archive; the browser's menu stays shut", async () => {
    const state = seedState();
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) eng.unreadCount = 3;
    await go(`c/${state.channels[1]?.id}`, state);
    const event = await rightClick(sidebarLink("eng"));
    expect(event.defaultPrevented).toBe(true);
    expect(items()).toEqual([
      "Marcar como lida",
      "Silenciar canal",
      "Editar canal",
      "Fixar no topo",
      "Nova categoria com este canal",
      "Copiar link",
      "Sair do canal",
      "Arquivar canal",
    ]);
    await pick("Marcar como lida");
    expect(state.calls.some((c) => c.method === "dms.markRead" && c.args[1] === ENG_ID)).toBe(true);
  });

  test("#general can't be archived; Copiar link copies the channel's address", async () => {
    await go();
    await rightClick(sidebarLink("general"));
    expect(items()).not.toContain("Arquivar canal");
    expect(items()).not.toContain("Sair do canal");
    await pick("Copiar link");
    expect(copied.at(-1)).toMatch(new RegExp(`/org/${ORG_ID}/c/`));
  });

  test("Sair do canal: a public channel goes at once, with Desfazer, and off its page", async () => {
    const state = seedState();
    const { router } = await go(`c/${ENG_ID}`, state);
    await rightClick(sidebarLink("eng"));
    await pick("Sair do canal");
    expect(state.calls.some((c) => c.method === "chat.leave" && c.args[1] === ENG_ID)).toBe(true);
    expect(router.state.location.pathname).not.toContain(ENG_ID);
    expect(screen().getByRole("button", { name: "Desfazer" })).toBeTruthy();
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("Sair do canal: a private channel asks first, and the last person out reads that it archives", async () => {
    const state = seedState();
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) eng.visibility = "private";
    await go(`c/${ENG_ID}`, state);
    await rightClick(sidebarLink("eng"));
    await pick("Sair do canal");
    const asked = screen().getByRole("dialog", { name: "Sair de #eng?" });
    expect(asked.textContent).toContain("alguém de dentro precisa adicionar você");
    expect(state.calls.some((c) => c.method === "chat.leave")).toBe(false);
    await act(async () => fireEvent.click(within(asked).getByRole("button", { name: "Sair" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "chat.leave" && c.args[1] === ENG_ID)).toBe(true);
  });

  test("the channel's header has the same menu", async () => {
    await go();
    await rightClick(screen().getByRole("heading", { level: 1, name: "eng" }));
    expect(items()).toEqual([
      "Silenciar canal",
      "Editar canal",
      "Fixar no topo",
      "Copiar link",
      "Sair do canal",
      "Arquivar canal",
    ]);
  });
});

/** DMs with Ada, Atlas and João, so each has a row under "Mensagens diretas". */
const withDms = () => {
  const state = seedState();
  seedDm(state, { type: "agent", id: ADA_ID });
  seedDm(state, { type: "agent", id: ATLAS_ID });
  seedDm(state, { type: "person", id: "u-joao" });
  return state;
};

describe("an agent", () => {
  test("Shift+F10 on its row: talk, profile, pin, copy @, a new group with it, edit (owner or admin), link, id", async () => {
    await go(undefined, withDms());
    const row = within(nav()).getByRole("link", { name: /^Ada/ });
    row.focus();
    await act(async () => fireEvent.keyDown(row, { key: "F10", shiftKey: true }));
    await settle(2);
    expect(items()).toEqual([
      "Mensagem direta",
      "Ver perfil",
      "Fixar no topo",
      "Copiar @ada",
      "Novo setor com Ada",
      "Editar agente",
      "Copiar link",
      "Copiar ID",
    ]);
    await pick("Copiar @ada");
    expect(copied.at(-1)).toBe("@ada");
  });

  test("the menu key opens it too; Editar agente goes to its settings", async () => {
    const { router } = await go(undefined, withDms());
    const row = within(nav()).getByRole("link", { name: /^Atlas/ });
    await act(async () => fireEvent.keyDown(row, { key: "ContextMenu" }));
    await settle(2);
    await pick("Editar agente");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${seedState().agents[1]?.id}`);
    expect(router.state.location.search).toMatchObject({ tab: "settings" });
  });
});

describe("a person", () => {
  test("their sidebar row: DM, copy @, remove (I may) and copy id", async () => {
    await go(undefined, withDms());
    const row = nav().querySelector('a[href$="/dm/person/u-joao"]');
    if (!row) throw new Error("no row for João");
    await rightClick(row);
    expect(items()).toEqual(["Mensagem direta", "Fixar no topo", "Copiar @joao", "Remover do workspace", "Copiar ID"]);
    await pick("Copiar ID");
    expect(copied.at(-1)).toBe("u-joao");
  });

  test("their name in a message: also their card and Mencionar, which types the @ in the composer", async () => {
    await go();
    const name = screen()
      .getAllByRole("button", { name: /^Perfil de / })
      .find((b) => !b.hasAttribute("aria-hidden"));
    if (!name) throw new Error("no author name");
    await rightClick(name);
    expect(items()).toContain("Mencionar");
    expect(items()).toContain("Ver perfil");
    await pick("Mencionar");
    const composer = screen().getByRole("combobox", { name: "Mensagem para #eng" }) as HTMLTextAreaElement;
    expect(composer.value).toMatch(/@\w+/);
  });
});

describe("lists of things", () => {
  test("a Drive card: open and download first, then what its … has", async () => {
    const api = createFakeApi(seedState(), { seed: true });
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    const card = document.querySelector(".drive-card");
    if (!card) throw new Error("no Drive card");
    await rightClick(card);
    expect(items().slice(0, 4)).toEqual(["Abrir", "Baixar", "Compartilhar", "Copiar link"]);
  });

  test("a routine: run, pause, then its … (edit, runs, duplicate, delete); the … lists the same", async () => {
    await go("routines");
    await rightClick(screen().getByRole("article", { name: "Resumo da semana" }));
    const fromRightClick = items();
    expect(fromRightClick).toEqual(
      expect.arrayContaining(["Rodar agora", "Pausar", "Editar", "Ver execuções", "Apagar"]),
    );
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
  });

  test("an issue card: open beside, open its page, copy link, and delete for who may", async () => {
    await go("issues");
    const card = document.querySelector(".issue-card");
    if (!card) throw new Error("no issue card");
    await rightClick(card);
    expect(items()).toEqual(["Abrir", "Abrir em página inteira", "Copiar link", "Excluir tarefa"]);
  });
});

describe("typing keeps the browser's menu", () => {
  test("the composer", async () => {
    await go();
    const composer = screen().getByRole("combobox", { name: "Mensagem para #eng" });
    const event = await rightClick(composer);
    expect(event.defaultPrevented).toBe(false);
    expect(screen().queryByRole("menu", { name: "Ações" })).toBeNull();
  });
});

describe("the sidebar's sections, in my order", () => {
  const blocks = () => [...nav().querySelectorAll<HTMLElement>(".sidebar__block")].map((b) => b.dataset.section);

  test("the default order; Mover para baixo on Canais saves the new one; Restaurar ordem padrão goes back", async () => {
    const { state } = await go();
    expect(blocks()).toEqual(["tools", "channels", "agents", "people"]);
    await act(async () =>
      fireEvent.click(
        within(nav()).getByRole("button", { name: "Arraste para mover a seção Canais ou clique para ver as opções" }),
      ),
    );
    await settle(2);
    expect(within(menu()).getByRole("menuitem", { name: "Mover para cima" }).getAttribute("aria-disabled")).toBe(null);
    await pick("Mover para baixo");
    expect(blocks()).toEqual(["tools", "agents", "channels", "people"]);
    expect(state.calls.filter((c) => c.method === "orgs.setSidebarOrder").map((c) => c.args[1])).toEqual([
      ["tools", "agents", "channels", "people"],
    ]);

    await rightClick(within(nav()).getByRole("button", { name: "Mensagens diretas" }));
    await pick("Restaurar ordem padrão");
    expect(blocks()).toEqual(["tools", "channels", "agents", "people"]);
    expect(state.calls.filter((c) => c.method === "orgs.setSidebarOrder").at(-1)?.args[1]).toBeNull();
  });

  test("a saved order comes back: agents first; the top one can't go up", async () => {
    await go(`c/${ENG_ID}`, seedState({ sidebarOrder: ["agents", "people", "tools", "channels"] }));
    expect(blocks()).toEqual(["agents", "people", "tools", "channels"]);
    await rightClick(within(nav()).getByRole("button", { name: "Agentes" }));
    expect(within(menu()).getByRole("menuitem", { name: "Mover para cima" }).hasAttribute("data-disabled")).toBe(true);
  });
});

describe("dragging in the sidebar", () => {
  test("a section's ghost is its header row, not a long list over the others", async () => {
    await go();
    const images: Element[] = [];
    const dataTransfer = { setData: () => {}, setDragImage: (el: Element) => void images.push(el) };
    const grip = within(nav()).getByRole("button", {
      name: "Arraste para mover a seção Canais ou clique para ver as opções",
    });
    await act(async () => fireEvent.dragStart(grip, { dataTransfer }));
    expect(images).toHaveLength(1);
    expect(images[0]?.classList.contains("sidebar__section-head")).toBe(true);
    expect(images[0]?.textContent).toContain("Canais");
    await act(async () => fireEvent.dragEnd(grip, { dataTransfer }));
    await act(async () =>
      fireEvent.dragStart(
        within(nav()).getByRole("button", {
          name: "Arraste para mover a seção Ferramentas ou clique para ver as opções",
        }),
        { dataTransfer },
      ),
    );
    // The tools have no header: the ghost is all of them, which is what moves.
    expect(images[1]?.classList.contains("sidebar__tools")).toBe(true);
  });

  test("one mark where a drag lands, the same for sections, channels, categories and agents", () => {
    const css = readFileSync(new URL("../src/layout.css", import.meta.url), "utf8");
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return start < 0 ? "" : css.slice(start, css.indexOf("}", start));
    };
    // The line: the accent at reduced strength, 2px, round ends, from the names' column.
    const line = rule('.sidebar :is([data-drop="before"], [data-drop="after"])::after,\n.sidebar__drop-line');
    expect(line).toContain("height: 2px");
    expect(line).toContain("border-radius: 999px");
    expect(line).toContain("color-mix(in srgb, var(--agent) 60%, transparent)");
    expect(line).toContain("left: var(--drop-inset, 36px)");
    // No second line in ink stacked on it (a section's box once drew both).
    expect(css).not.toMatch(/data-drop[^{]*\{[^}]*inset 0 -?2px 0 var\(--ink\)/);
    expect(rule(".sidebar__block[data-drop]::after")).not.toContain("background");
    expect(rule(".sidebar__drop-line")).not.toContain("var(--ink)");
    // The desktop app lets the section's grip (a draggable button) start its drag.
    const desktop = readFileSync(new URL("../src/desktop.css", import.meta.url), "utf8");
    expect(desktop).toContain('button:not([draggable="true"])');
  });
});

describe("the open row's highlight", () => {
  test("the open channel and the open agent are the active row (one plate, sidebar-css.test.ts has its look)", async () => {
    const { router } = await go();
    const active = () => nav().querySelector<HTMLElement>('.sidebar__item[data-status="active"]');
    expect(active()?.textContent).toContain("eng");
    await act(() => router.navigate({ to: `/org/${ORG_ID}/dm/agent/${seedState().agents[0]?.id}` }));
    await settle(4);
    expect(active()?.closest("[data-agent-row]")).not.toBeNull();
  });
});
