import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryRateLimiter } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import {
  acceptInvitation,
  approveJoinRequest,
  askToJoin,
  assertMemberRoom,
  createFakeJudge,
  createFileArtifact,
  createInvitation,
  deleteArtifact,
  enableOperatorEvents,
  getOrgLimits,
  inviteLink,
  inviteMany,
  listMessages,
  messageRouter,
  type OrgLimits,
  operatorOrg,
  PLATFORM_CAP,
  parseSkillMarkdown,
  platformCapJudge,
  platformCapReached,
  postPersonMessage,
  type RouterStrategy,
  resendInvitation,
  restoreArtifact,
  routeMessage,
  SKILL_LIMITS,
  saveSkill,
  saveStorage,
  sendInvitation,
  setOrgLimits,
  startMigration,
  storageUsage,
  testStorage,
  withJudgeFallback,
} from "../src";
import { type Fixture, SECRET, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  enableOperatorEvents(false);
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const NONE: OrgLimits = {
  members: null,
  membersMax: null,
  payerUserId: null,
  storageBytes: null,
  uploadBytesPerDay: null,
  platformUsdPerMonth: null,
};
const limit = (over: Partial<OrgLimits>) => setOrgLimits(f.db, f.org.id, { ...NONE, ...over });
const owner = () => ({ type: "person" as const, userId: f.owner.id });
const upload = (bytes: number, name = "notes.txt") =>
  createFileArtifact(f.artifactDeps, owner(), f.org.id, { title: name, name, bytes: new Uint8Array(bytes) });
const blobCount = async () => (await f.platformBlobs.list("")).length;
/** New files go to the workspace's own bucket (a fake S3 server). */
async function ownBucket() {
  const bucket = {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "acme-files",
    prefix: "agentes",
    pathStyle: true,
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret-test-key-123456",
  };
  expect((await testStorage(f.storage, f.owner.id, f.org.id, bucket)).ok).toBe(true);
  await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "s3", s3: bucket });
}
/** An account with this address. */
async function person(email: string, emailVerified = false) {
  const id = `user_${email.split("@")[0]}`;
  await f.db.insert(schema.users).values({ id, name: email.split("@")[0] ?? "", email, emailVerified });
  return { id, email };
}

describe("limits", () => {
  test("set and read; none by default; setting the same again moves nothing; an unknown workspace is null", async () => {
    f = await setup();
    expect(await getOrgLimits(f.db, f.org.id)).toEqual({ ...NONE, updatedAt: null });
    const set = await limit({
      members: 10,
      membersMax: 15,
      payerUserId: "user_payer",
      storageBytes: 50 * 1024 ** 3,
      uploadBytesPerDay: 1024,
      platformUsdPerMonth: 3.5,
    });
    expect(set).toEqual({
      members: 10,
      membersMax: 15,
      payerUserId: "user_payer",
      storageBytes: 50 * 1024 ** 3,
      uploadBytesPerDay: 1024,
      platformUsdPerMonth: 3.5,
      updatedAt: expect.any(Date),
    });
    const [row] = await f.db
      .select({ nano: schema.organizations.limitPlatformNanoUsd })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, f.org.id));
    expect(row?.nano).toBe(3_500_000_000);
    await f.db
      .update(schema.organizations)
      .set({ limitsUpdatedAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(schema.organizations.id, f.org.id));
    const again = await limit({
      members: 10,
      membersMax: 15,
      payerUserId: "user_payer",
      storageBytes: 50 * 1024 ** 3,
      uploadBytesPerDay: 1024,
      platformUsdPerMonth: 3.5,
    });
    expect(again?.updatedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    const cleared = await limit({});
    expect(cleared).toEqual({ ...NONE, updatedAt: expect.any(Date) });
    expect(cleared?.updatedAt?.getTime()).toBeGreaterThan(Date.parse("2026-01-02"));
    expect(await setOrgLimits(f.db, crypto.randomUUID(), NONE)).toBeNull();
  });
});

