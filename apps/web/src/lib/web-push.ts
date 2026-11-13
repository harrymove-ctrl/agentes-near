import type { ApiClient, NotificationCount, NotificationEvent, PushDeviceInput } from "@agenteschat/client";
import type { AuthClient } from "@/auth/client";
import { inDesktopApp } from "./desktop";
import { type PushOpen, pushOpenFrom } from "./push-open";

/**
 * Notifications in this browser (Web Push, ADR 0071): the service worker at `/sw.js` (public/sw.js) shows what
 * the server pushes while the app's tab is closed or in the background. The person turns it on themselves, with
 * a click (the browser asks for permission only then); never inside the desktop app, which shows its own
 * notifications (ADR 0036), nor on an iPhone or iPad outside an installed web app (the phone app is there).
 */

export type WebPushState =
  /** This browser can't take pushes here (or it is the desktop app, or Safari on an iPhone): nothing shows. */
  | "unsupported"
  /** This server has Web Push off: nothing shows. */
  | "off-by-server"
  /** Not on yet in this browser; a click turns it on. */
  | "default"
  /** The browser blocks notifications for this site: only its own site settings can allow them again. */
  | "denied"
  /** On: this browser is subscribed. */
  | "subscribed";

/** What this browser offers, read once (`readPushEnvironment`); plain data so the rules are testable. */
export interface PushEnvironment {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  desktopApp: boolean;
  userAgent: string;
  maxTouchPoints: number;
  /** Opened as an installed web app (home screen), not in a browser tab. */
  standalone: boolean;
}

export function readPushEnvironment(): PushEnvironment {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      secure: false,
      serviceWorker: false,
      pushManager: false,
      notification: false,
      desktopApp: false,
      userAgent: "",
      maxTouchPoints: 0,
      standalone: false,
    };
  }
  let standalone = false;
  try {
    standalone =
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    standalone = false;
  }
  return {
    secure: window.isSecureContext === true,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    desktopApp: inDesktopApp(),
    userAgent: navigator.userAgent ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone,
  };
}

/** An iPhone, iPod or iPad (iPadOS says "Macintosh" but has a touch screen; a Mac has none). */
export const isAppleMobile = (userAgent: string, maxTouchPoints: number) =>
  /\b(iPhone|iPad|iPod)\b/.test(userAgent) || (/\bMacintosh\b/.test(userAgent) && maxTouchPoints > 1);

/** Whether to offer notifications in this browser at all. */
export function canOfferWebPush(env: PushEnvironment): boolean {
  if (env.desktopApp) return false;
  if (!env.secure || !env.serviceWorker || !env.pushManager || !env.notification) return false;
  // Safari on an iPhone or iPad takes pushes only as an installed web app; there the phone app is the way.
  if (isAppleMobile(env.userAgent, env.maxTouchPoints) && !env.standalone) return false;
  return true;
}

export function deriveWebPushState(input: {
  offered: boolean;
  /** The server's key; `null` = Web Push off on the server. */
  publicKey: string | null;
  permission: NotificationPermission;
  subscribed: boolean;
}): WebPushState {
  if (!input.offered) return "unsupported";
  if (!input.publicKey) return "off-by-server";
  if (input.permission === "denied") return "denied";
  if (input.permission === "granted" && input.subscribed) return "subscribed";
  return "default";
}

/** A base64url string (the server's VAPID key) as the bytes `applicationServerKey` takes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = "";
  for (const b of view) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether a subscription was made with the server's current key (a new key needs a new subscription). */
export function sameKey(current: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!current) return false;
  try {
    return bytesToBase64Url(current) === bytesToBase64Url(base64UrlToBytes(publicKey));
  } catch {
    return false;
  }
}

/** What the server keeps of a subscription (`PushSubscription.toJSON()`); `null` when the browser left a part out. */
export function subscriptionBody(json: PushSubscriptionJSON, locale: string): PushDeviceInput | null {
  const { endpoint, keys } = json;
  if (!endpoint || !keys?.p256dh || !keys.auth) return null;
  return { platform: "web", endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, locale };
}

