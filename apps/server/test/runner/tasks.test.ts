import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MISSION_DENY_RULES, PUSH_ASK_RULES } from "@agenteschat/adapters/command-policy";
import {
  type AccountKind,
  PERMISSION_PROMPT_TOOL,
  parseRunnerFrame,
  parseServerFrame,
  type RunnerFrame,
  TASKS_PROTOCOL,
} from "@agenteschat/adapters/machine-protocol";
import { ACCOUNT_MISSING_MESSAGE, ACCOUNT_SIGNED_OUT } from "../../runner/accounts";
import { handleRequest } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import {
  claudeSessionFile,
  executorCommand,
  parseOutputLine,
  TaskManager,
  type TaskManagerOptions,
} from "../../runner/tasks";
import { errorCode, gitRepo, hasGit, removeDirs, tempDir, waitFor, withContainersClient } from "./helpers";

const dirs: string[] = [];
const managers: TaskManager[] = [];
/** Process groups left behind on purpose (an "interrupted" task): killed after each test. */
const groups: number[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };
const id = (n: number) => `0193aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;
const PROXY_URL =
  "https://agentes.test/api/git/0190a7b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b/0190a7b2-3c4d-7e5f-8a9b-0c1d2e3f4a5c/acme/app.git";

function setup(over: Partial<TaskManagerOptions> = {}) {
  const ws = tempDir("ws-");
  const home = tempDir("home-");
  dirs.push(ws, home);
  const frames: RunnerFrame[] = [];
  const make = (extra: Partial<TaskManagerOptions> = {}) => {
    const m = new TaskManager({
      root: path.join(home, "tasks"),
      workspaceReal: ws,
      agentFolder: (agent) => agentWorkspace(ws, agent),
      watchMs: 20,
      eventEveryMs: 0,
      claudeHome: path.join(home, "claude"),
      caffeinate: false,
      ...over,
      ...extra,
    });
    managers.push(m);
    return m;
  };
  const tasks = make();
  const done = (taskId: string) =>
    frames.find((f): f is Extract<RunnerFrame, { type: "task.done" }> => f.type === "task.done" && f.taskId === taskId);
  return { ws, home, tasks, frames, make, done, send: (f: RunnerFrame) => frames.push(f) };
}

test("protocol 4: task frames and ops parse; malformed pieces are cut or dropped", () => {
  expect(TASKS_PROTOCOL).toBe(4);
  const event = parseRunnerFrame(
    JSON.stringify({ type: "task.event", taskId: "t1", kind: "line", line: "x".repeat(900), files: ["a.ts", 3] }),
  );
  expect(event).toEqual({ type: "task.event", taskId: "t1", kind: "line", line: "x".repeat(500), files: ["a.ts"] });
  expect(parseRunnerFrame(JSON.stringify({ type: "task.event", taskId: "t1", kind: "weird" }))).toBeNull();
  expect(
    parseRunnerFrame(
      JSON.stringify({ type: "task.done", taskId: "t1", exitCode: 0, seconds: 12.4, result: "ok", interrupted: true }),
    ),
  ).toEqual({
    type: "task.done",
    taskId: "t1",
    exitCode: 0,
    signal: null,
    seconds: 12,
    result: "ok",
    interrupted: true,
  });
  expect(parseRunnerFrame(JSON.stringify({ type: "task.done", taskId: "t1", exitCode: "no" }))).toMatchObject({
    exitCode: null,
    seconds: 0,
  });
  const hello = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "0.4.0",
      protocol: 4,
      tasks: [
        { taskId: "t1", agentId: "a1", status: "running", pid: 42, startedAt: "2026-10-16T10:00:00.000Z" },
        { taskId: "t2", agentId: "a1", status: "bogus", startedAt: "x" },
      ],
    }),
  );
  expect(hello).toMatchObject({ type: "hello", tasks: [{ taskId: "t1", status: "running", pid: 42 }] });
  expect(parseServerFrame(JSON.stringify({ type: "task.ack", taskId: "t1" }))).toEqual({
    type: "task.ack",
    taskId: "t1",
  });
  expect(parseServerFrame(JSON.stringify({ type: "task.ack" }))).toBeNull();
  for (const op of ["task.start", "task.status", "task.cancel"]) {
    expect(parseServerFrame(JSON.stringify({ type: "request", id: "r", op }))).not.toBeNull();
  }
  expect(parseServerFrame(JSON.stringify({ type: "request", id: "r", op: "task.nope" }))).toBeNull();
});

test("executor commands: Claude Code with stream-json and its session; prompts never on the command line", () => {
  expect(executorCommand("claude", { session: "s-1234567890" })).toBe(
    "claude -p --output-format stream-json --verbose --permission-mode acceptEdits --session-id s-1234567890",
  );
  expect(executorCommand("claude", { session: "s-1234567890", resume: true })).toContain("--resume s-1234567890");
  expect(executorCommand("shell", { command: " make test " })).toBe("make test");
  // No `--full-auto` any more (removed from Codex): exec is unattended, the sandbox is the limit.
  expect(executorCommand("codex", {})).toBe("codex exec --json --skip-git-repo-check -");
  expect(() => executorCommand("shell", {})).toThrow("needs a command");
  expect(claudeSessionFile("/h/.claude", "/Users/me/agentes/dev-0193aaaa", "abc")).toBe(
    "/h/.claude/projects/-Users-me-agentes-dev-0193aaaa/abc.jsonl",
  );
});

test("Claude Code's stream-json becomes a human line, edited files and the final result", () => {
  const cwd = "/w/dev";
  const tool = (name: string, input: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  expect(parseOutputLine(tool("Edit", { file_path: "/w/dev/src/app.ts" }), "claude", cwd)).toEqual({
    line: "Editing src/app.ts",
    files: ["src/app.ts"],
  });
  expect(parseOutputLine(tool("Bash", { command: "npm  test" }), "claude", cwd).line).toBe("Running: npm test");
  expect(parseOutputLine(tool("Read", { file_path: "/w/dev/a.md" }), "claude", cwd)).toEqual({ line: "Reading a.md" });
  expect(
    parseOutputLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Now the tests.\nMore" }] } }),
      "claude",
      cwd,
    ),
  ).toEqual({ line: "Now the tests." });
  expect(
    parseOutputLine(JSON.stringify({ type: "result", result: "Built it.\nDetails", session_id: "S1" }), "claude", cwd),
  ).toEqual({ result: "Built it.\nDetails", session: "S1", line: "Built it." });
  expect(parseOutputLine(JSON.stringify({ type: "system", session_id: "S1" }), "claude", cwd)).toEqual({
    session: "S1",
  });
  expect(parseOutputLine("plain words", "claude", cwd)).toEqual({ line: "plain words" });
  expect(parseOutputLine("{not json", "shell", cwd)).toEqual({ line: "{not json" });
});

test.skipIf(!posix)(
  "a shell task runs detached: events, task.done once, re-sent until acknowledged",
  async () => {
    const { tasks, frames, send, done, home } = setup();
    await tasks.init();
    tasks.attach(send);
    const started = await tasks.start(AGENT, {
      taskId: id(1),
      executor: "shell",
      command: "echo one; sleep 0.3; echo two; echo warn >&2; exit 3",
    });
    expect(started).toMatchObject({
      taskId: id(1),
      cwd: "",
      command: "echo one; sleep 0.3; echo two; echo warn >&2; exit 3",
    });
    expect(started.pid).toBeGreaterThan(0);
    expect(tasks.list()).toMatchObject([{ taskId: id(1), status: "running", agentId: AGENT.id }]);
    await waitFor(() => Boolean(done(id(1))), 8000);
    const d = done(id(1));
    expect(d).toMatchObject({ exitCode: 3, signal: null, lastLine: expect.any(String) });
    expect(d?.result).toContain("two");
    expect(d?.result).toContain("warn");
    expect(frames.some((f) => f.type === "task.event" && f.kind === "line")).toBe(true);
    // Output and the exit live in the task's folder; the journal says it ended.
    const dir = path.join(home, "tasks", id(1));
    expect(readFileSync(path.join(dir, "stdout.log"), "utf8")).toBe("one\ntwo\n");
    expect(JSON.parse(readFileSync(path.join(dir, "exit.json"), "utf8"))).toMatchObject({ exitCode: 3 });
    const journal = JSON.parse(readFileSync(path.join(home, "tasks", "journal.json"), "utf8"));
    expect(journal.tasks[0]).toMatchObject({ taskId: id(1), status: "done", delivered: false });
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(1);

    // A reconnect sends it again until the server says it has it.
    tasks.attach(send);
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(2);
    tasks.ack(id(1));
    tasks.attach(send);
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(2);
    expect(tasks.list()).toEqual([]);
    expect(tasks.status(AGENT).tasks).toMatchObject([{ taskId: id(1), status: "done", exitCode: 3 }]);
  },
  15_000,
);

test.skipIf(!posix)(
  "a task outlives the runner: a new runner picks it up from the journal",
  async () => {
    const { tasks, frames, send, done, make } = setup();
    await tasks.init();
    await tasks.start(AGENT, { taskId: id(2), executor: "shell", command: "sleep 0.6; echo finished" });
    // The runner stops (an update): watching ends, the task goes on.
    tasks.close();
    const next = make();
    await next.init();
    expect(next.list()).toMatchObject([{ taskId: id(2), status: "running" }]);
    next.attach(send);
    await waitFor(() => Boolean(done(id(2))), 8000);
    expect(done(id(2))).toMatchObject({ exitCode: 0, result: "finished", lastLine: "finished" });
    expect(frames.filter((f) => f.type === "task.done")).toHaveLength(1);
  },
  15_000,
);

test.skipIf(!posix)(
  "finished while no runner watched: reported on the next start",
  async () => {
    const { tasks, send, done, make } = setup();
    await tasks.init();
    await tasks.start(AGENT, { taskId: id(3), executor: "shell", command: "echo quick" });
    tasks.close();
    await new Promise((r) => setTimeout(r, 700));
    const next = make();
    await next.init();
    next.attach(send);
    await waitFor(() => Boolean(done(id(3))), 8000);
    expect(done(id(3))).toMatchObject({ exitCode: 0, result: "quick" });
  },
  15_000,
);

test.skipIf(!posix)(
  "cancel stops the whole process group; slots refuse a task beyond the limit",
  async () => {
    const { tasks, send, done } = setup({ maxConcurrent: 1 });
    await tasks.init();
    tasks.attach(send);
    await tasks.start(AGENT, { taskId: id(4), executor: "shell", command: "sleep 30" });
    expect(await errorCode(() => tasks.start(AGENT, { taskId: id(5), executor: "shell", command: "true" }))).toBe(
      "no_slot",
    );
    expect(tasks.cancel(AGENT, id(4))).toEqual({ canceled: true });
    await waitFor(() => Boolean(done(id(4))), 8000);
    expect(done(id(4))).toMatchObject({ canceled: true, exitCode: null, signal: "SIGTERM" });
    expect(tasks.cancel(AGENT, id(4))).toEqual({ canceled: false });
    expect(await errorCode(() => tasks.cancel(AGENT, id(99)))).toBe("not_found");
    // Another agent can't see or cancel it.
    expect(tasks.status({ id: "0193bbbb-0000-7000-8000-000000000000", handle: "x" }).tasks).toEqual([]);
  },
  15_000,
);

test.skipIf(!posix)(
  "the time limit kills a task that runs too long",
  async () => {
    const { tasks, send, done } = setup();
    await tasks.init();
    tasks.attach(send);
    await tasks.start(AGENT, { taskId: id(6), executor: "shell", command: "sleep 30", maxSeconds: 1 });
    await waitFor(() => Boolean(done(id(6))), 10_000);
    expect(done(id(6))).toMatchObject({ timedOut: true, exitCode: null });
  },
  15_000,
);

test.skipIf(!posix)(
  "a task whose wrapper vanished without an exit is interrupted (the machine went down)",
  async () => {
    const { tasks, send, done, home } = setup();
    await tasks.init();
    tasks.attach(send);
    const { pid } = await tasks.start(AGENT, { taskId: id(7), executor: "shell", command: "sleep 30" });
    const childPid = path.join(home, "tasks", id(7), "child.pid");
    await waitFor(() => existsSync(childPid) && readFileSync(childPid, "utf8").trim() !== "");
    groups.push(Number(readFileSync(childPid, "utf8")));
    process.kill(pid, "SIGKILL");
    await waitFor(() => Boolean(done(id(7))), 8000);
    expect(done(id(7))).toMatchObject({ interrupted: true, exitCode: null });
    expect(tasks.list()).toMatchObject([{ taskId: id(7), status: "interrupted" }]);
  },
  15_000,
);

test.skipIf(!posix)(
  "a SIGTERM from outside (the system shutting down) ends a task interrupted, not canceled; one aimed at the command alone, failed",
  async () => {
    const { tasks, send, done, home } = setup();
    await tasks.init();
    tasks.attach(send);
    const childPid = async (taskId: string) => {
      const file = path.join(home, "tasks", taskId, "child.pid");
      await waitFor(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "");
      return Number(readFileSync(file, "utf8"));
    };
    // The wrapper gets it (systemd stops the agent's scope).
    const { pid } = await tasks.start(AGENT, { taskId: id(11), executor: "shell", command: "sleep 30" });
    groups.push(await childPid(id(11)));
    process.kill(pid, "SIGTERM");
    await waitFor(() => Boolean(done(id(11))), 8000);
    expect(done(id(11))).toMatchObject({ interrupted: true, exitCode: null });
    expect(done(id(11))?.canceled).toBeUndefined();

    // The command gets it first, the wrapper a moment later: the scope signals each of its processes.
    const second = await tasks.start(AGENT, { taskId: id(12), executor: "shell", command: "sleep 30" });
    process.kill(-(await childPid(id(12))), "SIGTERM");
    await Bun.sleep(200);
    process.kill(second.pid, "SIGTERM");
    await waitFor(() => Boolean(done(id(12))), 8000);
    expect(done(id(12))).toMatchObject({ interrupted: true, exitCode: null, signal: "SIGTERM" });

    // Only the command gets it (a person's `kill`, the agent's own `pkill`): it failed by that signal, it was
    // never interrupted, and nothing resumes it.
    await tasks.start(AGENT, { taskId: id(13), executor: "shell", command: "sleep 30" });
    process.kill(await childPid(id(13)), "SIGTERM");
    await waitFor(() => Boolean(done(id(13))), 8000);
    expect(done(id(13))).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    expect(done(id(13))?.interrupted).toBeUndefined();
    expect(done(id(13))?.canceled).toBeUndefined();
    expect(tasks.list()).toMatchObject([
      { taskId: id(11), status: "interrupted" },
      { taskId: id(12), status: "interrupted" },
      { taskId: id(13), status: "done" },
    ]);
  },
  20_000,
);

test.skipIf(!posix)(
  "Claude Code: the prompt goes through stdin, its session is resumed when it exists, secrets are redacted",
  async () => {
    const bin = tempDir("bin-");
    dirs.push(bin);
    writeFileSync(
      path.join(bin, "claude"),
      [
        "#!/bin/sh",
        'here="$(pwd)"',
        'cat > "$here/prompt-seen.txt"',
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"S-1"}'`,
        `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"'"$here"'/app/main.ts"}}]}}'`,
        `printf '%s\\n' '{"type":"result","result":"Built it with tok_SECRET123 in place.","session_id":"S-1"}'`,
      ].join("\n"),
    );
    chmodSync(path.join(bin, "claude"), 0o755);
    const { tasks, send, done, ws, home, frames } = setup({
      secrets: async () => ({
        env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
        redact: (s) => s.replaceAll("tok_SECRET123", "[secret:TOKEN]"),
      }),
    });
    await tasks.init();
    tasks.attach(send);
    const session = "0193cccc-0000-7000-8000-000000000001";
    const first = await tasks.start(AGENT, {
      taskId: id(8),
      executor: "claude",
      prompt: 'Build the app; it\'s "quoted" & $weird',
      session,
    });
    // Claude Code keeps sessions under ~/.claude/projects; with none there, it starts this one.
    expect(first.command).toContain(`--session-id ${session}`);
    await waitFor(() => Boolean(done(id(8))), 8000);
    const folder = await agentWorkspace(ws, AGENT);
    expect(readFileSync(path.join(folder, "prompt-seen.txt"), "utf8")).toBe('Build the app; it\'s "quoted" & $weird');
    expect(done(id(8))).toMatchObject({
      exitCode: 0,
      result: "Built it with [secret:TOKEN] in place.",
      files: ["app/main.ts"],
      session,
    });
    expect(JSON.stringify(frames)).not.toContain("tok_SECRET123");

    // The session exists in that folder now: the next task resumes it.
    const file = claudeSessionFile(path.join(home, "claude"), folder, session);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}\n");
    const second = await tasks.start(AGENT, { taskId: id(9), executor: "claude", prompt: "go on", session });
    expect(second.command).toContain(`--resume ${session}`);
    await waitFor(() => Boolean(done(id(9))), 8000);
  },
  20_000,
);