describe("members", () => {
  test("a full workspace refuses invitations, accepting one and approving a request; members already in stay in", async () => {
    f = await setup();
    const early = await createInvitation(f.db, f.owner.id, f.org.id, { email: "early@example.com", role: "member" });
    await limit({ members: 2 });
    const { token } = await createInvitation(f.db, f.owner.id, f.org.id, { email: "bia@example.com", role: "member" });
    const bia = await person("bia@example.com");
    expect(await acceptInvitation(f.db, bia, token)).toMatchObject({ orgId: f.org.id });

    // Full: 2 of 2. Nothing goes out that couldn't be accepted.
    const full = { code: "org.members_full", params: { members: 2, limit: 2 } };
    await expect(
      createInvitation(f.db, f.owner.id, f.org.id, { email: "carl@example.com", role: "member" }),
    ).rejects.toMatchObject(full);
    await expect(
      inviteMany(f.db, f.owner.id, f.org.id, { emails: ["bia@example.com", "carl@example.com"] }),
    ).rejects.toMatchObject(full);
    await expect(resendInvitation(f.db, f.owner.id, f.org.id, early.invitation.id)).rejects.toMatchObject(full);
    await expect(acceptInvitation(f.db, await person("early@example.com"), early.token)).rejects.toMatchObject(full);
    // An address already in is told so, not that it is full.
    expect(await inviteMany(f.db, f.owner.id, f.org.id, { emails: ["bia@example.com"] })).toEqual([
      { email: "bia@example.com", status: "already_member" },
    ]);

    // A request to join waits; approving it is refused while full.
    const link = await inviteLink(f.db, SECRET, f.owner.id, f.org.id);
    const dan = await person("dan@example.com", true);
    await askToJoin({ db: f.db, rateLimiter: createMemoryRateLimiter() }, "https://agentes.test", {
      token: link.token,
      user: dan,
    });
    const [request] = await f.db.select().from(schema.organizationJoinRequests);
    await expect(
      approveJoinRequest({ db: f.db }, "https://agentes.test", f.owner.id, f.org.id, request?.id ?? ""),
    ).rejects.toMatchObject(full);

    // Someone already in accepting an invitation again isn't one more person.
    const self = await sendInvitation(f.db, {
      orgId: f.org.id,
      email: f.owner.email,
      role: "member",
      invitedBy: f.owner.id,
      ownersOk: true,
    });
    expect(await acceptInvitation(f.db, f.owner, self.token)).toMatchObject({ orgId: f.org.id });

    // A blocked account still takes its seat; one more seat lets the request in.
    await f.db.update(schema.users).set({ blockedAt: new Date() }).where(eq(schema.users.id, bia.id));
    await expect(assertMemberRoom(f.db, f.org.id)).rejects.toMatchObject(full);
    await limit({ members: 3 });
    expect(
      await approveJoinRequest({ db: f.db }, "https://agentes.test", f.owner.id, f.org.id, request?.id ?? ""),
    ).toEqual({ outcome: "joined" });
    await limit({});
    expect(
      (await createInvitation(f.db, f.owner.id, f.org.id, { email: "x@example.com", role: "member" })).token,
    ).toBeString();
  });
});

