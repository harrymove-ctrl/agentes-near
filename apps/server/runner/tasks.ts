import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ASK_AGAIN, MISSION_DENY_RULES, PUSH_ASK_RULES } from "@agenteschat/adapters/command-policy";
import {
  type AccountKind,
  type AgentScope,
  commandOf,
  findPullRequestUrl,
  isAccountId,
  isRunToolToken,
  type MachineReplies,
  MISSION_RULES_NO_GIT,
  PERMISSION_WAIT_MS,
  type RunnerFrame,
  type RunnerTask,
  TASK_LIMITS,
  type TaskDenial,
  type TaskDone,
  type TaskExecutor,
  type TaskStart,
} from "@agenteschat/adapters/machine-protocol";
import { claudeCodeModel, planForTurn, planOf } from "@agenteschat/providers/plans";
import {
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_SIGNED_OUT,
  type AccountFolders,
  type AccountGrant,
  accountEnv,
  accountSettingsEnv,
  accountSignIn,
  handToken,
  TOKEN_FD_ENV,
  withoutContainers,
  withSignIn,
  yieldRoute,
} from "./accounts";
import { codexThreadKey } from "./brain-codex";
import { commandApproval, ownBranches } from "./command-gate";
import { RunnerError } from "./errors";
import { shellCommand } from "./exec";
import { readJson, writeJson } from "./json-file";
import {
  CODEX_MCP_ENV,
  claudeMcpConfig,
  claudePermissionSettings,
  codexWritableRoots,
  MCP_TOKEN_FILE,
  type McpTaskInfo,
  missionBranchPrefix,
  missionExecutorArgs,
  newMcpToken,
  shellArg,
} from "./mcp";
import { commitPathspecs, excludeLocally, git, gitWhy } from "./mission-worktree";
import { isInside, resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";

export { excludeLocally };

/**
 * Background tasks (protocol 4, ADR 0029): commands that outlive a request,
 * the socket and the runner itself.
 *
 * - Each task runs under a tiny wrapper (`wrap.mjs`, plain JavaScript run by
 *   this same runtime) started detached in its own process group and
 *   `unref()`ed, so restarting the runner (an update, a crash) leaves it
 *   running. The wrapper starts the command with stdout/stderr going to
 *   `<runner home>/tasks/<taskId>/stdout.log` and `stderr.log`, touches
 *   `alive` every 15 s, enforces `maxSeconds`, stops on `cancel` (a file, so
 *   it works on Windows too; a SIGTERM from outside, as at a shutdown, ends it
 *   as interrupted), and writes `exit.json` (atomically) when the command
 *   ends. A pid alone can't tell "still running" after a reboot (pids are
 *   reused); a fresh `alive` can.
 * - The journal `<runner home>/tasks/journal.json` (written whole, then
 *   renamed) lists every task with its state; `hello` carries it.
 * - A watcher tails the logs: Claude Code's `stream-json` lines become a
 *   human last line and the files it edits; other executors send their last
 *   plain lines. Events are throttled and secrets redacted (ADR 0027).
 *   A pull request URL seen in the output (`gh pr create`, a tool result)
 *   goes once as `task.event` `prUrl` (protocol 6).
 * - `task.output` (protocol 6) re-reads the end of a task's log and answers
 *   the same human lines the watcher derives ("Ver saída"), redacted.
 * - `task.done` goes once per task and again after each reconnect until the
 *   server acknowledges it (`task.ack`).
 * - Claude Code and Codex sign in as the agent's turns do (protocol 31, ADR
 *   0041 §5.1): with `account`, that account's folder is the CLI's home, a
 *   plan's key goes in its env, and a token root keeps reaches the wrapper on
 *   its descriptor 3 and the CLI on its own, never a file or an environment.
 *   Without `account`, the computer's own sign-in. A CLI that found nothing to
 *   sign in with ends with what its agent can do instead (`noSignInResult`).
 * - A Claude sign-in several agents share (`AccountGrant` `hosted`): its CLI is root's and no wrapper runs here. All the
 *   rest stays with this manager: root hears where the task runs (`HostedTask`) and sends the CLI's lines back into the
 *   same logs, then how it ended into `exit.json`, so the watcher reads it like any other. Such a CLI dies with the
 *   runner, so the task ends as interrupted then, for the server to resume.
 */

export const DEFAULT_MAX_CONCURRENT_TASKS = 3;
export const DEFAULT_TASK_MAX_SECONDS = 4 * 3600;
/** Hard cap on `maxSeconds` (a day). */
export const TASK_MAX_SECONDS_CAP = 24 * 3600;
/** `alive` is touched this often by the wrapper; older than `ALIVE_STALE_MS` means the wrapper is gone. */
export const ALIVE_EVERY_MS = 15_000;
export const ALIVE_STALE_MS = 60_000;
/**
 * A command killed by a SIGTERM the wrapper didn't send: the wrapper waits this long for one of its own. A
 * shutdown stopping the agent's scope signals every process in it at once; a kill aimed at the command alone
 * (a person, the agent's own `pkill`) never reaches the wrapper.
 */
const OUTSIDE_SIGTERM_WAIT_MS = 2000;
/** Finished, acknowledged tasks (and their logs) are kept this long. */
export const TASK_KEEP_MS = 7 * 24 * 3600_000;
/** The watcher reads the logs this often. */
export const WATCH_MS = 1000;
/** At most one `line` event per task this often; a `progress` heartbeat when nothing else was sent. */
export const EVENT_EVERY_MS = 2000;
export const PROGRESS_EVERY_MS = 30_000;
/** What `task.done` keeps of a plain command's output. */
const TAIL_LINES = 20;
/** `task.output` reads at most this much of the end of each log. */
const OUTPUT_READ_BYTES = 512 * 1024;
const MAX_LINE_BUFFER = 1024 * 1024;
const CANCEL_GRACE_MS = 10_000;
const TASK_ID = /^[a-zA-Z0-9-]{8,64}$/;
const SESSION_ID = /^[a-zA-Z0-9-]{8,64}$/;

/** The text Claude Code gets when the server resumes a task interrupted by the machine going away. */
export const RESUME_NOTE =
  "You were interrupted (the computer went offline). Look at your folder (git status when it is a git repository) and continue where you stopped.";

interface Entry {
  taskId: string;
  agentId: string;
  agentHandle: string;
  executor: TaskExecutor;
  /** What runs (shown in logs and to the server; prompts go through stdin, never here). */
  command: string;
  /** Absolute. */
  cwd: string;
  /** Relative to the agent's folder. */
  cwdRel: string;
  /** The agent's folder (absolute). */
  folder?: string;
  /** Claude Code: started with `--resume` (else `--session-id`); flipped once when that was wrong. */
  resumed?: boolean;
  /** The start was retried once with the other session flag. */
  retried?: boolean;
  branch?: string;
  session?: string;
  status: RunnerTask["status"];
  pid?: number;
  startedAt: string;
  endedAt?: string;
  maxSeconds: number;
  lastLine?: string;
  files: string[];
  /** Protocol 6: the first pull request URL seen in its output. */
  prUrl?: string;
  /** Protocol 5: the mission this task works for, and its token for the local `agentes` MCP server. */
  missionId?: string;
  mcpToken?: string;
  /** Protocol 8: the server's token for its tools (ADR 0032), sent with each relayed call. */
  serverToken?: string;
  /** Set by `task.cancel` (a canceled task that vanished is canceled, not interrupted). */
  canceling?: boolean;
  done?: TaskDone;
  /** The server acknowledged `done`. */
  delivered?: boolean;
  /** Protocol 14: commit what changed at the end with this message; `HEAD` when it started. */
  commit?: string;
  startSha?: string;
  /** Protocol 31: the agent's account its CLI signs in with (absent: the computer's own sign-in). */
  account?: string;
  /** Its CLI is root's: there is no wrapper, and `pid` is this worker's own, never one to signal. */
  hosted?: true;
  /** Its env holds that account's coding plan key, which its redaction must hide (never the key itself). */
  planKey?: boolean;
  /** Why the runner canceled it: what its agent reads first in the result. */
  canceledWhy?: string;
}

interface Journal {
  tasks: Entry[];
  /**
   * Codex picks its own thread id (`thread.started`): our session id → that
   * thread, so the next turn resumes it by id (`exec … resume <id> -`).
   */
  codexThreads?: Record<string, string>;
}

interface ExitFile {
  exitCode: number | null;
  signal: string | null;
  /** `interrupted`: stopped by a signal from outside (a shutdown), not by us. */
  reason: "canceled" | "timeout" | "interrupted" | null;
  endedAt: string;
  error?: string;
}

/** What root needs of a task it hosts, from the worker that prepared it, besides the request itself. */
export interface HostedTask {
  cwd: string;
  /** Where an item works, told first in its prompt. */
  where: string;
  /** The folder is a git repository: the mission's rules hold as sent. */
  git: boolean;
  maxSeconds: number;
}

/** How a hosted task's CLI ended, as root says. */
export type HostedExit = Pick<ExitFile, "exitCode" | "signal" | "reason" | "error">;

export interface TaskSecrets {
  env: Record<string, string>;
  redact: (text: string) => string;
  /** The longest secret − 1: what streamed text holds back so a value split between batches is still caught. */
  hold?: number;
}

/** A task as the desktop app sees it (running, or just ended). */
export interface SettledTask {
  taskId: string;
  agentId: string;
  agentHandle: string;
  executor: TaskExecutor;
  /** The command line (prompts are never on it). */
  command: string;
  /** Absolute. */
  cwd: string;
  startedAt: string;
  done?: TaskDone;
  /** The agent's account its CLI signs in with (absent: the computer's own sign-in). */
  account?: string;
}

export interface TaskManagerOptions {
  /** `<runner home>/tasks`. */
  root: string;
  workspaceReal: string;
  maxConcurrent?: number;
  defaultMaxSeconds?: number;
  log?: (line: string) => void;
  /** The agent's folder (real path); `handlers.ts` passes `agentWorkspace`. */
  agentFolder: (agent: AgentScope) => Promise<string>;
  /** The agent's secrets: env for the command, redaction for what leaves the machine. */
  secrets?: (agent: AgentScope) => Promise<TaskSecrets | null>;
  /** Protocol 31: the accounts' folders, as for turns; without it a task on an account is refused. */
  accounts?: AccountFolders;
  /**
   * How the wrapper starts, before the task folder: default this runtime and
   * `wrap.mjs` next to the journal. A compiled runner (ADR 0036) has no
   * runtime to hand a script to and passes `[binary, "task-wrapper"]`.
   */
  wrapperCommand?: string[];
  /** A task ended (once per task, after `task.done` was queued): the desktop app's jobs and activity log. */
  onSettled?: (task: SettledTask) => void;
  /** The server's host, for `commitChanges`' fallback author. */
  commitHost?: () => string | undefined;
  /** Tests: shorter intervals. */
  watchMs?: number;
  eventEveryMs?: number;
  /** Tests: the runtime that runs the wrapper (default: this one). */
  runtime?: string;
  /** Tests: where Claude Code keeps its sessions (default `$CLAUDE_CONFIG_DIR` or `~/.claude`). */
  claudeHome?: string;
  /**
   * Protocol 5: the local `agentes` MCP server for mission tasks: where the
   * daemon listens, and how to start `agentes-runner mcp` (runtime + script).
   * Without it a mission task runs without our tools.
   */
  mcp?: { socketPath: string; command: string[] };
  /** macOS: keep the machine awake while tasks run (default on darwin). */
  caffeinate?: boolean;
  /** How a Claude Code or Codex task's wrapper starts (a worker under systemd: in the agent's AI CLIs slice). */
  spawnCli?: Spawn;
  /** System mode, in a worker: root stops the CLI of a task it hosts. */
  hostedStop?: (taskId: string) => void;
  now?: () => number;
}

/**
 * The wrapper's body: plain JavaScript that uses `dir` (the task folder),
 * `spawn`, `path` and the fs functions below as free names. Bundled runners
 * write it into `wrap.mjs` (with the imports) and start it with the same
 * runtime; a compiled runner has no runtime for a script and runs it in
 * `agentes-runner task-wrapper <dir>` (`runTaskWrapper`). One source either way.
 */
const WRAPPER_NAMES = [
  "spawn",
  "existsSync",
  "openSync",
  "readFileSync",
  "renameSync",
  "utimesSync",
  "writeFileSync",
  "path",
  "dir",
] as const;

const WRAPPER_BODY = `const spec = JSON.parse(readFileSync(path.join(dir, "spec.json"), "utf8"));
const file = (n) => path.join(dir, n);
let reason = null;
let ended = false;
const finish = (data) => {
  if (ended) return;
  ended = true;
  const tmp = file("exit.json.tmp");
  writeFileSync(tmp, JSON.stringify({ ...data, reason, endedAt: new Date().toISOString() }));
  renameSync(tmp, file("exit.json"));
  process.exit(0);
};
const touch = () => {
  const now = new Date();
  try { utimesSync(file("alive"), now, now); } catch { try { writeFileSync(file("alive"), ""); } catch {} }
};
touch();
const beat = setInterval(touch, ${ALIVE_EVERY_MS});
const out = openSync(file("stdout.log"), "a");
const err = openSync(file("stderr.log"), "a");
const input = existsSync(file("stdin.txt")) ? openSync(file("stdin.txt"), "r") : "ignore";
// A token root keeps for the agent's account (spec.tokenFd): read whole off this wrapper's descriptor 3, then handed
// on the command's own descriptor 3, which Claude Code reads and closes. Never in a file, nor in an environment.
let token = spec.tokenFd ? readFileSync(3, "utf8") : "";
let child;
try {
  child = spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    env: process.env,
    stdio: token ? [input, out, err, "pipe"] : [input, out, err],
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim,
  });
} catch (e) {
  finish({ exitCode: 127, signal: null, error: String(e && e.message || e) });
}
if (token) {
  child.stdio[3].on("error", () => {});
  child.stdio[3].end(token);
  token = "";
}
writeFileSync(file("child.pid"), String(child.pid ?? ""));
const kill = (signal) => {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch {}
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
};
const stop = (why) => {
  if (reason) return;
  reason = why;
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), 5000).unref();
};
let exited = null;
// A command stopped by us ends by our signal even when its shell reports none (or exits with 143).
const settle = () => finish(reason && (exited.signal || exited.code === null || exited.code === 143) ? { exitCode: null, signal: exited.signal ?? "SIGTERM" } : { exitCode: exited.code, signal: exited.signal ?? null });
// The runner cancels through the "cancel" file, never a signal: a SIGTERM comes from outside (the system
// shutting down stops the agent's scope), and the task resumes or is reported like after a crash.
process.on("SIGTERM", () => { stop("interrupted"); if (exited) settle(); });
process.on("SIGINT", () => stop("canceled"));
process.on("SIGHUP", () => {});
if (spec.maxSeconds > 0) setTimeout(() => stop("timeout"), spec.maxSeconds * 1000).unref();
const poll = setInterval(() => { if (existsSync(file("cancel"))) stop("canceled"); }, 1000);
child.on("error", (e) => { clearInterval(beat); clearInterval(poll); finish({ exitCode: 127, signal: null, error: String(e && e.message || e) }); });
// Killed by a SIGTERM we didn't send: interrupted only if one reaches this wrapper too (its whole scope stopped).
child.on("exit", (code, signal) => { clearInterval(beat); clearInterval(poll); exited = { code, signal }; if (!reason && signal === "SIGTERM") setTimeout(settle, ${OUTSIDE_SIGTERM_WAIT_MS}); else settle(); });
`;

/** The wrapper every task runs under (written next to the journal; plain JS for Node and Bun). */
export const WRAPPER_SOURCE = `// agentes-runner task wrapper: runs one task and records how it ended.
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = process.argv[2];
${WRAPPER_BODY}`;

/**
 * `agentes-runner task-wrapper <dir>` (compiled runners): the same wrapper,
 * in this process. It exits on its own when the task ends (`process.exit`),
 * so the caller must not exit after it returns.
 */
export function runTaskWrapper(dir: string) {
  const run = new Function(...WRAPPER_NAMES, WRAPPER_BODY) as (...args: unknown[]) => void;
  run(spawn, existsSync, openSync, readFileSync, renameSync, utimesSync, writeFileSync, path, dir);
}

const clampInt = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(min, Math.min(max, v));
};

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Claude Code keeps a session per folder: `<claude home>/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl`. */
export function claudeSessionFile(claudeHome: string, cwd: string, session: string) {
  return path.join(claudeHome, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
}

/**
 * Whether Claude Code has this session: in this folder first, then in any
 * project folder (a worktree, a moved repository). Null when there is no
 * `projects` folder to look in (another home, an older Claude Code).
 */
export function claudeSessionExists(claudeHome: string, cwd: string, session: string): boolean | null {
  const projects = path.join(claudeHome, "projects");
  if (!existsSync(projects)) return null;
  if (existsSync(claudeSessionFile(claudeHome, cwd, session))) return true;
  try {
    for (const dir of readdirSync(projects)) {
      if (existsSync(path.join(projects, dir, `${session}.jsonl`))) return true;
    }
  } catch {
    return null;
  }
  return false;
}

/** Claude Code's answer when the session flag was the wrong one (exits at once). */
export const WRONG_SESSION_FLAG = /already in use|no conversation found|session .* not found/i;
/** A start that ends within this long with that answer is retried once with the other flag. */
export const FAST_FAIL_SECONDS = 30;

/** What a coding CLI says when it has nothing to sign in with (Claude Code: "Not logged in · Please run /login"). */
const NOT_SIGNED_IN = {
  claude: /not logged in|please run \/login/i,
  // Not `CODEX_AUTH`'s "401 unauthorized": a command the task ran can print that about some other API.
  codex:
    /not logged in|codex login|refresh token (?:was )?(?:expired|revoked|already used)|access token could not be refreshed/i,
} as const;

/**
 * A Claude Code or Codex task that ended at once because its CLI had nothing to sign in with: what its agent reads
 * instead of the CLI's "Please run /login", which no agent can do. Null: it ended some other way.
 */
function noSignInResult(t: Entry, exit: ExitFile | null, seconds: number, said: string): string | null {
  if (t.executor === "shell" || !exit || exit.exitCode === 0 || exit.reason || seconds > FAST_FAIL_SECONDS) return null;
  if (!NOT_SIGNED_IN[t.executor].test(said)) return null;
  const cli = t.executor === "codex" ? "Codex" : "Claude Code";
  const plan = t.executor === "codex" ? "ChatGPT" : "Claude";
  const instead = "until then, do this work in your own turn (run_code) instead of a background task.";
  return t.account
    ? `${cli} couldn't sign in with this agent's ${plan} account on this computer, so the task stopped before doing anything. Its owner can sign in to that account again in Settings, AI accounts; ${instead}`
    : `${cli} has no sign-in for this agent on this computer (the agent has no ${plan} account here), so the task stopped before doing anything. Its owner can connect a ${plan} account on the agent's page; ${instead}`;
}

/** The same command with the other session flag (`--resume` ↔ `--session-id`). */
export function flipSessionFlag(command: string, session: string, resumed: boolean) {
  return resumed
    ? command.replace(`--resume ${session}`, `--session-id ${session}`)
    : command.replace(`--session-id ${session}`, `--resume ${session}`);
}

/**
 * The command line for an executor. Prompts never go on it (no quoting
 * across shells): the wrapper feeds them through stdin.
 */
export function executorCommand(
  executor: TaskExecutor,
  options: {
    command?: string;
    session?: string;
    resume?: boolean;
    extra?: string[];
    /** Claude Code's permission mode (default `acceptEdits`; a mission's plan turn runs `dontAsk`). */
    permissionMode?: "acceptEdits" | "dontAsk";
    /** Codex: where it works (`-C`), its sandbox, the file for its last message, the thread to resume. */
    codex?: { cwd: string; sandbox: "read-only" | "workspace-write"; lastFile: string; thread?: string };
    /**
     * Protocol 10: the folders allowed for the agent besides its own. Claude
     * Code gets `--add-dir` for each, Codex its sandbox's writable roots.
     */
    addDirs?: string[];
    platform?: NodeJS.Platform;
  },
): string {
  const addDirs = (options.addDirs ?? []).filter((d) => typeof d === "string" && d);
  if (executor === "shell") {
    const command = (options.command ?? "").trim();
    if (!command) throw new RunnerError("bad_request", "A shell task needs a command");
    return command;
  }
  // `extra`: a mission task's MCP server and rules (already quoted for the shell).
  if (executor === "codex") {
    // `codex exec` (JSONL events) runs unattended with approval_policy=never: the sandbox is the limit, so
    // workspace-write with network (git push, installs) for work, read-only for a plan. No `--full-auto` (removed).
    // Global options go before `resume`; the prompt comes on stdin (`-`). Always resumed by id, never `--last`.
    const q = (v: string) => shellArg(v, options.platform);
    const c = options.codex;
    return [
      "codex",
      "exec",
      "--json",
      "--skip-git-repo-check",
      ...(c ? ["-C", q(c.cwd), "--sandbox", c.sandbox] : []),
      ...(c?.sandbox === "workspace-write" ? ["-c", q("sandbox_workspace_write.network_access=true")] : []),
      ...(c?.sandbox === "workspace-write" && addDirs.length ? ["-c", q(codexWritableRoots(addDirs))] : []),
      ...(options.extra ?? []),
      ...(c ? ["-o", q(c.lastFile)] : []),
      ...(c?.thread ? ["resume", c.thread] : []),
      "-",
    ].join(" ");
  }
  const parts = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    options.permissionMode ?? "acceptEdits",
  ];
  parts.push(...(options.extra ?? []));
  for (const d of addDirs) parts.push("--add-dir", shellArg(d, options.platform));
  if (options.session) parts.push(options.resume ? "--resume" : "--session-id", options.session);
  return parts.join(" ");
}

