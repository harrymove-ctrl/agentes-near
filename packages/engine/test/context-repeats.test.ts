import { expect, test } from "bun:test";
import { collapseRepeats } from "../src";

test("the same call with the same result shows once, at its latest place, with how many times", () => {
  const check = { key: "a", line: "- @theo himetrica_list_events → [] (ok)" };
  const entries = [
    check,
    { key: "b", line: "- @theo create_issue → Created #12 (ok)" },
    ...Array.from({ length: 11 }, () => check),
    { key: "c", line: "- @atlas list_issues → 3 issues (ok)" },
  ];
  expect(collapseRepeats(entries, 12)).toEqual([
    "- @theo create_issue → Created #12 (ok)",
    "- @theo himetrica_list_events → [] (ok) (12 times)",
    "- @atlas list_issues → 3 issues (ok)",
  ]);
  // Only the newest lines are kept.
  expect(collapseRepeats(entries, 1)).toEqual(["- @atlas list_issues → 3 issues (ok)"]);
});
