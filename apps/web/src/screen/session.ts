import type { DesktopMode, DesktopViewState } from "@agenteschat/client";
import { DESKTOP_CLOSE, desktopCloseState, desktopRetryMs, desktopSocketUrl } from "@agenteschat/client";
import type RFB from "@novnc/novnc";
import type { RfbChannel } from "@novnc/novnc";
import { type DesktopChannel, DesktopLink } from "../components/desktop/link";
import { INSERT, PASTE_MAX_BYTES, pasteBytes, SHIFT } from "../components/desktop/paste";
import { heldPicture, holdPicture, liveCanvas, showsPicture } from "../lib/canvas";

/** What the page tells the phone app; the app's side is `apps/mobile/src/features/computer/screen-page.ts`. */
export type ScreenEvent =
  | { type: "ready" }
  | { type: "view"; state: DesktopViewState }
  /** The desktop's size, in its own pixels: the app sizes this page to it. */
  | { type: "size"; width: number; height: number }
  /** The stream closed or changed mode: what the server says about the screen may have changed. */
  | { type: "changed" }
  /** noVNC's session took its mode: the app's switch cover ("Assumindo o controle…") waits for it. */
  | { type: "session"; mode: DesktopMode }
  | { type: "refused"; why: "tooLong" };

/** The keys the app's key row presses, as X keysyms. */
export const SCREEN_KEYS = {
  Tab: { keysym: 0xff09, code: "Tab" },
  Enter: { keysym: 0xff0d, code: "Enter" },
  Backspace: { keysym: 0xff08, code: "Backspace" },
  Escape: { keysym: 0xff1b, code: "Escape" },
  ArrowLeft: { keysym: 0xff51, code: "ArrowLeft" },
  ArrowUp: { keysym: 0xff52, code: "ArrowUp" },
  ArrowRight: { keysym: 0xff53, code: "ArrowRight" },
  ArrowDown: { keysym: 0xff54, code: "ArrowDown" },
} as const;
export type ScreenKey = keyof typeof SCREEN_KEYS;

/** How long a first picture is looked for, and how often, as in the web's `DesktopView`. */
const PICTURE_POLL_MS = 50;
const PICTURE_WAIT_MS = 10_000;
/** A stream that changes mode in place and hasn't this long after the mode changed opens again in the new one. */
const SWITCH_WAIT_MS = 3_000;
/** RFB's PointerEvent: its message type, then the buttons held and the position, big-endian. */
const POINTER_EVENT = 5;
/** A browser card's screen (`preview`) opens again this many times after drops, then says offline. */
const PREVIEW_RETRIES = 3;

export interface ScreenDeps {
  createRfb: (target: HTMLElement, channel: RfbChannel) => RFB;
  createSocket: (url: string) => WebSocket;
  post: (event: ScreenEvent) => void;
}

/**
 * The agent's screen on a page of its own, for the phone app's WebView (ADR 0098): what the web's `DesktopView` does
 * with a socket and noVNC, without its screen around it. The app holds every touch: noVNC here only draws, at the
 * desktop's own size, and the app moves and zooms the whole page. The pointer goes straight onto the session's
 * channel as an RFB message, since noVNC would read it from a mouse over a canvas the app transforms.
 *
 * `preview`: the browser card's view of the screen its browser runs on (ADR 0058 §7): watching only, and no wait of
 * its own on a screen it can't show (the card shows its browser's frames instead).
 */
