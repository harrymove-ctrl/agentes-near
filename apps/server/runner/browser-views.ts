import {
  BROWSER_VIEW,
  encodeBrowserFrame,
  type RunnerFrame,
  STREAM_CLOSE,
} from "@agenteschat/adapters/machine-protocol";
import type { DataSocket } from "./streams";

type Frame = Extract<RunnerFrame, { type: "browser.frame" }>;

interface View {
  agentId: string;
  socket: DataSocket;
  /** Frames sent and not acknowledged yet. */
  inflight: number;
  /** The newest frame while the window is full: it goes at the next acknowledgement, older ones never do. */
  held: Frame | null;
  stall: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /** What it did, logged once when it ends, so a slow live view can be told from a slow page (ADR 0040 §7.1). */
  sent: number;
  /** Frames that waited while the window was full and a newer one took their place. */
  replaced: number;
  bytes: number;
  /** Ended because no acknowledgement came in `stallMs`. */
  stalled: boolean;
}

/**
 * A full window waits `stallMs` at a time while its socket is still sending (a slow uplink, not a dead one), but no
 * longer than this many in all.
 */
const STALL_ROUNDS = 4;

export interface BrowserViewsOptions {
  /** Dials the data socket `streamId` names (`DataSockets.dial`, counted as `browserView`). */
  dial(streamId: string): Promise<DataSocket>;
  /** One line per view when it ends: what it sent, what it skipped, whether it stalled. */
  log?: (line: string) => void;
  /**
   * A view that died while its stream runs (no acknowledgement, or the server closed it) hands its agent's newest
   * frame here, to go on the machine socket: the server takes it (newer than anything the view brought), so an idle
   * page shows its current picture even if no view opens again.
   */
  fallback?: (frame: Frame) => void;
  /** Tests: smaller or shorter than `BROWSER_VIEW`. */
  window?: number;
  stallMs?: number;
}

/**
 * The live views of the agents' browsers on this computer (ADR 0040 §7.1, protocol 49): one data socket per agent
 * (or browser profile) the server asked for with `browser.view.open`, held by the process that holds the server's
 * connection (root in system mode: the workers pass their frames up as before, and only root has the machine's
 * token). That agent's frames go there as bytes (`encodeBrowserFrame`), never as `browser.frame` on the machine
 * socket, so a picture never delays a command and the bytes carry no base64. At most `window` frames are on their
 * way unacknowledged (the server answers each with `{"type":"ack"}`, within `BROWSER_VIEW.ackOwedMs` even when
 * nobody watching has room); a frame that finds the window full waits in place of the one waiting before it. A slow
 * link then shows the page as it is now, never the seconds it fell behind. A full window with no acknowledgement for
 * `stallMs`, and no bytes leaving meanwhile, is a dead socket: the view ends, and that agent's frames are the caller's
 * again until the server opens a new one. Frames of an agent with no view are the caller's to send as before.
 */
export class BrowserViews {
  private readonly views = new Map<string, View>();
  /**
   * Each streaming agent's newest frame, kept until its stream ends: a new view starts with it. With `pacing=ack` an
   * idle page sends nothing new, so the picture a dead view held (or lost on its way) would otherwise never come.
   */
  private readonly latest = new Map<string, Frame>();
  /**
   * An agent's view has room for its next frame again, or it ended: its browser's stream may send the next one
   * (`BrowserManager.room`; in system mode root tells the agent's worker, `Supervisor.browserRoom`).
   */
  onRoom: (agentId: string) => void = () => {};

  constructor(private readonly opts: BrowserViewsOptions) {}

  private get windowSize(): number {
    return this.opts.window ?? BROWSER_VIEW.window;
  }

  /** `browser.view.open`: answers once the server took the data socket; a view this agent had closes. */
  async open(agentId: string, streamId: string): Promise<{ opened: true }> {
    const socket = await this.opts.dial(streamId);
    const old = this.views.get(agentId);
    // Not `end`: the stream goes on, and its newest frame is the new view's first.
    if (old) this.close(old, STREAM_CLOSE.normal, "a new view", false);
    const view: View = {
      agentId,
      socket,
      inflight: 0,
      held: null,
      stall: null,
      closed: false,
      sent: 0,
      replaced: 0,
      bytes: 0,
      stalled: false,
    };
    this.views.set(agentId, view);
    socket.listen({
      // Nothing comes down as bytes on a view: what a person sends goes on the machine socket.
      bytes: () => undefined,
      control: (frame) => {
        if (frame.type === "ack") this.acked(view);
      },
      closed: () => this.drop(view),
    });
    const last = this.latest.get(agentId);
    if (last) this.send(view, last);
    return { opened: true };
  }

