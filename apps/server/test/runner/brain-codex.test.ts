import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type MachineRequest, parseBrainEvent } from "@agenteschat/adapters";
import {
  CODEX_CHAT_CONFIG,
  CODEX_CHAT_OFF,
  type CodexBrainEvent,
  CodexEventMapper,
  CodexThreads,
  chatFolder,
  codexBridgeOverrides,
  codexChatBreach,
  codexContextOverride,
  codexEffort,
  codexProfileOf,
  codexThreadKey,
  codexThreadsFile,
  codexTurnArgs,
  codexVersionOk,
  handleCodexBrainTurn,
  runCodexTurn,
} from "../../runner/brain-codex";
import { handleRequest } from "../../runner/handlers";
import { CODEX_MCP_SERVER } from "../../runner/mcp";
import { agentWorkspace } from "../../runner/paths";
import type { Spawn } from "../../runner/scope-gate";
import { errorCode, removeDirs, tempDir, withContainersClient } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const RUN = "0193aaaa-0000-7000-8000-0000000000a1";
const SESSION = "0193cccc-0000-7000-8000-000000000001";
const THREAD = "01a1463b-6712-7b53-9f12-2499fb614d2d";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };

/** A real codex-cli 0.163.0 first turn, then a resumed one with a command and an edit. */
const TURN1 = [
  `{"type":"thread.started","thread_id":"${THREAD}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17806,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
];
const TURN2 = [
  `{"type":"thread.started","thread_id":"${THREAD}"}`,
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I’ll check the folder now."}}',
  `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"npm test\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \\"npm test\\"","aggregated_output":"2 passed\\n","exit_code":0,"status":"completed"}}`,
  '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"CWD/src/main.ts","kind":"update"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"mcp_tool_call","server":"agenteschat_agentes","tool":"search","arguments":{},"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Done: tests pass."}}',
  '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":4}}',
];

test("version gate: 0.163.0 and newer", () => {
  expect(codexVersionOk("codex-cli 0.163.0")).toBe(true);
  expect(codexVersionOk("codex-cli 0.170.1")).toBe(true);
  expect(codexVersionOk("codex-cli 0.99.0")).toBe(false);
  expect(codexVersionOk(undefined)).toBe(false);
});

test("command line: first turn with instructions, resume by id without them, options before resume", () => {
  const first = codexTurnArgs({
    cwd: "/w/my app",
    lastFile: "/r/last.txt",
    runId: RUN,
    model: "gpt-5.5",
    instructions: 'Be "brief".\nUse tools.',
    mcp: { command: ["/usr/bin/bun", "/r/runner.js"] },
  });
  expect(first.slice(0, 7)).toEqual([
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    "/w/my app",
    "--sandbox",
    "workspace-write",
  ]);
  // ADR 0053 §3: never the network (exec can't ask, so the sandbox is the limit).
  expect(first.join(" ")).not.toContain("network_access");
  expect(first).toContain(`developer_instructions=${JSON.stringify('Be "brief".\nUse tools.')}`);
  expect(first.slice(-5)).toEqual(["-m", "gpt-5.5", "-o", "/r/last.txt", "-"]);
  expect(first).not.toContain("resume");
  expect(first).not.toContain("--full-auto");

  const resumed = codexTurnArgs({ cwd: "/w/app", lastFile: "/l.txt", runId: RUN, instructions: "x", thread: THREAD });
  expect(resumed.slice(-5)).toEqual(["-o", "/l.txt", "resume", THREAD, "-"]);
  expect(resumed.some((a) => a.startsWith("developer_instructions="))).toBe(false);

  // A plan turn: a read-only sandbox (its writable roots don't apply).
  const plan = codexTurnArgs({
    cwd: "/w/app",
    lastFile: "/l.txt",
    runId: RUN,
    profile: "plan",
    writableRoots: ["/w/shared"],
  });
  expect(plan.slice(5, 7)).toEqual(["--sandbox", "read-only"]);
  expect(plan.join(" ")).not.toContain("writable_roots");
  expect(plan.join(" ")).not.toContain("network_access");
  expect(codexProfileOf({ permissions: { mode: "plan" } })).toBe("plan");
  expect(codexProfileOf({})).toBe("work");
});

test("MCP bridge overrides: stdio by run with the token through env_vars, or HTTP with a bearer from the env", () => {
  const key = `mcp_servers.${CODEX_MCP_SERVER}`;
  expect(codexBridgeOverrides({ runId: RUN, command: ["/usr/bin/bun", "/r/runner.js"] })).toEqual([
    `${key}.command="/usr/bin/bun"`,
    `${key}.args=["/r/runner.js","mcp","--run","${RUN}"]`,
    `${key}.env_vars=["AGENTES_MCP_TOKEN","AGENTES_MCP_SOCKET","AGENTES_RUNNER_HOME"]`,
    `${key}.default_tools_approval_mode="approve"`,
    `${key}.startup_timeout_sec=60`,
    `${key}.tool_timeout_sec=300`,
    `${key}.required=true`,
  ]);
  const http = codexBridgeOverrides({ runId: RUN, url: "https://agentes.chat/mcp/run" });
  expect(http.slice(0, 2)).toEqual([
    `${key}.url="https://agentes.chat/mcp/run"`,
    `${key}.bearer_token_env_var="AGENTES_MCP_TOKEN"`,
  ]);
  expect(http).toContain(`${key}.default_tools_approval_mode="approve"`);
  // The token itself is never on the command line (only the name of the env var that holds it).
  expect(JSON.stringify(http)).not.toContain("agr_");
});

test("events: commands and edits are executed tool calls, our bridge's calls aren't repeated, the last message wins", () => {
  const m = new CodexEventMapper({ cwd: "/w/app", model: "gpt-5.5", redact: (s) => s.replaceAll("2 passed", "[ok]") });
  const out = TURN2.map((l) => l.replace("CWD", "/w/app")).flatMap((l) => m.line(l));
  expect(m.thread).toBe(THREAD);
  expect(out).toEqual([
    {
      type: "tool_call",
      id: "item_1",
      name: "shell",
      input: { command: "npm test" },
      executed: { content: "[ok]\n" },
    },
    {
      type: "tool_call",
      id: "item_2",
      name: "file_change",
      input: { changes: [{ path: "src/main.ts", kind: "update" }] },
      executed: { content: "Changed src/main.ts (update)" },
    },
    { type: "usage", input: 200, output: 30, source: "plan", model: "gpt-5.5" },
  ]);
  expect(m.finish({ exitCode: 0, sessionId: SESSION })).toEqual([
    { type: "text_delta", text: "Done: tests pass." },
    { type: "done", text: "Done: tests pass.", session: { id: SESSION } },
  ]);
  // A failing or declined command is an error result.
  expect(
    new CodexEventMapper({ cwd: "/w" }).line(
      '{"type":"item.completed","item":{"id":"c","type":"command_execution","command":"git push","aggregated_output":"","exit_code":null,"status":"declined"}}',
    ),
  ).toMatchObject([{ executed: { content: "Not allowed by Codex's sandbox.", isError: true } }]);
});

test("turn end: failed turns, usage limits, a stream error with a bad exit, last.txt as the fallback answer", () => {
  const failed = new CodexEventMapper();
  failed.line('{"type":"turn.failed","error":{"message":"model overloaded"}}');
  expect(failed.finish({ exitCode: 1, sessionId: SESSION })).toEqual([
    { type: "error", code: "codex_failed", message: "model overloaded" },
  ]);
  const limited = new CodexEventMapper();
  limited.line('{"type":"error","message":"Reconnecting... 1/5"}');
  limited.line('{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again later."}}');
  expect(limited.finish({ exitCode: 1, sessionId: SESSION })).toEqual([
    { type: "limit" },
    { type: "error", code: "plan_limit", message: "You’ve hit your usage limit. Try again later.", worked: false },
  ]);
  // Cut after a command ran: the engine must not hand the rest to the API.
  const cut = new CodexEventMapper();
  cut.line(
    '{"type":"item.completed","item":{"id":"c","type":"command_execution","command":"git push","aggregated_output":"","exit_code":0,"status":"completed"}}',
  );
  cut.line('{"type":"turn.failed","error":{"message":"Your workspace is out of credits."}}');
  expect(cut.finish({ exitCode: 1, sessionId: SESSION }).at(-1)).toEqual({
    type: "error",
    code: "plan_limit",
    message: "Your workspace is out of credits.",
    worked: true,
  });
  // A workspace out of credits or at its spend cap is the plan's limit too.
  for (const message of ["Your workspace is out of credits.", "You've reached your workspace's spend cap."]) {
    const m = new CodexEventMapper();
    m.line(JSON.stringify({ type: "turn.failed", error: { message } }));
    expect(m.finish({ exitCode: 1, sessionId: SESSION })).toMatchObject([{ type: "limit" }, { code: "plan_limit" }]);
  }
  // An `error` event alone doesn't end a completed turn.
  const retried = new CodexEventMapper();
  retried.line('{"type":"error","message":"Reconnecting... 1/5"}');
  retried.line('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}');
  expect(retried.finish({ exitCode: 0, lastFile: "from file\n", sessionId: SESSION })).toEqual([
    { type: "text_delta", text: "from file" },
    { type: "done", text: "from file", session: { id: SESSION } },
  ]);
  const crashed = new CodexEventMapper();
  crashed.line('{"type":"error","message":"stream disconnected"}');
  expect(crashed.finish({ exitCode: 1, sessionId: SESSION })).toEqual([
    { type: "error", code: "codex_failed", message: "stream disconnected", retryable: true },
  ]);
});

test("threads survive a restart (file in the runner home)", () => {
  const home = tempDir("brain-home-");
  dirs.push(home);
  const file = codexThreadsFile(home);
  new CodexThreads(file).set(SESSION, THREAD);
  expect(new CodexThreads(file).get(SESSION)).toBe(THREAD);
  expect(new CodexThreads(file).get("other-session")).toBeUndefined();
});

/** A fake `codex`: records argv, stdin and the token it got, prints a real turn (the resumed one when asked). */
function fakeCodex(dir: string) {
  const bin = path.join(dir, "codex");
  const t1 = TURN1.join("\n");
  const t2 = TURN2.join("\n");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'n=$(ls "$FAKE_DIR" | grep -c "^args-")',
      'for a in "$@"; do printf "%s\\n" "$a"; done > "$FAKE_DIR/args-$n"',
      'cat > "$FAKE_DIR/prompt-$n"',
      'printf "%s" "$AGENTES_MCP_TOKEN" > "$FAKE_DIR/token-$n"',
      'case " $* " in',
      `  *" resume "*) cat <<'EOF'\n${t2.replaceAll("CWD", "/x")}\nEOF\n;;`,
      `  *) cat <<'EOF'\n${t1}\nEOF\n;;`,
      "esac",
      'echo "some MCP server failed to start" >&2',
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

test.skipIf(!posix)(
  "a fake codex: first turn starts a thread with the instructions, the next resumes it by id; secrets redacted",
  async () => {
    const root = tempDir("brain-codex-");
    dirs.push(root);
    const fake = path.join(root, "fake");
    const ws = path.join(root, "ws");
    const home = path.join(root, "home");
    for (const d of [fake, ws, home]) mkdirSync(d, { recursive: true });
    const bin = fakeCodex(fake);
    const folder = await agentWorkspace(ws, AGENT);
    mkdirSync(path.join(folder, "app"), { recursive: true });
    const events: CodexBrainEvent[] = [];
    const ctx = {
      folder,
      exec: true,
      runnerHome: home,
      mcp: { socketPath: path.join(home, "mcp.sock"), command: ["/usr/bin/env", "/r/runner.js"] },
      codexVersion: () => "codex-cli 0.163.0",
      bin,
    };
    const req = {
      runId: RUN,
      kind: "codex" as const,
      session: { id: SESSION, resume: false },
      cwd: "app",
      system: "You are Dev.",
      prompt: 'Say pong; it\'s "quoted" & $weird',
      mcp: { token: "tok_per_run" },
      agent: AGENT,
    };
    const signal = new AbortController().signal;
    // Codex inherits the runner's env: FAKE_DIR tells the fake where to record.
    process.env.FAKE_DIR = fake;
    try {
      await handleCodexBrainTurn(ctx, req, { signal, emit: (e) => events.push(e) });
      expect(events).toEqual([
        { type: "usage", input: 17806, output: 5, source: "plan", cacheRead: 6912 },
        { type: "text_delta", text: "pong" },
        { type: "done", text: "pong", session: { id: SESSION } },
      ]);
      const args1 = readFileSync(path.join(fake, "args-0"), "utf8").trim().split("\n");
      expect(args1).toContain(path.join(folder, "app"));
      expect(args1).toContain('developer_instructions="You are Dev."');
      expect(args1).toContain(`mcp_servers.${CODEX_MCP_SERVER}.args=["/r/runner.js","mcp","--run","${RUN}"]`);
      expect(args1).not.toContain("resume");
      expect(args1.at(-1)).toBe("-");
      expect(args1.join(" ")).not.toContain("tok_per_run");
      expect(readFileSync(path.join(fake, "prompt-0"), "utf8")).toBe(req.prompt);
      expect(readFileSync(path.join(fake, "token-0"), "utf8")).toBe("tok_per_run");
      expect(new CodexThreads(codexThreadsFile(home)).get(SESSION)).toBe(THREAD);
      // The turn's scratch folder is gone.
      expect(existsSync(path.join(home, "brain", "turns", RUN))).toBe(false);

      events.length = 0;
      await handleCodexBrainTurn(
        ctx,
        { ...req, runId: RUN.replace(/1$/, "2"), session: { id: SESSION, resume: true }, prompt: "run the tests" },
        { signal, emit: (e) => events.push(e) },
      );
      const args2 = readFileSync(path.join(fake, "args-1"), "utf8").trim().split("\n");
      expect(args2.slice(-3)).toEqual(["resume", THREAD, "-"]);
      expect(args2.some((a) => a.startsWith("developer_instructions="))).toBe(false);
      expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_call", "usage", "text_delta", "done"]);
      expect(events.at(-1)).toEqual({ type: "done", text: "Done: tests pass.", session: { id: SESSION } });
    } finally {
      delete process.env.FAKE_DIR;
    }
  },
  15_000,
);

test.skipIf(!posix)("refuses an old or missing Codex without starting it; bad requests fail", async () => {
  const root = tempDir("brain-codex-");
  dirs.push(root);
  const bin = path.join(root, "codex");
  writeFileSync(bin, `#!/bin/sh\ntouch "${root}/started"\n`);
  chmodSync(bin, 0o755);
  const events: CodexBrainEvent[] = [];
  const opts = {
    threads: new CodexThreads(path.join(root, "threads.json")),
    workDir: path.join(root, "turn"),
    emit: (e: CodexBrainEvent) => events.push(e),
    signal: new AbortController().signal,
    bin,
  };
  const input = { runId: RUN, sessionId: SESSION, cwd: root, system: "", prompt: "hi", mcp: { token: "t" } };
  await runCodexTurn(input, { ...opts, codexVersion: () => "codex-cli 0.162.0" });
  expect(events).toMatchObject([{ type: "error", code: "codex_too_old" }]);
  expect((events[0] as { message: string }).message).toContain("0.163.0");
  await runCodexTurn(input, { ...opts, codexVersion: () => undefined });
  expect(events[1]).toMatchObject({ type: "error", code: "codex_missing" });
  expect(existsSync(path.join(root, "started"))).toBe(false);
  // A codex that exits without a turn is an error, not an empty answer.
  await runCodexTurn(input, { ...opts, codexVersion: () => "codex-cli 0.163.0" });
  expect(existsSync(path.join(root, "started"))).toBe(true);
  expect(events[2]).toMatchObject({ type: "error", code: "codex_failed" });

  const ctx = { folder: root, exec: true, runnerHome: root, codexVersion: () => "codex-cli 0.163.0", bin };
  const req = {
    runId: RUN,
    kind: "codex" as const,
    session: { id: SESSION, resume: false },
    system: "",
    prompt: "hi",
    mcp: { token: "t" },
    agent: AGENT,
  };
  const scope = { signal: new AbortController().signal, emit: () => {} };
  expect(await errorCode(() => handleCodexBrainTurn({ ...ctx, exec: false }, req, scope))).toBe("exec_disabled");
  expect(await errorCode(() => handleCodexBrainTurn(ctx, { ...req, agent: undefined }, scope))).toBe("bad_request");
  expect(await errorCode(() => handleCodexBrainTurn(ctx, { ...req, mcp: { token: "" } }, scope))).toBe("bad_request");
  expect(await errorCode(() => handleCodexBrainTurn(ctx, { ...req, cwd: "nope" }, scope))).toBe("not_found");
});

