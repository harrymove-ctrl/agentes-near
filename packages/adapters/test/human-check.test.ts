import { expect, test } from "bun:test";
import { createTurnstileCheck, TURNSTILE_SCRIPT_URL, TURNSTILE_VERIFY_URL } from "../src/human-check";

/** Cloudflare's public test keys. */
const SITE_KEY = "1x00000000000000000000AA";
const SECRET = "1x0000000000000000000000000000000AA";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** What Cloudflare's test secrets answer (probed 2026-10-26): any host, no action. */
const TESTING = { success: true, hostname: "example.com", metadata: { result_with_testing_key: true } };
const json = (body: unknown, status = 200) => Response.json(body, { status });

type Answer = (body: Record<string, unknown>) => Response | Promise<Response>;

/** A fake Cloudflare: siteverify answers with `answer`, and the widget's script loads unless `script` says otherwise. */
function cloudflare(answer: Answer, script: () => Response | Promise<Response> = () => new Response("/* api.js */")) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === TURNSTILE_SCRIPT_URL) {
      calls.push({ url });
      return script();
    }
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, body });
    return answer(body);
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls, verifies: () => calls.filter((c) => c.url === TURNSTILE_VERIFY_URL) };
}

function setup(answer: Answer, script?: () => Response | Promise<Response>) {
  const cf = cloudflare(answer, script);
  let at = Date.parse("2026-10-27T12:00:00Z");
  const logs: { message: string; data?: Record<string, unknown> }[] = [];
  const check = createTurnstileCheck({
    siteKey: SITE_KEY,
    secretKey: SECRET,
    hostnames: ["agentes.chat"],
    fetch: cf.fetch,
    now: () => at,
    log: { error: (message, data) => logs.push({ message, data }) },
  });
  return { check, cf, logs, advance: (ms: number) => (at += ms), now: () => at };
}

test("no token, an empty one or one longer than Cloudflare's 2048 characters: refused without asking Cloudflare", async () => {
  const { check, cf } = setup(() => json(TESTING));
  expect(check.siteKey).toBe(SITE_KEY);
  for (const token of [undefined, null, "", "x".repeat(2049)]) {
    expect(await check.verify(token, "sign-in", "203.0.113.7")).toBe("human_check");
  }
  expect(cf.calls).toEqual([]);
});

test("Cloudflare's test keys pass on any host; a real answer passes only for its own action on our host", async () => {
  let answer: Record<string, unknown> = TESTING;
  const { check, cf } = setup(() => json(answer));
  expect(await check.verify(TOKEN, "sign-in", "203.0.113.7")).toBeNull();
  // The token, the secret and the visitor's address go to Cloudflare; an address we don't know doesn't.
  expect(cf.verifies()[0]?.body).toMatchObject({ secret: SECRET, response: TOKEN, remoteip: "203.0.113.7" });
  await check.verify(TOKEN, "sign-in", "unknown");
  expect(cf.verifies()[1]?.body).not.toHaveProperty("remoteip");

  answer = { success: true, hostname: "agentes.chat", action: "sign-up" };
  expect(await check.verify(TOKEN, "sign-up", "203.0.113.7")).toBeNull();
  expect(await check.verify(TOKEN, "sign-in", "203.0.113.7")).toBe("human_check");
  answer = { success: true, hostname: "agentes.chat.evil.example", action: "sign-up" };
  expect(await check.verify(TOKEN, "sign-up", "203.0.113.7")).toBe("human_check");
  // Three tokens passed. The last answers carry no test secret's mark, so `testing` is off.
  expect(check.status()).toMatchObject({ state: "ok", passed: 3, testing: false });
});

test("a token Cloudflare refuses (wrong, expired or already spent): human_check", async () => {
  for (const code of ["invalid-input-response", "timeout-or-duplicate", "missing-input-response", "bad-request"]) {
    const { check, logs } = setup(() => json({ success: false, "error-codes": [code] }));
    expect(await check.verify(TOKEN, "waitlist", "203.0.113.7")).toBe("human_check");
    expect(logs).toEqual([]);
  }
});

test("one retry with the same idempotency key; still no answer lets the request through, logged without the token or the secret", async () => {
  let failures = 1;
  const { check, cf, logs } = setup(() => {
    if (failures-- > 0) throw new Error("timed out");
    return json(TESTING);
  });
  expect(await check.verify(TOKEN, "ask-code", "203.0.113.7")).toBeNull();
  const [first, second] = cf.verifies();
  expect(first?.body?.idempotency_key).toBe(second?.body?.idempotency_key ?? "");
  expect(logs).toEqual([]);

  for (const answer of [
    () => {
      throw new Error("timed out");
    },
    () => json({}, 502),
    () => json({ success: false, "error-codes": ["internal-error"] }),
  ]) {
    const down = setup(answer);
    expect(await down.check.verify(TOKEN, "ask-code", "203.0.113.7")).toBeNull();
    expect(down.cf.verifies().length).toBe(2);
    expect(down.check.status().state).toBe("unreachable");
    expect(down.logs).toEqual([
      { message: "bot check unavailable, request let through", data: { reason: "unreachable", action: "ask-code" } },
    ]);
    expect(JSON.stringify(down.logs)).not.toContain(TOKEN);
    expect(JSON.stringify(down.logs)).not.toContain(SECRET);
  }
});

test("a secret Cloudflare refuses while running lets requests through and says secret_refused", async () => {
  const { check, logs } = setup(() => json({ success: false, "error-codes": ["invalid-input-secret"] }));
  expect(await check.verify(TOKEN, "sign-in", "203.0.113.7")).toBeNull();
  expect(check.status().state).toBe("secret_refused");
  expect(logs.map((l) => l.data?.reason)).toEqual(["secret_refused"]);
});

