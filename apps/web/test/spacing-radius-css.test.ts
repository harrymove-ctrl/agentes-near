import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");
const UI = join(import.meta.dir, "../../../packages/ui/src/styles");
const read = (path: string) => Bun.file(path).text();
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];
const px = (tokens: string, name: string) => {
  const raw = last(tokens, ":root", name);
  const ref = raw?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return Number.parseFloat((ref ? last(tokens, ":root", ref) : raw) ?? "NaN");
};

test("a menu's rows have the same room at its ends as at its sides, a select's too", async () => {
  const kit = topLevel(await read(join(UI, "components.css")));
  expect(last(kit, ".ac-menu", "padding")).toBe("var(--menu-pad)");
  // A select's room at its ends is its viewport's (kept when scrolled), never the menu's on top of it.
  expect(last(kit, ".ac-menu--select", "padding-block")).toBe("0");
  expect(last(kit, ".ac-menu--select [data-radix-select-viewport]", "padding-block")).toBe("var(--menu-pad)");
  // A row's top and bottom are one value; a row with a description is as deep as its sides, and a row led by a face
  // (OptionRow) keeps the face 6 from its top and bottom (10 on touch) and the rows' 8 from its start.
  expect(last(kit, ".ac-menu__item", "padding")).toBe("calc((var(--menu-item-h) - 20px) / 2) var(--menu-item-px)");
  expect(last(kit, ".ac-menu__item:has(>.ac-menu__label>.ac-menu__desc)", "padding-block")).toBeUndefined();
  expect(last(kit, ":is(.ac-menu,.ac-palette__list):has(.ac-menu__leading>.ac-avatar) .ac-menu__item", "padding")).toBe(
    "calc((var(--option-h) - var(--option-face)) / 2) var(--menu-item-px)",
  );
  expect(last(kit, ":root", "--menu-item-px")).toBe("8px");
  expect(last(kit, ".ac-option", "padding")).toBe("var(--space-3)");
});

