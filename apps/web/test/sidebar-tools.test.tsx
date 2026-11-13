import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, createEvent, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type State = ReturnType<typeof seedState>;
const go = async (state: State = seedState()) => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
// The page behind an open dialog is hidden from roles: the sidebar by its element.
const nav = () => document.getElementById("app-nav") as HTMLElement;
const rows = () =>
  [...nav().querySelectorAll(".sidebar__tools > a.sidebar__item .sidebar__item-label")].map((l) => l.textContent);
/** The tools in the list on top, in order (More keeps the rest), under Início, which always heads it. */
const listed = () => rows().slice(1);
const openMore = async () => {
  await click(within(nav()).getByRole("button", { name: "Mais" }));
  return screen().getByRole("dialog", { name: "Mais" });
};
/** What More lists, each tool's name before its line on what it is for. */
const inMore = (more: HTMLElement) =>
  within(more)
    .getAllByRole("link")
    .map((l) => l.querySelector(".ac-menu__label")?.firstChild?.textContent);
const openSetup = async () => {
  await click(within(await openMore()).getByRole("button", { name: "Personalizar a barra lateral" }));
  return screen().getByRole("dialog", { name: "Personalizar a barra lateral" });
};
const choose = (dialog: HTMLElement, tool: string, place: string) =>
  click(within(within(dialog).getByRole("radiogroup", { name: tool })).getByRole("radio", { name: place }));
const chosen = (dialog: HTMLElement, tool: string) =>
  within(within(dialog).getByRole("radiogroup", { name: tool }))
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;
/** What each choice sent: the tool and its place (null: back on its default), or `{}` for Restaurar o padrão. */
const sent = (state: State) =>
  state.calls
    .filter((c) => c.method === "orgs.setSidebarItem" || c.method === "orgs.setSidebarItems")
    .map((c) => c.args.slice(1));
const noneWaiting = () => {
  const state = seedState();
  for (const a of state.approvals) a.status = "approved";
  for (const p of state.proposals) p.status = "accepted";
  return state;
};

describe("the bell", () => {
  test("in my card at the bottom, how many are unread in the sidebar's red count; no longer on top", async () => {
    await go(
      seedState({
        notifications: [notification({ id: "n1", kind: "mention" }), notification({ id: "n2", kind: "dm" })],
      }),
    );
    const bell = within(nav()).getByRole("link", { name: "2 notificações não lidas" });
    expect(bell.getAttribute("href")).toBe(`/org/${ORG_ID}/notifications`);
    expect(bell.closest(".sidebar__me")).toBeTruthy();
    expect(bell.textContent).toBe("2");
    // Unread calls on me: red like a mention's count, not a neutral count of things.
    expect(bell.querySelector(".ac-count")?.classList.contains("sidebar__unread")).toBe(true);
    expect(listed()).not.toContain("Notificações");
  });

  test("more than 99 unread: the count on the bell's corner says 99+, its name says how many", async () => {
    await go(
      seedState({ notifications: Array.from({ length: 120 }, (_, i) => notification({ id: `n${i}`, kind: "dm" })) }),
    );
    expect(within(nav()).getByRole("link", { name: "120 notificações não lidas" }).textContent).toBe("99+");
  });

  test("nothing unread: the bell alone, named Notificações", async () => {
    await go();
    const bell = within(nav()).getByRole("link", { name: "Notificações" });
    expect(bell.textContent).toBe("");
  });
});

