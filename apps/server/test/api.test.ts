import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { z } from "@hono/zod-openapi";
import { issueParams } from "../src/http/errors";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

describe("sign-up policy (self-host)", () => {
  test("first account signs up; then sign-up closes", async () => {
    const anon = browser(t);
    expect(await (await anon("/api/app/auth-config")).json()).toMatchObject({ signupOpen: true, firstRun: true });
    await signUp(browser(t), "owner@example.com");
    expect(await (await anon("/api/app/auth-config")).json()).toMatchObject({ signupOpen: false, firstRun: false });
    const res = await browser(t)("/api/auth/sign-up/email", {
      json: { email: "stranger@example.com", password: "correct horse battery", name: "s" },
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain("Sign-up is closed");
  });

  test("auth-config: no legal links or support address unless configured; password reset when email goes out", async () => {
    // The test server's fake email sender delivers; people connect their own computers.
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      termsUrl: null,
      privacyUrl: null,
      supportEmail: null,
      passwordReset: true,
      workspaceComputer: false,
      cloud: false,
    });
    await t.close();
    t = await createTestServer({
      env: {
        TERMS_URL: "https://example.com/terms",
        PRIVACY_URL: "https://example.com/privacy",
        SUPPORT_EMAIL: "help@example.com",
        MACHINE_PROVISIONING: "external",
        OPERATOR_API_TOKEN: "o".repeat(40),
      },
    });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      termsUrl: "https://example.com/terms",
      privacyUrl: "https://example.com/privacy",
      supportEmail: "help@example.com",
      workspaceComputer: true,
    });
  });

  test("ALLOW_SIGNUP=true keeps it open", async () => {
    await t.close();
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    await signUp(browser(t), "a@example.com");
    await signUp(browser(t), "b@example.com");
  });

  test("an invited email can sign up and join", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const { url } = (await (
      await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
    ).json()) as { url: string };
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const token = url.split("/invite/")[1];
    expect((await ana(`/api/app/invitations/${token}/accept`, { json: {} })).status).toBe(200);
    const me = (await (await ana("/api/app/me")).json()) as { organizations: { id: string; role: string }[] };
    expect(me.organizations).toEqual([
      {
        id: orgId,
        name: "Acme",
        mode: "team",
        role: "member",
        permissions: expect.arrayContaining(["read", "post", "talk_to_agents"]),
        rank: null,
        logo: null,
        standing: { state: "active", reason: null },
        start: { page: "home", channelId: null },
        showActivity: false,
        agentStyle: null,
        chatPrefs: {},
        createdAt: expect.any(String),
      },
    ] as never);
  });
});

describe("app API protections", () => {
  test("requires a session", async () => {
    expect((await browser(t)("/api/app/me")).status).toBe(401);
  });

  test("CSRF: writes need our Origin and JSON", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    expect(
      (await owner("/api/app/organizations", { json: { name: "X" }, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await owner("/api/app/organizations", { json: { name: "X" }, origin: null })).status).toBe(403);
    const form = await t.app.request("/api/app/organizations", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        cookie: owner.cookie(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "name=X",
    });
    expect(form.status).toBe(415);
  });

  test("validation errors use the error shape, a sentence per field", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const res = await owner("/api/app/organizations", { json: { name: "", teamSize: "huge" } });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; message: string; params?: unknown } };
    expect(error.code).toBe("invalid_request");
    expect(error.message).toMatch(/^name: [^;]+\. teamSize: [^;]+$/);
    // The validator's English is for developers: the apps word the first problem by its kind.
    expect(error.params).toEqual({ field: "name", issue: "missing" });
    const long = await owner("/api/app/organizations", { json: { name: "x".repeat(101) } });
    expect(((await long.json()) as { error: { params?: unknown } }).error.params).toEqual({
      field: "name",
      issue: "too_long",
      max: 100,
    });
  });

  test("a number out of its range reads as a value to check, never as text too long or missing", () => {
    const first = (schema: z.ZodType, value: unknown) => issueParams(schema.safeParse(value).error?.issues[0]);
    const fields = z.object({ timeout: z.number().int().min(1).max(60), names: z.array(z.string()).min(1).max(2) });
    expect(first(fields, { timeout: 70, names: ["a"] })).toEqual({ field: "timeout", issue: "invalid" });
    expect(first(fields, { timeout: 0, names: ["a"] })).toEqual({ field: "timeout", issue: "invalid" });
    expect(first(fields, { timeout: 5, names: ["a", "b", "c"] })).toEqual({
      field: "names",
      issue: "too_many",
      max: 2,
    });
    expect(first(fields, { timeout: 5, names: [] })).toEqual({ field: "names", issue: "missing" });
  });
});

