import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = (path: string) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const layout = css("layout.css");

/** Every block of `selector`, exactly as written. */
const blocks = (sheet: string, selector: string) =>
  [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
    .map((m) => m[2])
    .join("\n");

describe("dialogs laid out on the form's rhythm", () => {
  test("Outro provedor: a list's label tight to its rows, the rows closer to each other than fields are", () => {
    expect(blocks(layout, ".endpoint-models")).toContain("gap: var(--space-2);");
    expect(blocks(layout, ".endpoint-models > .ac-field__label")).toContain(
      "margin-block-end: calc(var(--field-gap) - var(--space-2));",
    );
  });

  test("a channel's permissions stand under its roles, so their words keep the column", () => {
    expect(blocks(layout, ".channel-perms__grid")).toContain("flex-direction: column;");
    expect(blocks(layout, ".channel-perms__targets")).not.toContain("168px");
  });

  test("the table editor: each row's × centred on its fields, the header's tone over that column too", () => {
    expect(blocks(layout, ".artifact-table--edit td")).toContain("vertical-align: middle;");
    expect(blocks(layout, ".artifact-table thead td")).toContain("background: var(--surface-sunken);");
  });

  test("on the narrowest phones every tool level stays in its track, and a widget's parts wrap", () => {
    expect(blocks(layout, ".tr-seg .ac-toolpx-swatch")).toContain("display: none;");
    expect(blocks(css("pages/dashboards.css"), ".nwc-pks")).toContain("flex-wrap: wrap;");
  });

  test("Personalizar a barra lateral: every row's Segmented fills the same column", () => {
    const source = readFileSync(new URL("../src/components/SidebarSetup.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<Segmented\s+block\s/);
    expect(blocks(layout, ".sidebar-setup__row > .ac-seg")).not.toContain("justify-self");
  });
});