test.skipIf(!posix || !hasGit)(
  "a branch puts the task in its own git worktree",
  async () => {
    const { tasks, send, done, ws } = setup();
    await tasks.init();
    tasks.attach(send);
    const folder = await agentWorkspace(ws, AGENT);
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: folder, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(path.join(folder, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
    const r = await tasks.start(AGENT, {
      taskId: id(10),
      executor: "shell",
      command: "git branch --show-current",
      branch: "feat/x",
    });
    expect(r).toMatchObject({ cwd: `.worktrees/${id(10)}`, branch: "feat/x" });
    await waitFor(() => Boolean(done(id(10))), 8000);
    expect(done(id(10))?.result).toBe("feat/x");
    expect(git("status", "--porcelain").stdout).toBe("");
    expect(
      await errorCode(() => tasks.start(AGENT, { taskId: id(11), executor: "shell", command: "true", branch: "-bad" })),
    ).toBe("bad_request");
  },
  15_000,
);

test("handlers: task ops need the task manager, and commands allowed", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const scope = { signal: new AbortController().signal, output: () => {} };
  const req = { op: "task.start", taskId: id(12), executor: "shell", command: "true", agent: AGENT } as const;
  expect(await errorCode(() => handleRequest({ workspaceReal: ws, exec: true, token: "agm_x" }, req, scope))).toBe(
    "bad_request",
  );
  const { tasks } = setup();
  await tasks.init();
  expect(
    await errorCode(() => handleRequest({ workspaceReal: ws, exec: false, token: "agm_x", tasks }, req, scope)),
  ).toBe("exec_disabled");
});

test.skipIf(process.platform !== "darwin")(
  "macOS: sleep is held while a task runs and released after",
  async () => {
    const { tasks, send, done } = setup({ caffeinate: true });
    await tasks.init();
    tasks.attach(send);
    await tasks.start(AGENT, { taskId: id(13), executor: "shell", command: "sleep 0.3" });
    expect(tasks.holdingSleep).toBe(true);
    await waitFor(() => Boolean(done(id(13))), 8000);
    expect(tasks.holdingSleep).toBe(false);
  },
  15_000,
);

test("protocol 6: pull request URLs in Claude Code tool results, answers and plain lines", () => {
  const cwd = "/w/dev";
  const toolResult = JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", content: [{ type: "text", text: "https://github.com/acme/app/pull/431\n" }] }],
    },
  });
  expect(parseOutputLine(toolResult, "claude", cwd)).toEqual({ prUrl: "https://github.com/acme/app/pull/431" });
  expect(parseOutputLine(JSON.stringify({ type: "user", message: { content: [] } }), "claude", cwd)).toEqual({});
  expect(
    parseOutputLine(JSON.stringify({ type: "result", result: "Opened https://github.com/a/b/pull/7." }), "claude", cwd)
      .prUrl,
  ).toBe("https://github.com/a/b/pull/7");
  expect(parseOutputLine("Created https://gitlab.com/acme/app/-/merge_requests/3", "shell", cwd).prUrl).toBe(
    "https://gitlab.com/acme/app/-/merge_requests/3",
  );
  const parsed = parseServerFrame(
    JSON.stringify({ type: "request", id: "r", op: "task.output", taskId: id(1), tail: 5 }),
  );
  expect(parsed).toMatchObject({ op: "task.output", tail: 5 });
  expect(
    parseRunnerFrame(
      JSON.stringify({ type: "task.event", taskId: id(1), kind: "progress", prUrl: "https://github.com/a/b/pull/1" }),
    ),
  ).toMatchObject({ prUrl: "https://github.com/a/b/pull/1" });
  expect(
    parseRunnerFrame(JSON.stringify({ type: "task.event", taskId: id(1), kind: "progress", prUrl: "javascript:x" })),
  ).not.toHaveProperty("prUrl");
});

