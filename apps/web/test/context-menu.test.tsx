import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { messageLink } from "@/components/MessageMore";
import { type MenuEntry, setMenuLook, tidy, toSystem } from "@/lib/context-menu";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * The desktop app's right click: one list of choices per thing, drawn as our menu
 * (the default) or the system's (`context_menu` in menus.rs); the browser keeps its own menu.
 */

const win = () =>
  window as {
    __agentesDesktop?: unknown;
    __TAURI_INTERNALS__?: unknown;
    __agentesContextMenu?: (token: string, id: string) => void;
    __agentesMenu?: (action: string) => void;
  };
afterEach(() => {
  cleanup();
  setMenuLook("ours");
  delete win().__agentesDesktop;
  delete win().__TAURI_INTERNALS__;
});

/** The app around the site: records what the system's menu was asked to draw. */
function inTheApp() {
  const drawn: { token: number; items: unknown[] }[] = [];
  win().__agentesDesktop = { version: "0.6.0" };
  win().__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { token: number; items: unknown[] }) => {
      if (cmd === "context_menu") drawn.push(args);
      if (cmd === "this_mac") return { orgs: [] };
      return {};
    },
  };
  return drawn;
}

const copied: string[] = [];
// After the DOM is attached (its own navigator).
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
});

const messageOf = (text: string) => {
  const el = screen()
    .getAllByRole("article")
    .findLast((a) => a.textContent?.includes(text));
  if (!el) throw new Error(`no message with ${text}`);
  return el;
};

describe("one list, two looks", () => {
  const run = () => {};
  const entries: MenuEntry[] = [
    { kind: "separator" },
    { kind: "reactions", label: "Reagir", emojis: ["👍", "🎉"], pick: () => {} },
    { kind: "item", id: "copy", label: "Copiar texto", run },
    { kind: "separator" },
    { kind: "separator" },
    { kind: "item", id: "wiki", label: "Salvar na wiki", disabled: true, run },
    { kind: "separator" },
  ];

  test("no separator first, last or twice", () => {
    expect(tidy(entries).map((e) => e.kind)).toEqual(["reactions", "item", "separator", "item"]);
  });

  test("the system's menu: reactions become a submenu, each choice keeps what it runs", () => {
    const { items, runs } = toSystem(tidy(entries));
    expect(items).toEqual([
      {
        type: "submenu",
        label: "Reagir",
        items: [
          { type: "item", id: "react-0", label: "👍" },
          { type: "item", id: "react-1", label: "🎉" },
        ],
      },
      { type: "separator" },
      { type: "item", id: "copy", label: "Copiar texto" },
      { type: "separator" },
      { type: "item", id: "wiki", label: "Salvar na wiki", disabled: true },
    ]);
    expect([...runs.keys()]).toEqual(["react-0", "react-1", "copy", "wiki"]);
  });
});

describe("right click on a message", () => {
  test("in the app: our menu with reactions, Responder, Copiar texto, Copiar link, Fixar, Salvar na wiki", async () => {
    inTheApp();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const message = messageOf("o login está devolvendo 401");
    await act(async () => fireEvent.contextMenu(message, { clientX: 40, clientY: 60 }));
    await settle(2);
    const menu = screen().getByRole("menu", { name: "Ações" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.getAttribute("aria-label") ?? i.textContent),
    ).toEqual([
      "👍",
      "🎉",
      "👀",
      "✅",
      "❤️",
      "Adicionar reação",
      "Responder",
      "Copiar texto",
      "Copiar link da mensagem",
      "Fixar mensagem",
      "Salvar na wiki",
    ]);

    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Copiar link da mensagem" })));
    await settle(2);
    expect(copied.at(-1)).toBe(messageLink(window.location.origin, ORG_ID, { id: "m-1", channelId: ENG_ID }));
    expect(screen().queryByRole("menu", { name: "Ações" })).toBeNull();
  });

  test("the last reaction cell opens every emoji for that message, from the right click and from '…'", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const message = messageOf("o login está devolvendo 401");
    await act(async () => fireEvent.contextMenu(message, { clientX: 40, clientY: 60 }));
    await settle(2);
    const menu = screen().getByRole("menu", { name: "Ações" });
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: "Adicionar reação" })));
    await settle(4);
    expect(screen().queryByRole("menu", { name: "Ações" })).toBeNull();
    expect(screen().getByRole("dialog", { name: "Emojis" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Emojis" })).toBeNull();

    const more = within(message).getAllByRole("button", { name: "Mais ações da mensagem" }).at(-1);
    if (!more) throw new Error("no … button");
    await act(async () => fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: "mouse" }));
    await settle(2);
    const dropdown = screen().getByRole("menu");
    await act(async () => fireEvent.click(within(dropdown).getByRole("menuitem", { name: "Adicionar reação" })));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Emojis" })).toBeTruthy();
  });

  test("the system's look: the app draws it, and the choice comes back into the page", async () => {
    const drawn = inTheApp();
    setMenuLook("system");
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    await act(async () => fireEvent.contextMenu(messageOf("o login está devolvendo 401")));
    await settle(2);
    expect(screen().queryByRole("menu", { name: "Ações" })).toBeNull();
    const asked = drawn.at(-1);
    expect(asked?.items).toContainEqual({ type: "item", id: "copy-text", label: "Copiar texto" });
    await act(async () => win().__agentesContextMenu?.(String(asked?.token), "copy-text"));
    await settle(2);
    expect(copied.at(-1)).toContain("o login está devolvendo 401");
    // An older menu's answer is ignored.
    const before = copied.length;
    await act(async () => win().__agentesContextMenu?.(String((asked?.token ?? 0) - 1), "copy-text"));
    expect(copied.length).toBe(before);
  });

  test("in the browser: a message gets our menu too; empty space keeps the browser's", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const page = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => void document.body.dispatchEvent(page));
    expect(page.defaultPrevented).toBe(false);
    expect(screen().queryByRole("menu")).toBeNull();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
    await act(async () => void messageOf("o login está devolvendo 401").dispatchEvent(event));
    await settle(2);
    expect(event.defaultPrevented).toBe(true);
    const menu = screen().getByRole("menu", { name: "Ações" });
    expect(within(menu).getByRole("menuitem", { name: "Fixar mensagem" })).toBeTruthy();
  });
});

describe("the Mac's menu bar", () => {
  test("Ir → Tarefas goes there", async () => {
    inTheApp();
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    await act(async () => win().__agentesMenu?.("goTasks"));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/issues`);
  });
});
