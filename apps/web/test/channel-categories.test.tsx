import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, createEvent, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { endExit, exitsLast, renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const sheet of document.querySelectorAll("style[data-layout]")) sheet.remove();
});

/** Acme on a channel (#general unless `channel` says), on `api` (the fake one on `state` unless given). */
const go = async (state = seedState(), { api = createFakeApi(state), channel = GENERAL_ID } = {}) => {
  await renderApp(`/org/${ORG_ID}/c/${channel}`, { api });
  await settle(8);
  return state;
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
/** "Canais", the sidebar's part with the channels in no category (all of them, with no categories). */
const canais = () => within(nav()).getByRole("button", { name: "Canais" }).closest(".sidebar__section") as HTMLElement;
const names = () =>
  [...canais().querySelectorAll(".sidebar__section-body a.sidebar__item > .sidebar__item-label")].map(
    (l) => l.textContent,
  );
const row = (name: string) => within(canais()).getByRole("link", { name });
const dataTransfer = { setData: () => {}, getData: () => "" };
/** Drags `from` over the top or bottom half of `to` (a 0-tall box here) and drops it there. */
const dragOnto = async (from: Element, to: Element, half: "top" | "bottom") => {
  await act(async () => fireEvent.dragStart(from, { dataTransfer }));
  // happy-dom's DragEvent is a plain Event: no clientY from the init.
  const over = createEvent.dragOver(to, { dataTransfer });
  Object.defineProperty(over, "clientY", { value: half === "top" ? 0 : 1 });
  await act(async () => fireEvent(to, over));
  const mark = to.getAttribute("data-drop");
  await act(async () => fireEvent.drop(to, { dataTransfer }));
  await settle(3);
  return mark;
};
const places = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "chat.place").map((c) => c.args.slice(1));

describe("the channels' order in the sidebar (ADR 0080)", () => {
  test("with no categories, a channel drags above or below another one in Canais", async () => {
    const state = await go();
    expect(names()).toEqual(["eng", "general"]);
    expect(row("general").getAttribute("draggable")).toBe("true");

    expect(await dragOnto(row("general"), row("eng"), "top")).toBe("before");
    expect(places(state)).toEqual([[GENERAL_ID, { categoryId: null, beforeChannelId: ENG_ID }]]);
    expect(names()).toEqual(["general", "eng"]);
    expect(row("eng").getAttribute("data-drop")).toBeNull();

    // Below the last one: to the end.
    expect(await dragOnto(row("general"), row("eng"), "bottom")).toBe("after");
    expect(places(state).at(-1)).toEqual([GENERAL_ID, { categoryId: null, beforeChannelId: null }]);
    expect(names()).toEqual(["eng", "general"]);
  });

  test("a drop where the channel already is sends nothing", async () => {
    const state = await go();
    expect(await dragOnto(row("eng"), row("general"), "top")).toBe("before");
    expect(await dragOnto(row("general"), row("eng"), "bottom")).toBe("after");
    expect(places(state)).toEqual([]);
  });

  test("nothing drags until the categories load", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.chat.categories = () => new Promise(() => {});
    await go(state, { api });
    expect(row("general").getAttribute("draggable")).toBe("false");
  });

  test("a member drags only the channels they created", async () => {
    const state = seedState();
    const me = state.me;
    if (me?.organizations[0]) me.organizations[0].role = "member";
    for (const c of state.channels) c.createdByUserId = c.id === GENERAL_ID ? me?.user.id : "u-joao";
    await go(state);
    expect(row("general").getAttribute("draggable")).toBe("true");
    expect(row("eng").getAttribute("draggable")).toBe("false");
  });
});