test.skipIf(!posix)(
  "task.output: the last human lines of a task's log, secrets redacted; another agent's task is not found",
  async () => {
    const { tasks, send, done } = setup({
      secrets: async () => ({ env: {}, redact: (s: string) => s.replaceAll("hunter2", "[redacted]") }),
    });
    await tasks.init();
    tasks.attach(send);
    await tasks.start(AGENT, { taskId: id(61), executor: "shell", command: "echo one; echo pass hunter2; echo three" });
    await waitFor(() => Boolean(done(id(61))), 8000);
    expect(await tasks.output(AGENT, id(61), 2)).toEqual({ lines: ["pass [redacted]", "three"], truncated: true });
    expect(await tasks.output(AGENT, id(61), 50)).toEqual({
      lines: ["one", "pass [redacted]", "three"],
      truncated: false,
    });
    await expect(tasks.output({ id: "other", handle: "x" }, id(61), 10)).rejects.toMatchObject({ code: "not_found" });
  },
  15_000,
);

test.skipIf(!posix || !hasGit)(
  "a background shell task meets the command policy: a push to the default branch or a force push waits, to a PR branch it runs",
  async () => {
    const { tasks, ws, send, done } = setup();
    await tasks.init();
    tasks.attach(send);
    const folder = await agentWorkspace(ws, AGENT);
    gitRepo(dirs, path.join(folder, "repo"));
    const start = (n: number, command: string, extra: Record<string, unknown> = {}) =>
      tasks.start(AGENT, { taskId: id(n), executor: "shell", command, cwd: "repo", ...extra });
    expect(await errorCode(() => start(30, "git push origin develop"))).toBe("approval_needed");
    const held = await start(30, "git push origin develop").catch((err: Error) => err.message);
    expect(held).toStartWith("This push goes to the default branch develop: a person approves it first.");
    expect(held).toContain("make the same call again with why");
    expect(await start(31, "git push --force origin cursor/pap-582-fix").catch((err: Error) => err.message)).toContain(
      "This is a force push to cursor/pap-582-fix, a branch others may share",
    );
    // Behind a nested shell, or a spelling git reads its own way, it waits the same.
    expect(await start(34, "bash -c 'git push origin develop'").catch((err: Error) => err.message)).toStartWith(
      "This push goes to the default branch develop",
    );
    expect(await errorCode(() => start(35, "git push origin :"))).toBe("approval_needed");
    // Nothing ran: no task was started for them.
    expect(tasks.list()).toEqual([]);
    // The pull request's own branch is ordinary work; a person's approval lets the held one through.
    await start(32, "git push origin HEAD");
    await start(33, "git push origin develop", { approved: true });
    await waitFor(() => Boolean(done(id(32)) && done(id(33))), 10_000);
    expect(done(id(32))).toMatchObject({ exitCode: 0 });
    expect(done(id(33))).toMatchObject({ exitCode: 0 });
    // Through our git proxy a delete never starts, approved or not: delete_branches does it.
    spawnSync("git", ["remote", "set-url", "--push", "origin", PROXY_URL], { cwd: path.join(folder, "repo") });
    expect(await errorCode(() => start(36, "git push origin --delete main", { approved: true }))).toBe("not_allowed");
    expect(await start(37, "git push origin --delete main").catch((err: Error) => err.message)).toContain(
      "Ask with delete_branches",
    );
  },
  30_000,
);

