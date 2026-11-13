// A fake `codex` for the Codex brain tests: `exec --json` (one turn as JSONL)
// and `app-server` (the JSON-RPC subset the runner speaks, shapes as
// codex-cli 0.163.0's `codex app-server generate-ts`: one JSON object per
// line, no `jsonrpc` field).
// Each start and each request is appended to $FAKE_CODEX_LOG (JSON lines).
// $FAKE_CODEX_NO_APP: `app-server` is an unknown subcommand (an older CLI).
// The turn's prompt drives the app-server: "TOOLS" (a command, an edit, our
// bridge's call, a message whole and one streamed), "WAIT" (stays in progress
// until steered or interrupted), "WAIT_END" (ends the turn when steered, then
// refuses the steer as the real CLI does), "LIMIT" (usage limit), "CRASH"
// (exits mid-turn), "APPROVE <command>" (asks the runner to approve the
// command, answers with the decision), "APPROVE_FILE <path>" (the same for a
// change of that file), "RATE" (the plan's windows moved:
// `account/rateLimits/updated`), "LEAK" (quotes $FAKE_SECRET in two deltas apart), "FAST_REFUSED" (a turn with
// `serviceTier: "fast"` fails as the provider's refusal comes back); anything else answers "pong".
// `account/rateLimits/read` answers the 5 hours at 12% and the week at 55%.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const THREAD = "01a1463b-6712-7b53-9f12-2499fb614d2d";
const args = process.argv.slice(2);
if (args[0] === "login") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
const log = (o) => {
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(o)}\n`);
};
log({
  start: args[0],
  pid: process.pid,
  args,
  codexHome: process.env.CODEX_HOME ?? null,
  token: process.env.AGENTES_MCP_TOKEN ?? null,
  secret: process.env.FAKE_SECRET ?? null,
  openaiKey: process.env.OPENAI_API_KEY ?? null,
});

if (args[0] === "exec") {
  let prompt = "";
  process.stdin.on("data", (c) => {
    prompt += c.toString("utf8");
  });
  // $FAKE_CODEX_EXEC_MS: how long the turn takes.
  process.stdin.on("end", () =>
    setTimeout(
      () => {
        const line = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
        line({ type: "thread.started", thread_id: THREAD });
        line({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: `exec: ${prompt.trim()}` } });
        line({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
      },
      Number(process.env.FAKE_CODEX_EXEC_MS ?? 0),
    ),
  );
} else if (args[0] === "app-server") {
  if (process.env.FAKE_CODEX_NO_APP) {
    process.stderr.write("error: unrecognized subcommand 'app-server'\n");
    process.exit(2);
  }
  appServer();
} else {
  process.exit(2);
}

function appServer() {
  const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const note = (method, params) => send({ method, params });
  let initialized = false;
  let turns = 0;
  /** The turn in progress: { id, mode }. */
  let active = null;
  /** Requests sent to the runner (approvals), by id: what to do with its answer. */
  const asked = new Map();
  let askedIds = 0;
  const askRunner = (method, params, then) => {
    const id = `srv-${++askedIds}`;
    asked.set(id, then);
    send({ id, method, params });
  };
  /** The thread's token totals (a resumed thread starts with some). */
  const total = { input: 1000, cached: 400, output: 100 };

  const usage = (input, cached, output) => {
    const last = {
      totalTokens: input + output,
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0,
    };
    total.input += input;
    total.cached += cached;
    total.output += output;
    const t = {
      totalTokens: total.input + total.output,
      inputTokens: total.input,
      cachedInputTokens: total.cached,
      cacheWriteInputTokens: 0,
      outputTokens: total.output,
      reasoningOutputTokens: 0,
    };
    note("thread/tokenUsage/updated", {
      threadId: THREAD,
      turnId: active?.id,
      tokenUsage: { total: t, last, modelContextWindow: null },
    });
    // Codex says it again (rate limits): the turn's usage must not count it twice.
    note("thread/tokenUsage/updated", {
      threadId: THREAD,
      turnId: active?.id,
      tokenUsage: { total: t, last, modelContextWindow: null },
    });
  };
  const item = (kind, it) => note(kind, { item: it, threadId: THREAD, turnId: active?.id });
  const message = (id, text, streamed) => {
    item("item/started", { type: "agentMessage", id, text: "", phase: null });
    if (streamed) {
      for (const delta of [text.slice(0, 5), text.slice(5)]) {
        if (delta) note("item/agentMessage/delta", { threadId: THREAD, turnId: active?.id, itemId: id, delta });
      }
    }
    item("item/completed", { type: "agentMessage", id, text, phase: null });
  };
  const complete = (status, error = null) => {
    const id = active?.id;
    active = null;
    note("turn/completed", { threadId: THREAD, turn: { id, items: [], status, error } });
  };

  const handle = (req) => {
    const { id, method, params } = req;
    log({ rpc: method, params });
    const ok = (result) => send({ id, result });
    const fail = (message) => send({ id, error: { code: -32600, message } });
    if (method !== "initialize" && !initialized) return fail("Not initialized");
    switch (method) {
      case "initialize":
        initialized = true;
        return ok({
          userAgent: "fake/0.163.0",
          codexHome: process.env.CODEX_HOME ?? "/h",
          platformFamily: "unix",
          platformOs: "linux",
        });
      case "account/rateLimits/read":
        return ok({
          rateLimits: {
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1900000000 },
            secondary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1900500000 },
          },
        });
      case "thread/start":
        total.input = 0;
        total.cached = 0;
        total.output = 0;
        ok({ thread: { id: THREAD }, model: params.model ?? "gpt-5.5", cwd: params.cwd });
        return note("thread/started", { thread: { id: THREAD } });
      case "thread/resume":
        if (params.threadId !== THREAD) return fail(`no rollout found for thread id ${params.threadId}`);
        return ok({ thread: { id: THREAD }, model: params.model ?? "gpt-5.5", cwd: params.cwd });
      case "turn/start": {
        if (active) return fail("a turn is already running");
        const prompt = params.input.map((i) => i.text).join("\n");
        active = {
          id: `turn-${++turns}`,
          mode: /\bWAIT_END\b/.test(prompt) ? "wait_end" : /\bWAIT\b/.test(prompt) ? "wait" : "",
        };
        ok({ turn: { id: active.id, items: [], status: "inProgress", error: null } });
        note("turn/started", {
          threadId: THREAD,
          turn: { id: active.id, items: [], status: "inProgress", error: null },
        });
        const user = {
          type: "userMessage",
          id: `u-${turns}`,
          clientId: params.clientUserMessageId ?? null,
          content: params.input,
        };
        item("item/started", user);
        item("item/completed", user);
        if (/\bLEAK\b/.test(prompt)) {
          // Quotes $FAKE_SECRET in two deltas far enough apart that the runner sends a batch between them.
          const value = process.env.FAKE_SECRET ?? "";
          const text = `The key you asked about: ${value} ok`;
          item("item/started", { type: "agentMessage", id: "m-leak", text: "", phase: null });
          note("item/agentMessage/delta", {
            threadId: THREAD,
            turnId: active.id,
            itemId: "m-leak",
            delta: text.slice(0, 30),
          });
          return setTimeout(() => {
            note("item/agentMessage/delta", {
              threadId: THREAD,
              turnId: active.id,
              itemId: "m-leak",
              delta: text.slice(30),
            });
            item("item/completed", { type: "agentMessage", id: "m-leak", text, phase: null });
            usage(10, 0, 3);
            complete("completed");
          }, 60);
        }
        if (/\bCRASH\b/.test(prompt)) {
          message("m-crash", "half an answ", true);
          return setTimeout(() => process.exit(1), 20);
        }
        const approve = /\bAPPROVE(_FILE)?\s+(.+)$/.exec(prompt.trim());
        if (approve) {
          const file = Boolean(approve[1]);
          const what = (approve[2] ?? "").trim();
          const it = file
            ? {
                type: "fileChange",
                id: "f-ask",
                changes: [{ path: what, kind: { type: "update", move_path: null }, diff: "" }],
                status: "inProgress",
              }
            : {
                type: "commandExecution",
                id: "c-ask",
                command: `/bin/zsh -lc "${what}"`,
                cwd: params.cwd ?? "",
                processId: null,
                status: "inProgress",
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null,
              };
          item("item/started", it);
          const turnId = active.id;
          return askRunner(
            file ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval",
            {
              threadId: THREAD,
              turnId,
              itemId: it.id,
              reason: null,
              ...(file ? { grantRoot: null } : { command: it.command, cwd: it.cwd }),
            },
            (answer) => {
              const decision = answer.result?.decision ?? "none";
              log({ approval: { item: it.id, what, decision } });
              item("item/completed", { ...it, status: decision === "accept" ? "completed" : "declined" });
              message("m-ask", `decision: ${decision}`, true);
              usage(10, 0, 3);
              complete("completed");
            },
          );
        }
        if (/\bRATE\b/.test(prompt)) {
          note("account/rateLimits/updated", {
            rateLimits: {
              primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 1900000000 },
              secondary: null,
            },
          });
        }
        if (/\bFAST_REFUSED\b/.test(prompt) && params.serviceTier === "fast") {
          return complete("failed", {
            message: '{"error":{"message":"Fast mode is not available for this account.","param":"service_tier"}}',
            codexErrorInfo: "other",
            additionalDetails: null,
          });
        }
        if (/\bLIMIT\b/.test(prompt)) {
          note("error", {
            error: { message: "Reconnecting... 1/5", codexErrorInfo: null },
            willRetry: true,
            threadId: THREAD,
            turnId: active.id,
          });
          return complete("failed", {
            message: "You've hit your usage limit. Try again later.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          });
        }
        if (/\bTOOLS\b/.test(prompt)) {
          message("m-1", "I’ll check the folder now.", false);
          const cmd = {
            type: "commandExecution",
            id: "c-1",
            command: '/bin/zsh -lc "npm test"',
            cwd: params.cwd ?? "",
            processId: null,
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          item("item/started", cmd);
          item("item/completed", {
            ...cmd,
            status: "completed",
            aggregatedOutput: "2 passed\n",
            exitCode: 0,
            durationMs: 5,
          });
          item("item/completed", {
            type: "fileChange",
            id: "f-1",
            changes: [{ path: `${process.cwd()}/src/main.ts`, kind: { type: "update", move_path: null }, diff: "" }],
            status: "completed",
          });
          item("item/completed", {
            type: "mcpToolCall",
            id: "t-1",
            server: "agenteschat_agentes",
            tool: "search",
            status: "completed",
            arguments: {},
          });
          message("m-2", "Done: tests pass.", true);
          usage(200, 50, 30);
          return complete("completed");
        }
        if (active.mode) {
          message("m-wait", "Working on it", true);
          return;
        }
        message("m-pong", "pong", true);
        usage(17806, 6912, 5);
        return complete("completed");
      }
      case "turn/steer": {
        if (active?.mode === "wait_end") {
          // The turn ends before the steer is read: the CLI refuses it.
          message("m-end", "Finished before reading it.", true);
          usage(10, 0, 3);
          complete("completed");
          return fail("no active turn to steer");
        }
        if (!active) return fail("no active turn to steer");
        if (params.expectedTurnId !== active.id) {
          return fail(`expected active turn id \`${params.expectedTurnId}\` but found \`${active.id}\``);
        }
        ok({ turnId: active.id });
        // Read at its next model request: the input as a user message with our id.
        setTimeout(() => {
          const user = {
            type: "userMessage",
            id: `s-${params.clientUserMessageId}`,
            clientId: params.clientUserMessageId ?? null,
            content: params.input,
          };
          item("item/started", user);
          item("item/completed", user);
          message("m-steered", `Got it: ${params.input.map((i) => i.text).join(" ")}`, true);
          usage(300, 0, 20);
          complete("completed");
        }, 30);
        return;
      }
      case "turn/interrupt":
        if (!active || params.turnId !== active.id) return fail("no active turn to interrupt");
        ok({});
        return setTimeout(() => complete("interrupted"), 10);
      default:
        return send({ id, error: { code: -32601, message: `unknown method ${method}` } });
    }
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) handle(msg);
    else if (msg.method) log({ notify: msg.method });
    else if (msg.id !== undefined && asked.has(msg.id)) {
      const then = asked.get(msg.id);
      asked.delete(msg.id);
      then(msg);
    }
  });
  rl.on("close", () => process.exit(0));
}
