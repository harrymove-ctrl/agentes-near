import { type ChildProcess, execFile, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import {
  type AgentScope,
  type BrainEffort,
  type BrainSpeed,
  isAccountId,
  isBrainEffort,
  isContextTokens,
} from "@agenteschat/adapters/machine-protocol";
import {
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_SIGNED_OUT,
  type AccountFolders,
  type AccountGrant,
  accountEnv,
  accountSignIn,
  withoutContainers,
  withoutSignIns,
} from "./accounts";
import { CODEX_ROUTE_OFF } from "./brain-route";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { cachedCodexVersion, resolveCommand } from "./executors";
import { CODEX_MCP_ENV, CODEX_MCP_SERVER, codexWritableRoots } from "./mcp";
import { isInside, resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The Codex branch of `brain.turn` (ADR 0032, ADR 0029 "Codex"): one agent
 * turn as `codex exec --json`, its JSONL turned into brain events.
 * Protocol 15: where the runner has them, turns run on a long-lived
 * `codex app-server` instead (`brain-codex-app.ts`: the same events, plus
 * messages mid-turn); this file stays the fallback and shares its mapping.
 *
 * - First turn of a session: `codex exec --json --skip-git-repo-check -C <cwd>
 *   --sandbox <workspace-write | read-only> -c developer_instructions=<system>
 *   <MCP bridge -c …> [-m <model>] -o <last.txt> -`, the prompt on stdin. Next
 *   turns: the same options without the instructions (the thread keeps them),
 *   then `resume <thread_id> -`.
 * - ADR 0053 §3: the turn's permission profile is its sandbox, never with the
 *   network: `plan` is read-only, `work` writes in its folders. `exec` can't
 *   ask for approvals (it forces approval_policy=never), so whatever the
 *   sandbox refuses stays refused; the app-server mode answers Codex's
 *   approvals with the command policy instead (`brain-codex-app.ts`).
 * - Codex picks its thread id (`thread.started`): our session id → that
 *   thread lives in `<runner home>/brain/codex-threads.json`. A runner that
 *   lost it starts a new thread (with the instructions again).
 * - Events: `agent_message` (exec has no deltas: the last completed one is
 *   the answer, sent whole as one `text_delta`, `last.txt` when the stream had
 *   none), `command_execution` / `file_change` (`tool_call` already executed,
 *   for the transcript), `turn.completed` usage (the plan's), `turn.failed`
 *   (the error; a usage limit is `limit` first). `error` events alone don't
 *   end a turn (Codex retries after some); exit code and `turn.failed` decide.
 *   Our MCP bridge's tool calls are not repeated: the engine ran them.
 * - The MCP bridge needs `default_tools_approval_mode="approve"` or every tool
 *   without `readOnlyHint` is denied. The token reaches the bridge through
 *   the env (`env_vars`, or `bearer_token_env_var` for an HTTP bridge), never argv.
 * - ADR 0041: a turn with an `account` runs with `CODEX_HOME` set to that
 *   account's folder (missing: `account_missing`, never another account); its
 *   threads are remembered per account. `effort` is `-c model_reasoning_effort`
 *   (`xhigh` and `max` are `high`).
 */

/** Same as the engine's `CODEX_MIN_VERSION` (`packages/engine/src/missions.ts`): the release verified on a real machine. */
export const CODEX_MIN_VERSION = "0.163.0";
/** What a `tool_call` keeps of a command's output. */
export const CODEX_TOOL_OUTPUT_MAX = 4000;
/** Sessions remembered (oldest forgotten first). */
export const CODEX_THREADS_MAX = 2000;
const KILL_GRACE_MS = 5000;
const CODEX_LOGIN_STATUS_MS = 5000;

/** The engine's `BrainEvent` (ADR 0032 contract), as the runner sends it in `brain.event`. */
export type CodexBrainEvent =
  | { type: "text_delta"; text: string }
  /** Grok Build, read with Claude Code's parser: a call of its own as it starts. */
  | { type: "tool_started"; id: string; name: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
      executed?: { content: string; isError?: boolean };
    }
  | {
      type: "usage";
      /** Every input token the turn read (cache included); `cacheRead`/`cacheWrite` say how much of it was cache. */
      input: number;
      output: number;
      source: "api" | "plan";
      model?: string;
      cacheRead?: number;
      cacheWrite?: number;
    }
  | { type: "limit"; resetsAt?: string }
  | { type: "done"; text: string; session?: { id: string } }
  | { type: "error"; code: string; message: string; retryable?: boolean; worked?: boolean }
  /** Protocol 15 (app-server only): messages handed with `brain.steer` that the turn read. */
  | { type: "steer_read"; uuids: string[] }
  | { type: "speed_fallback"; message: string };

/** `brain.turn` with `kind: "codex"` (contract: "Runner"). */
export interface CodexBrainTurnRequest {
  runId: string;
  kind: "codex";
  session: { id: string; resume: boolean };
  /** Relative to the agent's folder. */
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  /** Protocol 13: the account folder to run in (`accounts/codex/<id>`); absent: the machine's own sign-in. */
  account?: string;
  /** Protocol 13: how hard it thinks. */
  effort?: BrainEffort;
  /** Protocol 46: Fast mode on this turn. */
  speed?: BrainSpeed;
  /** Protocol 28: the agent's context limit in tokens. */
  contextTokens?: number;
  /** Protocol 16: the turn's permission profile (absent: `work`); protocol 41: `chat`, the team's right hand. */
  permissions?: { mode?: "plan" | "work" | "chat" };
  /** Protocol 16: false for a background turn (no app-server is kept for it). */
  keepAlive?: boolean;
}

/**
 * Codex features a `chat` turn turns off (protocol 41): the route's, and every other one of 0.164.0 that adds a tool
 * or reads something of the computer's. A name Codex doesn't know fails the turn (`Unknown feature flag`). Codex
 * 0.164.0 keeps its `exec` (a JavaScript sandbox with `apply_patch` and MCP resources in it) whatever is off.
 * `code_mode_host` stays off so `exec` fails closed: an `exec` cell, and an `apply_patch` it calls, emit no item for
 * the kill to see.
 */
export const CODEX_CHAT_OFF = [
  ...CODEX_ROUTE_OFF,
  "unified_exec",
  "unified_exec_tty",
  "shell_snapshot",
  "skill_mcp_dependency_install",
  "remote_plugin",
  "plugin_sharing",
  "multi_agent_v2",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "browser_annotation_api",
  "in_app_browser",
  "in_app_local_automation",
  "view_image",
  "hooks",
  "memories",
  "goals",
  "code_mode_host",
  "workspace_dependencies",
] as const;

/**
 * A `chat` turn's `-c` overrides: no approvals (`exec` forces it anyway), no web search, no `AGENTS.md`, and our
 * bridge's tools offered to the model directly. Codex's catalog makes its models `code_mode_only` (gpt-5.6 and
 * gpt-6 in 0.164.0), which hides every MCP tool inside `exec`; with the host off that left the turn no tool at all.
 * `agents.enabled=false` drops the `collaboration` tools the catalog turns on for gpt-6 although `multi_agent_v2` is
 * off: a `spawn_agent` emits no item, and the sub-agent it starts calls our bridge unseen by the kill.
 * Codex 0.164.0 refuses an unknown value for each of these keys.
 */
export const CODEX_CHAT_CONFIG = [
  'approval_policy="never"',
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  `features.code_mode.direct_only_tool_namespaces=${JSON.stringify([`mcp__${CODEX_MCP_SERVER}`])}`,
  "agents.enabled=false",
];

/**
 * The runtime kill of a `chat` turn: an item that is neither the model's words, a warning nor a call to our bridge
 * (a command, a file change, a web search, a sub-agent, `exec`'s own…) is a breach, at its first event
 * (`item.started` comes before a command runs). Null for anything else.
 */
export function codexChatBreach(ev: Record<string, unknown>): string | null {
  if (ev.type !== "item.started" && ev.type !== "item.updated" && ev.type !== "item.completed") return null;
  const item = (ev.item ?? {}) as Record<string, unknown>;
  // `error`: a warning Codex reports as an item (a retry, a config note), no tool.
  if (item.type === "agent_message" || item.type === "reasoning" || item.type === "error") return null;
  if (item.type === "mcp_tool_call" && item.server === CODEX_MCP_SERVER) return null;
  const what = typeof item.type === "string" ? item.type.slice(0, 64) : "unknown";
  return `Codex used a tool of its own (${what}), so the turn stopped.`;
}

/**
 * The folder a `chat` turn starts in (Codex's and Cursor's): one per agent under the runner home (Cursor finds a chat
 * again by its folder), emptied on every turn, so no project config, rules or instructions are there to read.
 */
export function chatFolder(runnerHome: string, agentId: string): string {
  const dir = path.join(runnerHome, "brain", "chat", agentId.replace(/[^\w-]/g, "_"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { recursive: true, force: true });
  return dir;
}

/** The profile a request asks for: anything but `plan` is `work`. */
export const codexProfileOf = (req: { permissions?: { mode?: unknown } }): CommandProfile =>
  req.permissions?.mode === "plan" ? "plan" : "work";

/** The Codex sandbox of a profile (`--sandbox`, the app-server's `sandbox`): never with the network. */
export const codexSandbox = (profile: CommandProfile) => (profile === "plan" ? "read-only" : "workspace-write");

/**
 * Fast mode on a `codex exec` turn. `fast` reaches the provider as `service_tier: "priority"` (codex-cli 0.166.0), and
 * a model that doesn't list the tier goes out without one. `features.` rather than `--enable`: the flag fails the turn
 * on a Codex that doesn't know the feature, the key doesn't.
 */
export const CODEX_FAST_CONFIG = ['service_tier="fast"', "features.fast_mode=true"];

/**
 * Every other `codex exec` turn. `exec resume` goes on with the tier the thread last ran with, and leaving
 * `service_tier` out doesn't clear it: only the feature off does (codex-cli 0.165.0 and 0.166.0). It also holds against
 * a `service_tier` in the config of the person's own computer.
 */
export const CODEX_STANDARD_CONFIG = ["features.fast_mode=false"];

/**
 * A provider's words we know for a refused tier, or a Codex that can't read the setting. On the wire the tier is
 * `priority`.
 */
const CODEX_FAST_REFUSED = /service[_ ]tier|fast[_ ]mode|priority/i;

/**
 * This failure may be Fast's. No real refusal has been seen yet, so anything the provider failed comes in, not only
 * the words above: going again costs one try on a turn that was lost anyway. A dropped connection is the engine's
 * retry, and a plan's limit or a lost sign-in aren't about speed.
 */
const fastMayHaveFailed = (error: Extract<CodexBrainEvent, { type: "error" }>) =>
  error.code === "codex_failed" && (!error.retryable || CODEX_FAST_REFUSED.test(error.message));

/** The computer's own Codex is on a ChatGPT sign-in, not an API key, where Fast bills the key at a higher rate. */
const ownChatGptSignIn = (opts: Pick<CodexTurnOptions, "bin" | "env">) =>
  new Promise<boolean>((resolve) => {
    const env = { ...process.env, ...opts.env };
    execFile(
      resolveCommand(opts.bin ?? "codex", env.PATH),
      ["login", "status"],
      { env, timeout: CODEX_LOGIN_STATUS_MS },
      (err, stdout, stderr) => resolve(!err && /logged in using chatgpt/i.test(`${stdout}${stderr}`)),
    );
  });

/** The agent's context limit as Codex's own: it compacts the conversation there instead of at its window. */
export const codexContextOverride = (tokens: unknown): string[] =>
  isContextTokens(tokens) ? ["-c", `model_auto_compact_token_limit=${tokens}`] : [];

/** Codex's `model_reasoning_effort` for a brain effort (it has no `xhigh` or `max`). */
export function codexEffort(effort: BrainEffort): "low" | "medium" | "high" {
  return effort === "low" || effort === "medium" ? effort : "high";
}

/** `codex-cli 0.163.0` → true from `CODEX_MIN_VERSION` on. */
export function codexVersionOk(version: string | undefined): boolean {
  const parse = (s: string | undefined) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(s ?? "");
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const have = parse(version);
  const want = parse(CODEX_MIN_VERSION) as number[];
  if (!have) return false;
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
}

/**
 * Our session id → Codex thread id, kept across runner restarts (written
 * whole, then renamed). A session in an account folder is keyed
 * `<account>:<session>` (`codexThreadKey`): a thread lives in one Codex home.
 */
export class CodexThreads {
  private map: Record<string, string> | null = null;

  constructor(private readonly file: string) {}

  private load(): Record<string, string> {
    if (this.map) return this.map;
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      this.map =
        v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === "string",
              ),
            )
          : {};
    } catch {
      this.map = {};
    }
    return this.map;
  }

  get(session: string): string | undefined {
    return this.load()[session];
  }

  set(session: string, thread: string) {
    const map = this.load();
    if (map[session] === thread) return;
    delete map[session];
    map[session] = thread;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - CODEX_THREADS_MAX))) delete map[k];
    this.save(map);
  }

  delete(session: string) {
    const map = this.load();
    if (!(session in map)) return;
    delete map[session];
    this.save(map);
  }

  private save(map: Record<string, string>) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** The threads file's key for a session (in an account: that account's thread, never the machine's). */