/** A short human line for one Claude Code tool call ("Editing src/app.ts"). */
function toolLine(name: string, input: Record<string, unknown>, rel: (p: string) => string): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `${name === "Write" ? "Writing" : "Editing"} ${rel(str("file_path") || str("notebook_path"))}`;
    case "Read":
      return `Reading ${rel(str("file_path"))}`;
    case "Bash":
      return `Running: ${str("command").replace(/\s+/g, " ").trim()}`;
    case "Grep":
    case "Glob":
      return `Searching ${str("pattern")}`;
    case "Task":
      return `Subtask: ${str("description")}`;
    case "TodoWrite":
      return "Updating its plan";
    case "WebFetch":
    case "WebSearch":
      return `${name === "WebFetch" ? "Fetching" : "Searching the web for"} ${str("url") || str("query")}`;
    default:
      return `Using ${name}`;
  }
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** Claude Code's own tools as the agent's worker serves them on a shared sign-in; the server's are in lower case. */
const DELEGATED_TOOL = /^mcp__agentes__(?=[A-Z])/;

/** What one line of output says: a human line, files touched, the final result, the session. */
export interface ParsedLine {
  /** Commands refused with nobody to approve them (Claude Code's `permission_denials`, Codex's declined). */
  denials?: TaskDenial[];
  line?: string;
  files?: string[];
  result?: string;
  session?: string;
  /** A pull request URL in the output (a tool result, the answer, a plain line). */
  prUrl?: string;
  /** Codex: the thread it opened (`thread.started`), to resume next time. */
  thread?: string;
  /** Codex: the turn failed (`turn.failed`, `error`). */
  error?: string;
}

