import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CommandProfile, CommandScope } from "@agenteschat/adapters/command-policy";
import { type BrainSteerReply, type BrainSteerRequest, isBrainEffort } from "@agenteschat/adapters/machine-protocol";
import { accountEnv, withoutContainers, yieldRoute } from "./accounts";
import {
  type CodexAppRunner,
  type CodexBrainEvent,
  type CodexTurnInput,
  type CodexTurnOptions,
  codexBridgeOverrides,
  codexCommandCall,
  codexContextOverride,
  codexEffort,
  codexFileChangeCall,
  codexProblem,
  codexSandbox,
  codexThreadKey,
  unwrapShell,
} from "./brain-codex";
import { killTree } from "./exec";
import { resolveCommand } from "./executors";
import {
  CODEX_MCP_ENV,
  codexWritableRoots,
  type IpcReply,
  ipcCall,
  type McpTaskInfo,
  newMcpToken,
  permissionPrompt,
} from "./mcp";
import { isInside } from "./paths";
import type { Spawn } from "./scope-gate";

/**
 * Codex brain turns on `codex app-server` (protocol 15, live steering): the
 * JSON-RPC (one JSON object per line on stdio, no `jsonrpc` field) that
 * Codex's IDE extension speaks, so a person's message reaches a turn in
 * progress, as Claude Code's do (`brain.ts`).
 *
 * - One app-server per (agent, session) stays alive between turns (closed
 *   after `idleMs` idle, at most `maxProcesses` kept per agent; the least
 *   recently used idle one goes for a new one; all busy: the turn still gets
 *   its own, and the extra ones close as turns end).
 *   Started with the same `-c` overrides as exec (the agent's writable roots,
 *   our MCP bridge; no network) and the same env (the agent's secrets,
 *   `CODEX_HOME` = the turn's account). A change of folder, roots, account,
 *   secrets or permission profile starts it again; a background turn
 *   (`keepAlive: false`) closes it when it ends.
 * - `initialize` + `initialized`, then the session's Codex thread:
 *   `thread/resume` of the stored id (the threads file exec keeps too), else
 *   `thread/start` with the instructions (`developerInstructions`), always
 *   `cwd`, the profile's sandbox (`read-only` for `plan`, `workspace-write`
 *   for `work`, never the network), `approvalPolicy: "untrusted"` and the
 *   model. Each turn is `turn/start` with the prompt, the model, `effort` and
 *   `serviceTier`, always: Codex keeps a thread's tier until told otherwise.
 * - Approvals (ADR 0053 §3): Codex asks before a command it doesn't trust or a
 *   change outside its sandbox (`item/commandExecution/requestApproval`,
 *   `item/fileChange/requestApproval`); the runner answers with the same
 *   decision Claude Code's permission prompt gets (`permissionPrompt`: deny
 *   list, secrets, plain reads, a `plan` turn's refusals, then the server's
 *   rules or a person), `accept` or `decline`.
 * - Notifications → the same events exec gives: `item/agentMessage/delta`
 *   streamed as text deltas (batched), a completed `commandExecution` /
 *   `fileChange` as an executed `tool_call`, `thread/tokenUsage/updated`
 *   (the thread's totals: the turn's usage is the difference) as `usage`,
 *   `turn/completed` as `done` (the last agent message) or the error.
 * - Our MCP bridge is the process's, not a run's: `mcp --run <process id>`
 *   with a local token; the turn's run and its server token are swapped in
 *   per turn (between turns its calls are refused quietly, as Claude's).
 * - Steering: `turn/steer` with `expectedTurnId` (the turn running now) and
 *   our message `uuid` as `clientUserMessageId`; Codex adds the input at its
 *   next model request and emits it as a `userMessage` item whose `clientId`
 *   is that uuid: `steer_read`. "No active turn" or another turn id: `no_turn`
 *   (the engine keeps the message for the next turn). An urgent one ("Parar e
 *   mandar") is `turn/interrupt` (the turn ends `interrupted`, what it did so
 *   far stays in the thread) and a new `turn/start` with the messages, in the
 *   same `brain.turn`: the protocol has no "read it now" for steered input,
 *   and interrupting stops a long command at once, as stop-and-send means.
 * - `codex exec` instead (its turns answer steering with `unsupported`): an
 *   HTTP bridge (its token is per run), a Codex older than
 *   `CODEX_APP_MIN_VERSION`, all processes busy, an app-server that fails to
 *   start or to `initialize` (remembered for that binary and version), or one
 *   that dies mid-turn (that turn runs again with exec, resuming the thread).
 *
 * The protocol shapes below are the minimum this file reads, copied from
 * `codex app-server generate-ts` of codex-cli 0.163.0 (`ClientRequest`,
 * `ServerNotification`, `v2/*`); `apps/server/scripts/probe-codex-app-server.ts`
 * checks them against a real CLI.
 */

/** The first Codex whose app-server has `turn/steer` and the shapes below (the same as `CODEX_MIN_VERSION` today). */
export const CODEX_APP_MIN_VERSION = "0.163.0";
export const CODEX_APP_IDLE_MS = 10 * 60_000;
export const CODEX_APP_MAX_PROCESSES = 3;
/** Text deltas are sent at most this often (batched), as Claude Code's. */
export const CODEX_APP_DELTA_MS = 50;
const START_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 60_000;
/** `turn/steer` and `turn/interrupt` answer at once. */
const STEER_RPC_MS = 5_000;
const CLOSE_GRACE_MS = 3_000;
const STDERR_KEEP = 4000;

// ── Protocol (codex-cli 0.163.0, `codex app-server generate-ts`) ─────────────

/** `v2/UserInput`, the text variant. */
type UserInput = { type: "text"; text: string; text_elements: never[] };
/** `v2/TurnError`. */
interface TurnError {
  message: string;
  /** `v2/CodexErrorInfo`: "usageLimitExceeded", "unauthorized", … or an object. */
  codexErrorInfo: unknown;
  additionalDetails: string | null;
}
/** `v2/Turn` (the fields read). */
interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: TurnError | null;
}
/** `v2/TokenUsageBreakdown`. */
interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}
/** `v2/ThreadTokenUsage`: `total` is the thread's, `last` the last model request's. */
interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
}
/** `ThreadStartResponse` / `ThreadResumeResponse` / `TurnStartResponse` (the fields read). */
type ThreadResponse = { thread: { id: string } };
type TurnStartResponse = { turn: Turn };

