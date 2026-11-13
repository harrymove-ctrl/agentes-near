import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters";
import { accountCodeAad, OPENCODE_KEY_PROVIDER } from "@agenteschat/adapters/machine-protocol";
import { sealSecret } from "@agenteschat/adapters/secret-box";
import { setTool } from "../../runner/access";
import { AccountManager, accountEnv, opencodeKeyOf } from "../../runner/accounts";
import type { CodexBrainEvent } from "../../runner/brain-codex";
import {
  OPENCODE_CHAT_PERMISSION,
  OpencodeEventMapper,
  opencodeConfig,
  opencodeConfigDir,
  opencodePrompt,
  opencodeSessionsFile,
  opencodeToolsBreach,
  opencodeTurnArgs,
} from "../../runner/brain-opencode";
import { accessToStore, effectiveAccess } from "../../runner/config";
import { detectExecutors, parseOpencodeModels } from "../../runner/executors";
import { handleRequest } from "../../runner/handlers";
import { CODEX_MCP_SERVER } from "../../runner/mcp";
import type { Spawn } from "../../runner/scope-gate";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
const managers: AccountManager[] = [];
const realHome = process.env.HOME;
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  delete process.env.FAKE_OPENCODE_LOG;
  for (const name of [
    "OPENCODE_PERMISSION",
    "ANTHROPIC_API_KEY",
    "FAKE_OPENCODE_ALLOW",
    "FAKE_OPENCODE_EXTRA_TOOL",
    "FAKE_OPENCODE_PROBE_FAIL",
    "FAKE_OPENCODE_RUN_BASH",
  ])
    delete process.env[name];
  process.env.HOME = realHome;
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-opencode.mjs");
const RUN = "0193aaaa-0000-7000-8000-0000000000f1";
const SESSION = "0193cccc-0000-7000-8000-0000000000f1";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff00f1", handle: "dev" };
const ACCOUNT = "0193eeee-0000-7000-8000-0000000000f1";
const ORG = "0193dddd-0000-7000-8000-000000000001";
const KEY = "oc_sk_fake0000000000000000";

test("command line: run with JSON events, the model and the session; the prompt never on the argv", () => {
  expect(opencodeTurnArgs({})).toEqual(["run", "--format", "json"]);
  expect(opencodeTurnArgs({ model: "opencode/big-pickle", session: "ses_1" })).toEqual([
    "run",
    "--format",
    "json",
    "--model",
    "opencode/big-pickle",
    "--session",
    "ses_1",
  ]);
  expect(opencodePrompt("You are Dev.", "oi", true)).toBe("You are Dev.\n\noi");
  expect(opencodePrompt("You are Dev.", "oi", false)).toBe("oi");
});

test("the turn's config: our server alone with env references, plan reads only, the key by reference", () => {
  const work = JSON.parse(opencodeConfig({ command: ["/usr/bin/bun", "/r/runner.js"], profile: "work" }));
  expect(Object.keys(work.mcp)).toEqual([CODEX_MCP_SERVER]);
  expect(work.mcp[CODEX_MCP_SERVER]).toEqual({
    type: "local",
    command: ["/usr/bin/bun", "/r/runner.js", "mcp", "--run", "{env:AGENTES_MCP_RUN}"],
    environment: {
      AGENTES_MCP_TOKEN: "{env:AGENTES_MCP_TOKEN}",
      AGENTES_MCP_SOCKET: "{env:AGENTES_MCP_SOCKET}",
      AGENTES_RUNNER_HOME: "{env:AGENTES_RUNNER_HOME}",
    },
    enabled: true,
  });
  expect(work.permission).toEqual({ "*": "allow", external_directory: "deny" });
  expect(work).toMatchObject({ share: "disabled", autoupdate: false });
  expect(work.provider).toBeUndefined();
  const plan = JSON.parse(opencodeConfig({ url: "https://x.test/mcp", profile: "plan", key: true }));
  expect(plan.mcp[CODEX_MCP_SERVER]).toEqual({
    type: "remote",
    url: "https://x.test/mcp",
    headers: { Authorization: "Bearer {env:AGENTES_MCP_TOKEN}" },
    enabled: true,
  });
  expect(plan.permission).toMatchObject({ edit: "deny", bash: "deny", task: "deny", external_directory: "deny" });
  expect(plan.provider).toEqual({ opencode: { options: { apiKey: "{env:OPENCODE_API_KEY}" } } });
});

