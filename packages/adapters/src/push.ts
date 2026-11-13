/**
 * Push notifications to the phone app (ADR 0035, ADR 0152). Core sends only from an
 * outbox job (`push.send`), never inline in a request. Android phones are reached
 * straight through Firebase Cloud Messaging (`push-fcm.ts`, the app registers its
 * FCM token); iPhones through the Expo Push API (the app registers an Expo push
 * token). `createPhonePushSender` sends each message to its platform's sender.
 * Tests use the fake.
 */
export type PushPlatform = "ios" | "android";

export interface PushMessage {
  /** The phone's token: FCM registration token (Android) or Expo push token (`ExponentPushToken[…]`, iOS). */
  to: string;
  platform: PushPlatform;
  title: string;
  body: string;
  /** Deep link data for the app (`{ orgId, kind, notificationId, … }`). */
  data: Record<string, unknown>;
  /** `high` wakes the device right away (things waiting for the person). */
  priority?: "default" | "high";
  /** The app's notification category (iOS `categoryId`): the buttons it shows on the lock screen. */
  category?: string;
}

export interface PushResult {
  token: string;
  ok: boolean;
  /** The token no longer reaches a device (app uninstalled, notifications off): delete it. */
  unregistered: boolean;
  /** Not taken now, but may be later (rate limited, the service unavailable): the outbox may try again. */
  retryable?: boolean;
  /**
   * Not sent because this server sends nothing to the phone's platform (`PUSH_SENDER=off`, or `direct` with no
   * Firebase account): not a failure, and the device stays for when it does.
   */
  skipped?: boolean;
  /** Accepted: the ticket to ask about later (`receipts`), when the service gives one. */
  ticketId?: string;
  error?: string;
}

/** What happened to a sent message, asked some minutes later (Expo push receipts). */
export interface PushDeliveryReceipt {
  ticketId: string;
  ok: boolean;
  /** The device is gone (`DeviceNotRegistered`): delete its token. */
  unregistered: boolean;
  error?: string;
}

export interface PushSender {
  readonly id: string;
  /** One result per message, in order. Throws `PushError` when the whole request failed. */
  send(messages: PushMessage[]): Promise<PushResult[]>;
  /**
   * Receipts of earlier tickets (job `push.receipts`, ~15 min after sending).
   * Tickets without a receipt yet (or anymore) are left out. Throws
   * `PushError` when the request failed. Absent: the sender has none.
   */
  receipts?(ticketIds: string[]): Promise<PushDeliveryReceipt[]>;
}

/** A request failure; `retryable` drives the outbox retry. */
export class PushError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PushError";
  }
}

/** Whether a sender's failure may work later: a `PushError` says so; anything else (the network, a store) may. */
const mayRetry = (error: unknown) => (error as { retryable?: unknown } | null)?.retryable !== false;

/**
 * The phone sender the server uses: each message goes to its platform's sender, in one `send` per
 * platform (both at once), and the results come back in the messages' order. A platform with no sender
 * answers its messages as `skipped`: neither sent, failed nor unregistered, so the device stays for when the
 * server sends there. Receipts are the iOS sender's
 * (only Expo gives tickets).
 *
 * One sender failing as a whole (a `PushError`) never keeps the other platform's phones from their push. When
 * no phone took it, that error is thrown (a retryable one first) as a single sender's would be, so the outbox
 * decides; when some did, the failed platform's phones answer it as their own failure instead, since a retry
 * would push the others twice.
 */
