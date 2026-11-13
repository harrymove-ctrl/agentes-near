import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, schema } from "@agenteschat/db";
import {
  archiveChannel,
  BILLING_FROM,
  type BillingLinkClaims,
  createAgent,
  createChannel,
  createFileArtifact,
  createIssue,
  createWikiPage,
  deleteArtifact,
  deleteWikiPage,
  insertMessage,
  mintBillingLink,
  openAgentDm,
  openPersonAgentDm,
  saveStorage,
  setBillingHold,
  setOrgStanding,
  signBillingLink,
  testStorage,
  updateIssue,
} from "../src";
import { openRoutineRoom } from "../src/routine-room";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

// The billing service checks the same vector: both sides sign and verify these exact bytes.
const SECRET = "test-billing-link-secret-000000000000000";
const VECTOR: BillingLinkClaims = {
  aud: "agentes-billing",
  jti: "00000000-0000-4000-8000-000000000001",
  iat: 1798761600,
  exp: 1798761900,
  orgId: "00000000-0000-4000-8000-0000000000aa",
  orgName: "Acme",
  userId: "user_test_1",
  email: "ana@example.com",
  name: "Ana",
  role: "owner",
  locale: "pt-BR",
  from: "settings",
  return: "/org/00000000-0000-4000-8000-0000000000aa/settings/billing",
  usage: {
    members: 3,
    agents: 6,
    storageBytes: 1073741824,
    messages: 48210,
    channels: 12,
    files: 37,
    wikiPages: 9,
    issues: 54,
    since: 1782864000,
  },
};
const TOKEN =
  "v1.eyJhdWQiOiJhZ2VudGVzLWJpbGxpbmciLCJqdGkiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJpYXQiOjE3OTg3NjE2MDAsImV4cCI6MTc5ODc2MTkwMCwib3JnSWQiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwYWEiLCJvcmdOYW1lIjoiQWNtZSIsInVzZXJJZCI6InVzZXJfdGVzdF8xIiwiZW1haWwiOiJhbmFAZXhhbXBsZS5jb20iLCJuYW1lIjoiQW5hIiwicm9sZSI6Im93bmVyIiwibG9jYWxlIjoicHQtQlIiLCJmcm9tIjoic2V0dGluZ3MiLCJyZXR1cm4iOiIvb3JnLzAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDBhYS9zZXR0aW5ncy9iaWxsaW5nIiwidXNhZ2UiOnsibWVtYmVycyI6MywiYWdlbnRzIjo2LCJzdG9yYWdlQnl0ZXMiOjEwNzM3NDE4MjQsIm1lc3NhZ2VzIjo0ODIxMCwiY2hhbm5lbHMiOjEyLCJmaWxlcyI6MzcsIndpa2lQYWdlcyI6OSwiaXNzdWVzIjo1NCwic2luY2UiOjE3ODI4NjQwMDB9fQ.f02uFh5tHCLVCq8HCwhzN8RM2Ne6EdD5DDxmHFR2qv4";

const NOW = new Date("2027-01-01T00:00:00Z");
const mint = (
  userId: string,
  from: (typeof BILLING_FROM)[number] = "settings",
  baseUrl = "https://billing.example.com",
) => mintBillingLink(f.db, { secret: SECRET, baseUrl, userId, orgId: f.org.id, from, now: NOW });

/** The link's token, checked like the billing service checks it: the HMAC over the payload as sent. */
function claimsOf(url: string) {
  const token = new URL(url).searchParams.get("t") ?? "";
  const [version, payload, signature] = token.split(".");
  expect(version).toBe("v1");
  expect(signature).toBe(createHmac("sha256", SECRET).update(`v1.${payload}`).digest("base64url"));
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString()) as BillingLinkClaims;
}

describe("signBillingLink", () => {
  test("the shared test vector, byte for byte", () => {
    expect(signBillingLink(SECRET, VECTOR)).toBe(TOKEN);
  });
});

