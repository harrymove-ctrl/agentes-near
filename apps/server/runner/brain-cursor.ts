import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import type { AgentScope } from "@agenteschat/adapters/machine-protocol";
import { isAccountId } from "@agenteschat/adapters/machine-protocol";
import { redactSecrets } from "@agenteschat/adapters/secret-box";
import { ACCOUNT_MISSING_MESSAGE, accountEnv, cursorKeyOf, withoutContainers, withoutSignIns } from "./accounts";
import {
  CODEX_TOOL_OUTPUT_MAX,
  type CodexBrainEvent,
  CodexThreads,
  chatFolder,
  codexProfileOf,
  codexThreadKey,
} from "./brain-codex";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { CURSOR_BIN, resolveCommand } from "./executors";
import { CODEX_MCP_ENV, CODEX_MCP_SERVER, redactDeep } from "./mcp";
import { resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The Cursor branch of `brain.turn` (protocol 36, ADR 0114): one agent turn as
 * one run of Cursor's CLI (`agent -p --output-format stream-json`), its lines
 * turned into brain events. Flags as cursor.com/docs/cli/reference/parameters
 * and …/output-format list them (read 2026-11-01).
 *
 * - `agent -p --output-format stream-json --stream-partial-output --workspace
 *   <cwd> --trust --approve-mcps [--model m] [--resume <chat>] <prompt>`. The
 *   CLI documents no prompt on standard input, so the prompt is the last
 *   argument (an argv: nothing goes through a shell); the first turn of a
 *   chat leads it with the engine's context (Cursor has no system prompt flag).
 * - The chat: `system`/`init` names it (`session_id`); our session → that chat
 *   lives in `<runner home>/brain/cursor-chats.json` (per account, like Codex's
 *   threads). A runner that lost it starts a new chat (with the context again).
 * - ADR 0053 §3: `plan` is `--mode ask` (reads only); `work` is `--force` inside
 *   Cursor's sandbox (`--sandbox enabled`). Cursor asks nobody mid-turn in print
 *   mode, so whatever its sandbox refuses stays refused, as with `codex exec`.
 * - Our MCP bridge: Cursor reads `.cursor/mcp.json` from the workspace and its
 *   parents, so the agent's own folder holds our server's entry, rewritten every
 *   turn with ours alone (a turn could have added a server there); the run id
 *   and the token reach it through the env by `${env:…}` interpolation, never a
 *   file or argv. `--approve-mcps` approves every server Cursor finds, and an
 *   MCP server runs outside Cursor's sandbox, so it is passed only when the
 *   turn's folder is the agent's own folder or under it with no other
 *   `.cursor/mcp.json` on the way: a turn in a granted folder elsewhere runs
 *   without our bridge or anyone's. Our bridge's calls are not repeated as
 *   `tool_call`: the engine ran them.
 * - Events: `assistant` lines with `timestamp_ms` and no `model_call_id` are the
 *   text deltas (the other `assistant` lines repeat them); `tool_call`
 *   `completed` is an executed `tool_call` (transcript only); `result` ends the
 *   turn with the whole answer. A turn that streamed no delta (a CLI without
 *   partial output) sends that answer as one. Usage, when the CLI reports it,
 *   is the plan's (`source: "plan"`).
 * - No live steering: print mode takes nothing mid-turn, so messages wait for
 *   the turn's end (`brain.steer` answers `unsupported`).
 * - ADR 0041/0059: a turn with an `account` runs with that account's folder as
 *   Cursor's config folder (`accountEnv`), or its sealed `CURSOR_API_KEY`.
 */

/** The longest prompt argument: Linux refuses a single argument past 128 KiB (`MAX_ARG_STRLEN`). */
export const CURSOR_PROMPT_MAX = 120_000;
const KILL_GRACE_MS = 5000;

/** `brain.turn` with `kind: "cursor"`. */
export interface CursorBrainTurnRequest {
  runId: string;
  kind: "cursor";
  session: { id: string; resume: boolean };
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  account?: string;
  permissions?: { mode?: "plan" | "work" | "chat" };
  keepAlive?: boolean;
}

/** Where our session → Cursor chat ids live in the runner home. */
export const cursorChatsFile = (runnerHome: string) => path.join(runnerHome, "brain", "cursor-chats.json");

/** The env name the bridge's run id comes through (`${env:…}` in `.cursor/mcp.json`). */
export const CURSOR_RUN_ENV = "AGENTES_MCP_RUN";

/**
 * Our server's entry in Cursor's `mcp.json`: stdio (`agentes-runner mcp --run <run>`) or the bridge's URL with the
 * token as a bearer. Every value that changes per turn is an `${env:…}` reference.
 */
export function cursorMcpEntry(input: { command?: string[]; url?: string }): Record<string, unknown> {
  const env = (name: string) => `\${env:${name}}`;
  if (input.url) return { url: input.url, headers: { Authorization: `Bearer ${env(CODEX_MCP_ENV[0])}` } };
  const [command, ...args] = input.command ?? [];
  return {
    type: "stdio",
    command: command ?? "agentes-runner",
    args: [...args, "mcp", "--run", env(CURSOR_RUN_ENV)],
    env: Object.fromEntries(CODEX_MCP_ENV.map((name) => [name, env(name)])),
  };
}

/**
 * Project config a turn could plant in the agent's folder that would run or allow commands outside Cursor's
 * sandbox and our checks (ADR 0117): removed every turn, as Claude Code's work turns load no project settings.
 */
export const CURSOR_PLANTED = ["hooks.json", "cli.json"] as const;

/** Writes `<folder>/.cursor/mcp.json` with our server alone (written whole, then renamed), dropping `CURSOR_PLANTED`. */
export function writeCursorMcp(folder: string, entry: Record<string, unknown>) {
  const dir = path.join(folder, ".cursor");
  const file = path.join(dir, "mcp.json");
  mkdirSync(dir, { recursive: true });
  for (const name of CURSOR_PLANTED) rmSync(path.join(dir, name), { force: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ mcpServers: { [CODEX_MCP_SERVER]: entry } }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * A `chat` turn's `.cursor/cli.json` (protocol 41): every built-in tool Cursor documents denied (its shell, reads and
 * writes in the workspace and anywhere else, the web), as cursor.com/docs/cli/reference/permissions lists them (read
 * 2026-11-04). A deny wins over any allow the account's own config has. MCP tools can't be denied but for ours (a
 * deny wins over our allow too): the runner kills the turn on any other (`cursorChatBreach`).
 */
export const CURSOR_CHAT_PERMISSIONS = {
  permissions: {
    // Ours, said outright: a print-mode turn without `--force` may otherwise hold an MCP call for an approval.
    allow: [`Mcp(${CODEX_MCP_SERVER}:*)`],
    deny: [
      "Shell(*)",
      "Shell(*:*)",
      "Read(**)",
      "Read(/**)",
      "Read(~/**)",
      "Write(**)",
      "Write(/**)",
      "Write(~/**)",
      "WebFetch(*)",
    ],
  },
};

/**
 * The runtime kill of a `chat` turn: a `tool_call` (started or completed) that isn't a call to our bridge
 * (`mcpToolCall` named `<server>-<tool>` or from our `providerIdentifier`, or a `function` named for our server) is a
 * breach. Null for anything else.
 */
export function cursorChatBreach(ev: Record<string, unknown>): string | null {
  if (ev.type !== "tool_call") return null;
  const call = isRecord(ev.tool_call) ? ev.tool_call : {};
  const key = Object.keys(call)[0] ?? "";
  const body = isRecord(call[key]) ? (call[key] as Record<string, unknown>) : {};
  const args = isRecord(body.args) ? body.args : {};
  const name = key === "function" ? str(body.name) : str(args.name);
  const ours =
    name.startsWith(`${CODEX_MCP_SERVER}-`) ||
    name.startsWith(`mcp_${CODEX_MCP_SERVER}`) ||
    (key === "mcpToolCall" && str(args.providerIdentifier) === CODEX_MCP_SERVER);
  if ((key === "mcpToolCall" || key === "function") && ours) return null;
  return `Cursor used a tool of its own (${(key.replace(/ToolCall$/, "") || "unknown").slice(0, 64)}), so the turn stopped.`;
}

/** Whether `--approve-mcps` may go: `cwd` is `folder` or under it, with no `.cursor/mcp.json` but ours on the way. */
export function cursorMayApproveMcps(folder: string, cwd: string): boolean {
  const rel = path.relative(folder, cwd);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  for (let dir = cwd; dir !== folder; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".cursor", "mcp.json"))) return false;
  }
  return true;
}

