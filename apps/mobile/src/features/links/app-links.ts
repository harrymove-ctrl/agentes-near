import type { ApiClient, MessageCard } from "@agenteschat/client";
import { messagePath } from "@agenteschat/client/lib/message-links";
import { isSafeId } from "../shared/logic";
import { chatHref, notificationHref } from "./logic";

/**
 * The web's addresses as the app's screens (iOS universal links, Android App Links): a link to the website that
 * opens the app lands where the website would. Which paths open the app at all is listed twice, for each store's
 * build: the server's `APP_LINK_PATHS` (apps/server/src/app-links.ts, read by iOS) and the Android intent filters
 * (`APP_LINK_PATTERNS` in app.config.ts). Keep the three in step.
 *
 * A workspace's page goes through `/link` (app/(app)/link.tsx), which switches to that workspace first and finds
 * what a web address names but the app's screen needs (a thread's conversation, a DM's channel). A page the app has
 * no screen for opens in the browser.
 */

/** Where a web address opens: an app path, the web page in the browser, or null when it isn't the web's. */
export type AppLink = { href: string } | { web: string } | null;

/** Settings sections the app has, by the web's section id (apps/web/src/pages/settings-sections.ts). */
export const SETTINGS_SCREENS: Record<string, string> = {
  account: "/me/account",
  notifications: "/me/notifications",
  apps: "/settings/apps",
  general: "/settings/general",
  members: "/me/members",
  audit: "/settings/audit",
  access: "/settings/access",
  connectors: "/connectors",
  skills: "/settings/skills",
  // AI accounts became part of AI and usage: its old address opens that.
  keys: "/usage",
  storage: "/settings/storage",
  computers: "/settings/devices",
  devices: "/settings/devices",
  usage: "/usage",
  import: "/settings/import",
  media: "/settings/media",
  approvals: "/me/approvals",
  right_hand: "/settings/right-hand",
  roles: "/settings/roles",
  vault: "/settings/vault",
  about: "/me/about",
};

/**
 * A settings address with a sign-in's result or an action only the website runs: the website, never the app's
 * section without it (the server's `APP_LINK_WEB_QUERIES`, which iOS already leaves out).
 */
export const WEB_ONLY_QUERIES = ["mail", "connected", "outcome", "review", "install", "delete"];

/** Paths outside a workspace the app has its own screen for, under the same path (expo-router opens them). */
const OWN_PATHS = /^\/(invite\/[^/]+|reset-password|signup)\/?$/;

/** `/link?…`: what the link screen needs, encoded. */
const linkHref = (params: Record<string, string | null | undefined>) =>
  `/link?${Object.entries(params)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")}`;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
};

/** The query's values (React Native's URLSearchParams lacks `get`). */
function queryOf(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (k) out[decode(k)] = decode(v.replace(/\+/g, " "));
  }
  return out;
}

/** Inside a workspace (`/org/<id>/…`): the app's screen, or null when the app has none. */
function workspaceScreen(rest: string[], q: Record<string, string>): Record<string, string | null> | string | null {
  const [page = "", id, sub] = rest;
  const m = isSafeId(q.m) ? q.m : null;
  const open = isSafeId(q.open) ? q.open : null;
  // A widget open on Home or on its dashboard (`?widget=`, ADR 0135): its own screen.
  const widget = isSafeId(q.widget) ? q.widget : null;
  // The thread open in a conversation's panel (`?thread=`, with `tm` for the panel's message): its own screen here.
  if ((page === "c" || page === "dm") && isSafeId(q.thread))
    return { thread: q.thread, m: isSafeId(q.tm) ? q.tm : null };
  switch (page) {
    case "":
    case "home":
      return widget ? `/widget/${widget}` : "/";
    case "dashboards":
      if (widget) return `/widget/${widget}`;
      if (id === undefined) return "/dashboards";
      return isSafeId(id) ? `/board/${id}` : null;
    case "c":
      return isSafeId(id) ? { to: m ? `/chat/${id}?m=${m}` : `/chat/${id}` } : null;
    case "dm":
      if (!isSafeId(sub)) return null;
      return id === "agent" ? { agent: sub, m } : id === "person" ? { person: sub, m } : null;
    case "threads":
      if (id === undefined) return open ? { thread: open } : "/conversations/threads";
      return isSafeId(id) ? { thread: id, m } : null;
    case "agents":
      if (id === "new") return "/new-agent";
      if (!isSafeId(id)) return null;
      return sub === "memory" ? `/memory?agent=${id}` : `/agent/${id}`;
    case "approvals":
      return open ? `/approval/${open}` : "/activity";
    case "notifications":
      return open ? { notification: open } : "/activity";
    case "issues": {
      const number = id ?? open;
      if (number === undefined || number === null) return "/issues";
      return /^\d{1,9}$/.test(number) ? `/issues/${number}` : null;
    }
    case "proposals":
      return "/proposals";
    case "task-manager":
      return isSafeId(q.task) ? `/task-manager/${q.task}` : "/task-manager";
    case "routines":
      return open ? `/routines/${open}` : "/routines";
    case "search":
      return "/search";
    case "drive":
      // A file's link (`filePath`): the file itself, at its version when named.
      if (isSafeId(q.artifact))
        return /^\d{1,9}$/.test(q.v ?? "") ? `/file/${q.artifact}?v=${q.v}` : `/file/${q.artifact}`;
      return "/drive";
    case "wiki":
      if (id === undefined) return "/wiki";
      return id && id.length <= 200 ? `/wiki/${encodeURIComponent(id)}` : null;
    case "members":
      return "/me/members";
    case "settings":
      if (id === undefined) return "/settings";
      if (WEB_ONLY_QUERIES.some((key) => key in q)) return null;
      // A join request's Approve/Deny in its email: that request, on top of the requests.
      if (id === "members" && isSafeId(q.request)) return `/join-requests?request=${q.request}`;
      if ((id === "computers" || id === "devices") && sub !== undefined) {
        // A phone's guide (the web's and the desktop app's QR codes name it `computer`), for the computer it plugs into.
        if (sub === "android-setup" || sub === "iphone-setup") {
          const machine = isSafeId(q.machine) ? q.machine : isSafeId(q.computer) ? q.computer : null;
          return machine ? `/settings/devices/${sub}?machine=${machine}` : `/settings/devices/${sub}`;
        }
        return isSafeId(sub) ? `/settings/devices/${sub}` : null;
      }
      return SETTINGS_SCREENS[id] ?? null;
    default:
      return null;
  }
}