test("JSON events: text parts as paragraphs, OpenCode's own tools executed, our bridge's left out, the steps' tokens added up", () => {
  const m = new OpencodeEventMapper({
    model: "opencode/big-pickle",
    redact: (t) => t.replaceAll("s3cret", "[secret]"),
  });
  const lines = [
    { type: "step_start", sessionID: "ses_9", part: {} },
    { type: "text", sessionID: "ses_9", part: { type: "text", text: "Let me look." } },
    {
      type: "tool_use",
      part: {
        tool: "bash",
        callID: "c1",
        state: { status: "completed", input: { command: "cat .env" }, output: "K=s3cret" },
      },
    },
    {
      type: "tool_use",
      part: { tool: "read", callID: "c2", state: { status: "error", input: {}, error: "No such file" } },
    },
    { type: "tool_use", part: { tool: "read", callID: "c3", state: { status: "running", input: {} } } },
    { type: "tool_use", part: { tool: `${CODEX_MCP_SERVER}_search`, callID: "c4", state: { status: "completed" } } },
    { type: "step_finish", part: { tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 3 } } } },
    { type: "text", part: { type: "text", text: "Done." } },
    { type: "step_finish", part: { tokens: { input: 4, output: 1 } } },
  ];
  const events = lines.flatMap((l) => m.line(JSON.stringify(l)));
  expect(m.session).toBe("ses_9");
  expect(events).toEqual([
    { type: "text_delta", text: "Let me look." },
    { type: "tool_call", id: "c1", name: "bash", input: { command: "cat .env" }, executed: { content: "K=[secret]" } },
    { type: "tool_call", id: "c2", name: "read", input: {}, executed: { content: "No such file", isError: true } },
    { type: "text_delta", text: "\n\nDone." },
  ]);
  expect(m.finish({ exitCode: 0, sessionId: SESSION })).toEqual([
    { type: "usage", input: 22, output: 4, source: "plan", model: "opencode/big-pickle", cacheRead: 5, cacheWrite: 3 },
    { type: "done", text: "Done.", session: { id: SESSION } },
  ]);
});

test("the answer is the text after the last tool call: a give-up before its own retry is narration, never posted", () => {
  const m = new OpencodeEventMapper();
  const said = (text: string) => JSON.stringify({ type: "text", part: { type: "text", text } });
  for (const l of [
    said("Não tenho como ler seu WhatsApp."),
    JSON.stringify({
      type: "tool_use",
      part: { tool: `${CODEX_MCP_SERVER}_find_tools`, state: { status: "completed" } },
    }),
    said("Abri o WhatsApp Web no meu navegador."),
    said("Escaneie o QR code e eu leio as mensagens."),
  ])
    m.line(l);
  expect(m.finish({ exitCode: 0, sessionId: SESSION }).at(-1)).toEqual({
    type: "done",
    text: "Abri o WhatsApp Web no meu navegador.\n\nEscaneie o QR code e eu leio as mensagens.",
    session: { id: SESSION },
  });
});

test("a turn that went wrong: a limit, a refused key, anything else, a non-zero exit", () => {
  const failed = (message: string) => {
    const m = new OpencodeEventMapper();
    m.line(JSON.stringify({ type: "error", error: { name: "APIError", data: { message } } }));
    return m.finish({ exitCode: 1, sessionId: SESSION });
  };
  expect(failed("Rate limit exceeded")).toEqual([
    { type: "limit" },
    { type: "error", code: "plan_limit", message: "Rate limit exceeded", worked: false },
  ]);
  expect(failed("Insufficient balance on your OpenCode account")[1]).toMatchObject({ code: "plan_limit" });
  expect(failed("401 Unauthorized")[0]).toMatchObject({ code: "not_logged_in" });
  expect(failed("boom")[0]).toMatchObject({ code: "opencode_failed", retryable: true });
  expect(new OpencodeEventMapper().finish({ exitCode: 2, sessionId: SESSION, stderr: "crash" })[0]).toMatchObject({
    code: "opencode_failed",
    message: "OpenCode exited with code 2: crash",
  });
});

