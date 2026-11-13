import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ACCESS_LIMITS,
  grantedTo,
  isAccountId,
  type MachineAgent,
  type RunnerAccess,
  type RunnerFolderGrant,
  type RunnerTools,
} from "@agenteschat/adapters/machine-protocol";
import type { ControlAccessRequest, ControlErrorCode } from "@agenteschat/adapters/runner-control";
import { expandHome } from "./config";
import { isInside } from "./paths";

/**
 * Folders and tools on the machine (protocol 10, ADR 0036 §8). The person
 * allows a folder beyond the agents' own folders for some agents, and turns
 * Claude Code, Codex, commands, the agent browser, the desktops and the
 * terminal on or off. Everything here is a plain transform of `RunnerAccess`
 * (the caller writes the config), plus the checks a folder must pass before it
 * is allowed and the store of pending requests. Access only widens on the
 * machine: the server can only reduce.
 */

/** A refusal the desktop app (or the CLI) shows as is. */
export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ControlError";
  }
}

export const TOOL_NAMES: readonly (keyof RunnerTools)[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
  "commands",
  "browser",
  "desktop",
  "terminal",
];

/** What each tool is, as the CLI names it (`tools list`, `doctor`). */
export const TOOL_LABELS: Record<keyof RunnerTools, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok Build",
  antigravity: "Antigravity CLI (Gemini)",
  commands: "Commands",
  browser: "Browser",
  desktop: "Desktops (each agent's own screen, watched and controlled from the app)",
  terminal: "Terminal (a shell as the agent, opened from the app)",
};

const caseless = process.platform === "win32" || process.platform === "darwin";
const samePath = (a: string, b: string) => (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Folders that are never allowed as a whole (exact match): the root, the home, the folders of homes and volumes. */
function exactRefused(home: string): string[] {
  if (process.platform === "win32") {
    const drive = (process.env.SystemDrive || "C:").replace(/[\\/]+$/, "");
    return [`${drive}\\`, home, `${drive}\\Users`];
  }
  return ["/", home, "/Users", "/home", "/Volumes", "/private", "/var", "/opt", "/mnt", "/media", "/root"];
}

/** System folders, refused with everything inside them. */
function treeRefused(): string[] {
  if (process.platform === "win32") {
    const drive = (process.env.SystemDrive || "C:").replace(/[\\/]+$/, "");
    return [
      process.env.SystemRoot || `${drive}\\Windows`,
      process.env.ProgramFiles || `${drive}\\Program Files`,
      process.env["ProgramFiles(x86)"] || `${drive}\\Program Files (x86)`,
      process.env.ProgramData || `${drive}\\ProgramData`,
    ];
  }
  return [
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/dev",
    "/proc",
    "/sys",
    "/boot",
    "/Applications",
    "/private/etc",
    "/private/var/db",
    "/cores",
  ];
}

/**
 * Why a folder can't be allowed, or null. `abs` and `real` are the given
 * path made absolute and its real path; both are checked (a symlink can't
 * smuggle a system folder in). The runner home (it holds the token) and any
 * folder that contains it or the workspace (every agent's folder) are
 * refused too.
 */
export function refusedFolder(
  abs: string,
  real: string,
  opts: { home?: string; runnerHome?: string; workspace?: string } = {},
): string | null {
  const home = opts.home ?? os.homedir();
  const low = (p: string) => (caseless ? p.toLowerCase() : p);
  for (const p of [abs, real]) {
    if (exactRefused(home).some((s) => samePath(s, p))) {
      return samePath(p, home)
        ? "Your whole home folder can't be allowed: pick a folder inside it"
        : `${p} is a system folder and can't be allowed`;
    }
    if (treeRefused().some((s) => isInside(low(s), low(p)))) return `${p} is a system folder and can't be allowed`;
  }
  // The runner's home holds this computer's key: never inside an allowed folder, never one itself.
  if (opts.runnerHome && (isInside(opts.runnerHome, real) || isInside(real, opts.runnerHome))) {
    return `${real} is or contains the runner's own folder (it holds this computer's key) and can't be allowed`;
  }
  // A folder that holds the whole workspace would give one agent every agent's folder (one agent's folder is fine).
  if (opts.workspace && isInside(real, opts.workspace)) {
    return `${real} contains every agent's folder and can't be allowed`;
  }
  return null;
}

/**
 * Checks a folder a person wants to allow: it must exist, be a folder and
 * not be a system folder. Returns its real path (what goes in the config).
 */
export function checkFolder(
  input: string,
  opts: { home?: string; runnerHome?: string; workspace?: string } = {},
): string {
  if (typeof input !== "string" || !input.trim()) throw new ControlError("invalid_path", "Pick a folder");
  if (input.includes("\0") || input.length > ACCESS_LIMITS.path) throw new ControlError("invalid_path", "Invalid path");
  const abs = expandHome(input.trim());
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new ControlError("invalid_path", `${abs} doesn't exist`);
  }
  if (!statSync(real).isDirectory()) throw new ControlError("invalid_path", `${abs} is not a folder`);
  const why = refusedFolder(path.resolve(abs), real, opts);
  if (why) throw new ControlError("invalid_path", why);
  return real;
}

