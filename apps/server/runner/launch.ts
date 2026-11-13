import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * How this runner starts itself again (ADR 0036 §2): the service definition,
 * the `agentes-runner mcp` command written into Claude Code's and Codex's MCP
 * config, and the background task wrapper all need "this runner".
 *
 * - Bundled (`agentes-runner.mjs` run by Node or Bun): the runtime plus the
 *   script, `[process.execPath, <script>]`.
 * - Compiled (`bun build --compile apps/server/runner/main.ts`): one
 *   executable, `[process.execPath]`. There is no separate script to pass.
 *
 * A compiled Bun executable runs its entry from Bun's embedded file system:
 * `Bun.main` and `process.argv[1]` are virtual paths (`/$bunfs/root/…` on
 * macOS and Linux, `B:/~BUN/root/…` on Windows) that exist nowhere on disk.
 * We call it compiled when the entry is such a virtual path, when there is no
 * entry at all, or when the entry is the executable itself
 * (`process.execPath === script`). Anything else is a runtime running a script.
 */

export interface ProcessShape {
  execPath: string;
  /** `process.argv[1]`. */
  argv1?: string;
  /** `Bun.main` when running under Bun. */
  bunMain?: string;
}

/** A path inside Bun's embedded file system (a compiled executable's own files). */
export function isBunfsPath(p: string | undefined): boolean {
  if (!p) return false;
  return p.startsWith("/$bunfs/") || /^[a-zA-Z]:[\\/]~BUN[\\/]/.test(p) || p.startsWith("$bunfs");
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Whether this process is a compiled runner (no separate script). Pure apart from resolving symlinks. */
export function isCompiled(p: ProcessShape, resolve: (p: string) => string = real): boolean {
  if (isBunfsPath(p.bunMain) || isBunfsPath(p.argv1)) return true;
  if (!p.argv1) return true;
  return resolve(p.argv1) === resolve(p.execPath);
}

/** The argv that starts this runner: `[runtime, script]`, or `[binary]` when compiled. */
export function selfCommand(p: ProcessShape, resolve: (p: string) => string = real): string[] {
  if (isCompiled(p, resolve)) return [p.execPath];
  return [p.execPath, resolve(p.argv1 as string)];
}

/** This process, as `isCompiled` and `selfCommand` see it. */
export function currentProcess(): ProcessShape {
  const bun = (globalThis as { Bun?: { main?: unknown } }).Bun;
  return {
    execPath: process.execPath,
    ...(process.argv[1] ? { argv1: process.argv[1] } : {}),
    ...(typeof bun?.main === "string" ? { bunMain: bun.main } : {}),
  };
}

/** `selfCommand(currentProcess())`. */
export const thisRunner = () => selfCommand(currentProcess());

/** `isCompiled(currentProcess())`. */
export const runningCompiled = () => isCompiled(currentProcess());

/** `Bun.Terminal` is there (Bun 1.3.5 and newer): the agents' desktops and terminals need it. */
export const hasBunTerminal = () => typeof Bun !== "undefined" && "Terminal" in Bun;

/** The runtime this runner runs on, for people (`Bun 1.4.4`, `Node 22.12.0`). */
export const runtimeName = () =>
  process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`;
