import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bunPins, LAUNCHER, packageName, TARGETS } from "../../../scripts/native-package";

const installSh = readFileSync(join(import.meta.dir, "../../../install.sh"), "utf8");

test("every package gets the Bun install.sh pins, checked by its SHA-256", () => {
  const pins = bunPins(installSh);
  expect(pins.version).toBe(/^\s*BUN_VERSION=(\S+)$/m.exec(installSh)?.[1] ?? "");
  for (const bunTarget of Object.values(TARGETS)) {
    expect(pins.sha256[bunTarget]).toMatch(/^[0-9a-f]{64}$/);
    expect(installSh).toContain(`BUN_TARGET=${bunTarget}\n      BUN_SHA256=${pins.sha256[bunTarget]}`);
  }
  expect(() => bunPins("echo nothing pinned")).toThrow(/BUN_VERSION/);
});

test("the package's names and its launcher", () => {
  expect(packageName("1.4.0", "darwin-arm64")).toBe("agentes-native-1.4.0-darwin-arm64.tar.gz");
  expect(LAUNCHER.startsWith("#!/bin/sh\n")).toBe(true);
  expect(LAUNCHER).toContain('exec "$here/../runtime/bun" "$here/../server/native.js" "$@"');
});
