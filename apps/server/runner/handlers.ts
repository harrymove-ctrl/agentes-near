import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ASK_AGAIN, inBrowserProfile } from "@agenteschat/adapters/command-policy";
import {
  type AgentScope,
  browserSetupOf,
  type FileEntry,
  isStreamId,
  isTerminalSize,
  MAX_INLINE_FILE_BYTES,
  type MachineErrorCode,
  type MachineOp,
  type MachineReplies,
  type MachineRequest,
  type RunnerAccess,
  type RunnerFrame,
  type RunnerPause,
  type RunnerTools,
  STEER_LIMITS,
} from "@agenteschat/adapters/machine-protocol";
import { redactSecrets } from "@agenteschat/adapters/secret-box";
import { realFoldersFor } from "./access";
import type { AccountBrains } from "./account-brains";
import type { AccountFolders, AccountGrant, AccountManager } from "./accounts";
import { type BrainManager, brainKey } from "./brain";
import { type AntigravityBrainTurnRequest, handleAntigravityBrainTurn } from "./brain-antigravity";
import { type CodexBrainEvent, type CodexBrainTurnRequest, handleCodexBrainTurn } from "./brain-codex";
import type { CodexAppServers } from "./brain-codex-app";
import { type CursorBrainTurnRequest, handleCursorBrainTurn } from "./brain-cursor";
import { type GrokBrainTurnRequest, handleGrokBrainTurn } from "./brain-grok";
import { handleOpencodeBrainTurn, type OpencodeBrainTurnRequest } from "./brain-opencode";
import { routeWithPlan } from "./brain-route";
import { type BrowserManager, browserSetupText } from "./browser";
import type { BrowserViews } from "./browser-views";
import { allowedMerge, commandApproval, ownBranches } from "./command-gate";
import type { DesktopManager } from "./desktop";
import { type DesktopSessions, hostMemAvailable, MIN_FREE_BYTES } from "./desktop-session";
import { RunnerError, toMachineError } from "./errors";
import { runCommand } from "./exec";
import { type CacheFill, type CloneSlots, gitSync } from "./git";
import { isGitInternalPath, touchesGitInternals } from "./git-guard";
import { type McpTaskInfo, redactDeep } from "./mcp";
import { missionWorktree } from "./mission-worktree";
import { agentWorkspace, hiddenIn, isInside, resolveForAgent } from "./paths";
import type { PhoneManager, PhoneRequest } from "./phones";
import { pullFile } from "./pull";
import { type FetchLike, pushPath } from "./push";
import { openDesktopStream } from "./rfb";
import type { Spawn } from "./scope-gate";
import { agentSecrets, handleSecret, holdsSecretFile } from "./secrets";
import type { DataSockets } from "./streams";
import type { TaskManager } from "./tasks";
import type { Terminals } from "./terminal";
import { openExecKeys, parseExecVault, runnerVault, sealMadePassword } from "./vault";
import type { PairRequest } from "./wifi-pair";

/**
 * Requests one connection runs at once, whatever they are: a bound on a flood, far above what room allows
 * (a 32 GB computer takes about 48 coding turns, each with a tool call in flight).
 */
export const MAX_IN_FLIGHT = 128;
/**
 * Where the memory isn't known (not Linux): brain turns at once, the count the runner always had. Background
 * tasks keep their own count (`maxConcurrentTasks`): a mission item refused for room would sit in its queue,
 * which moves when a task ends or the computer comes back, never when room frees.
 */
export const TURNS_WITHOUT_MEMORY = 8;
/** What a coding CLI grows to once it runs (measured: about 0.6 GB). */
export const TURN_BYTES = 0.6e9;
/**
 * A locked-down turn (`permissions.mode` `chat`, the team's right hand) has no folders, no browser and no tools of its
 * own, so it is at most one CLI: it needs room for that and a margin, not `MIN_FREE_BYTES`. A person asks it what
 * filled the computer, so it runs while the rest waits, and only a computer about to run out turns it away.
 */
export const LOCKED_TURN_MIN_FREE_BYTES = TURN_BYTES + 0.3e9;
/** Where memory isn't known: how many locked-down turns may run past `TURNS_WITHOUT_MEMORY`. */
export const LOCKED_TURNS_PAST_COUNT = 2;
/**
 * The floor of the slot held for a person's turn (`personWaiting`): one turn and a margin, so a nearly dead computer
 * doesn't get worse. Agents' turns stop at `MIN_FREE_BYTES` and grow by `TURN_BYTES`, so a computer they filled sits
 * just above this: the slot is there whenever only their turns filled it. The margin is over a locked-down turn's
 * because this one has tools.
 */
export const PERSON_TURN_MIN_FREE_BYTES = TURN_BYTES + 0.4e9;
/** A CLI takes seconds to grow: a turn admitted this recently isn't in the memory reading yet, so it is counted. */
export const TURN_SETTLE_MS = 30_000;
/** How long a turn without room may wait while idle warm CLIs close for it, before `no_slot`. */
export const RECLAIM_MS = 5_000;
/**
 * Never refused for room nor at the ceiling: a brain turn holds its request for the whole turn, so a computer
 * full of agents' work would otherwise keep people from watching or taking control, or a person in control from
 * being screened (`desktop.text`). Short, and capped per agent on both sides.
 */
const PEOPLE_OPS: ReadonlySet<string> = new Set([
  "stream.open",
  "browser.view.open",
  "desktop.session.status",
  "desktop.session.stop",
  "desktop.text",
]);
export const MAX_LIST_ENTRIES = 5000;

/** Ops that start new work: refused while the owner paused the computer (protocol 9). Reads of status, output and cancel still go. */
export const NEW_WORK_OPS: ReadonlySet<string> = new Set([
  "exec",
  "read",
  "write",
  "list",
  "push",
  "pull",
  "task.start",
  "brain.turn",
  "brain.route",
  "git.sync",
  "browser.act",
  "browser.batch",
  "browser.capture",
  "browser.warm",
  "browser.stream.start",
  "desktop.session.start",
  "desktop.look",
  "desktop.act",
  "desktop.capture",
  "desktop.apps",
  "vault.key",
  "vault.password",
  "phone.claim",
  "phone.install",
  "phone.launch",
  "phone.flow",
  "phone.record",
  "phone.screenshot",
  "phone.logs",
]);

/**
 * System mode: where each op runs. `machine`: the root process answers it
 * (the computer's accounts and access settings; pause is checked there
 * before anything is routed). `agent`: the request's agent's worker, as that
 * agent's own OS user (`supervisor.ts`). Typed over every op, so a new op
 * doesn't compile until someone decides where it runs.
 */
export const OP_ROUTES: Readonly<Record<MachineOp, "machine" | "agent">> = {
  exec: "agent",
  read: "agent",
  write: "agent",
  list: "agent",
  push: "agent",
  pull: "agent",
  // Keys and staged boxes stay in the root supervisor until DB-committed activation.
  secret: "machine",
  account: "machine",
  "task.start": "agent",
  "task.status": "agent",
  "task.cancel": "agent",
  "task.output": "agent",
  "brain.turn": "agent",
  "brain.steer": "agent",
  // As the agent's own user: the account folder is lent to it, as for a turn.
  "brain.route": "agent",
  "git.sync": "agent",
  "mission.worktree": "agent",
  "access.request": "machine",
  "access.reduce": "machine",
  "browser.act": "agent",
  "browser.stop": "agent",
  "browser.stream.start": "agent",
  "browser.stream.stop": "agent",
  "browser.input": "agent",
  "browser.batch": "agent",
  "browser.capture": "agent",
  "browser.warm": "agent",
  // Root answers it, and refuses it (and every op with `profile`) in system mode until profiles have their own users.
  "browser.profile.delete": "machine",
  // Root's: a stream's data socket needs the machine token, which no worker holds, and a desktop's password file
  // must be one its agent can't rewrite.
  "desktop.session.start": "machine",
  "desktop.session.stop": "machine",
  "desktop.session.status": "machine",
  "stream.open": "machine",
  // The live view's data socket is the process's that holds the server connection (only it has the token).
  "browser.view.open": "machine",
  // The helper runs as the agent's own user, in its worker; the worker asks the supervisor for the desktop.
  "desktop.look": "agent",
  "desktop.act": "agent",
  "desktop.capture": "agent",
  "desktop.apps": "agent",
  "desktop.text": "agent",
  // ADR 0144: the key lives in the process that opens the values (the agent's worker), so root never holds one.
  "vault.key": "agent",
  // The password is made and sealed where the Vault's values open: root relays only the box.
  "vault.password": "agent",
  // The process that sees the phones and keeps their locks (a system-mode runner reaches none).
  "phone.claim": "machine",
  "phone.release": "machine",
  "phone.install": "machine",
  "phone.launch": "machine",
  "phone.flow": "machine",
  "phone.record": "machine",
  "phone.screenshot": "machine",
  "phone.logs": "machine",
  // adb's pairing keys are the person's, like its phones.
  "phone.pair.start": "machine",
  "phone.pair.code": "machine",
  "phone.pair.status": "machine",
  "phone.pair.cancel": "machine",
  // The computer's own pause lives in its config, root's.
  "pause.set": "machine",
  "phone.look": "machine",
  // The Mac's own pick of iPhones on its Wi-Fi, kept beside its phones' locks.
  "phone.wifi": "machine",
};

type AccessRequestOp = Extract<MachineRequest, { op: "access.request" }>;
type AccessReduceOp = Extract<MachineRequest, { op: "access.reduce" }>;

