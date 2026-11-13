import { describe, expect, test } from "bun:test";
import { workspacePath } from "../src";

describe("workspace paths", () => {
  test("relative to the workspace: `/workspace` dropped, no `..`", () => {
    expect(workspacePath("/workspace/a/./b.py")).toBe("a/b.py");
    expect(workspacePath("")).toBe("");
    expect(() => workspacePath("a/../../x")).toThrow();
  });
});
