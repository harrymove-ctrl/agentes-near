import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type BrainRouteReply,
  type BrainRouteRequest,
  isAccountId,
  isAccountKind,
  ROUTE_LIMITS,
  ROUTE_TIMEOUT_MS,
} from "@agenteschat/adapters/machine-protocol";
import {
  type AccountFolders,
  type AccountGrant,
  accountEnv,
  accountSettingsEnv,
  accountSignIn,
  handToken,
  planKeyOf,
  routesRunning,
  signInKey,
  TOKEN_FD_ENV,
  TOKEN_STDIO,
  withoutContainers,
} from "./accounts";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { resolveCommand } from "./executors";

/**
 * `brain.route` (protocol 24, ADR 0074): a person's own Claude or ChatGPT plan picks who answers their
 * message nobody mentioned. The prompt carries other people's messages, which may try to instruct the model,
 * so the CLI gets nothing to act with: every tool off, nothing of the folder or its owner loaded, no session
 * kept, in a temporary folder of its own, removed afterwards. It runs as the request's agent's user (system
 * mode: in its worker) with the account folder's env, and is killed after `ROUTE_TIMEOUT_MS`.
 *
 * A sign-in made with a key is refused: it is neither a plan nor free. One route per sign-in at a time, and
 * none while that sign-in has a process open (a turn, or the one kept after it): concurrent processes on one
 * sign-in race on its refresh token, so the answer is `busy` at once and the server tries another. For the
 * same reason a turn or a task starting on a sign-in stops the route running there first.
 *
 * On a Claude sign-in several agents share, root runs it as that sign-in's user (`RouteDeps.shared`): no worker holds
 * the sign-in, and with no tools the CLI has nothing to delegate.
 */

/** Claude Code's argv for a route; the prompt goes on standard input. */
export function claudeRouteArgs(o: { systemFile: string; schema: Record<string, unknown> }): string[] {
  return [
    "-p",
    "--safe-mode",
    "--model",
    "haiku",
    "--effort",
    "low",
    "--tools",
    "",
    "--no-session-persistence",
    "--system-prompt-file",
    o.systemFile,
    "--json-schema",
    JSON.stringify(o.schema),
    "--output-format",
    "json",
  ];
}

/** Codex features a route turns off: it reads and answers, nothing else. */
export const CODEX_ROUTE_OFF = [
  "shell_tool",
  "sleep_tool",
  "skill_search",
  "tool_suggest",
  "plugins",
  "apps",
  "multi_agent",
  "browser_use",
  "computer_use",
  "image_generation",
] as const;

/** Codex's argv for a route; the prompt goes on standard input (`-`). */
export function codexRouteArgs(o: { model: string; schemaFile: string; lastFile: string }): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-m",
    o.model,
    "-c",
    'model_reasoning_effort="low"',
    ...CODEX_ROUTE_OFF.flatMap((feature) => ["--disable", feature]),
    "--output-schema",
    o.schemaFile,
    "-o",
    o.lastFile,
    "-",
  ];
}

/**
 * The newest `gpt-<version>-luna` in a Codex model catalog (`codex debug models`): its smallest model with a
 * ChatGPT sign-in, which refuses the API's own small model.
 */
export function newestLuna(catalog: unknown): string | null {
  const models = (catalog as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  let best: { slug: string; version: number[] } | null = null;
  for (const m of models) {
    const slug = (m as { slug?: unknown } | null)?.slug;
    const version = typeof slug === "string" ? /^gpt-(\d+(?:\.\d+)*)-luna$/.exec(slug)?.[1] : undefined;
    if (!version || typeof slug !== "string") continue;
    const parts = version.split(".").map(Number);
    if (!best || newer(parts, best.version)) best = { slug, version: parts };
  }
  return best?.slug ?? null;
}

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
};

