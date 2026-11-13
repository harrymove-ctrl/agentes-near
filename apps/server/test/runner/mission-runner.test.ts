import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PUSH_ASK_RULES } from "@agenteschat/adapters/command-policy";
import {
  MISSION_RULES,
  MISSION_RULES_NO_GIT,
  parseRunnerFrame,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import {
  cachedCodexVersion,
  cachedExecutors,
  detectExecutors,
  EXECUTORS_EXIT_STRIKES,
  EXECUTORS_RETRY_MS,
  EXECUTORS_TTL_MS,
  resolveCommand,
} from "../../runner/executors";
import {
  claudePermissionSettings,
  FOLDER_PATH_PREFIX,
  McpBridge,
  type McpTaskInfo,
  missionBranchPrefix,
  redactDeep,
  resolveTaskPath,
} from "../../runner/mcp";
import { agentWorkspace } from "../../runner/paths";
import { claudeSessionExists, flipSessionFlag, linkMissionFiles, TaskManager } from "../../runner/tasks";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const hasGit = spawnSync("git", ["--version"]).status === 0;
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };
const MISSION = "0193aaaa-0000-7000-8000-0000000000bb";
const id = (n: number) => `0193aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;

function manager(home: string, ws: string, over: Partial<ConstructorParameters<typeof TaskManager>[0]> = {}) {
  const tasks = new TaskManager({
    root: path.join(home, "tasks"),
    workspaceReal: ws,
    agentFolder: (agent) => agentWorkspace(ws, agent),
    watchMs: 20,
    eventEveryMs: 0,
    claudeHome: path.join(home, "claude"),
    caffeinate: false,
    mcp: { socketPath: path.join(home, "mcp.sock"), command: [process.execPath, "/opt/agentes-runner.mjs"] },
    ...over,
  });
  closers.push(() => tasks.close());
  return tasks;
}

test("protocol 7: hello carries the coding CLIs found; detection is best effort and cached", async () => {
  const hello = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "0.7.0",
      protocol: 7,
      executors: { claude: { version: "2.1.300 (Claude Code)\n" }, codex: { nope: 1 }, other: { version: "x" } },
    }),
  );
  expect(hello).toMatchObject({ executors: { claude: { version: "2.1.300 (Claude Code)" } } });
  expect((hello as { executors: Record<string, unknown> }).executors.codex).toBeUndefined();
  expect((hello as { executors: Record<string, unknown> }).executors.other).toBeUndefined();

  const calls: string[] = [];
  const run = (command: string) => {
    calls.push(command);
    return command === "claude" ? { status: 0, stdout: "2.1.300 (Claude Code)\n" } : { ...NOT_FOUND };
  };
  expect(await detectExecutors(run)).toEqual({
    found: { claude: { version: "2.1.300 (Claude Code)" } },
    unsure: false,
  });
  let now = 0;
  const cached = cachedExecutors({ now: () => now, run });
  await cached.ready();
  cached();
  // `claude --version` and (protocol 8) `claude auth status` per look.
  expect(calls.filter((c) => c === "claude")).toHaveLength(4);
  now = EXECUTORS_TTL_MS;
  cached();
  await waitFor(() => calls.filter((c) => c === "claude").length === 6);
});

test("detection: fresh() looks now, before the TTL, and finds a CLI installed since", async () => {
  let installed = false;
  const run = (command: string) =>
    command === "codex" && installed ? { status: 0, stdout: "codex-cli 0.80.0\n" } : { ...NOT_FOUND };
  const cached = cachedExecutors({ now: () => 0, run });
  expect(await cached.ready()).toEqual({});
  installed = true;
  expect(cached()).toEqual({});
  expect(await cached.fresh()).toEqual({ codex: { version: "codex-cli 0.80.0" } });
});

const NOT_FOUND = { status: null, stdout: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) };
const TIMED_OUT = { status: null, stdout: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) };

test("detection: only a missing binary is not installed; a timeout or failing exit keeps the last good look", async () => {
  const good = { claude: { version: "2.1.300", loggedIn: true }, codex: { version: "codex-cli 0.80.0" } };
  const timeouts = () => ({ ...TIMED_OUT });
  expect(await detectExecutors(timeouts, good)).toEqual({ found: good, unsure: true });
  const failing = () => ({ status: 1, stdout: "" });
  expect(await detectExecutors(failing, good)).toEqual({ found: good, unsure: true });
  // Claude Code answered its version but its login check timed out: the login last seen stands.
  const authTimeout = (c: string, args: string[]) =>
    c === "claude" ? (args[0] === "auth" ? { ...TIMED_OUT } : { status: 0, stdout: "2.1.301\n" }) : { ...NOT_FOUND };
  expect(await detectExecutors(authTimeout, good)).toEqual({
    found: { claude: { version: "2.1.300", loggedIn: true } },
    unsure: true,
  });
  // Gone from the PATH: not installed any more, and that is a sure answer.
  expect(await detectExecutors(() => ({ ...NOT_FOUND }), good)).toEqual({ found: {}, unsure: false });
  // A shim whose interpreter is gone: the shell's "not found" is as sure.
  expect(await detectExecutors(() => ({ status: 127, stdout: "" }), good)).toEqual({ found: {}, unsure: false });
  // A launcher left behind keeps failing: dropped after a few looks in a row.
  const strikes = {};
  for (let i = 1; i < EXECUTORS_EXIT_STRIKES; i++) {
    expect(await detectExecutors(failing, good, strikes)).toEqual({ found: good, unsure: true });
  }
  expect(await detectExecutors(failing, good, strikes)).toEqual({ found: {}, unsure: false });
});

test('Codex turn\'s own look: a timeout is "couldn\'t tell" (null), never "not installed"', async () => {
  let answer: object = { ...TIMED_OUT };
  const version = cachedCodexVersion(() => answer as { status: number | null; stdout: string });
  expect(await version()).toBeNull();
  answer = { status: 0, stdout: "codex-cli 0.80.0\n" };
  expect(await version()).toBe("codex-cli 0.80.0");
  answer = { ...NOT_FOUND };
  expect(await version()).toBe("codex-cli 0.80.0");
  expect(await cachedCodexVersion(() => ({ ...NOT_FOUND }))()).toBeUndefined();
});

test("cache: an unsure look is retried soon, never kept for the TTL; hello never waits on a look", async () => {
  let now = 0;
  let answer: (command: string) => object = () => ({ ...TIMED_OUT });
  let release: () => void = () => {};
  let gate = Promise.resolve();
  let looks = 0;
  const run = async (command: string) => {
    if (command === "claude") looks++;
    await gate;
    return answer(command) as { status: number | null; stdout: string };
  };
  const changes: unknown[] = [];
  const home = tempDir("executors-");
  dirs.push(home);
  const file = path.join(home, "executors.json");
  writeFileSync(file, JSON.stringify({ codex: { version: "codex-cli 0.80.0" }, bogus: { version: "x" } }));
  const cached = cachedExecutors({ now: () => now, run, file, onChange: (found) => changes.push(found) });
  // The first look hangs: the list kept on disk comes back at once (as `hello` would carry it).
  gate = new Promise((r) => {
    release = r;
  });
  expect(cached()).toEqual({ codex: { version: "codex-cli 0.80.0" } });
  release();
  // Everything timed out: the kept list stands, nothing changed.
  await cached.ready();
  await waitFor(() => looks === 1);
  await Bun.sleep(5);
  expect(cached()).toEqual({ codex: { version: "codex-cli 0.80.0" } });
  expect(changes).toEqual([]);
  // Retried after `EXECUTORS_RETRY_MS`, not the TTL.
  answer = (c) =>
    c === "claude"
      ? { status: 0, stdout: "2.1.300\n" }
      : c === "codex"
        ? { status: 0, stdout: "codex-cli 0.80.0\n" }
        : { ...NOT_FOUND };
  now = EXECUTORS_RETRY_MS;
  cached();
  await waitFor(() => changes.length === 1);
  expect(cached()).toMatchObject({ claude: { version: "2.1.300" }, codex: { version: "codex-cli 0.80.0" } });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ claude: { version: "2.1.300" } });
  // A sure look is kept for the TTL.
  const before = looks;
  now += EXECUTORS_RETRY_MS;
  cached();
  await Bun.sleep(5);
  expect(looks).toBe(before);
});

test("permission profile: work allows git, tests and builds; every push asks the prompt tool; merges and deploys are denied", () => {
  const prefix = missionBranchPrefix(MISSION);
  expect(prefix).toBe("agentes/000000bb/");
  expect(missionBranchPrefix(MISSION, "agentes/custom/")).toBe("agentes/custom/");
  expect(missionBranchPrefix(MISSION, "../x/")).toBe("agentes/000000bb/");
  const work = claudePermissionSettings("work").permissions;
  const plan = claudePermissionSettings("plan").permissions;
  for (const rule of [
    "mcp__agentes",
    "Bash(git commit *)",
    "Bash(git checkout *)",
    "Bash(gh pr create *)",
    "Bash(npm test *)",
    "Bash(pnpm install *)",
    "Bash(cargo test *)",
    "Bash(eas build --local *)",
  ]) {
    expect(work.allow).toContain(rule);
  }
  // No push is allowed or denied by a rule: every one reaches the prompt tool (`ask` outranks allow rules,
  // the owner's too), where the computer reads where it goes (ADR 0053 §3).
  for (const p of [work, plan]) {
    expect(p.allow.some((r) => r.startsWith("Bash(git push"))).toBe(false);
    expect(p.deny.some((r) => r.startsWith("Bash(git") && r.includes(" push"))).toBe(false);
    expect(p.ask).toEqual([...PUSH_ASK_RULES]);
  }
  for (const rule of [
    "Bash(git merge *)",
    "Bash(gh pr merge *)",
    "Bash(vercel deploy *)",
    "Bash(eas submit *)",
    "Bash(kubectl apply *)",
    "Bash(kubectl rollout *)",
    "Bash(kubectl delete *)",
    "Bash(helm install *)",
    "Bash(helm upgrade *)",
    "Bash(helm uninstall *)",
    "Bash(terraform apply *)",
    "Bash(terraform destroy *)",
    "Bash(railway up*)",
    "Bash(railway deploy*)",
    "Bash(fly deploy*)",
    "Bash(flyctl deploy*)",
    "Bash(npm publish*)",
    "Bash(pnpm publish*)",
    "Bash(yarn publish*)",
    "Bash(yarn npm publish*)",
    "Bash(bun publish*)",
    "Bash(cargo publish*)",
    "Bash(gem push*)",
    "Bash(twine upload*)",
    "Bash(docker push*)",
    "Bash(gh release create*)",
  ]) {
    expect(work.deny).toContain(rule);
    expect(plan.deny).toContain(rule);
  }
  expect(plan.allow).toContain("mcp__agentes");
  expect(plan.allow).toContain("Bash(git log *)");
  expect(plan.allow.some((r) => r.startsWith("Bash(git commit") || r.startsWith("Bash(npm"))).toBe(false);
  expect(plan.deny).toContain("Edit");
  expect(plan.deny).toContain("Write");
  // A real run: `git status 2>&1 | head -3`, `git -C <folder> status` and `ls ~/.claude/skills` were denied.
  for (const rule of ["Bash(git status)", "Bash(git -C * status *)", "Bash(head *)", "Bash(ls)", "Bash(ls *)"]) {
    expect(plan.allow).toContain(rule);
    expect(work.allow).toContain(rule);
  }
  expect(plan.allow.some((r) => r.startsWith("Bash(python"))).toBe(false);
  expect(work.allow).toContain("Bash(git -C * commit *)");
  expect(work.allow).toContain("Bash(mkdir *)");
  // `-C <path>` spellings are denied like the plain ones.
  expect(work.deny).toContain("Bash(git -C * merge *)");
  expect(plan.deny).toContain("Bash(git -C * merge *)");
});

test.skipIf(!posix)(
  "a mission task's Claude Code gets the settings file and works (items never run in plan mode)",
  async () => {
    const ws = tempDir("ws-");
    const home = tempDir("home-");
    dirs.push(ws, home);
    const tasks = manager(home, ws);
    await tasks.init();
    const work = await tasks.start(AGENT, {
      taskId: id(1),
      executor: "claude",
      prompt: "Do the item",
      session: "0193aaaa-0000-7000-8000-0000000000aa",
      mission: { id: MISSION, rules: "Rules.", branchPrefix: "agentes/0193aaaa/" },
    });
    expect(work.command).toContain("--permission-mode acceptEdits");
    expect(work.command).toContain(`--settings '${path.join(home, "tasks", id(1), "settings.json")}'`);
    const settings = JSON.parse(readFileSync(path.join(home, "tasks", id(1), "settings.json"), "utf8"));
    expect(settings.permissions.ask).toEqual([...PUSH_ASK_RULES]);
    expect(settings.permissions.deny).toContain("Bash(git merge *)");
    // Its prompts say they come from a mission's task, and which branches are its own (the mission's and the agent's).
    const mcp = JSON.parse(readFileSync(path.join(home, "tasks", id(1), "mcp.json"), "utf8"));
    expect(mcp.mcpServers.agentes.env).toMatchObject({
      AGENTES_MCP_TASK: "mission",
      AGENTES_MCP_BRANCHES: "agentes/dev/,agentes/0193aaaa/",
    });
  },
);

test("paths the executor gives: relative stay, absolute inside the task folder become relative, elsewhere in the agent folder get a prefix, outside is refused", () => {
  const info = { cwd: "/w/dev-1/.worktrees/t1", folder: "/w/dev-1" };
  expect(resolveTaskPath("shots/home.png", info)).toBe("shots/home.png");
  expect(resolveTaskPath("/w/dev-1/.worktrees/t1/shots/home.png", info)).toBe("shots/home.png");
  expect(resolveTaskPath("/w/dev-1/app/README.md", info)).toBe(`${FOLDER_PATH_PREFIX}app/README.md`);
  expect(resolveTaskPath("/etc/passwd", info)).toBeNull();
  expect(resolveTaskPath("/w/dev-10/x", info)).toBeNull();
  expect(redactDeep({ a: ["tok_1 here", { b: "tok_1" }], n: 3 }, (s) => s.replaceAll("tok_1", "[secret]"))).toEqual({
    a: ["[secret] here", { b: "[secret]" }],
    n: 3,
  });
});

test("the bridge masks the agent's secrets and resolves paths before relaying; a path outside the folder is refused", async () => {
  const frames: RunnerFrame[] = [];
  const info: McpTaskInfo = {
    token: "secret-token-1",
    missionId: "m1",
    running: true,
    cwd: "/w/dev-1/app",
    folder: "/w/dev-1",
    redact: (s) => s.replaceAll("ghp_SECRET", "[secret:GH]"),
  };
  const b = new McpBridge({ socketPath: "/nonexistent", task: () => info });
  b.attach((f) => frames.push(f));
  const base = { taskId: "0193aaaa-0000-7000-8000-000000000042", token: "secret-token-1" };
  const pending = b.handle({ ...base, tool: "report", args: { summary: "pushed with ghp_SECRET" } });
  await waitFor(() => frames.length === 1);
  const call = frames[0] as Extract<RunnerFrame, { type: "mcp.call" }>;
  expect(call.args).toEqual({ summary: "pushed with [secret:GH]" });
  b.result({ type: "mcp.result", callId: call.callId, ok: true, text: "ok" });
  await pending;
  const upload = b.handle({ ...base, tool: "upload_artifact", args: { path: "/w/dev-1/app/dist/app.zip" } });
  await waitFor(() => frames.length === 2);
  const second = frames[1] as Extract<RunnerFrame, { type: "mcp.call" }>;
  expect(second.args).toEqual({ path: "dist/app.zip" });
  b.result({ type: "mcp.result", callId: second.callId, ok: true, text: "ok" });
  await upload;
  expect(
    await b.handle({ ...base, tool: "request_review", args: { title: "x", paths: ["/etc/hosts"] } }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("outside your folder") });
  expect(frames).toHaveLength(2);
});

test("Claude Code sessions are found in any project folder; the session flag flips", () => {
  const home = tempDir("claude-");
  dirs.push(home);
  const session = "0193cccc-0000-7000-8000-000000000001";
  expect(claudeSessionExists(home, "/w/app", session)).toBeNull();
  mkdirSync(path.join(home, "projects", "-w-elsewhere"), { recursive: true });
  expect(claudeSessionExists(home, "/w/app", session)).toBe(false);
  writeFileSync(path.join(home, "projects", "-w-elsewhere", `${session}.jsonl`), "{}\n");
  expect(claudeSessionExists(home, "/w/app", session)).toBe(true);
  expect(flipSessionFlag(`claude -p --session-id ${session}`, session, false)).toBe(`claude -p --resume ${session}`);
  expect(flipSessionFlag(`claude -p --resume ${session}`, session, true)).toBe(`claude -p --session-id ${session}`);
});

test.skipIf(!posix)(
  "a start Claude Code refuses at once for the session flag is retried once with the other flag",
  async () => {
    const bin = tempDir("bin-");
    const ws = tempDir("ws-");
    const home = tempDir("home-");
    dirs.push(bin, ws, home);
    writeFileSync(
      path.join(bin, "claude"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *--session-id*) echo "Error: Session ID is already in use." >&2; exit 1 ;;',
        "esac",
        `printf '%s\\n' '{"type":"result","result":"resumed fine"}'`,
      ].join("\n"),
    );
    chmodSync(path.join(bin, "claude"), 0o755);
    const frames: RunnerFrame[] = [];
    const tasks = manager(home, ws, {
      secrets: async () => ({ env: { PATH: `${bin}:${process.env.PATH ?? ""}` }, redact: (s) => s }),
    });
    await tasks.init();
    tasks.attach((f) => frames.push(f));
    const session = "0193cccc-0000-7000-8000-000000000002";
    const started = await tasks.start(AGENT, { taskId: id(3), executor: "claude", prompt: "go", session });
    expect(started.command).toContain("--session-id");
    const done = () =>
      frames.find((f) => f.type === "task.done" && f.taskId === id(3)) as
        | Extract<RunnerFrame, { type: "task.done" }>
        | undefined;
    await waitFor(() => Boolean(done()), 10_000);
    expect(done()).toMatchObject({ exitCode: 0, result: "resumed fine" });
    // One end only: the refused start never reached the server.
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(1);
  },
  20_000,
);

test.skipIf(!posix || !hasGit)(
  "a mission item's worktree sees the mission's files, and .agentes/ stays out of git",
  () => {
    const repo = tempDir("repo-");
    dirs.push(repo);
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
    mkdirSync(path.join(repo, ".agentes"));
    writeFileSync(path.join(repo, ".agentes", "mission.md"), "# Mission\n");
    const worktree = path.join(repo, "..", `${path.basename(repo)}-wt`);
    dirs.push(worktree);
    git("worktree", "add", "-q", "-b", "agentes/x/item", worktree);
    linkMissionFiles(repo, worktree);
    expect(lstatSync(path.join(worktree, ".agentes")).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(worktree, ".agentes", "mission.md"), "utf8")).toBe("# Mission\n");
    expect(git("status", "--porcelain").stdout).toBe("");
    expect(existsSync(path.join(repo, ".git", "info", "exclude"))).toBe(true);
    expect(readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8")).toContain(".agentes/");
  },
);

/** A Claude Code stand-in that records where it ran and what it read on stdin. */
function fakeClaude(bin: string) {
  writeFileSync(
    path.join(bin, "claude"),
    [
      "#!/bin/sh",
      'pwd > "$PWD/.seen-cwd"',
      'cat > "$PWD/.seen-prompt"',
      `printf '%s\\n' '{"type":"result","result":"ok"}'`,
    ].join("\n"),
  );
  chmodSync(path.join(bin, "claude"), 0o755);
}

test.skipIf(!posix)(
  "a mission folder without git: an item runs without a branch in its own subfolder, with rules that never mention branches",
  async () => {
    const bin = tempDir("bin-");
    const ws = tempDir("ws-");
    const home = tempDir("home-");
    dirs.push(bin, ws, home);
    fakeClaude(bin);
    const tasks = manager(home, ws, {
      secrets: async () => ({ env: { PATH: `${bin}:${process.env.PATH ?? ""}` }, redact: (s) => s }),
    });
    await tasks.init();
    const folder = await agentWorkspace(ws, AGENT);
    mkdirSync(path.join(folder, ".agentes"), { recursive: true });
    writeFileSync(path.join(folder, ".agentes", "mission.md"), "# Mission\n");
    const started = await tasks.start(AGENT, {
      taskId: id(20),
      executor: "claude",
      prompt: "Make the contact sheet",
      session: "0193aaaa-0000-7000-8000-0000000000c1",
      branch: "agentes/000000bb/contact-sheet",
      mission: { id: MISSION, rules: MISSION_RULES, branchPrefix: "agentes/000000bb/" },
    });
    expect(started.branch).toBeUndefined();
    expect(started.cwd).toBe("work/contact-sheet");
    expect(started.command).toContain("not a git repository");
    expect(started.command).not.toContain("own branch");
    expect(MISSION_RULES_NO_GIT).not.toMatch(/branch|commit|push|pull request/i);
    expect(MISSION_RULES_NO_GIT).toContain("upload_artifact");
    expect(MISSION_RULES).toContain("language the people use");
    const item = path.join(folder, "work", "contact-sheet");
    await waitFor(
      () =>
        existsSync(path.join(item, ".seen-prompt")) && readFileSync(path.join(item, ".seen-prompt"), "utf8").length > 0,
      10_000,
    );
    expect(readFileSync(path.join(item, ".seen-prompt"), "utf8")).toStartWith("Your folder: work/contact-sheet/");
    // It reads the mission's files from its subfolder.
    expect(readFileSync(path.join(item, ".agentes", "mission.md"), "utf8")).toBe("# Mission\n");
    // The same name again gets a folder of its own.
    const again = await tasks.start(AGENT, {
      taskId: id(21),
      executor: "claude",
      prompt: "Again",
      session: "0193aaaa-0000-7000-8000-0000000000c2",
      branch: "contact-sheet",
      mission: { id: MISSION, rules: MISSION_RULES },
    });
    expect(again.cwd).toBe(`work/contact-sheet-${id(21).replace(/-/g, "").slice(-8)}`);
    // A shell task still needs a repository for a branch.
    await expect(
      tasks.start(AGENT, { taskId: id(22), executor: "shell", command: "true", branch: "x" }),
    ).rejects.toMatchObject({ code: "bad_request" });
  },
  20_000,
);

test.skipIf(!posix || !hasGit)(
  "a mission folder with git: an item keeps its branch and worktree, and the git rules",
  async () => {
    const bin = tempDir("bin-");
    const ws = tempDir("ws-");
    const home = tempDir("home-");
    dirs.push(bin, ws, home);
    fakeClaude(bin);
    const tasks = manager(home, ws, {
      secrets: async () => ({ env: { PATH: `${bin}:${process.env.PATH ?? ""}` }, redact: (s) => s }),
    });
    await tasks.init();
    const folder = await agentWorkspace(ws, AGENT);
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: folder, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(path.join(folder, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const started = await tasks.start(AGENT, {
      taskId: id(23),
      executor: "claude",
      prompt: "Build the tabs",
      session: "0193aaaa-0000-7000-8000-0000000000c3",
      branch: "agentes/000000bb/nav",
      mission: { id: MISSION, rules: MISSION_RULES, branchPrefix: "agentes/000000bb/" },
    });
    expect(started).toMatchObject({ branch: "agentes/000000bb/nav", cwd: `.worktrees/${id(23)}` });
    expect(started.command).toContain("own branch");
    const wt = path.join(folder, ".worktrees", id(23));
    await waitFor(
      () => existsSync(path.join(wt, ".seen-prompt")) && readFileSync(path.join(wt, ".seen-prompt"), "utf8").length > 0,
      10_000,
    );
    expect(readFileSync(path.join(wt, ".seen-prompt"), "utf8")).toStartWith("Your branch: agentes/000000bb/nav");
  },
  20_000,
);

test("coding CLIs are looked up on the current PATH (the app adopts the login shell's after start)", () => {
  const { mkdtempSync, writeFileSync, chmodSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "bin-"));
  writeFileSync(join(dir, "claude"), "#!/bin/sh\necho 2.1.300\n");
  chmodSync(join(dir, "claude"), 0o755);
  writeFileSync(join(dir, "codex"), "not executable");
  expect(resolveCommand("claude", `/nope:${dir}`)).toBe(join(dir, "claude"));
  expect(resolveCommand("codex", dir)).toBe("codex");
  expect(resolveCommand("/abs/claude", dir)).toBe("/abs/claude");
  // System mode: the runner never launches what an agent put in the shared bin/ (it would run with another
  // agent's sign-in), not even through a bare name looked up again on the PATH.
  expect(resolveCommand("claude", `/nope:${dir}`, dir)).toBe("/nope/claude");
  expect(resolveCommand("claude", `${dir}:/usr/bin`, dir)).toBe("/usr/bin/claude");
});
