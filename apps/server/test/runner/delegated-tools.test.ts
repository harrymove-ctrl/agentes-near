import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { ASK_AFTER_TASK, PLAN_MESSAGE } from "@agenteschat/adapters/command-policy";
import { PERMISSION_TOOL } from "@agenteschat/adapters/machine-protocol";
import {
  BASH_MAX_TIMEOUT_MS,
  DELEGATED_RESULT_TOKENS,
  DELEGATED_TOOLS,
  type DelegatedBridge,
  type DelegatedScope,
  DelegatedTools,
  type DelegatedToolsOptions,
  delegatedTask,
  PLAN_DELEGATED_TOOLS,
  parseBridge,
  type ToolNotice,
} from "../../runner/delegated-tools";
import { formatBytes } from "../../runner/exec";
import {
  claudeMcpConfig,
  handleMcpMessage,
  type IpcReply,
  McpBridge,
  type McpTaskInfo,
  type McpToolResult,
  runMcpRelay,
  type ToolCaller,
} from "../../runner/mcp";
import { WorkerLink } from "../../runner/worker";
import { removeDirs, tempDir, waitFor } from "./helpers";

type Tool = (typeof DELEGATED_TOOLS)[number];

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  removeDirs(dirs);
});

const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "ada" };
const HIDDEN = "tok_ada_0123456789";
const SECRETS = {
  env: { ADA_TOKEN: HIDDEN },
  files: [] as string[],
  hold: HIDDEN.length - 1,
  redact: (text: string) => text.replaceAll(HIDDEN, "[secret]"),
};

const temp = (prefix: string) => {
  const dir = tempDir(prefix);
  dirs.push(dir);
  return dir;
};

const allow: IpcReply = { ok: true, text: JSON.stringify({ behavior: "allow" }) };
const deny: IpcReply = { ok: true, text: JSON.stringify({ behavior: "deny", message: "Lia said no." }) };

function setup(over: Partial<DelegatedScope> = {}, options: Partial<DelegatedToolsOptions> = {}) {
  const folder = temp("delegated-");
  const notices: ToolNotice[] = [];
  const asked: { tool: string; args: Record<string, unknown> }[] = [];
  const state = { answer: deny };
  const tools = new DelegatedTools({
    secrets: async () => null,
    onNotice: (n) => notices.push(n),
    root: temp("shells-"),
    ...options,
  });
  closers.push(() => tools.close());
  const scope = { session: "s1", cwd: folder, folder, profile: "work" as const, ...over };
  const surface = tools.surface(scope);
  const ask: ToolCaller = async (tool, args) => {
    asked.push({ tool, args });
    return state.answer;
  };
  let id = 0;
  const call = (name: string, args: Record<string, unknown>, callId: string | number = ++id) =>
    surface.call(name, args, { id: callId, ask });
  return { folder, tools, surface, scope, call, notices, asked, state, ask };
}

