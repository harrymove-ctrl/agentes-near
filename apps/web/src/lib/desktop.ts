import type { AppNotification, SignInProvider } from "@agenteschat/client";
import { deviceNoticeOf } from "@agenteschat/client/lib/devices";
import { firstName } from "@agenteschat/client/lib/format";
import { noticeLine } from "@agenteschat/client/lib/island";
import { mediaWord } from "@agenteschat/client/lib/media";
import type { i18n as I18n, TFunction } from "i18next";
import { useEffect } from "react";
import type { DesktopServerWorkspaces } from "./workspaces";

/**
 * The site inside the agentes.chat desktop app (ADR 0036, ADR 0066): the app's main window loads it and
 * sets `window.__agentesDesktop` before it starts. The site gets nothing of the computer; it draws its own
 * title bar and sends Google/Apple sign-in to the browser (`apps/desktop/src-tauri/src/main_window.rs`).
 */
export const inDesktopApp = () =>
  typeof window !== "undefined" && Boolean((window as { __agentesDesktop?: unknown }).__agentesDesktop);

export type DesktopPlatform = "mac" | "windows" | "linux";

/** The system the app runs on; apps from before Windows and Linux say nothing, and were Macs. */
export function desktopPlatform(): DesktopPlatform | null {
  if (!inDesktopApp()) return null;
  const platform = (window as { __agentesDesktop?: { platform?: unknown } }).__agentesDesktop?.platform;
  return platform === "windows" || platform === "linux" ? platform : "mac";
}

/**
 * `{{device}}` in the site's words about this computer ("Use this Mac", "Use this computer"), in the
 * page's language, kept right when the language changes.
 */
export function applyDesktopDevice(i18n: I18n, platform: DesktopPlatform) {
  const apply = () => {
    const interpolation = i18n.options.interpolation ?? {};
    interpolation.defaultVariables = {
      ...interpolation.defaultVariables,
      device: i18n.t(`machines.thisMac.device.${platform}`),
    };
    i18n.options.interpolation = interpolation;
  };
  apply();
  i18n.on("languageChanged", apply);
}

/** What a phone gets pushed (apps/server push.ts), and so what the desktop app shows while in the background. */
const NOTICE_KINDS = [
  "mention",
  "dm",
  "agent_reply",
  "agent_question",
  "approval",
  "mission_stopped",
  "routine_failed",
  "run_failed",
  "routine_paused",
  "browser_handoff",
  "secret_request",
] as const;
type NoticeKind = (typeof NOTICE_KINDS)[number];
const isNoticeKind = (kind: string): kind is NoticeKind => (NOTICE_KINDS as readonly string[]).includes(kind);
const NOTICE_TITLE_MAX = 80;
const NOTICE_BODY_MAX = 180;

const oneLine = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/**
 * The desktop app's notification for one that just arrived (`notification.upserted`): new and unread, of a
 * kind a phone would get pushed, or waiting on the person. Its page is the inbox, where it is on top. Merged
 * into one already there, read, or done: none. Someone's agent using a phone of the person's: "Lia is using Pixel 8",
 * what it does for whom, the phone's page, and `phoneId` for the notification's Stop (`agentName` names the agent).
 */
export function desktopNotice(
  t: TFunction,
  orgId: string,
  n: Pick<AppNotification, "kind" | "waiting" | "count" | "readAt" | "doneAt" | "latest" | "source" | "actors">,
  agentName?: (agentId: string) => string | undefined,
): { title: string; body: string; path: string; phoneId?: string } | null {
  if (n.readAt || n.doneAt || n.count > 1) return null;
  const device = n.kind === "device.in_use" ? deviceNoticeOf(n) : null;
  if (device?.phoneId) {
    const agent = device.agentId ? agentName?.(device.agentId) : undefined;
    const person = device.forName ? firstName(device.forName) : null;
    const doing = device.text?.trim() || null;
    const deviceName = device.device;
    return {
      title: oneLine(
        agent
          ? t("desktopNotice.deviceInUse", { agent, deviceName })
          : t("desktopNotice.deviceInUseAny", { deviceName }),
        NOTICE_TITLE_MAX,
      ),
      body: oneLine(
        doing && person
          ? t("desktopNotice.deviceDoingFor", { doing, person })
          : person
            ? t("desktopNotice.deviceFor", { person })
            : (doing ?? ""),
        NOTICE_BODY_MAX,
      ),
      path: `/org/${encodeURIComponent(orgId)}/settings/devices/phones/${encodeURIComponent(device.phoneId)}`,
      phoneId: device.phoneId,
    };
  }
  const kind = isNoticeKind(n.kind) ? n.kind : n.waiting ? "waiting" : null;
  if (!kind) return null;
  return {
    title: oneLine(t(`desktopNotice.${kind}`), NOTICE_TITLE_MAX),
    // The snippet, an approval's action, or the word for a GIF, a sticker or a voice message (ADR 0091, 0100).
    body: oneLine(
      noticeLine(n, (media) => mediaWord(t, media)),
      NOTICE_BODY_MAX,
    ),
    path: `/org/${encodeURIComponent(orgId)}/notifications`,
  };
}

