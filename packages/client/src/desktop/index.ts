import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useApi } from "../api/context";
import { ApiError } from "../api/http";
import { keys } from "../api/keys";
import type { BrowserHandoff, DesktopPictureView, DesktopStatus } from "../api/types";
import { handoffScreen } from "../browser";
import { type SocketBase, socketUrl } from "../realtime/connection";

/**
 * The agent's screen in the apps (ADR 0058): what the dialog's screen shows, the
 * viewer sockets' addresses, and what each of their close codes means.
 */

/** What the screen shows. */
export type DesktopViewState =
  /** The socket opens, or the screen starts: opening it starts a screen that isn't running. */
  | "connecting"
  | "live"
  /** Someone else is in control: their screen stays theirs until they hand it back. */
  | "hidden"
  /** The computer is offline, or its socket is on another server (retrying). */
  | "offline"
  /** As many viewers as the screen takes, or too many opens in a minute (retrying). */
  | "busy"
  /** The computer shows as many screens as its memory allows (`desktop_busy`): "Tentar de novo". */
  | "noRoom"
  /** Its owner paused the computer: control waits for the resume (retrying). */
  | "paused"
  /** The agent or its workspace is held and its screen isn't running: nothing starts it until the hold ends. */
  | "held"
  | "forbidden"
  /** The agentes app on the computer is too old for screens. */
  | "outdated"
  /** Its switch is off on the computer, it can't run screens, or the agent may not use one. */
  | "unavailable"
  /** The computer ended the stream for good: only "Tentar de novo" opens it again. */
  | "ended";

/** How the panel opens the screen again after a close: at once, after a wait (`desktopRetryMs`), or not by itself. */
export type DesktopRetry = "now" | "later" | "never";

/** A person's stream of the desktop: watching it, or in control of it. */
export type DesktopMode = "watch" | "control";

/** Close codes of the viewer sockets; mirrors `STREAM_CLOSE` in packages/adapters/src/machine-protocol.ts. */
export const DESKTOP_CLOSE = {
  normal: 1000,
  forbidden: 4403,
  notFound: 4404,
  hidden: 4409,
  controlEnded: 4410,
  tooMany: 4429,
  refused: 4502,
  unreachable: 4503,
} as const;

/**
 * What a viewer socket's close means for the panel; `reason` is the server's (4502: the computer's error code).
 * `preview`: a browser card's view (ADR 0058 §7), which never waits on the screen by itself: only a dropped socket
 * opens it again, anything else puts the card back on its browser's frames.
 */
export function desktopCloseState(
  code: number,
  reason = "",
  o: { preview?: boolean } = {},
): { state: DesktopViewState; retry: DesktopRetry } {
  const next = closeState(code, reason);
  if (!o.preview) return next;
  // The screen isn't running, and a card never starts it.
  if (code === DESKTOP_CLOSE.refused && reason === "desktop_off") return { state: "ended", retry: "never" };
  return next.state === "connecting" ? next : { ...next, retry: "never" };
}

function closeState(code: number, reason: string): { state: DesktopViewState; retry: DesktopRetry } {
  switch (code) {
    // Control isn't this person's (any more): open again, now as a watcher.
    case DESKTOP_CLOSE.controlEnded:
      return { state: "connecting", retry: "now" };
    case DESKTOP_CLOSE.hidden:
      return { state: "hidden", retry: "later" };
    case DESKTOP_CLOSE.forbidden:
      return { state: "forbidden", retry: "never" };
    case DESKTOP_CLOSE.notFound:
      return { state: "unavailable", retry: "never" };
    case DESKTOP_CLOSE.tooMany:
      return { state: "busy", retry: "later" };
    case DESKTOP_CLOSE.unreachable:
      return { state: "offline", retry: "later" };
    case DESKTOP_CLOSE.normal:
      return { state: "ended", retry: "never" };
    case DESKTOP_CLOSE.refused:
      // An older computer refuses a screen that isn't running: the server starts it, the next try opens it.
      if (reason === "desktop_off") return { state: "connecting", retry: "later" };
      if (reason === "desktop_busy") return { state: "noRoom", retry: "never" };
      if (reason === "machine_paused") return { state: "paused", retry: "later" };
      if (reason === "held") return { state: "held", retry: "later" };
      if (reason === "runner_outdated") return { state: "outdated", retry: "never" };
      if (reason === "not_allowed" || reason === "desktop_unavailable") return { state: "unavailable", retry: "never" };
      return { state: "connecting", retry: "later" };
    // 1001 the server restarts, 1006 the network dropped, 1013 too slow, 4408 the computer was late…
    default:
      return { state: "connecting", retry: "later" };
  }
}

