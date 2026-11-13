import {
  type BrowserTraffic,
  HEARTBEAT_MS,
  type MachineEgress,
  type MachineLoad,
  type MachineRequest,
  parseServerFrame,
  type RunnerFrame,
  type RunnerInfo,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { type HandlerContext, handleRequest, type RequestObserver, RequestRunner } from "./handlers";
import type { McpBridge } from "./mcp";

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/** What a transport tells the connection. */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
}

export interface Socket {
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(): void;
}

/** Opens a socket (real WebSocket in the runner, a fake in tests). */
export type Dial = (url: string, handlers: SocketHandlers) => Socket;

/** The global WebSocket (Node 22+ and Bun both have it). */
export const webSocketDial: Dial = (url, handlers) => {
  if (typeof WebSocket === "undefined") {
    throw new Error("This runtime has no WebSocket client. Use Node.js 22 or newer, or Bun.");
  }
  const ws = new WebSocket(url);
  let closed = false;
  const decoder = new TextDecoder();
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (ev) => {
    const data: unknown = ev.data;
    if (typeof data === "string") handlers.onMessage(data);
    else if (data instanceof ArrayBuffer) handlers.onMessage(decoder.decode(data));
    else if (ArrayBuffer.isView(data)) handlers.onMessage(decoder.decode(data as Uint8Array));
  });
  ws.addEventListener("close", (ev) => {
    if (closed) return;
    closed = true;
    handlers.onClose(ev.code, ev.reason);
  });
  // An `error` is always followed by `close`; the watchdog covers the rest.
  ws.addEventListener("error", () => {});
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => ws.send(data),
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
};

/** 1 s, 2 s, 4 s… up to 60 s, each ±20 %. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
  return Math.min(BACKOFF_MAX_MS, Math.round(base * (0.8 + 0.4 * random())));
}

/** Why `run()` ended: the CLI exits with `exitCode`. */
export interface ConnectionOutcome {
  exitCode: number;
  reason: "invalid_token" | "revoked" | "outdated" | "replaced" | "stopped";
  message: string;
}

/** `start`'s exit code when the server refuses the token (unknown or revoked): only a new token helps. */
export const TOKEN_REFUSED_EXIT = 2;

const REFUSED_EXIT: Record<Exclude<ConnectionOutcome["reason"], "stopped">, number> = {
  invalid_token: TOKEN_REFUSED_EXIT,
  revoked: TOKEN_REFUSED_EXIT,
  outdated: 3,
  replaced: 0,
};

export interface ConnectionOptions {
  /** `wss://…/api/machines/connect`. */
  url: string;
  token: string;
  /** What `hello` says; a function is asked again for each `hello` (pause and access change over time). */
  info: RunnerInfo | (() => RunnerInfo);
  context: HandlerContext;
  dial?: Dial;
  log?: (line: string) => void;
  random?: () => number;
  /** Runs requests instead of `handleRequest` (tests: a fake; a worker: only its own agent's). */
  handler?: typeof handleRequest;
  /**
   * Background tasks (protocol 4): `hello` carries their journal, each
   * `welcome` re-sends every `task.done` not yet acknowledged, `task.ack`
   * marks one delivered. Defaults to `context.tasks`.
   */
  tasks?: Pick<NonNullable<HandlerContext["tasks"]>, "list" | "attach" | "detach" | "ack">;
  /** Protocol 5: the local MCP endpoint of mission tasks; its calls go out while connected. */
  mcp?: Pick<McpBridge, "attach" | "detach" | "result"> & Partial<Pick<McpBridge, "tools">>;
  /** Protocol 7: the coding CLIs on the machine, looked up for each `hello` (cached by the caller). */
  executors?: () => RunnerInfo["executors"];
  /** Protocol 22: the last day's load; each new summary goes out once, on the next `pong`. */
  load?: () => MachineLoad | null;
  /** Protocol 23: the agents' browsers' last day of traffic, the same way. */
  browserTraffic?: () => BrowserTraffic | null;
  egress?: () => MachineEgress | null;
  /** Called after each `welcome` (frames sent from here on reach the server). */
  onWelcome?: (welcome: { machineId: string; name: string; heartbeatMs: number; observeEgress: boolean }) => void;
  /** Protocol 9: the server's `agents` frame (the agents that use this machine). */
  onAgents?: (agents: unknown, deleted: unknown) => void;
  /** Protocol 12: a person's turn in an agent's browser started, changed or ended (`browser.handoff`). */
  onBrowserHandoff?: (frame: Extract<ServerFrame, { type: "browser.handoff" }>) => void;
  /** The socket's state: dialing, welcomed, or down (reconnecting). */
  onState?: (state: "connecting" | "online" | "offline") => void;
  /** Sees every request start and end (the desktop app's jobs, the activity log). */
  observer?: RequestObserver;
}