const textOf = (r: McpToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const idIn = (text: string) =>
  /\(ID: (b[0-9a-f]+)\)|with ID: (b[0-9a-f]+)/.exec(text)?.slice(1).find(Boolean) as string;

// ── The surface ──────────────────────────────────────────────────────────────

test("the tools keep Claude Code's names, and a plan turn gets no way to edit", () => {
  expect(DELEGATED_TOOLS.map((t) => t.name)).toEqual([
    "Bash",
    "TaskOutput",
    "TaskStop",
    "Read",
    "Edit",
    "Write",
    "Glob",
    "Grep",
  ]);
  expect(PLAN_DELEGATED_TOOLS.map((t) => t.name)).toEqual(["Bash", "TaskOutput", "TaskStop", "Read", "Glob", "Grep"]);
  const fields = (name: string) =>
    Object.keys((DELEGATED_TOOLS.find((t) => t.name === name) as Tool).inputSchema.properties as object);
  expect(fields("Bash")).toEqual(["command", "timeout", "description", "run_in_background"]);
  expect(fields("Read")).toEqual(["file_path", "offset", "limit", "pages"]);
  expect(fields("Edit")).toEqual(["file_path", "old_string", "new_string", "replace_all"]);
  expect(fields("Write")).toEqual(["file_path", "content"]);
  expect(fields("Glob")).toEqual(["pattern", "path"]);
  expect(fields("Grep")).toContain("output_mode");
  expect(fields("Grep")).toContain("head_limit");
  expect(fields("TaskStop")).toEqual(["task_id", "shell_id"]);
  // Listed up front, as the CLI's own are; behind ToolSearch the model would first have to look for its shell.
  for (const tool of DELEGATED_TOOLS) expect(tool).toMatchObject({ _meta: { "anthropic/alwaysLoad": true } });
  const reads = DELEGATED_TOOLS.filter((t) => (t as { annotations?: unknown }).annotations).map((t) => t.name);
  expect(reads).toEqual(["TaskOutput", "Read", "Glob", "Grep"]);
});

test("a tool's result never goes past what the CLI takes inline", async () => {
  const fake = fakeRg(Array.from({ length: 30_000 }, (_, i) => `./a:${i}:xxxxxxxx`).join("\n"));
  const { call } = setup({}, { rg: fake.rg });
  const out = textOf(await call("Grep", { pattern: "x", output_mode: "content", head_limit: 0 }));
  expect(out.length).toBeLessThan(DELEGATED_RESULT_TOKENS * 4 + 100);
  // Claude Code 2.1.308 saves an MCP result over 50,000 characters to its own store, out of every tool's reach.
  expect(out.length).toBeLessThanOrEqual(50_000);
  expect(out).toEndWith("[Cut here: ask for less, with offset, limit or a narrower search.]");
});

test("sizes read as Claude Code writes them", () => {
  expect(BASH_MAX_TIMEOUT_MS).toBe(600_000);
  expect(formatBytes(64200)).toBe("62.7KB");
  expect(formatBytes(5 * 1024 ** 3)).toBe("5GB");
  expect(formatBytes(10)).toBe("10 bytes");
});

// ── Bash ─────────────────────────────────────────────────────────────────────

test("Bash runs in bash, both streams in order, and a failure says its exit code first", async () => {
  const { call, state } = setup();
  state.answer = allow;
  const ok = await call("Bash", { command: `[[ a == a ]] && echo out; echo err >&2` });
  expect(ok).toEqual({ content: [{ type: "text", text: "out\nerr" }], isError: false });
  const failed = await call("Bash", { command: "echo nope; exit 3" });
  expect(failed.isError).toBe(true);
  expect(textOf(failed)).toBe("Exit code 3\nnope");
  expect(textOf(await call("Bash", { command: "true" }))).toBe("(Bash completed with no output)");
  // The wrapper's own arguments aren't the command's.
  expect(textOf(await call("Bash", { command: 'echo "[$#]"' }))).toBe("[0]");
  expect(textOf(await call("Bash", {}))).toBe("command is required");
});

test("the working directory carries over between calls, and comes back from outside the turn's folders", async () => {
  const { call, folder, state } = setup();
  state.answer = allow;
  mkdirSync(path.join(folder, "app"));
  await call("Bash", { command: "cd app" });
  expect(textOf(await call("Bash", { command: "pwd" }))).toBe(path.join(folder, "app"));
  writeFileSync(path.join(folder, "app", "a.txt"), "one\n");
  expect(textOf(await call("Read", { file_path: "a.txt" }))).toBe("1\tone");
  const out = temp("elsewhere-");
  expect(textOf(await call("Bash", { command: `cd ${out}` }))).toContain(`Shell cwd was reset to ${folder}`);
  expect(textOf(await call("Bash", { command: "pwd" }))).toBe(folder);
});

test("a folder that went away puts the shell back where the turn started", async () => {
  const { call, folder, state } = setup();
  state.answer = allow;
  mkdirSync(path.join(folder, "gone"));
  await call("Bash", { command: "cd gone" });
  await call("Bash", { command: `rm -rf ${path.join(folder, "gone")}` });
  expect(textOf(await call("Bash", { command: "pwd" }))).toBe(folder);
});

test("commands get the agent's secrets, and no result shows them", async () => {
  const { call, state } = setup({}, { secrets: async () => SECRETS });
  state.answer = allow;
  const out = await call("Bash", { command: 'echo "value=$ADA_TOKEN"' });
  expect(textOf(out)).toBe("value=[secret]");
});

test("output past the inline limit comes back as a preview and a file Read can page, redacted", async () => {
  const { call, state } = setup({}, { secrets: async () => SECRETS });
  state.answer = allow;
  const out = textOf(await call("Bash", { command: `echo "$ADA_TOKEN"; seq 1 20000` }));
  expect(out).toStartWith("Output too large (");
  expect(out).toContain("Preview (first 2KB):\n[secret]\n1\n2\n");
  expect(out).not.toContain(HIDDEN);
  const file = /saved to: (\S+)/.exec(out)?.[1] as string;
  expect(readFileSync(file, "utf8")).toContain("19999\n");
  const paged = textOf(await call("Read", { file_path: file, offset: 1, limit: 3 }));
  expect(paged).toBe("1\t[secret]\n2\t1\n3\t2");
});

test("a command that outlives its timeout moves to the background, as Claude Code's does", async () => {
  const { call, notices, state, folder } = setup();
  state.answer = allow;
  const mark = path.join(folder, "mark");
  const out = textOf(await call("Bash", { command: `sleep 0.3; echo done > ${mark}`, timeout: 20 }));
  expect(out).toStartWith("Command did not complete within its 1s timeout and was moved to the background (ID: b");
  expect(out).toContain("stop it with TaskStop");
  const id = idIn(out);
  await waitFor(() => existsSync(mark));
  await waitFor(() => notices.length === 2);
  expect(notices.map((n) => n.status)).toEqual(["running", "completed"]);
  expect(notices[1]).toMatchObject({ session: "s1", shellId: id, exitCode: 0 });
});

test("a background command answers at once, keeps its output, and says when it ends", async () => {
  const { call, notices, state } = setup();
  state.answer = allow;
  const started = textOf(
    await call("Bash", { command: "sleep 0.2; echo ready; exit 4", run_in_background: true, description: "Start it" }),
  );
  expect(started).toMatch(/^Command running in background with ID: b[0-9a-f]+\. Output is being written to: /);
  const id = idIn(started);
  await waitFor(() => notices.length === 1);
  expect(notices[0]).toMatchObject({ shellId: id, status: "running", summary: "Start it" });
  const early = textOf(await call("TaskOutput", { task_id: id, block: false }));
  expect(early).toContain("<retrieval_status>not_ready</retrieval_status>");
  expect(early).toContain("<status>running</status>");
  const late = textOf(await call("TaskOutput", { task_id: id }));
  expect(late).toContain("<retrieval_status>success</retrieval_status>");
  expect(late).toContain("<status>failed</status>");
  expect(late).toContain("<exit_code>4</exit_code>");
  expect(late).toContain("<output>\nready\n</output>");
  await waitFor(() => notices.length === 2);
  expect(notices[1]).toMatchObject({ shellId: id, status: "failed", exitCode: 4 });
});

test("TaskOutput stops waiting at its timeout, and a shell of another session isn't found", async () => {
  const { call, state, tools, scope, ask } = setup();
  state.answer = allow;
  const id = idIn(textOf(await call("Bash", { command: "sleep 5", run_in_background: true })));
  const waited = textOf(await call("TaskOutput", { task_id: id, timeout: 10 }));
  expect(waited).toContain("<retrieval_status>timeout</retrieval_status>");
  const other = tools.surface({ ...scope, session: "s2" });
  const out = await other.call("TaskStop", { task_id: id }, { id: 1, ask });
  expect(out).toEqual({ content: [{ type: "text", text: `No task found with ID: ${id}` }], isError: true });
  expect((await call("TaskOutput", { task_id: "b00000000" })).isError).toBe(true);
});

test("TaskStop ends a background command and all it started", async () => {
  const { call, notices, state, folder } = setup();
  state.answer = allow;
  const pidFile = path.join(folder, "pid");
  const id = idIn(
    textOf(await call("Bash", { command: `sleep 30 & echo $! > ${pidFile}; wait`, run_in_background: true })),
  );
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(alive(pid)).toBe(true);
  const stopped = JSON.parse(textOf(await call("TaskStop", { shell_id: id })));
  expect(stopped).toMatchObject({ task_id: id, task_type: "local_bash" });
  expect(stopped.message).toStartWith(`Successfully stopped task: ${id}`);
  await waitFor(() => !alive(pid));
  await waitFor(() => notices.length === 2);
  expect(notices[1]).toMatchObject({ status: "killed" });
  const again = await call("TaskStop", { task_id: id });
  expect(textOf(again)).toBe(`Task ${id} is not running (status: killed)`);
  expect(textOf(await call("TaskStop", {}))).toBe("Missing required parameter: task_id");
});

test("a plan turn stops the shells it started, never one a work turn left running", async () => {
  const { tools, scope, call, state, ask } = setup();
  state.answer = allow;
  const server = idIn(textOf(await call("Bash", { command: "sleep 30", run_in_background: true })));
  const plan = tools.surface({ ...scope, profile: "plan" });
  const inPlan = (name: string, args: Record<string, unknown>, id: number) => plan.call(name, args, { id, ask });
  const refused = await inPlan("TaskStop", { task_id: server }, 100);
  expect(refused).toMatchObject({ isError: true });
  expect(textOf(refused)).toBe(PLAN_MESSAGE);
  expect(textOf(await inPlan("TaskOutput", { task_id: server, block: false }, 101))).toContain(
    "<status>running</status>",
  );
  const own = idIn(textOf(await inPlan("Bash", { command: "tail -f /dev/null", run_in_background: true }, 102)));
  expect(textOf(await inPlan("TaskStop", { task_id: own }, 103))).toContain("Successfully stopped");
});

test("a CLI no notice can reach is told to look, and its task's end takes its shells", async () => {
  const { call, tools, folder, notices, state } = setup({ oneShot: true });
  state.answer = allow;
  const pidFile = path.join(folder, "pid");
  const started = textOf(
    await call("Bash", { command: `echo $$ > ${pidFile}; exec sleep 30`, run_in_background: true }),
  );
  expect(started).toContain("Check on it with TaskOutput.");
  expect(started).not.toContain("notified");
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const pid = Number(readFileSync(pidFile, "utf8"));
  tools.endSession("s1");
  await waitFor(() => !alive(pid));
  // Started, and nothing after: nobody is left to hear of its end.
  expect(notices).toHaveLength(1);
  expect(textOf(await call("TaskOutput", { task_id: "b00000000" }))).toContain("No task found");
  tools.endSession("no-such-session");
});

test("a background command's timeout is how long it may run there", async () => {
  const { call, notices, state } = setup();
  state.answer = allow;
  await call("Bash", { command: "sleep 30", run_in_background: true, timeout: 20 });
  await waitFor(() => notices.length === 2);
  expect(notices[1]).toMatchObject({ status: "killed" });
});

test("detach answers the call and leaves the command running", async () => {
  const { call, tools, notices, state, folder } = setup();
  state.answer = allow;
  const mark = path.join(folder, "mark");
  const started = path.join(folder, "started");
  const running = call("Bash", { command: `touch ${started}; sleep 0.3; echo done > ${mark}` });
  await waitFor(() => existsSync(started));
  tools.detach("s1");
  const out = textOf(await running);
  expect(out).toStartWith("Command was moved to the background (ID: b");
  expect(out).toContain("it was not interrupted");
  expect(existsSync(mark)).toBe(false);
  await waitFor(() => existsSync(mark));
  await waitFor(() => notices.length === 2);
  expect(notices.map((n) => n.status)).toEqual(["running", "completed"]);
});

test("cancel ends the call's whole process group, in under two seconds, ignored TERM included", async () => {
  const { call, surface, state, folder } = setup();
  state.answer = allow;
  const pidFile = path.join(folder, "pid");
  const running = call("Bash", { command: `trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait` }, 7);
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const pid = Number(readFileSync(pidFile, "utf8"));
  const at = Date.now();
  surface.cancel(7);
  expect(textOf(await running)).toBe("Command was aborted before completion");
  await waitFor(() => !alive(pid));
  expect(Date.now() - at).toBeLessThan(2000);
});

test("cancelling the session ends its calls and leaves its background shells", async () => {
  const { call, tools, state, folder } = setup();
  state.answer = allow;
  const id = idIn(textOf(await call("Bash", { command: "sleep 30", run_in_background: true })));
  const started = path.join(folder, "started");
  const running = call("Bash", { command: `touch ${started}; sleep 30` });
  await waitFor(() => existsSync(started));
  tools.cancel("s1");
  expect((await running).isError).toBe(true);
  expect(textOf(await call("TaskOutput", { task_id: id, block: false }))).toContain("<status>running</status>");
  tools.cancel("nobody");
  tools.detach("nobody");
});

test("a command writing without end is stopped at the output cap", async () => {
  const { call, state } = setup({}, { maxShellOutputBytes: 1000, shellWatchMs: 10 });
  state.answer = allow;
  const out = await call("Bash", { command: "yes" });
  expect(out.isError).toBe(true);
  expect(textOf(out)).toContain("Command killed: output file exceeded 1000 bytes");
});

test("commands start through the worker's scope gate, as their own process group", async () => {
  const seen: { file: string; args: readonly string[]; detached?: boolean }[] = [];
  const { spawn } = await import("node:child_process");
  const { call, state } = setup(
    {},
    {
      spawn: (file, args, options) => {
        seen.push({ file, args, ...(options.detached ? { detached: true } : {}) });
        return spawn(file, args, options);
      },
    },
  );
  state.answer = allow;
  await call("Bash", { command: "echo hi" });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.args[3]).toBe("echo hi");
  expect(seen[0]?.detached).toBe(true);
});