  /** One of an agent's frames: true when its view took it (sent, or kept as the newest), false when there is none. */
  push(frame: Frame): boolean {
    this.latest.set(frame.agentId, frame);
    const view = this.views.get(frame.agentId);
    if (!view) return false;
    if (view.inflight >= this.windowSize) {
      if (view.held) view.replaced++;
      view.held = frame;
      this.watchStall(view);
      return true;
    }
    this.send(view, frame);
    return true;
  }

  /** Whether an agent's next frame would go at once: its view has room, or it has none. */
  room(agentId: string): boolean {
    const view = this.views.get(agentId);
    return !view || this.hasRoom(view);
  }

  /** Whether the agent has a view open. */
  has(agentId: string): boolean {
    return this.views.has(agentId);
  }

  /** The agent's stream ended: its view closes, and the server opens a new one with its next stream. */
  end(agentId: string) {
    this.latest.delete(agentId);
    const view = this.views.get(agentId);
    if (view) this.close(view, STREAM_CLOSE.normal, "the stream ended", false);
  }

  /** The server's connection dropped: every view goes (the server opens them again with the streams). */
  closeAll() {
    for (const agentId of [...this.views.keys()]) this.end(agentId);
    // The streams stop with the connection (`BrowserManager.stopStreams`): nothing they sent is newest any more.
    this.latest.clear();
  }

  /** Agents with a view open (tests, the activity log). */
  viewing(): string[] {
    return [...this.views.keys()];
  }

  private hasRoom(view: View): boolean {
    return !view.closed && view.inflight < this.windowSize && view.held === null;
  }

  private send(view: View, frame: Frame) {
    const jpeg = Buffer.from(frame.data, "base64");
    const bytes = encodeBrowserFrame({ seq: frame.seq, metadata: frame.metadata }, jpeg);
    view.socket.send(bytes);
    view.inflight++;
    view.sent++;
    view.bytes += bytes.byteLength;
    // Full: the stream sends nothing more until there is room (`pacing=ack`), so the wait starts now.
    if (view.inflight >= this.windowSize) this.watchStall(view);
  }

  /**
   * A full window: the server answers every frame within `ackOwedMs`, so `stallMs` without an acknowledgement means
   * the socket is dead, not slow, unless its bytes are still leaving (frames of a slow uplink, the ack behind them):
   * then it waits another `stallMs`, up to `STALL_ROUNDS` in all. Otherwise the view ends, and the server opens a
   * new one.
   */
  private watchStall(view: View) {
    if (view.stall) return;
    const stallMs = this.opts.stallMs ?? BROWSER_VIEW.stallMs;
    const since = Date.now();
    let buffered = view.socket.bufferedAmount;
    const arm = () => {
      view.stall = setTimeout(check, stallMs);
      (view.stall as { unref?: () => void }).unref?.();
    };
    const check = () => {
      view.stall = null;
      if (view.closed) return;
      const now = view.socket.bufferedAmount;
      if (now < buffered && Date.now() - since < stallMs * STALL_ROUNDS) {
        buffered = now;
        arm();
        return;
      }
      view.stalled = true;
      this.close(view, STREAM_CLOSE.viewTooSlow, "no acknowledgement");
    };
    arm();
  }

  private acked(view: View) {
    if (view.closed) return;
    view.inflight = Math.max(0, view.inflight - 1);
    this.release(view);
    if (this.hasRoom(view)) this.onRoom(view.agentId);
  }

  /** The frame waiting goes, when there is room for it. */
  private release(view: View) {
    if (view.stall) clearTimeout(view.stall);
    view.stall = null;
    const held = view.held;
    view.held = null;
    if (held && !view.closed) this.push(held);
  }

  private close(view: View, code: number, reason: string, handOver = true) {
    this.drop(view, handOver);
    view.socket.close(code, reason);
  }

  /** The view is gone; its agent's newest frame stays in `latest` for the next one. */
  private drop(view: View, handOver = true) {
    if (view.closed) return;
    view.closed = true;
    // Its stream goes on without it: the newest picture, which it may have held or lost on its way, goes the other way.
    const last = handOver ? this.latest.get(view.agentId) : undefined;
    if (last) this.opts.fallback?.(last);
    view.held = null;
    if (view.stall) clearTimeout(view.stall);
    view.stall = null;
    if (this.views.get(view.agentId) === view) this.views.delete(view.agentId);
    this.opts.log?.(
      `browser view of ${view.agentId} ended${view.stalled ? " (no acknowledgement)" : ""}: ${view.sent} frames, ` +
        `${view.replaced} skipped while the window was full, ${view.bytes} bytes`,
    );
    // Nothing waits for its room any more: the stream's next frame goes on the machine socket.
    this.onRoom(view.agentId);
  }
}