export interface HandlerContext {
  /** Real path of the workspace folder. */
  workspaceReal: string;
  /** `false`: commands off (`--no-exec`, or `access.tools.commands` off). */
  exec: boolean;
  /** The machine token (authenticates `push` uploads). */
  token: string;
  /** The server this computer is paired with: `push` uploads go there (`uploadUrl`). */
  server?: string;
  fetch?: FetchLike;
  /** Where each agent's secrets live (ADR 0027); without it the machine keeps none. */
  secretsDir?: string;
  /** Background tasks (protocol 4); without it the runner refuses `task.*`. */
  tasks?: TaskManager;
  /**
   * Protocol 11: where the agents' git proxy credentials are kept
   * (`<runner home>/git`, outside their folders); without it the runner
   * refuses `git.sync`.
   */
  gitDir?: string;
  /** Tests: the git command (default `git` on the PATH). */
  gitCommand?: string;
  /** `<runner home>/git-cache`: shared read-only mirrors for clones (ADR 0116); single-user runners only. */
  gitCache?: string;
  /** A system-mode worker: root's clone slots and shared cache (ADR 0116), so both are the computer's. */
  cloneSlot?: CloneSlots;
  cacheFill?: CacheFill;
  /** Brain turns (protocol 8); without it the runner refuses `brain.turn`. */
  brains?: BrainManager;
  /** System mode: the turns of Claude sign-ins several agents share, which never reach a worker. */
  accountBrains?: AccountBrains;
  /**
   * A brain turn found no room: closes one idle warm CLI on this computer (any agent's in system mode), least
   * recently used first, `spare` (the waiting turn's own session, `brainKey`) last, never one mid-turn or
   * holding the agent's work; false when none could close.
   */
  reclaimBrains?: (spare: string) => Promise<boolean>;
  /** Whether the session `spare` (`brainKey`) has an open CLI: a turn on it takes no new process's memory. */
  warmBrain?: (spare: string) => Promise<boolean>;
  /**
   * Codex brain turns (ADR 0032 block 6): the runner home (threads file,
   * scratch), how Codex starts our MCP server, and the live Codex runs the
   * MCP bridge looks up by run id (`agentes-runner mcp --run <runId>`), or
   * by app-server process.
   */
  codex?: {
    runnerHome: string;
    mcp?: { socketPath: string; command: string[] };
    runs: Map<string, McpTaskInfo>;
    /** Protocol 15: long-lived `codex app-server`s (turns take messages mid-turn); without it, `codex exec`. */
    app?: CodexAppServers;
    /**
     * System mode, in a worker: the account folders lent to this agent (`accounts` is root's), and its own folder
     * for an account root keeps (`agentHome`, protocol 29).
     */
    accounts?: AccountFolders;
    /** How `codex exec` starts (a worker under systemd: in the agent's AI CLIs slice, `scope-gate.ts`). */
    spawn?: Spawn;
  };
  /** Protocol 9: whether the owner paused this computer (new work is refused with `paused`). */
  paused?: () => boolean;
  /** `REMOTE_PAUSE_PROTOCOL`: pause (`until` null: until resumed) or resume as asked from the apps; absent: refused. */
  setPause?: (paused: boolean, until: string | null, by: string) => RunnerPause;
  /** System mode: this process is root and answers only the `machine` ops of `OP_ROUTES` itself. */
  systemMode?: () => boolean;
  /** System mode: runs an `agent` op in its agent's worker; without it those ops are refused. */
  workers?: {
    run(req: MachineRequest, scope: RequestScope): Promise<unknown>;
    secret?(req: Extract<MachineRequest, { op: "secret" }>, scope: RequestScope): Promise<unknown>;
  };
  /**
   * Protocol 10: what the machine allows. With it, absolute paths inside the
   * agent's allowed folders are accepted and each tool needs to be on;
   * without it, commands, Claude Code and Codex follow `exec` as before.
   */
  access?: () => RunnerAccess;
  /** Protocol 10: `access.request` and `access.reduce` (the daemon keeps the requests and the config). */
  accessOps?: {
    request(agent: AgentScope, req: AccessRequestOp): Promise<MachineReplies["access.request"]>;
    reduce(req: AccessReduceOp): Promise<MachineReplies["access.reduce"]>;
  };
  /** Set per request (protocol 10): the folders allowed for the request's agent, as real paths. */
  grants?: string[];
  /** A worker (system mode): its agent's home, as a real path. */
  ownHome?: string;
  /** Protocol 12: the agents' browsers (ADR 0040); without it the runner refuses `browser.*`. */
  browser?: BrowserManager;
  /** Protocol 13: the computer brains' accounts (ADR 0041); without it the runner refuses `account`. */
  accounts?: AccountManager;
  /** Set per request in a worker (protocol 29): what root handed this turn for its account (`AccountManager.grant`). */
  grant?: AccountGrant;
  /** Protocol 18: the agents' desktops (ADR 0058); without it the runner refuses `desktop.session.*`. */
  desktops?: DesktopSessions;
  /** Protocol 18: terminals people open as an agent; without it the runner refuses terminal streams. */
  terminals?: Terminals;
  /** Protocol 18: where `stream.open` dials its data socket; without it the runner refuses streams. */
  streams?: DataSockets;
  /** Protocol 49: the live views of the agents' browsers (`browser.view.open`, ADR 0040 §7.1). */
  browserViews?: BrowserViews;
  /** Protocol 21: the agents' use of their own desktops (ADR 0062); without it the runner refuses `desktop.look`… */
  desktopUse?: DesktopManager;
  /** A person takes control of the agent's desktop: what the agent's pointer and keys are doing stops. */
  desktopTaken?: (agentId: string) => void;
  /** The phones this computer reaches (`PHONES_PROTOCOL`); without it every phone op answers `phone_missing`. */
  phones?: PhoneManager;
}

export interface RequestScope {
  signal: AbortSignal;
  /** Sends an `output` frame (exec with `stream: true`). */
  output: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Sends any frame while the request runs (`brain.event`, `brain.done`). */
  emit?: (frame: RunnerFrame) => void;
}

const clampInt = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(min, Math.min(max, v));
};

const requireString = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw new RunnerError("bad_request", `${field} must be a string`);
  return v;
};

type Secrets = Awaited<ReturnType<typeof agentSecrets>>;

const TOOL_LABEL: Record<keyof RunnerTools, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok Build",
  antigravity: "Antigravity CLI",
  commands: "Commands",
  browser: "Browser",
  desktop: "The desktop",
  terminal: "The terminal",
};

/** Whether a tool is on: from the machine's access (protocol 10), or `exec` for a runner without it. */
export function toolOn(ctx: Pick<HandlerContext, "access" | "exec">, tool: keyof RunnerTools): boolean {
  return ctx.access ? ctx.access().tools[tool] === true : ctx.exec;
}

function requireTool(ctx: HandlerContext, tool: keyof RunnerTools) {
  if (toolOn(ctx, tool)) return;
  if (!ctx.access) {
    throw new RunnerError(
      "exec_disabled",
      "Commands are turned off on this computer (the runner was paired with --no-exec)",
    );
  }
  const how = `its owner can turn it on in the agentes app (Preferences > Tools) or with agentes-runner tools enable ${tool}`;
  if (tool === "commands") throw new RunnerError("exec_disabled", `Commands are turned off on this computer (${how})`);
  throw new RunnerError("not_allowed", `${TOOL_LABEL[tool]} is turned off on this computer (${how})`);
}

const resolvePath = (ctx: HandlerContext, input: string) =>
  resolveForAgent(ctx.workspaceReal, ctx.grants, input, ctx.ownHome ? { path: ctx.ownHome, reads: false } : undefined);

/**
 * A path to read or send out. While commands are on the agent's home counts as its own: its user reads it anyway, so
 * this is no wider a reach. The worker runs as that user, so a link swapped in after the check opens nothing a command
 * of the agent couldn't.
 */
const resolveToRead = (ctx: HandlerContext, input: string) =>
  resolveForAgent(
    ctx.workspaceReal,
    ctx.grants,
    input,
    ctx.ownHome ? { path: ctx.ownHome, reads: toolOn(ctx, "commands") } : undefined,
  );

async function doExec(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "exec" }>,
  scope: RequestScope,
  secrets: Secrets,
) {
  requireTool(ctx, "commands");
  const command = requireString(req.command, "command");
  let cwd = ctx.workspaceReal;
  if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolvePath(ctx, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    if (!(await stat(resolved.abs)).isDirectory()) throw new RunnerError("bad_request", `${req.cwd} is not a folder`);
    cwd = resolved.abs;
  }
  // ADR 0144: Vault keys for this one command, checked whole before anything opens.
  const sealed = req.vault === undefined ? null : parseExecVault(req.vault);
  if (sealed && !req.agent?.id) throw new RunnerError("bad_request", "Vault keys belong to an agent's command");
  // run_code and skill scripts: the command and the script it runs meet the command policy first, as the
  // brain's own commands do (ADR 0053 §3). A person's approval of this very command lets it through, unless
  // our git proxy would refuse it anyway (`never`).
  const held = await commandApproval(command, { cwd, own: ownBranches(req.agent), how: ASK_AGAIN, script: true });
  if (held?.never) throw new RunnerError("not_allowed", held.message);
  const merge =
    held && req.approved !== true ? await allowedMerge(command, { cwd, repos: req.mergeRepos ?? [] }) : null;
  if (held && req.approved !== true && !merge) throw new RunnerError("approval_needed", held.message);
  let env = secrets?.env;
  let redact = secrets;
  if (sealed && req.agent) {
    // Opened in this process's memory, given to this command's environment only, and redacted from its output
    // (and for 10 minutes from what else the agent's work sends out: they are armed).
    const keys = await openExecKeys(runnerVault, String(req.agent.id), sealed);
    env = { ...(env ?? {}), ...Object.fromEntries(keys.map((k) => [k.name, k.value])) };
    redact = await agentSecrets(ctx.secretsDir, req.agent);
  }
  const result = await runCommand({
    command,
    cwd,
    timeoutSeconds: clampInt(req.timeoutSeconds, 1, 24 * 3600, 60),
    signal: scope.signal,
    onOutput: req.stream === true ? scope.output : undefined,
    ...(env ? { env } : {}),
    ...(redact ? { redact: redact.redact, redactHold: redact.hold } : {}),
  });
  return merge ? { ...result, merge } : result;
}

/**
 * A file that holds a secret is only for programs on this machine, never sent out (nor a folder that holds it), and
 * so is an agent browser's profile, its logins: a folder that holds one goes without it (`zipFolder`).
 */
async function refuseSecretFile(ctx: HandlerContext, secrets: Secrets, requested: string) {
  const target = await resolveToRead(ctx, requested);
  if (inBrowserProfile(target.abs)) {
    throw new RunnerError("bad_request", `${requested} holds your browser's logins. It stays on this computer.`);
  }
  if (secrets && (await holdsSecretFile(ctx.workspaceReal, secrets.files, target.abs))) {
    throw new RunnerError("bad_request", `${requested} holds a secret. It stays on this computer.`);
  }
}

