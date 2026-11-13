/**
 * Builds agentes.chat to run without Docker (native mode, ADR 0060 §2):
 *
 *   bun scripts/native-package.ts folders [--out <dir>]
 *       <out>/agentes/<version>/: server/ (the bundled server, PGlite and the other packages with
 *       WebAssembly in them, the migrations), web/ (the web app and the runner bundle), bin/,
 *       LICENSE, NOTICE and licenses/. The desktop app carries server/ and web/ from here.
 *   bun scripts/native-package.ts packages [--out <dir>] [--targets darwin-arm64,linux-x64,…]
 *       The folders, plus one package per computer, `agentes-native-<version>-<os>-<arch>.tar.gz`,
 *       each with the pinned Bun for it (install.sh's version and SHA-256), and `native.json`, which
 *       the release signs (`native.json.sig`).
 *
 * The server is JavaScript and WebAssembly, so one machine builds every package: only Bun differs.
 * Needs `unzip` and `tar`. The version is apps/server/package.json's unless `--version` says.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");

/** Packages left out of the bundle: they load WebAssembly and data files of their own, next to their code. */
export const EXTERNAL = [
  "@electric-sql/pglite",
  "@electric-sql/pglite-pgvector",
  "@electric-sql/pglite-tools",
  "libpg-query",
];

/** Package targets, and the name of Bun's build for each (install.sh pins the same ones). */
export const TARGETS = {
  "darwin-arm64": "darwin-aarch64",
  "darwin-x64": "darwin-x64-baseline",
  "linux-x64": "linux-x64-baseline",
  "linux-arm64": "linux-aarch64",
} as const;
export type Target = keyof typeof TARGETS;

/** The Bun version install.sh pins, and the SHA-256 of its zip for each of its builds. */
export function bunPins(installSh: string): { version: string; sha256: Record<string, string> } {
  const version = /^\s*BUN_VERSION=(\S+)$/m.exec(installSh)?.[1];
  if (!version) throw new Error("install.sh pins no BUN_VERSION");
  const sha256: Record<string, string> = {};
  for (const m of installSh.matchAll(/BUN_TARGET=(\S+)\s+BUN_SHA256=([0-9a-f]{64})/g))
    sha256[m[1] as string] = m[2] as string;
  return { version, sha256 };
}

export interface NativeManifest {
  version: string;
  pgMajor: number;
  pglite: string;
  files: Partial<Record<Target, { name: string; sha256: string; size: number }>>;
}

export const packageName = (version: string, target: Target) => `agentes-native-${version}-${target}.tar.gz`;

/** The launcher people and services run: the package's own Bun on its server. */
export const LAUNCHER = `#!/bin/sh
# agentes.chat without Docker: this package's Bun runs its server.
here=$(cd "$(dirname "$0")" && pwd -P)
exec "$here/../runtime/bun" "$here/../server/native.js" "$@"
`;

/** Source maps (the web app's are most of its size) and drizzle-kit's schema snapshots aren't read at run time. */
const notAtRunTime = (file: string) => file.endsWith(".map") || /[\\/]meta[\\/]\d+_snapshot\.json$/.test(file);
const runtimeOnly = { recursive: true, filter: (file: string) => !notAtRunTime(file) };

/** The entry the launcher and the desktop app run; the bundle sits one folder down, like a package's src/. */
const ENTRY = `import { main } from "./lib/native.js";

process.exit(await main(process.argv.slice(2)));
`;

function sh(command: string[], cwd = ROOT) {
  const r = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${r.exitCode})`);
}

/** Where `name` resolves from `from`, as Node finds it: the closest node_modules up the tree. */
function packageDir(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`${name} isn't installed (from ${from})`);
  }
}

/** A package and its runtime dependencies, into `<into>/node_modules`. */
function copyPackage(name: string, from: string, into: string, done = new Set<string>()) {
  if (done.has(name)) return;
  done.add(name);
  const dir = packageDir(name, from);
  cpSync(dir, join(into, "node_modules", name), { ...runtimeOnly, dereference: true });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPackage(dep, dir, into, done);
}

