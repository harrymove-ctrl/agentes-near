import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters";
import { AccountManager, accountEnv, parseGrokLogin, parseGrokStatus } from "../../runner/accounts";
import type { CodexBrainEvent } from "../../runner/brain-codex";
import {
  GROK_CHAT_DENIED,
  GROK_PLANTED,
  grokChatBreach,
  grokChatsFile,
  grokConfig,
  grokProblem,
  grokTurnArgs,
  writeGrokConfig,
} from "../../runner/brain-grok";
import { detectExecutors, parseGrokModels } from "../../runner/executors";
import { handleRequest } from "../../runner/handlers";
import { CODEX_MCP_SERVER } from "../../runner/mcp";
import type { Spawn } from "../../runner/scope-gate";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const managers: AccountManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  delete process.env.FAKE_GROK_LOG;
  delete process.env.FAKE_GROK_TOOLS;
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-grok.mjs");
const RUN = "0193aaaa-0000-7000-8000-0000000000a1";
const SESSION = "0193cccc-0000-7000-8000-0000000000a1";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff00a1", handle: "dev" };
const ACCOUNT = "0193eeee-0000-7000-8000-0000000000a1";
const ORG = "0193dddd-0000-7000-8000-000000000001";
const FIRST = "9a0c0000-0000-4000-8000-000000000001";

test("command line: headless with Claude Code's stream shape, always in a sandbox; work approves, plan asks nobody and edits nothing", () => {
  const work = grokTurnArgs({ prompt: "oi", model: "grok-4.6", chat: FIRST, effort: "max" });
  expect(work.slice(0, 4)).toEqual(["-p", "oi", "--output-format", "streaming-messages-json"]);
  expect(work.join(" ")).toContain("--sandbox workspace");
  expect(work.join(" ")).toContain("--permission-mode bypassPermissions");
  expect(work.join(" ")).toContain("--model grok-4.6");
  expect(work.join(" ")).toContain("--effort high");
  expect(work.join(" ")).toContain(`--resume ${FIRST}`);
  const plan = grokTurnArgs({ prompt: "oi", profile: "plan" }).join(" ");
  expect(plan).toContain("--permission-mode dontAsk");
  expect(plan).toContain(`--allow MCPTool(${CODEX_MCP_SERVER}__*)`);
  expect(plan).toContain("--deny Edit --deny Write");
  expect(plan).not.toContain("--resume");
  const chat = grokTurnArgs({ prompt: "oi", locked: true }).join(" ");
  expect(chat).toContain("--tools search_tool,use_tool");
  expect(chat).toContain(`--disallowed-tools ${GROK_CHAT_DENIED.join(",")}`);
  expect(chat).toContain("--no-subagents --disable-web-search --no-plan --permission-mode dontAsk");
  expect(chat).not.toContain("bypassPermissions");
});

test("our server in GROK_HOME's config.toml: the run and the token only as env references", () => {
  const stdio = grokConfig({ command: ["/usr/bin/agentes-runner"] });
  expect(stdio).toContain(`[mcp_servers.${CODEX_MCP_SERVER}]`);
  expect(stdio).toContain('args = ["mcp"]');
  // Grok's `${NAME}` interpolation in config.toml.
  const ref = (name: string) => `${name} = "\${${name}}"`;
  expect(stdio).toContain(ref("AGENTES_MCP_RUN"));
  expect(stdio).toContain(ref("AGENTES_MCP_TOKEN"));
  const http = grokConfig({ url: "https://bridge.example/mcp" });
  expect(http).toContain('bearer_token_env_var = "AGENTES_MCP_TOKEN"');
  expect(http).not.toContain("command");
});

test("a turn drops what an earlier turn planted in GROK_HOME (fleet config, folder trust, LSP, plugins), the sign-in stays", () => {
  const home = tempDir("grok-home-");
  dirs.push(home);
  for (const name of ["managed_config.toml", "trusted_folders.toml", "lsp.json", "auth.json"]) {
    writeFileSync(path.join(home, name), "x");
  }
  mkdirSync(path.join(home, "plugins", "evil"), { recursive: true });
  writeGrokConfig(home, grokConfig({ command: ["/usr/bin/agentes-runner"] }));
  for (const name of GROK_PLANTED) expect(existsSync(path.join(home, name))).toBe(false);
  expect(existsSync(path.join(home, "auth.json"))).toBe(true);
  expect(readFileSync(path.join(home, "config.toml"), "utf8")).toContain(`[mcp_servers.${CODEX_MCP_SERVER}]`);
});