/** The service worker's message when a notification is clicked on a page already open (public/sw.js). */
export const PUSH_OPEN_MESSAGE = "agentes.push.open";

/** An in-app path from a notification's address: only this site's own pages; anything else is `null`. */
export function inAppPath(url: unknown, origin: string): string | null {
  if (typeof url !== "string" || !url) return null;
  if (url.startsWith("/") && !url.startsWith("//")) return url.startsWith("/api/") ? null : url;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin || parsed.pathname.startsWith("/api/")) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

// ── The browser ─────────────────────────────────────────────────────────────

const SW_URL = "/sw.js";
/** How long signing out waits for the server to forget this browser: a server that doesn't answer must not hold it. */
export const SIGN_OUT_WAIT_MS = 5000;

const permissionNow = (): NotificationPermission =>
  typeof Notification === "undefined" ? "default" : Notification.permission;

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration ? registration.pushManager.getSubscription() : null;
}

/** How notifications stand in this browser, given the server's key (`null`: Web Push off on the server). */
export async function readWebPushState(
  publicKey: string | null,
  env: PushEnvironment = readPushEnvironment(),
): Promise<WebPushState> {
  const offered = canOfferWebPush(env);
  const permission = offered ? permissionNow() : "default";
  const subscribed =
    offered && publicKey !== null && permission === "granted" && Boolean(await currentSubscription().catch(() => null));
  return deriveWebPushState({ offered, publicKey, permission, subscribed });
}

async function forgetSubscription(api: ApiClient, subscription: PushSubscription) {
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => false);
  await api.push.unregister(endpoint).catch(() => {});
}

/**
 * Subscribes with the server's key (anew when the key changed) and tells the server. `undo`: a registration the
 * server refused unsubscribes here too, for a click turning it on (the switch then says what is true). The quiet
 * refresh keeps the subscription instead, so a server restarting, a rate limit or a moment offline never turns
 * someone's notifications off; the next page load sends it again.
 */
async function subscribeAndSend(
  api: ApiClient,
  registration: ServiceWorkerRegistration,
  publicKey: string,
  locale: string,
  undo: boolean,
): Promise<void> {
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, publicKey)) {
    await forgetSubscription(api, subscription);
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(publicKey),
  });
  const body = subscriptionBody(subscription.toJSON(), locale);
  if (!body) {
    await subscription.unsubscribe().catch(() => false);
    throw new Error("The browser's subscription has no keys");
  }
  try {
    await api.push.register(body);
  } catch (error) {
    if (undo) await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

/**
 * Turns notifications on in this browser. Call it straight from the click: the browser asks for permission
 * only during a person's gesture, so the permission prompt comes before anything else is awaited. Answers the
 * new state; throws when the server refused it (429, offline): nothing stays on then.
 */
export async function enableWebPush(api: ApiClient, publicKey: string, locale: string): Promise<WebPushState> {
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "default";
  await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  const registration = await navigator.serviceWorker.ready;
  await subscribeAndSend(api, registration, publicKey, locale, true);
  return "subscribed";
}

/** Turns notifications off in this browser: unsubscribed here, forgotten by the server. Never throws. */
export async function disableWebPush(api: ApiClient): Promise<WebPushState> {
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await forgetSubscription(api, subscription);
  return "default";
}

/**
 * On opening the app, quietly: a browser already on tells the server again (it keeps it, and moves it to the
 * account signed in now), with a new subscription when the server's key changed. Asks nothing of the person
 * and never throws.
 */
export async function refreshWebPush(
  api: ApiClient,
  locale: string,
  env: PushEnvironment = readPushEnvironment(),
): Promise<void> {
  try {
    if (!canOfferWebPush(env) || permissionNow() !== "granted") return;
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (!registration || !(await registration.pushManager.getSubscription())) return;
    const publicKey = await api.push.webKey();
    // Off on the server for now: the subscription stays, for when it is on again.
    if (!publicKey) return;
    await subscribeAndSend(api, registration, publicKey, locale, false);
  } catch {
    // Quiet, and the subscription stays: the next opening tries again.
  }
}

/**
 * Signing out: this browser stops getting the account's notifications, and the ones it still shows leave the
 * screen (their full text is the account's, on a computer someone else may use next). Waits at most
 * `SIGN_OUT_WAIT_MS`.
 */
export async function forgetWebPush(api: ApiClient): Promise<void> {
  if (!canOfferWebPush(readPushEnvironment())) return;
  await Promise.race([
    Promise.all([clearAllShownPushes(), disableWebPush(api)]).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS)),
  ]);
}

