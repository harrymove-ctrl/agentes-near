import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
/** The surfaces where a literal color once broke a theme: the agent's browser, its computer and its desktop. */
const SURFACES = [
  "apps/web/src/components/browser",
  "apps/web/src/components/computer",
  "apps/web/src/components/desktop",
];

describe("the browser, computer and desktop surfaces take their colors from the theme", () => {
  test("no hex color in their stylesheets: what looks the same in both themes is a token, defined once", async () => {
    const found: string[] = [];
    for (const dir of SURFACES)
      for (const name of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".css"))) {
        const css = (await Bun.file(join(ROOT, dir, name)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
        for (const declaration of css.split(/[;{}]/))
          if (/#[0-9a-f]{3,8}\b/i.test(declaration)) found.push(`${dir}/${name}: ${declaration.trim()}`);
      }
    expect(found).toEqual([]);
    const tokens = await Bun.file(join(ROOT, "packages/ui/src/styles/tokens.css")).text();
    for (const token of [
      "--site-paper",
      "--site-blank",
      "--site-ink",
      "--frame-ink",
      "--frame-control-a",
      "--frame-control-b",
      "--mac-accent",
      "--mac-accent-ink",
      "--screen-bg",
    ])
      expect(tokens.match(new RegExp(`${token}: #[0-9a-f]+;`, "g"))).toHaveLength(1);
  });
});
