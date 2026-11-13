import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import type { AgentScope, BrainEffort } from "@agenteschat/adapters/machine-protocol";
import { isAccountId } from "@agenteschat/adapters/machine-protocol";
import { ACCOUNT_MISSING_MESSAGE, accountEnv, withoutContainers, withoutSignIns } from "./accounts";
import { ClaudeStreamParser, LIMIT_TEXT } from "./brain";
import { type CodexBrainEvent, CodexThreads, chatFolder, codexProfileOf, codexThreadKey } from "./brain-codex";
import { cursorPrompt } from "./brain-cursor";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { GROK_BIN, resolveCommand } from "./executors";
import { CODEX_MCP_ENV, CODEX_MCP_SERVER, redactDeep } from "./mcp";
import { resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The Grok branch of `brain.turn` (protocol 43, ADR 0142): one agent turn as one run of xAI's Grok Build CLI
 * (`grok -p --output-format streaming-messages-json`), whose lines are Claude Code's `stream-json` shape and go through
 * the same parser. Flags as `grok --help` and Grok Build 1.0.34's docs (`docs/user-guide/14-headless-mode.md`, `18-sandbox.md`,
 * `22-permissions-and-safety.md`) list them, read 2026-11-04.
 *
 * - Always an account: `GROK_HOME` is the account's folder (its `auth.json`), and its `config.toml` holds our MCP
 *   server alone, rewritten when it differs. Every value that changes per turn (the run, the token) reaches the
 *   server through the env, so the account's turns of several agents share one file. No account (the computer's own
 *   `~/.grok`): refused, our bridge would have to go into the person's own config.
 * - The chat: `system`/`init` names Grok's session (`session_id`); our session → that session lives in
 *   `<runner home>/brain/grok-chats.json` (per account). The first turn of a chat leads its prompt with the engine's
 *   context (`cursorPrompt`); a runner that lost it, or a resume Grok can't find, starts a new chat with it again.
 * - ADR 0053 §3: `work` is `--permission-mode bypassPermissions` inside Grok's `workspace` sandbox (writes in the
 *   turn's folder only); `plan` is `dontAsk` (read-only tools and our bridge) with edits denied. Every turn runs in a
 *   sandbox profile, which also keeps it off Grok's shared leader process.
 * - `chat` (the team's right hand, ADR 0137 §4): built-in tools down to the MCP meta-tools (`search_tool`, `use_tool`),
 *   every built-in Grok documents also denied, no subagents, web or plan mode, in an empty folder with none of the
 *   agent's secrets. `grokChatBreach` kills the turn on an `init` listing anything else, a server but ours, an answer
 *   before `init`, or a call that isn't to our bridge.
 * - Our bridge's calls (`use_tool` / `search_tool`) are not repeated as `tool_call`: the engine ran them. Grok's own
 *   tools are, as what the turn tried. Usage is the plan's (`source: "plan"`).
 * - No live steering: `-p` takes nothing mid-turn (`brain.steer` answers `unsupported`).
 */

const KILL_GRACE_MS = 5000;

/** `brain.turn` with `kind: "grok"`. */
export interface GrokBrainTurnRequest {
  runId: string;
  kind: "grok";
  session: { id: string; resume: boolean };
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  account?: string;
  effort?: BrainEffort;
  permissions?: { mode?: "plan" | "work" | "chat" };
  keepAlive?: boolean;
}

/** Where our session → Grok session ids live in the runner home. */
export const grokChatsFile = (runnerHome: string) => path.join(runnerHome, "brain", "grok-chats.json");

/** The env name our bridge's run id comes through (`agentes-runner mcp` with no `--run` reads it). */
export const GROK_RUN_ENV = "AGENTES_MCP_RUN";

/** The tools Grok Build keeps for MCP whatever `--tools` says: they reach our bridge by its qualified names. */
export const GROK_META_TOOLS: readonly string[] = ["search_tool", "use_tool"];

/**
 * Every built-in tool Grok Build 1.0.34 documents, denied in a `chat` turn on top of `--tools` that lists only the
 * meta-tools (its shell's id is spelled both ways in its docs). `Agent` blocks its subagents. A name a version
 * doesn't know is ignored by it; one it adds that these miss stops the turn at `init` (`grokChatBreach`).
 */
export const GROK_CHAT_DENIED = [
  "run_terminal_cmd",
  "run_terminal_command",
  "get_command_or_subagent_output",
  "read_file",
  "search_replace",
  "write_file",
  "edit_file",
  "grep",
  "list_dir",
  "web_search",
  "web_fetch",
  "x_search",
  "code_interpreter",
  "todo_write",
  "spawn_subagent",
  "memory_search",
  "Agent",
] as const;

/**
 * `$GROK_HOME/config.toml` with our server alone (TOML; a JSON string is a TOML basic string): stdio (`agentes-runner
 * mcp`, the run, token, socket and home from the env) or the bridge's URL with the token as a bearer from the env.
 */
export function grokConfig(input: { command?: string[]; url?: string }): string {
  const q = JSON.stringify;
  const key = `mcp_servers.${CODEX_MCP_SERVER}`;
  const timeouts = ["startup_timeout_sec = 60", "tool_timeout_sec = 360"];
  if (input.url) {
    return [`[${key}]`, `url = ${q(input.url)}`, `bearer_token_env_var = ${q(CODEX_MCP_ENV[0])}`, ...timeouts, ""].join(
      "\n",
    );
  }
  const [command, ...args] = input.command ?? [];
  const names = [...CODEX_MCP_ENV, GROK_RUN_ENV];
  return [
    `[${key}]`,
    `command = ${q(command ?? "agentes-runner")}`,
    `args = ${q([...args, "mcp"])}`,
    ...timeouts,
    "",
    `[${key}.env]`,
    ...names.map((name) => `${name} = ${q(`\${${name}}`)}`),
    "",
  ].join("\n");
}

/**
 * What a turn could plant in `GROK_HOME` (the `workspace` sandbox lets its shell write there, and an account's turns
 * of several agents and Lodi share it) that a later turn would load as trusted, outside every tool and the chat guard:
 * a fleet config with hooks, MCP servers and plugins, the folder-trust store, user LSP servers and auto-trusted user
 * plugins (Grok Build 1.0.34's docs `10-hooks.md`, `26-config-reference.md`, `05-configuration.md`, `09-plugins.md`).
 * Removed before every turn. Its `hooks/` the sandbox itself keeps read-only, and `requirements.toml` only counts signed.
 */
export const GROK_PLANTED = ["managed_config.toml", "trusted_folders.toml", "lsp.json", "plugins"] as const;

/**
 * Writes `<home>/config.toml` (written whole, then renamed) when it isn't that already, after dropping `GROK_PLANTED`.
 */
export function writeGrokConfig(home: string, text: string) {
  for (const name of GROK_PLANTED) rmSync(path.join(home, name), { recursive: true, force: true });
  const file = path.join(home, "config.toml");
  try {
    if (readFileSync(file, "utf8") === text) return;
  } catch {
    // not there yet
  }
  mkdirSync(home, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** `--effort`: Grok's canonical levels, `xhigh` and `max` as `high` (a model accepts only the levels its menu has). */
const grokEffort = (effort?: BrainEffort) => (effort === "xhigh" || effort === "max" ? "high" : effort);

/** The `grok` arguments for one turn. */
export function grokTurnArgs(input: {
  prompt: string;
  chat?: string;
  model?: string;
  effort?: BrainEffort;
  profile?: CommandProfile;
  /** The team's right hand: the meta-tools alone. */
  locked?: boolean;
}): string[] {
  const ours = `MCPTool(${CODEX_MCP_SERVER}__*)`;
  const effort = grokEffort(input.effort);
  return [
    "-p",
    input.prompt,
    "--output-format",
    "streaming-messages-json",
    "--include-partial-messages",
    "--sandbox",
    "workspace",
    ...(input.locked
      ? [
          "--tools",
          GROK_META_TOOLS.join(","),
          "--disallowed-tools",
          GROK_CHAT_DENIED.join(","),
          "--no-subagents",
          "--disable-web-search",
          "--no-plan",
          "--permission-mode",
          "dontAsk",
          "--allow",
          ours,
        ]
      : input.profile === "plan"
        ? ["--permission-mode", "dontAsk", "--allow", ours, "--deny", "Edit", "--deny", "Write", "--no-plan"]
        : ["--permission-mode", "bypassPermissions", "--no-plan"]),
    ...(input.model ? ["--model", input.model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(input.chat ? ["--resume", input.chat] : []),
  ];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const QUALIFIED = /^[A-Za-z_][\w-]*__[\w-]+$/;

/** A `use_tool` call reaches our bridge alone: every qualified name in its input is ours, and there is one. */
function useToolIsOurs(input: unknown): boolean {
  const names = isRecord(input) ? Object.values(input).filter((v) => typeof v === "string" && QUALIFIED.test(v)) : [];
  return names.length > 0 && names.every((n) => (n as string).startsWith(`${CODEX_MCP_SERVER}__`));
}

/** What a `chat` turn's tool block may be: a meta-tool, and `use_tool` only toward our bridge (its input once whole). */
function blockBreach(block: Record<string, unknown>, whole: boolean): string | null {
  if (block.type === "server_tool_use") return `Grok used a tool of its own (${String(block.name).slice(0, 64)})`;
  if (block.type !== "tool_use") return null;
  const name = typeof block.name === "string" ? block.name : "";
  if (!GROK_META_TOOLS.includes(name)) return `Grok used a tool of its own (${name.slice(0, 64) || "unknown"})`;
  if (whole && name === "use_tool" && !useToolIsOurs(block.input)) return "Grok called a tool that isn't ours";
  return null;
}

/**
 * A `chat` turn's guard (protocol 43), line by line: the `init` must list only the meta-tools (and our bridge's
 * qualified names) and our server alone; nothing may come before it; every tool block must be a meta-tool, and
 * `use_tool` must name our bridge's tools. Null when the line is fine.
 */
export function grokChatBreach(ev: Record<string, unknown>, sawInit: boolean): string | null {
  const stop = (why: string) => `${why}, so the turn stopped.`;
  if (ev.type === "system" && ev.subtype === "init") {
    if (!Array.isArray(ev.tools) || !Array.isArray(ev.mcp_servers)) {
      return "Grok Build didn't list its tools, so the turn stopped before it began.";
    }
    const tools = ev.tools.filter(
      (t) => typeof t !== "string" || !(GROK_META_TOOLS.includes(t) || t.startsWith(`${CODEX_MCP_SERVER}__`)),
    );
    const servers = ev.mcp_servers.filter((s) => (isRecord(s) ? s.name : undefined) !== CODEX_MCP_SERVER);
    if (tools.length === 0 && servers.length === 0) return null;
    const names = [...tools.map(String), ...servers.map((s) => `MCP ${String(isRecord(s) ? s.name : s)}`)];
    return `Grok Build offers tools of its own here (${names.slice(0, 8).join(", ")}), so the turn stopped before it could use them.`;
  }
  if (ev.type === "system") return null;
  if (!sawInit) return stop("Grok Build answered before listing its tools");
  if (ev.type === "stream_event") {
    const e = isRecord(ev.event) ? ev.event : {};
    const block = e.type === "content_block_start" && isRecord(e.content_block) ? e.content_block : null;
    const why = block ? blockBreach(block, false) : null;
    return why ? stop(why) : null;
  }
  if (ev.type === "assistant") {
    const content = isRecord(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const block of content) {
      const why = isRecord(block) ? blockBreach(block, true) : null;
      if (why) return stop(why);
    }
  }
  return null;
}

const GROK_LIMIT = /usage limit|rate.?limit|quota|weekly (?:limit|pool)|out of (?:credits|usage)|upgrade your plan/i;
/** Grok can't authenticate (signed out, a refused token). */
export const GROK_AUTH =
  /not (?:authenticated|logged in|signed in)|grok login|unauthori[sz]ed|\b401\b|invalid (?:token|credentials)/i;
const SESSION_GONE = /session[^\n]*(?:not found|does not exist|no such)|no session/i;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `grok_failed`. */
export function grokProblem(problem: string, worked = false): CodexBrainEvent[] {
  if (GROK_LIMIT.test(problem) || LIMIT_TEXT.test(problem)) {
    return [{ type: "limit" }, { type: "error", code: "plan_limit", message: problem, retryable: true, worked }];
  }
  if (GROK_AUTH.test(problem)) return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "grok_failed", message: problem, retryable: true }];
}

export interface GrokTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  effort?: BrainEffort;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string };
  /** The account: its folder is `GROK_HOME`, its chats are its own. */
  account: { id: string; home: string };
  profile?: CommandProfile;
  /** The team's right hand (`cwd` its empty `chatFolder`): killed at a tool of Grok's own. */
  chat?: boolean;
}

export interface GrokTurnOptions {
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

/** Runs one Grok turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runGrokTurn(input: GrokTurnInput, opts: GrokTurnOptions): Promise<void> {
  const fail = (code: string, message: string, retryable?: boolean) =>
    opts.emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
  if ((opts.platform ?? process.platform) === "win32") {
    return fail("unsupported", "The Grok brain isn't supported on Windows yet.");
  }
  try {
    writeGrokConfig(
      input.account.home,
      grokConfig(input.mcp.url ? { url: input.mcp.url } : { command: opts.mcpCommand }),
    );
  } catch (err) {
    return fail("grok_failed", `Couldn't set up the agent's tools for Grok: ${(err as Error).message}`, true);
  }
  const chatKey = codexThreadKey(input.sessionId, input.account.id);
  const base: NodeJS.ProcessEnv = {
    ...withoutContainers(input.chat ? withoutSignIns(process.env) : process.env),
    ...(opts.env ?? {}),
    [GROK_RUN_ENV]: input.runId,
    [CODEX_MCP_ENV[0]]: input.mcp.token,
    ...(opts.socketPath ? { [CODEX_MCP_ENV[1]]: opts.socketPath } : {}),
    ...(opts.runnerHome ? { [CODEX_MCP_ENV[2]]: opts.runnerHome } : {}),
  };
  const env = accountEnv("grok", input.account.home, base);
  const clean = (text: string) => (opts.redact ? opts.redact(text) : text);
  const hold = opts.redact ? (opts.redactHold ?? 0) : 0;

  // One retry, as a new chat, when Grok can't find the chat it was to resume.
  for (let attempt = 0; ; attempt++) {
    const chat = opts.chats.get(chatKey);
    const args = grokTurnArgs({
      prompt: cursorPrompt(input.system, input.prompt, !chat),
      ...(chat ? { chat } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      profile: input.profile ?? "work",
      ...(input.chat ? { locked: true } : {}),
    });
    const parser = new ClaudeStreamParser();
    parser.beginTurn();
    let child: ChildProcess;
    try {
      child = (opts.spawn ?? spawn)(resolveCommand(opts.bin ?? GROK_BIN, env.PATH), args, {
        cwd: input.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      return fail("grok_failed", err instanceof Error ? err.message : String(err));
    }
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-2000);
    });
    let tail = "";
    let streamed = false;
    const flush = (text: string, whole: boolean) => {
      const out = clean(tail + text);
      const at = whole ? out.length : Math.max(0, out.length - hold);
      tail = out.slice(at);
      if (at > 0) {
        streamed = true;
        opts.emit({ type: "text_delta", text: out.slice(0, at) });
      }
    };
    let final: CodexBrainEvent | undefined;
    let sawInit = false;
    let breach: string | null = null;
    const lines = createInterface({ input: child.stdout as NonNullable<ChildProcess["stdout"]> });
    (lines as unknown as EventEmitter).on("line", (line: string) => {
      if (breach || final) return;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(ev)) return;
      if (input.chat) {
        breach = grokChatBreach(ev, sawInit);
        if (breach) {
          killTree(child, "SIGKILL");
          return;
        }
      }
      if (ev.type === "system" && ev.subtype === "init") sawInit = true;
      const parsed = parser.push(line);
      if (parser.session) opts.chats.set(chatKey, parser.session);
      for (const event of parsed.events as CodexBrainEvent[]) {
        if (event.type === "text_delta") {
          flush(event.text, false);
          continue;
        }
        // Our bridge's calls: the engine ran them.
        if ((event.type === "tool_call" || event.type === "tool_started") && GROK_META_TOOLS.includes(event.name))
          continue;
        flush("", true);
        opts.emit(
          event.type === "tool_call"
            ? {
                ...event,
                input: redactDeep(event.input, clean),
                ...(event.executed ? { executed: { ...event.executed, content: clean(event.executed.content) } } : {}),
              }
            : event,
        );
      }
      if (parsed.final) final = parsed.final as CodexBrainEvent;
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
        missing ? "grok_missing" : "grok_failed",
        missing ? "Grok Build, xAI's CLI, is not installed on this computer." : exit.error.message,
        true,
      );
    }
    if (chat && !sawInit && attempt === 0 && SESSION_GONE.test(stderr)) {
      opts.chats.delete(chatKey);
      continue;
    }
    flush("", true);
    if (final?.type === "done") {
      if (final.text && !streamed) opts.emit({ type: "text_delta", text: clean(final.text) });
      opts.emit({ type: "done", text: clean(final.text), session: { id: input.sessionId } });
      return;
    }
    const why =
      final?.type === "error"
        ? final.message
        : exit.code === 0
          ? "Grok Build ended without finishing the turn"
          : `Grok Build exited with code ${exit.code ?? "?"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
    // The parser named it Claude's: it is Grok's, by Grok's words.
    const events =
      final?.type === "error" && (final.code === "plan_limit" || final.code === "not_logged_in")
        ? [final]
        : grokProblem(clean(why), final?.type === "error" ? final.worked : false);
    for (const event of events) opts.emit(event);
    return;
  }
}

/** What the runner's `brain.turn` handler hands the Grok branch. */
export interface GrokBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  chats?: CodexThreads;
  bin?: string;
  grants?: string[];
  accounts?: { accountDir(kind: "grok", id: string): string | null };
  spawn?: Spawn;
}

const chatStores = new Map<string, CodexThreads>();

/** `brain.turn` with `kind: "grok"`: the turn's folder in the agent's own folder, its account and secrets, the turn. */
export async function handleGrokBrainTurn(
  ctx: GrokBrainContext,
  req: GrokBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "Grok Build is turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  // ADR 0041: the account's folder or nothing (the computer's own `~/.grok` would need our bridge in its config).
  const accountId: unknown = req.account;
  if (accountId === undefined || accountId === null || accountId === "") {
    scope.emit({
      type: "error",
      code: "not_logged_in",
      message: "Grok thinks only with a Grok account connected for the agent. Connect one on the agent's page.",
      retryable: false,
    });
    return;
  }
  if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
  const home = ctx.accounts?.accountDir("grok", accountId);
  if (!home) {
    scope.emit({ type: "error", code: "account_missing", message: ACCOUNT_MISSING_MESSAGE.grok, retryable: false });
    return;
  }
  // A `chat` turn starts in an empty folder of its own, whatever the request names.
  const chat = req.permissions?.mode === "chat";
  const folder = chat ? chatFolder(ctx.runnerHome, String(req.agent.id)) : ctx.folder;
  let cwd = folder;
  if (!chat && typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveForAgent(folder, ctx.grants, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    cwd = resolved.abs;
  }
  const secrets = chat ? null : await agentSecrets(ctx.secretsDir, req.agent);
  const file = grokChatsFile(ctx.runnerHome);
  const chats = ctx.chats ?? chatStores.get(file) ?? new CodexThreads(file);
  chatStores.set(file, chats);
  await runGrokTurn(
    {
      runId: req.runId,
      sessionId: req.session.id,
      cwd,
      ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      system: typeof req.system === "string" ? req.system : "",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      mcp: { token: req.mcp.token, ...(typeof req.mcp.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}) },
      account: { id: accountId, home },
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