const text = (t: string): UserInput => ({ type: "text", text: t, text_elements: [] });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `codex-cli 0.163.0` ≥ `min` (an unreadable version never is). */
export function codexAtLeast(version: string | undefined, min = CODEX_APP_MIN_VERSION): boolean {
  const parse = (s: string | undefined) =>
    /(\d+)\.(\d+)\.(\d+)/
      .exec(s ?? "")
      ?.slice(1)
      .map(Number) ?? null;
  const have = parse(version);
  const want = parse(min) as number[];
  if (!have) return false;
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
}

/**
 * The `codex app-server` arguments: our `-c` overrides (a process serves one folder, one set of roots
 * and one permission profile). No network in the sandbox (ADR 0053 §3): a command that needs it asks,
 * and the command policy answers.
 */
export function codexAppServerArgs(input: {
  /** The process id: our MCP bridge is `mcp --run <id>` (`McpTaskInfo` in the bridge's registry). */
  processId: string;
  mcp?: { command?: string[] };
  writableRoots?: string[];
  /** Protocol 28: the agent's context limit (a process serves one). */
  contextTokens?: number;
}): string[] {
  return [
    "app-server",
    "-c",
    "features.fast_mode=true",
    ...(input.writableRoots?.length ? ["-c", codexWritableRoots(input.writableRoots)] : []),
    ...codexContextOverride(input.contextTokens),
    ...(input.mcp ? codexBridgeOverrides({ runId: input.processId, ...input.mcp }).flatMap((o) => ["-c", o]) : []),
  ];
}

/**
 * A thread's sandbox and approval policy for the turn's profile (`thread/start`, `thread/resume`):
 * `plan` reads in a read-only sandbox, `work` writes in its folders; neither has the network. Codex
 * asks before anything else (`untrusted`), and the runner answers with the command policy.
 */
export const codexThreadPolicy = (profile: CommandProfile) => ({
  sandbox: codexSandbox(profile),
  approvalPolicy: "untrusted" as const,
});

// ── JSON-RPC client ──────────────────────────────────────────────────────────

/** A JSON-RPC error from the app-server (`code` -1: it exited or didn't answer). */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The answer to a request the app-server sends the runner. */
export type ServerRequestAnswer = { result: unknown } | { error: { code: number; message: string } };
/** Answers the app-server's requests of a turn (null: not this turn's; the default answer goes). */
export type ServerRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<ServerRequestAnswer> | null;

/** Server requests no turn handles (between turns, or legacy ones): refused, so a request never hangs a turn. */
function serverRequestAnswer(method: string): ServerRequestAnswer {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { result: { decision: { denied: { rejection: "Not allowed on this computer." } } } };
    default:
      return { error: { code: -32601, message: `The agentes runner doesn't answer ${method}` } };
  }
}

/** A running `codex app-server` on stdio. */
export class CodexAppClient {
  readonly child: ChildProcess;
  exited = false;
  stderr = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private readonly exitHandlers = new Set<() => void>();
  private requestHandler: ServerRequestHandler | null = null;