/** A watchdog firing this much later than asked means the process was suspended (sleep), not a silent server. */
const SUSPENDED_AFTER_MS = 30_000;

interface SessionEnd {
  welcomed: boolean;
  outcome?: ConnectionOutcome;
}

/**
 * Keeps one connection to the server: `hello` first, `pong` for each `ping`,
 * requests run concurrently, reconnects with backoff, and reconnects when no
 * ping arrives for two heartbeats. Ends only when the server refuses the
 * runner or `stop()` is called.
 */
export class RunnerConnection {
  private stopped = false;
  /** `reconnect()` was asked: the next dial goes out at once (no backoff). */
  private redial = false;
  private endSession?: () => void;
  private wake?: () => void;
  /** The welcomed session's sender (null while connecting or down). */
  private live: ((frame: RunnerFrame) => void) | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ConnectionOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** Whether a session is welcomed right now. */
  get online() {
    return this.live !== null;
  }

  /** Sends a frame on the welcomed session; false when not connected (the next `hello` carries the state). */
  send(frame: RunnerFrame): boolean {
    if (!this.live) return false;
    this.live(frame);
    return true;
  }

  async run(): Promise<ConnectionOutcome> {
    let attempt = 0;
    while (!this.stopped) {
      const end = await this.session();
      if (end.outcome) return end.outcome;
      if (this.stopped) break;
      if (this.redial) {
        this.redial = false;
        attempt = 0;
        this.log("reconnecting now (asked by the app)");
        continue;
      }
      if (end.welcomed) attempt = 0;
      const delay = backoffDelay(attempt, this.opts.random);
      attempt++;
      this.log(`disconnected; reconnecting in ${(delay / 1000).toFixed(1)} s`);
      await this.sleep(delay);
    }
    return { exitCode: 0, reason: "stopped", message: "stopped" };
  }

  /**
   * Drops the socket and dials again at once (the app's "Reconnect"): what
   * runs on this session is aborted like on any disconnect (the server
   * resumes an interrupted agent turn when the new socket says hello).
   */
  reconnect() {
    if (this.stopped) return;
    if (this.endSession) {
      this.redial = true;
      this.endSession();
    } else this.wake?.(); // waiting out a backoff: dial now
  }