const tokens = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What `claude -p --output-format json` printed: its structured answer, the model and the usage. Null: none. */
export function claudeRouteAnswer(stdout: string): Exclude<BrainRouteReply, { busy: true }> | null {
  let out: unknown;
  try {
    out = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isRecord(out) || out.is_error === true) return null;
  let json: unknown = out.structured_output;
  if (!isRecord(json) && typeof out.result === "string") {
    try {
      json = JSON.parse(out.result);
    } catch {
      json = null;
    }
  }
  if (!isRecord(json)) return null;
  const usage = isRecord(out.usage) ? out.usage : {};
  const cacheRead = tokens(usage.cache_read_input_tokens);
  const cacheWrite = tokens(usage.cache_creation_input_tokens);
  const model = isRecord(out.modelUsage) ? Object.keys(out.modelUsage)[0] : undefined;
  return {
    json,
    model: model?.slice(0, 100) ?? "haiku",
    usage: {
      input: tokens(usage.input_tokens) + cacheRead + cacheWrite,
      output: tokens(usage.output_tokens),
      cacheRead,
      cacheWrite,
    },
    durationMs: tokens(out.duration_ms),
  };
}

/** What Codex's `--json` events said it used (`turn.completed`): its input counts cached tokens in. */
export function codexRouteUsage(stdout: string) {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const ev = JSON.parse(line) as { type?: unknown; usage?: Record<string, unknown> };
      if (ev.type !== "turn.completed" || !ev.usage) continue;
      return {
        input: tokens(ev.usage.input_tokens),
        output: tokens(ev.usage.output_tokens),
        cacheRead: tokens(ev.usage.cached_input_tokens),
        cacheWrite: 0,
      };
    } catch {
      // not an event
    }
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export interface RouteDeps {
  /** The account folders: root's, or those lent to this agent's worker, and its own for one root keeps. */
  accounts?: AccountFolders;
  /** System mode, in a worker (protocol 29): what root handed this route for its account. */
  grant?: AccountGrant;
  /** The processes kept for turns: a sign-in with one open is busy. */
  brains?: { holds(account: string | null): boolean };
  codexApp?: { holds(account: string | null): boolean };
  /** Background tasks, each with its CLI on its sign-in: its agent's account, or the computer's own (none). */
  tasks?: { runningTasks(): { executor: string; account?: string }[] };
  /** Root, a sign-in several agents share: its CLI's config folder, a folder its user can read, and how it starts. */
  shared?: {
    home: string;
    dir: string;
    launch(): Promise<{ command: string[]; env: NodeJS.ProcessEnv; cwd: string }>;
  };
  signal?: AbortSignal;
  /** Tests: the CLIs, the time limit and where temporary folders go. */
  claudeCommand?: string[];
  codexCommand?: string[];
  timeoutMs?: number;
  tmpDir?: string;
}

/** Codex's small model per sign-in, looked up at most hourly (each lookup starts the CLI). */
const lunas = new Map<string, { model: string; at: number }>();
const LUNA_TTL_MS = 3600_000;
const KILL_GRACE_MS = 3000;
const OUTPUT_MAX = 1 << 20;

/**
 * One `brain.route`; `busy` at once while that sign-in has a process open or another route. A turn or a task
 * starting on that sign-in meanwhile stops it (`yieldRoute`), so the route fails and the server's rules decide.
 */
