import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");

describe("modals", () => {
  // A modal is portrait unless it says otherwise, and iOS aborts when one opens over a view lying down (`useSideways`).
  test("every modal can open with the phone sideways", () => {
    const files = [...new Bun.Glob("**/*.tsx").scanSync(SRC)];
    const modals = files.flatMap((file) =>
      [...readFileSync(join(SRC, file), "utf8").matchAll(/<Modal\b[^>]*>/g)].map((m) => ({ file, tag: m[0] })),
    );
    expect(modals.length).toBeGreaterThan(0);
    for (const { file, tag } of modals) expect(`${file}: ${tag}`).toContain("landscape");
  });
});