export class ScreenSession {
  private want: { connect: boolean; mode: DesktopMode } = { connect: false, mode: "watch" };
  private link: DesktopLink | null = null;
  private channel: DesktopChannel | null = null;
  private rfb: RFB | null = null;
  /** The mode of noVNC's session now, once connected: what may take input. */
  private session: DesktopMode | null = null;
  private view: DesktopViewState | null = null;
  private attempts = 0;
  private gaveUp = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private switchTimer: ReturnType<typeof setTimeout> | undefined;
  private looking: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly target: HTMLElement,
    private readonly place: {
      orgId: string;
      agentId: string;
      base: Parameters<typeof desktopSocketUrl>[0];
      preview?: boolean;
    },
    private readonly deps: ScreenDeps,
  ) {}

  /** What the app wants now: called again for every change, so the same value does nothing. */
  set(asked: { connect: boolean; mode: DesktopMode }) {
    // A card's view only watches.
    const want = this.place.preview ? { ...asked, mode: "watch" as const } : asked;
    const was = this.want;
    this.want = want;
    if (!want.connect) return this.end();
    if (!was.connect) {
      this.gaveUp = false;
      return this.open();
    }
    if (was.mode === want.mode || !this.link) return;
    // A stream that changes in place stays: the server switches it. Any other opens again in the new mode.
    if (!this.link.mode) return this.open();
    clearTimeout(this.switchTimer);
    this.switchTimer = setTimeout(() => {
      if (this.session !== this.want.mode) this.open();
    }, SWITCH_WAIT_MS);
  }

  /** "Tentar de novo": one new socket, whatever had stopped it. */
  retry() {
    this.attempts = 0;
    this.gaveUp = false;
    this.say("connecting");
    this.open();
  }

  /** The person's pointer at a desktop position, with these buttons held (bit 0 the left, bits 3 and 4 the wheel). */
  pointer(x: number, y: number, buttons: number) {
    if (this.session !== "control" || !this.channel) return;
    const px = Math.max(0, Math.min(0xffff, Math.round(x)));
    const py = Math.max(0, Math.min(0xffff, Math.round(y)));
    this.channel.send(new Uint8Array([POINTER_EVENT, buttons & 0xff, px >> 8, px & 0xff, py >> 8, py & 0xff]));
  }

  key(name: ScreenKey) {
    const k = SCREEN_KEYS[name];
    if (k && this.session === "control") this.rfb?.sendKey(k.keysym, k.code);
  }

  /** A whole text into the field in focus there (ADR 0058 §16): typed, or pasted when noVNC can't type it. */
  type(text: string) {
    if (this.session !== "control" || !text) return;
    // noVNC types one UTF-16 unit per key: an emoji goes as a paste.
    if ([...text].some((c) => c.length > 1)) return this.paste(text);
    const canvas = liveCanvas(this.target);
    // With no code, noVNC presses and lets go of the key's character.
    for (const key of text) canvas?.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
  }

  private paste(text: string) {
    if (pasteBytes(text) > PASTE_MAX_BYTES) return this.deps.post({ type: "refused", why: "tooLong" });
    this.rfb?.clipboardPasteFrom(text);
    for (const k of [SHIFT, INSERT]) this.rfb?.sendKey(k.keysym, k.code, true);
    for (const k of [INSERT, SHIFT]) this.rfb?.sendKey(k.keysym, k.code, false);
  }

  private say(state: DesktopViewState) {
    if (state === this.view) return;
    this.view = state;
    this.deps.post({ type: "view", state });
  }

  /** Lets go of the socket and noVNC; whatever closes after this is no longer heard. */
  private end() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.switchTimer);
    clearInterval(this.looking);
    const { link, rfb } = this;
    this.link = null;
    this.channel = null;
    this.rfb = null;
    this.session = null;
    if (rfb) rfb.disconnect();
    else link?.socket.close();
  }

  private open() {
    const holding = heldPicture(this.target) !== null || holdPicture(this.target);
    this.end();
    if (!holding) this.say("connecting");
    const { orgId, agentId, base, preview } = this.place;
    const mode = this.want.mode;
    const socket = this.deps.createSocket(
      desktopSocketUrl(
        base,
        preview ? { orgId, agentId, mode: "watch", preview: true } : { orgId, agentId, mode, switches: true },
      ),
    );
    const link = new DesktopLink(socket);
    this.link = link;
    socket.addEventListener("close", (e) => this.closed(link, e));
    link.onSwitch = (next) => {
      clearTimeout(this.switchTimer);
      clearInterval(this.looking);
      holdPicture(this.target);
      this.session = null;
      this.rfb?.disconnect();
      this.start(link, next);
      this.deps.post({ type: "changed" });
    };
    this.start(link, mode);
  }

  private closed(link: DesktopLink, e: CloseEvent) {
    // A close that arrives after the next connection took over leaves that one be.
    if (this.link !== link) return;
    this.link = null;
    this.channel = null;
    this.rfb = null;
    this.session = null;
    clearInterval(this.looking);
    clearTimeout(this.switchTimer);
    const preview = this.place.preview === true;
    const next = desktopCloseState(e.code, e.reason, { preview });
    // A card's screen that keeps dropping says so, and the card shows the frames.
    const spent = preview && next.retry !== "never" && this.attempts >= PREVIEW_RETRIES;
    if (e.code !== DESKTOP_CLOSE.controlEnded || !holdPicture(this.target)) {
      heldPicture(this.target)?.remove();
      this.say(spent ? "offline" : next.state);
    }
    this.deps.post({ type: "changed" });
    if (next.retry === "never" || spent) {
      this.gaveUp = true;
      return;
    }
    // "now" still waits a moment: the new state (control handed back) usually changes the mode first.
    const delay = next.retry === "now" ? 250 : desktopRetryMs(this.attempts);
    this.attempts++;
    this.retryTimer = setTimeout(() => {
      if (this.want.connect && !this.gaveUp) this.open();
    }, delay);
  }

  /** noVNC on the socket's next session, in `mode`. */
  private start(link: DesktopLink, mode: DesktopMode) {
    const control = mode === "control";
    const channel = link.channel();
    const rfb = this.deps.createRfb(this.target, channel);
    this.channel = channel;
    this.rfb = rfb;
    rfb.viewOnly = !control;
    rfb.qualityLevel = control ? 6 : 3;
    rfb.compressionLevel = 2;
    // Drawn at the desktop's own size: the app moves and zooms this page.
    rfb.scaleViewport = false;
    rfb.resizeSession = false;
    rfb.focusOnClick = false;
    rfb.background = "transparent";
    rfb.addEventListener("connect", () => {
      if (this.rfb !== rfb) return;
      this.attempts = 0;
      this.session = mode;
      this.deps.post({ type: "session", mode });
      const since = Date.now();
      const look = () => {
        const canvas = liveCanvas(this.target);
        if (canvas && !showsPicture(canvas) && Date.now() - since < PICTURE_WAIT_MS) return;
        clearInterval(this.looking);
        heldPicture(this.target)?.remove();
        if (canvas) this.deps.post({ type: "size", width: canvas.width, height: canvas.height });
        this.say("live");
      };
      clearInterval(this.looking);
      this.looking = setInterval(look, PICTURE_POLL_MS);
      look();
    });
  }
}
