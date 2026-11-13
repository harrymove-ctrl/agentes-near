import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (file: string) => readFileSync(join(import.meta.dir, "../../src", file), "utf8").replace(/\s+/g, " ");

test("Nova tarefa half written: a back swipe asks first, and a task just made leaves without asking", () => {
  const form = src("features/issues/NewIssueForm.tsx");
  expect(form).toContain('usePreventRemove(title.trim() !== "" || text.trim() !== "",');
  expect(form).toContain("if (done.current) return repeat();");
  expect(form).toContain('{ text: t("edit.discard"), style: "destructive", onPress: repeat }');
  expect(form.indexOf("done.current = true;")).toBeLessThan(form.lastIndexOf("close();"));
});
