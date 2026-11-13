import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunnerFrame } from "@agenteschat/adapters/machine-protocol";
import { agentWorkspace } from "../../runner/paths";
import { executorCommand, type SettledTask, TaskManager } from "../../runner/tasks";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const managers: TaskManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };
const TASK = "0193aaaa-0000-7000-8000-000000000042";

test.skipIf(!posix)(
  "a compiled runner runs the task wrapper in-process (`task-wrapper <dir>`), same result as wrap.mjs",
  async () => {
    const ws = tempDir("ws-");
    const home = tempDir("home-");
    const bin = tempDir("bin-");
    dirs.push(ws, home, bin);
    // Stands in for `agentes-runner task-wrapper <dir>`: the same function main.ts calls.
    const entry = path.join(bin, "task-wrapper.ts");
    writeFileSync(
      entry,
      `import { runTaskWrapper } from ${JSON.stringify(path.resolve(import.meta.dir, "../../runner/tasks.ts"))};\nrunTaskWrapper(process.argv[2]);\n`,
    );
    const frames: RunnerFrame[] = [];
    const settled: SettledTask[] = [];
    const tasks = new TaskManager({
      root: path.join(home, "tasks"),
      workspaceReal: ws,
      agentFolder: (agent) => agentWorkspace(ws, agent),
      watchMs: 20,
      eventEveryMs: 0,
      caffeinate: false,
      wrapperCommand: [process.execPath, entry],
      onSettled: (t) => settled.push(t),
    });
    managers.push(tasks);
    await tasks.init();
    tasks.attach((f) => frames.push(f));
    await tasks.start(AGENT, { taskId: TASK, executor: "shell", command: "echo compiled; exit 0" });
    expect(tasks.runningTasks().map((t) => t.taskId)).toEqual([TASK]);
    await waitFor(() => frames.some((f) => f.type === "task.done"), 8000);
    expect(frames.find((f) => f.type === "task.done")).toMatchObject({ taskId: TASK, exitCode: 0, result: "compiled" });
    // No wrap.mjs is written when the runner has its own wrapper command.
    expect(existsSync(path.join(home, "tasks", "wrap.mjs"))).toBe(false);
    expect(settled).toMatchObject([{ taskId: TASK, executor: "shell", done: { exitCode: 0 } }]);
    expect(tasks.runningTasks()).toEqual([]);
  },
  15_000,
);

test("allowed folders reach the executors: --add-dir for Claude Code, writable roots for Codex", () => {
  expect(executorCommand("claude", { addDirs: ["/data/app", "/data/it's"], platform: "linux" })).toBe(
    "claude -p --output-format stream-json --verbose --permission-mode acceptEdits --add-dir '/data/app' --add-dir '/data/it'\\''s'",
  );
  const codex = executorCommand("codex", {
    addDirs: ["/data/app"],
    codex: { cwd: "/w", sandbox: "workspace-write", lastFile: "/l.txt" },
    platform: "linux",
  });
  expect(codex).toContain(`-c 'sandbox_workspace_write.writable_roots=["/data/app"]'`);
  // A read-only sandbox reads anywhere already; no writable roots there.
  expect(
    executorCommand("codex", {
      addDirs: ["/data/app"],
      codex: { cwd: "/w", sandbox: "read-only", lastFile: "/l.txt" },
      platform: "linux",
    }),
  ).not.toContain("writable_roots");
});
