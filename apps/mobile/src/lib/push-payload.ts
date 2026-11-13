/**
 * What a push carries for the deep link (ADR 0035 §4; the server's `PUSH_PLACE_KEYS` in packages/engine/src/push.ts):
 * `{ orgId, kind, notificationId }` and the ids of where it happened. Pure: reads untrusted notification data into
 * known string fields (anything else is dropped), so the route mapping (`hrefForPush`) gets clean input.
 */
export type PushData = Partial<Record<(typeof FIELDS)[number], string>>;

const FIELDS = [
  // The server it came from (ADR 0154): a phone signed in to several opens it there.
  "server",
  "orgId",
  "kind",
  "notificationId",
  "channelId",
  "threadId",
  "messageId",
  "dmId",
  "approvalId",
  "missionId",
  // An agent's browser handoff (ADR 0040): opens its live view.
  "handoffId",
  "routineId",
  "agentId",
  "machineId",
  "topicId",
  "issueNumber",
  // A device's notifications: the phone it is about, and the join or access request.
  "phoneId",
  "requestId",
] as const;

export function readPushData(data: unknown): PushData {
  const out: PushData = {};
  if (!data || typeof data !== "object") return out;
  const o = data as Record<string, unknown>;
  for (const key of FIELDS) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0 && v.length <= 200) out[key] = v;
  }
  return out;
}

/**
 * A push about the conversation open on screen stays quiet (no banner, no sound, no buzz): what it says
 * is already arriving in front of the person.
 */
export function quietWhileOpen(data: PushData, open: { orgId: string; channelId: string } | null): boolean {
  if (!open || !data.channelId) return false;
  return data.channelId === open.channelId && (!data.orgId || data.orgId === open.orgId);
}

/**
 * Who holds a value (the conversation on screen): `hold` sets it and returns the release, which clears it
 * only if it still holds that same value. A screen that loses focus after the next one took over (React
 * Navigation may blur the old one after focusing the new one) doesn't wipe the new one's value.
 */
export function createHolder<T extends object>() {
  let current: T | null = null;
  return {
    get: () => current,
    hold(value: T) {
      current = value;
      return () => {
        if (current === value) current = null;
      };
    },
  };
}

/** The body of `POST /api/app/push/devices`. */
export function deviceBody(token: string, platform: string, locale: string) {
  return { token, platform: platform === "ios" ? "ios" : "android", locale };
}

/** `DELETE /api/app/push/devices/:token` path (the token has brackets: encode it). */
export const devicePath = (token: string) => `/api/app/push/devices/${encodeURIComponent(token)}`;

/**
 * The token `getDevicePushTokenAsync` / `addPushTokenListener` hand over (`{ type, data }`): on Android the FCM
 * registration token, a string (ADR 0152). Anything else is no token.
 */
export function systemToken(token: { data?: unknown } | null | undefined): string | null {
  const data = token?.data;
  return typeof data === "string" && data.length > 0 && data.length <= 2048 ? data : null;
}
