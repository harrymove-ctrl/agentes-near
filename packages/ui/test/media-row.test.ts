import { describe, expect, test } from "bun:test";

const css = (await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text()).replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
/** Every rule as [selector, body], at-rule blocks included. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [(m[1] ?? "").trim(), m[2] ?? ""] as const);
const body = (selector: string) =>
  rules
    .filter(([s]) => s === selector)
    .map(([, b]) => b)
    .join(";");

describe("MediaRow", () => {
  test("the face, then the name and the role on its line, the rest under them at the row's full width", () => {
    expect(body(".ac-mediarow")).toContain("grid-template-columns: auto minmax(0, 1fr) auto;");
    // Stretched beside a taller card (Agentes trabalhando agora), its lines stay at its top.
    expect(body(".ac-mediarow")).toContain("align-content: start;");
    expect(body(".ac-mediarow__face")).toContain("grid-area: 1 / 1;");
    expect(body(".ac-mediarow__head")).toContain("grid-area: 1 / 2;");
    expect(body(".ac-mediarow__end")).toContain("grid-area: 1 / 3;");
    expect(body(".ac-mediarow__body")).toContain("grid-column: 1 / -1;");
    // The name's line never pushes the row past its box: it wraps, its words too.
    expect(body(".ac-mediarow__head")).toContain("min-width: 0;");
    expect(body(".ac-mediarow__body")).toContain("min-width: 0;");
  });

  test("nothing puts the text in a column beside the face", () => {
    const beside = rules.filter(
      ([s, b]) => /\.ac-mediarow__body\b/.test(s) && /grid-(column|area)\s*:\s*(2|auto \/ 2)\b/.test(b),
    );
    expect(beside).toEqual([]);
  });

  test("a face of 32 in a card's head, 24 in a list row, 12 and 8 from the name", () => {
    // The card's head takes the one face size beside a name (`--name-face`, 32).
    expect(body(".ac-mediarow")).toContain("--mediarow-face: var(--name-face);");
    expect(body(":root")).toContain("--name-face: 32px;");
    expect(body(".ac-mediarow--row")).toContain("--mediarow-face: 24px;");
    expect(body(".ac-mediarow > .ac-mediarow__face > :not(svg)")).toContain("width: var(--mediarow-face);");
    expect(body(".ac-mediarow__face")).toContain("min-width: var(--mediarow-face);");
    expect(body(".ac-mediarow")).toContain("column-gap: var(--space-3);");
    expect(body(".ac-mediarow--row")).toContain("column-gap: var(--space-2);");
    expect(body(".ac-mediarow")).toContain("row-gap: var(--space-2);");
  });

  test("a wrapped head keeps its first line, and what ends it, on the face's middle", () => {
    expect(body(".ac-mediarow")).toContain("align-items: start;");
    expect(body(".ac-mediarow__head")).toContain(
      "padding-block-start: max(0px, calc((var(--mediarow-axis) - 20px) / 2));",
    );
    expect(body(".ac-mediarow__face")).toContain(
      "margin-block-start: calc((var(--mediarow-axis) - var(--mediarow-face)) / 2);",
    );
    expect(body(".ac-mediarow__end")).toContain("height: var(--mediarow-axis);");
    expect(body(".ac-mediarow")).toContain("--mediarow-axis: var(--mediarow-face);");
  });

  test("a button with its plate ending the name's line sets the line's axis, so it keeps the row's padding", () => {
    expect(
      body(".ac-mediarow:has(> .ac-mediarow__end :is(.ac-btn--sm:not(.ac-btn--ghost), .ac-select, .ac-seg))"),
    ).toContain("--mediarow-axis: max(var(--mediarow-face), var(--control-h-sm));");
    // Dropped under the words, it no longer sets it.
    const narrow = css.match(/@container \(max-width: 479px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).toContain(
      ".ac-mediarow:has(> .ac-mediarow__end--wrap) > :is(.ac-mediarow__face, .ac-mediarow__head)",
    );
    expect(narrow).toContain("--mediarow-axis: var(--mediarow-face);");
  });

  test("in a box under 480px, what ends the head drops under the text, at its start", () => {
    const narrow = css.match(/@container \(max-width: 479px\)\s*\{([\s\S]*?\})\s*\}/)?.[1] ?? "";
    expect(narrow).toContain(".ac-mediarow__end--wrap");
    expect(narrow).toContain("grid-area: auto / 1 / auto / -1;");
    expect(narrow).toContain("order: 1;");
    expect(narrow).toContain("justify-self: start;");
    expect(narrow).toContain("height: auto;");
    // Its buttons wrap among themselves rather than run past the row's edge.
    expect(narrow).toContain("flex-wrap: wrap;");
  });

  test("a glyph in a face's place keeps its size and the names in line; nothing under the name's line takes no room", () => {
    expect(body(".ac-mediarow__face")).toContain("min-width: var(--mediarow-face);");
    expect(body(".ac-mediarow__face")).toContain("justify-content: center;");
    expect(body(".ac-mediarow__body:empty")).toContain("display: none;");
    // A row of actions at the line's end keeps its own gap.
    expect(body(".ac-mediarow__end.ac-acts")).toContain("column-gap: calc(2 * var(--ghost-plate));");
  });

  test("it comes last in the kit's sheet, so a row it is mixed with (a list row, an option) takes its grid", () => {
    const last = css.lastIndexOf(".ac-mediarow {");
    for (const other of [".ac-list__row {", ".ac-option {", ".ac-faceline {"])
      expect(css.lastIndexOf(other)).toBeLessThan(last);
  });

  test("a task's number reads inline in its title's words, muted, in even figures", () => {
    expect(body(".ac-mediarow__num")).toContain("font-variant-numeric: tabular-nums;");
    expect(body(".ac-mediarow__meta,\n.ac-mediarow__num")).toContain("color: var(--ink-muted);");
  });
});