async function doRead(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "read" }>,
  secrets: Secrets,
): Promise<MachineReplies["read"]> {
  const target = await resolveToRead(ctx, requireString(req.path, "path"));
  if (!target.exists) return { base64: null, size: 0 };
  const st = await stat(target.abs);
  if (st.isDirectory()) throw new RunnerError("bad_request", `${req.path} is a folder`);
  if (!st.isFile()) throw new RunnerError("bad_request", `${req.path} is not a regular file`);
  const limit = Math.min(
    clampInt(req.maxBytes, 0, MAX_INLINE_FILE_BYTES, MAX_INLINE_FILE_BYTES),
    MAX_INLINE_FILE_BYTES,
  );
  if (st.size > limit) throw new RunnerError("too_large", `The file has ${st.size} bytes (max ${limit})`);
  const data = await readFile(target.abs);
  if (data.byteLength > limit) throw new RunnerError("too_large", `The file is larger than ${limit} bytes`);
  // A file a command wrote a value into (`env > dump.txt`) goes back to the model like command output: redacted.
  if (secrets) {
    const text = data.toString("utf8");
    const clean = secrets.redact(text);
    if (clean !== text) return { base64: Buffer.from(clean).toString("base64"), size: Buffer.byteLength(clean) };
  }
  return { base64: data.toString("base64"), size: data.byteLength };
}

/** Where a file op may put `requested`, its parent folders made. */
async function writeTarget(ctx: HandlerContext, requested: string) {
  // A repository's git dir is the runner's own git's settings (`git.sync`, `mission.worktree` run
  // without the "commands" switch): never written by a file op (`git-guard.ts`).
  const gitInternal = () =>
    new RunnerError("bad_request", `${requested} is inside a .git folder. Files there can't be written this way.`);
  if (isGitInternalPath(requested)) throw gitInternal();
  const first = await resolvePath(ctx, requested);
  if (first.rel === "") throw new RunnerError("bad_request", "Can't write over the workspace folder");
  if (touchesGitInternals(requested, first.abs)) throw gitInternal();
  if (!first.exists) await mkdir(path.dirname(first.abs), { recursive: true });
  // Check again now that the parents exist (nothing raced us outside).
  const target = await resolvePath(ctx, requested);
  if (touchesGitInternals(requested, target.abs)) throw gitInternal();
  if (target.exists && (await stat(target.abs)).isDirectory()) {
    throw new RunnerError("bad_request", `${requested} is a folder`);
  }
  return target;
}

async function doWrite(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "write" }>,
): Promise<MachineReplies["write"]> {
  const base64 = requireString(req.base64, "base64");
  if (Math.floor((base64.length * 3) / 4) > MAX_INLINE_FILE_BYTES + 3) {
    throw new RunnerError("too_large", `Files sent inline are limited to ${MAX_INLINE_FILE_BYTES} bytes`);
  }
  const data = Buffer.from(base64, "base64");
  if (data.byteLength > MAX_INLINE_FILE_BYTES) {
    throw new RunnerError("too_large", `Files sent inline are limited to ${MAX_INLINE_FILE_BYTES} bytes`);
  }
  const target = await writeTarget(ctx, requireString(req.path, "path"));
  await writeFile(target.abs, data);
  return { size: data.byteLength };
}

