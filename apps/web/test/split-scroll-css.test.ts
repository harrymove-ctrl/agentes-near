import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, builtCss, declarations } from "./built-css";

const WIDE = "@media (min-width: 941px) and (min-height: 560px)";
const NARROW = "@media (max-width: 940px)";
const SPLIT_PAGES = ["src/pages/ApprovalsPage.tsx", "src/pages/ProposalsPage.tsx", "src/pages/SettingsPage.tsx"];

test("a list beside what it opens: each column scrolls on its own, and under half the work area the columns keep its height and the page scrolls to them; narrower the columns stack, and shorter the page scrolls", async () => {
  const css = await builtCss("src/styles.css", "src/pages/approvals.css");
  const wide = atRule(css, WIDE);
  // The work area holding a split scrolls only up and down, and only when its columns run past the split; the height
  // reaches the split; each column scrolls.
  const main = declarations(wide, ".shell__main:has(.page-split)");
  expect(main).toContainEqual(["overflow", "hidden auto"]);
  expect(main).toContainEqual(["container-type", "size"]);
  expect(declarations(wide, ".shell__main .page-split")).toContainEqual(["min-height", "0"]);
  const column = declarations(wide, ".shell__main .page-split>*");
  expect(column).toContainEqual(["overflow-y", "auto"]);
  // A step: nothing while the split keeps half the work area (its height then), the area's height less 8px under it.
  const floor = column.find(([p]) => p === "min-height")?.[1] ?? "";
  expect(floor.replace(/\s+/g, "")).toMatch(/^min\(100cqh-var\(--space-2\),\(50cqh-100%\)\*(10000|1e4)\)$/);
  // Sideways a column keeps its scroll to itself; up and down it hands over to the page's.
  expect(column).toContainEqual(["overscroll-behavior-x", "contain"]);
  expect(column.filter(([p]) => p === "overscroll-behavior" || p === "overscroll-behavior-y")).toEqual([]);
  expect(declarations(wide, ".shell__main .page-split>*>*")).toContainEqual(["flex-shrink", "0"]);
  // The open request's column runs out over the page's side room to the work area's edge, by the page's own token.
  const review = declarations(wide, ".page-split>.ap-review");
  expect(review).toContainEqual(["margin-right", "calc(-1 * var(--page-x))"]);
  expect(review).toContainEqual(["padding-right", "var(--page-x)"]);
  // A short window (small or zoomed in) keeps the page's scroll: under the header the columns would have no room.
  expect(declarations(atRule(css, "@media (min-width: 941px)"), ".shell__main:has(.page-split)")).toEqual([]);
  // Below that width the pages stack their columns, so the page scrolls as one again.
  const narrow = atRule(css, NARROW);
  expect(declarations(narrow, ".ap-split")).toContainEqual(["grid-template-columns", "minmax(0,1fr)"]);
  expect(declarations(narrow, ".settings")).toContainEqual(["flex-direction", "column"]);
  // The old way, a list stuck to the top of a scrolling page, is gone.
  expect(declarations(css, ".ap-list").filter(([p]) => p === "position" || p === "max-height")).toEqual([]);
  for (const page of SPLIT_PAGES)
    expect(await Bun.file(join(import.meta.dir, "..", page)).text()).toContain("page-split");
});

test("the task board as Trello's: it fills the window under the page's head with the split's rule, its scrollbar along the bottom, each column's cards scrolling on their own", async () => {
  const css = await builtCss("src/styles.css", "src/pages/issues.css");
  const board = await Bun.file(join(import.meta.dir, "..", "src/pages/IssueBoard.tsx")).text();
  // The same height-passing rule as the list-and-detail pages, not a second one.
  expect(board).toContain('className="issues-boardframe page-split"');
  expect(board).toContain("useDragScroll(wrap, BOARD_SPACE)");
  // The kit's scrollbar stays drawn: no strip that hides it, no fade, no arrows.
  const wrap = declarations(css, ".issues-boardwrap");
  expect(wrap).toContainEqual(["overflow-x", "auto"]);
  expect(wrap.filter(([p]) => p === "scrollbar-width" || p.includes("mask"))).toEqual([]);
  expect(css).not.toContain("issues-boardframe__arrow");
  // Out over the page's side room to the work area's edges at every width, its first column on the page's line: the
  // page's own token, no number of its own anywhere (a phone's snap included).
  expect(wrap).toContainEqual(["margin", "0 calc(-1 * var(--page-x))"]);
  expect(wrap).toContainEqual(["padding", "2px var(--page-x) 10px"]);
  expect(wrap).toContainEqual(["scroll-padding-inline", "var(--page-x)"]);
  const phone = declarations(atRule(css, "@media (max-width: 720px)"), ".issues-boardwrap");
  expect(
    phone.filter(([p]) => p.startsWith("margin") || p.startsWith("padding") || p.startsWith("scroll-padding")),
  ).toEqual([]);
  const wide = atRule(css, WIDE);
  expect(declarations(wide, ".issues-board")).toContainEqual(["height", "100%"]);
  expect(declarations(wide, ".issues-col")).toContainEqual(["max-height", "100%"]);
  const cards = declarations(wide, ".issues-col>.issues-col__cards");
  expect(cards).toContainEqual(["overflow-y", "auto"]);
  expect(cards).toContainEqual(["min-height", "0"]);
  // Contained neither way: sideways a trackpad's swipe over a column slides the board, and a column scrolled to its end
  // hands the wheel to the page, which scrolls when what sits above squeezes the board.
  expect(cards.filter(([p]) => p.startsWith("overscroll-behavior"))).toEqual([]);
  // A short or narrow window keeps the page's scroll and columns as tall as their cards.
  expect(declarations(atRule(css, "@media (min-width: 941px)"), ".issues-col>.issues-col__cards")).toEqual([]);
  expect(declarations(css, ".issues-col__cards").filter(([p]) => p.startsWith("overflow"))).toEqual([]);
});