test("the CLI's models: provider/model lines, the free tier marked", () => {
  expect(
    parseOpencodeModels(
      "opencode/big-pickle\nopencode/glm-5.3-flash-free\nopencode/glm-5.3\nanthropic/claude-x\nnoise\n",
    ),
  ).toEqual([
    { id: "opencode/big-pickle", label: "Big Pickle", free: true },
    { id: "opencode/glm-5.3-flash-free", label: "GLM-5.3 Flash Free", free: true },
    { id: "opencode/glm-5.3" },
    { id: "anthropic/claude-x" },
  ]);
});

test.skipIf(!posix)("detection: OpenCode's semver and its models; another `opencode` is skipped", async () => {
  const run = (version: string) => (command: string, args: string[]) =>
    command === "opencode"
      ? args[0] === "--version"
        ? { status: 0, stdout: `${version}\n` }
        : { status: 0, stdout: "opencode/big-pickle\n" }
      : { status: 1, stdout: "" };
  expect((await detectExecutors(run("1.19.5"))).found.opencode).toEqual({
    version: "1.19.5",
    models: [{ id: "opencode/big-pickle", label: "Big Pickle", free: true }],
  });
  expect((await detectExecutors(run("opencode the game"))).found.opencode).toBeUndefined();
});

test("an account folder is all of OpenCode's XDG folders, and no other key leaks in", () => {
  const env = accountEnv("opencode", "/acc/o", { PATH: "/bin", OPENCODE_API_KEY: "machine", HOME: "/h" });
  expect(env).toMatchObject({
    XDG_DATA_HOME: "/acc/o",
    XDG_CONFIG_HOME: "/acc/o",
    XDG_CACHE_HOME: "/acc/o",
    XDG_STATE_HOME: "/acc/o",
  });
  expect(env.OPENCODE_API_KEY).toBeUndefined();
});

test("access stored before OpenCode's switch follows Codex's", () => {
  const stored = (tools: Record<string, boolean>) =>
    ({ access: { folders: [], tools: { claude: true, commands: true, ...tools } } }) as never;
  expect(effectiveAccess(stored({ codex: false, cursor: true })).tools.opencode).toBe(false);
  expect(effectiveAccess(stored({ codex: true, opencode: false })).tools.opencode).toBe(false);
  // A Codex edit from an app without OpenCode's switch doesn't freeze OpenCode on; turning it off stores its own.
  const before = stored({ codex: true, cursor: true });
  const offCodex = accessToStore(before, setTool(effectiveAccess(before), "codex", false));
  expect(offCodex.tools.opencode).toBeUndefined();
  expect(accessToStore(before, setTool(effectiveAccess(before), "opencode", false)).tools.opencode).toBe(false);
});

function turnContext(root: string) {
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  // The agent's own home (`~/.opencode`), never the test machine's.
  process.env.HOME = path.join(root, "agent-home");
  for (const d of [ws, home, process.env.HOME]) mkdirSync(d, { recursive: true });
  return {
    home,
    ctx: {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      codex: {
        runnerHome: home,
        runs: new Map(),
        spawn: ((_, args, options) => spawn(process.execPath, [FAKE, ...args], options)) as Spawn,
      },
    },
  };
}

const turn = (over: Record<string, unknown> = {}) =>
  ({
    op: "brain.turn",
    runId: RUN,
    kind: "opencode",
    session: { id: SESSION, resume: false },
    cwd: "",
    system: "You are Dev, the team's developer.",
    prompt: "run the tests",
    mcp: { token: "tok_run" },
    agent: AGENT,
    ...over,
  }) as MachineRequest;

interface Logged {
  args: string[];
  message: string;
  dataHome: string | null;
  configHome: string | null;
  configDir: string | null;
  configEntries: string[];
  permission: string | null;
  anthropicKey: string | null;
  lspDownload: string | null;
  apiKey: string | null;
  config: string;
  projectConfig: string | null;
  run: string;
  token: string;
}
const logOf = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Logged);