/** The npm package a bundled file belongs to (`…/node_modules/<name>/…`), with its folder. */
function owningPackage(file: string): { name: string; dir: string } | null {
  const parts = file.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return null;
  const scoped = parts[at + 1]?.startsWith("@");
  const name = parts.slice(at + 1, at + (scoped ? 3 : 2)).join("/");
  return { name, dir: parts.slice(0, at + (scoped ? 3 : 2)).join("/") };
}

/** Every bundled package's license text, in `licenses/npm/<name>/`. */
function copyLicenses(inputs: string[], into: string) {
  const seen = new Map<string, string>();
  for (const input of inputs) {
    const found = owningPackage(resolve(input));
    if (found && !seen.has(found.name)) seen.set(found.name, found.dir);
  }
  for (const [name, dir] of seen) {
    const target = join(into, "npm", name);
    mkdirSync(target, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string; license?: unknown };
    const texts = new Bun.Glob("{LICEN[CS]E,LICEN[CS]E.*,COPYING,COPYING.*,NOTICE,NOTICE.*}").scanSync({ cwd: dir });
    let any = false;
    for (const file of texts) {
      cpSync(join(dir, file), join(target, file));
      any = true;
    }
    if (!any) writeFileSync(join(target, "LICENSE"), `${name}@${pkg.version ?? ""}: ${String(pkg.license ?? "")}\n`);
  }
  return seen.size;
}

/** `<out>/agentes/<version>`: everything but Bun. */
export async function buildFolders(out: string, version: string) {
  const base = join(out, "agentes", version);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });

  sh(["bun", "run", "--filter", "@agenteschat/web", "build"]);
  cpSync(join(ROOT, "apps/web/dist"), join(base, "web"), runtimeOnly);
  // The program that connects a computer, which every server offers for download (as the image does).
  const runner = await Bun.build({
    entrypoints: [join(ROOT, "apps/server/runner/main.ts")],
    target: "node",
    banner: "#!/usr/bin/env node",
    outdir: join(base, "web/runner"),
    naming: "agentes-runner.mjs",
    metafile: true,
  });
  if (!runner.success) throw new AggregateError(runner.logs, "the runner didn't bundle");

  const server = join(base, "server");
  const built = await Bun.build({
    // The freeze watch's thread is a file of its own, loaded beside `native.js` (`startFreezeWatch`).
    entrypoints: [join(ROOT, "apps/server/src/native.ts"), join(ROOT, "apps/server/src/freeze-watch-worker.ts")],
    target: "bun",
    outdir: join(server, "lib"),
    external: EXTERNAL,
    metafile: true,
  });
  if (!built.success) throw new AggregateError(built.logs, "the server didn't bundle");
  writeFileSync(join(server, "native.js"), ENTRY);
  // Read beside the bundle, as from the packages' own folders (`../migrations`, `../assets`).
  cpSync(join(ROOT, "packages/db/migrations"), join(server, "migrations"), runtimeOnly);
  cpSync(join(ROOT, "packages/engine/assets"), join(server, "assets"), { recursive: true });
  const from = { "libpg-query": join(ROOT, "packages/engine") } as Record<string, string>;
  for (const name of EXTERNAL) copyPackage(name, from[name] ?? join(ROOT, "packages/db"), server);

  mkdirSync(join(base, "bin"));
  writeFileSync(join(base, "bin/agentes-server"), LAUNCHER);
  chmodSync(join(base, "bin/agentes-server"), 0o755);
  for (const file of ["LICENSE", "NOTICE"]) cpSync(join(ROOT, file), join(base, file));
  cpSync(join(ROOT, "apps/desktop/src-tauri/licenses/bun"), join(base, "licenses/bun"), { recursive: true });
  const inputs = [built, runner].flatMap((r) => Object.keys(r.metafile?.inputs ?? {}));
  const licensed = copyLicenses(inputs, join(base, "licenses"));
  console.log(`${relative(ROOT, base)}: server and web built, ${licensed} bundled packages' licenses`);
  return base;
}

