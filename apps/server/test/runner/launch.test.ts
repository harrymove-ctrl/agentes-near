import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isBunfsPath, isCompiled, selfCommand } from "../../runner/launch";
import { acquireLock, bootId, LOCK_FILE, readLock } from "../../runner/lock";
import { launchdPlist, systemdUnit, windowsTaskCommand } from "../../runner/service";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const same = (p: string) => p;

test("compiled: the entry is in Bun's embedded file system, missing, or the executable itself", () => {
  expect(isBunfsPath("/$bunfs/root/agentes-runner")).toBe(true);
  expect(isBunfsPath("B:/~BUN/root/agentes-runner.exe")).toBe(true);
  expect(isBunfsPath("B:\\~BUN\\root\\agentes-runner.exe")).toBe(true);
  expect(isBunfsPath("/home/me/.agentes-runner/agentes-runner.mjs")).toBe(false);
  expect(isBunfsPath(undefined)).toBe(false);

  const app = "/Applications/agentes.app/Contents/MacOS/agentes-runner";
  expect(isCompiled({ execPath: app, argv1: "/$bunfs/root/agentes-runner" }, same)).toBe(true);
  expect(isCompiled({ execPath: app, bunMain: "/$bunfs/root/main.js", argv1: "/whatever" }, same)).toBe(true);
  expect(isCompiled({ execPath: app }, same)).toBe(true);
  expect(isCompiled({ execPath: app, argv1: app }, same)).toBe(true);
  expect(selfCommand({ execPath: app, argv1: "/$bunfs/root/agentes-runner" }, same)).toEqual([app]);
});

test("bundled: the runtime plus the script (real path)", () => {
  const node = "/usr/bin/node";
  const script = "/home/me/.agentes-runner/agentes-runner.mjs";
  expect(isCompiled({ execPath: node, argv1: script }, same)).toBe(false);
  expect(selfCommand({ execPath: node, argv1: script }, same)).toEqual([node, script]);
  // A symlinked launcher resolves to the script it points at.
  const resolve = (p: string) => (p === "/usr/local/bin/agentes-runner.mjs" ? script : p);
  expect(selfCommand({ execPath: node, argv1: "/usr/local/bin/agentes-runner.mjs" }, resolve)).toEqual([node, script]);
  expect(selfCommand({ execPath: "/home/me/.bun/bin/bun", bunMain: script, argv1: script }, same)).toEqual([
    "/home/me/.bun/bin/bun",
    script,
  ]);
});

test("service files for a compiled runner name the executable alone", () => {
  const launch = { runtime: "/opt/agentes/agentes-runner", home: "/home/me/.agentes-runner" };
  expect(systemdUnit(launch)).toContain('ExecStart="/opt/agentes/agentes-runner" start\n');
  const plist = launchdPlist(launch);
  expect(plist).toContain(
    "<array>\n    <string>/opt/agentes/agentes-runner</string>\n    <string>start</string>\n  </array>",
  );
  expect(plist).not.toContain("<string></string>");
  expect(windowsTaskCommand({ ...launch, runtime: "C:\\agentes\\agentes-runner.exe" }).install).toContain(
    '/TR "\\"C:\\agentes\\agentes-runner.exe\\" start"',
  );
});

test("lock: one runner per home; a second one is refused, a stale lock is taken over", () => {
  const home = tempDir("home-");
  dirs.push(home);
  const first = acquireLock(home, "app");
  expect(first.ok).toBe(true);
  expect(readLock(home)).toMatchObject({ pid: process.pid, mode: "app" });

  // Another process (another pid) finds ours alive.
  const second = acquireLock(home, "start", { pid: process.pid + 100_000, alive: () => true });
  expect(second).toMatchObject({ ok: false, holder: { pid: process.pid, mode: "app" } });

  // Released: the file goes, and anyone can take it.
  if (first.ok) first.release();
  expect(existsSync(path.join(home, LOCK_FILE))).toBe(false);

  // A lock left by a process that is gone is stale.
  writeFileSync(path.join(home, LOCK_FILE), JSON.stringify({ pid: 4_000_000, mode: "start", startedAt: "x" }));
  const taken = acquireLock(home, "start", { alive: (pid) => pid === process.pid });
  expect(taken.ok).toBe(true);
  expect(JSON.parse(readFileSync(path.join(home, LOCK_FILE), "utf8")).pid).toBe(process.pid);

  // Releasing never removes a lock someone else took over meanwhile.
  writeFileSync(path.join(home, LOCK_FILE), JSON.stringify({ pid: 4_000_001, mode: "app", startedAt: "x" }));
  if (taken.ok) taken.release();
  expect(existsSync(path.join(home, LOCK_FILE))).toBe(true);
});

test("lock: one taken before the computer restarted is stale, whichever process has its pid now", () => {
  const home = tempDir("home-");
  dirs.push(home);
  const other = process.pid + 100_000;
  const left = (boot?: string, startedAt = new Date().toISOString()) =>
    writeFileSync(
      path.join(home, LOCK_FILE),
      JSON.stringify({ pid: other, mode: "start", startedAt, ...(boot ? { boot } : {}) }),
    );
  const alive = () => true;
  left("earlier-boot");
  const taken = acquireLock(home, "start", { alive, boot: "this-boot" });
  expect(taken.ok).toBe(true);
  expect(readLock(home)).toMatchObject({ pid: process.pid, boot: "this-boot" });
  // Taken in this boot, by a live process: held.
  left("this-boot");
  expect(acquireLock(home, "start", { alive, boot: "this-boot" })).toMatchObject({ ok: false, holder: { pid: other } });
  // An older version's lock doesn't say its boot: taken before the computer started, it's stale…
  left(undefined, "2000-01-01T00:00:00.000Z");
  expect(acquireLock(home, "start", { alive, boot: "this-boot" }).ok).toBe(true);
  // …and since, its pid decides.
  left();
  expect(acquireLock(home, "start", { alive, boot: "this-boot" }).ok).toBe(false);
  if (process.platform === "linux" || process.platform === "darwin") expect(bootId()).toMatch(/^[\w-]{8,}$/);
});

test("lock: processes that try at the same moment, on a new home or a stale lock, get it once", async () => {
  const lock = path.join(import.meta.dir, "../../runner/lock.ts");
  const child = (home: string, at: number) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { acquireLock } = await import(${JSON.stringify(lock)});
         while (Date.now() < ${at}) {}
         const r = acquireLock(${JSON.stringify(home)}, "server", { file: "server.lock" });
         await Bun.sleep(150);
         console.log(r.ok ? "ok" : "held");`,
      ],
      { stdout: "pipe" },
    );
  for (const stale of [false, true, false, true, false, true]) {
    const home = tempDir("race-");
    dirs.push(home);
    if (stale) {
      const gone = Bun.spawn(["true"]);
      await gone.exited;
      writeFileSync(path.join(home, "server.lock"), JSON.stringify({ pid: gone.pid, mode: "server", startedAt: "" }));
    }
    const at = Date.now() + 400;
    const outs = await Promise.all([child(home, at), child(home, at)].map((c) => new Response(c.stdout).text()));
    expect(outs.map((o) => o.trim()).sort()).toEqual(["held", "ok"]);
    expect(readdirSync(home)).toEqual(["server.lock"]);
  }
}, 30_000);
