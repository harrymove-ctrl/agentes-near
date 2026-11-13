import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  BRIDGE_PROTOCOL,
  MCP_ARGS_MAX_CHARS,
  MISSION_MCP_TOOLS,
  MISSION_PROTOCOL,
  MISSION_RULES_NO_GIT,
  PERMISSION_PROMPT_TOOL,
  parseRunnerFrame,
  parseServerFrame,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import {
  ALWAYS_LOADED,
  claudeMcpConfig,
  claudePermissionSettings,
  cleanRules,
  handleMcpMessage,
  ipcCall,
  MCP_CUT_OFF,
  McpBridge,
  type McpTaskInfo,
  McpToolCache,
  missionExecutorArgs,
  missionFolderRules,
  runMcpServer,
} from "../../runner/mcp";
import { agentWorkspace } from "../../runner/paths";
import { TaskManager } from "../../runner/tasks";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const TASK = "0193aaaa-0000-7000-8000-000000000042";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };

test("protocol 5: mcp.call and mcp.result parse; a whole source file fits, oversized arguments are dropped", () => {
  expect(MISSION_PROTOCOL).toBe(5);
  const call = (args: Record<string, unknown>) =>
    parseRunnerFrame(JSON.stringify({ type: "mcp.call", callId: "c1", taskId: TASK, tool: "report", args }));
  expect(call({ summary: "x" })).toEqual({
    type: "mcp.call",
    callId: "c1",
    taskId: TASK,
    tool: "report",
    args: { summary: "x" },
  });
  const file = "export const line = 1;\n".repeat(6600);
  expect(file.length).toBeGreaterThan(150_000);
  expect(call({ content: file })).toMatchObject({ type: "mcp.call", args: { content: file } });
  expect(call({ s: "x".repeat(MCP_ARGS_MAX_CHARS) })).toBeNull();
  expect(parseServerFrame(JSON.stringify({ type: "mcp.result", callId: "c1", ok: true, text: "done" }))).toMatchObject({
    type: "mcp.result",
    ok: true,
  });
  expect(parseServerFrame(JSON.stringify({ type: "mcp.result", ok: true }))).toBeNull();
});

test("MCP JSON-RPC: initialize, notifications, tools/list, tools/call and errors", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    return tool === "report" ? { ok: true as const, text: "Reported." } : { ok: false as const, error: "Nope" };
  };
  const init = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    call,
  );
  expect(init).toMatchObject({
    id: 1,
    result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "agentes" } },
  });
  expect(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, call)).toBeNull();
  const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, call)) as {
    result: { tools: { name: string }[] };
  };
  expect(list.result.tools.map((t) => t.name)).toEqual(MISSION_MCP_TOOLS.map((t) => t.name));
  expect(list.result.tools.map((t) => t.name)).toContain("update_plan");
  expect(
    await handleMcpMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report", arguments: { summary: "hi" } } },
      call,
    ),
  ).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "Reported." }], isError: false } });
  expect(
    await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_context" } }, call),
  ).toMatchObject({ result: { content: [{ text: "Nope" }], isError: true } });
  expect(calls).toEqual([
    ["report", { summary: "hi" }],
    ["get_context", {}],
  ]);
  expect(
    await handleMcpMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf" } }, call),
  ).toMatchObject({ error: { code: -32602 } });
  expect(await handleMcpMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" }, call)).toMatchObject({
    error: { code: -32601 },
  });
  expect(await handleMcpMessage({ id: 7, method: "ping" }, call)).toMatchObject({ error: { code: -32600 } });
  expect(await handleMcpMessage({ jsonrpc: "2.0", id: 8, method: "ping" }, call)).toEqual({
    jsonrpc: "2.0",
    id: 8,
    result: {},
  });
});

function bridge(task: McpTaskInfo | null, socketPath = "unused") {
  const frames: RunnerFrame[] = [];
  const b = new McpBridge({ socketPath, task: (id) => (id === TASK ? task : null), callTimeoutMs: 2000 });
  closers.push(() => b.close());
  return { b, frames };
}