export const codexThreadKey = (sessionId: string, account?: string) =>
  account ? `${account}:${sessionId}` : sessionId;

/** Where the threads live in the runner home. */
export const codexThreadsFile = (runnerHome: string) => path.join(runnerHome, "brain", "codex-threads.json");

/**
 * Codex `-c` overrides for the run's MCP bridge (values are TOML; JSON
 * strings and arrays are valid TOML). Stdio: `agentes-runner mcp --run
 * <runId>` with the token, socket and home passed by name (`env_vars`).
 * HTTP: the bridge URL with the token as a bearer from the env.
 */
export function codexBridgeOverrides(input: { runId: string; command?: string[]; url?: string }): string[] {
  const key = `mcp_servers.${CODEX_MCP_SERVER}`;
  const toml = (v: unknown) => JSON.stringify(v);
  const where = input.url
    ? [`${key}.url=${toml(input.url)}`, `${key}.bearer_token_env_var=${toml(CODEX_MCP_ENV[0])}`]
    : (() => {
        const [command, ...args] = input.command ?? [];
        return [
          `${key}.command=${toml(command ?? "agentes-runner")}`,
          `${key}.args=${toml([...args, "mcp", "--run", input.runId])}`,
          `${key}.env_vars=${toml(CODEX_MCP_ENV)}`,
        ];
      })();
  return [
    ...where,
    `${key}.default_tools_approval_mode="approve"`,
    `${key}.startup_timeout_sec=60`,
    `${key}.tool_timeout_sec=300`,
    `${key}.required=true`,
  ];
}

