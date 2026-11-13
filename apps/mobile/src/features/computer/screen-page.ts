import type { DesktopMode, DesktopViewState } from "@agenteschat/client";
import { originOf } from "@agenteschat/client/lib/server";

/*
 * The agent's screen on the phone (ADR 0098): the app's side of the server's `/screen.html`, in a WebView. The page
 * holds the stream and draws it; the app holds every touch and tells it what to do. Pure, so it is unit-tested.
 */

/** What the page says (`apps/web/src/screen/session.ts`). */
export type ScreenEvent =
  | { type: "ready" }
  | { type: "view"; state: DesktopViewState }
  | { type: "size"; width: number; height: number }
  | { type: "changed" }
  /** The stream's session took its mode (a page from before it never says). */
  | { type: "session"; mode: DesktopMode }
  | { type: "refused"; why: "tooLong" };

const VIEW_STATES: ReadonlySet<string> = new Set<DesktopViewState>([
  "connecting",
  "live",
  "hidden",
  "offline",
  "busy",
  "noRoom",
  "paused",
  "held",
  "forbidden",
  "outdated",
  "unavailable",
  "ended",
]);

/** The page's address for one agent. `preview`: a browser card's view, which only watches (ADR 0058 §7). */
export const screenPageUrl = (server: string, orgId: string, agentId: string, o: { preview?: boolean } = {}) => {
  const query = new URLSearchParams({ o: orgId, a: agentId, ...(o.preview ? { p: "1" } : {}) });
  return `${server}/screen.html?${query.toString()}`;
};

/** This WebView holds a session, so only the server's own page ever loads in it: never a link, a redirect or a frame. */
export function screenPageStays(server: string, url: string): boolean {
  const page = new URL(`${server}/screen.html`);
  try {
    const to = new URL(url);
    return to.origin === page.origin && to.pathname === page.pathname;
  } catch {
    return false;
  }
}

/** One message from the server's page, or null for anything else. */
export function screenEvent(server: string, from: { url: string; data: string }): ScreenEvent | null {
  if (originOf(from.url) !== new URL(server).origin) return null;
  let m: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(from.data);
    if (typeof parsed !== "object" || parsed === null) return null;
    m = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (m.type === "ready" || m.type === "changed") return { type: m.type };
  if (m.type === "view" && typeof m.state === "string" && VIEW_STATES.has(m.state)) {
    return { type: "view", state: m.state as DesktopViewState };
  }
  if (m.type === "size" && Number(m.width) > 0 && Number(m.height) > 0) {
    return { type: "size", width: Number(m.width), height: Number(m.height) };
  }
  if (m.type === "session" && (m.mode === "watch" || m.mode === "control")) return { type: "session", mode: m.mode };
  if (m.type === "refused" && m.why === "tooLong") return { type: "refused", why: "tooLong" };
  return null;
}

/**
 * The session for the page's socket. A WebView shares neither the app's stored cookie nor its headers, so the cookie is
 * set from the page, before anything else runs there, in a WebView that keeps nothing (`incognito`) and loads nothing
 * else (`screenPageStays`).
 */
export function sessionCookieScript(cookie: string, server: string): string {
  const secure = server.startsWith("https:") ? "; secure" : "";
  const sets = cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes("="))
    .map((pair) => `document.cookie=${JSON.stringify(`${pair}; path=/; samesite=strict${secure}`)};`);
  return `${sets.join("")}true;`;
}

/**
 * What the app answers a page event with: the session cookie again, set in the page's own document, before each time
 * its socket may open (`ready` comes before the app's first `set`, `changed` before the page opens again after a
 * close). On Android the start script runs at `onPageStarted`, which may still be the document before this one, and
 * any `incognito` WebView mounting clears every WebView's cookies, so the start script's cookie can't be counted on
 * there: the socket opened with no session and the screen stayed on opening.
 */
export const sessionAnswer = (event: ScreenEvent, cookie: string, server: string): string | null =>
  event.type === "ready" || event.type === "changed" ? sessionCookieScript(cookie, server) : null;

/**
 * Whether the agent's screen waits on something that may never come, so past its time it says it can't be shown and is
 * reported: opening while the app is in front (its state never came, or its socket never opened) or a switch the stream
 * never takes.
 */
export const screenWaits = (s: { active: boolean; shown: DesktopViewState; switching: boolean }) =>
  s.active && (s.shown === "connecting" || (s.shown === "live" && s.switching));

