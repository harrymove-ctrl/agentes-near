import { createCipheriv, createECDH, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * Web Push to browsers (ADR 0071), written against the RFCs with no extra dependency:
 * the payload is encrypted to the browser (RFC 8291, `aes128gcm` content coding from RFC 8188: ECDH P-256
 * with the subscription's `p256dh`, its `auth` secret, HKDF) and the request is signed with this
 * installation's VAPID key (RFC 8292: an ES256 JWT for the push service's origin). The push service
 * only ever sees ciphertext. Core sends only from the `push.send` outbox job. Tests use the fake.
 */

/** A browser subscription's keys (from `PushSubscription.toJSON().keys`), base64url. */
export interface WebPushKeys {
  /** The browser's ECDH P-256 public key, an uncompressed point (65 bytes). */
  p256dh: string;
  /** The subscription's authentication secret (16 bytes). */
  auth: string;
}

export interface WebPushMessage {
  /** The subscription's endpoint (`https://…` at the browser's push service). */
  endpoint: string;
  keys: WebPushKeys;
  /** Serialized as JSON; at most `WEB_PUSH_PAYLOAD_MAX` bytes. */
  payload: unknown;
  /** How long the push service keeps it while the browser is away (default a day). */
  ttlSeconds?: number;
  /** `high` for things waiting for the person. */
  urgency?: "normal" | "high";
  /** A newer message with the same topic replaces an undelivered one (≤ 32 base64url characters). */
  topic?: string;
}

export interface WebPushResult {
  ok: boolean;
  /** The subscription can't be reached anymore (expired, unsubscribed, a host on our own network): delete it. */
  gone: boolean;
  /** Worth trying again later (429, 5xx, network, DNS). */
  retryable: boolean;
  /**
   * The push service refused this installation's signature (401/403): a subscription made for another key,
   * or a key or contact of ours it doesn't accept. Not proof the subscription is gone, so it is kept.
   */
  unauthorized?: boolean;
  status?: number;
  error?: string;
}

export interface WebPushSender {
  readonly id: string;
  /** Never throws: every failure is a result. */
  send(message: WebPushMessage): Promise<WebPushResult>;
}

/** This installation's VAPID identity (RFC 8292). */
export interface VapidKeys {
  /** Uncompressed P-256 point, base64url (what browsers get as `applicationServerKey`). */
  publicKey: string;
  /** The private scalar `d` (32 bytes), base64url. */
  privateKey: string;
  /** Who runs this server, for the push service: an `https:` URL or a `mailto:` address. */
  subject: string;
}

/** Payloads are kept to 3 KB (one 4096-byte record holds a bit less than 4 KB of plaintext). */
export const WEB_PUSH_PAYLOAD_MAX = 3072;
export const WEB_PUSH_TIMEOUT_MS = 10_000;
/** A day: a push older than that is no news anymore. */
export const WEB_PUSH_DEFAULT_TTL_SECONDS = 86_400;
/** RFC 8292 allows up to 24 h; half of it leaves room for clock drift. */
export const VAPID_JWT_TTL_SECONDS = 12 * 3600;
/** Record size announced in the `aes128gcm` header: the whole message is one record. */
const RECORD_SIZE = 4096;
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

const b64u = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const fromB64u = (value: string) => Buffer.from(value.replace(/=+$/, ""), "base64url");
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/** A subscription whose keys can't be used (not a P-256 point, a short secret). */
export class WebPushKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebPushKeyError";
  }
}

/**
 * Encrypts one payload for one subscription (RFC 8291 §3, RFC 8188 §2): the body to POST, header
 * included (salt, record size, the sender's ephemeral public key). `fixed` pins the salt and the
 * sender's private key, only so the RFC's test vector can be checked; a real send leaves both random.
 */
