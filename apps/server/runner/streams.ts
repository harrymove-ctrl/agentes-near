import {
  parseStreamControl,
  STREAM_CLOSE,
  STREAM_LIMITS,
  type StreamControl,
} from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "./errors";
import { writeJson } from "./json-file";

/** System mode: what root relayed, in `<runner home>/relayed.json`, for an operator's network guard to read. */
export const RELAYED_FILE = "relayed.json";

/**
 * System mode: the payload bytes the root runner relayed since it started, per stream (`up` toward the
 * server), without TLS: the agents' desktops and terminals on their data sockets, and the live view of
 * their browsers on the `browser.frame`s it passes on (`down`: the input people sent it). The Cloud's
 * guard reads `relayed.json` as `{startedAt, desktop, terminal, browserView}`.
 */
export class RelayCount {
  readonly startedAt = Date.now();
  readonly desktop = { up: 0, down: 0 };
  readonly terminal = { up: 0, down: 0 };
  readonly browserView = { up: 0, down: 0 };
  private saved = "";

  /** Written whole and renamed, only when it changed. */
  save(file: string) {
    const counts = {
      startedAt: this.startedAt,
      desktop: this.desktop,
      terminal: this.terminal,
      browserView: this.browserView,
    };
    const text = JSON.stringify(counts);
    if (text === this.saved) return;
    writeJson(file, counts);
    this.saved = text;
  }
}

const sizeOf = (data: string | ArrayBuffer | ArrayBufferView) =>
  typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;

/** What one side of a stream on the computer hears from its data socket. */
export interface DataListener {
  /** The person's bytes (keys, pointer). */
  bytes(data: Uint8Array): void;
  /** The person's control frames (a terminal's resize). */
  control?(frame: StreamControl): void;
  /** The socket closed, from either side. */
  closed(): void;
}

/**
 * One stream's data socket (ADR 0058 §11) once the server answered
 * `stream.ready`: binary frames are the stream's bytes, text frames its
 * control frames.
 */
export interface DataSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes still queued to go out. */
  readonly bufferedAmount: number;
  /** Starts handing over what the person sends; what came before waits for it. */
  listen(on: DataListener): void;
}

type Frame = Uint8Array | StreamControl;

const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    // a socket that broke reports it with its close
  }
};

const isReady = (data: unknown) => {
  try {
    return typeof data === "string" && (JSON.parse(data) as { type?: unknown } | null)?.type === "stream.ready";
  } catch {
    return false;
  }
};

/**
 * Dials the data socket of the stream `streamId` (`wss://…/api/machines/stream`):
 * its first frame names the stream with the machine's token, and it is ready
 * once the server answers `stream.ready`. Rejects when the server closes it
 * first, nothing comes within `timeoutMs`, or `signal` aborts. Pings go out
 * every `pingMs` (an idle desktop sends nothing, and proxies drop idle sockets).
 */
export function openDataSocket(opts: {
  url: string;
  token: string;
  streamId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onClosed?: () => void;
  /** The stream's bytes once it is ready, as they go `up` to the server and come `down`. */
  count?: (way: "up" | "down", bytes: number) => void;
}): Promise<DataSocket> {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new RunnerError("internal", "This runtime has no WebSocket client"));
      return;
    }
    const ws = new WebSocket(opts.url);
    ws.binaryType = "arraybuffer";
    let ready = false;
    let ended = false;
    let listener: DataListener | null = null;
    const early: Frame[] = [];
    let pinger: ReturnType<typeof setInterval> | undefined;

    const deliver = (frame: Frame) => {
      if (frame instanceof Uint8Array) listener?.bytes(frame);
      else listener?.control?.(frame);
    };
    const socket: DataSocket = {
      send: (data) =>
        quietly(() => {
          ws.send(data);
          opts.count?.("up", sizeOf(data));
        }),
      close: (code = STREAM_CLOSE.normal, reason = "") => {
        try {
          ws.close(code, reason);
        } catch {
          // The standard client (Node's) refuses codes other than 1000 and 3000-4999: it still closes.
          quietly(() => ws.close());
        }
      },
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      listen(on) {
        listener = on;
        for (const frame of early.splice(0)) deliver(frame);
        if (ended) on.closed();
      },
    };
    const settle = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    };
    const fail = (message: string) => {
      if (ready || ended) return;
      ended = true;
      settle();
      reject(new RunnerError("internal", message));
      // Some runtimes dispatch `close` from inside `close()`: the rejection above is the one that counts.
      quietly(() => ws.close());
    };
    const abort = () => fail("Canceled");
    const timer = setTimeout(
      () => fail("The server didn't take the stream in time"),
      opts.timeoutMs ?? STREAM_LIMITS.helloTimeoutMs,
    );
    if (opts.signal?.aborted) return abort();
    opts.signal?.addEventListener("abort", abort, { once: true });

    ws.addEventListener("open", () => {
      quietly(() => ws.send(JSON.stringify({ type: "stream.hello", token: opts.token, streamId: opts.streamId })));
    });
    ws.addEventListener("message", (ev) => {
      const data: unknown = ev.data;
      if (!ready) {
        if (!isReady(data)) return fail("The server answered the stream with something else");
        ready = true;
        settle();
        pinger = setInterval(() => quietly(() => ws.ping?.()), STREAM_LIMITS.pingMs);
        resolve(socket);
        return;
      }
      if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        opts.count?.("down", sizeOf(data));
      }
      let frame: Frame | null = null;
      if (typeof data === "string") frame = parseStreamControl(data);
      else if (data instanceof ArrayBuffer) frame = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (!frame) return;
      if (listener) deliver(frame);
      else early.push(frame);
    });
    ws.addEventListener("close", (ev) => {
      clearInterval(pinger);
      if (!ready) return fail(`The server refused the stream (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
      if (ended) return;
      ended = true;
      opts.onClosed?.();
      listener?.closed();
    });
    // An `error` is always followed by `close`.
    ws.addEventListener("error", () => undefined);
  });
}

/**
 * The data sockets of one connection to the server (its URL and the
 * machine's token): all of them close when that connection ends for good
 * (the computer unpaired, or the runner stopping), so no stream outlives the
 * pairing it was opened under.
 */
export class DataSockets {
  private readonly open = new Set<DataSocket>();

  constructor(private readonly opts: { url: string; token: string; timeoutMs?: number; relayed?: RelayCount }) {}

  async dial(
    streamId: string,
    kind: "desktop" | "terminal" | "browserView" | "phone",
    signal?: AbortSignal,
  ): Promise<DataSocket> {
    const { relayed, ...dial } = this.opts;
    // Phones are only reached by single-user runners, which count nothing.
    const bytes = kind === "phone" ? undefined : relayed?.[kind];
    let socket: DataSocket | null = null;
    socket = await openDataSocket({
      ...dial,
      streamId,
      ...(signal ? { signal } : {}),
      ...(bytes
        ? {
            count: (way: "up" | "down", n: number) => {
              bytes[way] += n;
            },
          }
        : {}),
      onClosed: () => {
        if (socket) this.open.delete(socket);
      },
    });
    this.open.add(socket);
    return socket;
  }

  closeAll() {
    for (const socket of [...this.open]) socket.close(STREAM_CLOSE.restarting, "the computer's runner stopped");
    this.open.clear();
  }
}
