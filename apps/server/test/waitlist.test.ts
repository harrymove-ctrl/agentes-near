import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { enqueueWaitlistContacts, joinWaitlist, WAITLIST_MAX_SENDS } from "@agenteschat/engine";
import { browser, createTestServer, ORIGIN, type TestServer } from "./harness";

/** The landing page's own site. */
const LANDING = "https://agentes.example";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { LANDING_URL: LANDING } });
});
afterEach(() => t.close());

test("without LANDING_URL there is no waiting list", async () => {
  await t.close();
  t = await createTestServer();
  expect((await browser(t)("/api/waitlist", { json: { email: "ana@acme.com" } })).status).toBe(404);
  expect((await browser(t)("/api/waitlist/confirm", { json: { token: "x" } })).status).toBe(404);
});

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/** The token in the link of the latest confirmation email sent. */
function lastToken() {
  const text = t.email.sent.at(-1)?.text ?? "";
  const match = text.match(/\/\?confirm=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error(`no confirmation link in: ${text}`);
  return match[1];
}

test("joining stores the email once, lowercase, with the language; the answer never tells it was there", async () => {
  const anon = browser(t);
  const first = await anon("/api/waitlist", { json: { email: "  Ana@Acme.com ", locale: "en" } });
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ ok: true });
  const again = await anon("/api/waitlist", { json: { email: "ana@acme.com", locale: "pt-BR" } });
  expect(again.status).toBe(202);
  expect(await again.json()).toEqual({ ok: true });

  const rows = await t.db.select().from(schema.waitlistEntries);
  expect(rows.map((r) => [r.email, r.locale, r.source, r.confirmedAt])).toEqual([
    ["ana@acme.com", "en", "landing", null],
  ]);
});