test.skipIf(!posix)(
  "a Claude Code task outside a mission keeps the owner's settings plus the deny list, and every push asks our prompt tool",
  async () => {
    const { make, home } = setup();
    const tasks = make({ mcp: { socketPath: path.join(home, "mcp.sock"), command: ["/opt/agentes-runner"] } });
    await tasks.init();
    const started = await tasks.start(AGENT, { taskId: id(34), executor: "claude", prompt: "Push the fix" });
    expect(started.command).toContain(`--permission-prompt-tool ${PERMISSION_PROMPT_TOOL}`);
    const dir = path.join(home, "tasks", id(34));
    expect(started.command).toContain(`--settings '${path.join(dir, "settings.json")}'`);
    const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
    expect(settings.permissions.ask).toEqual([...PUSH_ASK_RULES]);
    expect(settings.permissions.deny).toEqual([...MISSION_DENY_RULES]);
    // No allow list of ours: the owner's own settings decide the rest, as before.
    expect(settings.permissions.allow).toBeUndefined();
    const mcp = JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.agentes.env).toMatchObject({
      AGENTES_MCP_TASK: "local",
      AGENTES_MCP_BRANCHES: "agentes/dev/",
    });
  },
  15_000,
);

const FOLDER_ACCOUNT = "0193ffff-0000-7000-8000-000000000001";
const ROOTS_ACCOUNT = "0193ffff-0000-7000-8000-000000000002";
const GONE_ACCOUNT = "0193ffff-0000-7000-8000-000000000003";
const TOKEN = "sk-ant-oat01-fake-token-for-tests-only";

