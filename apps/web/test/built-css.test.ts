import { expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import { build } from "vite";

const WEB = join(import.meta.dir, "..");
const ROOT = join(WEB, "../..");

/** The app's stylesheet as the production build writes it: Vite's own CSS pipeline (its minifier and targets). */
async function builtCss() {
  const out = await build({
    configFile: false,
    logLevel: "silent",
    root: WEB,
    build: { write: false, rollupOptions: { input: join(WEB, "src/styles.css") } },
  });
  return (Array.isArray(out) ? out : [out])
    .flatMap((o) => ("output" in o ? o.output : []))
    .flatMap((o) => (o.type === "asset" && o.fileName.endsWith(".css") ? [String(o.source)] : []))
    .join("\n");
}

const normal = (selector: string) =>
  selector
    .replace(/\s*([>+~,])\s*/g, "$1")
    .replace(/="([^"]*)"/g, "=$1")
    .replace(/::(before|after)\b/g, ":$1")
    .replace(/\s+/g, " ")
    .trim();

/** The rules of every `@media (<feature>: <value>)` block, in order, as one sheet. */
const mediaRules = (css: string, feature: string, value: string) =>
  [
    ...css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(new RegExp(`@media\\s*\\(${feature}:\\s*${value}\\)\\s*\\{((?:[^{}]*\\{[^{}]*\\})*[^{}]*)\\}`, "g")),
  ]
    .map((m) => m[1] ?? "")
    .join("\n");
const touchRules = (css: string) => mediaRules(css, "pointer", "coarse");

/** A selector list's selectors: its commas outside parentheses (`:not(a, b)` is one). */
function selectorsOf(list: string) {
  const s = normal(list);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, s.slice(start)];
}

/** The declarations of every rule whose selector list holds `selector`, in order, as [property, value]. */
function declarations(css: string, selector: string) {
  const wanted = normal(selector);
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => selectorsOf(m[1] ?? "").includes(wanted))
    .flatMap((m) =>
      (m[2] ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as const),
    );
}

/** A `translateY()`'s offset as its px and % parts ("calc(4px - 50%)" → 4px and -50%). */
function offsetY(transform: string | undefined) {
  const inner = transform?.match(/^translateY\((.*)\)$/)?.[1] ?? "";
  const terms = inner
    .replace(/^calc\((.*)\)$/, "$1")
    .replace(/\s+-\s+/g, " +-")
    .split(/\s+\+/);
  const sum = (unit: string) =>
    terms.filter((t) => t.trim().endsWith(unit)).reduce((n, t) => n + Number.parseFloat(t.replace(/\s/g, "")), 0);
  return { px: sum("px"), pct: sum("%") };
}

test("the built stylesheet keeps the hover bar placed by its middle, 4px lower at rest, and the hint line's flow", async () => {
  const css = await builtCss();
  // At rest and shown, as the kit declares them (components.test.tsx): a translate beside the transform would be
  // dropped by the minifier, and the bar would hang half its height lower.
  const transform = (selector: string) =>
    declarations(css, selector)
      .filter(([p]) => p === "transform")
      .at(-1)?.[1];
  expect(offsetY(transform(".ac-msg__actions"))).toEqual({ px: 4, pct: -50 });
  for (const shown of [
    ".ac-msg:hover .ac-msg__actions",
    "html:not([data-pointer]) .ac-msg:focus-within .ac-msg__actions",
    '.ac-msg__actions[data-open="true"]',
    '.ac-msg__actions:has([aria-expanded="true"])',
  ])
    expect(offsetY(transform(shown))).toEqual({ px: 0, pct: -50 });
  expect(declarations(css, ".ac-msg__actions").filter(([p]) => p === "translate")).toEqual([]);
  // Every declaration of the hint line's rules is in the build as the kit wrote it.
  const kit = await Bun.file(join(ROOT, "packages/ui/src/styles/components.css")).text();
  for (const selector of [
    ".ac-hintline",
    ".ac-hintline:not(:has(> .ac-hint))",
    ".ac-hintline > :first-child:not(.ac-hint)",
    ".ac-hintline > .ac-hint",
  ]) {
    const source = declarations(kit, selector);
    expect(source.length).toBeGreaterThan(0);
    expect(declarations(css, selector)).toEqual(expect.arrayContaining(source));
  }
});