export type PageCalls = {
  set: [{ connect: boolean; mode: DesktopMode }];
  retry: [];
  pointer: [x: number, y: number, buttons: number];
  key: [name: ScreenKey];
  type: [text: string];
};

/** A call on the page, for `injectJavaScript`. JSON keeps whatever a person typed a value, never code. */
export const screenCall = <K extends keyof PageCalls>(method: K, ...args: PageCalls[K]) =>
  `window.agentScreen?.${method}(${args.map((a) => JSON.stringify(a)).join(",")});true;`;

/**
 * A call on the page as the app sends it: one the page may open its socket on at once (`set`, `retry`) has the session
 * set just before it, since another WebView mounting meanwhile (a browser card's) may have cleared it (`sessionAnswer`).
 */
export const pageCall = <K extends keyof PageCalls>(
  session: { cookie: string; server: string },
  method: K,
  ...args: PageCalls[K]
) =>
  (method === "set" || method === "retry" ? sessionCookieScript(session.cookie, session.server) : "") +
  screenCall(method, ...args);

/** The keys a phone keyboard lacks, on the row over it while typing on the screen (`SCREEN_KEYS` on the page). */
export const SCREEN_ROW_KEYS = ["Escape", "Tab", "ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight"] as const;
export type ScreenRowKey = (typeof SCREEN_ROW_KEYS)[number];
/** Every key the app presses on the screen: the row's, and the keyboard's own Return and Backspace. */
export type ScreenKey = ScreenRowKey | "Enter" | "Backspace";

/**
 * What the phone keyboard did to the field nobody sees, from its text before to its text now, as keys on the screen:
 * Backspaces for what went, then what came. Counted in characters, so an emoji is one Backspace. A change in the middle
 * (the keyboard's caret moved) takes back to it and types the rest again, which leaves the screen's text the same.
 */
export function typedSince(before: string, after: string): { back: number; typed: string } {
  const was = [...before];
  const now = [...after];
  let same = 0;
  while (same < was.length && same < now.length && was[same] === now[same]) same++;
  return { back: was.length - same, typed: now.slice(same).join("") };
}

/** RFB's buttons: the left one, and the wheel's two directions (pressed and let go per notch). */
export const BUTTON = { none: 0, left: 1, wheelUp: 8, wheelDown: 16 } as const;

/**
 * How often a moving pointer reaches the page: a touch moves far more often than a stream needs to hear. The same pace
 * noVNC keeps for a mouse (`MOUSE_MOVE_DELAY`), so the agent's screen answers a finger as it answers a mouse on the web.
 */
export const POINTER_MS = 16;

type Send = (x: number, y: number, buttons: number) => void;

/**
 * The pointer on its way to the page. The first move goes at once, so a touch never starts late; while it keeps moving,
 * only the newest goes at each tick. A change of buttons goes at once, and after the move before it, so a click lands
 * where the cursor was seen.
 */
export class PointerLine {
  private buttons: number = BUTTON.none;
  private waiting: { x: number; y: number } | null = null;
  private tick: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: Send,
    private readonly schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
    private readonly unschedule: (id: ReturnType<typeof setTimeout>) => void = clearTimeout,
  ) {}

  move(x: number, y: number) {
    this.waiting = { x, y };
    if (this.tick !== null) return;
    this.flush();
    this.wait();
  }

  /** Presses or lets go of these buttons where the pointer is. */
  press(x: number, y: number, buttons: number) {
    this.flush();
    this.buttons = buttons;
    this.send(x, y, buttons);
  }

  /** One click, down and up. */
  click(x: number, y: number, button: number = BUTTON.left) {
    this.flush();
    this.send(x, y, this.buttons | button);
    this.send(x, y, this.buttons);
  }

  /** Stops waiting: the view is going. */
  stop() {
    if (this.tick !== null) this.unschedule(this.tick);
    this.tick = null;
    this.waiting = null;
  }

  private wait() {
    this.tick = this.schedule(() => {
      this.tick = null;
      if (!this.waiting) return;
      this.flush();
      this.wait();
    }, POINTER_MS);
  }

  private flush() {
    if (!this.waiting) return;
    const { x, y } = this.waiting;
    this.waiting = null;
    this.send(x, y, this.buttons);
  }
}
