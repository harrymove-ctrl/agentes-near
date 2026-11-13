import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });

describe("every agent avatar goes through AgentAvatar", () => {
  test('no <Avatar kind="agent"> (or a dynamic kind) outside components/AgentAvatar.tsx', () => {
    const offenders = files(SRC)
      .filter((f) => !f.endsWith(join("components", "AgentAvatar.tsx")))
      .flatMap((f) => {
        const text = readFileSync(f, "utf8");
        const hits = [...text.matchAll(/<Avatar\b[^>]*?\bkind=(?:"agent"|\{)/gs)];
        return hits.map((m) => `${relative(SRC, f)}:${text.slice(0, m.index).split("\n").length}`);
      });
    expect(offenders).toEqual([]);
  });
});