// ── Accounts and effort (protocol 13, ADR 0041) ──────────────────────────────

const ACCOUNT = "0193ffff-0000-7000-8000-000000000002";

test("effort: model_reasoning_effort, with xhigh and max as high; nothing for an unknown level", () => {
  expect(["low", "medium", "high", "xhigh", "max"].map((e) => codexEffort(e as never))).toEqual([
    "low",
    "medium",
    "high",
    "high",
    "high",
  ]);
  const args = (effort?: string) =>
    codexTurnArgs({ cwd: "/w", lastFile: "/l.txt", runId: RUN, model: "gpt-5.5", effort: effort as never });
  const max = args("max");
  expect(max[max.indexOf('model_reasoning_effort="high"') - 1]).toBe("-c");
  expect(args("low")).toContain('model_reasoning_effort="low"');
  expect(args("turbo").some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
  expect(args().some((a) => a.startsWith("model_reasoning_effort"))).toBe(false);
  // Before resume and the stdin dash, like every option.
  expect(args("medium").slice(-1)).toEqual(["-"]);
});

test("speed: fast is the tier and its feature; any other turn clears a tier its thread kept", () => {
  const args = (speed?: string) =>
    codexTurnArgs({ cwd: "/w", lastFile: "/l.txt", runId: RUN, model: "gpt-6.1-sol", speed: speed as never });
  const fast = args("fast");
  expect(fast[fast.indexOf('service_tier="fast"') - 1]).toBe("-c");
  expect(fast[fast.indexOf("features.fast_mode=true") - 1]).toBe("-c");
  for (const other of [args("standard"), args("turbo"), args()]) {
    expect(other.some((a) => a.includes("service_tier"))).toBe(false);
    expect(other[other.indexOf("features.fast_mode=false") - 1]).toBe("-c");
  }
});

/**
 * A `codex` that fails as a provider's 400 comes back (exit 1) until the turn clears Fast. Leaving `service_tier` out
 * isn't enough, as with the real CLI: `exec resume` goes on with the tier the thread started with.
 */
function fastRefusingCodex(dir: string, refusal: string) {
  const bin = path.join(dir, "codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = login ]; then echo "$FAKE_LOGIN"; exit 0; fi',
      'n=$(ls "$FAKE_DIR" | grep -c "^args-")',
      'for a in "$@"; do printf "%s\\n" "$a"; done > "$FAKE_DIR/args-$n"',
      "cat > /dev/null",
      '[ "$FAKE_FAIL_ALWAYS" = 1 ] && n=x',
      'case "$n $*" in',
      "  x*) ;;",
      "  *features.fast_mode=false*)",
      `    cat <<'EOF'\n${JSON.stringify({ type: "item.completed", item: { id: "m", type: "agent_message", text: "pong" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\nEOF`,
      "    exit 0;;",
      "esac",
      `cat <<'EOF'\n${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n${JSON.stringify({ type: "turn.failed", error: { message: refusal } })}\nEOF`,
      "exit 1",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function fastTurn(
  refusal: string,
  o: { login?: string; failAlways?: boolean; account?: { id: string; home: string } } = {},
) {
  const root = tempDir("brain-codex-");
  dirs.push(root);
  const fake = path.join(root, "fake");
  mkdirSync(fake, { recursive: true });
  process.env.FAKE_DIR = fake;
  process.env.FAKE_LOGIN = o.login ?? "Logged in using ChatGPT";
  process.env.FAKE_FAIL_ALWAYS = o.failAlways ? "1" : "0";
  const events: CodexBrainEvent[] = [];
  await runCodexTurn(
    {
      runId: RUN,
      sessionId: SESSION,
      cwd: root,
      system: "",
      prompt: "hi",
      mcp: { token: "t" },
      speed: "fast",
      ...(o.account ? { account: o.account } : {}),
    },
    {
      threads: new CodexThreads(path.join(root, "threads.json")),
      workDir: path.join(root, "turn"),
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      bin: fastRefusingCodex(fake, refusal),
      codexVersion: () => "codex-cli 0.166.0",
    },
  );
  for (const key of ["FAKE_DIR", "FAKE_LOGIN", "FAKE_FAIL_ALWAYS"]) delete process.env[key];
  const argv = (n: number) =>
    existsSync(path.join(fake, `args-${n}`)) ? readFileSync(path.join(fake, `args-${n}`), "utf8").split("\n") : null;
  return { events, argv };
}

test.skipIf(!posix)(
  "Fast refused on exec: the same turn again at standard speed, once, and the reply still comes",
  async () => {
    const refusal = '{"error":{"message":"Fast mode is not available for this account.","param":"service_tier"}}';
    const { events, argv } = await fastTurn(refusal);
    expect(argv(0)).toContain('service_tier="fast"');
    expect(argv(1)).not.toContain('service_tier="fast"');
    expect(argv(1)).toContain("resume");
    expect(argv(2)).toBeNull();
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    const note = events.find((e) => e.type === "speed_fallback");
    expect(note).toEqual({ type: "speed_fallback", message: refusal });
    expect(parseBrainEvent(note)).toEqual(note as never);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "pong" });
  },
);

test.skipIf(!posix)("Fast fails on exec in words nobody knew: the reply still comes, with the note", async () => {
  const { events, argv } = await fastTurn("This account can't use that.");
  expect(argv(0)).toContain('service_tier="fast"');
  expect(argv(1)).toContain("features.fast_mode=false");
  expect(events.find((e) => e.type === "speed_fallback")).toBeDefined();
  expect(events.at(-1)).toMatchObject({ type: "done", text: "pong" });
});

test.skipIf(!posix)("a failure that isn't Fast's: one more try, then that failure, no note, no loop", async () => {
  const { events, argv } = await fastTurn("The model is overloaded.", { failAlways: true });
  expect(argv(1)).toContain("features.fast_mode=false");
  expect(argv(2)).toBeNull();
  expect(events.some((e) => e.type === "speed_fallback")).toBe(false);
  expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "codex_failed" });
});

