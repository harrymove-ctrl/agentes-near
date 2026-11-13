import { expect, test } from "bun:test";
import { builtCss, declarations, rules } from "./built-css";

test("what ships never lets the chat list shrink what it holds", async () => {
  const css = await builtCss("src/styles.css", "src/components/threads/threads.css");
  // The list is a column flexbox taller than its box. A row the browser skips has no content to stop it shrinking, nor
  // has a box that clips its overflow (a range thread's context): either would be laid out at its padding, and a row
  // that hover or focus just left would move the rows under a tap until the next frame.
  expect(declarations(css, ".channel__messages > *")).toContainEqual(["flex-shrink", "0"]);
  const row = declarations(css, ".channel__messages .ac-msg");
  expect(row).toContainEqual(["content-visibility", "auto"]);
  expect(row.findLast(([p]) => p === "contain-intrinsic-size")?.[1]).toStartWith("auto ");
  // No rule gives a row or the context block a flex of its own (`flex` sets flex-shrink too).
  const flexed = rules(css)
    .filter((r) => r.declarations.some(([p]) => p === "flex" || p === "flex-shrink"))
    .flatMap((r) => r.selectors.filter((s) => /\.(ac-msg(--[\w-]+)?|thread-context)(?![\w-])[^ >+~]*$/.test(s)));
  expect(flexed).toEqual([]);
});