/** The prompt argument: a new chat's leads with the engine's context, cut in its middle past `CURSOR_PROMPT_MAX`. */
export function cursorPrompt(system: string, prompt: string, newChat: boolean): string {
  const context = newChat ? system.trim() : "";
  const room = CURSOR_PROMPT_MAX - prompt.length - 2;
  // ponytail: a context past the argument limit loses its middle; a rules file per chat if real contexts get there.
  const fitted =
    context.length <= room
      ? context
      : room > 2000
        ? `${context.slice(0, Math.floor(room / 2) - 1)}\n…\n${context.slice(context.length - Math.floor(room / 2) + 2)}`
        : "";
  return (fitted ? `${fitted}\n\n${prompt}` : prompt).slice(-CURSOR_PROMPT_MAX);
}

/** The `agent` arguments for one turn. */
export function cursorTurnArgs(input: {
  cwd: string;
  prompt: string;
  chat?: string;
  model?: string;
  profile?: CommandProfile;
  approveMcps?: boolean;
  /** Protocol 41: the team's right hand, in ask mode inside Cursor's sandbox and never `--force`. */
  locked?: boolean;
}): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    input.cwd,
    "--trust",
    // The CLI would otherwise download its own updates into each agent's home (CURSOR_CONFIG_DIR) on a turn.
    "--disable-auto-update",
    ...(input.approveMcps ? ["--approve-mcps"] : []),
    ...(input.locked
      ? ["--mode", "ask", "--sandbox", "enabled"]
      : input.profile === "plan"
        ? ["--mode", "ask"]
        : ["--force", "--sandbox", "enabled"]),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.chat ? ["--resume", input.chat] : []),
    input.prompt,
  ];
}

