import { describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import {
  createFakeWebPushSender,
  createWebPushSender,
  encryptWebPush,
  generateVapidKeys,
  VAPID_JWT_TTL_SECONDS,
  type VapidKeys,
  vapidAuthorization,
  type WebPushKeys,
  webPushResultOf,
} from "../src";

const b64u = (value: string) => Buffer.from(value, "base64url");

/** RFC 8291 Appendix A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/** What the browser does (RFC 8291 §3, RFC 8188 §2), written apart from the sender so each checks the other. */
function decrypt(body: Uint8Array, uaPrivate: string, auth: string): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idlen);
  const ciphertext = buf.subarray(21 + idlen, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(b64u(uaPrivate));
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\u0000"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(hmac(b64u(auth), secret), info);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\u0000\u0001")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\u0000\u0001")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Strip the padding delimiter (0x02) and any zeros after it.
  const end = record.lastIndexOf(2);
  return record.subarray(0, end).toString("utf8");
}

/** A browser's subscription keys, made here. */
function browserKeys(): { keys: WebPushKeys; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") },
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

function vapid(): VapidKeys {
  return { ...generateVapidKeys(), subject: "mailto:ops@example.com" };
}

async function verifyJwt(jwt: string, publicKey: string) {
  const [header, claims, signature] = jwt.split(".");
  const key = await crypto.subtle.importKey("raw", b64u(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64u(signature ?? ""),
    new TextEncoder().encode(`${header}.${claims}`),
  );
}

describe("Web Push encryption (RFC 8291)", () => {
  test("the RFC's test vector: same salt and sender key give the same body", () => {
    const body = encryptWebPush(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: b64u(RFC.salt), senderPrivateKey: b64u(RFC.asPrivate) },
    );
    expect(body.toString("base64url")).toBe(RFC.body);
    // The header carries the salt, a 4096-byte record and the sender's public key.
    expect(body.subarray(0, 16).toString("base64url")).toBe(RFC.salt);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.subarray(21, 86).toString("base64url")).toBe(RFC.asPublic);
  });

  test("the RFC's body decrypts with the browser's key", () => {
    expect(decrypt(b64u(RFC.body), RFC.uaPrivate, RFC.auth)).toBe(RFC.plaintext);
  });

  test("a random salt and key each time; the browser reads it back", () => {
    const browser = browserKeys();
    const text = JSON.stringify({ title: "Oi", body: "Tudo certo?" });
    const a = encryptWebPush(new TextEncoder().encode(text), browser.keys);
    const b = encryptWebPush(new TextEncoder().encode(text), browser.keys);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, browser.privateKey, browser.keys.auth)).toBe(text);
    expect(decrypt(b, browser.privateKey, browser.keys.auth)).toBe(text);
  });

  test("keys that aren't a P-256 point or a 16-byte secret are refused", () => {
    const browser = browserKeys();
    const bytes = new TextEncoder().encode("x");
    expect(() => encryptWebPush(bytes, { ...browser.keys, p256dh: "AAAA" })).toThrow();
    expect(() => encryptWebPush(bytes, { ...browser.keys, auth: "AAAA" })).toThrow();
    const notOnCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
    expect(() => encryptWebPush(bytes, { ...browser.keys, p256dh: notOnCurve })).toThrow();
  });
});