describe("storage", () => {
  test("refused before any blob is written; the trash frees its space; skills count; its own bucket is never counted", async () => {
    f = await setup();
    await limit({ storageBytes: 100 });
    const first = await upload(60);
    expect(await storageUsage(f.db, f.org.id)).toEqual({ usedBytes: 60, uploadBytes24h: 60 });
    const blobs = await blobCount();
    const refused = upload(41);
    await expect(refused).rejects.toMatchObject({ code: "storage.full", params: { usedBytes: 60, limitBytes: 100 } });
    await expect(refused).rejects.toThrow(
      "The workspace's file storage is full (60 bytes of 100 bytes): nothing was saved. Tell the person who asked: an admin can free space or raise the limit.",
    );
    expect(await blobCount()).toBe(blobs);
    expect((await f.db.select().from(schema.artifacts)).map((a) => a.id)).toEqual([first.id]);
    // Exactly up to the limit.
    await upload(40);

    // In the trash, a file takes no space (its blob goes 30 days later).
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, first.id);
    expect((await storageUsage(f.db, f.org.id)).usedBytes).toBe(40);
    await upload(60);

    // Skill files count too, and a refused skill leaves nothing behind.
    await limit({ storageBytes: 110 });
    const skill = (path: string, bytes: number) =>
      saveSkill({ db: f.db, blobs: f.artifactDeps.blobs }, f.owner.id, f.org.id, {
        ...parseSkillMarkdown("---\nname: weekly-report\ndescription: Writes the weekly report.\n---\nSteps."),
        source: "manual",
        files: [{ path, data: new Uint8Array(bytes) }],
      });
    await skill("templates/a.md", 10);
    expect((await storageUsage(f.db, f.org.id)).usedBytes).toBe(110);
    await expect(skill("templates/b.md", 1)).rejects.toMatchObject({ code: "storage.full" });
    expect((await f.db.select().from(schema.skills))[0]?.version).toBe(1);
    // A file never stored (a binary past what a skill keeps) takes no space, even past a limit lowered below what is kept.
    await limit({ storageBytes: 100 });
    await skill("demo.mp4", SKILL_LIMITS.assetBytes + 1);

    // On its own bucket, nothing counts against the limit.
    await ownBucket();
    await upload(500);
    expect((await storageUsage(f.db, f.org.id)).usedBytes).toBe(110);
    expect((await operatorOrg(f.db, f.org.id))?.meters).toEqual({
      storageBytes: 110,
      uploadBytes24h: 170,
      ownStorage: true,
      platformUsdThisMonth: 0,
    });
  });

  test("files out of the trash or copied back from its own bucket count again, never as the day's uploads", async () => {
    f = await setup();
    await limit({ storageBytes: 100, uploadBytesPerDay: 120 });
    const first = await upload(60);
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, first.id);
    const second = await upload(50);
    // The trash freed the space a new file took: bringing the old one back would pass the limit.
    await expect(restoreArtifact(f.artifactDeps, f.owner.id, f.org.id, first.id)).rejects.toMatchObject({
      code: "storage.full",
      params: { usedBytes: 50, limitBytes: 100 },
    });
    expect((await storageUsage(f.db, f.org.id)).usedBytes).toBe(50);
    // With room it comes back, though today's uploads (110 of 120 bytes) couldn't take it: it was written before.
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, second.id);
    await restoreArtifact(f.artifactDeps, f.owner.id, f.org.id, first.id);
    expect(await storageUsage(f.db, f.org.id)).toEqual({ usedBytes: 60, uploadBytes24h: 110 });

    // Files on its own bucket count against nothing until they are copied back here.
    await ownBucket();
    await upload(70);
    await saveStorage(f.storage, f.owner.id, f.org.id, { kind: "agentes" });
    await expect(startMigration(f.storage, f.owner.id, f.org.id)).rejects.toMatchObject({
      code: "storage.full",
      params: { usedBytes: 60, limitBytes: 100 },
    });
    expect(await f.db.select().from(schema.storageMigrations)).toEqual([]);
    await limit({ storageBytes: 130, uploadBytesPerDay: 120 });
    expect(await startMigration(f.storage, f.owner.id, f.org.id)).toMatchObject({ status: "running", total: 1 });
  });

  test("at most a day's worth in any 24 hours, the trash included", async () => {
    f = await setup();
    await limit({ uploadBytesPerDay: 100 });
    const first = await upload(60);
    await deleteArtifact(f.artifactDeps, f.owner.id, f.org.id, first.id);
    const refused = upload(60);
    await expect(refused).rejects.toMatchObject({ code: "storage.daily_full", params: { limitBytes: 100 } });
    await expect(refused).rejects.toThrow(
      "Today's uploads to this workspace reached 100 bytes: nothing was saved. Try again in a few hours.",
    );
    await f.db
      .update(schema.artifactVersions)
      .set({ createdAt: sql`now() - interval '25 hours'` })
      .where(eq(schema.artifactVersions.artifactId, first.id));
    await upload(60);
    expect(await storageUsage(f.db, f.org.id)).toEqual({ usedBytes: 60, uploadBytes24h: 60 });
  });
});