/**
 * A connector's OAuth started in the app's window: the provider opens in the browser, which isn't signed in, so
 * the server hands what it sent back to the app (`agenteschat://desktop/connectors/oauth`), which opens
 * `/desktop/connector` in its window to finish there (packages/engine oauth-return.ts). Apps from before say
 * nothing and keep the web's return.
 */
export const takesConnectorReturn = () =>
  (window as { __agentesDesktop?: { connectorReturn?: unknown } }).__agentesDesktop?.connectorReturn === true;

export const oauthReturnPath = (path: string) => (takesConnectorReturn() ? `desktop:${path}` : path);

/** A mailbox's return in that link: `state=mail`, `code=connected|failed` (packages/engine oauth-return.ts). */
export const DESKTOP_MAIL_STATE = "mail";

/** The window opens this in the browser instead of loading it (main_window.rs). */
export const BROWSER_SIGN_IN_PATH = "/desktop/sign-in";
/** Loading this brings the window to the front (main_window.rs), then goes on to `to`. */
export const SIGNED_IN_PATH = "/desktop/signed-in";

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** 32 random bytes (base64url): kept by the window, never sent until it redeems. */
export function newVerifier() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The verifier's SHA-256 (base64url): what travels through the browser. */
export async function challengeOf(verifier: string) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** `access`: an early-access link's token, for the sign-up the browser makes (DesktopSignInPage). */
export const browserSignInUrl = (provider: SignInProvider, requestId: string, access?: string) =>
  `${BROWSER_SIGN_IN_PATH}?${new URLSearchParams({ provider, request: requestId, ...(access ? { access } : {}) })}`;

/**
 * What the site may ask of this computer (ADR 0036, `this_mac` in main_window.rs): which of this server's
 * organizations it works for, pairing it with one (the app asks the person in its own dialog first; the site
 * then confirms the runner's code with its own session), reconnecting it, the app's Preferences on a tab, its
 * access requests, the badge and notifications. Nothing else reaches the computer.
 */
