import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { spawnGated } from "../../runner/scope-gate";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";

/** A program that says it started, whether fd 3 reached it, its pid, the first line of its stdin, then exits 7. */
function target() {
  const dir = tempDir("gate-");
  dirs.push(dir);
  const file = path.join(dir, "target");
  writeFileSync(
    file,
    '#!/bin/sh\necho started\nif [ -e /dev/fd/3 ]; then echo fd3-open; else echo fd3-closed; fi\necho "pid:$$"\nread line\necho "stdin:$line"\nexit 7\n',
    { mode: 0o755 },
  );
  return file;
}

function watch(child: ChildProcess) {
  const out = { text: "", code: undefined as number | null | undefined, error: undefined as Error | undefined };
  child.stdout?.on("data", (d: Buffer) => {
    out.text += d.toString();
  });
  const events = child as unknown as EventEmitter;
  events.on("exit", (code: number | null) => {
    out.code = code;
  });
  events.on("error", (err: Error) => {
    out.error = err;
  });
  return out;
}

test.if(posix)("the child comes back at once and starts only once root moved it, as the program itself", async () => {
  const file = target();
  const asked: [number, string][] = [];
  let release = () => {};
  const child = spawnGated("cli", file, [], { stdio: ["pipe", "pipe", "pipe"] }, (pid, kind) => {
    asked.push([pid, kind]);
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  expect(child.pid).toBeGreaterThan(0);
  const out = watch(child);
  // What the caller writes meanwhile waits in the pipe.
  child.stdin?.end("first line\nsecond\n");
  await Bun.sleep(300);
  expect(out.text).toBe("");
  expect(asked).toEqual([[child.pid as number, "cli"]]);
  release();
  await waitFor(() => out.code !== undefined);
  // Same pid (exec), fd 3 gone, stdin whole, the program's own exit code.
  expect(out.text).toBe(`started\nfd3-closed\npid:${child.pid}\nstdin:first line\n`);
  expect(out.code).toBe(7);
});

test.if(posix)("a move that fails or never answers still starts it: where it is, after the wait", async () => {
  const failed = watch(
    spawnGated("browser", target(), [], { stdio: ["ignore", "pipe", "ignore"] }, () =>
      Promise.reject(new Error("systemd said no")),
    ),
  );
  await waitFor(() => failed.code !== undefined);
  expect(failed.text).toStartWith("started\n");

  const at = Date.now();
  const silent = watch(
    spawnGated("cli", target(), [], { stdio: ["ignore", "pipe", "ignore"] }, () => new Promise(() => {}), 200),
  );
  await waitFor(() => silent.code !== undefined);
  expect(Date.now() - at).toBeGreaterThanOrEqual(190);
  expect(silent.text).toStartWith("started\n");
});

test.if(posix)("detached, it leads its own process group as the program, so killing the group stops it", async () => {
  const dir = tempDir("gate-");
  dirs.push(dir);
  const file = path.join(dir, "sleeper");
  writeFileSync(file, '#!/bin/sh\necho "up"\nexec sleep 30\n', { mode: 0o755 });
  const child = spawnGated("cli", file, [], { stdio: ["ignore", "pipe", "ignore"], detached: true }, async () => {});
  const out = watch(child);
  await waitFor(() => out.text === "up\n");
  process.kill(-(child.pid as number), "SIGTERM");
  await waitFor(() => out.code !== undefined);
  expect(out.code).toBeNull();
});

test.if(posix)("a caller's own descriptor past stderr reaches the program, held all the same", async () => {
  const dir = tempDir("gate-");
  dirs.push(dir);
  const file = path.join(dir, "reader");
  writeFileSync(
    file,
    '#!/bin/sh\nread -r secret <&3\necho "fd3:$secret"\nif [ -e /dev/fd/4 ]; then echo fd4-open; else echo fd4-closed; fi\n',
    { mode: 0o755 },
  );
  const asked: number[] = [];
  let release = () => {};
  const child = spawnGated("cli", file, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] }, (pid) => {
    asked.push(pid);
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const out = watch(child);
  (child.stdio[3] as Writable).end("the-token\n");
  await Bun.sleep(300);
  expect(out.text).toBe("");
  expect(asked).toEqual([child.pid as number]);
  release();
  await waitFor(() => out.code !== undefined);
  // The caller's fd 3 whole; the gate's own descriptor gone before the program starts.
  expect(out.text).toBe("fd3:the-token\nfd4-closed\n");
});

test("a program that can't run fails as it would have, and isn't held", async () => {
  let asked = false;
  const enter = async () => {
    asked = true;
  };
  const missing = "/nonexistent/agentes-gate-test";
  const gated = watch(spawnGated("cli", missing, [], { stdio: "pipe" }, enter));
  const plain = watch(spawn(missing, [], { stdio: "pipe" }));
  await waitFor(() => gated.error !== undefined && plain.error !== undefined);
  expect((gated.error as NodeJS.ErrnoException).code).toBe((plain.error as NodeJS.ErrnoException).code);
  expect(gated.error?.message).toBe(plain.error?.message);
  expect(asked).toBe(false);
});