export function encryptWebPush(
  plaintext: Uint8Array,
  subscriber: WebPushKeys,
  fixed: { salt?: Uint8Array; senderPrivateKey?: Uint8Array } = {},
): Buffer {
  const uaPublic = fromB64u(subscriber.p256dh);
  const authSecret = fromB64u(subscriber.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04)
    throw new WebPushKeyError("p256dh is not an uncompressed P-256 point");
  if (authSecret.length < 16) throw new WebPushKeyError("auth secret is shorter than 16 bytes");
  if (plaintext.length > RECORD_SIZE - 16 - 1 - 86) throw new WebPushKeyError("payload doesn't fit in one record");

  const ecdh = createECDH("prime256v1");
  if (fixed.senderPrivateKey) ecdh.setPrivateKey(Buffer.from(fixed.senderPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = ecdh.computeSecret(uaPublic);
  } catch {
    throw new WebPushKeyError("p256dh is not a point on P-256");
  }
  const salt = Buffer.from(fixed.salt ?? randomBytes(16));

  // RFC 8291 §3.4: the input keying material mixes the ECDH secret with the subscription's auth secret.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0]), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  // RFC 8188 §2.2–2.3: content encryption key and nonce (one record, so sequence number 0).
  const prk = hmac(salt, ikm);
  const expand = (label: string, length: number) =>
    hmac(prk, Buffer.concat([Buffer.from(`Content-Encoding: ${label}`), Buffer.from([0, 1])])).subarray(0, length);
  const cek = expand("aes128gcm", 16);
  const nonce = expand("nonce", 12);

  // The last (only) record ends with the 0x02 delimiter and no padding.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  const sealed = Buffer.concat([cipher.update(record), cipher.final()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed, cipher.getAuthTag()]);
}

/** A new VAPID key pair: the public key as an uncompressed point and the private `d`, both base64url. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error("couldn't export the VAPID key");
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])), privateKey: jwk.d };
}

const signingKeys = new Map<string, Promise<CryptoKey>>();

/** The private key as a WebCrypto ECDSA key (cached: the same pair signs every push). */
function signingKey(vapid: Pick<VapidKeys, "publicKey" | "privateKey">): Promise<CryptoKey> {
  const id = `${vapid.publicKey}.${vapid.privateKey}`;
  let key = signingKeys.get(id);
  if (!key) {
    const point = fromB64u(vapid.publicKey);
    if (point.length !== 65 || point[0] !== 0x04)
      return Promise.reject(new Error("the VAPID public key is not an uncompressed P-256 point"));
    const jwk = {
      kty: "EC",
      crv: "P-256",
      d: vapid.privateKey.replace(/=+$/, ""),
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
      ext: false,
    };
    key = crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    key.catch(() => signingKeys.delete(id));
    if (signingKeys.size > 8) signingKeys.clear();
    signingKeys.set(id, key);
  }
  return key;
}

/**
 * The `Authorization` header of one push (RFC 8292 §3): `vapid t=<ES256 JWT>, k=<public key>`, the JWT
 * for the endpoint's origin, valid 12 h.
 */
export async function vapidAuthorization(endpoint: string, vapid: VapidKeys, now = Date.now()): Promise<string> {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + VAPID_JWT_TTL_SECONDS,
      sub: vapid.subject,
    }),
  );
  const input = `${header}.${claims}`;
  // WebCrypto's ECDSA signature is already JWS's form (r ‖ s, 64 bytes).
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await signingKey(vapid),
    new TextEncoder().encode(input),
  );
  return `vapid t=${input}.${b64u(new Uint8Array(signature))}, k=${vapid.publicKey.replace(/=+$/, "")}`;
}

/** What a push service's answer means for the subscription. */
export function webPushResultOf(status: number, detail = ""): WebPushResult {
  if (status >= 200 && status < 300) return { ok: true, gone: false, retryable: false, status };
  const error = `push service answered ${status}${detail ? `: ${detail}` : ""}`;
  // 404/410: expired or unsubscribed, for good.
  if (status === 404 || status === 410) return { ok: false, gone: true, retryable: false, status, error };
  // 401/403: the signature was refused. A subscription made for a key this installation replaced answers so,
  // but so does every subscription when our own key or contact is wrong (a pinned pair, a contact the push
  // service rejects, a clock far off): deleting on it would wipe every browser over a setting. The page
  // subscribes again with the new key on its next load, and a browser whose session ended is dropped anyway.
  if (status === 401 || status === 403)
    return { ok: false, gone: false, retryable: false, unauthorized: true, status, error };
  if (status === 429 || status >= 500) return { ok: false, gone: false, retryable: true, status, error };
  return { ok: false, gone: false, retryable: false, status, error };
}

