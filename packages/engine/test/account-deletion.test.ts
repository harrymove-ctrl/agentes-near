import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  archiveAgent,
  createLocalKeyWrapper,
  createOrganization,
  deleteAccount,
  enableOperatorEvents,
  MACHINE_CONTROL_TOPIC,
  postPersonMessage,
  purgeWorkspace,
  registerPushDevice,
  scheduleDeletion,
  sealSecret,
  setDeletionHold,
  setOrgStanding,
  UnauthorizedError,
  USER_FILES_PURGE_JOB,
  workspaceContents,
} from "../src";
import { addMember, addUser, type Fixture, makeAdmin, SECRET, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  enableOperatorEvents(false);
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DAY = 86_400_000;
const PUBLIC_URL = "https://chat.example.com";
/** What the route gives `deleteAccount` here: the fixture's pub/sub, on a server that emails and has a support address. */
const deps = () => ({ pubsub: f.pubsub, emails: { publicUrl: PUBLIC_URL, support: "help@example.com" } });
const orgRow = async (orgId = f.org.id) =>
  (await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)))[0] ?? null;
const userRow = async (userId: string) =>
  (await f.db.select().from(schema.users).where(eq(schema.users.id, userId)))[0] ?? null;
const jobs = (kind: string) => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, kind));
const feedOf = (type: string) => f.db.select().from(schema.operatorEvents).where(eq(schema.operatorEvents.type, type));
const auditOf = (action: string) => f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));
const membersOf = async (orgId: string) =>
  (
    await f.db
      .select({ userId: schema.organizationMembers.userId })
      .from(schema.organizationMembers)
      .where(eq(schema.organizationMembers.orgId, orgId))
  ).map((m) => m.userId);
/** The database wrote the date: a test moves it back to make the purge due. */
const pastItsDate = (orgId: string) =>
  f.db
    .update(schema.organizations)
    .set({ deletionDueAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.organizations.id, orgId));
/** What the computers' sockets are told from now on, wherever they are (`MACHINE_CONTROL_TOPIC`). */
function toComputers() {
  const signals: RealtimeEvent[] = [];
  f.pubsub.subscribe(MACHINE_CONTROL_TOPIC, (e) => signals.push(e));
  return signals;
}
/** A computer `userId` connected in `orgId`; `kept`: a server an admin marked the workspace's, which stays. */
async function computer(userId: string, name: string, options: { kept?: boolean; orgId?: string } = {}) {
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, userId, options.orgId ?? f.org.id, { name });
  if (options.kept) {
    await f.db
      .update(schema.machines)
      .set({ executors: { mode: "system" }, belongsToWorkspace: true })
      .where(eq(schema.machines.id, machineId));
  }
  return machineId;
}
const aiAccount = (machineId: string, createdBy: string) =>
  f.db.insert(schema.machineAccounts).values({
    id: crypto.randomUUID(),
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Claude Max",
    status: "active",
    createdBy,
  });
const removedComputers = async () =>
  (await f.db.select().from(schema.machines).orderBy(schema.machines.createdAt)).map((m) => [
    m.name,
    m.deletedAt !== null,
  ]);
const agentComputer = async () =>
  (await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id)))[0]?.machineId;

