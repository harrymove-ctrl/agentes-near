import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  type AccountKind,
  type AgentScope,
  isAccountId,
  LOAD_SAMPLE_MS,
  MACHINE_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  type MachineErrorCode,
  parseAccess,
  parsePause,
  type TurnContext,
} from "@agenteschat/adapters/machine-protocol";
import { realFoldersFor } from "./access";
import { agentAccountHome, grantOf, lentAccounts } from "./accounts";
import { BrainManager, turnContext } from "./brain";
import { CodexAppServers } from "./brain-codex-app";
import { BrowserManager, type BrowserManagerOptions, launchChrome } from "./browser";
import type { BrowserPorts } from "./browser-ports";
import { type Dial, RunnerConnection, type SocketHandlers } from "./connection";
import { DEFAULT_LIMITS, machineOs, prepareWorkspace } from "./daemon";
import { type DelegatedBridge, DelegatedTools, delegatedTask, parseBridge, type ToolNotice } from "./delegated-tools";
import { DesktopManager, type DesktopManagerOptions } from "./desktop";
import { RUNNER_VERSION, RunnerError, toMachineError } from "./errors";
import type { CacheFill, CloneSlots } from "./git";
import { type HandlerContext, handleRequest } from "./handlers";
import { currentProcess, isCompiled, selfCommand } from "./launch";
import { readLines } from "./lines";
import { McpBridge, type McpTaskInfo, mcpSocketPath } from "./mcp";
import { agentWorkspace } from "./paths";
import type { FetchLike } from "./push";
import { ENTER_MS, type ScopeKind, type Spawn, spawnGated } from "./scope-gate";
import { type ActivatedSecret, agentSecrets, dropStoredSiteSecrets, handleSecret, secretValue } from "./secrets";
import { AGENTS_CGROUP, agentCgroup, systemdBooted } from "./service";
import { systemStartPage } from "./start-page";
import {
  BROWSER_LEASE_MS,
  type BrainReclaimed,
  UPLOAD_CHUNK_BYTES,
  type WorkerDesktop,
  type WorkerDesktopUse,
  type WorkerLinkFrame,
  type WorkerState,
} from "./supervisor";
import { type HostedExit, TaskManager } from "./tasks";

/**
 * System mode: one agent's runner (`agentes-runner worker --agent <id>`),
 * started by the root supervisor through the agent's launcher, so all of it
 * runs as the agent's own OS user. The daemon's managers and handlers for
 * that agent only, over a link of JSON lines on stdin/stdout instead of the
 * server's socket (`supervisor.ts`): no pairing, service, tray or machine
 * token. Its home (`--home`: task journal, secrets, git credentials,
 * browser) is outside the agent's own home, its workspace (`--dir`).
 */

export interface WorkerOptions {
  agentId: string;
  /** The worker's own home. */
  home: string;
  /** The agent's home: the workspace its folder is made in. */
  dir: string;
  /** From the supervisor. */
  input: Readable;
  /** To the supervisor. */
  output: Writable;
  log: (line: string) => void;
  /** System mode: preguarded ports assigned from this worker's UID. */
  browserPorts?: BrowserPorts;
  /** How this runner starts itself (default: this process). */
  self?: { command: string[]; compiled: boolean };
  /** Tests: the computer desktop use sees, and how its helper starts. */
  desktop?: Pick<DesktopManagerOptions, "system" | "command">;
  /** Tests: how Claude Code starts for brain turns. */
  claudeCommand?: string[];
  /** Tests: how `agent-browser` and Chrome start, and Chrome's debugging endpoint. */
  browser?: Pick<
    BrowserManagerOptions,
    "command" | "chrome" | "startChrome" | "isOurChrome" | "fetch" | "windowDrawMs"
  >;
}

/**
 * Root answers for the agent's desktop within that desktop's start, whose steps each have a limit; an ask it never
 * answers would hold the agent's browser commands behind it.
 */
const DESKTOP_MS = 2 * 60_000;

/** Until the supervisor says otherwise, nothing is allowed. */
const NOTHING_ALLOWED: WorkerState = {
  access: { folders: [], tools: { claude: false, codex: false, commands: false } },
  paused: { paused: false },
  limits: { ...DEFAULT_LIMITS },
};

