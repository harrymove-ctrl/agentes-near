import { BROWSER_LIMITS, BROWSER_VIEW, type BrowserInputEvent, parseBrowserInputEvent } from "@agenteschat/adapters";

/**
 * The agent browser's live view on `/api/ws` (ADR 0040 §7). Client frames:
 *
 * - `{"type":"browser.watch","agentId","acks"?:true,"frames"?:true,"maxFps"?}`:
 *   start getting that agent's browser (checked like the HTTP routes:
 *   `requireBrowserAccess`). `acks`: this client answers each `browser.frame`
 *   that says `"ack":true` with `{"type":"browser.ack","agentId","seq"}` once
 *   it drew it, and gets frames in a window (`createViewerPacer`, ADR 0040
 *   §7.1), at most `maxFps` a second (`1..BROWSER_VIEW.maxFps`; absent, or the
 *   top rate: as the window allows). Without it (older apps), the newest frame once a second
 *   (`BROWSER_VIEW.legacyFps`), skipped while its socket is backed up.
 *   `frames` (with `acks`): the server answers
 *   `{"type":"browser.frames","agentId","ticket"}` (when the browser streams
 *   on this server and the view has no frame socket open yet) and the client
 *   opens `GET /api/browser/frames?ticket=` (once, within `FRAME_TICKET_MS`):
 *   from then on that view's pictures come there as bytes
 *   (`encodeBrowserFrame`: version, header length, JSON header, JPEG), and
 *   the client answers each one it drew there with `{"type":"ack"}`. While it
 *   isn't open (or after it closed) they come here as before. The frame
 *   socket stays open across watches of the same agent on this socket; it
 *   closes on `browser.unwatch` or when this socket closes.
 * - `{"type":"browser.fps","agentId","maxFps"}`: the rate of a view this
 *   socket watches with `acks`, changed in place (a card opened or closed); one
 *   sent while a watch of that agent is still starting applies to it.
 * - `{"type":"browser.frames.renew","agentId"}`: its frame socket closed while
 *   the view goes on: a new `browser.frames` ticket for the same view (at most
 *   one every `FRAME_RENEW_MS`), even while the server still sees one open (a
 *   socket left half-open by a network change); opening it replaces that one.
 * - `{"type":"browser.unwatch","agentId"}`.
 * - `{"type":"browser.input","agentId","events":[…]}`: only from the person
 *   in control of the open handoff; events as `BrowserInputEvent` (mouse,
 *   key, touch, and `text` for the app's own text field).
 *
 * Server frames (not wrapped, unlike channel events): `browser.frame`
 * (`{agentId, seq, data: base64 JPEG, metadata: {deviceWidth, deviceHeight,
 * pageScaleFactor?, url?, title?}}`; a watch on a running stream gets its
 * newest frame at once), `browser.status` (`{agentId, mode,
 * controllerUserId, handoff, hidden}`; `hidden`: someone else is in control,
 * so no frames reach this viewer until they hand it back, then the newest
 * comes at once),
 * `browser.unavailable` (`{agentId, reason: reconnecting | offline |
 * no_computer | closed | unavailable | forbidden, message?}`: send
 * `browser.watch` again with backoff on `reconnecting`, and on `closed` (the
 * agent's browser isn't open; it shows once something opens it); a repeated
 * watch restarts the view, so it also recovers after `offline`, an ended
 * stream or `forbidden`),
 * `browser.ended` (`{agentId, reason, message?}`), and `error` with
 * `code` and `agentId` (`forbidden`, `not_found`, `too_many_browsers`,
 * `not_in_control`, `input_failed` (the computer couldn't put a person's input on the page), `no_field` (their text
 * reached a page with nothing focused to take it), `rate_limited`).
 */
export type BrowserClientFrame =
  | { type: "browser.watch"; agentId: string; acks?: true; frames?: true; maxFps?: number }
  | { type: "browser.fps"; agentId: string; maxFps: number }
  | { type: "browser.frames.renew"; agentId: string }
  | { type: "browser.unwatch"; agentId: string }
  | { type: "browser.ack"; agentId: string }
  | { type: "browser.input"; agentId: string; events: BrowserInputEvent[] };

/** A watched browser's frame socket (ADR 0040 §7.1), opened with a ticket from `browser.frames`. */
export const BROWSER_FRAMES_PATH = "/api/browser/frames";
/** How long a frame socket's ticket opens it. */
export const FRAME_TICKET_MS = 30_000;
/** A view gets a new frame socket ticket (`browser.frames.renew`) at most this often. */
export const FRAME_RENEW_MS = 1000;
/** A frame socket backed up past this skips frames (the newest goes next), as the realtime socket does. */
export const MAX_FRAME_BACKLOG = 1024 * 1024;

