import { spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  MachineReplies,
  MissionWorktreeEnsured,
  MissionWorktreeRequest,
} from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "./errors";
import { CONFIG_LIST_ARGS, HARDENED_GIT_ARGS, unsafeConfigMessage, unsafeRepoConfig } from "./git-guard";
import { isInside, normalizeRequestPath, resolveInWorkspace } from "./paths";

/**
 * `mission.worktree` (protocol 14, ADR 0044): the mission's one worktree and
 * branch. The runner's own git in the agent's folder (like `git.sync`), so
 * no "commands" switch; `ensure` is new work and is refused while paused
 * (`handlers.ts`). Setup (installs) is never run here: `ensure` only says
 * what to run (`setupCommand`) and the server starts it as a shell task.
 */

/** Each git command of an `ensure` / `remove` (a checkout of a big repository takes a while). */
const GIT_TIMEOUT_MS = 5 * 60_000;
/** `agentes.json` limits: entries in `copy`, each path's and `setup`'s length. */
const PROJECT_COPY_MAX = 100;
const PROJECT_PATH_MAX = 300;
const PROJECT_SETUP_MAX = 2000;
const SHA = /^[0-9a-f]{7,64}$/;

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs git with an argv (no shell) and a deadline. Never throws on git's own failure. */
export function git(
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const keep = (s: string, add: string) => (s.length > 64_000 ? s.slice(-32_000) : s) + add;
    child.stdout?.on("data", (d: Buffer) => {
      stdout = keep(stdout, d.toString("utf8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr = keep(stderr, d.toString("utf8"));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS);
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const events = child as unknown as EventEmitter;
    events.on("error", (err: NodeJS.ErrnoException) => {
      stderr = keep(stderr, err.code === "ENOENT" ? "git is not installed" : err.message);
      done(null);
    });
    events.on("close", (code: number | null) => done(code));
  });
}

/**
 * The runner's own git in a mission's repository, with `HARDENED_GIT_ARGS` (no hooks, no
 * fsmonitor: `git-guard.ts`). `git` itself stays as it is for a task's end-of-item commit,
 * which runs with the "commands" switch and runs the repository's hooks on purpose.
 */
const safeGit = (cwd: string, args: string[]) => git(cwd, [...HARDENED_GIT_ARGS, ...args]);

/** Refuses a repository (or worktree) whose own config holds a key that can run a program (`git-guard.ts`). */
async function refuseUnsafeConfig(dir: string) {
  const listed = await safeGit(dir, CONFIG_LIST_ARGS);
  if (listed.code !== 0) {
    throw new RunnerError("bad_request", gitWhy(listed, "git couldn't read the repository's config"));
  }
  const key = unsafeRepoConfig(listed.stdout);
  if (key) throw new RunnerError("bad_request", unsafeConfigMessage(key));
}

/** git's last meaningful line, for people. */
export function gitWhy(run: GitResult, fallback: string) {
  if (run.timedOut) return "git took too long";
  const lines = `${run.stderr}\n${run.stdout}`
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fatal = lines.filter((l) => /^(fatal|error):/i.test(l));
  return ((fatal.at(-1) ?? lines.at(-1) ?? fallback) || fallback).slice(0, 500);
}

const out = (r: GitResult) => (r.code === 0 ? r.stdout.trim() : "");

/** `agentes.json` at the repository root, as far as it makes sense (bad shapes are ignored, never fatal). */
export interface ProjectConfig {
  copy?: string[];
  /** `""`: nothing to run. */
  setup?: string;
}

export function readProjectConfig(dir: string): ProjectConfig {
  let raw: unknown;
  try {
    const file = path.join(dir, "agentes.json");
    if (!lstatSync(file).isFile()) return {};
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const v = raw as Record<string, unknown>;
  const config: ProjectConfig = {};
  if (Array.isArray(v.copy)) {
    config.copy = v.copy
      .filter((p): p is string => typeof p === "string" && p.trim() !== "" && p.length <= PROJECT_PATH_MAX)
      .slice(0, PROJECT_COPY_MAX);
  }
  if (typeof v.setup === "string" && v.setup.length <= PROJECT_SETUP_MAX) config.setup = v.setup.trim();
  return config;
}

/** What prepares a folder: `agentes.json` `setup`, else the install for the root lockfile; null for nothing. */
export function setupCommandFor(dir: string, config: ProjectConfig = readProjectConfig(dir)): string | null {
  if (config.setup !== undefined) return config.setup || null;
  const has = (f: string) => existsSync(path.join(dir, f));
  if (has("bun.lock") || has("bun.lockb")) return "bun install";
  if (has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile";
  if (has("package-lock.json")) return "npm ci";
  if (has("yarn.lock")) return "yarn install --frozen-lockfile";
  return null;
}

/** A branch name git accepts, or a clear refusal. */
async function checkBranch(cwd: string, branch: unknown): Promise<string> {
  const b = typeof branch === "string" ? branch.trim() : "";
  if (!b || b.length > 200 || b.startsWith("-")) throw new RunnerError("bad_request", `Invalid branch name ${b}`);
  const r = await safeGit(cwd, ["check-ref-format", "--branch", b]);
  if (r.code !== 0) throw new RunnerError("bad_request", `Invalid branch name ${b}`);
  return b;
}

/**
 * The repository at `repo` (relative to the agent's folder): its top level,
 * which must be inside the agent's folder (a folder that only sits inside a
 * bigger repository, such as a workspace kept in git, is not one).
 */
async function repoRoot(folder: string, repo: unknown): Promise<string> {
  const resolved = await resolveInWorkspace(folder, typeof repo === "string" ? repo : "");
  if (!resolved.exists) throw new RunnerError("not_found", `The folder ${String(repo)} doesn't exist`);
  const top = await safeGit(resolved.abs, ["rev-parse", "--show-toplevel"]);
  if (top.code === null && /not installed/.test(top.stderr)) {
    throw new RunnerError("bad_request", "git is not installed on this computer");
  }
  const root = out(top);
  if (!root) {
    // Truly no git here: the server lets the mission work in the folder itself.
    if (/not a git repository/i.test(top.stderr)) throw new RunnerError("not_git", "not a git repository");
    throw new RunnerError("bad_request", gitWhy(top, "git couldn't read the repository"));
  }
  let real = "";
  try {
    real = realpathSync(root);
  } catch {}
  if (!real || !isInside(folder, real)) {
    // Inside a bigger repository (a workspace kept in git): never "no git", the person's checkout is not ours.
    throw new RunnerError(
      "outside_workspace",
      `${String(repo) || "The folder"} is inside a git repository that starts outside the agent's folder`,
    );
  }
  await refuseUnsafeConfig(real);
  return real;
}

/** The worktree's folder: inside the agent's folder, never the folder or the repository itself. */
async function worktreeTarget(folder: string, root: string, input: unknown): Promise<string> {
  const resolved = await resolveInWorkspace(folder, typeof input === "string" ? input : "");
  if (resolved.rel === "" || resolved.abs === root) {
    throw new RunnerError("bad_request", "The mission's folder must be a folder of its own");
  }
  return resolved.abs;
}

const branchExists = async (root: string, branch: string) =>
  (await safeGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;

/** The branch checked out in `dir` ("" when detached). */
const currentBranch = async (dir: string) => out(await safeGit(dir, ["symbolic-ref", "--short", "-q", "HEAD"]));

const commonDir = async (dir: string) => {
  const r = out(await safeGit(dir, ["rev-parse", "--git-common-dir"]));
  try {
    return r ? realpathSync(path.resolve(dir, r)) : "";
  } catch {
    return "";
  }
};

/** Where a worktree lists the files `ensure` copied into it (in its own git dir, so per worktree). */
const COPIED_LIST = "agentes-copied";

/** The worktree's own git dir (`.git/worktrees/<name>` for a linked worktree); "" outside git. */
async function ownGitDir(dir: string) {
  const r = out(await safeGit(dir, ["rev-parse", "--git-dir"]));
  return r ? path.resolve(dir, r) : "";
}

/** The files `ensure` copied into the worktree at `dir` (none outside a mission's worktree). */
export async function copiedFiles(dir: string): Promise<string[]> {
  const gitDir = await ownGitDir(dir);
  if (!gitDir) return [];
  try {
    return readFileSync(path.join(gitDir, COPIED_LIST), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The pathspecs of an end-of-item commit in `dir`: the whole tree but the
 * files `ensure` copied that git doesn't ignore already (a `.env` it would
 * show as untracked; naming an ignored one makes `git add` fail). Empty when
 * there is none (the plain `git add -A`).
 */
export async function commitPathspecs(dir: string): Promise<string[]> {
  const copied = await copiedFiles(dir);
  if (!copied.length) return [];
  const top = out(await safeGit(dir, ["rev-parse", "--show-toplevel"])) || dir;
  const ignored = new Set(
    (await safeGit(top, ["check-ignore", "--", ...copied])).stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const shown = copied.filter((p) => !ignored.has(p));
  return shown.length ? [":/", ...shown.map((p) => `:(top,exclude,literal)${p}`)] : [];
}

/**
 * Copies the files git ignores from the repository into the new worktree:
 * `agentes.json` `copy`, else the `.env*` files at the root. Only regular
 * files git doesn't track, whose real path stays inside the repository; never
 * over a file the worktree already has. What was copied is listed in the
 * worktree's own git dir (never the repository's shared `info/exclude`,
 * which would hide them in the person's checkout too), and the end-of-item
 * commit leaves those paths out (`commitPathspecs`). Returns what was copied.
 */
async function copyIgnored(root: string, target: string, config: ProjectConfig): Promise<string[]> {
  let wanted: string[];
  if (config.copy) {
    wanted = config.copy.flatMap((p) => {
      try {
        const rel = normalizeRequestPath(p);
        return rel ? [rel] : [];
      } catch {
        return [];
      }
    });
  } else {
    try {
      wanted = readdirSync(root)
        .filter((n) => n.startsWith(".env"))
        .sort();
    } catch {
      wanted = [];
    }
    // By default only what git ignores: an agent's own `git add -A` can't take it either.
    if (wanted.length) {
      const ignored = new Set(
        (await safeGit(root, ["check-ignore", "--", ...wanted])).stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
      wanted = wanted.filter((n) => ignored.has(n));
    }
  }
  const copied: string[] = [];
  for (const rel of [...new Set(wanted)]) {
    const source = path.join(root, ...rel.split("/"));
    try {
      if (!isInside(root, realpathSync(source))) continue;
      if (!lstatSync(source).isFile()) continue;
    } catch {
      continue;
    }
    if (out(await safeGit(root, ["ls-files", "--", rel]))) continue;
    const dest = path.join(target, ...rel.split("/"));
    if (existsSync(dest)) continue;
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      // A folder on the way that is a link out of the worktree: skip.
      if (!isInside(realpathSync(target), realpathSync(path.dirname(dest)))) continue;
      copyFileSync(source, dest);
    } catch {
      continue;
    }
    copied.push(rel);
  }
  const gitDir = copied.length ? await ownGitDir(target) : "";
  if (gitDir) {
    try {
      writeFileSync(path.join(gitDir, COPIED_LIST), `${copied.join("\n")}\n`);
    } catch {
      // Best effort: without the list a commit could take a copied file the repository doesn't ignore.
    }
  }
  return copied;
}

/**
 * Adds a pattern to the repository's `info/exclude` (never committed, never
 * shown as untracked; shared by all its worktrees). Best effort.
 */
export function excludeLocally(cwd: string, pattern: string) {
  const gitDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", windowsHide: true });
  if (gitDir.error || gitDir.status !== 0) return;
  const exclude = path.join(path.resolve(cwd, gitDir.stdout.trim()), "info", "exclude");
  try {
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.split("\n").includes(pattern)) {
      mkdirSync(path.dirname(exclude), { recursive: true });
      writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
    }
  } catch {
    // only cosmetic
  }
}

export async function ensureMissionWorktree(
  folder: string,
  req: Extract<MissionWorktreeRequest, { action: "ensure" }>,
): Promise<MissionWorktreeEnsured> {
  const root = await repoRoot(folder, req.repo);
  const branch = await checkBranch(root, req.branch);
  const target = await worktreeTarget(folder, root, req.path);
  const baseSha = typeof req.baseSha === "string" && SHA.test(req.baseSha.trim()) ? req.baseSha.trim() : undefined;
  if (req.baseSha !== undefined && !baseSha) throw new RunnerError("bad_request", "baseSha is not a commit id");
  const relPath = path.relative(folder, target).split(path.sep).join("/");
  const repoBranch = await currentBranch(root);
  excludeLocally(root, ".worktrees/");
  excludeLocally(root, ".agentes/");

  let created = false;
  let newBase: string | undefined;
  if (existsSync(target)) {
    // An empty folder left behind (a crash before the checkout) counts as gone.
    let empty = false;
    try {
      empty = lstatSync(target).isDirectory() && readdirSync(target).length === 0;
    } catch {}
    if (empty) rmdirSync(target);
  }
  if (existsSync(target)) {
    const top = out(await safeGit(target, ["rev-parse", "--show-toplevel"]));
    let topReal = "";
    try {
      topReal = top ? realpathSync(top) : "";
    } catch {}
    if (topReal !== target || (await commonDir(target)) !== (await commonDir(root))) {
      throw new RunnerError("bad_request", `${relPath} exists and is not a worktree of this repository`);
    }
    const on = await currentBranch(target);
    if (on !== branch) {
      throw new RunnerError("bad_request", `${relPath} is on ${on || "a detached HEAD"}, not on ${branch}`);
    }
  } else if (await branchExists(root, branch)) {
    // The folder is gone, the work is not: add it again from the branch.
    await safeGit(root, ["worktree", "prune"]);
    mkdirSync(path.dirname(target), { recursive: true });
    const add = await safeGit(root, ["worktree", "add", target, branch]);
    if (add.code !== 0) throw new RunnerError("bad_request", `git worktree add failed: ${gitWhy(add, "unknown")}`);
    created = true;
  } else if (baseSha) {
    throw new RunnerError("branch_missing", `Neither ${relPath} nor the branch ${branch} exists any more`);
  } else {
    const head = out(await safeGit(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]));
    if (!head) throw new RunnerError("bad_request", "The repository has no commits yet");
    mkdirSync(path.dirname(target), { recursive: true });
    const add = await safeGit(root, ["worktree", "add", "-b", branch, target, head]);
    if (add.code !== 0) throw new RunnerError("bad_request", `git worktree add failed: ${gitWhy(add, "unknown")}`);
    created = true;
    newBase = head;
  }

  // A worktree may have config of its own (`extensions.worktreeConfig`): the same check before `status`.
  await refuseUnsafeConfig(target);
  // The project's own file wins from the branch; the person's copy (not committed yet) otherwise.
  const config = existsSync(path.join(target, "agentes.json")) ? readProjectConfig(target) : readProjectConfig(root);
  const copied = created ? await copyIgnored(root, target, config) : [];
  const specs = await commitPathspecs(target);
  const dirty = out(await safeGit(target, ["status", "--porcelain", ...(specs.length ? ["--", ...specs] : [])])) !== "";
  // An existing branch: the base the server gave, else where it left the repository's branch.
  const reportedBase =
    newBase ?? baseSha ?? (repoBranch ? out(await safeGit(root, ["merge-base", repoBranch, branch])) : "");
  return {
    path: relPath,
    branch,
    baseBranch: repoBranch,
    baseSha: reportedBase,
    created,
    dirty,
    setupCommand: setupCommandFor(target, config),
    copied,
  };
}

export async function removeMissionWorktree(
  folder: string,
  req: Extract<MissionWorktreeRequest, { action: "remove" }>,
): Promise<MachineReplies["mission.worktree"]> {
  const root = await repoRoot(folder, req.repo);
  const branch = await checkBranch(root, req.branch);
  const target = await worktreeTarget(folder, root, req.path);
  let removed = false;
  if (existsSync(target)) {
    const rm = await safeGit(root, ["worktree", "remove", "--force", target]);
    if (rm.code !== 0) throw new RunnerError("bad_request", `git worktree remove failed: ${gitWhy(rm, "unknown")}`);
    removed = true;
  }
  await safeGit(root, ["worktree", "prune"]);
  if (req.deleteBranch === true && (await branchExists(root, branch))) {
    const del = await safeGit(root, ["branch", "-D", branch]);
    if (del.code !== 0) throw new RunnerError("bad_request", `git branch -D failed: ${gitWhy(del, "unknown")}`);
  }
  return { removed };
}

/** `op: "mission.worktree"` for the agent's folder (a real path). */
export function missionWorktree(
  folder: string,
  req: MissionWorktreeRequest,
): Promise<MachineReplies["mission.worktree"]> {
  if (req.action === "ensure") return ensureMissionWorktree(folder, req);
  if (req.action === "remove") return removeMissionWorktree(folder, req);
  throw new RunnerError(
    "bad_request",
    `Unknown mission.worktree action ${String((req as { action?: unknown }).action)}`,
  );
}