/** Every sign-out (the account menu, a suspended workspace, an invitation's page) forgets this browser first. */
export function withWebPushSignOut(auth: AuthClient, api: ApiClient): AuthClient {
  return {
    ...auth,
    signOut: async () => {
      await forgetWebPush(api);
      await auth.signOut();
    },
  };
}

/**
 * A click on a notification while the app is open in a tab: the service worker focuses the tab and passes it the
 * notification (`PUSH_OPEN_MESSAGE`: its page and the push's data), so the app opens it without loading again
 * (`dispatchPushOpen` in push-open.ts).
 */
export function listenForPushOpens(open: (click: PushOpen) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const container = navigator.serviceWorker;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown; data?: unknown } | null;
    if (!data || data.type !== PUSH_OPEN_MESSAGE) return;
    const click = pushOpenFrom(data, (url) => inAppPath(url, window.location.origin));
    if (click) open(click);
  };
  container.addEventListener("message", onMessage);
  container.startMessages?.();
  return () => container.removeEventListener("message", onMessage);
}

// ── Clear on read ───────────────────────────────────────────────────────────

/**
 * A notification read, finished or snoozed anywhere (this tab, another browser, the phone) also leaves the
 * browser's list (ADR 0071). The server never sends browsers a "clear" push (a push that shows nothing ends
 * Safari's subscription and makes Chrome show its own notice), so open pages do it: the service worker shows
 * each push with its notification's id as the tag, and a page asks it to close the stale ones (public/sw.js).
 */

/** Page → service worker: close the notifications shown with these tags. */
export const PUSH_CLEAR_MESSAGE = "push-clear";
/** Page → service worker: which tags are shown now; the answer comes back on the message's port. */
export const PUSH_SHOWN_MESSAGE = "push-shown";
/** At most this many ids in one `api.push.stale` call (the route's limit). */
export const STALE_BATCH = 100;
/** How long to wait for the service worker's answer: an older worker never answers. */
export const SHOWN_WAIT_MS = 2000;
/** After the badge drops, wait this long, so a burst of reads ("Marcar tudo como lido") asks the server once. */
export const SWEEP_DELAY_MS = 1500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A shown notification's tag that is a notification's id (one shown while the app was in front has its own). */
export const isNotificationTag = (tag: unknown): tag is string => typeof tag === "string" && UUID.test(tag);

/**
 * The shown notifications a realtime event makes stale: one read, done or snoozed until later comes in again
 * (`notification.upserted`), and one gone from the inbox (`notification.removed`: done, snoozed, resolved).
 */
export function pushTagsToClear(event: NotificationEvent, now: number = Date.now()): string[] {
  if (event.type === "notification.removed") return [event.id];
  if (event.type !== "notification.upserted") return [];
  const n = event.notification;
  if (n.readAt || n.doneAt) return [n.id];
  if (n.snoozedUntil && Date.parse(n.snoozedUntil) > now) return [n.id];
  return [];
}

/**
 * Whether the badge went down: something was read or resolved without its own event ("Marcar tudo como lido"
 * sends only the new numbers), so the shown notifications are worth checking with the server.
 */
export function countsDropped(before: NotificationCount | undefined, after: NotificationCount): boolean {
  return before !== undefined && (after.unread < before.unread || after.waiting < before.waiting);
}