/** The `codex` arguments for one turn (an argv: nothing goes through a shell). */
export function codexTurnArgs(input: {
  cwd: string;
  lastFile: string;
  runId: string;
  model?: string;
  /** Only when a thread starts. */
  instructions?: string;
  /** Resume this Codex thread. */
  thread?: string;
  mcp?: { command?: string[]; url?: string };
  /** Protocol 10: folders allowed for the agent besides its own (its sandbox's writable roots). */
  writableRoots?: string[];
  /** Protocol 13: `-c model_reasoning_effort` (anything else is left out). */
  effort?: BrainEffort;
  /** Protocol 46: `fast`, `CODEX_FAST_CONFIG`; anything else, `CODEX_STANDARD_CONFIG`. */
  speed?: BrainSpeed;
  /** Protocol 28: `-c model_auto_compact_token_limit` (anything else is left out). */
  contextTokens?: number;
  /** Protocol 16: the sandbox (default `work`: workspace-write; `plan`: read-only). Never the network. */
  profile?: CommandProfile;
  /** Protocol 41: the team's right hand. Read-only, none of the computer's config, rules or features. */
  chat?: boolean;
}): string[] {
  const instructions = input.instructions?.trim();
  const sandbox = input.chat ? "read-only" : codexSandbox(input.profile ?? "work");
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...(input.chat
      ? [
          "--ignore-user-config",
          "--ignore-rules",
          ...CODEX_CHAT_CONFIG.flatMap((c) => ["-c", c]),
          ...CODEX_CHAT_OFF.flatMap((feature) => ["--disable", feature]),
        ]
      : []),
    "-C",
    input.cwd,
    "--sandbox",
    sandbox,
    ...(sandbox === "workspace-write" && input.writableRoots?.length
      ? ["-c", codexWritableRoots(input.writableRoots)]
      : []),
    ...(instructions && !input.thread ? ["-c", `developer_instructions=${JSON.stringify(instructions)}`] : []),
    ...(input.mcp ? codexBridgeOverrides({ runId: input.runId, ...input.mcp }).flatMap((o) => ["-c", o]) : []),
    ...(isBrainEffort(input.effort)
      ? ["-c", `model_reasoning_effort=${JSON.stringify(codexEffort(input.effort))}`]
      : []),
    ...(input.speed === "fast" ? CODEX_FAST_CONFIG : CODEX_STANDARD_CONFIG).flatMap((c) => ["-c", c]),
    ...codexContextOverride(input.contextTokens),
    ...(input.model ? ["-m", input.model] : []),
    "-o",
    input.lastFile,
    ...(input.thread ? ["resume", input.thread] : []),
    "-",
  ];
}