const findFolder = (access: RunnerAccess, folder: string) => access.folders.findIndex((f) => samePath(f.path, folder));

const uniq = (ids: string[]) =>
  [...new Set(ids.filter((a) => typeof a === "string" && a))].slice(0, ACCESS_LIMITS.agentsPerFolder);

const copy = (access: RunnerAccess): RunnerAccess => ({
  folders: access.folders.map((f) => ({ path: f.path, agents: [...f.agents] })),
  tools: { ...access.tools },
});

/** Allows `folder` (a checked real path) for `agents` too (merged with whoever already had it). */
export function addFolder(access: RunnerAccess, folder: string, agents: string[]): RunnerAccess {
  const next = copy(access);
  const i = findFolder(next, folder);
  if (i >= 0) {
    const f = next.folders[i] as RunnerFolderGrant;
    f.agents = uniq([...f.agents, ...agents]);
  } else {
    if (next.folders.length >= ACCESS_LIMITS.folders) {
      throw new ControlError("bad_request", `At most ${ACCESS_LIMITS.folders} folders can be allowed`);
    }
    next.folders.push({ path: folder, agents: uniq(agents) });
  }
  return next;
}

/** Which agents use `folder` from now on (the folder must be allowed already). */
export function setFolderAgents(access: RunnerAccess, folder: string, agents: string[]): RunnerAccess {
  const next = copy(access);
  const i = findFolder(next, folder);
  if (i < 0) throw new ControlError("not_found", `${folder} is not an allowed folder`);
  (next.folders[i] as RunnerFolderGrant).agents = uniq(agents);
  return next;
}

/** Removes `folder` for everyone, or only for `agentId` (the folder stays allowed for the others). */
export function removeFolder(access: RunnerAccess, folder: string, agentId?: string): RunnerAccess {
  const next = copy(access);
  const i = findFolder(next, folder);
  if (i < 0) return next;
  if (agentId) {
    const f = next.folders[i] as RunnerFolderGrant;
    f.agents = f.agents.filter((a) => a !== agentId);
  } else {
    next.folders.splice(i, 1);
  }
  return next;
}

export function setTool(access: RunnerAccess, tool: keyof RunnerTools, on: boolean): RunnerAccess {
  if (!TOOL_NAMES.includes(tool)) throw new ControlError("bad_request", `Unknown tool ${String(tool)}`);
  const next = copy(access);
  next.tools[tool] = on;
  return next;
}

/**
 * `access.reduce` from the server: removes a folder (for everyone or one
 * agent) or turns a tool off. Never widens: whatever the frame says, the
 * result allows no more than `access` did.
 */
export function reduceAccess(
  access: RunnerAccess,
  req: { removeFolder?: { path?: unknown; agentId?: unknown }; disableTool?: unknown },
): RunnerAccess {
  let next = copy(access);
  const rf = req.removeFolder;
  if (rf && typeof rf.path === "string" && rf.path) {
    const target = path.resolve(rf.path);
    const i = next.folders.findIndex((f) => samePath(f.path, target) || samePath(f.path, rf.path as string));
    const folder = i >= 0 ? (next.folders[i] as RunnerFolderGrant).path : target;
    next = removeFolder(next, folder, typeof rf.agentId === "string" && rf.agentId ? rf.agentId : undefined);
  }
  if (typeof req.disableTool === "string" && TOOL_NAMES.includes(req.disableTool as keyof RunnerTools)) {
    next.tools[req.disableTool as keyof RunnerTools] = false;
  }
  return next;
}