test("the worker stopping stops the shells", async () => {
  const { call, tools, state, folder } = setup();
  state.answer = allow;
  const pidFile = path.join(folder, "pid");
  await call("Bash", { command: `sleep 30 & echo $! > ${pidFile}; wait`, run_in_background: true });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const pid = Number(readFileSync(pidFile, "utf8"));
  tools.close();
  await waitFor(() => !alive(pid));
});

// ── The gate ─────────────────────────────────────────────────────────────────

test("what the computer refuses is refused before anything runs, and no person is asked", async () => {
  const { call, asked, folder } = setup();
  const mark = path.join(folder, "mark");
  const merge = await call("Bash", { command: `touch ${mark}; git merge main` });
  expect(merge.isError).toBe(true);
  expect(textOf(merge)).toContain("This is a merge");
  expect((await call("Bash", { command: "cat ~/.ssh/id_rsa" })).isError).toBe(true);
  expect(textOf(await call("Bash", { command: `python3 -c 'open("${mark}", "w")'` }))).toContain("denied");
  expect(asked).toEqual([]);
  expect(existsSync(mark)).toBe(false);
});

test("reads and what the turn's rules allow go on without asking", async () => {
  const { call, asked, folder } = setup();
  writeFileSync(path.join(folder, "a.txt"), "hello\n");
  expect(textOf(await call("Bash", { command: "cat a.txt" }))).toBe("hello");
  expect(textOf(await call("Bash", { command: "mkdir -p lib && touch lib/x" }))).toBe(
    "(Bash completed with no output)",
  );
  expect(existsSync(path.join(folder, "lib", "x"))).toBe(true);
  expect(asked).toEqual([]);
});

test("anything else goes to the prompt, and the person's word decides", async () => {
  const { call, asked, state, folder } = setup();
  const mark = path.join(folder, "mark");
  const command = `ada-tool --go; touch ${mark}`;
  const no = await call("Bash", { command, description: "Tell it" }, 11);
  expect(textOf(no)).toBe("Lia said no.");
  expect(existsSync(mark)).toBe(false);
  expect(asked[0]).toMatchObject({
    tool: PERMISSION_TOOL,
    args: { tool_name: "Bash", input: { command, description: "Tell it" }, tool_use_id: "delegated-11" },
  });
  state.answer = allow;
  expect((await call("Bash", { command })).isError).toBe(false);
  expect(existsSync(mark)).toBe(true);
});

test("an allow rule never covers what it can't follow, or a write out of the folders", async () => {
  const { call, asked, folder } = setup();
  const mark = path.join(folder, "mark");
  expect((await call("Bash", { command: `mkdir x$(touch ${mark})` })).isError).toBe(true);
  expect(existsSync(mark)).toBe(false);
  const out = temp("elsewhere-");
  expect((await call("Bash", { command: `mkdir y > ${out}/file` })).isError).toBe(true);
  expect(existsSync(path.join(out, "file"))).toBe(false);
  expect(asked).toHaveLength(2);
});

test("a push is kept for the prompt whatever the allow rules say", async () => {
  const { call } = setup({ allow: ["Bash(git push *)"] });
  const out = await call("Bash", { command: "git push origin main" });
  expect(out.isError).toBe(true);
});

test("a rule a person gave for the mission allows that command", async () => {
  const { call, asked } = setup({ allow: ["Bash(ada-tool *)"] });
  const out = await call("Bash", { command: "ada-tool run" });
  expect(asked).toEqual([]);
  expect(textOf(out)).toContain("Exit code 127");
});

test("a plan turn runs reads and nothing else, asking nobody", async () => {
  const { call, asked, folder } = setup({ profile: "plan" });
  writeFileSync(path.join(folder, "a.txt"), "hello\n");
  expect(textOf(await call("Bash", { command: "cat a.txt" }))).toBe("hello");
  expect(textOf(await call("Read", { file_path: path.join(folder, "a.txt") }))).toBe("1\thello");
  const touched = await call("Bash", { command: "touch b.txt" });
  expect(touched.isError).toBe(true);
  expect((await call("Write", { file_path: path.join(folder, "b.txt"), content: "x" })).isError).toBe(true);
  expect(existsSync(path.join(folder, "b.txt"))).toBe(false);
  expect(asked).toEqual([]);
});

test("cancel ends a call that waits for a person", async () => {
  const { surface, folder } = setup();
  const never: ToolCaller = () => new Promise<IpcReply>(() => {});
  const running = surface.call("Write", { file_path: "/nowhere/ada.txt", content: "x" }, { id: 3, ask: never });
  await Bun.sleep(20);
  surface.cancel(3);
  const out = await running;
  expect(out).toEqual({ content: [{ type: "text", text: "The call was canceled." }], isError: true });
  expect(existsSync(path.join(folder, "ada.txt"))).toBe(false);
});

// ── Read ─────────────────────────────────────────────────────────────────────

test("Read numbers lines from one, takes offset and limit, and warns about an empty file", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.txt");
  writeFileSync(file, "one\r\ntwo\nthree\n");
  expect(textOf(await call("Read", { file_path: file }))).toBe("1\tone\n2\ttwo\n3\tthree");
  expect(textOf(await call("Read", { file_path: file, offset: 2, limit: 1 }))).toBe("2\ttwo");
  expect(textOf(await call("Read", { file_path: file, offset: "3" }))).toBe("3\tthree");
  expect(textOf(await call("Read", { file_path: file, offset: 9 }))).toBe(
    "<system-reminder>Warning: the file exists but is shorter than the provided offset (9). The file has 3 lines.</system-reminder>",
  );
  writeFileSync(file, "");
  expect(textOf(await call("Read", { file_path: file }))).toBe(
    "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
  );
});

test("Read counts lines as grep does: only a newline ends one", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.txt");
  writeFileSync(file, "one\ntwo\rthree\nfour\n");
  expect(textOf(await call("Read", { file_path: file, offset: 3 }))).toBe("3\tfour");
  writeFileSync(file, "a\u2028b\u2029c\nlast");
  expect(textOf(await call("Read", { file_path: file }))).toBe("1\ta\u2028b\u2029c\n2\tlast");
});

test("Read stops at 2000 lines and at the size limits, and offset and limit get past the size", async () => {
  const { call, folder } = setup();
  const long = path.join(folder, "long.txt");
  writeFileSync(long, Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n"));
  const lines = textOf(await call("Read", { file_path: long })).split("\n");
  expect(lines).toHaveLength(2000);
  expect(lines[1999]).toBe("2000\tl1999");

  const big = path.join(folder, "big.txt");
  writeFileSync(big, `${"x".repeat(100)}\n`.repeat(4000));
  const whole = await call("Read", { file_path: big });
  expect(whole.isError).toBe(true);
  expect(textOf(whole)).toStartWith(
    "File content (394.5KB) exceeds maximum allowed size (256KB). Use offset and limit",
  );
  expect(textOf(await call("Read", { file_path: big, offset: 3999, limit: 1 }))).toStartWith("3999\txxx");
  const wide = path.join(folder, "wide.txt");
  writeFileSync(wide, `${"y".repeat(DELEGATED_RESULT_TOKENS * 4 + 10)}\n`);
  expect(textOf(await call("Read", { file_path: wide }))).toContain("exceeds maximum allowed tokens (12000)");
});

test("Read says what's wrong with a path", async () => {
  const { call, folder } = setup();
  const missing = textOf(await call("Read", { file_path: path.join(folder, "no.txt") }));
  expect(missing).toBe(`File does not exist. Note: your current working directory is ${folder}.`);
  expect(textOf(await call("Read", { file_path: folder }))).toStartWith("EISDIR");
  writeFileSync(path.join(folder, "a.bin"), Buffer.from([1, 0, 2]));
  expect(textOf(await call("Read", { file_path: path.join(folder, "a.bin") }))).toStartWith(
    "This tool cannot read binary files. The file appears to be a binary bin file.",
  );
  expect(textOf(await call("Read", {}))).toBe("file_path is required");
});

test("Read returns an image as an image, never redacted", async () => {
  const { call, folder } = setup({}, { secrets: async () => SECRETS });
  const bytes = Buffer.from(`\x89PNG${HIDDEN}`, "latin1");
  writeFileSync(path.join(folder, "a.PNG"), bytes);
  expect(await call("Read", { file_path: path.join(folder, "a.PNG") })).toEqual({
    content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }],
    isError: false,
  });
});