test.skipIf(!posix)("a computer's own sign-in with an API key never asks for Fast", async () => {
  const { argv } = await fastTurn("unused", { login: "API key configured - fixture-***" });
  expect(argv(0)).not.toContain('service_tier="fast"');
  expect(argv(0)).toContain("features.fast_mode=false");
});

test.skipIf(!posix)("an account is a ChatGPT sign-in by itself: no need to ask", async () => {
  const root = tempDir("brain-codex-");
  dirs.push(root);
  const { argv } = await fastTurn("unused", { login: "API key configured", account: { id: "a1", home: root } });
  expect(argv(0)).toContain('service_tier="fast"');
});

test.skipIf(!posix)("a chat turn (the right hand) never carries the tier, whatever the request says", async () => {
  const root = tempDir("brain-codex-");
  dirs.push(root);
  const fake = path.join(root, "fake");
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  for (const d of [fake, ws, home]) mkdirSync(d, { recursive: true });
  process.env.FAKE_DIR = fake;
  try {
    const ctx = {
      folder: await agentWorkspace(ws, AGENT),
      exec: true,
      runnerHome: home,
      codexVersion: () => "codex-cli 0.166.0",
      bin: fakeCodex(fake),
    };
    const req = {
      runId: RUN,
      kind: "codex" as const,
      session: { id: SESSION, resume: false },
      system: "",
      prompt: "hi",
      mcp: { token: "t" },
      agent: AGENT,
      speed: "fast" as const,
      permissions: { mode: "chat" as const },
    };
    await handleCodexBrainTurn(ctx, req, { signal: new AbortController().signal, emit: () => {} });
    const args = readFileSync(path.join(fake, "args-0"), "utf8");
    expect(args).toContain("--ignore-user-config");
    expect(args).not.toContain("service_tier");
  } finally {
    delete process.env.FAKE_DIR;
  }
});

