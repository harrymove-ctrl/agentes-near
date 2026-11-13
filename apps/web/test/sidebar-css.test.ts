import { expect, test } from "bun:test";
import { join } from "node:path";
import { declarations } from "./built-css";

const css = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
const value = (selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];

test("a channel's # is no louder than a category's chevron, in its column, and every name starts in one column", () => {
  const mark = '.sidebar:not([data-rail="true"]) .sidebar__item > .sidebar__channel-icon';
  const chevron = ".sidebar__section-chevron";
  // The chevron's 14px and faint ink, in the 16px icons' place (1px each side).
  expect([value(mark, "width"), value(mark, "height"), value(mark, "color"), value(mark, "margin")]).toEqual([
    "14px",
    "14px",
    "var(--faint)",
    "0 1px",
  ]);
  expect([value(chevron, "color"), value(chevron, "margin")]).toEqual(["var(--faint)", "0 1px"]);
  // A category's header starts and spaces its chevron and name as a row does its icon and name.
  const row = '.sidebar:not([data-rail="true"]) .sidebar__item';
  const header = ".sidebar__section-toggle";
  expect([value(header, "padding"), value(header, "gap")]).toEqual([value(row, "padding"), value(row, "gap")]);
  // No step in under a header: a category's rows line up with the ones outside it.
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__section-body', "padding-left")).toBeUndefined();
});

test("space, not lines, sets the sidebar's parts apart: 16px over each one with the list's gap", () => {
  expect(declarations(css, ".sidebar__divider")).toEqual([]);
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__block + .sidebar__block', "margin-top")).toBe("10px");
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__scroll', "gap")).toBe("6px");
});

test("an agent's role sits under its name as a tag, one line, beside a face as tall as both, and gone in the rail", () => {
  const role = ".sidebar__item-role";
  // One line ending in "…", what it is on too: the row stays two lines and everything in it shares its middle.
  expect([
    value(role, "white-space"),
    value(role, "text-overflow"),
    value(".sidebar__item-work", "white-space"),
  ]).toEqual(["nowrap", "ellipsis", undefined]);
  expect([value(role, "font-size"), value(role, "color")]).toEqual(["12.5px", "var(--faint)"]);
  // The role, the agent's fixed label, is a small tag as wide as its words; what it is on stays a plain line.
  const tag = ".sidebar__item-role.ac-tag";
  expect([value(tag, "font-size"), value(tag, "align-self")]).toEqual(["11.5px", "flex-start"]);
  expect([value(".sidebar__item-text", "flex-direction"), value(".sidebar__item-text", "min-width")]).toEqual([
    "column",
    "0",
  ]);
  // A message's face size (`--name-face`, 32), 8 from the plate's edges: a name alone centres on it, a name over a
  // role is a face line (the name's capitals on the face's top, `.ac-captop` on the label) with what ends the row on
  // its middle.
  const face = '.sidebar:not([data-rail="true"]) .sidebar__item > .ac-avatar--sm';
  // The rail's 40px tile keeps its smaller face, with room for the presence badge and the unread count.
  expect(value(".sidebar__item > .ac-avatar--sm", "height")).toBe("var(--sidebar-rail-face)");
  expect(value(".sidebar", "--sidebar-rail-face")).toBe("28px");
  expect([value(face, "width"), value(face, "height")]).toEqual(["var(--name-face)", "var(--name-face)"]);
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__item:has(> .ac-avatar)', "padding-block")).toBe("8px");
  const twoLines =
    '.sidebar:not([data-rail="true"]) .sidebar__item:has(> .ac-avatar + .sidebar__item-text > .sidebar__item-role)';
  expect(declarations(css, twoLines)).toEqual([["align-items", "flex-start"]]);
  expect(value(`${twoLines} > :not(.ac-avatar, .sidebar__item-text)`, "align-self")).toBe("center");
  expect(value(".sidebar__item", "align-items")).toBe("center");
  // The icons' rows: 32, their 16px icons 8 from the plate's edges.
  const item = '.sidebar:not([data-rail="true"]) .sidebar__item';
  expect([value(item, "min-height"), value(item, "padding")]).toEqual(["32px", "0 8px"]);
  expect(value(`${item} > .ac-icon`, "height")).toBe("16px");
  expect(value('.sidebar[data-rail="true"] .sidebar__item-text', "display")).toBe("contents");
  expect(value('.sidebar[data-rail="true"] .sidebar__item-role', "display")).toBe("none");
});