/** What a person sends on a frame socket: only `{"type":"ack"}`, one per picture drawn. Null for anything else. */
export function parseFrameSocketMessage(raw: string | Buffer): { type: "ack" } | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  try {
    return (JSON.parse(raw) as { type?: unknown } | null)?.type === "ack" ? { type: "ack" } : null;
  } catch {
    return null;
  }
}

/** Largest browser client frame: a batch of input events with a pasted text. */
export const MAX_BROWSER_CLIENT_FRAME = BROWSER_LIMITS.inputText * 2 + 64 * 1024;
/** Agents' browsers one socket may watch at once. */
export const MAX_WATCHED_BROWSERS = 4;
/** Input frames per second from one socket (a drag sends many moves). */
export const BROWSER_INPUT_PER_SECOND = 60;

/** An agent's id, or a browser profile's live-view key (`profile:<id>`, ADR 0110). */
const UUID = /^(profile:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A rate a viewer asked for, within `1..BROWSER_VIEW.maxFps`; undefined when it isn't a number. */
function fps(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(BROWSER_VIEW.maxFps, Math.max(1, value));
}

/** A browser frame of the live view, checked; null when the frame isn't one (or is malformed). */
export function parseBrowserClientFrame(raw: string | Buffer): BrowserClientFrame | null {
  if (raw.length > MAX_BROWSER_CLIENT_FRAME) return null;
  const text = String(raw);
  // Cheap test before parsing: every other client frame is small and never says "browser.".
  if (!text.includes('"browser.')) return null;
  try {
    const frame = JSON.parse(text) as {
      type?: unknown;
      agentId?: unknown;
      events?: unknown;
      acks?: unknown;
      frames?: unknown;
      maxFps?: unknown;
    };
    if (typeof frame.agentId !== "string" || !UUID.test(frame.agentId)) return null;
    const maxFps = fps(frame.maxFps);
    if (frame.type === "browser.watch") {
      const acks = frame.acks === true;
      return {
        type: frame.type,
        agentId: frame.agentId,
        ...(acks ? { acks: true as const } : {}),
        // Frames on their own socket, and a rate of its own, come in a window: only for a client that answers them.
        ...(acks && frame.frames === true ? { frames: true as const } : {}),
        ...(acks && maxFps !== undefined ? { maxFps } : {}),
      };
    }
    if (frame.type === "browser.fps") {
      return maxFps === undefined ? null : { type: frame.type, agentId: frame.agentId, maxFps };
    }
    if (frame.type === "browser.unwatch" || frame.type === "browser.ack" || frame.type === "browser.frames.renew") {
      return { type: frame.type, agentId: frame.agentId };
    }
    if (frame.type === "browser.input" && Array.isArray(frame.events)) {
      if (frame.events.length === 0 || frame.events.length > BROWSER_LIMITS.inputEvents) return null;
      const events: BrowserInputEvent[] = [];
      for (const e of frame.events) {
        const parsed = parseBrowserInputEvent(e);
        if (!parsed) return null;
        events.push(parsed);
      }
      return { type: "browser.input", agentId: frame.agentId, events };
    }
  } catch {}
  return null;
}

/** A full window with no ack for this long sends the newest frame anyway (a hidden tab draws nothing). */
export const VIEWER_ACK_STALL_MS = BROWSER_VIEW.viewerStallMs;
/**
 * A frame its backed-up socket couldn't take is tried again this often: an idle page sends no newer one, so it
 * would otherwise never show (ADR 0040 §7.1). Bun says nothing when a socket drains.
 */
export const VIEWER_BACKLOG_RETRY_MS = 250;

export interface ViewerPacer<M extends { type: string } = { type: string }> {
  /** A live-view message to the viewer: frames in the window and at its rate, everything else at once. */
  send(message: M): void;
  /** The viewer drew a frame (`browser.ack`, or `{"type":"ack"}` on its frame socket). */
  ack(): void;
  /** The frames on their way will never be acked (their frame socket closed): the window starts again. */
  reset(): void;
  /** Whether it would send a frame now: room in the window, and its rate allows it. */
  room(): boolean;
  /** Frames at most this often from now on (`browser.fps`); 0: as the window allows. */
  setMinInterval(ms: number): void;
  /** The view ended: nothing held goes out any more. */
  close(): void;
}

/**
 * Live-view frames to one viewer in a window (ADR 0040 §7.1): at most `window` frames it hasn't drawn yet are on
 * their way; a frame that finds the window full waits in place of the one waiting before it, so a slow link (a
 * phone on mobile data) shows the page as it is now rather than the seconds it fell behind. `minIntervalMs` caps its
 * rate the same way (a thumbnail needs one frame a second): a frame sooner than that waits, newest wins, and one
 * timer sends it when the interval ends. Other messages go at once; one that ends or hides the view drops the frame
 * waiting, which would show a page it no longer may. `deliver` answering false sent nothing (its socket is backed
 * up): that frame takes no room in the window, and waits (newest wins) to be tried again. `onRoom`: the viewer may
 * take a frame again (it drew one, or its interval passed), so the computer's next one is worth sending.
 */
export function createViewerPacer<M extends { type: string }>(
  deliver: (message: M) => unknown,
  opts: {
    window?: number;
    stallMs?: number;
    minIntervalMs?: number;
    onRoom?: () => void;
    /** Tests: how soon a frame its backed-up socket refused is tried again (`VIEWER_BACKLOG_RETRY_MS`). */
    retryMs?: number;
    now?: () => number;
    timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  } = {},
): ViewerPacer<M> {
  const window = opts.window ?? BROWSER_VIEW.window;
  const stallMs = opts.stallMs ?? VIEWER_ACK_STALL_MS;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  let minIntervalMs = Math.max(0, opts.minIntervalMs ?? 0);
  let inflight = 0;
  let held: M | null = null;
  let stall: unknown = null;
  /** Ends the current interval: the frame waiting for it goes, and the viewer has room again. */
  let pace: unknown = null;
  /** Tries the frame its backed-up socket refused again. */
  let retry: unknown = null;
  let lastSent = Number.NEGATIVE_INFINITY;
  let closed = false;
  const unstall = () => {
    if (stall !== null) timers.clearTimeout(stall);
    stall = null;
  };
  const unpace = () => {
    if (pace !== null) timers.clearTimeout(pace);
    pace = null;
  };
  const unretry = () => {
    if (retry !== null) timers.clearTimeout(retry);
    retry = null;
  };
  const release = () => {
    const next = held;
    held = null;
    if (next) pacer.send(next);
  };
  const schedulePace = () => {
    if (pace !== null || minIntervalMs <= 0) return;
    const wait = Math.max(0, lastSent + minIntervalMs - now());
    pace = timers.setTimeout(() => {
      pace = null;
      release();
      opts.onRoom?.();
    }, wait);
  };
  const pacer: ViewerPacer<M> = {
    send(message) {
      if (closed) return;
      if (message.type !== "browser.frame") {
        const hides =
          message.type === "browser.ended" ||
          message.type === "browser.unavailable" ||
          (message.type === "browser.status" && (message as { hidden?: unknown }).hidden === true);
        if (hides) {
          held = null;
          unpace();
          unretry();
        }
        deliver(message);
        return;
      }
      if (inflight >= window) {
        held = message;
        stall ??= timers.setTimeout(() => {
          stall = null;
          // Nothing drawn in all this time: start the window again, from the newest frame.
          inflight = 0;
          release();
          opts.onRoom?.();
        }, stallMs);
        return;
      }
      if (now() - lastSent < minIntervalMs) {
        held = message;
        schedulePace();
        return;
      }
      // This frame is newer than any waiting one, which must never follow it.
      held = null;
      unpace();
      unretry();
      inflight++;
      const before = lastSent;
      lastSent = now();
      // Not sent (its socket is backed up): it takes no room in the window, and waits to be tried again.
      if (deliver(message) === false) {
        inflight--;
        lastSent = before;
        held = message;
        retry = timers.setTimeout(() => {
          retry = null;
          release();
        }, opts.retryMs ?? VIEWER_BACKLOG_RETRY_MS);
        return;
      }
      // The computer hears when this viewer's rate lets the next frame go.
      if (opts.onRoom) schedulePace();
    },
    ack() {
      // An ack for nothing on its way (a confused client) lets nothing go.
      if (closed || inflight === 0) return;
      inflight--;
      unstall();
      release();
      opts.onRoom?.();
    },
    reset() {
      if (closed) return;
      inflight = 0;
      unstall();
      release();
      opts.onRoom?.();
    },
    room: () => !closed && inflight < window && now() - lastSent >= minIntervalMs,
    setMinInterval(ms) {
      if (closed) return;
      minIntervalMs = Math.max(0, ms);
      unpace();
      // A frame waiting for the old interval goes now, or waits for the new one.
      if (held && inflight < window) release();
      opts.onRoom?.();
    },
    close() {
      closed = true;
      held = null;
      unstall();
      unpace();
      unretry();
    },
  };
  return pacer;
}

/**
 * The interval between frames for a rate a viewer asked for (`maxFps`, `1..BROWSER_VIEW.maxFps`). The top rate is no
 * limit at all, as a watch that names none: the computer sends no faster, and an interval would only hold back
 * frames that come a little early (jitter) and the acks the computer waits for, while a person is in control.
 */
export const fpsInterval = (maxFps: number) => (maxFps >= BROWSER_VIEW.maxFps ? 0 : 1000 / Math.max(1, maxFps));
/** What an app that answers no frames gets: one frame a second, as before the window (`BROWSER_VIEW.legacyFps`). */
export const LEGACY_INTERVAL_MS = 1000 / BROWSER_VIEW.legacyFps;
