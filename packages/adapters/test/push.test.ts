import { describe, expect, test } from "bun:test";
import {
  createExpoPushSender,
  createFakePushSender,
  createPhonePushSender,
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_URL,
  PushError,
  type PushMessage,
  type PushSender,
} from "../src";

const msg = (n: number): PushMessage => ({
  to: `ExponentPushToken[t${n}]`,
  platform: "ios",
  title: "Oi",
  body: "Tudo certo?",
  data: { orgId: "o", kind: "mention", notificationId: `n${n}` },
});

const ticketFor = (to: string) => {
  if (to === "ExponentPushToken[t3]")
    return { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } };
  if (to === "ExponentPushToken[t4]")
    return { status: "error", message: "too big", details: { error: "MessageTooBig" } };
  return { status: "ok", id: "x" };
};

describe("Expo push sender", () => {
  test("posts batches of at most 100 and maps tickets; DeviceNotRegistered marks the token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sender = createExpoPushSender({
      accessToken: "expo_test",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const batch = JSON.parse(String(init.body)) as { to: string }[];
        return Response.json({ data: batch.map((m) => ticketFor(m.to)) });
      }) as unknown as typeof fetch,
    });
    const messages = Array.from({ length: 150 }, (_, i) => msg(i));
    const results = await sender.send(messages);
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe(EXPO_PUSH_URL);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer expo_test");
    expect((JSON.parse(String(calls[0]?.init.body)) as unknown[]).length).toBe(100);
    expect((JSON.parse(String(calls[1]?.init.body)) as unknown[]).length).toBe(50);
    expect(JSON.parse(String(calls[0]?.init.body))[0]).toEqual({
      to: "ExponentPushToken[t0]",
      title: "Oi",
      body: "Tudo certo?",
      data: { orgId: "o", kind: "mention", notificationId: "n0" },
      sound: "default",
      priority: "default",
    });
    expect(results.length).toBe(150);
    expect(results[0]).toEqual({ token: "ExponentPushToken[t0]", ok: true, unregistered: false, ticketId: "x" });
    expect(results[3]).toMatchObject({ ok: false, unregistered: true });
    expect(results[4]).toMatchObject({ ok: false, unregistered: false, error: "too big" });
  });

  test("no access token: no authorization header", async () => {
    let auth: string | null = "unset";
    const sender = createExpoPushSender({
      fetch: (async (_url: string, init: RequestInit) => {
        auth = new Headers(init.headers).get("authorization");
        return Response.json({ data: [{ status: "ok" }] });
      }) as unknown as typeof fetch,
    });
    await sender.send([msg(1)]);
    expect(auth).toBeNull();
  });

  test("429 and 5xx retry; other refusals don't", async () => {
    const failing = (status: number) => {
      const refuse = async () => Response.json({ errors: [{ code: "X", message: "nope" }] }, { status });
      return createExpoPushSender({ fetch: refuse as unknown as typeof fetch });
    };
    const retryable = async (status: number) => {
      try {
        await failing(status).send([msg(1)]);
        return "sent";
      } catch (error) {
        expect(error).toBeInstanceOf(PushError);
        return (error as PushError).retryable;
      }
    };
    expect(await retryable(429)).toBe(true);
    expect(await retryable(503)).toBe(true);
    expect(await retryable(400)).toBe(false);
  });
});

describe("Expo push receipts", () => {
  test("asks in batches of 1000; DeviceNotRegistered marks unregistered; missing receipts are left out", async () => {
    const calls: { url: string; ids: string[] }[] = [];
    const sender = createExpoPushSender({
      fetch: (async (url: string, init: RequestInit) => {
        const { ids } = JSON.parse(String(init.body)) as { ids: string[] };
        calls.push({ url, ids });
        const data: Record<string, unknown> = {};
        for (const id of ids) {
          if (id === "gone") data[id] = { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } };
          else if (id === "big")
            data[id] = { status: "error", message: "too big", details: { error: "MessageTooBig" } };
          else if (id !== "pending") data[id] = { status: "ok" };
        }
        return Response.json({ data });
      }) as unknown as typeof fetch,
    });
    const ids = [...Array.from({ length: 1000 }, (_, i) => `t${i}`), "gone", "big", "pending"];
    const receipts = await sender.receipts?.(ids);
    expect(calls.map((c) => [c.url, c.ids.length])).toEqual([
      [EXPO_RECEIPTS_URL, 1000],
      [EXPO_RECEIPTS_URL, 3],
    ]);
    expect(receipts?.length).toBe(1002);
    expect(receipts?.find((r) => r.ticketId === "gone")).toEqual({
      ticketId: "gone",
      ok: false,
      unregistered: true,
      error: "gone",
    });
    expect(receipts?.find((r) => r.ticketId === "big")).toMatchObject({ ok: false, unregistered: false });
    expect(receipts?.some((r) => r.ticketId === "pending")).toBe(false);
  });

  test("a refused receipts request throws; 5xx retries", async () => {
    const sender = createExpoPushSender({
      fetch: (async () => Response.json({ errors: [{ message: "down" }] }, { status: 503 })) as unknown as typeof fetch,
    });
    const error = await sender.receipts?.(["a"]).catch((e) => e);
    expect(error).toBeInstanceOf(PushError);
    expect((error as PushError).retryable).toBe(true);
  });
});