test("a rounded thing near a rounded box's edge has the box's radius less the room between them", async () => {
  const kit = await read(join(UI, "components.css"));
  const top = topLevel(kit);
  const tokens = topLevel(await read(join(UI, "tokens.css")));
  // Menus, selects and popovers: the box is its rows' radius plus its room.
  expect(last(top, ".ac-menu", "border-radius")).toBe("calc(var(--radius-item) + var(--menu-pad))");
  expect(last(top, ".ac-menu__item", "border-radius")).toBe("var(--radius-item)");
  expect(last(top, ".ac-menu__reaction", "border-radius")).toBe("var(--radius-item)");
  // The emoji picker: 8px of room, and its search, tabs, segmented tabs and cells on the rows' radius.
  expect(last(top, ".ac-emoji-popover", "--menu-pad")).toBe("var(--space-2)");
  expect(last(top, ".ac-emoji-popover", "padding")).toBe("var(--menu-pad)");
  for (const inner of [".ac-emoji__search", ".ac-emoji__tab"])
    expect(last(top, inner, "border-radius")).toBe("var(--control-r-sm)");
  expect(last(top, ".ac-picker .ac-tabs--seg", "--seg-r")).toBe("var(--control-r-sm)");
  expect(px(tokens, "--control-r-sm")).toBe(px(tokens, "--radius-item"));
  expect(px(tokens, "--radius-item") + px(tokens, "--space-2")).toBeLessThanOrEqual(px(tokens, "--radius-xl"));
  // The message's hover bar, with a mouse and under a finger.
  expect(last(top, ".ac-msg__actions", "padding")).toBe("var(--bar-pad)");
  expect(last(top, ".ac-msg__actions", "border-radius")).toBe("var(--bar-r)");
  const inBar = "calc(var(--bar-r) - var(--bar-pad))";
  expect(last(top, ".ac-msg__actions .ac-btn--sm", "border-radius")).toBe(inBar);
  // Under a finger the plates grow through the bar's own size, so their corner stays the bar's less its room.
  expect(last(atRule(kit, "@media (pointer: coarse)"), ".ac-msg__actions", "--bar-btn")).toBe("var(--control-h-sm)");
  // A plate with a count (👍 1) is one plate around the icon and the count, the icon as far in as in a square one.
  expect(last(top, ".ac-msg__actions .ac-btn--sm", "width")).toBe("var(--bar-btn)");
  expect(last(top, ".ac-msg__actions .ac-btn--sm:not(.ac-btn--icon)", "width")).toBe("auto");
  expect(last(top, ".ac-msg__actions .ac-btn--sm:not(.ac-btn--icon)", "padding-inline")).toBe(
    "calc((var(--bar-btn) - var(--bar-icon)) / 2)",
  );
  // Pressed, it keeps the ghost's plate: no fill of the bar's own over it.
  expect(kit).not.toContain('.ac-msg__actions .ac-btn[aria-pressed="true"]');
  // Segmented controls, and the command palette's rows in its list.
  expect(last(top, ".ac-seg__item", "border-radius")).toBe("calc(var(--seg-r) - var(--seg-in))");
  expect(last(top, ".ac-palette__list", "padding")).toBe("var(--palette-pad)");
  expect(last(top, ".ac-palette__item", "border-radius")).toBe("calc(var(--radius-section) - var(--palette-pad))");
  // Menus whose search row and list hold the room themselves: the corner follows that room, not the default.
  for (const menu of [".ac-tz__menu.ac-menu", ".ac-filter__menu.ac-menu"]) {
    expect(last(top, menu, "--menu-pad")).toBe("6px");
    expect(last(top, menu, "padding")).toBe("0");
  }
  for (const inner of [".ac-tz__searchrow", ".ac-tz__list", ".ac-filter__list"])
    expect(last(top, inner, "padding")).toBe("var(--menu-pad)");
  // The phone-style menu overlay: 8px of room inside a section's corner, said as its menu's room.
  expect(last(top, ".ac-mo__group", "--menu-pad")).toBe("var(--space-2)");
  expect(last(top, ".ac-mo__group", "padding")).toBe("var(--menu-pad)");
  expect(last(top, ".ac-mo__item", "border-radius")).toBe("calc(var(--radius-section) - var(--space-2))");
  // Popovers with their own room set it as the menu's, so their corner follows.
  const layout = topLevel(await read(join(SRC, "layout.css")));
  expect(last(layout, ".agp-changes.ac-popover", "padding")).toBe("var(--menu-pad)");
  expect(last(layout, ".agp-changes__item", "border-radius")).toBe("var(--radius-item)");
  expect(last(layout, ".agp-changes__jump", "border-radius")).toBe("calc(var(--radius-item) - 4px)");
  const calendar = topLevel(await read(join(SRC, "pages/calendar.css")));
  expect(last(calendar, ".cal-more.ac-popover", "padding")).toBe("var(--menu-pad)");
});

