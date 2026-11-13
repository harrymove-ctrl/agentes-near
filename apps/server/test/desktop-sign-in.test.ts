import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import { desktopChallenge } from "../src/desktop-sign-in";
import { browser, createTestServer, signUp, type TestServer } from "./harness";

/**
 * The Mac app's window signs in with Google or Apple through the browser (ADR 0036).
 * The hand-over is a device-style exchange: the window opens a request for its
 * challenge and shows a code, the browser confirms that code and hands its fresh
 * sign-in over, and the window redeems it with the verifier it kept. A sign-in only
 * moves to a window the person is actually using, never to one a link chose.
 */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const pair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: desktopChallenge(verifier) };
};
const open = async (b: ReturnType<typeof browser>, challenge: string) =>
  (await (await b("/api/auth/desktop/open", { json: { challenge } })).json()) as { requestId: string; code: string };

test("the window gets its own session once the browser confirms the request, once", async () => {
  t = await createTestServer();
  const site = browser(t);
  const window = browser(t);
  await signUp(site, "ana@acme.com");
  const { verifier, challenge } = pair();

  const { requestId, code } = await open(window, challenge);
  expect(requestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(code).toMatch(CODE);

  // Opened but not yet confirmed: the window keeps asking and gets nothing.
  expect(await (await window("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({ signedIn: false });

  // The signed-in browser confirms the request it was pointed at.
  expect((await site("/api/auth/desktop/handoff", { json: { requestId } })).status).toBe(200);
  // Someone else's verifier still gets nothing.
  expect(await (await window("/api/auth/desktop/redeem", { json: { verifier: pair().verifier } })).json()).toEqual({
    signedIn: false,
  });

  expect(await (await window("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({ signedIn: true });
  const me = (await (await window("/api/app/me")).json()) as { user: { email: string } };
  expect(me.user.email).toBe("ana@acme.com");
  // Its own session: different from the browser's.
  expect(window.cookie()).not.toBe(site.cookie());

  // Single use: a second redeem gets nothing, and the request cannot be confirmed again.
  const again = browser(t);
  expect(await (await again("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({ signedIn: false });
  expect(await (await site("/api/auth/desktop/handoff", { json: { requestId } })).json()).toEqual({ ok: false });
});

test("a handoff without a window-made request is refused and hands nothing over", async () => {
  t = await createTestServer();
  const site = browser(t);
  await signUp(site, "bia@acme.com");
  const { verifier, challenge } = pair();
  // A request id the window never opened (so its challenge is unknown to the server).
  const strangerId = randomBytes(32).toString("base64url");

  expect(await (await site("/api/auth/desktop/handoff", { json: { requestId: strangerId } })).json()).toEqual({
    ok: false,
  });
  // No hand-over was recorded for the challenge, so the window cannot redeem.
  void challenge;
  expect(await (await browser(t)("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({
    signedIn: false,
  });
});

test("a handoff needs a signed-in browser with a fresh sign-in", async () => {
  t = await createTestServer();
  const window = browser(t);
  const { challenge } = pair();
  const { requestId } = await open(window, challenge);

  expect((await browser(t)("/api/auth/desktop/handoff", { json: { requestId } })).status).toBe(401);

  const site = browser(t);
  await signUp(site, "caio@acme.com");
  await t.db.update(schema.sessions).set({ createdAt: new Date(Date.now() - 60 * 60_000) });
  // The cookie cache still has the old copy for a few minutes: a new browser on the same session row.
  const stale = browser(t);
  const token = site
    .cookie()
    .split("; ")
    .find((c) => c.includes("session_token="));
  if (!token) throw new Error("no session cookie");
  const res = await stale("/api/auth/desktop/handoff", { json: { requestId }, headers: { cookie: token } });
  expect(res.status).toBe(403);
  const rows = await t.db
    .select()
    .from(schema.verifications)
    .where(eq(schema.verifications.identifier, `desktop-handoff:${challenge}`));
  expect(rows).toHaveLength(0);
});

test("a revoked browser session cannot hand off through its signed cookie cache", async () => {
  t = await createTestServer();
  const site = browser(t);
  const window = browser(t);
  await signUp(site, "eva@acme.com");
  const { verifier, challenge } = pair();
  const { requestId } = await open(window, challenge);
  const priorCookies = site.cookie();

  expect((await site("/api/auth/sign-out", { json: {} })).status).toBe(200);
  const stale = browser(t);
  const res = await stale("/api/auth/desktop/handoff", {
    json: { requestId },
    headers: { cookie: priorCookies },
  });
  expect(res.status).toBe(401);
  expect(await (await window("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({ signedIn: false });
});

test("a pending handoff cannot be redeemed after its browser session is revoked", async () => {
  t = await createTestServer();
  const site = browser(t);
  const window = browser(t);
  await signUp(site, "fabi@acme.com");
  const { verifier, challenge } = pair();
  const { requestId } = await open(window, challenge);

  expect(await (await site("/api/auth/desktop/handoff", { json: { requestId } })).json()).toEqual({ ok: true });
  expect((await site("/api/auth/sign-out", { json: {} })).status).toBe(200);
  expect(await (await window("/api/auth/desktop/redeem", { json: { verifier } })).json()).toEqual({ signedIn: false });
});

test("the browser only ever sees the code the request was opened with", async () => {
  t = await createTestServer();
  const window = browser(t);
  const { challenge } = pair();
  const { requestId, code } = await open(window, challenge);

  // The code endpoint returns that request's own code, for the person to match.
  const seen = (await (await browser(t)("/api/auth/desktop/request", { json: { requestId } })).json()) as {
    code: string | null;
  };
  expect(seen.code).toBe(code);

  // A different, unopened request id yields no code.
  const otherId = randomBytes(32).toString("base64url");
  expect(await (await browser(t)("/api/auth/desktop/request", { json: { requestId: otherId } })).json()).toEqual({
    code: null,
  });
});

test("only well-formed keys", async () => {
  t = await createTestServer();
  const site = browser(t);
  await signUp(site, "dani@acme.com");
  expect((await site("/api/auth/desktop/open", { json: { challenge: "short" } })).status).toBe(400);
  expect((await site("/api/auth/desktop/handoff", { json: { requestId: "short" } })).status).toBe(400);
  expect((await browser(t)("/api/auth/desktop/redeem", { json: { verifier: "x".repeat(200) } })).status).toBe(400);
});