/** Whether `a` allows anything `b` doesn't (tests: a reduce never widens). */
export function widens(a: RunnerAccess, b: RunnerAccess): boolean {
  for (const t of TOOL_NAMES) if (a.tools[t] === true && b.tools[t] !== true) return true;
  for (const f of a.folders) {
    const g = b.folders.find((x) => samePath(x.path, f.path));
    if (!g) return true;
    if (f.agents.some((id) => !g.agents.includes(id))) return true;
  }
  return false;
}

/** The folders allowed for one agent (as stored). */
export function foldersFor(access: RunnerAccess, agentId: string | undefined): string[] {
  if (!agentId) return [];
  return access.folders.filter((f) => grantedTo(f, agentId)).map((f) => f.path);
}

/** The same, as real paths that exist now (an allowed folder that vanished or moved is skipped). */
export async function realFoldersFor(access: RunnerAccess, agentId: string | undefined): Promise<string[]> {
  const out: string[] = [];
  for (const f of foldersFor(access, agentId)) {
    try {
      const real = await realpath(f);
      if (!out.includes(real)) out.push(real);
    } catch {
      // gone
    }
  }
  return out;
}

/** Whether `target` (absolute) is inside a folder allowed for `agentId` (symlinks resolved where it exists). */
export function allowedFor(access: RunnerAccess, agentId: string, target: string): boolean {
  let real = path.resolve(target);
  try {
    real = realpathSync(real);
  } catch {
    // not there yet: compared as given
  }
  return foldersFor(access, agentId).some((f) => {
    let root = f;
    try {
      root = realpathSync(f);
    } catch {}
    return isInside(root, real) || isInside(f, path.resolve(target));
  });
}

// ── Pending requests (`access.request`) ─────────────────────────────────────

export interface StoredRequest extends ControlAccessRequest {
  agentHandle: string;
}

/** A decision the server hasn't received yet (sent again after each reconnect). */
export interface PendingDecision {
  requestId: string;
  decision: "granted" | "denied" | "expired";
  scope?: "agent" | "all";
}

interface RequestsFile {
  requests: StoredRequest[];
  decided: PendingDecision[];
}

export const ACCESS_REQUESTS_FILE = "access-requests.json";
const REQUEST_ID = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_REQUESTS = 200;

/** `<home>/access-requests.json` (mode 600): requests waiting for the person, and decisions not yet delivered. */
export class AccessRequests {
  private data: RequestsFile;

  constructor(
    private readonly home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.data = this.load();
  }

  private get file() {
    return path.join(this.home, ACCESS_REQUESTS_FILE);
  }

  private load(): RequestsFile {
    try {
      if (!existsSync(this.file)) return { requests: [], decided: [] };
      const v = JSON.parse(readFileSync(this.file, "utf8")) as Partial<RequestsFile>;
      return {
        requests: Array.isArray(v.requests) ? v.requests.filter((r) => REQUEST_ID.test(String(r?.requestId))) : [],
        decided: Array.isArray(v.decided) ? v.decided.filter((d) => REQUEST_ID.test(String(d?.requestId))) : [],
      };
    } catch {
      return { requests: [], decided: [] };
    }
  }

