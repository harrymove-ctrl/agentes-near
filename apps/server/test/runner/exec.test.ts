import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DELETE_BRANCHES_POINTER } from "@agenteschat/adapters/command-policy";
import { OutputBuffer, runCommand } from "../../runner/exec";
import { handleRequest } from "../../runner/handlers";
import { errorCode, gitRepo, hasGit, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";

test("OutputBuffer keeps everything under the limit, head and tail above it", () => {
  const small = new OutputBuffer(10);
  small.push(Buffer.from("12345"));
  small.push(Buffer.from("6789"));
  expect(small.text()).toBe("123456789");

  const big = new OutputBuffer(10);
  big.push(Buffer.from("abcdefgh"));
  big.push(Buffer.from("ijklmnopqrstuvwxyz"));
  expect(big.totalBytes).toBe(26);
  expect(big.text()).toBe("abcde\n[… cut …]\nvwxyz");
});

test.skipIf(!posix)("exec: runs a command in the workspace and reports its output and exit code", async () => {
  const ws = tempDir();
  dirs.push(ws);
  mkdirSync(path.join(ws, "sub"));
  const signal = new AbortController().signal;
  const ok = await runCommand({ command: "echo hi; pwd", cwd: ws, timeoutSeconds: 10, signal });
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout).toBe(`hi\n${ws}\n`);
  expect(ok.timedOut).toBe(false);

  const failed = await runCommand({ command: "echo oops >&2; exit 3", cwd: ws, timeoutSeconds: 10 });
  expect(failed).toEqual({ exitCode: 3, stdout: "", stderr: "oops\n", timedOut: false });

  const ctx = { workspaceReal: ws, exec: true, token: "agm_x" };
  const scope = { signal, output: () => {} };
  const inSub = (await handleRequest(
    ctx,
    { op: "exec", command: "pwd", cwd: "/workspace/sub", timeoutSeconds: 10, stream: false },
    scope,
  )) as { stdout: string };
  expect(inSub.stdout).toBe(`${path.join(ws, "sub")}\n`);
  expect(
    await errorCode(() =>
      handleRequest(ctx, { op: "exec", command: "pwd", cwd: "../", timeoutSeconds: 10, stream: false }, scope),
    ),
  ).toBe("outside_workspace");
});

test("exec is refused when the runner was paired with --no-exec", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const ctx = { workspaceReal: ws, exec: false, token: "agm_x" };
  const scope = { signal: new AbortController().signal, output: () => {} };
  expect(
    await errorCode(() =>
      handleRequest(ctx, { op: "exec", command: "echo hi", timeoutSeconds: 5, stream: false }, scope),
    ),
  ).toBe("exec_disabled");
});

test.skipIf(!posix)("exec streams output in batches while it runs", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const chunks: string[] = [];
  const result = await runCommand({
    command: "echo a; sleep 0.3; echo b",
    cwd: ws,
    timeoutSeconds: 10,
    batchMs: 20,
    onOutput: (stream, chunk) => {
      if (stream === "stdout") chunks.push(chunk);
    },
  });
  expect(result.stdout).toBe("a\nb\n");
  expect(chunks.join("")).toBe("a\nb\n");
  expect(chunks.length).toBeGreaterThanOrEqual(2);
});

test.skipIf(!posix)(
  "exec times out: exit 124 and the process group is killed",
  async () => {
    const ws = tempDir();
    dirs.push(ws);
    const started = Date.now();
    const result = await runCommand({ command: "sleep 5", cwd: ws, timeoutSeconds: 1 });
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4500);
  },
  10_000,
);

test.skipIf(!posix)(
  "exec cancel: exit 130 with canceled.killed",
  async () => {
    const ws = tempDir();
    dirs.push(ws);
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    const result = await runCommand({ command: "sleep 5", cwd: ws, timeoutSeconds: 30, signal: controller.signal });
    expect(result.exitCode).toBe(130);
    expect(result.canceled).toEqual({ killed: true });
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(4500);
  },
  10_000,
);

