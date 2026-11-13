import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [join(import.meta.dir, "../src/styles"), join(import.meta.dir, "../../../apps/web/src")];

/** The CSS outside every `@supports (animation-timeline…) { … }` block. */
function outsideSupports(css: string) {
  let out = "";
  let at = 0;
  for (;;) {
    const start = css.indexOf("@supports (animation-timeline", at);
    if (start < 0) return out + css.slice(at);
    out += css.slice(at, start);
    let depth = 0;
    let i = css.indexOf("{", start);
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    at = i + 1;
  }
}

test("a scroll-driven animation only where scroll timelines exist: elsewhere it would keep its last frame", async () => {
  const unguarded: string[] = [];
  for (const root of ROOTS)
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!file.endsWith(".css")) continue;
      const css = await Bun.file(join(root, file)).text();
      if (/animation-timeline\s*:/.test(outsideSupports(css))) unguarded.push(file);
    }
  expect(unguarded).toEqual([]);
});