describe("fake push sender", () => {
  test("tickets of accepted messages; goneLater tokens come back unregistered in receipts", async () => {
    const fake = createFakePushSender({ goneLater: ["ExponentPushToken[t2]"] });
    const results = await fake.send([msg(1), msg(2)]);
    const ids = results.map((r) => r.ticketId ?? "");
    expect(ids.every(Boolean)).toBe(true);
    const receipts = await fake.receipts(ids);
    expect(receipts.map((r) => r.unregistered)).toEqual([false, true]);
  });

  test("records messages and reports unregistered tokens", async () => {
    const fake = createFakePushSender({ unregistered: ["ExponentPushToken[t2]"] });
    const results = await fake.send([msg(1), msg(2)]);
    expect(fake.sent.map((m) => m.to)).toEqual(["ExponentPushToken[t1]"]);
    expect(results.map((r) => r.unregistered)).toEqual([false, true]);
  });
});

describe("phone push sender", () => {
  const android = (n: number): PushMessage => ({ ...msg(n), to: `fcm-token-${n}`, platform: "android" });

  test("each message goes to its platform's sender, results in order; receipts are the iPhone's", async () => {
    const fcm = createFakePushSender({ unregistered: ["fcm-token-3"] });
    const expo = createFakePushSender();
    const phones = createPhonePushSender({ android: fcm, ios: expo });
    const results = await phones.send([android(1), msg(2), android(3), msg(4)]);
    expect(results.map((r) => [r.token, r.ok, r.unregistered])).toEqual([
      ["fcm-token-1", true, false],
      ["ExponentPushToken[t2]", true, false],
      ["fcm-token-3", false, true],
      ["ExponentPushToken[t4]", true, false],
    ]);
    expect(fcm.sent.map((m) => m.to)).toEqual(["fcm-token-1"]);
    expect(expo.sent.map((m) => m.to)).toEqual(["ExponentPushToken[t2]", "ExponentPushToken[t4]"]);
    const ticket = results[1]?.ticketId ?? "";
    expect(await phones.receipts?.([ticket])).toEqual([{ ticketId: ticket, ok: true, unregistered: false }]);
  });

  test("a platform without a sender: skipped, the device kept; the other still sends", async () => {
    const expo = createFakePushSender();
    const phones = createPhonePushSender({ android: null, ios: expo });
    const results = await phones.send([android(1), msg(2)]);
    expect(results[0]).toMatchObject({ token: "fcm-token-1", ok: false, unregistered: false, skipped: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(createPhonePushSender({ android: createFakePushSender() }).receipts).toBeUndefined();
  });

  test("one platform failing as a whole never stops the other; only nothing sent throws", async () => {
    const down: PushSender = {
      id: "down",
      send: async () => {
        throw new PushError("push relay refused the request (403)", false, 403);
      },
    };
    const expo = createFakePushSender();
    const phones = createPhonePushSender({ android: down, ios: expo });
    const results = await phones.send([android(1), msg(2)]);
    expect(results[0]).toMatchObject({ token: "fcm-token-1", ok: false, unregistered: false, retryable: false });
    expect(results[1]).toMatchObject({ token: "ExponentPushToken[t2]", ok: true });
    expect(expo.sent.map((m) => m.to)).toEqual(["ExponentPushToken[t2]"]);
    await expect(phones.send([android(1)])).rejects.toMatchObject({ retryable: false, status: 403 });
  });

  test("the fake's failing tokens come back retryable", async () => {
    const fake = createFakePushSender({ failing: ["fcm-token-1"] });
    expect(await fake.send([android(1)])).toEqual([
      { token: "fcm-token-1", ok: false, unregistered: false, retryable: true, error: "unavailable" },
    ]);
    expect(fake.sent).toEqual([]);
  });
});
