import { randomBytes } from "node:crypto";
import {
  type AgentScope,
  type DesktopMode,
  type MachineRequest,
  type PhoneTarget,
  parseStreamControl,
  parseStreamHello,
  STREAM_CLOSE,
  STREAM_LIMITS,
  type StreamHello,
  type StreamRequest,
} from "@agenteschat/adapters";
import type { Database } from "@agenteschat/db";
import { type MachineHub, MachineRequestError } from "./machine-hub";
import { authenticateMachine, MachineOfflineError, MachinePausedError } from "./machines";
import { AgentHeldError, OrgPausedError } from "./standing";

/** A WebSocket as the broker sees it: the server adapts Bun's, tests use in-memory ones. */
export interface StreamSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Bytes still queued to go out. */
  buffered(): number;
  ping?(): void;
}

/** Who opens a stream, of which agent, and what it shows. */
export interface StreamInput {
  userId: string;
  orgId: string;
  /** The agent whose desktop or terminal it is; empty for a phone's screen (`request.phoneId`). */
  agentId: string;
  request: StreamRequest;
  /** The person's session behind the viewer socket (its token): the recheck ends the stream once it is gone. */
  sessionToken?: string;
  /** Its viewer takes a desktop's mode changing in place (ADR 0058 §17): `{"type":"mode"}` frames, a new session. */
  switches?: boolean;
  /** A browser card's view (ADR 0058 §7): watch only, never starts the desktop, yields to full viewers. */
  preview?: boolean;
  /** A phone's screen for the phone app: its pictures go as base64 text frames (React Native draws them so). */
  text?: boolean;
}

/**
 * Where a stream that may open goes, or why it can't (the viewer's close code and a short reason). `held`:
 * the agent or its workspace is held, so a desktop that runs may be watched but none is started for it.
 */
export type StreamTarget =
  | { machineId: string; agent?: AgentScope; held?: boolean; switches?: boolean; phone?: PhoneTarget }
  | { refused: number; reason: string };

export interface Stream extends StreamInput {
  /** 32 random bytes, base64url: the runner's data socket names the stream with it. */
  readonly id: string;
  readonly viewer: StreamSocket;
  /** The computer, once `authorize` let it open. */
  machineId: string | null;
  /** The runner's data socket, once its hello named this stream. */
  runner: StreamSocket | null;
  /** Bytes from the person (keys, pointer, a resize) and to them (the screen, the shell's output). */
  bytesIn: number;
  bytesOut: number;
  openedAt: number;
  readyAt: number | null;
  closed: boolean;
}

/**
 * A data socket that serves something else than a person's stream: an agent browser's live view (ADR 0040 §7.1),
 * claimed by its id through `claim`. It hears what the runner sends, and its socket's end.
 */
export interface ClaimedStream {
  data(data: string | Uint8Array): void;
  /** Its socket ended; `code` as the runner closed it (`STREAM_CLOSE`), absent when the server ended it. */
  closed(code?: number): void;
}