/**
 * Sends Web Push through each subscription's push service. `vapid` gives this installation's key pair
 * (read once per send; the engine caches it). Only `https:` endpoints; `checkHost` (when given) refuses
 * hosts on our own network, since the endpoint comes from a browser. No redirects followed.
 */
export function createWebPushSender(options: {
  vapid: () => Promise<VapidKeys>;
  fetch?: typeof fetch;
  /**
   * Whether the endpoint's host may be called: `false` for one on our own network (the subscription is
   * dropped). Throws when it can't tell now (DNS doesn't answer): a failure to retry, never a reason to drop it.
   */
  checkHost?: (host: string) => Promise<boolean>;
  timeoutMs?: number;
}): WebPushSender {
  const http = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? WEB_PUSH_TIMEOUT_MS;
  return {
    id: "web-push",
    async send(message) {
      let url: URL;
      try {
        url = new URL(message.endpoint);
      } catch {
        return { ok: false, gone: true, retryable: false, error: "endpoint is not a URL" };
      }
      if (url.protocol !== "https:")
        return { ok: false, gone: false, retryable: false, error: "endpoint is not https" };
      const plaintext = Buffer.from(JSON.stringify(message.payload ?? null));
      if (plaintext.length > WEB_PUSH_PAYLOAD_MAX)
        return { ok: false, gone: false, retryable: false, error: "payload is larger than 3 KB" };
      if (options.checkHost) {
        let allowed: boolean;
        try {
          allowed = await options.checkHost(url.hostname);
        } catch (error) {
          const why = `couldn't check the endpoint's host: ${String(error)}`;
          return { ok: false, gone: false, retryable: true, error: why };
        }
        if (!allowed) return { ok: false, gone: true, retryable: false, error: "endpoint's host is not allowed" };
      }
      let body: Buffer;
      try {
        body = encryptWebPush(plaintext, message.keys);
      } catch (error) {
        return { ok: false, gone: true, retryable: false, error: `unusable subscription keys: ${String(error)}` };
      }
      let authorization: string;
      try {
        authorization = await vapidAuthorization(url.href, await options.vapid());
      } catch (error) {
        return { ok: false, gone: false, retryable: true, error: `no VAPID key: ${String(error)}` };
      }
      const headers: Record<string, string> = {
        authorization,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(Math.max(0, Math.floor(message.ttlSeconds ?? WEB_PUSH_DEFAULT_TTL_SECONDS))),
        urgency: message.urgency ?? "normal",
      };
      if (message.topic && TOPIC.test(message.topic)) headers.topic = message.topic;
      let res: Response;
      try {
        res = await http(url.href, {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const why = `could not reach the push service: ${String(error)}`;
        return { ok: false, gone: false, retryable: true, error: why };
      }
      const detail = res.ok ? "" : (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
      return webPushResultOf(res.status, detail);
    },
  };
}

/**
 * Test sender: records every message, never sends. Endpoints in `gone` answer as gone (410), those in
 * `failing` as a retryable failure (503), those in `refused` as a final one (400), those in
 * `unauthorized` as a refused signature (403).
 */
export function createFakeWebPushSender(
  options: {
    gone?: Iterable<string>;
    failing?: Iterable<string>;
    refused?: Iterable<string>;
    unauthorized?: Iterable<string>;
  } = {},
) {
  const sent: WebPushMessage[] = [];
  const gone = new Set(options.gone ?? []);
  const failing = new Set(options.failing ?? []);
  const refused = new Set(options.refused ?? []);
  const unauthorized = new Set(options.unauthorized ?? []);
  const sender: WebPushSender & {
    sent: WebPushMessage[];
    gone: Set<string>;
    failing: Set<string>;
    refused: Set<string>;
    unauthorized: Set<string>;
  } = {
    id: "fake-web-push",
    sent,
    gone,
    failing,
    refused,
    unauthorized,
    async send(message) {
      if (gone.has(message.endpoint)) return webPushResultOf(410);
      if (failing.has(message.endpoint)) return webPushResultOf(503);
      if (refused.has(message.endpoint)) return webPushResultOf(400);
      if (unauthorized.has(message.endpoint)) return webPushResultOf(403);
      sent.push(message);
      return webPushResultOf(201);
    },
  };
  return sender;
}