test.skipIf(!posix)(
  "a fake OpenCode: the first turn starts a session with the context on standard input, the next resumes it",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx, home } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    const frames: { type: string; event?: CodexBrainEvent }[] = [];
    const scope = { signal: new AbortController().signal, output: () => {}, emit: (f: never) => frames.push(f) };
    const reply = (await handleRequest(ctx, turn(), scope as never)) as { final: CodexBrainEvent };
    expect(reply.final).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
    const events = frames.flatMap((f) => (f.type === "brain.event" && f.event ? [f.event] : []));
    expect(events.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name)).toEqual(["bash"]);
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      input: 1000,
      output: 40,
      source: "plan",
      cacheRead: 100,
    });
    expect(frames.at(-1)?.type).toBe("brain.done");

    const [first] = logOf(log);
    expect(first?.message).toBe("You are Dev, the team's developer.\n\nrun the tests");
    expect(first?.args).toEqual(["run", "--format", "json"]);
    expect(first).toMatchObject({ run: RUN, token: "tok_run", projectConfig: "1", apiKey: null });
    expect(first?.config).not.toContain("tok_run");
    expect(JSON.parse(first?.config ?? "{}").mcp[CODEX_MCP_SERVER].type).toBe("local");
    expect(JSON.parse(readFileSync(opencodeSessionsFile(home), "utf8"))).toEqual({ [SESSION]: "ses_fake0001" });

    await handleRequest(ctx, turn({ runId: RUN.replace(/1$/, "2"), prompt: "and now?" }), scope as never);
    const second = logOf(log)[1];
    expect(second?.args).toEqual(["run", "--format", "json", "--session", "ses_fake0001"]);
    expect(second?.message).toBe("and now?");
    // No model named: OpenCode's own choice for the title too. Named: the title is that model's, no other one paid.
    expect(JSON.parse(first?.config ?? "{}").small_model).toBeUndefined();
    await handleRequest(ctx, turn({ runId: RUN.replace(/1$/, "3"), model: "opencode/glm-5.3" }), scope as never);
    expect(JSON.parse(logOf(log)[2]?.config ?? "{}").small_model).toBe("opencode/glm-5.3");

    // A model that isn't provider/model is refused before anything runs.
    await expect(
      handleRequest(ctx, turn({ runId: RUN.replace(/1$/, "3"), model: "--help" }), scope as never),
    ).rejects.toMatchObject({ code: "bad_request" });
  },
  20_000,
);

test.skipIf(!posix)(
  "an account's turn: its folder and its sealed key; a printed key is redacted; gone, refused and limited",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    const accountDir = path.join(root, "accounts", "opencode", ACCOUNT);
    mkdirSync(accountDir, { recursive: true });
    writeFileSync(path.join(accountDir, "opencode-key.json"), JSON.stringify({ key: KEY }));
    const withAccounts = (dir: string | null) => ({
      ...ctx,
      codex: { ...ctx.codex, accounts: { accountDir: (kind: string) => (kind === "opencode" ? dir : null) } },
    });
    const scope = { signal: new AbortController().signal, output: () => {}, emit: () => {} };
    const run = async (over: Record<string, unknown>, c: object = withAccounts(accountDir)) =>
      (
        (await handleRequest(c as never, turn({ account: ACCOUNT, ...over }), scope as never)) as {
          final: CodexBrainEvent;
        }
      ).final;

    expect(await run({})).toMatchObject({ type: "done" });
    const used = logOf(log).at(-1);
    expect(used).toMatchObject({ dataHome: accountDir, apiKey: KEY });
    expect(JSON.parse(used?.config ?? "{}").provider.opencode.options.apiKey).toBe("{env:OPENCODE_API_KEY}");
    expect(used?.config).not.toContain(KEY);

    const seen: unknown[] = [];
    const printed = await handleRequest(
      withAccounts(accountDir) as never,
      turn({ account: ACCOUNT, runId: RUN.replace(/1$/, "4"), prompt: "ENV" }),
      { ...scope, emit: (f: unknown) => seen.push(f) } as never,
    );
    expect(JSON.stringify([seen, printed])).not.toContain(KEY);
    expect(JSON.stringify(seen)).toContain("OPENCODE_API_KEY");

    expect(await run({ runId: RUN.replace(/1$/, "5") }, withAccounts(null))).toEqual({
      type: "error",
      code: "account_missing",
      message: expect.stringContaining("OpenCode account"),
      retryable: false,
    });
    expect(await run({ runId: RUN.replace(/1$/, "6"), prompt: "BADKEY" })).toMatchObject({ code: "not_logged_in" });
    expect(await run({ runId: RUN.replace(/1$/, "7"), prompt: "LIMIT" })).toMatchObject({ code: "plan_limit" });
  },
  20_000,
);

