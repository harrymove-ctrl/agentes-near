import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentScope,
  GIT_CHECKOUTS_DIR,
  GIT_SYNC_LIMITS,
  GITHUB_APP_TOKEN,
  type GitSyncRepo,
  type GitSyncRequest,
  isGitRepoName,
  type MachineReplies,
} from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { CONFIG_LIST_ARGS, HARDENED_GIT_ARGS, unsafeConfigMessage, unsafeRepoConfig } from "./git-guard";
import { resolveInWorkspace } from "./paths";

/**
 * `git.sync` (protocol 11, ADR 0024 addendum; ADR 0116): an agent's checkouts of
 * GitHub repositories, in its own folder, through the server's git proxy.
 *
 * - Our proxy credential (never a GitHub token) is written to
 *   `<runner home>/git/<agent id>.token` (mode 600, outside the agent's
 *   folder) and refreshed with every request. Each checkout's local config
 *   resets the machine's credential helpers and adds one that prints that
 *   file, so `git fetch` and `git push` there use it; nothing global changes
 *   on the machine.
 * - The remote is the proxy URL (`…/api/git/{org}/{connection}/owner/name.git`);
 *   the proxy checks the agent's repositories and lets it push only to
 *   `agentes/<handle>/…`.
 * - With a GitHub App token for the repository (protocol 35, ADR 0116), the
 *   checkout fetches straight from github.com with it (its own file; the
 *   helper hands it only to github.com) and pushes through the proxy
 *   (`remote.origin.pushurl`), so every push is still policed there. Without
 *   one, both go through the proxy, as before.
 * - A clone runs apart from its request: it outlives a dropped socket, the
 *   answer past the deadline is `cloning`, and a later `git.sync` of the same
 *   folder waits for it again. At most `MAX_CLONES` run at once; it stops
 *   when git shows no progress for `CLONE_STALL_MS`, not at a fixed time. The
 *   sync before a turn never waits for one.
 * - With a GitHub token and a shared cache (`gitCache` in single-user mode,
 *   root's `systemGitCache` through `cacheFill` in system mode), the
 *   repository is first fetched into `<cache>/<connection>/<owner>/<name>.git`
 *   with the agent's own token, and the clone borrows its objects
 *   (`--reference`); the cache never prunes. Otherwise a new clone is partial
 *   (`--filter=blob:none`). A clone GitHub refuses tries once more through
 *   the proxy.
 * - An existing checkout is fetched and its default branch fast-forwarded
 *   (never a merge, never over local changes). Failures (offline, refused)
 *   come back per repository; the request itself fails only on a bad request.
 */

const TOKEN = /^agtgit1\.[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{20,100}$/;
const AGENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const GITHUB_ORIGIN = "https://github.com";

/** Clones running at once on this computer (root's slots in system mode); the others wait their turn. */
export const MAX_CLONES = 2;
/** A clone that shows no progress for this long has stalled and is stopped. */
export const CLONE_STALL_MS = 10 * 60_000;
/** Even a progressing clone stops after this long. */
const CLONE_MAX_MS = 24 * 3600_000;
export const WAITING_FOR_CLONE = "waiting for another download to finish";

export interface GitContext {
  /** The agent's folder (real path). */
  folder: string;
  /** `<runner home>/git`: where the agents' proxy credentials are kept. */
  gitDir: string;
  agent: AgentScope;
  signal: AbortSignal;
  /** git's progress, when the request asked for it. */
  output?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** The git command (tests: a path to a fake). */
  gitCommand?: string;
  /** `<runner home>/git-cache`: the shared read-only mirrors (single-user runners only). */
  gitCache?: string;
  /** Clone slots; this process's own by default (`localCloneSlot`). */
  cloneSlot?: CloneSlots;
  /** Root's shared cache (a system-mode worker): used instead of `gitCache`. */
  cacheFill?: CacheFill;
  /** Root's cache: git runs as its owner, with its own HOME, and these variables. */
  runAs?: { uid: number; gid: number; home: string };
  env?: Record<string, string>;
}

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stalled?: boolean;
}