describe("the platform's AI", () => {
  /** What Jev cost the workspace, billed to the platform, at `at`. */
  const spend = (usd: number, at = new Date()) =>
    f.db.insert(schema.usageRecords).values({
      orgId: f.org.id,
      kind: "router",
      provider: "typesafe",
      model: "jev-latest",
      requestedModel: "jev-latest",
      inputTokens: 1,
      outputTokens: 1,
      costNanoUsd: Math.round(usd * 1e9),
      billedTo: "platform",
      createdAt: at,
    });
  const question = { stop: { type: "noul" as const, instructions: "Stop?", criteria: { true: "yes", false: "no" } } };

  test("past the cap Jev isn't asked: the workspace's own model answers, and a calibrated question fails", async () => {
    f = await setup();
    const jev = createFakeJudge(() => 0.9);
    const llm = createFakeJudge(() => 0.2);
    const judge = withJudgeFallback(platformCapJudge(f.db, jev), llm);
    const ask = (calibrated?: boolean) =>
      judge.ask({ orgId: f.org.id, kind: "stop_request", state: { message: "para" }, questions: question, calibrated });

    expect((await ask()).stop?.noul).toBe(0.9);
    await limit({ platformUsdPerMonth: 3 });
    // Usage the workspace paid for itself never counts.
    await f.db.insert(schema.usageRecords).values({
      orgId: f.org.id,
      provider: "anthropic",
      model: "m",
      requestedModel: "m",
      inputTokens: 1,
      outputTokens: 1,
      costNanoUsd: 9e9,
    });
    await spend(2.99);
    expect((await ask()).stop?.noul).toBe(0.9);
    await spend(0.01);
    expect((await ask()).stop?.noul).toBe(0.2);
    await expect(ask(true)).rejects.toThrow("platform_cap");
    expect(jev.calls).toHaveLength(2);
    expect(llm.calls).toHaveLength(1);
    // A higher cap applies at once.
    await limit({ platformUsdPerMonth: 4 });
    expect((await ask()).stop?.noul).toBe(0.9);
  });

  test("the router starts nobody past the cap and says so; @mentions still start their agents", async () => {
    f = await setup();
    const decided: string[] = [];
    const strategy: RouterStrategy = {
      name: "jev",
      decide: async (input) => {
        decided.push(input.message.body);
        return { agents: [{ agentId: f.agent.id, score: 0.9 }] };
      },
    };
    const deps = {
      db: f.db,
      strategy,
      policy: { minScore: 0.5, maxAgents: 2, maxHops: 3 },
      platformCapReached: (orgId: string) => platformCapReached(f.db, orgId),
    };
    const post = (body: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
    await limit({ platformUsdPerMonth: 3 });
    await spend(3);

    const plain = await post("anyone around?");
    expect(await routeMessage(deps, { orgId: f.org.id, messageId: plain.id })).toEqual({
      runs: [],
      selected: [],
      reason: PLATFORM_CAP,
    });
    expect(decided).toEqual([]);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ messageId: plain.id, candidates: [], error: "platform_cap" });
    const listed = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(listed.find((m) => m.id === plain.id)?.receipts).toMatchObject({ platformCap: true, seenBy: [] });

    await post("@dev are you there?");
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);

    // Only Jev bills the platform: the router checks the cap only with Jev in its chain.
    const router = (jev: boolean) =>
      messageRouter({
        ...f.jobDeps,
        router: { enabled: true, model: "claude-haiku-5-5", ...(jev ? { jev: { key: "jev-test" } } : {}) },
      });
    expect(router(true)?.platformCapReached).toBeFunction();
    expect(router(false)?.platformCapReached).toBeUndefined();
  });

  test("the operator's feed hears 50% and 100% once per month", async () => {
    f = await setup();
    enableOperatorEvents();
    const events = async () =>
      (await f.db.select().from(schema.operatorEvents).where(eq(schema.operatorEvents.type, "platform_ai.threshold")))
        .map((e) => e.data)
        .sort((a, b) => Number(a.percent) - Number(b.percent) || String(a.month).localeCompare(String(b.month)));
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    await limit({ platformUsdPerMonth: 3 });
    await spend(1.2);
    expect(await platformCapReached(f.db, f.org.id)).toBe(false);
    expect(await events()).toEqual([]);
    await spend(0.4);
    expect(await platformCapReached(f.db, f.org.id)).toBe(false);
    expect(await platformCapReached(f.db, f.org.id)).toBe(false);
    expect(await events()).toEqual([{ month, percent: 50, spentUsd: 1.6, limitUsd: 3 }]);
    await spend(1.5);
    expect(await platformCapReached(f.db, f.org.id)).toBe(true);
    expect(await platformCapReached(f.db, f.org.id)).toBe(true);
    expect(await events()).toEqual([
      { month, percent: 50, spentUsd: 1.6, limitUsd: 3 },
      { month, percent: 100, spentUsd: 3.1, limitUsd: 3 },
    ]);

    // A new month starts from nothing, and is told again.
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
    expect(await platformCapReached(f.db, f.org.id, next)).toBe(false);
    await spend(2, next);
    expect(await platformCapReached(f.db, f.org.id, next)).toBe(false);
    expect((await events()).filter((e) => e.month === next.toISOString().slice(0, 7))).toEqual([
      { month: next.toISOString().slice(0, 7), percent: 50, spentUsd: 2, limitUsd: 3 },
    ]);
  });
});
