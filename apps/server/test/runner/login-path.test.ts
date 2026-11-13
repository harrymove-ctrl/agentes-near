import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginShellPath, mergePath, usualDirs } from "../../runner/login-path";

test("mergePath: first wins, no empty or repeated entries", () => {
  expect(mergePath("/a:/b", null, "/b:/c::/a", undefined, "/d")).toBe("/a:/b:/c:/d");
  expect(mergePath("", "")).toBe("");
});

test("loginShellPath reads only what's between the marks, ignoring what the shell's rc files print", () => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(path.join(os.tmpdir(), "login-path-"));
  const shell = path.join(dir, "fake-shell");
  // A "shell" that prints a banner first, then runs the -c script like sh would.
  writeFileSync(shell, `#!/bin/sh\necho "Welcome!"\nPATH=/x/bin:/y/bin\nexport PATH\nshift\nexec /bin/sh -c "$1"\n`);
  chmodSync(shell, 0o755);
  expect(loginShellPath(shell)).toBe("/x/bin:/y/bin");
  expect(loginShellPath(path.join(dir, "missing"))).toBeNull();
});

test("the usual folders include the ones Claude Code and Homebrew install into", () => {
  const dirs = usualDirs("/Users/ana");
  expect(dirs).toContain("/Users/ana/.local/bin");
  expect(dirs).toContain("/opt/homebrew/bin");
});