export interface ThisMacStatus {
  orgs: { orgId: string; machineId: string | null; connection: string }[];
  /** False where agents can't work on this computer for this server: a server on this computer itself. */
  agentsHere?: boolean;
  /** This server runs inside the app on this computer: the app signs its owner in ("Continue on this Mac"). */
  local?: boolean;
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
const invoke = <T>(request: Record<string, unknown>): Promise<T> => {
  const tauri = (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  if (!inDesktopApp() || typeof tauri?.invoke !== "function") return Promise.reject(new Error("not in the app"));
  return tauri.invoke("this_mac", { request }) as Promise<T>;
};

/**
 * The site painted its first screen: the app's cover over the window goes (apps/desktop cover.rs). Older apps
 * don't have it; nothing happens there.
 */
export function pageReady() {
  const tauri = (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  if (!inDesktopApp() || typeof tauri?.invoke !== "function") return;
  void tauri.invoke("page_ready", {}).catch(() => {});
}

/** `pageReady` once the screen just rendered is on the glass (two frames on): a first screen's mount effect. */
export function pageReadyAfterPaint() {
  if (inDesktopApp()) requestAnimationFrame(() => requestAnimationFrame(pageReady));
}

/**
 * Links that open a new window (`target="_blank"`) in the app: the window's `on_new_window` sends them on, a page
 * of this server to the window and anything else to the browser (main_window.rs). The app's shell plugin adds
 * a click listener of its own to every page (on `body`) that takes these links first and asks the app over IPC,
 * which the site may not do, so a click did nothing. This one sits on the React root: after the page's own
 * handlers (one that handled the click itself, a popup, keeps it) and before the plugin's.
 */
export function routeNewWindowLinks(root: HTMLElement): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (link?.target !== "_blank" || !/^(https?|mailto|tel):$/.test(link.protocol)) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(link.href, "_blank", "noopener");
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

export const thisMac = {
  status: () => invoke<ThisMacStatus>({ kind: "status" }),
  /**
   * The runner's code for the site to confirm; null when this computer is already in `orgId`. `orgName` is
   * what the app's own dialog names (display only).
   */
  connect: (orgId: string, orgName?: string) =>
    invoke<{ userCode: string | null }>({ kind: "connect", orgId, ...(orgName ? { orgName } : {}) }),
  /** The socket again (this Mac went offline for `orgId`). */
  reconnect: (orgId: string) => invoke<unknown>({ kind: "reconnect", orgId }),
  openPrefs: (tab: "folders" | "tools" | "updates") => invoke<unknown>({ kind: "prefs", tab }),
  /** The menu bar's popover, where access requests are answered. */
  showRequests: () => invoke<unknown>({ kind: "requests" }),
  /** The Dock's badge: how many wait on the person, and unread (a dot when nothing waits). */
  badge: (waiting: number, unread: number) => invoke<unknown>({ kind: "badge", waiting, unread }),
  /** The Mac's Go menu: the person's organizations (⌘⌥1–9). */
  orgs: (orgs: { id: string; name: string }[]) => invoke<unknown>({ kind: "orgs", orgs }),
  /**
   * A notification while the app is in the background (the app limits how many); `path` opens on a click. With
   * `phoneId` (a phone of the person's that someone's agent uses), it has a Stop button, the same stop as the web's.
   */
  notify: (title: string, body: string, path: string, stop?: { orgId: string; phoneId: string }) =>
    invoke<unknown>({ kind: "notify", title, body, path, ...stop }),
  /**
   * On the server the app runs here: the app signs its owner in (its owner key buys a one-time sign-in, which
   * this window trades at `/desktop/handover`; the key never reaches the page). The window moves there.
   */
  signIn: () => invoke<unknown>({ kind: "signIn" }),
  /** The app's own window to pick another server (its first run), from the sign-in page. */
  otherServer: () => invoke<unknown>({ kind: "servers" }),
  /** The folder where the server the app runs here keeps its files, in Finder or the file manager. */
  revealFiles: () => invoke<unknown>({ kind: "files" }),
  /** The other servers' workspaces, as the app read them with each one's session (ADR 0154). */
  workspaces: () => invoke<{ servers: DesktopServerWorkspaces[] }>({ kind: "workspaces" }).then((r) => r.servers),
  /** The window goes to a workspace of another server of the app's list, already signed in there. */
  openWorkspace: (server: string, orgId: string) => invoke<unknown>({ kind: "openWorkspace", server, orgId }),
  /** The app's own window to add a workspace: a new one on agentes.chat, or the team's server. */
  addWorkspace: () => invoke<unknown>({ kind: "addWorkspace" }),
  /**
   * The window goes to a server of the app's list on its own first page (its sign-in when the app has no session
   * there). An app without it refuses: the caller falls back to the app's servers window.
   */
  openServer: (server: string) => invoke<unknown>({ kind: "openServer", server }),
};

/** The app lists every server's workspaces (`workspaces` in `window.__agentesDesktop`, ADR 0154); older apps don't. */
export const desktopListsWorkspaces = () =>
  inDesktopApp() && (window as { __agentesDesktop?: { workspaces?: unknown } }).__agentesDesktop?.workspaces === true;

/** The app takes `otherServer` (`servers` in `window.__agentesDesktop`); older apps refuse it. */
export const desktopPicksServer = () =>
  inDesktopApp() && (window as { __agentesDesktop?: { servers?: unknown } }).__agentesDesktop?.servers === true;

/** The app takes `revealFiles` (`files` in `window.__agentesDesktop`); older apps refuse it. */
export const desktopRevealsFiles = () =>
  inDesktopApp() && (window as { __agentesDesktop?: { files?: unknown } }).__agentesDesktop?.files === true;

/**
 * The app's "Show QR code" (Preferences › Servers) opens the site with `?open=phone`: "Open on your phone"
 * opens once the account button is on screen.
 */
const phone = { asked: false, listeners: new Set<() => void>() };
export const asksForPhone = (search: string) => new URLSearchParams(search).get("open") === "phone";
export function askForPhone() {
  phone.asked = true;
  for (const listener of phone.listeners) listener();
}
/** True once per ask. */
export function takePhoneAsk() {
  const asked = phone.asked;
  phone.asked = false;
  return asked;
}
export function onPhoneAsk(listener: () => void) {
  phone.listeners.add(listener);
  return () => {
    phone.listeners.delete(listener);
  };
}

/** The window's title in the app (and the tab's in a browser) while a screen shows; back when it goes. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}