test("a chat turn's guard: init with only the meta-tools and our server; a tool of Grok's own, another server or an answer first stop it", () => {
  const init = (tools: unknown, servers: unknown = [{ name: CODEX_MCP_SERVER }]) => ({
    type: "system",
    subtype: "init",
    tools,
    mcp_servers: servers,
  });
  expect(grokChatBreach(init(["search_tool", "use_tool"]), false)).toBeNull();
  expect(grokChatBreach(init(["search_tool", "use_tool", "read_file"]), false)).toContain("read_file");
  expect(
    grokChatBreach(init(["use_tool"], [{ name: CODEX_MCP_SERVER }, { name: "managed_gateway:x" }]), false),
  ).toContain("MCP managed_gateway:x");
  expect(grokChatBreach({ type: "system", subtype: "init" }, false)).toContain("didn't list its tools");
  const say = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
  expect(grokChatBreach(say, false)).toContain("before listing");
  expect(grokChatBreach(say, true)).toBeNull();
  const call = (name: string, input: unknown) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input }] },
  });
  expect(grokChatBreach(call("use_tool", { tool_name: `${CODEX_MCP_SERVER}__post_message` }), true)).toBeNull();
  expect(grokChatBreach(call("use_tool", { tool_name: "linear__save_issue" }), true)).toContain("isn't ours");
  expect(grokChatBreach(call("use_tool", { arguments: {} }), true)).toContain("isn't ours");
  expect(grokChatBreach(call("run_terminal_command", { command: "cat auth.json" }), true)).toContain(
    "run_terminal_command",
  );
  const start = {
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", name: "read_file" } },
  };
  expect(grokChatBreach(start, true)).toContain("read_file");
  const web = { type: "assistant", message: { content: [{ type: "server_tool_use", name: "web_search" }] } };
  expect(grokChatBreach(web, true)).toContain("web_search");
});

test("a turn that went wrong: a usage limit, a sign-in that ended, anything else", () => {
  expect(grokProblem("You've reached your weekly usage limit.", true)).toEqual([
    { type: "limit" },
    {
      type: "error",
      code: "plan_limit",
      message: "You've reached your weekly usage limit.",
      retryable: true,
      worked: true,
    },
  ]);
  expect(grokProblem("You are not authenticated. Run grok login.")[0]).toMatchObject({ code: "not_logged_in" });
  expect(grokProblem("boom")[0]).toMatchObject({ code: "grok_failed" });
});

test("the CLI's words: its models, its sign-in status and its device sign-in", () => {
  const models =
    "You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n";
  expect(parseGrokModels(models)).toEqual([{ id: "grok-4.6" }, { id: "grok-4.5" }]);
  expect(parseGrokStatus(0, "Available models:\n  * grok-4.6", true)).toEqual({ loggedIn: true });
  expect(parseGrokStatus(0, models, true)).toEqual({ loggedIn: false });
  expect(parseGrokStatus(0, "Available models:", false)).toEqual({ loggedIn: false });
  const login = "Open https://accounts.x.ai/device on any device\nand enter the code: WDJB-MJHT\n";
  expect(parseGrokLogin(login)).toEqual({ url: "https://accounts.x.ai/device", userCode: "WDJB-MJHT" });
  expect(parseGrokLogin("Open https://accounts.x.ai/device")).toBeNull();
  expect(parseGrokLogin("Open https://evil.example/x.ai\n", true)).toBeNull();
  expect(parseGrokLogin("Open https://accounts.x.ai/device?user_code=WDJB-MJHT\n")).toEqual({
    url: "https://accounts.x.ai/device?user_code=WDJB-MJHT",
  });
});

test("an account folder is GROK_HOME, other vendors' config and telemetry off, and no xAI key leaks in", () => {
  const env = accountEnv("grok", "/acc/x", {
    PATH: "/bin",
    XAI_API_KEY: "xai-machine",
    GROK_HOME: "/root/.grok",
    GROK_FOLDER_TRUST: "0",
    GROK_MEMORY: "1",
  });
  expect(env).toMatchObject({
    GROK_HOME: "/acc/x",
    GROK_CLAUDE_MCPS_ENABLED: "false",
    GROK_CURSOR_HOOKS_ENABLED: "false",
    GROK_TELEMETRY_ENABLED: "false",
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_MEMORY: "0",
  });
  expect(env.XAI_API_KEY).toBeUndefined();
  expect(env.GROK_FOLDER_TRUST).toBeUndefined();
});

test.skipIf(!posix)(
  "detection: Grok Build's version line and the models it lists; another `grok` is skipped",
  async () => {
    const run = (version: string) => (command: string, args: string[]) =>
      command === "grok"
        ? args[0] === "--version"
          ? { status: 0, stdout: `${version}\n` }
          : { status: 0, stdout: "Available models:\n  * grok-4.6 (default)\n" }
        : { status: 1, stdout: "" };
    expect((await detectExecutors(run("grok 1.0.34 (3736acbc8658) [stable]"))).found.grok).toEqual({
      version: "grok 1.0.34 (3736acbc8658) [stable]",
      models: [{ id: "grok-4.6" }],
    });
    expect((await detectExecutors(run("1.0.0"))).found.grok).toBeUndefined();
  },
);