/** A data socket the runner opened: its stream once its hello named one. */
export interface RunnerLink {
  readonly socket: StreamSocket;
  stream: Stream | null;
  /** Claimed by another part of the server (`claim`), not a person's stream. */
  claimed?: ClaimedStream;
  /** Its hello is being checked. */
  authing: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type Limits = {
  [K in keyof typeof STREAM_LIMITS]: (typeof STREAM_LIMITS)[K] extends number ? number : (typeof STREAM_LIMITS)[K];
};

export interface StreamBrokerDeps {
  db: Database;
  hub: Pick<MachineHub, "call">;
  /** Whether the person may open it and on which computer; `refused` is the viewer's close code. */
  authorize(input: StreamInput): Promise<StreamTarget>;
  /** Every `accessRecheckMs` while it is open: whether the person may still have it (null), else its close. */
  recheck?(stream: Stream): Promise<{ refused: number; reason: string } | null>;
  /** Whether a desktop stream may go on in `mode` (`switchWhere`): null, else its close. */
  reauthorize?(stream: Stream, mode: DesktopMode): Promise<{ refused: number; reason: string } | null>;
  /**
   * A hello naming no stream of the broker's: another part of the server may take that data socket (an agent
   * browser's live view, ADR 0040 §7.1) once its machine is known. Null leaves it unknown.
   */
  claim?(streamId: string, machineId: string, socket: StreamSocket): ClaimedStream | null;
  /** A stream got its data socket (session screening starts), once. */
  onReady?(stream: Stream): unknown;
  /** A stream that got its data socket ended (the audit). */
  onClosed?(stream: Stream): unknown;
  /** Tests: shorter timeouts, smaller caps. */
  limits?: Partial<Limits>;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

interface OpenStream extends Stream {
  /** A desktop whose viewer and computer both take its mode changing in place (ADR 0058 §17). */
  switches: boolean;
  /** The mode it is to have; `switchWhere` sets it, and a switch under way goes on until the stream has it. */
  wanted: DesktopMode | null;
  switching: boolean;
  /** A switch sent to the computer: the viewer's bytes are its old session's until it says it took this mode. */
  discarding: DesktopMode | null;
  /** The person's frames before the data socket is ready, sent once it is. */
  queue: (string | Uint8Array)[];
  queued: number;
  /** Bytes the person sent in the current second. */
  second: { start: number; bytes: number };
  timer?: ReturnType<typeof setTimeout>;
  pinger?: ReturnType<typeof setInterval>;
  checker?: ReturnType<typeof setInterval>;
}

/**
 * A viewer that took a browser card's place waits this long before asking the computer again: the computer counts
 * the card's stream until its data socket has closed.
 */
const PREVIEW_YIELD_RETRY_MS = 500;

/**
 * Desktop and terminal streams on this server (ADR 0058 §2): a person's viewer
 * socket paired with the one data socket the runner dials for it, bytes
 * relayed as they come, never parsed or kept. `open` asks `authorize` (who,
 * which computer), checks the caps, then sends `stream.open` with a fresh
 * 32-byte id; the data socket's `stream.hello` names that id and carries its
 * machine's token. Either side closing closes both; a stream that got its data
 * socket goes to `onReady`, and to `onClosed` once it ends.
 */
export function createStreamBroker(deps: StreamBrokerDeps) {
  const limits: Limits = { ...STREAM_LIMITS, ...deps.limits };
  const streams = new Map<string, OpenStream>();
  /** Data sockets that haven't named their stream yet. */
  const waiting = new Set<RunnerLink>();
  /** Data sockets another part of the server took (`claim`). */
  const claimed = new Set<RunnerLink>();

  const quietly = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A socket that broke is cleaned up by its close.
    }
  };

  /** A hook, after the broker's own step and never in its way. */
  const later = (hook: ((s: Stream) => unknown) | undefined, s: Stream, failed: string) => {
    if (!hook) return;
    void Promise.resolve()
      .then(() => hook(s))
      .catch((error) => deps.log?.warn(failed, { agentId: s.agentId, error: String(error) }));
  };

  function close(stream: Stream, code: number = STREAM_CLOSE.normal, reason = "") {
    const s = streams.get(stream.id);
    if (!s) return;
    streams.delete(s.id);
    s.closed = true;
    clearTimeout(s.timer);
    clearInterval(s.pinger);
    clearInterval(s.checker);
    quietly(() => s.viewer.close(code, reason));
    const runner = s.runner;
    if (runner) quietly(() => runner.close(code, reason));
    if (s.readyAt !== null) later(deps.onClosed, s, "stream audit failed");
  }

  /** Ends a data socket that has no stream (yet). */
  function endLink(link: RunnerLink, code: number, reason: string) {
    link.closed = true;
    if (link.timer) clearTimeout(link.timer);
    link.timer = null;
    waiting.delete(link);
    quietly(() => link.socket.close(code, reason));
  }

  /** One frame to a side; a side that keeps more than `max` bytes queued doesn't keep up, and the stream ends. */
  function relay(s: OpenStream, to: StreamSocket, frame: string | Uint8Array, max: number) {
    quietly(() => to.send(frame));
    if (to.buffered() > max) close(s, STREAM_CLOSE.tooSlow, "too slow");
  }

