import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { setOrgLimits } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const BILLING = { BILLING_URL: "https://billing.example.com", BILLING_LINK_SECRET: "b".repeat(32) };

async function ownerWithWorkspace(server: TestServer) {
  const owner = browser(server);
  await signUp(owner, "owner@example.com");
  const res = await owner("/api/app/organizations", { json: { name: "Acme" } });
  const { organization } = (await res.json()) as { organization: { id: string } };
  return { owner, orgId: organization.id };
}

describe("the billing link", () => {
  test("no billing service: 404 billing.off, and auth-config names none", async () => {
    t = await createTestServer();
    const { owner, orgId } = await ownerWithWorkspace(t);
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({ billingUrl: null });
    const res = await owner(`/api/app/organizations/${orgId}/billing-link`, { json: { from: "settings" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "billing.off" } });
  });

  test("the plan picked in the app rides along; a malformed one is refused", async () => {
    t = await createTestServer({ env: BILLING });
    const { owner, orgId } = await ownerWithWorkspace(t);
    const link = (plan: string) =>
      owner(`/api/app/organizations/${orgId}/billing-link`, { json: { from: "onboarding", plan } });
    const ok = await link("team");
    expect(ok.status).toBe(200);
    const { url } = (await ok.json()) as { url: string };
    const payload = new URL(url).searchParams.get("t")?.split(".")[1] ?? "";
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ plan: "team" });
    expect((await link("Team plan")).status).toBe(400);
  });

  test("owners and admins get a signed link for 5 minutes; members get 403", async () => {
    t = await createTestServer({ env: BILLING });
    expect(await (await browser(t)("/api/app/auth-config")).json()).toMatchObject({
      billingUrl: "https://billing.example.com",
    });
    const { owner, orgId } = await ownerWithWorkspace(t);
    const admin = await joinByInvitation(t, owner, orgId, "admin@example.com", { role: "admin" });
    const member = await joinByInvitation(t, owner, orgId, "member@example.com");
    const link = (who: typeof owner, from = "settings") =>
      who(`/api/app/organizations/${orgId}/billing-link`, { json: { from } });

    for (const who of [owner, admin]) {
      const res = await link(who);
      expect(res.status).toBe(200);
      const { url, expiresAt } = (await res.json()) as { url: string; expiresAt: string };
      expect(url).toMatch(/^https:\/\/billing\.example\.com\/link\?t=v1\.[\w-]+\.[\w-]+$/);
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(290_000);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    }
    const refused = await link(member);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "forbidden" } });
    expect((await link(owner, "anywhere")).status).toBe(400);
  });

  test("with the hold on new workspaces: a new one waits for its plan, and its owner makes no other meanwhile, its onboarding getting the same one back", async () => {
    t = await createTestServer({
      env: { ...BILLING, BILLING_HOLD_NEW_WORKSPACES: "true", OPERATOR_API_TOKEN: "o".repeat(40) },
    });
    const { owner, orgId } = await ownerWithWorkspace(t);
    const me = (await (await owner("/api/app/me")).json()) as {
      organizations: { id: string; standing: { state: string; reason: string | null } }[];
    };
    expect(me.organizations).toEqual([
      expect.objectContaining({ id: orgId, standing: { state: "hold", reason: "payment" } }),
    ]);
    // Paying is how the hold ends: its owner may open the plan.
    expect((await owner(`/api/app/organizations/${orgId}/billing-link`, { json: { from: "onboarding" } })).status).toBe(
      200,
    );
    // Still in its onboarding, a create gives the same one back, so a reload before paying lands on it again.
    const again = await owner("/api/app/organizations", { json: { name: "Beta" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ organization: { id: orgId } });
    // Once it is set up, another one waits for this one's plan.
    const finished = await owner(`/api/app/organizations/${orgId}/onboarding`, {
      method: "PATCH",
      json: { finished: true },
    });
    expect(finished.status).toBe(200);
    const another = await owner("/api/app/organizations", { json: { name: "Gama" } });
    expect(another.status).toBe(403);
    expect(await another.json()).toMatchObject({ error: { code: "org.create_unpaid", params: { orgId } } });
  });
});

describe("the workspace's limits", () => {
  test("any member reads people, files and today's uploads against them; a full workspace invites nobody", async () => {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const { owner, orgId } = await ownerWithWorkspace(t);
    const member = await joinByInvitation(t, owner, orgId, "member@example.com");
    const read = async (who: Browser) => {
      const res = await who(`/api/app/organizations/${orgId}/limits`);
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await read(member)).toEqual({
      members: { used: 2, limit: null, max: null, canAddSeats: false, payer: null },
      storage: { usedBytes: 0, limitBytes: null, ownStorage: false },
      uploads: { usedBytes24h: 0, limitBytesPerDay: null },
    });
    const limits = {
      members: 2,
      membersMax: 3,
      payerUserId: null,
      storageBytes: 1000,
      uploadBytesPerDay: 500,
      platformUsdPerMonth: 3,
    };
    await setOrgLimits(t.db, orgId, limits);
    expect(await read(owner)).toEqual({
      members: { used: 2, limit: 2, max: 3, canAddSeats: true, payer: null },
      storage: { usedBytes: 0, limitBytes: 1000, ownStorage: false },
      uploads: { usedBytes24h: 0, limitBytesPerDay: 500 },
    });
    const stranger = browser(t);
    await signUp(stranger, "eve@example.com");
    expect((await stranger(`/api/app/organizations/${orgId}/limits`)).status).toBe(403);

    const invited = await owner(`/api/app/organizations/${orgId}/invitations`, {
      json: { email: "new@example.com", role: "member" },
    });
    expect(invited.status).toBe(409);
    expect(await invited.json()).toMatchObject({
      error: { code: "org.members_full", params: { members: 2, limit: 2 } },
    });
  });

  test("who pays: the payer reads it is them, anyone else who manages billing reads their name", async () => {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const server = t;
    const { owner, orgId } = await ownerWithWorkspace(server);
    const admin = await joinByInvitation(server, owner, orgId, "admin@example.com", { role: "admin" });
    const member = await joinByInvitation(server, owner, orgId, "member@example.com");
    const [payer] = await server.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "owner@example.com"));
    const seen = async (who: Browser, payerUserId: string | null) => {
      await setOrgLimits(server.db, orgId, {
        members: 3,
        membersMax: 5,
        payerUserId,
        storageBytes: null,
        uploadBytesPerDay: null,
        platformUsdPerMonth: null,
      });
      const res = await who(`/api/app/organizations/${orgId}/limits`);
      return ((await res.json()) as { members: { payer: unknown } }).members.payer;
    };
    const payerId = payer?.id ?? "";
    expect(await seen(owner, payerId)).toEqual({ you: true, name: null });
    expect(await seen(admin, payerId)).toEqual({ you: false, name: "owner" });
    // Who pays is billing's business: a member reads only that it isn't them.
    expect(await seen(member, payerId)).toEqual({ you: false, name: null });
    // Someone not in the workspace: no name to say.
    expect(await seen(admin, "user_gone")).toEqual({ you: false, name: null });
    expect(await seen(admin, null)).toBeNull();
  });
});