test.skipIf(!posix)(
  "OpenCode reads no config but ours: its config folder emptied each turn, no inherited permission, ~/.opencode refused",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx, home } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    process.env.OPENCODE_PERMISSION = JSON.stringify({ bash: "allow", edit: "allow" });
    const configDir = opencodeConfigDir(home);
    // What an earlier `work` turn could have left there.
    mkdirSync(path.join(configDir, "plugin"), { recursive: true });
    mkdirSync(path.join(configDir, "node_modules"), { recursive: true });
    writeFileSync(path.join(configDir, "plugin", "x.js"), "export default {}");
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ mcp: { other: { type: "local" } } }));
    const scope = { signal: new AbortController().signal, output: () => {}, emit: () => {} };
    const final = async (over: Record<string, unknown>) =>
      ((await handleRequest(ctx, turn(over), scope as never)) as { final: CodexBrainEvent }).final;

    expect(await final({ permissions: { mode: "plan" } })).toMatchObject({ type: "done" });
    expect(logOf(log)[0]).toMatchObject({
      configHome: configDir,
      configDir,
      configEntries: ["node_modules"],
      permission: null,
      lspDownload: "1",
    });

    mkdirSync(path.join(process.env.HOME as string, ".opencode", "plugin"), { recursive: true });
    expect(await final({ runId: RUN.replace(/1$/, "2") })).toMatchObject({
      type: "error",
      code: "opencode_failed",
      message: expect.stringContaining("plugin"),
    });
    expect(logOf(log)).toHaveLength(1);
  },
  20_000,
);

test.skipIf(!posix)(
  "the free tier: no key from the runner's env, OpenCode's own provider alone, its models only",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-runner-key";
    const scope = { signal: new AbortController().signal, output: () => {}, emit: () => {} };
    await handleRequest(ctx, turn({ freeTier: true, model: "opencode/big-pickle" }), scope as never);
    const free = logOf(log)[0];
    expect(free?.anthropicKey).toBeNull();
    expect(JSON.parse(free?.config ?? "{}").enabled_providers).toEqual(["opencode"]);

    await handleRequest(ctx, turn({ runId: RUN.replace(/1$/, "2") }), scope as never);
    const own = logOf(log)[1];
    expect(own?.anthropicKey).toBe("sk-ant-fake-runner-key");
    expect(JSON.parse(own?.config ?? "{}").enabled_providers).toBeUndefined();

    await expect(
      handleRequest(
        ctx,
        turn({ runId: RUN.replace(/1$/, "3"), freeTier: true, model: "anthropic/claude-x" }),
        scope as never,
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
  },
  20_000,
);

test.skipIf(!posix)(
  "a session OpenCode lost is forgotten: the turn starts a new one, with the context",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx, home } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    mkdirSync(path.join(home, "brain"), { recursive: true });
    writeFileSync(opencodeSessionsFile(home), JSON.stringify({ [SESSION]: "ses_gone" }));
    const scope = { signal: new AbortController().signal, output: () => {}, emit: () => {} };
    const reply = (await handleRequest(ctx, turn({ prompt: "and now?" }), scope as never)) as {
      final: CodexBrainEvent;
    };
    expect(reply.final).toMatchObject({ type: "done" });
    const [, fresh] = logOf(log);
    expect(fresh?.args).toEqual(["run", "--format", "json"]);
    expect(fresh?.message).toBe("You are Dev, the team's developer.\n\nand now?");
    expect(JSON.parse(readFileSync(opencodeSessionsFile(home), "utf8"))).toEqual({ [SESSION]: "ses_fake0001" });
  },
  20_000,
);

test.skipIf(!posix)("OpenCode turned off refuses the turn", async () => {
  const root = tempDir("brain-opencode-");
  dirs.push(root);
  const { ctx } = turnContext(root);
  const tools = { claude: true, codex: true, opencode: false, commands: true };
  const off = { ...ctx, access: () => ({ folders: [], tools }) };
  const scope = { signal: new AbortController().signal, output: () => {}, emit: () => {} };
  await expect(handleRequest(off as never, turn(), scope as never)).rejects.toMatchObject({ code: "not_allowed" });
});

