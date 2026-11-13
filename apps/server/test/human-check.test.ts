import { afterEach, expect, test } from "bun:test";
import { createTurnstileCheck, TURNSTILE_SCRIPT_URL } from "@agenteschat/adapters";
import { ConfigError } from "@agenteschat/config";
import { checkHumanCheckAtBoot } from "../src/http/human-check";
import { createLogger } from "../src/logger";
import { type Browser, browser, createTestServer, seedOrg, type TestServer } from "./harness";

/** What Cloudflare's test site keys hand out, and its test secret passes. */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/**
 * Cloudflare as its test secret answers: the dummy token passes on any host, anything else is refused. Without
 * `testSecret`, as a real secret answers the dummy token: refused.
 */
function cloudflare() {
  const state = { up: true, secretRefused: false, testSecret: true };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!state.up) throw new Error("connect ECONNREFUSED");
    if (String(input) === TURNSTILE_SCRIPT_URL) return new Response("/* api.js */");
    const { response } = JSON.parse(String(init?.body)) as { response: string };
    if (state.secretRefused) return Response.json({ success: false, "error-codes": ["invalid-input-secret"] });
    return Response.json(
      response === TOKEN && state.testSecret
        ? { success: true, hostname: "example.com", metadata: { result_with_testing_key: true } }
        : { success: false, "error-codes": ["invalid-input-response"] },
    );
  }) as typeof globalThis.fetch;
  return { state, fetch: fakeFetch };
}

const turnstile = (fetch: typeof globalThis.fetch) =>
  createTurnstileCheck({
    siteKey: "1x00000000000000000000AA",
    secretKey: "1x0000000000000000000000000000000AA",
    hostnames: ["localhost"],
    fetch,
  });

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

const codeOf = async (res: Response) => {
  const body = (await res.json()) as { code?: string; error?: { code: string } };
  return body.error?.code ?? body.code;
};
const passing = { "x-captcha-response": TOKEN };
const signUpPassing = (b: Browser, email: string) =>
  b("/api/auth/sign-up/email", {
    json: { email, password: "correct horse battery", name: email.split("@")[0] },
    headers: passing,
  });

/** The six guarded calls, each from a fresh browser, with `headers`. */
async function sixCalls(token: string, headers: Record<string, string>) {
  const call = (path: string, json: unknown) => browser(t)(path, { json, headers });
  return {
    "email-lookup": await call("/api/app/sign-in-options", { email: "owner@example.com" }),
    "sign-in": await call("/api/auth/sign-in/email", { email: "owner@example.com", password: "correct horse battery" }),
    "sign-up": await call("/api/auth/sign-up/email", {
      email: "new@example.com",
      password: "correct horse battery",
      name: "New",
    }),
    "password-reset": await call("/api/auth/request-password-reset", {
      email: "owner@example.com",
      redirectTo: "/reset-password",
    }),
    "ask-code": await call(`/api/app/invitations/${token}/code`, { email: "ana@example.com" }),
    waitlist: await call("/api/waitlist", { email: "ana@example.com" }),
  };
}
const statuses = (calls: Record<string, Response>) =>
  Object.fromEntries(Object.entries(calls).map(([action, res]) => [action, res.status]));
const THROUGH = {
  "email-lookup": 200,
  "sign-in": 200,
  "sign-up": 200,
  "password-reset": 200,
  "ask-code": 202,
  waitlist: 202,
};

/** An owner with a workspace and its invitation link, on a server with `check` (none: no keys). */
async function start(check?: ReturnType<typeof turnstile>) {
  t = await createTestServer({
    env: { LANDING_URL: "https://agentes.example", ALLOW_SIGNUP: "true" },
    humanCheck: check,
  });
  const owner = browser(t);
  expect((await signUpPassing(owner, "owner@example.com")).status).toBe(200);
  const { orgId } = await seedOrg(owner);
  const link = (await (await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} })).json()) as {
    url: string;
  };
  return { owner, token: link.url.split("/invite/")[1] ?? "" };
}

test("without the keys: no site key for pages, and every form works without a token", async () => {
  const { token } = await start();
  expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({ turnstileSiteKey: null });
  expect(statuses(await sixCalls(token, {}))).toEqual(THROUGH);
});

test("with the keys: each of the six forms needs a token Cloudflare passes, and nothing else changes", async () => {
  const { token } = await start(turnstile(cloudflare().fetch));
  expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
    turnstileSiteKey: "1x00000000000000000000AA",
  });

  for (const headers of [{}, { "x-captcha-response": "a-made-up-token" }] as Record<string, string>[]) {
    for (const [action, res] of Object.entries(await sixCalls(token, headers))) {
      expect({ action, status: res.status, code: await codeOf(res) }).toEqual({
        action,
        status: 403,
        code: "human_check",
      });
    }
  }
  // Nothing went through: no email, no code, no place on the list.
  await t.drain();
  expect(t.email.sent.filter((m) => m.to.includes("ana@example.com"))).toEqual([]);

  expect(statuses(await sixCalls(token, passing))).toEqual(THROUGH);
});

