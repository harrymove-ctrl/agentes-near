/**
 * The app's side of the control protocol (packages/adapters/src/runner-control.ts): one client for
 * every runner home. Requests get an id and wait for the `reply` with the same id (or a timeout);
 * `hello` lines and events go to subscribers, tagged with the home they came from.
 *
 * Every window has its own client. The Rust side broadcasts each stdout line to all windows, so
 * ids carry a per-window prefix and a reply nobody here asked for is ignored.
 *
 * Pure TypeScript (no Tauri, no DOM): the transport is injected, so tests and the fake runner use it too.
 */
import {
  CONTROL_MAX_LINE,
  type ControlErrorCode,
  type ControlEvent,
  type ControlOut,
  type ControlReplies,
  type ControlRequest,
} from "@agenteschat/adapters/runner-control";

export type HelloLine = Extract<ControlOut, { type: "hello" }>;

/** Why a request failed: the runner's own codes, or ours. */
export type ClientErrorCode = ControlErrorCode | "timeout" | "closed" | "send_failed";

export class ControlError extends Error {
  readonly code: ClientErrorCode;
  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}

export interface ControlTransport {
  /** Writes one line (no newline) to the runner of `homeId`. */
  send(homeId: string, line: string): Promise<void>;
}

export type ControlMessage = { kind: "hello"; hello: HelloLine } | { kind: "event"; event: ControlEvent };
export type ControlListener = (homeId: string, message: ControlMessage) => void;

export interface ControlClientOptions {
  /** Prefix of every request id (e.g. the window's name), so replies are matched per window. */
  idPrefix?: string;
  /** Default timeout per request (ms). */
  timeoutMs?: number;
  /** Timers, injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Pending {
  homeId: string;
  resolve: (data: unknown) => void;
  reject: (err: ControlError) => void;
  timer: unknown;
}

/**
 * Timeouts by request: sign-in and shutdown reply at once; activity and diagnostics read files;
 * the accounts ask each CLI, and `account.begin` waits for the CLI to print its sign-in link.
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const SLOW: Partial<Record<ControlRequest["type"], number>> = {
  diagnostics: 20_000,
  activity: 15_000,
  "accounts.list": 20_000,
  "account.begin": 30_000,
  // The CLI's sign-out alone may take 10 s before the folder goes.
  "account.remove": 20_000,
};

export class ControlClient {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<ControlListener>();
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly transport: ControlTransport,
    options: ControlClientOptions = {},
  ) {
    this.prefix = (options.idPrefix ?? "app").slice(0, 40);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Sends a request to one runner and resolves with its reply's data. */
  request<R extends ControlRequest>(homeId: string, req: R, timeoutMs?: number): Promise<ControlReplies[R["type"]]> {
    this.seq += 1;
    const id = `${this.prefix}-${this.seq}`;
    const line = JSON.stringify({ ...req, id });
    if (line.length > CONTROL_MAX_LINE) {
      return Promise.reject(new ControlError("bad_request", "request too large"));
    }
    return new Promise<ControlReplies[R["type"]]>((resolve, reject) => {
      const ms = timeoutMs ?? SLOW[req.type] ?? this.timeoutMs;
      const timer = this.setTimer(() => {
        if (this.pending.delete(id)) reject(new ControlError("timeout", `${req.type} timed out`));
      }, ms);
      this.pending.set(id, { homeId, resolve: resolve as (d: unknown) => void, reject, timer });
      this.transport.send(homeId, line).catch((err: unknown) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.clearTimer(p.timer);
        reject(new ControlError("send_failed", err instanceof Error ? err.message : String(err)));
      });
    });
  }

  /** One stdout line from a runner. */
  receive(homeId: string, line: string): void {
    if (!line || line.length > CONTROL_MAX_LINE) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const out = msg as ControlOut;
    if (out.type === "reply") {
      const p = this.pending.get(out.id);
      // Another window's request (same broadcast), or one that already timed out.
      if (!p || p.homeId !== homeId) return;
      this.pending.delete(out.id);
      this.clearTimer(p.timer);
      if (out.ok) p.resolve(out.data);
      else p.reject(new ControlError(out.error?.code ?? "internal", out.error?.message ?? "error"));
      return;
    }
    if (out.type === "hello") {
      this.emit(homeId, { kind: "hello", hello: out });
      return;
    }
    if (out.type === "event" && out.event && typeof out.event === "object") {
      this.emit(homeId, { kind: "event", event: out.event });
    }
  }

  subscribe(listener: ControlListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The runner of `homeId` stopped: its open requests fail now instead of timing out. */
  closeHome(homeId: string): void {
    for (const [id, p] of this.pending) {
      if (p.homeId !== homeId) continue;
      this.pending.delete(id);
      this.clearTimer(p.timer);
      p.reject(new ControlError("closed", "runner stopped"));
    }
  }

  /** Nothing reads the runners' lines any more: every open request fails now instead of timing out. */
  close(): void {
    for (const homeId of new Set([...this.pending.values()].map((p) => p.homeId))) this.closeHome(homeId);
  }

  /** Open requests (tests, diagnostics). */
  get inFlight(): number {
    return this.pending.size;
  }

  private emit(homeId: string, message: ControlMessage) {
    for (const l of [...this.listeners]) {
      try {
        l(homeId, message);
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  }
}