/**
 * The fake CLIs as `claude` and `codex` on a PATH of their own (a task's shell finds them there), the computer's
 * own sign-in folders empty (`own`, whatever this machine has), and an agent's accounts as folders under `home`:
 * `FOLDER_ACCOUNT` signed in there for both CLIs, and the agent's own folders for the accounts root keeps.
 */
function fakeClis(home: string) {
  const bin = tempDir("bin-");
  const logs = tempDir("cli-logs-");
  const own = tempDir("cli-home-");
  dirs.push(bin, logs, own);
  for (const [cli, script] of [
    ["claude", "fake-claude.mjs"],
    ["codex", "fake-codex.mjs"],
  ] as const) {
    const file = path.join(bin, cli);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dir, script)}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  const folder = (kind: AccountKind, id: string) => path.join(home, "accounts", kind, id);
  const agentHome = (kind: AccountKind, id: string) => path.join(home, "agent", "accounts", kind, id);
  mkdirSync(folder("claude_code", FOLDER_ACCOUNT), { recursive: true });
  writeFileSync(path.join(folder("claude_code", FOLDER_ACCOUNT), ".credentials.json"), "{}");
  mkdirSync(folder("codex", FOLDER_ACCOUNT), { recursive: true });
  writeFileSync(path.join(folder("codex", FOLDER_ACCOUNT), "auth.json"), "{}");
  const claudeLog = path.join(logs, "claude.log");
  const codexLog = path.join(logs, "codex.log");
  const read = (file: string) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    folder,
    agentHome,
    own,
    claudeRuns: () => read(claudeLog),
    codexRuns: () => read(codexLog),
    options: {
      secrets: async () => ({
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: own,
          CLAUDE_CONFIG_DIR: path.join(own, ".claude"),
          CODEX_HOME: path.join(own, ".codex"),
          FAKE_CLAUDE_LOG: claudeLog,
          FAKE_CODEX_LOG: codexLog,
        },
        redact: (s: string) => s,
      }),
      accounts: {
        accountDir: (kind: AccountKind, id: string) => (id === FOLDER_ACCOUNT ? folder(kind, id) : null),
        agentHome: (kind: AccountKind, id: string) => {
          mkdirSync(agentHome(kind, id), { recursive: true });
          return agentHome(kind, id);
        },
      },
    } satisfies Partial<TaskManagerOptions>,
  };
}