async function doList(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "list" }>,
): Promise<MachineReplies["list"]> {
  const target = await resolveToRead(ctx, typeof req.path === "string" ? req.path : "");
  if (!target.exists) return { entries: [] };
  const root = target.root ?? ctx.workspaceReal;
  const st = await stat(target.abs);
  if (!st.isDirectory()) return { entries: [{ path: target.rel, isDir: false, size: st.size }] };
  const depth = clampInt(req.depth, 1, 5, 1);
  const entries: FileEntry[] = [];
  const walk = async (abs: string, rel: string, level: number) => {
    let items: Dirent[];
    try {
      items = await readdir(abs, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip it
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const childAbs = path.join(abs, item.name);
      if (target.inHome && hiddenIn(root, childAbs)) continue;
      const childRel = rel ? `${rel.replace(/\/+$/, "")}/${item.name}` : item.name;
      let isDir = item.isDirectory();
      let size = 0;
      let descend = isDir;
      try {
        if (item.isSymbolicLink()) {
          const real = await realpath(childAbs);
          if (!isInside(root, real)) continue; // leaves the workspace (or the allowed folder)
          if (target.inHome && hiddenIn(root, real)) continue;
          const s = await stat(real);
          isDir = s.isDirectory();
          size = isDir ? 0 : s.size;
          descend = false; // never follow links while walking (no loops)
        } else if (!isDir) {
          size = (await lstat(childAbs)).size;
        }
      } catch {
        continue; // dangling link or vanished file
      }
      entries.push({ path: childRel, isDir, size });
      if (descend && level < depth) await walk(childAbs, childRel, level + 1);
    }
  };
  await walk(target.abs, target.rel, 1);
  return { entries };
}

export const PAUSED = "The owner paused this computer. Nothing new starts here until it's resumed.";

/** Protocol 18: a stream that is new work (control of a desktop, a terminal); watching one that runs isn't. */
const workStream = (req: MachineRequest) =>
  req.op === "stream.open" && (req.kind === "terminal" || req.mode === "control");

/**
 * Runs one request; throws RunnerError (or fs errors) on failure. An error's text leaves redacted like an answer
 * (ADR 0144): a page's error can quote what was just typed.
 */
export async function handleRequest(ctx: HandlerContext, req: MachineRequest, scope: RequestScope): Promise<unknown> {
  try {
    return await routeRequest(ctx, req, scope);
  } catch (err) {
    throw await scrubbed(ctx, req, err);
  }
}

/** The error with every secret value of the request's agent (and of its browser profile's session) redacted. */
async function scrubbed(ctx: HandlerContext, req: MachineRequest, err: unknown): Promise<unknown> {
  const own = await agentSecrets(ctx.secretsDir, req.agent).catch(() => null);
  const profileId = req.profile?.id;
  const profile = typeof profileId === "string" ? runnerVault.armedOf(profileKey(profileId)) : [];
  if (!own && profile.length === 0) return err;
  const { code, message } = toMachineError(err);
  const clean = redactSecrets(own ? own.redact(message) : message, profile);
  return clean === message ? err : new RunnerError(code, clean);
}

async function routeRequest(ctx: HandlerContext, req: MachineRequest, scope: RequestScope): Promise<unknown> {
  // Protocol 9: paused by the owner. What already runs finishes; status, output and cancel still answer.
  if ((NEW_WORK_OPS.has(req.op) || workStream(req)) && ctx.paused?.()) throw new RunnerError("paused", PAUSED);
  if (req.op === "pause.set") {
    if (!ctx.setPause) throw new RunnerError("unsupported", "This runner can't be paused from the apps.");
    const by = requireString(req.by, "by");
    const until = req.paused && typeof req.until === "string" ? req.until : null;
    return { paused: ctx.setPause(req.paused === true, until, by) } satisfies MachineReplies["pause.set"];
  }
  // Protocol 49: an agent's (or a profile's) live view socket, this process's in every mode (ADR 0040 §7.1).
  if (req.op === "browser.view.open") return openBrowserView(ctx, req);
  // Protocol 34: a browser profile's session, never an agent's worker or folder (ADR 0110).
  if (req.profile || req.op === "browser.profile.delete") return handleProfileBrowser(ctx, req, scope);
  if (ctx.systemMode?.() && OP_ROUTES[req.op] !== "machine") {
    if (!ctx.workers) {
      throw new RunnerError(
        "not_allowed",
        "This computer runs each agent as its own user, and its runner can't do that yet. Update the runner on this computer.",
      );
    }
    // An op this runner doesn't know (`OP_ROUTES` has no row) goes nowhere.
    if (OP_ROUTES[req.op] !== "agent") throw new RunnerError("bad_request", `Unknown op ${String(req.op)}`);
    const hosted = ctx.accountBrains;
    if (hosted?.takes(req)) return doHostedTurn(ctx, hosted, req, scope);
    if (req.op === "brain.steer" && hosted?.brains.hosts(String(req.runId))) {
      return doBrainSteer({ ...ctx, brains: hosted.brains }, req);
    }
    if (hosted?.onSharedLogin(req) && req.agent) {
      const { agent } = req;
      if (req.op === "brain.route") {
        requireTool(ctx, "claude");
        return hosted.route(req, agent, scope);
      }
      if (req.op === "task.start") {
        const { workers } = ctx;
        return hosted.startTask(
          req,
          agent,
          () => workers.run(req, scope),
          (final) => signedOut(ctx, req, final),
        );
      }
    }
    const out = await ctx.workers.run(req, scope);
    // The account's folder is root's to mark: what the worker's turn found out is told here.
    if (req.op === "brain.turn") signedOut(ctx, req, (out as Partial<MachineReplies["brain.turn"]> | null)?.final);
    return out;
  }
  if (req.op === "access.request" || req.op === "access.reduce") return handleAccess(ctx, req);
  // Protocol 13: accounts belong to the machine, not to an agent.
  if (req.op === "account") return handleAccount(ctx, req);
  // Protocol 15: messages for a turn already running (never new work: a paused computer still takes them).
  if (req.op === "brain.steer") return doBrainSteer(ctx, req);
  if (req.op === "desktop.session.start" || req.op === "desktop.session.stop" || req.op === "desktop.session.status") {
    return handleDesktop(ctx, req);
  }
  if (req.op === "stream.open") return handleStream(ctx, req, scope);
  if (req.op === "secret" && ctx.systemMode?.()) {
    if (!ctx.workers?.secret) throw new RunnerError("not_allowed", "The root secret broker is unavailable");
    return ctx.workers.secret(req, scope);
  }
  // Protocol 45 (ADR 0144): a one-use key in this process's memory (the agent's worker in system mode).
  if (req.op === "vault.key") {
    const agentId = req.agent?.id;
    if (typeof agentId !== "string" || !agentId) {
      throw new RunnerError("bad_request", "A Vault key belongs to an agent");
    }
    return { vaultKey: await runnerVault.issueKey(agentId) } satisfies MachineReplies["vault.key"];
  }
  if (req.op === "vault.password") {
    return { box: await sealMadePassword(req, req.agent?.id) } satisfies MachineReplies["vault.password"];
  }
  // Protocol 10: the folders this agent may use besides its own.
  if (ctx.access && req.agent) ctx = { ...ctx, grants: await realFoldersFor(ctx.access(), String(req.agent.id)) };
  if (req.op === "task.start" || req.op === "task.status" || req.op === "task.cancel" || req.op === "task.output") {
    return handleTask(ctx, req);
  }
  if (isPairOp(req)) {
    if (!ctx.phones) throw new RunnerError("phone_missing", "This computer doesn't reach phones.");
    return ctx.phones.pair(req);
  }
  if (req.op === "phone.look") return { looking: ctx.phones?.look() ?? false } satisfies MachineReplies["phone.look"];
  if (req.op === "phone.wifi")
    return ctx.phones ? ctx.phones.wifi(req) : ({ available: [] } satisfies MachineReplies["phone.wifi"]);
  if (isPhoneOp(req)) return handlePhone(ctx, req, scope);
  // Each agent works in its own folder: that folder is its workspace.
  if (req.agent) ctx = { ...ctx, workspaceReal: await agentWorkspace(ctx.workspaceReal, req.agent) };
  if (req.op === "secret") {
    if (!ctx.secretsDir) throw new RunnerError("bad_request", "This runner keeps no secrets");
    return handleSecret(ctx.secretsDir, req.agent, ctx.workspaceReal, req);
  }
  if (
    req.op === "browser.act" ||
    req.op === "browser.batch" ||
    req.op === "browser.capture" ||
    req.op === "browser.warm" ||
    req.op === "browser.stop" ||
    req.op === "browser.stream.start" ||
    req.op === "browser.stream.stop" ||
    req.op === "browser.input"
  ) {
    return handleBrowser(ctx, req, scope);
  }
  if (
    req.op === "desktop.look" ||
    req.op === "desktop.act" ||
    req.op === "desktop.capture" ||
    req.op === "desktop.apps" ||
    req.op === "desktop.text"
  ) {
    return handleDesktopUse(ctx, req);
  }
  const secrets = await agentSecrets(ctx.secretsDir, req.agent);
  switch (req.op) {
    case "brain.turn":
      return doBrainTurn(ctx, req, scope, secrets);
    case "brain.route":
      // Never the agent's secrets: the route reads other people's messages.
      requireTool(ctx, req.kind === "codex" ? "codex" : "claude");
      if (!req.agent) throw new RunnerError("bad_request", "A route runs for an agent");
      return routeWithPlan(req, {
        accounts: ctx.accounts ?? ctx.codex?.accounts,
        ...(ctx.grant ? { grant: ctx.grant } : {}),
        brains: ctx.brains,
        codexApp: ctx.codex?.app,
        tasks: ctx.tasks,
        signal: scope.signal,
      });
    case "git.sync":
      // The runner's own git in the agent's folder (not the agent's shell): no "commands" switch needed,
      // so it never runs with a program the repository's config names (`git-guard.ts`).
      if (!req.agent) throw new RunnerError("bad_request", "A git sync belongs to an agent");
      if (!ctx.gitDir) throw new RunnerError("bad_request", "This runner keeps no git credentials");
      return gitSync(
        {
          folder: ctx.workspaceReal,
          gitDir: ctx.gitDir,
          agent: req.agent,
          signal: scope.signal,
          ...(req.stream === true ? { output: scope.output } : {}),
          ...(ctx.gitCommand ? { gitCommand: ctx.gitCommand } : {}),
          ...(ctx.gitCache ? { gitCache: ctx.gitCache } : {}),
          ...(ctx.cloneSlot ? { cloneSlot: ctx.cloneSlot } : {}),
          ...(ctx.cacheFill ? { cacheFill: ctx.cacheFill } : {}),
        },
        req,
      );
    case "mission.worktree":
      // The runner's own git in the agent's folder (like `git.sync`). Making a folder is new work; removing one isn't.
      if (!req.agent) throw new RunnerError("bad_request", "A mission's folder belongs to an agent");
      if (req.action === "ensure" && ctx.paused?.()) {
        throw new RunnerError("paused", PAUSED);
      }
      return missionWorktree(ctx.workspaceReal, req);
    case "exec":
      return doExec(ctx, req, scope, secrets);
    case "read":
      await refuseSecretFile(ctx, secrets, requireString(req.path, "path"));
      return doRead(ctx, req, secrets);
    case "write":
      return doWrite(ctx, req);
    case "list":
      return doList(ctx, req);
    case "push":
      await refuseSecretFile(ctx, secrets, requireString(req.path, "path"));
      return pushPath({
        workspaceReal: ctx.workspaceReal,
        token: ctx.token,
        ...(ctx.server ? { server: ctx.server } : {}),
        path: requireString(req.path, "path"),
        url: requireString(req.url, "url"),
        uploadId: requireString(req.uploadId, "uploadId"),
        maxBytes: clampInt(req.maxBytes, 0, Number.MAX_SAFE_INTEGER, 0),
        fetch: ctx.fetch,
        signal: scope.signal,
        resolve: (p) => resolveToRead(ctx, p),
      });
    case "pull":
      return pullFile({
        abs: (await writeTarget(ctx, requireString(req.path, "path"))).abs,
        token: ctx.token,
        ...(ctx.server ? { server: ctx.server } : {}),
        url: requireString(req.url, "url"),
        pullId: requireString(req.pullId, "pullId"),
        size: clampInt(req.size, 0, Number.MAX_SAFE_INTEGER, 0),
        ...(typeof req.sha256 === "string" ? { sha256: req.sha256 } : {}),
        fetch: ctx.fetch,
        signal: scope.signal,
      });
    default:
      throw new RunnerError("bad_request", `Unknown op ${(req as { op: string }).op}`);
  }
}

const isPhoneOp = (req: MachineRequest): req is PhoneRequest => req.op.startsWith("phone.");
const isPairOp = (req: MachineRequest): req is PairRequest => req.op.startsWith("phone.pair.");

/**
 * `PHONES_PROTOCOL`: the phone ops. They run with the computer's commands off (sharing a phone grants only these);
 * the files they make and take are the agent's: its folder and the folders it may use.
 */
async function handlePhone(ctx: HandlerContext, req: PhoneRequest, scope: RequestScope) {
  const phones = ctx.phones;
  if (!phones) throw new RunnerError("phone_missing", "This computer doesn't reach phones.");
  const folder = req.agent ? await agentWorkspace(ctx.workspaceReal, req.agent) : null;
  return phones.handle(req, {
    folder,
    resolve: async (input) => {
      if (!folder) throw new RunnerError("bad_request", "A phone's files come from an agent's folder");
      const target = await resolveToRead({ ...ctx, workspaceReal: folder }, input);
      if (!target.exists) throw new RunnerError("not_found", `${input} doesn't exist`);
      return target.abs;
    },
    signal: scope.signal,
  });
}

/**
 * Protocol 18: the agent's desktop (ADR 0058). Starting it needs the
 * machine's desktop switch; stopping it and asking about it always go.
 */
function handleDesktop(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "desktop.session.start" | "desktop.session.stop" | "desktop.session.status" }>,
) {
  const desktops = ctx.desktops;
  if (!desktops) throw new RunnerError("desktop_unavailable", "This runner runs no desktops");
  if (!req.agent) throw new RunnerError("bad_request", "A desktop belongs to an agent");
  switch (req.op) {
    case "desktop.session.stop":
      return desktops.stop(req.agent);
    case "desktop.session.status": {
      const status = desktops.status(req.agent);
      return { ...status, streams: status.streams + (ctx.terminals?.count(req.agent.id) ?? 0) };
    }
    case "desktop.session.start":
      requireTool(ctx, "desktop");
      return desktops.ensure(req.agent);
  }
}

/**
 * Protocol 21: the agent uses its own desktop (ADR 0062). That runs commands
 * as the agent (its desktop has a terminal), so it needs the machine's
 * desktop switch and its commands switch. Protocol 25's `desktop.text` goes
 * through the same helper, behind the same switches.
 */
function handleDesktopUse(
  ctx: HandlerContext,
  req: Extract<
    MachineRequest,
    { op: "desktop.look" | "desktop.act" | "desktop.capture" | "desktop.apps" | "desktop.text" }
  >,
) {
  const desktop = ctx.desktopUse;
  if (!desktop) throw new RunnerError("desktop_unavailable", "This runner doesn't serve desktop use");
  if (!req.agent) throw new RunnerError("bad_request", "A desktop belongs to an agent");
  requireTool(ctx, "desktop");
  requireTool(ctx, "commands");
  switch (req.op) {
    case "desktop.look":
      return desktop.look(req.agent);
    case "desktop.act":
      return desktop.act(req.agent, req.action, req.settle === true, { folder: ctx.workspaceReal, grants: ctx.grants });
    case "desktop.capture":
      return desktop.capture(req.agent, req.region);
    case "desktop.apps":
      return desktop.apps(req.agent);
    case "desktop.text":
      return desktop.text(req.agent);
  }
}

/**
 * Protocol 18: one viewer of the agent's desktop or one terminal as the agent
 * (ADR 0058 §11), each behind its machine switch; answered once its data
 * socket got `stream.ready`, while the bytes go on flowing over it.
 */