test("a row's hover buttons get their own room instead of covering the name and role, and Tab shows them", () => {
  // Each button is 24px, from 4px before the row's end.
  const open = '.sidebar__row[data-acts]:is(:hover, :focus-within, :has([data-state="open"]))';
  expect(value(`${open} > .sidebar__row-acts`, "opacity")).toBe("1");
  // Not in the rail, which has no such buttons: room kept there would push the mark out of its plate.
  const wide = `.sidebar:not([data-rail="true"]) ${open} > .sidebar__item`;
  expect(value(wide, "padding-right")).toBe("var(--acts-room, 32px)");
  expect(value(`${open} > .sidebar__item`, "padding-right")).toBeUndefined();
  expect(value('.sidebar__row[data-acts="2"]', "--acts-room")).toBe("56px");
  expect(value(".sidebar__row-acts", "opacity")).toBe("0");
  // Centred on the row, as the face is, on a two-line row too.
  expect([value(".sidebar__row-acts", "top"), value(".sidebar__row-acts", "translate")]).toEqual(["50%", "0 -50%"]);
  expect(declarations(css, ".sidebar__row:has(> .sidebar__item .sidebar__item-role) > .sidebar__row-acts")).toEqual([]);
  expect(value('.sidebar[data-rail="true"] .sidebar__row-acts', "display")).toBe("none");
});

test("a closed group of agents keeps in sight who works, waits or wrote; pinned rows end with a little space, no line, and their pin shows on hover", () => {
  expect(
    value('.sidebar__section--group[data-open="false"] .sidebar__section-body > [data-live="true"]', "display"),
  ).toBe("flex");
  expect(value(".sidebar__pins-end", "border-top")).toBeUndefined();
  // At rest the pin is hidden; it shows with the row's hover or focus, and always on a touch screen.
  expect(declarations(css, ".sidebar__pinned").find(([p]) => p === "opacity")?.[1]).toBe("0");
  expect(value(".sidebar__item:is(:hover, :focus-visible) .sidebar__pinned", "opacity")).toBe("1");
  // The `@media (hover: none)` override comes last.
  expect(value(".sidebar__pinned", "opacity")).toBe("1");
  expect(
    value('.sidebar:not([data-rail="true"]) .sidebar__section--part[data-open="false"] ~ .sidebar__see-all', "display"),
  ).toBe("none");
});

test("the right hand stays in sight in a closed Agentes, a plain row like any agent's", () => {
  expect(value('.sidebar__section[data-open="false"] .sidebar__section-body > [data-right-hand]', "display")).toBe(
    "flex",
  );
  expect(declarations(css, '.sidebar__item[data-right-hand]:not([data-status="active"])')).toEqual([]);
  expect(declarations(css, '.sidebar__item[data-right-hand]:not([data-status="active"]):hover')).toEqual([]);
});

test("a row's hidden hover buttons don't catch the pointer, so a drag over a row's end lands before or after it", () => {
  const shown = '.sidebar__row[data-acts]:is(:hover, :focus-within, :has([data-state="open"])) > .sidebar__row-acts';
  expect([value(".sidebar__row-acts", "pointer-events"), value(shown, "pointer-events")]).toEqual(["none", "auto"]);
});

test("over a row's hover button the row keeps its plate, and the button lights its ink only, no square of its own", () => {
  const row = '.sidebar__row:hover > .sidebar__item:not([data-status="active"], .sidebar__item--unshown)';
  expect(value(row, "background")).toBe(value(".sidebar__item:hover", "background"));
  expect(value(".sidebar__row-acts .ac-btn--ghost", "color")).toBe("var(--ink-muted)");
  const lit = '.sidebar__row-acts .ac-btn--ghost:is(:hover, [data-state="open"])';
  expect([value(lit, "background"), value(lit, "color")]).toEqual(["transparent", "var(--ink)"]);
});

