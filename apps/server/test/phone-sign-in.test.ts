import { afterEach, describe, expect, test } from "bun:test";
import { like, schema } from "@agenteschat/db";
import { browser, createTestServer, ORIGIN, signUp, type TestServer } from "./harness";

/**
 * "Abrir no celular": the web app mints a one-time sign-in for the QR code; the phone app (ADR 0035: no
 * Origin, `X-Agentes-Client: mobile`, the Expo plugin's `expo-origin`) trades it for a session of its own.
 * And `GET /api/instance`, what the apps check before using a server.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const MOBILE = { "x-agentes-client": "mobile" };

/** The phone trading a token, before it has any cookie. */
const trade = (token: string) =>
  t.app.request("/api/auth/sign-in/one-time-token", {
    method: "POST",
    headers: { ...MOBILE, "expo-origin": "agenteschat://", "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

async function mint(b: ReturnType<typeof browser>) {
  const res = await b("/api/app/phone-sign-in", { json: {} });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; server: string; expiresIn: number };
}

describe("one-time sign-in for the phone", () => {
  test("minted for the signed-in person; the phone gets its own session, once", async () => {
    t = await createTestServer();
    const web = browser(t);
    await signUp(web, "ana@example.com");
    const { token, server, expiresIn } = await mint(web);
    expect(server).toBe(ORIGIN);
    expect(expiresIn).toBeGreaterThan(60);
    expect(expiresIn).toBeLessThanOrEqual(5 * 60);
    const stored = await t.db
      .select()
      .from(schema.verifications)
      .where(like(schema.verifications.identifier, "phone-sign-in:%"));
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);

    const traded = await trade(token);
    expect(traded.status).toBe(200);
    const me = await t.app.request("/api/app/me", { headers: { ...MOBILE, cookie: cookiesOf(traded) } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe("ana@example.com");
    // A session of its own, next to the browser's: signing out on one leaves the other.
    expect(await t.db.select().from(schema.sessions)).toHaveLength(2);

    const again = await trade(token);
    expect(again.status).toBe(401);
    expect(again.headers.getSetCookie()).toHaveLength(0);
  });

  test("an expired code is refused", async () => {
    t = await createTestServer();
    const web = browser(t);
    await signUp(web, "ana@example.com");
    const { token } = await mint(web);
    await t.db.update(schema.verifications).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await trade(token)).status).toBe(401);
  });

  test("signing out on the web voids a code still on screen", async () => {
    t = await createTestServer();
    const web = browser(t);
    await signUp(web, "ana@example.com");
    const { token } = await mint(web);
    expect((await web("/api/auth/sign-out", { json: {} })).status).toBe(200);
    expect((await trade(token)).status).toBe(401);
  });

  test("only a signed-in person mints, and only from our web app", async () => {
    t = await createTestServer();
    expect((await browser(t)("/api/app/phone-sign-in", { json: {} })).status).toBe(401);
    const web = browser(t);
    await signUp(web, "ana@example.com");
    const foreign = await web("/api/app/phone-sign-in", { json: {}, origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
  });

  test("a made-up code is refused", async () => {
    t = await createTestServer();
    expect((await trade("not-a-real-code")).status).toBe(401);
  });

  test("a computer's own server at its own address: no code, since no phone could open it", async () => {
    t = await createTestServer({ env: { INSTALL_MODE: "desktop" } });
    const web = browser(t);
    await signUp(web, "ana@example.com");
    const res = await web("/api/app/phone-sign-in", { json: {} });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("phone.local_only");
    const stored = await t.db
      .select()
      .from(schema.verifications)
      .where(like(schema.verifications.identifier, "phone-sign-in:%"));
    expect(stored).toHaveLength(0);
  });
});

describe("GET /api/instance", () => {
  test("what the apps check, readable by the desktop app's web view", async () => {
    t = await createTestServer({ env: { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" } });
    const first = await t.app.request("/api/instance");
    expect(first.status).toBe(200);
    expect(first.headers.get("access-control-allow-origin")).toBe("*");
    expect(await first.json()).toEqual({
      name: "agentes.chat",
      version: "test",
      api: 1,
      minApi: 1,
      url: ORIGIN,
      sourceUrl: "https://github.com/agentes-chat/agentes-chat",
      signIn: { email: true, google: true, github: false, apple: false },
      // Nobody yet: the first account signs up.
      signup: "open",
      ownerClaim: false,
      cloud: false,
    });
    await signUp(browser(t), "owner@example.com");
    const after = (await (await t.app.request("/api/instance")).json()) as { signup: string };
    expect(after.signup).toBe("invite");
  });

  test("a modified version links its own source", async () => {
    t = await createTestServer({ env: { SOURCE_URL: "https://git.example.com/fork" } });
    expect(await (await t.app.request("/api/instance")).json()).toMatchObject({
      sourceUrl: "https://git.example.com/fork",
    });
  });

  test("agentes.chat's own servers say they are the Cloud", async () => {
    t = await createTestServer({ env: { PUBLIC_URL: "https://app.agentes.chat" } });
    expect(await (await t.app.request("/api/instance")).json()).toMatchObject({
      url: "https://app.agentes.chat",
      cloud: true,
    });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({ cloud: true });
  });
});
