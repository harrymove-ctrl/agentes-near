import type { ChannelEvent, UserEvent } from "../api/types";
import { decodeBrowserFrameBytes } from "../browser/frame-bytes";
import { type BrowserWatcher, createBrowserWatches } from "../browser/watches";
import { steerStore } from "./steer";

/**
 * WebSocket client for `/api/ws?orgId=` (apps/server/src/realtime/ws.ts,
 * docs/adr/0010-realtime.md). One connection per organization:
 * - subscribes per channel (ref-counted) and re-subscribes after reconnects;
 * - says when the server confirms a channel's subscription (`onSubscribed`): its
 *   events arrive only from then on, so what a page read before may be behind;
 * - reconnects with backoff; tells listeners so they catch up over HTTP
 *   (real-time is best effort, the database is the source of truth);
 * - pings to keep the connection alive through proxies, and drops a socket whose pong doesn't come back
 *   (`pongTimeoutMs`): after a network change or a sleep the browser can keep a dead socket "open" for
 *   minutes while HTTP still works, so messages send and nothing arrives live;
 * - asks again, with backoff, for a channel someone still listens to when the server drops or refuses its
 *   subscription (`unsubscribed`, an error about the channel, `rate_limited`): the socket stays up and keeps
 *   bringing the person's own events (the reply sound) while that channel would stay silent until a refresh;
 * - when a notification names a message in a channel listened to here whose `message.created` never came
 *   (`MISSED_MESSAGE_GRACE_MS` later), subscribes that channel anew: the server's `subscribed` has every screen
 *   catch up (`onSubscribed`), and a subscription the server lost without a word is made again.
 * - watches agents' browsers with `acks` and `frames` (ADR 0040 §7.1): each watched browser's pictures come as
 *   bytes on a frame socket of their own (`/api/browser/frames`, opened with the ticket `browser.frames` brings),
 *   so a picture never holds up a message; each one is answered once it could be drawn (after the next animation
 *   frame), and the server keeps only a few on their way, so a slow link or a busy page shows the newest
 *   picture instead of a backlog. Until that socket is open, or after it closed, they come here as base64 and are
 *   answered with `browser.ack` (only those the server marks `ack: true`: an older server knows no acks, nor
 *   `browser.fps`, which waits until the server shows it paces). A frame socket that closes on its own while the
 *   browser is still watched is asked for again (`browser.frames.renew`, with backoff); it stays open across watches
 *   of the same agent and goes with the unwatch. Without
 *   `browserFrameSockets` (the phone: its binary messages cost more on the JS thread than base64 does) the pictures
 *   stay on this socket, answered all the same.
 */

export type ServerFrame =
  | { type: "ready"; orgId: string; userId: string }
  | { type: "subscribed" | "unsubscribed"; channelId: string }
  /** `agentId`: about an agent's browser (ADR 0040), for the live view. */
  | { type: "error"; code: string; channelId?: string; agentId?: string }
  | { type: "pong" }
  | { type: "event"; channelId: string; event: ChannelEvent }
  /** `user`: for me only; `org`: broadcasts to the whole organization. */
  | { type: "event"; scope: "user" | "org"; event: UserEvent }
  /** The agent browser's live view (ADR 0040): `browser.frame`, `browser.status`, … (see `browser/live.ts`). */
  | { type: `browser.${string}`; agentId: string; [key: string]: unknown };

/** A watched browser's frame socket (ADR 0040 §7.1): opened with a ticket from `browser.frames`. */
export const BROWSER_FRAMES_PATH = "/api/browser/frames";
/** The waits before asking again for a frame socket that closed on its own; a frame that comes starts them over. */
export const BROWSER_FRAMES_RENEW_MS = [1000, 2000, 4000];

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** The part of the browser WebSocket we use (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000];
/** How long after a notification its message's own `message.created` may still come (it is normally first). */
export const MISSED_MESSAGE_GRACE_MS = 3000;
/** How many `message.created` ids are remembered for that check. */
const HEARD_LIMIT = 500;
const OPEN = 1;

/** Where the server is: the page's location (web) or the server's origin, e.g. "https://app.agentes.chat" (phone app). */
export type SocketBase = string | { protocol: string; host: string };

