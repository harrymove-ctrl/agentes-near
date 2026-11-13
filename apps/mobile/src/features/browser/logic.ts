import {
  type AgentAccess,
  BROWSER_TOOL_SCOPE,
  type BrowserFrameMetadata,
  type BrowserHandoff,
  type BrowserLiveUnavailable,
  type BrowserStep,
  pagePoint,
  type ScreenKind,
} from "@agenteschat/client";
import type { TFunction } from "i18next";

/**
 * The agent's browser on the phone (ADR 0040): what only the app decides. The
 * request, the live connection and the input events are shared with the web (`@agenteschat/client`,
 * `browser/*`). Pure, so it is unit-tested.
 */

/**
 * What the card shows: waiting for someone, me in control, someone else helping, or how it ended. On the agent's
 * desktop the same states open its computer's view (ADR 0098).
 */
export type CardState = "waiting" | "mine" | "helping" | "done" | "failed" | "expired" | "cancelled" | "withdrawn";

export function cardStateOf(h: Pick<BrowserHandoff, "status" | "controllerUserId">, meId: string | null): CardState {
  if (h.status === "pending") return "waiting";
  if (h.status === "active") return h.controllerUserId && h.controllerUserId === meId ? "mine" : "helping";
  return h.status;
}

/** One line of the log, in the person's words ("Abriu loja.exemplo", "Preencheu um campo"), as on the web; its screen's too. */
export function stepText(
  t: TFunction,
  s: Pick<BrowserStep, "tool" | "detail">,
  screen: ScreenKind = "browser",
): string {
  const tool = s.tool.replace(/^mcp__agentes__/, "");
  const words = screen === "desktop" ? "desktop.watch.step" : "browser.watch.step";
  const open = screen === "desktop" ? "desktop_open" : "browser_open";
  if (tool === open) return s.detail ? t(`${words}.${open}`, { detail: s.detail }) : t(`${words}.${open}_plain`);
  const key = `${words}.${tool}`;
  const text = t(key);
  return text === key ? t(`${words}.other`) : text;
}

/** "dashboard.stripe.com" from a frame's URL (or nothing). */
export function hostOf(url: string | undefined | null): string {
  if (!url) return "";
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return m?.[1]?.toLowerCase() ?? "";
}

/** The site the card names: the live page's host, else the last page the agent opened ("loja.exemplo"). */
export function siteOf(frameUrl: string | null | undefined, steps: { tool: string; detail: string | null }[]): string {
  const live = hostOf(frameUrl);
  if (live) return live;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    const tool = s?.tool.replace(/^mcp__agentes__/, "");
    if ((tool !== "browser_open" && tool !== "browser_tabs") || !s?.detail) continue;
    return hostOf(s.detail) || s.detail.trim().toLowerCase();
  }
  return "";
}

/** The site's letter tile ("L" for loja.exemplo, without "www."), or nothing. */
export function siteLetter(host: string): string {
  const name = host.replace(/^www\./, "");
  return name ? name.charAt(0).toUpperCase() : "";
}

/**
 * Where a finger on the page's box lands on the page (`createTouchInput`'s `toPage`): the picture is
 * drawn "contain", so the letterbox around it is off the page, or its nearest edge with `clamp`.
 */
export const touchOnPage = (
  p: { x: number; y: number },
  box: { width: number; height: number },
  meta: Pick<BrowserFrameMetadata, "deviceWidth" | "deviceHeight">,
  clamp: boolean,
) => pagePoint(p, { left: 0, top: 0, ...box }, meta, "contain", clamp);

/** The live view's key row: Tab, Enter, Apagar, Esc. */
export const LIVE_KEYS = ["Tab", "Enter", "Backspace", "Escape"] as const;
export type LiveKey = (typeof LIVE_KEYS)[number];

/**
 * The phone keyboard's key that goes on to the page or screen, past the typing field. The field holds a draft sent
 * whole, so Backspace edits that draft while it has text; on an empty draft it deletes in the field in focus there
 * (iOS reports it even with nothing to delete, once per repeat while held). Return on an empty draft is Enter there.
 */
export const keyPastDraft = (draft: string, key: string): LiveKey | null =>
  draft === "" && (key === "Backspace" || key === "Enter") ? key : null;

/** Quick reasons on "Não consegui" (the person may also write their own). */
export const FAILED_REASONS = ["code", "password", "blocked"] as const;
export type FailedReason = (typeof FAILED_REASONS)[number];

/** The longest note the server takes on Pronto, Devolver or Não consegui. */
export const NOTE_MAX = 1000;

/** The agent may use its browser: `browser:use` granted to it ("all tools" doesn't cover it). */
export const browserGranted = (access: Pick<AgentAccess, "builtins"> | null | undefined) =>
  Boolean(access?.builtins.some((s) => s.scope === BROWSER_TOOL_SCOPE && s.state === "granted"));

/** Why the card has no live page: the server's reason, the stream ended, or too many browsers on the socket. */
export type PageGap = BrowserLiveUnavailable | "ended" | "tooMany";

/** The words for why the page shows nothing; the Cloud's computer is always on, so offline there isn't answering. */
export const pageGapKey = (gap: PageGap | "stuck", gender: "F" | "M", cloud: boolean) =>
  `mobile.browser.live.unavailable.${gap === "offline" && cloud ? "offlineCloud" : gap}${gender}` as const;

/** No page yet, but waiting may bring it: opening, reconnecting, or not available for now (the client retries). */
export const waitsForPage = (gap: PageGap | null) => gap === null || gap === "reconnecting" || gap === "unavailable";

export interface PageNote {
  say: PageGap | "starting" | "hidden" | "stuck";
  /** Only while the page may still come by itself. */
  spin: boolean;
  help: "grace" | "closedHelp" | "stuckHelp" | null;
}

/**
 * The page box with no page to show: opening, hidden while someone else is in control (their screen
 * stays theirs), or why it can't be shown, with a line of help where waiting means something. A closed
 * or ended browser holds until a frame comes, and none comes to a hidden view: there, who holds it wins.
 * `stuck`: it waited too long for a page that waiting brings (`useBrowserStuck`): it says it couldn't open,
 * with Try again.
 */
export function pageNoteOf(gap: PageGap | null, hidden: boolean, mine: boolean, stuck = false): PageNote {
  if (stuck && !hidden && waitsForPage(gap)) return { say: "stuck", spin: false, help: "stuckHelp" };
  if (gap && !(hidden && (gap === "closed" || gap === "ended"))) {
    const help = gap === "closed" ? "closedHelp" : gap === "reconnecting" && mine ? "grace" : null;
    return { say: gap, spin: gap === "reconnecting", help };
  }
  return hidden ? { say: "hidden", spin: false, help: null } : { say: "starting", spin: true, help: null };
}

/** A browser that is closed, ended or on a computer that's off: the agent's sky in the page's place, the words on it. */
export const skyBehind = (note: PageNote) => note.say === "closed" || note.say === "ended" || note.say === "offline";

/**
 * Whether the card watches its browser's frames. Not while it shows the agent's whole screen (ADR 0058 §7), so the
 * computer's screencast isn't kept running for nobody, nor before the screen's status says which: the person in
 * control always does, since their watch keeps their control.
 */
export const framesWanted = (o: {
  watching: boolean;
  profile: boolean;
  holding: boolean;
  settled: boolean;
  desktop: boolean;
}) => (o.watching || o.profile) && (o.holding || (o.settled && !o.desktop));