async function sha256(file: string) {
  return createHash("sha256")
    .update(new Uint8Array(await Bun.file(file).arrayBuffer()))
    .digest("hex");
}

/** One package per target, each with its Bun, and the manifest naming them. */
export async function buildPackages(out: string, version: string, targets: Target[]) {
  const base = await buildFolders(out, version);
  const { version: bunVersion, sha256: pins } = bunPins(readFileSync(join(ROOT, "install.sh"), "utf8"));
  const manifest: NativeManifest = { version, ...builtDatabase(base), files: {} };
  const work = join(out, "work");
  for (const target of targets) {
    const bunTarget = TARGETS[target];
    const pin = pins[bunTarget];
    if (!pin) throw new Error(`install.sh pins no Bun for ${bunTarget}`);
    const zip = join(work, `bun-${bunTarget}.zip`);
    if (!existsSync(zip) || (await sha256(zip)) !== pin) {
      mkdirSync(work, { recursive: true });
      const url = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-${bunTarget}.zip`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      await Bun.write(zip, res);
      if ((await sha256(zip)) !== pin) throw new Error(`${url} isn't the Bun install.sh pins (SHA-256)`);
    }
    rmSync(join(work, `bun-${bunTarget}`), { recursive: true, force: true });
    sh(["unzip", "-q", "-o", zip, "-d", work]);
    rmSync(join(base, "runtime"), { recursive: true, force: true });
    mkdirSync(join(base, "runtime"));
    cpSync(join(work, `bun-${bunTarget}`, "bun"), join(base, "runtime/bun"));
    chmodSync(join(base, "runtime/bun"), 0o755);
    const name = packageName(version, target);
    sh(["tar", "-czf", join(out, name), "-C", out, `agentes/${version}`]);
    manifest.files[target] = { name, sha256: await sha256(join(out, name)), size: statSync(join(out, name)).size };
    console.log(`${name}: ${(statSync(join(out, name)).size / 1e6).toFixed(1)} MB`);
  }
  rmSync(join(base, "runtime"), { recursive: true, force: true });
  writeFileSync(join(out, "native.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The PGlite and the Postgres major of the built server, as it says them itself (so it runs). */
function builtDatabase(base: string): { pgMajor: number; pglite: string } {
  const r = Bun.spawnSync(["bun", join(base, "server/native.js"), "version"], { stdout: "pipe", stderr: "inherit" });
  const said = r.exitCode === 0 ? (JSON.parse(r.stdout.toString()) as { pgMajor?: unknown; pglite?: unknown }) : {};
  if (typeof said.pgMajor !== "number" || typeof said.pglite !== "string") {
    throw new Error("the built server didn't say what it runs");
  }
  return { pgMajor: said.pgMajor, pglite: said.pglite };
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { out: { type: "string" }, version: { type: "string" }, targets: { type: "string" } },
  });
  const out = resolve(values.out ?? join(ROOT, "dist/native"));
  const version =
    values.version ??
    (JSON.parse(readFileSync(join(ROOT, "apps/server/package.json"), "utf8")) as { version: string }).version;
  const command = positionals[0] ?? "packages";
  if (command === "folders") await buildFolders(out, version);
  else if (command === "packages") {
    const targets = (values.targets?.split(",") ?? Object.keys(TARGETS)) as Target[];
    for (const t of targets)
      if (!(t in TARGETS)) throw new Error(`unknown target ${t}: ${Object.keys(TARGETS).join(", ")}`);
    console.log(JSON.stringify(await buildPackages(out, version, targets), null, 2));
  } else
    throw new Error(
      "usage: bun scripts/native-package.ts folders|packages [--out <dir>] [--version <v>] [--targets …]",
    );
}