/** A WebSocket address on the server: `path` with `params` as its query. */
export function socketUrl(base: SocketBase, path: string, params: Record<string, string | number>) {
  const origin = typeof base === "string" ? originOf(base) : base;
  const protocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${protocol}//${origin.host}${path}?${query}`;
}

/** The socket URL for an organization. */
export function realtimeUrl(base: SocketBase, orgId: string) {
  return socketUrl(base, "/api/ws", { orgId });
}

/** A frame socket's URL on the same server as the realtime socket `url`. */
export function framesUrl(url: string, ticket: string) {
  const m = /^(wss?:\/\/[^/?#]+)/i.exec(url);
  return `${m ? m[1] : ""}${BROWSER_FRAMES_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

/** "https://app.agentes.chat/x" → { protocol: "https:", host: "app.agentes.chat" } (no `URL`: React Native's is partial). */
function originOf(base: string): { protocol: string; host: string } {
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]+)/i.exec(base.trim());
  if (!m) throw new Error(`socketUrl: not an absolute URL: ${base}`);
  return { protocol: (m[1] as string).toLowerCase(), host: m[2] as string };
}

/** A frame socket's binary message as bytes over an `ArrayBuffer`; null for anything else. */
function frameBytesOf(data: unknown): ArrayBuffer | Uint8Array<ArrayBuffer> | null {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array && data.buffer instanceof ArrayBuffer) return data as Uint8Array<ArrayBuffer>;
  return null;
}

/**
 * How much later than the frame socket's last picture one on the realtime socket must be captured to be taken as
 * newer whatever its `seq` (a stream that started again). Pictures of one start can differ by a little.
 */
const BROWSER_RESTART_GAP_MS = 2000;

/** A refused `browser.watch`: no view of that agent on the server (an input's `rate_limited` ends nothing). */
const WATCH_REFUSALS = new Set(["forbidden", "not_found", "too_many_browsers"]);

/** The server ended this agent's view: pictures still on their way on its frame socket are old (ADR 0040 §7.1). */
function endsView(frame: ServerFrame): boolean {
  if (frame.type === "error") return WATCH_REFUSALS.has(frame.code);
  return frame.type === "browser.ended" || frame.type === "browser.unavailable";
}

/** Parses a server frame; `null` for anything we don't understand (ignored). */
export function parseServerFrame(data: unknown): ServerFrame | null {
  if (typeof data !== "string") return null;
  try {
    const frame = JSON.parse(data) as { type?: unknown };
    if (typeof frame?.type !== "string") return null;
    return frame as ServerFrame;
  } catch {
    return null;
  }
}

type EventListener = (event: ChannelEvent) => void;

export class RealtimeConnection {
  private socket: SocketLike | null = null;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly subscribedListeners = new Set<(channelId: string) => void>();
  private readonly errorListeners = new Set<(code: string, channelId?: string) => void>();
  private readonly userListeners = new Set<(event: UserEvent) => void>();
  private readonly browserListeners = new Set<(frame: Record<string, unknown>) => void>();
  /** Each watched browser's frame socket, by agent. */
  private readonly frameSockets = new Map<string, SocketLike>();
  /**
   * The last frame each agent's frame socket brought (`seq`, and `at`: when its computer captured it): a frame of
   * theirs here that is no newer (sent before the switch) is answered but not drawn over it; a newer one (the server
   * went back to this socket first) is drawn. Compared by capture time when both have it, since a stream that starts
   * again numbers from 0. Forgotten when that socket goes or the view starts again.
   */
  private readonly lastBytes = new Map<string, { seq: number; at?: number }>();
  /**
   * Agents whose view the server ended (`browser.ended`, `browser.unavailable`, a refused watch) on the realtime
   * socket. Pictures sent before that may still arrive later on the frame socket, a separate connection (ADR 0040
   * §7.1), and must not show the old page as live again: they are answered but held, the newest only, until the
   * view starts again (`browser.watch`: dropped) or the server sends a status (every stream that starts again sends
   * one, maybe after its first pictures: the held one is drawn then).
   */
  private readonly halted = new Map<string, Record<string, unknown> | null>();
  /** Asking again for a frame socket that closed on its own: the pending ask and how many were made since a frame. */
  private readonly renewals = new Map<string, { timer: unknown; attempt: number }>();
  /**
   * Whether the server on this socket paces views (a frame with `ack: true`, a frame socket's ticket): only such a
   * server knows `browser.fps`; an older one would count each as a bad message.
   */
  private serverPaces = false;
  /** The rate each agent's views need, held until the server shows it paces (the watch already said the one before). */
  private readonly pendingFps = new Map<string, number>();
  private readonly browserWatches = createBrowserWatches({
    send: (frame) => this.sendBrowserFrame(frame),
    timers: {
      setTimeout: (fn, ms) => this.timers.setTimeout(fn, ms),
      clearTimeout: (id) => this.timers.clearTimeout(id),
    },
  });
  private attempt = 0;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  /** Channels the server confirmed on this socket. */
  private readonly confirmed = new Set<string>();
  private readonly retries = new Map<string, { timer: unknown; attempt: number }>();
  /** Recent `message.created` ids, oldest first. */
  private readonly heard = new Set<string>();
  private everOpened = false;
  private stopped = true;
  status: ConnectionStatus = "idle";

  constructor(
    private readonly options: {
      url: string;
      createSocket: SocketFactory;
      timers?: Timers;
      pingMs?: number;
      /** How long after a ping with nothing heard back the socket counts as dead and is replaced. */
      pongTimeoutMs?: number;
      backoffMs?: number[];
      /**
       * Watched browsers' pictures as bytes on a frame socket each (ADR 0040 §7.1); default true. The phone says no:
       * React Native hands binary messages to JS as base64 decoded in JS, and its image view takes the server's
       * base64 as it is.
       */
      browserFrameSockets?: boolean;
    },
  ) {}

  private get timers() {
    return this.options.timers ?? defaultTimers;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.closeFrameSockets();
    this.forgetPacing();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, "bye");
    }
    this.setStatus("closed");
  }

  /** Listen to a channel's events. Returns the unsubscribe function. */
  subscribe(channelId: string, listener: EventListener): () => void {
    let set = this.listeners.get(channelId);
    const first = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(channelId, set);
    }
    set.add(listener);
    if (first) {
      this.clearRetry(channelId);
      this.send({ type: "subscribe", channelId });
    }
    return () => {
      const current = this.listeners.get(channelId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channelId);
        this.confirmed.delete(channelId);
        this.send({ type: "unsubscribe", channelId });
      }
    };
  }

  /** Tells the channel we're typing, in one of its threads or not (call it throttled: see `typingThrottle`). */
  sendTyping(channelId: string, threadId?: string | null) {
    this.send(threadId ? { type: "typing", channelId, threadId } : { type: "typing", channelId });
  }

  onStatus(listener: (status: ConnectionStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Called after a reconnect (not the first connect): refetch what may have been missed. */
  onReconnect(listener: () => void) {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /**
   * The server confirmed a channel's subscription (its first, and again after every reconnect): the channel's
   * events reach us from now on. Whatever happened there before, after a page read it, is only over HTTP.
   */
  onSubscribed(listener: (channelId: string) => void) {
    this.subscribedListeners.add(listener);
    return () => {
      this.subscribedListeners.delete(listener);
    };
  }

  /** Events for the signed-in person (e.g. an approval they can decide), whatever channel they're in. */
  onUserEvent(listener: (event: UserEvent) => void) {
    this.userListeners.add(listener);
    return () => {
      this.userListeners.delete(listener);
    };
  }

  /**
   * The agent browser's live view frames (ADR 0040: `browser.*`, and errors about
   * an agent's browser), as they arrive. Feed them to `createBrowserLiveConnection`.
   */
  onBrowserFrame(listener: (frame: Record<string, unknown>) => void) {
    this.browserListeners.add(listener);
    return () => {
      this.browserListeners.delete(listener);
    };
  }

  /**
   * Who watches which agent's browser on this socket: views of one agent share one
   * `browser.watch` and unwatch a moment after the last leaves (pass it to
   * `createBrowserLiveConnection`). Watched again after every (re)connect.
   */
  get browserWatcher(): BrowserWatcher {
    return this.browserWatches;
  }

  /** Whether watched browsers' pictures come on frame sockets of their own. */
  private get frameSocketsOn() {
    return this.options.browserFrameSockets !== false;
  }

  /**
   * Sends a live-view frame (`browser.watch`, `browser.fps`, `browser.unwatch`, `browser.input`); dropped while not
   * connected. `browser.fps` waits until the server shows it paces views (`markPacing`), the last one per agent.
   */
  sendBrowserFrame(frame: { type: `browser.${string}`; agentId: string; [key: string]: unknown }) {
    const { agentId } = frame;
    // Every watch from this socket answers frames, and takes them on their own socket where it may: `handle` does
    // both, for every view of that agent at once. A view that goes takes its frame socket with it.
    if (frame.type === "browser.unwatch") {
      this.closeFrameSocket(agentId);
      this.pendingFps.delete(agentId);
    }
    if (frame.type === "browser.watch") {
      // The server starts the view again and sends its newest page on whichever path is open: what comes next is
      // drawn, from either. A frame socket still open stays (the server keeps it across watches); a renewal waiting
      // still goes unless this watch's ticket opened one first, and renewals count from the first wait again. The
      // watch says the rate the views need now.
      this.lastBytes.delete(agentId);
      this.halted.delete(agentId);
      this.pendingFps.delete(agentId);
      this.restartRenewals(agentId);
      this.send({ ...frame, acks: true, ...(this.frameSocketsOn ? { frames: true } : {}) });
      return;
    }
    if (frame.type === "browser.fps" && !this.serverPaces) {
      if (typeof frame.maxFps === "number") this.pendingFps.set(agentId, frame.maxFps);
      return;
    }
    this.send(frame);
  }

  /** The server showed it paces views: the rates held for it go now. */
  private markPacing() {
    if (this.serverPaces) return;
    this.serverPaces = true;
    for (const [agentId, maxFps] of this.pendingFps) this.send({ type: "browser.fps", agentId, maxFps });
    this.pendingFps.clear();
  }

  /** A new socket may reach another server (a deploy, an older replica): it shows again whether it paces. */
  private forgetPacing() {
    this.serverPaces = false;
    this.pendingFps.clear();
  }

  /** Runs `fn` once the views could draw what they just got (a hidden tab draws nothing, so it runs late). */
  private afterDraw(fn: () => void) {
    const nextFrame = (globalThis as { requestAnimationFrame?: (fn: () => void) => unknown }).requestAnimationFrame;
    if (typeof nextFrame === "function") nextFrame(fn);
    else fn();
  }

  /** A frame from the realtime socket that asks for an answer (`ack: true`): answered once the views could draw it. */
  private ackBrowserFrame(agentId: string, seq: unknown, now = false) {
    const ack = () => this.send({ type: "browser.ack", agentId, ...(typeof seq === "number" ? { seq } : {}) });
    if (now) ack();
    else this.afterDraw(ack);
  }

  /**
   * `browser.frames`: the ticket for a watched browser's frame socket. Its bytes go to the views as frames with
   * `jpeg`, each answered there once drawn. A new ticket (the server lost the old socket) replaces the socket.
   */
  private openFrameSocket(agentId: string, ticket: string) {
    // A renewal's count stays: a ticket whose socket closes before any frame comes doesn't start the waits over.
    this.dropFrameSocket(agentId);
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(framesUrl(this.options.url, ticket));
    } catch {
      this.renewFrameSocket(agentId);
      return;
    }
    (socket as { binaryType?: string }).binaryType = "arraybuffer";
    this.frameSockets.set(agentId, socket);
    socket.onmessage = (ev) => {
      if (this.frameSockets.get(agentId) !== socket) return;
      const bytes = frameBytesOf(ev.data);
      const decoded = bytes ? decodeBrowserFrameBytes(bytes) : null;
      if (!decoded) return;
      // It works: a later close asks again from the shortest wait.
      this.stopRenewal(agentId);
      const at = decoded.metadata.capturedAt;
      this.lastBytes.set(agentId, { seq: decoded.seq, ...(at !== undefined ? { at } : {}) });
      const frame = { type: "browser.frame", agentId, ...decoded };
      const answer = () => {
        if (socket.readyState === OPEN) socket.send(JSON.stringify({ type: "ack" }));
      };
      // The view ended meanwhile (ADR 0040 §7.1): held, and answered now so the server's window never stalls.
      if (this.halted.has(agentId)) {
        this.halted.set(agentId, frame);
        answer();
        return;
      }
      for (const l of this.browserListeners) l(frame);
      this.afterDraw(answer);
    };
    socket.onerror = () => {
      // `onclose` follows.
    };
    // Its frames come on the realtime socket again meanwhile (drawn from now on), and a new socket is asked for
    // while the browser is still watched.
    socket.onclose = () => {
      if (this.frameSockets.get(agentId) !== socket) return;
      this.frameSockets.delete(agentId);
      this.lastBytes.delete(agentId);
      this.renewFrameSocket(agentId);
    };
  }

  /**
   * A frame socket closed on its own (a proxy's restart, a network change): while its browser is still watched, a
   * new ticket for the same view (`browser.frames.renew`, never a new watch: that would restart the view), after
   * 1 s, 2 s, 4 s, then no more until a frame comes or the view starts again (`browser.watch`: `restartRenewals`);
   * it stays on this socket meanwhile.
   */
  private renewFrameSocket(agentId: string) {
    const prev = this.renewals.get(agentId);
    if (prev && prev.timer !== null) return;
    const attempt = prev?.attempt ?? 0;
    const wait = BROWSER_FRAMES_RENEW_MS[attempt];
    if (wait === undefined || !this.browserWatches.watching().includes(agentId)) return;
    const entry = { attempt: attempt + 1, timer: null as unknown };
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = null;
      if (this.frameSockets.has(agentId) || !this.browserWatches.watching().includes(agentId)) return;
      this.send({ type: "browser.frames.renew", agentId });
    }, wait);
    this.renewals.set(agentId, entry);
  }

  /** Cancels a pending renewal and starts the waits over (a frame came, the view went). */
  private stopRenewal(agentId: string) {
    const entry = this.renewals.get(agentId);
    if (!entry) return;
    if (entry.timer !== null) this.timers.clearTimeout(entry.timer);
    this.renewals.delete(agentId);
  }

  /**
   * The view starts again (`browser.watch`): the next frame socket that closes before a frame came is asked for
   * from the first wait. A renewal already waiting still goes, as the first of the new count.
   */
  private restartRenewals(agentId: string) {
    const entry = this.renewals.get(agentId);
    if (!entry) return;
    if (entry.timer === null) this.renewals.delete(agentId);
    else entry.attempt = 1;
  }

  /** The view goes (unwatched, the socket lost): its frame socket, and any renewal, with it. */
  private closeFrameSocket(agentId: string) {
    this.stopRenewal(agentId);
    this.halted.delete(agentId);
    this.dropFrameSocket(agentId);
  }

  /** Closes this agent's frame socket, if any: its frames come here from now on, and are drawn. */
  private dropFrameSocket(agentId: string) {
    this.lastBytes.delete(agentId);
    const socket = this.frameSockets.get(agentId);
    if (!socket) return;
    this.frameSockets.delete(agentId);
    socket.onmessage = null;
    socket.onclose = null;
    try {
      socket.close(1000, "unwatched");
    } catch {}
  }

  private closeFrameSockets() {
    const agents = new Set([
      ...this.frameSockets.keys(),
      ...this.renewals.keys(),
      ...this.lastBytes.keys(),
      ...this.halted.keys(),
    ]);
    for (const agentId of agents) this.closeFrameSocket(agentId);
  }

  /**
   * Pings now and replaces the socket if nothing comes back in time (`pongTimeoutMs`). Runs on the ping interval;
   * call it too when the page may have slept or changed networks (visible again, back online).
   */
  checkAlive() {
    if (!this.isOpen || this.pongTimer !== null) return;
    this.send({ type: "ping" });
    const socket = this.socket;
    this.pongTimer = this.timers.setTimeout(() => {
      this.pongTimer = null;
      if (this.socket !== socket || !socket) return;
      // Its close event may never come (or come late, after the new socket opened): detach it first.
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      try {
        socket.close(4000, "no pong");
      } catch {}
      this.lost();
    }, this.options.pongTimeoutMs ?? 10_000);
  }

  /** Whether frames can go out now. */
  get isOpen() {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  onError(listener: (code: string, channelId?: string) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private open() {
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.setStatus("open");
      this.confirmed.clear();
      for (const channelId of this.listeners.keys()) this.send({ type: "subscribe", channelId });
      // The agents' browsers someone is looking at (a watch sent before the socket opened was dropped).
      this.browserWatches.resumeAll();
      this.startPing();
      if (reconnected) for (const l of this.reconnectListeners) l();
    };
    socket.onmessage = (ev) => {
      // Anything heard proves the socket alive.
      if (this.pongTimer !== null) this.timers.clearTimeout(this.pongTimer);
      this.pongTimer = null;
      this.handle(parseServerFrame(ev.data));
    };
    socket.onerror = () => {
      // `onclose` follows and schedules the retry.
    };
    socket.onclose = () => this.lost();
  }

  private lost() {
    this.socket = null;
    this.clearTimers();
    // The server forgot this socket's views: their frame sockets go, and the watches made again bring new ones.
    this.closeFrameSockets();
    this.forgetPacing();
    if (!this.stopped) this.scheduleReconnect();
  }

  private handle(frame: ServerFrame | null) {
    if (!frame) return;
    if (frame.type.startsWith("browser.") || (frame.type === "error" && typeof frame.agentId === "string")) {
      if (frame.type === "browser.frames" && typeof frame.agentId === "string") {
        const ticket = (frame as { ticket?: unknown }).ticket;
        this.markPacing();
        if (typeof ticket === "string" && this.frameSocketsOn) this.openFrameSocket(frame.agentId, ticket);
        return;
      }
      if (frame.type === "browser.frame" && typeof frame.agentId === "string") {
        // Only a server that paces this view asks for answers: an older one would count each as a bad message.
        const ack = (frame as { ack?: unknown }).ack === true;
        if (ack) this.markPacing();
        const seq = (frame as { seq?: unknown }).seq;
        const capturedAt = (frame as { metadata?: { capturedAt?: unknown } }).metadata?.capturedAt;
        const last = this.lastBytes.get(frame.agentId);
        if (last && typeof seq === "number") {
          // No newer than the frame socket's last picture (sent before the switch): answered, never drawn over it.
          // Unless captured well after it: a stream that started again, numbered from 0.
          const restarted =
            typeof capturedAt === "number" && last.at !== undefined && capturedAt > last.at + BROWSER_RESTART_GAP_MS;
          if (seq <= last.seq && !restarted) {
            if (ack) this.ackBrowserFrame(frame.agentId, seq, true);
            return;
          }
          // Newer: the server sends here because it lost the frame socket, which may still look open on this side
          // (a half-open socket never closes here: nothing is sent on it but acks). It goes, so a stream that starts
          // over at 0 isn't taken for older pictures, and a new one is asked for (ADR 0040 §7.1).
          if (ack) {
            this.dropFrameSocket(frame.agentId);
            this.renewFrameSocket(frame.agentId);
          }
        }
        // Drawn: it came after the view's end on this same socket. A picture the frame socket held, maybe older, goes.
        if (this.halted.has(frame.agentId)) this.halted.set(frame.agentId, null);
        for (const l of this.browserListeners) l(frame as Record<string, unknown>);
        if (ack) this.ackBrowserFrame(frame.agentId, seq);
        return;
      }
      const agentId = (frame as { agentId?: unknown }).agentId;
      if (typeof agentId === "string" && endsView(frame)) this.halted.set(agentId, null);
      for (const l of this.browserListeners) l(frame as Record<string, unknown>);
      // The view runs again: a picture the frame socket held meanwhile is drawn, after the status.
      if (frame.type === "browser.status" && typeof agentId === "string") {
        const held = this.halted.get(agentId);
        this.halted.delete(agentId);
        if (held) for (const l of this.browserListeners) l(held);
      }
      return;
    }
    if (frame.type === "event" && "scope" in frame) {
      this.checkHeard(frame.event);
      for (const l of this.userListeners) l(frame.event);
    } else if (frame.type === "event") {
      if (frame.event.type === "message.created") {
        this.heard.add(frame.event.messageId);
        if (this.heard.size > HEARD_LIMIT) this.heard.delete(this.heard.values().next().value as string);
      }
      // "lê na próxima pausa" / "leu" under your messages: one store for every screen (`useSteerState`).
      steerStore.apply(frame.event);
      const set = this.listeners.get(frame.channelId);
      if (!set) return;
      for (const l of [...set]) l(frame.event);
    } else if (frame.type === "subscribed") {
      this.confirmed.add(frame.channelId);
      this.clearRetry(frame.channelId);
      for (const l of this.subscribedListeners) l(frame.channelId);
    } else if (frame.type === "unsubscribed") {
      // Dropped by the server (archived, membership recheck), or the answer to an unsubscribe overtaken by a new
      // listener: ask again while someone listens.
      this.confirmed.delete(frame.channelId);
      this.retrySubscribe(frame.channelId);
    } else if (frame.type === "error") {
      if (frame.channelId) this.retrySubscribe(frame.channelId);
      // Refused before the server read which channel: every one not confirmed yet may be the one.
      else if (frame.code === "rate_limited")
        for (const channelId of this.listeners.keys())
          if (!this.confirmed.has(channelId)) this.retrySubscribe(channelId);
      for (const l of this.errorListeners) l(frame.code, frame.channelId);
    }
  }

  /** A notification about a message in a channel open here: if its `message.created` doesn't come, subscribe anew. */
  private checkHeard(event: UserEvent) {
    if (event.type !== "notification.upserted" || !("notification" in event)) return;
    const { source, readAt } = event.notification;
    const { channelId, messageId } = source;
    if (!channelId || !messageId || readAt || !this.listeners.has(channelId) || this.heard.has(messageId)) return;
    this.timers.setTimeout(() => {
      if (this.heard.has(messageId) || !this.listeners.has(channelId)) return;
      this.confirmed.delete(channelId);
      this.send({ type: "unsubscribe", channelId });
      this.send({ type: "subscribe", channelId });
    }, MISSED_MESSAGE_GRACE_MS);
  }

  private clearRetry(channelId: string) {
    const retry = this.retries.get(channelId);
    if (retry && retry.timer !== null) this.timers.clearTimeout(retry.timer);
    this.retries.delete(channelId);
  }

  /** Subscribes again after a backoff; gives up after the last step (a real refusal), until the next reconnect. */
  private retrySubscribe(channelId: string) {
    if (!this.listeners.has(channelId)) return;
    const prev = this.retries.get(channelId);
    if (prev && prev.timer !== null) return;
    const attempt = prev?.attempt ?? 0;
    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    if (attempt >= backoff.length) return;
    const entry = { attempt: attempt + 1, timer: null as unknown };
    entry.timer = this.timers.setTimeout(() => {
      entry.timer = null;
      if (this.listeners.has(channelId)) this.send({ type: "subscribe", channelId });
    }, backoff[attempt] ?? 10_000);
    this.retries.set(channelId, entry);
  }

  private send(frame: unknown) {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(frame));
  }

  private scheduleReconnect() {
    const backoff = this.options.backoffMs ?? BACKOFF_MS;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 10_000;
    this.attempt++;
    this.setStatus("reconnecting");
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private startPing() {
    const ms = this.options.pingMs ?? 30_000;
    if (ms <= 0) return;
    this.pingTimer = this.timers.setInterval(() => this.checkAlive(), ms);
  }

  private clearTimers() {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    if (this.pongTimer !== null) this.timers.clearTimeout(this.pongTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    for (const retry of this.retries.values()) if (retry.timer !== null) this.timers.clearTimeout(retry.timer);
    this.retries.clear();
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }
}
