// agentes.chat service worker: notifications in this browser (Web Push, ADR 0071), nothing else.
// It has no fetch handler and caches nothing, so the app loads exactly as it does without it. The page
// registers it only when the person turns notifications on (apps/web/src/lib/web-push.ts).

/** What a click on a notification asks of a tab already open (`PUSH_OPEN_MESSAGE` in web-push.ts). */
const OPEN_MESSAGE = "agentes.push.open";
const ICON = "/email/mark.png";
const BADGE = "/push-badge.png";

// A new version takes over at once: it holds no state, so there is nothing to wait for.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Only this site's own pages, never the API; anything else opens the inbox's home. */
function inAppUrl(url) {
  try {
    const parsed = new URL(typeof url === "string" && url ? url : "/", self.location.origin);
    if (parsed.origin !== self.location.origin || parsed.pathname.startsWith("/api/")) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

/** An id that goes in a path as it is (`ID` in apps/web/src/lib/push-open.ts). */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (value) => typeof value === "string" && ID.test(value);
const PLACE_KEYS = ["channelId", "threadId", "approvalId", "missionId", "handoffId"];

/** The push's `data` (which notification, in which workspace), checked; `null` without one to open. */
function readOpenData(raw) {
  if (!raw || typeof raw !== "object" || !isId(raw.orgId) || !isId(raw.notificationId)) return null;
  const data = { orgId: raw.orgId, notificationId: raw.notificationId };
  if (typeof raw.kind === "string" && /^[a-z_]{1,40}$/.test(raw.kind)) data.kind = raw.kind;
  for (const key of PLACE_KEYS) if (isId(raw[key])) data[key] = raw[key];
  return data;
}

/**
 * Where a click goes: the notification itself (the inbox opens it on load and steps aside, `pushOpenPath` in
 * apps/web/src/lib/push-open.ts), else the push's own address.
 */
function openUrl(url, open) {
  if (open) return inAppUrl(`/org/${open.orgId}/notifications?open=${encodeURIComponent(open.notificationId)}`);
  return inAppUrl(url);
}

function readPayload(event) {
  if (!event.data) return null;
  try {
    const data = event.data.json();
    if (!data || typeof data !== "object") return null;
    const open = readOpenData(data.data);
    return {
      title: typeof data.title === "string" && data.title ? data.title : "agentes.chat",
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" && data.tag ? data.tag : undefined,
      url: openUrl(data.url, open),
      open,
    };
  } catch {
    return null;
  }
}

/** A tab of the app the person is looking at right now (visible and focused). */
async function lookingAtApp() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((client) => client.visibilityState === "visible" && client.focused);
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  if (!payload) return;
  event.waitUntil(
    (async () => {
      const options = {
        body: payload.body,
        icon: ICON,
        badge: BADGE,
        data: { url: payload.url, open: payload.open },
        renotify: false,
      };
      if (payload.tag) options.tag = payload.tag;
      if (await lookingAtApp()) {
        // The person is in the app, which already shows this (the inbox, the badge, the chat). Browsers want
        // a notification for every push (`userVisibleOnly`): Safari ends a subscription after a few pushes
        // without one, and Chrome may show its own "updated in the background" note. So the safe way is to
        // show it silently and close it at once, instead of skipping it. Its tag (its own when the push has
        // none) closes just this one, never the others still waiting in the system's list.
        const tag = payload.tag ?? `agentes-quiet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await self.registration.showNotification(payload.title, { ...options, tag, silent: true });
        const shown = await self.registration.getNotifications({ tag });
        for (const notification of shown) notification.close();
        return;
      }
      await self.registration.showNotification(payload.title, options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const open = readOpenData(event.notification.data?.open);
  const url = openUrl(event.notification.data?.url, open);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = windows.filter((client) => new URL(client.url).origin === self.location.origin);
      const client = same.find((c) => c.focused) ?? same.find((c) => c.visibilityState === "visible") ?? same[0];
      if (client) {
        // The app opens the notification without loading the page again (`listenForPushOpens`): the same
        // place a click in its inbox goes, marked read the same way.
        await client.focus().catch(() => {});
        client.postMessage({ type: OPEN_MESSAGE, url, data: open });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// Clear on read (ADR 0071): an open page closes what the person already read, finished or snoozed elsewhere.
// The server never pushes a "clear" to browsers (a push that shows nothing ends Safari's subscription and makes
// Chrome show its own notice), so the page asks here: "push-shown" answers the tags shown now (each one a
// notification's id), "push-clear" closes the ones with these tags (`PUSH_CLEAR_MESSAGE` in web-push.ts).
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "push-clear") {
    const tags = Array.isArray(data.tags) ? data.tags.filter((tag) => typeof tag === "string" && tag) : [];
    event.waitUntil(
      Promise.all(
        tags.slice(0, 500).map(async (tag) => {
          for (const notification of await self.registration.getNotifications({ tag })) notification.close();
        }),
      ).catch(() => {}),
    );
    return;
  }
  if (data.type === "push-shown") {
    const port = event.ports?.[0];
    event.waitUntil(
      self.registration
        .getNotifications()
        .then((shown) => {
          const reply = { type: "push-shown", tags: [...new Set(shown.map((n) => n.tag).filter(Boolean))] };
          if (port) port.postMessage(reply);
          else event.source?.postMessage(reply);
        })
        .catch(() => {}),
    );
  }
});

async function serverKey() {
  const res = await fetch("/api/app/push/web", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return typeof data?.publicKey === "string" ? data.publicKey : null;
}

function keyBytes(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(`${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// The browser replaced the subscription (expired, or keys rotated): subscribe again with the server's key (the
// old one when it can't be asked) and tell the server, best effort. The locale is the browser's: a service
// worker can't read the app's choice.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      let subscription = event.newSubscription ?? null;
      if (!subscription) {
        const current = await serverKey()
          .then((k) => (k ? keyBytes(k) : null))
          .catch(() => null);
        const key = current ?? event.oldSubscription?.options?.applicationServerKey ?? null;
        if (!key) return;
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
      }
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
      await fetch("/api/app/push/devices", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          platform: "web",
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          locale: self.navigator.language || "pt-BR",
        }),
      });
      const before = event.oldSubscription?.endpoint;
      if (before && before !== json.endpoint) {
        // In the body: an endpoint's encoded slashes in a path don't survive every proxy.
        await fetch("/api/app/push/devices/forget", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ token: before }),
        });
      }
    })().catch(() => {}),
  );
});