  constructor(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; spawn?: Spawn }) {
    this.child = (opts.spawn ?? spawn)(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group: closing it takes the commands it runs along (`killTree`).
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const events = this.child as unknown as EventEmitter;
    events.on("error", (err: Error) => {
      this.stderr = `${this.stderr}${err.message}\n`.slice(-STDERR_KEEP);
      this.markExit();
    });
    events.on("exit", () => this.markExit());
    this.child.stdin?.on("error", () => {});
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      (rl as unknown as EventEmitter).on("line", (line: string) => this.line(line));
    }
  }

  private line(raw: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    const method = typeof msg.method === "string" ? msg.method : null;
    const id = typeof msg.id === "number" || typeof msg.id === "string" ? msg.id : null;
    if (method && id !== null) {
      const params = isObj(msg.params) ? msg.params : {};
      const handled = this.requestHandler?.(method, params) ?? null;
      if (!handled) {
        this.send({ id, ...serverRequestAnswer(method) });
        return;
      }
      // Answered when decided (a person may be asked); a failure refuses, never hangs the turn.
      handled.then(
        (answer) => this.send({ id, ...answer }),
        () => this.send({ id, ...serverRequestAnswer(method) }),
      );
      return;
    }
    if (method) {
      const params = isObj(msg.params) ? msg.params : {};
      for (const l of [...this.listeners]) l(method, params);
      return;
    }
    if (typeof id !== "number") return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (isObj(msg.error)) p.reject(new CodexRpcError(num(msg.error.code), str(msg.error.message) || "error"));
    else p.resolve(msg.result);
  }

  private send(msg: unknown) {
    if (this.exited) return;
    try {
      this.child.stdin?.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // gone: the exit handler settles
    }
  }

  private markExit() {
    if (this.exited) return;
    this.exited = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CodexRpcError(-1, "Codex app-server exited"));
      this.pending.delete(id);
    }
    // Lines still buffered in readline arrive first.
    setImmediate(() => {
      for (const h of [...this.exitHandlers]) h();
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    if (this.exited) return Promise.reject(new CodexRpcError(-1, "Codex app-server exited"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(-1, `Codex app-server didn't answer ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.send(params === undefined ? { method } : { method, params });
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** The turn in progress answers the app-server's requests (its approvals); null between turns. */
  onRequest(handler: ServerRequestHandler | null) {
    this.requestHandler = handler;
  }

  onExit(handler: () => void): () => void {
    if (this.exited) {
      setImmediate(handler);
      return () => {};
    }
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** Ends its input (the app-server exits) and kills the group if it lingers. */
  close(graceMs = CLOSE_GRACE_MS) {
    if (this.exited) return;
    try {
      this.child.stdin?.end();
    } catch {}
    const t = setTimeout(() => {
      if (this.exited) return;
      killTree(this.child, "SIGTERM");
      const k = setTimeout(() => {
        if (!this.exited) killTree(this.child, "SIGKILL");
      }, CLOSE_GRACE_MS);
      k.unref?.();
    }, graceMs);
    t.unref?.();
  }
}

// ── Notifications → brain events ─────────────────────────────────────────────

const usageDiff = (a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown => ({
  totalTokens: Math.max(0, num(a.totalTokens) - num(b.totalTokens)),
  inputTokens: Math.max(0, num(a.inputTokens) - num(b.inputTokens)),
  cachedInputTokens: Math.max(0, num(a.cachedInputTokens) - num(b.cachedInputTokens)),
  cacheWriteInputTokens: Math.max(0, num(a.cacheWriteInputTokens) - num(b.cacheWriteInputTokens)),
  outputTokens: Math.max(0, num(a.outputTokens) - num(b.outputTokens)),
  reasoningOutputTokens: Math.max(0, num(a.reasoningOutputTokens) - num(b.reasoningOutputTokens)),
});

/**
 * App-server notifications of one `brain.turn` (one or more Codex turns, with
 * "Parar e mandar") → the events `codex exec` gives for a turn.
 */
export class CodexAppMapper {
  /** The last agent message of the Codex turn running now. */
  private answer?: string;
  /** Agent messages already sent, streamed or whole (by item id): Codex may complete one twice. */
  private readonly sent = new Set<string>();
  private lastDeltaItem: string | null = null;
  private anyText = false;
  /** The thread's totals before this `brain.turn`, and now. */
  private base?: TokenUsageBreakdown;
  private total?: TokenUsageBreakdown;
  /** An `error` notification Codex won't retry (the turn's own error says more). */
  lastError?: string;
  /** The turn ran a command, changed a file or called our bridge: a cut now loses work the API couldn't see. */
  private worked = false;

  constructor(private readonly opts: { cwd: string; model?: string; redact?: (text: string) => string }) {}

  private clean(t: string) {
    return this.opts.redact ? this.opts.redact(t) : t;
  }

  private rel(p: string) {
    if (!p || !this.opts.cwd) return p;
    const abs = path.resolve(this.opts.cwd, p);
    return isInside(this.opts.cwd, abs) ? path.relative(this.opts.cwd, abs).split(path.sep).join("/") : p;
  }

  /** Text for the live view; messages after the first are set apart by a blank line. Redacted by the caller. */
  private textOf(itemId: string, delta: string): string {
    const sep = this.lastDeltaItem !== itemId && this.anyText ? "\n\n" : "";
    this.lastDeltaItem = itemId;
    this.anyText = true;
    return sep + delta;
  }

  /** `item/agentMessage/delta`. */
  delta(params: Record<string, unknown>): string {
    const itemId = str(params.itemId);
    const delta = str(params.delta);
    if (!delta) return "";
    this.sent.add(itemId);
    return this.textOf(itemId, delta);
  }

  /** `item/completed`: executed tool calls, the answer, and the text of a message that wasn't streamed. */
  completed(item: Record<string, unknown>): { events: CodexBrainEvent[]; text?: string } {
    const id = str(item.id) || `codex-${randomUUID()}`;
    if (item.type === "commandExecution" || item.type === "fileChange" || item.type === "mcpToolCall")
      this.worked = true;
    switch (item.type) {
      case "agentMessage": {
        const t = str(item.text);
        if (!t.trim()) return { events: [] };
        this.answer = this.clean(t);
        if (this.sent.has(id)) return { events: [] };
        this.sent.add(id);
        return { events: [], text: this.textOf(id, t) };
      }
      case "commandExecution":
        return {
          events: [
            codexCommandCall(
              {
                id,
                command: str(item.command),
                output: str(item.aggregatedOutput),
                exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
                status: str(item.status),
              },
              (t) => this.clean(t),
            ),
          ],
        };
      case "fileChange": {
        const changes = (Array.isArray(item.changes) ? item.changes : []).flatMap((c: unknown) =>
          isObj(c) && str(c.path)
            ? [{ path: this.rel(str(c.path)), kind: (isObj(c.kind) && str(c.kind.type)) || "update" }]
            : [],
        );
        const status = str(item.status);
        return { events: [codexFileChangeCall({ id, changes, failed: status === "failed" || status === "declined" })] };
      }
      default:
        // Our bridge's calls (`mcpToolCall`) aren't repeated (the engine ran them); the rest isn't a tool call.
        return { events: [] };
    }
  }

  /** `thread/tokenUsage/updated`. */
  usage(tokenUsage: unknown) {
    if (!isObj(tokenUsage) || !isObj(tokenUsage.total)) return;
    const u = tokenUsage as unknown as Partial<ThreadTokenUsage> & { total: TokenUsageBreakdown };
    // The first one of this `brain.turn`: the thread's totals before its first model request.
    if (!this.base) this.base = isObj(u.last) ? usageDiff(u.total, u.last) : u.total;
    // Totals, not sums: Codex says the same usage again (rate-limit updates) without counting twice.
    this.total = u.total;
  }

  /** A Codex turn ended and another starts in the same `brain.turn` ("Parar e mandar"): its answer, if it had one. */
  nextTurn(): string | undefined {
    const a = this.answer;
    this.answer = undefined;
    return a;
  }

  /** `turn/completed`: `usage` + `done` (held answers first), or how it failed. */
  end(turn: Turn, sessionId: string, held: string[]): CodexBrainEvent[] {
    if (turn.status === "completed") {
      const u = this.base && this.total ? usageDiff(this.total, this.base) : undefined;
      const answer = [...held, this.answer ?? ""].filter(Boolean).join("\n\n");
      return [
        {
          type: "usage",
          input: u?.inputTokens ?? 0,
          output: u?.outputTokens ?? 0,
          source: "plan",
          ...(this.opts.model ? { model: this.opts.model } : {}),
          // Codex counts cached input inside `inputTokens`.
          ...(u && u.cachedInputTokens > 0 ? { cacheRead: u.cachedInputTokens } : {}),
          ...(u && u.cacheWriteInputTokens > 0 ? { cacheWrite: u.cacheWriteInputTokens } : {}),
        },
        { type: "done", text: answer, session: { id: sessionId } },
      ];
    }
    const info = turn.error?.codexErrorInfo;
    const message = this.clean(
      str(turn.error?.message) ||
        this.lastError ||
        (turn.status === "interrupted" ? "Codex stopped the turn" : "The turn failed"),
    );
    if (info === "usageLimitExceeded")
      return [{ type: "limit" }, { type: "error", code: "plan_limit", message, worked: this.worked }];
    if (info === "unauthorized") return [{ type: "error", code: "not_logged_in", message, retryable: true }];
    return codexProblem(message, turn.status === "failed", this.worked);
  }
}

// ── Approvals (ADR 0053 §3) ──────────────────────────────────────────────────

/** A call as the command policy reads it (Claude Code's permission prompt arguments). */
export type PolicyCall = { tool_name: string; input: Record<string, unknown> };

/** A command as Codex gives it: a line (`/bin/zsh -lc "npm test"`) or an argv. */
function commandText(raw: unknown): string {
  if (typeof raw === "string") return unwrapShell(raw);
  if (!Array.isArray(raw)) return "";
  const argv = raw.filter((a): a is string => typeof a === "string");
  // `["/bin/zsh", "-lc", "npm test"]`: the shell's line.
  if (argv.length === 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0] as string) && /^-l?c$/.test(argv[1] as string)) {
    return (argv[2] as string).trim();
  }
  return argv.join(" ").trim();
}

/**
 * What one approval Codex asks is, for the command policy: the shell command
 * (`item/commandExecution/requestApproval`), or a write of each file a change
 * touches and of the folder it wants (`item/fileChange/requestApproval`; the
 * files come from the change's `item/started`). Empty: nothing to judge it by
 * (declined). Null: not an approval.
 */
export function approvalCalls(
  method: string,
  params: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  cwd: string,
): PolicyCall[] | null {
  if (method === "item/commandExecution/requestApproval") {
    const command = commandText(params.command ?? item?.command);
    return command ? [{ tool_name: "Bash", input: { command } }] : [];
  }
  if (method === "item/fileChange/requestApproval") {
    const changes: unknown[] = item && Array.isArray(item.changes) ? item.changes : [];
    const files = changes.flatMap((c) => (isObj(c) && str(c.path) ? [path.resolve(cwd, str(c.path))] : []));
    const root = str(params.grantRoot);
    if (root) files.push(path.resolve(cwd, root));
    return files.map((file) => ({ tool_name: "Write", input: { file_path: file } }));
  }
  return null;
}

/** `accept` only when the policy allows every call of the approval (`permissionPrompt`, as Claude Code's prompt). */
export async function decideApproval(
  calls: PolicyCall[],
  ask: (tool: string, args: Record<string, unknown>) => Promise<IpcReply>,
  opts: { scope: CommandScope; profile: CommandProfile; signal?: AbortSignal },
): Promise<"accept" | "decline"> {
  if (calls.length === 0) return "decline";
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (opts.signal?.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  // The turn ended while a person was asked: stop asking (the answer is a refusal).
  const call = (tool: string, args: Record<string, unknown>): Promise<IpcReply> =>
    opts.signal?.aborted ? Promise.resolve({ ok: false, error: "The turn ended." }) : ask(tool, args);
  for (const c of calls) {
    const answer = await permissionPrompt(c, call, { scope: opts.scope, profile: opts.profile, sleep });
    if (answer.behavior !== "allow") return "decline";
  }
  return "accept";
}

// ── The processes ────────────────────────────────────────────────────────────

/** A message for the turn in progress (`brain.steer`). */
type SteerMessage = BrainSteerRequest["messages"][number];

interface AppLive {
  key: string;
  /** Also the MCP bridge's id (`mcp --run <id>`). */
  id: string;
  agentId: string;
  /** The account it signs in with; null: the computer's own sign-in. */
  account: string | null;
  sessionId: string;
  threadKey: string;
  client: CodexAppClient;
  sig: string;
  threadId: string | null;
  /** The tool names its thread opened with (`mcp.tools`): what its Codex listed, once. */
  tools: Set<string> | null;
  busy: boolean;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The bridge entry between turns (no run: its calls are refused quietly). */
  bridge: McpTaskInfo | null;
  /** The turn in progress: messages for it mid-turn. */
  turn: { runId: string; steer(messages: SteerMessage[]): Promise<BrainSteerReply> } | null;
}

interface AppOutcome {
  died?: boolean;
  canceled?: boolean;
  /** Steered messages the turn never said it read. */
  unread?: string[];
}

export interface CodexAppServersOptions {
  /** The MCP bridge's registry (the daemon's Codex runs): each process's server is `mcp --run <process id>`. */
  runs: Map<string, McpTaskInfo>;
  idleMs?: number;
  maxProcesses?: number;
  /** Tests: the delta batching and how long `initialize` may take. */
  deltaMs?: number;
  startTimeoutMs?: number;
  /**
   * How an approval reaches the server (`permission_prompt` for the turn's run). Default: the daemon's MCP
   * endpoint, as the process's own bridge (its id and local token). Tests: a fake server.
   */
  ask?: (process: { id: string; token: string }, tool: string, args: Record<string, unknown>) => Promise<IpcReply>;
  /** Protocol 19: Codex's `account/rateLimits/updated` (`rateLimits`), for the process's account (null: its own sign-in). */
  onRateLimits?: (account: string | null, rateLimits: unknown) => void;
  /** How `codex app-server` starts (a worker under systemd: in the agent's AI CLIs slice, `scope-gate.ts`). */
  spawn?: Spawn;
  log?: (line: string) => void;
}

const canceledEvent: CodexBrainEvent = { type: "error", code: "canceled", message: "The turn was canceled." };

export class CodexAppServers implements CodexAppRunner {
  private readonly live = new Map<string, AppLive>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Runs on a process now (steering finds them), and runs `codex exec` runs instead. */
  private readonly running = new Map<string, AppLive>();
  /** Runs on `codex exec`, with the account each signs in with (null: the computer's own). */
  private readonly execRuns = new Map<string, string | null>();
  /** Turns from their start to their end (an app-server's handshake too), with their account like `execRuns`. */
  private readonly turns = new Map<string, string | null>();
  /** `<bin>@<version>` whose app-server didn't start: exec for it from then on. */
  private readonly broken = new Set<string>();
  private closed = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: CodexAppServersOptions) {
    this.log = opts.log ?? (() => {});
  }

  setLimits(limits: { idleMs?: number; maxProcesses?: number }) {
    if (limits.idleMs !== undefined) this.opts.idleMs = limits.idleMs;
    if (limits.maxProcesses !== undefined) this.opts.maxProcesses = limits.maxProcesses;
  }

  /** App-servers alive now. */
  get size() {
    return [...this.live.values()].filter((l) => !l.client.exited).length;
  }

  /** Whether a process of that sign-in is open: a turn, or an app-server kept after one (`null`: the computer's own). */
  holds(account: string | null): boolean {
    for (const l of this.live.values()) if (l.account === account && !l.client.exited) return true;
    return [...this.turns.values()].includes(account);
  }

  /** The process of an agent's session (tests). */
  process(agentId: string, sessionId: string, account?: string): CodexAppClient | undefined {
    return this.live.get(`${agentId}:${codexThreadKey(sessionId, account)}`)?.client;
  }

  /**
   * Protocol 15: messages for the Codex turn of `runId`. On an app-server:
   * `turn/steer` (or the urgent restart); run by `codex exec`: `unsupported`;
   * starting or ended: `no_turn` (they wait for the next turn).
   */
  async steer(agentId: string, req: BrainSteerRequest): Promise<BrainSteerReply> {
    const live = this.running.get(req.runId);
    if (live) {
      if (live.agentId !== agentId || live.sessionId !== req.session || live.client.exited)
        return { status: "no_turn" };
      if (!live.turn || live.turn.runId !== req.runId) return { status: "no_turn", reason: "Codex is starting" };
      return live.turn.steer(req.messages);
    }
    if (this.execRuns.has(req.runId)) {
      return { status: "unsupported", reason: "This Codex turn runs with codex exec: it reads messages between turns" };
    }
    // Starting (spawn, handshake, thread), or ended: the messages wait for the next turn.
    return { status: "no_turn" };
  }

  async turn(
    input: CodexTurnInput & { version: string },
    opts: CodexTurnOptions,
    exec: () => Promise<void>,
  ): Promise<void> {
    // Held from here, so no route starts beside it, and a route already on its sign-in stops first: two
    // processes on one sign-in race on its refresh token.
    this.turns.set(input.runId, input.account?.id ?? null);
    try {
      await yieldRoute("codex", input.account?.home);
      await this.turnOn(input, opts, exec);
    } finally {
      this.turns.delete(input.runId);
    }
  }

  private async turnOn(
    input: CodexTurnInput & { version: string },
    opts: CodexTurnOptions,
    exec: () => Promise<void>,
  ): Promise<void> {
    const viaExec = async () => {
      this.execRuns.set(input.runId, input.account?.id ?? null);
      try {
        await exec();
      } finally {
        this.execRuns.delete(input.runId);
      }
    };
    if (this.closed || input.mcp.url || !input.agentId || !codexAtLeast(input.version)) return viaExec();
    if (this.broken.has(`${opts.bin ?? "codex"}@${input.version}`)) return viaExec();
    const threadKey = codexThreadKey(input.sessionId, input.account?.id);
    const key = `${input.agentId}:${threadKey}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.runTurn(key, threadKey, input, opts));
    this.chains.set(key, run);
    let handled = false;
    try {
      handled = await run;
    } catch (err) {
      this.log(`codex app-server turn failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.chains.get(key) === run) this.chains.delete(key);
    }
    if (!handled) await viaExec();
  }

  private signature(input: CodexTurnInput, opts: CodexTurnOptions) {
    return JSON.stringify({
      cwd: input.cwd,
      roots: input.writableRoots ?? [],
      account: input.account?.home ?? null,
      bin: opts.bin ?? "codex",
      mcp: opts.mcpCommand ?? null,
      socket: opts.socketPath ?? null,
      env: opts.env ?? {},
      // A thread's sandbox is set when it opens: another profile is another process.
      profile: input.profile ?? "work",
      // The context limit is the process's (`-c`): another one is another process.
      context: input.contextTokens ?? null,
    });
  }

  private async runTurn(
    key: string,
    threadKey: string,
    input: CodexTurnInput & { version: string },
    opts: CodexTurnOptions,
  ): Promise<boolean> {
    if (opts.signal.aborted) {
      opts.emit(canceledEvent);
      return true;
    }
    const sig = this.signature(input, opts);
    let live = this.live.get(key);
    // Codex lists our tools when its thread opens and never again (codex-cli 0.165.0 doesn't follow
    // `tools/list_changed`: its `mcp_tool_list_changed` feature is under development and off): other tool names
    // start the process again, resumed, so the turn can call what the agent may use now. Only a new name does: a
    // dropped one stays listed, and the server answers a call to it.
    const listed = live?.tools;
    const stale = !!listed && !!input.mcp.tools && input.mcp.tools.split(" ").some((n) => !listed.has(n));
    if (live && (live.client.exited || live.sig !== sig || stale)) {
      if (stale) this.log(`codex app-server for ${input.sessionId.slice(0, 8)}: its tools changed; starting it again`);
      this.drop(live);
      live = undefined;
    }
    if (!live) {
      const agent = input.agentId ?? "";
      const lru = this.alive(agent) >= this.max ? this.lruIdle(agent) : undefined;
      if (lru) this.drop(lru);
      // Over the cap when every app-server is busy: the turn still gets its own (steering reaches it, never exec's
      // `unsupported`); `trim` closes the extra as turns end.
      const started = await this.start(key, threadKey, sig, input, opts);
      if (!started) return false;
      live = started;
    }
    const out = await this.onLive(live, input, opts);
    if (out.died) {
      this.log(`codex app-server for ${input.sessionId.slice(0, 8)} died mid-turn; running it with exec`);
      this.drop(live);
      return false;
    }
    // Canceled, a steered message it never read (Codex might still act on it unheard), or a background
    // turn (nothing stays alive for it): the process goes.
    if (out.canceled || out.unread?.length || input.keepAlive === false) this.drop(live);
    return true;
  }

  private async start(
    key: string,
    threadKey: string,
    sig: string,
    input: CodexTurnInput & { version: string },
    opts: CodexTurnOptions,
  ): Promise<AppLive | null> {
    const id = randomUUID();
    const token = newMcpToken();
    const base: NodeJS.ProcessEnv = {
      ...withoutContainers(process.env),
      ...(opts.env ?? {}),
      [CODEX_MCP_ENV[0]]: token,
      ...(opts.socketPath ? { [CODEX_MCP_ENV[1]]: opts.socketPath } : {}),
      ...(opts.runnerHome ? { [CODEX_MCP_ENV[2]]: opts.runnerHome } : {}),
    };
    // ADR 0041: the account's folder is this process's Codex home, and nothing else signs it in.
    const env = input.account ? accountEnv("codex", input.account.home, base) : base;
    const args = codexAppServerArgs({
      processId: id,
      mcp: { ...(opts.mcpCommand ? { command: opts.mcpCommand } : {}) },
      ...(input.writableRoots?.length ? { writableRoots: input.writableRoots } : {}),
      ...(input.contextTokens ? { contextTokens: input.contextTokens } : {}),
    });
    const brokenKey = `${opts.bin ?? "codex"}@${input.version}`;
    let client: CodexAppClient;
    try {
      client = new CodexAppClient(resolveCommand(opts.bin ?? "codex", env.PATH), args, {
        cwd: input.cwd,
        env,
        ...(this.opts.spawn ? { spawn: this.opts.spawn } : {}),
      });
    } catch (err) {
      this.log(`codex app-server didn't start: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    try {
      await client.request(
        "initialize",
        {
          clientInfo: { name: "agentes_runner", title: "agentes.chat runner", version: "1" },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            // Never read here (each is one line per chunk of output).
            optOutNotificationMethods: [
              "item/commandExecution/outputDelta",
              "item/fileChange/outputDelta",
              "item/reasoning/textDelta",
              "item/reasoning/summaryTextDelta",
              "item/reasoning/summaryPartAdded",
              "item/plan/delta",
              "turn/diff/updated",
            ],
          },
        },
        this.opts.startTimeoutMs ?? START_TIMEOUT_MS,
      );
      client.notify("initialized");
    } catch (err) {
      const tail = client.stderr.trim().split("\n").slice(-2).join(" ");
      this.log(
        `codex app-server handshake failed (${err instanceof Error ? err.message : String(err)}${tail ? `: ${tail}` : ""}); using codex exec`,
      );
      this.broken.add(brokenKey);
      client.close(0);
      return null;
    }
    const bridge: McpTaskInfo = {
      token,
      missionId: "",
      running: false,
      idle: true,
      cwd: input.cwd,
      folder: input.folder ?? input.cwd,
    };
    this.opts.runs.set(id, bridge);
    const live: AppLive = {
      key,
      id,
      agentId: input.agentId ?? "",
      account: input.account?.id ?? null,
      sessionId: input.sessionId,
      threadKey,
      client,
      sig,
      threadId: null,
      tools: null,
      busy: false,
      lastUsed: Date.now(),
      idleTimer: null,
      bridge,
      turn: null,
    };
    this.live.set(key, live);
    // Gone while idle: forgotten; the next turn starts it again (resumed).
    client.onExit(() => {
      if (!live.busy) this.drop(live);
    });
    const account = input.account?.id ?? null;
    client.onNotification((method, params) => {
      if (method === "account/rateLimits/updated") this.opts.onRateLimits?.(account, params.rateLimits);
    });
    this.log(`codex app-server for ${input.sessionId.slice(0, 8)} started`);
    return live;
  }

  private async onLive(live: AppLive, input: CodexTurnInput, opts: CodexTurnOptions): Promise<AppOutcome> {
    live.busy = true;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    // The bridge relays for this run now, with its server token.
    if (live.bridge) {
      this.opts.runs.set(live.id, {
        token: live.bridge.token,
        missionId: "",
        running: true,
        cwd: live.bridge.cwd ?? input.cwd,
        folder: live.bridge.folder ?? input.cwd,
        runId: input.runId,
        serverToken: input.mcp.token,
        ...(opts.redact ? { redact: opts.redact } : {}),
      });
    }
    this.running.set(input.runId, live);
    try {
      if (!live.threadId) {
        live.tools = input.mcp.tools ? new Set(input.mcp.tools.split(" ")) : null;
        const opened = await this.openThread(live, input, opts);
        if (opened !== true) return opened;
      }
      return await this.runOnThread(live, input, opts);
    } finally {
      if (this.running.get(input.runId) === live) this.running.delete(input.runId);
      live.busy = false;
      live.turn = null;
      live.lastUsed = Date.now();
      if (live.bridge && this.opts.runs.has(live.id)) this.opts.runs.set(live.id, live.bridge);
      if (this.live.get(live.key) === live) this.armIdle(live);
      this.trim(live.agentId);
    }
  }

  /** The session's thread on this process: resumed by its stored id, else a new one with the instructions. */
  private async openThread(live: AppLive, input: CodexTurnInput, opts: CodexTurnOptions): Promise<true | AppOutcome> {
    const client = live.client;
    const common = {
      cwd: input.cwd,
      ...codexThreadPolicy(input.profile ?? "work"),
      ...(input.model ? { model: input.model } : {}),
    };
    const stored = opts.threads.get(live.threadKey);
    if (stored) {
      try {
        const r = await client.request<ThreadResponse>("thread/resume", {
          threadId: stored,
          ...common,
          excludeTurns: true,
        });
        live.threadId = str(r?.thread?.id) || stored;
        return true;
      } catch (err) {
        if (client.exited) return { died: true };
        // Lost (another Codex home, a cleaned folder): a new thread, with the instructions again, as exec does.
        this.log(
          `codex thread ${stored.slice(0, 8)} not resumed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    const instructions = input.system.trim();
    try {
      const r = await client.request<ThreadResponse>("thread/start", {
        ...common,
        ...(instructions ? { developerInstructions: instructions } : {}),
      });
      const id = str(r?.thread?.id);
      if (!id) throw new CodexRpcError(0, "Codex started a thread without an id");
      live.threadId = id;
      opts.threads.set(live.threadKey, id);
      return true;
    } catch (err) {
      if (client.exited) return { died: true };
      const message = err instanceof Error ? err.message : String(err);
      for (const e of codexProblem(opts.redact ? opts.redact(message) : message, false)) opts.emit(e);
      return {};
    }
  }

  /** One `brain.turn` on the thread: `turn/start`, its events, steering; ends with one `done` or `error`. */
  private runOnThread(live: AppLive, input: CodexTurnInput, opts: CodexTurnOptions): Promise<AppOutcome> {
    const client = live.client;
    const threadId = live.threadId as string;
    const redact = opts.redact ?? ((s: string) => s);
    const deltaMs = this.opts.deltaMs ?? CODEX_APP_DELTA_MS;
    const mapper = new CodexAppMapper({
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(opts.redact ? { redact: opts.redact } : {}),
    });
    const overrides = {
      ...(input.model ? { model: input.model } : {}),
      ...(isBrainEffort(input.effort) ? { effort: codexEffort(input.effort) } : {}),
      serviceTier: input.speed === "fast" ? "fast" : null,
    };
    return new Promise<AppOutcome>((resolve) => {
      let settled = false;
      let canceled = false;
      /** The Codex turn running now (null while one starts). */
      let turnId: string | null = null;
      /** Steered inputs not read yet: our `clientUserMessageId` → the message uuids it carries. */
      const unread = new Map<string, string[]>();
      /** `turn/steer` requests not answered yet (by `clientUserMessageId`). */
      const asking = new Set<string>();
      /** "Parar e mandar": the turn is being interrupted; these start the next one. */
      let restart: SteerMessage[] | null = null;
      /** Answers of Codex turns that ended before the last one (an urgent message arrived as one completed). */
      const held: string[] = [];
      let buf = "";
      /** Redacted text kept back from the last batch, so a value split between batches never leaves in pieces. */
      let tail = "";
      const hold = opts.redact ? Math.max(0, opts.redactHold ?? 0) : 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      /** Commands and changes Codex started (an approval names its item; a change's files are only here). */
      const items = new Map<string, Record<string, unknown>>();
      /** Approvals end with the turn: one still waiting for a person is refused then. */
      const approvals = new AbortController();

      /** Sends the text so far; a batch (`whole` false) keeps back its last `hold` characters for the next one. */
      const flush = (whole = true) => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!buf && !(whole && tail)) return;
        const out = redact(tail + buf);
        buf = "";
        const cut = whole ? out.length : Math.max(0, out.length - hold);
        tail = out.slice(cut);
        if (cut > 0) opts.emit({ type: "text_delta", text: out.slice(0, cut) });
      };
      const addText = (t: string) => {
        if (!t) return;
        buf += t;
        if (!timer) timer = setTimeout(() => flush(false), deltaMs);
      };
      const emit = (e: CodexBrainEvent) => {
        flush();
        opts.emit(e);
      };
      const finish = (events: CodexBrainEvent[], out: AppOutcome = {}) => {
        if (settled) return;
        flush();
        settled = true;
        for (const e of events) opts.emit(e);
        live.turn = null;
        client.onRequest(null);
        approvals.abort();
        offNote();
        offExit();
        opts.signal.removeEventListener("abort", onAbort);
        // A steer still unanswered when the turn ended was refused (Codex accepts one only while its turn runs).
        const left = [...unread.entries()].filter(([id]) => !asking.has(id)).flatMap(([, uuids]) => uuids);
        resolve(left.length ? { ...out, unread: left } : out);
      };
      const interrupt = (id: string) =>
        client.request("turn/interrupt", { threadId, turnId: id }, STEER_RPC_MS).catch(() => undefined);
      const startTurn = (clientId: string, texts: string[]) => {
        turnId = null;
        client
          .request<TurnStartResponse>("turn/start", {
            threadId,
            clientUserMessageId: clientId,
            input: texts.map(text),
            ...overrides,
          })
          .then((r) => {
            if (!turnId) turnId = str(r?.turn?.id) || null;
            if (canceled && turnId) void interrupt(turnId);
          })
          .catch((err: unknown) => {
            // Gone: the exit handler settles it.
            if (client.exited) return;
            const message = err instanceof Error ? err.message : String(err);
            finish(codexProblem(redact(message), false));
          });
      };

      live.turn = {
        runId: input.runId,
        steer: async (messages) => {
          if (settled || canceled) return { status: "no_turn" };
          const uuids = messages.map((m) => m.uuid);
          // Interrupting already: these join the messages the next turn starts with.
          if (restart) {
            restart.push(...messages);
            return { status: "accepted", accepted: uuids };
          }
          const current = turnId;
          if (!current) return { status: "no_turn", reason: "Codex is starting the turn" };
          if (messages.some((m) => m.urgent)) {
            const batch = [...messages];
            restart = batch;
            try {
              await client.request("turn/interrupt", { threadId, turnId: current }, STEER_RPC_MS);
              return { status: "accepted", accepted: uuids };
            } catch (err) {
              // The turn completed meanwhile and the next one already started with them: delivered all the same.
              if (restart !== batch) return { status: "accepted", accepted: uuids };
              restart = null;
              return { status: "no_turn", reason: err instanceof Error ? err.message : String(err) };
            }
          }
          const accepted: string[] = [];
          for (const m of messages) {
            // Known before the request: Codex may say it read it before it answers.
            unread.set(m.uuid, [m.uuid]);
            asking.add(m.uuid);
            try {
              await client.request(
                "turn/steer",
                { threadId, expectedTurnId: current, clientUserMessageId: m.uuid, input: [text(m.text)] },
                STEER_RPC_MS,
              );
              accepted.push(m.uuid);
            } catch (err) {
              unread.delete(m.uuid);
              // "no active turn to steer", "expected active turn id …", a turn that can't be steered (review, compact).
              if (accepted.length) break;
              return { status: "no_turn", reason: err instanceof Error ? err.message : String(err) };
            } finally {
              asking.delete(m.uuid);
            }
          }
          return { status: "accepted", accepted };
        },
      };

      const completed = (turn: Turn) => {
        if (turnId && turn.id !== turnId) return;
        flush();
        if (restart && turn.status !== "failed") {
          // The next Codex turn starts with the urgent messages (and any that came while it stopped).
          const answer = mapper.nextTurn();
          if (turn.status === "completed" && answer) held.push(answer);
          const batch = restart;
          restart = null;
          const clientId = (batch[0] as SteerMessage).uuid;
          unread.set(
            clientId,
            batch.map((m) => m.uuid),
          );
          startTurn(
            clientId,
            batch.map((m) => m.text),
          );
          return;
        }
        finish(mapper.end(turn, input.sessionId, held));
      };

      const offNote = client.onNotification((method, params) => {
        if (settled) return;
        if (typeof params.threadId === "string" && params.threadId !== threadId) return;
        switch (method) {
          case "turn/started": {
            const id = isObj(params.turn) ? str(params.turn.id) : "";
            if (!turnId && id) turnId = id;
            return;
          }
          case "item/agentMessage/delta":
            addText(mapper.delta(params));
            return;
          case "item/started":
          case "item/completed": {
            const item = isObj(params.item) ? params.item : {};
            if ((item.type === "commandExecution" || item.type === "fileChange") && str(item.id)) {
              if (method === "item/started") items.set(str(item.id), item);
              else items.delete(str(item.id));
            }
            if (item.type === "userMessage") {
              const ours = unread.get(str(item.clientId));
              if (ours) {
                unread.delete(str(item.clientId));
                emit({ type: "steer_read", uuids: ours });
              }
              return;
            }
            if (method !== "item/completed") return;
            const out = mapper.completed(item);
            if (out.text) addText(out.text);
            for (const e of out.events) emit(e);
            return;
          }
          case "thread/tokenUsage/updated":
            mapper.usage(params.tokenUsage);
            return;
          case "error": {
            const error = isObj(params.error) ? params.error : {};
            if (params.willRetry !== true && str(error.message)) mapper.lastError = str(error.message);
            return;
          }
          case "turn/completed":
            if (isObj(params.turn)) completed(params.turn as unknown as Turn);
            return;
          default:
            return;
        }
      });
      const offExit = client.onExit(() => finish([], { died: true }));
      // Codex's approvals for this turn: the command policy decides, as for Claude Code's prompts.
      const ask = this.approvalAsker(live, opts);
      const scope: CommandScope = {
        cwd: input.cwd,
        folders: [...new Set([input.cwd, input.folder ?? input.cwd, ...(input.writableRoots ?? [])])],
        ...(process.env.HOME ? { home: process.env.HOME } : {}),
        ...(opts.runnerHome ? { runnerHome: opts.runnerHome } : {}),
      };
      client.onRequest((method, params) => {
        if (settled) return null;
        if (typeof params.threadId === "string" && params.threadId !== threadId) return null;
        const calls = approvalCalls(method, params, items.get(str(params.itemId)), input.cwd);
        if (calls === null) return null;
        return decideApproval(calls, ask, {
          scope,
          profile: input.profile ?? "work",
          signal: approvals.signal,
        }).then((decision) => {
          if (decision === "decline")
            this.log(`codex approval declined: ${redact(JSON.stringify(calls)).slice(0, 300)}`);
          return { result: { decision } };
        });
      });
      function onAbort() {
        canceled = true;
        if (turnId) void interrupt(turnId);
        finish([canceledEvent], { canceled: true });
      }
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
      startTurn(input.runId, [input.prompt]);
    });
  }

  /** How this process's approvals reach the server: as its own bridge (its id and local token, relayed for the turn's run). */
  private approvalAsker(live: AppLive, opts: CodexTurnOptions) {
    const token = live.bridge?.token ?? "";
    const custom = this.opts.ask;
    if (custom) return (tool: string, args: Record<string, unknown>) => custom({ id: live.id, token }, tool, args);
    const socketPath = opts.socketPath;
    return (tool: string, args: Record<string, unknown>): Promise<IpcReply> =>
      socketPath
        ? ipcCall(socketPath, { taskId: live.id, token, tool, args })
        : Promise.resolve({ ok: false, error: "This computer can't ask agentes.chat (no local endpoint)." });
  }

  private armIdle(live: AppLive) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      if (!live.busy) {
        this.log(`codex app-server for ${live.sessionId.slice(0, 8)} idle; closing`);
        this.drop(live);
      }
    }, this.opts.idleMs ?? CODEX_APP_IDLE_MS);
    live.idleTimer.unref?.();
  }

  private get max() {
    return this.opts.maxProcesses ?? CODEX_APP_MAX_PROCESSES;
  }

  /** The cap is per agent: one agent's turns never close another's warm app-server. */
  private alive(agentId: string) {
    return [...this.live.values()].filter((l) => l.agentId === agentId && !l.client.exited).length;
  }

  private lruIdle(agentId: string): AppLive | undefined {
    let lru: AppLive | undefined;
    for (const l of this.live.values()) {
      if (l.busy || l.agentId !== agentId) continue;
      if (!lru || l.lastUsed < lru.lastUsed) lru = l;
    }
    return lru;
  }

  /** Back within the agent's cap once its turns end, least recently used idle first. */
  private trim(agentId: string) {
    while (this.alive(agentId) > this.max) {
      const l = this.lruIdle(agentId);
      if (!l) return;
      this.drop(l);
    }
  }

  private drop(live: AppLive) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (this.live.get(live.key) === live) this.live.delete(live.key);
    this.opts.runs.delete(live.id);
    live.bridge = null;
    live.client.close();
  }

  /** The runner is exiting: every process is closed. */
  close() {
    this.closed = true;
    for (const l of [...this.live.values()]) this.drop(l);
  }
}