/** `worker.state` as the supervisor sends it (the config's limits are checked there); null when it isn't one. */
function parseWorkerState(f: Record<string, unknown>): WorkerState | null {
  const access = parseAccess(f.access);
  const paused = parsePause(f.paused);
  const limits = { ...DEFAULT_LIMITS, ...(f.limits as Partial<WorkerState["limits"]>) };
  const viewers = Number.isSafeInteger(f.desktopViewers) ? Math.max(0, f.desktopViewers as number) : 0;
  const account = f.account === null || isAccountId(f.account) ? { account: f.account } : {};
  const accounts = Array.isArray(f.accounts) ? { accounts: f.accounts.filter(isAccountId) } : {};
  const host = typeof f.commitHost === "string" && /^[a-z0-9.-]{1,253}$/i.test(f.commitHost) ? f.commitHost : null;
  const commitHost = host ? { commitHost: host } : {};
  return access && paused
    ? {
        access,
        paused,
        limits,
        desktopViewers: viewers,
        privateNetwork: f.privateNetwork === true,
        ...account,
        ...accounts,
        ...commitHost,
      }
    : null;
}

type PullFrame = Extract<WorkerLinkFrame, { type: "pull.head" | "pull.chunk" | "pull.end" }>;

/**
 * The worker's end of the link. Each dial is one session on the same pipes;
 * `worker.close` ends it (the supervisor's own session with the server
 * ended) and the connection dials again, saying hello.
 */