test("Read turns a PDF's pages into images", async () => {
  const bin = temp("bin-");
  const tool = path.join(bin, "pdftoppm");
  // Called as: pdftoppm -png -r 100 -f <first> -l <last> <file> <prefix>
  writeFileSync(
    tool,
    `#!/bin/sh\necho "$5 $7" > "$(dirname "$0")/args"\nprintf one > "$9-1.png"\nprintf two > "$9-2.png"\n`,
  );
  chmodSync(tool, 0o755);
  const { call, folder } = setup({}, { pdftoppm: tool });
  const file = path.join(folder, "a.pdf");
  writeFileSync(file, "%PDF-1.7");
  const out = await call("Read", { file_path: file, pages: "2-3" });
  expect(out.content.slice(1)).toEqual([
    { type: "image", data: Buffer.from("one").toString("base64"), mimeType: "image/png" },
    { type: "image", data: Buffer.from("two").toString("base64"), mimeType: "image/png" },
  ]);
  expect(textOf(out)).toBe(`PDF pages extracted: 2 page(s) from ${file} (8 bytes).`);
  expect(readFileSync(path.join(bin, "args"), "utf8").trim()).toBe("2 3");
  expect(textOf(await call("Read", { file_path: file, pages: "x" }))).toStartWith("Invalid pages parameter");
  expect(textOf(await call("Read", { file_path: file, pages: "1-21" }))).toStartWith("Too many pages");
});

test("a computer without pdftoppm says so", async () => {
  const { call, folder } = setup({}, { pdftoppm: "/nowhere/pdftoppm" });
  writeFileSync(path.join(folder, "a.pdf"), "%PDF-1.7");
  expect(textOf(await call("Read", { file_path: path.join(folder, "a.pdf") }))).toStartWith("pdftoppm is not on");
});

test("Read renders a notebook's cells and outputs, images as images", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.ipynb");
  const book = {
    metadata: { language_info: { name: "python" } },
    cells: [
      { id: "m1", cell_type: "markdown", source: ["# Title\n", "text"] },
      {
        id: "c1",
        cell_type: "code",
        source: "print(1)",
        outputs: [
          { output_type: "stream", text: ["1\n"] },
          { output_type: "display_data", data: { "text/plain": "<Figure>", "image/png": "aW1n\n" } },
          { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["line"] },
        ],
      },
    ],
  };
  writeFileSync(file, JSON.stringify(book));
  const out = await call("Read", { file_path: file });
  expect(out.content).toEqual([
    {
      type: "text",
      text: `<cell id="m1"><cell_type>markdown</cell_type># Title\ntext</cell id="m1">\n<cell id="c1">print(1)</cell id="c1">\n1\n\n<Figure>`,
    },
    { type: "image", data: "aW1n", mimeType: "image/png" },
    { type: "text", text: "ValueError: bad\nline" },
  ]);
  writeFileSync(file, "{");
  expect((await call("Read", { file_path: file })).isError).toBe(true);
});

test("Read refuses secrets by name, through a link, in the browser's folder and in the agent's secret files", async () => {
  const files = ["keys/ada.pem"];
  const { call, folder, asked } = setup({}, { secrets: async () => ({ ...SECRETS, files }) });
  writeFileSync(path.join(folder, ".env"), "ADA=1\n");
  symlinkSync(path.join(folder, ".env"), path.join(folder, "plain.txt"));
  mkdirSync(path.join(folder, ".agentes", "browser"), { recursive: true });
  writeFileSync(path.join(folder, ".agentes", "browser", "Cookies"), "c\n");
  mkdirSync(path.join(folder, "keys"));
  writeFileSync(path.join(folder, "keys", "ada.pem"), "k\n");
  for (const file of [".env", "plain.txt", ".agentes/browser/Cookies", "keys/ada.pem"]) {
    const out = await call("Read", { file_path: path.join(folder, file) });
    expect(out.isError).toBe(true);
    expect(textOf(out)).not.toContain("1\t");
  }
  expect(asked).toEqual([]);
});

test("Read shows a file a command wrote a secret into, redacted", async () => {
  const { call, folder } = setup({}, { secrets: async () => SECRETS });
  writeFileSync(path.join(folder, "dump.txt"), `ADA_TOKEN=${HIDDEN}\n`);
  expect(textOf(await call("Read", { file_path: path.join(folder, "dump.txt") }))).toBe("1\tADA_TOKEN=[secret]");
});

// ── Edit and Write ───────────────────────────────────────────────────────────

const stale = (file: string) => utimesSync(file, new Date(), new Date(Date.now() + 5000));

test("Edit wants the file read, and read since it last changed", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.txt");
  writeFileSync(file, "one\n");
  const edit = { file_path: file, old_string: "one", new_string: "two" };
  expect(textOf(await call("Edit", edit))).toBe("File has not been read yet. Read it first before writing to it.");
  await call("Read", { file_path: file });
  stale(file);
  expect(textOf(await call("Edit", edit))).toStartWith("File has been modified since read");
  expect(readFileSync(file, "utf8")).toBe("one\n");
  await call("Read", { file_path: file });
  expect(textOf(await call("Edit", edit))).toBe(`The file ${file} has been updated successfully.`);
  expect(readFileSync(file, "utf8")).toBe("two\n");
  // Its own write counts as read.
  const again = await call("Edit", { file_path: file, old_string: "two", new_string: "three" });
  expect(again.isError).toBe(false);
});

test.if(process.platform !== "win32")("Edit on a named pipe answers at once, and never opens it", async () => {
  const { call, folder, state } = setup();
  state.answer = allow;
  const pipe = path.join(folder, "pipe");
  execFileSync("mkfifo", [pipe]);
  for (const old of ["a", ""]) {
    const out = await call("Edit", { file_path: pipe, old_string: old, new_string: "b" });
    expect(out).toMatchObject({ isError: true });
    expect(textOf(out)).toBe(`${pipe} is not a regular file.`);
  }
});

test("Edit needs one match unless told otherwise, and takes the new text as it is", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.txt");
  writeFileSync(file, "a a\n");
  await call("Read", { file_path: file });
  const missing = textOf(await call("Edit", { file_path: file, old_string: "z", new_string: "y" }));
  expect(missing).toBe("String to replace not found in file.\nString: z");
  const many = textOf(await call("Edit", { file_path: file, old_string: "a", new_string: "b" }));
  expect(many).toStartWith("Found 2 matches of the string to replace, but replace_all is false.");
  const all = await call("Edit", { file_path: file, old_string: "a", new_string: "$&", replace_all: true });
  expect(textOf(all)).toBe(`The file ${file} has been updated. All occurrences were successfully replaced.`);
  expect(readFileSync(file, "utf8")).toBe("$& $&\n");
  await call("Edit", { file_path: file, old_string: "$& $&", new_string: "$'x" });
  expect(readFileSync(file, "utf8")).toBe("$'x\n");
  const same = await call("Edit", { file_path: file, old_string: "q", new_string: "q" });
  expect(textOf(same)).toBe("No changes to make: old_string and new_string are exactly the same.");
});

test("Edit with nothing to replace makes a new file, never over one with content", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "deep", "new.txt");
  const made = await call("Edit", { file_path: file, old_string: "", new_string: "hi\n" });
  expect(made.isError).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("hi\n");
  const over = await call("Edit", { file_path: file, old_string: "", new_string: "x" });
  expect(textOf(over)).toBe("Cannot create new file - file already exists.");
  const gone = await call("Edit", { file_path: `${file}.no`, old_string: "a", new_string: "b" });
  expect(textOf(gone)).toStartWith("File does not exist.");
});

test("Edit keeps the file's line ends", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.txt");
  writeFileSync(file, "one\r\ntwo\r\n");
  await call("Read", { file_path: file });
  await call("Edit", { file_path: file, old_string: "one\ntwo", new_string: "one\nmid\ntwo" });
  expect(readFileSync(file, "utf8")).toBe("one\r\nmid\r\ntwo\r\n");
});

test("Edit matches the file's curly quotes and keeps them in the new text", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.txt");
  writeFileSync(file, "say “hello” and don’t\n");
  await call("Read", { file_path: file });
  const out = await call("Edit", {
    file_path: file,
    old_string: `say "hello" and don't`,
    new_string: `say "bye" and won't`,
  });
  expect(out.isError).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("say “bye” and won’t\n");
});

test("Edit leaves notebooks to Write and Bash", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.ipynb");
  writeFileSync(file, JSON.stringify({ cells: [] }));
  const out = await call("Edit", { file_path: file, old_string: "cells", new_string: "x" });
  expect(textOf(out)).toStartWith("File is a Jupyter Notebook.");
});

test("Write makes a file, and replaces one only after reading all of it", async () => {
  const { call, folder, state } = setup();
  state.answer = allow;
  const file = path.join(folder, "sub", "a.txt");
  expect(textOf(await call("Write", { file_path: file, content: "one\ntwo\n" }))).toBe(
    `File created successfully at: ${file}`,
  );
  await call("Bash", { command: `printf 'one\\ntwo\\n' > sub/b.txt` });
  const other = path.join(folder, "sub", "b.txt");
  expect(textOf(await call("Write", { file_path: other, content: "x" }))).toStartWith("File has not been read yet");
  await call("Read", { file_path: other, limit: 1 });
  expect(textOf(await call("Write", { file_path: other, content: "x" }))).toStartWith("You read only part");
  await call("Read", { file_path: other });
  stale(other);
  expect(textOf(await call("Write", { file_path: other, content: "x" }))).toStartWith("File has been modified");
  await call("Read", { file_path: other });
  expect(textOf(await call("Write", { file_path: other, content: "x" }))).toBe(
    `The file ${other} has been updated successfully.`,
  );
  expect(readFileSync(other, "utf8")).toBe("x");
  expect(textOf(await call("Write", { file_path: folder, content: "x" }))).toStartWith("EISDIR");
});

