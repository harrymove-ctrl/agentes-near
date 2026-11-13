import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render } from "@testing-library/react";
import { pageScrollReset } from "../src/lib/page-scroll";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

// Two settings sections in one route and a page of its own, each in the app's page column, routed like main.tsx.
async function app() {
  const root = createRootRoute({ component: Outlet });
  const page = () => (
    <main className="shell__main">
      <div className="settings page-split">
        {/* The nav's head and a section's head as the app's, so the geometry check measures a real page top. */}
        <nav className="settings__nav" data-scroll-restoration-id="settings-nav">
          <div className="settings__head">
            <h1 className="settings__title">Configurações</h1>
          </div>
        </nav>
        <div className="settings__body" data-scroll-restoration-id="settings-section">
          <header className="ac-pagehead">
            <h2 id="jev" className="ac-pagehead__title">
              Jev
            </h2>
          </header>
        </div>
      </div>
    </main>
  );
  const section = createRoute({ getParentRoute: () => root, path: "settings/$section", component: page });
  const drive = createRoute({
    getParentRoute: () => root,
    path: "drive",
    component: page,
    validateSearch: (s: Record<string, unknown>) => ({ open: typeof s.open === "string" ? s.open : undefined }),
  });
  // Another page whose own scrolling column sits where the settings section does (`main > div > div:nth-child(2)`).
  const wiki = createRoute({
    getParentRoute: () => root,
    path: "wiki",
    component: () => (
      <main className="shell__main">
        <div className="wiki">
          <aside className="wiki-nav" />
          <div className="wiki__center" />
        </div>
      </main>
    ),
  });
  const pageScroll = pageScrollReset();
  const router = createRouter({
    routeTree: root.addChildren([section, drive, wiki]),
    history: createMemoryHistory({ initialEntries: ["/settings/members"] }),
    scrollRestoration: true,
    scrollToTopSelectors: pageScroll.selectors,
  });
  router.subscribe("onBeforeLoad", pageScroll.track);
  render(<RouterProvider router={router} />);
  await settle();
  const column = () => document.querySelector("main.shell__main") as HTMLElement;
  const scrollOf = (el: () => HTMLElement) => (top: number) => {
    el().scrollTop = top;
    el().dispatchEvent(new Event("scroll"));
  };
  const scroll = scrollOf(column);
  const body = () => document.querySelector(".settings__body") as HTMLElement;
  const nav = () => document.querySelector(".settings__nav") as HTMLElement;
  const go = async (to: () => unknown) => {
    await act(async () => {
      await to();
    });
    await settle();
  };
  return { router, column, scroll, body, nav, scrollBody: scrollOf(body), scrollNav: scrollOf(nav), go };
}

describe("page column scroll", () => {
  test("another settings section starts at the top, and Back puts the first one back where it was", async () => {
    const { router, column, scroll, go } = await app();
    scroll(600);
    await go(() => router.history.push("/settings/agents"));
    expect(column().scrollTop).toBe(0);
    await go(() => router.history.back());
    expect(column().scrollTop).toBe(600);
  });

  test("where the nav and the section scroll on their own, another section starts at the top and the nav stays", async () => {
    const { router, body, nav, scrollBody, scrollNav, go } = await app();
    scrollNav(120);
    scrollBody(700);
    await go(() => router.history.push("/settings/agents"));
    expect(body().scrollTop).toBe(0);
    expect(nav().scrollTop).toBe(120);
    await go(() => router.history.back());
    expect(body().scrollTop).toBe(700);
  });

  test("a section's scroll never lands on another page's column in the same place", async () => {
    const { router, scrollBody, go } = await app();
    scrollBody(700);
    await go(() => router.history.push("/wiki"));
    expect((document.querySelector(".wiki__center") as HTMLElement).scrollTop).toBe(0);
  });

  test("another page starts at the top too", async () => {
    const { router, column, scroll, go } = await app();
    scroll(400);
    await go(() => router.history.push("/drive"));
    expect(column().scrollTop).toBe(0);
  });

  test("a change of search alone (a dialog over the list) keeps the place", async () => {
    const { router, column, scroll, go } = await app();
    await go(() => router.history.push("/drive"));
    scroll(300);
    await go(() => router.history.replace("/drive?open=x"));
    expect(column().scrollTop).toBe(300);
  });

  test("a link to an anchor in another section still lands on it", async () => {
    const { router, scroll, go } = await app();
    scroll(500);
    const landed: string[] = [];
    const into = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      landed.push(this.id);
    };
    try {
      await go(() => router.history.push("/settings/ai#jev"));
    } finally {
      HTMLElement.prototype.scrollIntoView = into;
    }
    expect(landed).toEqual(["jev"]);
  });
});

// The router hands a scrolled element's place to whatever sits at the same spot in the next page's DOM, unless the
// element names itself: every column of a split does, so its scroll stays on its own page.
describe("a split's columns name their scroll", () => {
  for (const path of ["approvals", "proposals", "settings/account"])
    test(path, async () => {
      await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(seedState()) });
      await settle(4);
      const columns = [...document.querySelectorAll(".page-split > *")];
      expect(columns.length).toBe(2);
      const ids = columns.map((c) => c.getAttribute("data-scroll-restoration-id"));
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(2);
    });
});