  /**
   * Whether the caps leave no room: viewers per desktop; terminals per agent and per computer. A browser card's
   * view (`preview`) leaves one viewer's room free, so a person opening the screen itself always finds one.
   */
  function full(s: OpenStream, machineId: string) {
    let agent = 0;
    let machine = 0;
    const phoneId = s.request.kind === "phone" ? s.request.phoneId : null;
    for (const o of streams.values()) {
      if (o === s || o.machineId === null || o.request.kind !== s.request.kind) continue;
      if (phoneId !== null) {
        if (o.request.kind === "phone" && o.request.phoneId === phoneId) agent++;
        continue;
      }
      if (o.agentId === s.agentId) agent++;
      if (o.machineId === machineId) machine++;
    }
    if (s.request.kind === "desktop") return agent >= limits.viewersPerDesktop - (s.preview ? 1 : 0);
    if (s.request.kind === "phone") return agent >= limits.viewersPerDesktop;
    return agent >= limits.terminalsPerAgent || machine >= limits.terminalsPerMachine;
  }

  /** The agent's oldest browser card view sent to its computer, which gives its room to a full viewer. */
  function oldestPreview(s: OpenStream) {
    for (const o of streams.values()) {
      if (o !== s && o.preview && o.machineId !== null && o.agentId === s.agentId && o.request.kind === "desktop") {
        return o;
      }
    }
    return null;
  }

  /** Why the computer didn't open it, as the viewer's close code and reason. */
  function refusal(error: unknown): [number, string] {
    if (error instanceof MachineOfflineError) return [STREAM_CLOSE.unreachable, "offline"];
    if (error instanceof MachinePausedError) return [STREAM_CLOSE.refused, "machine_paused"];
    // The hub's own check, for what starts something (control; a start on an older runner).
    if (error instanceof AgentHeldError || error instanceof OrgPausedError) return [STREAM_CLOSE.refused, "held"];
    if (error instanceof MachineRequestError) {
      if (error.code === "timeout") return [STREAM_CLOSE.late, "timeout"];
      if (error.code === "too_many_streams") return [STREAM_CLOSE.tooMany, error.code];
      return [STREAM_CLOSE.refused, error.code === "paused" ? "machine_paused" : error.code];
    }
    return [STREAM_CLOSE.refused, "internal"];
  }