/** What `GET …/desktop`'s `reason` means for the screen. */
export function desktopReasonState(reason: string | null): "offline" | "outdated" | "unavailable" {
  if (reason === "offline" || reason === "other_server") return "offline";
  if (reason === "runner_outdated") return "outdated";
  return "unavailable";
}

/**
 * What the screen shows before any socket opens, from its state; null: open it (a screen that isn't running
 * starts on its first viewer).
 */
export function desktopStatusState(status: DesktopStatus, userId: string): DesktopViewState | null {
  if (!status.available) return desktopReasonState(status.reason);
  if (status.controllerUserId && status.controllerUserId !== userId) return "hidden";
  // A held agent's screen that runs may be watched; one that doesn't isn't started until the hold ends.
  if (status.held && !status.running) return "held";
  return null;
}

/**
 * Whether helping with `h` happens on the agent's whole screen: a request on the screen itself, or one in its browser
 * whose window is on that screen (`status.handoff` is the same one) for someone who may drive the screen. Who may only
 * drive the browser helps in its page.
 */
export function drivesOnDesktop(
  h: Pick<BrowserHandoff, "id" | "screen">,
  status: Partial<Pick<DesktopStatus, "available" | "canControl" | "handoff">> | null | undefined,
): boolean {
  if (handoffScreen(h) === "desktop") return true;
  return status?.available === true && status.canControl === true && status.handoff?.id === h.id;
}

/** Control while the handoff holding the desktop is this person's and they help there (`drivesOnDesktop`). */
export function desktopMode(
  status: Pick<DesktopStatus, "handoff" | "available" | "canControl">,
  userId: string,
): DesktopMode {
  const h = status.handoff;
  return h?.status === "active" && h.controllerUserId === userId && drivesOnDesktop(h, status) ? "control" : "watch";
}

/** Why this person drives only the agent's browser, not its whole computer (`controlRefusal`), as its words' key. */
export const browserOnlyWhy = (status: Pick<DesktopStatus, "controlRefusal"> | null | undefined) =>
  status?.controlRefusal === "owner_plan"
    ? ("desktop.browserOnly.plan" as const)
    : status?.controlRefusal === "role"
      ? ("desktop.browserOnly.role" as const)
      : ("desktop.browserOnly.other" as const);

/**
 * "Quer assumir o controle?" over the agent's screen while watching, on the web and the phone. `browser`: this person
 * may take the agent's browser where its screen isn't theirs; `working`: the agent is at work and pauses for it.
 */
export function askControlWords(
  status: Pick<DesktopStatus, "canControl" | "controlRefusal"> | null | undefined,
  browser: boolean,
  working: boolean,
) {
  const mayTake = Boolean(status?.canControl) || browser;
  const browserOnly = !status?.canControl && browser;
  return {
    mayTake,
    browserOnly,
    title: !mayTake
      ? ("desktop.ask.watching" as const)
      : browserOnly
        ? ("desktop.ask.titleBrowser" as const)
        : ("desktop.ask.title" as const),
    help: browserOnly ? browserOnlyWhy(status) : mayTake && working ? ("desktop.ask.working" as const) : null,
  };
}

/**
 * Which way control is switching over the last picture, or null: the person's own step on its way (`taking`,
 * `returning`), or the screen's session (`session`, null until one opens) still in the other mode than `mode`.
 */
export function desktopSwitch(s: {
  taking: boolean;
  returning: boolean;
  mode: DesktopMode;
  session: DesktopMode | null;
}): "taking" | "returning" | null {
  if (s.taking || (s.mode === "control" && s.session === "watch")) return "taking";
  if (s.returning || (s.mode === "watch" && s.session === "control")) return "returning";
  return null;
}

/** Waits between tries to open the screen again: 1 s, then up to 10 s. */
const RETRY_MS = [1000, 2000, 5000, 10_000];
export const desktopRetryMs = (attempt: number) => RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 10_000;

/**
 * A person's socket to the agent's desktop (raw RFB). `switches`: it takes its mode changing in place (ADR 0058 §17),
 * with `{"type":"mode"}` text frames around each new RFB session (`DesktopLink` in the web app). `preview`: a browser
 * card's view (ADR 0058 §7), which only watches and never changes mode.
 */
export function desktopSocketUrl(
  base: SocketBase,
  v: { orgId: string; agentId: string; mode: DesktopMode; switches?: boolean; preview?: boolean },
) {
  // In this order, one key at a time: an optional key may not be undefined in the address's parameters.
  const params: Record<string, string | number> = { orgId: v.orgId, agentId: v.agentId };
  if (v.preview) params.preview = 1;
  else if (v.switches) params.switch = 1;
  params.mode = v.preview ? "watch" : v.mode;
  return socketUrl(base, "/api/desktop", params);
}