export class WorkerLink {
  private session: SocketHandlers | null = null;
  private readonly uploads = new Map<string, (reply: Extract<WorkerLinkFrame, { type: "upload.reply" }>) => void>();
  private readonly pulls = new Map<string, (frame: PullFrame) => void>();
  private readonly desktops = new Map<string, (reply: Extract<WorkerLinkFrame, { type: "desktop.ensured" }>) => void>();
  private nextEnsure = 0;
  private readonly enters = new Map<string, () => void>();
  private nextEnter = 0;
  private readonly slots = new Map<string, (waiting: boolean) => void>();
  private readonly fills = new Map<string, (dir: string | null) => void>();
  private nextGit = 0;
  onState: (state: WorkerState) => void = () => {};
  onDesktopTaken: () => void = () => {};
  /** Root: the agent's live view has room for its browser's next frame, or (`view` false) it has none. */
  onBrowserRoom: (agentId: string, view: boolean) => void = () => {};
  onSecretInstall: (id: string, agent: AgentScope, secret: ActivatedSecret) => void = () => {};
  /** Browser clicked on the agent's desktop, as root relays it: answered with `showing` and `shown`. */
  onShow: (showId: string, agent: AgentScope) => void = () => {};
  /**
   * Root needs room for a brain turn: with `peek`, what this agent would close (`BrainManager.idleCandidate`),
   * else whether an idle CLI of this agent's closed.
   */
  onReclaim: (ask: { spare?: string; peek: boolean }) => Promise<BrainReclaimed> = async () => ({ closed: false });
  /** A delegated CLI's bridge, or its end. */
  onBridge: (bridge: DelegatedBridge) => void = () => {};
  onTurnPrepare: (ask: { agent: AgentScope; cwd?: string; text: boolean }) => Promise<TurnContext> = async () => {
    throw new RunnerError("not_allowed", "This worker serves no turn of root's");
  };
  onTaskOut: (taskId: string, stream: "stdout" | "stderr", line: string) => void = () => {};
  onTaskExit: (taskId: string, session: string, exit: HostedExit) => void = () => {};
  onTurnCancel: (session: string) => void = () => {};
  onTurnDetach: (session: string) => void = () => {};
  /** The supervisor is gone (stdin closed). */
  onEnd: () => void = () => {};

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly desktopMs = DESKTOP_MS,
  ) {
    readLines(
      input,
      MAX_FRAME_BYTES + 1024,
      (line) => this.line(line),
      () => {},
    );
    input.once("end", () => this.ended());
    input.once("close", () => this.ended());
  }

  private ended() {
    this.unanswered("The runner is stopping. Try again in a minute.");
    // Root is gone: its slots and cache with it; the clones go on as they can.
    for (const granted of [...this.slots.values()]) granted(false);
    for (const filled of [...this.fills.values()]) filled(null);
    this.onEnd();
  }

  /** Desktops still asked for fail when the session or the link ends, as the work that asked for them does. */
  private unanswered(message: string) {
    for (const answer of [...this.desktops.values()]) {
      answer({ type: "desktop.ensured", ensureId: "", error: { code: "internal", message } });
    }
  }

  readonly dial: Dial = (_url, handlers) => {
    this.session = handlers;
    queueMicrotask(() => handlers.onOpen());
    return {
      send: (data) => this.write(data),
      close: () => this.end(handlers),
    };
  };

  private end(handlers: SocketHandlers | null) {
    if (!handlers || this.session !== handlers) return;
    this.session = null;
    this.unanswered("The computer lost its connection to agentes.chat");
    queueMicrotask(() => handlers.onClose(1000, ""));
  }

  private write(data: string) {
    this.output.write(`${data}\n`);
  }

  private line(line: string) {
    let f: Record<string, unknown> | null = null;
    try {
      f = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (f?.type) {
      case "worker.close":
        this.end(this.session);
        return;
      case "worker.state": {
        const state = parseWorkerState(f);
        if (state) this.onState(state);
        return;
      }
      case "desktop.taken":
        this.onDesktopTaken();
        return;
      case "browser.room":
        if (typeof f.agentId === "string") this.onBrowserRoom(f.agentId, f.view === true);
        return;
      case "upload.reply":
        if (typeof f.uploadId === "string") this.uploads.get(f.uploadId)?.(f as never);
        return;
      case "pull.head":
      case "pull.chunk":
      case "pull.end":
        if (typeof f.pullId === "string") this.pulls.get(f.pullId)?.(f as never);
        return;
      case "desktop.ensured":
        if (typeof f.ensureId === "string") this.desktops.get(f.ensureId)?.(f as never);
        return;
      case "clone.slotted":
        if (typeof f.slotId === "string") this.slots.get(f.slotId)?.(f.waiting === true);
        return;
      case "cache.filled":
        if (typeof f.fillId === "string") this.fills.get(f.fillId)?.(typeof f.dir === "string" ? f.dir : null);
        return;
      case "scope.entered":
        if (typeof f.enterId === "string") this.enters.get(f.enterId)?.();
        return;
      case "secret.install":
        if (
          typeof f.installId === "string" &&
          f.agent &&
          typeof f.agent === "object" &&
          f.secret &&
          typeof f.secret === "object"
        )
          this.onSecretInstall(f.installId, f.agent as AgentScope, f.secret as ActivatedSecret);
        return;
      case "brain.reclaim":
        if (typeof f.reclaimId === "string") {
          const reclaimId = f.reclaimId.slice(0, 64);
          const ask = { ...(typeof f.spare === "string" ? { spare: f.spare } : {}), peek: f.peek === true };
          void this.onReclaim(ask)
            .catch(() => ({ closed: false }))
            .then((out) =>
              this.write(JSON.stringify({ type: "brain.reclaimed", reclaimId, ...out } satisfies WorkerLinkFrame)),
            );
        }
        return;
      case "bridge.token": {
        const bridge = parseBridge(f);
        if (bridge) this.onBridge(bridge);
        return;
      }
      case "turn.prepare": {
        const agent = f.agent as Partial<AgentScope> | undefined;
        if (typeof f.prepareId !== "string" || typeof agent?.id !== "string" || typeof agent.handle !== "string")
          return;
        const prepareId = f.prepareId.slice(0, 64);
        const ask = {
          agent: agent as AgentScope,
          ...(typeof f.cwd === "string" ? { cwd: f.cwd } : {}),
          text: f.text === true,
        };
        void this.onTurnPrepare(ask).then(
          (context) => this.write(JSON.stringify({ type: "turn.context", prepareId, ...context })),
          (err: unknown) => this.write(JSON.stringify({ type: "turn.context", prepareId, error: toMachineError(err) })),
        );
        return;
      }
      case "task.out":
        if (typeof f.taskId === "string" && typeof f.line === "string") {
          this.onTaskOut(f.taskId, f.stream === "stderr" ? "stderr" : "stdout", f.line);
        }
        return;
      case "task.exit":
        if (typeof f.taskId === "string") {
          const { exitCode, signal, reason, error } = f as unknown as HostedExit;
          const session = typeof f.session === "string" ? f.session : "";
          this.onTaskExit(f.taskId, session, { exitCode, signal, reason, ...(error ? { error } : {}) });
        }
        return;
      case "turn.cancel":
        if (typeof f.session === "string") this.onTurnCancel(f.session);
        return;
      case "turn.detach":
        if (typeof f.session === "string") this.onTurnDetach(f.session);
        return;
      case "browser.show": {
        const agent = f.agent as Partial<AgentScope> | undefined;
        if (typeof f.showId === "string" && typeof agent?.id === "string" && typeof agent.handle === "string") {
          this.onShow(f.showId, agent as AgentScope);
        }
        return;
      }
      default:
        this.session?.onMessage(line);
    }
  }

  bridgeReady(process: string, error?: string) {
    this.write(
      JSON.stringify({ type: "bridge.ready", process, ...(error ? { error } : {}) } satisfies WorkerLinkFrame),
    );
  }

  toolNotice(notice: ToolNotice) {
    this.write(JSON.stringify({ type: "tool.notice", ...notice } satisfies WorkerLinkFrame));
  }

  taskStop(taskId: string) {
    this.write(JSON.stringify({ type: "task.stop", taskId } satisfies WorkerLinkFrame));
  }

  /** `agent-browser` downloads first, for that click. */
  showing(showId: string) {
    this.write(JSON.stringify({ type: "browser.showing", showId } satisfies WorkerLinkFrame));
  }

  /** The agent's Chrome is on its desktop, or why it isn't. */
  shown(showId: string, error?: { code: MachineErrorCode; message: string }) {
    this.write(
      JSON.stringify({ type: "browser.shown", showId, ...(error ? { error } : {}) } satisfies WorkerLinkFrame),
    );
  }

  secretInstalled(
    installId: string,
    result: { size?: number; superseded?: boolean } | { error: { code: MachineErrorCode; message: string } },
  ) {
    this.write(JSON.stringify({ type: "secret.installed", installId, ...result } satisfies WorkerLinkFrame));
  }

  /**
   * The agent's desktop (root's, ADR 0058 §10), started when it isn't running: the supervisor answers only
   * while this worker serves a request that uses it that way.
   */
  desktop(use: WorkerDesktopUse): Promise<WorkerDesktop> {
    const ensureId = String(++this.nextEnsure);
    return new Promise((resolve, reject) => {
      const late = setTimeout(() => {
        const error = { code: "internal" as const, message: "The agent's desktop didn't start in time" };
        this.desktops.get(ensureId)?.({ type: "desktop.ensured", ensureId, error });
      }, this.desktopMs);
      this.desktops.set(ensureId, (reply) => {
        clearTimeout(late);
        this.desktops.delete(ensureId);
        if (reply.desktop) resolve(reply.desktop);
        else reject(new RunnerError(reply.error?.code ?? "internal", reply.error?.message ?? "No desktop"));
      });
      this.write(JSON.stringify({ type: "desktop.ensure", ensureId, use } satisfies WorkerLinkFrame));
    });
  }

  /** Its agent's Chrome is in use on the agent's desktop: root doesn't stop that desktop as idle for a while. */
  browserOnDesktop() {
    this.write(JSON.stringify({ type: "browser.desktop" } satisfies WorkerLinkFrame));
  }

  /**
   * Root moves its process `pid` (held, `scope-gate.ts`) into the agent's slice for `kind`: settles once root
   * answered, whatever it says, or after `ENTER_MS` (a root that doesn't know the frame never answers).
   */
  readonly enterScope = (pid: number, kind: ScopeKind): Promise<void> => {
    const enterId = String(++this.nextEnter);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(late);
        this.enters.delete(enterId);
        resolve();
      };
      const late = setTimeout(done, ENTER_MS);
      late.unref?.();
      this.enters.set(enterId, done);
      this.write(JSON.stringify({ type: "scope.enter", enterId, pid, kind } satisfies WorkerLinkFrame));
    });
  };

  /** One of the computer's clone slots, from root (ADR 0116): every agent's clones count against one cap. */
  readonly cloneSlot: CloneSlots = (onWait) => {
    const slotId = String(++this.nextGit);
    return new Promise((resolve) => {
      this.slots.set(slotId, (waiting) => {
        if (waiting) return onWait();
        this.slots.delete(slotId);
        resolve(() => this.write(JSON.stringify({ type: "clone.release", slotId } satisfies WorkerLinkFrame)));
      });
      this.write(JSON.stringify({ type: "clone.slot", slotId } satisfies WorkerLinkFrame));
    });
  };

  /** Root's shared cache (`systemGitCache`), filled with this agent's GitHub token; null when there's none. */
  readonly cacheFill: CacheFill = (input) => {
    const fillId = String(++this.nextGit);
    return new Promise((resolve) => {
      this.fills.set(fillId, (dir) => {
        this.fills.delete(fillId);
        resolve(dir);
      });
      this.write(JSON.stringify({ type: "cache.fill", fillId, ...input } satisfies WorkerLinkFrame));
    });
  };

  /** A turn's plan usage, for root to keep with the account (root takes it only for a turn it sent here). */
  usage(kind: AccountKind, account: string, info: unknown) {
    this.write(JSON.stringify({ type: "usage", kind, account, info } satisfies WorkerLinkFrame));
  }

  /** A ChatGPT sign-in root keeps, refreshed by this agent's Codex: root takes it only for a turn it sent here. */
  codexAuth(account: string, auth: string) {
    this.write(JSON.stringify({ type: "codex.auth", account, auth } satisfies WorkerLinkFrame));
  }

  /** What its agent's Chrome sent and received since the last time (protocol 23); nothing when it moved nothing. */
  traffic({ up, down }: { up: number; down: number }) {
    if (up > 0 || down > 0) this.write(JSON.stringify({ type: "browser.traffic", up, down } satisfies WorkerLinkFrame));
  }

  /**
   * `push` and `pull` without the machine token: the supervisor makes the request to the URL of the server's own
   * request, which also keeps it off the route the agent's programs take, and the bytes cross the link in pieces.
   */
  readonly fetch: FetchLike = (_url, init) => {
    const headers = new Headers(init.headers as Record<string, string>);
    if (init.method === "GET") return this.pull(headers.get("x-agentes-pull-id") ?? "", init.signal ?? undefined);
    const uploadId = headers.get("x-agentes-upload-id") ?? "";
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array();
    const signal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const done = () => {
        this.uploads.delete(uploadId);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        done();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Canceled"));
      };
      this.uploads.set(uploadId, (reply) => {
        done();
        const status = reply.status ?? 0;
        if (typeof reply.error === "string") reject(new Error(reply.error));
        else resolve(new Response(reply.body ?? "", { status: status >= 200 && status <= 599 ? status : 502 }));
      });
      signal?.addEventListener("abort", abort, { once: true });
      for (let at = 0; at < body.byteLength; at += UPLOAD_CHUNK_BYTES) {
        const data = Buffer.from(body.subarray(at, at + UPLOAD_CHUNK_BYTES)).toString("base64");
        this.write(JSON.stringify({ type: "upload.chunk", uploadId, data } satisfies WorkerLinkFrame));
      }
      this.write(
        JSON.stringify({
          type: "upload.end",
          uploadId,
          contentType: headers.get("content-type") ?? "",
          name: headers.get("x-agentes-file-name") ?? "",
          sha256: headers.get("x-agentes-sha256") ?? "",
        } satisfies WorkerLinkFrame),
      );
    });
  };

  private pull(pullId: string, signal?: AbortSignal) {
    return new Promise<Response>((resolve, reject) => {
      let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
      const done = () => {
        this.pulls.delete(pullId);
        signal?.removeEventListener("abort", abort);
      };
      const fail = (error: Error) => {
        done();
        reject(error);
        sink?.error(error);
      };
      const abort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("Canceled"));
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          sink = controller;
        },
        cancel: done,
      });
      this.pulls.set(pullId, (f) => {
        if (f.type === "pull.head") resolve(new Response(body, { status: f.status }));
        else if (f.type === "pull.chunk") sink?.enqueue(Buffer.from(f.data, "base64"));
        else if (f.error === undefined) {
          done();
          sink?.close();
        } else fail(new Error(f.error));
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.write(JSON.stringify({ type: "pull.start", pullId } satisfies WorkerLinkFrame));
    });
  }
}