/** Claude Code's `result.permission_denials`: `{ tool_name, tool_input }` each, as what people read. */
export function claudeDenials(v: unknown): TaskDenial[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => {
    if (!d || typeof d !== "object") return [];
    const x = d as { tool_name?: unknown; tool_input?: unknown };
    const tool = typeof x.tool_name === "string" ? x.tool_name : "";
    if (!tool || tool.startsWith("mcp__agentes__")) return [];
    const input = x.tool_input && typeof x.tool_input === "object" ? (x.tool_input as Record<string, unknown>) : {};
    const command = commandOf(tool, input).slice(0, TASK_LIMITS.denial);
    return command ? [{ tool, command }] : [];
  });
}

/** The text of a Claude Code tool result (a string, or text blocks). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Record<string, unknown>[])
    .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

/** Claude Code `stream-json` (and Codex `--json`, best effort); plain text otherwise. */
export function parseOutputLine(raw: string, executor: TaskExecutor, cwd: string): ParsedLine {
  const text = raw.trim();
  if (!text) return {};
  const rel = (p: string) => {
    if (!p) return "";
    const abs = path.resolve(cwd, p);
    return isInside(cwd, abs) ? path.relative(cwd, abs).split(path.sep).join("/") : p;
  };
  const first = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";
  if (executor !== "shell" && text.startsWith("{")) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { line: text };
    }
    if (executor === "claude") {
      const session = typeof ev.session_id === "string" ? ev.session_id : undefined;
      if (ev.type === "result") {
        const result = typeof ev.result === "string" ? ev.result : "";
        const prUrl = findPullRequestUrl(result);
        const denials = claudeDenials(ev.permission_denials);
        return {
          result,
          session,
          ...(result ? { line: first(result) } : {}),
          ...(prUrl ? { prUrl } : {}),
          ...(denials.length ? { denials } : {}),
        };
      }
      if (ev.type === "user") {
        // Tool results: only a pull request URL matters here (`gh pr create` prints it).
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
        for (const block of blocks) {
          if (block?.type !== "tool_result") continue;
          const prUrl = findPullRequestUrl(toolResultText(block.content));
          if (prUrl) return { session, prUrl };
        }
        return session ? { session } : {};
      }
      if (ev.type === "assistant") {
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        const out: ParsedLine = { session };
        const files: string[] = [];
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              out.line = first(block.text);
              const prUrl = findPullRequestUrl(block.text);
              if (prUrl) out.prUrl = prUrl;
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              const input = (block.input ?? {}) as Record<string, unknown>;
              const name = block.name.replace(DELEGATED_TOOL, "");
              out.line = toolLine(name, input, rel);
              const p = input.file_path ?? input.notebook_path;
              if (EDIT_TOOLS.has(name) && typeof p === "string" && p) files.push(rel(p));
            }
          }
        }
        if (files.length) out.files = files;
        return out;
      }
      return session ? { session } : {};
    }
    return parseCodexEvent(ev, rel, first);
  }
  const prUrl = findPullRequestUrl(text);
  return { line: text, ...(prUrl ? { prUrl } : {}) };
}

/**
 * One `codex exec --json` event (JSONL): `thread.started` (its thread id),
 * `item.started|updated|completed` with `agent_message` (the human line and,
 * last one wins, the result; only when completed), `command_execution`
 * ("Running: …", a failure, a pull request in its output), `file_change`
 * (files), `mcp_tool_call`, `todo_list`; `turn.failed` and `error` (the
 * error, as the line and the result). Reasoning and usage are skipped.
 * Stderr is never a failure by itself (the person's own MCP servers log there).
 */
export function parseCodexEvent(
  ev: Record<string, unknown>,
  rel: (p: string) => string,
  first: (s: string) => string,
): ParsedLine {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (ev.type) {
    case "thread.started":
      return str(ev.thread_id) ? { thread: str(ev.thread_id) } : {};
    case "turn.failed": {
      const message = str((ev.error as { message?: unknown } | undefined)?.message) || "the turn failed";
      return { line: `Error: ${first(message)}`, error: message, result: message };
    }
    case "error": {
      const message = str(ev.message) || "error";
      return { line: `Error: ${first(message)}`, error: message };
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = (ev.item ?? {}) as Record<string, unknown>;
      const done = ev.type === "item.completed";
      switch (item.type) {
        case "agent_message": {
          if (!done) return {};
          const text = str(item.text);
          const prUrl = findPullRequestUrl(text);
          return text ? { line: first(text), result: text, ...(prUrl ? { prUrl } : {}) } : {};
        }
        case "command_execution": {
          const command = unwrapShell(str(item.command));
          const output = str(item.aggregated_output);
          const prUrl = findPullRequestUrl(output);
          const code = typeof item.exit_code === "number" ? item.exit_code : null;
          if (!done) return command ? { line: `Running: ${command}` } : {};
          // Refused by its sandbox or approval policy: listed at the end ("Liberar e repetir").
          if (item.status === "declined" && command) {
            return { line: `Not allowed: ${command}`, denials: [{ tool: "Bash", command: command.slice(0, 300) }] };
          }
          return {
            ...(code !== null && code !== 0 ? { line: `Command failed (exit ${code}): ${command}` } : {}),
            ...(prUrl ? { prUrl } : {}),
          };
        }
        case "file_change": {
          const files = (Array.isArray(item.changes) ? (item.changes as { path?: unknown }[]) : []).flatMap((c) =>
            typeof c?.path === "string" && c.path ? [rel(c.path)] : [],
          );
          return files.length ? { files, line: `Editing ${files[0]}` } : {};
        }
        case "mcp_tool_call":
          return done ? {} : { line: `Using ${str(item.tool) || "a tool"}` };
        case "todo_list":
          return { line: "Updating its plan" };
        case "error": {
          const message = str(item.message);
          return message ? { line: `Error: ${first(message)}` } : {};
        }
        default:
          return {};
      }
    }
    default:
      return {};
  }
}