test("an Edit keeps a file marked as partly read, so a Write can't wipe what was never seen", async () => {
  const { call, folder } = setup();
  const file = path.join(folder, "a.txt");
  writeFileSync(file, `${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}\n`);
  await call("Read", { file_path: file, offset: 10, limit: 2 });
  await call("Edit", { file_path: file, old_string: "line 9\n", new_string: "line nine\n" });
  expect(textOf(await call("Write", { file_path: file, content: "only this" }))).toStartWith("You read only part");
  expect(readFileSync(file, "utf8")).toContain("line 49");
  await call("Read", { file_path: file });
  expect((await call("Write", { file_path: file, content: "only this" })).isError).toBe(false);
});

test("edits inside the turn's folders need nobody; outside them a person decides; a repository's git dir is never written", async () => {
  const granted = temp("granted-");
  const { call, asked, state, folder } = setup({ grants: [granted] });
  expect((await call("Write", { file_path: path.join(granted, "a.txt"), content: "x" })).isError).toBe(false);
  expect(asked).toEqual([]);
  const out = temp("elsewhere-");
  const file = path.join(out, "a.txt");
  expect(textOf(await call("Write", { file_path: file, content: "x" }))).toBe("Lia said no.");
  expect(existsSync(file)).toBe(false);
  expect(asked[0]?.args).toMatchObject({ tool_name: "Write" });
  state.answer = allow;
  expect((await call("Write", { file_path: file, content: "x" })).isError).toBe(false);
  const hook = path.join(folder, ".git", "hooks", "pre-commit");
  expect(textOf(await call("Write", { file_path: hook, content: "x" }))).toContain("inside a .git folder");
  symlinkSync(path.join(folder, ".git"), path.join(folder, "plain"));
  mkdirSync(path.join(folder, ".git"));
  const through = await call("Write", { file_path: path.join(folder, "plain", "config"), content: "x" });
  expect(textOf(through)).toContain("inside a .git folder");
  expect(existsSync(hook)).toBe(false);
});

test("a link out of the folders is judged by where it leads", async () => {
  const { call, asked, folder } = setup();
  const out = temp("elsewhere-");
  writeFileSync(path.join(out, "a.txt"), "x\n");
  symlinkSync(path.join(out, "a.txt"), path.join(folder, "link.txt"));
  await call("Read", { file_path: path.join(folder, "link.txt") });
  expect((await call("Write", { file_path: path.join(folder, "link.txt"), content: "y" })).isError).toBe(true);
  expect(asked).toHaveLength(1);
  expect(readFileSync(path.join(out, "a.txt"), "utf8")).toBe("x\n");
});

test("a link to nothing is judged by where it leads too: writing would create that", async () => {
  const { call, asked, folder } = setup();
  mkdirSync(path.join(folder, ".git", "hooks"), { recursive: true });
  const hook = path.join(folder, ".git", "hooks", "post-commit");
  symlinkSync(".git/hooks/post-commit", path.join(folder, "notes.md"));
  const write = await call("Write", { file_path: path.join(folder, "notes.md"), content: "x" });
  expect(textOf(write)).toContain("inside a .git folder");
  const edit = await call("Edit", { file_path: path.join(folder, "notes.md"), old_string: "", new_string: "x" });
  expect(textOf(edit)).toContain("inside a .git folder");
  expect(existsSync(hook)).toBe(false);

  const missing = path.join(temp("elsewhere-"), "a.txt");
  symlinkSync(missing, path.join(folder, "out.md"));
  expect(textOf(await call("Write", { file_path: path.join(folder, "out.md"), content: "x" }))).toBe("Lia said no.");
  expect(asked).toHaveLength(1);
  expect(existsSync(missing)).toBe(false);

  // Through a folder link, `..` leaves from where the link leads.
  const out = temp("elsewhere-");
  mkdirSync(path.join(out, "in"));
  symlinkSync(path.join(out, "in"), path.join(folder, "there"));
  symlinkSync("there/../gone.txt", path.join(folder, "up.md"));
  expect(textOf(await call("Write", { file_path: path.join(folder, "up.md"), content: "x" }))).toBe("Lia said no.");
  expect(asked).toHaveLength(2);
  expect(existsSync(path.join(out, "gone.txt"))).toBe(false);

  symlinkSync("loop-b", path.join(folder, "loop-a"));
  symlinkSync("loop-a", path.join(folder, "loop-b"));
  const loop = await call("Write", { file_path: path.join(folder, "loop-a"), content: "x" });
  expect(textOf(loop)).toContain("Too many links");
});

// ── Glob and Grep ────────────────────────────────────────────────────────────

/** A ripgrep that notes its arguments and prints `out` (exit `code`). */
function fakeRg(out: string, code = 0) {
  const dir = temp("rg-");
  const file = path.join(dir, "rg");
  writeFileSync(path.join(dir, "out"), out);
  writeFileSync(
    file,
    `#!/bin/sh\npwd -P > "${dir}/cwd"\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/args"\ncat "${dir}/out"\n[ ${code} = 2 ] && echo boom >&2\nexit ${code}\n`,
  );
  chmodSync(file, 0o755);
  return {
    rg: [file],
    args: () => readFileSync(path.join(dir, "args"), "utf8").trim().split("\n"),
    cwd: () => readFileSync(path.join(dir, "cwd"), "utf8").trim(),
  };
}

test("Glob lists files by the path from the shell's folder, and says when it stops", async () => {
  const fake = fakeRg("./src/a.ts\n./b.ts\n");
  const { call, folder } = setup({}, { rg: fake.rg });
  expect(textOf(await call("Glob", { pattern: "**/*.ts" }))).toBe("src/a.ts\nb.ts");
  expect(fake.args().slice(0, 6)).toEqual([
    "--files",
    "--hidden",
    "--no-ignore",
    "--sort=modified",
    "--glob",
    "**/*.ts",
  ]);
  expect(fake.args()).toContain("!.git/");
  mkdirSync(path.join(folder, "src"));
  expect(textOf(await call("Glob", { pattern: "*.ts", path: "src" }))).toBe("src/src/a.ts\nsrc/b.ts");
  expect(textOf(await call("Glob", { pattern: path.join(folder, "src", "*.ts") }))).toBe("src/src/a.ts\nsrc/b.ts");
  expect(fake.args()).toContain("*.ts");
  expect(textOf(await call("Glob", { pattern: "*", path: "no" }))).toBe(`Directory does not exist: ${folder}/no`);
  writeFileSync(path.join(folder, "f"), "");
  expect(textOf(await call("Glob", { pattern: "*", path: "f" }))).toBe(`Path is not a directory: ${folder}/f`);
});

test("Glob stops at a hundred files, and finds none with an empty answer", async () => {
  const many = fakeRg(Array.from({ length: 120 }, (_, i) => `./f${i}`).join("\n"));
  const { call } = setup({}, { rg: many.rg });
  const lines = textOf(await call("Glob", { pattern: "*" })).split("\n");
  expect(lines).toHaveLength(101);
  expect(lines[100]).toBe("(Results are truncated. Consider using a more specific path or pattern.)");
  const none = setup({}, { rg: fakeRg("", 1).rg });
  expect(textOf(await none.call("Glob", { pattern: "*" }))).toBe("No files found");
});

test("no rg on the PATH: the CLI's own, with a shared bin folder too, where a missing command still resolves to a path", async () => {
  const bin = tempDir("rg-in-claude-");
  dirs.push(bin);
  writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n");
  chmodSync(path.join(bin, "claude"), 0o755);
  const { PATH, AGENTES_SHARED_BIN } = process.env;
  process.env.PATH = bin;
  process.env.AGENTES_SHARED_BIN = "/home/ag-test/shared/bin";
  try {
    const { call } = setup();
    expect(textOf(await call("Glob", { pattern: "*.ts" }))).not.toContain("ripgrep is not on this computer");
  } finally {
    process.env.PATH = PATH;
    if (AGENTES_SHARED_BIN === undefined) delete process.env.AGENTES_SHARED_BIN;
    else process.env.AGENTES_SHARED_BIN = AGENTES_SHARED_BIN;
  }
});

