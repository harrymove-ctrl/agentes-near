import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { errnoCode } from "./errors";

/**
 * One runner per home (ADR 0036 §4): `<home>/runner.lock` holds the PID of
 * the runner that took it (`start` or `app`). A second runner on the same
 * home finds a live PID and stops with a clear message; a lock whose PID is
 * gone (a crash) or that an earlier boot left (its PID may be another
 * process's now) is stale and taken over. A native server's data folder is
 * locked the same way, in its own file (`server.lock`).
 */

export const LOCK_FILE = "runner.lock";

export interface LockInfo {
  pid: number;
  mode: string;
  startedAt: string;
  /** The boot of the computer it was taken in (`bootId`); absent in locks from older versions. */
  boot?: string;
}

let thisBoot: string | undefined;

/** This boot of the computer, as the system names it; "" where it doesn't say. */
export function bootId(): string {
  if (thisBoot === undefined) {
    try {
      thisBoot =
        process.platform === "linux"
          ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
          : process.platform === "darwin"
            ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              }).trim()
            : "";
    } catch {
      thisBoot = "";
    }
  }
  return thisBoot;
}

/**
 * Whether a lock was taken before this boot of the computer: its boot isn't this one, or, in a lock
 * that doesn't say its boot (older versions), it was taken before the computer started.
 */
function beforeThisBoot(holder: LockInfo, boot: string): boolean {
  if (holder.boot) return Boolean(boot) && holder.boot !== boot;
  return Date.parse(holder.startedAt) < Date.now() - os.uptime() * 1000;
}

export type LockResult = { ok: true; release: () => void } | { ok: false; holder: LockInfo };

/** Whether a process with this PID exists (EPERM: it exists, it just isn't ours). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errnoCode(err) === "EPERM";
  }
}

function parseLock(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    if (typeof v.pid !== "number") return null;
    return {
      pid: v.pid,
      mode: typeof v.mode === "string" ? v.mode : "",
      startedAt: typeof v.startedAt === "string" ? v.startedAt : "",
      ...(typeof v.boot === "string" ? { boot: v.boot } : {}),
    };
  } catch {
    return null;
  }
}

const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export function readLock(home: string, file = LOCK_FILE): LockInfo | null {
  const text = readText(path.join(home, file));
  return text === null ? null : parseLock(text);
}

/**
 * Takes the home's lock for this process, or says who holds it. The lock is written whole and then
 * linked into place, so it never exists without its PID; a stale one is moved aside and removed only
 * if it is still the one judged stale, so two processes taking it over at once never both get it.
 */
export function acquireLock(
  home: string,
  mode: string,
  opts: { pid?: number; alive?: (pid: number) => boolean; boot?: string; file?: string } = {},
): LockResult {
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? pidAlive;
  const boot = opts.boot ?? bootId();
  const name = opts.file ?? LOCK_FILE;
  const file = path.join(home, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const info: LockInfo = { pid, mode, startedAt: new Date().toISOString(), ...(boot ? { boot } : {}) };
  const draft = `${file}.${pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(draft, JSON.stringify(info), { mode: 0o600 });
  // ponytail: three processes starting within microseconds of a takeover could still both end up holding it;
  // the native server's database has the system's own lock too (`openPglite`).
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(draft, file);
        return {
          ok: true,
          release: () => {
            // Only our own lock: a runner that took over a lock we thought stale keeps its own.
            if (readLock(home, name)?.pid === pid) rmSync(file, { force: true });
          },
        };
      } catch (err) {
        if (errnoCode(err) !== "EEXIST") throw err;
      }
      const seen = readText(file);
      if (seen === null) continue;
      const holder = parseLock(seen);
      if (holder && holder.pid !== pid && !beforeThisBoot(holder, boot) && alive(holder.pid)) {
        return { ok: false, holder };
      }
      // Stale (its process is gone, or an earlier boot's), unreadable, or our own PID from before a restart.
      const aside = `${draft}.stale`;
      try {
        renameSync(file, aside);
      } catch (err) {
        if (errnoCode(err) === "ENOENT") continue;
        throw err;
      }
      if (readText(aside) !== seen) {
        // Another process's new lock took its place meanwhile: it goes back.
        try {
          linkSync(aside, file);
        } catch (err) {
          if (errnoCode(err) !== "EEXIST") throw err;
        }
      }
      rmSync(aside, { force: true });
    }
  } finally {
    rmSync(draft, { force: true });
  }
  const holder = readLock(home, name);
  return { ok: false, holder: holder ?? { pid: 0, mode: "", startedAt: "" } };
}

/** The message a second runner prints. */
export function lockedMessage(home: string, holder: LockInfo) {
  return `Another agentes runner is already running with this home (${home}, pid ${holder.pid}${holder.mode ? `, ${holder.mode}` : ""}). Stop it first, or use another home (--home or AGENTES_RUNNER_HOME).`;
}