  async function start(s: OpenStream) {
    let target: StreamTarget;
    try {
      target = await deps.authorize(s);
    } catch (error) {
      deps.log?.warn("stream check failed", { agentId: s.agentId, error: String(error) });
      return close(s, STREAM_CLOSE.internal, "internal");
    }
    if (s.closed) return;
    if ("refused" in target) return close(s, target.refused, target.reason);
    // A person opening the screen itself takes a browser card's room (ADR 0058 §7): the card shows frames again.
    let yielded = false;
    if (s.request.kind === "desktop" && !s.preview && full(s, target.machineId)) {
      const preview = oldestPreview(s);
      if (preview) {
        close(preview, STREAM_CLOSE.tooMany, "preview_yield");
        yielded = true;
      }
    }
    if (full(s, target.machineId)) return close(s, STREAM_CLOSE.tooMany, "too_many_streams");
    s.machineId = target.machineId;
    // A card's view only watches: it never turns into control (no control audit, no screening).
    s.switches = s.request.kind === "desktop" && s.switches && target.switches === true && !s.preview;
    const { machineId, agent } = target;
    const held = target.held === true;
    // A card's view never starts a stopped screen: only someone opening it does.
    const starts = s.request.kind === "desktop" && !held && !s.preview ? { start: true } : {};
    const request = {
      op: "stream.open",
      streamId: s.id,
      ...s.request,
      ...(agent ? { agent } : {}),
      ...(target.phone ? { phone: target.phone } : {}),
      ...starts,
    } as Extract<MachineRequest, { op: "stream.open" }>;
    const open = () => deps.hub.call(machineId, request, { timeoutMs: limits.openTimeoutMs });
    const first = async () => {
      try {
        await open();
      } catch (error) {
        // The card's view it took the place of holds the computer's room until its data socket closes.
        if (!yielded || s.closed || !(error instanceof MachineRequestError && error.code === "too_many_streams")) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, PREVIEW_YIELD_RETRY_MS));
        if (!s.closed) await open();
      }
    };
    try {
      try {
        await first();
      } catch (error) {
        if (!(error instanceof MachineRequestError && error.code === "desktop_off") || s.closed) throw error;
        if (held) return close(s, STREAM_CLOSE.refused, "held");
        if (s.preview) return close(s, STREAM_CLOSE.refused, "desktop_off");
        // A runner from before desktops stayed on ignores `start`: it starts, then opens.
        await deps.hub.call(machineId, { op: "desktop.session.start", agent }, { timeoutMs: limits.openTimeoutMs });
        if (!s.closed) await open();
      }
      // The runner answers only once its data socket got `stream.ready`: without one by now, none is coming.
      if (!s.runner) close(s, STREAM_CLOSE.late, "no data socket");
    } catch (error) {
      // Once ready the bytes flow on their own socket: a reply lost with the machine's socket ends nothing.
      if (!s.runner) close(s, ...refusal(error));
    }
  }

  async function attach(link: RunnerLink, hello: StreamHello) {
    let machine: Awaited<ReturnType<typeof authenticateMachine>>;
    try {
      machine = await authenticateMachine(deps.db, hello.token);
    } catch {
      return endLink(link, STREAM_CLOSE.internal, "internal");
    }
    if (link.closed) return;
    if (!machine) return endLink(link, STREAM_CLOSE.badToken, "bad token");
    const s = streams.get(hello.streamId);
    if (!s) {
      const taker = deps.claim?.(hello.streamId, machine.id, link.socket) ?? null;
      if (taker && !link.closed) {
        waiting.delete(link);
        link.claimed = taker;
        claimed.add(link);
        quietly(() => link.socket.send(JSON.stringify({ type: "stream.ready" })));
        return;
      }
      taker?.closed();
    }
    // Ended, served by another data socket, or never sent to a computer.
    if (!s || s.runner || !s.machineId) return endLink(link, STREAM_CLOSE.notFound, "unknown stream");
    if (s.machineId !== machine.id) return endLink(link, STREAM_CLOSE.badToken, "another computer's stream");
    waiting.delete(link);
    link.stream = s;
    s.runner = link.socket;
    s.readyAt = Date.now();
    clearTimeout(s.timer);
    s.pinger = setInterval(() => {
      quietly(() => s.viewer.ping?.());
      quietly(() => link.socket.ping?.());
    }, limits.pingMs);
    const recheck = deps.recheck;
    if (recheck) {
      // Access can end while it's open (removed from the org, someone else took control…).
      let checking = false;
      s.checker = setInterval(() => {
        if (s.closed) return;
        // An unresponsive store cannot leave a private stream open indefinitely.
        if (checking) return close(s, STREAM_CLOSE.internal, "access unavailable");
        checking = true;
        void Promise.resolve()
          .then(() => recheck(s))
          .then(
            (lost) => {
              if (lost) close(s, lost.refused, lost.reason);
            },
            (error) => {
              deps.log?.warn("stream recheck failed", { agentId: s.agentId, error: String(error) });
              close(s, STREAM_CLOSE.internal, "access unavailable");
            },
          )
          .finally(() => {
            checking = false;
          });
      }, limits.accessRecheckMs);
    }
    quietly(() => link.socket.send(JSON.stringify({ type: "stream.ready" })));
    // Before any of the computer's bytes: the viewer keeps this socket when the mode changes.
    const request = s.request;
    if (s.switches && request.kind === "desktop") {
      quietly(() => s.viewer.send(JSON.stringify({ type: "mode", mode: request.mode })));
    }
    const queue = s.queue;
    s.queue = [];
    s.queued = 0;
    for (const frame of queue) if (!s.closed) relay(s, link.socket, frame, limits.runnerBufferedMax);
    if (!s.closed) later(deps.onReady, s, "stream start hook failed");
    // Its handoff changed while it opened (taken right after the screen opened).
    if (s.switches && s.wanted && request.kind === "desktop" && s.wanted !== request.mode) void switchMode(s);
  }

  /**
   * A desktop stream goes on in `s.wanted` on the same sockets (ADR 0058 §17), once `reauthorize` lets it: what ran
   * so far ends for the hooks (its audit; a control session's screening and grace) and the new mode starts for them,
   * the computer logs in again, and the viewer's bytes are dropped until it took the switch (`discarding`).
   * Switches asked meanwhile wait for this one; the last one asked wins. Control refused leaves it watching (the
   * recheck closes it if the person may not even watch now); watching refused closes it.
   */
  async function switchMode(s: OpenStream) {
    if (s.switching) return;
    s.switching = true;
    try {
      while (!s.closed && s.runner && s.request.kind === "desktop" && s.wanted && s.wanted !== s.request.mode) {
        const mode = s.wanted;
        let lost: { refused: number; reason: string } | null = null;
        try {
          lost = (await deps.reauthorize?.(s, mode)) ?? null;
        } catch (error) {
          deps.log?.warn("stream switch check failed", { agentId: s.agentId, error: String(error) });
          lost = { refused: STREAM_CLOSE.internal, reason: "access unavailable" };
        }
        if (s.closed || !s.runner) return;
        if (lost && mode === "control") {
          if (s.wanted === mode) s.wanted = null;
          continue;
        }
        if (lost) return close(s, lost.refused, lost.reason);
        if (s.wanted !== mode) continue;
        if (s.readyAt !== null) later(deps.onClosed, { ...s }, "stream audit failed");
        s.request = { kind: "desktop", mode };
        s.readyAt = Date.now();
        s.bytesIn = 0;
        s.bytesOut = 0;
        s.discarding = mode;
        relay(s, s.runner, JSON.stringify({ type: "mode", mode }), limits.runnerBufferedMax);
        if (!s.closed) later(deps.onReady, s, "stream start hook failed");
      }
    } finally {
      s.switching = false;
    }
  }

  return {
    /**
     * A person's viewer socket opened. The stream exists at once (frames the
     * person sends wait for the data socket); the checks, the caps and
     * `stream.open` follow, and a refusal closes the viewer with its code.
     */
    open(viewer: StreamSocket, input: StreamInput): Stream {
      const s: OpenStream = {
        userId: input.userId,
        orgId: input.orgId,
        agentId: input.agentId,
        request: input.request,
        sessionToken: input.sessionToken,
        ...(input.text ? { text: true } : {}),
        switches: input.switches === true && input.preview !== true,
        ...(input.preview ? { preview: true } : {}),
        wanted: null,
        switching: false,
        discarding: null,
        id: randomBytes(32).toString("base64url"),
        viewer,
        machineId: null,
        runner: null,
        bytesIn: 0,
        bytesOut: 0,
        openedAt: Date.now(),
        readyAt: null,
        closed: false,
        queue: [],
        queued: 0,
        second: { start: 0, bytes: 0 },
      };
      streams.set(s.id, s);
      s.timer = setTimeout(() => {
        if (!s.runner) close(s, STREAM_CLOSE.late, "the computer did not open the stream in time");
      }, limits.openTimeoutMs);
      void start(s);
      return s;
    },

    /** A frame from the person: binary is the stream's bytes; text only a terminal's `resize`. */
    fromViewer(stream: Stream, data: string | Uint8Array) {
      const s = streams.get(stream.id);
      if (!s) return;
      const size = typeof data === "string" ? data.length : data.byteLength;
      const now = Date.now();
      if (now - s.second.start >= 1000) s.second = { start: now, bytes: 0 };
      s.second.bytes += size;
      if (size > limits.clientFrameMax || s.second.bytes > limits.clientBytesPerSecond) {
        return close(s, STREAM_CLOSE.badRequest, "too much input");
      }
      let frame = data;
      if (s.request.kind === "phone") {
        // A phone's viewer acknowledges pictures and, in control, sends its input: text frames only.
        const control = typeof data === "string" ? parseStreamControl(data) : null;
        const type = control?.type;
        const input = type === "tap" || type === "swipe" || type === "text" || type === "key";
        if (type !== "ack" && !(input && s.request.mode === "control"))
          return close(s, STREAM_CLOSE.badRequest, "bad frame");
        frame = JSON.stringify(control);
      } else if (typeof data === "string") {
        const control = s.request.kind === "terminal" || s.switches ? parseStreamControl(data) : null;
        // The viewer took the switch: what it sends from here is the new session's.
        if (s.switches && control?.type === "mode") {
          if (s.discarding === control.mode) s.discarding = null;
          return;
        }
        if (s.request.kind !== "terminal" || control?.type !== "resize") {
          return close(s, STREAM_CLOSE.badRequest, "bad frame");
        }
        frame = JSON.stringify(control);
      }
      if (s.discarding) return;
      s.bytesIn += size;
      if (s.runner) return relay(s, s.runner, frame, limits.runnerBufferedMax);
      s.queued += size;
      if (s.queued > limits.clientFrameMax) return close(s, STREAM_CLOSE.badRequest, "too much input");
      s.queue.push(frame);
    },

    /** A data socket opened: it has `helloTimeoutMs` to send `stream.hello`. */
    accept(socket: StreamSocket): RunnerLink {
      const link: RunnerLink = { socket, stream: null, authing: false, closed: false, timer: null };
      link.timer = setTimeout(() => endLink(link, STREAM_CLOSE.late, "no stream.hello"), limits.helloTimeoutMs);
      waiting.add(link);
      return link;
    },

    /** A frame from the runner: first its `stream.hello`, then the bytes (and a terminal's `exit`). */
    async fromRunner(link: RunnerLink, data: string | Uint8Array) {
      if (link.closed) return;
      if (link.claimed) return link.claimed.data(data);
      if (link.stream) {
        const s = streams.get(link.stream.id);
        if (!s) return;
        if (typeof data === "string") {
          const control = parseStreamControl(data);
          if (control?.type === "exit" && s.request.kind === "terminal") {
            quietly(() => s.viewer.send(JSON.stringify(control)));
          }
          // Where the computer's old session ends: the viewer starts noVNC again on the bytes after it.
          if (control?.type === "mode" && s.switches) quietly(() => s.viewer.send(JSON.stringify(control)));
          return;
        }
        s.bytesOut += data.byteLength;
        const out = s.text ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64") : data;
        return relay(s, s.viewer, out, limits.viewerBufferedMax);
      }
      const hello = typeof data === "string" && !link.authing ? parseStreamHello(data) : null;
      if (!hello) return endLink(link, STREAM_CLOSE.badRequest, "send stream.hello, then wait for stream.ready");
      link.authing = true;
      // In time: checking its token is the server's own wait.
      if (link.timer) clearTimeout(link.timer);
      link.timer = null;
      await attach(link, hello);
    },

    /** A data socket closed: its stream ends; the viewer retries unless the runner ended it on purpose. */
    runnerClosed(link: RunnerLink, code: number) {
      if (link.closed) return;
      link.closed = true;
      if (link.timer) clearTimeout(link.timer);
      link.timer = null;
      waiting.delete(link);
      if (link.claimed) {
        claimed.delete(link);
        link.claimed.closed(code);
        return;
      }
      if (link.stream) {
        // Control ended on the computer (a phone taken back): the viewer opens again as a watcher.
        const ended =
          code === STREAM_CLOSE.normal || code === STREAM_CLOSE.controlEnded ? code : STREAM_CLOSE.unreachable;
        close(link.stream, ended, "the computer closed the stream");
      }
    },

    /** Ends a stream, both sides with `code` (the viewer leaving: normal). */
    close,

    /**
     * Turns every desktop stream `match` picks whose viewer takes it to `mode` in place (`switchMode`): one that is
     * ready at once, one still opening once it is (where its computer can). The others are left as they are.
     */
    switchWhere(match: (stream: Stream) => boolean, mode: DesktopMode) {
      for (const s of streams.values()) {
        if (!s.switches || s.request.kind !== "desktop" || !match(s)) continue;
        s.wanted = mode;
        if (s.runner) void switchMode(s);
      }
    },

    /** Whether a stream is ready and changes mode in place (its viewer and its computer both can). */
    switches(stream: Stream) {
      const s = streams.get(stream.id);
      return s?.switches === true && s.runner !== null;
    },

    /** Ends every stream `match` picks (someone took control: the others' views go). */
    closeWhere(match: (stream: Stream) => boolean, code: number, reason = "") {
      let n = 0;
      for (const s of [...streams.values()]) {
        if (!match(s)) continue;
        close(s, code, reason);
        n++;
      }
      return n;
    },

    /** Whether a stream `match` picks is open here (still being checked, opening or ready). */
    some(match: (stream: Stream) => boolean) {
      for (const s of streams.values()) if (match(s)) return true;
      return false;
    },

    /** An agent's streams of a kind sent to its computer (ready or still opening). */
    count(agentId: string, kind: StreamRequest["kind"]) {
      let n = 0;
      for (const s of streams.values()) if (s.agentId === agentId && s.request.kind === kind && s.machineId) n++;
      return n;
    },

    /** Ends every stream and data socket (the server restarts: viewers open again on the next one). */
    stop() {
      for (const s of [...streams.values()]) close(s, STREAM_CLOSE.restarting, "server restarting");
      for (const link of [...waiting]) endLink(link, STREAM_CLOSE.restarting, "server restarting");
      for (const link of [...claimed]) {
        claimed.delete(link);
        quietly(() => link.socket.close(STREAM_CLOSE.restarting, "server restarting"));
        link.claimed?.closed();
      }
    },
  };
}

export type StreamBroker = ReturnType<typeof createStreamBroker>;
