/**
 * Fails when an installed dependency's license is not permissive or weak copyleft (LGPL, MPL-2.0):
 * strong copyleft (GPL, AGPL), source-available (SSPL, Business Source, Elastic, Commons Clause),
 * proprietary, unknown or missing. The phone and desktop apps reach app stores through the section 7
 * permission in NOTICE, which can't cover code others license under the GPL or AGPL (and
 * GPL-2.0-only can't be combined with AGPL-3.0 at all), so no dependency may bring strong copyleft.
 * Run in CI via `bun run check:licenses`, after `bun install`.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

/** SPDX ids a dependency may use, plus any `LGPL-*`. Every id in its license expression must be one of them. */
const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unlicense",
]);

/** Read by hand: the license field is missing or names an id outside ALLOWED, but the terms we use are fine. */
const REVIEWED = new Set([
  "khroma", // no license field; its license file is MIT
  "node-forge", // "(BSD-3-Clause OR GPL-2.0)", used under BSD-3-Clause
  "@zone-eu/mailsplit", // "(MIT OR EUPL-1.1+)", used under MIT
]);

/** Why a package's `package.json` license is not acceptable, or null when it is. */
export function licenseProblem(pkg: { name?: string; license?: unknown }): string | null {
  if (pkg.name && REVIEWED.has(pkg.name)) return null;
  if (typeof pkg.license !== "string" || !pkg.license.trim()) return "no SPDX license field";
  // Each choice of an OR too, so a dual license with GPL is read by hand before it goes in REVIEWED.
  const ids = pkg.license.split(/[\s()]+/).filter((id) => id && !["AND", "OR", "WITH"].includes(id));
  return ids.length > 0 && ids.every((id) => ALLOWED.has(id) || id.startsWith("LGPL-")) ? null : pkg.license;
}

/** Every package folder under a node_modules folder, nested node_modules included. */
function* packageDirs(nodeModules: string): Generator<string> {
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith(".")) continue;
    const path = join(nodeModules, entry);
    for (const dir of entry.startsWith("@") ? readdirSync(path).map((name) => join(path, name)) : [path]) {
      // Not a folder: a stray file, a link to one of our own workspaces (AGPL by design), or a link
      // into the isolated store (node_modules/.bun), which is read as roots of its own.
      if (!lstatSync(dir).isDirectory()) continue;
      yield dir;
      const nested = join(dir, "node_modules");
      if (existsSync(nested)) yield* packageDirs(nested);
    }
  }
}

if (import.meta.main) {
  // An isolated install (`linker = "isolated"` in bunfig.toml)
  // keeps each package in node_modules/.bun/<name>@<version>/node_modules and links it everywhere else.
  const roots = [
    "node_modules",
    ...new Glob("{apps,packages}/*/node_modules").scanSync({ onlyFiles: false }),
    ...new Glob("node_modules/.bun/*/node_modules").scanSync({ onlyFiles: false, dot: true }),
  ];
  const problems: string[] = [];
  let checked = 0;
  for (const root of roots) {
    for (const dir of packageDirs(root)) {
      checked++;
      const file = Bun.file(join(dir, "package.json"));
      const problem = licenseProblem((await file.exists()) ? await file.json() : {});
      if (problem) problems.push(`${dir}: ${problem}`);
    }
  }
  // A layout with every package behind a link this script doesn't follow would otherwise pass unread.
  if (checked === 0) {
    console.error("No installed packages found: run bun install first.");
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(
      `Dependencies under a license agentes.chat can't ship (add one to REVIEWED only after reading its terms):\n${problems.join("\n")}`,
    );
    process.exit(1);
  }
  console.log(`licenses ok (${checked} packages)`);
}