test("context limit (protocol 28): model_auto_compact_token_limit, nothing for a value out of range", () => {
  const args = (contextTokens?: unknown) =>
    codexTurnArgs({ cwd: "/w", lastFile: "/l.txt", runId: RUN, contextTokens: contextTokens as never });
  const limited = args(400_000);
  expect(limited[limited.indexOf("model_auto_compact_token_limit=400000") - 1]).toBe("-c");
  expect(limited.slice(-1)).toEqual(["-"]);
  for (const bad of [undefined, 10, 400_000.5, "400000", 50_000_000]) {
    expect(args(bad).some((a) => a.startsWith("model_auto_compact_token_limit"))).toBe(false);
  }
  expect(codexContextOverride(1_000_000)).toEqual(["-c", "model_auto_compact_token_limit=1000000"]);
});

test("a not-logged-in Codex is not_logged_in (the server marks the account signed out)", () => {
  const m = new CodexEventMapper({ cwd: "/w" });
  m.event({ type: "turn.failed", error: { message: "Not logged in. Run `codex login`." } });
  expect(m.finish({ exitCode: 1, sessionId: SESSION })).toEqual([
    { type: "error", code: "not_logged_in", message: "Not logged in. Run `codex login`.", retryable: true },
  ]);
});

test.skipIf(!posix)(
  "an account turn runs with CODEX_HOME at the account's folder and keeps its own thread; a missing one fails",
  async () => {
    const root = tempDir("brain-codex-");
    dirs.push(root);
    const fake = path.join(root, "fake");
    const ws = path.join(root, "ws");
    const home = path.join(root, "home");
    const accountDir = path.join(root, "account");
    for (const d of [fake, ws, home, accountDir]) mkdirSync(d, { recursive: true });
    const bin = path.join(fake, "codex");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `printf "%s" "$CODEX_HOME" > "${fake}/home"`,
        `printf "%s" "$CONTAINER_HOST$DOCKER_HOST$XDG_RUNTIME_DIR" > "${fake}/containers"`,
        `for a in "$@"; do printf "%s\\n" "$a"; done > "${fake}/args"`,
        "cat > /dev/null",
        `cat <<'EOF'\n${TURN1.join("\n")}\nEOF`,
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    const ctx = {
      folder: await agentWorkspace(ws, AGENT),
      exec: true,
      runnerHome: home,
      codexVersion: () => "codex-cli 0.163.0",
      bin,
      accounts: { accountDir: (kind: string, id: string) => (kind === "codex" && id === ACCOUNT ? accountDir : null) },
    };
    const req = {
      runId: RUN,
      kind: "codex" as const,
      session: { id: SESSION, resume: false },
      system: "You are Dev.",
      prompt: "hi",
      mcp: { token: "tok" },
      agent: AGENT,
      account: ACCOUNT,
      effort: "xhigh" as const,
    };
    const events: CodexBrainEvent[] = [];
    await withContainersClient(() =>
      handleCodexBrainTurn(ctx, req, { signal: new AbortController().signal, emit: (e) => events.push(e) }),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", text: "pong" });
    expect(readFileSync(path.join(fake, "home"), "utf8")).toBe(accountDir);
    // Its sandbox holds the turn, so the agent's containers service isn't named to it (ADR 0169).
    expect(readFileSync(path.join(fake, "containers"), "utf8")).toBe("");
    expect(readFileSync(path.join(fake, "args"), "utf8").split("\n")).toContain('model_reasoning_effort="high"');
    // The thread is this account's: the machine's own sign-in won't resume it.
    const threads = new CodexThreads(codexThreadsFile(home));
    expect(threads.get(codexThreadKey(SESSION, ACCOUNT))).toBe(THREAD);
    expect(threads.get(SESSION)).toBeUndefined();

    events.length = 0;
    rmSync(path.join(fake, "home"), { force: true });
    await handleCodexBrainTurn(
      { ...ctx, accounts: { accountDir: () => null } },
      { ...req, runId: RUN.replace(/1$/, "3") },
      { signal: new AbortController().signal, emit: (e) => events.push(e) },
    );
    expect(events).toMatchObject([{ type: "error", code: "account_missing", retryable: false }]);
    expect(existsSync(path.join(fake, "home"))).toBe(false);
  },
  15_000,
);

test.skipIf(!posix)(
  "a turn the handler dispatches starts in the checkout of the agent's own folder, never a folder nested in it",
  async () => {
    const root = tempDir("brain-codex-");
    dirs.push(root);
    const fake = path.join(root, "fake");
    const ws = path.join(root, "ws");
    const home = path.join(root, "home");
    for (const d of [fake, ws, home]) mkdirSync(d, { recursive: true });
    const bin = fakeCodex(fake);
    const folder = await agentWorkspace(ws, AGENT);
    // Where `prepareAgentCode` starts a turn: a checkout `git.sync` keeps in the agent's folder.
    mkdirSync(path.join(folder, "repos", "acme", "app"), { recursive: true });
    const req = {
      op: "brain.turn",
      runId: RUN,
      kind: "codex",
      session: { id: SESSION, resume: false },
      cwd: "repos/acme/app",
      system: "",
      prompt: "oi",
      mcp: { token: "tok" },
      agent: AGENT,
    } as MachineRequest;
    const ctx = {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      // Never the computer's own codex: the fake answers whatever the runner finds on the PATH.
      codex: { runnerHome: home, runs: new Map(), spawn: ((_, args, options) => spawn(bin, args, options)) as Spawn },
    };
    process.env.FAKE_DIR = fake;
    try {
      const reply = (await handleRequest(ctx, req, { signal: new AbortController().signal, output: () => {} })) as {
        final: CodexBrainEvent;
      };
      expect(reply.final.type === "error" ? reply.final.code : "done").not.toBe("not_found");
      expect(existsSync(path.join(folder, path.basename(folder)))).toBe(false);
    } finally {
      delete process.env.FAKE_DIR;
    }
  },
  15_000,
);

test("a chat turn (protocol 41): no user config nor rules, every feature that adds a tool off, read-only, no roots", () => {
  const args = codexTurnArgs({
    cwd: "/r/brain/chat/lodi",
    lastFile: "/l.txt",
    runId: RUN,
    instructions: "You are Lodi.",
    mcp: { command: ["/usr/bin/bun", "/r/runner.js"] },
    writableRoots: ["/w/shared"],
    profile: "work",
    chat: true,
  });
  expect(args.slice(0, 5)).toEqual([
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
  ]);
  for (const c of CODEX_CHAT_CONFIG) expect(args).toContain(c);
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "browser_use",
    "computer_use",
    "view_image",
  ]) {
    expect(CODEX_CHAT_OFF).toContain(feature as never);
  }
  const disabled = args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []));
  expect(disabled).toEqual([...CODEX_CHAT_OFF]);
  const sandbox = args.indexOf("--sandbox");
  expect(args[sandbox + 1]).toBe("read-only");
  expect(args.join(" ")).not.toContain("writable_roots");
  expect(args).toContain(`mcp_servers.${CODEX_MCP_SERVER}.required=true`);
});