/** `/bin/zsh -lc "npm test"` → `npm test` (Codex wraps every command in the login shell). */
export function unwrapShell(command: string) {
  const m = /^\S*(?:sh|bash|zsh)\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(command.trim());
  return (m ? (m[2] ?? "") : command).replace(/\s+/g, " ").trim();
}

const USAGE_LIMIT = /hit your usage limit|usage limit reached|usage_limit|workspace is out of credits|spend cap/i;
/** Codex can't authenticate (signed out, a revoked or expired sign-in). */
export const CODEX_AUTH =
  /not logged in|codex login|401 unauthorized|refresh token (?:was )?(?:expired|revoked|already used)|access token could not be refreshed/i;

/** A command Codex ran (exec's `command_execution`, app-server's `commandExecution`), as an executed `tool_call`. */
export function codexCommandCall(
  item: { id: string; command: string; output: string; exitCode: number | null; status: string },
  clean: (text: string) => string,
): CodexBrainEvent {
  const command = clean(unwrapShell(item.command));
  const declined = item.status === "declined";
  const output = clean(item.output);
  const content = declined
    ? "Not allowed by Codex's sandbox."
    : output.length > CODEX_TOOL_OUTPUT_MAX
      ? `${output.slice(0, CODEX_TOOL_OUTPUT_MAX)}\n…`
      : output;
  return {
    type: "tool_call",
    id: item.id,
    name: "shell",
    input: { command },
    executed: {
      content,
      ...(declined || item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0)
        ? { isError: true }
        : {}),
    },
  };
}