/** Every file under `dir`. */
const filesUnder = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((rel) => path.join(dir, rel))
    .filter((file) => statSync(file).isFile());

test.skipIf(!posix)(
  "protocol 31: a Claude Code task signs in with its agent's account, as its turns: the account's folder, or what root keeps, on a descriptor and in no file",
  async () => {
    const { make, home, send, done, frames } = setup();
    const cli = fakeClis(home);
    const tasks = make(cli.options);
    await tasks.init();
    tasks.attach(send);

    // An account's folder is the CLI's home, its endpoint pinned in the task's own settings.
    await tasks.start(AGENT, { taskId: id(40), executor: "claude", prompt: "Build it", account: FOLDER_ACCOUNT });
    await waitFor(() => Boolean(done(id(40))), 8000);
    expect(done(id(40))).toMatchObject({ exitCode: 0, result: "done: Build it" });
    expect(cli.claudeRuns()[0]).toMatchObject({
      configDir: cli.folder("claude_code", FOLDER_ACCOUNT),
      oauthToken: null,
      settingsEnv: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
    });

    // One root keeps (protocol 29): the agent's own folder for it, and root's token on descriptor 3 only.
    const token = { kind: "token", token: TOKEN } as const;
    await tasks.start(
      AGENT,
      { taskId: id(41), executor: "claude", prompt: "Test it", account: ROOTS_ACCOUNT },
      undefined,
      token,
    );
    await waitFor(() => Boolean(done(id(41))), 8000);
    expect(done(id(41))).toMatchObject({ exitCode: 0, result: "done: Test it" });
    expect(cli.claudeRuns()[1]).toMatchObject({
      configDir: cli.agentHome("claude_code", ROOTS_ACCOUNT),
      oauthToken: TOKEN,
      oauthEnv: null,
      oauthFd: "3",
    });
    // Nothing the runner wrote for its tasks holds it, nor anything it sent.
    for (const file of filesUnder(path.join(home, "tasks"))) expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
    expect(JSON.stringify(frames)).not.toContain(TOKEN);

    // A coding plan's key root keeps: in the CLI's env under the plan's name, with the plan's endpoint and one of
    // its models, and hidden in what the task says.
    const KEY = "zai-fake-key-for-tests-only";
    await tasks.start(
      AGENT,
      { taskId: id(42), executor: "claude", prompt: "ECHOKEY", account: ROOTS_ACCOUNT },
      undefined,
      { kind: "key", provider: "zai", key: KEY },
    );
    await waitFor(() => Boolean(done(id(42))), 8000);
    expect(cli.claudeRuns()[2]).toMatchObject({
      authToken: KEY,
      settingsEnv: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
    });
    expect(cli.claudeRuns()[2]?.args).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    expect(done(id(42))?.result).toStartWith("key ");
    expect(JSON.stringify(frames)).not.toContain(KEY);
    // On OpenCode Go, the model the server named runs the whole task, Claude Code's own small calls included.
    await tasks.start(
      AGENT,
      { taskId: id(60), executor: "claude", prompt: "Go", account: ROOTS_ACCOUNT, model: "deepseek-v4.1-flash" },
      undefined,
      { kind: "key", provider: "opencode", key: "oc_sk_fake-for-tests" },
    );
    await waitFor(() => Boolean(done(id(60))), 8000);
    const go = cli.claudeRuns().at(-1);
    expect(go?.args).toEqual(expect.arrayContaining(["--model", "deepseek-v4.1-flash"]));
    expect(go?.settingsEnv).toMatchObject({
      ANTHROPIC_BASE_URL: "https://opencode.ai/inference/go/anthropic",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4.1-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4.1-flash",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4.1-flash",
    });

    // No account: the computer's own sign-in, and there is none here. The agent reads what it can do, never the
    // CLI's "Please run /login".
    await tasks.start(AGENT, { taskId: id(43), executor: "claude", prompt: "Ship it" });
    await waitFor(() => Boolean(done(id(43))), 8000);
    expect(cli.claudeRuns().at(-1)).toMatchObject({ configDir: path.join(cli.own, ".claude"), oauthToken: null });
    const failed = done(id(43));
    expect(failed?.exitCode).toBe(1);
    expect(failed?.result).toStartWith(
      "Claude Code has no sign-in for this agent on this computer (the agent has no Claude account here)",
    );
    expect(`${failed?.result} ${failed?.lastLine}`).not.toContain("/login");

    // An account that isn't here, or one root has nothing for: refused at once, in its turns' words.
    const refused = (n: number, account: string, grant?: { kind: "none" }) =>
      tasks
        .start(AGENT, { taskId: id(n), executor: "claude", prompt: "x", account }, undefined, grant)
        .catch((err: Error) => err.message);
    expect(await refused(44, GONE_ACCOUNT)).toBe(ACCOUNT_MISSING_MESSAGE.claude_code);
    expect(await refused(45, ROOTS_ACCOUNT, { kind: "none" })).toBe(ACCOUNT_SIGNED_OUT);
    expect(cli.claudeRuns()).toHaveLength(5);
  },
  30_000,
);