test("a chat turn offers our bridge's tools outside code mode, whose host stays off", () => {
  const args = codexTurnArgs({ cwd: "/c", lastFile: "/l.txt", runId: RUN, mcp: {}, chat: true });
  const overrides = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
  const disabled = args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []));
  expect(overrides).toContain(`features.code_mode.direct_only_tool_namespaces=["mcp__${CODEX_MCP_SERVER}"]`);
  expect(disabled).toContain("code_mode_host");
});

test("a chat turn has no sub-agents: the catalog's collaboration tools are off", () => {
  const overrides = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
  const chat = codexTurnArgs({ cwd: "/c", lastFile: "/l.txt", runId: RUN, mcp: {}, chat: true });
  const work = codexTurnArgs({ cwd: "/c", lastFile: "/l.txt", runId: RUN, mcp: {} });
  expect(overrides(chat)).toContain("agents.enabled=false");
  expect(overrides(work)).not.toContain("agents.enabled=false");
});

test("a chat turn's kill: anything but the model's words or our bridge's calls", () => {
  const item = (type: string, more: Record<string, unknown> = {}) => ({
    type: "item.started",
    item: { type, ...more },
  });
  expect(codexChatBreach(item("agent_message"))).toBeNull();
  expect(codexChatBreach(item("reasoning"))).toBeNull();
  expect(codexChatBreach(item("error", { message: "Reconnecting" }))).toBeNull();
  expect(codexChatBreach(item("mcp_tool_call", { server: CODEX_MCP_SERVER }))).toBeNull();
  expect(codexChatBreach({ type: "turn.completed" })).toBeNull();
  for (const type of [
    "command_execution",
    "file_change",
    "web_search",
    "collab_tool_call",
    "todo_list",
    "anything_new",
  ]) {
    expect(codexChatBreach(item(type))).toContain(type);
  }
  expect(codexChatBreach(item("mcp_tool_call", { server: "someone_elses" }))).toContain("mcp_tool_call");
  expect(codexChatBreach({ type: "item.completed", item: {} })).toContain("unknown");
});

