// A fake `claude` for brain tests: speaks stream-json in and out like
// `claude -p --input-format stream-json --output-format stream-json`.
// Each start appends its argv, $CLAUDE_CONFIG_DIR, its folder, $ANTHROPIC_API_KEY,
// $ANTHROPIC_AUTH_TOKEN, the OAuth token it holds (`oauthToken`: read where
// $CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR says, as Claude Code does, or $CLAUDE_CODE_OAUTH_TOKEN),
// $CLAUDE_CODE_OAUTH_TOKEN itself (`oauthEnv`), the descriptor (`oauthFd`) and its `--settings`
// file's `env` and its `--append-system-prompt-file`'s text (`system`) to $FAKE_CLAUDE_LOG (one JSON line).
// Prompts drive it: "CRASH" exits mid-turn once (marker file in the log's
// folder), "SLOW" answers after 300 ms, "TOOL" calls one of our tools and one
// of its own, "LIMIT" hits the plan limit, "AUTH" fails to authenticate,
// "RATE" says the 5-hour window is at 84%, "COMPACT" compacts its history first (`compact_boundary`), "PWTOOL" runs a shell call with $AGENT_PW in its command; "STEER…" and "BGSELF" below (live
// steering, background tasks), "ECHOKEY" answers with $ANTHROPIC_AUTH_TOKEN and "ECHOTOKEN" with
// the OAuth token it holds (as an agent's shell could print them), "ECHOSPLIT" with that token in two
// deltas, each 150 ms before the next line, "KEY401" is refused by the endpoint and retries for good
// (as Claude Code 2.1.310 does, ten times with backoff), "ASKCONTROL" asks for an elicitation on stdout and answers
// with what it got back, "ECHOSHAPE" prints a token-shaped text in two deltas, "ECHOLONGSHAPE" one that goes on over
// three after its prefix, "KEY403" is forbidden by it (a model or account switched off). Control requests: `initialize`, and `get_usage`
// as $FAKE_CLAUDE_USAGE says ("" a Max plan's windows, "signed_out", "error",
// "hang": never).
// With `--json-schema` it is a route (`brain.route`): the prompt on stdin, one JSON result whose
// `structured_output` gives the schema's first handle 0.9, and a line with the system prompt and the
// prompt in the log. "SLOW_ROUTE" never answers, "BAD_ROUTE" answers no JSON.
// Without `--input-format` it is a background task (`task.start`): the prompt as plain text on stdin, one
// result, then it exits. Like Claude Code, it is signed in only with a token, a key, or a sign-in in its
// config folder ($CLAUDE_CONFIG_DIR, else ~/.claude: a `.credentials.json` there); otherwise its result is
// "Not logged in · Please run /login" (exit 1). "SLOWTASK" takes 30 s, "SLOWKEY" 3 s, "ECHOKEY" answers with
// $ANTHROPIC_AUTH_TOKEN, "NOSESSION" refuses its session flag after 1.5 s (exit 1).
import { appendFileSync, closeSync, existsSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = process.env.FAKE_CLAUDE_LOG;
// As Claude Code 2.1.314: a token on a descriptor is read at the start (up to a newline), which is then closed and
// its variable dropped.
const oauthFd = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR ?? null;
let fdToken = null;
if (oauthFd) {
  const fd = Number(oauthFd);
  const buf = Buffer.alloc(4096);
  let got = "";
  while (!got.includes("\n")) {
    const n = readSync(fd, buf);
    if (n === 0) break;
    got += buf.toString("utf8", 0, n);
  }
  closeSync(fd);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  fdToken = got.trim() || null;
}
const heldToken = fdToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
if (log) {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? null;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN ?? null;
  const oauthToken = heldToken;
  const oauthEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? null;
  const compactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? null;
  const autoMemoryOff = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null;
  const at = args.indexOf("--settings");
  let settingsEnv = null;
  try {
    settingsEnv = at >= 0 ? (JSON.parse(readFileSync(args[at + 1], "utf8")).env ?? null) : null;
  } catch {}
  const sysAt = args.indexOf("--append-system-prompt-file");
  let system = null;
  try {
    system = sysAt >= 0 ? readFileSync(args[sysAt + 1], "utf8") : null;
  } catch {}
  appendFileSync(
    log,
    `${JSON.stringify({ pid: process.pid, args, configDir, cwd: process.cwd(), apiKey, authToken, oauthToken, oauthEnv, oauthFd, baseUrl, settingsEnv, compactWindow, autoMemoryOff, system })}\n`,
  );
}
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flag("--json-schema") !== undefined) {
  await route();
  process.exit(0);
}
if (flag("--input-format") === undefined) await task();

