import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import type { AgentScope, BrainEffort } from "@agenteschat/adapters/machine-protocol";
import { isAccountId } from "@agenteschat/adapters/machine-protocol";
import { ACCOUNT_MISSING_MESSAGE, accountEnv, withoutContainers, withoutSignIns } from "./accounts";
import { AGY_CHAT_AGENT, prepareAgyHome } from "./agy-home";
import { LIMIT_TEXT } from "./brain";
import { type CodexBrainEvent, CodexThreads, chatFolder, codexProfileOf, codexThreadKey } from "./brain-codex";
import { cursorPrompt } from "./brain-cursor";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { AGY_BIN, resolveCommand } from "./executors";
import { CODEX_MCP_ENV, CODEX_MCP_SERVER, redactDeep } from "./mcp";
import { resolveForAgent } from "./paths";
import { resetFromWords } from "./plan-usage";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The Antigravity branch of `brain.turn` (protocol 44, ADR 0143): one agent turn as one run of Google's Antigravity
 * CLI (`agy -p --output-format stream-json`), its NDJSON read here: `init` (the conversation and every tool), then
 * `step_update`s (the reply's text deltas, each tool step with its call and output, per-step usage), then `result`.
 * Flags and shapes as antigravity.google/docs/cli/headless and cli/reference list them, read 2026-11-04.
 *
 * - Always an account, on Linux: its folder is the CLI's whole `HOME` (`agy-home.ts`), prepared before every turn
 *   (settings, our MCP server alone, Lodi's agent; anything an earlier turn planted removed). The run and its token
 *   reach our server through the env it inherits, so the account's turns of several agents share one config.
 * - The chat: `init` names the conversation; our session → that conversation lives in
 *   `<runner home>/brain/antigravity-chats.json` (per account), resumed with `--conversation`. A new chat leads its
 *   prompt with the engine's context (`cursorPrompt`); a resume that comes back as another conversation (the CLI
 *   only warns on one it doesn't know) is stopped at `init` and started again with the context.
 * - ADR 0053 §3: every turn runs with `--sandbox` (terminal commands in the CLI's sandbox: the turn's folder and temp,
 *   no network) and the account's `proceed-in-sandbox`; `work` adds `--mode accept-edits` (edits in the workspace
 *   without asking), `plan` doesn't (an edit needs an approval nobody gives in headless mode, so it is refused).
 * - `chat` (the team's right hand, ADR 0137 §4): `--agent agenteschat-chat` (no built-in tool, no commands, never a
 *   subagent), in an empty folder with none of the agent's secrets. `antigravityChatBreach` kills the turn on an
 *   `init` listing any tool but our server's, on anything before `init`, on a tool step that isn't ours and on a
 *   subagent.
 * - Our server's calls are not repeated as `tool_call`: the engine ran them. The CLI's own tools are, as what the turn
 *   tried. Usage is the plan's (`source: "plan"`): the turn's `agent_response` steps summed (`result.usage` counts
 *   the whole conversation).
 * - A failed turn exits non-zero; a model or agent failure exits 3 with an `AGY_ERROR: {…}` line on stderr (its
 *   canonical status, HTTP or gRPC code, retryability): quota and rate limits are `plan_limit`, a refused sign-in
 *   `not_logged_in`.
 * - No live steering: `-p` takes nothing mid-turn (`brain.steer` answers `unsupported`).
 */

const KILL_GRACE_MS = 5000;

/** `brain.turn` with `kind: "antigravity"`. */
export interface AntigravityBrainTurnRequest {
  runId: string;
  kind: "antigravity";
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

/** Where our session → conversation ids live in the runner home. */
export const antigravityChatsFile = (runnerHome: string) => path.join(runnerHome, "brain", "antigravity-chats.json");

/** The env name our bridge's run id comes through (`agentes-runner mcp` with no `--run` reads it). */
export const AGY_RUN_ENV = "AGENTES_MCP_RUN";

/**
 * A tool of our server, as the CLI may name it: `agenteschat_agentes__post_message`, `…/post_message`,
 * `mcp_agenteschat_agentes_post_message`. Anything else is the CLI's own.
 */
const OURS = new RegExp(`^(?:mcp[_.:/-]{1,2})?${CODEX_MCP_SERVER}(?:__|[_.:/-])[\\w.-]+$`);
export const isOurAgyTool = (name: unknown) => typeof name === "string" && OURS.test(name);

/** `--effort`: low, medium or high (`xhigh` and `max` as high); a slug that names its level (`…-high`) takes none. */
const agyEffort = (effort?: BrainEffort, model?: string) =>
  model && /-(?:low|medium|high)$/.test(model) ? undefined : effort === "xhigh" || effort === "max" ? "high" : effort;

/** The `agy` arguments for one turn. */
export function antigravityTurnArgs(input: {
  prompt: string;
  chat?: string;
  model?: string;
  effort?: BrainEffort;
  profile?: CommandProfile;
  /** The team's right hand: our server's tools alone. */
  locked?: boolean;
}): string[] {
  const effort = agyEffort(input.effort, input.model);
  return [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--sandbox",
    "--disable-slash-commands",
    ...(input.locked ? ["--agent", AGY_CHAT_AGENT] : input.profile === "plan" ? [] : ["--mode", "accept-edits"]),
    ...(input.model ? ["--model", input.model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(input.chat ? ["--conversation", input.chat] : []),
  ];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A `chat` turn's guard (protocol 44), line by line: `init` must list our server's tools alone, nothing may come
 * before it, and no step may be a tool that isn't ours or a subagent. Null when the line is fine.
 */
export function antigravityChatBreach(ev: Record<string, unknown>, sawInit: boolean): string | null {
  const stop = (why: string) => `${why}, so the turn stopped.`;
  if (ev.event === "init") {
    const tools = isRecord(ev.init) ? ev.init.tools : undefined;
    if (!Array.isArray(tools)) return "The Antigravity CLI didn't list its tools, so the turn stopped before it began.";
    const theirs = tools.filter((t) => !isOurAgyTool(t)).map((t) => String(t).slice(0, 64));
    if (theirs.length === 0) return null;
    return `The Antigravity CLI offers tools of its own here (${theirs.slice(0, 8).join(", ")}), so the turn stopped before it could use them.`;
  }
  if (!sawInit) return stop("The Antigravity CLI answered before listing its tools");
  if (ev.event !== "step_update") return null;
  const step = isRecord(ev.step_update) ? ev.step_update : {};
  if (step.subagent_info !== undefined) return stop("The Antigravity CLI started another agent");
  const info = isRecord(step.tool_info) ? step.tool_info : {};
  const name = step.tool_name ?? info.name;
  if ((step.step_type === "tool" || name !== undefined) && !isOurAgyTool(name)) {
    return stop(`The Antigravity CLI used a tool of its own (${String(name ?? "unknown").slice(0, 64)})`);
  }
  return null;
}

/** `AGY_ERROR: {…}` on stderr (CLI 1.2.x): what it says, and whether it is a limit or a refused sign-in. */
export function parseAgyError(stderr: string): { message: string; limit: boolean; auth: boolean } | null {
  const line = stderr
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("AGY_ERROR:"));
  if (!line) return null;
  let o: Record<string, unknown> = {};
  try {
    const v = JSON.parse(line.slice("AGY_ERROR:".length).trim());
    if (isRecord(v)) o = v;
  } catch {
    return { message: line.slice(0, 500), limit: false, auth: false };
  }
  const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  const status = `${str(o.status)} ${str(o.canonical_status)} ${str(o.code)} ${str(o.http_status)}`;
  const message = (str(o.message) || str(o.error) || status.trim() || "The model call failed").slice(0, 500);
  return {
    message,
    limit: /RESOURCE_EXHAUSTED|\b429\b/i.test(status) || AGY_LIMIT.test(message),
    auth: /UNAUTHENTICATED|\b401\b/i.test(status) || AGY_AUTH.test(message),
  };
}

const AGY_LIMIT = /quota|rate.?limit|usage limit|resource.?exhausted|weekly limit|five.?hour limit|out of credits/i;
/** The CLI can't sign in (signed out, a refused token, no license). */
export const AGY_AUTH =
  /auth(?:entication)? required|not (?:authenticated|logged in|signed in)|unauthenticated|unauthori[sz]ed|\b401\b|invalid (?:token|credentials|grant)|license/i;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `antigravity_failed`. */
export function antigravityProblem(
  problem: string,
  o: { worked?: boolean; limit?: boolean; auth?: boolean; now?: number } = {},
): CodexBrainEvent[] {
  if (o.limit || AGY_LIMIT.test(problem) || LIMIT_TEXT.test(problem)) {
    const resetsAt = resetFromWords(problem, o.now);
    return [
      { type: "limit", ...(resetsAt ? { resetsAt } : {}) },
      { type: "error", code: "plan_limit", message: problem, retryable: true, worked: o.worked ?? false },
    ];
  }
  if (o.auth || AGY_AUTH.test(problem))
    return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "antigravity_failed", message: problem, retryable: true }];
}

const tokens = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** One usage record as ours: every input token (the CLI's input may already leave the cache out), output with thinking. */
function usageOf(u: Record<string, unknown>) {
  const input = tokens(u.input_tokens);
  const cacheRead = tokens(u.cache_read_tokens);
  return { input: input >= cacheRead ? input : input + cacheRead, output: tokens(u.output_tokens), cacheRead };
}

export interface AntigravityTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  effort?: BrainEffort;
  system: string;
  prompt: string;
  mcp: { token: string };
  /** The account: its folder is the CLI's `HOME`, its chats are its own. */
  account: { id: string; home: string };
  profile?: CommandProfile;
  /** The team's right hand (`cwd` its empty `chatFolder`): killed at a tool of the CLI's own. */
  chat?: boolean;
}

export interface AntigravityTurnOptions {
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
  now?: () => number;
}

/** Runs one Antigravity turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runAntigravityTurn(input: AntigravityTurnInput, opts: AntigravityTurnOptions): Promise<void> {
  const fail = (code: string, message: string, retryable?: boolean) =>
    opts.emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
  // Elsewhere the CLI keeps its sign-in in the one keychain of the computer's user (ADR 0143).
  if ((opts.platform ?? process.platform) !== "linux") {
    return fail("unsupported", "Gemini plans think on Linux computers only, for now.");
  }
  try {
    prepareAgyHome(input.account.home, opts.mcpCommand);
    if (input.chat) {
      // Nothing of the workspace's own config (`.agents/`, `.gemini/`) in Lodi's folder.
      for (const name of [".agents", ".gemini"]) rmSync(path.join(input.cwd, name), { recursive: true, force: true });
      mkdirSync(input.cwd, { recursive: true });
    }
  } catch (err) {
    return fail(
      "antigravity_failed",
      `Couldn't set up the agent's tools for the Antigravity CLI: ${(err as Error).message}`,
      true,
    );
  }
  const chatKey = codexThreadKey(input.sessionId, input.account.id);
  const base: NodeJS.ProcessEnv = {
    ...withoutContainers(input.chat ? withoutSignIns(process.env) : process.env),
    ...(opts.env ?? {}),
    [AGY_RUN_ENV]: input.runId,
    [CODEX_MCP_ENV[0]]: input.mcp.token,
    ...(opts.socketPath ? { [CODEX_MCP_ENV[1]]: opts.socketPath } : {}),
    ...(opts.runnerHome ? { [CODEX_MCP_ENV[2]]: opts.runnerHome } : {}),
  };
  const env = accountEnv("antigravity", input.account.home, base);
  const clean = (text: string) => (opts.redact ? opts.redact(text) : text);
  const hold = opts.redact ? (opts.redactHold ?? 0) : 0;

  // One retry, as a new chat, when the CLI doesn't have the conversation it was to resume.
  for (let attempt = 0; ; attempt++) {
    const chat = opts.chats.get(chatKey);
    const args = antigravityTurnArgs({
      prompt: cursorPrompt(input.system, input.prompt, !chat),
      ...(chat ? { chat } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      profile: input.profile ?? "work",
      ...(input.chat ? { locked: true } : {}),
    });
    let child: ChildProcess;
    try {
      child = (opts.spawn ?? spawn)(resolveCommand(opts.bin ?? AGY_BIN, env.PATH), args, {
        cwd: input.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      return fail("antigravity_failed", err instanceof Error ? err.message : String(err));
    }
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr = (stderr + c.toString("utf8")).slice(-4000);
    });
    let tail = "";
    let streamed = false;
    let worked = false;
    const flush = (text: string, whole: boolean) => {
      const out = clean(tail + text);
      const at = whole ? out.length : Math.max(0, out.length - hold);
      tail = out.slice(at);
      if (at > 0) {
        streamed = true;
        opts.emit({ type: "text_delta", text: out.slice(0, at) });
      }
    };
    let sawInit = false;
    let lost = false;
    let breach: string | null = null;
    let result: Record<string, unknown> | undefined;
    let model = input.model;
    const used = { input: 0, output: 0, cacheRead: 0, steps: 0 };
    const lines = createInterface({ input: child.stdout as NonNullable<ChildProcess["stdout"]> });
    (lines as unknown as EventEmitter).on("line", (line: string) => {
      if (breach || lost || result) return;
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(ev)) return;
      if (input.chat) {
        breach = antigravityChatBreach(ev, sawInit);
        if (breach) {
          killTree(child, "SIGKILL");
          return;
        }
      }
      if (ev.event === "init") {
        sawInit = true;
        const id = typeof ev.conversation_id === "string" ? ev.conversation_id : undefined;
        if (isRecord(ev.init) && typeof ev.init.model === "string") model = ev.init.model;
        // A resume the CLI didn't have comes back as a new conversation, without the context.
        if (chat && id && id !== chat && attempt === 0) {
          lost = true;
          killTree(child, "SIGKILL");
          return;
        }
        if (id) opts.chats.set(chatKey, id);
        return;
      }
      if (ev.event === "result") {
        result = isRecord(ev.result) ? ev.result : {};
        return;
      }
      if (ev.event !== "step_update" || !isRecord(ev.step_update)) return;
      const step = ev.step_update;
      if (step.step_type === "agent_response") {
        if (typeof step.text_delta === "string" && step.text_delta) flush(step.text_delta, false);
        if (step.state === "DONE" && isRecord(step.usage)) {
          const u = usageOf(step.usage);
          used.input += u.input;
          used.output += u.output;
          used.cacheRead += u.cacheRead;
          used.steps++;
        }
        return;
      }
      const info = isRecord(step.tool_info) ? step.tool_info : null;
      if (step.step_type !== "tool" || step.state !== "DONE" || !info) return;
      const name = typeof step.tool_name === "string" ? step.tool_name : String(info.name ?? "tool");
      worked = true;
      // Our bridge's calls: the engine ran them.
      if (isOurAgyTool(name)) return;
      flush("", true);
      const error = isRecord(info.error) ? info.error : null;
      const output = error ? String(error.message ?? error.type ?? "failed") : String(info.output ?? "");
      opts.emit({
        type: "tool_call",
        id: `${String(step.conversation_id ?? "agy")}:${String(step.step_index ?? used.steps)}`,
        name,
        input: redactDeep(info.parameters ?? {}, clean),
        executed: { content: clean(output.slice(0, 20_000)), ...(error ? { isError: true } : {}) },
      });
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
        missing ? "antigravity_missing" : "antigravity_failed",
        missing ? "The Antigravity CLI, Google's, is not installed on this computer." : exit.error.message,
        true,
      );
    }
    if (chat && attempt === 0 && (lost || (!sawInit && /conversation[^\n]*not found/i.test(stderr)))) {
      opts.chats.delete(chatKey);
      continue;
    }
    flush("", true);
    const r = result ?? {};
    const u = used.steps === 0 && !chat && isRecord(r.usage) ? usageOf(r.usage) : used;
    if (u.input || u.output) {
      opts.emit({
        type: "usage",
        input: u.input,
        output: u.output,
        source: "plan",
        ...(model ? { model } : {}),
        ...(u.cacheRead ? { cacheRead: u.cacheRead } : {}),
      });
    }
    const response = typeof r.response === "string" ? r.response : "";
    if (r.status === "SUCCESS" && exit.code === 0) {
      const text = clean(response.trimEnd());
      if (text && !streamed) opts.emit({ type: "text_delta", text });
      opts.emit({ type: "done", text, session: { id: input.sessionId } });
      return;
    }
    const agyError = parseAgyError(stderr);
    const why =
      agyError?.message ??
      (typeof r.error === "string" && r.error
        ? r.error
        : r.finished_reason === "print_timeout"
          ? "The Antigravity CLI ran out of time"
          : exit.code === 0
            ? "The Antigravity CLI ended without finishing the turn"
            : `The Antigravity CLI exited with code ${exit.code ?? "?"}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`);
    for (const event of antigravityProblem(clean(why), {
      worked: worked || streamed,
      limit: agyError?.limit ?? false,
      auth: agyError?.auth ?? false,
      ...(opts.now ? { now: opts.now() } : {}),
    }))
      opts.emit(event);
    return;
  }
}

/** What the runner's `brain.turn` handler hands the Antigravity branch. */
export interface AntigravityBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  chats?: CodexThreads;
  bin?: string;
  grants?: string[];
  accounts?: { accountDir(kind: "antigravity", id: string): string | null };
  spawn?: Spawn;
  platform?: NodeJS.Platform;
}

const chatStores = new Map<string, CodexThreads>();

/** `brain.turn` with `kind: "antigravity"`: the turn's folder in the agent's own folder, its account and secrets, the turn. */
export async function handleAntigravityBrainTurn(
  ctx: AntigravityBrainContext,
  req: AntigravityBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "The Antigravity CLI is turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  // ADR 0041: the account's folder or nothing (the computer's own sign-in would need our bridge in its config).
  const accountId: unknown = req.account;
  if (accountId === undefined || accountId === null || accountId === "") {
    scope.emit({
      type: "error",
      code: "not_logged_in",
      message: "Gemini thinks only with a Gemini account connected for the agent. Connect one on the agent's page.",
      retryable: false,
    });
    return;
  }
  if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
  const home = ctx.accounts?.accountDir("antigravity", accountId);
  if (!home) {
    scope.emit({
      type: "error",
      code: "account_missing",
      message: ACCOUNT_MISSING_MESSAGE.antigravity,
      retryable: false,
    });
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
  const file = antigravityChatsFile(ctx.runnerHome);
  const chats = ctx.chats ?? chatStores.get(file) ?? new CodexThreads(file);
  chatStores.set(file, chats);
  await runAntigravityTurn(
    {
      runId: req.runId,
      sessionId: req.session.id,
      cwd,
      ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      system: typeof req.system === "string" ? req.system : "",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      mcp: { token: req.mcp.token },
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
      ...(ctx.platform ? { platform: ctx.platform } : {}),
    },
  );
}