export async function routeWithPlan(req: BrainRouteRequest, deps: RouteDeps): Promise<BrainRouteReply> {
  if (process.platform === "win32") throw new RunnerError("not_allowed", "Plans don't pick who answers on Windows yet");
  if (!isAccountKind(req.kind) || req.kind === "cursor" || req.kind === "opencode") {
    throw new RunnerError("bad_request", "kind must be claude_code or codex");
  }
  if (typeof req.system !== "string" || req.system.length > ROUTE_LIMITS.system) {
    throw new RunnerError("bad_request", "system must be a string of at most 8000 characters");
  }
  if (typeof req.prompt !== "string" || !req.prompt.trim() || req.prompt.length > ROUTE_LIMITS.prompt) {
    throw new RunnerError("bad_request", "prompt must be a string of at most 32000 characters");
  }
  const schema = JSON.stringify(req.schema ?? null);
  if (!isRecord(req.schema) || schema.length > ROUTE_LIMITS.schema) {
    throw new RunnerError("bad_request", "schema must be a JSON object");
  }
  const account = req.account ?? null;
  if (account !== null && !isAccountId(account)) throw new RunnerError("bad_request", "Invalid account id");
  const signIn = deps.shared
    ? { home: deps.shared.home, release: undefined }
    : account
      ? await accountSignIn(deps.accounts, req.kind, account, deps.grant)
      : null;
  if (signIn === "signed_out") throw new RunnerError("not_found", "That account is signed out here");
  if (signIn === "missing") throw new RunnerError("not_found", "That account isn't on this computer anymore");
  const home = signIn?.home ?? null;
  const key = signInKey(req.kind, home);
  const open = req.kind === "codex" ? deps.codexApp : deps.brains;
  const cli = req.kind === "codex" ? "codex" : "claude";
  const task = deps.tasks?.runningTasks().some((t) => t.executor === cli && (t.account ?? null) === account);
  if (routesRunning.has(key) || open?.holds(account) || task) {
    signIn?.release?.();
    return { busy: true };
  }
  const stop = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, stop.signal]) : stop.signal;
  const done = route(req, { ...deps, signal }, home ?? null, key);
  routesRunning.set(key, { stop, done });
  try {
    return await done;
  } finally {
    routesRunning.delete(key);
    signIn?.release?.();
  }
}

