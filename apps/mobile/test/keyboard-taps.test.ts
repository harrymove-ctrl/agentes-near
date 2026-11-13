import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (file: string) => readFileSync(join(import.meta.dir, "../src", file), "utf8");
/** The props of each `<ScrollView …>` in a file. */
const scrollViews = (text: string) => [...text.matchAll(/<ScrollView\b([^>]*)>/g)].map((m) => m[1] ?? "");

test("a field in a scrolling screen: the button beside it takes the first tap with the keyboard up", () => {
  // The default budget (its Salvar) and an inbox reply on the island (its send).
  for (const file of ["features/usage/UsageScreen.tsx", "features/island/NoticeIsland.tsx"]) {
    const views = scrollViews(source(file));
    expect(views.length).toBeGreaterThan(0);
    for (const props of views) expect(props).toContain('keyboardShouldPersistTaps="handled"');
  }
  // And the budget's field scrolls up over the keyboard.
  expect(scrollViews(source("features/usage/UsageScreen.tsx"))[0]).toContain("automaticallyAdjustKeyboardInsets");
});