test("the open row is one solid plate (no sky, no glow), hover its lighter step, both from the sidebar's tokens", () => {
  const active = '.sidebar__item[data-status="active"]';
  expect(value(active, "background")).toBe("var(--side-chosen)");
  const all = declarations(css, active).concat(declarations(css, `${active}::before`));
  expect(
    all.some(([p, v]) => p.startsWith("background-image") || v.includes("--sel-sky") || v.includes("--sel-glow")),
  ).toBe(false);
  expect(value(".sidebar__item:hover", "background")).toBe("var(--side-hover)");
  // The open channel's own buttons stay in sight on it.
  expect(value('.sidebar__row:has(> [data-status="active"]) > .sidebar__row-acts', "opacity")).toBe("1");
});

test("a channel: gray when read, full ink and bold with the edge pill when unread, the red count only for mentions", () => {
  const channel = '.sidebar__item[data-kind="channel"]';
  expect(value(`${channel} .sidebar__item-label`, "color")).toBe("var(--faint)");
  const unread = `${channel}[data-unread="true"]`;
  expect([
    value(`${unread} .sidebar__item-label`, "color"),
    value(`${unread} .sidebar__item-label`, "font-weight"),
  ]).toEqual(["var(--ink)", "650"]);
  const pill = `${unread}::before`;
  expect([value(pill, "left"), value(pill, "width"), value(pill, "height"), value(pill, "background")]).toEqual([
    "-12px",
    "4px",
    "8px",
    "var(--ink)",
  ]);
  expect([value(".sidebar__unread", "background"), value(".sidebar__unread", "color")]).toEqual([
    "var(--danger)",
    "var(--raised)",
  ]);
  // A category's name is in normal case, 13px and muted, quieter than any unread channel; a part's title too.
  const label = ".sidebar__section--category .sidebar__section-head .sidebar__label";
  expect([value(label, "font-size"), value(label, "color")]).toEqual(["13px", "var(--muted)"]);
  const part = ".sidebar__section--part .sidebar__section-head .sidebar__label";
  expect([value(part, "text-transform"), value(part, "font-size"), value(part, "color")]).toEqual([
    "none",
    "13px",
    "var(--muted)",
  ]);
});

test("you and the bell in one raised card, a plate each inside its curve; the bell's unread count red on its corner", async () => {
  // Raised, e1, its corner 14 and its padding 4: each plate's corner is 14 less 4, so it follows the card's curve.
  const card = ".sidebar__me";
  expect(["padding", "border-radius", "background", "box-shadow"].map((p) => value(card, p))).toEqual([
    "4px",
    "14px",
    "var(--raised)",
    "var(--e1)",
  ]);
  expect([value(".sidebar__me > .sidebar__user", "border-radius"), value(".sidebar__bell", "border-radius")]).toEqual([
    "10px",
    "10px",
  ]);
  // 40 wide and the card's inside tall on every pointer: no touch size of its own.
  expect([value(".sidebar__bell", "width"), value(".sidebar__bell", "align-self")]).toEqual([
    "var(--control-h-md)",
    "stretch",
  ]);
  expect(declarations(css, '.sidebar:not([data-rail="true"]) .sidebar__bell')).toEqual([]);
  // The count on the glyph's corner, where the rail's tiles put theirs, cut from it by a ring in the card's color.
  const count = '.sidebar:not([data-rail="true"]) .sidebar__bell > .sidebar__unread';
  const corner = ["position", "top", "right"];
  expect(corner.map((p) => value(count, p))).toEqual(["absolute", "2px", "0"]);
  expect(corner.map((p) => value('.sidebar[data-rail="true"] .sidebar__unread', p))).toEqual(["absolute", "2px", "0"]);
  expect(value(count, "box-shadow")).toBe("0 0 0 2px var(--raised)");
  // The rail keeps two of its 40px tiles on the sidebar's paper, and the face's presence ring in the paper's color.
  const rail = '.sidebar[data-rail="true"] .sidebar__me';
  expect(["background", "box-shadow", "padding"].map((p) => value(rail, p))).toEqual(["transparent", "none", "0"]);
  expect(value('.sidebar[data-rail="true"] .sidebar__user', "border-radius")).toBe("var(--control-r-md)");
  const presence = await Bun.file(join(import.meta.dir, "../src/components/presence.css")).text();
  expect(declarations(presence, '.sidebar:not([data-rail="true"]) .sidebar__me')).toEqual([
    ["--presence-ring", "var(--raised)"],
  ]);
});