function turnContext(root: string) {
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  const accountDir = path.join(root, "accounts", "grok", ACCOUNT);
  for (const d of [ws, home, accountDir]) mkdirSync(d, { recursive: true });
  const accounts = {
    accountDir: (kind: string, id: string) => (kind === "grok" && id === ACCOUNT ? accountDir : null),
  };
  return {
    home,
    accountDir,
    ctx: {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      codex: {
        runnerHome: home,
        runs: new Map(),
        accounts,
        mcp: { socketPath: path.join(home, "mcp.sock"), command: ["/usr/bin/agentes-runner"] },
        spawn: ((_, args, options) => spawn(process.execPath, [FAKE, ...args], options)) as Spawn,
      },
    },
  };
}

const turn = (over: Record<string, unknown> = {}) =>
  ({
    op: "brain.turn",
    runId: RUN,
    kind: "grok",
    session: { id: SESSION, resume: false },
    cwd: "",
    system: "You are Dev, the team's developer.",
    prompt: "run the tests",
    mcp: { token: "tok_run" },
    agent: AGENT,
    account: ACCOUNT,
    ...over,
  }) as MachineRequest;

const logOf = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { args: string[]; home: string; run: string; token: string; claudeMcps: string });

const scopeOf = (frames: unknown[] = []) => ({
  signal: new AbortController().signal,
  output: () => {},
  emit: (f: unknown) => frames.push(f),
});
const eventsOf = (frames: unknown[]) =>
  (frames as { type: string; event?: CodexBrainEvent }[]).flatMap((f) =>
    f.type === "brain.event" && f.event ? [f.event] : [],
  );

test.skipIf(!posix)(
  "a fake Grok: the first turn starts a session with the context and our bridge, the next resumes it with the new message only",
  async () => {
    const root = tempDir("brain-grok-");
    dirs.push(root);
    const { ctx, home, accountDir } = turnContext(root);
    writeFileSync(path.join(accountDir, "auth.json"), "{}");
    const log = path.join(root, "grok.log");
    process.env.FAKE_GROK_LOG = log;
    const frames: unknown[] = [];
    const reply = (await handleRequest(ctx as never, turn(), scopeOf(frames) as never)) as { final: CodexBrainEvent };
    expect(reply.final).toEqual({ type: "done", text: "Let me check. All good.", session: { id: SESSION } });
    const events = eventsOf(frames);
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("Let me check. All good.");
    // Grok's shell call is on the transcript; the call to our bridge isn't (the engine ran it).
    expect(events.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name)).toEqual([
      "run_terminal_command",
    ]);
    // Its own call is told as it starts (the step line); the bridge's says its own.
    expect(events.filter((e) => e.type === "tool_started").map((e) => (e as { name: string }).name)).toEqual([
      "run_terminal_command",
    ]);
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      source: "plan",
      input: 1000,
      output: 40,
      cacheRead: 400,
      model: "grok-4.6",
    });

    const [first] = logOf(log);
    expect(first?.args[1]).toBe("You are Dev, the team's developer.\n\nrun the tests");
    expect(first?.args).not.toContain("--resume");
    expect(first?.args.join(" ")).not.toContain("tok_run");
    expect(first).toMatchObject({ home: accountDir, run: RUN, token: "tok_run", claudeMcps: "false" });
    expect(readFileSync(path.join(accountDir, "config.toml"), "utf8")).toContain('command = "/usr/bin/agentes-runner"');
    expect(JSON.parse(readFileSync(grokChatsFile(home), "utf8"))).toEqual({ [`${ACCOUNT}:${SESSION}`]: FIRST });

    await handleRequest(ctx as never, turn({ runId: RUN.replace(/1$/, "2"), prompt: "and now?" }), scopeOf() as never);
    const second = logOf(log)[1];
    expect(second?.args.join(" ")).toContain(`--resume ${FIRST}`);
    expect(second?.args[1]).toBe("and now?");

    // A session Grok no longer has (another runner home, whose chats file names one): a new one, with the context.
    const other = turnContext(path.join(root, "other"));
    writeFileSync(path.join(other.accountDir, "auth.json"), "{}");
    mkdirSync(path.dirname(grokChatsFile(other.home)), { recursive: true });
    writeFileSync(
      grokChatsFile(other.home),
      JSON.stringify({ [`${ACCOUNT}:${SESSION}`]: "9a0c0000-0000-4000-8000-0000000000ff" }),
    );
    const again = (await handleRequest(
      other.ctx as never,
      turn({ runId: RUN.replace(/1$/, "3"), prompt: "still there?" }),
      scopeOf() as never,
    )) as { final: CodexBrainEvent };
    expect(again.final).toMatchObject({ type: "done" });
    expect(logOf(log).at(-1)?.args[1]).toBe("You are Dev, the team's developer.\n\nstill there?");
  },
  20_000,
);