test("Grep lists files, the newest first, the secrets' files out of the search, whatever the caller's glob", async () => {
  const fake = fakeRg("./old.ts\n./new.ts\n");
  const { call, folder } = setup({}, { rg: fake.rg, secrets: async () => ({ ...SECRETS, files: ["keys/ada.pem"] }) });
  writeFileSync(path.join(folder, "old.ts"), "");
  writeFileSync(path.join(folder, "new.ts"), "");
  utimesSync(path.join(folder, "old.ts"), new Date(1000), new Date(1000));
  expect(textOf(await call("Grep", { pattern: "-x", glob: "*.{ts,tsx} *.md" }))).toBe("Found 2 files\nnew.ts\nold.ts");
  const args = fake.args();
  expect(args).toContain("-l");
  expect(args.slice(-4)).toEqual(["-e", "-x", "--", "."]);
  const at = (word: string) => args.indexOf(word);
  expect(args[at("*.{ts,tsx}") - 1]).toBe("--glob");
  expect(at("!**/.env")).toBeGreaterThan(at("*.md"));
  expect(args).toContain("!**/.agentes/browser/**");
  expect(args).toContain("!keys/ada.pem");
  expect(args).toContain("!.git/");
});

test("Grep shows matching lines with Claude Code's options, redacted and paged", async () => {
  const fake = fakeRg(`./a.ts:1:one\n./a.ts:2:${HIDDEN}\n./b.ts:9:three\n`);
  const { call, folder } = setup({}, { rg: fake.rg, secrets: async () => SECRETS });
  const out = textOf(
    await call("Grep", {
      pattern: "x",
      output_mode: "content",
      "-i": true,
      "-C": 2,
      multiline: true,
      type: "ts",
      head_limit: 1,
      offset: 1,
      path: folder,
    }),
  );
  expect(out).toBe("a.ts:2:[secret]\n\n[Showing results with pagination = limit: 1, offset: 1]");
  const args = fake.args();
  for (const word of ["-U", "--multiline-dotall", "-i", "-n", "-H", "--type", "ts"]) expect(args).toContain(word);
  expect(args[args.indexOf("-C") + 1]).toBe("2");
  expect(args).toContain("--max-columns");
  await call("Grep", { pattern: "x", output_mode: "content", "-n": false, "-A": 1, "-B": 2 });
  expect(fake.args()).not.toContain("-n");
  expect(fake.args()[fake.args().indexOf("-A") + 1]).toBe("1");
  expect(fake.args()[fake.args().indexOf("-B") + 1]).toBe("2");
  const none = textOf(await call("Grep", { pattern: "x", output_mode: "content", offset: 10 }));
  expect(none).toBe("No entries at this offset");
});

test("Grep counts, and reads no match and a failure apart", async () => {
  const fake = fakeRg("./a.ts:2\n./b.ts:1\n");
  const { call } = setup({}, { rg: fake.rg });
  expect(textOf(await call("Grep", { pattern: "x", output_mode: "count" }))).toBe(
    "a.ts:2\nb.ts:1\n\nFound 3 total occurrences across 2 files.",
  );
  expect(fake.args()).toContain("-c");
  const none = setup({}, { rg: fakeRg("", 1).rg });
  expect(textOf(await none.call("Grep", { pattern: "x" }))).toBe("No files found");
  expect(textOf(await none.call("Grep", { pattern: "x", output_mode: "content" }))).toBe("No matches found");
  expect(textOf(await none.call("Grep", { pattern: "x", output_mode: "count" }))).toBe("No matches found");
  const broken = setup({}, { rg: fakeRg("", 2).rg });
  const out = await broken.call("Grep", { pattern: "(" });
  expect(out).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
  expect(textOf(await none.call("Grep", { pattern: "x", path: "no" }))).toStartWith("Path does not exist");
});

test("a path rg couldn't read costs the search only that path; alone it is still a failure", async () => {
  const some = fakeRg("./a.txt:1:needle\n", 2);
  const { call } = setup({}, { rg: some.rg });
  const out = await call("Grep", { pattern: "needle", output_mode: "content" });
  expect(out).toMatchObject({ isError: false });
  expect(textOf(out)).toBe("a.txt:1:needle");
  const files = setup({}, { rg: fakeRg("./a.txt\n", 2).rg });
  expect(textOf(await files.call("Glob", { pattern: "*" }))).toBe("a.txt");
  const none = setup({}, { rg: fakeRg("", 2).rg });
  expect(await none.call("Glob", { pattern: "*" })).toMatchObject({ isError: true });
  const late = setup({}, { rg: fakeRg("./a.txt\n", 124).rg });
  expect(await late.call("Grep", { pattern: "x" })).toMatchObject({ isError: true });
});

test("Grep refuses what Read refuses: a file named outright or through a link", async () => {
  const fake = fakeRg("");
  const secrets = async () => ({ ...SECRETS, files: ["repos/x/conf/sa.json"] });
  const { call, folder } = setup({}, { rg: fake.rg, secrets });
  mkdirSync(path.join(folder, "repos", "x", "conf"), { recursive: true });
  writeFileSync(path.join(folder, "repos", "x", "conf", "sa.json"), "{}");
  writeFileSync(path.join(folder, "server.pem"), "x");
  symlinkSync("server.pem", path.join(folder, "notes.txt"));
  symlinkSync("repos/x/conf/sa.json", path.join(folder, "sa-link"));
  mkdirSync(path.join(folder, ".agentes", "browser"), { recursive: true });
  writeFileSync(path.join(folder, ".agentes", "browser", "Cookies"), "x");
  for (const given of ["repos/x/conf/sa.json", "notes.txt", "sa-link", ".agentes/browser/Cookies"]) {
    expect(await call("Grep", { pattern: "x", path: given })).toMatchObject({ isError: true });
  }
  expect(() => fake.args()).toThrow();
});

test("Grep leaves an agent's secret files out wherever the shell's folder is", async () => {
  const fake = fakeRg("");
  const secrets = async () => ({ ...SECRETS, files: ["repos/x/conf/sa.json", "keys/ada.pem"] });
  const parts = temp("delegated-");
  const inner = path.join(parts, "repos", "x");
  mkdirSync(path.join(inner, "conf"), { recursive: true });
  const { call } = setup({ folder: parts, cwd: inner }, { rg: fake.rg, secrets });
  await call("Grep", { pattern: "x" });
  expect(fake.args()).toContain("!conf/sa.json");
  expect(fake.args().join(" ")).not.toContain("ada.pem");

  // Above the shell's folder rg runs from the target, and the paths it prints come back whole.
  const up = fakeRg("./keys/a.txt:1:x\n--\n./repos/b.txt:2:x\n");
  const above = setup({ folder: parts, cwd: inner }, { rg: up.rg, secrets });
  const out = await above.call("Grep", { pattern: "x", path: parts, output_mode: "content" });
  expect(up.cwd()).toBe(realpathSync(parts));
  expect(up.args().slice(-2)).toEqual(["--", "."]);
  expect(up.args()).toContain("!repos/x/conf/sa.json");
  expect(up.args()).toContain("!keys/ada.pem");
  const root = realpathSync(parts);
  expect(textOf(out)).toBe(`${root}/keys/a.txt:1:x\n--\n${root}/repos/b.txt:2:x`);

  // A folder reached through a link is searched at its real path, where the same globs hold.
  const linked = fakeRg("");
  const link = setup({ folder: parts, cwd: parts }, { rg: linked.rg, secrets });
  symlinkSync("repos/x/conf", path.join(parts, "linkdir"));
  await link.call("Grep", { pattern: "x", path: "linkdir" });
  expect(linked.args().slice(-2)).toEqual(["--", "repos/x/conf"]);
  expect(linked.args()).toContain("!repos/x/conf/sa.json");
});

test("a head_limit of zero means no limit, and a computer without ripgrep says what to use", async () => {
  const many = fakeRg(Array.from({ length: 300 }, (_, i) => `./a:${i}:x`).join("\n"));
  const { call } = setup({}, { rg: many.rg });
  expect(textOf(await call("Grep", { pattern: "x", output_mode: "content" })).split("\n")).toHaveLength(252);
  const all = textOf(await call("Grep", { pattern: "x", output_mode: "content", head_limit: 0 }));
  expect(all.split("\n")).toHaveLength(300);
  const missing = setup({}, { rg: ["/nowhere/rg"] });
  expect(textOf(await missing.call("Grep", { pattern: "x" }))).toStartWith("ripgrep is not on this computer");
  expect(textOf(await missing.call("Glob", { pattern: "x" }))).toStartWith("ripgrep is not on this computer");
});

