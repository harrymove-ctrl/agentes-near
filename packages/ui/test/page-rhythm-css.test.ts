import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const kit = readFileSync(new URL("../src/styles/components.css", import.meta.url).pathname, "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** A selector list's selectors, split on its top-level commas only (`:is(a, b)` stays one). */
const split = (list: string) => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, list.slice(start)].map((s) => s.replace(/\s+/g, " ").trim());
};

/** The bodies of every rule whose selector list holds exactly `selector`, inside `@media` blocks too. */
const body = (selector: string, css = kit) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => split(m[1] ?? "").includes(selector))
    .map((m) => m[2])
    .join("\n");

/** What a `@media` block holds, every block with that exact query. */
const media = (query: string) => {
  const out: string[] = [];
  for (let at = kit.indexOf(`@media ${query} {`); at >= 0; at = kit.indexOf(`@media ${query} {`, at + 1)) {
    let depth = 0;
    let end = kit.indexOf("{", at);
    for (; end < kit.length; end++) {
      if (kit[end] === "{") depth++;
      else if (kit[end] === "}" && --depth === 0) break;
    }
    out.push(kit.slice(kit.indexOf("{", at) + 1, end));
  }
  return out.join("\n");
};

describe("one page top and side", () => {
  test("every page's room is two tokens: the title's line on the sidebar's workspace row, 20 on a phone, 16 at the side under 640", () => {
    expect(body(":root")).toContain("--page-top: calc(38px - var(--control-h-md) / 2);");
    expect(body(":root")).toContain("--page-x: 24px;");
    expect(body(":root", media("(max-width: 760px)"))).toContain("--page-top: 20px;");
    expect(body(":root", media("(max-width: 640px)"))).toContain("--page-x: 16px;");
  });

  test("the title's line and the buttons beside it are as tall as a page's buttons, so they centre on it", () => {
    expect(body(".ac-pagehead__title")).toContain("line-height: var(--control-h-md);");
    expect(body(".ac-pagehead__actions")).toContain("min-height: var(--control-h-md);");
  });

  test("a page's count is on the title's row, on its baseline, 12 after it, under it only without room", () => {
    const line = body(".ac-pagehead__titleline:has(> .ac-pagehead__count)");
    expect(line).toContain("flex-wrap: wrap;");
    expect(line).toContain("column-gap: var(--space-3);");
    expect(body(".ac-pagehead__titleline > .ac-pagehead__title:has(+ .ac-pagehead__count)")).toContain(
      "align-self: baseline;",
    );
    expect(body(".ac-pagehead__count")).toContain("align-self: baseline;");
  });
});

describe("cards and rows", () => {
  test("a card is 16 inside, a list row 8 above and below (12 under a finger)", () => {
    const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url).pathname, "utf8");
    expect(tokens).toContain("--row-py: var(--space-2);");
    expect(body(":root", media("(pointer: coarse)"))).toContain("--row-py: var(--space-3);");
    expect(body(".ac-card")).toContain("--card-pad: var(--space-4);");
    expect(body(".ac-card__foot")).toContain("padding: var(--row-py) var(--card-pad, 16px);");
    expect(body(".ac-list__row")).toContain("padding: var(--row-py) var(--space-4);");
  });
});

describe("one group heading", () => {
  test("one 20px line on the list's outer edge, 8 over its rows; groups 24 apart", () => {
    const head = body(".ac-grouphead");
    expect(head).toContain("margin: 0 0 8px;");
    expect(head).toContain("padding: 0;");
    expect(head).toContain("line-height: 20px;");
    expect(head).toContain("min-height: 20px;");
    expect(body(".ac-grouphead__aside")).toContain("margin-left: auto;");
    expect(body(".ac-groups")).toContain("gap: 24px;");
  });
});

