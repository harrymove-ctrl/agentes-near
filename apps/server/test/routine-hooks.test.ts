import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { schema } from "@agenteschat/db";
import { HOOK_LIMIT_PER_IP } from "@agenteschat/engine";
import { systemText } from "@agenteschat/providers";
import { browser, createTestServer, joinByInvitation, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

/** ADR 0106: `POST /api/hooks/{token}`, a webhook routine's own address, and the routes that manage it. */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

type Hook = {
  url: string;
  signed: boolean;
  calls: { outcome: string; status: number; runId: string | null; test: boolean }[];
};

async function webhookRoutine() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Confira o pedido novo.",
      target: { type: "channel", channelId },
      trigger: { type: "webhook" },
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as { id: string; trigger: { type: string; url: string; signed: boolean } };
  return { owner, orgId, api, routine };
}

/** A call from another service: no cookie, no Origin. */
const call = (url: string, body: string, headers: Record<string, string> = {}, method = "POST") =>
  t.app.request(new URL(url).pathname + new URL(url).search, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7", ...headers },
    ...(method === "POST" ? { body } : {}),
  });
const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("its address: POST only, 202 with the run; signed calls with a secret; a new address ends the old one", async () => {
  const { api, routine } = await webhookRoutine();
  expect(routine.trigger).toMatchObject({ type: "webhook", signed: false });
  expect(routine.trigger.url).toMatch(new RegExp(`^${ORIGIN}/api/hooks/[A-Za-z0-9_-]{43}$`));
  const url = routine.trigger.url;

  const get = await call(url, "", {}, "GET");
  expect(get.status).toBe(405);
  expect(get.headers.get("allow")).toBe("POST");

  const body = JSON.stringify({ order: 42, status: "paid" });
  const accepted = await call(url, body, { "x-github-event": "push" });
  expect(accepted.status).toBe(202);
  const { runId } = (await accepted.json()) as { ok: true; runId: string };
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);

  const signedUp = (await (await api(`/routines/${routine.id}/hook/secret`, { json: {} })).json()) as {
    secret: string;
    hook: Hook;
  };
  expect(signedUp.hook).toMatchObject({ url, signed: true });
  const unsigned = await call(url, body);
  expect(unsigned.status).toBe(401);
  expect(await codeOf(unsigned)).toBe("invalid_signature");
  expect((await call(url, body, { "x-agentes-signature": sign(signedUp.secret, body) })).status).toBe(202);
  expect((await call(url, body, { "x-hub-signature-256": sign(signedUp.secret, body) })).status).toBe(202);

  const replaced = (await (await api(`/routines/${routine.id}/hook/address`, { json: {} })).json()) as Hook;
  expect(replaced.url).not.toBe(url);
  const old = await call(url, body, { "x-agentes-signature": sign(signedUp.secret, body) });
  expect(old.status).toBe(404);
  expect(await codeOf(old)).toBe("not_found");
  expect((await call(replaced.url, body, { "x-agentes-signature": sign(signedUp.secret, body) })).status).toBe(202);

  // Its page lists the calls, newest first, each with its run.
  const hook = (await (await api(`/routines/${routine.id}/hook`)).json()) as Hook;
  expect(hook.calls.map((c) => c.outcome)).toEqual(["accepted", "accepted", "accepted", "bad_signature", "accepted"]);
  expect(hook.calls.at(-1)).toMatchObject({ status: 202, runId, test: false });

  // The run goes through the outbox, after the answer.
  await t.drain();
  const runs = (await (await api(`/routines/${routine.id}/runs`)).json()) as { runs: { status: string }[] };
  expect(runs.runs.length).toBeGreaterThan(0);
  expect(runs.runs.every((r) => r.status === "silent")).toBe(true);
});

test("a repeat within 24 hours (Idempotency-Key or X-GitHub-Delivery) answers with the first run", async () => {
  const { routine } = await webhookRoutine();
  const first = await call(routine.trigger.url, '{"n":1}', { "idempotency-key": "order-42" });
  const { runId } = (await first.json()) as { runId: string };
  const again = await call(routine.trigger.url, '{"n":1}', { "idempotency-key": "order-42" });
  expect(again.status).toBe(202);
  expect(await again.json()).toEqual({ ok: true, runId, duplicate: true });
  const github = await call(routine.trigger.url, '{"n":2}', { "x-github-delivery": "72d3162e" });
  const repeat = await call(routine.trigger.url, '{"n":2}', { "x-github-delivery": "72d3162e" });
  expect(await repeat.json()).toMatchObject({
    runId: ((await github.json()) as { runId: string }).runId,
    duplicate: true,
  });
});

