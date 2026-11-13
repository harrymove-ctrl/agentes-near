import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { createFakeApi, GENERAL_ID, ORG_ID } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** A phone: only the compact query matches (the rest goes to the real `matchMedia`). */
let restore: (() => void) | null = null;
function onPhone() {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) =>
    query === COMPACT_QUERY
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as unknown as MediaQueryList)
      : real(query)) as typeof window.matchMedia;
  restore = () => {
    window.matchMedia = real;
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  restore?.();
  restore = null;
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const go = async (path: string) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi() });
  await settle(6);
  return r;
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const menuButton = () => screen().getAllByRole("button", { name: "Abrir menu" })[0] as HTMLElement;

describe("the sidebar on a phone (drawer)", () => {
  test("wide screens have no menu button: the sidebar is always there", async () => {
    await go(`c/${GENERAL_ID}`);
    expect(screen().queryByRole("button", { name: "Abrir menu" })).toBeNull();
    expect(nav().getAttribute("data-open")).toBe("false");
  });

  test("the menu button in the channel header opens it; Esc closes it and focus goes back", async () => {
    onPhone();
    await go(`c/${GENERAL_ID}`);
    const header = document.querySelector(".channel__header") as HTMLElement;
    const button = within(header).getByRole("button", { name: "Abrir menu" });
    expect(button.getAttribute("aria-controls")).toBe(nav().id);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    button.focus();
    await click(button);
    expect(nav().getAttribute("data-open")).toBe("true");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement === nav()).toBe(true);
    // The page behind can't be reached while it's open.
    // The work area (an offline-computer notice and the page) is inert as a whole.
    const main = document.querySelector(".shell__work") as HTMLElement;
    expect(main.inert).toBe(true);

    await act(async () => {
      fireEvent.keyDown(nav(), { key: "Escape" });
    });
    expect(nav().getAttribute("data-open")).toBe("false");
    expect(main.inert).toBe(false);
    expect(document.activeElement === button).toBe(true);
  });

  test("a tap on the dimmed page closes it", async () => {
    onPhone();
    await go(`c/${GENERAL_ID}`);
    await click(menuButton());
    expect(nav().getAttribute("data-open")).toBe("true");
    await click(screen().getByRole("button", { name: "Fechar menu" }));
    expect(nav().getAttribute("data-open")).toBe("false");
    expect(screen().queryByRole("button", { name: "Fechar menu" })).toBeNull();
  });

  test("following a link closes it, and the new page has the menu in its top bar", async () => {
    onPhone();
    const { router } = await go(`c/${GENERAL_ID}`);
    await click(menuButton());
    // Docs starts closed: Drive is the icon on its header.
    await click(within(nav()).getAllByRole("link", { name: "Drive" })[0] as HTMLElement);
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/drive`);
    expect(nav().getAttribute("data-open")).toBe("false");
    // Not a chat page: the shell's bar carries the menu, the workspace and search.
    const bar = document.querySelector(".shell__bar") as HTMLElement;
    expect(within(bar).getByRole("button", { name: "Abrir menu" })).toBeTruthy();
    expect(bar.textContent).toContain("Acme");
  });

  test("a link to the page already open closes it too", async () => {
    onPhone();
    await go("drive");
    await click(menuButton());
    expect(nav().getAttribute("data-open")).toBe("true");
    // Docs starts closed: Drive is the icon on its header.
    await click(within(nav()).getAllByRole("link", { name: "Drive" })[0] as HTMLElement);
    await settle();
    expect(nav().getAttribute("data-open")).toBe("false");
  });
});