async function handleStream(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "stream.open" }>,
  scope: RequestScope,
): Promise<MachineReplies["stream.open"]> {
  const { agent, streamId } = req;
  const streams = ctx.streams;
  if (!isStreamId(streamId)) throw new RunnerError("bad_request", "A stream needs its id");
  if (!streams) throw new RunnerError("bad_request", "This runner opens no streams");
  const dial = () => streams.dial(streamId, req.kind, scope.signal);
  // A phone's screen (bring your own devices) is no agent's: it goes with the phone, commands on or off.
  if (req.kind === "phone") {
    if (!ctx.phones) throw new RunnerError("phone_missing", "This computer doesn't reach phones.");
    await ctx.phones.view(req.phone, req.mode, dial);
    return { opened: true };
  }
  if (!agent) throw new RunnerError("bad_request", "A stream needs an agent");
  if (req.kind === "desktop") {
    requireTool(ctx, "desktop");
    if (!ctx.desktops) throw new RunnerError("desktop_unavailable", "This runner runs no desktops");
    if (req.mode !== "watch" && req.mode !== "control") throw new RunnerError("bad_request", "watch or control");
    // One that isn't running starts when the server says so, and stays on; never on a paused computer.
    if (req.start === true && !ctx.desktops.status(agent).running) {
      if (ctx.paused?.()) throw new RunnerError("paused", PAUSED);
      await ctx.desktops.ensure(agent);
    }
    if (req.mode === "control") ctx.desktopTaken?.(agent.id);
    // A switch to control in place (protocol 30) is new work too, as a control stream's open is.
    await openDesktopStream(ctx.desktops, agent, req.mode, dial, (mode) => {
      requireTool(ctx, "desktop");
      if (mode !== "control") return;
      if (ctx.paused?.()) throw new RunnerError("paused", PAUSED);
      ctx.desktopTaken?.(agent.id);
    });
  } else if (req.kind === "terminal") {
    requireTool(ctx, "terminal");
    if (!ctx.terminals) throw new RunnerError("terminal_unavailable", "This runner opens no terminals");
    if (!isTerminalSize(req.cols, req.rows))
      throw new RunnerError("bad_request", "The terminal's size is out of bounds");
    await ctx.terminals.open(agent, { cols: req.cols, rows: req.rows }, dial);
  } else {
    throw new RunnerError("bad_request", "A stream shows a desktop, a terminal or a phone");
  }
  return { opened: true };
}

/** Protocol 18: the agent's Chrome goes on its desktop only while the machine's desktop switch is on too. */
const onDesktop = (ctx: HandlerContext, req: { desktop?: unknown }) => req.desktop === true && toolOn(ctx, "desktop");

/**
 * Protocol 12: the agent's browser (ADR 0040); `browser.batch` and
 * `browser.capture` from protocol 17 (ADR 0054), `browser.warm` from 27.
 * Needs the machine's browser switch on; stopping (the browser, its live view)
 * always goes, so Stop works even after the switch went off.
 */
async function handleBrowser(
  ctx: HandlerContext,
  req: Extract<
    MachineRequest,
    {
      op:
        | "browser.act"
        | "browser.batch"
        | "browser.capture"
        | "browser.warm"
        | "browser.stop"
        | "browser.stream.start"
        | "browser.stream.stop"
        | "browser.input";
    }
  >,
  scope: RequestScope,
) {
  const browser = ctx.browser;
  if (!browser) throw new RunnerError("browser_unavailable", "This runner has no agent browser");
  if (!req.agent) throw new RunnerError("bad_request", "A browser belongs to an agent");
  switch (req.op) {
    case "browser.stop":
      return browser.stop(req.agent);
    case "browser.stream.stop":
      return browser.streamStop(req.agent);
    case "browser.act":
      requireTool(ctx, "browser");
      return redacted(
        ctx,
        req.agent,
        await browser.act(req.agent, ctx.workspaceReal, { ...req, desktop: onDesktop(ctx, req) }, scope.signal),
      );
    case "browser.batch":
      requireTool(ctx, "browser");
      return redacted(
        ctx,
        req.agent,
        await browser.batch(req.agent, ctx.workspaceReal, { ...req, desktop: onDesktop(ctx, req) }, scope.signal),
      );
    case "browser.capture": {
      requireTool(ctx, "browser");
      const shot = await browser.capture(req.agent, ctx.workspaceReal, req.allowedDomains, scope.signal);
      // The page's address, redacted like any answer (ADR 0144); never the image's bytes, which a value could match.
      if (!shot.url) return shot;
      return { ...shot, url: await redacted(ctx, req.agent, shot.url) };
    }
    case "browser.warm":
      requireTool(ctx, "browser");
      return browser.warm(req.agent, ctx.workspaceReal, onDesktop(ctx, req));
    case "browser.stream.start":
      requireTool(ctx, "browser");
      return browser.streamStart(req.agent, req.mode);
    case "browser.input":
      requireTool(ctx, "browser");
      return browser.input(req.agent, Array.isArray(req.events) ? req.events : []);
  }
}

/** A browser answer (a snapshot, a page's text, a code field just typed into) with the agent's secrets redacted. */
async function redacted<T>(ctx: HandlerContext, agent: AgentScope, reply: T): Promise<T> {
  const secrets = await agentSecrets(ctx.secretsDir, agent);
  return secrets ? (redactDeep(reply, secrets.redact) as T) : reply;
}

/** A browser profile's session key (ADR 0110), where what is typed in it is armed too (ADR 0144). */
const profileKey = (id: string) => `profile:${id.toLowerCase()}`;

/**
 * A profile session's answer (ADR 0110), redacted like an agent's (ADR 0144): the acting agent's secrets and every
 * value typed in that session, whoever typed it.
 */
async function profileRedacted<T>(ctx: HandlerContext, actor: AgentScope, session: AgentScope, reply: T): Promise<T> {
  const own = actor.id === session.id ? null : await agentSecrets(ctx.secretsDir, actor);
  const typed = runnerVault.armedOf(session.id);
  if (!own && typed.length === 0) return reply;
  return redactDeep(reply, (text) => redactSecrets(own ? own.redact(text) : text, typed)) as T;
}

export const PROFILES_SYSTEM_MODE =
  "Browser profiles don't work yet on a computer where each agent runs as its own user (system mode).";
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `browser.view.open` (protocol 49): the data socket of an agent's live view, or a browser profile's (its frames
 * carry `profile:<id>` where an agent's id would be). Dialed here, whichever process runs that browser: in system
 * mode root's, which passes the worker's frames on to it.
 */
async function openBrowserView(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "browser.view.open" }>,
): Promise<MachineReplies["browser.view.open"]> {
  if (!ctx.browserViews) throw new RunnerError("browser_unavailable", "This runner has no live view for browsers");
  requireTool(ctx, "browser");
  const profileId = req.profile?.id;
  if (profileId !== undefined && (typeof profileId !== "string" || !PROFILE_ID.test(profileId))) {
    throw new RunnerError("bad_request", "Which browser profile?");
  }
  const key = typeof profileId === "string" ? profileKey(profileId) : String(req.agent?.id ?? "");
  if (!key || !isStreamId(req.streamId)) throw new RunnerError("bad_request", "A live view needs an agent and its id");
  return ctx.browserViews.open(key, req.streamId);
}

/**
 * Protocol 34 (ADR 0110): a `browser.*` op in a browser profile's session. The session is keyed by the profile
 * (`profile:<id>`), its folder is under the runner's home, and its Chrome is always headless; `agent` only says who
 * acts. Single mode only: in system mode a profile needs an OS user of its own (phase 2), so it is refused.
 */
async function handleProfileBrowser(ctx: HandlerContext, req: MachineRequest, scope: RequestScope) {
  if (ctx.systemMode?.()) throw new RunnerError("not_allowed", PROFILES_SYSTEM_MODE);
  const browser = ctx.browser;
  if (!browser) throw new RunnerError("browser_unavailable", "This runner has no agent browser");
  const id = req.profile?.id;
  if (typeof id !== "string" || !PROFILE_ID.test(id)) throw new RunnerError("bad_request", "Which browser profile?");
  const agent: AgentScope = {
    id: profileKey(id),
    handle: req.agent?.handle ?? "profile",
    ...(req.agent?.name ? { name: req.agent.name } : {}),
  };
  // The agent whose turn it is: its Vault keys open here (ADR 0144); the session isn't its own.
  const actor: AgentScope = req.agent && typeof req.agent.id === "string" && req.agent.id ? req.agent : agent;
  const folder = browser.profileFolder(id.toLowerCase());
  switch (req.op) {
    case "browser.profile.delete":
      return browser.deleteProfile(agent, folder);
    case "browser.stop":
      return browser.stop(agent);
    case "browser.stream.stop":
      return browser.streamStop(agent);
    case "browser.act":
      requireTool(ctx, "browser");
      return profileRedacted(
        ctx,
        actor,
        agent,
        await browser.act(agent, folder, { ...req, desktop: false }, scope.signal, actor),
      );
    case "browser.batch":
      requireTool(ctx, "browser");
      return profileRedacted(
        ctx,
        actor,
        agent,
        await browser.batch(agent, folder, { ...req, desktop: false }, scope.signal, actor),
      );
    case "browser.capture": {
      requireTool(ctx, "browser");
      const shot = await browser.capture(agent, folder, req.allowedDomains, scope.signal);
      // The page's address, redacted like the session's other answers (ADR 0144); never the image's bytes.
      if (!shot.url) return shot;
      return { ...shot, url: await profileRedacted(ctx, actor, agent, shot.url) };
    }
    case "browser.warm":
      requireTool(ctx, "browser");
      return browser.warm(agent, folder, false);
    case "browser.stream.start":
      requireTool(ctx, "browser");
      return browser.streamStart(agent, req.mode);
    case "browser.input":
      requireTool(ctx, "browser");
      return browser.input(agent, Array.isArray(req.events) ? req.events : []);
    default:
      throw new RunnerError("bad_request", `${req.op} doesn't take a browser profile`);
  }
}

/**
 * Protocol 13 (ADR 0041): sign-ins and accounts of the computer brains. A new
 * sign-in is new work (refused while paused); status, list, cancel and remove
 * still answer.
 */
