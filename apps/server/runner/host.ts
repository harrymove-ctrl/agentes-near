import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentUser, readAgentUsers } from "./agent-users";
import {
  DEFAULT_AGENT_UID_RANGE,
  expandHome,
  readStoredConfig,
  runnerHome,
  type StoredConfig,
  serializeConfig,
  writeConfig,
} from "./config";
import { backoffDelay, TOKEN_REFUSED_EXIT } from "./connection";
import { machineOs } from "./daemon";
import { RUNNER_VERSION } from "./errors";
import { readLines } from "./lines";
import { uniqueWorkspace } from "./pairing";
import type { FetchLike } from "./push";

/**
 * `agentes-runner host`: the server's own computer (`HOST_COMPUTER_TOKEN`).
 * Every minute it asks the server which organizations it serves
 * (`POST /api/machines/host/sync`), keeps one runner home per organization
 * (`<state>/orgs/<orgId>`, `managedBy: "host"`) and runs `agentes-runner
 * start` in each, started again after a backoff when it stops. The children
 * speak the ordinary machine protocol, so the server treats each as one more
 * computer of that organization.
 *
 * On Linux it runs as root and each child is a system-mode runner (each agent
 * its own OS user): each organization's agents get uids from their
 * own block of the range, so two children never hand out the same uid, and
 * one loopback guard covers all of them (`agentUids`). On a Mac, and on Linux
 * as another user (the self-host setup's simple mode, where system mode can't
 * run: ADR 0153 §5), the children run as the user who installed it.
 *
 * A server that turned it off (404) or refuses its token (401) leaves it idle,
 * asking again every minute, with its children stopped. While the server
 * can't be reached they keep going.
 *
 * ponytail: one child process per organization; multiplex organizations in one runner if a server hosts dozens.
 */

