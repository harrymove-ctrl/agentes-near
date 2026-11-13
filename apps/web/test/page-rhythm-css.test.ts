import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");
const read = (path: string) => Bun.file(join(SRC, path)).text();
const last = (css: string, selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a DM's name wraps whole on a phone, its pill 8 after it and under it when both don't fit", async () => {
  const phone = atRule(await read("responsive.css"), "@media (max-width: 760px)");
  expect(last(phone, ".dm-who .channel__title", "display")).toBe("flex");
  expect(last(phone, ".dm-who .channel__title", "flex-wrap")).toBe("wrap");
  expect(last(phone, ".dm-who .channel__title", "gap")).toBe("var(--space-1) var(--space-2)");
  // Never cut: a header's name and its line wrap, the header's glyphs go under them.
  for (const selector of [".channel__title", ".dm-who .channel__title>.channel__name", ".channel__topic"]) {
    expect([selector, last(phone, selector, "text-overflow")]).toEqual([selector, undefined]);
    expect([selector, last(phone, selector, "white-space")]).toEqual([selector, undefined]);
  }
  expect(last(phone, ".channel__title", "overflow-wrap")).toBe("anywhere");
  expect(last(phone, ".dm-who .channel__title>.ac-chip", "flex")).toBe("none");
  // On a phone the header's search is its icon, in a DM's header as in a channel's: both hold it with their glyphs.
  const header = atRule(await read("components/channel-header.css"), "@media (max-width: 760px)");
  expect(last(header, ".channel__acts>.channel__search", "display")).toBe("none");
  // A tag on a first line that rises keeps the line where it is, as the kit's pills do.
  expect(last(topLevel(await read("layout.css")), ".ac-captop:has(.agp-tag)", "margin-block-start")).toBe("0");
});

test("the agent page's overview takes all the width it has, and the computer's line wraps whole", async () => {
  for (const sheet of ["layout.css", "responsive.css"])
    expect(declarations(await read(sheet), ".agp-overview").filter(([p]) => p === "max-width")).toEqual([]);
  const computer = await read("components/computer/computer.css");
  const line = declarations(computer, ".cmp-entry__line>span:last-child");
  expect(line.filter(([p]) => p === "text-overflow" || p === "white-space")).toEqual([]);
  expect(last(computer, ".cmp-entry__line>span:last-child", "overflow-wrap")).toBe("anywhere");
  // Its icon stays on the first line's capitals when the words wrap (`.ac-iconline`).
  expect(last(computer, ".cmp-entry__line", "align-items")).toBe("flex-start");
});