test("a popover with words and controls of its own has the menu's room, its words further in, never its own corner", async () => {
  const kit = topLevel(await read(join(UI, "components.css")));
  expect(last(kit, ".ac-popover", "--popover-in")).toBe("6px");
  const neg = "calc(-1 * var(--popover-in))";
  const sheets = {
    calendar: topLevel(await read(join(SRC, "pages/calendar.css"))),
    tasks: topLevel(await read(join(SRC, "components/tasks/tasks.css"))),
    dashboards: topLevel(await read(join(SRC, "pages/dashboards.css"))),
    issues: topLevel(await read(join(SRC, "pages/issues.css"))),
    layout: topLevel(await read(join(SRC, "layout.css"))),
    card: topLevel(await read(join(SRC, "components/profile-card.css"))),
  };
  const boxes: [keyof typeof sheets, string][] = [
    ["calendar", ".cal-pop.ac-popover"],
    ["tasks", ".tm-confirm.ac-popover"],
    ["dashboards", ".nw-alert.ac-popover"],
    ["issues", ".issues-display.ac-popover"],
    ["issues", ".issue-github__pop.ac-popover"],
    ["layout", ".profile-card"],
    ["card", ".mcard-audience.ac-popover"],
  ];
  for (const [sheet, box] of boxes) {
    expect(last(sheets[sheet], box, "--menu-pad")).toBe("var(--space-2)");
    // The audience editor's foot room is its pinned Cancelar and Salvar's own, so it scrolls nothing below them.
    expect(last(sheets[sheet], box, "padding")).toBe(
      box === ".mcard-audience.ac-popover" ? "var(--menu-pad) var(--menu-pad) 0" : "var(--menu-pad)",
    );
    // The corner is the menu's (`.ac-menu`), from that room: none of them sets its own.
    expect(last(sheets[sheet], box, "border-radius")).toBeUndefined();
  }
  expect(last(sheets.card, ".mcard-audience__acts", "padding")).toBe("12px 0 var(--menu-pad)");
  // Words further in; the buttons' row back on the room, in its corners.
  expect(last(sheets.calendar, ".cal-pop .cal-details", "padding")).toBe("var(--popover-in)");
  expect(last(sheets.calendar, ".cal-pop .cal-details__actions:has(>.ac-btn)", "margin-bottom")).toBe(neg);
  expect(last(sheets.tasks, ".tm-confirm__head", "padding")).toBe("var(--popover-in) var(--popover-in) 0");
  expect(last(sheets.dashboards, ".nw-alert__row", "padding")).toBe("var(--popover-in) var(--popover-in) 0");
  expect(last(sheets.issues, ".issues-display__row", "padding-inline")).toBe("var(--popover-in)");
  expect(last(sheets.issues, ".issues-display__foot", "padding")).toBe("14px var(--popover-in) var(--popover-in)");
  expect(last(sheets.issues, ".issue-github__field", "margin")).toBe("var(--popover-in) var(--popover-in) 0");
  expect(last(sheets.issues, ".issues-layout", "border-radius")).toBe(
    "var(--radius-item) var(--radius-item) var(--radius-item) 4px",
  );
  expect(last(sheets.layout, ".channel-card>div", "padding")).toBe("var(--popover-in)");
  expect(last(sheets.layout, ".channel-card .profile-card__actions", "margin-bottom")).toBe(neg);
  expect(last(sheets.card, ".mcard-audience.ac-popover>:not(.mcard-audience__acts)", "margin-inline")).toBe(
    "var(--popover-in)",
  );
});

test("a button inside a field is as far from its end as from its top and bottom, its corner the field's less that", async () => {
  const kit = topLevel(await read(join(UI, "components.css")));
  // The date picker: the menu's room (a later `.ac-menu` rule sets the padding and corner from it), the hairline over
  // its foot with that room on both sides, the corner days on the box's corner less the room and a cell's 1px.
  expect(last(kit, ".ac-date", "--menu-pad")).toBe("var(--space-2)");
  expect(last(kit, ".ac-date", "padding")).toBeUndefined();
  expect(last(kit, ".ac-date", "gap")).toBe("var(--menu-pad)");
  expect(last(kit, ".ac-date__foot", "padding-top")).toBe("var(--menu-pad)");
  expect(last(kit, ".ac-date__grid td", "padding")).toBe("1px");
  expect(last(kit, ".ac-date__day", "border-radius")).toBe("calc(var(--radius-item) - 1px)");
  // A search field's clear and a filter chip's.
  for (const [clear, h, r] of [
    [".ac-searchfield__clear", "var(--tool-h, var(--control-h-md))", "var(--tool-r, var(--control-r-md))"],
    [".ac-filter__clear", "var(--tool-h, var(--control-h-sm))", "var(--tool-r, var(--control-r-sm))"],
  ] as const) {
    expect(last(kit, clear, "--in")).toBe(`calc((${h} - 22px) / 2)`);
    expect(last(kit, clear, "height")).toBe("22px");
    expect(last(kit, clear, "border-radius")).toBe(`calc(${r} - var(--in))`);
  }
  expect(last(kit, ".ac-searchfield__clear", "right")).toBe("var(--in)");
  expect(last(kit, ".ac-filter__clear", "margin-right")).toBe("var(--in)");
  // A token's ✕: 4px around a 20px circle in a 28px pill, 2px around 18px (r2) in a 22px one (r4).
  expect(last(kit, ".ac-token", "padding")).toBe("0 var(--token-px)");
  expect(last(kit, ".ac-token__remove", "height")).toBe("20px");
  expect(last(kit, ".ac-token--sm", "--token-px")).toBe("7px");
  expect(last(kit, ".ac-token--sm", "--token-x-spare")).toBe("5px");
  expect(last(kit, ".ac-token--sm", "border-radius")).toBe("var(--radius-xs)");
  expect(last(kit, ".ac-token--sm .ac-token__remove", "border-radius")).toBe("var(--radius-cut)");
  // The composer's row: one room on every side, its send button the card's corner less it.
  expect(last(kit, ".ac-composer__row", "padding")).toBe("var(--space-2)");
  expect(last(kit, ".ac-composer__send", "border-radius")).toBe("var(--control-r-sm)");
  // The password field's eye: a 32px button in the ruler's 48px field, as far from its end as from its top and
  // bottom, its corner the field's less that room.
  const auth = topLevel(await read(join(SRC, "components/auth.css")));
  expect(last(auth, ".auth__big.ac-input", "height")).toBe("var(--control-h-lg)");
  expect(last(auth, ".auth__big.ac-input", "border-radius")).toBe("var(--control-r-lg)");
  expect(last(auth, ".auth__eye.ac-btn", "right")).toBe("calc((var(--control-h-lg) - var(--control-h-sm)) / 2)");
  expect(last(auth, ".auth__eye.ac-btn", "border-radius")).toBe(
    "calc(var(--control-r-lg) - (var(--control-h-lg) - var(--control-h-sm)) / 2)",
  );
});