describe("one menu rhythm", () => {
  test("rows of 32 (40 on touch), a description adding its line to the same room, Mais 2 apart as menus are", () => {
    expect(body(":root")).toContain("--menu-item-h: 32px;");
    expect(body(":root", media("(pointer: coarse)"))).toContain("--menu-item-h: 40px;");
    expect(body(".ac-menu__item:has(> .ac-menu__label > .ac-menu__desc)")).toBe("");
    expect(kit).not.toContain(".ac-menu:has(.ac-menu__desc) .ac-menu__item {");
    expect(body(".ac-popover:has(> .ac-menu__item)")).toContain("gap: 2px;");
  });

  test("a search's list, a filter's and the workspace menu take the same rows", () => {
    for (const row of [".ac-tz__option", ".ac-filter__option"]) {
      expect(body(row)).toContain("min-height: var(--menu-item-h);");
      expect(body(row)).toContain("padding: calc((var(--menu-item-h) - 20px) / 2) var(--menu-item-px);");
      expect(body(row)).toContain("line-height: 20px;");
    }
    expect(body(".ac-tz__list")).toContain("gap: 2px;");
    expect(body(".ac-tz__list > div")).toContain("gap: 2px;");
    expect(body(".ac-filter__list")).toContain("gap: 2px;");
    // The composer's suggestions and the palette group their rows in a listbox: the rows keep the 2 there too.
    for (const list of [
      '.ac-suggest > [role="listbox"] > [role="presentation"]',
      '.ac-palette__list > [role="presentation"]',
    ])
      expect(body(list)).toContain("gap: 2px;");
    expect(body(':is(.ac-menu--select, .ac-menu--dropdown) [role="group"]:not(.ac-menu__reactions)')).toContain(
      "gap: 2px;",
    );
    expect(body(".ac-mo__group")).toContain("--menu-pad: var(--space-2);");
    // The full-screen menu's 15px rows are the touch ones under any pointer: 20px of line and 10 above and below.
    expect(body(".ac-mo__item")).toContain("padding: 10px 14px;");
    expect(body(".ac-suggest__item")).not.toContain("min-height");
  });

  test("a face list keeps its own rows over the menu's", () => {
    expect(body(":is(.ac-menu, .ac-palette__list):has(.ac-menu__leading > .ac-avatar) .ac-menu__item")).toContain(
      "min-height: var(--option-h);",
    );
    // Its descriptions sit beside the names, one line: the leads centre in their rows, not on a first line.
    const lead =
      ":is(.ac-menu, .ac-palette__list):has(.ac-menu__leading > .ac-avatar) :is(.ac-menu__item, .ac-search__option) > .ac-menu__leading";
    expect(body(lead)).toContain("align-self: center;");
    expect(body(lead)).toContain("translate: none;");
  });
});

