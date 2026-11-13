// A fake OpenCode CLI (`opencode`) for runner tests. Each start appends its argv, cwd, piped message and the env
// that matters (XDG folders, key, config, MCP run and token) to $FAKE_OPENCODE_LOG (one JSON line).
// `--version` prints a semver, `models` OpenCode's free models (and a paid one when a key is in the config).
// `run --format json` reads the message from standard input and prints one turn's JSON lines: a text part, a bash
// call, a call to our MCP bridge, a second text part and two steps' tokens; `--session` resumes that session, else a
// new one. A message with "LIMIT": a rate limit error, exit 1. "BADKEY": a 401, exit 1. "ENV": the shell printing
// $OPENCODE_API_KEY. `--session ses_gone`: "Session not found", exit 1 (OpenCode lost that session).
import { appendFileSync, existsSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const env = process.env;
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "--version") {
  process.stdout.write("1.19.5\n");
  process.exit(0);
}
if (args[0] === "models") {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
  const paid = config.provider?.opencode ? "opencode/glm-5.3\n" : "";
  process.stdout.write(`opencode/big-pickle\nopencode/glm-5.3-flash-free\n${paid}`);
  process.exit(0);
}
// The config's `permission` as OpenCode 1.19.5 orders the build agent's rules: its defaults, the config's, then
// $FAKE_OPENCODE_ALLOW (a rule another config adds after ours, read last), then the truncation folder.
const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
const rules = [
  { permission: "*", pattern: "*", action: "allow" },
  { permission: "question", pattern: "*", action: "allow" },
  ...Object.entries(config.permission ?? {}).map(([permission, action]) => ({ permission, pattern: "*", action })),
  ...(env.FAKE_OPENCODE_ALLOW ? [{ permission: env.FAKE_OPENCODE_ALLOW, pattern: "*", action: "allow" }] : []),
  { permission: "external_directory", pattern: "/tmp/opencode/tool-output/*", action: "allow" },
];
const match = (id, p) => p === "*" || p === id || (p.endsWith("*") && id.startsWith(p.slice(0, -1)));
// `Permission.disabled`: hidden when the last rule naming it denies `*`.
const on = (id) => {
  const rule = rules.findLast((r) => match(id === "write" ? "edit" : id, r.permission));
  return !(rule?.pattern === "*" && rule.action === "deny");
};
// `debug agent <name>`: the agent's tools as OpenCode resolves them (its built-in ones, plus $FAKE_OPENCODE_EXTRA_TOOL,
// one a new version adds; MCP servers' tools are never listed) and its rules. $FAKE_OPENCODE_PROBE_FAIL: exit 1.
if (args[0] === "debug" && args[1] === "agent") {
  if (env.FAKE_OPENCODE_LOG) {
    appendFileSync(
      env.FAKE_OPENCODE_LOG,
      `${JSON.stringify({ probe: true, args, cwd: process.cwd(), config: env.OPENCODE_CONFIG_CONTENT ?? null })}\n`,
    );
  }
  if (env.FAKE_OPENCODE_PROBE_FAIL) {
    process.stderr.write("Error: No providers found\n");
    process.exit(1);
  }
  const ids = ["bash", "read", "edit", "write", "glob", "grep", "webfetch", "task", "todowrite", "skill"];
  if (env.FAKE_OPENCODE_EXTRA_TOOL) ids.push(env.FAKE_OPENCODE_EXTRA_TOOL);
  const tools = Object.fromEntries(ids.map((id) => [id, on(id)]));
  process.stdout.write(`${JSON.stringify({ name: args[2], mode: "primary", permission: rules, tools }, null, 2)}\n`);
  process.exit(0);
}
if (args[0] !== "run" || flag("--format") !== "json") {
  process.stderr.write(`fake opencode: unknown command ${args.join(" ")}\n`);
  process.exit(2);
}

let message = "";
for await (const chunk of process.stdin) message += chunk;
if (env.FAKE_OPENCODE_LOG) {
  appendFileSync(
    env.FAKE_OPENCODE_LOG,
    `${JSON.stringify({
      args,
      cwd: process.cwd(),
      message,
      dataHome: env.XDG_DATA_HOME ?? null,
      apiKey: env.OPENCODE_API_KEY ?? null,
      config: env.OPENCODE_CONFIG_CONTENT ?? null,
      projectConfig: env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
      configHome: env.XDG_CONFIG_HOME ?? null,
      configDir: env.OPENCODE_CONFIG_DIR ?? null,
      configEntries:
        env.XDG_CONFIG_HOME && existsSync(env.XDG_CONFIG_HOME) ? readdirSync(env.XDG_CONFIG_HOME).sort() : [],
      permission: env.OPENCODE_PERMISSION ?? null,
      anthropicKey: env.ANTHROPIC_API_KEY ?? null,
      lspDownload: env.OPENCODE_DISABLE_LSP_DOWNLOAD ?? null,
      claudeCode: env.OPENCODE_DISABLE_CLAUDE_CODE ?? null,
      run: env.AGENTES_MCP_RUN ?? null,
      token: env.AGENTES_MCP_TOKEN ?? null,
    })}\n`,
  );
}
if (flag("--session") === "ses_gone") {
  process.stderr.write("Error: Session not found\n");
  process.exit(1);
}
const sessionID = flag("--session") ?? "ses_fake0001";
const line = (type, data) => process.stdout.write(`${JSON.stringify({ type, timestamp: 1, sessionID, ...data })}\n`);
const error = (text) => {
  line("error", { error: { name: "APIError", data: { message: text } } });
  process.exit(1);
};
if (message.includes("LIMIT")) error("Rate limit exceeded: free usage limit reached, try again later");
if (message.includes("BADKEY")) error("401 Unauthorized: invalid api key");

line("step_start", { part: { type: "step-start" } });
if (message.includes("ENV")) {
  const out = `OPENCODE_API_KEY=${env.OPENCODE_API_KEY ?? ""}`;
  const state = { status: "completed", input: { command: "env" }, output: out };
  line("tool_use", { part: { type: "tool", tool: "bash", callID: "call_env", state } });
  line("text", { part: { type: "text", text: out, time: { start: 1, end: 2 } } });
  line("step_finish", { part: { type: "step-finish", tokens: { input: 5, output: 1 } } });
  process.exit(0);
}
line("text", { part: { type: "text", text: "Let me check.", time: { start: 1, end: 2 } } });
// The bash call only where the config leaves bash on, or always with $FAKE_OPENCODE_RUN_BASH (a guard that missed).
if (on("bash") || env.FAKE_OPENCODE_RUN_BASH) {
  line("tool_use", {
    part: {
      type: "tool",
      tool: "bash",
      callID: "call_1",
      state: { status: "completed", input: { command: "npm test" }, output: "2 passed\n" },
    },
  });
}
line("tool_use", {
  part: {
    type: "tool",
    tool: "agenteschat_agentes_search",
    callID: "call_2",
    state: { status: "completed", input: { q: "x" }, output: "found" },
  },
});
line("step_finish", {
  part: {
    type: "step-finish",
    cost: 0,
    tokens: { input: 800, output: 30, reasoning: 5, cache: { read: 100, write: 0 } },
  },
});
line("text", { part: { type: "text", text: "All good.", time: { start: 3, end: 4 } } });
line("step_finish", {
  part: { type: "step-finish", cost: 0, tokens: { input: 100, output: 5, cache: { read: 0, write: 0 } } },
});
process.exit(0);