test("the bridge checks the task's token, needs a connection, relays the call and its answer", async () => {
  const { b, frames } = bridge({ token: "secret-token-1", missionId: "m1", running: true });
  const req = { taskId: TASK, token: "secret-token-1", tool: "report", args: { summary: "hi" } };
  expect(await b.handle({ ...req, token: "wrong-token-00" })).toMatchObject({
    ok: false,
    error: expect.stringContaining("Not allowed"),
  });
  expect(await b.handle({ ...req, taskId: "0193aaaa-0000-7000-8000-000000000099" })).toMatchObject({ ok: false });
  expect(await b.handle({ ...req, tool: "rm_rf" })).toMatchObject({ ok: false, error: "Unknown tool rm_rf" });
  b.attach((f) => frames.push(f));
  const pending = b.handle(req);
  await waitFor(() => frames.length === 1);
  const sent = frames[0] as Extract<RunnerFrame, { type: "mcp.call" }>;
  expect(sent).toMatchObject({ type: "mcp.call", taskId: TASK, tool: "report", args: { summary: "hi" } });
  b.result({ type: "mcp.result", callId: sent.callId, ok: true, text: "Reported in the thread." });
  expect(await pending).toEqual({ ok: true, text: "Reported in the thread." });
  // A mission task runs on through a dropped connection: its call in flight goes again under the same
  // callId once the connection is back (the server runs it once and answers the copy).
  const second = b.handle(req);
  await waitFor(() => frames.length === 2);
  b.detach();
  const resent: RunnerFrame[] = [];
  b.attach((f) => resent.push(f), { mcpOnce: true });
  await waitFor(() => resent.length === 1);
  expect(resent[0]).toEqual(frames[1]);
  b.result({ type: "mcp.result", callId: (frames[1] as { callId: string }).callId, ok: true, text: "Reported." });
  expect(await second).toEqual({ ok: true, text: "Reported." });
});

test("a task's call cut by a drop goes again only to a server that runs it once, and says when it may have run", async () => {
  const task: McpTaskInfo = { token: "secret-token-1", missionId: "m1", running: true };
  const req = { taskId: TASK, token: "secret-token-1", tool: "report", args: { summary: "hi" } };
  const { b, frames } = bridge(task);
  b.attach((f) => frames.push(f), { mcpOnce: true });
  // Back on a server that would run it twice (an older one): never sent again.
  const older = b.handle(req);
  await waitFor(() => frames.length === 1);
  b.detach();
  const resent: RunnerFrame[] = [];
  b.attach((f) => resent.push(f));
  expect(await older).toEqual({ ok: false, error: MCP_CUT_OFF });
  // A call made while the link was down was never sent: it goes out as usual.
  b.detach();
  const fresh = b.handle(req);
  await new Promise((r) => setTimeout(r, 20));
  b.attach((f) => resent.push(f));
  await waitFor(() => resent.length === 1);
  b.result({ type: "mcp.result", callId: (resent[0] as { callId: string }).callId, ok: true, text: "posted" });
  expect(await fresh).toEqual({ ok: true, text: "posted" });

  // Sent again, and no answer before its time is up: it may have run, never "try again".
  const quick = new McpBridge({ socketPath: "unused", task: (id) => (id === TASK ? task : null), callTimeoutMs: 80 });
  closers.push(() => quick.close());
  const out: RunnerFrame[] = [];
  quick.attach((f) => out.push(f), { mcpOnce: true });
  const late = quick.handle(req);
  await waitFor(() => out.length === 1);
  quick.detach();
  quick.attach((f) => out.push(f), { mcpOnce: true });
  await waitFor(() => out.length === 2);
  expect(await late).toEqual({ ok: false, error: MCP_CUT_OFF });
});

test("at a drop, a brain turn's calls fail as transient (the turn itself is sent again); its prompt goes again", async () => {
  const { b, frames } = bridge({
    token: "secret-token-1",
    missionId: "",
    running: true,
    runId: "0193aaaa-0000-7000-8000-0000000000aa",
    serverToken: SERVER_TOKEN,
  });
  b.attach((f) => frames.push(f));
  const post = b.handle({ taskId: TASK, token: "secret-token-1", tool: "post_message", args: { text: "oi" } });
  const prompt = b.handle({ taskId: TASK, token: "secret-token-1", tool: "permission_prompt", args: {} });
  await waitFor(() => frames.length === 2);
  b.detach();
  expect(await post).toMatchObject({ ok: false, transient: true });
  const resent: RunnerFrame[] = [];
  b.attach((f) => resent.push(f));
  await waitFor(() => resent.length === 1);
  expect(resent[0]).toMatchObject({ tool: "permission_prompt" });
  b.result({ type: "mcp.result", callId: (resent[0] as { callId: string }).callId, ok: true, text: "{}" });
  expect(await prompt).toEqual({ ok: true, text: "{}" });
});

test("while the connection is down (a runner restart, a reconnect) a call waits and is relayed after it comes back", async () => {
  const { b, frames } = bridge({ token: "secret-token-1", missionId: "m1", running: true });
  const req = { taskId: TASK, token: "secret-token-1", tool: "report", args: { summary: "hi" } };
  const early = b.handle(req);
  await new Promise((r) => setTimeout(r, 20));
  expect(frames).toHaveLength(0);
  b.attach((f) => frames.push(f));
  await waitFor(() => frames.length === 1);
  const sent = frames[0] as Extract<RunnerFrame, { type: "mcp.call" }>;
  b.result({ type: "mcp.result", callId: sent.callId, ok: true, text: "Reported in the thread." });
  expect(await early).toEqual({ ok: true, text: "Reported in the thread." });
  // A permission prompt in flight when the link drops is sent again on the next connection (never denied for it).
  const prompt = b.handle({ ...req, tool: "permission_prompt", args: { tool_name: "Bash", input: { command: "ls" } } });
  await waitFor(() => frames.length === 2);
  b.detach();
  const resent: RunnerFrame[] = [];
  b.attach((f) => resent.push(f));
  await waitFor(() => resent.length === 1);
  const again = resent[0] as Extract<RunnerFrame, { type: "mcp.call" }>;
  expect(again.tool).toBe("permission_prompt");
  b.result({ type: "mcp.result", callId: again.callId, ok: true, text: '{"behavior":"allow"}' });
  expect(await prompt).toEqual({ ok: true, text: '{"behavior":"allow"}' });
});