const USAGE_LIMIT =
  /usage limit|rate limit|quota|out of (?:credits|usage|requests)|spend(?:ing)? limit|upgrade your plan/i;
/** Cursor can't authenticate (signed out, a revoked key). */
export const CURSOR_AUTH = /not (?:logged in|authenticated)|agent login|invalid api key|authentication required/i;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `cursor_failed`. */
export function cursorProblem(problem: string, worked = false): CodexBrainEvent[] {
  if (USAGE_LIMIT.test(problem))
    return [{ type: "limit" }, { type: "error", code: "plan_limit", message: problem, worked }];
  if (CURSOR_AUTH.test(problem)) return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "cursor_failed", message: problem, retryable: true }];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (text: string) =>
  text.length > CODEX_TOOL_OUTPUT_MAX ? `${text.slice(0, CODEX_TOOL_OUTPUT_MAX)}\n…` : text;

/** Cursor's own tool call (`readToolCall`, `shellToolCall`, `function`…) as an executed `tool_call`; null for MCP calls. */
export function cursorToolCall(
  id: string,
  call: Record<string, unknown>,
  clean: (text: string) => string,
): CodexBrainEvent | null {
  const key = Object.keys(call)[0];
  if (!key) return null;
  const body = isRecord(call[key]) ? (call[key] as Record<string, unknown>) : {};
  const fn = key === "function" ? str(body.name) : "";
  // Our bridge's calls (and any MCP server's): the engine records ours itself.
  if (/^mcp/i.test(key) || fn.startsWith(CODEX_MCP_SERVER) || fn.startsWith("mcp_")) return null;
  const name = (fn || key.replace(/ToolCall$/, "")).slice(0, 128) || "tool";
  let input: unknown = body.args ?? {};
  if (key === "function") {
    try {
      input = JSON.parse(str(body.arguments) || "{}");
    } catch {
      input = { arguments: clean(str(body.arguments)) };
    }
  }
  if (isRecord(input) && typeof input.fileText === "string") input = { ...input, fileText: undefined };
  input = redactDeep(input, clean);
  const result = isRecord(body.result) ? body.result : {};
  const success = result.success;
  const failure = result.error ?? result.failure ?? result.rejected;
  const text =
    failure !== undefined
      ? str(isRecord(failure) ? (failure.message ?? failure.error) : failure) || "The tool failed."
      : isRecord(success)
        ? str(success.content) ||
          [str(success.stdout), str(success.stderr)].filter(Boolean).join("\n") ||
          (str(success.path) ? `Wrote ${str(success.path)}` : JSON.stringify(success))
        : typeof success === "string"
          ? success
          : "";
  const exit = isRecord(success) && typeof success.exitCode === "number" ? success.exitCode : 0;
  return {
    type: "tool_call",
    id,
    name,
    input,
    executed: { content: cut(clean(text)), ...(failure !== undefined || exit !== 0 ? { isError: true } : {}) },
  };
}