test.skipIf(!posix)(
  "protocol 31: a Codex task signs in with its agent's account's folder; without one it says what the agent can do",
  async () => {
    const { make, home, send, done } = setup();
    const cli = fakeClis(home);
    const tasks = make(cli.options);
    await tasks.init();
    tasks.attach(send);
    await withContainersClient(async () => {
      await tasks.start(AGENT, { taskId: id(46), executor: "codex", prompt: "Port it", account: FOLDER_ACCOUNT });
      await waitFor(() => Boolean(done(id(46))), 8000);
    });
    expect(done(id(46))).toMatchObject({ exitCode: 0, result: "done: Port it" });
    expect(cli.codexRuns()[0]?.codexHome).toBe(cli.folder("codex", FOLDER_ACCOUNT));
    // Its sandbox holds it, so the agent's containers service isn't named to it (ADR 0169).
    expect(cli.codexRuns()[0]?.containers).toEqual([]);

    await tasks.start(AGENT, { taskId: id(47), executor: "codex", prompt: "Port it" });
    await waitFor(() => Boolean(done(id(47))), 8000);
    expect(cli.codexRuns()[1]?.codexHome).toBe(path.join(cli.own, ".codex"));
    expect(done(id(47))?.result).toStartWith(
      "Codex has no sign-in for this agent on this computer (the agent has no ChatGPT account here)",
    );

    // A 401 from some API a command called is the task's own failure, not Codex's sign-in.
    await tasks.start(AGENT, { taskId: id(51), executor: "codex", prompt: "CURL401", account: FOLDER_ACCOUNT });
    await waitFor(() => Boolean(done(id(51))), 8000);
    expect(done(id(51))?.result).toBe("curl said 401 Unauthorized");
  },
  20_000,
);

test.skipIf(!posix)(
  "a task on an account its agent no longer thinks with is canceled, as its turns' processes close",
  async () => {
    const { make, home, send, done } = setup();
    const cli = fakeClis(home);
    const tasks = make(cli.options);
    await tasks.init();
    tasks.attach(send);
    await tasks.start(AGENT, { taskId: id(48), executor: "claude", prompt: "SLOWTASK", account: FOLDER_ACCOUNT });
    await tasks.start(AGENT, { taskId: id(49), executor: "shell", command: "sleep 30" });
    tasks.keepAccount(FOLDER_ACCOUNT);
    expect(tasks.list().map((t) => t.status)).toEqual(["running", "running"]);
    // One of the several accounts the agent thinks with (the team's right hand): it goes on too.
    tasks.keepAccount(null, [FOLDER_ACCOUNT]);
    expect(tasks.list().map((t) => t.status)).toEqual(["running", "running"]);
    // Root says the agent thinks with nothing now: the task on its old account stops, the shell task goes on.
    tasks.keepAccount(null);
    await waitFor(() => Boolean(done(id(48))), 8000);
    expect(done(id(48))).toMatchObject({ canceled: true });
    expect(done(id(48))?.lastLine).toBe("Stopped: this agent's AI account changed. Start it again to use the new one.");
    expect(done(id(49))).toBeUndefined();
    tasks.cancel(AGENT, id(49));
    await waitFor(() => Boolean(done(id(49))), 8000);
  },
  20_000,
);

test.skipIf(!posix)(
  "a runner restarted since a task on an account started never tries it again on the computer's own sign-in",
  async () => {
    const { make, home, send, done } = setup();
    const cli = fakeClis(home);
    const first = make(cli.options);
    await first.init();
    first.attach(send);
    const session = "0193aaaa-0000-7000-8000-0000000000ff";
    await first.start(AGENT, {
      taskId: id(50),
      executor: "claude",
      prompt: "NOSESSION",
      session,
      account: FOLDER_ACCOUNT,
    });
    // The task outlives its runner; the next one only has the journal, not the account's sign-in.
    first.close();
    const again = make(cli.options);
    await again.init();
    again.attach(send);
    await waitFor(() => Boolean(done(id(50))), 8000);
    // Claude Code refused the session flag, which the runner would otherwise retry with the other one.
    expect(done(id(50))?.result).toContain("No conversation found");
    expect(cli.claudeRuns()).toHaveLength(1);
  },
  20_000,
);

test.skipIf(!posix)(
  "a runner restarted mid-task never lets out a coding plan's key it can no longer hide",
  async () => {
    const { make, home, send, done, frames } = setup();
    const cli = fakeClis(home);
    const first = make(cli.options);
    await first.init();
    first.attach(send);
    const KEY = "zai-fake-key-for-tests-only";
    await first.start(
      AGENT,
      { taskId: id(52), executor: "claude", prompt: "SLOWKEY ECHOKEY", account: ROOTS_ACCOUNT },
      undefined,
      { kind: "key", provider: "zai", key: KEY },
    );
    // Root kept the key: the next runner only has the journal, so it can't hide it and stops the task.
    first.close();
    const again = make(cli.options);
    await again.init();
    again.attach(send);
    await waitFor(() => Boolean(done(id(52))), 8000);
    expect(done(id(52))).toMatchObject({ canceled: true });
    expect(done(id(52))?.result).toStartWith("Stopped: the runner restarted");
    expect(JSON.stringify(frames)).not.toContain(KEY);
  },
  20_000,
);