test("a call that waited out its timeout without a connection says so (transient)", async () => {
  const frames: RunnerFrame[] = [];
  const b = new McpBridge({
    socketPath: "unused",
    task: (id) => (id === TASK ? { token: "secret-token-1", missionId: "m1", running: true } : null),
    callTimeoutMs: 30,
  });
  closers.push(() => b.close());
  const out = await b.handle({ taskId: TASK, token: "secret-token-1", tool: "report", args: {} });
  expect(out).toMatchObject({ ok: false, transient: true, error: expect.stringContaining("not connected") });
  expect(frames).toHaveLength(0);
});

test("an ended task has no tools any more", async () => {
  const { b } = bridge({ token: "secret-token-1", missionId: "m1", running: false });
  b.attach(() => {});
  expect(await b.handle({ taskId: TASK, token: "secret-token-1", tool: "report", args: {} })).toEqual({
    ok: false,
    error: "This task has ended.",
  });
});

test.skipIf(!posix)("stdio MCP server → local socket → bridge → server, end to end (no executor)", async () => {
  const home = tempDir("mcp-");
  dirs.push(home);
  const socketPath = path.join(home, "mcp.sock");
  const { b, frames } = bridge({ token: "tok-123456789", missionId: "m1", running: true }, socketPath);
  await b.listen();
  b.attach((f) => {
    frames.push(f);
    if (f.type === "mcp.call")
      queueMicrotask(() => b.result({ type: "mcp.result", callId: f.callId, ok: true, text: `ran ${f.tool}` }));
  });
  expect(await ipcCall(socketPath, { taskId: TASK, token: "bad", tool: "report", args: {} })).toMatchObject({
    ok: false,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
  const server = runMcpServer({ taskId: TASK, socketPath, token: "tok-123456789", input, output });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write("not json\n");
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "update_plan", arguments: { items: [] } } })}\n`,
  );
  input.end();
  expect(await server).toBe(0);
  const parsed = lines.map(
    (l) => JSON.parse(l) as { id: unknown; result?: { content?: { text: string }[] }; error?: unknown },
  );
  expect(parsed.find((m) => m.id === 1)?.result).toMatchObject({ serverInfo: { name: "agentes" } });
  expect(parsed.find((m) => m.id === null)?.error).toMatchObject({ code: -32700 });
  expect(parsed.find((m) => m.id === 2)?.result?.content?.[0]?.text).toBe("ran update_plan");
  expect(frames.filter((f) => f.type === "mcp.call")).toHaveLength(1);
});

test("executor arguments: Claude Code gets our MCP config, our tools allowed and the rules; quoting is safe", () => {
  expect(cleanRules("Don't merge! Use `x` & 100% $HOME")).toBe("Don t merge Use x 100 HOME");
  const args = missionExecutorArgs(
    "claude",
    {
      configFile: "/tmp/a b/mcp.json",
      command: ["/usr/bin/node", "/opt/runner.mjs"],
      taskId: TASK,
      socketPath: "/s",
      rules: "Read .agentes/ first.",
    },
    "darwin",
  );
  expect(args).toEqual([
    "--mcp-config",
    "'/tmp/a b/mcp.json'",
    "--allowedTools",
    "mcp__agentes",
    "--append-system-prompt",
    "'Read .agentes/ first.'",
  ]);
  const win = missionExecutorArgs(
    "claude",
    {
      configFile: "C:\\Users\\A B\\mcp.json",
      command: ["node", "r.mjs"],
      taskId: TASK,
      socketPath: "\\\\.\\pipe\\x",
      rules: "Rules.",
    },
    "win32",
  );
  expect(win[1]).toBe('"C:\\Users\\A B\\mcp.json"');
  const codex = missionExecutorArgs(
    "codex",
    { configFile: "", command: ["/usr/bin/node", "/opt/runner.mjs"], taskId: TASK, socketPath: "/s", rules: "" },
    "linux",
  );
  expect(codex.join(" ")).toContain(
    `mcp_servers.agenteschat_agentes.args=["/opt/runner.mjs","mcp","--task","${TASK}"]`,
  );
  expect(
    claudeMcpConfig({ command: ["/usr/bin/node", "/opt/r.mjs"], taskId: TASK, socketPath: "/s", token: "t" }),
  ).toEqual({
    mcpServers: {
      agentes: {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["/opt/r.mjs", "mcp", "--task", TASK],
        env: { AGENTES_MCP_TOKEN: "t", AGENTES_MCP_SOCKET: "/s" },
      },
    },
  });
  // A brain's tools are always loaded (no ToolSearch call before each one).
  expect(
    claudeMcpConfig({ command: ["node", "r.mjs"], taskId: TASK, socketPath: "/s", token: "t", alwaysLoad: true })
      .mcpServers.agentes,
  ).toMatchObject({ alwaysLoad: true });
});

test.skipIf(!posix)(
  "a mission task gets a token, an MCP config (mode 600) and the flags; other tasks don't",
  async () => {
    const ws = tempDir("ws-");
    const home = tempDir("home-");
    dirs.push(ws, home);
    const tasks = new TaskManager({
      root: path.join(home, "tasks"),
      workspaceReal: ws,
      agentFolder: (agent) => agentWorkspace(ws, agent),
      watchMs: 20,
      eventEveryMs: 0,
      claudeHome: path.join(home, "claude"),
      caffeinate: false,
      mcp: { socketPath: path.join(home, "mcp.sock"), command: [process.execPath, "/opt/agentes-runner.mjs"] },
    });
    closers.push(() => tasks.close());
    await tasks.init();
    const started = await tasks.start(AGENT, {
      taskId: TASK,
      executor: "claude",
      prompt: "Plan it",
      session: "0193aaaa-0000-7000-8000-0000000000aa",
      mission: { id: "0193aaaa-0000-7000-8000-0000000000bb", rules: "Read .agentes/ first." },
    });
    expect(started.command).toContain("--mcp-config");
    expect(started.command).toContain("--allowedTools mcp__agentes");
    // The workspace isn't a git repository: the rules for a folder without git replace the given ones.
    expect(started.command).toContain(`--append-system-prompt '${cleanRules(MISSION_RULES_NO_GIT)}'`);
    expect(started.command).not.toContain("Read .agentes/ first.");
    const info = tasks.mcpTask(TASK);
    expect(info).toMatchObject({ missionId: "0193aaaa-0000-7000-8000-0000000000bb", running: true });
    const config = JSON.parse(readFileSync(path.join(home, "tasks", TASK, "mcp.json"), "utf8"));
    expect(config.mcpServers.agentes.env.AGENTES_MCP_TOKEN).toBe(info?.token);
    expect(config.mcpServers.agentes.args).toEqual(["/opt/agentes-runner.mjs", "mcp", "--task", TASK]);
    // Where it runs, so plain reads there need no card.
    const cwd = config.mcpServers.agentes.env.AGENTES_MCP_CWD as string;
    expect(path.isAbsolute(cwd)).toBe(true);
    expect(String(config.mcpServers.agentes.env.AGENTES_MCP_FOLDERS).split(path.delimiter)).toContain(cwd);
    expect(existsSync(path.join(home, "tasks", TASK, "mcp-token"))).toBe(true);
    // The token never leaves the machine (not in the journal's view sent to the server).
    expect(JSON.stringify(tasks.list())).not.toContain(info?.token ?? "none");
    const plain = "0193aaaa-0000-7000-8000-000000000043";
    const other = await tasks.start(AGENT, { taskId: plain, executor: "shell", command: "true" });
    expect(other.command).toBe("true");
    expect(tasks.mcpTask(plain)).toBeNull();
  },
);

test("the permission prompt tool Claude Code is told to use is one our server advertises (work turns), under the server name of the MCP config", async () => {
  const list = (await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, async () => ({
    ok: true as const,
    text: "",
  }))) as { result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] } };
  const names = list.result.tools.map((t) => t.name);
  expect(names).toContain("permission_prompt");
  expect(names).toContain("complete_mission");
  const prompt = list.result.tools.find((t) => t.name === "permission_prompt");
  expect(Object.keys(prompt?.inputSchema.properties ?? {})).toEqual(
    expect.arrayContaining(["tool_name", "input", "tool_use_id"]),
  );
  const args = missionExecutorArgs(
    "claude",
    {
      configFile: "/c/mcp.json",
      command: ["node", "r.mjs"],
      taskId: TASK,
      socketPath: "/s",
      rules: "",
      promptTool: true,
    },
    "darwin",
  );
  const given = args[args.indexOf("--permission-prompt-tool") + 1] ?? "";
  expect(given).toBe(PERMISSION_PROMPT_TOOL);
  const config = claudeMcpConfig({ command: ["node", "r.mjs"], taskId: TASK, socketPath: "/s", token: "t" }) as {
    mcpServers: Record<string, unknown>;
  };
  const [server] = Object.keys(config.mcpServers);
  expect(given).toBe(`mcp__${server}__permission_prompt`);
  expect(names.map((n) => `mcp__${server}__${n}`)).toContain(given);
  // Plan turns don't get the prompt tool (only reads there).
  const plan = missionExecutorArgs(
    "claude",
    { configFile: "/c/mcp.json", command: ["node", "r.mjs"], taskId: TASK, socketPath: "/s", rules: "" },
    "darwin",
  );
  expect(plan).not.toContain("--permission-prompt-tool");
});

test("an item away from the mission folder may use it (--add-dir, Read/Edit/Write there only); the main session needs nothing", () => {
  const folder = "/Users/ana/agentes/app";
  expect(missionFolderRules(folder, ["Read", "Edit", "Write"])).toEqual([
    "Read(//Users/ana/agentes/app/**)",
    "Edit(//Users/ana/agentes/app/**)",
    "Write(//Users/ana/agentes/app/**)",
  ]);
  // Never a relative, wildcard or parent path.
  expect(missionFolderRules("app", ["Read"])).toEqual([]);
  expect(missionFolderRules("/Users/*", ["Read"])).toEqual([]);
  expect(missionFolderRules("/Users/ana/../bob", ["Read"])).toEqual([]);
  const work = claudePermissionSettings("work", [], folder);
  expect(work.permissions.allow).toContain("Edit(//Users/ana/agentes/app/**)");
  // Nothing broader: no bare Edit/Write, and the deny list stays.
  expect(work.permissions.allow).not.toContain("Edit");
  expect(work.permissions.allow).not.toContain("Write");
  expect(work.permissions.deny.length).toBeGreaterThan(0);
  const plan = claudePermissionSettings("plan", [], folder);
  expect(plan.permissions.allow).toContain("Read(//Users/ana/agentes/app/**)");
  expect(plan.permissions.allow.some((r) => r.startsWith("Edit("))).toBe(false);
  expect(claudePermissionSettings("work").permissions.allow.some((r) => r.includes("//"))).toBe(false);
  const args = missionExecutorArgs(
    "claude",
    {
      configFile: "/tmp/mcp.json",
      command: ["agentes-runner"],
      taskId: TASK,
      socketPath: "/tmp/mcp.sock",
      rules: "",
      promptTool: true,
      addDirs: [folder],
    },
    "darwin",
  );
  // Shell-quoted like every other path argument.
  expect(args.join(" ")).toContain(`--add-dir '${folder}'`);
  expect(
    missionExecutorArgs(
      "claude",
      { configFile: "/tmp/mcp.json", command: ["x"], taskId: TASK, socketPath: "/tmp/s", rules: "" },
      "darwin",
    ),
  ).not.toContain("--add-dir");
});

// ── Protocol 8: the bridge (ADR 0032) ───────────────────────────────────────

const SERVER_TOKEN = `agr_${"a".repeat(43)}`;

test("protocol 8: mcp.call carries the server token; mcp.list and mcp.tools parse; bad tokens are dropped", () => {
  expect(BRIDGE_PROTOCOL).toBe(8);
  expect(
    parseRunnerFrame(
      JSON.stringify({ type: "mcp.call", callId: "c1", taskId: TASK, tool: "x", args: {}, token: SERVER_TOKEN }),
    ),
  ).toMatchObject({ type: "mcp.call", token: SERVER_TOKEN });
  expect(
    parseRunnerFrame(
      JSON.stringify({ type: "mcp.call", callId: "c1", taskId: TASK, tool: "x", args: {}, token: "nope" }),
    ),
  ).not.toHaveProperty("token");
  expect(
    parseRunnerFrame(JSON.stringify({ type: "mcp.list", callId: "l1", taskId: TASK, token: SERVER_TOKEN })),
  ).toEqual({ type: "mcp.list", callId: "l1", taskId: TASK, token: SERVER_TOKEN });
  expect(parseRunnerFrame(JSON.stringify({ type: "mcp.list", callId: "l1", taskId: TASK }))).toBeNull();
  expect(
    parseServerFrame(JSON.stringify({ type: "mcp.tools", callId: "l1", ok: true, tools: [{ name: "a" }] })),
  ).toMatchObject({ type: "mcp.tools", ok: true });
  expect(parseServerFrame(JSON.stringify({ type: "mcp.tools", callId: "l1", ok: true }))).toBeNull();
});

test("with a server token the bridge asks the server for the list and relays any tool, token attached", async () => {
  const { b, frames } = bridge({
    token: "secret-token-1",
    missionId: "m1",
    running: true,
    serverToken: SERVER_TOKEN,
    cwd: "/w/dev-1/app",
    folder: "/w/dev-1",
    redact: (s) => s.replaceAll("tok_1", "[secret]"),
  });
  b.attach((f) => frames.push(f));
  const listing = b.handle({ taskId: TASK, token: "secret-token-1", tool: "", args: {}, kind: "list" });
  await waitFor(() => frames.length === 1);
  const list = frames[0] as Extract<RunnerFrame, { type: "mcp.list" }>;
  expect(list).toMatchObject({ type: "mcp.list", taskId: TASK, token: SERVER_TOKEN });
  const tool = { name: "github_get_pr", description: "Read a PR", inputSchema: { type: "object", properties: {} } };
  b.tools({ type: "mcp.tools", callId: list.callId, ok: true, tools: [tool, { name: "bad name!" } as never] });
  expect(await listing).toEqual({ ok: true, text: "", tools: [tool], memo: true });
  // Asked again for the same run (each MCP process asks every second): answered here, the server isn't asked.
  expect(await b.handle({ taskId: TASK, token: "secret-token-1", tool: "", args: {}, kind: "list" })).toEqual({
    ok: true,
    text: "",
    tools: [tool],
    memo: true,
  });
  expect(frames.filter((f) => f.type === "mcp.list")).toHaveLength(1);

  const call = b.handle({ taskId: TASK, token: "secret-token-1", tool: "github_get_pr", args: { q: "tok_1" } });
  await waitFor(() => frames.length === 2);
  const sent = frames[1] as Extract<RunnerFrame, { type: "mcp.call" }>;
  expect(sent).toMatchObject({ tool: "github_get_pr", args: { q: "[secret]" }, token: SERVER_TOKEN });
  b.result({ type: "mcp.result", callId: sent.callId, ok: true, text: "PR #3" });
  expect(await call).toEqual({ ok: true, text: "PR #3" });
  // Paths of our upload tools are still resolved on the machine.
  const upload = b.handle({
    taskId: TASK,
    token: "secret-token-1",
    tool: "upload_artifact",
    args: { path: "/w/dev-1/app/out.png" },
  });
  await waitFor(() => frames.length === 3);
  expect(frames[2]).toMatchObject({ tool: "upload_artifact", args: { path: "out.png" } });
  b.result({ type: "mcp.result", callId: (frames[2] as { callId: string }).callId, ok: true, text: "ok" });
  await upload;
  expect(await b.handle({ taskId: TASK, token: "secret-token-1", tool: "no spaces", args: {} })).toMatchObject({
    ok: false,
    error: "Unknown tool no spaces",
  });
});

test("the bridge relays a whole source file; past the limit it says the way out", async () => {
  const { b, frames } = bridge({ token: "secret-token-1", missionId: "m1", running: true, serverToken: SERVER_TOKEN });
  b.attach((f) => frames.push(f));
  const req = { taskId: TASK, token: "secret-token-1", tool: "github_create_or_update_file" };
  const content = "export const line = 1;\n".repeat(6600);
  const pending = b.handle({ ...req, args: { path: "src/big.ts", content } });
  await waitFor(() => frames.length === 1);
  const sent = frames[0] as Extract<RunnerFrame, { type: "mcp.call" }>;
  expect(sent.args).toEqual({ path: "src/big.ts", content });
  b.result({ type: "mcp.result", callId: sent.callId, ok: true, text: "Committed." });
  expect(await pending).toEqual({ ok: true, text: "Committed." });
  expect(await b.handle({ ...req, args: { content: "x".repeat(MCP_ARGS_MAX_CHARS) } })).toEqual({
    ok: false,
    error:
      "The arguments are too large (more than 1 MB). Keep big content in a file in your folder: to change a repository, commit and push it with git.",
  });
  expect(frames).toHaveLength(1);
});

test("without a server token (an older server) the list is the fixed mission tools", async () => {
  const { b } = bridge({ token: "secret-token-1", missionId: "m1", running: true });
  const out = await b.handle({ taskId: TASK, token: "secret-token-1", tool: "", args: {}, kind: "list" });
  expect(out.ok && out.tools?.map((t) => t.name)).toEqual(MISSION_MCP_TOOLS.map((t) => t.name));
  expect(await b.handle({ taskId: TASK, token: "secret-token-1", tool: "github_get_pr", args: {} })).toMatchObject({
    ok: false,
    error: "Unknown tool github_get_pr",
  });
});

test("the MCP process caches the run's list, refreshes it and notices a change; a failed ask keeps the last list", async () => {
  let now = 0;
  let served = [{ name: "a", description: "A", inputSchema: { type: "object" } }];
  let fail = false;
  let asked = 0;
  const cache = new McpToolCache(
    async () => {
      asked++;
      return fail ? { ok: false, error: "down", transient: true } : { ok: true, text: "", tools: served };
    },
    { ttlMs: 1000, now: () => now },
  );
  expect((await cache.get()).map((t) => t.name)).toEqual(["a"]);
  await cache.get();
  expect(asked).toBe(1);
  now = 2000;
  served = [...served, { name: "b", description: "B", inputSchema: { type: "object" } }];
  expect((await cache.get()).map((t) => t.name)).toEqual(["a", "b"]);
  expect(await cache.refresh()).toBe(false);
  served = [served[0] as (typeof served)[number]];
  expect(await cache.refresh()).toBe(true);
  fail = true;
  expect(await cache.refresh()).toBe(false);
  now = 10_000;
  expect((await cache.get()).map((t) => t.name)).toEqual(["a"]);
  // Never loaded and the server is unreachable: the fixed mission tools.
  const empty = new McpToolCache(async () => ({ ok: false, error: "down" }));
  expect((await empty.get()).map((t) => t.name)).toEqual(MISSION_MCP_TOOLS.map((t) => t.name));
});

test("every change the MCP process sees is announced, one a call's get saw first too; asks don't overlap", async () => {
  let now = 0;
  let served = [{ name: "a", description: "A", inputSchema: { type: "object" } }];
  let asked = 0;
  let announced = 0;
  const cache = new McpToolCache(
    async () => {
      asked++;
      return { ok: true, text: "", tools: served };
    },
    { ttlMs: 1000, now: () => now, onChange: () => announced++ },
  );
  await cache.get();
  expect(announced).toBe(0);
  // The list changes; a call's `get` sees it first (the TTL ran out), and the background refresh after it sees none.
  now = 2000;
  served = [...served, { name: "b", description: "B", inputSchema: { type: "object" } }];
  expect((await cache.get()).map((t) => t.name)).toEqual(["a", "b"]);
  expect(await cache.refresh()).toBe(false);
  expect(announced).toBe(1);
  // Two asks at once are one.
  const before = asked;
  await Promise.all([cache.refresh(), cache.refresh()]);
  expect(asked).toBe(before + 1);
});

test("MCP JSON-RPC with the bridge's list: tools/list is the run's; a name it lacks still goes to the server", async () => {
  const calls: string[] = [];
  const call = async (tool: string) => {
    calls.push(tool);
    return { ok: true as const, text: `ran ${tool}` };
  };
  const tools = [
    { name: "github_get_pr", description: "Read a PR", inputSchema: { type: "object", properties: {} } },
    { name: "get_context", description: "Search", inputSchema: { type: "object", properties: {} } },
    { name: "react", description: "React", inputSchema: { type: "object", properties: {} } },
  ];
  const list = async () => tools;
  const init = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    call,
    undefined,
    list,
  );
  expect(init).toMatchObject({ result: { capabilities: { tools: { listChanged: true } } } });
  const listed = (await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, call, undefined, list)) as {
    result: { tools: { name: string; annotations?: unknown }[] };
  };
  expect(listed.result.tools.map((t) => t.name)).toEqual(["github_get_pr", "get_context", "react"]);
  expect(listed.result.tools[1]?.annotations).toEqual({ readOnlyHint: true });
  // Claude Code lists what agents reach for on their own; the rest wait behind its ToolSearch (token-trim B6).
  const meta = listed.result.tools.map((t) => (t as { _meta?: unknown })._meta);
  expect(meta).toEqual([undefined, undefined, { "anthropic/alwaysLoad": true }]);
  // What an API brain never loads on demand either (token-trim B3): learning, skills, the wiki, teammates.
  for (const name of [
    "react",
    "ask_user",
    "remember",
    "update_memory",
    "forget",
    "save_how_to",
    "update_skill",
    "load_skill",
    "read_wiki_page",
    "search_wiki",
    "ask_agent",
    "tell_agent",
    "follow_up",
    "work_in_background",
    "web_search",
    "find_tools",
  ])
    expect(ALWAYS_LOADED.has(name)).toBe(true);
  for (const name of ["send_sticker", "set_status", "github_get_pr"]) expect(ALWAYS_LOADED.has(name)).toBe(false);
  const ran = await handleMcpMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "github_get_pr", arguments: {} } },
    call,
    undefined,
    list,
  );
  expect(ran).toMatchObject({ result: { content: [{ type: "text", text: "ran github_get_pr" }], isError: false } });
  // A kept-alive executor may list what it had before: the server decides (it runs any tool the agent may use).
  expect(
    await handleMcpMessage(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "update_plan", arguments: {} } },
      call,
      undefined,
      list,
    ),
  ).toMatchObject({ result: { content: [{ type: "text", text: "ran update_plan" }], isError: false } });
  expect(calls).toEqual(["github_get_pr", "update_plan"]);
  // Nothing beyond this computer to ask (a background task outside a mission): only its own prompt tool.
  expect(
    await handleMcpMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "update_plan", arguments: {} } },
      call,
      undefined,
      list,
      "work",
      { local: true },
    ),
  ).toMatchObject({ error: { code: -32602 } });
});

test.skipIf(!posix)(
  "a kept-alive brain process tells its executor the next turn's tools within a moment of the turn's start, before any call",
  async () => {
    const home = tempDir("mcp-");
    dirs.push(home);
    const socketPath = path.join(home, "mcp.sock");
    // A brain process's bridge entry: between turns idle, then the next run with its own token.
    const info: McpTaskInfo = { token: "tok-123456789", missionId: "", running: false, idle: true };
    const b = new McpBridge({ socketPath, task: (id) => (id === TASK ? info : null), callTimeoutMs: 2000 });
    closers.push(() => b.close());
    await b.listen();
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
    let served = [tool("find_tools"), tool("use_tool")];
    let asked = 0;
    b.attach((f) => {
      if (f.type !== "mcp.list") return;
      asked++;
      queueMicrotask(() => b.tools({ type: "mcp.tools", callId: f.callId, ok: true, tools: served }));
    });
    const turn = (runId: string | null) => {
      Object.assign(
        info,
        runId ? { running: true, idle: false, runId, serverToken: SERVER_TOKEN } : { running: false, idle: true },
      );
      if (!runId) delete info.runId;
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Record<string, unknown>[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(l));
    });
    const server = runMcpServer({
      taskId: TASK,
      socketPath,
      token: "tok-123456789",
      input,
      output,
      refreshMs: 60_000,
      pollMs: 20,
    });
    const send = (msg: Record<string, unknown>) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    const listed = async (id: number) => {
      send({ id, method: "tools/list" });
      await waitFor(() => lines.some((l) => l.id === id));
      const reply = lines.find((l) => l.id === id) as { result: { tools: { name: string }[] } };
      return reply.result.tools.map((t) => t.name);
    };
    // The first turn: the executor lists once, at its start.
    turn("0193aaaa-0000-7000-8000-0000000000a1");
    send({ id: 1, method: "initialize", params: {} });
    expect(await listed(2)).toEqual(["find_tools", "use_tool"]);
    // Between turns a person gives the agent a connector.
    turn(null);
    await new Promise((r) => setTimeout(r, 80));
    served = [...served, tool("vega_crm_find_tools"), tool("vega_crm_use_tool")];
    expect(lines.some((l) => l.method === "notifications/tools/list_changed")).toBe(false);
    // The next turn: told at once, with no call in between, and the list it reads again is the new one.
    turn("0193aaaa-0000-7000-8000-0000000000a2");
    await waitFor(() => lines.some((l) => l.method === "notifications/tools/list_changed"), 2000);
    expect(await listed(3)).toEqual(["find_tools", "use_tool", "vega_crm_find_tools", "vega_crm_use_tool"]);
    // Asked every 20 ms all along, yet the server only once per run: the daemon answered the rest.
    expect(asked).toBe(2);
    input.end();
    expect(await server).toBe(0);
  },
  10_000,
);

test.skipIf(!posix)("a mission task started with the server's token keeps it for the bridge", async () => {
  const ws = tempDir("ws-");
  const home = tempDir("home-");
  dirs.push(ws, home);
  const tasks = new TaskManager({
    root: path.join(home, "tasks"),
    workspaceReal: ws,
    agentFolder: (agent) => agentWorkspace(ws, agent),
    watchMs: 20,
    eventEveryMs: 0,
    claudeHome: path.join(home, "claude"),
    caffeinate: false,
    mcp: { socketPath: path.join(home, "mcp.sock"), command: [process.execPath, "/opt/agentes-runner.mjs"] },
  });
  closers.push(() => tasks.close());
  await tasks.init();
  await tasks.start(AGENT, {
    taskId: TASK,
    executor: "claude",
    prompt: "Plan it",
    mission: { id: "0193aaaa-0000-7000-8000-0000000000bb", rules: "Rules.", mcpToken: SERVER_TOKEN },
  });
  expect(tasks.mcpTask(TASK)).toMatchObject({ serverToken: SERVER_TOKEN });
  await tasks.start(AGENT, {
    taskId: "0193aaaa-0000-7000-8000-000000000043",
    executor: "claude",
    prompt: "Plan it",
    mission: { id: "0193aaaa-0000-7000-8000-0000000000bb", rules: "Rules.", mcpToken: "not-a-token" },
  });
  expect(tasks.mcpTask("0193aaaa-0000-7000-8000-000000000043")?.serverToken).toBeUndefined();
});

test.if(process.platform !== "win32")(
  "a second socket for relays is open to whoever enters its folder, and goes with the bridge",
  async () => {
    const dir = tempDir("relays-");
    dirs.push(dir);
    const bridge = new McpBridge({ socketPath: path.join(dir, "mcp.sock"), task: () => null });
    const relays = path.join(dir, "relays.sock");
    await bridge.listenForRelays(relays);
    await bridge.listenForRelays(relays);
    expect(statSync(relays).mode & 0o777).toBe(0o666);
    await bridge.close();
    expect(existsSync(relays)).toBe(false);
  },
);