test("the built stylesheet keeps the bar's 32px plates on touch, the small buttons' 44px targets, and the receipt dot's room", async () => {
  const css = await builtCss();
  const kit = await Bun.file(join(ROOT, "packages/ui/src/styles/components.css")).text();
  const [built, source] = [touchRules(css), touchRules(kit)];
  // The bar's 26px plates grow to the 32 every small button keeps on touch; each one's target grows to 44 past it.
  for (const selector of [".ac-msg__actions", ".ac-btn--sm::after", ".ac-btn--sm.ac-btn--icon::after"]) {
    expect(declarations(source, selector).length).toBeGreaterThan(0);
    expect(declarations(built, selector)).toEqual(expect.arrayContaining(declarations(source, selector)));
  }
  // No touch rule grows a small button's plate past its 32.
  expect(declarations(built, ".ac-btn--sm").filter(([p]) => /^min-(height|width)$/.test(p))).toEqual([]);
  // A receipt's words wrap on their own column, and a dot and its action as one piece.
  for (const selector of [
    ".ac-receipt",
    ".ac-receipt__words",
    ".ac-receipt__words > :first-child",
    ".ac-receipt__words > .ac-hintline:first-child",
    ".ac-receipt__then",
  ]) {
    expect(declarations(kit, selector).length).toBeGreaterThan(0);
    expect(declarations(css, selector)).toEqual(expect.arrayContaining(declarations(kit, selector)));
  }
  expect(declarations(css, ".ac-receipt").filter(([p]) => p === "flex-wrap")).toEqual([]);
});

test("the built stylesheet keeps touch's bar for the keyboard only, and the lit row of an open menu", async () => {
  const css = await builtCss();
  const kit = await Bun.file(join(ROOT, "packages/ui/src/styles/components.css")).text();
  const hidden =
    '.ac-msg:is(:hover, :focus-within):not(:has(:focus-visible:not(:read-write))) .ac-msg__actions:not([data-open="true"], :has([aria-expanded="true"]))';
  const [built, source] = [mediaRules(css, "hover", "none"), mediaRules(kit, "hover", "none")];
  expect(declarations(source, hidden)).toEqual([
    ["opacity", "0"],
    ["pointer-events", "none"],
  ]);
  expect(declarations(built, hidden)).toEqual(declarations(source, hidden));
  const lit = '.ac-msg[data-menu-open="true"]';
  expect(declarations(kit, lit).length).toBeGreaterThan(0);
  expect(declarations(css, lit)).toEqual(expect.arrayContaining(declarations(kit, lit)));
  // The menu's reactions are 40px targets on touch, as its items are, and the last one's two icons sit side by side.
  expect(declarations(touchRules(kit), ".ac-menu__reaction").length).toBeGreaterThan(0);
  expect(declarations(touchRules(css), ".ac-menu__reaction")).toEqual(
    expect.arrayContaining(declarations(touchRules(kit), ".ac-menu__reaction")),
  );
  const more = ".ac-menu__reaction--more";
  expect(declarations(kit, more).length).toBeGreaterThan(0);
  expect(declarations(css, more)).toEqual(expect.arrayContaining(declarations(kit, more)));
});

test("the built stylesheet keeps a tip on the floating layer, fixed to the window, a word too long for it broken inside", async () => {
  const tip = declarations(await builtCss(), ".ac-tip");
  for (const kept of [
    ["position", "fixed"],
    ["z-index", "var(--z-floating)"],
    ["max-width", "calc(100vw - 24px)"],
    ["overflow-wrap", "anywhere"],
    ["pointer-events", "none"],
  ] as const)
    expect(tip).toContainEqual(kept);
});

test("no rule sets translate, rotate or scale beside transform: the build's minifier drops or merges them", async () => {
  const pairs: string[] = [];
  for (const dir of ["apps/web/src", "packages/ui/src", "apps/desktop/src"])
    for await (const file of new Glob("**/*.css").scan(join(ROOT, dir))) {
      const css = await Bun.file(join(ROOT, dir, file)).text();
      for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const props = [...(m[2] ?? "").matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((p) => p[1]);
        if (props.includes("transform") && props.some((p) => p === "translate" || p === "rotate" || p === "scale"))
          pairs.push(`${dir}/${file}: ${(m[1] ?? "").trim()}`);
      }
    }
  expect(pairs).toEqual([]);
});