async function handleAccount(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "account" }>,
): Promise<MachineReplies["account"]> {
  const accounts = ctx.accounts;
  if (!accounts) throw new RunnerError("bad_request", "This runner keeps no accounts");
  switch (req.action) {
    case "begin":
      if (ctx.paused?.()) {
        throw new RunnerError("paused", PAUSED);
      }
      return accounts.begin(
        req.kind,
        requireString(req.loginId, "loginId"),
        req.again === true,
        req.email === undefined ? undefined : requireString(req.email, "email"),
        req.provider === undefined ? undefined : requireString(req.provider, "provider"),
        req.shared === true,
        req.method === undefined ? undefined : requireString(req.method, "method"),
      );
    case "code":
      if (typeof req.box !== "object" || req.box === null) throw new RunnerError("bad_request", "box is required");
      await accounts.code(requireString(req.loginId, "loginId"), requireString(req.aad, "aad"), req.box);
      return {};
    case "status":
      return accounts.status(requireString(req.loginId, "loginId"));
    case "cancel":
      await accounts.cancel(requireString(req.loginId, "loginId"));
      return {};
    case "list":
      // Protocol 19: usage looked up in the background; what it finds comes as `accounts.changed`.
      if (Array.isArray(req.fresh)) accounts.probeUsage(req.fresh.filter((id) => typeof id === "string"));
      return { accounts: await accounts.list() };
    case "remove":
      await accounts.remove(req.kind, requireString(req.accountId, "accountId"));
      return {};
    default:
      throw new RunnerError("bad_request", "Unknown account action");
  }
}

/** Protocol 10: the agent asks for a folder, or the site reduces what the machine allows. */
async function handleAccess(ctx: HandlerContext, req: AccessRequestOp | AccessReduceOp) {
  if (!ctx.accessOps) throw new RunnerError("bad_request", "This runner keeps no access settings");
  if (req.op === "access.request") {
    if (!req.agent) throw new RunnerError("bad_request", "A folder request belongs to an agent");
    return ctx.accessOps.request(req.agent, req);
  }
  return ctx.accessOps.reduce(req);
}

/**
 * `brain.turn` (protocol 8, ADR 0032): streams `brain.event` frames, the
 * final one included, then `brain.done`; the result repeats the final event.
 */
async function doBrainTurn(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "brain.turn" }>,
  scope: RequestScope,
  secrets: Secrets,
): Promise<MachineReplies["brain.turn"]> {
  const cli =
    req.kind === "codex" ||
    req.kind === "cursor" ||
    req.kind === "opencode" ||
    req.kind === "grok" ||
    req.kind === "antigravity"
      ? req.kind
      : null;
  requireTool(ctx, cli ?? "claude");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  const runId = requireString(req.runId, "runId");
  // A locked-down turn (protocol 41) gets neither the agent's secrets nor its folders, and stops at the first tool
  // that isn't our bridge's.
  const chat = req.permissions?.mode === "chat";
  if (cli) return doCodexTurn(ctx, req, scope, runId, chat);
  if (!ctx.brains) throw new RunnerError("bad_request", "This runner runs no brain turns");
  const final = await ctx.brains.turn(req, {
    agent: req.agent,
    folder: ctx.workspaceReal,
    secrets: secrets && !chat ? { env: secrets.env, redact: secrets.redact, hold: secrets.hold } : null,
    signal: scope.signal,
    emit: (event) => scope.emit?.({ type: "brain.event", runId, event }),
    ...(ctx.grants && !chat ? { grants: ctx.grants } : {}),
    ...(ctx.grant ? { grant: ctx.grant } : {}),
  });
  signedOut(ctx, req, final);
  scope.emit?.({ type: "brain.done", runId });
  return { runId, final };
}

/** `brain.turn` on a Claude sign-in several agents share: root runs its CLI (`account-brains.ts`). */
async function doHostedTurn(
  ctx: HandlerContext,
  hosted: AccountBrains,
  req: Extract<MachineRequest, { op: "brain.turn" }>,
  scope: RequestScope,
): Promise<MachineReplies["brain.turn"]> {
  requireTool(ctx, "claude");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  const runId = requireString(req.runId, "runId");
  const final = await hosted.turn(req, req.agent, scope, (event) =>
    scope.emit?.({ type: "brain.event", runId, event }),
  );
  signedOut(ctx, req, final);
  scope.emit?.({ type: "brain.done", runId });
  return { runId, final };
}

/**
 * Cursor, OpenCode, Grok and Antigravity turns in progress, by run: `brain.steer` answers `unsupported` for them
 * (`agent -p`, `opencode run`, `grok -p` and `agy -p` take nothing mid-turn).
 */
const turnOnlyRuns = new Map<string, "Cursor" | "OpenCode" | "Grok Build" | "Antigravity CLI">();

const STEER_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * `brain.steer` (protocol 15): messages for the request's agent's turn of
 * `runId` in progress (Claude Code reads them at its next tool boundary; a
 * Codex turn on its app-server at its next model request, `turn/steer`).
 * A Codex turn run by `codex exec` can't take any: `unsupported`.
 */
function doBrainSteer(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "brain.steer" }>,
): MachineReplies["brain.steer"] | Promise<MachineReplies["brain.steer"]> {
  if (!req.agent) throw new RunnerError("bad_request", "Steering belongs to an agent's turn");
  const runId = requireString(req.runId, "runId");
  const session = requireString(req.session, "session");
  if (!Array.isArray(req.messages) || req.messages.length === 0 || req.messages.length > STEER_LIMITS.messages) {
    throw new RunnerError("bad_request", `Between 1 and ${STEER_LIMITS.messages} messages`);
  }
  const messages = req.messages.map((m) => {
    if (typeof m?.uuid !== "string" || !STEER_UUID.test(m.uuid)) throw new RunnerError("bad_request", "Invalid uuid");
    if (typeof m.text !== "string" || !m.text.trim()) throw new RunnerError("bad_request", "Empty message");
    return { uuid: m.uuid, text: m.text.slice(0, STEER_LIMITS.text), ...(m.urgent === true ? { urgent: true } : {}) };
  });
  const turnOnly = turnOnlyRuns.get(runId);
  if (turnOnly) return { status: "unsupported", reason: `${turnOnly} reads messages only between turns` };
  if (ctx.codex?.runs.has(runId)) {
    return ctx.codex.app
      ? ctx.codex.app.steer(String(req.agent.id), { runId, session, messages })
      : { status: "unsupported", reason: "Codex reads messages only between turns" };
  }
  if (!ctx.brains) return { status: "unsupported", reason: "This runner runs no brain turns" };
  return ctx.brains.steer(String(req.agent.id), { runId, session, messages });
}

/**
 * A turn in an account that was refused (`not_logged_in`) or is gone
 * (`account_missing`): a refused one is marked so, and reads as signed out
 * until it signs in again (`AccountManager.refused`), and the server hears the
 * answer either way (`accounts.changed`). The machine is the only one that
 * says an account is signed out or gone; a passing failure leaves it as it was.
 */
function signedOut(
  ctx: HandlerContext,
  req: { kind?: unknown; account?: unknown },
  final: { type: string; code?: string } | undefined,
) {
  const accounts = ctx.accounts;
  if (!accounts || typeof req.account !== "string" || !req.account || final?.type !== "error") return;
  if (final.code !== "not_logged_in" && final.code !== "account_missing") return;
  const kind =
    req.kind === "codex" ||
    req.kind === "cursor" ||
    req.kind === "opencode" ||
    req.kind === "grok" ||
    req.kind === "antigravity"
      ? req.kind
      : "claude_code";
  void (final.code === "not_logged_in" ? accounts.refused(kind, req.account) : Promise.resolve())
    .catch(() => undefined)
    .then(() => {
      accounts.invalidate();
      return accounts.refresh(true);
    })
    .catch(() => undefined);
}

/**
 * The Codex branch of `brain.turn`: on the session's `codex app-server`
 * (`brain-codex-app.ts`; its bridge is the process's, relayed for this run),
 * else `codex exec --json` per turn (`brain-codex.ts`), whose MCP server
 * (`mcp --run <runId>`, the run's server token in its env) is relayed for the
 * run. This run's entry also marks it a Codex run for `brain.steer`.
 */