describe("the tools on top", () => {
  test("each tool row shows its own grip, saying what it moves; a click on it opens nothing; Início carries the section's", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const before = router.state.location.pathname;
    const tasks = within(nav()).getByRole("link", { name: "Tarefas" });
    const grip = tasks.querySelector(".sidebar__tool-grip") as HTMLElement;
    expect(grip.getAttribute("title")).toBe("Arraste para mover Tarefas");
    await click(grip);
    expect(router.state.location.pathname).toBe(before);
    const home = within(nav()).getByRole("link", { name: "Início" });
    expect(home.querySelector(".sidebar__tool-grip")).toBeNull();
    expect(home.getAttribute("draggable")).toBeNull();
    const section = within(nav()).getByRole("button", { name: /seção Ferramentas/ });
    expect(section.getAttribute("title")).toBe("Arraste para mover a seção Ferramentas ou clique para ver as opções");
  });

  test("a row says its name on hover only in the rail, which hides it: beside the words it would just repeat them", async () => {
    await go();
    const row = (name: string) => within(nav()).getByRole("link", { name });
    expect(row("Tarefas").getAttribute("title")).toBeNull();
    expect(row("Início").getAttribute("title")).toBeNull();
    await click(within(nav()).getByRole("button", { name: "Minimizar barra lateral" }));
    expect(row("Tarefas").getAttribute("title")).toBe("Tarefas");
    expect(row("Início").getAttribute("title")).toBe("Início");
    await click(within(nav()).getByRole("button", { name: "Expandir barra lateral" }));
  });

  test("by default Threads, Tarefas, Drive and Equipe, Aprovações while some wait; the rest in More, then Personalizar", async () => {
    await go();
    expect(rows()[0]).toBe("Início");
    expect(rows()).not.toContain("Painéis");
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive", "Equipe"]);
    const more = await openMore();
    expect(inMore(more)).toEqual([
      "Propostas de melhoria",
      "Wiki",
      "Rotinas",
      "Calendário",
      "Painéis",
      "Gerenciador de tarefas",
    ]);
    expect(
      within(more)
        .getByRole("link", { name: /Painéis/ })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/dashboards`);
    expect(
      within(more)
        .getByRole("link", { name: /Gerenciador de tarefas/ })
        .getAttribute("href"),
    ).toBe(`/org/${ORG_ID}/task-manager`);
    expect(within(more).getByRole("button", { name: "Personalizar a barra lateral" })).toBeTruthy();
    cleanup();
    await go(noneWaiting());
    expect(listed()).toEqual(["Threads", "Tarefas", "Drive", "Equipe"]);
    expect(inMore(await openMore())).toEqual([
      "Aprovações",
      "Propostas de melhoria",
      "Wiki",
      "Rotinas",
      "Calendário",
      "Painéis",
      "Gerenciador de tarefas",
    ]);
  });

  test("Personalizar: each choice moves the tool at once and is saved for me; Restaurar o padrão undoes them", async () => {
    const state = await go(noneWaiting());
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
    expect(chosen(dialog, "Aprovações")).toBe("Quando tiver algo");
    // Only a tool with a count can wait until there's something.
    const offered = (tool: string) =>
      within(within(dialog).getByRole("radiogroup", { name: tool }))
        .getAllByRole("radio")
        .map((r) => r.textContent);
    expect(offered("Threads")).toEqual(["Sempre", "Em Mais", "Quando tiver algo"]);
    expect(offered("Wiki")).toEqual(["Sempre", "Em Mais"]);
    const reset = within(dialog).getByRole("button", { name: "Restaurar o padrão" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);

    await choose(dialog, "Wiki", "Sempre");
    expect(listed()).toEqual(["Threads", "Tarefas", "Wiki", "Drive", "Equipe"]);
    await choose(dialog, "Drive", "Em Mais");
    await choose(dialog, "Aprovações", "Sempre");
    // Threads with no mission waiting for me: in More until one does.
    await choose(dialog, "Threads", "Quando tiver algo");
    expect(listed()).toEqual(["Aprovações", "Tarefas", "Wiki", "Equipe"]);
    // One tool each time: what another device chose meanwhile stays.
    expect(sent(state)).toEqual([
      ["wiki", "always"],
      ["drive", "more"],
      ["approvals", "always"],
      ["threads", "auto"],
    ]);
    expect(state.sidebarItems).toEqual({ wiki: "always", drive: "more", approvals: "always", threads: "auto" });
    // Back on its default: the tool leaves the saved choices.
    await choose(dialog, "Threads", "Sempre");
    expect(sent(state).at(-1)).toEqual(["threads", null]);
    expect(state.sidebarItems).toEqual({ wiki: "always", drive: "more", approvals: "always" });

    expect(reset.disabled).toBe(false);
    await click(reset);
    expect(listed()).toEqual(["Threads", "Tarefas", "Drive", "Equipe"]);
    expect(sent(state).at(-1)).toEqual([{}]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });

  test("another device moved a tool after this one loaded: Personalizar shows it, and a choice here keeps it", async () => {
    const state = await go(noneWaiting());
    state.sidebarItems = { wiki: "always" };
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Sempre");
    expect(listed()).toEqual(["Threads", "Tarefas", "Wiki", "Drive", "Equipe"]);
    await choose(dialog, "Drive", "Em Mais");
    expect(state.sidebarItems).toEqual({ wiki: "always", drive: "more" });
    expect(listed()).toEqual(["Threads", "Tarefas", "Wiki", "Equipe"]);
  });

  test("Painéis and the task manager are tools like the rest: Sempre brings them into the list, each line one row", async () => {
    const state = await go(noneWaiting());
    const dialog = await openSetup();
    expect([...dialog.querySelectorAll(".sidebar-setup__name")].map((n) => n.textContent)).toEqual(
      expect.arrayContaining(["Painéis", "Gerenciador de tarefas"]),
    );
    expect(chosen(dialog, "Gerenciador de tarefas")).toBe("Em Mais");
    await choose(dialog, "Gerenciador de tarefas", "Sempre");
    await choose(dialog, "Painéis", "Sempre");
    expect(sent(state)).toContainEqual(["taskManager", "always"]);
    expect(sent(state)).toContainEqual(["dashboards", "always"]);
    expect(listed()).toEqual(expect.arrayContaining(["Painéis", "Gerenciador de tarefas"]));
    expect(dialog.querySelector(".ac-dialog__foot-note")).toBeNull();
  });

  test("the choices couldn't be read: a choice here moves only its tool, and the server's answer shows the rest", async () => {
    const state = noneWaiting();
    state.sidebarItems = { wiki: "always", routines: "always" };
    const api = createFakeApi(state);
    api.orgs.sidebarItems = async () => {
      throw new ApiError(500, "internal", "Não deu");
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
    await choose(dialog, "Drive", "Em Mais");
    expect(state.sidebarItems).toEqual({ wiki: "always", routines: "always", drive: "more" });
    expect(chosen(dialog, "Wiki")).toBe("Sempre");
    expect(listed()).toEqual(["Threads", "Tarefas", "Wiki", "Rotinas", "Equipe"]);
  });

  test("proposals waiting count on Aprovações, and on their own row once a person gives them one", async () => {
    const waiting = () => {
      const state = noneWaiting();
      for (const p of state.proposals) Object.assign(p, { status: "pending", canDecide: true });
      return state;
    };
    await go(waiting());
    const row = (name: string) =>
      [...nav().querySelectorAll(".sidebar__tools > a.sidebar__item")].find(
        (a) => a.querySelector(".sidebar__item-label")?.textContent === name,
      );
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive", "Equipe"]);
    expect(row("Aprovações")?.textContent).toContain("2");
    cleanup();
    await go({ ...waiting(), sidebarItems: { proposals: "auto" } });
    expect(listed()).toEqual(["Propostas de melhoria", "Threads", "Tarefas", "Drive", "Equipe"]);
    expect(row("Propostas de melhoria")?.textContent).toContain("2");
    expect(row("Propostas de melhoria")?.getAttribute("href")).toBe(`/org/${ORG_ID}/proposals`);
    cleanup();
    // A tab of Aprovações: its row is the one lit, with no second row for the page.
    await renderApp(`/org/${ORG_ID}/proposals`, { api: createFakeApi(waiting()) });
    await settle(10);
    expect(row("Aprovações")?.getAttribute("data-status")).toBe("active");
    expect(nav().querySelector(`.sidebar__more-active a[href$="/proposals"]`)).toBeNull();
  });

  test("the choices are the server's: the same sidebar on every device", async () => {
    await go(seedState({ sidebarItems: { drive: "more", routines: "always", approvals: "more" } }));
    expect(listed()).toEqual(["Threads", "Tarefas", "Rotinas", "Equipe"]);
    expect(inMore(await openMore())).toEqual([
      "Aprovações",
      "Propostas de melhoria",
      "Wiki",
      "Drive",
      "Calendário",
      "Painéis",
      "Gerenciador de tarefas",
    ]);
  });

  test("the server refuses: the tool goes back where it was", async () => {
    const state = seedState();
    state.sidebarItemsError = new ApiError(500, "internal", "Não deu");
    await go(state);
    const dialog = await openSetup();
    await choose(dialog, "Wiki", "Sempre");
    await settle(3);
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive", "Equipe"]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });

  test("two choices in a row, both refused: the sidebar ends as the server keeps it", async () => {
    const state = seedState();
    state.sidebarItemsError = new ApiError(500, "internal", "Não deu");
    const api = createFakeApi(state);
    const refuse = api.orgs.setSidebarItem;
    let release = () => {};
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    api.orgs.setSidebarItem = async (orgId, item, place) => {
      if (calls++ === 0) await first;
      return refuse(orgId, item, place);
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const dialog = await openSetup();
    await choose(dialog, "Wiki", "Sempre");
    // The second waits for the first, and shows at once.
    await choose(dialog, "Drive", "Em Mais");
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Wiki", "Equipe"]);
    await act(async () => release());
    await settle(6);
    expect(calls).toBe(2);
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive", "Equipe"]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });

  describe("one by one, in my order", () => {
    const toolOrder = (state: State) =>
      state.calls.filter((c) => c.method === "orgs.setSidebarToolOrder").map((c) => c.args[1]);
    const tool = (name: string) =>
      [...nav().querySelectorAll(".sidebar__tools > a.sidebar__item")].find(
        (a) => a.querySelector(".sidebar__item-label")?.textContent === name,
      ) as HTMLElement;
    const dataTransfer = { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "" };

    test("the server's order: the same list on every device", async () => {
      await go(
        seedState({
          sidebarToolOrder: ["drive", "issues", "approvals", "threads", "wiki", "routines", "calendar"],
        }),
      );
      expect(listed()).toEqual(["Drive", "Tarefas", "Aprovações", "Threads", "Equipe"]);
    });

    test("Alt+Shift+↑/↓ moves a tool past its neighbour in the list, over the ones in More, and saves it", async () => {
      const state = await go(seedState({ sidebarItems: { wiki: "more" } }));
      expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive", "Equipe"]);
      await act(async () => fireEvent.keyDown(tool("Drive"), { key: "ArrowUp", altKey: true, shiftKey: true }));
      await settle(3);
      // Wiki waits in More between Tarefas and Drive: one press is one step in the list.
      expect(listed()).toEqual(["Aprovações", "Threads", "Drive", "Tarefas", "Equipe"]);
      expect(toolOrder(state)).toEqual([
        [
          "approvals",
          "proposals",
          "threads",
          "drive",
          "issues",
          "wiki",
          "routines",
          "calendar",
          "team",
          "dashboards",
          "taskManager",
        ],
      ]);
      expect(tool("Drive").getAttribute("aria-keyshortcuts")).toBe("Alt+Shift+ArrowUp Alt+Shift+ArrowDown");
      // At the top, up does nothing; an arrow alone is the page's.
      await act(async () => fireEvent.keyDown(tool("Aprovações"), { key: "ArrowUp", altKey: true, shiftKey: true }));
      await act(async () => fireEvent.keyDown(tool("Threads"), { key: "ArrowDown" }));
      await settle(3);
      expect(toolOrder(state)).toHaveLength(1);
    });

    test("a tool dragged onto another goes before or after it, and saves it", async () => {
      const state = await go();
      await act(async () => fireEvent.dragStart(tool("Drive"), { dataTransfer }));
      const over = createEvent.dragOver(tool("Threads"), { dataTransfer });
      // happy-dom's DragEvent is a plain Event: no clientY from the init (a 0-tall box: 0 is its top half).
      Object.defineProperty(over, "clientY", { value: 0 });
      await act(async () => fireEvent(tool("Threads"), over));
      expect(tool("Threads").getAttribute("data-drop")).toBe("before");
      await act(async () => fireEvent.drop(tool("Threads"), { dataTransfer }));
      await settle(3);
      expect(listed()).toEqual(["Aprovações", "Drive", "Threads", "Tarefas", "Equipe"]);
      expect(tool("Threads").getAttribute("data-drop")).toBeNull();

      for (let i = 0; i < 2; i++) {
        await act(async () => fireEvent.keyDown(tool("Drive"), { key: "ArrowDown", altKey: true, shiftKey: true }));
        await settle(3);
      }
      expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive", "Equipe"]);
      // Moved down, its node is re-inserted: the focus comes back to it.
      expect(document.activeElement === tool("Drive")).toBe(true);
      // Wiki stays where the steps left it, in More: the order is Drive's own spot now, not the default's.
      expect(toolOrder(state).at(-1)).toEqual([
        "approvals",
        "proposals",
        "threads",
        "issues",
        "drive",
        "wiki",
        "routines",
        "calendar",
        "team",
        "dashboards",
        "taskManager",
      ]);
    });

    test("Personalizar lists the tools in my order, with Mover para cima / para baixo; Restaurar o padrão resets it", async () => {
      const state = await go(noneWaiting());
      const dialog = await openSetup();
      const names = () =>
        [...dialog.querySelectorAll(".sidebar-setup__row .sidebar-setup__name")].map((n) => n.textContent);
      expect(names().slice(0, 3)).toEqual(["Aprovações", "Propostas de melhoria", "Threads"]);
      expect(
        (within(dialog).getByRole("button", { name: "Mover para cima: Aprovações" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      await click(within(dialog).getByRole("button", { name: "Mover para cima: Drive" }));
      await click(within(dialog).getByRole("button", { name: "Mover para cima: Drive" }));
      expect(names().slice(0, 5)).toEqual(["Aprovações", "Propostas de melhoria", "Threads", "Drive", "Tarefas"]);
      // At the top its up arrow turns off: the focus goes to the row's down arrow, not out of the dialog.
      await click(within(dialog).getByRole("button", { name: "Mover para cima: Threads" }));
      await click(within(dialog).getByRole("button", { name: "Mover para cima: Threads" }));
      expect(document.activeElement === within(dialog).getByRole("button", { name: "Mover para baixo: Threads" })).toBe(
        true,
      );
      await click(within(dialog).getByRole("button", { name: "Mover para baixo: Threads" }));
      expect(listed()).toEqual(["Threads", "Drive", "Tarefas", "Equipe"]);
      const reset = within(dialog).getByRole("button", { name: "Restaurar o padrão" }) as HTMLButtonElement;
      expect(reset.disabled).toBe(false);
      await click(reset);
      expect(listed()).toEqual(["Threads", "Tarefas", "Drive", "Equipe"]);
      expect(toolOrder(state).at(-1)).toBeNull();
      expect(state.sidebarToolOrder).toBeUndefined();
    });
  });
});

describe("the sidebar's parts", () => {
  test("space, no lines, between the tools, the channels and the DMs; Canais and Mensagens diretas aren't categories", async () => {
    const state = seedState();
    state.channelCategories = [{ id: "00000000-0000-4000-8000-0000000000f1", name: "Engenharia", position: 0 }];
    for (const c of state.channels) if (c.id === ENG_ID) c.categoryId = "00000000-0000-4000-8000-0000000000f1";
    await go(state);
    const section = (name: string) =>
      within(nav()).getByRole("button", { name }).closest(".sidebar__section") as HTMLElement;
    expect(nav().querySelectorAll(".sidebar__divider")).toHaveLength(0);
    for (const part of ["Canais", "Mensagens diretas"]) {
      expect(section(part).closest(".sidebar__block")?.previousElementSibling?.className).toBe("sidebar__block");
      expect(section(part).classList.contains("sidebar__section--part")).toBe(true);
    }
    // The categories follow their part's channels, in its block.
    expect(section("Engenharia").closest(".sidebar__block")).toBe(section("Canais").closest(".sidebar__block"));
    expect(section("Engenharia").classList.contains("sidebar__section--part")).toBe(false);
  });
});
