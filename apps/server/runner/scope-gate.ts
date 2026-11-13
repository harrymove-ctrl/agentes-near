import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { isExecutable } from "./executors";

/**
 * System mode under systemd: an agent's Chrome and its AI CLIs run in slices
 * of their own inside the agent's (`agents-<uid>-browser.slice`,
 * `agents-<uid>-cli.slice`), so an operator's network guard can tell their traffic
 * apart by the cgroup of each socket. Root moves the process (`scope.enter`),
 * and it must be there before its first byte: `/bin/sh` waits on a descriptor
 * of its own, past the caller's, then becomes the program (`exec`), with the
 * pid, process group and descriptors the caller already holds. A move that
 * fails or never comes leaves it where it is, in the agent's own slice:
 * nothing waits more than `ENTER_MS` and nothing fails because of the gate.
 */
export type ScopeKind = "browser" | "cli";

/** `spawn`'s shape, for the call sites that start the agent's Chrome and AI CLIs. */
export type Spawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** How long a held process waits to be moved before it starts where it is. */
export const ENTER_MS = 5000;

/** Waits for a line on `fd` (one digit: what `sh` redirects), closes it, then becomes the program. */
const hold = (fd: number) => `read -r _ <&${fd}; exec ${fd}<&-; exec "$0" "$@"`;

/** Starts `file` held until `enter(pid, kind)` settles (`waitMs` at most). */
export function spawnGated(
  kind: ScopeKind,
  file: string,
  args: readonly string[],
  options: SpawnOptions,
  enter: (pid: number, kind: ScopeKind) => Promise<unknown>,
  waitMs = ENTER_MS,
): ChildProcess {
  const io = options.stdio ?? "pipe";
  const runnable = isExecutable(file);
  // The caller's descriptors stay where they are (a token on fd 3, `accounts.ts`); the gate's comes after them.
  const stdio = typeof io === "string" ? [io, io, io] : [...[0, 1, 2].map((fd) => io[fd] ?? "pipe"), ...io.slice(3)];
  // A program that can't run fails exactly as it did, and past fd 9 `sh` can't name the gate's.
  if (!runnable || options.shell || stdio.length > 9) return spawn(file, args, options);
  const child = spawn("/bin/sh", ["-c", hold(stdio.length), file, ...args], { ...options, stdio: [...stdio, "pipe"] });
  const gate = child.stdio[stdio.length] as Writable | null | undefined;
  gate?.on("error", () => {});
  const release = () => gate?.end("\n");
  const pid = child.pid;
  if (!pid) {
    release();
    return child;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  void Promise.race([
    enter(pid, kind).catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    }),
  ]).then(() => {
    clearTimeout(timer);
    release();
  });
  return child;
}
