import { expect, test } from "bun:test";
import path from "node:path";
import { builtCss, declarations, topLevel } from "./built-css";

const SRC = path.join(import.meta.dir, "../src");
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a settings row's title line is one text line, and one gap token sits under it and between the row's parts", async () => {
  const css = await builtCss("src/styles.css", "src/components/ai-apps.css");
  const top = topLevel(css);
  expect(last(top, ":root", "--list-part-gap")).toBe("10px");
  // The pill is as tall as the line it sits on, so the title line keeps the text's height.
  expect(last(top, "body", "line-height")).toBe("22px");
  expect(last(top, ".ac-chip", "height")).toBe("22px");
  expect(last(top, ".list-title", "align-items")).toBe("center");
  expect(last(top, ".list-title:not(:last-child)", "margin-block-end")).toBe("var(--list-part-gap)");
  // The rows are MediaRows: the leading tile and the name share one line, the details, who uses it and the actions go
  // under them at the row's width (the kit's `.ac-mediarow`), so no page sheet lays the rows out on its own.
  for (const row of [".connected-row", ".app-row", ".machine-row"]) {
    for (const p of ["display", "grid-template-columns", "align-items", "gap", "column-gap"])
      expect(last(top, row, p)).toBeUndefined();
  }
  // Nothing else adds to the gap under the title: the details' column and the other lists' columns have none.
  for (const col of [".list-col", ".connected-row__text"]) {
    expect(last(top, col, "gap")).toBeUndefined();
  }
  // The details wrap whole: no "…" that hides what they say.
  expect(last(top, ".connected-row__text>.small", "text-overflow")).toBeUndefined();
  expect(last(top, ".connected-row__text", "overflow-wrap")).toBe("anywhere");
  expect(last(top, ".connected-row__actions", "grid-column")).toBeUndefined();
});

test("every settings list with a name and pills uses the shared title line", async () => {
  for (const file of [
    "components/Connectors.tsx",
    "components/MailConnect.tsx",
    "components/DatabaseConnect.tsx",
    "components/GitHubAppPanel.tsx",
    "components/Machines.tsx",
    "components/AiApps.tsx",
    "components/vault/VaultConnections.tsx",
  ]) {
    const source = await Bun.file(path.join(SRC, file)).text();
    expect(source).toContain('className="list-title');
    expect(source).not.toContain("connected-row__name");
    expect(source).not.toContain("app-row__title");
  }
});

test("Calendar's and Routines' lists show their words whole: they wrap, never end in a \"…\" that hides them", async () => {
  const top = topLevel(await builtCss("src/pages/routines.css", "src/pages/calendar.css"));
  for (const selector of [
    ".routine-row__title",
    ".routine-row__sub",
    ".routine-row__to>span",
    ".routine-row__when-text b",
    ".routine-row__when-text small",
    ".routine-row__runs small",
    ".routines-horizon__label b",
    ".cal-band__label b",
  ]) {
    expect([selector, last(top, selector, "text-overflow")]).toEqual([selector, undefined]);
    expect([selector, last(top, selector, "white-space")]).toEqual([selector, undefined]);
  }
  // Who and where it delivers keeps the row's width: its chips and its fix go under the words when there's no room.
  expect(last(top, ".routine-row__sub", "flex-wrap")).toBe("wrap");
  // A lane grows with its name, the routine's line on its middle.
  expect(last(top, ".routines-horizon__label", "height")).toBeUndefined();
  expect(last(top, ".routines-horizon__track", "align-self")).toBe("center");
  expect(last(top, ".cal-band__label", "height")).toBeUndefined();
  // An event's title wraps wherever it shows (a block, a row, a bar): no nowrap, no "…", a long word broken.
  expect(last(top, ".cal-chip__title", "white-space")).toBeUndefined();
  expect(last(top, ".cal-chip__title", "text-overflow")).toBeUndefined();
  expect(last(top, ".cal-chip", "overflow-wrap")).toBe("anywhere");
});
