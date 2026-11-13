// A fake Cursor CLI (`agent`) for runner tests. Each start appends its argv, cwd and the env that matters
// (config folder, key, MCP run and token) to $FAKE_CURSOR_LOG (one JSON line).
// Signed in: $CURSOR_API_KEY, or `auth.json` in $CURSOR_CONFIG_DIR (else $HOME/.cursor).
// `--version` prints a dated version, `models` a few models (one included in the plan), `status` whether it is
// signed in, `logout` removes `auth.json`. `login` prints a cursor.com link, then (after $FAKE_CURSOR_LOGIN_MS,
// default 200 ms) writes `auth.json` and exits 0.
// `-p … <prompt>` prints stream-json for one turn: init (the chat: `--resume`'s, or a new one), three text deltas
// with a pre-tool flush, a shell call (none with "BRIDGE_ONLY" in the prompt), a call to our MCP bridge, the end-of-turn flush and the result with usage.
// Not signed in: "Authentication required" on stderr, exit 1. A prompt with "LIMIT": a usage limit, exit 1.
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const env = process.env;
const log = env.FAKE_CURSOR_LOG;
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({
      args,
      cwd: process.cwd(),
      configDir: env.CURSOR_CONFIG_DIR ?? null,
      apiKey: env.CURSOR_API_KEY ?? null,
      run: env.AGENTES_MCP_RUN ?? null,
      token: env.AGENTES_MCP_TOKEN ?? null,
    })}\n`,
  );
}
const config = env.CURSOR_CONFIG_DIR ?? path.join(env.HOME ?? "/nonexistent", ".cursor");
const auth = path.join(config, "auth.json");
const signedIn = () => Boolean(env.CURSOR_API_KEY) || existsSync(auth);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "--version") {
  process.stdout.write("2026.10.28-1a2b3c4\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(
    "Available models\n\ngrok-5-code - Grok 5 Code (included)\nclaude-opus-5-5 - Claude Opus 5.5\ngpt-6.1-sol - GPT-6.1 Sol (current)\n",
  );
  process.exit(0);
}
if (args[0] === "status") {
  if (signedIn()) {
    process.stdout.write("✓ Logged in as dev@example.com\n");
    process.exit(0);
  }
  process.stdout.write("Not logged in\n");
  process.exit(1);
}
if (args[0] === "logout") {
  rmSync(auth, { force: true });
  process.exit(0);
}
if (args[0] === "login") {
  process.stdout.write(
    "Open this link to sign in:\nhttps://cursor.com/loginDeepControl?challenge=fake-challenge&uuid=0193aaaa&mode=login\nWaiting…\n",
  );
  await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_CURSOR_LOGIN_MS ?? 200)));
  mkdirSync(config, { recursive: true });
  writeFileSync(auth, "{}");
  process.stdout.write("Logged in.\n");
  process.exit(0);
}

if (args[0] === "-p") {
  const prompt = args.at(-1) ?? "";
  if (!signedIn()) {
    process.stderr.write("Error: Authentication required. Please run 'agent login' first.\n");
    process.exit(1);
  }
  if (prompt.includes("LIMIT")) {
    process.stderr.write("You've hit your usage limit for this month. Upgrade your plan to continue.\n");
    process.exit(1);
  }
  const chat = flag("--resume") ?? "c0ffee00-0000-4000-8000-000000000001";
  const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  if (prompt.includes("ENV")) {
    // The agent's shell printing its env: the key shows in the tool's output and the answer.
    const out = `CURSOR_API_KEY=${env.CURSOR_API_KEY ?? ""}`;
    const success = { stdout: `${out}\n`, exitCode: 0 };
    const call = { shellToolCall: { args: { command: "env" }, result: { success } } };
    line({ type: "tool_call", subtype: "completed", call_id: "call_env", tool_call: call, session_id: chat });
    const msg = { role: "assistant", content: [{ type: "text", text: out }] };
    line({ type: "assistant", message: msg, session_id: chat, timestamp_ms: 1 });
    line({ type: "result", subtype: "success", is_error: false, result: out, session_id: chat });
    process.exit(0);
  }
  const text = (t, extra = {}) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: t }] },
    session_id: chat,
    ...extra,
  });
  line({
    type: "system",
    subtype: "init",
    apiKeySource: env.CURSOR_API_KEY ? "env" : "login",
    cwd: process.cwd(),
    session_id: chat,
    model: "Grok 5 Code",
    permissionMode: "default",
  });
  line({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, session_id: chat });
  line(text("Let me ", { timestamp_ms: 1 }));
  line(text("check.", { timestamp_ms: 2 }));
  line(text("Let me check.", { timestamp_ms: 3, model_call_id: "m1" }));
  const shell = { shellToolCall: { args: { command: "npm test" } } };
  // "BRIDGE_ONLY": a turn that calls our bridge alone.
  if (!prompt.includes("BRIDGE_ONLY")) {
    line({ type: "tool_call", subtype: "started", call_id: "call_1", tool_call: shell, session_id: chat });
    line({
      type: "tool_call",
      subtype: "completed",
      call_id: "call_1",
      tool_call: {
        shellToolCall: { args: { command: "npm test" }, result: { success: { stdout: "2 passed\n", exitCode: 0 } } },
      },
      session_id: chat,
    });
  }
  line({
    type: "tool_call",
    subtype: "completed",
    call_id: "call_2",
    tool_call: { mcpToolCall: { args: { name: "agenteschat_agentes-search" }, result: { success: { content: "x" } } } },
    session_id: chat,
  });
  line(text(" All good.", { timestamp_ms: 4 }));
  line(text("Let me check. All good."));
  line({
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1234,
    is_error: false,
    result: "Let me check. All good.",
    session_id: chat,
    usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 100 },
  });
  process.exit(0);
}

process.stderr.write(`fake cursor: unknown command ${args.join(" ")}\n`);
process.exit(2);