// ── A Claude sign-in several agents share: root runs the CLI, the task stays here ──────────────────────────────────

const SHARED = "0193ffff-0000-7000-8000-000000000002";
const hostedStart = (n: number) => ({ taskId: id(n), executor: "claude" as const, prompt: "fix it", account: SHARED });
const HOSTED: { kind: "hosted" } = { kind: "hosted" };

test.skipIf(!posix)("a hosted task starts no wrapper, says where it runs, and ends as root says", async () => {
  const s = setup();
  s.tasks.attach(s.send);
  await s.tasks.init();
  const reply = (await s.tasks.start(AGENT, hostedStart(1), undefined, HOSTED)) as { host?: unknown; pid: number };
  expect(reply.pid).toBe(process.pid);
  expect(reply.host).toMatchObject({ where: "", git: false });
  const dir = path.join(s.home, "tasks", id(1));
  expect(existsSync(path.join(dir, "spec.json"))).toBe(false);
  expect(existsSync(path.join(dir, "stdin.txt"))).toBe(false);
  expect(s.tasks.list()[0]).toMatchObject({ taskId: id(1), status: "running" });

  const assistant = {
    type: "assistant",
    session_id: "s",
    message: {
      content: [{ type: "tool_use", name: "mcp__agentes__Edit", input: { file_path: "app.ts", old_string: "a" } }],
    },
  };
  s.tasks.hostedOutput(id(1), "stdout", JSON.stringify(assistant));
  s.tasks.hostedOutput(id(1), "stdout", JSON.stringify({ type: "result", session_id: "s", result: "all done" }));
  s.tasks.hostedExit(id(1), { exitCode: 0, signal: null, reason: null });
  await waitFor(() => s.done(id(1)) !== undefined);
  expect(s.done(id(1))).toMatchObject({ exitCode: 0, result: "all done", files: ["app.ts"], session: "s" });
  // Nothing more lands for a task that ended.
  s.tasks.hostedOutput(id(1), "stdout", "late");
  expect(readFileSync(path.join(dir, "stdout.log"), "utf8")).not.toContain("late");
});

test.skipIf(!posix)("a hosted task's cancel asks root, and never signals the worker it runs beside", async () => {
  const stops: string[] = [];
  const s = setup({ hostedStop: (taskId) => stops.push(taskId) });
  s.tasks.attach(s.send);
  await s.tasks.init();
  await s.tasks.start(AGENT, hostedStart(2), undefined, HOSTED);
  const kill = process.kill;
  const killed: unknown[] = [];
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal === "SIGKILL") killed.push(pid);
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    expect(s.tasks.cancel(AGENT, id(2))).toEqual({ canceled: true });
    expect(stops).toEqual([id(2)]);
    (s.tasks as unknown as { hardKill(t: unknown, dir: string): void }).hardKill(
      { hosted: true, pid: process.pid },
      s.home,
    );
    expect(killed).toEqual([]);
  } finally {
    process.kill = kill;
  }
  s.tasks.hostedExit(id(2), { exitCode: null, signal: "SIGTERM", reason: "canceled" });
  await waitFor(() => s.done(id(2)) !== undefined);
  expect(s.done(id(2))).toMatchObject({ canceled: true });
});

test.skipIf(!posix)(
  "a hosted task's CLI doesn't outlive the runner: the next one reads it as interrupted",
  async () => {
    const s = setup();
    await s.tasks.init();
    await s.tasks.start(AGENT, hostedStart(3), undefined, HOSTED);
    s.tasks.close();
    const next = s.make();
    next.attach(s.send);
    await next.init();
    await waitFor(() => s.done(id(3)) !== undefined);
    expect(s.done(id(3))).toMatchObject({ interrupted: true });
  },
);

test.skipIf(!posix)("a hosted task's commands refused with nobody to ask go with its end", async () => {
  const s = setup();
  s.tasks.attach(s.send);
  await s.tasks.init();
  await s.tasks.start(AGENT, { ...hostedStart(4), session: "0193aaaa-0000-7000-8000-000000000044" }, undefined, HOSTED);
  s.tasks.hostedDenial("0193aaaa-0000-7000-8000-000000000044", "Bash", { command: "git push" });
  s.tasks.hostedDenial("0193aaaa-0000-7000-8000-000000000044", "Bash", { command: "git push" });
  s.tasks.hostedDenial("another-session", "Bash", { command: "rm -rf x" });
  s.tasks.hostedExit(id(4), { exitCode: 1, signal: null, reason: null });
  await waitFor(() => s.done(id(4)) !== undefined);
  expect(s.done(id(4))?.denials).toEqual([{ tool: "Bash", command: "git push" }]);
});

test("a tool of Claude Code's served by the bridge reads as itself; the server's keep their names", () => {
  const line = (name: string) =>
    parseOutputLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name, input: { command: "ls" } }] },
      }),
      "claude",
      "/w",
    ).line;
  expect(line("mcp__agentes__Bash")).toBe("Running: ls");
  expect(line("mcp__agentes__update_plan")).toBe("Using mcp__agentes__update_plan");
});
