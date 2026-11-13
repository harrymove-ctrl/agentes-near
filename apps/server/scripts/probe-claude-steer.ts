/**
 * Probe: how the installed Claude Code takes a message written into a turn in
 * progress (live steering, protocol 15). Spawns `claude -p` with stream-json
 * in and out, sends a turn that runs `sleep 12` in Bash, writes a second user
 * line (our own `uuid`, a priority, a human origin) while the tool runs, and
 * prints what matters with the time since start:
 *
 * - `INIT`: the version and `capabilities` (what the runner decides support by:
 *   `msg_lifecycle_v1` = steerable, `interrupt_send_now_v1` = urgent "now").
 * - `command_lifecycle` per uuid (`queued` → `started` when the model picks the
 *   message up, the real read → `completed` at the turn's end).
 * - `task_*` system events (a Bash moved to the background by a "now" message,
 *   and the notice when it ends, which starts another turn on its own).
 * - Each `result` (`user_message_uuids`, `queued_turn_count`), and the runner's
 *   own parser on the same lines (`PARSED`: what would reach the engine).
 *
 * Uses this computer's Claude sign-in and plan; nothing else is called. Ends
 * on its own once the stream is quiet after a result (hard stop at 2 min).
 *
 *   bun apps/server/scripts/probe-claude-steer.ts [--priority next|now] [--model haiku]
 *     [--at 6000] [--cwd <dir>] [--claude <path>] [--raw]
 *
 * Findings (2026-10-23; 2.1.175, 2.1.220, 2.1.258, 2.1.259, 2.1.309):
 * - A line sent while Bash runs is read in the same turn after the tool, on every one of them.
 * - `capabilities` in `system/init`: absent on 2.1.175; `msg_lifecycle_v1` (and the lifecycle events) from
 *   2.1.220; `interrupt_send_now_v1` on 2.1.309.
 * - `result.user_message_uuids` from 2.1.259 only (2.1.258: `user_message_uuid`).
 * - `priority: "now"` + `origin: {kind: "human"}` with `interrupt_send_now_v1`: the running Bash goes to the
 *   background at once (`task_updated` `is_backgrounded`), the message is `started` within ~0.5 s, and when
 *   the task ends the CLI runs another turn by itself (`task_notification`, a second `result`).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { ClaudeStreamParser, claudeCapabilities, userMessageLine } from "../runner/brain";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
};
const priority = opt("priority", "next") as "next" | "now";
const model = opt("model", "haiku");
const injectAt = Number(opt("at", "6000"));
const cwd = opt("cwd", mkdtempSync(path.join(tmpdir(), "claude-steer-probe-")));
const claude = opt("claude", process.env.CLAUDE_BIN ?? "claude");
const raw = argv.includes("--raw");
const QUIET_MS = 15_000;
const HARD_STOP_MS = 120_000;

const child = spawn(
  claude,
  [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--session-id",
    randomUUID(),
    "--allowedTools",
    "Bash",
  ],
  { cwd, stdio: ["pipe", "pipe", "inherit"] },
);
const t0 = Date.now();
const log = (...parts: unknown[]) => console.log(String(Date.now() - t0).padStart(6), ...parts);
const short = (v: unknown, n = 300) => JSON.stringify(v)?.slice(0, n);
const parser = new ClaudeStreamParser();
parser.beginTurn();

let quiet: ReturnType<typeof setTimeout> | null = null;
let results = 0;
const stop = () => {
  log("CLOSING");
  child.stdin.end();
  setTimeout(() => child.kill("SIGKILL"), 5000).unref();
};
const hard = setTimeout(stop, HARD_STOP_MS);

(createInterface({ input: child.stdout }) as unknown as EventEmitter).on("line", (line: string) => {
  if (quiet) clearTimeout(quiet);
  quiet = null;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    log("RAW", line.slice(0, 200));
    return;
  }
  const subtype = typeof e.subtype === "string" ? e.subtype : "";
  if (e.type === "system" && subtype === "init") {
    log("INIT", short({ version: e.claude_code_version, capabilities: claudeCapabilities(e) }, 1000));
  } else if (e.type === "result") {
    log(
      "RESULT",
      short({
        result: e.result,
        user_message_uuids: e.user_message_uuids,
        user_message_uuid: e.user_message_uuid,
        queued_turn_count: e.queued_turn_count,
        subtype,
      }),
    );
  } else if (e.type === "assistant") {
    const content = (e.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
    log("ASSISTANT", short(content.map((c) => (c.type === "text" ? c.text : `${c.type}:${c.name ?? ""}`))));
  } else if (e.type === "user") {
    log("USER", short((e.message as { content?: unknown } | undefined)?.content, 160), e.uuid ?? "");
  } else if (e.type === "command_lifecycle" || (e.type === "system" && subtype.startsWith("task"))) {
    log(e.type === "system" ? subtype : "command_lifecycle", short(e, 400));
  } else if (raw && e.type !== "stream_event") {
    log(String(e.type), subtype, short(e, 400));
  }
  const parsed = parser.push(line);
  const events = parsed.events.filter((ev) => ev.type !== "text_delta");
  if (events.length || parsed.task || parsed.final) {
    log("PARSED", short({ events, task: parsed.task, final: parsed.final?.type }, 400));
  }
  if (parsed.final) {
    parser.beginTurn();
    results++;
  }
  // After a result, a quiet stream ends the probe (a background task's own turn keeps it talking).
  if (results > 0) quiet = setTimeout(stop, QUIET_MS);
});

child.stdin.write(
  userMessageLine(
    "Use the Bash tool to run exactly: sleep 12 && echo finished . Then reply with one short sentence about the output.",
  ),
);
const steerUuid = randomUUID();
setTimeout(() => {
  log("INJECT", priority, steerUuid);
  child.stdin.write(
    userMessageLine("Also: end your final answer with the word BANANA.", {
      uuid: steerUuid,
      priority,
      origin: { kind: "human" },
    }),
  );
}, injectAt);

(child as unknown as EventEmitter).on("exit", (code: number | null) => {
  log("EXIT", code);
  clearTimeout(hard);
  if (quiet) clearTimeout(quiet);
  process.exit(0);
});
