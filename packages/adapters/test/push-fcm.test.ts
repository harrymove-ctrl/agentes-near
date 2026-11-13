import { beforeAll, describe, expect, test } from "bun:test";
import {
  createFcmPushSender,
  FCM_SCOPE,
  FCM_URL,
  type FcmServiceAccount,
  fcmMessage,
  fcmResultOf,
  GOOGLE_TOKEN_URL,
  type PushMessage,
} from "../src";

const msg = (to: string, priority?: "high" | "default"): PushMessage => ({
  to,
  platform: "android",
  title: "Ada mencionou você",
  body: "pode olhar?",
  data: { orgId: "o", kind: "mention", notificationId: "n1" },
  ...(priority ? { priority } : {}),
});

let account: FcmServiceAccount;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  publicKey = pair.publicKey;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  account = { projectId: "test-project", clientEmail: "push@test-project.iam.gserviceaccount.com", privateKey: pem };
});

type Call = { url: string; init: RequestInit };

/** FCM and Google's token endpoint; `answer` decides each message's reply. */
function fakeGoogle(answer: (token: string, bearer: string) => Response | Promise<Response> = () => Response.json({})) {
  const calls: Call[] = [];
  const tokenCalls: Call[] = [];
  let issued = 0;
  const http = (async (url: string, init: RequestInit) => {
    if (url === GOOGLE_TOKEN_URL) {
      tokenCalls.push({ url, init });
      issued++;
      return Response.json({ access_token: `access-${issued}`, expires_in: 3600, token_type: "Bearer" });
    }
    calls.push({ url, init });
    const body = JSON.parse(String(init.body)) as { message: { token: string } };
    const bearer = new Headers(init.headers).get("authorization") ?? "";
    return answer(body.message.token, bearer);
  }) as unknown as typeof fetch;
  return { http, calls, tokenCalls };
}

describe("fcmMessage", () => {
  test("a data message expo-notifications presents: title, message, the data as JSON, the channel", () => {
    expect(fcmMessage(msg("tok-1"))).toEqual({
      message: {
        token: "tok-1",
        android: { priority: "NORMAL", ttl: "86400s" },
        data: {
          title: "Ada mencionou você",
          message: "pode olhar?",
          body: JSON.stringify({ orgId: "o", kind: "mention", notificationId: "n1" }),
          channelId: "default",
          sound: "default",
        },
      },
    });
    expect(fcmMessage(msg("tok-1", "high")).message.android.priority).toBe("HIGH");
  });
});

describe("fcmResultOf", () => {
  const error = (status: number, errorCode: string, extra: Record<string, unknown> = {}) => ({
    error: { code: status, status: errorCode, details: [{ errorCode }], ...extra },
  });

  test("gone tokens are unregistered; 429 and 5xx retry; other refusals are final", () => {
    expect(fcmResultOf("t", 200, {})).toEqual({ token: "t", ok: true, unregistered: false });
    expect(fcmResultOf("t", 404, error(404, "UNREGISTERED"))).toMatchObject({ ok: false, unregistered: true });
    expect(fcmResultOf("t", 403, error(403, "SENDER_ID_MISMATCH"))).toMatchObject({ unregistered: true });
    // A 404 that doesn't say UNREGISTERED is about the request (the project), never the phone.
    const notFound = { error: { code: 404, status: "NOT_FOUND", message: "Requested entity was not found." } };
    expect(fcmResultOf("t", 404, notFound)).toMatchObject({ unregistered: false, retryable: false });
    const badToken = {
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "The registration token is not a valid FCM registration token",
        details: [{ fieldViolations: [{ field: "message.token" }] }],
      },
    };
    expect(fcmResultOf("t", 400, badToken)).toMatchObject({ unregistered: true });
    expect(fcmResultOf("t", 429, error(429, "QUOTA_EXCEEDED"))).toMatchObject({ unregistered: false, retryable: true });
    expect(fcmResultOf("t", 503, error(503, "UNAVAILABLE"))).toMatchObject({ retryable: true });
    expect(fcmResultOf("t", 400, error(400, "INVALID_ARGUMENT"))).toMatchObject({
      unregistered: false,
      retryable: false,
    });
  });
});

