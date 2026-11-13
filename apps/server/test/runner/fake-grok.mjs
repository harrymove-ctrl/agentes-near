// A fake Grok Build CLI (`grok`) for runner tests. Each start appends its argv, cwd and the env that matters (its
// home, the MCP run and token, the switches that keep other config out) to $FAKE_GROK_LOG (one JSON line).
// Signed in: `auth.json` in $GROK_HOME. `--version` prints Grok Build's version line, `models` its models (or "You are
// not authenticated." first when signed out), `logout` removes `auth.json`. `login --device-auth` prints an x.ai link
// and a code, then (after $FAKE_GROK_LOGIN_MS, default 200 ms) writes `auth.json` and exits 0.
// `-p <prompt> --output-format streaming-messages-json` prints one turn: init (the session: `--resume`'s, or a new
// one; `tools` and `mcp_servers` as `--tools` and config.toml make them, or $FAKE_GROK_TOOLS), text deltas, a shell
// call (none with "BRIDGE_ONLY"), a `use_tool` call to our bridge (to another server's with "OTHER_SERVER"), more
// text and the result with usage. Not signed in: an error result. "LIMIT": a usage-limit result. "ENV": the shell
// call prints the env. A `--resume` of a session it never made: "Session not found" on stderr, exit 1.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const env = process.env;
const home = env.GROK_HOME ?? path.join(env.HOME ?? "/nonexistent", ".grok");
const auth = path.join(home, "auth.json");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (env.FAKE_GROK_LOG) {
  appendFileSync(
    env.FAKE_GROK_LOG,
    `${JSON.stringify({
      args,
      cwd: process.cwd(),
      home: env.GROK_HOME ?? null,
      run: env.AGENTES_MCP_RUN ?? null,
      token: env.AGENTES_MCP_TOKEN ?? null,
      xaiKey: env.XAI_API_KEY ?? null,
      claudeMcps: env.GROK_CLAUDE_MCPS_ENABLED ?? null,
      updates: env.GROK_DISABLE_AUTOUPDATER ?? null,
    })}\n`,
  );
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[0] === "--version") {
  process.stdout.write("grok 1.0.34 (3736acbc8658) [stable]\n");
  process.exit(0);
}
if (args[0] === "models") {
  if (!existsSync(auth)) process.stdout.write("You are not authenticated.\n\n");
  process.stdout.write("Default model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n");
  process.exit(0);
}
if (args[0] === "logout") {
  rmSync(auth, { force: true });
  process.exit(0);
}
if (args[0] === "login") {
  process.stdout.write("To sign in, open https://accounts.x.ai/device on any device\nand enter the code: WDJB-MJHT\n");
  await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_GROK_LOGIN_MS ?? 200)));
  writeFileSync(auth, "{}");
  process.stdout.write("Signed in.\n");
  process.exit(0);
}

if (args[0] === "-p") {
  const prompt = args[1] ?? "";
  const resume = flag("--resume");
  const known = path.join(home, "fake-sessions.json");
  const sessions = existsSync(known) ? JSON.parse(readFileSync(known, "utf8")) : [];
  if (resume && !sessions.includes(resume)) {
    process.stderr.write(`Error: Session not found: ${resume}\n`);
    process.exit(1);
  }
  const session = resume ?? `9a0c0000-0000-4000-8000-${String(sessions.length + 1).padStart(12, "0")}`;
  if (!resume) writeFileSync(known, JSON.stringify([...sessions, session]));
  const allowed = flag("--tools");
  const tools = env.FAKE_GROK_TOOLS
    ? env.FAKE_GROK_TOOLS.split(",")
    : allowed
      ? allowed.split(",")
      : ["read_file", "run_terminal_command", "search_tool", "use_tool"];
  const config = existsSync(path.join(home, "config.toml")) ? readFileSync(path.join(home, "config.toml"), "utf8") : "";
  const servers = [...config.matchAll(/^\[mcp_servers\.([\w-]+)\]$/gm)].map((m) => ({
    name: m[1],
    status: "connected",
  }));
  const base = { session_id: session, uuid: "x" };
  out({ type: "system", subtype: "init", model: flag("--model") ?? "grok-4.6", tools, mcp_servers: servers, ...base });
  if (!existsSync(auth)) {
    out({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "",
      errors: ["You are not authenticated. Run grok login."],
      ...base,
    });
    process.exit(1);
  }
  if (prompt.includes("LIMIT")) {
    out({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "",
      errors: ["You've reached your weekly usage limit."],
      ...base,
    });
    process.exit(1);
  }
  const delta = (text) =>
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
      ...base,
    });
  const msg = (content) => ({
    type: "assistant",
    message: { id: "msg_1", role: "assistant", model: "grok-4.6", content },
    parent_tool_use_id: null,
    ...base,
  });
  const result = (id, text) => ({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] },
    parent_tool_use_id: null,
    ...base,
  });
  delta("Let me ");
  delta("check.");
  const calls = [];
  if (!prompt.includes("BRIDGE_ONLY")) {
    calls.push({
      type: "tool_use",
      id: "call_1",
      name: "run_terminal_command",
      input: { command: prompt.includes("ENV") ? "env" : "bun test" },
    });
  }
  const server = prompt.includes("OTHER_SERVER") ? "linear" : "agenteschat_agentes";
  calls.push({
    type: "tool_use",
    id: "call_2",
    name: "use_tool",
    input: { tool_name: `${server}__post_message`, arguments: {} },
  });
  out(msg([{ type: "text", text: "Let me check." }, ...calls]));
  for (const c of calls) {
    out(result(c.id, c.name === "use_tool" ? "posted" : prompt.includes("ENV") ? JSON.stringify(env) : "ok"));
  }
  delta(" All good.");
  out(msg([{ type: "text", text: " All good." }]));
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 2,
    result: "Let me check. All good.",
    usage: { input_tokens: 600, output_tokens: 40, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 },
    modelUsage: { [flag("--model") ?? "grok-4.6"]: { inputTokens: 600 } },
    ...base,
  });
  process.exit(0);
}
process.exit(2);