/** The mode a desktop socket's text frame names (`{"type":"mode","mode"}`, ADR 0058 §17); null for any other. */
export function desktopModeFrame(text: string): DesktopMode | null {
  try {
    const frame = JSON.parse(text) as { type?: unknown; mode?: unknown };
    return frame.type === "mode" && (frame.mode === "watch" || frame.mode === "control") ? frame.mode : null;
  } catch {
    return null;
  }
}

/** The agent's screen as this person sees it; `poll`: ask again this often (nothing else says when it is handed back). */
export const useDesktopStatus = (
  orgId: string,
  agentId: string,
  options: { enabled?: boolean; poll?: number | false } = {},
) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentDesktop(orgId, agentId),
    queryFn: () => api.desktop.status(orgId, agentId),
    enabled: options.enabled ?? true,
    retry: false,
    refetchInterval: options.poll ?? false,
  });
};

/** How often the picture of an agent's screen is asked again while it works there. */
export const PICTURE_WORKING_MS = 5_000;
/** While nothing moves there, or there is no picture to show. */
export const PICTURE_IDLE_MS = 30_000;

/**
 * Whether the picture is asked at all: only while it is on the person's screen, and of a screen that runs, so nobody
 * looking at a DM ever starts a stopped one.
 */
export const asksPicture = (shown: boolean, status: Pick<DesktopStatus, "available" | "running"> | null) =>
  shown && status?.available === true && status.running;

export const pictureRefreshMs = (working: boolean, last: DesktopPictureView | undefined) =>
  working && last?.picture ? PICTURE_WORKING_MS : PICTURE_IDLE_MS;

/** A recent picture of the agent's screen, never a stream: see `asksPicture` for `enabled`. */
export const useDesktopPicture = (orgId: string, agentId: string, options: { enabled: boolean; working: boolean }) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentDesktopPicture(orgId, agentId),
    queryFn: () => api.desktop.picture(orgId, agentId),
    enabled: options.enabled,
    retry: false,
    refetchInterval: (q) => pictureRefreshMs(options.working, q.state.data),
  });
};

/**
 * Xvnc's MaxCutText (its default): a larger clipboard from a viewer is dropped without a word. It counts what noVNC
 * sends: UTF-8 with every line break as CRLF, and a NUL at the end. The agent's browser takes the same at most: a
 * paste goes in 10,000-character frames, and the server takes 60 frames a second.
 */
export const PASTE_MAX_BYTES = 262_144;

/** What a text takes on the desktop's clipboard, in the bytes `PASTE_MAX_BYTES` counts. */
export const pasteBytes = (text: string) =>
  new TextEncoder().encode(text.replace(/\r\n|\r|\n/g, "\r\n")).byteLength + 1;

// ── The browser card on the agent's screen (ADR 0058 §7) ─────────────────────

/** How long a card's screen stays open after it leaves the view (the browser stream's own linger). */
export const SCREEN_LINGER_MS = 10_000;
/**
 * After the card's screen gave up, frames this long at most unless the status changes first; doubled each time it
 * gives up again on the same status (a cause that lasts: the screen full, the computer failing), up to
 * `SCREEN_REFUSAL_MAX_MS`.
 */
export const SCREEN_REFUSAL_MS = 120_000;
export const SCREEN_REFUSAL_MAX_MS = 900_000;

/** How long frames win after the card's screen gave up for the `n`-th time in a row on one status (from 0). */
export const screenRefusalMs = (n: number) => Math.min(SCREEN_REFUSAL_MS * 2 ** n, SCREEN_REFUSAL_MAX_MS);

/**
 * Whether the browser card shows the agent's whole screen instead of its browser's frames (ADR 0058 §7): its browser
 * runs on that screen, which runs and this person may watch now, and they hold neither the screen nor the browser
 * (whoever holds it drives on the frames, whose watch keeps their control alive). A card never starts a screen.
 */
export function browserShowsDesktop(
  status: DesktopStatus | null | undefined,
  o: { userId: string; holdsBrowser: boolean },
): boolean {
  return (
    !!status &&
    status.browserOnDesktop === true &&
    status.running &&
    !o.holdsBrowser &&
    status.controllerUserId !== o.userId &&
    desktopStatusState(status, o.userId) === null
  );
}

/** What of the status, once changed, lets a card that gave up try the screen again. */
export const browserScreenKey = (s: DesktopStatus) =>
  [s.available, s.running, s.startedAt, s.browserOnDesktop === true, s.controllerUserId, s.reason].join("|");