/** Runs the worker until the supervisor goes away; its background tasks keep running (ADR 0029). */
export async function runWorker(o: WorkerOptions): Promise<number> {
  const { home, log } = o;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const workspaceReal = prepareWorkspace(o.dir);
  const self = o.self ?? { command: selfCommand(currentProcess()), compiled: isCompiled(currentProcess()) };
  const secretsDir = path.join(home, "secrets");
  // Site passwords live in memory now (ADR 0144): one an older runner kept on disk goes.
  void dropStoredSiteSecrets(secretsDir);
  const socketPath = mcpSocketPath(home);
  const mcpCommand = { socketPath, command: self.command };
  let state = NOTHING_ALLOWED;
  const link = new WorkerLink(o.input, o.output);
  link.onSecretInstall = (installId, agent, secret) => {
    if (agent.id !== o.agentId) {
      link.secretInstalled(installId, { error: { code: "not_allowed", message: "This worker serves another agent" } });
      return;
    }
    void agentWorkspace(workspaceReal, agent)
      .then((folder) => handleSecret(secretsDir, agent, folder, secret))
      .then(
        (result) => link.secretInstalled(installId, result),
        (error: unknown) => link.secretInstalled(installId, { error: toMachineError(error) }),
      );
  };
  // Under systemd the agent's Chrome and AI CLIs start in slices of their own, root moving them there first.
  const gated = (kind: ScopeKind): Spawn | undefined =>
    systemdBooted() ? (file, args, options) => spawnGated(kind, file, args, options, link.enterScope) : undefined;
  const cli = gated("cli");
  const chrome = gated("browser");
  // The account folders root lends to this agent's user for its turns and tasks (`AccountManager.lendTo`), and its
  // own folder for an account root keeps, whose credential comes with each turn and task (`AccountManager.grant`).
  // What the turns say about the plan's usage goes to root, which keeps the accounts.
  const accounts = {
    ...lentAccounts(),
    agentHome: (kind: AccountKind, id: string) => agentAccountHome(home, kind, id),
    noteRateLimit: (account: string, info: unknown) => link.usage("claude_code", account, info),
    codexAuth: (account: string, auth: string) => link.codexAuth(account, auth),
  };
  const tasks = new TaskManager({
    mcp: mcpCommand,
    root: path.join(home, "tasks"),
    workspaceReal,
    maxConcurrent: state.limits.maxConcurrentTasks,
    defaultMaxSeconds: state.limits.taskMaxSeconds,
    log,
    agentFolder: (agent) => agentWorkspace(workspaceReal, agent),
    secrets: (agent) => agentSecrets(secretsDir, agent),
    accounts,
    ...(self.compiled ? { wrapperCommand: [...self.command, "task-wrapper"] } : {}),
    ...(cli ? { spawnCli: cli } : {}),
    hostedStop: (taskId) => link.taskStop(taskId),
    commitHost: () => state.commitHost,
  });
  link.onTaskOut = (taskId, stream, line) => tasks.hostedOutput(taskId, stream, line);
  await tasks.init();
  const brainLimits = () => ({
    idleMs: state.limits.brainIdleMinutes * 60_000,
    maxProcesses: state.limits.brainMaxProcesses,
  });
  const brains = new BrainManager({
    root: path.join(home, "brains"),
    mcp: mcpCommand,
    accounts,
    ...(o.claudeCommand ? { claudeCommand: o.claudeCommand } : {}),
    ...brainLimits(),
    ...(cli ? { spawn: cli } : {}),
    log,
  });
  const codexRuns = new Map<string, McpTaskInfo>();
  const codexApp = new CodexAppServers({
    runs: codexRuns,
    ...brainLimits(),
    ...(cli ? { spawn: cli } : {}),
    onRateLimits: (account, rateLimits) => {
      if (account) link.usage("codex", account, rateLimits);
    },
    log,
  });
  // Claude Code's own tools for a CLI root runs on a shared sign-in: nothing here until root opens a bridge.
  const delegatedRuns = new Map<string, McpTaskInfo>();
  const delegated = new DelegatedTools({
    secrets: () => agentSecrets(secretsDir, { id: o.agentId, handle: "agent" }),
    onNotice: (notice) => link.toolNotice(notice),
    onDenied: (session, tool, input) => tasks.hostedDenial(session, tool, input),
    ...(cli ? { spawn: cli } : {}),
    log,
  });
  const openBridge = async (bridge: DelegatedBridge) => {
    const { token } = bridge;
    if (token === null || bridge.agent.id !== o.agentId) {
      delegatedRuns.delete(bridge.process);
      return;
    }
    if (bridge.socketPath) await mcp.listenForRelays(bridge.socketPath);
    const [folder, grants, secrets] = await Promise.all([
      agentWorkspace(workspaceReal, bridge.agent),
      realFoldersFor(state.access, o.agentId),
      agentSecrets(secretsDir, bridge.agent),
    ]);
    const where = { folder, grants, runnerHome: home, ...(secrets ? { redact: secrets.redact } : {}) };
    delegatedRuns.set(bridge.process, delegatedTask({ ...bridge, token }, delegated, where));
    link.bridgeReady(bridge.process);
  };
  // In order: a turn's frame must not land after the next turn's, which would leave its tools with no run.
  let bridging: Promise<void> = Promise.resolve();
  link.onBridge = (bridge) => {
    bridging = bridging.then(() =>
      openBridge(bridge).catch((err: unknown) => {
        const said = err instanceof Error ? err.message : String(err);
        log(`delegated tools: ${said}`);
        link.bridgeReady(bridge.process, said);
      }),
    );
  };
  link.onTurnPrepare = async ({ agent, cwd, text }) => {
    if (agent.id !== o.agentId) throw new RunnerError("not_allowed", "This worker serves another agent");
    const [folder, grants] = await Promise.all([
      agentWorkspace(workspaceReal, agent),
      realFoldersFor(state.access, o.agentId),
    ]);
    return turnContext({ folder, grants, ...(cwd ? { cwd } : {}), text });
  };
  link.onTaskExit = (taskId, session, exit) => {
    tasks.hostedExit(taskId, exit);
    delegated.endSession(session);
  };
  link.onTurnCancel = (session) => delegated.cancel(session);
  link.onTurnDetach = (session) => delegated.detach(session);
  const mcp = new McpBridge({
    socketPath,
    task: (taskId) =>
      tasks.mcpTask(taskId) ?? brains.mcpTask(taskId) ?? codexRuns.get(taskId) ?? delegatedRuns.get(taskId) ?? null,
    log,
  });
  await mcp
    .listen()
    .catch((err: unknown) => log(`mission tools unavailable: ${err instanceof Error ? err.message : String(err)}`));
  let live: RunnerConnection | null = null;
  // The desktop is root's: this worker's helper and Chrome run on it as the agent's own user, where root says.
  let desktop: WorkerDesktop | null = null;
  const ensureDesktop = (use: WorkerDesktopUse) => async () => {
    desktop = await link.desktop(use);
    return desktop;
  };
  // Root doesn't stop the desktop as idle while the agent's Chrome on it is in use: said after each change and
  // renewed well within the lease.
  const lease = () => {
    if (browser.onDesktopInUse(o.agentId)) link.browserOnDesktop();
  };
  // Agents whose live view is root's (ADR 0040 §7.1): their stream's next frame waits for root's `browser.room`.
  const viewed = new Set<string>();
  const browser = new BrowserManager({
    home,
    privateNetwork: () => state.privateNetwork === true,
    ...(o.browserPorts
      ? {
          fixedPorts: o.browserPorts,
          startPageDirectory: systemStartPage(process.getuid?.() ?? 0),
          installedByRoot: true,
        }
      : {}),
    log,
    send: (frame) => live?.send(frame) ?? false,
    frameRoom: (agentId) => !viewed.has(agentId),
    secret: (agent, name) => secretValue(secretsDir, agent, name),
    desktops: {
      ensure: ensureDesktop("browser"),
      session: () => desktop,
      status: () => ({ running: desktop !== null, streams: state.desktopViewers ?? 0 }),
    },
    onChange: () => queueMicrotask(lease),
    ...(chrome ? { startChrome: (exe, args, profile, env) => launchChrome(exe, args, profile, env, chrome) } : {}),
    // The agents share their memory (`agentLimits`): the limit a page dies at is all of theirs.
    memoryEvents: {
      agent: path.join(agentCgroup(process.getuid?.() ?? 0), "memory.events"),
      agents: path.join(AGENTS_CGROUP, "memory.events"),
    },
    ...o.browser,
  });
  const leases = setInterval(lease, BROWSER_LEASE_MS / 3);
  leases.unref?.();
  // Root sums its agents' browsers' traffic for the computer's own count.
  const counted = setInterval(() => link.traffic(browser.takeTraffic()), LOAD_SAMPLE_MS);
  counted.unref?.();
  void browser.closeAll();
  link.onReclaim = async ({ spare, peek }) => {
    if (!peek) return { closed: await brains.reclaimIdle(spare) };
    const idle = brains.idleCandidate(spare);
    return { closed: false, ...(idle ? { idle } : {}), ...(spare && brains.warm(spare) ? { warm: true } : {}) };
  };
  link.onBrowserRoom = (agentId, view) => {
    if (view) viewed.add(agentId);
    else viewed.delete(agentId);
    browser.room(agentId);
  };
  link.onDesktopTaken = () => {
    desktopUse.stopInput(o.agentId);
    // Its Chrome may be a window on that desktop.
    browser.stopInput(o.agentId);
  };
  link.onShow = (showId, agent) => {
    const shown =
      agent.id === o.agentId
        ? agentWorkspace(workspaceReal, agent).then((folder) => browser.show(agent, folder, () => link.showing(showId)))
        : Promise.reject(new RunnerError("not_allowed", "This worker serves another agent"));
    shown.then(
      () => link.shown(showId),
      (err: unknown) => link.shown(showId, toMachineError(err)),
    );
  };
  const own = process.getuid?.() ?? null;
  const desktopUse = new DesktopManager({
    desktops: {
      // Root's hello says whether the computer can; a worker reports nothing.
      info: () => ({ available: true }),
      ensure: ensureDesktop("desktop"),
      session: () => desktop,
    },
    uids: () => (own === null ? null : { runner: 0, agents: new Map([[o.agentId, own]]) }),
    secrets: (agent) => agentSecrets(secretsDir, agent),
    browserPid: (agentId) => browser.chromePid(agentId),
    log,
    ...o.desktop,
  });
  const context: HandlerContext = {
    workspaceReal,
    get exec() {
      return state.access.tools.commands;
    },
    token: "",
    fetch: link.fetch,
    secretsDir,
    gitDir: path.join(home, "git"),
    cloneSlot: link.cloneSlot,
    cacheFill: link.cacheFill,
    tasks,
    brains,
    codex: {
      runnerHome: home,
      mcp: mcpCommand,
      runs: codexRuns,
      app: codexApp,
      accounts,
      ...(cli ? { spawn: cli } : {}),
    },
    paused: () => state.paused.paused,
    access: () => state.access,
    // The workspace a worker is given is its agent's home (`workerCommand`).
    ownHome: workspaceReal,
    browser,
    desktopUse,
  };
  const connection = new RunnerConnection({
    url: "supervisor",
    token: "",
    info: () => ({
      version: RUNNER_VERSION,
      protocol: MACHINE_PROTOCOL_VERSION,
      os: machineOs(),
      arch: os.arch(),
      hostname: os.hostname(),
      workspace: workspaceReal,
      exec: state.access.tools.commands,
    }),
    context,
    mcp,
    log,
    dial: link.dial,
    handler: (ctx, req, scope) => {
      if (req.agent?.id !== o.agentId) {
        return Promise.reject(new RunnerError("not_allowed", "This worker serves another agent"));
      }
      // Root's, on the request it relays (it never passes on one the server sent).
      const grant = grantOf((req as { grant?: unknown }).grant);
      return handleRequest(grant ? { ...ctx, grant } : ctx, req, scope);
    },
    onBrowserHandoff: (frame) => browser.setHandoff(frame.agentId, frame.handoff),
    onState: (s) => {
      if (s === "online") return;
      browser.stopStreams();
      // Root's views went with the session: the next one says again.
      viewed.clear();
      browser.clearHandoffs();
    },
  });
  live = connection;
  link.onState = (next) => {
    const browserOff = state.access.tools.browser === true && next.access.tools.browser !== true;
    // Desktop use needs both switches: its helpers stop with either.
    const use = (s: WorkerState) => s.access.tools.desktop === true && s.access.tools.commands;
    if (use(state) && !use(next)) desktopUse.stopAll();
    state = next;
    tasks.setLimits({ maxConcurrent: next.limits.maxConcurrentTasks, defaultMaxSeconds: next.limits.taskMaxSeconds });
    brains.setLimits(brainLimits());
    codexApp.setLimits(brainLimits());
    if (next.account !== undefined) {
      brains.keepAccount(next.account, next.accounts);
      tasks.keepAccount(next.account, next.accounts);
    }
    // The browser switch went off: the agent's browser closes now, not at its next command.
    if (browserOff) void browser.closeAll();
  };
  link.onEnd = () => connection.stop();
  log(`agentes-runner ${RUNNER_VERSION}: worker of agent ${o.agentId} (folder ${workspaceReal})`);
  await connection.run();
  clearInterval(leases);
  clearInterval(counted);
  desktopUse.stopAll();
  tasks.close();
  brains.close();
  codexApp.close();
  delegated.close();
  await browser.close().catch(() => undefined);
  link.traffic(browser.takeTraffic());
  await mcp.close().catch(() => undefined);
  return 0;
}
