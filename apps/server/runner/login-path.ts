import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * An app opened from Finder (or by launchd at login) gets macOS's bare PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so `claude`, `codex`, `node`, `bun` and
 * the person's build tools aren't found, neither when we detect them nor when
 * a task runs them. In app mode the runner takes the PATH the person's login
 * shell builds (`$SHELL -ilc`), plus the usual install folders, before
 * anything else starts.
 */
const MARK = "__AGENTES_PATH__";

/** Common install folders, in the order a shell would usually have them. */
export function usualDirs(home = os.homedir()): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
}

/** The PATH printed by the login shell, or null (no shell, timeout, nothing between the marks). */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh"): string | null {
  try {
    const r = spawnSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out = `${r.stdout ?? ""}`;
    const start = out.indexOf(MARK);
    const end = out.indexOf(MARK, start + MARK.length);
    if (start < 0 || end < 0) return null;
    const value = out.slice(start + MARK.length, end).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Joins PATH lists, first wins, dropping empty and repeated entries. */
export function mergePath(...lists: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dir of (list ?? "").split(path.delimiter)) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(path.delimiter);
}

/** Sets `process.env.PATH` to the login shell's PATH + the usual folders that exist + what we had. */
export function adoptLoginPath(log: (line: string) => void = () => {}): void {
  if (process.platform === "win32") return;
  const shell = loginShellPath();
  const usual = usualDirs()
    .filter((d) => existsSync(d))
    .join(path.delimiter);
  process.env.PATH = mergePath(shell, usual, process.env.PATH);
  log(shell ? "PATH taken from the login shell" : "PATH: the login shell gave nothing; using the usual folders");
}