/** `agent -p --output-format stream-json` lines → brain events, plus what the turn's end needs. */
export class CursorEventMapper {
  chat?: string;
  model?: string;
  answer?: string;
  streamed = "";
  /** Redacted text kept back from the last delta (`hold`), so a secret split between deltas never leaves in pieces. */
  private tail = "";
  completed = false;
  failed?: string;
  /** The turn used a tool: a cut now loses work. */
  private worked = false;

  constructor(
    private readonly opts: {
      model?: string;
      redact?: (text: string) => string;
      /** Streamed text holds back this many characters (the longest secret − 1). */
      hold?: number;
    } = {},
  ) {}

  /** The text so far as a delta; `whole` false keeps back the last `hold` characters for the next one. */
  private flush(text: string, whole: boolean): CodexBrainEvent[] {
    if (!text && !(whole && this.tail)) return [];
    const out = this.clean(this.tail + text);
    const cut = whole ? out.length : Math.max(0, out.length - (this.opts.redact ? (this.opts.hold ?? 0) : 0));
    this.tail = out.slice(cut);
    if (cut === 0) return [];
    this.streamed += out.slice(0, cut);
    return [{ type: "text_delta", text: out.slice(0, cut) }];
  }

  private clean(text: string) {
    return this.opts.redact ? this.opts.redact(text) : text;
  }

  line(raw: string): CodexBrainEvent[] {
    const text = raw.trim();
    if (!text.startsWith("{")) return [];
    try {
      const ev = JSON.parse(text) as unknown;
      return isRecord(ev) ? this.event(ev) : [];
    } catch {
      return [];
    }
  }

  event(ev: Record<string, unknown>): CodexBrainEvent[] {
    if (str(ev.session_id)) this.chat = str(ev.session_id);
    switch (ev.type) {
      case "system":
        if (str(ev.model)) this.model = str(ev.model).slice(0, 100);
        return [];
      case "assistant": {
        // Only the deltas: the pre-tool-call flush (`model_call_id`) and the end-of-turn one (no `timestamp_ms`) repeat them.
        if (ev.timestamp_ms === undefined || ev.model_call_id !== undefined) return [];
        const content = isRecord(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
        const delta = content.map((c) => (isRecord(c) && c.type === "text" ? str(c.text) : "")).join("");
        return delta ? this.flush(delta, false) : [];
      }
      case "tool_call": {
        if (ev.subtype !== "completed" || !isRecord(ev.tool_call)) return [];
        this.worked = true;
        const id = str(ev.call_id) || `cursor-${Math.random().toString(36).slice(2)}`;
        const call = cursorToolCall(id, ev.tool_call, (t) => this.clean(t));
        return call ? [...this.flush("", true), call] : [];
      }
      case "result": {
        if (ev.is_error === true || (ev.subtype !== undefined && ev.subtype !== "success")) {
          this.failed = this.clean(str(ev.result) || str(ev.error) || "The turn failed");
          return [];
        }
        this.completed = true;
        this.answer = this.clean(str(ev.result));
        const u = isRecord(ev.usage) ? ev.usage : null;
        if (!u) return [];
        const cacheRead = num(u.cacheReadTokens ?? u.cache_read_input_tokens);
        const cacheWrite = num(u.cacheWriteTokens ?? u.cache_creation_input_tokens);
        const model = this.opts.model ?? this.model;
        return [
          {
            type: "usage",
            input: num(u.inputTokens ?? u.input_tokens) + cacheRead + cacheWrite,
            output: num(u.outputTokens ?? u.output_tokens),
            source: "plan",
            ...(model ? { model } : {}),
            ...(cacheRead ? { cacheRead } : {}),
            ...(cacheWrite ? { cacheWrite } : {}),
          },
        ];
      }
      default:
        return [];
    }
  }

  /** The turn's end: one `done`, or `error` (after `limit` when the plan ran out). */
  finish(input: { exitCode: number | null; sessionId: string; stderr?: string }): CodexBrainEvent[] {
    const rest = this.flush("", true);
    const problem =
      this.failed ??
      (this.completed
        ? undefined
        : input.exitCode === 0
          ? "Cursor ended without finishing the turn"
          : `Cursor exited with code ${input.exitCode ?? "?"}${input.stderr ? `: ${this.clean(input.stderr)}` : ""}`);
    if (problem) return [...rest, ...cursorProblem(problem, this.worked)];
    const text = this.answer || this.streamed;
    return [
      ...rest,
      ...(text && !this.streamed ? [{ type: "text_delta" as const, text }] : []),
      { type: "done", text, session: { id: input.sessionId } },
    ];
  }
}

export interface CursorTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  /** The agent's own folder: our `.cursor/mcp.json` lives there. */
  folder: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string };
  /** The account (its chats are its own): its folder, and its key when it was made with one. */
  account?: { id: string; home: string; key?: string };
  profile?: CommandProfile;
  /** Protocol 41: the team's right hand (`cwd` and `folder` its empty `chatFolder`), killed at a tool of Cursor's own. */
  chat?: boolean;
}