test("past 256 KB: 413; every client address has a limit, counted before anything is looked up", async () => {
  const { routine } = await webhookRoutine();
  const big = await call(routine.trigger.url, "x".repeat(256 * 1024 + 1));
  expect(big.status).toBe(413);
  expect(await codeOf(big)).toBe("too_large");
  for (let i = 0; i < HOOK_LIMIT_PER_IP.limit; i++) {
    const res = await call(`${ORIGIN}/api/hooks/nope`, "{}", { "x-forwarded-for": "203.0.113.50" });
    expect(res.status).toBe(404);
  }
  const limited = await call(routine.trigger.url, "{}", { "x-forwarded-for": "203.0.113.50" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  // Another address still gets through.
  expect((await call(routine.trigger.url, "{}", { "x-forwarded-for": "203.0.113.51" })).status).toBe(202);
});

test("only who manages it sees and changes its address; Testar sends a sample the agent is told is a test", async () => {
  await t.close();
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["Feito."] }) });
  const { owner, orgId, api, routine } = await webhookRoutine();
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asBia = (path: string, init?: Parameters<typeof bia>[1]) => bia(`/api/app/organizations/${orgId}${path}`, init);
  const listed = (await (await asBia("/routines")).json()) as { routines: { trigger: { url: string | null } }[] };
  expect(listed.routines[0]?.trigger.url).toBeNull();
  expect((await asBia(`/routines/${routine.id}/hook`)).status).toBe(403);
  expect((await asBia(`/routines/${routine.id}/hook/address`, { json: {} })).status).toBe(403);
  expect((await asBia(`/routines/${routine.id}/hook/test`, { json: {} })).status).toBe(403);

  const tested = await api(`/routines/${routine.id}/hook/test`, { json: {} });
  expect(tested.status).toBe(200);
  const { runId, hook } = (await tested.json()) as { runId: string; hook: Hook };
  expect(hook.calls).toMatchObject([{ outcome: "accepted", test: true, runId }]);
  await t.drain();
  const systems = t.provider.calls.map((c) => systemText(c.request.system));
  expect(systems.some((s) => s.includes("A person pressed Testar on this routine's page"))).toBe(true);
});

test("a call that fails on our side is logged without the routine's address", async () => {
  const { api, routine } = await webhookRoutine();
  await api(`/routines/${routine.id}/hook/secret`, { json: {} });
  // Its signing secret can't be opened any more (the key that sealed it is gone).
  await t.db.update(schema.routineHooks).set({ secretKekId: "gone" });
  const lines: string[] = [];
  const logged = spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
  try {
    expect((await call(routine.trigger.url, "{}")).status).toBe(500);
  } finally {
    logged.mockRestore();
  }
  const token = routine.trigger.url.split("/api/hooks/")[1] ?? "";
  expect(lines.join("\n")).toContain('"path":"/api/hooks/…"');
  expect(lines.join("\n")).not.toContain(token);
});

test("the methods it answers are chosen on the routine: GET passes its query string, others get 405 with Allow", async () => {
  const { api, routine } = await webhookRoutine();
  const changed = await api(`/routines/${routine.id}`, {
    method: "PATCH",
    json: { trigger: { type: "webhook", methods: ["GET", "PUT"] } },
  });
  expect(changed.status).toBe(200);
  expect(((await changed.json()) as { trigger: { methods: string[] } }).trigger.methods).toEqual(["GET", "PUT"]);
  const url = routine.trigger.url;
  const post = await call(url, "{}");
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, PUT");
  const get = await call(`${url}?status=paid&order=42`, "", {}, "GET");
  expect(get.status).toBe(202);
  const { runId } = (await get.json()) as { runId: string };
  const [run] = (await t.db.select().from(schema.routineRuns)).filter((r) => r.id === runId);
  expect((run?.event?.calls as { body: string; method: string }[] | undefined)?.[0]).toMatchObject({
    body: '{"status":"paid","order":"42"}',
    method: "GET",
  });
  expect((await (await api(`/routines/${routine.id}/hook`)).json()) as Hook).toMatchObject({ methods: ["GET", "PUT"] });
  // Signed, a GET's signature covers its query string as sent.
  const { secret } = (await (await api(`/routines/${routine.id}/hook/secret`, { json: {} })).json()) as {
    secret: string;
  };
  const query = "status=paid&order=43";
  expect((await call(`${url}?${query}`, "", { "x-agentes-signature": sign(secret, "") }, "GET")).status).toBe(401);
  expect((await call(`${url}?${query}`, "", { "x-agentes-signature": sign(secret, query) }, "GET")).status).toBe(202);
  const bad = await api(`/routines/${routine.id}`, {
    method: "PATCH",
    json: { trigger: { type: "webhook", methods: [] } },
  });
  expect(bad.status).toBe(400);
});