test("joining emails a confirmation link (through the outbox, in their language); the link confirms", async () => {
  const anon = browser(t);
  await anon("/api/waitlist", { json: { email: "ana@acme.com", locale: "en" } });
  expect(t.email.sent).toEqual([]); // never inline in the request
  await t.drain();
  expect(t.email.sent.map((m) => [m.to, m.subject])).toEqual([
    [["ana@acme.com"], "Confirm your spot on the agentes.chat waiting list"],
  ]);
  expect(t.email.sent[0]?.html).toContain('lang="en"');
  expect(t.email.sent[0]?.text).toContain(`${LANDING}/?confirm=`);
  const token = lastToken();
  // Only a hash of the token is stored.
  const [before] = await t.db.select().from(schema.waitlistEntries);
  expect(before?.confirmTokenHash).not.toContain(token);

  const res = await anon("/api/waitlist/confirm", { json: { token } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  const [row] = await t.db.select().from(schema.waitlistEntries);
  expect(row?.confirmedAt).toBeInstanceOf(Date);
  // Opening the link again still works; joining again sends nothing.
  expect((await anon("/api/waitlist/confirm", { json: { token } })).status).toBe(200);
  await anon("/api/waitlist", { json: { email: "ana@acme.com" } });
  await t.drain();
  expect(t.email.sent.length).toBe(1);
  // A MillionSend contact on joining (pending), updated on confirming; joining again adds nothing.
  const joined = row?.createdAt.toISOString() ?? "";
  expect(t.email.contacts).toEqual([
    {
      email: "ana@acme.com",
      properties: { waitlist: "pending", locale: "en", source: "landing", waitlist_joined_at: joined },
    },
    {
      email: "ana@acme.com",
      properties: {
        waitlist: "confirmed",
        locale: "en",
        source: "landing",
        waitlist_joined_at: joined,
        waitlist_confirmed_at: row?.confirmedAt?.toISOString() ?? "",
      },
    },
  ]);
  await enqueueWaitlistContacts(t.db);
  await t.drain();
  expect(t.email.contacts.length).toBe(2);
});

test("a pending job that runs after the confirmation still saves the contact as confirmed", async () => {
  const anon = browser(t);
  await anon("/api/waitlist", { json: { email: "ana@acme.com" } });
  // Confirmed before the outbox ran the join's jobs.
  const [entry] = await t.db.select().from(schema.waitlistEntries);
  await t.db.update(schema.waitlistEntries).set({ confirmedAt: new Date() });
  await t.drain();
  expect(entry?.confirmedAt).toBeNull();
  expect(t.email.contacts.map((c) => c.properties.waitlist)).toEqual(["confirmed"]);
});

test("entries from before the sync are caught up as contacts, each in its status", async () => {
  await t.db.insert(schema.waitlistEntries).values([
    { email: "old@acme.com", confirmedAt: new Date("2026-10-01T12:00:00Z") },
    { email: "pending@acme.com", locale: "en" },
  ]);
  expect(await enqueueWaitlistContacts(t.db)).toBe(2);
  await t.drain();
  expect(
    t.email.contacts
      .map((c) => [c.email, c.properties.waitlist, c.properties.locale])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ).toEqual([
    ["old@acme.com", "confirmed", "en"],
    ["pending@acme.com", "pending", "en"],
  ]);
  expect(await enqueueWaitlistContacts(t.db)).toBe(2);
  await t.drain();
  expect(t.email.contacts.length).toBe(2);
});

test("no locale means English, and the email is in English", async () => {
  expect((await browser(t)("/api/waitlist", { json: { email: "bia@acme.com" } })).status).toBe(202);
  const [row] = await t.db.select().from(schema.waitlistEntries);
  expect(row?.locale).toBe("en");
  await t.drain();
  expect(t.email.sent[0]?.subject).toBe("Confirm your spot on the agentes.chat waiting list");
  expect(t.email.sent[0]?.html).toContain('lang="en"');
});

test("an unknown, malformed or expired link is refused with a stable code", async () => {
  const anon = browser(t);
  for (const token of ["x".repeat(32), "short", "../../etc"]) {
    const res = await anon("/api/waitlist/confirm", { json: { token } });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_token");
  }
  const tooLong = await anon("/api/waitlist/confirm", { json: { token: "x".repeat(65) } });
  expect(await errorCode(tooLong)).toBe("invalid_request");

  await joinWaitlist(t.db, { email: "old@acme.com", publicUrl: ORIGIN }, new Date(Date.now() - 49 * 3600_000));
  await t.drain();
  const expired = await anon("/api/waitlist/confirm", { json: { token: lastToken() } });
  expect(await errorCode(expired)).toBe("invalid_token");
  const [row] = await t.db.select().from(schema.waitlistEntries);
  expect(row?.confirmedAt).toBeNull();
});

test("joining again resends the link at most every 2 minutes and 5 times; only the latest link works", async () => {
  // Relative to now: confirming checks the 48 h link age against the real clock.
  const start = Date.now() - 3600_000;
  const at = (minutes: number) => new Date(start + minutes * 60_000);
  const input = { email: "ana@acme.com", publicUrl: ORIGIN };
  expect(await joinWaitlist(t.db, input, at(0))).toEqual({ sent: true });
  await t.drain();
  const first = lastToken();
  expect(await joinWaitlist(t.db, input, at(1))).toEqual({ sent: false });
  expect(await joinWaitlist(t.db, input, at(3))).toEqual({ sent: true });
  await t.drain();
  const second = lastToken();
  expect(second).not.toBe(first);
  // Drain after each send: the outbox doesn't promise order, and the test reads the latest link.
  for (let i = 3; i <= WAITLIST_MAX_SENDS; i++) {
    expect((await joinWaitlist(t.db, input, at(i * 3))).sent).toBe(true);
    await t.drain();
  }
  expect((await joinWaitlist(t.db, input, at(60))).sent).toBe(false);
  await t.drain();
  expect(t.email.sent.length).toBe(WAITLIST_MAX_SENDS);
  expect(new Set(t.email.sent.map((m) => m.idempotencyKey)).size).toBe(WAITLIST_MAX_SENDS);

  const anon = browser(t);
  expect(await errorCode(await anon("/api/waitlist/confirm", { json: { token: first } }))).toBe("invalid_token");
  expect((await anon("/api/waitlist/confirm", { json: { token: lastToken() } })).status).toBe(200);
});

test("a bad email or body is refused with a stable code", async () => {
  const anon = browser(t);
  const bad = await anon("/api/waitlist", { json: { email: "not-an-email" } });
  expect(bad.status).toBe(400);
  expect(await errorCode(bad)).toBe("invalid_email");
  const wrongLocale = await anon("/api/waitlist", { json: { email: "a@acme.com", locale: "xx" } });
  expect(wrongLocale.status).toBe(400);
  expect(await errorCode(wrongLocale)).toBe("invalid_request");
  const tooLong = await anon("/api/waitlist", { json: { email: `${"a".repeat(250)}@acme.com` } });
  expect(await errorCode(tooLong)).toBe("invalid_request");
  expect(await t.db.select().from(schema.waitlistEntries)).toEqual([]);
  await t.drain();
  expect(t.email.sent).toEqual([]);
});

test("only the landing and our own origin can join or confirm", async () => {
  for (const path of ["/api/waitlist", "/api/waitlist/confirm"]) {
    const json = { email: "a@acme.com", token: "x".repeat(32) };
    const res = await browser(t)(path, { json, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("bad_origin");
    expect((await browser(t)(path, { json, origin: null })).status).toBe(403);
  }
});

test("too many attempts from one address are throttled, keyed by the address our proxy saw", async () => {
  const anon = browser(t);
  const headers = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 10; i++) {
    expect((await anon("/api/waitlist", { json: { email: `p${i}@acme.com` }, headers })).status).toBe(202);
  }
  const limited = await anon("/api/waitlist", { json: { email: "p10@acme.com" }, headers });
  expect(limited.status).toBe(429);
  expect(await errorCode(limited)).toBe("rate_limited");
  // A made-up address put in front by the client doesn't get around it.
  const spoofed = await anon("/api/waitlist", {
    json: { email: "p11@acme.com" },
    headers: { "x-forwarded-for": "10.9.8.7, 203.0.113.7" },
  });
  expect(spoofed.status).toBe(429);
  // A proxy's internal hop is skipped: the client is the last public address.
  const behindProxy = await anon("/api/waitlist", {
    json: { email: "p12@acme.com" },
    headers: { "x-forwarded-for": "203.0.113.7, 100.64.0.2" },
  });
  expect(behindProxy.status).toBe(429);
  const neighbour = await anon("/api/waitlist", {
    json: { email: "r@acme.com" },
    headers: { "x-forwarded-for": "198.51.100.9, 100.64.0.2" },
  });
  expect(neighbour.status).toBe(202);
  // Another address is not affected.
  const other = await anon("/api/waitlist", {
    json: { email: "q@acme.com" },
    headers: { "x-forwarded-for": "198.51.100.2" },
  });
  expect(other.status).toBe(202);
});

test("guessing confirmation links is throttled too", async () => {
  const anon = browser(t);
  const headers = { "x-forwarded-for": "203.0.113.9" };
  for (let i = 0; i < 30; i++) {
    expect((await anon("/api/waitlist/confirm", { json: { token: "x".repeat(32) }, headers })).status).toBe(400);
  }
  const limited = await anon("/api/waitlist/confirm", { json: { token: "x".repeat(32) }, headers });
  expect(limited.status).toBe(429);
});

test("the landing page on its own site joins and confirms through CORS, and the link opens it", async () => {
  const landing = LANDING;
  // The browser's preflight for a JSON POST.
  for (const path of ["/api/waitlist", "/api/waitlist/confirm"]) {
    const preflight = await t.app.request(path, {
      method: "OPTIONS",
      headers: {
        origin: landing,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-captcha-response",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(landing);
    // JSON, and the bot check's token when this server has one; never cookies.
    expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type,x-captcha-response");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
  }
  const anon = browser(t);
  const joined = await anon("/api/waitlist", { json: { email: "ana@acme.com" }, origin: landing });
  expect(joined.status).toBe(202);
  expect(joined.headers.get("access-control-allow-origin")).toBe(landing);
  await t.drain();
  expect(t.email.sent[0]?.text).toContain(`${landing}/?confirm=`);
  const confirmed = await anon("/api/waitlist/confirm", { json: { token: lastToken() }, origin: landing });
  expect(confirmed.status).toBe(200);
  // The app's own origin still works; others are still refused.
  expect((await anon("/api/waitlist", { json: { email: "bia@acme.com" } })).status).toBe(202);
  const evil = await anon("/api/waitlist", { json: { email: "c@acme.com" }, origin: "https://evil.example" });
  expect(evil.status).toBe(403);
});

test("CORS stays off everywhere else, and off entirely without LANDING_URL", async () => {
  const preflight = (path: string, origin: string) =>
    t.app.request(path, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
  const app = await preflight("/api/app/me", LANDING);
  expect(app.headers.get("access-control-allow-origin")).toBeNull();
  await t.close();
  t = await createTestServer();
  const off = await preflight("/api/waitlist", LANDING);
  expect(off.headers.get("access-control-allow-origin")).toBeNull();
});
