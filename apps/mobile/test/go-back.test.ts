import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );

test("leaving a screen goes back where it was opened from through one helper (`goBack`, its fallback when nothing is under it)", () => {
  const own = join(SRC, "ui/navigation.tsx");
  const twins = files(SRC).filter(
    (f) =>
      f !== own && /router\.canGoBack\(\)\s*\?\s*router\.back\(\)\s*:\s*router\.replace/.test(readFileSync(f, "utf8")),
  );
  expect(twins).toEqual([]);
  const helper = readFileSync(own, "utf8");
  expect(helper).toContain('export function goBack(fallback: Href = "/")');
});