test("every role mark is a full circle", async () => {
  const ui = await Bun.file(join(import.meta.dir, "../../../packages/ui/src/styles/components.css")).text();
  expect(declarations(ui, ".ac-rolemark").findLast(([p]) => p === "border-radius")?.[1]).toBe("50%");
});

test("Personalizar: a tool's line has four columns, its arrows one group 8 apart, on a phone on its first line", () => {
  expect(value(".sidebar-setup", "grid-template-columns")).toBe("auto 1fr auto");
  const first = declarations(css, ".sidebar-setup").find(([p]) => p === "grid-template-columns")?.[1];
  expect(first?.split(/ (?![^(]*\))/)).toHaveLength(4);
  expect(value(".sidebar-setup__moves", "gap")).toBe("var(--space-2)");
  expect(value(".sidebar-setup__row > .ac-seg", "grid-column")).toBe("2 / -1");
});

test("New agent's empty face is the agents' own: their size token in each mode and on the rail, their radius and gap (ADR 0164)", async () => {
  // The tokens: a team's agents have a message's face, a personal workspace's plain list 40, the rail 28.
  expect(value(".sidebar", "--sidebar-agent-face")).toBe("var(--name-face)");
  expect(value(".sidebar[data-personal]", "--sidebar-agent-face")).toBe("40px");
  // The agents' faces read the token: a team's rows and a personal workspace's plain list.
  const agentFace =
    '.sidebar:not([data-rail="true"]) :is([data-agent-row] > .sidebar__item, .sidebar__item[data-right-hand]) > .ac-avatar--sm';
  const plainFace =
    '.sidebar:not([data-rail="true"]) .sidebar__agents-plain :is([data-agent-row] > .sidebar__item, .sidebar__item[data-right-hand]) > .ac-avatar--sm';
  for (const face of [agentFace, plainFace])
    expect([value(face, "width"), value(face, "height")]).toEqual([
      "var(--sidebar-agent-face)",
      "var(--sidebar-agent-face)",
    ]);
  // New agent's tile reads the same tokens, never a number of its own.
  const tile = ".sidebar__new-agent-face";
  const fullTile = '.sidebar:not([data-rail="true"]) .sidebar__new-agent-face';
  expect([value(tile, "width"), value(tile, "height")]).toEqual([
    "var(--sidebar-rail-face)",
    "var(--sidebar-rail-face)",
  ]);
  expect([value(fullTile, "width"), value(fullTile, "height")]).toEqual([
    "var(--sidebar-agent-face)",
    "var(--sidebar-agent-face)",
  ]);
  // The framed tile's shape (radius 30% of the side), and as far from its name as an agent's face is from theirs.
  const kit = await Bun.file(join(import.meta.dir, "../../../packages/ui/src/styles/components.css")).text();
  const framed = declarations(kit, ".ac-avatar.ac-avatar--framed").findLast(([p]) => p === "border-radius")?.[1];
  expect(value(tile, "border-radius")).toBe(framed);
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__new-agent', "gap")).toBe("var(--sidebar-agent-gap)");
  expect(
    value(
      '.sidebar:not([data-rail="true"]) :is([data-agent-row] > .sidebar__item, .sidebar__item[data-right-hand])',
      "gap",
    ),
  ).toBe("var(--sidebar-agent-gap)");
});
