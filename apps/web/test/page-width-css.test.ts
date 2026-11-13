import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

const css = topLevel(
  await builtCss(
    "src/styles.css",
    "src/pages/wiki.css",
    "src/pages/issues.css",
    "src/pages/routines.css",
    "src/pages/team.css",
    "src/components/missions/missions.css",
  ),
);
const maxWidth = (selector: string) => declarations(css, selector).findLast(([p]) => p === "max-width")?.[1] ?? "none";

test("pages use the width they have: no column capped short of the work area, sidebar open or collapsed", () => {
  for (const selector of [
    // The wiki: home, a page read and edited (one column, its outline in the tree), the graph, the text.
    ".wiki-home",
    ".wiki-doc",
    ".wiki-doc[data-editing]",
    ".wiki-graph",
    ".wiki-prose .md",
    // Rendered Markdown anywhere (a Drive report, a skill, the wiki), as a message's words already are.
    ".md",
    // Lists (Threads, Aprovações, Notificações), Drive, tasks, routines, the team.
    ".page--list",
    ".drive",
    ".issues",
    ".issue-description",
    ".routines",
    ".page.team",
    // A task's page, proposals, an agent's memory, search results.
    ".page--full",
    ".mi-q p",
  ])
    expect([selector, maxWidth(selector)]).toEqual([selector, "none"]);
});

test("what is narrow on purpose stays narrow: forms, empty states and the Terms' reading column", () => {
  expect(maxWidth(".page")).toBe("920px");
  expect(maxWidth(".page--narrow")).toBe("720px");
  expect(maxWidth(".page--mid")).toBe("860px");
  expect(maxWidth(".settings")).toBe("1120px");
  expect(maxWidth(".newag__content")).toBe("660px");
});

test("the wiki graph's box has a set height, so its drawing can take the box's shape", () => {
  const svg = Object.fromEntries(declarations(css, ".wiki-graph__svg"));
  expect(svg.height).toBe("calc(100vh - 220px)");
  expect(svg["max-height"]).toBeUndefined();
});

const panes = await builtCss(
  "src/components/threads/threads.css",
  "src/components/agents/agent-sidebar.css",
  "src/components/audit.css",
  "src/components/tasks/tasks.css",
  "src/pages/approvals.css",
);
const own = (selector: string) => Object.fromEntries(declarations(panes, selector));

test("what opens in a side panel is the panel's width: its view takes back the room the scrollbar keeps", () => {
  // The panel's width (100cqw) less the scroller's content box and side padding is the scrollbar's room, 0 where a
  // scrollbar takes none: it comes back out of the view's end, which runs under the scrollbar without scrolling sideways.
  const view = own(":is(.thread-panel, .members-side) > :is(.thread-panel__page, .dm-side__scroll) > *");
  expect(view["margin-inline-end"]?.replace(/\s+/g, "")).toBe("calc(100%+2*var(--pane-x,0px)-100cqw)");
  // The build writes `overflow-x: hidden; overflow-y: auto` as one `overflow`.
  for (const scroller of [".thread-panel__page", ".dm-side__scroll"])
    expect(own(scroller).overflow ?? `${own(scroller)["overflow-x"]} ${own(scroller)["overflow-y"]}`).toBe(
      "hidden auto",
    );
  // A scroller with side room of its own says how much, the docked side of a DM is its scroller's container.
  expect(own(".audit-panel__body")).toMatchObject({ "--pane-x": "24px", padding: "18px var(--pane-x) 28px" });
  expect(own(".tm-panel__body")).toMatchObject({ "--pane-x": "18px", padding: "14px var(--pane-x) 18px" });
  expect(own(".members-side.dm-side")).toMatchObject({ overflow: "hidden", "container-type": "inline-size" });
});

test("an approval's request takes its column's width, its decision bar too", () => {
  for (const selector of [".ap-review__body", ".ap-bar--float"]) expect(own(selector)["max-width"]).toBeUndefined();
});