describe("deleting an account", () => {
  test("the preflight's counts: the agents still working there and the messages people can read", async () => {
    f = await setup();
    const before = (await workspaceContents(f.db, [f.org.id])).get(f.org.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "oi" });
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);
    expect((await workspaceContents(f.db, [f.org.id])).get(f.org.id)).toEqual({
      agents: (before?.agents ?? 0) - 1,
      messages: (before?.messages ?? 0) + 1,
    });
  });

  test("the preflight counts agents as the workspace does: an unused one holds none, its right hand aside", async () => {
    f = await setup({ rightHand: true });
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);
    expect((await workspaceContents(f.db, [f.org.id])).get(f.org.id)?.agents).toBe(0);
  });

  test("refused for the only owner of a workspace with others in it, with its name and id; nothing changes", async () => {
    f = await setup();
    enableOperatorEvents();
    await addMember(f.db, f.org.id, "member", "bia");
    const outbox = await f.db.select().from(schema.outbox);
    await expect(deleteAccount(f.db, f.owner.id, deps())).rejects.toMatchObject({
      code: "sole_owner",
      params: { organizations: ["Acme"], orgIds: [f.org.id] },
    });
    expect(await userRow(f.owner.id)).not.toBeNull();
    expect((await orgRow())?.deletionDueAt).toBeNull();
    expect(await f.db.select().from(schema.outbox)).toEqual(outbox);
    expect(await feedOf("user.deleted")).toEqual([]);
  });

  test("a member leaves every workspace: memberships and phones go, messages stay without an author, the logs say why", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const { organization: two } = await createOrganization(f.db, f.owner.id, { name: "Two" });
    await f.db.insert(schema.organizationMembers).values({ orgId: two.id, userId: bia.id, role: "member" });
    await makeAdmin(f.db, two.id, bia.id);
    await registerPushDevice(f.db, bia.id, {
      token: "ExponentPushToken[bia-phone-0001]",
      platform: "ios",
      locale: "en",
    });
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, { body: "bye" });

    await deleteAccount(f.db, bia.id, deps());
    expect(await userRow(bia.id)).toBeNull();
    expect(await f.db.select().from(schema.pushDevices)).toEqual([]);
    expect(await membersOf(f.org.id)).toEqual([f.owner.id]);
    expect(await membersOf(two.id)).toEqual([f.owner.id]);
    const [kept] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, m.id));
    expect(kept).toMatchObject({ body: "bye", authorType: "person", authorUserId: null });
    const left = (await auditOf("member.left")).map((a) => [a.orgId, a.actorId, a.details]);
    const person = { name: "bia", email: bia.email, accountDeleted: true };
    expect(left).toEqual([
      [f.org.id, bia.id, { ...person, role: "member" }],
      [two.id, bia.id, { ...person, role: "member" }],
    ]);
    // Workspaces with others in them stay open.
    expect((await orgRow())?.deletionDueAt).toBeNull();
    expect((await orgRow(two.id))?.deletionDueAt).toBeNull();
  });

  test("workspaces only they are in close and go later, not now: their work stops, their AI accounts leave the computers, and the feed says the account asked", async () => {
    f = await setup();
    enableOperatorEvents();
    await f.db.insert(schema.organizationSettings).values({ orgId: f.org.id, timezone: "America/Sao_Paulo" });
    const machineId = await computer(f.owner.id, "mac");
    await aiAccount(machineId, f.owner.id);
    const { organization: two } = await createOrganization(f.db, f.owner.id, { name: "Two" });
    // Already being deleted: it keeps its date.
    const earlier = await scheduleDeletion({ db: f.db }, f.owner.id, two.id, "owner");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev check the build",
    });
    const signals = toComputers();
    const told: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => told.push(e));

    await deleteAccount(f.db, f.owner.id, deps());
    expect(await userRow(f.owner.id)).toBeNull();
    expect(await f.db.select({ status: schema.agentRuns.status }).from(schema.agentRuns)).toEqual([
      { status: "canceled" },
    ]);
    expect(told).toContainEqual({ type: "membership.revoked", orgId: f.org.id, userId: f.owner.id, quiet: true });
    expect(told).toContainEqual(
      expect.objectContaining({ type: "org.broadcast", event: expect.objectContaining({ type: "org.deleting" }) }),
    );
    const row = await orgRow();
    const dueAt = row?.deletionDueAt?.getTime() ?? 0;
    expect(Math.abs(dueAt - Date.now() - 7 * DAY)).toBeLessThan(60_000);
    expect(row?.deletionRequestedBy).toBeNull();
    expect((await orgRow(two.id))?.deletionDueAt).toEqual(earlier.dueAt);
    expect(signals).toContainEqual({ type: "machine.accounts", machineId });
    expect(signals).not.toContainEqual({ type: "machine.revoke", machineId });
    expect(await f.db.select().from(schema.machineAccounts)).toMatchObject([{ machineId, status: "removing" }]);
    const due = new Date(dueAt).toISOString();
    expect(await feedOf("organization.deletion_requested")).toMatchObject([
      { orgId: two.id, userId: f.owner.id, data: { via: "owner" } },
      { orgId: f.org.id, userId: f.owner.id, data: { dueAt: due, via: "account" } },
    ]);
    expect(await feedOf("organization.deleted")).toEqual([]);
    const emails = (await jobs("email.send")).map((j) => j.payload.template);
    expect(emails).toEqual([
      {
        kind: "account_deleted",
        locale: "pt-BR",
        email: f.owner.email,
        orgNames: ["Acme"],
        dueAt: due,
        timeZone: "America/Sao_Paulo",
        support: "help@example.com",
        url: PUBLIC_URL,
      },
    ]);

    await pastItsDate(f.org.id);
    expect(await purgeWorkspace({ db: f.db, pubsub: f.pubsub }, f.org.id)).toBe(true);
    expect(await feedOf("organization.deleted")).toMatchObject([
      { orgId: f.org.id, userId: null, data: { via: "account" } },
    ]);
  });

  test("a hold or a suspension keeps no account: the workspace closes with it and its purge waits; a deletion hold neither", async () => {
    f = await setup();
    const bia = await addUser(f.db, "bia");
    const cy = await addUser(f.db, "cy");
    const { organization: suspended } = await createOrganization(f.db, bia.id, { name: "Suspended" });
    const { organization: held } = await createOrganization(f.db, cy.id, { name: "Held" });
    await setOrgStanding({ db: f.db }, suspended.id, { state: "suspended", reason: "abuse", notice: "shown" });
    await setOrgStanding({ db: f.db }, held.id, { state: "hold", reason: "review", notice: "silent" });
    const dan = await addMember(f.db, f.org.id, "member", "dan");
    await setDeletionHold(f.db, f.org.id, { held: true, reason: "legal_hold" });

    for (const person of [bia, cy, dan]) await deleteAccount(f.db, person.id);
    for (const person of [bia, cy, dan]) expect(await userRow(person.id)).toBeNull();
    for (const orgId of [suspended.id, held.id]) {
      expect((await orgRow(orgId))?.deletionDueAt).toBeInstanceOf(Date);
      await pastItsDate(orgId);
      expect(await purgeWorkspace({ db: f.db }, orgId)).toBe(false);
      expect(await orgRow(orgId)).not.toBeNull();
    }
    expect((await orgRow())?.deletionDueAt).toBeNull();
  });

  test("the only owner of a workspace being deleted goes, the others stay in it; the server's owner too: the Jev and GIPHY keys and the GitHub App they made go, the pin stays", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const sealed = await sealSecret(createLocalKeyWrapper(SECRET), "ts_saved_key_1", "jev");
    await f.db.insert(schema.instanceSecrets).values({ name: "typesafe", ...sealed, keyHint: "ey_1" });
    await f.db.insert(schema.instanceSecrets).values({ name: "giphy", ...sealed, keyHint: "ey_1" });
    await f.db
      .insert(schema.instanceSecrets)
      .values({ name: "github_app", ...sealed, keyHint: "agentes-chat-example" });
    const { dueAt } = await scheduleDeletion({ db: f.db }, f.owner.id, f.org.id, "owner");

    await deleteAccount(f.db, f.owner.id);
    expect(await userRow(f.owner.id)).toBeNull();
    expect((await orgRow())?.deletionDueAt).toEqual(dueAt);
    expect(await membersOf(f.org.id)).toEqual([bia.id]);
    expect(await f.db.select().from(schema.instanceSecrets)).toEqual([]);
    expect((await f.db.select().from(schema.instanceTelemetry))[0]?.ownerUserId).toBe(f.owner.id);
  });

  test("the computers they connected where they leave go, one marked the workspace's stays; the early-access row stays; the feed, the email and the photos' purge go out with it", async () => {
    f = await setup();
    enableOperatorEvents();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const laptop = await computer(bia.id, "Bia's laptop");
    const server = await computer(bia.id, "Team server", { kept: true });
    await f.db.update(schema.agents).set({ machineId: laptop }).where(eq(schema.agents.id, f.agent.id));
    await f.db.insert(schema.earlyAccessInvitations).values({
      email: bia.email,
      sentAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * DAY),
      usedAt: new Date(),
      userId: bia.id,
    });
    const signals = toComputers();

    await deleteAccount(f.db, bia.id, deps());
    expect(await removedComputers()).toEqual([
      ["Bia's laptop", true],
      ["Team server", false],
    ]);
    expect(signals).toContainEqual({ type: "machine.revoke", machineId: laptop });
    expect(signals).not.toContainEqual({ type: "machine.revoke", machineId: server });
    expect(await agentComputer()).toBeNull();
    expect(await auditOf("machine.deleted")).toMatchObject([
      { orgId: f.org.id, actorId: bia.id, targetId: laptop, details: { name: "Bia's laptop", agents: [f.agent.id] } },
    ]);
    expect(await f.db.select().from(schema.earlyAccessInvitations)).toMatchObject([{ email: bia.email, userId: null }]);
    expect(await feedOf("user.deleted")).toMatchObject([{ orgId: null, userId: bia.id }]);
    expect((await jobs(USER_FILES_PURGE_JOB)).map((j) => [j.orgId, j.payload])).toEqual([[null, { userId: bia.id }]]);
    expect(await jobs("email.send")).toMatchObject([
      {
        orgId: null,
        payload: {
          to: [bia.email],
          template: {
            kind: "account_deleted",
            email: bia.email,
            orgNames: [],
            dueAt: null,
            support: "help@example.com",
          },
        },
      },
    ]);
  });

  test("a workspace for an account that is gone: 401, not a database error", async () => {
    f = await setup();
    const bia = await addUser(f.db, "bia");
    await deleteAccount(f.db, bia.id);
    await expect(createOrganization(f.db, bia.id, { name: "Late" })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(createOrganization(f.db, bia.id, { name: "Late" }, { onboarding: true })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});