/** `/bin/zsh -lc "npm test"` → `npm test` (Codex wraps every command in the login shell). */
function unwrapShell(command: string) {
  const m = /^\S*(?:sh|bash|zsh)\s+-l?c\s+(["'])([\s\S]*)\1$/.exec(command.trim());
  return (m ? (m[2] ?? "") : command).replace(/\s+/g, " ").trim();
}

/** The end of a log (at most `max` bytes) and whether there was more before it. */
function readTail(file: string, max: number): { text: string; truncated: boolean } {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fd = openSync(file, "r");
    const n = readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, n).toString("utf8");
    // Cut where a line was split by the window.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: start > 0 };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Reads what a log grew since `offset` (at most 1 MB per call). */
function readFrom(file: string, offset: number): { text: string; next: number } {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    if (size <= offset) return { text: "", next: size < offset ? 0 : offset };
    const length = Math.min(size - offset, 1024 * 1024);
    const buf = Buffer.alloc(length);
    fd = openSync(file, "r");
    const n = readSync(fd, buf, 0, length, offset);
    return { text: buf.subarray(0, n).toString("utf8"), next: offset + n };
  } catch {
    return { text: "", next: offset };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface Watch {
  timer: ReturnType<typeof setInterval>;
  offsets: { stdout: number; stderr: number };
  partial: { stdout: string; stderr: string };
  tail: string[];
  result?: string;
  lastSentLine?: string;
  lastSentAt: number;
  pendingLine?: string;
  /** A pull request URL not yet sent. */
  pendingPr?: string;
  /** Refused commands seen so far (sent with `task.done`). */
  denials: TaskDenial[];
  newFiles: string[];
  redact: (text: string) => string;
  missingSince?: number;
  cancelAt?: number;
}

const addDenial = (w: Watch, denial: TaskDenial) => {
  if (w.denials.length >= TASK_LIMITS.denials || w.denials.some((x) => x.command === denial.command)) return;
  w.denials.push(denial);
};

export class TaskManager {
  private journal: Journal = { tasks: [] };
  private readonly watches = new Map<string, Watch>();
  /** A Codex task's ChatGPT sign-in root keeps: stop sending its refreshed copies back when the task ends. */
  private readonly releases = new Map<string, () => void>();
  /** How each task this runner started was launched, for its retry (`retryOtherFlag`); in memory only, until it ends. */
  private readonly launches = new Map<string, { env: NodeJS.ProcessEnv; token?: string }>();
  /** Tasks whose CLI root runs for this very process: one it doesn't know began before a restart and has ended. */
  private readonly hostedRuns = new Set<string>();
  private send: ((frame: RunnerFrame) => void) | null = null;
  private caffeinate: ChildProcess | null = null;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly opts: TaskManagerOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  get journalFile() {
    return path.join(this.opts.root, "journal.json");
  }

  private dirOf(taskId: string) {
    if (!TASK_ID.test(taskId)) throw new RunnerError("bad_request", "Invalid task id");
    return path.join(this.opts.root, taskId);
  }

  private save() {
    mkdirSync(this.opts.root, { recursive: true, mode: 0o700 });
    writeJson(this.journalFile, this.journal);
  }

  /** Loads the journal and picks up where the last runner stopped: running tasks are watched again, finished ones reported. */
  async init() {
    mkdirSync(this.opts.root, { recursive: true, mode: 0o700 });
    const loaded = readJson<Journal>(this.journalFile);
    this.journal = { tasks: Array.isArray(loaded?.tasks) ? loaded.tasks.filter((t) => TASK_ID.test(t.taskId)) : [] };
    // Forget what the server has had for a week (and its logs).
    const cutoff = this.now() - TASK_KEEP_MS;
    for (const t of [...this.journal.tasks]) {
      if (t.status !== "running" && t.delivered && t.endedAt && Date.parse(t.endedAt) < cutoff) {
        rmSync(this.dirOf(t.taskId), { recursive: true, force: true });
        this.journal.tasks = this.journal.tasks.filter((x) => x !== t);
      }
    }
    for (const t of this.journal.tasks) {
      if (t.status === "running") await this.watch(t, true, await this.reattachRedact(t));
    }
    this.save();
    this.updateCaffeinate();
  }

  /**
   * After a restart, the redaction of a task whose env holds a coding plan's key: the key read again from the
   * account's folder, else (root kept it) the task is canceled and nothing it says leaves the computer.
   */
  private async reattachRedact(t: Entry): Promise<((text: string) => string) | undefined> {
    if (!t.planKey || !t.account) return undefined;
    const kind: AccountKind = t.executor === "codex" ? "codex" : "claude_code";
    const signIn = await accountSignIn(this.opts.accounts, kind, t.account).catch(() => "missing" as const);
    if (typeof signIn === "object" && signIn.planKey) {
      const secrets = await this.opts.secrets?.({ id: t.agentId, handle: t.agentHandle }).catch(() => null);
      return withSignIn(secrets, signIn)?.redact;
    }
    t.canceledWhy =
      "Stopped: the runner restarted and could no longer hide this account's key from what the task says. Start it again.";
    this.cancel(undefined, t.taskId);
    return () => "";
  }

  /** For `hello`: every task the server may not know the end of. */
  list(): RunnerTask[] {
    return this.journal.tasks.filter((t) => t.status === "running" || !t.delivered).map((t) => this.info(t));
  }

  private info(t: Entry): RunnerTask {
    const seconds = Math.max(
      0,
      Math.round(((t.endedAt ? Date.parse(t.endedAt) : this.now()) - Date.parse(t.startedAt)) / 1000),
    );
    return {
      taskId: t.taskId,
      agentId: t.agentId,
      status: t.status,
      ...(t.pid ? { pid: t.pid } : {}),
      startedAt: t.startedAt,
      ...(t.endedAt ? { endedAt: t.endedAt } : {}),
      ...(t.done ? { exitCode: t.done.exitCode, signal: t.done.signal ?? null } : {}),
      seconds,
      ...(t.lastLine ? { lastLine: t.lastLine } : {}),
      ...(t.files.length ? { files: t.files.slice(0, TASK_LIMITS.files) } : {}),
    };
  }

  /** A new connection: frames go there, and every `task.done` the server hasn't acknowledged goes again. */
  attach(send: (frame: RunnerFrame) => void) {
    this.send = send;
    for (const t of this.journal.tasks) {
      if (t.done && !t.delivered) this.emit({ type: "task.done", ...t.done });
    }
  }

  detach() {
    this.send = null;
  }

  private emit(frame: RunnerFrame) {
    if (!this.send) return;
    try {
      this.send(frame);
    } catch {
      // the socket went away; `task.done` goes again after the reconnect
    }
  }

  /** The server stored this task's end. */
  ack(taskId: string) {
    const t = this.journal.tasks.find((x) => x.taskId === taskId);
    if (!t || t.delivered) return;
    t.delivered = true;
    this.save();
  }

  get running() {
    return this.journal.tasks.filter((t) => t.status === "running").length;
  }

  /** Running tasks, for the desktop app's "now" (they survive runner restarts). */
  runningTasks(): SettledTask[] {
    return this.journal.tasks.filter((t) => t.status === "running").map((t) => this.settled(t));
  }

  private settled(t: Entry): SettledTask {
    return {
      taskId: t.taskId,
      agentId: t.agentId,
      agentHandle: t.agentHandle,
      executor: t.executor,
      command: t.command,
      cwd: t.cwd,
      startedAt: t.startedAt,
      ...(t.done ? { done: t.done } : {}),
      ...(t.account ? { account: t.account } : {}),
    };
  }

  /**
   * System mode, in a worker: the account its agent thinks with now (null: none), as root says on each change. A
   * task on any other account is canceled (`BrainManager.keepAccount` closes its turns' processes alike), so no
   * process of this agent's user keeps a sign-in the agent left or one that was removed.
   */
  keepAccount(account: string | null, also: readonly string[] = []) {
    for (const t of this.journal.tasks) {
      if (t.status === "running" && t.account && t.account !== account && !also.includes(t.account) && !t.canceling) {
        t.canceledWhy = "Stopped: this agent's AI account changed. Start it again to use the new one.";
        this.cancel(undefined, t.taskId);
      }
    }
  }

  /** New limits from the config (the app's Preferences, or an edit): they apply to the next start. */
  setLimits(limits: { maxConcurrent?: number; defaultMaxSeconds?: number }) {
    if (limits.maxConcurrent !== undefined) this.opts.maxConcurrent = limits.maxConcurrent;
    if (limits.defaultMaxSeconds !== undefined) this.opts.defaultMaxSeconds = limits.defaultMaxSeconds;
  }

  /** Starts the wrapper for a task folder, detached (it outlives this runner); a token goes on its descriptor 3. */
  private spawnWrapper(dir: string, env: NodeJS.ProcessEnv, executor: TaskExecutor, token?: string): ChildProcess {
    let command = this.opts.wrapperCommand;
    if (!command?.length) {
      const wrapper = path.join(this.opts.root, "wrap.mjs");
      writeFileSync(wrapper, WRAPPER_SOURCE, { mode: 0o600 });
      command = [this.opts.runtime ?? process.execPath, wrapper];
    }
    const [file, ...args] = command;
    const start = (executor !== "shell" && this.opts.spawnCli) || spawn;
    const child = start(file as string, [...args, dir], {
      cwd: dir,
      env,
      stdio: token ? ["ignore", "ignore", "ignore", "pipe"] : "ignore",
      detached: true,
      windowsHide: true,
    });
    if (token) handToken(child, token);
    return child;
  }

  /**
   * ADR 0041 §5.1: a Claude Code or Codex task on the agent's account signs in as its turns do
   * (`accountSignIn`), refused at once when that account has no sign-in here. Null: the computer's own sign-in.
   */
  private async signIn(executor: "claude" | "codex", account: unknown, grant?: AccountGrant) {
    if (account === undefined || account === null || account === "") return null;
    if (!isAccountId(account)) throw new RunnerError("bad_request", "Invalid account id");
    const kind: AccountKind = executor === "codex" ? "codex" : "claude_code";
    const signIn = await accountSignIn(this.opts.accounts, kind, account, grant);
    if (signIn === "signed_out") throw new RunnerError("not_found", ACCOUNT_SIGNED_OUT);
    if (signIn === "missing") throw new RunnerError("not_found", ACCOUNT_MISSING_MESSAGE[kind]);
    return { ...signIn, kind, account };
  }

  /**
   * Starts a task. `allowed.grants` (protocol 10): the folders allowed for the
   * agent besides its own (real paths): `cwd` may be absolute inside one,
   * and Claude Code / Codex get them all (`--add-dir`, writable roots).
   * `grant` (system mode, protocol 29): what root handed over for `req.account`.
   */
  async start(
    agent: AgentScope,
    req: TaskStart,
    allowed?: { grants?: string[] },
    grant?: AccountGrant,
  ): Promise<MachineReplies["task.start"]> {
    if (this.closed) throw new RunnerError("internal", "The runner is stopping");
    const taskId = String(req.taskId ?? "");
    const dir = this.dirOf(taskId);
    if (this.journal.tasks.some((t) => t.taskId === taskId)) throw new RunnerError("bad_request", "Duplicate task id");
    const max = this.opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TASKS;
    if (this.running >= max) {
      throw new RunnerError(
        "no_slot",
        `This computer already runs ${max} background tasks (its limit). Wait for one to finish or cancel one.`,
      );
    }
    const executor: TaskExecutor = req.executor === "claude" || req.executor === "codex" ? req.executor : "shell";
    const session = typeof req.session === "string" && SESSION_ID.test(req.session) ? req.session : undefined;
    const prompt = typeof req.prompt === "string" ? req.prompt : "";
    if (executor !== "shell" && !prompt.trim())
      throw new RunnerError("bad_request", `A ${executor} task needs a prompt`);
    const hosted = executor === "claude" && grant?.kind === "hosted";
    const signIn = executor === "shell" || hosted ? null : await this.signIn(executor, req.account, grant);
    if (signIn?.release) this.releases.set(taskId, signIn.release);
    const keyPlan = executor === "claude" && signIn?.planKey ? planOf(signIn.planKey.provider) : undefined;
    const plan = keyPlan && planForTurn(keyPlan, req.model);
    // The agent's model on its plan, as its turns: the plan's `sonnet` when the server named none.
    const planModel = plan ? claudeCodeModel(plan, req.model) : undefined;
    const folder = await this.opts.agentFolder(agent);
    let cwd = folder;
    if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
      const resolved = await resolveForAgent(folder, allowed?.grants, req.cwd);
      if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
      if (!statSync(resolved.abs).isDirectory()) throw new RunnerError("bad_request", `${req.cwd} is not a folder`);
      cwd = resolved.abs;
    }
    const missionTask = typeof req.mission?.id === "string" && TASK_ID.test(req.mission.id);
    // The agent's own branches: its own prefix, and a mission's.
    const own = ownBranches(
      agent,
      missionTask ? missionBranchPrefix(String(req.mission?.id), req.mission?.branchPrefix) : undefined,
    );
    // A shell task runs its command as is: the command policy reads it first, as the brain's own commands
    // (ADR 0053 §3). A person's approval of this very task (`approved`) lets it through, unless our git proxy
    // would refuse it anyway (`never`).
    if (executor === "shell") {
      const held = await commandApproval(String(req.command ?? ""), {
        cwd,
        own,
        how: ASK_AGAIN,
        script: true,
        ...(typeof req.branch === "string" && req.branch.trim() ? { head: req.branch.trim() } : {}),
      });
      if (held?.never) throw new RunnerError("not_allowed", held.message);
      if (held && req.approved !== true) throw new RunnerError("approval_needed", held.message);
    }
    let branch: string | undefined;
    // Where an item works, told first in its prompt (the server's prompt doesn't know whether there is git).
    let where = "";
    // The mission folder (an item's worktree or subfolder is inside or next to it): writes and saves are fine here.
    const missionRoot = cwd;
    if (typeof req.branch === "string" && req.branch.trim() !== "") {
      const repo = cwd;
      if (executor === "shell" || isGitRepo(cwd)) {
        branch = req.branch.trim();
        cwd = createWorktree(cwd, folder, taskId, branch);
        if (missionTask) where = `Your branch: ${branch} (in its own worktree).`;
      } else {
        // No git (images, documents, files for the Drive): no branch, its own subfolder so parallel items never collide.
        cwd = itemFolder(repo, req.branch, taskId);
        const sub = path.relative(repo, cwd).split(path.sep).join("/");
        where = `Your folder: ${sub}/ inside the mission folder (not a git repository: no branches, commits or pushes). The mission folder is ../../ and its files are in .agentes/. Put what you make in your folder and deliver it with upload_artifact or request_review.`;
      }
      // A mission item in its own worktree or subfolder still reads the mission's files (ADR 0029).
      if (missionTask) linkMissionFiles(repo, cwd);
    } else if (missionTask) {
      excludeLocally(cwd, ".agentes/");
    }
    // Protocol 14 (ADR 0044): where the task starts from, kept in the journal (the commit at its end survives a restart).
    const commitMessage =
      typeof req.commit?.message === "string" && req.commit.message.trim()
        ? req.commit.message.trim().slice(0, COMMIT_MESSAGE_MAX)
        : undefined;
    const startSha = commitMessage ? headSha(cwd) : undefined;
    const baseBehind = req.baseCheck ? commitsBehind(cwd, req.baseCheck) : undefined;
    // Claude Code resumes a session it has (this folder, or any project folder), else starts it with that id. On an
    // account its sessions are in the account's folder: one with none there has none to resume.
    let resume = req.resume === true;
    if (executor === "claude" && session) {
      const home =
        signIn?.home ?? this.opts.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
      resume = claudeSessionExists(home, cwd, session) ?? (signIn ? false : resume);
    }
    // Codex resumes the thread it opened for this session before (by id, in the same Codex home), else a new one.
    const codexThread =
      executor === "codex" && session
        ? this.journal.codexThreads?.[codexThreadKey(session, signIn?.account)]
        : undefined;
    if (executor === "codex") resume = Boolean(codexThread);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A mission task (protocol 5): our MCP server for its executor, bound to this task by a token.
    const missionId =
      executor !== "shell" && typeof req.mission?.id === "string" && TASK_ID.test(req.mission.id)
        ? req.mission.id
        : undefined;
    // Protocol 14: a read item (ADR 0044) can't edit, whatever its prompt says.
    const readOnly = Boolean(missionId) && req.mission?.mode === "plan";
    let extra: string[] = [];
    let mcpToken: string | undefined;
    const input = where ? `${where}\n\n${prompt}` : prompt;
    // On an account, Claude Code's endpoint and proxies are pinned in its own `--settings`, as a turn's: a project's
    // settings never send its sign-in elsewhere.
    const accountSettings = executor === "claude" && signIn ? { env: accountSettingsEnv(plan, planModel) } : {};
    if (hosted) {
      // Its CLI's files and tools are root's and this worker's bridge's.
    } else if (missionId && this.opts.mcp) {
      mcpToken = newMcpToken();
      writeFileSync(path.join(dir, MCP_TOKEN_FILE), mcpToken, { mode: 0o600 });
      const configFile = path.join(dir, "mcp.json");
      const settingsFile = path.join(dir, "settings.json");
      // The rules for the folder it runs in: branches, commits and pushes only in a git repository.
      const given = typeof req.mission?.rules === "string" ? req.mission.rules : "";
      const rules = given && !isGitRepo(cwd) ? MISSION_RULES_NO_GIT : given;
      if (executor === "claude") {
        const config = claudeMcpConfig({
          command: this.opts.mcp.command,
          taskId,
          socketPath: this.opts.mcp.socketPath,
          token: mcpToken,
          cwd,
          folders: [...new Set([cwd, missionRoot])],
          runnerHome: path.dirname(this.opts.root),
          branches: own,
          task: "mission",
        });
        writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
        // What it may run without asking: item tasks work (the main session plans as an engine run, ADR 0032).
        const allow = Array.isArray(req.mission?.allow) ? req.mission.allow.filter((r) => typeof r === "string") : [];
        // An item in its own worktree or subfolder: the mission folder too (its .agentes/, shared inputs).
        const away = missionTask && path.resolve(cwd) !== path.resolve(missionRoot);
        writeFileSync(
          settingsFile,
          JSON.stringify({
            ...claudePermissionSettings(
              readOnly ? "plan" : "work",
              allow,
              away ? path.resolve(missionRoot) : undefined,
              {
                runnerHome: path.dirname(this.opts.root),
              },
            ),
            ...accountSettings,
          }),
          { mode: 0o600 },
        );
      }
      extra = missionExecutorArgs(executor === "codex" ? "codex" : "claude", {
        configFile,
        command: this.opts.mcp.command,
        taskId,
        socketPath: this.opts.mcp.socketPath,
        rules,
        ...(executor === "claude"
          ? {
              settingsFile,
              promptTool: true,
              ...(missionTask && path.resolve(cwd) !== path.resolve(missionRoot)
                ? { addDirs: [path.resolve(missionRoot)] }
                : {}),
            }
          : { resumed: Boolean(codexThread) }),
      });
    } else if (missionId) {
      this.log(`task ${taskId} works for a mission, but this runner has no MCP endpoint`);
    } else if (executor === "claude" && this.opts.mcp) {
      // Outside a mission, Claude Code keeps the computer owner's own settings, plus the deny list, and every
      // push asks our prompt tool, which answers on this computer alone (ADR 0053 §3).
      const configFile = path.join(dir, "mcp.json");
      const settingsFile = path.join(dir, "settings.json");
      const config = claudeMcpConfig({
        command: this.opts.mcp.command,
        taskId,
        socketPath: this.opts.mcp.socketPath,
        token: newMcpToken(),
        cwd,
        folders: [cwd],
        runnerHome: path.dirname(this.opts.root),
        branches: own,
        task: "local",
      });
      writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
      writeFileSync(
        settingsFile,
        JSON.stringify({
          permissions: { ask: [...PUSH_ASK_RULES], deny: [...MISSION_DENY_RULES] },
          ...accountSettings,
        }),
        { mode: 0o600 },
      );
      extra = missionExecutorArgs("claude", {
        configFile,
        command: this.opts.mcp.command,
        taskId,
        socketPath: this.opts.mcp.socketPath,
        rules: "",
        settingsFile,
        promptTool: true,
      });
    }
    if (executor === "claude" && signIn && !this.opts.mcp) {
      const settingsFile = path.join(dir, "settings.json");
      writeFileSync(settingsFile, JSON.stringify(accountSettings), { mode: 0o600 });
      extra.push("--settings", shellArg(settingsFile));
    }
    // A coding plan serves only its own models: Claude Code asks for one by the alias the plan maps (as a turn).
    if (planModel) extra.push("--model", planModel);
    const command = hosted
      ? "claude"
      : executorCommand(executor, {
          command: req.command,
          ...(readOnly && executor === "claude" ? { permissionMode: "dontAsk" as const } : {}),
          session,
          resume,
          extra,
          ...(allowed?.grants?.length ? { addDirs: allowed.grants.filter((g) => !isInside(g, cwd)) } : {}),
          ...(executor === "codex"
            ? {
                codex: {
                  cwd,
                  sandbox: readOnly ? ("read-only" as const) : ("workspace-write" as const),
                  lastFile: path.join(dir, "last.txt"),
                  ...(codexThread ? { thread: codexThread } : {}),
                },
              }
            : {}),
        });
    const maxSeconds = clampInt(
      req.maxSeconds,
      1,
      TASK_MAX_SECONDS_CAP,
      this.opts.defaultMaxSeconds ?? DEFAULT_TASK_MAX_SECONDS,
    );
    const secrets = (await this.opts.secrets?.(agent)) ?? null;
    let pid: number | undefined = process.pid;
    if (!hosted) {
      const shell = shellCommand(command);
      writeJson(path.join(dir, "spec.json"), {
        file: shell.file,
        args: shell.args,
        verbatim: shell.verbatim,
        cwd,
        maxSeconds,
        ...(signIn?.token ? { tokenFd: true } : {}),
      });
      if (executor !== "shell") writeFileSync(path.join(dir, "stdin.txt"), input, { mode: 0o600 });
      // A Codex task's sandbox is what holds it: no way out through the agent's containers service (ADR 0169).
      const own = executor === "codex" ? withoutContainers(process.env) : process.env;
      const base: NodeJS.ProcessEnv = { ...own, ...(secrets?.env ?? {}) };
      // As a turn's (ADR 0041 §5): the account's folder is the CLI's home and nothing else signs it in; a plan's key
      // goes in the env under the plan's name, a token only on descriptor 3 (`spawnWrapper`).
      const env = signIn ? accountEnv(signIn.kind, signIn.home, base) : base;
      if (plan && signIn?.planKey) env[plan.claudeCode.tokenEnv] = signIn.planKey.key;
      if (signIn?.token) Object.assign(env, TOKEN_FD_ENV);
      // Claude Code and Codex tasks run on their sign-in (the account's, or the computer's own): a route there stops
      // first (two processes on one sign-in race on its refresh token), right before the task starts.
      if (executor !== "shell") await yieldRoute(executor === "codex" ? "codex" : "claude_code", signIn?.home);
      let child: ChildProcess;
      let launch: { env: NodeJS.ProcessEnv; token?: string };
      try {
        // Codex hands our MCP process these by name (`env_vars`): the token never goes on a command line.
        const mcpEnv: Record<string, string> =
          executor === "codex" && mcpToken && this.opts.mcp
            ? {
                [CODEX_MCP_ENV[0]]: mcpToken,
                [CODEX_MCP_ENV[1]]: this.opts.mcp.socketPath,
                [CODEX_MCP_ENV[2]]: path.dirname(this.opts.root),
              }
            : executor === "claude" && mcpToken
              ? // A permission prompt waits for a person (up to PERMISSION_WAIT_MS): our tool call may take that long.
                { MCP_TOOL_TIMEOUT: String(PERMISSION_WAIT_MS + 5 * 60_000) }
              : {};
        // The agent's secrets (ADR 0027) through the environment only, never on disk here.
        launch = { env: { ...env, ...mcpEnv }, ...(signIn?.token ? { token: signIn.token } : {}) };
        child = this.spawnWrapper(dir, launch.env, executor, launch.token);
      } catch (err) {
        throw new RunnerError(
          "internal",
          `Couldn't start the task: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      (child as unknown as EventEmitter).on("error", () => {});
      child.unref();
      pid = child.pid;
      if (!pid) throw new RunnerError("internal", "Couldn't start the task");
      this.launches.set(taskId, launch);
    }
    // An allowed folder outside the agent's own (protocol 10) is reported by its absolute path.
    const rel = isInside(folder, cwd) ? path.relative(folder, cwd).split(path.sep).join("/") : cwd;
    const entry: Entry = {
      taskId,
      agentId: String(agent.id),
      agentHandle: String(agent.handle ?? ""),
      executor,
      command,
      cwd,
      cwdRel: rel,
      folder,
      ...(executor === "claude" && session && !hosted ? { resumed: resume } : {}),
      ...(branch ? { branch } : {}),
      ...(session ? { session } : {}),
      ...(missionId ? { missionId } : {}),
      ...(mcpToken ? { mcpToken } : {}),
      ...(mcpToken && isRunToolToken(req.mission?.mcpToken) ? { serverToken: req.mission.mcpToken } : {}),
      ...(commitMessage && startSha ? { commit: commitMessage, startSha } : {}),
      ...(signIn ? { account: signIn.account } : {}),
      ...(hosted ? { account: String(req.account), hosted: true as const } : {}),
      ...(plan && signIn?.planKey ? { planKey: true } : {}),
      status: "running",
      pid,
      startedAt: new Date(this.now()).toISOString(),
      maxSeconds,
      files: [],
    };
    this.journal.tasks.push(entry);
    this.save();
    if (hosted) this.hostedRuns.add(taskId);
    await this.watch(entry, false, (signIn ? withSignIn(secrets, signIn) : secrets)?.redact);
    this.updateCaffeinate();
    this.log(`[${entry.agentHandle}] task ${taskId} started: ${command.slice(0, 80)}`);
    return {
      taskId,
      pid,
      startedAt: entry.startedAt,
      cwd: rel,
      ...(branch ? { branch } : {}),
      command,
      ...(baseBehind !== undefined ? { baseBehind } : {}),
      ...(hosted ? { host: { cwd, where, git: isGitRepo(cwd), maxSeconds } satisfies HostedTask } : {}),
    };
  }

  private hostedTask(taskId: string) {
    return this.journal.tasks.find((t) => t.taskId === taskId && t.hosted && t.status === "running");
  }

  /** A line a hosted task's CLI printed, already through root's redaction. */
  hostedOutput(taskId: string, stream: "stdout" | "stderr", line: string) {
    if (this.hostedTask(taskId)) appendFileSync(path.join(this.dirOf(taskId), `${stream}.log`), `${line}\n`);
  }

  /** How a hosted task's CLI ended: the watcher takes it from here. */
  hostedExit(taskId: string, exit: HostedExit) {
    if (!this.hostedTask(taskId)) return;
    writeJson(path.join(this.dirOf(taskId), "exit.json"), { ...exit, endedAt: new Date(this.now()).toISOString() });
    this.hostedRuns.delete(taskId);
  }

  /** A tool of a hosted task's session refused a call nobody could approve (Claude Code's own would list it in `result`). */
  hostedDenial(session: string, tool: string, input: Record<string, unknown>) {
    const t = this.journal.tasks.find((x) => x.hosted && x.session === session && x.status === "running");
    const w = t && this.watches.get(t.taskId);
    const [denial] = claudeDenials([{ tool_name: tool, tool_input: input }]);
    if (w && denial) addDenial(w, { ...denial, command: w.redact(denial.command) });
  }

  /** For the MCP bridge: a mission task's token and whether it still runs. */
  mcpTask(taskId: string): McpTaskInfo | null {
    const t = this.journal.tasks.find((x) => x.taskId === taskId);
    if (!t?.missionId || !t.mcpToken) return null;
    return {
      token: t.mcpToken,
      missionId: t.missionId,
      running: t.status === "running",
      cwd: t.cwd,
      ...(t.serverToken ? { serverToken: t.serverToken } : {}),
      ...(t.folder ? { folder: t.folder } : {}),
      ...(this.watches.get(t.taskId)?.redact ? { redact: this.watches.get(t.taskId)?.redact } : {}),
    };
  }

  status(agent: AgentScope | undefined, taskId?: string): MachineReplies["task.status"] {
    const mine = this.journal.tasks.filter((t) => !agent || t.agentId === agent.id);
    return { tasks: (taskId ? mine.filter((t) => t.taskId === taskId) : mine).map((t) => this.info(t)) };
  }

  /**
   * `task.output` (protocol 6): the last `tail` human lines of a task, from
   * its logs (stdout first, then what it wrote to stderr), redacted with the
   * agent's secrets. Claude Code's `stream-json` becomes the same lines the
   * watcher sends, never raw JSON.
   */
  async output(agent: AgentScope | undefined, taskId: string, tail: number): Promise<MachineReplies["task.output"]> {
    const t = this.journal.tasks.find((x) => x.taskId === taskId && (!agent || x.agentId === agent.id));
    if (!t) throw new RunnerError("not_found", "No such task on this computer");
    const n = clampInt(tail, 1, TASK_LIMITS.outputLines, 50);
    const dir = this.dirOf(t.taskId);
    const redact =
      this.watches.get(t.taskId)?.redact ??
      (await this.opts.secrets?.({ id: t.agentId, handle: t.agentHandle }).catch(() => null))?.redact ??
      ((x: string) => x);
    const lines: string[] = [];
    let truncated = false;
    for (const stream of ["stdout", "stderr"] as const) {
      const read = readTail(path.join(dir, `${stream}.log`), OUTPUT_READ_BYTES);
      truncated ||= read.truncated;
      for (const raw of read.text.split("\n")) {
        const parsed = parseOutputLine(raw, stream === "stdout" ? t.executor : "shell", t.cwd);
        if (parsed.line) lines.push(redact(parsed.line).slice(0, TASK_LIMITS.line));
      }
    }
    return { lines: lines.slice(-n), truncated: truncated || lines.length > n };
  }

  cancel(agent: AgentScope | undefined, taskId: string): MachineReplies["task.cancel"] {
    const t = this.journal.tasks.find((x) => x.taskId === taskId && (!agent || x.agentId === agent.id));
    if (!t) throw new RunnerError("not_found", "No such task on this computer");
    if (t.status !== "running") return { canceled: false };
    t.canceling = true;
    this.save();
    const dir = this.dirOf(t.taskId);
    // The wrapper polls this file every second. No SIGTERM to it right away: a wrapper that is still
    // starting has no handler yet and would die without stopping the command or writing `exit.json`.
    // One that ignores the file is killed after the grace (`hardKill`).
    try {
      writeFileSync(path.join(dir, "cancel"), "");
    } catch {}
    const w = this.watches.get(t.taskId);
    if (w) w.cancelAt = this.now();
    if (t.hosted) this.opts.hostedStop?.(t.taskId);
    return { canceled: true };
  }

  private async watch(t: Entry, resumed: boolean, redact?: (text: string) => string) {
    const dir = this.dirOf(t.taskId);
    const size = (f: string) => {
      try {
        return statSync(path.join(dir, f)).size;
      } catch {
        return 0;
      }
    };
    // After a runner restart only the recent output matters (the last line, the tail).
    const start = (f: string) => (resumed ? Math.max(0, size(f) - 64 * 1024) : 0);
    const clean =
      redact ??
      (await this.opts.secrets?.({ id: t.agentId, handle: t.agentHandle }).catch(() => null))?.redact ??
      ((s: string) => s);
    const w: Watch = {
      timer: setInterval(() => this.tick(t), this.opts.watchMs ?? WATCH_MS),
      offsets: { stdout: start("stdout.log"), stderr: start("stderr.log") },
      partial: { stdout: "", stderr: "" },
      tail: [],
      lastSentAt: 0,
      denials: [],
      newFiles: [],
      redact: clean,
    };
    w.timer.unref?.();
    this.watches.set(t.taskId, w);
  }

  /** One look at a running task: new output, then whether it ended. */
  private tick(t: Entry) {
    const w = this.watches.get(t.taskId);
    if (!w || t.status !== "running") return;
    const dir = this.dirOf(t.taskId);
    this.readOutput(t, w, dir);
    const exit = readJson<ExitFile>(path.join(dir, "exit.json"));
    if (exit) return this.finish(t, w, exit);
    const now = this.now();
    let aliveAt = 0;
    try {
      aliveAt = statSync(path.join(dir, "alive")).mtimeMs;
    } catch {}
    const startedAt = Date.parse(t.startedAt);
    // The wrapper writes `alive` as it starts; give it a moment before judging.
    const gone = t.hosted
      ? !this.hostedRuns.has(t.taskId)
      : !pidAlive(t.pid) || (now - startedAt > ALIVE_STALE_MS && now - aliveAt > ALIVE_STALE_MS);
    if (gone) {
      // Wait one more look: `exit.json` may be landing right now.
      if (w.missingSince === undefined) {
        w.missingSince = now;
        return;
      }
      return this.finish(t, w, null);
    }
    w.missingSince = undefined;
    // The wrapper ignores a cancel (or is stuck): kill the command's group and the wrapper.
    if (w.cancelAt !== undefined && now - w.cancelAt > CANCEL_GRACE_MS) this.hardKill(t, dir);
    // Backstop for the wrapper's own limit.
    if (now - startedAt > (t.maxSeconds + 60) * 1000) {
      try {
        writeFileSync(path.join(dir, "cancel"), "");
      } catch {}
      if (w.cancelAt === undefined) w.cancelAt = now;
    }
    this.flushEvents(t, w, false);
  }

  private hardKill(t: Entry, dir: string) {
    if (t.hosted) return;
    let childPid: number | undefined;
    try {
      childPid = Number(readFileSync(path.join(dir, "child.pid"), "utf8").trim()) || undefined;
    } catch {
      // the wrapper never got that far
    }
    if (process.platform === "win32") {
      for (const pid of [childPid, t.pid]) {
        if (!pid) continue;
        try {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } catch {}
      }
      return;
    }
    for (const pid of [childPid ? -childPid : undefined, t.pid]) {
      if (!pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }

  private readOutput(t: Entry, w: Watch, dir: string) {
    for (const stream of ["stdout", "stderr"] as const) {
      const { text, next } = readFrom(path.join(dir, `${stream}.log`), w.offsets[stream]);
      w.offsets[stream] = next;
      if (!text) continue;
      let buf = w.partial[stream] + text;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      w.partial[stream] = buf.length > MAX_LINE_BUFFER ? "" : buf;
      for (const raw of lines) this.onLine(t, w, raw, stream);
    }
  }

  private onLine(t: Entry, w: Watch, raw: string, stream: "stdout" | "stderr") {
    // Claude Code's events are on stdout; its stderr (and every other executor's output) is plain text.
    const parsed = parseOutputLine(raw, stream === "stdout" ? t.executor : "shell", t.cwd);
    if (parsed.thread && t.session && t.executor === "codex") {
      const key = codexThreadKey(t.session, t.account);
      this.journal.codexThreads = { ...(this.journal.codexThreads ?? {}), [key]: parsed.thread };
      this.save();
    }
    if (parsed.session && !t.session) t.session = parsed.session;
    if (parsed.result !== undefined) w.result = parsed.result;
    for (const d of parsed.denials ?? []) addDenial(w, { tool: d.tool, command: w.redact(d.command) });
    const line = parsed.line ? w.redact(parsed.line).slice(0, TASK_LIMITS.line) : "";
    if (line) {
      w.pendingLine = line;
      t.lastLine = line;
      w.tail.push(line);
      if (w.tail.length > TAIL_LINES) w.tail.shift();
    }
    if (parsed.prUrl && !t.prUrl) {
      t.prUrl = w.redact(parsed.prUrl).slice(0, TASK_LIMITS.prUrl);
      w.pendingPr = t.prUrl;
    }
    for (const f of parsed.files ?? []) {
      if (!f || t.files.includes(f) || t.files.length >= TASK_LIMITS.files) continue;
      t.files.push(f);
      w.newFiles.push(f);
    }
  }

  private flushEvents(t: Entry, w: Watch, final: boolean) {
    const now = this.now();
    const seconds = Math.round((now - Date.parse(t.startedAt)) / 1000);
    if (w.newFiles.length > 0) {
      this.emit({ type: "task.event", taskId: t.taskId, kind: "files", files: [...t.files] });
      w.newFiles = [];
      this.save();
    }
    if (w.pendingPr) {
      this.emit({ type: "task.event", taskId: t.taskId, kind: "progress", seconds, prUrl: w.pendingPr });
      w.pendingPr = undefined;
      this.save();
    }
    if (final) return;
    if (
      w.pendingLine !== undefined &&
      w.pendingLine !== w.lastSentLine &&
      now - w.lastSentAt >= (this.opts.eventEveryMs ?? EVENT_EVERY_MS)
    ) {
      this.emit({ type: "task.event", taskId: t.taskId, kind: "line", line: w.pendingLine, seconds });
      w.lastSentLine = w.pendingLine;
      w.pendingLine = undefined;
      w.lastSentAt = now;
    } else if (now - w.lastSentAt >= PROGRESS_EVERY_MS) {
      this.emit({ type: "task.event", taskId: t.taskId, kind: "progress", seconds });
      w.lastSentAt = now;
    }
  }

  private finish(t: Entry, w: Watch, exit: ExitFile | null) {
    clearInterval(w.timer);
    this.readOutput(t, w, this.dirOf(t.taskId));
    for (const stream of ["stdout", "stderr"] as const) {
      if (w.partial[stream]) this.onLine(t, w, w.partial[stream], stream);
      w.partial[stream] = "";
    }
    this.flushEvents(t, w, true);
    this.watches.delete(t.taskId);
    this.releases.get(t.taskId)?.();
    this.releases.delete(t.taskId);
    // Claude Code refused the session flag at once ("already in use", "No conversation found"): try the other one, once.
    if (exit && this.wrongSessionFlag(t, w, exit)) {
      void this.retryOtherFlag(t, w, exit);
      return;
    }
    this.settle(t, w, exit);
  }

  private wrongSessionFlag(t: Entry, w: Watch, exit: ExitFile) {
    if (t.retried || t.executor !== "claude" || !t.session || t.resumed === undefined) return false;
    if (exit.exitCode === 0 || exit.reason) return false;
    const seconds = (Date.parse(exit.endedAt) - Date.parse(t.startedAt)) / 1000;
    return seconds <= FAST_FAIL_SECONDS && WRONG_SESSION_FLAG.test(`${w.tail.join("\n")}\n${w.result ?? ""}`);
  }

  /** Starts the same task again with the other session flag; when that can't start, the first end stands. */
  private async retryOtherFlag(t: Entry, w: Watch, exit: ExitFile) {
    const session = t.session as string;
    const command = flipSessionFlag(t.command, session, t.resumed === true);
    if (command === t.command) return this.settle(t, w, exit);
    const dir = this.dirOf(t.taskId);
    // The same sign-in as its start. A runner restarted since has lost an account's sign-in (it is never stored): no
    // retry, rather than one on the computer's own sign-in.
    const launch = this.launches.get(t.taskId);
    if (t.account && !launch) return this.settle(t, w, exit);
    try {
      const shell = shellCommand(command);
      writeJson(path.join(dir, "spec.json"), {
        file: shell.file,
        args: shell.args,
        verbatim: shell.verbatim,
        cwd: t.cwd,
        maxSeconds: t.maxSeconds,
        ...(launch?.token ? { tokenFd: true } : {}),
      });
      for (const f of ["exit.json", "alive", "child.pid", "cancel"]) rmSync(path.join(dir, f), { force: true });
      for (const f of ["stdout.log", "stderr.log"]) writeFileSync(path.join(dir, f), "", { mode: 0o600 });
      const secrets = (await this.opts.secrets?.({ id: t.agentId, handle: t.agentHandle }).catch(() => null)) ?? null;
      const env = launch?.env ?? (secrets ? { ...process.env, ...secrets.env } : process.env);
      const child = this.spawnWrapper(dir, env, t.executor, launch?.token);
      (child as unknown as EventEmitter).on("error", () => {});
      child.unref();
      if (!child.pid) throw new Error("no pid");
      t.command = command;
      t.resumed = !t.resumed;
      t.retried = true;
      t.pid = child.pid;
      t.startedAt = new Date(this.now()).toISOString();
      t.lastLine = undefined;
      this.save();
      this.log(`[${t.agentHandle}] task ${t.taskId}: retrying with ${t.resumed ? "--resume" : "--session-id"}`);
      // On an account, the redaction that also hides its key or token.
      await this.watch(t, false, t.account ? w.redact : (secrets?.redact ?? w.redact));
    } catch {
      this.settle(t, w, exit);
    }
  }

  /**
   * A task ended. Protocol 14: one with `commit` first commits what changed
   * (`git add -A`, then `git commit`; hooks run as usual), with " (stopped)"
   * after the message when it didn't end well. It stays `running` in the
   * journal until then, so a runner restart mid-commit commits again.
   */
  private settle(t: Entry, w: Watch, exit: ExitFile | null) {
    // Canceled and the wrapper gone without an exit: make sure nothing of the command is left.
    if (!exit && t.canceling) this.hardKill(t, this.dirOf(t.taskId));
    if (!t.commit || !t.startSha) return this.settleNow(t, w, exit);
    const ok = exit !== null && exit.exitCode === 0 && !exit.reason;
    const message = ok ? t.commit : `${t.commit} (stopped)`;
    void (async () => {
      const secrets = await this.opts.secrets?.({ id: t.agentId, handle: t.agentHandle }).catch(() => null);
      let commit: { startSha: string; endSha: string; error?: string };
      try {
        commit = await commitChanges(t.cwd, message, {
          env: secrets?.env ?? {},
          handle: t.agentHandle,
          startSha: t.startSha as string,
          host: this.opts.commitHost?.(),
        });
      } catch (err) {
        commit = { startSha: t.startSha as string, endSha: t.startSha as string, error: String(err) };
      }
      if (commit.error) this.log(`[${t.agentHandle}] task ${t.taskId}: couldn't commit: ${commit.error}`);
      this.settleNow(t, w, exit, commit);
    })();
  }

  private settleNow(
    t: Entry,
    w: Watch,
    exit: ExitFile | null,
    commit?: { startSha: string; endSha: string; error?: string },
  ) {
    this.launches.delete(t.taskId);
    const endedAt = exit?.endedAt ?? new Date(this.now()).toISOString();
    const seconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(t.startedAt)) / 1000));
    // Gone without an exit, or stopped from outside: interrupted, unless we were canceling it.
    const cut = exit?.reason === "interrupted";
    const canceled = exit && !cut ? exit.reason === "canceled" : t.canceling === true;
    const interrupted = !canceled && (!exit || cut);
    // Codex writes its final message to `last.txt` (`-o`): the result when the stream had none.
    const codexLast =
      t.executor === "codex" && !w.result
        ? (() => {
            try {
              return readFileSync(path.join(this.dirOf(t.taskId), "last.txt"), "utf8").trim() || undefined;
            } catch {
              return undefined;
            }
          })()
        : undefined;
    // A commit that failed (a hook said no): the changes stay in the folder and the reason goes with the result.
    const note = commit?.error ? `\n\nThe changes were not committed: ${commit.error}`.slice(0, 600) : "";
    const said = w.result ?? codexLast ?? w.tail.join("\n");
    const noSignIn = noSignInResult(t, exit, seconds, said);
    const why = canceled ? t.canceledWhy : undefined;
    if (noSignIn || why) t.lastLine = (why ?? noSignIn ?? "").slice(0, TASK_LIMITS.line);
    const text = noSignIn ?? said;
    const result = [why, w.redact(note ? `${text.slice(0, TASK_LIMITS.result - note.length)}${note}`.trim() : text)]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, TASK_LIMITS.result);
    t.status = interrupted ? "interrupted" : "done";
    t.endedAt = endedAt;
    t.done = {
      taskId: t.taskId,
      exitCode: exit ? exit.exitCode : null,
      signal: exit?.signal ?? (canceled && !exit ? "SIGTERM" : null),
      seconds,
      ...(result ? { result } : {}),
      ...(t.lastLine ? { lastLine: t.lastLine } : {}),
      ...(t.files.length ? { files: t.files.slice(0, TASK_LIMITS.files) } : {}),
      ...(canceled ? { canceled: true } : {}),
      ...(exit?.reason === "timeout" ? { timedOut: true } : {}),
      ...(interrupted ? { interrupted: true } : {}),
      ...(t.session ? { session: t.session } : {}),
      ...(w.denials.length ? { denials: w.denials } : {}),
      ...(commit ? { startSha: commit.startSha, endSha: commit.endSha } : {}),
    };
    t.delivered = false;
    this.save();
    this.updateCaffeinate();
    this.log(
      `[${t.agentHandle}] task ${t.taskId} ${interrupted ? "was interrupted" : canceled ? "was canceled" : `ended (exit ${exit?.exitCode ?? "?"})`}`,
    );
    this.emit({ type: "task.done", ...t.done });
    try {
      this.opts.onSettled?.(this.settled(t));
    } catch {
      // an observer never breaks the journal
    }
  }

  /** macOS: hold off idle sleep while any task runs (released when the runner exits, `-w`). */
  private updateCaffeinate() {
    const enabled = this.opts.caffeinate ?? process.platform === "darwin";
    if (!enabled) return;
    if (this.running > 0 && !this.caffeinate && !this.closed) {
      try {
        const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
        (child as unknown as EventEmitter).on("error", () => {
          this.caffeinate = null;
        });
        (child as unknown as EventEmitter).on("exit", () => {
          if (this.caffeinate === child) this.caffeinate = null;
        });
        child.unref();
        this.caffeinate = child;
      } catch {
        this.caffeinate = null;
      }
    } else if (this.running === 0 && this.caffeinate) {
      try {
        this.caffeinate.kill();
      } catch {}
      this.caffeinate = null;
    }
  }

  /** Whether macOS sleep is held right now (tests). */
  get holdingSleep() {
    return this.caffeinate !== null;
  }

  /** The runner is exiting: stop watching; the tasks themselves go on. */
  close() {
    this.closed = true;
    for (const w of this.watches.values()) clearInterval(w.timer);
    this.watches.clear();
    this.launches.clear();
    if (this.caffeinate) {
      try {
        this.caffeinate.kill();
      } catch {}
      this.caffeinate = null;
    }
    this.send = null;
  }
}