  /** Closes the socket, aborts running requests and makes `run()` return. */
  stop() {
    this.stopped = true;
    this.endSession?.();
    this.wake?.();
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    }).finally(() => {
      this.wake = undefined;
    });
  }

  private session(): Promise<SessionEnd> {
    return new Promise<SessionEnd>((resolve) => {
      const { opts, log } = this;
      let socket: Socket | undefined;
      let welcomed = false;
      let finished = false;
      let outcome: ConnectionOutcome | undefined;
      let heartbeatMs = HEARTBEAT_MS;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let sentLoad: MachineLoad | null = null;
      let sentTraffic: BrowserTraffic | null = null;
      let sentEgress: MachineEgress | null = null;
      let observeEgress = false;

      const send = (frame: RunnerFrame) => {
        if (finished || !socket) return;
        if (frame.type === "pong" && frame.egress && !observeEgress) {
          const { egress: _, ...privateFrame } = frame;
          frame = privateFrame;
        }
        // Browser pictures are independent JPEG frames: skip stale pictures while the link is backed up.
        // Results, heartbeats and input keep their normal ordered delivery.
        if (frame.type === "browser.frame" && (socket.bufferedAmount ?? 0) > 2 * 1024 * 1024) return;
        try {
          socket.send(JSON.stringify(frame));
          if (frame.type === "pong" && frame.egress) sentEgress = frame.egress;
        } catch {
          // closing; the session ends on `close`
        }
      };
      const runner = new RequestRunner(
        opts.context,
        send,
        log,
        opts.handler ?? handleRequest,
        undefined,
        opts.observer,
      );
      const tasks = opts.tasks ?? opts.context.tasks;

      const end = () => {
        if (finished) return;
        finished = true;
        if (watchdog) clearTimeout(watchdog);
        if (this.live === send) this.live = null;
        runner.close();
        tasks?.detach();
        opts.mcp?.detach();
        socket?.close();
        this.endSession = undefined;
        opts.onState?.("offline");
        resolve({ welcomed, outcome });
      };
      const arm = () => {
        if (watchdog) clearTimeout(watchdog);
        const armedAt = Date.now();
        watchdog = setTimeout(() => {
          // Fired much later than asked: this process was suspended (the Mac slept), not the server gone quiet.
          const late = Date.now() - armedAt - 2 * heartbeatMs;
          log(
            late > SUSPENDED_AFTER_MS
              ? `no ping from the server: this computer was asleep for about ${Math.round(late / 1000)} s; reconnecting`
              : "no ping from the server; reconnecting",
          );
          end();
        }, 2 * heartbeatMs);
      };

      const onFrame = (raw: string) => {
        const frame = parseServerFrame(raw);
        if (!frame) {
          log("ignored a frame the runner doesn't understand");
          return;
        }
        switch (frame.type) {
          case "welcome": {
            welcomed = true;
            observeEgress = frame.observeEgress === true;
            if (typeof frame.heartbeatMs === "number" && frame.heartbeatMs > 0) heartbeatMs = frame.heartbeatMs;
            log(`connected as ${frame.name}`);
            arm();
            this.live = send;
            opts.onState?.("online");
            opts.onWelcome?.({ machineId: frame.machineId, name: frame.name, heartbeatMs, observeEgress });
            // First: a supervisor passes what this server does with a repeated call on to its workers' welcome.
            opts.mcp?.attach(send, { mcpOnce: frame.mcpOnce === true });
            tasks?.attach(send);
            return;
          }
          case "agents":
            opts.onAgents?.(frame.agents, frame.deleted);
            return;
          case "browser.handoff":
            opts.onBrowserHandoff?.(frame);
            return;
          case "mcp.result":
            opts.mcp?.result(frame);
            return;
          case "mcp.tools":
            opts.mcp?.tools?.(frame);
            return;
          case "task.ack":
            tasks?.ack(frame.taskId);
            return;
          case "ping": {
            const load = opts.load?.() ?? null;
            const traffic = opts.browserTraffic?.() ?? null;
            const egress = observeEgress ? (opts.egress?.() ?? null) : null;
            send({
              type: "pong",
              at: frame.at,
              ...(load && load !== sentLoad ? { load } : {}),
              ...(traffic && traffic !== sentTraffic ? { browserTraffic: traffic } : {}),
              ...(egress && egress !== sentEgress ? { egress } : {}),
            });
            sentLoad = load;
            sentTraffic = traffic;
            sentEgress = egress;
            arm();
            return;
          }
          case "request": {
            const { type: _type, id, ...request } = frame;
            void runner.start(id, request as MachineRequest);
            return;
          }
          case "cancel":
            runner.cancel(frame.id);
            return;
          case "refused": {
            const reason = frame.reason in REFUSED_EXIT ? frame.reason : "invalid_token";
            outcome = { exitCode: REFUSED_EXIT[reason], reason, message: frame.message || reason };
            end();
            return;
          }
        }
      };

      this.endSession = end;
      opts.onState?.("connecting");
      try {
        socket = (opts.dial ?? webSocketDial)(opts.url, {
          onOpen: () => {
            queueMicrotask(() =>
              send({
                type: "hello",
                token: opts.token,
                ...(typeof opts.info === "function" ? opts.info() : opts.info),
                ...((executors) => (executors ? { executors } : {}))(opts.executors?.()),
                ...(tasks ? { tasks: tasks.list() } : {}),
              }),
            );
          },
          onMessage: (raw) => {
            if (!finished) onFrame(raw);
          },
          onClose: (code, reason) => {
            if (!finished && !welcomed && code !== 1000) {
              log(`could not connect${reason ? ` (${reason})` : code ? ` (code ${code})` : ""}`);
            }
            end();
          },
        });
      } catch (err) {
        log(`could not connect: ${err instanceof Error ? err.message : String(err)}`);
        end();
        return;
      }
      if (finished) socket.close();
      else arm();
    });
  }
}