/** The shown tags worth asking the server about, once each, in groups of at most `STALE_BATCH`. */
export function staleBatches(tags: readonly string[], size: number = STALE_BATCH): string[][] {
  const ids = [...new Set(tags.filter(isNotificationTag))];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

/** The service worker's answer to `PUSH_SHOWN_MESSAGE`: its tags, nothing else. */
export function shownTagsOf(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const tags = (data as { tags?: unknown }).tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0) : [];
}

/** Read once per page load: what the browser offers doesn't change while it is open. */
let offeredHere: boolean | undefined;

/** The worker showing this site's notifications, when they are on in this browser (never the desktop app). */
async function pushWorker(): Promise<ServiceWorker | null> {
  offeredHere ??= canOfferWebPush(readPushEnvironment());
  if (!offeredHere || permissionNow() !== "granted") return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return registration?.active ?? null;
}

function askShownTags(worker: ServiceWorker): Promise<string[]> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (tags: string[]) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(tags);
    };
    timer = setTimeout(() => done([]), SHOWN_WAIT_MS);
    channel.port1.onmessage = (event) => done(shownTagsOf(event.data));
    try {
      worker.postMessage({ type: PUSH_SHOWN_MESSAGE }, [channel.port2]);
    } catch {
      done([]);
    }
  });
}

/** Closes the notifications shown for these ids in this browser. Never throws. */
export async function clearShownPushes(ids: readonly string[]): Promise<void> {
  const tags = [...new Set(ids.filter(isNotificationTag))];
  if (tags.length === 0) return;
  try {
    (await pushWorker())?.postMessage({ type: PUSH_CLEAR_MESSAGE, tags });
  } catch {
    // Quiet: the next sweep tries again.
  }
}

/**
 * Asks the server which of the notifications this browser still shows are stale, and closes those. Runs on
 * opening the app, whenever the tab comes back into view, and after the badge drops. Never throws.
 */
export async function sweepStalePushes(api: ApiClient): Promise<void> {
  try {
    const worker = await pushWorker();
    if (!worker) return;
    const batches = staleBatches(await askShownTags(worker));
    const stale: string[] = [];
    for (const batch of batches) stale.push(...(await api.push.stale(batch)));
    const tags = [...new Set(stale.filter(isNotificationTag))];
    if (tags.length > 0) worker.postMessage({ type: PUSH_CLEAR_MESSAGE, tags });
  } catch {
    // Quiet: the next sweep tries again.
  }
}

/** Takes every notification this site shows off the screen (signing out: they were the account's). Never throws. */
async function clearAllShownPushes(): Promise<void> {
  try {
    const worker = await pushWorker();
    if (!worker) return;
    const tags = await askShownTags(worker);
    if (tags.length > 0) worker.postMessage({ type: PUSH_CLEAR_MESSAGE, tags });
  } catch {
    // Quiet: signing out goes on.
  }
}

/** The sweep the open workspace set up (`useWebPushClear`, which has the API); realtime asks for it by name. */
let sweeper: (() => Promise<void>) | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
/** The badge's last numbers per workspace, to see them drop. */
const lastCounts = new Map<string, NotificationCount>();

export function setStalePushSweeper(run: (() => Promise<void>) | null): void {
  sweeper = run;
  if (!run) clearTimeout(sweepTimer);
}

/** A sweep soon, once for a burst of calls; nothing when no workspace set one up. */
export function requestStalePushSweep(delayMs: number = SWEEP_DELAY_MS): void {
  if (!sweeper) return;
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => void sweeper?.(), delayMs);
}

/**
 * A notification event from realtime: closes what it made stale in this browser, and asks for a sweep when
 * the badge dropped (`sweep` false in tabs that leave it to another, so only one asks the server).
 */
export function settleShownPushes(orgId: string, event: NotificationEvent, sweep: boolean): void {
  if (event.type === "notification.counts") {
    const counts = { unread: event.unread, waiting: event.waiting };
    const dropped = countsDropped(lastCounts.get(orgId), counts);
    lastCounts.set(orgId, counts);
    if (dropped && sweep) requestStalePushSweep();
    return;
  }
  const tags = pushTagsToClear(event);
  if (tags.length > 0) void clearShownPushes(tags);
}