async function doCodexTurn(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "brain.turn" }>,
  scope: RequestScope,
  runId: string,
  chat: boolean,
): Promise<MachineReplies["brain.turn"]> {
  const codex = ctx.codex;
  const cursor = req.kind === "cursor";
  const opencode = req.kind === "opencode";
  const grok = req.kind === "grok";
  const agy = req.kind === "antigravity";
  const name = cursor ? "Cursor" : opencode ? "OpenCode" : grok ? "Grok Build" : agy ? "Antigravity CLI" : "Codex";
  if (!codex) throw new RunnerError("bad_request", `This runner runs no ${name} brain turns`);
  let final: CodexBrainEvent = {
    type: "error",
    code: `${cursor ? "cursor" : opencode ? "opencode" : grok ? "grok" : agy ? "antigravity" : "codex"}_failed`,
    message: `${name} ended without an answer.`,
  };
  let ended = false;
  const token = req.mcp?.token;
  // `handleRequest` made the workspace the agent's own folder already.
  const folder = ctx.workspaceReal;
  if (req.agent && typeof token === "string" && token) {
    codex.runs.set(runId, {
      token,
      missionId: "",
      running: true,
      cwd: folder,
      folder,
      runId,
      serverToken: token,
    });
  }
  const emit = (event: CodexBrainEvent) => {
    if (ended) return;
    if (event.type === "done" || event.type === "error") {
      final = event;
      ended = true;
    }
    scope.emit?.({ type: "brain.event", runId, event });
  };
  if (cursor || opencode || grok || agy) {
    turnOnlyRuns.set(runId, cursor ? "Cursor" : opencode ? "OpenCode" : grok ? "Grok Build" : "Antigravity CLI");
  }
  try {
    if (agy) {
      await handleAntigravityBrainTurn(
        {
          folder,
          exec: toolOn(ctx, "antigravity"),
          runnerHome: codex.runnerHome,
          ...(ctx.secretsDir && !chat ? { secretsDir: ctx.secretsDir } : {}),
          ...(codex.mcp ? { mcp: codex.mcp } : {}),
          ...(ctx.grants && !chat ? { grants: ctx.grants } : {}),
          ...(ctx.accounts || codex.accounts ? { accounts: ctx.accounts ?? codex.accounts } : {}),
          ...(codex.spawn ? { spawn: codex.spawn } : {}),
        },
        req as unknown as AntigravityBrainTurnRequest,
        { signal: scope.signal, emit },
      );
    } else if (grok) {
      await handleGrokBrainTurn(
        {
          folder,
          exec: toolOn(ctx, "grok"),
          runnerHome: codex.runnerHome,
          ...(ctx.secretsDir && !chat ? { secretsDir: ctx.secretsDir } : {}),
          ...(codex.mcp ? { mcp: codex.mcp } : {}),
          ...(ctx.grants && !chat ? { grants: ctx.grants } : {}),
          ...(ctx.accounts || codex.accounts ? { accounts: ctx.accounts ?? codex.accounts } : {}),
          ...(codex.spawn ? { spawn: codex.spawn } : {}),
        },
        req as unknown as GrokBrainTurnRequest,
        { signal: scope.signal, emit },
      );
    } else if (opencode) {
      await handleOpencodeBrainTurn(
        {
          folder,
          exec: toolOn(ctx, "opencode"),
          runnerHome: codex.runnerHome,
          ...(ctx.secretsDir && !chat ? { secretsDir: ctx.secretsDir } : {}),
          ...(codex.mcp ? { mcp: codex.mcp } : {}),
          ...(ctx.grants && !chat ? { grants: ctx.grants } : {}),
          ...(ctx.accounts || codex.accounts ? { accounts: ctx.accounts ?? codex.accounts } : {}),
          ...(codex.spawn ? { spawn: codex.spawn } : {}),
        },
        req as unknown as OpencodeBrainTurnRequest,
        { signal: scope.signal, emit },
      );
    } else if (cursor) {
      await handleCursorBrainTurn(
        {
          folder,
          exec: toolOn(ctx, "cursor"),
          runnerHome: codex.runnerHome,
          ...(ctx.secretsDir && !chat ? { secretsDir: ctx.secretsDir } : {}),
          ...(codex.mcp ? { mcp: codex.mcp } : {}),
          ...(ctx.grants && !chat ? { grants: ctx.grants } : {}),
          ...(ctx.accounts || codex.accounts ? { accounts: ctx.accounts ?? codex.accounts } : {}),
          ...(codex.spawn ? { spawn: codex.spawn } : {}),
        },
        req as unknown as CursorBrainTurnRequest,
        { signal: scope.signal, emit },
      );
    } else
      await handleCodexBrainTurn(
        {
          folder,
          exec: toolOn(ctx, "codex"),
          runnerHome: codex.runnerHome,
          ...(ctx.secretsDir && !chat ? { secretsDir: ctx.secretsDir } : {}),
          ...(codex.mcp ? { mcp: codex.mcp } : {}),
          ...(ctx.grants && !chat ? { grants: ctx.grants } : {}),
          ...(ctx.accounts || codex.accounts ? { accounts: ctx.accounts ?? codex.accounts } : {}),
          ...(codex.app ? { app: codex.app } : {}),
          ...(codex.spawn ? { spawn: codex.spawn } : {}),
          ...(ctx.grant ? { grant: ctx.grant } : {}),
        },
        req as unknown as CodexBrainTurnRequest,
        { signal: scope.signal, emit },
      );
  } finally {
    codex.runs.delete(runId);
    turnOnlyRuns.delete(runId);
  }
  signedOut(ctx, req, final);
  scope.emit?.({ type: "brain.done", runId });
  return { runId, final };
}

/** Background tasks: the manager finds each agent's folder itself (and keeps it for the task's life). */
function handleTask(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "task.start" | "task.status" | "task.cancel" | "task.output" }>,
) {
  const tasks = ctx.tasks;
  if (!tasks) throw new RunnerError("bad_request", "This runner runs no background tasks");
  switch (req.op) {
    case "task.start":
      // ADR 0144: a Vault key goes with one command, never a task that outlives the request (and keeps its env).
      if ((req as { vault?: unknown }).vault !== undefined) {
        throw new RunnerError("bad_request", "Vault keys go with one command (exec), never a background task");
      }
      requireTool(ctx, req.executor === "claude" ? "claude" : req.executor === "codex" ? "codex" : "commands");
      if (!req.agent) throw new RunnerError("bad_request", "A task belongs to an agent");
      return tasks.start(req.agent, req, ctx.grants ? { grants: ctx.grants } : undefined, ctx.grant);
    case "task.status":
      return tasks.status(req.agent, typeof req.taskId === "string" ? req.taskId : undefined);
    case "task.cancel":
      return tasks.cancel(req.agent, requireString(req.taskId, "taskId"));
    case "task.output":
      return tasks.output(req.agent, requireString(req.taskId, "taskId"), Number(req.tail));
  }
}

/** One log line per request: the op and the path or the head of the command, never file contents. */
export function describeRequest(req: MachineRequest): string {
  const who = req.agent ? `[${String(req.agent.handle ?? "")}] ` : "";
  return who + describeOp(req);
}

function describeOp(req: MachineRequest): string {
  switch (req.op) {
    case "exec": {
      const head = String(req.command ?? "")
        .replace(/\s+/g, " ")
        .trim();
      // How many Vault keys it carries, never their values (ADR 0144).
      const sealed = req.vault?.keys;
      const keys = Array.isArray(sealed) ? ` (${sealed.length} Vault keys)` : "";
      return `exec ${head.length > 80 ? `${head.slice(0, 80)}…` : head}${req.cwd ? ` (in ${req.cwd})` : ""}${keys}`;
    }
    case "read":
    case "write":
    case "list":
    case "push":
    case "pull":
      return `${req.op} ${String(req.path ?? "") || "."}`;
    case "secret":
      // Never the value: the action and the name or request.
      return `secret ${req.action} ${"name" in req ? req.name : req.requestId}`;
    case "account": {
      // Never the code: the action, the kind and the sign-in or account.
      const kind = "kind" in req ? ` ${String(req.kind ?? "")}` : "";
      const id = "loginId" in req ? req.loginId : "accountId" in req ? req.accountId : "";
      return `account ${String(req.action ?? "")}${kind}${id ? ` ${String(id).slice(0, 8)}` : ""}`;
    }
    case "task.start":
      return `task.start ${String(req.taskId ?? "")} (${String(req.executor ?? "")})`;
    case "task.status":
      return `task.status ${String(req.taskId ?? "all")}`;
    case "task.cancel":
      return `task.cancel ${String(req.taskId ?? "")}`;
    case "task.output":
      return `task.output ${String(req.taskId ?? "")}`;
    case "brain.turn":
      return `brain.turn ${String(req.runId ?? "")} (${String(req.kind ?? "")}${req.model ? `, ${String(req.model)}` : ""})`;
    case "brain.steer":
      // Never the text: how many messages, for which run.
      return `brain.steer ${String(req.runId ?? "")} (${Array.isArray(req.messages) ? req.messages.length : 0} messages)`;
    case "brain.route":
      // Never the prompt: other people's messages.
      return `brain.route (${String(req.kind ?? "")}${req.account ? ", an account" : ""})`;
    case "git.sync": {
      const repos = Array.isArray(req.repos) ? req.repos.map((r) => String(r?.repo ?? "")).join(", ") : "";
      return `git.sync ${repos || "(existing checkouts)"}`;
    }
    case "mission.worktree":
      return `mission.worktree ${String(req.action ?? "")} ${String(req.path ?? "")}`;
    case "access.request":
      return `access.request ${String(req.path ?? "")}`;
    case "browser.act": {
      // The command, and the URL of a navigation; never typed text.
      const command = String(req.command ?? "");
      const first = Array.isArray(req.args) ? String(req.args[0] ?? "") : "";
      const nav = ["open", "goto", "navigate"].includes(command) ? ` ${first.slice(0, 120)}` : "";
      return `browser.act ${command}${nav}`;
    }
    case "browser.batch": {
      // The commands only (`click, eval, wait, snapshot`): never their arguments.
      const commands = Array.isArray(req.commands) ? req.commands.map((c) => String(c?.command ?? "")) : [];
      return `browser.batch ${commands.join(", ").slice(0, 200)}`;
    }
    case "browser.warm":
      return `browser.warm${req.desktop === true ? " (desktop)" : ""}`;
    case "browser.stream.start":
      return `browser.stream.start (${String(req.mode ?? "")})`;
    case "browser.input":
      return `browser.input ${Array.isArray(req.events) ? req.events.length : 0} events`;
    case "browser.view.open":
      return "browser.view.open";
    case "stream.open":
      return req.kind === "terminal"
        ? `stream.open terminal ${String(req.cols)}×${String(req.rows)}`
        : `stream.open ${req.kind === "phone" ? `phone ${String(req.phone?.platform)}/${String(req.phone?.serial)}` : "desktop"} (${String(req.mode)})`;
    case "desktop.act": {
      // The kind and where it lands, its key, app or path; never typed text.
      const a: Record<string, unknown> = isRecordLike(req.action) ? req.action : {};
      const at = (v: unknown) => (isRecordLike(v) ? String(v.ref ?? `${String(v.x)},${String(v.y)}`).slice(0, 20) : "");
      const what = a.kind === "drag" ? `${at(a.from)} → ${at(a.to)}` : String(a.key ?? a.app ?? a.path ?? at(a.at));
      const text = typeof a.text === "string" ? ` (${a.text.length} characters)` : "";
      return `desktop.act ${String(a.kind).slice(0, 20)}${what ? ` ${what.slice(0, 120)}` : ""}${text}`;
    }
    case "desktop.capture":
      return `desktop.capture${req.region ? " (a region)" : ""}`;
    case "phone.claim":
    case "phone.release":
    case "phone.install":
    case "phone.launch":
    case "phone.flow":
    case "phone.record":
    case "phone.screenshot":
    case "phone.logs":
      // The phone and the app; never the flow's text or its variables.
      return `${req.op} ${String(req.platform)}/${String(req.serial)}${"app" in req && req.app ? ` ${String(req.app)}` : ""}`;
    case "access.reduce":
      return `access.reduce${req.removeFolder ? ` folder ${String(req.removeFolder.path ?? "")}` : ""}${req.disableTool ? ` tool ${String(req.disableTool)}` : ""}`;
    default:
      return String((req as { op: unknown }).op);
  }
}

const isRecordLike = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** How a request ended, for an observer. */
export type RequestOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: MachineErrorCode; message: string } };

/** Sees every request start and end (the desktop app's jobs and the activity log). */
export interface RequestObserver {
  started(id: string, req: MachineRequest): void;
  finished(id: string, req: MachineRequest, outcome: RequestOutcome): void;
}