test("every hairline between a card's rows, and over its foot, has one step of room on each side", async () => {
  const kit = topLevel(await read(join(UI, "components.css")));
  const tokens = topLevel(await read(join(UI, "tokens.css")));
  expect(last(tokens, ":root", "--row-py")).toBe("var(--space-2)");
  expect(last(kit, ".ac-card", "gap")).toBe("var(--space-3)");
  expect(last(kit, ".ac-card__foot", "padding")).toBe("var(--row-py) var(--card-pad, 16px)");
  const layout = topLevel(await read(join(SRC, "layout.css")));
  expect(last(layout, ".settings-row", "padding")).toBe("var(--row-py) var(--card-pad)");
  expect(last(layout, ".voice-engine__body", "padding")).toBe("var(--row-py) var(--card-pad)");
  // Over a foot, the rows give back the card's gap: the last row's padding is all that's over the foot's hairline.
  expect(last(layout, ".settings-rows:has(+.ac-card__foot)", "margin-bottom")).toBe("calc(-1 * var(--space-3))");
  const roles = topLevel(await read(join(SRC, "components/roles/roles.css")));
  expect(last(roles, ".roles-row", "padding")).toBe("var(--row-py) 20px");
  expect(last(roles, ".roles-area", "padding")).toBe("var(--row-py) 0");
  expect(last(roles, ".roles-look__row", "padding")).toBe("var(--row-py) 0");
  // Limites are settings rows: every select on one right edge.
  const people = topLevel(await read(join(SRC, "components/people-usage.css")));
  expect(declarations(people, ".pu-limits__row")).toEqual([]);
  expect(last(people, ".pu-pick__select", "width")).toBe("200px");
  const plan = topLevel(await read(join(SRC, "components/plan-usage.css")));
  // An account's row: one step above and below its words, the list's 16 at its sides, what it folds on the same sides.
  expect(last(plan, ".plan-row__head", "padding")).toBe("var(--space-3) var(--space-4)");
  expect(last(plan, ".plan-row__body", "padding")).toBe("0 var(--space-4)");
  expect(last(plan, ".plan-row__body", "gap")).toBe("var(--space-3)");
});

test("the API keys: each row has the rows' room above and below, 16 at its sides", async () => {
  const layout = topLevel(await read(join(SRC, "layout.css")));
  expect(last(layout, ".key-row", "padding")).toBe("var(--row-py) var(--space-4)");
});

test("the settings sidebar's links are the ruler's compact step, the default one under a finger", async () => {
  const css = await read(join(SRC, "layout.css"));
  const top = topLevel(css);
  expect(last(top, ".settings__link", "min-height")).toBe("var(--control-h-sm)");
  expect(last(top, ".settings__link", "border-radius")).toBe("var(--control-r-sm)");
  // A name that wraps (a long translation) keeps its icon on its first line, the words padded to one line's middle.
  expect(last(top, ".settings__link", "align-items")).toBe("flex-start");
  expect(last(top, ".settings__link", "padding")).toBe("calc((var(--control-h-sm) - 22px) / 2) 10px");
  expect(last(top, ".settings__groups", "gap")).toBe("var(--space-4)");
  const touch = atRule(css, "@media (pointer: coarse)");
  expect(last(touch, ".settings__link", "min-height")).toBe("var(--control-h-md)");
});