describe("Criar canal in a category made there (ADR 0080)", () => {
  const click = (el: Element) => act(async () => fireEvent.click(el));
  const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
  const pick = async (combobox: HTMLElement, option: string) => {
    combobox.focus();
    await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
    await act(async () => fireEvent.click(screen().getByRole("option", { name: option })));
    await settle();
  };
  const created = (state: ReturnType<typeof seedState>) =>
    state.calls.filter((c) => c.method === "chat.createChannel").map((c) => c.args[1]);

  test("the new channel lands in the category made from its picker, not before it exists", async () => {
    const state = await go();
    // Canais' +: Novo canal or Nova categoria.
    const plus = within(nav()).getByRole("button", { name: "Novo canal ou categoria" });
    await act(async () => {
      fireEvent.keyDown(plus, { key: "Enter" });
      fireEvent.keyUp(plus, { key: "Enter" });
    });
    await settle(2);
    const menu = screen().getByRole("menu", { name: "Novo canal ou categoria" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Novo canal", "Nova categoria"]);
    await click(within(menu).getByRole("menuitem", { name: "Novo canal" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    await type(within(dialog).getByLabelText("Nome"), "vendas");
    await pick(within(dialog).getByRole("combobox", { name: "Categoria" }), "Nova categoria…");

    // Typing goes to its Nome, not to the Categoria left under it.
    const inner = screen().getByRole("dialog", { name: "Nova categoria" });
    expect(document.activeElement === within(inner).getByLabelText("Nome")).toBe(true);
    await type(within(inner).getByLabelText("Nome"), "Produto");
    await click(within(inner).getByRole("button", { name: "Criar categoria" }));
    await settle(6);

    // Making the category only picks it: the channel waits for its own Criar.
    expect(created(state)).toEqual([]);
    const category = state.channelCategories?.find((c) => c.name === "Produto");
    expect(category).toBeDefined();
    const still = screen().getByRole("dialog", { name: "Criar canal" });
    const picker = within(still).getByRole("combobox", { name: "Categoria" });
    expect(picker.textContent).toContain("Produto");
    expect(document.activeElement === picker).toBe(true);

    await click(within(still).getByRole("button", { name: "Criar #vendas" }));
    await settle(6);
    expect(created(state)).toEqual([{ name: "vendas", visibility: "public", categoryId: category?.id }]);
    expect(state.channels.find((c) => c.name === "vendas")?.categoryId).toBe(category?.id ?? "");
  });

  test("from a category's '+', it starts chosen and the channel lands there", async () => {
    const seeded = seedState();
    seeded.channelCategories = [{ id: "cat-produto", name: "Produto", position: 0 }];
    for (const c of seeded.channels) if (c.id === ENG_ID) c.categoryId = "cat-produto";
    const state = await go(seeded);
    await click(within(nav()).getByRole("button", { name: "Novo canal em Produto" }));
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    expect(within(dialog).getByRole("combobox", { name: "Categoria" }).textContent).toContain("Produto");
    await type(within(dialog).getByLabelText("Nome"), "roadmap");
    await click(within(dialog).getByRole("button", { name: "Criar #roadmap" }));
    await settle(6);
    expect(created(state)).toEqual([{ name: "roadmap", visibility: "public", categoryId: "cat-produto" }]);
  });
});

describe("what a dialog makes or renames is never taken by itself, while it is sent or closes", () => {
  const click = (el: Element) => act(async () => fireEvent.click(el));
  const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
  const openMenu = async (trigger: HTMLElement) => {
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.keyUp(trigger, { key: "Enter" });
    });
    await settle(2);
    return screen().getByRole("menu");
  };
  /** The sidebar under an open dialog: out of the accessibility tree then, with no names to find its rows by. */
  const sidebar = () => document.querySelector("nav.sidebar") as HTMLElement;
  const categoryNames = () =>
    [...sidebar().querySelectorAll(".sidebar__section-toggle .sidebar__label")].map((l) => l.textContent);
  /** The dialog, closed and still on screen (`exitsLast`), then its exit ended. */
  const closing = async (dialog: HTMLElement) => {
    expect([dialog.isConnected, dialog.getAttribute("data-state")]).toEqual([true, "closed"]);
    expect(dialog.textContent).not.toContain("Já existe");
    await endExit(dialog);
    expect(dialog.isConnected).toBe(false);
  };

  test("Criar canal: the channel being made, in the list before Criar is answered", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // A new list on each read, as the server sends: the fake's own array would read as unchanged.
    const readChannels = api.chat.channels;
    api.chat.channels = async (...args) => [...(await readChannels(...args))];
    const make = api.chat.createChannel;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    api.chat.createChannel = async (...args) => {
      const made = await make(...args);
      await answered;
      return made;
    };
    const { sockets, router } = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api });
    await settle(8);
    await act(async () => sockets.last().open());
    await settle(2);
    exitsLast();
    const plus = within(nav()).getByRole("button", { name: "Novo canal ou categoria" });
    await click(within(await openMenu(plus)).getByRole("menuitem", { name: "Novo canal" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    await type(within(dialog).getByLabelText("Nome"), "vendas");
    await click(within(dialog).getByRole("button", { name: "Criar #vendas" }));
    // Made on the server, which says so on the socket before it answers.
    await act(async () => sockets.last().push({ type: "event", scope: "org", event: { type: "channels.changed" } }));
    await settle(6);
    expect(sidebar().querySelector('a.sidebar__item[title="#vendas"]')).not.toBeNull();
    expect(dialog.textContent).not.toContain("Já existe");
    await act(async () => answer());
    await settle(6);
    await closing(dialog);
    const made = state.channels.find((c) => c.name === "vendas");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${made?.id}`);
  });

  test("Nova categoria: the category being made, in the list before Criar is answered", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // After Criar, the categories are read again before the channels.
    const readChannels = api.chat.channels;
    let channelsRead: Promise<void> | null = null;
    let answer = () => {};
    api.chat.channels = async (...args) => {
      await channelsRead;
      return readChannels(...args);
    };
    await go(state, { api });
    exitsLast();
    const plus = within(nav()).getByRole("button", { name: "Novo canal ou categoria" });
    await click(within(await openMenu(plus)).getByRole("menuitem", { name: "Nova categoria" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Nova categoria" });
    await type(within(dialog).getByLabelText("Nome"), "Produto");
    channelsRead = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await click(within(dialog).getByRole("button", { name: "Criar categoria" }));
    await settle(6);
    expect(categoryNames()).toContain("Produto");
    expect(dialog.textContent).not.toContain("Já existe");
    await act(async () => answer());
    await settle(6);
    await closing(dialog);
  });

  test("Mover › Criar: the name it opened with stays while the category is made", async () => {
    const seeded = seedState();
    seeded.channelCategories = [{ id: "cat-engenharia", name: "Engenharia", position: 0 }];
    const api = createFakeApi(seeded);
    const readChannels = api.chat.channels;
    let channelsRead: Promise<void> | null = null;
    let answer = () => {};
    api.chat.channels = async (...args) => {
      await channelsRead;
      return readChannels(...args);
    };
    await go(seeded, { api });
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 });
    await act(async () => void row("general").dispatchEvent(menu));
    await settle(2);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Mover para…" }));
    await settle(2);
    const move = screen().getByRole("dialog", { name: "Mover #general" });
    await type(within(move).getByRole("searchbox", { name: "Buscar categoria" }), "Produto");
    await click(within(move).getByRole("button", { name: "Criar “Produto”" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Nova categoria" });
    const field = within(dialog).getByLabelText("Nome") as HTMLInputElement;
    expect(field.value).toBe("Produto");
    exitsLast();
    channelsRead = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await click(within(dialog).getByRole("button", { name: "Criar categoria" }));
    await settle(6);
    expect(categoryNames()).toContain("Produto");
    expect(field.value).toBe("Produto");
    expect(dialog.textContent).not.toContain("Já existe");
    await act(async () => answer());
    await settle(6);
    await closing(dialog);
    const back = screen().getByRole("dialog", { name: "Mover #general" });
    expect(within(back).getByRole("button", { name: "Mover para Produto" })).toBeTruthy();
  });

  test("Renomear categoria: its new name in the list once saved", async () => {
    const seeded = seedState();
    seeded.channelCategories = [{ id: "cat-produto", name: "Produto", position: 0 }];
    await go(seeded);
    exitsLast();
    const options = within(nav()).getByRole("button", { name: "Opções de Produto" });
    await click(within(await openMenu(options)).getByRole("menuitem", { name: "Renomear" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Renomear categoria" });
    await type(within(dialog).getByLabelText("Nome"), "Produtos");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(categoryNames()).toContain("Produtos");
    await closing(dialog);
  });
});

const ENGINEERING = "00000000-0000-4000-8000-0000000000f1";
/** Acme with the category Engenharia: #eng, #design and #alerts (2 unread) in it; #general in none. */
function withCategory() {
  const state = seedState();
  state.channelCategories = [{ id: ENGINEERING, name: "Engenharia", position: 0 }];
  const eng = state.channels.find((c) => c.id === ENG_ID);
  if (!eng) throw new Error("no #eng");
  eng.categoryId = ENGINEERING;
  state.channels.push(
    { ...eng, id: "00000000-0000-4000-8000-0000000000c3", name: "design" },
    { ...eng, id: "00000000-0000-4000-8000-0000000000c4", name: "alerts", unreadCount: 2 },
  );
  return state;
}
/** The app's layout stylesheet in the page: what a closed category hides, and how far in its rows sit. */
const withLayout = async () => {
  const sheet = document.createElement("style");
  sheet.dataset.layout = "";
  sheet.textContent = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
  document.head.append(sheet);
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const category = (name: string) => {
  const toggle = within(nav()).getByRole("button", { name });
  const root = toggle.closest(".sidebar__section") as HTMLElement;
  return { toggle, root, body: root.querySelector(".sidebar__section-body") as HTMLElement };
};
/** A channel's row, in sight or not (a hidden one has no accessible name to find it by). */
const channel = (name: string) => {
  const row = nav().querySelector(`a.sidebar__item[title="#${name}"]`);
  if (!row) throw new Error(`no #${name} in the sidebar`);
  return row;
};
/** In sight: neither it nor a box around it (a row with its hover buttons, a section) is hidden. */
const shown = (el: Element) => {
  for (let e: Element | null = el; e; e = e.parentElement)
    if (window.getComputedStyle(e).display === "none") return false;
  return true;
};

describe("a category in the sidebar (ADR 0080)", () => {
  test("its channels line up with the ones in none, under its header; a channel in none stays where it was", async () => {
    await withLayout();
    await go(withCategory());
    const { body } = category("Engenharia");
    expect(body.contains(channel("eng"))).toBe(true);
    // Under the Canais part, not in the category.
    const loose = category("Canais").body;
    expect(loose.contains(channel("general"))).toBe(true);
    expect(body.contains(channel("general"))).toBe(false);
    // No step in: a channel's # sits in its header's chevron column, as the ones in no category (sidebar-css.test.ts).
    expect(window.getComputedStyle(body).paddingLeft).toBe(window.getComputedStyle(loose).paddingLeft);
    expect(window.getComputedStyle(body).paddingLeft).not.toBe("19px");
  });

  test("closed, it hides its channels but the unread ones, and its header says it is closed", async () => {
    await withLayout();
    await go(withCategory());
    const { toggle, body } = category("Engenharia");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(body.id);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(shown(channel("eng"))).toBe(false);
    expect(shown(channel("design"))).toBe(false);
    expect(shown(channel("alerts"))).toBe(true);
    expect(shown(channel("general"))).toBe(true);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(shown(channel("eng"))).toBe(true);
    expect(shown(channel("design"))).toBe(true);
  });

  test("closed, it keeps the channel you are in", async () => {
    await withLayout();
    await go(withCategory(), { channel: ENG_ID });
    await click(category("Engenharia").toggle);
    expect(shown(channel("eng"))).toBe(true);
    expect(shown(channel("design"))).toBe(false);
  });

  test("it stays closed after a reload, for this person in this workspace", async () => {
    await go(withCategory());
    await click(category("Engenharia").toggle);
    expect(JSON.parse(localStorage.getItem(`agentes.sidebar.sections.u-walter.${ORG_ID}`) ?? "[]")).toEqual([
      `category:${ENGINEERING}`,
    ]);
    cleanup();
    await go(withCategory());
    expect(category("Engenharia").toggle.getAttribute("aria-expanded")).toBe("false");
    // João, signed in on the same browser, has his own.
    cleanup();
    const joao = withCategory();
    if (joao.me) joao.me.user = { ...joao.me.user, id: "u-joao", name: "João" };
    await go(joao);
    expect(category("Engenharia").toggle.getAttribute("aria-expanded")).toBe("true");
  });

  test("another workspace has its own, also when you switch to it with the sidebar on screen", async () => {
    const BETA_ID = "00000000-0000-4000-8000-0000000000b2";
    const state = seedState();
    state.me?.organizations.push({ id: BETA_ID, name: "Beta", role: "owner" });
    const { router } = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const saved = (orgId: string) =>
      JSON.parse(localStorage.getItem(`agentes.sidebar.sections.u-walter.${orgId}`) ?? "[]");
    const open = (name: string) => category(name).toggle.getAttribute("aria-expanded");
    const switchTo = async (orgId: string) => {
      await act(() => router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId, channelId: GENERAL_ID } }));
      await settle(8);
    };
    const sidebar = nav();
    await click(category("Mensagens diretas").toggle);
    expect(saved(ORG_ID)).toEqual(["people"]);

    await switchTo(BETA_ID);
    expect(nav()).toBe(sidebar);
    expect(open("Mensagens diretas")).toBe("true");
    await click(category("Canais").toggle);
    expect(saved(BETA_ID)).toEqual(["channels"]);
    expect(saved(ORG_ID)).toEqual(["people"]);

    await switchTo(ORG_ID);
    expect(open("Mensagens diretas")).toBe("false");
    expect(open("Canais")).toBe("true");
  });
});

describe("dragging a channel into, out of and between categories (ADR 0080)", () => {
  const DESIGN_ID = "00000000-0000-4000-8000-0000000000c3";
  const head = (name: string) => category(name).root.querySelector(".sidebar__section-head") as HTMLElement;
  /** Drags `from` over `to` (no row: the part's own space) and drops it; the mark its header got. */
  const dragInto = async (from: Element, to: Element, header: () => Element) => {
    await act(async () => fireEvent.dragStart(from, { dataTransfer }));
    await act(async () => fireEvent.dragOver(to, { dataTransfer }));
    const mark = header().getAttribute("data-drop");
    await act(async () => fireEvent.drop(to, { dataTransfer }));
    await settle(3);
    return mark;
  };

  test("a channel in none goes in: on the category's header, between its rows at that place, or on its empty end", async () => {
    const state = await go(withCategory());
    expect(await dragOnto(channel("general"), head("Engenharia"), "top")).toBe("into");
    expect(places(state)).toEqual([[GENERAL_ID, { categoryId: ENGINEERING }]]);
    expect(category("Engenharia").body.contains(channel("general"))).toBe(true);
    cleanup();

    const again = await go(withCategory());
    expect(await dragOnto(channel("general"), channel("design"), "top")).toBe("before");
    expect(places(again)).toEqual([[GENERAL_ID, { categoryId: ENGINEERING, beforeChannelId: DESIGN_ID }]]);
    cleanup();

    // Not on a row: the category's own space (past its last row, a row's hover buttons) takes it too, at its end.
    const third = await go(withCategory());
    const body = category("Engenharia").body;
    expect(await dragInto(channel("general"), body, () => head("Engenharia"))).toBe("into");
    expect(places(third)).toEqual([[GENERAL_ID, { categoryId: ENGINEERING }]]);
    expect(head("Engenharia").getAttribute("data-drop")).toBeNull();
  });

  test("out to Canais it leaves its category; let go on its own row, it stays where it was", async () => {
    const state = await go(withCategory());
    expect(await dragInto(channel("eng"), category("Canais").body, () => category("Canais").root)).toBe("into");
    expect(places(state)).toEqual([[ENG_ID, { categoryId: null }]]);
    expect(category("Canais").body.contains(channel("eng"))).toBe(true);

    // A short drag that ends on the row it started from sends nothing (not "to the end of the part around it").
    await act(async () => fireEvent.dragStart(channel("general"), { dataTransfer }));
    const own = createEvent.dragOver(channel("general"), { dataTransfer });
    await act(async () => fireEvent(channel("general"), own));
    expect(own.defaultPrevented).toBe(false);
    expect(category("Canais").root.getAttribute("data-drop")).toBeNull();
    await act(async () => fireEvent.drop(channel("general"), { dataTransfer }));
    await settle(3);
    expect(places(state)).toHaveLength(1);
  });

  test("a member moves only the channels they created, into a category on its empty end; the categories stay put", async () => {
    const state = withCategory();
    const me = state.me;
    if (me?.organizations[0]) me.organizations[0].role = "member";
    for (const c of state.channels) c.createdByUserId = c.id === GENERAL_ID ? me?.user.id : "u-joao";
    await go(state);
    // The categories are the workspace's: only who manages channels drags them.
    expect(head("Engenharia").getAttribute("draggable")).toBe("false");
    expect(channel("eng").getAttribute("draggable")).toBe("false");
    expect(channel("general").getAttribute("draggable")).toBe("true");
    expect(await dragInto(channel("general"), category("Engenharia").body, () => head("Engenharia"))).toBe("into");
    expect(places(state)).toEqual([[GENERAL_ID, { categoryId: ENGINEERING }]]);
  });

  test("into the part it's already in, a channel stays put: its category's header or body, Canais' body for one in none", async () => {
    const state = await go(withCategory());
    expect(await dragOnto(channel("eng"), head("Engenharia"), "top")).toBeNull();
    expect(await dragInto(channel("eng"), category("Engenharia").body, () => head("Engenharia"))).toBeNull();
    expect(await dragInto(channel("general"), category("Canais").body, () => category("Canais").root)).toBeNull();
    expect(places(state)).toEqual([]);
  });
});
