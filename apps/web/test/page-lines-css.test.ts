import { expect, test } from "bun:test";
import { join } from "node:path";
import { builtCss, declarations, topLevel } from "./built-css";

const ROOT = join(import.meta.dir, "../../..");
const LAYOUT = join(ROOT, "apps/web/src/layout.css");
const KIT = join(ROOT, "packages/ui/src/styles/components.css");

/**
 * The rules of every `@media` block where Settings' sections are the strip above the page (940px and under: tablets
 * and phones) or the phone layout (760px and under), in order, as one sheet.
 */
const phoneRules = (css: string) =>
  [
    ...css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(
        /@media\s*\((?:max-width:\s*(?:760|940)px|width\s*<=\s*(?:760|940)px)\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g,
      ),
  ]
    .map((m) => m[1] ?? "")
    .join("\n");

/** Declarations as `property:value`, spaces out: the minifier drops the ones it may. */
const squeeze = (list: (readonly [string, string])[]) => list.map(([p, v]) => `${p}:${v.replace(/\s+/g, "")}`);

test("the built stylesheet keeps what places the Settings header, the bucket's hints and the card heads' keys", async () => {
  const css = await builtCss();
  const shipped = topLevel(css);
  // Over the phone's strip the header leaves the desktop nav's inset: it starts on the gutter, as the page's title does.
  expect(declarations(phoneRules(css), ".settings__head")).toContainEqual(["padding", "0"]);
  expect(declarations(phoneRules(await Bun.file(LAYOUT).text()), ".settings__head")).toContainEqual(["padding", "0"]);
  // Every declaration the source writes for these ships as written.
  const sources: [string, string[]][] = [
    [LAYOUT, [".grid-fields--wide", ".page__header > p", ".page__header-text > p", ".key-row", ".key-row__tail"]],
    [
      KIT,
      [
        ".ac-card__lead",
        ".ac-card__key",
        ".ac-card__head:not(:has(.ac-card__sub)) .ac-card__key",
        ".ac-card__head:not(:has(.ac-card__sub)) .ac-card__key + .ac-card__heading",
        ".ac-captail",
        ".ac-optrow__desc",
        ".ac-card__sub",
        ".ac-field__example",
      ],
    ],
  ];
  for (const [file, selectors] of sources) {
    const source = topLevel(await Bun.file(file).text());
    for (const selector of selectors) {
      const written = squeeze(declarations(source, selector));
      expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
      expect({ selector, shipped: squeeze(declarations(shipped, selector)) }).toEqual({
        selector,
        shipped: expect.arrayContaining(written),
      });
    }
  }
  // A key keeps its title's first line, however the title wraps: lifted by the capitals' middle from a 22px box.
  expect(declarations(shipped, ".ac-card__head:not(:has(.ac-card__sub)) .ac-card__key")).toContainEqual([
    "translate",
    "0 calc(-1 * var(--cap-mid))",
  ]);
  // Two columns of at least 280px: the endpoint's and the folder's hints keep one line each.
  expect(declarations(shipped, ".grid-fields--wide")).toContainEqual([
    "grid-template-columns",
    "repeat(auto-fit,minmax(min(100%,280px),1fr))",
  ]);
  // A template's tile and its name and line sit centred on one row (Do zero's too).
  expect(declarations(shipped, ".newag__role-head")).toContainEqual(["align-items", "center"]);
  // No word alone on a description's last line.
  for (const selector of [
    ".ac-optrow__desc",
    ".ac-card__sub",
    ".ac-field__example",
    ".catalog-feat__desc",
    ".catalog-tile__desc",
    ".newag__role-desc",
    ".newag__role--blank .newag__role-name span",
    ".onb__lead",
    ".page-sub",
    ".page__header > p",
    ".page__header-text > p",
  ])
    expect({ selector, wrap: declarations(shipped, selector).find(([p]) => p === "text-wrap")?.[1] }).toEqual({
      selector,
      wrap: "pretty",
    });
});

test("the built page sheets keep a plan's name and chip on its tile's line and the export's line whole", async () => {
  const sheets: [string, string[]][] = [
    ["src/components/plan-usage.css", [".plan-acct", ".plan-acct__name", ".plan-acct__chip"]],
    ["src/components/import-flow.css", [".imp-note"]],
  ];
  for (const [file, selectors] of sheets) {
    const source = topLevel(await Bun.file(join(ROOT, "apps/web", file)).text());
    const shipped = topLevel(await builtCss(file));
    for (const selector of selectors) {
      const written = squeeze(declarations(source, selector));
      expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
      expect({ selector, shipped: squeeze(declarations(shipped, selector)) }).toEqual({
        selector,
        shipped: expect.arrayContaining(written),
      });
    }
  }
  const plans = topLevel(await builtCss("src/components/plan-usage.css"));
  // The face line's own rules lay the head out: none here may put the tile back in the block's middle.
  expect(declarations(plans, ".plan-acct").map(([p]) => p)).toEqual(["min-width"]);
  // The chip flows after the name's last word: a wrapped name ends on a word and the chip, never a word alone.
  expect(declarations(plans, ".plan-acct__name")).toContainEqual(["text-wrap", "balance"]);
  expect(declarations(plans, ".plan-acct__name").map(([p]) => p)).not.toContain("display");
  // The export card's line on what never goes in the file ends on two words at 360, not "conversas." alone.
  expect(declarations(topLevel(await builtCss("src/components/import-flow.css")), ".imp-note")).toContainEqual([
    "text-wrap",
    "pretty",
  ]);
});