test("without rg on the PATH, the one inside the claude binary does the searching", async () => {
  const bin = temp("bin-");
  writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "./seen:$1"\n`);
  chmodSync(path.join(bin, "claude"), 0o755);
  const before = process.env.PATH;
  process.env.PATH = bin;
  closers.push(() => {
    process.env.PATH = before;
  });
  const { call } = setup();
  expect(textOf(await call("Glob", { pattern: "*" }))).toBe("seen:--files");
});

test("searching a secret by name is refused before ripgrep runs", async () => {
  const fake = fakeRg("");
  const { call } = setup({}, { rg: fake.rg });
  expect((await call("Grep", { pattern: "x", path: "~/.ssh" })).isError).toBe(true);
  expect((await call("Glob", { pattern: "~/.aws/*" })).isError).toBe(true);
  expect(() => fake.args()).toThrow();
});

// ── Sessions ─────────────────────────────────────────────────────────────────

test("a restarted CLI on the same session keeps the cwd, what was read and its shells", async () => {
  const { call, tools, scope, ask, state, folder } = setup();
  state.answer = allow;
  mkdirSync(path.join(folder, "app"));
  const file = path.join(folder, "a.txt");
  writeFileSync(file, "one\n");
  await call("Read", { file_path: file });
  await call("Bash", { command: "cd app" });
  const id = idIn(textOf(await call("Bash", { command: "sleep 30", run_in_background: true })));
  const next = tools.surface(scope);
  const again = (name: string, args: Record<string, unknown>) => next.call(name, args, { id: "x", ask });
  expect(textOf(await again("Bash", { command: "pwd" }))).toBe(path.join(folder, "app"));
  expect((await again("Edit", { file_path: file, old_string: "one", new_string: "two" })).isError).toBe(false);
  expect((await again("TaskStop", { task_id: id })).isError).toBe(false);
  // Started somewhere else: the turn's cwd wins.
  const other = tools.surface({ ...scope, cwd: path.join(folder, "app") });
  await other.call("Bash", { command: "cd .." }, { id: "y", ask });
  const moved = tools.surface({ ...scope, cwd: folder });
  expect(textOf(await moved.call("Bash", { command: "pwd" }, { id: "z", ask }))).toBe(folder);
});

test("sessions past the limit go, oldest idle first, and never one with a shell running", async () => {
  const { tools, scope, call, ask, state } = setup();
  state.answer = allow;
  const id = idIn(textOf(await call("Bash", { command: "sleep 30", run_in_background: true })));
  for (let i = 0; i < 70; i++) tools.surface({ ...scope, session: `other-${i}` });
  const first = tools.surface(scope);
  expect((await first.call("TaskStop", { task_id: id }, { id: 1, ask })).isError).toBe(false);
});

test("unknown tools and arguments of the wrong type are errors, not crashes", async () => {
  const { call } = setup();
  expect(textOf(await call("toString", {}))).toBe("Unknown tool: toString");
  expect(textOf(await call("Write", { file_path: 3, content: "x" }))).toBe("file_path is required");
  expect(textOf(await call("Edit", { file_path: "/a", old_string: 1 }))).toBe("old_string is required");
});

// ── On the bridge ────────────────────────────────────────────────────────────

const rpc = (method: string, params: unknown = {}, id: number | null = 1) => ({
  jsonrpc: "2.0",
  ...(id === null ? {} : { id }),
  method,
  params,
});
const serverTools = async () => [{ name: "post_message", description: "Post", inputSchema: { type: "object" } }];
const toolNames = (res: Record<string, unknown> | null) =>
  (res?.result as { tools: { name: string }[] } | undefined)?.tools.map((t) => t.name) ?? [];

test("only a delegated session lists these tools; every other MCP process stays as it is", async () => {
  const relayed: string[] = [];
  const server: ToolCaller = async (tool) => {
    relayed.push(tool);
    return { ok: true, text: "from the server" };
  };
  const plain = await handleMcpMessage(rpc("tools/list"), server, undefined, serverTools);
  expect(toolNames(plain)).toEqual(["post_message"]);
  // A name the bridge doesn't list goes to the server, which says no: nothing runs here.
  const called = await handleMcpMessage(
    rpc("tools/call", { name: "Bash", arguments: { command: "touch x" } }),
    server,
    undefined,
    serverTools,
  );
  expect(relayed).toEqual(["Bash"]);
  expect(called?.result).toEqual({ content: [{ type: "text", text: "from the server" }], isError: false });

  const { surface } = setup();
  const context = { delegated: surface };
  const listedThere = await handleMcpMessage(rpc("tools/list"), server, undefined, serverTools, "work", context);
  expect(toolNames(listedThere)).toEqual([...DELEGATED_TOOLS.map((t) => t.name), "post_message"]);
});

test("a delegated call runs here, a server tool still goes to the server, and a cancel reaches the call", async () => {
  const relayed: string[] = [];
  const server: ToolCaller = async (tool) => {
    if (tool === PERMISSION_TOOL) return allow;
    relayed.push(tool);
    return { ok: true, text: "posted" };
  };
  const { surface } = setup();
  const context = { delegated: surface };
  const message = (m: unknown) => handleMcpMessage(m, server, undefined, serverTools, "work", context);
  const here = await message(rpc("tools/call", { name: "Bash", arguments: { command: "echo here" } }));
  expect(here).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "here" }], isError: false },
  });
  expect(relayed).toEqual([]);
  const there = await message(rpc("tools/call", { name: "post_message", arguments: {} }));
  expect(there?.result).toEqual({ content: [{ type: "text", text: "posted" }], isError: false });
  expect(relayed).toEqual(["post_message"]);

  const running = message(rpc("tools/call", { name: "Bash", arguments: { command: "pwd; cat" } }, 9));
  const slow = message(rpc("tools/call", { name: "Bash", arguments: { command: "sleep 30" } }, 10));
  await Bun.sleep(100);
  expect(await message(rpc("notifications/cancelled", { requestId: 10 }, null))).toBeNull();
  const cut = (await slow)?.result as McpToolResult;
  expect(textOf(cut)).toBe("Command was aborted before completion");
  expect((await running)?.id).toBe(9);
});

test("a cancel without a delegated session stays a notification nobody answers", async () => {
  const none: ToolCaller = async () => ({ ok: true, text: "" });
  expect(await handleMcpMessage(rpc("notifications/cancelled", { requestId: 1 }, null), none)).toBeNull();
});

test("the CLI's MCP config names the relay only for a delegated CLI", () => {
  const config = (relay?: boolean) =>
    claudeMcpConfig({
      command: ["agentes-runner"],
      taskId: "p1",
      socketPath: "/s",
      token: "t",
      ...(relay ? { relay } : {}),
    }).mcpServers.agentes.args;
  expect(config()).toEqual(["mcp", "--task", "p1"]);
  expect(config(true)).toEqual(["mcp", "--relay", "--task", "p1"]);
});

function bridgeOn(task: (id: string) => McpTaskInfo | null) {
  const socketPath = path.join(temp("sock-"), "mcp.sock");
  const bridge = new McpBridge({ socketPath, task });
  closers.push(() => bridge.close());
  return bridge;
}

/** A relay to `socketPath`: lines in, lines out, as the CLI sees it. */
function relayTo(socketPath: string, taskId: string, token: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen: Record<string, unknown>[] = [];
  let buf = "";
  output.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      seen.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  const done = runMcpRelay({ socketPath, taskId, token, input, output });
  const send = (message: unknown) => input.write(`${JSON.stringify(message)}\n`);
  return { input, seen, done, send };
}

const task = (over: Partial<McpTaskInfo>): McpTaskInfo => ({
  token: "bridge-token",
  missionId: "",
  running: true,
  runId: "run-1",
  ...over,
});

test("the relay moves bytes: MCP runs in the worker, tools and all", async () => {
  const { surface, folder, state } = setup();
  state.answer = allow;
  const bridge = bridgeOn((id) => (id === "proc-0001" ? task({ delegated: surface }) : null));
  await bridge.listen();
  const relay = relayTo(bridge.socketPath, "proc-0001", "bridge-token");
  relay.send(rpc("initialize", { protocolVersion: "2025-06-18" }, 1));
  relay.send(rpc("tools/list", {}, 2));
  relay.send(rpc("tools/call", { name: "Bash", arguments: { command: "pwd" } }, 3));
  await waitFor(() => relay.seen.length === 3);
  const byId = (id: number) => relay.seen.find((m) => m.id === id);
  expect(byId(1)?.result).toMatchObject({ serverInfo: { name: "agentes" } });
  expect(toolNames(byId(2) as Record<string, unknown>)).toContain("Grep");
  expect(byId(3)?.result).toEqual({ content: [{ type: "text", text: folder }], isError: false });
  relay.input.end();
  expect(await relay.done).toBe(0);
});

test("a gated call asks through the bridge, for the turn the bridge knows", async () => {
  const { surface } = setup();
  const bridge = bridgeOn(() => task({ delegated: surface }));
  const frames: Record<string, unknown>[] = [];
  bridge.attach((f) => frames.push(f as never));
  await bridge.listen();
  const relay = relayTo(bridge.socketPath, "proc-0001", "bridge-token");
  relay.send(rpc("tools/call", { name: "Bash", arguments: { command: "ada-tool --go" } }, 1));
  await waitFor(() => frames.some((f) => f.tool === PERMISSION_TOOL));
  const frame = frames.find((f) => f.tool === PERMISSION_TOOL) as { callId: string; taskId: string };
  expect(frame.taskId).toBe("run-1");
  bridge.result({
    type: "mcp.result",
    callId: frame.callId,
    ok: true,
    text: JSON.stringify({ behavior: "deny", message: "Not now." }),
  });
  await waitFor(() => relay.seen.length === 1);
  expect(relay.seen[0]?.result).toEqual({ content: [{ type: "text", text: "Not now." }], isError: true });
  relay.input.end();
  await relay.done;
});

test("a relay needs the right token and a delegated task", async () => {
  const { surface } = setup();
  const bridge = bridgeOn((id) =>
    id === "proc-0001" ? task({ delegated: surface }) : id === "proc-0002" ? task({}) : null,
  );
  await bridge.listen();
  for (const [id, token] of [
    ["proc-0001", "wrong-token!"],
    ["proc-0002", "bridge-token"],
    ["proc-0003", "bridge-token"],
  ] as const) {
    const relay = relayTo(bridge.socketPath, id, token);
    relay.send(rpc("tools/list", {}, 1));
    await waitFor(() => relay.seen.length === 1);
    expect(relay.seen[0]).toEqual({ ok: false, error: "Not allowed: this task has no agentes tools." });
    expect(await relay.done).toBe(0);
  }
});

test("the CLI going away ends its calls, and its background shells stay", async () => {
  const { surface, tools, state, folder, notices } = setup();
  state.answer = allow;
  const bridge = bridgeOn(() => task({ delegated: surface }));
  bridge.attach((f) => {
    if (f.type === "mcp.call")
      bridge.result({ type: "mcp.result", callId: f.callId, ok: true, text: allow.ok ? allow.text : "" });
  });
  await bridge.listen();
  const relay = relayTo(bridge.socketPath, "proc-0001", "bridge-token");
  const pidFile = path.join(folder, "pid");
  relay.send(rpc("tools/call", { name: "Bash", arguments: { command: "sleep 30", run_in_background: true } }, 1));
  await waitFor(() => relay.seen.length === 1);
  relay.send(rpc("tools/call", { name: "Bash", arguments: { command: `sleep 30 & echo $! > ${pidFile}; wait` } }, 2));
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const pid = Number(readFileSync(pidFile, "utf8"));
  relay.input.end();
  await relay.done;
  await waitFor(() => !alive(pid));
  expect(notices.map((n) => n.status)).toEqual(["running"]);
  tools.close();
});

test("a relay with nothing listening ends with an error", async () => {
  const code = await runMcpRelay({
    socketPath: path.join(temp("sock-"), "none.sock"),
    taskId: "proc-0001",
    token: "t",
    input: new PassThrough(),
    output: new PassThrough(),
  });
  expect(code).toBe(1);
});

// ── From root ────────────────────────────────────────────────────────────────

const bridgeFrame = {
  type: "bridge.token",
  process: "proc-0001",
  token: "bridge-token",
  agent: AGENT,
  session: "s1",
  cwd: "/home/ag/ada",
  profile: "plan",
  branches: ["agentes/ada/"],
  allow: ["Bash(ada *)", 3],
  runId: "run-1",
  serverToken: "agr_x",
};

test("a bridge frame is read field by field", () => {
  expect(parseBridge(bridgeFrame)).toEqual({
    process: "proc-0001",
    token: "bridge-token",
    agent: AGENT,
    session: "s1",
    cwd: "/home/ag/ada",
    profile: "plan",
    branches: ["agentes/ada/"],
    allow: ["Bash(ada *)"],
    runId: "run-1",
    serverToken: "agr_x",
  });
  expect(parseBridge({ ...bridgeFrame, token: null })?.token).toBeNull();
  expect(parseBridge({ ...bridgeFrame, task: "local" })?.task).toBe("local");
  expect(parseBridge({ ...bridgeFrame, task: "anything" })?.task).toBeUndefined();
  expect(parseBridge({ ...bridgeFrame, profile: "anything" })?.profile).toBe("work");
  for (const bad of [{ process: 1 }, { token: 3 }, { agent: {} }, { session: 2 }, { cwd: "relative" }]) {
    expect(parseBridge({ ...bridgeFrame, ...bad })).toBeNull();
  }
});

test("a bridge entry carries the tools, relays for its run, and rests between turns", () => {
  const { tools, folder } = setup();
  const bridge = { ...(parseBridge(bridgeFrame) as DelegatedBridge), token: "bridge-token", cwd: folder };
  const where = { folder, grants: [], redact: (t: string) => t };
  const running = delegatedTask(bridge, tools, where);
  expect(running).toMatchObject({
    token: "bridge-token",
    running: true,
    runId: "run-1",
    serverToken: "agr_x",
    cwd: folder,
    folder,
  });
  expect(running.delegated?.tools).toBe(PLAN_DELEGATED_TOOLS);
  expect(running.delegated?.profile).toBe("plan");
  expect(running.delegated?.branches).toEqual(["agentes/ada/"]);
  const { runId: _run, serverToken: _token, ...between } = bridge;
  const idle = delegatedTask(between, tools, where);
  expect(idle).toMatchObject({ running: false, idle: true });
  expect(idle.runId).toBeUndefined();
  expect(idle.serverToken).toBeUndefined();
});

test("the worker link hears root's frames and says its own", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const said: string[] = [];
  output.on("data", (chunk: Buffer) => said.push(chunk.toString().trim()));
  const link = new WorkerLink(input, output);
  const heard: unknown[] = [];
  link.onBridge = (b) => heard.push(b.process);
  link.onTurnCancel = (s) => heard.push(`cancel ${s}`);
  link.onTurnDetach = (s) => heard.push(`detach ${s}`);
  const line = (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`);
  line(bridgeFrame);
  line({ ...bridgeFrame, cwd: "not absolute" });
  line({ type: "turn.cancel", session: "s1" });
  line({ type: "turn.cancel", session: 1 });
  line({ type: "turn.detach", session: "s1" });
  await waitFor(() => heard.length === 3);
  expect(heard).toEqual(["proc-0001", "cancel s1", "detach s1"]);
  link.onTaskOut = (taskId, stream, said) => heard.push([taskId, stream, said]);
  link.onTaskExit = (taskId, session, exit) => heard.push([taskId, session, exit]);
  line({ type: "task.out", taskId: 1, line: "x" });
  line({ type: "task.out", taskId: "t1", stream: "stderr", line: "why" });
  line({ type: "task.exit", taskId: "t1", session: "s1", exitCode: 0, signal: null, reason: null });
  await waitFor(() => heard.length === 5);
  expect(heard.slice(3)).toEqual([
    ["t1", "stderr", "why"],
    ["t1", "s1", { exitCode: 0, signal: null, reason: null }],
  ]);
  link.bridgeReady("proc-0001");
  const notice = { session: "s1", shellId: "b1", status: "running" as const, summary: "x", outputFile: "/t" };
  link.toolNotice(notice);
  await waitFor(() => said.length === 2);
  expect(JSON.parse(said[0] as string)).toEqual({ type: "bridge.ready", process: "proc-0001" });
  expect(JSON.parse(said[1] as string)).toEqual({ type: "tool.notice", ...notice });
});

