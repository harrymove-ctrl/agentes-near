import { expect, test } from "bun:test";
import { join } from "node:path";
import { builtCss, declarations, topLevel } from "./built-css";

const LAYOUT = join(import.meta.dir, "../src/layout.css");

/** What places a step's button, and a failed sign-in's: under its words, on their column, at every width. */
const PLACEMENT = [
  ".agp-addacct",
  ".agp-addacct__step",
  ".agp-addacct__step.ac-iconline > .agp-addacct__text",
  ".agp-addacct__step.ac-iconline > :not(i, .agp-addacct__text)",
  ".agp-addacct__step:not(.ac-iconline) > .agp-addacct__text",
  ".agp-addacct > .ai-panel__row > .ac-setnote",
  ".agp-addacct > .ai-panel__row > :not(.ac-setnote)",
  ".ai-panel--plan .ai-panel__row > .ac-setnote",
  ".ai-panel--plan .ai-panel__row > :not(.ac-setnote)",
  ".ai-panel--plan > .grid-options--sm .ac-option__title",
];

test("the built stylesheet keeps a step's button under its words at every width, as the source writes it", async () => {
  const source = topLevel(await Bun.file(LAYOUT).text());
  const css = await builtCss();
  const shipped = topLevel(css);
  for (const selector of PLACEMENT) {
    const written = squeeze(declarations(source, selector));
    expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
    expect({ selector, shipped: squeeze(declarations(shipped, selector)) }).toEqual({
      selector,
      shipped: expect.arrayContaining(written),
    });
  }
  // The words take the row, so whatever follows them wraps under: in the build too, outside any media query.
  expect(declarations(shipped, ".agp-addacct__step")).toContainEqual(["flex-wrap", "wrap"]);
  // Nothing in what ships pulls a step's words down to a button beside them, at any width.
  expect(css).not.toMatch(/agp-addacct__step:has\(/);
  // A failed sign-in's buttons go under the note's words anywhere, and in a plan's panel after its 20px lead column:
  // the panel's rule, as specific, comes later.
  const at = (selector: string) => shipped.search(new RegExp(`(^|[}])[^{}]*${escaped(selector)}[^{}]*\\{`));
  const anywhere = at(".agp-addacct>.ai-panel__row>:not(.ac-setnote)");
  expect(anywhere).toBeGreaterThan(-1);
  expect(anywhere).toBeLessThan(at(".ai-panel--plan .ai-panel__row>:not(.ac-setnote)"));
  expect(declarations(shipped, ".agp-addacct > .ai-panel__row > :not(.ac-setnote)")).toContainEqual([
    "margin-left",
    "22px",
  ]);
  // Its lines never end on a word alone, in a plan's panel or out of one.
  expect(declarations(shipped, ".agp-addacct")).toContainEqual(["text-wrap", "pretty"]);
  // The account cards keep the check's room whether chosen or not: no state of theirs rewraps a title.
  expect(declarations(shipped, ".ai-panel--plan > .grid-options--sm .ac-option__title")).toContainEqual([
    "padding-right",
    "22px",
  ]);
});

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Declarations as `property:value`, spaces out: the minifier drops the ones it may. */
const squeeze = (list: (readonly [string, string])[]) => list.map(([p, v]) => `${p}:${v.replace(/\s+/g, "")}`);