/** A path as one word for `sh` (the credential helper is a shell snippet; Windows paths with `/`). */
const shWord = (p: string) => `'${p.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;

/** The credential helper our checkouts use: prints the agent's proxy credential, only for `get`. */
export function credentialHelper(tokenFile: string) {
  return `!f() { test "$1" = get || exit 0; echo username=agentes; printf 'password=%s\\n' "$(cat ${shWord(tokenFile)})"; }; f`;
}

/**
 * The helper of a checkout that fetches straight from GitHub: the GitHub token for github.com, our proxy
 * credential for anything else (the proxy, where it pushes). Each host only ever sees its own.
 */
export function directCredentialHelper(tokenFile: string, githubFile: string) {
  return [
    `!f() { test "$1" = get || exit 0; h=; while read -r l && [ -n "$l" ]; do [ "$l" = host=github.com ] && h=1; done;`,
    `if [ -n "$h" ]; then echo username=x-access-token; printf 'password=%s\\n' "$(cat ${shWord(githubFile)})";`,
    `else echo username=agentes; printf 'password=%s\\n' "$(cat ${shWord(tokenFile)})"; fi; }; f`,
  ].join(" ");
}

/** Where a checkout fetches and pushes, and its credential helper. */
interface Remote {
  url: string;
  /** Set when fetches go straight to GitHub: pushes still go through the proxy. */
  pushUrl?: string;
  helper: string;
}

/** `-c` options for one git command: no credential helper of the machine, only ours. */
const authArgs = (remote: Remote) => ["-c", "credential.helper=", "-c", `credential.helper=${remote.helper}`];

function remoteFor(proxy: { base: string }, repo: string, tokenFile: string, githubFile?: string): Remote {
  const proxyUrl = `${proxy.base}${repo}.git`;
  if (!githubFile) return { url: proxyUrl, helper: credentialHelper(tokenFile) };
  return {
    url: `${GITHUB_ORIGIN}/${repo}.git`,
    pushUrl: proxyUrl,
    helper: directCredentialHelper(tokenFile, githubFile),
  };
}

/** The proxy URL must be ours: http(s), a `/api/git/` path, no credentials in it. */
function checkProxy(proxy: GitSyncRequest["proxy"] | undefined) {
  if (!proxy || typeof proxy.base !== "string" || typeof proxy.token !== "string") {
    throw new RunnerError("bad_request", "proxy is required");
  }
  let url: URL;
  try {
    url = new URL(proxy.base);
  } catch {
    throw new RunnerError("bad_request", "proxy.base is not a URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.pathname.includes("/api/git/")) {
    throw new RunnerError("bad_request", "proxy.base is not a git proxy URL");
  }
  if (!TOKEN.test(proxy.token)) throw new RunnerError("bad_request", "proxy.token is not a proxy credential");
  return { base: proxy.base.endsWith("/") ? proxy.base : `${proxy.base}/`, token: proxy.token };
}

/**
 * Runs git with an argv (no shell), a deadline and the request's cancel, with `HARDENED_GIT_ARGS`
 * (no hooks, no fsmonitor: `git-guard.ts`). Never throws on git's own failure.
 */
function runGit(
  ctx: GitContext,
  args: string[],
  opts: { cwd: string; deadline: number; progress?: boolean; stallMs?: number },
) {
  return new Promise<GitRun>((resolve) => {
    const ms = Math.max(1000, opts.deadline - Date.now());
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ctx.gitCommand ?? "git", [...HARDENED_GIT_ARGS, ...args], {
        cwd: opts.cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          LC_ALL: "C",
          ...(ctx.runAs ? { HOME: ctx.runAs.home, XDG_CONFIG_HOME: "" } : {}),
          ...ctx.env,
        },
        ...(ctx.runAs ? { uid: ctx.runAs.uid, gid: ctx.runAs.gid } : {}),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const keep = (s: string, add: string) => (s.length > 64_000 ? s.slice(-32_000) : s) + add;
    child.stdout?.on("data", (d: Buffer) => {
      stdout = keep(stdout, d.toString("utf8"));
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString("utf8");
      stderr = keep(stderr, text);
      if (opts.progress) ctx.output?.("stderr", text);
      watchStall();
    });
    const stop = () => killTree(child, "SIGTERM");
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, ms);
    function watchStall() {
      if (!opts.stallMs) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        timedOut = true;
        stalled = true;
        stop();
      }, opts.stallMs);
    }
    watchStall();
    ctx.signal.addEventListener("abort", stop, { once: true });
    let settled = false;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stallTimer);
      ctx.signal.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr, timedOut, stalled });
    };
    // Through EventEmitter: some @types/node versions lose ChildProcess's event methods.
    const events = child as unknown as EventEmitter;
    events.on("error", (err: NodeJS.ErrnoException) => {
      stderr = keep(stderr, err.code === "ENOENT" ? "git is not installed" : err.message);
      done(null);
    });
    events.on("close", (code: number | null) => done(code));
  });
}

/** git's last meaningful line (progress lines dropped), for people. */
function why(run: GitRun, fallback: string) {
  if (run.stalled) return "the download stopped making progress (network slow or offline)";
  if (run.timedOut) return "it took too long (network slow or offline)";
  const lines = run.stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(
      (l) => l && !/^(remote: )?(Counting|Compressing|Receiving|Resolving|Enumerating|Total|Updating files)/.test(l),
    );
  const fatal = lines.filter((l) => /^(fatal|error|agentes):/i.test(l) || /^remote: agentes:/.test(l));
  return ((fatal.at(-1) ?? lines.at(-1) ?? fallback) || fallback).slice(0, GIT_SYNC_LIMITS.message);
}

/** Writes a credential (mode 600, in folders only the runner reads) and returns its file. */
function writeSecret(file: string, token: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Each checkout's own settings: our remote, only our credential helpers, the agent as author. */
async function configure(
  ctx: GitContext,
  cwd: string,
  input: { remote: Remote; author: GitSyncRequest["author"] },
  deadline: number,
) {
  const set = (...args: string[]) => runGit(ctx, ["config", "--local", ...args], { cwd, deadline });
  // Whatever the last sync left (proxy only, or straight from GitHub), before this one's.
  await set("--unset-all", "credential.helper");
  await set("--unset-all", "remote.origin.pushurl");
  const steps: string[][] = [
    ["remote.origin.url", input.remote.url],
    ...(input.remote.pushUrl ? [["remote.origin.pushurl", input.remote.pushUrl]] : []),
    ["--add", "credential.helper", ""],
    ["--add", "credential.helper", input.remote.helper],
    ["credential.useHttpPath", "false"],
    ["user.name", input.author.name],
    ["user.email", input.author.email],
    ["push.autoSetupRemote", "true"],
  ];
  for (const s of steps) {
    const r = await set(...s);
    if (r.code !== 0) throw new Error(why(r, "git config failed"));
  }
}

/** Throws (a per-repository failure) when the checkout's own config holds a key that can run a program. */
async function refuseUnsafeConfig(ctx: GitContext, cwd: string, deadline: number) {
  const listed = await runGit(ctx, CONFIG_LIST_ARGS, { cwd, deadline });
  if (listed.code !== 0) throw new Error(why(listed, "git couldn't read the checkout's config"));
  const key = unsafeRepoConfig(listed.stdout);
  if (key) throw new Error(unsafeConfigMessage(key));
}

const trimOut = (r: GitRun) => r.stdout.trim();

/** HEAD, the current branch and the remote's default branch of a checkout. */
async function describeCheckout(ctx: GitContext, cwd: string, deadline: number) {
  const [head, branch, remoteHead] = await Promise.all([
    runGit(ctx, ["rev-parse", "--short", "HEAD"], { cwd, deadline }),
    runGit(ctx, ["branch", "--show-current"], { cwd, deadline }),
    runGit(ctx, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd, deadline }),
  ]);
  const def = remoteHead.code === 0 ? trimOut(remoteHead).replace(/^origin\//, "") : "";
  return {
    head: head.code === 0 ? trimOut(head) : "",
    branch: branch.code === 0 ? trimOut(branch) : "",
    defaultBranch: def,
  };
}

/** Fetches and fast-forwards the default branch (checked out and clean, or just its ref). Returns a warning, if any. */
async function update(ctx: GitContext, cwd: string, origin: Remote, deadline: number): Promise<string | undefined> {
  const fetched = await runGit(ctx, [...authArgs(origin), "fetch", "--prune", "--quiet", "origin"], {
    cwd,
    deadline,
  });
  if (fetched.code !== 0) throw new Error(why(fetched, "git fetch failed"));
  const now = await describeCheckout(ctx, cwd, deadline);
  const branch = now.branch;
  let defaultBranch = now.defaultBranch;
  if (!defaultBranch) {
    await runGit(ctx, [...authArgs(origin), "remote", "set-head", "origin", "--auto"], { cwd, deadline });
    defaultBranch = (await describeCheckout(ctx, cwd, deadline)).defaultBranch;
  }
  if (!defaultBranch) return "the remote's default branch is unknown";
  const remote = `refs/remotes/origin/${defaultBranch}`;
  if (branch === defaultBranch) {
    const ff = await runGit(ctx, ["merge", "--ff-only", "--quiet", remote], { cwd, deadline });
    if (ff.code !== 0) return `${defaultBranch} wasn't moved: it has local changes or commits of its own`;
    return undefined;
  }
  const local = `refs/heads/${defaultBranch}`;
  const exists = await runGit(ctx, ["rev-parse", "--verify", "--quiet", local], { cwd, deadline });
  if (exists.code !== 0) return undefined;
  const ancestor = await runGit(ctx, ["merge-base", "--is-ancestor", local, remote], { cwd, deadline });
  if (ancestor.code !== 0) return `${defaultBranch} wasn't moved: it has commits of its own`;
  const moved = await runGit(ctx, ["update-ref", local, remote], { cwd, deadline });
  if (moved.code !== 0) return `${defaultBranch} wasn't moved`;
  return undefined;
}