test("a page that couldn't make a token: blocked while Cloudflare answers us, through while it doesn't", async () => {
  let up = true;
  const { check, cf, logs, advance } = setup(
    () => json({ success: false, "error-codes": ["invalid-input-response"] }),
    () => (up ? new Response("/* api.js */") : new Response("", { status: 503 })),
  );
  expect(await check.verify("unavailable", "sign-in", "203.0.113.7")).toBe("human_check_blocked");
  expect(await check.verify("unavailable:300010", "sign-in", "203.0.113.7")).toBe("human_check_blocked");
  // One probe for both: the dummy token to siteverify, and the widget's script.
  expect(cf.calls.map((c) => [c.url, c.body?.response])).toEqual([
    [TURNSTILE_VERIFY_URL, TOKEN],
    [TURNSTILE_SCRIPT_URL, undefined],
  ]);
  expect(check.status()).toMatchObject({ state: "ok", blocked: 1, passed: 0 });
  expect(logs).toEqual([]);

  // The widget's script stops loading from here too: a minute after the last probe, Cloudflare is asked again.
  up = false;
  advance(59_000);
  expect(await check.verify("unavailable", "sign-in", "198.51.100.9")).toBe("human_check_blocked");
  advance(1_000);
  expect(await check.verify("unavailable", "sign-in", "203.0.113.8")).toBeNull();
  expect(check.status()).toMatchObject({ state: "unreachable", blocked: 2 });
  expect(logs.map((l) => l.data)).toEqual([{ reason: "unreachable", action: "sign-in" }]);

  // Counted for 10 minutes after each network's last refusal.
  advance(9 * 60_000);
  expect(check.status().blocked).toBe(1);
  advance(60_000);
  expect(check.status().blocked).toBe(0);
});

test("blocked counts networks, an IPv6 one by its /64, so one client claiming its page couldn't load the check counts once", async () => {
  const { check, advance } = setup(() => json({ success: false, "error-codes": ["invalid-input-response"] }));
  for (let i = 1; i <= 30; i++) {
    expect(await check.verify("unavailable", "email-lookup", "203.0.113.7")).toBe("human_check_blocked");
    expect(await check.verify("unavailable", "sign-in", `2001:db8:1:2::${i.toString(16)}`)).toBe("human_check_blocked");
  }
  expect(check.status().blocked).toBe(2);
  expect(await check.verify("unavailable", "sign-in", "2001:db8:1:3::1")).toBe("human_check_blocked");
  expect(check.status().blocked).toBe(3);
  // A network asking again stays counted 10 minutes from then.
  advance(9 * 60_000);
  expect(await check.verify("unavailable", "sign-in", "203.0.113.7")).toBe("human_check_blocked");
  advance(60_000);
  expect(check.status().blocked).toBe(1);
});

test("a site key Turnstile refuses shows as pages' unavailable codes, logged at most once a minute", async () => {
  const { check, logs, advance } = setup(() => json({ success: false, "error-codes": ["invalid-input-response"] }));
  for (const code of ["110100", "400020", "110200"]) {
    expect(await check.verify(`unavailable:${code}`, "waitlist", "203.0.113.7")).toBe("human_check_blocked");
  }
  expect(logs.map((l) => l.data?.code)).toEqual(["110100"]);
  expect(logs[0]?.message).toContain("TURNSTILE_SITE_KEY");
  advance(60_000);
  expect(await check.verify("unavailable:110200", "waitlist", "203.0.113.7")).toBe("human_check_blocked");
  expect(logs.map((l) => l.data?.code)).toEqual(["110100", "110200"]);
});

test("the probe: a real secret refuses the dummy token, a wrong one is refused itself; since moves only with the state", async () => {
  let answer: Answer = () => json({ success: false, "error-codes": ["invalid-input-response"] });
  const { check, advance, now } = setup((body) => answer(body));
  const started = check.status().since;
  expect(await check.probe()).toBe("ok");
  expect(check.status().since).toEqual(started);

  advance(5_000);
  answer = () => json({ success: false, "error-codes": ["invalid-input-secret"] });
  expect(await check.probe()).toBe("secret_refused");
  expect(check.status().since).toEqual(new Date(now()));
  advance(5_000);
  answer = () => json({ success: false, "error-codes": ["missing-input-secret"] });
  expect(await check.probe()).toBe("secret_refused");
  expect(check.status().since).toEqual(new Date(now() - 5_000));

  // One of Cloudflare's test secrets passes even the dummy token: ok, and said so.
  expect(check.status().testing).toBe(false);
  answer = () => json(TESTING);
  expect(await check.probe()).toBe("ok");
  expect(check.status().testing).toBe(true);
});

test("while Cloudflare fails, reading the status asks again once a minute, and follows its return", async () => {
  let down = true;
  const { check, cf, advance } = setup(() => {
    if (down) throw new Error("unreachable");
    return json({ success: false, "error-codes": ["invalid-input-response"] });
  });
  expect(await check.probe()).toBe("unreachable");
  const probes = () => cf.calls.filter((c) => c.url === TURNSTILE_SCRIPT_URL).length;
  expect(check.status().state).toBe("unreachable");
  expect(probes()).toBe(1);

  down = false;
  advance(60_000);
  expect(check.status().state).toBe("unreachable");
  await Bun.sleep(0);
  expect(probes()).toBe(2);
  expect(check.status().state).toBe("ok");
});