/** Files Codex changed (exec's `file_change`, app-server's `fileChange`), as an executed `tool_call`. */
export function codexFileChangeCall(item: {
  id: string;
  changes: Array<{ path: string; kind: string }>;
  failed: boolean;
}): CodexBrainEvent {
  return {
    type: "tool_call",
    id: item.id,
    name: "file_change",
    input: { changes: item.changes },
    executed: {
      content: item.failed
        ? "The change failed."
        : `Changed ${item.changes.map((c) => `${c.path} (${c.kind})`).join(", ") || "nothing"}`,
      ...(item.failed ? { isError: true } : {}),
    },
  };
}

/**
 * How a Codex turn that went wrong ends: a usage limit is `limit` then
 * `plan_limit`, a failed sign-in `not_logged_in` (the server marks the
 * account signed out, ADR 0041), anything else `codex_failed` (retryable
 * unless the turn itself failed).
 */
export function codexProblem(problem: string, turnFailed: boolean, worked = false): CodexBrainEvent[] {
  if (USAGE_LIMIT.test(problem))
    return [{ type: "limit" }, { type: "error", code: "plan_limit", message: problem, worked }];
  if (CODEX_AUTH.test(problem)) return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "codex_failed", message: problem, ...(turnFailed ? {} : { retryable: true }) }];
}

/**
 * `codex exec --json` lines → brain events, plus what the turn's end needs
 * (the thread, the last answer, whether it completed or failed).
 */
export class CodexEventMapper {
  thread?: string;
  answer?: string;
  completed = false;
  failed?: string;
  lastError?: string;
  /** The turn ran a command, changed a file or called our bridge: a cut now loses work the API couldn't see. */
  private worked = false;

  constructor(
    private readonly opts: { cwd: string; model?: string; redact?: (text: string) => string } = { cwd: "" },
  ) {}

  private clean(text: string) {
    return this.opts.redact ? this.opts.redact(text) : text;
  }

  private rel(p: string) {
    if (!p || !this.opts.cwd) return p;
    const abs = path.resolve(this.opts.cwd, p);
    return isInside(this.opts.cwd, abs) ? path.relative(this.opts.cwd, abs).split(path.sep).join("/") : p;
  }

  /** One JSONL line (anything that isn't a JSON event is ignored). */
  line(raw: string): CodexBrainEvent[] {
    const text = raw.trim();
    if (!text.startsWith("{")) return [];
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return [];
    }
    return this.event(ev);
  }

  event(ev: Record<string, unknown>): CodexBrainEvent[] {
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    switch (ev.type) {
      case "thread.started":
        if (str(ev.thread_id)) this.thread = str(ev.thread_id);
        return [];
      case "turn.completed": {
        this.completed = true;
        const u = (ev.usage ?? {}) as Record<string, unknown>;
        return [
          {
            type: "usage",
            input: num(u.input_tokens),
            output: num(u.output_tokens),
            source: "plan",
            ...(this.opts.model ? { model: this.opts.model } : {}),
            // Codex counts cached input inside `input_tokens`.
            ...(num(u.cached_input_tokens) > 0 ? { cacheRead: num(u.cached_input_tokens) } : {}),
          },
        ];
      }
      case "turn.failed":
        this.failed = this.clean(str((ev.error as { message?: unknown } | undefined)?.message) || "The turn failed");
        return [];
      case "error":
        this.lastError = this.clean(str(ev.message) || "error");
        return [];
      case "item.completed": {
        const item = (ev.item ?? {}) as Record<string, unknown>;
        const id = str(item.id) || `codex-${Math.random().toString(36).slice(2)}`;
        if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call")
          this.worked = true;
        switch (item.type) {
          case "agent_message": {
            const t = str(item.text);
            if (t.trim()) this.answer = this.clean(t);
            return [];
          }
          case "command_execution":
            return [
              codexCommandCall(
                {
                  id,
                  command: str(item.command),
                  output: str(item.aggregated_output),
                  exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
                  status: str(item.status),
                },
                (t) => this.clean(t),
              ),
            ];
          case "file_change": {
            const changes = (Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : []).flatMap(
              (c) => (str(c?.path) ? [{ path: this.rel(str(c.path)), kind: str(c.kind) || "update" }] : []),
            );
            return [codexFileChangeCall({ id, changes, failed: item.status === "failed" })];
          }
          default:
            return [];
        }
      }
      default:
        return [];
    }
  }

  /** The turn's end: one `done`, or `error` (after `limit` when the plan ran out). */
  finish(input: { exitCode: number | null; lastFile?: string; sessionId: string; stderr?: string }): CodexBrainEvent[] {
    const problem =
      this.failed ??
      (this.completed
        ? undefined
        : (this.lastError ??
          (input.exitCode === 0
            ? "Codex ended without finishing the turn"
            : `Codex exited with code ${input.exitCode ?? "?"}${input.stderr ? `: ${this.clean(input.stderr)}` : ""}`)));
    if (problem) return codexProblem(problem, this.failed !== undefined, this.worked);
    const text = this.answer ?? this.clean(input.lastFile?.trim() ?? "");
    return [
      ...(text ? [{ type: "text_delta" as const, text }] : []),
      { type: "done", text, session: { id: input.sessionId } },
    ];
  }
}