test.skipIf(!posix)(
  "an account's turn: none or gone refused, signed out is not_logged_in, a limit is plan_limit, the agent's secrets never leave",
  async () => {
    const root = tempDir("brain-grok-");
    dirs.push(root);
    const { ctx, accountDir } = turnContext(root);
    const run = async (over: Record<string, unknown>, c: object = ctx) =>
      ((await handleRequest(c as never, turn(over), scopeOf() as never)) as { final: CodexBrainEvent }).final;
    expect(await run({ account: undefined })).toMatchObject({ type: "error", code: "not_logged_in" });
    expect(await run({ runId: RUN.replace(/1$/, "4") })).toMatchObject({ type: "error", code: "not_logged_in" });
    const gone = { ...ctx, codex: { ...ctx.codex, accounts: { accountDir: () => null } } };
    expect(await run({ runId: RUN.replace(/1$/, "5") }, gone)).toEqual({
      type: "error",
      code: "account_missing",
      message: expect.stringContaining("Grok account"),
      retryable: false,
    });
    writeFileSync(path.join(accountDir, "auth.json"), "{}");
    expect(await run({ runId: RUN.replace(/1$/, "6"), prompt: "LIMIT" })).toMatchObject({
      type: "error",
      code: "plan_limit",
    });
  },
  20_000,
);

test.skipIf(!posix)(
  "a chat turn: only the meta-tools and our bridge; a tool of Grok's own or a call to another server stops it",
  async () => {
    const root = tempDir("brain-grok-");
    dirs.push(root);
    const { ctx, accountDir } = turnContext(root);
    writeFileSync(path.join(accountDir, "auth.json"), "{}");
    const log = path.join(root, "grok.log");
    process.env.FAKE_GROK_LOG = log;
    const chat = { permissions: { mode: "chat" } };
    const run = async (over: Record<string, unknown>) =>
      (
        (await handleRequest(ctx as never, turn({ ...chat, ...over }), scopeOf() as never)) as {
          final: CodexBrainEvent;
        }
      ).final;
    expect(await run({ prompt: "BRIDGE_ONLY hi" })).toMatchObject({ type: "done" });
    expect(logOf(log)[0]?.args.join(" ")).toContain("--tools search_tool,use_tool");
    expect(await run({ runId: RUN.replace(/1$/, "7"), prompt: "BRIDGE_ONLY OTHER_SERVER" })).toMatchObject({
      type: "error",
      code: "tools_not_locked",
    });
    process.env.FAKE_GROK_TOOLS = "search_tool,use_tool,run_terminal_command";
    expect(await run({ runId: RUN.replace(/1$/, "8"), prompt: "BRIDGE_ONLY" })).toMatchObject({
      type: "error",
      code: "tools_not_locked",
      message: expect.stringContaining("run_terminal_command"),
    });
  },
  20_000,
);

test.skipIf(!posix)("Grok turned off on the computer refuses the turn", async () => {
  const root = tempDir("brain-grok-");
  dirs.push(root);
  const { ctx } = turnContext(root);
  const off = {
    ...ctx,
    access: () => ({ folders: [], tools: { claude: true, codex: true, grok: false, commands: true } }),
  };
  await expect(handleRequest(off as never, turn(), scopeOf() as never)).rejects.toMatchObject({ code: "not_allowed" });
});

test.skipIf(!posix)("sign-in on the computer: Grok's device link and code, then signed in", async () => {
  const home = tempDir("grok-accounts-");
  dirs.push(home);
  const m = new AccountManager({
    root: path.join(home, "accounts"),
    orgId: () => ORG,
    commands: { grok: [process.execPath, FAKE] },
  });
  managers.push(m);
  const id = "0193eeee-0000-7000-8000-0000000000d1";
  const begun = await m.begin("grok", id);
  expect(begun).toMatchObject({ url: "https://accounts.x.ai/device", userCode: "WDJB-MJHT" });
  expect(begun.publicKey).toBeUndefined();
  await waitFor(() => m.status(id).state === "done", 5000);
  expect(m.status(id).account).toMatchObject({ kind: "grok", loggedIn: true });
  expect(m.accountDir("grok", id)).toBe(path.join(home, "accounts", "grok", id));
});