test("sign-up's refusal by the check says so by its code, not as a closed sign-up", async () => {
  t = await createTestServer({ humanCheck: turnstile(cloudflare().fetch) });
  // The first account; then sign-up is closed (ALLOW_SIGNUP off).
  expect((await signUpPassing(browser(t), "owner@example.com")).status).toBe(200);
  const res = await browser(t)("/api/auth/sign-up/email", {
    json: { email: "stranger@example.com", password: "correct horse battery", name: "S" },
  });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { code: string; message: string };
  expect(body.code).toBe("human_check");
  expect(body.message).not.toContain("Sign-up is closed");
});

test("a page that couldn't make a token: blocked while Cloudflare answers this server, through while it doesn't", async () => {
  const cf = cloudflare();
  const { token } = await start(turnstile(cf.fetch));
  const ask = (headers: Record<string, string>) =>
    browser(t)(`/api/app/invitations/${token}/code`, { json: { email: "ana@example.com" }, headers });

  const blocked = await ask({ "x-captcha-response": "unavailable:300010" });
  expect(blocked.status).toBe(403);
  expect(await blocked.json()).toEqual({
    error: { code: "human_check_blocked", message: "The bot check didn't load. Try another browser or network." },
  });
  expect(t.adapters.humanCheck?.status()).toMatchObject({ state: "ok", blocked: 1 });
  // Counted once per network: two addresses of one IPv6 /64, asking twice each, are one more.
  for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2::1", "2001:db8:1:2::2"]) {
    expect((await ask({ "x-captcha-response": "unavailable", "x-forwarded-for": ip })).status).toBe(403);
  }
  expect(t.adapters.humanCheck?.status()).toMatchObject({ state: "ok", blocked: 2 });

  // Cloudflare goes down for this server too (probed now rather than a minute later).
  cf.state.up = false;
  expect(await t.adapters.humanCheck?.probe()).toBe("unreachable");
  expect((await ask({ "x-captcha-response": "unavailable" })).status).toBe(202);
  // A real token goes through as well: nobody is locked out by Cloudflare's outage (here the code just went out).
  expect(await codeOf(await ask(passing))).toBe("join.code_wait");
});

test("at boot, a secret Cloudflare refuses stops the server; Cloudflare out of reach doesn't, nor a test secret, which warns", async () => {
  const lines: string[] = [];
  const log = {
    ...createLogger("error"),
    error: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    info: (m: string) => lines.push(m),
  };
  await expect(checkHumanCheckAtBoot(null, log)).resolves.toBeUndefined();
  expect(lines).toEqual([]);

  const cf = cloudflare();
  cf.state.secretRefused = true;
  const refused = checkHumanCheckAtBoot(turnstile(cf.fetch), log);
  await expect(refused).rejects.toBeInstanceOf(ConfigError);
  await expect(refused).rejects.toThrow(/TURNSTILE_SECRET_KEY/);

  cf.state.secretRefused = false;
  cf.state.up = false;
  await expect(checkHumanCheckAtBoot(turnstile(cf.fetch), log)).resolves.toBeUndefined();
  expect(lines.at(-1)).toContain("Cloudflare can't be reached");
  cf.state.up = true;
  // Cloudflare's always-passing test secret takes even the dummy token.
  await checkHumanCheckAtBoot(turnstile(cf.fetch), log);
  expect(lines.at(-1)).toContain("TURNSTILE_SECRET_KEY is one of Cloudflare's test secrets. They refuse real tokens");
  cf.state.testSecret = false;
  await checkHumanCheckAtBoot(turnstile(cf.fetch), log);
  expect(lines.at(-1)).toContain("bot check on");
});

test("refused bots don't spend a link's codes: a person asking through it still gets one", async () => {
  const { token } = await start(turnstile(cloudflare().fetch));
  const ask = (ip: string, headers: Record<string, string> = {}) =>
    browser(t)(`/api/app/invitations/${token}/code`, {
      json: { email: `${ip}@example.com` },
      headers: { "x-forwarded-for": ip, ...headers },
    });
  // As many tokenless asks as the link allows in an hour, from 4 addresses within their own limit.
  for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"]) {
    for (let i = 0; i < 10; i++) expect(await codeOf(await ask(ip))).toBe("human_check");
  }
  expect((await ask("203.0.113.50", passing)).status).toBe(202);
});

test("an IPv6 network is one address for the limits: its /64 shares one count", async () => {
  const { owner } = await start();
  const lookup = (ip: string) =>
    owner("/api/app/sign-in-options", { json: { email: "owner@example.com" }, headers: { "x-forwarded-for": ip } });
  for (let i = 1; i <= 30; i++) expect((await lookup(`2001:db8:1:2::${i.toString(16)}`)).status).toBe(200);
  expect((await lookup("2001:db8:1:2:ffff:ffff:ffff:ffff")).status).toBe(429);
  expect((await lookup("2001:db8:1:3::1")).status).toBe(200);
});