describe("mintBillingLink", () => {
  test("an owner's link: who, where, for 5 minutes, in the vector's key order", async () => {
    const link = await mint(f.owner.id);
    expect(link.url.startsWith("https://billing.example.com/link?t=v1.")).toBe(true);
    expect(link.expiresAt).toEqual(new Date(NOW.getTime() + 300_000));
    const [owner] = await f.db.select().from(schema.users).where(eq(schema.users.id, f.owner.id));
    const claims = claimsOf(link.url);
    expect(Object.keys(claims)).toEqual(Object.keys(VECTOR));
    expect(Object.keys(claims.usage)).toEqual(Object.keys(VECTOR.usage));
    expect(claims).toEqual({
      aud: "agentes-billing",
      jti: expect.any(String),
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 300,
      orgId: f.org.id,
      orgName: "Acme",
      userId: f.owner.id,
      email: owner?.email ?? "",
      name: owner?.name ?? "",
      role: "owner",
      locale: "pt-BR",
      from: "settings",
      return: `/org/${f.org.id}/settings/billing`,
      // A new workspace: #general, its owner and @dev, nothing written yet.
      usage: {
        members: 1,
        agents: 1,
        storageBytes: 0,
        messages: 0,
        channels: 1,
        files: 0,
        wikiPages: 0,
        issues: 0,
        since: Math.floor(f.org.createdAt.getTime() / 1000),
      },
    });
    // Single use on the billing side: every link is its own.
    expect(claimsOf((await mint(f.owner.id)).url).jti).not.toBe(claims.jti);
  });

  test("admins too, in their language; back to where each entry point opened it", async () => {
    const admin = await addMember(f.db, f.org.id, "admin");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, admin.id));
    const returns = Object.fromEntries(
      await Promise.all(BILLING_FROM.map(async (from) => [from, claimsOf((await mint(admin.id, from)).url).return])),
    );
    const org = `/org/${f.org.id}`;
    expect(returns).toEqual({
      settings: `${org}/settings/billing`,
      hold: org,
      onboarding: `${org}/onboarding`,
      new_workspace: org,
      invite_full: `${org}/members`,
      upload_full: org,
      storage: `${org}/settings/storage`,
    });
    const claims = claimsOf((await mint(admin.id, "hold", "https://billing.example.com/")).url);
    expect(claims).toMatchObject({ role: "admin", locale: "en", usage: { members: 2 } });
  });

  test("the plan picked in the app goes as a claim, untouched; anything not a plan key is left out", async () => {
    const planOf = async (plan: string | undefined) =>
      claimsOf(
        (
          await mintBillingLink(f.db, {
            secret: SECRET,
            baseUrl: "https://billing.example.com",
            userId: f.owner.id,
            orgId: f.org.id,
            from: "onboarding",
            plan,
            now: NOW,
          })
        ).url,
      ).plan;
    expect(await planOf("team")).toBe("team");
    expect(await planOf("pro_yearly")).toBe("pro_yearly");
    expect(await planOf(undefined)).toBeUndefined();
    for (const junk of ["Team", "team plan", "x".repeat(40), "1team", ""]) expect(await planOf(junk)).toBeUndefined();
  });

  test("back to the page it was opened from when that is one of this workspace's; anything else, the default", async () => {
    const org = `/org/${f.org.id}`;
    const back = async (from: (typeof BILLING_FROM)[number], returnTo: string) =>
      claimsOf(
        (
          await mintBillingLink(f.db, {
            secret: SECRET,
            baseUrl: "https://billing.example.com",
            userId: f.owner.id,
            orgId: f.org.id,
            from,
            returnTo,
            now: NOW,
          })
        ).url,
      ).return;
    // The upload that hit the limit, in a channel: back to that channel. The billing service takes a bare path only
    // (it adds `?paid=1`), so the page's search and hash stay behind.
    const channel = `${org}/c/0b6f4c1e-8d2a-4f3b-9c7e-5a1d2e3f4a5b`;
    expect(await back("upload_full", `${channel}?thread=m-1#x`)).toBe(channel);
    expect(await back("hold", `${org}/settings/members`)).toBe(`${org}/settings/members`);
    // Another workspace, another host, the onboarding outside any workspace, or a path that only starts like it.
    expect(await back("upload_full", "/org/someone-else/c/abc")).toBe(org);
    expect(await back("upload_full", "https://evil.example.com/org")).toBe(org);
    expect(await back("upload_full", `//evil.example.com${org}/`)).toBe(org);
    expect(await back("onboarding", "/onboarding")).toBe(`${org}/onboarding`);
    expect(await back("settings", `${org}x/c/abc`)).toBe(`${org}/settings/billing`);
    expect(await back("settings", `${org}/c/a\\b`)).toBe(`${org}/settings/billing`);
    // A shape the billing service would refuse the whole link over: the default instead.
    expect(await back("settings", `${org}/wiki/Café`)).toBe(`${org}/settings/billing`);
    expect(await back("settings", `${org}/c/a b`)).toBe(`${org}/settings/billing`);
  });

  test("usage counts the files on this server's storage; on the workspace's own bucket, none", async () => {
    const owner = { type: "person" as const, userId: f.owner.id };
    await createFileArtifact(f.artifactDeps, owner, f.org.id, { title: "a", name: "a.txt", bytes: new Uint8Array(42) });
    expect(claimsOf((await mint(f.owner.id)).url).usage.storageBytes).toBe(42);
    const bucket = {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "acme-files",
      prefix: null,
      pathStyle: true,
      accessKeyId: "AKIATEST",
      secretAccessKey: "secret-test-key-123456",
    };
    expect((await testStorage(f.storage, f.owner.id, f.org.id, bucket)).ok).toBe(true);
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket });
    expect(claimsOf((await mint(f.owner.id)).url).usage.storageBytes).toBeNull();
  });

  test("usage counts what people can read, live: messages, named channels, Drive files, wiki pages, tasks", async () => {
    const ana = { type: "person" as const, userId: f.owner.id };
    const say = (channelId: string, author: Parameters<typeof insertMessage>[1]["author"] = ana, threadId?: string) =>
      insertMessage(f.db, { orgId: f.org.id, channelId, threadId, author, body: "Oi" });
    const root = await say(f.general.id);
    await say(f.general.id, ana, root.id);
    const old = await createChannel(f.db, f.owner.id, f.org.id, { name: "old" });
    await say(old.id);
    await archiveChannel(f.db, f.owner.id, f.org.id, old.id);
    await say((await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id)).id);
    // Rooms no person reads: two agents' DM and a routine's room.
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "Watch.", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const dev = { type: "agent" as const, agentId: f.agent.id, runId: null, hop: 1, stretchId: null };
    await say((await openAgentDm(f.db, f.org.id, f.agent.id, ops.id)).id, dev);
    await say((await openRoutineRoom(f.db, f.org.id, f.agent.id, crypto.randomUUID())).id, ana);

    const file = (name: string) =>
      createFileArtifact(f.artifactDeps, ana, f.org.id, { title: name, name, bytes: new Uint8Array(1) });
    await file("kept.txt");
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, (await file("trashed.txt")).id);
    const wiki = { db: f.db };
    await createWikiPage(wiki, ana, f.org.id, { title: "Glossário" });
    await deleteWikiPage(wiki, ana, f.org.id, (await createWikiPage(wiki, ana, f.org.id, { title: "Rascunho" })).id);
    const tasks = { db: f.db };
    await createIssue(tasks, ana, f.org.id, { title: "Lançar" });
    const dropped = await createIssue(tasks, ana, f.org.id, { title: "Esquecer" });
    await updateIssue(tasks, ana, f.org.id, dropped.id, { status: "canceled" });

    expect(claimsOf((await mint(f.owner.id)).url).usage).toMatchObject({
      messages: 4,
      channels: 1,
      files: 1,
      wikiPages: 1,
      issues: 1,
    });
  });

  test("members and strangers never get one; a held workspace does, a suspended one doesn't", async () => {
    const member = await addMember(f.db, f.org.id, "member");
    await expect(mint(member.id)).rejects.toMatchObject({ code: "forbidden" });
    const stranger = await addUser(f.db, "eve");
    await expect(mint(stranger.id)).rejects.toMatchObject({ code: "forbidden" });

    await setBillingHold({ db: f.db }, f.org.id, "payment");
    expect(claimsOf((await mint(f.owner.id, "hold")).url).from).toBe("hold");
    await setOrgStanding({ db: f.db }, f.org.id, { state: "suspended", reason: "abuse", notice: "shown" });
    await expect(mint(f.owner.id)).rejects.toMatchObject({ code: "org.suspended" });
  });
});