async function task() {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const id = flag("--resume") ?? flag("--session-id") ?? "none";
  const say = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: id })}\n`);
  say({ type: "system", subtype: "init" });
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "/nonexistent", ".claude");
  const key = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  if (!heldToken && !key && !existsSync(path.join(home, ".credentials.json"))) {
    say({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    process.exit(1);
  }
  if (prompt.includes("SLOWTASK")) await new Promise((resolve) => setTimeout(resolve, 30_000));
  if (prompt.includes("SLOWKEY")) await new Promise((resolve) => setTimeout(resolve, 3000));
  if (prompt.includes("NOSESSION")) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    say({ type: "result", subtype: "error_during_execution", is_error: true, result: `No conversation found: ${id}` });
    process.exit(1);
  }
  const result = prompt.includes("ECHOKEY") ? `key ${key}` : `done: ${prompt.trim()}`;
  say({ type: "result", subtype: "success", is_error: false, result });
  process.exit(0);
}

async function route() {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const system = readFileSync(flag("--system-prompt-file"), "utf8");
  if (log) appendFileSync(log, `${JSON.stringify({ pid: process.pid, route: true, system, prompt })}\n`);
  if (prompt.includes("SLOW_ROUTE")) await new Promise((resolve) => setTimeout(resolve, 120_000));
  if (prompt.includes("BAD_ROUTE")) {
    process.stdout.write("Sorry, I can't help with that.\n");
    return;
  }
  const schema = JSON.parse(flag("--json-schema"));
  const handle = schema.properties?.scores?.items?.properties?.handle?.enum?.[0];
  const answer = { needs_agent: 0.9, scores: handle ? [{ handle, score: 0.9 }] : [], reason: "a fake route" };
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 3847,
      result: JSON.stringify(answer),
      structured_output: answer,
      usage: { input_tokens: 2, cache_read_input_tokens: 2597, cache_creation_input_tokens: 0, output_tokens: 750 },
      modelUsage: { "claude-haiku-5-5": { inputTokens: 2, outputTokens: 750 } },
    })}\n`,
  );
}
const session = flag("--resume") ?? flag("--session-id") ?? "none";
if (flag("--resume") && process.env.FAKE_CLAUDE_NO_SESSION) {
  process.stderr.write(`No conversation found with session ID: ${session}\n`);
  process.exit(1);
}
if (flag("--session-id") && process.env.FAKE_CLAUDE_SESSION_TAKEN) {
  process.stderr.write(`Session ID ${session} is already in use.\n`);
  process.exit(1);
}
const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, session_id: session })}\n`);
// $FAKE_CLAUDE_VERSION: the version its init line says (logs only).
const version = process.env.FAKE_CLAUDE_VERSION;
// $FAKE_CLAUDE_CAPS: its init `capabilities`, comma-separated (unset: none, an old CLI that can't be steered).
// With msg_lifecycle_v1 each line with a `uuid` says `command_lifecycle` queued → started (read) → completed.
const caps = process.env.FAKE_CLAUDE_CAPS ? process.env.FAKE_CLAUDE_CAPS.split(",") : null;
const lifecycle = caps?.includes("msg_lifecycle_v1") === true;
// $FAKE_CLAUDE_NO_RESULT_UUIDS: results never list what they read (only the lifecycle says it).
const resultUuids = !process.env.FAKE_CLAUDE_NO_RESULT_UUIDS;
const lifecycleOf = (uuid, state) => {
  if (lifecycle && uuid) out({ type: "command_lifecycle", command_uuid: uuid, state });
};
// Its init lists its tools as Claude Code does: `--tools` (absent: its own), our bridge's, and $FAKE_CLAUDE_EXTRA_TOOL
// (one a new version adds whatever `--tools` says). $FAKE_CLAUDE_NO_TOOL_LIST: no lists at all.
const mcpServers = (() => {
  try {
    return Object.keys(JSON.parse(readFileSync(flag("--mcp-config") ?? "", "utf8")).mcpServers ?? {});
  } catch {
    return [];
  }
})();
const toolsFlag = flag("--tools");
const initTools = [
  ...(toolsFlag === undefined ? ["Bash", "Read", "Edit"] : toolsFlag.split(",").filter(Boolean)),
  ...(mcpServers.includes("agentes") ? ["mcp__agentes__post_message"] : []),
  ...(process.env.FAKE_CLAUDE_EXTRA_TOOL ? [process.env.FAKE_CLAUDE_EXTRA_TOOL] : []),
];
// Claude Code says `init` as each turn starts.
const init = () =>
  out({
    type: "system",
    subtype: "init",
    model: flag("--model") ?? "claude-sonnet",
    ...(version ? { claude_code_version: version } : {}),
    ...(caps ? { capabilities: caps } : {}),
    ...(process.env.FAKE_CLAUDE_NO_TOOL_LIST
      ? {}
      : { tools: initTools, mcp_servers: mcpServers.map((name) => ({ name, status: "connected" })) }),
  });
init();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turns = 0;
// Lines wait here: a turn may read the ones sent while it runs ("STEER"), the rest start the next turns.
const queue = [];
let wake = null;
let closed = false;
let controlAnswer = null;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let control = null;
  try {
    control = JSON.parse(line);
  } catch {}
  if (control?.type === "control_request") return answerControl(control);
  if (control?.type === "control_response") {
    controlAnswer = control.response;
    wake?.();
    return;
  }
  queue.push(line);
  try {
    lifecycleOf(JSON.parse(line).uuid, "queued");
  } catch {}
  wake?.();
});
rl.on("close", () => {
  closed = true;
  wake?.();
});
const waitForLine = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  }).finally(() => {
    wake = null;
  });
(async () => {
  for (;;) {
    const line = queue.shift();
    if (line !== undefined) await answer(line);
    else if (closed) process.exit(0);
    else await waitForLine(60_000);
  }
})();

async function answer(line) {
  const msg = JSON.parse(line);
  const prompt = String(msg.message?.content ?? "");
  const read = msg.uuid ? [msg.uuid] : [];
  lifecycleOf(msg.uuid, "started");
  if (turns > 0) init();
  let steered = "";
  let moved = false;
  turns++;
  // "STEER": a tool runs, then the messages sent meanwhile are read at its boundary (same turn).
  // "STEERLATE": the turn ends before reading them (they start the next turn).
  // "STEERDROP": they vanish unread and nothing waits (a CLI that lost them).
  // "STEERBG": the tool runs as task bg1; a "now" message moves it to the background and is read at once;
  // after the result the task ends and the CLI runs a turn of its own ("background finished").
  // "STEERBGHANG": the moved task never ends.
  if (prompt.includes("STEER")) {
    const bg = prompt.includes("STEERBG");
    if (bg) {
      out({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: { command: "make" } }] },
        parent_tool_use_id: null,
      });
      out({ type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "s1", is_backgrounded: false });
    }
    if (queue.length === 0) await waitForLine(3000);
    if (prompt.includes("STEERDROP")) queue.length = 0;
    else if (!prompt.includes("STEERLATE")) {
      moved = bg && queue.some((l) => JSON.parse(l).priority === "now");
      if (!bg) {
        out({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: { command: "make" } }] },
          parent_tool_use_id: null,
        });
      }
      if (moved) out({ type: "system", subtype: "task_updated", task_id: "bg1", patch: { is_backgrounded: true } });
      out({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "s1", content: moved ? "moved to the background" : "built" }],
        },
        parent_tool_use_id: null,
      });
      while (queue.length) {
        const m = JSON.parse(queue.shift());
        if (m.uuid) read.push(m.uuid);
        lifecycleOf(m.uuid, "started");
        steered += ` +${m.priority ?? "-"}/${m.origin?.kind ?? "-"}: ${m.message?.content ?? ""}`;
      }
      // Read before the turn ends (the lifecycle says so first).
      await sleep(50);
    }
  }
  // "BGSELF": the model starts a task in the background itself; it ends after the turn, and the CLI
  // runs a turn of its own then, nobody asking ("stray").
  if (prompt.includes("BGSELF")) {
    out({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "serve" } }] },
      parent_tool_use_id: null,
    });
    out({ type: "system", subtype: "task_started", task_id: "self1", tool_use_id: "b1", is_backgrounded: true });
    out({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "running in the background" }] },
      parent_tool_use_id: null,
    });
  }
  // "SERVE": the model starts a dev server in the background; it runs until a later "UNSERVE" stops it.
  if (prompt.includes("SERVE") && !prompt.includes("UNSERVE")) {
    out({ type: "system", subtype: "task_started", task_id: "srv", tool_use_id: "v1", is_backgrounded: true });
  }
  if (prompt.includes("UNSERVE")) {
    out({ type: "system", subtype: "task_updated", task_id: "srv", patch: { status: "killed" } });
  }
  const marker = log ? path.join(path.dirname(log), "crashed") : "";
  if (prompt.includes("CRASH") && marker && !existsSync(marker)) {
    writeFileSync(marker, "");
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "par" } },
      parent_tool_use_id: null,
    });
    await sleep(20);
    process.exit(3);
  }
  // "DIES": every process dies saying why on stderr, as a Node crash ends (the line, its stack, Node's version).
  // "KILLED": the first does; the next is killed (SIGKILL) with nothing to say.
  if (marker && (prompt.includes("DIES") || prompt.includes("KILLED"))) {
    const killed = `${marker}-killed`;
    if (prompt.includes("KILLED") && existsSync(killed)) process.kill(process.pid, "SIGKILL");
    if (prompt.includes("KILLED")) writeFileSync(killed, "");
    process.stderr.write(
      "TypeError: Cannot read properties of undefined (reading 'x')\n    at run (/home/nina/app/cli.js:10:20)\n\nNode.js v22.11.0\n",
    );
    await sleep(20);
    process.exit(3);
  }
  if (prompt.includes("ASKCONTROL")) {
    out({
      type: "control_request",
      request_id: "c1",
      request: { subtype: "elicitation", message: "Paste your token" },
    });
    if (!controlAnswer) await waitForLine(3000);
  }
  if (prompt.includes("SLOW")) await sleep(300);
  if (prompt.includes("COMPACT")) out({ type: "system", subtype: "compact_boundary", parent_tool_use_id: null });
  if (prompt.includes("RATE")) {
    out({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.84,
        resetsAt: 1900000000,
      },
    });
  }
  if (prompt.includes("LIMIT")) {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1900000000 } });
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your limit",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return;
  }
  if (prompt.includes("KEY401")) {
    out({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 600,
      error_status: 401,
      error: "authentication_failed",
    });
    await sleep(60_000);
    return;
  }
  if (prompt.includes("KEY403")) {
    out({
      type: "assistant",
      parent_tool_use_id: null,
      error: "authentication_failed",
      message: { id: "msg_403", content: [{ type: "text", text: "API Error: 403" }] },
    });
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Account.Disabled"}}',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return;
  }
  if (prompt.includes("AUTH")) {
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return;
  }
  const half = Math.floor((heldToken ?? "").length / 2);
  const said = prompt.includes("ECHOKEY")
    ? [`token ${process.env.ANTHROPIC_AUTH_TOKEN} `, "printed"]
    : prompt.includes("ECHOTOKEN")
      ? [`token ${heldToken} `, "printed"]
      : prompt.includes("ECHOSPLIT")
        ? [`token ${heldToken?.slice(0, half)}`, `${heldToken?.slice(half)} printed`]
        : prompt.includes("ECHOSHAPE")
          ? ["token sk-ant-o", "at01-fakefakefake1234 printed"]
          : prompt.includes("ECHOLONGSHAPE")
            ? ["token sk-ant-oat01-fake", "fakefake", "fake1234 printed"]
            : ["Hello ", "world"];
  for (const text of said) {
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
    });
    if (/ECHOSPLIT|ECHOSHAPE|ECHOLONGSHAPE/.test(prompt)) await sleep(150);
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] }, parent_tool_use_id: null });
  if (prompt.includes("PWTOOL")) {
    // A shell call with $AGENT_PW written out in its command (a password with quotes and a backslash).
    out({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "p1", name: "Bash", input: { command: `login --pw '${process.env.AGENT_PW}'` } },
        ],
      },
      parent_tool_use_id: null,
    });
    out({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "p1", content: "ok" }] },
      parent_tool_use_id: null,
    });
  } else if (prompt.includes("TOOL")) {
    out({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "mcp__agentes__search_context", input: { query: "x" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
        ],
      },
      parent_tool_use_id: null,
    });
    out({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "found it" }] },
          { type: "tool_result", tool_use_id: "t2", content: "a.txt" },
        ],
      },
      parent_tool_use_id: null,
    });
  }
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result:
      prompt.includes("ECHOKEY") ||
      prompt.includes("ECHOTOKEN") ||
      prompt.includes("ECHOSPLIT") ||
      prompt.includes("ECHOSHAPE") ||
      prompt.includes("ECHOLONGSHAPE")
        ? said.join("")
        : prompt.includes("ASKCONTROL")
          ? `control ${controlAnswer?.subtype}: ${controlAnswer?.error}`
          : `echo ${turns}: ${prompt}${steered}`,
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 7 },
    modelUsage: { [flag("--model") ?? "claude-sonnet"]: { inputTokens: 10, outputTokens: 7 } },
    ...(read.length && resultUuids ? { user_message_uuid: read.at(-1), user_message_uuids: read } : {}),
    ...(version ? { queued_turn_count: queue.length } : {}),
  });
  for (const uuid of read) lifecycleOf(uuid, "completed");
  // "STEERBGHANG": the moved task never ends (a server): no notice, no turn of its own, ever.
  if (moved && prompt.includes("STEERBGHANG")) {
    // nothing
  }
  // "STEERBGSLOW": the moved task ends 800 ms after the result.
  else if (moved) await turnOfItsOwn("bg1", "background finished", 0, prompt.includes("STEERBGSLOW") ? 800 : 100);
  // Its own turn takes 300 ms ("BGSELFSTUCK": never ends).
  if (prompt.includes("BGSELF")) await turnOfItsOwn("self1", "stray", prompt.includes("BGSELFSTUCK") ? 60_000 : 300);
}

/** A control request on stdin, answered at once (`get_usage` as $FAKE_CLAUDE_USAGE says). */
function answerControl(req) {
  const reply = (subtype, body) =>
    process.stdout.write(
      `${JSON.stringify({ type: "control_response", response: { subtype, request_id: req.request_id, ...body } })}\n`,
    );
  const mode = process.env.FAKE_CLAUDE_USAGE ?? "";
  if (req.request?.subtype === "initialize") return reply("success", { response: { commands: [] } });
  if (req.request?.subtype !== "get_usage") return reply("error", { error: "not supported" });
  if (mode === "hang") return;
  if (mode === "error") return reply("error", { error: "get_usage failed" });
  if (mode === "signed_out") {
    return reply("success", { response: { subscription_type: null, rate_limits_available: false, rate_limits: null } });
  }
  reply("success", {
    response: {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2030-01-01T15:40:00.000Z" },
        seven_day: { utilization: 81.6, resets_at: "2030-01-04T10:00:00.000Z" },
        seven_day_opus: { utilization: 12, resets_at: null },
        seven_day_sonnet: null,
        model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: null }],
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      },
      behaviors: null,
    },
  });
}

/** A background task ends `after` ms on: its notice starts a turn nobody sent (it answers `text`, `ms` later). */
async function turnOfItsOwn(taskId, text, ms = 0, after = 100) {
  await sleep(after);
  out({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "completed" } });
  out({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed" });
  init();
  out({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
  });
  out({ type: "assistant", message: { content: [{ type: "text", text }] }, parent_tool_use_id: null });
  await sleep(ms);
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    usage: { input_tokens: 3, output_tokens: 2 },
    ...(version ? { queued_turn_count: queue.length } : {}),
  });
}