test.skipIf(!posix)("an OpenCode account is its sealed key: no key, no sign-in", async () => {
  const home = tempDir("opencode-accounts-");
  dirs.push(home);
  const m = new AccountManager({
    root: path.join(home, "accounts"),
    orgId: () => ORG,
    commands: { opencode: [process.execPath, FAKE] },
  });
  managers.push(m);
  const id = "0193eeee-0000-7000-8000-0000000000e1";
  await expect(m.begin("opencode", id)).rejects.toMatchObject({ code: "bad_request" });
  await expect(m.begin("opencode", id, false, undefined, "cursor")).rejects.toMatchObject({ code: "bad_request" });
  const begun = await m.begin("opencode", id, false, undefined, OPENCODE_KEY_PROVIDER);
  expect(begun.publicKey).toBeString();
  const aad = accountCodeAad(id, ORG);
  await expect(m.code(id, aad, await sealSecret(begun.publicKey as string, "short", aad))).rejects.toMatchObject({
    message: "That doesn't look like an OpenCode API key. Copy the whole key.",
  });
  await m.code(id, aad, await sealSecret(begun.publicKey as string, KEY, aad));
  expect(m.status(id).account).toMatchObject({ kind: "opencode", loggedIn: true, provider: "zen", keyHint: "0000" });
  expect(await opencodeKeyOf(path.join(home, "accounts", "opencode", id))).toBe(KEY);
  m.invalidate();
  expect((await m.list()).find((a) => a.id === id)).toMatchObject({ loggedIn: true, provider: "zen" });
});

// ── Protocol 41: the team's right hand on an OpenCode plan (ADR 0137 §4) ─────

test("a chat turn: every tool denied by `*` but our bridge's, its own agent, no plugins, the model as the default", () => {
  const chat = JSON.parse(opencodeConfig({ profile: "work", chat: { model: "opencode/glm-5.3" } }));
  expect(chat.permission).toEqual({ "*": "deny", [`${CODEX_MCP_SERVER}_*`]: "allow" });
  expect(Object.keys(chat.permission)).toEqual(["*", `${CODEX_MCP_SERVER}_*`]);
  expect(chat.model).toBe("opencode/glm-5.3");
  expect(Object.keys(chat.mcp)).toEqual([CODEX_MCP_SERVER]);
  expect(opencodeTurnArgs({ chat: true, model: "opencode/glm-5.3" })).toEqual([
    "run",
    "--format",
    "json",
    "--agent",
    "build",
    "--pure",
    "--model",
    "opencode/glm-5.3",
  ]);
  expect(OPENCODE_CHAT_PERMISSION["*"]).toBe("deny");
});

test("the guard reads `opencode debug agent`: any tool on but ours, a rule after ours, or no list, stops the turn", () => {
  const rule = (permission: string, action: string, pattern = "*") => ({ permission, pattern, action });
  // OpenCode 1.19.5's build agent: its defaults, ours, then the truncation folder it always appends.
  const ours = [
    rule("*", "allow"),
    rule("read", "ask", "*.env"),
    rule("*", "deny"),
    rule(`${CODEX_MCP_SERVER}_*`, "allow"),
    rule("external_directory", "allow", "/tmp/opencode/tool-output/*"),
  ];
  const answer = (tools: unknown, permission: unknown = ours) =>
    JSON.stringify({ name: "build", permission, tools }, null, 2);
  expect(opencodeToolsBreach(answer({ bash: false, read: false, [`${CODEX_MCP_SERVER}_post`]: true }))).toBeNull();
  expect(opencodeToolsBreach(answer({ bash: false, websearch: true }))).toContain("websearch");
  expect(opencodeToolsBreach(answer(undefined))).toContain("didn't list");
  expect(opencodeToolsBreach(answer({ bash: false }, null))).toContain("didn't list");
  expect(opencodeToolsBreach("")).toContain("didn't list");
  expect(opencodeToolsBreach(answer({ read: "maybe" }))).toContain("read");
  // An MCP server's tools never show in `tools`: a config read after ours that allows them stops the turn.
  expect(opencodeToolsBreach(answer({ bash: false }, [...ours, rule("corp_*", "allow")]))).toContain("corp_*");
  // A pattern denied after ours shows the tool again (`Permission.disabled` hides only a `*` deny).
  expect(opencodeToolsBreach(answer({ bash: false }, [...ours, rule("gh_*", "deny", "rm *")]))).toContain("gh_*");
  expect(opencodeToolsBreach(answer({ bash: false }, [...ours, rule("bash", "deny")]))).toBeNull();
  expect(opencodeToolsBreach(answer({ bash: false }, ours.slice(0, 2)))).toContain("*");
});