export interface CodexTurnOptions {
  threads: CodexThreads;
  /** A scratch folder for this turn (`last.txt`); removed afterwards. */
  workDir: string;
  emit: (event: CodexBrainEvent) => void;
  signal: AbortSignal;
  /** How to start `agentes-runner mcp` (runtime + script); the stdio bridge. */
  mcpCommand?: string[];
  /** The daemon's MCP socket and the runner home (stdio bridge env). */
  socketPath?: string;
  runnerHome?: string;
  /** The agent's secrets: env for Codex, redaction for what leaves the machine (ADR 0027). */
  env?: Record<string, string>;
  redact?: (text: string) => string;
  /** Streamed text holds back this many characters (the longest secret − 1), as for Claude Code. */
  redactHold?: number;
  /** The first line of `codex --version` (default: the cached detection). */
  codexVersion?: () => string | undefined;
  /** Tests: the codex executable. */
  bin?: string;
  /** How `codex exec` starts (a worker under systemd: in the agent's AI CLIs slice, `scope-gate.ts`). */
  spawn?: Spawn;
  platform?: NodeJS.Platform;
  /**
   * Protocol 15: the long-lived `codex app-server` processes
   * (`brain-codex-app.ts`): the turn runs there when it can (it takes
   * messages mid-turn); when it can't, `codex exec` runs it as before.
   */
  app?: CodexAppRunner;
}

/** What one Codex turn needs (either mode). */
export interface CodexTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  system: string;
  prompt: string;
  /** `tools`: the run's tool names, space-separated (`BrainTurnRequest.mcp.tools`). */
  mcp: { token: string; url?: string; tools?: string };
  /** Protocol 10: folders allowed for the agent besides its own. */
  writableRoots?: string[];
  /** Protocol 13: the account (its threads are its own) and its folder (`CODEX_HOME`). */
  account?: { id: string; home: string };
  effort?: BrainEffort;
  /** Protocol 46: Fast mode on this turn. */
  speed?: BrainSpeed;
  /** Protocol 28: the agent's context limit in tokens. */
  contextTokens?: number;
  /** App-server mode: the agent (one process per agent and session) and its folder (the MCP bridge's). */
  agentId?: string;
  folder?: string;
  /** Protocol 16: the turn's permission profile (default `work`). */
  profile?: CommandProfile;
  /** Protocol 16: false for a background turn: its app-server closes when the turn ends. */
  keepAlive?: boolean;
  /** Protocol 41: the team's right hand (`codexTurnArgs`' `chat`), always on `codex exec`, killed at a tool of Codex's own. */
  chat?: boolean;
}

/** The app-server mode as `runCodexTurn` sees it (`CodexAppServers`). */
export interface CodexAppRunner {
  /** Runs the turn on an app-server, or with `exec` (`codex exec`) when it can't there. */
  turn(input: CodexTurnInput & { version: string }, opts: CodexTurnOptions, exec: () => Promise<void>): Promise<void>;
}

const codexVersion = cachedCodexVersion();