describe("organizations, agents and credentials", () => {
  test("credentials are never returned, not even to owners", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const list = await (await owner(`/api/app/organizations/${orgId}/credentials`)).text();
    expect(list).toContain("9876");
    expect(list).not.toContain("sk-ant-api-secret");
    const agents = await (await owner(`/api/app/organizations/${orgId}/agents`)).json();
    expect(agents).toMatchObject({
      agents: [
        { handle: "lodi", hasCredential: false },
        { handle: "dev", model: "claude-sonnet-5-5", hasCredential: true, monthlyBudgetUsd: 50 },
      ],
    });
    const rows = await t.db.select().from(schema.providerCredentials);
    expect(JSON.stringify(rows)).not.toContain("sk-ant-api-secret");
  });

  test("members can chat but can't manage agents or credentials", async () => {
    await t.close();
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const { url } = (await (
      await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "ana@example.com", role: "member" } })
    ).json()) as { url: string };
    await ana(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
    expect((await ana(`/api/app/organizations/${orgId}/agents`, { json: { name: "X", handle: "xx" } })).status).toBe(
      403,
    );
    expect((await ana(`/api/app/organizations/${orgId}/credentials`)).status).toBe(403);
    expect((await ana(`/api/app/organizations/${orgId}/usage`)).status).toBe(403);
    expect((await ana(`/api/app/organizations/${orgId}/agents`)).status).toBe(200);
  });

  test("the team's right hand (ADR 0137): listed with its mark, never archived or deleted; an old app's coordinator is ignored", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId, agentId: devId } = await seedOrg(owner);
    const api = (path: string, init?: Parameters<typeof owner>[1]) =>
      owner(`/api/app/organizations/${orgId}${path}`, init);
    const { agents } = (await (await api("/agents")).json()) as {
      agents: { id: string; handle: string; builtin: string | null }[];
    };
    expect(agents.map((a) => [a.handle, a.builtin])).toEqual([
      ["lodi", "right_hand"],
      ["dev", null],
    ]);
    const lodi = agents[0]?.id;
    for (const path of [`/agents/${lodi}`, `/agents/${lodi}?purge=true`]) {
      const refused = await api(path, { method: "DELETE" });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: "agent.right_hand_permanent" } });
    }
    // Phones without the update still send `coordinator`: 200, and nothing changes.
    const old = await api(`/agents/${devId}`, { method: "PATCH", json: { coordinator: true } });
    expect(old.status).toBe(200);
    expect(await old.json()).toMatchObject({ id: devId, builtin: null });
  });

  test("unknown models are rejected", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const res = await owner(`/api/app/organizations/${orgId}/agents`, {
      json: { name: "X", handle: "xx", model: "gpt-5" },
    });
    expect(res.status).toBe(400);
  });
});

describe("chat over HTTP", () => {
  test("post a mention, workers run the agent, the reply appears in the channel, usage is billed", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId, channelId, agentId } = await seedOrg(owner);
    const posted = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, {
      json: { body: "@dev status?" },
    });
    expect(posted.status).toBe(201);
    const message = (await posted.json()) as { id: string; mentionedAgentIds: string[] };
    expect(message.mentionedAgentIds).toEqual([agentId]);

    await t.drain();
    // Asked in the channel, answered in the channel.
    const timeline = (await (await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`)).json()) as {
      messages: { author: { type: string }; body: string; threadId: string | null }[];
    };
    expect(timeline.messages.map((m) => [m.author.type, m.body, m.threadId])).toEqual([
      ["person", "@dev status?", null],
      ["agent", "Echo: [owner]: @dev status?.", null],
    ]);
    expect(t.provider.calls[0]?.apiKey).toBe("sk-ant-api-secret-9876");
    // Per-agent cost is an admin endpoint (the owner here); members get 403 (see above).
    const usage = (await (await owner(`/api/app/organizations/${orgId}/usage`)).json()) as {
      usage: { calls: number; costUsd: number }[];
    };
    expect(usage.usage[0]?.calls).toBe(1);
    expect(usage.usage[0]?.costUsd).toBeGreaterThan(0);
  });

  test("a channel created with a category is placed in it", async () => {
    const owner = browser(t);
    await signUp(owner, "owner@example.com");
    const { orgId } = await seedOrg(owner);
    const org = `/api/app/organizations/${orgId}`;
    const category = (await (await owner(`${org}/channel-categories`, { json: { name: "Produto" } })).json()) as {
      id: string;
    };
    const res = await owner(`${org}/channels`, { json: { name: "roadmap", categoryId: category.id } });
    expect(res.status).toBe(201);
    const channel = (await res.json()) as { id: string; categoryId: string | null };
    expect(channel.categoryId).toBe(category.id);
    const list = (await (await owner(`${org}/channels`)).json()) as {
      channels: { id: string; categoryId: string | null }[];
    };
    expect(list.channels.filter((c) => c.categoryId === category.id).map((c) => c.id)).toEqual([channel.id]);
  });

  test("organizations are isolated: another org's owner can't read or post", async () => {
    await t.close();
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const a = browser(t);
    await signUp(a, "a@example.com");
    const { orgId, channelId } = await seedOrg(a);
    const b = browser(t);
    await signUp(b, "b@example.com");
    const other = (await (await b("/api/app/organizations", { json: { name: "Other" } })).json()) as {
      organization: { id: string };
    };

    expect((await b(`/api/app/organizations/${orgId}/channels/${channelId}/messages`)).status).toBe(403);
    expect(
      (await b(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "hi" } })).status,
    ).toBe(403);
    // Using their own org id with A's channel id doesn't help either.
    expect((await b(`/api/app/organizations/${other.organization.id}/channels/${channelId}/messages`)).status).toBe(
      404,
    );
  });
});
