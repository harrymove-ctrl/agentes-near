import { expect, test } from "bun:test";
import { join } from "node:path";
import { builtCss, rules, topLevel } from "./built-css";

const WEB = join(import.meta.dir, "..");

/** Where each `@layer <name> {` block opens and closes in a stylesheet, outermost only. */
function layerBlocks(css: string) {
  const blocks: { name: string; start: number; end: number }[] = [];
  for (let at = css.indexOf("@layer"); at >= 0; at = css.indexOf("@layer", at + 1)) {
    const open = css.indexOf("{", at);
    const semi = css.indexOf(";", at);
    if (open < 0 || (semi >= 0 && semi < open)) continue;
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === "{") depth++;
      else if (css[end] === "}" && --depth === 0) break;
    }
    blocks.push({ name: css.slice(at + 6, open).trim(), start: open, end });
    at = end;
  }
  return blocks;
}

test("the kit and the app's base sheets share one cascade layer, so a page sheet beats them in any link order", async () => {
  const source = (await Bun.file(join(WEB, "src/styles.css")).text()).replace(/\/\*[\s\S]*?\*\//g, "");
  // The layer is named before any import, and the kit and the base sheets go into it in their order, so between them
  // specificity and order decide as before: a kit rule for a context still outranks a base sheet's general one.
  expect(source.trim().startsWith("@layer base;")).toBe(true);
  const imports = [...source.matchAll(/@import\s+"([^"]+)"([^;]*);/g)].map(([, file, rest]) => ({
    file,
    layer: rest?.match(/layer\((\w+)\)/)?.[1],
  }));
  const layered = imports.filter((i) => i.layer).map((i) => `${i.file} ${i.layer}`);
  expect(layered).toEqual([
    "@agenteschat/ui/styles.css base",
    "./layout.css base",
    "./responsive.css base",
    "./chat/looks.css base",
  ]);
  // Fonts stay unlayered (they hold only @font-face), and the app rules that must outrank a page sheet's own (the
  // desktop app's, written as `html[data-desktop] …` over the pages'); nothing else comes in without a layer.
  for (const i of imports.filter((i) => !i.layer))
    expect(i.file).toMatch(/^@fontsource-variable\/|^\.\/fonts\.css$|^\.\/desktop\.css$|^\.\/over-pages\.css$/);
});

test("the build keeps the layer: the kit's card and the base sheets inside it, a page sheet's rule outside", async () => {
  const css = (await builtCss("src/styles.css", "src/components/roles/roles.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = layerBlocks(css);
  const at = (selector: string) => {
    const i = css.indexOf(`${selector}{`);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  };
  const inside = (selector: string) => blocks.find((b) => at(selector) > b.start && at(selector) < b.end)?.name;
  expect(inside(".ac-card")).toBe("base");
  expect(inside(".page-title")).toBe("base");
  // The kit before the base sheets in it: a tie between them goes to the base sheet, as it always did.
  expect(at(".ac-card")).toBeLessThan(at(".page-title"));
  expect(inside(".roles-list")).toBeUndefined();
  // The app's rules that outrank a page's own (the split pages' layout) stand outside the layer, as page sheets do.
  expect(inside(".shell__main:has(.page-split)")).toBeUndefined();
});

test("what applies at every width keeps a layer's rules and drops its media blocks", () => {
  const css = "@layer base;@layer base{.a{color:red}@media (width<=720px){.b{color:blue}}}.c{color:green}";
  expect(topLevel(css)).toBe(".a{color:red}.c{color:green}");
});

test("a card that also stands in a message sets its own margins only outside one: inside, the kit's rhythm does", async () => {
  // The kit's `.ac-msg .ac-msg__body > *` sets the room around a message's parts, but any page rule beats a layered
  // one: a card's own vertical margins are scoped out of a message body, or they would add to the rhythm.
  const CARDS = [
    ".rq",
    ".brw-ac",
    ".mi-card",
    ".ag-rcs",
    ".iw-card",
    ".iw-chips",
    ".setup-cl",
    ".thread-context",
    ".cq-turn__say",
    ".tp-chips",
  ];
  const VERTICAL = /^margin(-top|-bottom|-block(-start|-end)?)?$/;
  const loose: string[] = [];
  for (const file of new Bun.Glob("src/**/*.css").scanSync(WEB)) {
    const css = await Bun.file(join(WEB, file)).text();
    for (const rule of rules(css))
      for (const selector of rule.selectors)
        if (
          CARDS.includes(selector) &&
          rule.declarations.some(([p, v]) => VERTICAL.test(p) && !/^0(px)?( 0(px)?)*$/.test(v))
        )
          loose.push(`${file} ${selector}`);
  }
  expect(loose).toEqual([]);
});