/** A card's screen in any state but these went back to frames. */
export const previewGivesUp = (state: DesktopViewState) => state !== "connecting" && state !== "live";

export interface BrowserScreen {
  /** Show the screen (and watch no frames). */
  desktop: boolean;
  /**
   * The viewer may be open now: `desktop` and on screen, or within `SCREEN_LINGER_MS` of leaving it, and the card of
   * this agent shown last in this app.
   */
  connect: boolean;
  /** The status answered or failed, or isn't asked: the frames path may start. */
  settled: boolean;
  status: ReturnType<typeof useDesktopStatus>;
  /**
   * The embedded viewer's state: a `previewGivesUp` one puts the card on frames until the key changes or the refusal
   * ends.
   */
  report: (state: DesktopViewState) => void;
}

/**
 * Which of one agent's cards shows its screen: one viewer per agent in this app (ADR 0058 §7), as its frames are one
 * watch. The card shown last wins; the others keep the screen's place until it leaves.
 */
const screenClaims = new Map<string, symbol[]>();
const claimListeners = new Set<() => void>();

function setScreenClaim(agentId: string, token: symbol, on: boolean) {
  const list = (screenClaims.get(agentId) ?? []).filter((t) => t !== token);
  if (on) list.push(token);
  if (list.length) screenClaims.set(agentId, list);
  else screenClaims.delete(agentId);
  for (const listener of claimListeners) listener();
}

function subscribeClaims(listener: () => void) {
  claimListeners.add(listener);
  return () => {
    claimListeners.delete(listener);
  };
}

/** True while `on`, and for `ms` after it turns false. */
function useLinger(on: boolean, ms: number) {
  const [kept, setKept] = useState(on);
  useEffect(() => {
    if (on) {
      setKept(true);
      return;
    }
    const timer = setTimeout(() => setKept(false), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on || kept;
}

/**
 * The browser card's choice between the agent's whole screen and its browser's frames (ADR 0058 §7), on the web and
 * the phone. `shown`: the card is on the person's screen (the viewer opens only then, and lingers a little after);
 * `poll`: ask the status again every 30 s (by default while shown); `holdsBrowser`: this person holds its browser.
 */
export function useBrowserScreen(
  orgId: string,
  agentId: string,
  o: { enabled: boolean; userId: string; shown: boolean; holdsBrowser: boolean; poll?: boolean },
): BrowserScreen {
  const status = useDesktopStatus(orgId, agentId, {
    enabled: o.enabled,
    poll: o.enabled && (o.poll ?? o.shown) ? PICTURE_IDLE_MS : false,
  });
  // A status that now fails for lack of access (or of the agent) shows nothing: React Query keeps the last good one.
  const lost = status.error instanceof ApiError && (status.error.status === 403 || status.error.status === 404);
  const data = lost ? undefined : status.data;
  const key = data ? browserScreenKey(data) : null;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [refusal, setRefusal] = useState<{ key: string; at: number; n: number } | null>(null);
  const [, setTick] = useState(0);
  const refusalMs = refusal ? screenRefusalMs(refusal.n) : 0;
  const refused = refusal !== null && refusal.key === key && Date.now() - refusal.at < refusalMs;
  useEffect(() => {
    if (!refused || !refusal) return;
    // The refusal ends by itself: render again then, so the card tries the screen once more.
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, refusal.at + refusalMs - Date.now()));
    return () => clearTimeout(timer);
  }, [refused, refusal, refusalMs]);
  const report = useCallback((state: DesktopViewState) => {
    const current = keyRef.current;
    // Live again: the next refusal waits the shortest time.
    if (state === "live") setRefusal(null);
    else if (current !== null && previewGivesUp(state)) {
      setRefusal((was) => ({ key: current, at: Date.now(), n: was?.key === current ? was.n + 1 : 0 }));
    }
  }, []);
  const desktop = o.enabled && browserShowsDesktop(data, o) && !refused;
  const near = useLinger(o.shown, SCREEN_LINGER_MS);
  const wants = desktop && near;
  const [token] = useState(() => Symbol("screen"));
  useEffect(() => {
    if (!wants) return;
    setScreenClaim(agentId, token, true);
    return () => setScreenClaim(agentId, token, false);
  }, [wants, agentId, token]);
  const claimant = useSyncExternalStore(
    subscribeClaims,
    () => screenClaims.get(agentId)?.at(-1) ?? null,
    () => null,
  );
  return {
    desktop,
    connect: wants && claimant === token,
    settled: !o.enabled || status.isSuccess || status.isError,
    status,
    report,
  };
}
