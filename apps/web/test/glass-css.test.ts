import { expect, test } from "bun:test";
import path from "node:path";
import { Glob } from "bun";

const ROOT = path.join(import.meta.dir, "../../..");
const SOURCES = ["apps/web/src", "packages/ui/src", "apps/desktop/src"];

interface Minifier {
  transform(options: { filename: string; code: Uint8Array; minify: boolean; targets: Record<string, number> }): {
    code: Uint8Array;
  };
}
// What `vite build` minifies with: Vite's own Lightning CSS, resolved through Vite so it is that very copy, at Vite's
// default targets (Safari 16.4 still takes the -webkit- name).
const vite = path.dirname(Bun.resolveSync("vite/package.json", path.join(ROOT, "apps/web")));
const { transform } = (await import(Bun.resolveSync("lightningcss", vite))) as Minifier;
const version = (major: number, minor = 0) => (major << 16) | (minor << 8);
const TARGETS = {
  chrome: version(111),
  edge: version(111),
  firefox: version(114),
  safari: version(16, 4),
  ios_saf: version(16, 4),
};

test("every glass keeps its blur in the built CSS, where a -webkit- twin after backdrop-filter replaced it", async () => {
  const lost: string[] = [];
  for (const dir of SOURCES) {
    for await (const file of new Glob("**/*.css").scan(path.join(ROOT, dir))) {
      const code = await Bun.file(path.join(ROOT, dir, file)).bytes();
      const built = new TextDecoder().decode(transform({ filename: file, code, minify: true, targets: TARGETS }).code);
      for (const block of built.match(/\{[^{}]*\}/g) ?? []) {
        if (block.includes("backdrop-filter") && !/[{;]backdrop-filter:/.test(block))
          lost.push(`${dir}/${file}: ${block}`);
      }
    }
  }
  expect(lost).toEqual([]);
});
