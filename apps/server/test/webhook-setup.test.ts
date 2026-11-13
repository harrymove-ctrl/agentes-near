import { afterEach, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** A GitHub or Sentry routine's webhook set up from the routine form: made, pasted, tested, or added in one click. */

let t: TestServer;
afterEach(() => t.close());

interface Setup {
  id: string | null;
  url: string | null;
  secret: string | null;
  receivedAt: string | null;
  refusedAt: string | null;
  secretSet: boolean;
  canManage: boolean;
  oneClick: boolean;
}

async function world(options: Parameters<typeof createTestServer>[0] = {}) {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }), ...options });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const setup = async (provider: "github" | "sentry", method?: "PUT") =>
    (await (await api(`/webhooks/${provider}`, method ? { method, json: {} } : undefined)).json()) as Setup;
  return { owner, orgId, channelId, agentId, api, setup };
}

const call = (url: string, headers: Record<string, string>, body: string) =>
  t.app.request(new URL(url).pathname, { method: "POST", headers, body });
const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

test("GitHub: made once, its secret shown again, a wrong secret said, the ping turns it green and the routine runs", async () => {
  const w = await world();
  const routine = (await (
    await w.api("/routines", {
      json: {
        agentId: w.agentId,
        prompt: "Revise o PR novo.",
        target: { type: "channel", channelId: w.channelId },
        trigger: { type: "event", event: "github.pr_opened" },
      },
    })
  ).json()) as { id: string };
  const state = async () =>
    ((await (await w.api("/routines")).json()) as { routines: { id: string; state: string }[] }).routines.find(
      (r) => r.id === routine.id,
    )?.state;
  expect(await w.setup("github")).toMatchObject({ id: null, url: null, canManage: true, oneClick: false });
  const made = await w.setup("github", "PUT");
  expect(made.url).toContain("/api/webhooks/github/");
  expect(made.secret).toBeString();
  // Opening the form again reuses it.
  expect((await w.setup("github", "PUT")).id).toBe(made.id);
  expect(await w.setup("github")).toMatchObject({ id: made.id, secret: made.secret, receivedAt: null });
  expect(await state()).toBe("needs_webhook");

  const ping = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const github = (secret: string, body: string, event = "ping", type = "application/json") =>
    call(
      made.url ?? "",
      { "content-type": type, "x-github-event": event, "x-hub-signature-256": `sha256=${hmac(secret, body)}` },
      body,
    );
  expect((await github("other secret", ping)).status).toBe(401);
  expect((await w.setup("github")).refusedAt).toBeString();
  expect((await github(made.secret ?? "", ping)).status).toBe(202);
  expect((await w.setup("github")).receivedAt).toBeString();
  expect(await state()).toBe("active");

  // GitHub's default content type wraps the JSON in a form field: the event still fires the routine.
  const pr = JSON.stringify({
    action: "opened",
    repository: { full_name: "acme/app" },
    pull_request: { number: 7, title: "Fix login", html_url: "https://github.com/acme/app/pull/7" },
  });
  const form = `payload=${encodeURIComponent(pr)}`;
  const fired = await github(made.secret ?? "", form, "pull_request", "application/x-www-form-urlencoded");
  expect(await fired.json()).toMatchObject({ event: "github.pr_opened", fired: 1 });
});

test("Sentry: its Client Secret is pasted here, never shown back, and its calls are checked with it", async () => {
  const w = await world();
  const made = await w.setup("sentry", "PUT");
  expect(made).toMatchObject({ secret: null, secretSet: false });
  expect((await w.api("/webhooks/sentry/secret", { method: "PUT", json: { secret: "short" } })).status).toBe(400);
  const pasted = (await (
    await w.api("/webhooks/sentry/secret", { method: "PUT", json: { secret: "  sentry-client-secret-1234  " } })
  ).json()) as Setup;
  expect(pasted).toMatchObject({ id: made.id, secret: null, secretSet: true });
  const issue = JSON.stringify({ action: "created", data: { issue: { id: "42", title: "TypeError" } } });
  const sentry = (secret: string) =>
    call(
      made.url ?? "",
      {
        "content-type": "application/json",
        "sentry-hook-resource": "issue",
        "sentry-hook-signature": hmac(secret, issue),
      },
      issue,
    );
  expect((await sentry("sentry-client-secret-1234")).status).toBe(202);
  expect((await w.setup("sentry")).receivedAt).toBeString();
});

test("someone who doesn't set up webhooks sees whether it works, not its address or secret, and can't make one", async () => {
  const w = await world();
  const orgId = w.orgId;
  await w.setup("github", "PUT");
  const member = await joinByInvitation(t, w.owner, orgId, "member@example.com");
  const seen = (await (await member(`/api/app/organizations/${orgId}/webhooks/github`)).json()) as Setup;
  expect(seen).toMatchObject({ canManage: false, url: null, secret: null, oneClick: false });
  expect(seen.id).toBeString();
  expect((await member(`/api/app/organizations/${orgId}/webhooks/sentry`, { method: "PUT", json: {} })).status).toBe(
    403,
  );
});

test("one click: our GitHub App adds the webhook to the repository, or says no access is left to try", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const made: { url: string; body: Record<string, unknown> }[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/acme/app/installation") return Response.json({ id: 7 });
    if (url === "https://api.github.com/app/installations/7/access_tokens")
      return Response.json({ token: "ghs_hooks" });
    if (url.startsWith("https://api.github.com/repos/acme/app/hooks")) {
      if (init?.method === "POST") {
        made.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ id: 1 }, { status: 201 });
      }
      return Response.json([]);
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  const w = await world({
    http,
    env: {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey.export({ type: "pkcs1", format: "pem" }).toString()).toString(
        "base64",
      ),
    },
  });
  await t.db.insert(schema.githubAppInstallations).values({
    orgId: w.orgId,
    installationId: 7,
    accountLogin: "acme",
    accountType: "Organization",
    repositorySelection: "all",
  });
  expect((await w.setup("github")).oneClick).toBe(true);
  const done = await w.api("/webhooks/github/repository", { json: { repo: "acme/app" } });
  expect(done.status).toBe(200);
  const setup = (await done.json()) as Setup;
  expect(made).toHaveLength(1);
  expect(made[0]?.body).toMatchObject({
    name: "web",
    active: true,
    events: ["pull_request", "deployment_status"],
    config: { url: setup.url, content_type: "json", secret: setup.secret },
  });

  // A repository the app isn't installed on, and no GitHub connection: the steps by hand stay.
  const refused = await w.api("/webhooks/github/repository", { json: { repo: "acme/web" } });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({
    error: { code: "webhook.github_no_access", params: { repo: "acme/web" } },
  });
});
