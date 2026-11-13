import { expect, test } from "bun:test";

const css = (file: string) => Bun.file(new URL(`../src/pages/${file}`, import.meta.url).pathname).text();
/** What the `(hover: none)` blocks of a sheet set, as one text. */
const onTouch = (sheet: string) =>
  [...sheet.matchAll(/@media \(hover: none\) \{([\s\S]*?)\n\}/g)].map((m) => m[1] ?? "").join("\n");
const rule = (block: string, selector: string) => block.split(`\n  ${selector} {`)[1]?.split("}")[0] ?? "";

test("touch: a control shown only on hover that a tap still reaches is always shown there", async () => {
  // A criterion's pencil, and the checkbox a tap on a thread's face reaches (the face makes way for it).
  expect(rule(onTouch(await css("issues.css")), ".issue-criterion__pen")).toContain("opacity: 1");
  const threads = onTouch(await css("threads.css"));
  expect(rule(threads, ".thread-row__check")).toContain("opacity: 1");
  expect(rule(threads, ".thread-row__face")).toContain("opacity: 0");
});