test.skipIf(!posix || !hasGit)(
  "exec (run_code, skill scripts): a held push doesn't run, and says why; an approved one, or a push to a PR branch, runs",
  async () => {
    const { work, git } = gitRepo(dirs);
    mkdirSync(path.join(work, ".agentes"));
    writeFileSync(path.join(work, ".agentes", "run-1.sh"), "git push origin develop\n");
    writeFileSync(path.join(work, ".agentes", "run-2.sh"), "git push origin HEAD\n");
    writeFileSync(path.join(work, ".agentes", "run-3.sh"), `sh -c "git push origin develop"\n`);
    const ctx = { workspaceReal: work, exec: true, token: "agm_x" };
    const scope = { signal: new AbortController().signal, output: () => {} };
    const exec = (command: string, approved?: boolean) =>
      handleRequest(
        ctx,
        { op: "exec", command, timeoutSeconds: 30, stream: false, ...(approved ? { approved } : {}) },
        scope,
      ) as Promise<{ exitCode: number; stderr: string }>;
    expect(await errorCode(() => exec("bash .agentes/run-1.sh"))).toBe("approval_needed");
    const held = await exec("bash .agentes/run-1.sh").catch((err: Error) => err.message);
    expect(held).toStartWith("This push goes to the default branch develop: a person approves it first.");
    expect(held).toContain("make the same call again with why");
    // A person approved this very command: it runs.
    expect((await exec("bash .agentes/run-1.sh", true)).exitCode).toBe(0);
    // The pull request's own branch is ordinary work: the new commit goes up.
    git("commit", "-q", "--allow-empty", "-m", "fix");
    expect((await exec("bash .agentes/run-2.sh")).exitCode).toBe(0);
    expect(git("rev-parse", "origin/cursor/pap-582-fix")).toBe(git("rev-parse", "HEAD"));
    expect(await errorCode(() => exec("git push --force origin cursor/pap-582-fix"))).toBe("approval_needed");
    // A push behind a nested shell, on the command line or in the script, waits the same.
    expect(await errorCode(() => exec("sh -c 'git push origin develop'"))).toBe("approval_needed");
    expect(await errorCode(() => exec("bash .agentes/run-3.sh"))).toBe("approval_needed");
    expect(await errorCode(() => exec("git push origin HEAD:heads/develop"))).toBe("approval_needed");
  },
  30_000,
);

test.skipIf(!hasGit)(
  "a merge in a repository the agent merges in without asking runs and says so; everything else stays held",
  async () => {
    const { work, git } = gitRepo(dirs);
    git("remote", "set-url", "origin", "https://github.com/acme/app.git");
    git("branch", "feature");
    const ctx = { workspaceReal: work, exec: true, token: "agm_x" };
    const scope = { signal: new AbortController().signal, output: () => {} };
    const exec = (command: string, mergeRepos?: string[]) =>
      handleRequest(
        ctx,
        { op: "exec", command, timeoutSeconds: 30, stream: false, ...(mergeRepos ? { mergeRepos } : {}) },
        scope,
      ) as Promise<{ exitCode: number; merge?: unknown }>;
    expect(await errorCode(() => exec("git merge feature"))).toBe("approval_needed");
    expect(await errorCode(() => exec("git merge feature", ["acme/api"]))).toBe("approval_needed");
    expect(await exec("git merge feature", ["acme/app"])).toMatchObject({
      exitCode: 0,
      merge: { repo: "acme/app", pr: null, ref: "feature" },
    });
    // The list covers merges, never what comes with one.
    expect(await errorCode(() => exec("git merge feature && git push origin develop", ["acme/app"]))).toBe(
      "approval_needed",
    );
    expect(await errorCode(() => exec("git push origin develop", ["acme/app"]))).toBe("approval_needed");
    // Nothing held, nothing to report.
    expect(await exec("true", ["acme/app"])).not.toHaveProperty("merge");
  },
  30_000,
);

test.skipIf(!posix || !hasGit)(
  "exec through our git proxy: a delete or a push to the default branch never runs, a person's approval or not",
  async () => {
    const { work, git } = gitRepo(dirs);
    git(
      "remote",
      "set-url",
      "--push",
      "origin",
      "https://agentes.test/api/git/0190a7b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b/0190a7b2-3c4d-7e5f-8a9b-0c1d2e3f4a5c/acme/app.git",
    );
    const ctx = { workspaceReal: work, exec: true, token: "agm_x" };
    const scope = { signal: new AbortController().signal, output: () => {} };
    const exec = (command: string, approved: boolean) =>
      handleRequest(ctx, { op: "exec", command, timeoutSeconds: 30, stream: false, approved }, scope);
    for (const approved of [false, true]) {
      expect(await errorCode(() => exec("git push origin --delete cursor/pap-582-fix", approved))).toBe("not_allowed");
      expect(await errorCode(() => exec("git push origin develop", approved))).toBe("not_allowed");
    }
    expect(await exec("git push origin --delete cursor/pap-582-fix", true).catch((err: Error) => err.message)).toBe(
      `This deletes the remote branch cursor/pap-582-fix: ${DELETE_BRANCHES_POINTER}`,
    );
    // Not through the proxy: a person's approval lets it run, as before.
    git("config", "--unset-all", "remote.origin.pushurl");
    expect(await errorCode(() => exec("git push origin --delete cursor/pap-582-fix", false))).toBe("approval_needed");
  },
  30_000,
);
