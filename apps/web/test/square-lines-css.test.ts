import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const read = (file: string) => Bun.file(join(import.meta.dir, "../src", file)).text();
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a square never keeps a column beside three lines: its line under it at the row's width", async () => {
  const layout = await read("layout.css");
  const routines = await read("pages/routines.css");
  // Criar agente's Do zero: the tile on the name's line, its line under both.
  const blank = topLevel(layout);
  expect(last(blank, ".newag__role--blank .newag__role-head", "display")).toBe("grid");
  expect(last(blank, ".newag__role--blank .newag__role-name", "display")).toBe("contents");
  expect(last(blank, ".newag__role--blank .newag__role-name span", "grid-column")).toBe("1 / -1");
  // Nova rotina: the apps' logos lead the sentence on its first line, its later lines under them.
  const needs = topLevel(routines);
  expect(last(needs, ".routine-needs", "display")).toBeUndefined();
  expect(last(needs, ".routine-needs > .connector-icon", "vertical-align")).toBe("middle");
  // A prepared run on a phone, and the agent page's person on a phone: the icon or the face on the title's line.
  const runs = atRule(routines, "@media (max-width: 640px)");
  expect(last(runs, ".routine-ahead__item", "display")).toBe("grid");
  expect(last(runs, ".routine-ahead__item small", "grid-column")).toBe("1 / -1");
  const phone = atRule(layout, "@media (max-width: 640px)");
  expect(last(phone, ".agp-person:has(> .agp-person__t > span)", "display")).toBe("grid");
  expect(last(phone, ".agp-person > .agp-person__t > span", "grid-column")).toBe("1 / -1");
  // A settings line that opens something, with a status: the chevron on the name's line, the status under them at the
  // row's width, a step from the icon.
  const rows = atRule(layout, "@media (max-width: 760px)");
  const open = ".settings-row--lead.settings-row--open:has(> .settings-row__text > .settings-row__status)";
  expect(last(rows, open, "display")).toBe("grid");
  expect(last(rows, `${open} > .settings-row__chevron`, "grid-area")).toBe("1 / -2");
  expect(
    last(rows, ".settings-row--lead.settings-row--open > .settings-row__text > .settings-row__status", "grid-column"),
  ).toBe("1 / -1");
  expect(last(rows, open, "gap")).toBe("var(--space-2) var(--space-3)");
});