/** `TaskStart.commit.message`, cut. */
const COMMIT_MESSAGE_MAX = 500;
/** A commit's hooks may take this long (a pre-commit that runs the linter). */
const COMMIT_TIMEOUT_MS = 10 * 60_000;
const SHA = /^[0-9a-f]{7,64}$/;

/** `git rev-parse HEAD` in `cwd`; undefined outside git or before the first commit. */
export function headSha(cwd: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD^{commit}"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  const sha = !r.error && r.status === 0 ? r.stdout.trim() : "";
  return SHA.test(sha) ? sha : undefined;
}

/** `TaskStart.baseCheck`: commits `branch` has beyond `sha` (`git rev-list --count`); undefined when git can't say. */
export function commitsBehind(cwd: string, check: { branch?: unknown; sha?: unknown }): number | undefined {
  const branch = typeof check.branch === "string" ? check.branch.trim() : "";
  const sha = typeof check.sha === "string" ? check.sha.trim() : "";
  if (!branch || branch.startsWith("-") || branch.length > 200 || !SHA.test(sha)) return undefined;
  const r = spawnSync("git", ["rev-list", "--count", `${sha}..${branch}`, "--"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  const n = !r.error && r.status === 0 ? Number(r.stdout.trim()) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The end of a task with `commit` (ADR 0044): everything that changed in its
 * folder becomes one commit, but the files the mission's `ensure` copied
 * there (`commitPathspecs`). Nothing when the tree is clean. Hooks run (never
 * `--no-verify`); when the commit fails the changes stay and `error` says why.
 * The author is whoever the checkout has (`git.sync` sets the agent), else
 * the agent by its handle at `agents.<host>`, the server's host as the engine's
 * `agentCommitEmail` has it (`invalid`, a reserved name, when it isn't known).
 */
export async function commitChanges(
  cwd: string,
  message: string,
  opts: { env: Record<string, string>; handle: string; startSha: string; host?: string | undefined },
): Promise<{ startSha: string; endSha: string; error?: string }> {
  const { env } = opts;
  const end = async () => {
    const r = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], { env });
    const sha = r.code === 0 ? r.stdout.trim() : "";
    return SHA.test(sha) ? sha : opts.startSha;
  };
  // The files the mission's worktree got copied (a `.env`) stay out (ADR 0044).
  const specs = await commitPathspecs(cwd);
  const only = specs.length ? ["--", ...specs] : [];
  const status = await git(cwd, ["status", "--porcelain", ...only], { env });
  if (status.code !== 0)
    return { startSha: opts.startSha, endSha: await end(), error: gitWhy(status, "git status failed") };
  if (!status.stdout.trim()) return { startSha: opts.startSha, endSha: await end() };
  const add = await git(cwd, ["add", "-A", ...only], { env });
  if (add.code !== 0) return { startSha: opts.startSha, endSha: await end(), error: gitWhy(add, "git add failed") };
  const email = await git(cwd, ["config", "user.email"], { env });
  const handle = opts.handle.replace(/[^a-zA-Z0-9_-]/g, "") || "agent";
  const author =
    email.code === 0 && email.stdout.trim()
      ? []
      : ["-c", `user.name=${handle} (agentes)`, "-c", `user.email=${handle}@agents.${opts.host ?? "invalid"}`];
  const commit = await git(cwd, [...author, "commit", "-q", "-m", message], { env, timeoutMs: COMMIT_TIMEOUT_MS });
  return {
    startSha: opts.startSha,
    endSha: await end(),
    ...(commit.code !== 0 ? { error: gitWhy(commit, "git commit failed") } : {}),
  };
}

/** Whether `cwd` is inside a git work tree (false when git isn't installed). */
export function isGitRepo(cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", windowsHide: true });
  return !r.error && r.status === 0 && r.stdout.trim() === "true";
}

/**
 * A mission item's own folder when the mission folder isn't a git
 * repository: `<repo>/work/<last part of the branch>/` (another one with the
 * task id when that name is taken). Returns its path.
 */
export function itemFolder(repo: string, branch: string, taskId: string): string {
  const last = branch.trim().split("/").filter(Boolean).pop() ?? "";
  const slug =
    last
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "")
      .slice(0, 60) || "item";
  let target = path.join(repo, "work", slug);
  if (existsSync(target)) target = path.join(repo, "work", `${slug}-${taskId.replace(/[^a-zA-Z0-9]/g, "").slice(-8)}`);
  mkdirSync(target, { recursive: true });
  return target;
}

/** A branch name git accepts, or a clear refusal. */
function checkBranch(cwd: string, branch: string) {
  if (branch.length > 200 || branch.startsWith("-"))
    throw new RunnerError("bad_request", `Invalid branch name ${branch}`);
  const r = spawnSync("git", ["check-ref-format", "--branch", branch], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new RunnerError("bad_request", `Invalid branch name ${branch}`);
}

/**
 * `git worktree add -b <branch> <agent folder>/.worktrees/<taskId>` from the
 * repository at `cwd`; `.worktrees/` is excluded locally so it never shows as
 * untracked. Returns the new worktree's path.
 */
export function createWorktree(cwd: string, folder: string, taskId: string, branch: string): string {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", windowsHide: true });
  if (inside.error) throw new RunnerError("bad_request", "git is not installed on this computer");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw new RunnerError(
      "bad_request",
      "A shell task with a branch needs a git repository: the task's folder isn't one (start it without a branch)",
    );
  }
  checkBranch(cwd, branch);
  const target = path.join(folder, ".worktrees", taskId);
  mkdirSync(path.dirname(target), { recursive: true });
  const add = spawnSync("git", ["worktree", "add", "-b", branch, target], { cwd, encoding: "utf8", windowsHide: true });
  if (add.status !== 0) {
    throw new RunnerError("bad_request", `git worktree add failed: ${(add.stderr || add.stdout).trim().slice(0, 500)}`);
  }
  excludeLocally(cwd, ".worktrees/");
  return target;
}

/**
 * A mission item's worktree sees the mission's files: `<worktree>/.agentes`
 * is a link to the repository's `.agentes/` (a copy where links can't be
 * made, e.g. Windows without the right), and `.agentes/` stays out of git
 * (`info/exclude`). A worktree whose branch already tracks `.agentes/` keeps
 * its own.
 */
export function linkMissionFiles(repo: string, worktree: string) {
  excludeLocally(repo, ".agentes/");
  const source = path.join(repo, ".agentes");
  const target = path.join(worktree, ".agentes");
  try {
    mkdirSync(source, { recursive: true });
    if (existsSync(target)) return;
    symlinkSync(source, target, "dir");
  } catch {
    try {
      cpSync(source, target, { recursive: true });
    } catch {
      // the executor is told where the files are anyway
    }
  }
}