/** The checkouts already in `repos/` (one `owner/name` level, with a `.git`). */
function existingCheckouts(folder: string): string[] {
  const root = path.join(folder, GIT_CHECKOUTS_DIR);
  const found: string[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const owner of dirs(root)) {
    for (const name of dirs(path.join(root, owner))) {
      const repo = `${owner}/${name}`;
      if (isGitRepoName(repo) && existsSync(path.join(root, owner, name, ".git"))) found.push(repo);
    }
  }
  return found.slice(0, GIT_SYNC_LIMITS.repos);
}

/** A clone running apart from the request that started it (`git.sync` of the same folder joins it). */
interface CloneJob {
  done: Promise<GitSyncRepo>;
  /** git's last progress line, or `WAITING_FOR_CLONE`. */
  status: string;
  listeners: Set<(chunk: string) => void>;
}

/**
 * A clone slot: resolves with its release once one is free, calling `onWait` first when it has to wait. A
 * system-mode worker asks root for one (`WorkerLink.cloneSlot`), so the cap is the computer's, not the agent's.
 */
export type CloneSlots = (onWait: () => void) => Promise<() => void>;

/**
 * Root's shared cache for a system-mode worker (`WorkerLink.cacheFill`, `systemGitCache`): the cached repository
 * the agent may borrow from, fetched with its own GitHub token, or null.
 */
