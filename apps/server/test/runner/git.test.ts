import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineReplies, MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { credentialHelper } from "../../runner/git";
import {
  describeRequest,
  type HandlerContext,
  handleRequest,
  NEW_WORK_OPS,
  type RequestScope,
} from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import { errorCode, removeDirs, tempDir } from "./helpers";

/**
 * `git.sync` with real git and no network: the proxy URL is rewritten to
 * local bare repositories through a test-only global git config
 * (`url.<file>.insteadOf <proxy>`), so clone, fetch and fast-forward run for real.
 */

const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev", name: "Dev" };
const BASE = "http://proxy.test/api/git/org/conn/";
const TOKEN = `agtgit1.${"a".repeat(40)}.${"b".repeat(43)}`;
const AUTHOR = { name: "Dev (agentes)", email: "dev@agents.agentes.chat" };

const dirs: string[] = [];
let root = "";
let remotes = "";
let source = "";
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

// `env` passed explicitly: Bun's child_process otherwise uses the environment from start-up, without the
// GIT_CONFIG_GLOBAL set below (CI has no git identity of its own).
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: process.env }).trim();

beforeAll(() => {
  root = tempDir("gitsync-");
  remotes = path.join(root, "remotes");
  source = path.join(root, "source");
  const globalConfig = path.join(root, "gitconfig");
  writeFileSync(
    globalConfig,
    [
      "[user]",
      "\tname = Test",
      "\temail = test@example.com",
      "[init]",
      "\tdefaultBranch = main",
      `[url "file://${remotes}/"]`,
      `\tinsteadOf = ${BASE}`,
      '[protocol "file"]',
      "\tallow = always",
      "",
    ].join("\n"),
  );
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  mkdirSync(path.join(remotes, "acme"), { recursive: true });
  mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  writeFileSync(path.join(source, "README.md"), "v1\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "first");
  git(root, "clone", "-q", "--bare", source, path.join(remotes, "acme", "app.git"));
  git(source, "remote", "add", "origin", path.join(remotes, "acme", "app.git"));
});

afterAll(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
  removeDirs([root]);
});
afterEach(() => removeDirs(dirs));

function setup() {
  const ws = tempDir("ws-");
  const home = tempDir("home-");
  dirs.push(ws, home);
  const ctx: HandlerContext = { workspaceReal: ws, exec: false, token: "agm_x", gitDir: path.join(home, "git") };
  return { ws, home, ctx };
}

const scope = (output: string[] = []): RequestScope => ({
  signal: new AbortController().signal,
  output: (_s, chunk) => output.push(chunk),
});

const sync = (repos: { repo: string; dir?: string; clone: boolean }[], extra: Partial<MachineRequest> = {}) =>
  ({
    op: "git.sync",
    agent: AGENT,
    proxy: { base: BASE, token: TOKEN },
    author: AUTHOR,
    repos: repos.map((r) => ({ dir: `repos/${r.repo}`, ...r })),
    timeoutSeconds: 60,
    ...extra,
  }) as MachineRequest;

