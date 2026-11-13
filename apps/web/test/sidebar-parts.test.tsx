import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * The sidebar's parts (Canais, Agentes, Mensagens diretas): small-capitals titles set apart by space, one + each
 * (Canais: Novo canal, Nova categoria; Agentes: Criar agente, Novo grupo; Mensagens diretas: Nova mensagem), the
 * sidebar's own menu on a right click in its empty space, and the buttons over a row's end on hover or focus.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const sheet of document.querySelectorAll("style[data-layout]")) sheet.remove();
});

type State = ReturnType<typeof seedState>;
const ENGINEERING = "00000000-0000-4000-8000-0000000000f1";
const asMember = (state: State = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
const withCategory = (state: State = seedState()) => {
  state.channelCategories = [{ id: ENGINEERING, name: "Engenharia", position: 0 }];
  for (const c of state.channels) if (c.id === ENG_ID) c.categoryId = ENGINEERING;
  return state;
};
/** DMs with Ada (an hour ago), João (now, 2 unread) and Atlas (no message yet). */
const withDms = (state: State = seedState()) => {
  seedDm(state, { type: "agent", id: ADA_ID }, { ago: 60 });
  seedDm(state, { type: "person", id: "u-joao" }, { ago: 1, unread: 2 });
  state.dms.push({ channelId: "dm-atlas", with: { type: "agent", id: ATLAS_ID, name: "Atlas", handle: "atlas" } });
  return state;
};
const go = async (state: State = seedState(), path = `c/${GENERAL_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const scroll = () => nav().querySelector(".sidebar__scroll") as HTMLElement;
const head = (name: string) =>
  within(nav()).getByRole("button", { name }).closest(".sidebar__section-head") as HTMLElement;
const labels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** A header's + opens with the keyboard like any of our menus. */
const openPlus = async (label: string) => {
  const plus = within(nav()).getByRole("button", { name: label });
  await act(async () => {
    fireEvent.keyDown(plus, { key: "Enter" });
    fireEvent.keyUp(plus, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu", { name: label });
};
const rightClick = async (el: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 400 });
  await act(async () => void el.dispatchEvent(event));
  await settle(2);
  return event;
};
const appMenu = () => screen().getByRole("menu", { name: "Ações" });
const channelRow = (name: string) => {
  const link = nav().querySelector(`a.sidebar__item[title="#${name}"]`);
  if (!link) throw new Error(`no #${name}`);
  return link.parentElement as HTMLElement;
};
const withLayout = async () => {
  const sheet = document.createElement("style");
  sheet.dataset.layout = "";
  sheet.textContent = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
  document.head.append(sheet);
};
const shown = (el: Element) => {
  for (let e: Element | null = el; e; e = e.parentElement)
    if (window.getComputedStyle(e).display === "none") return false;
  return true;
};

describe("the parts' headers", () => {
  test("Canais holds the channels in no category, then its categories; no lines, no Nova categoria row", async () => {
    await go(withCategory());
    const titles = [...nav().querySelectorAll(".sidebar__section--part .sidebar__section-toggle")].map(
      (b) => b.textContent,
    );
    expect(titles).toEqual(["Canais", "Agentes", "Mensagens diretas"]);
    const canais = head("Canais").closest(".sidebar__section") as HTMLElement;
    expect(within(canais).getByRole("link", { name: /general/ })).toBeTruthy();
    expect(canais.nextElementSibling?.querySelector(".sidebar__section-toggle")?.textContent).toBe("Engenharia");
    expect(nav().querySelector(".sidebar__divider")).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Nova categoria" })).toBeNull();
  });

  test("Mensagens diretas lists the people I talked to, latest first; an agent's DM is its row in Agentes", async () => {
    await go(withDms());
    const dms = head("Mensagens diretas").closest(".sidebar__section") as HTMLElement;
    const names = [...dms.querySelectorAll("a.sidebar__item .sidebar__item-label")].map((l) => l.textContent);
    expect(names).toEqual(["João"]);
    const agents = head("Agentes").closest(".sidebar__section") as HTMLElement;
    expect(within(agents).getByRole("link", { name: /^Ada/ })).toBeTruthy();
    // A DM's unread count is the red one, as on Discord.
    const joao = within(dms).getByRole("link", { name: /João/ });
    expect(joao.getAttribute("data-unread")).toBe("true");
    expect(within(joao).getByRole("img", { name: "2 mensagens não lidas" }).textContent).toBe("2");
    // Closed, the part keeps its unread total on its header.
    await click(within(nav()).getByRole("button", { name: "Mensagens diretas" }));
    expect(within(head("Mensagens diretas")).getByRole("img", { name: "2 mensagens não lidas" })).toBeTruthy();
  });

  test("a DM opened with a person is listed before any message", async () => {
    const state = seedState();
    state.dms.push({
      channelId: "dm-joao",
      with: { type: "person", id: "u-joao", name: "João", handle: null },
      openedAt: new Date().toISOString(),
    });
    await go(state);
    const dms = head("Mensagens diretas").closest(".sidebar__section") as HTMLElement;
    expect(within(dms).getByRole("link", { name: /João/ })).toBeTruthy();
  });

  test("no conversation with a person yet: a line says where they go; the agents' groups are under Agentes", async () => {
    const state = seedState();
    state.agentGroups = [{ id: "00000000-0000-4000-8000-0000000000e1", name: "Integrations", agentIds: [ADA_ID] }];
    await go(state);
    const dms = head("Mensagens diretas").closest(".sidebar__section") as HTMLElement;
    expect(dms.querySelectorAll("a.sidebar__item").length).toBe(0);
    expect(dms.textContent).toContain("Suas conversas com pessoas aparecem aqui.");
    const group = head("Integrations").closest(".sidebar__section") as HTMLElement;
    expect(within(group).getByRole("link", { name: /^Ada/ })).toBeTruthy();
    expect(nav().querySelector(".sidebar__see-all")).toBeNull();
  });

  test("closed, Canais hides its categories too, but the open channel", async () => {
    await withLayout();
    await go(withCategory(), `c/${ENG_ID}`);
    await click(within(nav()).getByRole("button", { name: "Canais" }));
    expect(shown(channelRow("eng"))).toBe(true);
    expect(shown(nav().querySelector('a.sidebar__item[title="#general"]') as Element)).toBe(false);
  });

  test("no Criar agente row, not even with no agents yet: Agentes' + has it (always shown on touch screens)", async () => {
    await go();
    expect(nav().querySelector(".sidebar__create")).toBeNull();
    expect(labels(await openPlus("Novo agente ou setor"))).toEqual(["Criar agente", "Novo setor"]);
    cleanup();
    const state = seedState();
    state.agents = [];
    await go(state);
    expect(nav().querySelector(".sidebar__create")).toBeNull();
    expect(within(nav()).queryByRole("link", { name: "Criar o primeiro agente" })).toBeNull();
    expect(labels(await openPlus("Novo agente ou setor"))).toEqual(["Criar agente", "Novo setor"]);
  });
});

describe("one + per part", () => {
  test("Canais: Novo canal and Nova categoria, each opening its dialog", async () => {
    await go();
    expect(head("Canais").contains(within(nav()).getByRole("button", { name: "Novo canal ou categoria" }))).toBe(true);
    let menu = await openPlus("Novo canal ou categoria");
    expect(labels(menu)).toEqual(["Novo canal", "Nova categoria"]);
    await click(within(menu).getByRole("menuitem", { name: "Novo canal" }));
    expect(screen().getByRole("dialog", { name: "Criar canal" })).toBeTruthy();
    cleanup();
    await go();
    menu = await openPlus("Novo canal ou categoria");
    await click(within(menu).getByRole("menuitem", { name: "Nova categoria" }));
    expect(screen().getByRole("dialog", { name: "Nova categoria" })).toBeTruthy();
  });

  test("a member creates channels but not categories: Novo canal alone", async () => {
    await go(asMember());
    expect(labels(await openPlus("Novo canal ou categoria"))).toEqual(["Novo canal"]);
  });

  test("Agentes: Criar agente opens the new agent's dialog over the page (ADR 0164); Equipe is a tool row of its own", async () => {
    const { router } = await go();
    expect(
      within(nav().querySelector(".sidebar__tools") as HTMLElement).getByRole("link", { name: "Equipe" }),
    ).toBeTruthy();
    const before = router.state.location.pathname;
    const menu = await openPlus("Novo agente ou setor");
    await click(within(menu).getByRole("menuitem", { name: "Criar agente" }));
    expect(screen().getByRole("dialog", { name: "Novo agente" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(before);
  });

  test("Mensagens diretas' + is Nova mensagem, opening Ir para…; a member who may not create agents has no Agentes +", async () => {
    await go(asMember());
    expect(within(head("Agentes")).queryByRole("button", { name: "Novo agente ou setor" })).toBeNull();
    let asked = 0;
    const count = () => asked++;
    window.addEventListener("agentes:palette", count);
    await click(within(head("Mensagens diretas")).getByRole("button", { name: "Nova mensagem" }));
    window.removeEventListener("agentes:palette", count);
    expect(asked).toBe(1);
  });
});

describe("the sidebar's own menu, on its empty space", () => {
  test("customize, create, Equipe and the order; Personalizar opens its dialog", async () => {
    await go();
    const event = await rightClick(scroll());
    expect(event.defaultPrevented).toBe(true);
    expect(labels(appMenu())).toEqual([
      "Personalizar a barra lateral",
      "Novo canal",
      "Nova categoria",
      "Criar agente",
      "Novo setor",
      "Equipe",
      "Restaurar ordem padrão",
    ]);
    expect(
      within(appMenu()).getByRole("menuitem", { name: "Restaurar ordem padrão" }).hasAttribute("data-disabled"),
    ).toBe(true);
    await click(within(appMenu()).getByRole("menuitem", { name: "Personalizar a barra lateral" }));
    expect(screen().getByRole("dialog", { name: "Personalizar a barra lateral" })).toBeTruthy();
  });

  test("a member's lists only what they may do", async () => {
    await go(asMember());
    await rightClick(scroll());
    expect(labels(appMenu())).toEqual([
      "Personalizar a barra lateral",
      "Novo canal",
      "Equipe",
      "Restaurar ordem padrão",
    ]);
  });

  test("rows and headers keep their own menus, and a tool's link keeps the browser's", async () => {
    await go();
    await rightClick(head("Mensagens diretas"));
    expect(labels(appMenu())).toContain("Mover para cima");
    expect(labels(appMenu())).not.toContain("Personalizar a barra lateral");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    const tool = within(nav()).getByRole("link", { name: /^Threads/ });
    const event = await rightClick(tool);
    expect(event.defaultPrevented).toBe(false);
    await act(async () => fireEvent.keyDown(tool, { key: "F10", shiftKey: true }));
    await settle(2);
    expect(screen().queryByRole("menuitem", { name: "Personalizar a barra lateral" })).toBeNull();
  });

  test("a right click or Shift+F10 inside a + menu or a dialog (portaled out of the sidebar) opens no menu of ours", async () => {
    const ours = () =>
      screen()
        .queryAllByRole("menuitem")
        .map((i) => i.textContent)
        .filter((l) => l === "Personalizar a barra lateral" || l === "Mover para cima");
    await go(withCategory());
    const menu = await openPlus("Novo canal ou categoria");
    const item = within(menu).getByRole("menuitem", { name: "Novo canal" });
    await rightClick(item);
    expect(ours()).toEqual([]);
    await act(async () => fireEvent.keyDown(item, { key: "F10", shiftKey: true }));
    await settle(2);
    expect(ours()).toEqual([]);
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    await rightClick(nav().querySelector('a.sidebar__item[title="#general"]') as Element);
    await click(within(appMenu()).getByRole("menuitem", { name: /^Mover para/ }));
    const dialog = screen().getByRole("dialog");
    await rightClick(within(dialog).getAllByRole("button")[0] as Element);
    expect(ours()).toEqual([]);
  });
});

describe("a row's buttons on hover or focus", () => {
  test("a channel I manage: Adicionar pessoas ou agentes opens adding members, the gear its settings", async () => {
    const { router } = await go(seedState(), `c/${GENERAL_ID}`);
    const row = channelRow("eng");
    expect(row.dataset.acts).toBe("2");
    await click(within(row).getByRole("button", { name: "Adicionar pessoas ou agentes" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(screen().getByRole("dialog", { name: "Adicionar a #eng" })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "#eng" })).toBeNull();
    // Closing it closes everything: no details left under it.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(4);
    expect(screen().queryByRole("dialog")).toBeNull();

    await click(within(channelRow("general")).getByRole("button", { name: "Configurações do canal" }));
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(screen().getByRole("dialog", { name: "#general" })).toBeTruthy();
  });

  test("Tab reaches them right after the row's link, in the row", async () => {
    await go();
    const row = channelRow("eng");
    const stops = [...row.querySelectorAll<HTMLElement>("a, button")];
    expect(stops.map((el) => el.getAttribute("aria-label") ?? el.tagName)).toEqual([
      "A",
      "Adicionar pessoas ou agentes",
      "Configurações do canal",
    ]);
    expect(stops.every((el) => el.tabIndex === 0)).toBe(true);
  });

  test("a member who didn't make the channel gets none, and keeps its unread marks", async () => {
    const state = asMember();
    for (const c of state.channels) {
      c.unreadCount = c.id === ENG_ID ? 2 : 0;
      c.mentionCount = c.id === ENG_ID ? 2 : 0;
    }
    await go(state);
    const link = nav().querySelector('a.sidebar__item[title="#eng"]') as HTMLElement;
    expect(link.parentElement?.classList.contains("sidebar__row")).toBe(false);
    expect(within(nav()).queryByRole("button", { name: "Configurações do canal" })).toBeNull();
    expect(link.querySelector(".sidebar__unread")?.textContent).toBe("2");
  });

  test("an agent: its settings for its owner and the admins, in the panel and never the full page", async () => {
    const { router } = await go(withDms());
    const ada = within(nav()).getByRole("link", { name: /^Ada/ }).parentElement as HTMLElement;
    await click(within(ada).getByRole("button", { name: "Configurações de Ada" }));
    await settle(4);
    // Beside the conversation on screen, which stays.
    expect(document.querySelector("aside.thread-panel--wide")).not.toBeNull();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    cleanup();
    // With no conversation on screen: beside the agent's own.
    const away = await go(withDms(), "threads");
    const row = within(nav()).getByRole("link", { name: /^Ada/ }).parentElement as HTMLElement;
    await click(within(row).getByRole("button", { name: "Configurações de Ada" }));
    await settle(8);
    expect(away.router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    expect(document.querySelector("aside.thread-panel--wide")).not.toBeNull();
    cleanup();
    await go(asMember(withDms()));
    expect(within(nav()).getByRole("link", { name: /^Ada/ })).toBeTruthy();
    expect(within(nav()).queryByRole("button", { name: "Configurações de Ada" })).toBeNull();
  });
});

describe("unread marks, Discord's way", () => {
  const RANDOM = "00000000-0000-4000-8000-0000000000c9";
  const withRandom = (state: State = seedState()) => {
    state.channels.push({
      id: RANDOM,
      name: "random",
      topic: "",
      visibility: "public",
      isMember: true,
      createdAt: new Date().toISOString(),
    });
    return state;
  };

  test("something new lights the row with how many wait in a quiet count, a mention of me gets the red one, muted never lights", async () => {
    const state = withRandom();
    for (const c of state.channels) {
      if (c.id === ENG_ID) Object.assign(c, { unreadCount: 4, mentionCount: 0 });
      if (c.id === RANDOM) Object.assign(c, { unreadCount: 3, mentionCount: 2 });
    }
    await go(state);
    const link = (name: string) => nav().querySelector(`a.sidebar__item[title="#${name}"]`) as HTMLElement;
    expect(link("eng").dataset.kind).toBe("channel");
    expect(link("eng").dataset.unread).toBe("true");
    // A group conversation says how many messages wait, like a DM, in the neutral count: red stays for mentions.
    const quiet = link("eng").querySelector(".sidebar__unread") as HTMLElement;
    expect(quiet.textContent).toBe("4");
    expect(quiet.classList.contains("sidebar__unread--quiet")).toBe(true);
    expect(quiet.getAttribute("aria-label")).toBe("4 mensagens não lidas");
    const count = link("random").querySelector(".sidebar__unread") as HTMLElement;
    expect(count.textContent).toBe("2");
    expect(count.classList.contains("sidebar__unread--quiet")).toBe(false);
    expect(count.getAttribute("aria-label")).toBe("2 menções a você");
    expect(link("general").dataset.unread).toBe("false");
    expect(link("general").querySelector(".sidebar__unread")).toBeNull();
    cleanup();

    // Muted: it rests gray whatever comes, but a mention of me still shows.
    const muted = withRandom();
    for (const c of muted.channels)
      if (c.id === RANDOM) Object.assign(c, { unreadCount: 3, mentionCount: 1, muted: true });
    await go(muted);
    expect(link("random").dataset.unread).toBe("false");
    expect(link("random").dataset.muted).toBe("true");
    expect(link("random").querySelector(".sidebar__unread")?.textContent).toBe("1");
    cleanup();

    const mutedQuiet = withRandom();
    for (const c of mutedQuiet.channels)
      if (c.id === RANDOM) Object.assign(c, { unreadCount: 3, mentionCount: 0, muted: true });
    await go(mutedQuiet);
    expect(link("random").querySelector(".sidebar__unread")).toBeNull();
  });

  test("the open channel keeps its own buttons, the cog for its settings", async () => {
    await go();
    const row = channelRow("general");
    expect((row.querySelector("a.sidebar__item") as HTMLElement).dataset.status).toBe("active");
    const cog = within(row).getByRole("button", { name: "Configurações do canal" });
    expect(cog.querySelector("svg path")?.getAttribute("d")).toStartWith("M15.26 8.39");
  });
});