describe("VAPID (RFC 8292)", () => {
  test("generated keys: a 65-byte uncompressed point and a 32-byte private key", () => {
    const keys = generateVapidKeys();
    expect(b64u(keys.publicKey).length).toBe(65);
    expect(b64u(keys.publicKey)[0]).toBe(4);
    expect(b64u(keys.privateKey).length).toBe(32);
    expect(generateVapidKeys().publicKey).not.toBe(keys.publicKey);
  });

  test("the header: an ES256 JWT for the endpoint's origin, 12 h, signed with our key", async () => {
    const keys = vapid();
    const now = Date.UTC(2026, 9, 27, 12);
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def", keys, now);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match?.[2]).toBe(keys.publicKey);
    const jwt = match?.[1] ?? "";
    const [head, claims] = jwt.split(".");
    expect(JSON.parse(b64u(head ?? "").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(b64u(claims ?? "").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + VAPID_JWT_TTL_SECONDS,
      sub: "mailto:ops@example.com",
    });
    expect(b64u(jwt.split(".")[2] ?? "").length).toBe(64);
    expect(await verifyJwt(jwt, keys.publicKey)).toBe(true);
    expect(await verifyJwt(jwt, generateVapidKeys().publicKey)).toBe(false);
  });
});

describe("Web Push sender", () => {
  const ENDPOINT = "https://updates.push.example/wpush/v2/abc";

  function sender(answer: (url: string, init: RequestInit) => Response | Promise<Response>, keys = vapid()) {
    const calls: { url: string; init: RequestInit }[] = [];
    const push = createWebPushSender({
      vapid: async () => keys,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer(url, init);
      }) as unknown as typeof fetch,
    });
    return { push, calls, keys };
  }

  test("posts the encrypted payload with the VAPID header, TTL, urgency and topic", async () => {
    const browser = browserKeys();
    const { push, calls, keys } = sender(() => new Response(null, { status: 201 }));
    const payload = { title: "Dev mencionou você", body: "olha isso", url: "/org/o/notifications" };
    const result = await push.send({
      endpoint: ENDPOINT,
      keys: browser.keys,
      payload,
      urgency: "high",
      ttlSeconds: 3600,
      topic: "abc123",
    });
    expect(result).toEqual({ ok: true, gone: false, retryable: false, status: 201 });
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.init.headers);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(calls[0]?.init.method).toBe("POST");
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("ttl")).toBe("3600");
    expect(headers.get("urgency")).toBe("high");
    expect(headers.get("topic")).toBe("abc123");
    expect(headers.get("authorization")).toStartWith("vapid t=");
    expect(headers.get("authorization")).toEndWith(`, k=${keys.publicKey}`);
    const jwt = /t=([^,]+)/.exec(headers.get("authorization") ?? "")?.[1] ?? "";
    expect(JSON.parse(b64u(jwt.split(".")[1] ?? "").toString()).aud).toBe("https://updates.push.example");
    // Only the browser can read it.
    const body = calls[0]?.init.body as Uint8Array;
    expect(JSON.parse(decrypt(body, browser.privateKey, browser.keys.auth))).toEqual(payload);
  });

  test("status mapping: gone, retryable, refused", async () => {
    const browser = browserKeys();
    const send = async (status: number) => {
      const { push } = sender(() => new Response("nope", { status }));
      return push.send({ endpoint: ENDPOINT, keys: browser.keys, payload: {} });
    };
    for (const status of [404, 410]) expect(await send(status)).toMatchObject({ ok: false, gone: true });
    // A refused signature isn't proof the subscription is gone: our own key or contact may be what's wrong.
    for (const status of [401, 403])
      expect(await send(status)).toMatchObject({ ok: false, gone: false, retryable: false, unauthorized: true });
    for (const status of [429, 500, 503])
      expect(await send(status)).toMatchObject({ ok: false, gone: false, retryable: true, status });
    expect(await send(400)).toMatchObject({
      ok: false,
      gone: false,
      retryable: false,
      error: "push service answered 400: nope",
    });
    expect(await send(413)).toMatchObject({ ok: false, gone: false, retryable: false });
  });

  test("a network failure is retryable", async () => {
    const { push } = sender(() => {
      throw new Error("ECONNRESET");
    });
    expect(await push.send({ endpoint: ENDPOINT, keys: browserKeys().keys, payload: {} })).toMatchObject({
      ok: false,
      gone: false,
      retryable: true,
    });
  });

  test("only https endpoints, payloads up to 3 KB and usable keys; nothing is sent otherwise", async () => {
    const browser = browserKeys();
    const { push, calls } = sender(() => new Response(null, { status: 201 }));
    expect(await push.send({ endpoint: "http://push.example/x", keys: browser.keys, payload: {} })).toMatchObject({
      ok: false,
      gone: false,
      retryable: false,
    });
    expect(
      await push.send({ endpoint: ENDPOINT, keys: browser.keys, payload: { text: "x".repeat(4000) } }),
    ).toMatchObject({ ok: false, retryable: false });
    expect(
      await push.send({ endpoint: ENDPOINT, keys: { ...browser.keys, p256dh: "AAAA" }, payload: {} }),
    ).toMatchObject({ ok: false, gone: true });
    expect(calls).toHaveLength(0);
  });

  test("a host refused by checkHost is never called; one it can't check now is tried again later", async () => {
    let called = false;
    const push = createWebPushSender({
      vapid: async () => vapid(),
      fetch: (async () => {
        called = true;
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
      checkHost: async (host) => {
        if (host === "dns-down.example") throw new Error("getaddrinfo EAI_AGAIN");
        return host !== "internal.example";
      },
    });
    const keys = browserKeys().keys;
    const result = await push.send({ endpoint: "https://internal.example/x", keys, payload: {} });
    expect(result).toMatchObject({ ok: false, gone: true });
    // DNS that doesn't answer never drops a subscription.
    const unsure = await push.send({ endpoint: "https://dns-down.example/x", keys, payload: {} });
    expect(unsure).toMatchObject({ ok: false, gone: false, retryable: true });
    expect(called).toBe(false);
    expect(await push.send({ endpoint: ENDPOINT, keys, payload: {} })).toMatchObject({ ok: true });
    expect(called).toBe(true);
  });

  test("result mapping and the fake sender", async () => {
    expect(webPushResultOf(201)).toEqual({ ok: true, gone: false, retryable: false, status: 201 });
    const fake = createFakeWebPushSender({
      gone: ["https://a"],
      failing: ["https://b"],
      refused: ["https://c"],
      unauthorized: ["https://e"],
    });
    const keys = browserKeys().keys;
    expect(await fake.send({ endpoint: "https://a", keys, payload: {} })).toMatchObject({ gone: true });
    expect(await fake.send({ endpoint: "https://b", keys, payload: {} })).toMatchObject({ retryable: true });
    const refused = await fake.send({ endpoint: "https://c", keys, payload: {} });
    expect(refused).toMatchObject({ ok: false, retryable: false });
    const unauthorized = await fake.send({ endpoint: "https://e", keys, payload: {} });
    expect(unauthorized).toMatchObject({ ok: false, gone: false, unauthorized: true, status: 403 });
    expect(await fake.send({ endpoint: "https://d", keys, payload: {} })).toMatchObject({ ok: true });
    expect(fake.sent.map((m) => m.endpoint)).toEqual(["https://d"]);
  });
});