/**
 * A URL the app was opened with → where it goes. Only the web's addresses (`https://<host>/…`) change: the app's own
 * scheme (`agenteschat://chat/…`) and paths stay as they are (null).
 */
export function appLinkFromUrl(url: string): AppLink {
  const match = /^https?:\/\/[^/?#]+(\/[^?#]*)?(?:\?([^#]*))?/i.exec(url.trim());
  if (!match) return null;
  const path = match[1] || "/";
  const query = match[2] ?? "";
  if (OWN_PATHS.test(path)) return { href: query ? `${path}?${query}` : path };
  const web = { web: query ? `${path}?${query}` : path };
  const parts = path.split("/").filter(Boolean).map(decode);
  if (parts[0] !== "org" || !isSafeId(parts[1])) return web;
  const screen = workspaceScreen(parts.slice(2), queryOf(query));
  if (screen === null) return web;
  // `web`: the address itself, opened in the browser when the person isn't in that workspace.
  const at = { org: parts[1], web: web.web };
  return { href: linkHref(typeof screen === "string" ? { ...at, to: screen } : { ...at, ...screen }) };
}

/**
 * A link in a message to a page of this server (`server`): the app's screen for it, through `/link`; null for any other
 * site, or a page the app has no screen for (it opens as a web page).
 */
export function ownLinkHref(url: string, server: string): string | null {
  const origin = (u: string) => /^https?:\/\/[^/?#]+/i.exec(u.trim())?.[0].toLowerCase() ?? null;
  const here = origin(server);
  if (!here || origin(url) !== here) return null;
  const link = appLinkFromUrl(url);
  return link && "href" in link ? link.href : null;
}

/**
 * Where a message link's pill opens: the conversation at the message, or, for another workspace's message, through
 * `/link` (which switches to that workspace first: the card's ids mean nothing in the current one).
 */
export function messageRefHref(linkOrgId: string, card: MessageCard, orgId: string, server: string): string {
  if (linkOrgId === orgId) return chatHref(card.channelId, card.threadId, card.id);
  const link = appLinkFromUrl(`${server.replace(/\/+$/, "")}${messagePath(linkOrgId, card)}`);
  return link && "href" in link ? link.href : chatHref(card.channelId, card.threadId, card.id);
}

/**
 * The workspace a `/link` opens in: the link's when the person is in it, else the current one for a link naming none.
 * A workspace they aren't in (removed, another account) gives its web address back, or `/` without one: its ids
 * mean nothing in the current workspace.
 */
export function linkWorkspace(
  p: { org?: unknown; web?: unknown },
  orgIds: string[],
  current: string,
): { org: string } | { web: string } {
  if (!isSafeId(p.org)) return { org: current };
  if (orgIds.includes(p.org)) return { org: p.org };
  return { web: typeof p.web === "string" && p.web.startsWith("/") && !p.web.startsWith("//") ? p.web : "/" };
}

/** What `/link` was opened with (`appLinkFromUrl`), unchecked. */
export interface LinkParams {
  to?: unknown;
  thread?: unknown;
  agent?: unknown;
  person?: unknown;
  notification?: unknown;
  m?: unknown;
}

/**
 * The app path a `/link` opens, in the workspace already switched to: a path as it came, or the conversation a
 * thread, a DM or a notification is in (asked of the server). `/` when it names nothing the app can open.
 */
export async function resolveLink(
  api: { threads: Pick<ApiClient["threads"], "get">; dms: Pick<ApiClient["dms"], "open"> } & {
    notifications: Pick<ApiClient["notifications"], "read">;
  },
  orgId: string,
  p: LinkParams,
): Promise<string> {
  if (typeof p.to === "string" && p.to.startsWith("/") && !p.to.startsWith("//")) return p.to;
  const m = isSafeId(p.m) ? p.m : null;
  if (isSafeId(p.thread)) {
    const thread = await api.threads.get(orgId, p.thread);
    return chatHref(thread.channelId, thread.id, m);
  }
  const dm = isSafeId(p.agent) ? { agentId: p.agent } : isSafeId(p.person) ? { userId: p.person } : null;
  if (dm) return chatHref((await api.dms.open(orgId, dm)).channelId, null, m);
  // Opening a notification reads it, as the web's inbox does with `?open=`.
  if (isSafeId(p.notification))
    return notificationHref(await api.notifications.read(orgId, p.notification, true)) ?? "/activity";
  return "/";
}
