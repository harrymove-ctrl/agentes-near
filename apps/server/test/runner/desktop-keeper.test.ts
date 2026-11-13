import { expect, test } from "bun:test";
import path from "node:path";

/** The CI runners have Python; a developer's machine may not. */
const python = Bun.which("python3") ?? (process.env.CI ? "python3" : null);

test.skipIf(!python)("the desktop keeper's pure parts pass their Python tests (ADR 0168)", () => {
  const run = Bun.spawnSync([python ?? "", "-I", path.join(import.meta.dir, "test_desktop_keeper.py")], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SHELL: "/bin/bash" },
  });
  if (run.exitCode !== 0) throw new Error(`${run.stdout}\n${run.stderr}`);
  expect(run.stderr.toString()).toMatch(/\nOK\n/);
});