  private save() {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  static validId(requestId: unknown): requestId is string {
    return typeof requestId === "string" && REQUEST_ID.test(requestId);
  }

  get(requestId: string) {
    return this.data.requests.find((r) => r.requestId === requestId);
  }

  /** Pending ones, oldest first (expired ones are not here: `expire()` takes them out). */
  list(): StoredRequest[] {
    return [...this.data.requests];
  }

  /** Stores a request (the same id again keeps the first). */
  add(input: {
    requestId: string;
    agent: { id: string; name: string; handle: string };
    path: string;
    reason: string;
  }): StoredRequest {
    const existing = this.get(input.requestId);
    if (existing) return existing;
    const at = this.now();
    const req: StoredRequest = {
      requestId: input.requestId,
      agent: { id: input.agent.id, name: input.agent.name },
      agentHandle: input.agent.handle,
      path: input.path,
      reason: input.reason.slice(0, ACCESS_LIMITS.reason),
      at: new Date(at).toISOString(),
      expiresAt: new Date(at + ACCESS_LIMITS.requestTtlMs).toISOString(),
    };
    this.data.requests.push(req);
    if (this.data.requests.length > MAX_REQUESTS)
      this.data.requests.splice(0, this.data.requests.length - MAX_REQUESTS);
    this.save();
    return req;
  }

  /** Takes a request out with its decision; the decision waits in the file until the server has it. */
  resolve(requestId: string, decision: PendingDecision["decision"], scope?: "agent" | "all") {
    this.data.requests = this.data.requests.filter((r) => r.requestId !== requestId);
    this.data.decided = this.data.decided.filter((d) => d.requestId !== requestId);
    this.data.decided.push({ requestId, decision, ...(scope ? { scope } : {}) });
    if (this.data.decided.length > MAX_REQUESTS) this.data.decided.splice(0, this.data.decided.length - MAX_REQUESTS);
    this.save();
  }

  /** Requests past their 24 h, taken out (each with an `expired` decision). */
  expire(): StoredRequest[] {
    const now = this.now();
    const gone = this.data.requests.filter((r) => Date.parse(r.expiresAt) <= now);
    for (const r of gone) this.resolve(r.requestId, "expired");
    return gone;
  }

  /** Decisions the server hasn't acknowledged by receiving them. */
  undelivered(): PendingDecision[] {
    return [...this.data.decided];
  }

  /** Sent: forgotten. */
  delivered(requestIds: string[]) {
    if (requestIds.length === 0) return;
    this.data.decided = this.data.decided.filter((d) => !requestIds.includes(d.requestId));
    this.save();
  }
}

// ── Agents (from the server's `agents` frame) ───────────────────────────────

/** Not `agents.json`: in a system home that file lists the agents' own OS users (`agent-users.ts`). */
export const AGENTS_FILE = "machine-agents.json";

/** The last `agents` frame, kept so the CLI can resolve `--agent <handle>` and the app shows them offline. */
export function readAgents(home: string): MachineAgent[] {
  try {
    const v = JSON.parse(readFileSync(path.join(home, AGENTS_FILE), "utf8")) as unknown;
    return Array.isArray(v) ? parseAgents(v) : [];
  } catch {
    return [];
  }
}

export function writeAgents(home: string, agents: MachineAgent[]) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, AGENTS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(agents), { mode: 0o600 });
  renameSync(tmp, file);
}

/** The `agents` frame's list, checked and cut. */
export function parseAgents(v: unknown): MachineAgent[] {
  if (!Array.isArray(v)) return [];
  const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
  const out: MachineAgent[] = [];
  for (const a of v.slice(0, 500)) {
    if (typeof a !== "object" || a === null) continue;
    const o = a as Record<string, unknown>;
    const id = str(o.id, 64);
    if (!id) continue;
    const look = typeof o.look === "object" && o.look !== null ? (o.look as Record<string, unknown>) : null;
    const lookOut = look
      ? {
          ...(str(look.color, 40) ? { color: str(look.color, 40) } : {}),
          ...(str(look.eyes, 40) ? { eyes: str(look.eyes, 40) } : {}),
          ...(str(look.accessory, 40) ? { accessory: str(look.accessory, 40) } : {}),
        }
      : null;
    out.push({
      id,
      handle: str(o.handle, 64),
      name: str(o.name, 100) || str(o.handle, 64),
      ...(lookOut && Object.keys(lookOut).length ? { look: lookOut } : {}),
      ...(isAccountId(o.account) ? { account: o.account } : {}),
      ...(Array.isArray(o.accounts) && o.accounts.some(isAccountId)
        ? { accounts: o.accounts.filter(isAccountId).slice(0, 500) }
        : {}),
      ...(str(o.locale, 32) ? { locale: str(o.locale, 32) } : {}),
      ...(o.containers === true ? { containers: true } : {}),
    });
  }
  return out;
}

/** `--agent dev`, `--agent @dev` or an id → the agent's id. */
export function resolveAgentHandle(agents: MachineAgent[], given: string): MachineAgent | undefined {
  const h = given.trim().replace(/^@/, "").toLowerCase();
  return agents.find((a) => a.handle.toLowerCase() === h || a.id === given.trim());
}