async function route(req: BrainRouteRequest, deps: RouteDeps, home: string | null, key: string) {
  if (deps.shared) return claudeRoute(req, { ...deps, dir: deps.shared.dir, home });
  if (home && (deps.grant?.kind === "key" || (!deps.grant && (await planKeyOf(home))))) {
    throw new RunnerError("not_allowed", "A sign-in made with a key doesn't pick who answers");
  }
  const dir = mkdtempSync(path.join(deps.tmpDir ?? os.tmpdir(), "agentes-route-"));
  try {
    return req.kind === "codex"
      ? await codexRoute(req, { ...deps, dir, home, key })
      : await claudeRoute(req, { ...deps, dir, home });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function claudeRoute(req: BrainRouteRequest, o: RouteDeps & { dir: string; home: string | null }) {
  const systemFile = path.join(o.dir, "system.txt");
  writeFileSync(systemFile, req.system, { mode: o.shared ? 0o640 : 0o600 });
  const launched = await o.shared?.launch();
  // An account's folder is the CLI's home, and requests go only to Claude's own endpoint.
  const token = o.grant?.kind === "token" ? o.grant.token : undefined;
  const env = launched
    ? { ...launched.env, ...accountSettingsEnv(undefined, "haiku") }
    : o.home
      ? {
          ...accountEnv("claude_code", o.home),
          ...accountSettingsEnv(undefined, "haiku"),
          ...(token ? TOKEN_FD_ENV : {}),
        }
      : process.env;
  const started = Date.now();
  const command = launched?.command ?? o.claudeCommand ?? ["claude"];
  const run = await runCli(command, claudeRouteArgs({ systemFile, schema: req.schema }), {
    cwd: launched?.cwd ?? o.dir,
    env,
    input: req.prompt,
    timeoutMs: o.timeoutMs ?? ROUTE_TIMEOUT_MS,
    signal: o.signal,
    ...(token ? { token } : {}),
  });
  const answer = claudeRouteAnswer(run.stdout);
  if (!answer) throw new RunnerError("internal", `Claude Code didn't answer${run.why(started)}`);
  return { ...answer, durationMs: answer.durationMs || Date.now() - started };
}

async function codexRoute(req: BrainRouteRequest, o: RouteDeps & { dir: string; home: string | null; key: string }) {
  const env = withoutContainers(o.home ? accountEnv("codex", o.home) : process.env);
  const model = await codexLuna(o, env);
  const schemaFile = path.join(o.dir, "schema.json");
  const lastFile = path.join(o.dir, "last.txt");
  writeFileSync(schemaFile, JSON.stringify(req.schema), { mode: 0o600 });
  const started = Date.now();
  const run = await runCli(o.codexCommand ?? ["codex"], codexRouteArgs({ model, schemaFile, lastFile }), {
    cwd: o.dir,
    env,
    // `codex exec` has no system prompt of its own here (`--ignore-user-config`): it leads the prompt.
    input: `${req.system}\n\n${req.prompt}`,
    timeoutMs: o.timeoutMs ?? ROUTE_TIMEOUT_MS,
    signal: o.signal,
  });
  let json: unknown = null;
  try {
    json = existsSync(lastFile) ? JSON.parse(readFileSync(lastFile, "utf8")) : null;
  } catch {
    json = null;
  }
  if (!isRecord(json)) throw new RunnerError("internal", `Codex didn't answer${run.why(started)}`);
  return { json, model, usage: codexRouteUsage(run.stdout), durationMs: Date.now() - started };
}

/** The account's newest Luna (`codex debug models`), cached for an hour per sign-in. */
async function codexLuna(o: RouteDeps & { dir: string; key: string }, env: NodeJS.ProcessEnv) {
  const cached = lunas.get(o.key);
  if (cached && Date.now() - cached.at < LUNA_TTL_MS) return cached.model;
  const run = await runCli(o.codexCommand ?? ["codex"], ["debug", "models"], {
    cwd: o.dir,
    env,
    input: "",
    timeoutMs: 15_000,
    signal: o.signal,
  });
  let catalog: unknown = null;
  try {
    catalog = JSON.parse(run.stdout);
  } catch {
    catalog = null;
  }
  const model = newestLuna(catalog);
  if (!model) throw new RunnerError("internal", "Codex lists no small model for this sign-in");
  lunas.set(o.key, { model, at: Date.now() });
  return model;
}

/** Runs a CLI with `input` on its standard input, killed (with what it started) past `timeoutMs` or on abort. */
function runCli(
  command: string[],
  args: string[],
  o: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input: string;
    timeoutMs: number;
    signal?: AbortSignal;
    /** A token root handed over, on its own descriptor (`TOKEN_FD_ENV`). */
    token?: string;
  },
): Promise<{ stdout: string; why(started: number): string }> {
  const [file, ...pre] = command;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let ended: "timeout" | "canceled" | null = null;
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const kill = (why: "timeout" | "canceled") => {
      ended ??= why;
      if (!child) return;
      killTree(child, "SIGTERM");
      grace = setTimeout(() => child && killTree(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => kill("canceled");
    const done = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      o.signal?.removeEventListener("abort", onAbort);
      const tail = (error?.message ?? stderr).trim().split("\n").slice(-2).join(" ").slice(0, 300);
      resolve({
        stdout,
        why: (started) =>
          ended === "timeout"
            ? ` in ${Math.round((Date.now() - started) / 1000)} s`
            : ended === "canceled"
              ? ": canceled"
              : `${code !== null && code !== 0 ? ` (exit ${code})` : ""}${tail ? `: ${tail}` : ""}`,
      });
    };
    try {
      child = spawn(resolveCommand(file ?? "", o.env.PATH), [...pre, ...args], {
        cwd: o.cwd,
        env: o.env,
        stdio: o.token ? [...TOKEN_STDIO] : ["pipe", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
      });
    } catch (error) {
      return done(null, error instanceof Error ? error : new Error(String(error)));
    }
    if (o.token) handToken(child, o.token);
    timer = setTimeout(() => kill("timeout"), o.timeoutMs);
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < OUTPUT_MAX) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.input);
    const events = child as unknown as EventEmitter;
    events.on("error", (error: Error) => done(null, error));
    events.on("close", (code: number | null) => done(code));
  });
}
