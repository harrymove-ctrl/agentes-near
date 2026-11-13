import { type DesktopMode, desktopModeFrame } from "@agenteschat/client";
import type { RfbChannel } from "@novnc/novnc";

/** One RFB session's side of a `DesktopLink`, in the shape noVNC takes for a socket. */
export class DesktopChannel implements RfbChannel {
  binaryType = "arraybuffer";
  protocol = "";
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  /** Frames that came before noVNC set itself up on this channel. */
  private early: MessageEvent[] = [];
  private started = false;
  private over = false;
  private ended = false;

  constructor(
    private readonly socket: WebSocket,
    early: MessageEvent[],
  ) {
    this.early = early;
    // noVNC takes the channel in its constructor and is set up right after it: what came before goes to it then.
    queueMicrotask(() => {
      this.started = true;
      for (const e of this.early.splice(0)) this.onmessage?.(e);
    });
  }

  get readyState() {
    return this.ended ? WebSocket.CLOSED : this.socket.readyState;
  }

  send(data: Uint8Array<ArrayBuffer>) {
    if (!this.over) this.socket.send(data);
  }

  /** noVNC lets go: the socket closes with it, unless a switch already ended this session. */
  close() {
    if (this.ended) return;
    if (!this.over) return this.socket.close();
    this.ended = true;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "", wasClean: true } as CloseEvent));
  }

  deliver(e: MessageEvent) {
    if (this.over) return;
    if (this.started) this.onmessage?.(e);
    else this.early.push(e);
  }

  /** The session ended in a switch: it takes and sends nothing more. */
  stop() {
    this.over = true;
  }

  closed(e: CloseEvent) {
    if (this.ended) return;
    this.ended = true;
    this.onclose?.(e);
  }
}

/**
 * A person's socket to an agent's desktop whose mode may change in place (ADR 0058 §17): noVNC gets a channel of
 * its own for each RFB session, all on this socket. The stream's first text frame says it does, and its mode; each
 * one after it is the computer's mark where a session ends: the channel in use takes nothing more, the socket says
 * it took the switch, and what follows waits for the next channel. A stream that never says so (an older server or
 * computer) is one session on this socket, like a plain one. It listens from the tick the socket is made: the
 * computer speaks first, and what reaches a socket before anyone listens is lost.
 */
export class DesktopLink {
  /** The stream's mode once it said it changes in place; null while it hasn't. */
  mode: DesktopMode | null = null;
  /** The server switched the stream: a new session in `mode` follows, for the next channel. */
  onSwitch: ((mode: DesktopMode) => void) | null = null;
  private current: DesktopChannel | null = null;
  private waiting: MessageEvent[] = [];

  constructor(readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (e) => this.message(e as MessageEvent));
    socket.addEventListener("open", (e) => this.current?.onopen?.(e));
    socket.addEventListener("error", (e) => this.current?.onerror?.(e));
    // noVNC takes its screen off the page as its socket closes: the page's own listeners keep its picture first.
    socket.addEventListener("close", (e) => queueMicrotask(() => this.current?.closed(e as CloseEvent)));
  }

  /** The channel for noVNC's next session (the first, or the one after a switch). */
  channel() {
    this.current = new DesktopChannel(this.socket, this.waiting.splice(0));
    return this.current;
  }

  private message(e: MessageEvent) {
    if (typeof e.data !== "string") {
      if (this.current) this.current.deliver(e);
      else this.waiting.push(e);
      return;
    }
    const mode = desktopModeFrame(e.data);
    if (!mode) return;
    const first = this.mode === null;
    this.mode = mode;
    if (first) return;
    this.current?.stop();
    this.current = null;
    this.socket.send(e.data);
    this.onSwitch?.(mode);
  }
}