describe("the toolbar", () => {
  test("from 761px a page's toolbar keeps one row: the search giving way down to 160, the rest at the end", () => {
    const wide = media("(min-width: 761px)");
    expect(body(".ac-toolbar:has(> .ac-toolbar__search):not([data-stack])", wide)).toContain("flex-wrap: nowrap;");
    // The search's floor holds at every width: a phone's top row keeps it too.
    expect(body(".ac-toolbar > .ac-toolbar__search")).toContain("min-width: 160px;");
    expect(body(".ac-toolbar > .ac-toolbar__search", wide)).not.toContain("min-width");
    expect(body(".ac-toolbar__search")).toContain("flex: 0 1 280px;");
    expect(body(".ac-toolbar > .ac-toolbar__search + *", wide)).toContain("margin-left: auto;");
    expect(body(".ac-toolbar > .ac-toolbar__search + .ac-toolbar__filters + .ac-toolbar__actions", wide)).toContain(
      "margin-left: 0;",
    );
    expect(body(".ac-toolbar:has(> .ac-toolbar__search):not([data-stack]) > .ac-toolbar__filters", wide)).toContain(
      "flex: none;",
    );
  });

  test("two rows on a phone and when one doesn't fit: the search and the actions, then the filters in one scroller", () => {
    const phone = media("(max-width: 760px)");
    expect(body(".ac-toolbar:has(> .ac-toolbar__search) > .ac-toolbar__actions", phone)).toContain("order: 1;");
    // Its basis counts the room its margins give back: a full row, never beside a search without actions to share
    // the search's, which it would squeeze to nothing.
    const row = body(".ac-toolbar:has(> .ac-toolbar__search) > .ac-toolbar__filters", phone);
    expect(row).toContain("order: 2;");
    expect(row).toContain("flex: 1 1 calc(100% + 2 * var(--bleed));");
    expect(body(".ac-toolbar[data-stack] > .ac-toolbar__actions")).toContain("order: 1;");
    const stacked = body(".ac-toolbar[data-stack] > .ac-toolbar__filters");
    expect(stacked).toContain("order: 2;");
    expect(stacked).toContain("flex: 1 1 calc(100% + 2 * var(--bleed));");
    expect(stacked).toContain("overflow-x: auto;");
    // The filter bar inside the row doesn't scroll on its own, so the row's 4px up and down keep its controls' rings
    // whole (an active filter's ring too); at its sides it runs out over the page's room (`--bleed`) to the edge, its
    // first control on the page's line, pulled back by as much so the row keeps its place.
    expect(kit).not.toMatch(/\.ac-filterbar[^{}]*\{[^}]*overflow-x: auto/);
    for (const strip of [body(".ac-toolbar__filters", phone), stacked]) {
      expect(strip).toContain("padding: 4px var(--bleed);");
      expect(strip).toContain("margin: -2px calc(-1 * var(--bleed));");
      expect(strip).toContain("max-width: calc(100% + 2 * var(--bleed));");
    }
    // A side another part shares keeps only the rings' 4px: after the actions (split), before them (no search).
    const split = body('.ac-toolbar[data-stack="split"] > .ac-toolbar__filters');
    expect(split).toContain("margin-left: -4px;");
    expect(split).toContain("padding-left: 4px;");
    const beforeActions = body(
      ".ac-toolbar:not(:has(> .ac-toolbar__search)):has(> .ac-toolbar__actions) > .ac-toolbar__filters",
      phone,
    );
    expect(beforeActions).toContain("margin-right: -4px;");
    expect(beforeActions).toContain("padding-right: 4px;");
    // The room is the page's, or that of the box a toolbar sits in: running past its edge would scroll it sideways.
    expect(body(":root")).toContain("--bleed: var(--page-x);");
    expect(body(".ac-dialog")).toContain("--bleed: var(--dialog-pad);");
    expect(body(".ac-details")).toContain("--bleed: var(--details-pad);");
    expect(body(".ac-card")).toContain("--bleed: var(--card-pad);");
    expect(body(".ac-menu")).toContain("--bleed: var(--menu-pad);");
  });

  test("stacked, a search that can't keep its floor beside the actions takes the top row alone, the actions leading the next", () => {
    expect(body('.ac-toolbar[data-stack="split"] > .ac-toolbar__search')).toContain("flex: 1 1 100%;");
    expect(body('.ac-toolbar[data-stack="split"] > .ac-toolbar__filters')).toContain("flex: 1 1 0;");
    // With no filters to share that row, the actions fill it.
    expect(body('.ac-toolbar[data-stack="split"]:not(:has(> .ac-toolbar__filters)) > .ac-toolbar__actions')).toContain(
      "flex: 1 1 100%;",
    );
    // Later than the stacked rules it overrides, which are as specific.
    expect(kit.indexOf('.ac-toolbar[data-stack="split"] > .ac-toolbar__filters')).toBeGreaterThan(
      kit.indexOf(".ac-toolbar[data-stack] > .ac-toolbar__filters {"),
    );
  });

  test("stacked, no control sits alone beside an empty stretch: a lone small filter shares a row, a lone segmented control fills its own", () => {
    const squash = (s: string) => s.replace(/\s+/g, "");
    /** The bodies of the rules whose selector holds `part` (whitespace aside). */
    const where = (part: string, css = kit) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => split(m[1] ?? "").some((s) => squash(s).includes(squash(part))))
        .map((m) => m[2])
        .join("\n");
    const lone =
      ":has(> .ac-toolbar__filters > :only-child:not(.ac-filterbar, .ac-seg), > .ac-toolbar__filters > .ac-filterbar:only-child > :only-child)";
    const phone = media("(max-width: 760px)");
    for (const [stacked, css] of [
      [".ac-toolbar[data-stack]", kit],
      [".ac-toolbar:has(> .ac-toolbar__search)", phone],
    ] as const) {
      // After the search, with the actions when there are some: the search then fills its own row.
      expect(where(`${stacked}${lone} > :is(.ac-toolbar__filters, .ac-toolbar__actions)`, css)).toContain("order: 1;");
      expect(where(`${stacked}:has(> .ac-toolbar__actions)${lone} > .ac-toolbar__search`, css)).toContain(
        "flex: 1 1 100%;",
      );
      // One control doesn't scroll: no scroller's room around it.
      expect(where(`${stacked}${lone} > .ac-toolbar__filters`, css)).toContain("overflow: visible;");
    }
    // A lone segmented control (Atividade's, Auditoria's) fills its row and scrolls in its own track when wider.
    expect(where(".ac-toolbar[data-stack] > .ac-toolbar__filters > .ac-seg:only-child")).toContain("flex: 1 1 auto;");
    expect(where(".ac-toolbar__filters > .ac-seg:only-child", phone)).toContain("min-width: 0;");
    expect(where(".ac-toolbar__filters > .ac-seg:only-child > .ac-seg__item", phone)).toContain("flex: 1 0 auto;");
    // Without a search (Auditoria's view and agent): what wraps fills its line on a phone.
    expect(
      where(".ac-toolbar:not(:has(> .ac-toolbar__search)) > :is(.ac-toolbar__filters, .ac-toolbar__actions)", phone),
    ).toContain("flex: 1 1 auto;");
  });

  test("an empty search field gives the hidden hint's room back to its words", () => {
    expect(
      body(".ac-searchfield:not(:has(> .ac-searchfield__clear, > .ac-searchfield__hint)) .ac-searchfield__input"),
    ).toContain("padding-right: var(--control-px-sm);");
    expect(
      body(
        ".ac-searchfield:not(:has(> .ac-searchfield__clear)) .ac-searchfield__input",
        media("(max-width: 760px), (pointer: coarse)"),
      ),
    ).toContain("padding-right: var(--control-px-sm);");
  });

  test("a filter's option ends with its count, then the check", () => {
    expect(body(".ac-filter__option > .ac-countchip")).toContain("margin-left: auto;");
    expect(body(".ac-filter__option > .ac-countchip + .ac-tz__check")).toContain("margin-left: var(--space-2);");
  });
});

describe("a pill on a name's first line", () => {
  test("doesn't rise with .ac-captop, on the line or ending the row on it", () => {
    for (const selector of [
      ".ac-captop:has(.ac-chip)",
      ":is(.ac-list__row, .ac-faceline):has(> .ac-captail > .ac-chip) .ac-captop",
      ".ac-captail.ac-captop:has(> .ac-chip)",
    ])
      expect(body(selector)).toContain("margin-block-start: 0;");
  });
});

describe("a tab strip", () => {
  test("starts its first label on the content's edge, its underline too, and the first section under it has no hairline", () => {
    expect(body(".ac-tabs > .ac-tab:first-child")).toContain("padding-inline-start: 0;");
    expect(body('.ac-tabs > .ac-tab:first-child[data-state="active"]::after')).toContain("left: 0;");
    expect(body(".ac-tabpanel > .ac-details__section:first-child")).toContain("border-top: 0;");
    expect(body(".ac-tabpanel > .ac-details__section:first-child")).toContain("padding-top: 0;");
  });
});
