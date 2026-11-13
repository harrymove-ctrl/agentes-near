// A fake Antigravity CLI (`agy`) for runner tests. Each start appends its argv, cwd and the env that matters (its home,
// the MCP run and token, keys that must stay out) to $FAKE_AGY_LOG (one JSON line). Signed in: `fake-auth.json` in
// $HOME/.gemini/antigravity-cli. `--version` prints a version line, `models` the models as Antigravity CLI 1.5.0 does
// (seen on Linux, 2026-11-11): "Fetching available models..." on stderr, then one model a line on stdout, its slug and
// name split by a tab; signed out "Please sign in…", an account Google won't serve "Eligibility check failed…", exit 1.
// `acp --login` prints its Google sign-in link and prompt as 1.5.0 does and, as 1.5.x does, reads the pasted code only
// from its terminal (none: "no controlling terminal", exit 1), then exchanges it: a code with "bad" in it, or with paste
// marks it never turned on, is refused by Google (`invalid_grant`), one with "offline" can't reach Google, one with
// "ineligible" signs in an account `models` then refuses; else "Logged in as …", exit 0. `-p /usage` prints the
// quotas, `-p /logout` signs out. `-p <prompt> --output-format stream-json` prints one turn: init (the conversation:
// `--conversation`'s, or a new one when it doesn't know that one; its tools: our server's alone with `--agent`, else
// the CLI's own and ours, or $FAKE_AGY_TOOLS), a text delta, a shell step (none with "BRIDGE_ONLY"), a call to our
// server (a tool of the CLI's own with "OWN_TOOL"), the last delta with usage and the result. "LIMIT": an AGY_ERROR
// quota line on stderr and exit 3. "ENV": the shell step's output is the env.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const env = process.env;
const dir = path.join(env.HOME ?? "/nonexistent", ".gemini", "antigravity-cli");
const auth = path.join(dir, "fake-auth.json");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (env.FAKE_AGY_LOG) {
  appendFileSync(
    env.FAKE_AGY_LOG,
    `${JSON.stringify({
      args,
      cwd: process.cwd(),
      home: env.HOME ?? null,
      run: env.AGENTES_MCP_RUN ?? null,
      token: env.AGENTES_MCP_TOKEN ?? null,
      geminiKey: env.GEMINI_API_KEY ?? null,
      dbus: env.DBUS_SESSION_BUS_ADDRESS ?? null,
      updates: env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null,
    })}\n`,
  );
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[0] === "--version") {
  process.stdout.write("agy 1.4.12\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stderr.write("Fetching available models...\n");
  if (!existsSync(auth)) {
    process.stderr.write(
      "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
    );
    process.exit(1);
  }
  if (readFileSync(auth, "utf8").includes("ineligible")) {
    process.stderr.write(
      "Error: Eligibility check failed: PERMISSION_DENIED (code 403): The caller does not have permission\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    "gemini-4-argon-high\tGemini 4 Argon (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n",
  );
  process.exit(0);
}
if (args[0] === "acp" && args[1] === "--login") {
  process.stdout.write(
    "Open this link in a browser to log in with Google:\r\n\r\n  https://accounts.google.com/o/oauth2/auth?client_id=agy&state=s1\r\n\r\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\r\n",
  );
  if (!process.stdin.isTTY) {
    process.stderr.write("Error: no controlling terminal; cannot complete interactive login\n");
    process.exit(1);
  }
  let code = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    code += chunk;
    if (/[\r\n]/.test(code)) break;
  }
  if (!code.trim() || code.includes("\x1b") || code.includes("bad")) {
    process.stdout.write('\r\ncouldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Bad Request"\r\n');
    process.exit(1);
  }
  if (code.includes("offline")) {
    process.stdout.write(
      '\r\ncouldn\'t log in: token exchange failed: Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com: no such host\r\n',
    );
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(auth, code.includes("ineligible") ? '{"ineligible":true}' : "{}");
  process.stdout.write("Logged in as ana@example.com.\r\n");
  process.exit(0);
}
if (args[0] === "-p" && args[1] === "/usage") {
  process.stdout.write(
    "Model quotas\n\nGemini Models\nWeekly Limit Remaining\n75%\nFive Hour Limit Remaining\n40% · resets in 2h 30m\n\nClaude and GPT models\nWeekly Limit Remaining\n100%\n",
  );
  process.exit(0);
}
if (args[0] === "-p" && args[1] === "/logout") {
  rmSync(auth, { force: true });
  process.exit(0);
}

if (args[0] === "-p") {
  const prompt = args[1] ?? "";
  if (!existsSync(auth)) {
    process.stderr.write("Error: authentication required\n");
    process.exit(1);
  }
  const known = path.join(dir, "fake-conversations.json");
  const conversations = existsSync(known) ? JSON.parse(readFileSync(known, "utf8")) : [];
  let conversation = flag("--conversation");
  if (conversation && !conversations.includes(conversation)) {
    process.stderr.write(`warning: conversation ${conversation} not found, starting a new one\n`);
    conversation = undefined;
  }
  if (!conversation) {
    conversation = `c3b60000-0000-4000-8000-${String(conversations.length + 1).padStart(12, "0")}`;
    writeFileSync(known, JSON.stringify([...conversations, conversation]));
  }
  const tools = env.FAKE_AGY_TOOLS
    ? env.FAKE_AGY_TOOLS.split(",")
    : flag("--agent")
      ? ["agenteschat_agentes/post_message"]
      : ["ask_permission", "run_command", "write_to_file", "agenteschat_agentes/post_message"];
  const step = (o) => out({ event: "step_update", step_update: { conversation_id: conversation, ...o } });
  out({
    event: "init",
    conversation_id: conversation,
    init: {
      cwd: process.cwd(),
      tools,
      permission_mode: "request-review",
      ...(flag("--model") ? { model: flag("--model") } : {}),
    },
  });
  step({ step_index: 0, state: "DONE", step_type: "user_input" });
  if (prompt.includes("LIMIT")) {
    process.stderr.write(
      `AGY_ERROR: ${JSON.stringify({ status: "RESOURCE_EXHAUSTED", code: 429, retryable: true, message: "Quota exceeded for Gemini 4 Argon. Resets in 2h 5m." })}\n`,
    );
    out({ event: "result", result: { conversation_id: conversation, status: "ERROR", response: "", error: "quota" } });
    process.exit(3);
  }
  step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Let me check. " });
  if (!prompt.includes("BRIDGE_ONLY")) {
    step({
      step_index: 2,
      state: "DONE",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: {
        name: "run_command",
        parameters: { CommandLine: "bun test" },
        output: prompt.includes("ENV") ? JSON.stringify(env) : "3 pass\n",
      },
    });
  }
  const call = prompt.includes("OWN_TOOL") ? "view_file" : "agenteschat_agentes/post_message";
  step({
    step_index: 3,
    state: "DONE",
    step_type: "tool",
    tool_name: call,
    tool_info: { name: call, parameters: {}, output: "ok" },
  });
  step({
    step_index: 4,
    state: "DONE",
    step_type: "agent_response",
    text_delta: "All good.\n",
    usage: { input_tokens: 1000, output_tokens: 40, thinking_tokens: 30, cache_read_tokens: 400, total_tokens: 1040 },
  });
  out({
    event: "result",
    result: {
      conversation_id: conversation,
      status: "SUCCESS",
      response: "Let me check. All good.\n",
      num_turns: 1,
      usage: { input_tokens: 9000, output_tokens: 400, cache_read_tokens: 0, total_tokens: 9400 },
    },
  });
  process.exit(0);
}
process.exit(2);