test.skipIf(!posix)(
  "a chat turn asks OpenCode for its tools first, in the agent's folder with the same config, and runs only when none is on",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    const scope = { signal: new AbortController().signal, output: () => {}, emit: () => {} };
    const chat = (n: number, over: Record<string, unknown> = {}) =>
      handleRequest(
        { ...ctx, grants: ["/somewhere/else"], secretsDir: path.join(root, "no-secrets") },
        turn({ runId: RUN.replace(/1$/, String(n)), cwd: "repos/acme/app", permissions: { mode: "chat" }, ...over }),
        scope as never,
      ) as Promise<{ final: CodexBrainEvent }>;
    // A tool a new version adds is off too: `*` denies it.
    process.env.FAKE_OPENCODE_EXTRA_TOOL = "computer";
    expect((await chat(1)).final).toMatchObject({ type: "done" });
    const [probe, run] = logOf(log) as unknown as [Logged & { probe?: boolean; cwd: string }, Logged & { cwd: string }];
    expect(probe?.probe).toBe(true);
    expect(probe?.args).toEqual(["debug", "agent", "build", "--pure"]);
    expect(probe?.config).toBe(run?.config);
    expect(probe?.cwd).toBe(run?.cwd);
    // Whatever folder the request names: the agent's own.
    expect(path.basename(run?.cwd ?? "")).toBe(`dev-${AGENT.id.slice(0, 8)}`);
    expect(run?.args).toEqual(["run", "--format", "json", "--agent", "build", "--pure"]);
    expect(JSON.parse(run?.config ?? "{}").permission).toEqual(OPENCODE_CHAT_PERMISSION);
    // Not the computer's `~/.claude/CLAUDE.md`.
    expect((run as unknown as { claudeCode: string | null }).claudeCode).toBe("1");

    // Another config allows a tool after ours: the turn stops before OpenCode runs it.
    process.env.FAKE_OPENCODE_ALLOW = "bash";
    const breached = await chat(2);
    expect(breached.final).toMatchObject({ type: "error", code: "tools_not_locked" });
    expect((breached.final as { message: string }).message).toContain("bash");
    // An MCP server another config adds and allows (its tools never in `debug agent`'s list): stopped too.
    process.env.FAKE_OPENCODE_ALLOW = "corp_*";
    expect((await chat(4)).final).toMatchObject({ type: "error", code: "tools_not_locked" });
    delete process.env.FAKE_OPENCODE_ALLOW;
    // A tool of OpenCode's own that runs anyway: the turn ends there, and what it read goes nowhere.
    process.env.FAKE_OPENCODE_RUN_BASH = "1";
    const events: CodexBrainEvent[] = [];
    const ran = (await handleRequest(
      { ...ctx, grants: ["/somewhere/else"] },
      turn({ runId: RUN.replace(/1$/, "5"), permissions: { mode: "chat" } }),
      { ...scope, emit: (f: { event?: CodexBrainEvent }) => f.event && events.push(f.event) } as never,
    )) as { final: CodexBrainEvent };
    expect(ran.final).toMatchObject({ type: "error", code: "tools_not_locked" });
    expect(events.filter((e) => e.type === "tool_call" || e.type === "text_delta")).toEqual([
      expect.objectContaining({ type: "text_delta", text: "Let me check." }),
    ]);
    delete process.env.FAKE_OPENCODE_RUN_BASH;
    // A probe that fails says nothing: the turn stops too.
    process.env.FAKE_OPENCODE_PROBE_FAIL = "1";
    expect((await chat(3)).final).toMatchObject({ type: "error", code: "tools_not_locked" });
    expect(logOf(log).filter((l) => !(l as { probe?: boolean }).probe)).toHaveLength(2);
  },
  20_000,
);