export interface CursorTurnOptions {
  chats: CodexThreads;
  emit: (event: CodexBrainEvent) => void;
  signal: AbortSignal;
  mcpCommand?: string[];
  socketPath?: string;
  runnerHome?: string;
  env?: Record<string, string>;
  redact?: (text: string) => string;
  /** Streamed text holds back this many characters (the longest secret − 1). */
  redactHold?: number;
  /** Tests: the executable. */
  bin?: string;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
}

/** Runs one Cursor turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runCursorTurn(input: CursorTurnInput, opts: CursorTurnOptions): Promise<void> {
  const fail = (code: string, message: string, retryable?: boolean) =>
    opts.emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
  if ((opts.platform ?? process.platform) === "win32") {
    return fail("unsupported", "The Cursor brain isn't supported on Windows yet.");
  }
  try {
    writeCursorMcp(input.folder, cursorMcpEntry(input.mcp.url ? { url: input.mcp.url } : { command: opts.mcpCommand }));
    if (input.chat) {
      writeFileSync(path.join(input.folder, ".cursor", "cli.json"), JSON.stringify(CURSOR_CHAT_PERMISSIONS), {
        mode: 0o600,
      });
    }
  } catch (err) {
    return fail("cursor_failed", `Couldn't set up the agent's tools for Cursor: ${(err as Error).message}`, true);
  }
  const chatKey = codexThreadKey(input.sessionId, input.account?.id);
  const chat = opts.chats.get(chatKey);
  const args = cursorTurnArgs({
    cwd: input.cwd,
    prompt: cursorPrompt(input.system, input.prompt, !chat),
    ...(chat ? { chat } : {}),
    ...(input.model ? { model: input.model } : {}),
    profile: input.profile ?? "work",
    approveMcps: cursorMayApproveMcps(input.folder, input.cwd),
    ...(input.chat ? { locked: true } : {}),
  });
  const base: NodeJS.ProcessEnv = {
    ...withoutContainers(input.chat ? withoutSignIns(process.env) : process.env),
    ...(opts.env ?? {}),
    [CURSOR_RUN_ENV]: input.runId,
    [CODEX_MCP_ENV[0]]: input.mcp.token,
    ...(opts.socketPath ? { [CODEX_MCP_ENV[1]]: opts.socketPath } : {}),
    ...(opts.runnerHome ? { [CODEX_MCP_ENV[2]]: opts.runnerHome } : {}),
  };
  const env = input.account ? accountEnv("cursor", input.account.home, base) : base;
  const key = input.account?.key;
  if (key) env.CURSOR_API_KEY = key;
  // The agent's shell could print the key (its env, its file in the lent folder).
  const redact = key
    ? (text: string) => redactSecrets(opts.redact ? opts.redact(text) : text, [{ name: "CURSOR_API_KEY", value: key }])
    : opts.redact;
  const mapper = new CursorEventMapper({
    ...(input.model ? { model: input.model } : {}),
    ...(redact ? { redact, hold: Math.max(opts.redactHold ?? 0, key ? key.length - 1 : 0) } : {}),
  });

  let child: ChildProcess;
  try {
    child = (opts.spawn ?? spawn)(resolveCommand(opts.bin ?? CURSOR_BIN, env.PATH), args, {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (err) {
    return fail("cursor_failed", err instanceof Error ? err.message : String(err));
  }
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString("utf8")).slice(-2000);
  });
  const lines = createInterface({ input: child.stdout as NonNullable<ChildProcess["stdout"]> });
  // A `chat` turn that used a tool of Cursor's own ends there: nothing after it is passed on.
  let breach: string | null = null;
  (lines as unknown as EventEmitter).on("line", (line: string) => {
    if (breach) return;
    if (input.chat) {
      try {
        const ev = JSON.parse(line) as unknown;
        breach = isRecord(ev) ? cursorChatBreach(ev) : null;
      } catch {
        breach = null;
      }
      if (breach) {
        killTree(child, "SIGKILL");
        return;
      }
    }
    for (const event of mapper.line(line)) opts.emit(event);
    if (mapper.chat) opts.chats.set(chatKey, mapper.chat);
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    killTree(child, "SIGTERM");
    killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
  };
  if (opts.signal.aborted) abort();
  else opts.signal.addEventListener("abort", abort, { once: true });
  const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
    let settled = false;
    const proc = child as unknown as EventEmitter;
    proc.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        resolve({ code: null, error });
      }
    });
    proc.on("close", (code: number | null) => {
      if (!settled) {
        settled = true;
        resolve({ code });
      }
    });
  });
  opts.signal.removeEventListener("abort", abort);
  if (killTimer) clearTimeout(killTimer);
  lines.close();
  if (opts.signal.aborted) return fail("canceled", "The turn was canceled.");
  if (breach) return fail("tools_not_locked", breach);
  if (exit.error) {
    const missing = (exit.error as NodeJS.ErrnoException).code === "ENOENT";
    return fail(
      missing ? "cursor_missing" : "cursor_failed",
      missing ? "Cursor's CLI is not installed on this computer." : exit.error.message,
      true,
    );
  }
  for (const event of mapper.finish({ exitCode: exit.code, sessionId: input.sessionId, stderr: stderr.trim() })) {
    opts.emit(event);
  }
}

/** What the runner's `brain.turn` handler hands the Cursor branch. */
export interface CursorBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  chats?: CodexThreads;
  bin?: string;
  grants?: string[];
  accounts?: { accountDir(kind: "cursor", id: string): string | null };
  spawn?: Spawn;
}