test("git.sync clones into the agent's folder with only our proxy credential, then fast-forwards", async () => {
  const { ctx } = setup();
  const output: string[] = [];
  const first = (await handleRequest(
    ctx,
    sync([{ repo: "acme/app", clone: true }], { stream: true } as Partial<MachineRequest>),
    scope(output),
  )) as MachineReplies["git.sync"];
  const folder = await agentWorkspace(ctx.workspaceReal, AGENT);
  const checkout = path.join(folder, "repos", "acme", "app");
  expect(first.repos).toEqual([
    {
      repo: "acme/app",
      dir: "repos/acme/app",
      path: checkout,
      status: "cloned",
      branch: "main",
      defaultBranch: "main",
      head: git(checkout, "rev-parse", "--short", "HEAD"),
    },
  ]);
  expect(readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("v1\n");
  // git's progress went out as output (asked with `stream`).
  expect(output.join("")).toContain("Cloning into");

  // The checkout points at the proxy, resets the machine's helpers and uses only ours; the agent is the author.
  expect(git(checkout, "config", "--local", "remote.origin.url")).toBe(`${BASE}acme/app.git`);
  const helpers = execFileSync("git", ["config", "--local", "--get-all", "credential.helper"], {
    cwd: checkout,
    encoding: "utf8",
  })
    .replace(/\n$/, "")
    .split("\n");
  const tokenFile = path.join(ctx.gitDir as string, `${AGENT.id}.token`);
  expect(helpers).toEqual(["", credentialHelper(tokenFile)]);
  expect(git(checkout, "config", "--local", "user.email")).toBe(AUTHOR.email);
  expect(git(checkout, "config", "--local", "push.autoSetupRemote")).toBe("true");
  // The credential lives outside the agent's folder, readable only by the owner.
  expect(readFileSync(tokenFile, "utf8")).toBe(TOKEN);
  if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  expect(tokenFile.startsWith(folder)).toBe(false);

  // A new commit upstream: the next sync (existing checkouts, no clone) fast-forwards main.
  writeFileSync(path.join(source, "README.md"), "v2\n");
  git(source, "commit", "-qam", "second");
  git(source, "push", "-q", "origin", "main");
  const second = (await handleRequest(
    ctx,
    sync([], { existing: true } as Partial<MachineRequest>),
    scope(),
  )) as MachineReplies["git.sync"];
  expect(second.repos).toHaveLength(1);
  expect(second.repos[0]).toMatchObject({ repo: "acme/app", status: "updated", branch: "main", defaultBranch: "main" });
  expect(readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("v2\n");

  // On its own branch with local work: main still moves (its ref), the work stays.
  git(checkout, "checkout", "-q", "-b", "agentes/dev/fix");
  writeFileSync(path.join(checkout, "notes.md"), "wip\n");
  writeFileSync(path.join(source, "README.md"), "v3\n");
  git(source, "commit", "-qam", "third");
  git(source, "push", "-q", "origin", "main");
  const third = (await handleRequest(
    ctx,
    sync([{ repo: "acme/app", clone: false }]),
    scope(),
  )) as MachineReplies["git.sync"];
  expect(third.repos[0]).toMatchObject({ status: "updated", branch: "agentes/dev/fix" });
  expect(git(checkout, "rev-parse", "main")).toBe(git(source, "rev-parse", "main"));
  expect(readFileSync(path.join(checkout, "notes.md"), "utf8")).toBe("wip\n");
});

test("git.sync: not cloned and not asked, refused by the remote, outside the folder, bad requests", async () => {
  const { ctx } = setup();
  const r = (await handleRequest(
    ctx,
    sync([
      { repo: "acme/app", clone: false },
      { repo: "acme/missing", clone: true },
      { repo: "acme/app", dir: "../elsewhere", clone: true },
    ]),
    scope(),
  )) as MachineReplies["git.sync"];
  expect(r.repos.map((x) => x.status)).toEqual(["missing", "failed", "failed"]);
  expect(r.repos[1]?.message).toBeTruthy();
  expect(r.repos[2]?.message).toContain("leaves the workspace");

  // Only our proxy and our credential: never another URL, a token in the URL, or a GitHub token.
  for (const proxy of [
    { base: "https://github.com/", token: TOKEN },
    { base: "https://x:y@agentes.chat/api/git/o/c/", token: TOKEN },
    { base: BASE, token: "ghp_123456789012345678901234567890" },
  ]) {
    expect(await errorCode(() => handleRequest(ctx, { ...sync([]), proxy } as MachineRequest, scope()))).toBe(
      "bad_request",
    );
  }
  expect(await errorCode(() => handleRequest(ctx, sync([{ repo: "../etc", clone: true }]), scope()))).toBe(
    "bad_request",
  );
  expect(await errorCode(() => handleRequest({ ...ctx, gitDir: undefined }, sync([]), scope()))).toBe("bad_request");
  // Paused computers start nothing new, this included; the log line names the repositories.
  expect(NEW_WORK_OPS.has("git.sync")).toBe(true);
  expect(describeRequest(sync([{ repo: "acme/app", clone: true }]))).toBe("[dev] git.sync acme/app");
});

test("with commands off the runner's git runs nothing the agent chose: no .git writes, no hooks, no unsafe config", async () => {
  const { ctx, home } = setup();
  const first = (await handleRequest(
    ctx,
    sync([{ repo: "acme/app", clone: true }]),
    scope(),
  )) as MachineReplies["git.sync"];
  expect(first.repos[0]?.status).toBe("cloned");
  const folder = await agentWorkspace(ctx.workspaceReal, AGENT);
  const checkout = path.join(folder, "repos", "acme", "app");
  const base64 = Buffer.from("[core]\n\tfsmonitor = evil\n").toString("base64");
  const write = (p: string) =>
    handleRequest(ctx, { op: "write", agent: AGENT, path: p, base64 } as MachineRequest, scope());

  // The `write` op (allowed with commands off) never reaches into a git dir, in any spelling.
  for (const p of [
    "repos/acme/app/.git/config",
    "repos/acme/app/.git/hooks/post-merge",
    "repos/acme/app/.GIT/config",
    "repos/acme/app/.git./config",
    "repos/acme/app/.git",
    "repos/other/.git",
  ]) {
    expect(await errorCode(() => write(p))).toBe("bad_request");
  }
  expect(readFileSync(path.join(checkout, ".git", "config"), "utf8")).not.toContain("evil");
  expect(existsSync(path.join(folder, "repos", "other"))).toBe(false);
  // Anything else in the checkout is still the agent's to write.
  await write("repos/acme/app/.gitignore");
  expect(existsSync(path.join(checkout, ".gitignore"))).toBe(true);

  // A hook already in the checkout (made while commands were on): the fast-forward runs none.
  const marker = path.join(home, "ran");
  if (process.platform !== "win32") {
    const hook = path.join(checkout, ".git", "hooks", "post-merge");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    git(checkout, "config", "core.hooksPath", ".git/hooks");
  }
  writeFileSync(path.join(source, "README.md"), "hooks\n");
  git(source, "commit", "-qam", "hooks");
  git(source, "push", "-q", "origin", "main");
  const second = (await handleRequest(
    ctx,
    sync([{ repo: "acme/app", clone: false }]),
    scope(),
  )) as MachineReplies["git.sync"];
  expect(second.repos[0]?.status).toBe("updated");
  expect(readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("hooks\n");
  expect(existsSync(marker)).toBe(false);

  // Config that names a program (a filter driver, an ssh command): that checkout fails, nothing runs.
  git(checkout, "config", "core.sshCommand", `touch '${marker}'`);
  const third = (await handleRequest(
    ctx,
    sync([{ repo: "acme/app", clone: false }]),
    scope(),
  )) as MachineReplies["git.sync"];
  expect(third.repos[0]).toMatchObject({ status: "failed" });
  expect(third.repos[0]?.message).toContain("core.sshcommand");
  expect(existsSync(marker)).toBe(false);
});

test("the credential helper prints our token for `get` only", () => {
  const { home } = setup();
  const file = path.join(home, "it's a token");
  writeFileSync(file, TOKEN);
  const helper = credentialHelper(file);
  expect(helper.startsWith("!")).toBe(true);
  // git runs `!…` helpers as `sh -c '<snippet> "$@"' <snippet> <action>`.
  const run = (action: string) =>
    spawnSync("sh", ["-c", `${helper.slice(1)} "$@"`, helper.slice(1), action], { encoding: "utf8" }).stdout;
  expect(run("get")).toBe(`username=agentes\npassword=${TOKEN}\n`);
  expect(run("store")).toBe("");
});