describe("FCM push sender", () => {
  test("one access token for every send, signed by the service account; one request per message", async () => {
    const google = fakeGoogle();
    const sender = createFcmPushSender({ serviceAccount: account, fetch: google.http });
    const results = await sender.send([msg("tok-1"), msg("tok-2", "high")]);
    await sender.send([msg("tok-3")]);

    expect(results).toEqual([
      { token: "tok-1", ok: true, unregistered: false },
      { token: "tok-2", ok: true, unregistered: false },
    ]);
    expect(google.tokenCalls).toHaveLength(1);
    const sendUrl = `${FCM_URL}/v1/projects/test-project/messages:send`;
    expect(google.calls.map((c) => c.url)).toEqual([sendUrl, sendUrl, sendUrl]);
    const bearers = google.calls.map((c) => new Headers(c.init.headers).get("authorization"));
    expect(bearers).toEqual(["Bearer access-1", "Bearer access-1", "Bearer access-1"]);

    // The JWT Google gets: the account's, for FCM, verifiable with the account's public key.
    const form = new URLSearchParams(String(google.tokenCalls[0]?.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header = "", claims = "", signature = ""] = (form.get("assertion") ?? "").split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({
      iss: account.clientEmail,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URL,
    });
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      new Uint8Array(Buffer.from(signature, "base64url")),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  test("a new access token before the old one runs out", async () => {
    let now = 1_000_000;
    const google = fakeGoogle();
    const sender = createFcmPushSender({ serviceAccount: account, fetch: google.http, now: () => now });
    await sender.send([msg("tok-1")]);
    now += 56 * 60_000;
    await sender.send([msg("tok-2")]);
    expect(google.tokenCalls).toHaveLength(2);
    expect(new Headers(google.calls[1]?.init.headers).get("authorization")).toBe("Bearer access-2");
  });

  test("a 401 gets one new token and one more try", async () => {
    const google = fakeGoogle((_, bearer) => {
      if (bearer === "Bearer access-1") return Response.json({ error: { code: 401 } }, { status: 401 });
      return Response.json({});
    });
    const sender = createFcmPushSender({ serviceAccount: account, fetch: google.http });
    expect(await sender.send([msg("tok-1")])).toEqual([{ token: "tok-1", ok: true, unregistered: false }]);
    expect(google.tokenCalls).toHaveLength(2);
    expect(google.calls).toHaveLength(2);
  });

  test("answers per message: gone, retryable, or the network down", async () => {
    const google = fakeGoogle((token) => {
      if (token === "gone")
        return Response.json({ error: { details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 });
      if (token === "busy") return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
      if (token === "offline") throw new TypeError("fetch failed");
      return Response.json({});
    });
    const sender = createFcmPushSender({ serviceAccount: account, fetch: google.http });
    const results = await sender.send([msg("ok"), msg("gone"), msg("busy"), msg("offline")]);
    expect(results.map((r) => [r.token, r.ok, r.unregistered, r.retryable])).toEqual([
      ["ok", true, false, undefined],
      ["gone", false, true, undefined],
      ["busy", false, false, true],
      ["offline", false, false, true],
    ]);
  });

  test("Google refusing the account is final; its token endpoint down retries", async () => {
    const refusing = (status: number) =>
      (async (url: string) => {
        if (url === GOOGLE_TOKEN_URL) return Response.json({ error: "invalid_grant" }, { status });
        return Response.json({});
      }) as unknown as typeof fetch;
    const refused = await createFcmPushSender({ serviceAccount: account, fetch: refusing(400) }).send([msg("t")]);
    expect(refused[0]).toMatchObject({ ok: false, unregistered: false, retryable: false });
    expect(refused[0]?.error).toContain("invalid_grant");
    const down = await createFcmPushSender({ serviceAccount: account, fetch: refusing(503) }).send([msg("t")]);
    expect(down[0]).toMatchObject({ ok: false, unregistered: false, retryable: true });
  });

  test("a key that isn't one never reaches Google", async () => {
    const google = fakeGoogle();
    const sender = createFcmPushSender({
      serviceAccount: {
        ...account,
        privateKey: "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----",
      },
      fetch: google.http,
    });
    expect((await sender.send([msg("t")]))[0]).toMatchObject({ ok: false, retryable: false });
    expect(google.tokenCalls).toHaveLength(0);
  });
});
