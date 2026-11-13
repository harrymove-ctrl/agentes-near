import { describe, expect, test } from "bun:test";
import { sql } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import type { Event } from "@sentry/core";
import { createErrorReporter, noErrorReports } from "../src/error-reports";
import { scrubBreadcrumb, scrubEvent, scrubText, urlPattern } from "../src/error-scrub";

const ORG_ID = "0b0e5b55-7e6c-4b51-9c3c-2f1d8f5a7c01";
/** Shaped like a person's id from Better Auth: 32 letters and digits. */
const USER_ID = "notarealuseridnotarealuserid0001";
const DSN = "https://public@example.invalid/1";
/** What must never leave in a report. */
const PRIVATE = [
  "ana@example.com",
  "Ana Souza",
  "sk-ant-api03-notarealkeynotarealkey",
  "Bearer notarealtoken123",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJlbm90cmVhbA",
  "session_token=abc",
  "203.0.113.9",
  "the message she wrote",
  "invitetokennotarealinvitetoken0",
];

describe("scrubbing (ADR 0104)", () => {
  test("an event with an email, a token, a cookie and a body comes out with none of them, its ids and route kept", () => {
    const event: Event = {
      message: "failed for ana@example.com",
      exception: {
        values: [
          {
            type: "Error",
            value:
              "refused Bearer notarealtoken123 for ana@example.com (sk-ant-api03-notarealkeynotarealkey, eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJlbm90cmVhbA) from 203.0.113.9",
            stacktrace: { frames: [{ filename: "app.js", function: "send", vars: { body: "the message she wrote" } }] },
          },
        ],
      },
      request: {
        method: "POST",
        url: `https://app.example.com/api/app/organizations/${ORG_ID}/invite/invitetokennotarealinvitetoken0?email=ana@example.com`,
        headers: {
          Cookie: "session_token=abc",
          Authorization: "Bearer notarealtoken123",
          "User-Agent": "Mozilla/5.0",
        },
        cookies: { session_token: "abc" },
        data: { text: "the message she wrote" },
        query_string: "email=ana@example.com",
      },
      user: { id: "user-1", email: "ana@example.com", username: "Ana Souza", ip_address: "203.0.113.9" },
      extra: { body: "the message she wrote" },
      server_name: "Ana Souza's MacBook",
      contexts: { response: { status_code: 500, headers: { "set-cookie": "session_token=abc" } } },
      tags: { org_id: ORG_ID, note: "ana@example.com" },
      breadcrumbs: [
        { category: "console", message: "the message she wrote" },
        {
          category: "fetch",
          data: {
            method: "POST",
            url: `/api/app/organizations/${ORG_ID}/messages?q=the message she wrote`,
            status_code: 500,
            body: "the message she wrote",
          },
        },
        { category: "ui.click", message: 'button.send[aria-label="Ana Souza"]' },
      ],
    };
    const clean = scrubEvent(event);
    const text = JSON.stringify(clean);
    for (const value of PRIVATE) expect(text).not.toContain(value);
    expect(clean.user).toEqual({ id: "user-1" });
    expect(clean.request).toEqual({
      method: "POST",
      url: "https://app.example.com/api/app/organizations/:id/invite/:id",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    expect(clean.tags).toEqual({ org_id: ORG_ID, note: "[email]" });
    expect(clean.breadcrumbs).toEqual([
      { category: "fetch", data: { method: "POST", url: "/api/app/organizations/:id/messages", status_code: 500 } },
      { category: "ui.click", message: "button.send", data: {} },
    ]);
  });

  test("breadcrumbs: console lines go, a navigation keeps only its route", () => {
    expect(scrubBreadcrumb({ category: "console", message: "hi" })).toBeNull();
    expect(
      scrubBreadcrumb({ category: "navigation", data: { from: `/org/${ORG_ID}/c/x?draft=1`, to: "/login#t" } }),
    ).toEqual({ category: "navigation", data: { from: "/org/:id/c/x", to: "/login" } });
    expect(urlPattern("https://user:pass@app.example.com/api/x")).toBe("https://app.example.com/api/x");
  });

  test("an IPv6 address in any form is masked, and a name people chose in a path is an id", () => {
    expect(scrubText("from 2001:db8::1, fe80::1%en0 and 2804:14c:5b73:8f00::1a2b at 12:30:45")).toBe(
      "from [ip], [ip] and [ip] at 12:30:45",
    );
    expect(urlPattern(`https://app.example.com/org/${ORG_ID}/wiki/demissao-ana-souza`)).toBe(
      "https://app.example.com/org/:id/wiki/:id",
    );
    expect(urlPattern(`/api/app/organizations/${ORG_ID}/wiki/pages/demissao-ana-souza/history`)).toBe(
      "/api/app/organizations/:id/wiki/pages/:id/history",
    );
    expect(urlPattern(`/api/app/organizations/${ORG_ID}/skills/${ORG_ID}/files/ana-souza.md`)).toBe(
      "/api/app/organizations/:id/skills/:id/files/:id",
    );
  });
});

/** A reporter whose server is a fake `fetch` that keeps every envelope it is sent. */
async function reporterToFakeServer(
  from: { platform?: string; runtime: { name: string } } = { runtime: { name: "bun" } },
) {
  const sent: { url: string; body: string }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const reporter = await createErrorReporter({
    dsn: DSN,
    environment: "staging",
    release: "2026.10.31.4",
    fetch: fake,
    ...from,
  });
  return { reporter, sent };
}

/** The event of an envelope: its third line, after the envelope's header and the item's. */
const eventOf = (body: string) => JSON.parse(body.split("\n")[2] ?? "{}");

describe("the reporter", () => {
  test("without a DSN nothing is reported and the SDK is never loaded", async () => {
    let loaded = false;
    const load = async () => {
      loaded = true;
      return import("@sentry/core");
    };
    expect(await createErrorReporter({ environment: "production", release: "1", runtime: { name: "bun" } }, load)).toBe(
      noErrorReports,
    );
    expect(loaded).toBe(false);
    expect(noErrorReports.capture(new Error("x"))).toBeUndefined();
  });

  test("with one, a report reaches the server scrubbed, with its release, environment and tags", async () => {
    const { reporter, sent } = await reporterToFakeServer();
    const id = reporter.capture(
      new Error("refused Bearer notarealtoken123 for ana@example.com"),
      {
        org_id: ORG_ID,
        user_id: USER_ID,
        route: "/api/app/organizations/:orgId/messages",
        status: 500,
        log: `refused ${"notarealtoken".repeat(3)}`,
        empty: undefined,
      },
      true,
    );
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await reporter.flush(2000)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toStartWith("https://example.invalid/api/1/envelope/");
    const body = sent[0]?.body ?? "";
    for (const value of PRIVATE) expect(body).not.toContain(value);
    const event = eventOf(body);
    expect(event).toMatchObject({
      event_id: id,
      release: "2026.10.31.4",
      environment: "staging",
      platform: "node",
      contexts: { runtime: { name: "bun" } },
      // The ids as they are, a token in free text masked.
      tags: {
        org_id: ORG_ID,
        user_id: USER_ID,
        route: "/api/app/organizations/:orgId/messages",
        status: "500",
        log: "refused [token]",
      },
      exception: {
        values: [{ type: "Error", value: "refused Bearer *** for [email]", mechanism: { handled: false } }],
      },
    });
    expect(event.tags.empty).toBeUndefined();
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  });

  test("the phone app's reports say what runs them, scrubbed the same", async () => {
    const { reporter, sent } = await reporterToFakeServer({ platform: "javascript", runtime: { name: "android" } });
    reporter.capture(new Error("for ana@example.com"), { view: "computer", page_ready: false });
    expect(await reporter.flush(2000)).toBe(true);
    expect(eventOf(sent[0]?.body ?? "")).toMatchObject({
      platform: "javascript",
      contexts: { runtime: { name: "android" } },
      tags: { view: "computer", page_ready: "false" },
      exception: { values: [{ value: "for [email]" }] },
    });
  });

  test("a failed query is reported with its SQL and its cause, never the values it was given", async () => {
    const { db, close } = await createTestDatabase();
    try {
      const failed = await db
        .execute(sql`select ${"Ana Souza"} as name, ${"the message she wrote"} as body, 1 / 0 as broken`)
        .catch((error: unknown) => error);
      // Drizzle's message holds every value of the query: what the scrubber cuts.
      expect(String(failed)).toContain("params: Ana Souza,the message she wrote");
      const { reporter, sent } = await reporterToFakeServer();
      reporter.capture(failed);
      expect(await reporter.flush(2000)).toBe(true);
      const body = sent[0]?.body ?? "";
      for (const value of PRIVATE) expect(body).not.toContain(value);
      expect(eventOf(body).exception.values.map((e: { value: string }) => e.value)).toEqual([
        "division by zero",
        "Failed query: select $1 as name, $2 as body, 1 / 0 as broken\nparams: [removed]",
      ]);
    } finally {
      await close();
    }
    // A fresh database runs every migration first, which passes 5 s on a busy CI runner.
  }, 30_000);
});