export function createPhonePushSender(senders: { android?: PushSender | null; ios?: PushSender | null }): PushSender {
  const of = (platform: PushPlatform) => senders[platform] ?? null;
  const ios = of("ios");
  return {
    id: "phones",
    async send(messages) {
      const out = new Array<PushResult>(messages.length);
      const thrown: { at: number[]; error: unknown }[] = [];
      await Promise.all(
        (["android", "ios"] as const).map(async (platform) => {
          const at = messages.flatMap((m, i) => (m.platform === platform ? [i] : []));
          if (at.length === 0) return;
          const sender = of(platform);
          if (!sender) {
            for (const i of at) {
              out[i] = {
                token: messages[i]?.to ?? "",
                ok: false,
                unregistered: false,
                skipped: true,
                error: `this server sends no ${platform} push`,
              };
            }
            return;
          }
          try {
            const results = await sender.send(at.map((i) => messages[i] as PushMessage));
            at.forEach((i, n) => {
              out[i] = results[n] ?? {
                token: messages[i]?.to ?? "",
                ok: false,
                unregistered: false,
                error: "no result",
              };
            });
          } catch (error) {
            thrown.push({ at, error });
          }
        }),
      );
      const first = thrown.find((t) => mayRetry(t.error)) ?? thrown[0];
      if (first && !out.some((r) => r?.ok)) throw first.error;
      for (const { at, error } of thrown) {
        for (const i of at) {
          out[i] = {
            token: messages[i]?.to ?? "",
            ok: false,
            unregistered: false,
            retryable: mayRetry(error),
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return out;
    },
    ...(ios?.receipts ? { receipts: (ids: string[]) => ios.receipts?.(ids) ?? Promise.resolve([]) } : {}),
  };
}

/** Expo accepts at most 100 messages per request. */
export const EXPO_PUSH_BATCH = 100;
export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo accepts at most 1000 ticket ids per receipts request. */
export const EXPO_RECEIPTS_BATCH = 1000;

type ExpoTicket = { status: "ok"; id?: string } | { status: "error"; message?: string; details?: { error?: string } };
type ExpoReceipt = { status: "ok" } | { status: "error"; message?: string; details?: { error?: string } };

/**
 * Expo Push API (`POST /--/api/v2/push/send`, JSON array, ≤100 per request).
 * `accessToken` is needed only when the Expo project has enhanced push
 * security on. 429 and 5xx retry; other 4xx don't. A ticket with
 * `DeviceNotRegistered` marks its token unregistered.
 */
export function createExpoPushSender(
  options: { accessToken?: string; url?: string; receiptsUrl?: string; fetch?: typeof fetch } = {},
) {
  const http = options.fetch ?? fetch;
  const url = options.url ?? EXPO_PUSH_URL;
  const receiptsUrl = options.receiptsUrl ?? EXPO_RECEIPTS_URL;
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
  };
  const sender: PushSender = {
    id: "expo",
    async send(messages) {
      const results: PushResult[] = [];
      for (let i = 0; i < messages.length; i += EXPO_PUSH_BATCH) {
        const batch = messages.slice(i, i + EXPO_PUSH_BATCH);
        let res: Response;
        try {
          res = await http(url, {
            method: "POST",
            headers,
            body: JSON.stringify(
              batch.map((m) => ({
                to: m.to,
                title: m.title,
                body: m.body,
                data: m.data,
                sound: "default",
                priority: m.priority ?? "default",
                ...(m.category ? { categoryId: m.category } : {}),
              })),
            ),
          });
        } catch (error) {
          throw new PushError(`could not reach Expo push: ${String(error)}`, true);
        }
        const payload = (await res.json().catch(() => ({}))) as {
          data?: ExpoTicket[];
          errors?: { code?: string; message?: string }[];
        };
        if (!res.ok || !Array.isArray(payload.data)) {
          const why = payload.errors?.map((e) => e.message ?? e.code).join("; ") ?? "";
          throw new PushError(
            `Expo push refused the request (${res.status}): ${why}`.trim(),
            res.status === 429 || res.status >= 500,
            res.status,
          );
        }
        batch.forEach((m, n) => {
          const ticket = payload.data?.[n];
          if (ticket?.status === "ok")
            results.push({ token: m.to, ok: true, unregistered: false, ...(ticket.id ? { ticketId: ticket.id } : {}) });
          else
            results.push({
              token: m.to,
              ok: false,
              unregistered: ticket?.details?.error === "DeviceNotRegistered",
              error: ticket?.message ?? ticket?.details?.error ?? "no ticket",
            });
        });
      }
      return results;
    },
    async receipts(ticketIds) {
      const out: PushDeliveryReceipt[] = [];
      for (let i = 0; i < ticketIds.length; i += EXPO_RECEIPTS_BATCH) {
        const ids = ticketIds.slice(i, i + EXPO_RECEIPTS_BATCH);
        let res: Response;
        try {
          res = await http(receiptsUrl, { method: "POST", headers, body: JSON.stringify({ ids }) });
        } catch (error) {
          throw new PushError(`could not reach Expo push receipts: ${String(error)}`, true);
        }
        const payload = (await res.json().catch(() => ({}))) as {
          data?: Record<string, ExpoReceipt>;
          errors?: { code?: string; message?: string }[];
        };
        if (!res.ok || !payload.data || typeof payload.data !== "object") {
          const why = payload.errors?.map((e) => e.message ?? e.code).join("; ") ?? "";
          throw new PushError(
            `Expo push receipts refused the request (${res.status}): ${why}`.trim(),
            res.status === 429 || res.status >= 500,
            res.status,
          );
        }
        for (const id of ids) {
          const receipt = payload.data[id];
          if (!receipt) continue;
          if (receipt.status === "ok") out.push({ ticketId: id, ok: true, unregistered: false });
          else
            out.push({
              ticketId: id,
              ok: false,
              unregistered: receipt.details?.error === "DeviceNotRegistered",
              error: receipt.message ?? receipt.details?.error ?? "error",
            });
        }
      }
      return out;
    },
  };
  return sender;
}

/**
 * Test sender: records every message, never sends. Tokens in `unregistered`
 * come back unregistered at once; tokens in `failing` as a failure that can be
 * retried (as FCM's 429 and 5xx); tokens in `goneLater` are accepted (a
 * ticket) and their receipts say `DeviceNotRegistered`.
 */
export function createFakePushSender(
  options: { unregistered?: Iterable<string>; failing?: Iterable<string>; goneLater?: Iterable<string> } = {},
) {
  const sent: PushMessage[] = [];
  const unregistered = new Set(options.unregistered ?? []);
  const failing = new Set(options.failing ?? []);
  const goneLater = new Set(options.goneLater ?? []);
  /** Ticket id → token. */
  const tickets = new Map<string, string>();
  const receiptRequests: string[][] = [];
  const sender: PushSender & {
    sent: PushMessage[];
    unregistered: Set<string>;
    failing: Set<string>;
    goneLater: Set<string>;
    tickets: Map<string, string>;
    receiptRequests: string[][];
    receipts(ticketIds: string[]): Promise<PushDeliveryReceipt[]>;
  } = {
    id: "fake",
    sent,
    unregistered,
    failing,
    goneLater,
    tickets,
    receiptRequests,
    async send(messages) {
      return messages.map((m): PushResult => {
        if (unregistered.has(m.to)) return { token: m.to, ok: false, unregistered: true, error: "DeviceNotRegistered" };
        if (failing.has(m.to))
          return { token: m.to, ok: false, unregistered: false, retryable: true, error: "unavailable" };
        sent.push(m);
        const ticketId = `fake-ticket-${tickets.size + 1}`;
        tickets.set(ticketId, m.to);
        return { token: m.to, ok: true, unregistered: false, ticketId };
      });
    },
    async receipts(ticketIds) {
      receiptRequests.push([...ticketIds]);
      return ticketIds.flatMap((ticketId): PushDeliveryReceipt[] => {
        const token = tickets.get(ticketId);
        if (!token) return [];
        return goneLater.has(token)
          ? [{ ticketId, ok: false, unregistered: true, error: "DeviceNotRegistered" }]
          : [{ ticketId, ok: true, unregistered: false }];
      });
    },
  };
  return sender;
}
