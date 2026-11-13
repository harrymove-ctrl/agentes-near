import { describe, expect, test } from "bun:test";
import type { ApiClient, AppNotification } from "@agenteschat/client";
import type { AuthClient } from "../src/auth/client";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canOfferWebPush,
  countsDropped,
  deriveWebPushState,
  inAppPath,
  isAppleMobile,
  isNotificationTag,
  type PushEnvironment,
  pushTagsToClear,
  requestStalePushSweep,
  STALE_BATCH,
  sameKey,
  setStalePushSweeper,
  shownTagsOf,
  staleBatches,
  subscriptionBody,
  withWebPushSignOut,
} from "../src/lib/web-push";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_OLD = "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const browser = (over: Partial<PushEnvironment> = {}): PushEnvironment => ({
  secure: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  desktopApp: false,
  userAgent: CHROME,
  maxTouchPoints: 0,
  standalone: false,
  ...over,
});

describe("base64url (the server's key)", () => {
  test("decodes without padding and with the url alphabet, and back", () => {
    expect([...base64UrlToBytes("-_8")]).toEqual([251, 255]);
    expect(bytesToBase64Url(new Uint8Array([251, 255]))).toBe("-_8");
    expect([...base64UrlToBytes("AQID")]).toEqual([1, 2, 3]);
    const key = new Uint8Array(65).map((_, i) => (i * 37) % 256);
    expect([...base64UrlToBytes(bytesToBase64Url(key))]).toEqual([...key]);
    expect(bytesToBase64Url(key.buffer)).toBe(bytesToBase64Url(key));
  });

  test("a subscription made with another key needs a new one", () => {
    const key = bytesToBase64Url(new Uint8Array([4, 1, 2, 3]));
    expect(sameKey(new Uint8Array([4, 1, 2, 3]).buffer, key)).toBe(true);
    expect(sameKey(new Uint8Array([4, 1, 2, 9]).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
    expect(sameKey(undefined, key)).toBe(false);
  });
});

describe("where notifications in this browser are offered", () => {
  test("a secure browser with service workers, push and notifications", () => {
    expect(canOfferWebPush(browser())).toBe(true);
    expect(canOfferWebPush(browser({ secure: false }))).toBe(false);
    expect(canOfferWebPush(browser({ serviceWorker: false }))).toBe(false);
    expect(canOfferWebPush(browser({ pushManager: false }))).toBe(false);
    expect(canOfferWebPush(browser({ notification: false }))).toBe(false);
  });

  test("never in the desktop app: it shows its own notifications", () => {
    expect(canOfferWebPush(browser({ desktopApp: true }))).toBe(false);
  });

  test("on an iPhone or iPad only as an installed web app (the phone app is the way there)", () => {
    expect(isAppleMobile(IPHONE, 5)).toBe(true);
    expect(isAppleMobile(IPAD_OLD, 5)).toBe(true);
    // iPadOS says it is a Mac; a Mac has no touch screen.
    expect(isAppleMobile(MAC, 5)).toBe(true);
    expect(isAppleMobile(MAC, 0)).toBe(false);
    expect(isAppleMobile(CHROME, 10)).toBe(false);
    expect(canOfferWebPush(browser({ userAgent: IPHONE, maxTouchPoints: 5 }))).toBe(false);
    expect(canOfferWebPush(browser({ userAgent: MAC, maxTouchPoints: 5 }))).toBe(false);
    expect(canOfferWebPush(browser({ userAgent: IPHONE, maxTouchPoints: 5, standalone: true }))).toBe(true);
    expect(canOfferWebPush(browser({ userAgent: MAC }))).toBe(true);
  });
});

describe("the switch's state", () => {
  const base = { offered: true, publicKey: "BPk", permission: "default" as NotificationPermission, subscribed: false };

  test("hidden where it isn't offered or the server has it off", () => {
    expect(deriveWebPushState({ ...base, offered: false })).toBe("unsupported");
    expect(deriveWebPushState({ ...base, publicKey: null })).toBe("off-by-server");
    expect(deriveWebPushState({ ...base, offered: false, publicKey: null })).toBe("unsupported");
  });

  test("blocked by the browser, off, or on", () => {
    expect(deriveWebPushState({ ...base, permission: "denied" })).toBe("denied");
    expect(deriveWebPushState({ ...base, permission: "denied", subscribed: true })).toBe("denied");
    expect(deriveWebPushState(base)).toBe("default");
    // Allowed once, then turned off here: off, and a click turns it on without asking again.
    expect(deriveWebPushState({ ...base, permission: "granted" })).toBe("default");
    expect(deriveWebPushState({ ...base, permission: "granted", subscribed: true })).toBe("subscribed");
  });
});

describe("what the server keeps of a subscription", () => {
  test("its endpoint and keys, in the app's language", () => {
    const endpoint = "https://push.example/a";
    const keys = { p256dh: "p", auth: "a" };
    expect(subscriptionBody({ endpoint, keys }, "pt-BR")).toEqual({ platform: "web", endpoint, keys, locale: "pt-BR" });
  });

  test("nothing when the browser left a part out", () => {
    expect(subscriptionBody({ keys: { p256dh: "p", auth: "a" } }, "en")).toBeNull();
    expect(subscriptionBody({ endpoint: "https://push.example/a", keys: { p256dh: "p" } }, "en")).toBeNull();
    expect(subscriptionBody({ endpoint: "https://push.example/a" }, "en")).toBeNull();
  });
});

describe("a click on a notification opens the app's own page", () => {
  const origin = "https://app.example";
  test("paths and this site's addresses", () => {
    expect(inAppPath("/org/o1/notifications", origin)).toBe("/org/o1/notifications");
    expect(inAppPath("https://app.example/org/o1/c/c1?thread=t#m", origin)).toBe("/org/o1/c/c1?thread=t#m");
  });

  test("never another site, the API, or something that isn't an address", () => {
    expect(inAppPath("//evil.example/x", origin)).toBeNull();
    expect(inAppPath("https://evil.example/org/o1", origin)).toBeNull();
    expect(inAppPath("/api/app/push/web", origin)).toBeNull();
    expect(inAppPath("https://app.example/api/app/me", origin)).toBeNull();
    expect(inAppPath("javascript:alert(1)", origin)).toBeNull();
    expect(inAppPath("", origin)).toBeNull();
    expect(inAppPath(42, origin)).toBeNull();
  });
});

describe("signing out", () => {
  test("goes on to the real sign-out, keeping everything else", async () => {
    let signedOut = 0;
    const signIn = async () => ({ ok: true }) as const;
    const signOut = async () => {
      signedOut++;
    };
    const auth = { signIn, signOut } as unknown as AuthClient;
    const calls: string[] = [];
    const api = {
      push: {
        webKey: async () => "BPk",
        register: async () => {
          calls.push("register");
        },
        unregister: async () => {
          calls.push("unregister");
        },
      },
    } as unknown as ApiClient;
    const wrapped = withWebPushSignOut(auth, api);
    await wrapped.signOut();
    expect(signedOut).toBe(1);
    expect(wrapped.signIn).toBe(signIn);
    // No subscription in this browser: nothing to forget.
    expect(calls).toEqual([]);
  });
});

describe("clear on read", () => {
  const ID = "0192f1a0-7c3e-7a11-9b2c-3d4e5f607182";
  const OTHER = "0192f1a0-7c3e-7a11-9b2c-3d4e5f607183";
  const NOW = Date.parse("2026-10-27T12:00:00Z");
  const item = (over: Partial<AppNotification> = {}) =>
    ({ id: ID, readAt: null, doneAt: null, snoozedUntil: null, ...over }) as AppNotification;
  const upserted = (over: Partial<AppNotification> = {}) =>
    ({ type: "notification.upserted", notification: item(over) }) as const;

  test("read, done or snoozed until later closes its notification; new and unread stays", () => {
    expect(pushTagsToClear(upserted({ readAt: "2026-10-27T11:59:00Z" }), NOW)).toEqual([ID]);
    expect(pushTagsToClear(upserted({ doneAt: "2026-10-27T11:59:00Z" }), NOW)).toEqual([ID]);
    expect(pushTagsToClear(upserted({ snoozedUntil: "2026-10-28T09:00:00Z" }), NOW)).toEqual([ID]);
    expect(pushTagsToClear(upserted(), NOW)).toEqual([]);
    // Back from a snooze: in the inbox again, unread, so it stays.
    expect(pushTagsToClear(upserted({ snoozedUntil: "2026-10-27T11:00:00Z" }), NOW)).toEqual([]);
  });

  test("gone from the inbox closes it; the badge's numbers close nothing by themselves", () => {
    expect(pushTagsToClear({ type: "notification.removed", id: ID }, NOW)).toEqual([ID]);
    expect(pushTagsToClear({ type: "notification.counts", unread: 0, waiting: 0 }, NOW)).toEqual([]);
  });

  test("a drop in the badge asks the server, a rise or the first numbers don't", () => {
    expect(countsDropped(undefined, { unread: 0, waiting: 0 })).toBe(false);
    expect(countsDropped({ unread: 5, waiting: 1 }, { unread: 0, waiting: 1 })).toBe(true);
    expect(countsDropped({ unread: 5, waiting: 1 }, { unread: 5, waiting: 0 })).toBe(true);
    expect(countsDropped({ unread: 5, waiting: 1 }, { unread: 6, waiting: 1 })).toBe(false);
    expect(countsDropped({ unread: 5, waiting: 1 }, { unread: 5, waiting: 1 })).toBe(false);
  });

  test("only notification ids are asked about, once each, at most 100 per call", () => {
    expect(isNotificationTag(ID)).toBe(true);
    expect(isNotificationTag("agentes-quiet-1730000000000-abc")).toBe(false);
    expect(isNotificationTag("")).toBe(false);
    expect(isNotificationTag(42)).toBe(false);
    expect(staleBatches([])).toEqual([]);
    expect(staleBatches([ID, "agentes-quiet-1", ID, OTHER])).toEqual([[ID, OTHER]]);

    const ids = Array.from({ length: 250 }, (_, i) => `0192f1a0-7c3e-7a11-9b2c-${String(i).padStart(12, "0")}`);
    const batches = staleBatches(ids);
    expect(STALE_BATCH).toBe(100);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(ids);
  });

  test("the service worker's answer: its tags, nothing else", () => {
    expect(shownTagsOf({ type: "push-shown", tags: [ID, "", 3, null, OTHER] })).toEqual([ID, OTHER]);
    expect(shownTagsOf({ type: "push-shown" })).toEqual([]);
    expect(shownTagsOf(null)).toEqual([]);
    expect(shownTagsOf("x")).toEqual([]);
  });

  test("a burst of sweep requests runs one sweep; none without a workspace that set one up", async () => {
    let runs = 0;
    setStalePushSweeper(async () => {
      runs++;
    });
    requestStalePushSweep(5);
    requestStalePushSweep(5);
    requestStalePushSweep(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toBe(1);

    setStalePushSweeper(null);
    requestStalePushSweep(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toBe(1);
  });
});