/** Tests: what admission reads. */
export interface Admission {
  /** The memory available now (default: `/proc/meminfo`, as desktops read it; null: not known). */
  memAvailable?: () => number | null;
  now?: () => number;
  /** Tests: `RECLAIM_MS`. */
  reclaimMs?: number;
}

/**
 * Runs the requests of one connection concurrently, sends their `result`
 * frames, and aborts them on `cancel` or when the connection ends. A brain turn
 * that finds no room is refused `no_slot` (the server waits and asks again);
 * past `MAX_IN_FLIGHT` anything but a person's view is refused `busy`.
 */
export class RequestRunner {
  private readonly inflight = new Map<string, AbortController>();
  private closed = false;
  /** Brain turns running now. */
  private turns = 0;
  /** When brain turns were admitted, over the last `TURN_SETTLE_MS`. */
  private admitted: number[] = [];
  /** When a person's turn was last admitted, by the floor or the slot. */
  private lastPersonTurn = Number.NEGATIVE_INFINITY;
  /** The request in the slot held for a person's turn (`reserve`). */
  private reserved: string | null = null;

  constructor(
    private readonly ctx: HandlerContext,
    private readonly send: (frame: RunnerFrame) => void,
    private readonly log: (line: string) => void = () => {},
    private readonly handler: typeof handleRequest = handleRequest,
    private readonly admission: Admission = {},
    private readonly observer?: RequestObserver,
  ) {}

  /**
   * Room for one more brain turn: `MemAvailable`, less what the turns admitted in the last
   * `TURN_SETTLE_MS` will still take, leaves `MIN_FREE_BYTES` (1.5 GiB, the floor desktops keep). The
   * floor is more than the biggest thing a turn grows into (a computer-use agent, about 1.4 GB with its screen
   * and browser), so the one admitted last still fits whole. Where the memory isn't known, a count instead. `locked`:
   * a locked-down turn, on its own floor and a little past the count. `person`: a person waits on it.
   */
  private admit(locked: boolean, person: boolean): boolean {
    const now = (this.admission.now ?? Date.now)();
    this.admitted = this.admitted.filter((at) => now - at < TURN_SETTLE_MS);
    const free = this.memAvailable();
    const floor = locked ? LOCKED_TURN_MIN_FREE_BYTES : MIN_FREE_BYTES;
    const room =
      free === null
        ? this.turns < TURNS_WITHOUT_MEMORY + (locked ? LOCKED_TURNS_PAST_COUNT : 0)
        : free - this.admitted.length * TURN_BYTES >= floor;
    if (room) {
      this.admitted.push(now);
      if (person) this.lastPersonTurn = now;
    }
    return room;
  }

  /**
   * The floor turned away a turn a person waits on and closing idle CLIs didn't help: one such turn at a time goes
   * ahead, down to `PERSON_TURN_MIN_FREE_BYTES`, if no person's turn was admitted in the last `TURN_SETTLE_MS` (the
   * reading doesn't show that one yet). Agents' turns keep their floor, and what this one takes counts against it.
   * Where memory isn't known there is no floor to keep, so no slot.
   */
  private reserve(id: string, person: boolean): boolean {
    if (!person || this.reserved !== null) return false;
    const now = (this.admission.now ?? Date.now)();
    const free = this.memAvailable();
    if (free === null || now - this.lastPersonTurn < TURN_SETTLE_MS) return false;
    if (free - this.admitted.length * TURN_BYTES < PERSON_TURN_MIN_FREE_BYTES) return false;
    this.admitted.push(now);
    this.lastPersonTurn = now;
    this.reserved = id;
    return true;
  }

  private floorHolds(locked: boolean) {
    const free = this.memAvailable();
    return free !== null && free >= (locked ? LOCKED_TURN_MIN_FREE_BYTES : MIN_FREE_BYTES);
  }

  private memAvailable() {
    return (this.admission.memAvailable ?? hostMemAvailable)();
  }

  /**
   * No room for a turn: idle warm CLIs close, one at a time, until there is, for up to `RECLAIM_MS`. Not where
   * memory isn't known: room there is a count of turns, which closing idle CLIs doesn't change.
   */
  private async reclaim(
    close: () => Promise<boolean>,
    signal: AbortSignal,
    locked: boolean,
    person: boolean,
  ): Promise<boolean> {
    const until = Date.now() + (this.admission.reclaimMs ?? RECLAIM_MS);
    while (!signal.aborted && Date.now() < until) {
      if (!(await close())) return false;
      if (!signal.aborted && this.admit(locked, person)) return true;
    }
    return false;
  }

  get size() {
    return this.inflight.size;
  }

  /** Starts a request; resolves when its result was sent (tests await it). */
  start(id: string, req: MachineRequest): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inflight.has(id)) {
      this.reply(id, { ok: false, error: { code: "bad_request", message: "Duplicate request id" } });
      return Promise.resolve();
    }
    if (this.inflight.size >= MAX_IN_FLIGHT && !PEOPLE_OPS.has(req.op)) {
      this.reply(id, { ok: false, error: { code: "internal", message: "busy" } });
      return Promise.resolve();
    }
    const controller = new AbortController();
    const locked = req.op === "brain.turn" && req.permissions?.mode === "chat";
    const person = req.op === "brain.turn" && req.personWaiting === true;
    // A paused computer says so (the handler refuses new work), never that it is full.
    if (req.op === "brain.turn" && !this.ctx.paused?.() && !this.admit(locked, person)) {
      const close = this.ctx.reclaimBrains;
      if (!close || this.memAvailable() === null) {
        if (this.reserve(id, person)) return this.run(id, req, controller);
        this.full(id);
        return Promise.resolve();
      }
      // Held meanwhile: a duplicate id is refused, and a cancel stops closing other conversations' CLIs for it.
      this.inflight.set(id, controller);
      const session = (req as { session?: { id?: unknown } }).session?.id;
      const spare = brainKey(req.agent?.id ?? "", String(session ?? ""));
      // A turn on its session's open CLI starts no process: the turns still settling don't count against it, the floor does.
      const warm = this.ctx.warmBrain ? this.ctx.warmBrain(spare).catch(() => false) : Promise.resolve(false);
      return warm
        .then(
          (open) =>
            (open && this.floorHolds(locked)) || this.reclaim(() => close(spare), controller.signal, locked, person),
        )
        .then((room) => {
          if (!this.closed && (room || (!controller.signal.aborted && this.reserve(id, person))))
            return this.run(id, req, controller);
          this.inflight.delete(id);
          if (controller.signal.aborted)
            this.reply(id, { ok: false, error: { code: "internal", message: "Canceled" } });
          else this.full(id);
        });
    }
    return this.run(id, req, controller);
  }

  private full(id: string) {
    const message = "This computer is short of memory for more work right now";
    this.reply(id, { ok: false, error: { code: "no_slot", message } });
  }

  private run(id: string, req: MachineRequest, controller: AbortController): Promise<void> {
    const turn = req.op === "brain.turn";
    if (turn) this.turns++;
    this.inflight.set(id, controller);
    // A browser or desktop command is logged when it ends, with how long it took (`browser.act snapshot 812ms`) and
    // what it waited on first (`(install 28.1 s, launch 1.4 s)`).
    const timed =
      req.op === "browser.act" ||
      req.op === "browser.batch" ||
      req.op === "browser.capture" ||
      req.op === "browser.warm" ||
      req.op === "browser.input" ||
      req.op === "desktop.look" ||
      req.op === "desktop.act" ||
      req.op === "desktop.capture" ||
      req.op === "desktop.text";
    const startedAt = Date.now();
    if (!timed) this.log(describeRequest(req));
    this.observe(() => this.observer?.started(id, req));
    const scope: RequestScope = {
      signal: controller.signal,
      output: (stream, chunk) => {
        if (!this.closed && chunk) this.send({ type: "output", id, stream, chunk });
      },
      emit: (frame) => {
        if (this.closed) return;
        try {
          this.send(frame);
        } catch {
          // socket gone
        }
      },
    };
    return this.handler(this.ctx, req, scope)
      .then((data): RequestOutcome => {
        if (controller.signal.aborted && req.op !== "exec") {
          return { ok: false, error: { code: "internal", message: "Canceled" } };
        }
        return { ok: true, data };
      })
      .catch((err: unknown): RequestOutcome => {
        const error = toMachineError(err);
        if (error.code === "internal" && error.message !== "Canceled") this.log(`${req.op} failed: ${error.message}`);
        return { ok: false, error };
      })
      .then((outcome) => {
        if (timed) {
          const data = outcome.ok && isRecordLike(outcome.data) ? outcome.data : null;
          // An input batch says how many events the browser didn't confirm.
          const unconfirmed = typeof data?.failed === "number" && data.failed > 0 ? data.failed : 0;
          const failed = !outcome.ok || data?.success === false;
          const setup = browserSetupOf(data?.setup);
          const notes = [
            failed ? "failed" : unconfirmed ? `failed: ${unconfirmed}` : "",
            setup ? browserSetupText(setup) : "",
          ].filter(Boolean);
          const note = notes.length > 0 ? ` (${notes.join(", ")})` : "";
          this.log(`${describeRequest(req)} ${Date.now() - startedAt}ms${note}`);
        }
        this.observe(() => this.observer?.finished(id, req, outcome));
        this.reply(id, outcome);
      })
      .finally(() => {
        this.inflight.delete(id);
        if (turn) this.turns--;
        if (this.reserved === id) this.reserved = null;
      });
  }

  private observe(fn: () => void) {
    try {
      fn();
    } catch {
      // an observer never breaks a request
    }
  }

  cancel(id: string) {
    this.inflight.get(id)?.abort();
  }

  /** The connection ended: stop everything, send nothing more. */
  close() {
    this.closed = true;
    for (const c of this.inflight.values()) c.abort();
  }

  private reply(id: string, r: RequestOutcome) {
    if (this.closed) return;
    try {
      this.send(
        r.ok ? { type: "result", id, ok: true, data: r.data } : { type: "result", id, ok: false, error: r.error },
      );
    } catch {
      // socket gone
    }
  }
}