const chatStores = new Map<string, CodexThreads>();

/** `brain.turn` with `kind: "cursor"`: the turn's folder in the agent's own folder, its secrets, then the turn. */
export async function handleCursorBrainTurn(
  ctx: CursorBrainContext,
  req: CursorBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "Cursor is turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  // A `chat` turn starts in an empty folder of its own (then our `.cursor` alone), whatever the request names.
  const chat = req.permissions?.mode === "chat";
  const folder = chat ? chatFolder(ctx.runnerHome, String(req.agent.id)) : ctx.folder;
  let cwd = folder;
  if (!chat && typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveForAgent(folder, ctx.grants, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    cwd = resolved.abs;
  }
  // ADR 0041: the account's folder or nothing (never the machine's own sign-in instead).
  let account: CursorTurnInput["account"];
  const accountId: unknown = req.account;
  if (accountId !== undefined && accountId !== null && accountId !== "") {
    if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
    const home = ctx.accounts?.accountDir("cursor", accountId);
    if (!home) {
      scope.emit({ type: "error", code: "account_missing", message: ACCOUNT_MISSING_MESSAGE.cursor, retryable: false });
      return;
    }
    const key = await cursorKeyOf(home);
    account = { id: accountId, home, ...(key ? { key } : {}) };
  }
  const secrets = chat ? null : await agentSecrets(ctx.secretsDir, req.agent);
  const file = cursorChatsFile(ctx.runnerHome);
  const chats = ctx.chats ?? chatStores.get(file) ?? new CodexThreads(file);
  chatStores.set(file, chats);
  await runCursorTurn(
    {
      runId: req.runId,
      sessionId: req.session.id,
      cwd,
      folder,
      ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
      system: typeof req.system === "string" ? req.system : "",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      mcp: { token: req.mcp.token, ...(typeof req.mcp.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}) },
      ...(account ? { account } : {}),
      profile: codexProfileOf(req),
      ...(chat ? { chat } : {}),
    },
    {
      chats,
      emit: scope.emit,
      signal: scope.signal,
      runnerHome: ctx.runnerHome,
      ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
      ...(secrets ? { env: secrets.env, redact: secrets.redact, redactHold: secrets.hold } : {}),
      ...(ctx.bin ? { bin: ctx.bin } : {}),
      ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
    },
  );
}