/** Runs one Codex turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runCodexTurn(input: CodexTurnInput, opts: CodexTurnOptions): Promise<void> {
  const fail = (code: string, message: string, retryable?: boolean) =>
    opts.emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
  if ((opts.platform ?? process.platform) === "win32") {
    return fail("unsupported", "The Codex brain isn't supported on Windows yet.");
  }
  const version = await (opts.codexVersion ?? codexVersion)();
  if (version === null)
    return fail("codex_failed", "Couldn't check Codex on this computer (`codex --version` didn't answer).", true);
  if (!version) return fail("codex_missing", "Codex is not installed on this computer.");
  if (!codexVersionOk(version)) {
    return fail("codex_too_old", `Codex here is ${version}. Agents need ${CODEX_MIN_VERSION} or newer.`);
  }
  // A long-lived app-server takes messages mid-turn; exec runs the turns it can't (an older CLI, a failed handshake…).
  // A `chat` turn's flags exist only for `exec`.
  const run = (turn: CodexTurnInput, turnOpts: CodexTurnOptions) =>
    turnOpts.app && !turn.chat
      ? turnOpts.app.turn({ ...turn, version }, turnOpts, () => runCodexExec(turn, turnOpts))
      : runCodexExec(turn, turnOpts);
  const { speed: _speed, ...standard } = input;
  if (input.speed !== "fast" || (!input.account && !(await ownChatGptSignIn(opts)))) return run(standard, opts);
  // Fast never costs a reply: failed before anything happened, the same turn goes again at standard speed.
  const first: { started?: boolean; refused?: string } = {};
  await run(input, {
    ...opts,
    emit: (event) => {
      if (event.type === "error" && !first.started && fastMayHaveFailed(event)) first.refused = event.message;
      else {
        first.started = true;
        opts.emit(event);
      }
    },
  });
  const { refused } = first;
  if (refused === undefined) return;
  return run(standard, {
    ...opts,
    emit: (event) => {
      if (event.type === "done") opts.emit({ type: "speed_fallback", message: refused });
      opts.emit(event);
    },
  });
}

/** One turn as `codex exec --json` (the version already checked). */
async function runCodexExec(input: CodexTurnInput, opts: CodexTurnOptions): Promise<void> {
  const fail = (code: string, message: string, retryable?: boolean) =>
    opts.emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
  const threadKey = codexThreadKey(input.sessionId, input.account?.id);
  const thread = opts.threads.get(threadKey);
  mkdirSync(opts.workDir, { recursive: true });
  const lastFile = path.join(opts.workDir, "last.txt");
  rmSync(lastFile, { force: true });
  const args = codexTurnArgs({
    cwd: input.cwd,
    lastFile,
    runId: input.runId,
    ...(input.model ? { model: input.model } : {}),
    instructions: input.system,
    ...(thread ? { thread } : {}),
    mcp: input.mcp.url ? { url: input.mcp.url } : { ...(opts.mcpCommand ? { command: opts.mcpCommand } : {}) },
    ...(input.writableRoots?.length ? { writableRoots: input.writableRoots } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.speed ? { speed: input.speed } : {}),
    ...(input.contextTokens ? { contextTokens: input.contextTokens } : {}),
    profile: input.profile ?? "work",
    ...(input.chat ? { chat: true } : {}),
  });
  const base: NodeJS.ProcessEnv = {
    ...withoutContainers(input.chat ? withoutSignIns(process.env) : process.env),
    ...(opts.env ?? {}),
    [CODEX_MCP_ENV[0]]: input.mcp.token,
    ...(opts.socketPath ? { [CODEX_MCP_ENV[1]]: opts.socketPath } : {}),
    ...(opts.runnerHome ? { [CODEX_MCP_ENV[2]]: opts.runnerHome } : {}),
  };
  // ADR 0041: the account's folder is this turn's Codex home, and nothing else signs it in.
  const env = input.account ? accountEnv("codex", input.account.home, base) : base;
  const mapper = new CodexEventMapper({
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(opts.redact ? { redact: opts.redact } : {}),
  });

  let child: ChildProcess;
  try {
    child = (opts.spawn ?? spawn)(resolveCommand(opts.bin ?? "codex", env.PATH), args, {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch (err) {
    return fail("codex_failed", err instanceof Error ? err.message : String(err));
  }

  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    // Never a failure by itself (the person's own MCP servers log here); kept for a bad exit.
    stderr = (stderr + c.toString("utf8")).slice(-2000);
  });
  const lines = createInterface({ input: child.stdout as NonNullable<ChildProcess["stdout"]> });
  // A `chat` turn that used a tool of Codex's own ends there: nothing after it is passed on.
  let breach: string | null = null;
  (lines as unknown as EventEmitter).on("line", (line: string) => {
    if (breach) return;
    if (input.chat) {
      try {
        breach = codexChatBreach(JSON.parse(line) as Record<string, unknown>);
      } catch {
        breach = null;
      }
      if (breach) {
        killTree(child, "SIGKILL");
        return;
      }
    }
    for (const event of mapper.line(line)) opts.emit(event);
    if (mapper.thread) opts.threads.set(threadKey, mapper.thread);
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(input.prompt);

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

  let last: string | undefined;
  try {
    if (existsSync(lastFile)) last = readFileSync(lastFile, "utf8");
  } catch {
    // none
  }
  rmSync(opts.workDir, { recursive: true, force: true });

  if (opts.signal.aborted) return fail("canceled", "The turn was canceled.");
  if (breach) return fail("tools_not_locked", breach);
  if (exit.error) {
    const missing = (exit.error as NodeJS.ErrnoException).code === "ENOENT";
    return fail(
      missing ? "codex_missing" : "codex_failed",
      missing ? "Codex is not installed on this computer." : exit.error.message,
    );
  }
  for (const event of mapper.finish({
    exitCode: exit.code,
    lastFile: last,
    sessionId: input.sessionId,
    stderr: stderr.trim(),
  })) {
    opts.emit(event);
  }
}

/** What the runner's `brain.turn` handler hands the Codex branch. */
export interface CodexBrainContext {
  /** The agent's own folder (real path), as `handleRequest` resolved it for the request. */
  folder: string;
  /** `false`: started with `--no-exec`. */
  exec: boolean;
  /** The runner home (threads file, per-turn scratch, bridge env). */
  runnerHome: string;
  secretsDir?: string;
  /** The stdio MCP bridge: the daemon socket and how to start `agentes-runner mcp`. */
  mcp?: { socketPath: string; command: string[] };
  threads?: CodexThreads;
  codexVersion?: () => string | undefined;
  bin?: string;
  /** Protocol 10: folders allowed for the agent besides its own (real paths). */
  grants?: string[];
  /** Protocol 13: the accounts' folders (ADR 0041); without it a turn with an account is `account_missing`. */
  accounts?: AccountFolders;
  /** Set per request in a worker (protocol 29): what root handed this turn for its account (`AccountManager.grant`). */
  grant?: AccountGrant;
  /** Protocol 15: the app-server processes (live steering); without it every turn is `codex exec`. */
  app?: CodexAppRunner;
  spawn?: Spawn;
}

const threadStores = new Map<string, CodexThreads>();

/**
 * The dispatch hook: `brain.turn` with `kind: "codex"` → resolves the turn's
 * folder in the agent's own folder, loads its secrets and runs the turn,
 * emitting each event (the caller wraps them in `brain.event` and sends
 * `brain.done`).
 */
export async function handleCodexBrainTurn(
  ctx: CodexBrainContext,
  req: CodexBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) {
    throw new RunnerError(
      "exec_disabled",
      "Commands are turned off on this computer (the runner was paired with --no-exec)",
    );
  }
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  const folder = ctx.folder;
  // A `chat` turn starts in an empty folder of its own, whatever the request names, with no grants nor secrets.
  const chat = req.permissions?.mode === "chat";
  let cwd = chat ? chatFolder(ctx.runnerHome, String(req.agent.id)) : folder;
  if (!chat && typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveForAgent(folder, ctx.grants, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    cwd = resolved.abs;
  }
  // ADR 0041: the account's folder or nothing (never the machine's own sign-in instead).
  let account: { id: string; home: string } | undefined;
  let release: (() => void) | undefined;
  const accountId: unknown = req.account;
  if (accountId !== undefined && accountId !== null && accountId !== "") {
    if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
    const signIn = await accountSignIn(ctx.accounts, "codex", accountId, ctx.grant);
    if (signIn === "signed_out") {
      scope.emit({ type: "error", code: "not_logged_in", message: ACCOUNT_SIGNED_OUT, retryable: true });
      return;
    }
    if (signIn === "missing") {
      scope.emit({ type: "error", code: "account_missing", message: ACCOUNT_MISSING_MESSAGE.codex, retryable: false });
      return;
    }
    account = { id: accountId, home: signIn.home };
    release = signIn.release;
  }
  // Starting in one of its checkouts (`repos/owner/name`), the agent keeps its whole folder (its other checkouts).
  const writableRoots = chat
    ? []
    : [...(cwd !== folder ? [folder] : []), ...(ctx.grants ?? []).filter((g) => !isInside(g, cwd))];
  const secrets = chat ? null : await agentSecrets(ctx.secretsDir, req.agent);
  const file = codexThreadsFile(ctx.runnerHome);
  const threads = ctx.threads ?? threadStores.get(file) ?? new CodexThreads(file);
  threadStores.set(file, threads);
  try {
    await runCodexTurn(
      {
        runId: req.runId,
        sessionId: req.session.id,
        cwd,
        ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
        system: typeof req.system === "string" ? req.system : "",
        prompt: typeof req.prompt === "string" ? req.prompt : "",
        mcp: {
          token: req.mcp.token,
          ...(typeof req.mcp.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}),
          ...(typeof req.mcp.tools === "string" && req.mcp.tools ? { tools: req.mcp.tools.slice(0, 64_000) } : {}),
        },
        ...(writableRoots.length ? { writableRoots } : {}),
        ...(account ? { account } : {}),
        ...(isBrainEffort(req.effort) ? { effort: req.effort } : {}),
        ...(req.speed === "fast" && !chat ? { speed: "fast" as const } : {}),
        ...(isContextTokens(req.contextTokens) ? { contextTokens: req.contextTokens } : {}),
        agentId: String(req.agent.id),
        folder,
        profile: codexProfileOf(req),
        ...(req.keepAlive === false ? { keepAlive: false } : {}),
        ...(chat ? { chat } : {}),
      },
      {
        threads,
        workDir: path.join(ctx.runnerHome, "brain", "turns", req.runId),
        emit: scope.emit,
        signal: scope.signal,
        runnerHome: ctx.runnerHome,
        ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
        ...(secrets ? { env: secrets.env, redact: secrets.redact, redactHold: secrets.hold } : {}),
        ...(ctx.codexVersion ? { codexVersion: ctx.codexVersion } : {}),
        ...(ctx.bin ? { bin: ctx.bin } : {}),
        ...(ctx.app ? { app: ctx.app } : {}),
        ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
      },
    );
  } finally {
    release?.();
  }
}