export type CacheFill = (input: { connection: string; repo: string; github: string }) => Promise<string | null>;

const clones = new Map<string, CloneJob>();
let clonesRunning = 0;
const cloneQueue: (() => void)[] = [];

/** This process's slots: the computer's in single-user mode, and in a system-mode runner's root. */
export const localCloneSlot: CloneSlots = async (onWait) => {
  if (clonesRunning < MAX_CLONES) clonesRunning++;
  else {
    onWait();
    await new Promise<void>((resolve) => cloneQueue.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = cloneQueue.shift();
    if (next) next();
    else clonesRunning--;
  };
};

const cacheLocks = new Map<string, Promise<unknown>>();

/** Runs `fn` alone for `key` (one fetch into a cached repository at a time). */
function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (cacheLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  cacheLocks.set(key, next);
  return next.finally(() => {
    if (cacheLocks.get(key) === next) cacheLocks.delete(key);
  });
}

/** The connection id in our proxy URL (`…/api/git/{org}/{connection}/`). */
const connectionOf = (base: string) => new URL(base).pathname.split("/").filter(Boolean).at(-1) ?? "default";
const CONNECTION = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Fetches every branch and tag of `url` into the bare repository `dir` (made when it has no HEAD; `shared`:
 * readable by whoever may enter `dir`) with the `auth` options. Never pruned: checkouts borrow its objects.
 */
async function fetchMirror(ctx: GitContext, dir: string, url: string, auth: string[], shared: boolean) {
  const opts = { cwd: path.dirname(dir), deadline: Date.now() + CLONE_MAX_MS, stallMs: CLONE_STALL_MS };
  if (!existsSync(path.join(dir, "HEAD"))) {
    const init = ["init", "--quiet", "--bare", ...(shared ? ["--shared=all"] : []), dir];
    if ((await runGit(ctx, init, opts)).code !== 0) return false;
    for (const [k, v] of [
      ["gc.pruneExpire", "never"],
      ["gc.cruftPacks", "true"],
      ["fetch.prune", "false"],
    ] as const) {
      if ((await runGit(ctx, ["--git-dir", dir, "config", k, v], opts)).code !== 0) return false;
    }
  }
  const fetched = await runGit(
    ctx,
    [
      ...auth,
      "--git-dir",
      dir,
      "fetch",
      "--progress",
      "--no-prune",
      url,
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ],
    { ...opts, progress: true },
  );
  return fetched.code === 0;
}

/**
 * Fetches `repo` into the single-user runner's cache with the agent's own credentials (so the agent reaches only
 * what it may fetch) and returns the cached repository, or null when it couldn't.
 */
function fillCache(ctx: GitContext, cacheRoot: string, connection: string, repo: string, remote: Remote) {
  const dir = path.join(cacheRoot, connection, `${repo}.git`);
  return locked(dir, async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return (await fetchMirror(ctx, dir, remote.url, authArgs(remote), false)) ? dir : null;
  });
}