test("every page starts at the page's top and side: lists, Settings, the wiki, the calendar, the agent page", async () => {
  const layout = topLevel(await read("layout.css"));
  expect(last(layout, ".page", "padding")).toBe("var(--page-top) var(--page-x) 32px");
  // Header, toolbar and content 16 apart on every page, its columns included.
  expect(last(layout, ".page", "gap")).toBe("var(--space-4)");
  expect(declarations(layout, ".page--list").filter(([p]) => p === "gap")).toEqual([]);
  expect(declarations(layout, ".page--tight")).toEqual([]);
  for (const [sheet, column] of [
    ["pages/approvals.css", ".ap__main"],
    ["pages/issues.css", ".issues__main"],
    ["pages/threads.css", ".threads__main"],
    ["pages/routines.css", ".routines__main"],
  ] as const)
    expect([column, last(topLevel(await read(sheet)), column, "gap")]).toEqual([column, "var(--space-4)"]);
  for (const [sheet, root] of [
    ["pages/task-manager.css", ".tm"],
    ["pages/team.css", ".page.team"],
  ] as const)
    expect([root, declarations(await read(sheet), root).filter(([p]) => p === "gap")]).toEqual([root, []]);
  expect(last(layout, ".settings", "padding")).toBe("var(--page-top) var(--page-x) 96px");
  expect(last(layout, ".settings__body", "gap")).toBe("var(--space-4)");
  const split = atRule(await read("layout.css"), "@media (min-width: 941px) and (min-height: 560px)");
  expect(last(split, ".settings", "padding")).toBe("0 0 0 max(var(--page-x), calc(50% - 532px))");
  expect(last(split, ".settings__nav", "padding")).toBe("var(--page-top) 6px 24px");
  // Its 12px room on the left is `--bleed`, which a strip that scrolls sideways in it runs out over.
  expect(last(split, ".settings__body", "--bleed")).toBe("12px");
  expect(last(split, ".settings__body", "padding")).toBe(
    "var(--page-top) max(var(--page-x), calc(100% - 1064px)) 96px var(--bleed)",
  );
  const wiki = await read("pages/wiki.css");
  expect(last(topLevel(wiki), ".wiki__center", "padding")).toBe("var(--page-top) var(--page-x) 96px");
  // The wiki's bar starts on the page's top and sticks there, its face reaching over the room above it.
  expect(last(topLevel(wiki), ".wiki-top", "top")).toBe("0");
  expect(declarations(wiki, ".wiki-top").filter(([p]) => p === "margin-top")).toEqual([]);
  expect(last(topLevel(wiki), ".wiki-top::before", "inset")).toBe("calc(-1 * var(--page-top)) 0 0");
  expect(declarations(wiki, ".wiki-top").filter(([p]) => p === "background")).toEqual([]);
  const calendar = await read("pages/calendar.css");
  expect(last(topLevel(calendar), ".cal-page__header", "padding")).toBe("var(--page-top) var(--page-x) 16px");
  expect(last(topLevel(calendar), ".cal-page__body", "padding")).toBe("0 var(--page-x) 16px");
  expect(last(layout, ".agp", "--agp-gutter")).toBe("var(--page-x)");
  // No page root keeps a top or side room of its own, at any width.
  const roots = [".page", ".settings", ".wiki__center", ".cal-page__header", ".cal-page__body"];
  for (const sheet of ["layout.css", "responsive.css", "pages/wiki.css", "pages/calendar.css"]) {
    const css = await read(sheet);
    for (const root of roots)
      for (const [p, v] of declarations(css, root))
        if (/^padding(-top|-left|-right|-inline)?$/.test(p))
          expect([sheet, root, p, v]).toEqual([sheet, root, p, expect.stringMatching(/var\(--page-(top|x)\)/)]);
  }
  // A board's crumb starts on the page's side, not 4px out of it.
  expect(declarations(await read("pages/dashboards.css"), ".db-crumb").filter(([p]) => p === "margin-left")).toEqual(
    [],
  );
});

test("your name and @ wrap whole: on the account menu's top they go on under your face, in the sidebar never cut", async () => {
  const layout = topLevel(await read("layout.css"));
  // The face floats: the words beside it go on under it at the menu's width, a long @ breaking anywhere.
  expect(last(layout, ".profile-menu__head", "display")).toBe("flow-root");
  expect(last(layout, ".profile-menu__head", "overflow-wrap")).toBe("anywhere");
  expect(last(layout, ".profile-menu__head>.ac-face-edit", "float")).toBe("left");
  expect(last(layout, ".profile-menu__head>.list-col", "display")).toBe("block");
  // The account row at a team's foot and a personal workspace's top row: the name wraps, no ellipsis.
  const cut = declarations(layout, ".sidebar__user-name").filter(([p]) => p === "text-overflow" || p === "white-space");
  expect(cut).toEqual([]);
  expect(last(layout, ".sidebar__user-name", "overflow-wrap")).toBe("anywhere");
  expect(last(layout, ".sidebar__org-button--me .sidebar__org-name", "white-space")).toBe("normal");
  expect(last(layout, ".sidebar__org-button--me .sidebar__org-name", "overflow-wrap")).toBe("anywhere");
});
