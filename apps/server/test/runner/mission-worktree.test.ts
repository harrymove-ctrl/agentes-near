import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type MissionWorktreeEnsured,
  parseBaseBehind,
  parseMissionWorktreeEnsured,
  parseRunnerFrame,
  type RunnerFrame,
  type TaskDone,
} from "@agenteschat/adapters/machine-protocol";
import { handleRequest } from "../../runner/handlers";
import { copiedFiles, missionWorktree, readProjectConfig, setupCommandFor } from "../../runner/mission-worktree";
import { agentWorkspace } from "../../runner/paths";
import { commitChanges, TaskManager } from "../../runner/tasks";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const hasGit = spawnSync("git", ["--version"]).status === 0;
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };
const id = (n: number) => `0193aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;
const BRANCH = "agentes/000000bb/tabs";
const WT = ".worktrees/m-000000bb";

const run = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const out = (cwd: string, ...args: string[]) => run(cwd, ...args).stdout.trim();

/** An agent folder with a repository at `repos/app`: tracked `.env.example`, untracked `.env` and ignored `.env.local`. */
async function project() {
  const ws = tempDir("ws-");
  dirs.push(ws);
  const folder = await agentWorkspace(ws, AGENT);
  const repo = path.join(folder, "repos", "app");
  mkdirSync(repo, { recursive: true });
  run(repo, "init", "-q", "-b", "main");
  run(repo, "config", "user.email", "dev@agents.agentes.chat");
  run(repo, "config", "user.name", "Dev (agentes)");
  writeFileSync(path.join(repo, "README.md"), "hi\n");
  writeFileSync(path.join(repo, ".gitignore"), ".env.local\nnode_modules/\n");
  writeFileSync(path.join(repo, ".env.example"), "KEY=\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "init");
  writeFileSync(path.join(repo, ".env"), "KEY=1\n");
  writeFileSync(path.join(repo, ".env.local"), "LOCAL=1\n");
  return { ws, folder, repo, head: out(repo, "rev-parse", "HEAD") };
}

const ensure = (folder: string, extra: { baseSha?: string; path?: string; branch?: string } = {}) =>
  missionWorktree(folder, {
    action: "ensure",
    repo: "repos/app",
    path: extra.path ?? WT,
    branch: extra.branch ?? BRANCH,
    ...(extra.baseSha ? { baseSha: extra.baseSha } : {}),
  }) as Promise<MissionWorktreeEnsured>;

test.skipIf(!posix || !hasGit)(
  "ensure creates the branch from the checked-out branch's HEAD and copies only the .env files git ignores",
  async () => {
    const { folder, repo, head } = await project();
    const made = await ensure(folder);
    expect(made).toEqual({
      path: WT,
      branch: BRANCH,
      baseBranch: "main",
      baseSha: head,
      created: true,
      dirty: false,
      setupCommand: null,
      // `.env` is untracked but not ignored: by default it stays behind (an agent's `git add -A` would take it).
      copied: [".env.local"],
    });
    const wt = path.join(folder, WT);
    expect(out(wt, "symbolic-ref", "--short", "HEAD")).toBe(BRANCH);
    expect(readFileSync(path.join(wt, ".env.local"), "utf8")).toBe("LOCAL=1\n");
    expect(existsSync(path.join(wt, ".env"))).toBe(false);
    expect(readFileSync(path.join(wt, ".env.example"), "utf8")).toBe("KEY=\n");
    // `.agentes/` stays out of git; what was copied is listed in the worktree's own git dir, never in the
    // shared info/exclude: the person's checkout is left as it was.
    mkdirSync(path.join(wt, ".agentes"));
    writeFileSync(path.join(wt, ".agentes", "mission.md"), "# Mission\n");
    expect(out(wt, "status", "--porcelain")).toBe("");
    expect(out(repo, "status", "--porcelain")).toBe("?? .env");
    const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    for (const p of [".worktrees/", ".agentes/"]) expect(exclude.split("\n")).toContain(p);
    expect(exclude).not.toContain(".env");
    expect(await copiedFiles(wt)).toEqual([".env.local"]);
    expect(await copiedFiles(repo)).toEqual([]);

    // Again: nothing to do; loose changes are reported and left alone.
    writeFileSync(path.join(wt, "wip.txt"), "x\n");
    const again = await ensure(folder);
    expect(again).toMatchObject({ created: false, dirty: true, copied: [], baseBranch: "main", baseSha: head });
    expect(existsSync(path.join(wt, "wip.txt"))).toBe(true);
    // With the base the server keeps, that one is reported.
    expect((await ensure(folder, { baseSha: head.slice(0, 12) })).baseSha).toBe(head.slice(0, 12));
    expect(parseMissionWorktreeEnsured(made)).toEqual(made);
    expect(parseMissionWorktreeEnsured({ path: 1 })).toBeNull();
  },
);

test.skipIf(!posix || !hasGit)(
  "the runner's git runs no hook of the repository and refuses config that names a program",
  async () => {
    const { ws, folder, repo } = await project();
    // A hook left in the repository (made while commands were on): `worktree add` would run post-checkout.
    const marker = path.join(ws, "hook-ran");
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    run(repo, "config", "core.hooksPath", ".git/hooks");
    expect((await ensure(folder)).created).toBe(true);
    expect(existsSync(marker)).toBe(false);

    // Config that can run a program (here a filter driver `.gitattributes` would use): refused, nothing runs.
    run(repo, "config", "filter.evil.clean", `touch '${marker}'`);
    let message = "";
    try {
      await ensure(folder, { path: ".worktrees/m-000000cc", branch: "agentes/000000cc/x" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("filter.evil.clean");
    expect(existsSync(path.join(folder, ".worktrees", "m-000000cc"))).toBe(false);
    // An include (whatever it holds) is refused as such.
    run(repo, "config", "--unset", "filter.evil.clean");
    run(repo, "config", "include.path", "../extra.config");
    expect(await errorCode(() => ensure(folder, { path: ".worktrees/m-000000cc", branch: "agentes/000000cc/x" }))).toBe(
      "bad_request",
    );
    expect(existsSync(marker)).toBe(false);
  },
);

test.skipIf(!posix || !hasGit)(
  "agentes.json replaces the copy list and the setup; bad shapes and paths out of the repository are ignored",
  async () => {
    const { folder, repo } = await project();
    writeFileSync(
      path.join(repo, "agentes.json"),
      JSON.stringify({
        copy: ["config/local.json", "../outside.txt", "/etc/hosts", "link.txt", "README.md", 3, "missing.txt"],
        setup: "bun install && bun run db:generate",
      }),
    );
    writeFileSync(path.join(repo, "bun.lock"), "{}\n");
    run(repo, "add", "agentes.json", "bun.lock");
    run(repo, "commit", "-qm", "agentes.json");
    mkdirSync(path.join(repo, "config"));
    writeFileSync(path.join(repo, "config", "local.json"), "{}\n");
    writeFileSync(path.join(folder, "repos", "outside.txt"), "no\n");
    symlinkSync(path.join(folder, "repos", "outside.txt"), path.join(repo, "link.txt"));
    const made = await ensure(folder);
    expect(made.copied).toEqual(["config/local.json"]);
    expect(made.setupCommand).toBe("bun install && bun run db:generate");
    const wt = path.join(folder, WT);
    expect(existsSync(path.join(wt, ".env"))).toBe(false);
    expect(existsSync(path.join(wt, "link.txt"))).toBe(false);
    expect(existsSync(path.join(wt, "..", "outside.txt"))).toBe(false);

    // Bad shapes: the defaults stand, nothing crashes.
    const dir = tempDir("cfg-");
    dirs.push(dir);
    writeFileSync(path.join(dir, "agentes.json"), JSON.stringify({ copy: ".env", setup: 3 }));
    expect(readProjectConfig(dir)).toEqual({});
    writeFileSync(path.join(dir, "agentes.json"), "{ not json");
    expect(readProjectConfig(dir)).toEqual({});
    writeFileSync(path.join(dir, "agentes.json"), "[1]");
    expect(readProjectConfig(dir)).toEqual({});
    writeFileSync(path.join(dir, "agentes.json"), JSON.stringify({ setup: "" }));
    writeFileSync(path.join(dir, "package-lock.json"), "{}");
    // An empty setup means nothing to run, even with a lockfile.
    expect(setupCommandFor(dir)).toBeNull();
  },
);

test("the setup command comes from the root lockfile", () => {
  const cases: [string, string | null][] = [
    ["bun.lock", "bun install"],
    ["bun.lockb", "bun install"],
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["Cargo.lock", null],
  ];
  for (const [file, command] of cases) {
    const dir = tempDir("lock-");
    dirs.push(dir);
    writeFileSync(path.join(dir, file), "");
    expect(setupCommandFor(dir)).toBe(command);
  }
  const dir = tempDir("lock-");
  dirs.push(dir);
  writeFileSync(path.join(dir, "package-lock.json"), "{}");
  writeFileSync(path.join(dir, "agentes.json"), JSON.stringify({ copy: [".env"] }));
  // Only `copy` given: the install still comes from the lockfile.
  expect(setupCommandFor(dir)).toBe("npm ci");
});

test.skipIf(!posix || !hasGit)(
  "a deleted folder is added again from the branch; without the branch it is branch_missing",
  async () => {
    const { folder, repo, head } = await project();
    await ensure(folder);
    const wt = path.join(folder, WT);
    writeFileSync(path.join(wt, "step1.txt"), "done\n");
    run(wt, "add", "step1.txt");
    run(wt, "commit", "-qm", "agentes: step 1");
    const tip = out(wt, "rev-parse", "HEAD");
    rmSync(wt, { recursive: true, force: true });
    const back = await ensure(folder, { baseSha: head });
    expect(back).toMatchObject({ created: true, baseSha: head, copied: [".env.local"], dirty: false });
    expect(out(wt, "rev-parse", "HEAD")).toBe(tip);
    expect(readFileSync(path.join(wt, "step1.txt"), "utf8")).toBe("done\n");

    // Another branch in that folder is refused.
    expect(await errorCode(() => ensure(folder, { branch: "agentes/000000bb/other" }))).toBe("bad_request");

    rmSync(wt, { recursive: true, force: true });
    run(repo, "worktree", "prune");
    run(repo, "branch", "-D", BRANCH);
    expect(await errorCode(() => ensure(folder, { baseSha: head }))).toBe("branch_missing");
    // An empty folder left behind counts as gone.
    mkdirSync(wt, { recursive: true });
    expect(await errorCode(() => ensure(folder, { baseSha: head }))).toBe("branch_missing");
  },
);

test.skipIf(!posix || !hasGit)(
  "not a git repository, a bad branch and paths out of the folder are refused",
  async () => {
    const { ws, folder } = await project();
    mkdirSync(path.join(folder, "notes"));
    const notes = () => missionWorktree(folder, { action: "ensure", repo: "notes", path: WT, branch: BRANCH });
    await expect(notes()).rejects.toMatchObject({ code: "not_git", message: "not a git repository" });
    // Inside a repository that starts outside the agent's folder: never "no git".
    run(ws, "init", "-q", "-b", "main");
    expect(await errorCode(notes)).toBe("outside_workspace");
    rmSync(path.join(ws, ".git"), { recursive: true, force: true });
    expect(await errorCode(() => ensure(folder, { path: "../elsewhere" }))).toBe("outside_workspace");
    expect(await errorCode(() => ensure(folder, { path: "" }))).toBe("bad_request");
    expect(await errorCode(() => ensure(folder, { branch: "-x" }))).toBe("bad_request");
    expect(await errorCode(() => ensure(folder, { branch: "a..b" }))).toBe("bad_request");
  },
);

test.skipIf(!posix || !hasGit)("remove takes the folder away and keeps the branch unless asked", async () => {
  const { folder, repo } = await project();
  await ensure(folder);
  const remove = (deleteBranch?: boolean) =>
    missionWorktree(folder, {
      action: "remove",
      repo: "repos/app",
      path: WT,
      branch: BRANCH,
      ...(deleteBranch ? { deleteBranch } : {}),
    });
  writeFileSync(path.join(folder, WT, "loose.txt"), "x\n");
  expect(await remove()).toEqual({ removed: true });
  expect(existsSync(path.join(folder, WT))).toBe(false);
  expect(out(repo, "branch", "--list", BRANCH)).toContain(BRANCH);
  expect(await remove()).toEqual({ removed: false });
  // Delete everything (the person's choice on cancel).
  await ensure(folder);
  expect(await remove(true)).toEqual({ removed: true });
  expect(out(repo, "branch", "--list", BRANCH)).toBe("");
  expect(out(repo, "worktree", "list")).not.toContain("m-000000bb");
});

test.skipIf(!posix || !hasGit)(
  "the op goes through the handler; ensure waits while the computer is paused",
  async () => {
    const { ws } = await project();
    const scope = { signal: new AbortController().signal, output: () => {} };
    const req = {
      op: "mission.worktree" as const,
      action: "ensure" as const,
      repo: "repos/app",
      path: WT,
      branch: BRANCH,
    };
    let paused = true;
    const ctx = { workspaceReal: ws, exec: true, token: "agm_x", paused: () => paused };
    expect(await errorCode(() => handleRequest(ctx, { ...req, agent: AGENT }, scope))).toBe("paused");
    paused = false;
    expect(await handleRequest(ctx, { ...req, agent: AGENT }, scope)).toMatchObject({ created: true, path: WT });
    expect(await errorCode(() => handleRequest(ctx, req, scope))).toBe("bad_request");
    paused = true;
    // Removing isn't new work.
    expect(
      await handleRequest(
        ctx,
        { op: "mission.worktree", action: "remove", repo: "repos/app", path: WT, branch: BRANCH, agent: AGENT },
        scope,
      ),
    ).toEqual({ removed: true });
  },
);

function manager(home: string, ws: string) {
  const tasks = new TaskManager({
    root: path.join(home, "tasks"),
    workspaceReal: ws,
    agentFolder: (agent) => agentWorkspace(ws, agent),
    watchMs: 20,
    eventEveryMs: 0,
    claudeHome: path.join(home, "claude"),
    caffeinate: false,
  });
  closers.push(() => tasks.close());
  return tasks;
}

async function runTask(tasks: TaskManager, frames: RunnerFrame[], taskId: string, command: string, extra = {}) {
  const started = await tasks.start(AGENT, {
    taskId,
    executor: "shell",
    command,
    cwd: WT,
    commit: { message: "agentes: build the tabs" },
    ...extra,
  });
  const done = () => frames.find((f) => f.type === "task.done" && f.taskId === taskId) as TaskDone | undefined;
  await waitFor(() => Boolean(done()), 10_000);
  return { started, done: done() as TaskDone };
}

test.skipIf(!posix || !hasGit)(
  "a task with commit ends in one commit, also when it fails; a clean tree keeps the same sha",
  async () => {
    const { ws, folder, head } = await project();
    await ensure(folder);
    const wt = path.join(folder, WT);
    const home = tempDir("home-");
    dirs.push(home);
    const tasks = manager(home, ws);
    await tasks.init();
    const frames: RunnerFrame[] = [];
    tasks.attach((f) => frames.push(f));

    const ok = await runTask(tasks, frames, id(1), "echo tabs > tabs.txt");
    expect(ok.done.exitCode).toBe(0);
    expect(ok.done.startSha).toBe(head);
    expect(ok.done.endSha).toBe(out(wt, "rev-parse", "HEAD"));
    expect(ok.done.endSha).not.toBe(head);
    expect(out(wt, "log", "-1", "--format=%s")).toBe("agentes: build the tabs");
    expect(out(wt, "status", "--porcelain")).toBe("");
    expect(out(wt, "show", "--name-only", "--format=", "HEAD")).toBe("tabs.txt");
    expect(parseRunnerFrame(JSON.stringify({ type: "task.done", ...ok.done }))).toMatchObject({
      startSha: ok.done.startSha,
      endSha: ok.done.endSha,
    });

    const failed = await runTask(tasks, frames, id(2), "echo half > half.txt; exit 3");
    expect(failed.done.exitCode).toBe(3);
    expect(failed.done.startSha).toBe(ok.done.endSha as string);
    expect(failed.done.endSha).not.toBe(failed.done.startSha);
    expect(out(wt, "log", "-1", "--format=%s")).toBe("agentes: build the tabs (stopped)");

    const clean = await runTask(tasks, frames, id(3), "true");
    expect(clean.done.startSha).toBe(failed.done.endSha as string);
    expect(clean.done.endSha).toBe(clean.done.startSha as string);

    // A hook says no: the changes stay, the result says why.
    const hook = path.join(folder, "repos", "app", ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint failed: tabs.ts' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const refused = await runTask(tasks, frames, id(4), "echo more > more.txt");
    expect(refused.done.endSha).toBe(refused.done.startSha as string);
    expect(refused.done.result).toContain("The changes were not committed: lint failed: tabs.ts");
    expect(existsSync(path.join(wt, "more.txt"))).toBe(true);
    // The journal keeps where it started (a restart still commits at the end).
    const journal = JSON.parse(readFileSync(path.join(home, "tasks", "journal.json"), "utf8"));
    expect(journal.tasks.find((t: { taskId: string }) => t.taskId === id(4)).startSha).toBe(refused.done.startSha);

    // Without `commit` nothing is recorded.
    const plain = await tasks.start(AGENT, { taskId: id(5), executor: "shell", command: "true", cwd: WT });
    await waitFor(() => frames.some((f) => f.type === "task.done" && f.taskId === id(5)), 10_000);
    const plainDone = frames.find((f) => f.type === "task.done" && f.taskId === id(5)) as TaskDone;
    expect(plain.baseBehind).toBeUndefined();
    expect(plainDone.startSha).toBeUndefined();
    expect(
      parseRunnerFrame(JSON.stringify({ ...plainDone, type: "task.done", startSha: "zz", endSha: "nope" })),
    ).not.toHaveProperty("startSha");
  },
  30_000,
);

test.skipIf(!posix || !hasGit)(
  "a copied file the repository doesn't ignore never goes into a commit, nor into info/exclude",
  async () => {
    const { ws, folder, repo } = await project();
    writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    run(repo, "commit", "-qam", "track less");
    // Named in agentes.json, files git doesn't ignore are copied too.
    writeFileSync(path.join(repo, "agentes.json"), JSON.stringify({ copy: [".env", ".env.local"] }));
    const made = await ensure(folder);
    expect(made.copied).toEqual([".env", ".env.local"]);
    const wt = path.join(folder, WT);
    const home = tempDir("home-");
    dirs.push(home);
    const tasks = manager(home, ws);
    await tasks.init();
    const frames: RunnerFrame[] = [];
    tasks.attach((f) => frames.push(f));
    const { done } = await runTask(tasks, frames, id(20), "echo x > x.txt && echo LOCAL=2 > .env.local");
    expect(done.endSha).not.toBe(done.startSha as string);
    expect(out(wt, "show", "--name-only", "--format=", "HEAD")).toBe("x.txt");
    expect(out(wt, "status", "--porcelain").split("\n").sort()).toEqual(["?? .env", "?? .env.local"]);
    // Only the copied files: nothing else to commit, the same sha.
    const clean = await runTask(tasks, frames, id(21), "true");
    expect(clean.done.endSha).toBe(clean.done.startSha as string);
    expect(clean.done.result ?? "").not.toContain("not committed");
    const exclude = readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).not.toContain(".env");
    expect(out(repo, "status", "--porcelain")).toContain("?? .env.local");
    // By default (no agentes.json) a .env git doesn't ignore isn't copied at all.
    rmSync(path.join(repo, "agentes.json"));
    const other = await ensure(folder, { path: ".worktrees/m-000000cc", branch: "agentes/000000cc/x" });
    expect(other.copied).toEqual([]);
  },
  30_000,
);

test.skipIf(!posix || !hasGit)("baseCheck answers how many commits the base moved", async () => {
  const { ws, folder, repo, head } = await project();
  await ensure(folder);
  for (const n of [1, 2]) {
    writeFileSync(path.join(repo, `main${n}.txt`), "x\n");
    run(repo, "add", `main${n}.txt`);
    run(repo, "commit", "-qm", `main ${n}`);
  }
  const home = tempDir("home-");
  dirs.push(home);
  const tasks = manager(home, ws);
  await tasks.init();
  const frames: RunnerFrame[] = [];
  tasks.attach((f) => frames.push(f));
  const { started } = await runTask(tasks, frames, id(10), "true", { baseCheck: { branch: "main", sha: head } });
  expect(started.baseBehind).toBe(2);
  expect(parseBaseBehind(started)).toBe(2);
  const unknown = await runTask(tasks, frames, id(11), "true", { baseCheck: { branch: "gone", sha: head } });
  expect(unknown.started.baseBehind).toBeUndefined();
  expect(parseBaseBehind({ baseBehind: -1 })).toBeUndefined();
});

test.skipIf(!posix || !hasGit)("a checkout without an author commits as the agent on the server's host", async () => {
  const repo = tempDir("author-");
  dirs.push(repo);
  // No global or system config, so the checkout really has no user.email.
  const env = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: { ...process.env, ...env } });
  const author = () => spawnSync("git", ["log", "-1", "--format=%ae"], { cwd: repo, encoding: "utf8" }).stdout.trim();

  writeFileSync(path.join(repo, "a.txt"), "a\n");
  const first = await commitChanges(repo, "one", { env, handle: "dev", startSha: "", host: "chat.example.test" });
  expect(first.error).toBeUndefined();
  expect(author()).toBe("dev@agents.chat.example.test");

  writeFileSync(path.join(repo, "b.txt"), "b\n");
  await commitChanges(repo, "two", { env, handle: "dev", startSha: "" });
  expect(author()).toBe("dev@agents.invalid");
});