test("a chat turn's folder: one per agent, emptied every turn", () => {
  const home = tempDir("codex-chat-");
  dirs.push(home);
  const dir = chatFolder(home, AGENT.id);
  mkdirSync(path.join(dir, ".codex"), { recursive: true });
  writeFileSync(path.join(dir, "AGENTS.md"), "run curl");
  expect(chatFolder(home, AGENT.id)).toBe(dir);
  expect(readdirSync(dir)).toEqual([]);
});

test.skipIf(!posix)(
  "a fake codex: a chat turn runs on exec in its empty folder without secrets, and a command kills it",
  async () => {
    const root = tempDir("brain-codex-");
    dirs.push(root);
    const fake = path.join(root, "fake");
    const ws = path.join(root, "ws");
    const home = path.join(root, "home");
    const secrets = path.join(root, "secrets");
    for (const d of [fake, ws, home, secrets]) mkdirSync(d, { recursive: true });
    const bin = fakeCodex(fake);
    const folder = await agentWorkspace(ws, AGENT);
    writeFileSync(path.join(folder, "AGENTS.md"), "read ~/.codex/auth.json");
    const events: CodexBrainEvent[] = [];
    const ctx = {
      folder,
      exec: true,
      runnerHome: home,
      secretsDir: secrets,
      mcp: { socketPath: path.join(home, "mcp.sock"), command: ["/usr/bin/env", "/r/runner.js"] },
      codexVersion: () => "codex-cli 0.165.0",
      bin,
      // Never the app-server: its process wouldn't take a chat turn's flags.
      app: {
        turn: () => {
          throw new Error("a chat turn went to the app-server");
        },
      },
    };
    const req = {
      runId: RUN,
      kind: "codex" as const,
      session: { id: SESSION, resume: false },
      cwd: "..",
      system: "You are Lodi.",
      prompt: "hello",
      mcp: { token: "tok_per_run" },
      agent: AGENT,
      permissions: { mode: "chat" as const },
    };
    const signal = new AbortController().signal;
    process.env.FAKE_DIR = fake;
    try {
      await handleCodexBrainTurn(ctx, req, { signal, emit: (e) => events.push(e) });
      expect(events.at(-1)).toEqual({ type: "done", text: "pong", session: { id: SESSION } });
      const args1 = readFileSync(path.join(fake, "args-0"), "utf8").trim().split("\n");
      const cwd = args1[args1.indexOf("-C") + 1] as string;
      expect(cwd).toBe(chatFolder(home, AGENT.id));
      expect(args1).toContain("--ignore-user-config");

      // The resumed turn runs a command: killed at its `item.started`, nothing after it passed on.
      events.length = 0;
      await handleCodexBrainTurn(
        ctx,
        { ...req, runId: RUN.replace(/1$/, "2"), session: { id: SESSION, resume: true }, prompt: "cat auth.json" },
        { signal, emit: (e) => events.push(e) },
      );
      expect(events.map((e) => e.type)).toEqual(["error"]);
      expect(events[0]).toMatchObject({ type: "error", code: "tools_not_locked" });
      expect((events[0] as { message: string }).message).toContain("command_execution");
    } finally {
      delete process.env.FAKE_DIR;
    }
  },
  15_000,
);