export const HOST_SYNC_MS = 60_000;
/** Each organization's agents get uids from a block this big of the computer's range. */
export const HOST_UID_BLOCK = 100;
/** A child that ran this long before it stopped starts again at once. */
const CHILD_STABLE_MS = 60_000;
/** How long children get to stop before they are killed. */
const STOP_GRACE_MS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HostChild {
  /** The exit code once it has exited (null: killed by a signal, or it never started). */
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

/** Starts the runner of one home (`label` names it in the log). */
export type StartChild = (home: string, label: string) => HostChild;

export interface HostOptions {
  /** The server, as `normalizeServerUrl` gives it. */
  server: string;
  /** `HOST_COMPUTER_TOKEN`, read again before each sync (a token file may change). */
  token: () => string | null;
  /** The homes go in `<state>/orgs`. */
  state: string;
  /** This computer's name for new organizations. */
  name: string;
  /** Linux as root: every child in system mode. */
  system: boolean;
  /** Commands on in the homes `sync` makes (`--no-exec`: off); Claude Code, Codex, the browser and screens are on either way. */
  exec: boolean;
  log: (line: string) => void;
  start: StartChild;
  fetch?: FetchLike;
  /** The computer's agent uids, cut into organizations' blocks (default `DEFAULT_AGENT_UID_RANGE`). */
  uidRange?: [number, number];
  /** Where agents work outside system mode: a folder per organization in it (default `~/agentes`). */
  workspaceBase?: string;
  intervalMs?: number;
  /** Organizations whose token the first sync replaces (`--rotate`: the server refused it). */
  rotate?: string[];
}

export type HostStatus = "on" | "off" | "refused" | "no_token" | "unreachable";

/** What `once()` did: the homes of the organizations served (`new`: made now), and those it no longer serves. */
export interface HostSyncResult {
  status: HostStatus;
  homes: { orgId: string; orgName: string; machineId: string; home: string; new: boolean }[];
  gone: string[];
}

interface SyncedOrg {
  orgId: string;
  orgName: string;
  machineId: string;
  token?: string;
}

interface Child {
  orgId: string;
  label: string;
  home: string;
  proc: HostChild | null;
  /** Stops in a row soon after starting (the backoff). */
  attempt: number;
  startedAt: number;
  notBefore: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The orgs of a sync's answer; null when it isn't one (ids name folders here, so they must be ids). */
function parseOrgs(body: unknown): SyncedOrg[] | null {
  const orgs = (body as { orgs?: unknown } | null)?.orgs;
  if (!Array.isArray(orgs)) return null;
  const out: SyncedOrg[] = [];
  for (const o of orgs as Record<string, unknown>[]) {
    if (typeof o?.orgId !== "string" || !UUID.test(o.orgId)) return null;
    if (typeof o.machineId !== "string" || !UUID.test(o.machineId)) return null;
    const token = typeof o.token === "string" && o.token.length <= 200 ? o.token : undefined;
    const orgName = typeof o.orgName === "string" ? o.orgName.slice(0, 200) : "";
    out.push({ orgId: o.orgId.toLowerCase(), orgName, machineId: o.machineId, ...(token ? { token } : {}) });
  }
  return out;
}

/** An organization's name as a log tag: one line, short. */
const tag = (name: string, orgId: string) =>
  name
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, 60) || orgId;

export class HostComputer {
  private readonly children = new Map<string, Child>();
  /** Organizations whose token the server refused: the next sync asks for new ones. */
  private readonly rotate: Set<string>;
  private status: "starting" | HostStatus = "starting";
  private failures = 0;
  private stopped = false;
  private again = false;
  private wake: (() => void) | null = null;

  constructor(private readonly opts: HostOptions) {
    this.rotate = new Set(opts.rotate ?? []);
  }

  private get orgsDir() {
    return path.join(this.opts.state, "orgs");
  }

  /** Syncs now and every minute (sooner after a refused token) until `stop()`. */
  async run() {
    while (!this.stopped) {
      this.again = false;
      await this.sync();
      if (this.stopped || this.again) continue;
      const interval = this.opts.intervalMs ?? HOST_SYNC_MS;
      await this.sleep(this.status === "unreachable" ? Math.min(interval, backoffDelay(this.failures - 1)) : interval);
    }
  }

  /** Stops the loop and the children (killed if they take longer than a few seconds). */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.wake?.();
    const running = [...this.children.values()].flatMap((c) => (c.proc ? [c.proc] : []));
    this.stopAll();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), STOP_GRACE_MS);
    });
    if ((await Promise.race([Promise.all(running.map((p) => p.exited)), late])) === "late") {
      for (const p of running) p.kill("SIGKILL");
    }
    clearTimeout(timer);
  }

  /** Every persisted agent, including those of organizations not currently running. */
  agentUsers(): AgentUser[] {
    return this.homes().flatMap((h) => readAgentUsers(h.dir));
  }

  /** The uids of every organization's agents here (the loopback guard's). */
  agentUids(): number[] {
    return this.agentUsers().map((u) => u.uid);
  }

  /** One round: what the server says, then the homes and children to match. */
  async sync() {
    const orgs = await this.ask();
    if (orgs) this.reconcile(orgs);
  }

  /**
   * One round that writes the homes and starts nothing (`host --once`, for a program that runs their
   * runners itself, the desktop app). A new home has every tool off: that program turns on its own.
   * New means the organization had no home here: one written for the server at its previous port is the same
   * home, tools and all. `gone`: this server's homes here that it no longer serves; they stay until their
   * owner removes them.
   */
  async once(): Promise<HostSyncResult> {
    const before = this.homes().filter((h) => h.config.managedBy === "host");
    const orgs = await this.ask();
    if (!orgs) return { status: this.status === "starting" ? "unreachable" : this.status, homes: [], gone: [] };
    const homes = orgs.flatMap((org) => {
      const home = path.join(this.orgsDir, org.orgId);
      if (!this.writeHome(home, org, false)) return [];
      const fresh = !before.some((h) => h.orgId === org.orgId);
      return [{ orgId: org.orgId, orgName: org.orgName, machineId: org.machineId, home, new: fresh }];
    });
    const gone = before
      .filter((h) => h.config.server === this.opts.server && !orgs.some((o) => o.orgId === h.orgId))
      .map((h) => h.orgId);
    return { status: "on", homes, gone };
  }

  /** The organizations the server serves here, with new tokens where it sent them; null when it says no. */
  private async ask(): Promise<SyncedOrg[] | null> {
    const token = this.opts.token();
    if (!token) {
      this.idle("no_token", "no HOST_COMPUTER_TOKEN to show the server: waiting for it");
      return null;
    }
    let res: Response;
    try {
      res = await (this.opts.fetch ?? ((url, init) => fetch(url, init)))(`${this.opts.server}/api/machines/host/sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: this.opts.name,
          hostname: os.hostname(),
          os: machineOs(),
          arch: os.arch(),
          runnerVersion: RUNNER_VERSION,
          have: this.homes().flatMap((h) => (h.config.token ? [h.orgId] : [])),
          rotate: [...this.rotate],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      this.unreachable(err instanceof Error ? err.message : String(err));
      return null;
    }
    if (res.status === 404) {
      this.idle("off", "the server has this computer turned off (no HOST_COMPUTER_TOKEN there): waiting");
      return null;
    }
    if (res.status === 401) {
      this.idle("refused", "the server refused this computer's token (HOST_COMPUTER_TOKEN): waiting for the right one");
      return null;
    }
    const orgs = res.ok ? parseOrgs(await res.json().catch(() => null)) : null;
    if (!orgs) {
      this.unreachable(res.ok ? "an answer it doesn't understand" : `HTTP ${res.status}`);
      return null;
    }
    this.failures = 0;
    this.setStatus("on", `serving ${orgs.length} organization${orgs.length === 1 ? "" : "s"}`);
    return orgs;
  }

  private reconcile(orgs: SyncedOrg[]) {
    const wanted = new Set(orgs.map((o) => o.orgId));
    for (const c of [...this.children.values()]) {
      if (!wanted.has(c.orgId)) {
        this.opts.log(`[${c.label}] no longer served here; stopping its runner`);
        this.drop(c);
      }
    }
    for (const id of [...this.rotate]) if (!wanted.has(id)) this.rotate.delete(id);
    for (const org of orgs) {
      if (org.token) this.rotate.delete(org.orgId);
      const home = path.join(this.orgsDir, org.orgId);
      if (!this.writeHome(home, org)) continue;
      let c = this.children.get(org.orgId);
      if (!c) {
        c = { orgId: org.orgId, label: "", home, proc: null, attempt: 0, startedAt: 0, notBefore: 0, timer: null };
        this.children.set(org.orgId, c);
      }
      c.label = tag(org.orgName, org.orgId);
      this.launch(c);
    }
  }

  /**
   * Brings the organization's home up to date (mode 600, written only when it changes). False: it can't run yet.
   * A new home gets Claude Code, Codex, the browser, the agents' screens and commands (`exec`), or with `tools` false
   * none of them: the setup that made this the server's computer offered each agent its own screen (ADR 0153 §6).
   */
  private writeHome(home: string, org: SyncedOrg, tools = true): boolean {
    let prev: StoredConfig = {};
    try {
      prev = readStoredConfig(home) ?? {};
    } catch {
      // unreadable: written again below
    }
    const token = org.token ?? prev.token;
    if (!token) return false;
    const uids = this.opts.system ? (prev.agentUidRange ?? this.freeBlock()) : undefined;
    if (this.opts.system && !uids) {
      this.opts.log(`[${tag(org.orgName, org.orgId)}] no agent uids left on this computer for another organization`);
      return false;
    }
    const exec = tools && this.opts.exec;
    const next: StoredConfig = {
      ...prev,
      server: this.opts.server,
      machineId: org.machineId,
      name: prev.name ?? this.opts.name,
      token,
      workspace: prev.workspace ?? this.workspaceFor(home, org),
      orgId: org.orgId,
      orgName: org.orgName,
      managedBy: "host",
      // What a new home allows; later changes (`agentes-runner tools`, the site) stay.
      ...(prev.workspace
        ? {}
        : {
            exec,
            access: {
              folders: [],
              tools: { claude: tools, codex: tools, commands: exec, browser: tools, desktop: tools },
            },
          }),
      ...(uids ? { mode: "system" as const, agentUidRange: uids } : {}),
    };
    if (serializeConfig(next) !== serializeConfig(prev)) writeConfig(next, home);
    return true;
  }

  /**
   * System mode: the workspace is root's own folder in the home (each agent
   * works in its own user's home). Otherwise a folder per organization in
   * the base, made now so the next organization's can't take the same one.
   */
  private workspaceFor(home: string, org: SyncedOrg): string {
    if (this.opts.system) return path.join(home, "work");
    const base = this.opts.workspaceBase ?? expandHome("~/agentes");
    const taken = new Set(this.homes().map((h) => h.config.workspace));
    let dir = uniqueWorkspace(base, org.orgName || org.orgId);
    if (taken.has(dir)) dir = uniqueWorkspace(base, `${org.orgName} ${org.orgId.slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The lowest block of uids no organization here has. */
  private freeBlock(): [number, number] | null {
    const taken = this.homes().flatMap((h) => (h.config.agentUidRange ? [h.config.agentUidRange] : []));
    const [first, last] = this.opts.uidRange ?? DEFAULT_AGENT_UID_RANGE;
    for (let a = first; a + HOST_UID_BLOCK - 1 <= last; a += HOST_UID_BLOCK) {
      const b = a + HOST_UID_BLOCK - 1;
      if (!taken.some(([x, y]) => x <= b && y >= a)) return [a, b];
    }
    return null;
  }

  /** The organizations' homes here and what each holds. */
  private homes(): { orgId: string; dir: string; config: StoredConfig }[] {
    let names: string[];
    try {
      names = readdirSync(this.orgsDir);
    } catch {
      return [];
    }
    return names.flatMap((orgId) => {
      if (!UUID.test(orgId)) return [];
      const dir = path.join(this.orgsDir, orgId);
      try {
        const config = readStoredConfig(dir);
        return config ? [{ orgId, dir, config }] : [];
      } catch {
        return [];
      }
    });
  }

  /** Starts the child now, or once its backoff ends; nothing when it runs or a start is set. */
  private launch(c: Child) {
    if (this.stopped || c.proc || c.timer) return;
    const wait = c.notBefore - Date.now();
    if (wait > 0) {
      c.timer = setTimeout(() => {
        c.timer = null;
        this.launch(c);
      }, wait);
      return;
    }
    c.startedAt = Date.now();
    let proc: HostChild;
    try {
      proc = this.opts.start(c.home, c.label);
    } catch (err) {
      this.opts.log(`[${c.label}] couldn't start its runner: ${err instanceof Error ? err.message : String(err)}`);
      this.exited(c, null, null);
      return;
    }
    c.proc = proc;
    this.opts.log(`[${c.label}] runner started`);
    void proc.exited.then((code) => this.exited(c, proc, code));
  }

  private exited(c: Child, proc: HostChild | null, code: number | null) {
    if (proc && c.proc !== proc) return;
    c.proc = null;
    if (this.stopped || this.children.get(c.orgId) !== c) return;
    c.attempt = Date.now() - c.startedAt >= CHILD_STABLE_MS ? 0 : c.attempt + 1;
    c.notBefore = c.attempt > 0 ? Date.now() + backoffDelay(c.attempt - 1) : 0;
    this.opts.log(`[${c.label}] runner stopped${code === null ? "" : ` (exit ${code})`}`);
    if (code === TOKEN_REFUSED_EXIT) {
      // Its token was refused: the next sync, now, brings a new one and starts it again.
      this.rotate.add(c.orgId);
      this.again = true;
      this.wake?.();
      return;
    }
    this.launch(c);
  }

  private drop(c: Child) {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    this.children.delete(c.orgId);
    c.proc?.kill();
  }

  private stopAll() {
    for (const c of [...this.children.values()]) this.drop(c);
  }

  /** The server says no (or there's no token): nothing runs until it says yes. */
  private idle(status: Exclude<HostStatus, "on" | "unreachable">, message: string) {
    this.setStatus(status, message);
    if (this.children.size > 0) this.opts.log(`stopping ${this.children.size} runner(s)`);
    this.stopAll();
  }

  private unreachable(message: string) {
    this.failures++;
    this.setStatus("unreachable", `can't reach ${this.opts.server} (${message}); trying again`);
  }

  /** Logs only changes, so a long outage is one line. */
  private setStatus(next: HostComputer["status"], message: string) {
    if (next === this.status) return;
    this.status = next;
    this.opts.log(message);
  }

  /** Waits `ms`, or until a refused child asks for a sync (`wake`). */
  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

/**
 * Where `host` keeps its homes without `--state`. On a Mac the agentes app keeps its own homes in
 * `<home>/orgs` and starts every one it finds there, so this server's go one folder down.
 */
export const defaultHostState = (platform: NodeJS.Platform = process.platform, home = runnerHome()) =>
  platform === "darwin" ? path.join(home, "host") : home;

/** `HOST_COMPUTER_TOKEN` from a file (the service's way: no secret in the unit), or null. */
export function readTokenFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** `agentes-runner start` in a home, its log lines in this process's log under the organization's name. */
export function runnerChild(command: string[], print: (line: string) => void): StartChild {
  return (home, label) => {
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTES_RUNNER_HOME: home };
    // Under launchd a refusal exits 0; here the host must see it (exit 2) to ask for a new token.
    delete env.AGENTES_RUNNER_SERVICE;
    const [file = "", ...args] = [...command, "start"];
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("error", () => {});
      readLines(
        stream,
        16 * 1024,
        (line) => print(`[${label}] ${line}`),
        () => print(`[${label}] (a log line too long was left out)`),
      );
    }
    const events = child as unknown as EventEmitter;
    const exited = new Promise<number | null>((resolve) => {
      events.once("exit", (code: number | null) => resolve(code));
      events.once("error", () => resolve(null));
    });
    return { exited, kill: (signal = "SIGTERM") => void child.kill(signal) };
  };
}