test("a local task's CLI hears its tools are there, though none of the server's are", async () => {
  const { surface, ask } = setup({ task: "local" });
  const answer = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    ask,
    surface.scope,
    async () => [],
    "work",
    { task: true, local: true, delegated: surface },
  );
  expect((answer?.result as { instructions?: string } | undefined)?.instructions).toStartWith("Claude Code's tools");
});

test("in a background task, a refused call says so and is listed; a turn's isn't", async () => {
  const denied: unknown[][] = [];
  const onDenied = (session: string, tool: string, input: Record<string, unknown>) =>
    void denied.push([session, tool, input.command]);
  const task = setup({ task: "local" }, { onDenied });
  expect(task.surface).toMatchObject({ task: true, local: true });
  const refused = await task.call("Bash", { command: "curl -X POST https://example.com/deploy" });
  expect(refused.isError).toBe(true);
  expect(denied).toEqual([["s1", "Bash", "curl -X POST https://example.com/deploy"]]);
  denied.length = 0;
  const mission = setup({ task: "mission" }, { onDenied });
  expect(mission.surface).toMatchObject({ task: true });
  expect(mission.surface.local).toBeUndefined();
  const turn = setup({}, { onDenied });
  await turn.call("Bash", { command: "curl -X POST https://example.com/deploy" });
  expect(denied).toEqual([]);
});

test("in a background task, what the computer refuses itself says who can't approve it, and is listed", async () => {
  const denied: unknown[][] = [];
  const onDenied = (session: string, tool: string, input: Record<string, unknown>) =>
    void denied.push([session, tool, input.command]);
  const task = setup({ task: "mission" }, { onDenied });
  const merge = textOf(await task.call("Bash", { command: "git merge feature" }));
  expect(merge).toContain(ASK_AFTER_TASK);
  expect(merge).not.toContain("run_code");
  expect(denied).toEqual([["s1", "Bash", "git merge feature"]]);
  denied.length = 0;
  const turn = setup({}, { onDenied });
  expect(textOf(await turn.call("Bash", { command: "git merge feature" }))).toContain("run_code");
  expect(denied).toEqual([]);
});