/** git's helper in root's cache: the GitHub token from the fetch's own environment (only github.com is fetched). */
const ENV_GITHUB_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; printf 'password=%s\\n' "$AGENTES_GITHUB_TOKEN"; }; f`;

export interface SystemGitCacheOptions {
  /** `/var/cache/agentes-git`. */
  root: string;
  /** The system user `agentes-git` that owns the cached repositories (made on first use). */
  owner: () => { uid: number; gid: number };
  /** Lets one agent's uid into one cached repository (`setfacl -m u:<uid>:rx`); false when it couldn't. */
  grant: (dir: string, uid: number) => boolean | Promise<boolean>;
  gitCommand?: string;
}

/**
 * Root's cache on a system-mode computer (ADR 0116 §4): `<root>/<connection>/<owner>/<name>.git`, a bare
 * repository owned by `agentes-git`, mode 700, its contents readable by whoever may enter it. Each fill fetches
 * from github.com with the asking agent's own single-repository token, as `agentes-git`; only when GitHub let that
 * agent fetch does its uid get into that one repository (an ACL on its folder). An agent that was never let in
 * can't read it, whoever else filled it.
 */
export function systemGitCache(o: SystemGitCacheOptions) {
  return (input: { connection: string; repo: string; github: string; uid: number }): Promise<string | null> => {
    if (
      !CONNECTION.test(input.connection) ||
      !isGitRepoName(input.repo) ||
      !GITHUB_APP_TOKEN.test(input.github) ||
      !Number.isSafeInteger(input.uid)
    ) {
      return Promise.resolve(null);
    }
    const dir = path.join(o.root, input.connection, `${input.repo}.git`);
    return locked(dir, async () => {
      const owner = o.owner();
      // Root's folders above it: anyone may pass through, nobody but root may list or change them.
      for (const d of [o.root, path.join(o.root, input.connection), path.dirname(dir)]) {
        mkdirSync(d, { recursive: true, mode: 0o711 });
        chmodSync(d, 0o711);
      }
      const fresh = !existsSync(path.join(dir, "HEAD"));
      if (fresh) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chownSync(dir, owner.uid, owner.gid);
      }
      const ctx: GitContext = {
        folder: o.root,
        gitDir: o.root,
        agent: { id: "agentes-git", handle: "agentes-git", name: "agentes-git" },
        signal: new AbortController().signal,
        runAs: { ...owner, home: o.root },
        env: { AGENTES_GITHUB_TOKEN: input.github },
        ...(o.gitCommand ? { gitCommand: o.gitCommand } : {}),
      };
      const auth = ["-c", "credential.helper=", "-c", `credential.helper=${ENV_GITHUB_HELPER}`];
      const fetched = await fetchMirror(ctx, dir, `${GITHUB_ORIGIN}/${input.repo}.git`, auth, true);
      // `--shared=all` opens the folder itself to everyone: only the agents let in may enter it.
      if (fresh) chmodSync(dir, 0o700);
      return fetched && (await o.grant(dir, input.uid)) ? dir : null;
    });
  };
}

interface CloneInput {
  repo: string;
  base: GitSyncRepo;
  abs: string;
  /** Straight from GitHub when the request carried a token, else the proxy. */
  remote: Remote;
  /** Both through the proxy: where a clone GitHub refused tries again. */
  proxyRemote: Remote;
  /** The GitHub App token, for the shared cache. */
  github?: string;
  connection: string;
  author: GitSyncRequest["author"];
}

/** The cached repository a clone may borrow from, or null (no cache here, or the fill failed). */
async function cachedRepo(ctx: GitContext, job: CloneJob, input: CloneInput): Promise<string | null> {
  // Through the proxy, a full fetch would cost the server what the partial clone spares it: the cache only with a token.
  if (!input.github) return null;
  if (ctx.cacheFill) {
    job.status = "downloading into the computer's shared cache";
    return ctx.cacheFill({ connection: input.connection, repo: input.repo, github: input.github }).catch(() => null);
  }
  return ctx.gitCache ? fillCache(ctx, ctx.gitCache, input.connection, input.repo, input.remote) : null;
}

/** Clones one repository, waiting for a free slot first; `ctx` is the job's own (no request's cancel or output). */
async function runClone(ctx: GitContext, job: CloneJob, input: CloneInput): Promise<GitSyncRepo> {
  const release = await (ctx.cloneSlot ?? localCloneSlot)(() => {
    job.status = WAITING_FOR_CLONE;
    for (const l of job.listeners) l(`${WAITING_FOR_CLONE}\n`);
  });
  const clone = (remote: Remote, cached: string | null) =>
    runGit(
      ctx,
      [
        ...authArgs(remote),
        "clone",
        ...(cached ? ["--reference", cached] : ["--filter=blob:none"]),
        "--progress",
        "--origin",
        "origin",
        remote.url,
        input.abs,
      ],
      { cwd: path.dirname(input.abs), deadline: Date.now() + CLONE_MAX_MS, stallMs: CLONE_STALL_MS, progress: true },
    );
  try {
    mkdirSync(path.dirname(input.abs), { recursive: true });
    let remote = input.remote;
    let cloned = await clone(remote, await cachedRepo(ctx, job, input));
    if (cloned.code !== 0 && remote.pushUrl && !cloned.stalled) {
      // GitHub refused (the token ran out while the clone waited or filled the cache) or isn't reachable: once more
      // through the proxy, which the next sync moves back to GitHub with a fresh token.
      rmSync(input.abs, { recursive: true, force: true });
      remote = input.proxyRemote;
      cloned = await clone(remote, null);
    }
    if (cloned.code !== 0) throw new Error(why(cloned, "git clone failed"));
    const deadline = Date.now() + 120_000;
    await configure(ctx, input.abs, { remote, author: input.author }, deadline);
    const d = await describeCheckout(ctx, input.abs, deadline);
    return {
      ...input.base,
      status: "cloned",
      ...(d.branch ? { branch: d.branch } : {}),
      ...(d.defaultBranch ? { defaultBranch: d.defaultBranch } : {}),
      ...(d.head ? { head: d.head } : {}),
    };
  } catch (err) {
    return {
      ...input.base,
      message: (err instanceof Error ? err.message : String(err)).slice(0, GIT_SYNC_LIMITS.message),
    };
  } finally {
    release();
  }
}

/** Starts the clone of `key` apart from the request, or returns the one already running. */
function startClone(ctx: GitContext, key: string, input: CloneInput) {
  const running = clones.get(key);
  if (running) return running;
  const job: CloneJob = { done: Promise.resolve(input.base), status: "starting", listeners: new Set() };
  const jobCtx: GitContext = {
    ...ctx,
    signal: new AbortController().signal,
    output: (_stream, chunk) => {
      const line = chunk
        .split(/[\r\n]+/)
        .filter((l) => l.trim())
        .at(-1);
      if (line) job.status = line.trim().slice(0, 200);
      for (const l of job.listeners) l(chunk);
    },
  };
  job.done = runClone(jobCtx, job, input).finally(() => clones.delete(key));
  clones.set(key, job);
  return job;
}

/** A clone still going, as a sync answers it. */
const cloningReply = (job: CloneJob, base: GitSyncRepo): GitSyncRepo => ({
  ...base,
  status: "cloning",
  message: `still downloading in the background (${job.status})`.slice(0, GIT_SYNC_LIMITS.message),
});

/**
 * Waits for a clone until the request's deadline or cancel; `cloning` (it goes on) when it isn't done by then.
 * `queued`: the request that started it answers at once while it waits for a slot, so the agent hears that now; a
 * later request for it waits, as asked.
 */
async function awaitClone(
  ctx: GitContext,
  job: CloneJob,
  base: GitSyncRepo,
  deadline: number,
  queued = false,
): Promise<GitSyncRepo> {
  let stop = () => {};
  const later = new Promise<null>((resolve) => {
    stop = () => resolve(null);
  });
  const listener = (chunk: string) => {
    ctx.output?.("stderr", chunk);
    if (queued && job.status === WAITING_FOR_CLONE) stop();
  };
  job.listeners.add(listener);
  if (queued && job.status === WAITING_FOR_CLONE) stop();
  const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
  ctx.signal.addEventListener("abort", stop, { once: true });
  try {
    return (await Promise.race([job.done, later])) ?? cloningReply(job, base);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", stop);
    job.listeners.delete(listener);
  }
}

/** `git.sync`: clones or updates the request's repositories (one at a time, within the deadline). */
export async function gitSync(ctx: GitContext, req: GitSyncRequest): Promise<MachineReplies["git.sync"]> {
  const proxy = checkProxy(req.proxy);
  const agentId = String(ctx.agent.id);
  if (!AGENT_ID.test(agentId)) throw new RunnerError("bad_request", "agent.id is invalid");
  // Before anything else in the request can refuse it: the agent's own `git fetch` and `git push` through the
  // proxy work only while this credential is fresh.
  const tokenFile = writeSecret(path.join(ctx.gitDir, `${agentId}.token`), proxy.token);
  const author = {
    name: typeof req.author?.name === "string" ? req.author.name.slice(0, 200) : "",
    email: typeof req.author?.email === "string" ? req.author.email.slice(0, 200) : "",
  };
  if (!author.name || !author.email) throw new RunnerError("bad_request", "author is required");
  if (!Array.isArray(req.repos)) throw new RunnerError("bad_request", "repos must be a list");
  const wanted: { repo: string; dir: string; clone: boolean; github?: string }[] = [];
  for (const r of req.repos.slice(0, GIT_SYNC_LIMITS.repos)) {
    if (!isGitRepoName(r?.repo)) throw new RunnerError("bad_request", "repo must be owner/name");
    if (r.github !== undefined && (typeof r.github !== "string" || !GITHUB_APP_TOKEN.test(r.github))) {
      throw new RunnerError("bad_request", "github is not a GitHub App token");
    }
    const dir = typeof r.dir === "string" && r.dir.trim() ? r.dir.trim() : `${GIT_CHECKOUTS_DIR}/${r.repo}`;
    wanted.push({ repo: r.repo, dir, clone: r.clone === true, ...(r.github ? { github: r.github } : {}) });
  }
  if (req.existing === true) {
    const seen = new Set(wanted.map((w) => w.dir.toLowerCase()));
    for (const repo of existingCheckouts(ctx.folder)) {
      const dir = `${GIT_CHECKOUTS_DIR}/${repo}`;
      if (!seen.has(dir.toLowerCase())) wanted.push({ repo, dir, clone: false });
    }
  }
  const seconds = Math.max(1, Math.min(GIT_SYNC_LIMITS.maxSeconds, Math.floor(Number(req.timeoutSeconds) || 60)));
  const deadline = Date.now() + seconds * 1000;
  const out: GitSyncRepo[] = [];
  for (const w of wanted) {
    const base: GitSyncRepo = { repo: w.repo, dir: w.dir, status: "failed" };
    try {
      if (ctx.signal.aborted) throw new Error("canceled");
      // Inside the agent's folder, never the folder itself (links that leave it are refused).
      const target = await resolveInWorkspace(ctx.folder, w.dir);
      if (target.rel === "") throw new RunnerError("bad_request", "dir can't be your folder itself");
      base.dir = target.rel;
      base.path = target.abs;
      // A fresh token also reaches a clone still going (git reads the file when it authenticates).
      const githubPath = path.join(ctx.gitDir, "github", agentId, `${w.repo}.token`);
      const githubFile = w.github ? writeSecret(githubPath, w.github) : undefined;
      const remote = remoteFor(proxy, w.repo, tokenFile, githubFile);
      const key = `${agentId}\0${target.abs}`;
      const running = clones.get(key);
      if (running) {
        // A clone of this folder is still going (started by an earlier request): `git_clone` waits for it, the
        // sync before a turn doesn't; neither touches it.
        out.push(w.clone ? await awaitClone(ctx, running, base, deadline) : cloningReply(running, base));
        continue;
      }
      // No token this time (the App, the repository or the agent's access is gone): none left on disk either.
      if (!githubFile) rmSync(githubPath, { force: true });
      if (!target.exists) {
        if (!w.clone) {
          out.push({ ...base, status: "missing" });
          continue;
        }
        const job = startClone(ctx, key, {
          repo: w.repo,
          base,
          abs: target.abs,
          remote,
          proxyRemote: remoteFor(proxy, w.repo, tokenFile),
          ...(w.github ? { github: w.github } : {}),
          connection: connectionOf(proxy.base),
          author,
        });
        out.push(await awaitClone(ctx, job, base, deadline, true));
        continue;
      }
      if (!statSync(target.abs).isDirectory() || !existsSync(path.join(target.abs, ".git"))) {
        throw new Error(`${target.rel} exists and isn't a git checkout`);
      }
      // An existing checkout's config may have been changed since it was cloned: only safe keys (`git-guard.ts`).
      await refuseUnsafeConfig(ctx, target.abs, deadline);
      await configure(ctx, target.abs, { remote, author }, deadline);
      let warning: string | undefined;
      let failure: string | undefined;
      try {
        warning = await update(ctx, target.abs, remote, deadline);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      const d = await describeCheckout(ctx, target.abs, deadline);
      out.push({
        ...base,
        status: failure ? "failed" : "updated",
        ...(d.branch ? { branch: d.branch } : {}),
        ...(d.defaultBranch ? { defaultBranch: d.defaultBranch } : {}),
        ...(d.head ? { head: d.head } : {}),
        ...((failure ?? warning) ? { message: (failure ?? warning ?? "").slice(0, GIT_SYNC_LIMITS.message) } : {}),
      });
    } catch (err) {
      if (err instanceof RunnerError && err.code === "bad_request") throw err;
      out.push({
        ...base,
        message: (err instanceof Error ? err.message : String(err)).slice(0, GIT_SYNC_LIMITS.message),
      });
    }
  }
  return { repos: out };
}
