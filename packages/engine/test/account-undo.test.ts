import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import {
  ACCOUNT_DELETE_JOB,
  ACCOUNT_DELETION_DAYS,
  accountDeletionPlan,
  addChannelMember,
  approverIds,
  changeMemberRole,
  createOrganization,
  enableOperatorEvents,
  enqueueOverdueAccountDeletions,
  getMembership,
  listMembers,
  listMemberships,
  openDm,
  purgeAccount,
  purgeWorkspace,
  queueEmail,
  registerPushDevice,
  removeMember,
  restoreAccount,
  scheduleAccountDeletion,
  scheduleDeletion,
  setOrgStanding,
  setUserBlocked,
} from "../src";
import { addMember, addUser, type Fixture, makeAdmin, setup } from "./fixtures";
import { channelRoutine, fire, routineRow } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  enableOperatorEvents(false);
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const DAY = 86_400_000;
const emails = { publicUrl: "https://chat.example.com", support: "help@example.com" };
const deps = () => ({ db: f.db, pubsub: f.pubsub, emails });
const userRow = async (id: string) =>
  (await f.db.select().from(schema.users).where(eq(schema.users.id, id)))[0] ?? null;
const orgRow = async (id: string) =>
  (await f.db.select().from(schema.organizations).where(eq(schema.organizations.id, id)))[0] ?? null;
const jobs = (kind: string) => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, kind));
const feedOf = (type: string) => f.db.select().from(schema.operatorEvents).where(eq(schema.operatorEvents.type, type));
const pastDue = (userId: string) =>
  f.db
    .update(schema.users)
    .set({ deletionDueAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.users.id, userId));
const emailsTo = async (address: string) =>
  (await jobs("email.send"))
    .map((j) => j.payload as { to: string[]; template: { kind: string } })
    .filter((p) => p.to.includes(address))
    .map((p) => p.template.kind);

/** The fixture's owner, whose workspace has a member, and a workspace of that member's alone. */
async function aMemberWithTheirOwn() {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const { organization: own } = await createOrganization(f.db, bia.id, { name: "Bia's" });
  return { bia, own };
}

describe("scheduling", () => {
  test("nothing is deleted yet: memberships and sign-ins wait, sessions and phones end, nobody finds them", async () => {
    const { bia, own } = await aMemberWithTheirOwn();
    enableOperatorEvents();
    await registerPushDevice(f.db, bia.id, { token: "ExponentPushToken[bia-0001]", platform: "ios", locale: "en" });
    await f.db.insert(schema.sessions).values({
      id: "s1",
      token: "t1",
      userId: bia.id,
      expiresAt: new Date(Date.now() + DAY),
    });
    await f.db
      .insert(schema.accounts)
      .values({ id: "a1", accountId: "google-sub", providerId: "google", userId: bia.id });
    const heard: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => heard.push(e));

    const { dueAt } = await scheduleAccountDeletion(deps(), bia.id);

    expect(Math.abs(dueAt.getTime() - Date.now() - ACCOUNT_DELETION_DAYS * DAY)).toBeLessThan(60_000);
    expect(await userRow(bia.id)).toMatchObject({ deletionDueAt: dueAt });
    expect(await f.db.select().from(schema.sessions).where(eq(schema.sessions.userId, bia.id))).toEqual([]);
    expect(await f.db.select().from(schema.pushDevices)).toEqual([]);
    expect(await f.db.select().from(schema.accounts).where(eq(schema.accounts.userId, bia.id))).toHaveLength(1);
    expect(await f.db.select().from(schema.organizationMembers)).toHaveLength(3);

    expect(await getMembership(f.db, bia.id, f.org.id)).toBeNull();
    expect(await listMemberships(f.db, bia.id)).toEqual([]);
    expect((await listMembers(f.db, f.org.id)).map((m) => m.userId)).toEqual([f.owner.id]);
    await expect(openDm(f.db, f.owner.id, f.org.id, { userId: bia.id })).rejects.toThrow();
    expect(heard.some((e) => e.type === "membership.revoked")).toBe(true);

    expect(
      await registerPushDevice(f.db, bia.id, { token: "ExponentPushToken[bia-0002]", platform: "ios", locale: "en" }),
    ).toBe(false);
    expect((await feedOf("user.deletion_requested")).map((e) => e.userId)).toEqual([bia.id]);
    expect(await feedOf("user.deleted")).toEqual([]);
    expect(await emailsTo(bia.email)).toEqual(["account_deleting"]);
    const [job] = await jobs(ACCOUNT_DELETE_JOB);
    expect(job?.nextAttemptAt).toEqual(dueAt);
    expect((await orgRow(own.id))?.deletionDueAt).toEqual(dueAt);
  });

  test("no other email reaches them, only what they asked for and what they must be told", async () => {
    const { bia } = await aMemberWithTheirOwn();
    await scheduleAccountDeletion(deps(), bia.id);
    const template = { kind: "budget", level: "warning", agentName: "x", spent: "1", limit: "2", url: "https://x" };
    const q = (key: string, t: unknown, to = [bia.email]) =>
      queueEmail(f.db, { orgId: null, key, to, template: t as never });
    await q("a", template);
    await q("b", { kind: "password_reset", url: "https://x" });
    await q("c", template, [bia.email.toUpperCase(), "someone@example.com"]);
    const payloads = (await jobs("email.send")).map((j) => j.payload as { key: string; to: string[] });
    expect(payloads.map((p) => p.key)).not.toContain("a");
    expect(payloads.find((p) => p.key === "b")?.to).toEqual([bia.email]);
    expect(payloads.find((p) => p.key === "c")?.to).toEqual(["someone@example.com"]);
  });

  test("the only owner of a workspace with others can't, as today; again keeps its date; a blocked account can't", async () => {
    const { bia } = await aMemberWithTheirOwn();
    await expect(scheduleAccountDeletion(deps(), f.owner.id)).rejects.toMatchObject({ code: "sole_owner" });
    expect((await userRow(f.owner.id))?.deletionDueAt).toBeNull();

    const { dueAt } = await scheduleAccountDeletion(deps(), bia.id);
    expect((await scheduleAccountDeletion(deps(), bia.id)).dueAt).toEqual(dueAt);
    expect(await jobs(ACCOUNT_DELETE_JOB)).toHaveLength(1);

    const cleo = await addUser(f.db, "cleo");
    await setUserBlocked({ db: f.db }, cleo.id, { blocked: true, reason: null });
    await expect(scheduleAccountDeletion(deps(), cleo.id)).rejects.toThrow();
  });

  test("an owner waiting for their date owns nothing: the other owner is the last one, and can't leave it ownerless", async () => {
    f = await setup();
    const co = await addMember(f.db, f.org.id, "owner", "co");
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await scheduleAccountDeletion(deps(), f.owner.id);
    expect((await accountDeletionPlan(f.db, co.id)).soleOwner.map((o) => o.id)).toEqual([f.org.id]);
    await expect(scheduleAccountDeletion(deps(), co.id)).rejects.toMatchObject({ code: "sole_owner" });
    await expect(changeMemberRole(f.db, co.id, f.org.id, co.id, "member")).rejects.toThrow();
    await expect(removeMember(f.db, co.id, f.org.id, co.id)).rejects.toThrow();

    // Everyone else leaving: the last person in use closes it, and the first account's date doesn't reopen it.
    await removeMember(f.db, co.id, f.org.id, member.id);
    expect((await accountDeletionPlan(f.db, co.id)).closes.map((o) => o.id)).toEqual([f.org.id]);
  });

  test("a workspace being deleted already keeps its own date, and is no longer the account's to bring back", async () => {
    const { bia, own } = await aMemberWithTheirOwn();
    const { dueAt: first } = await scheduleDeletion(deps(), bia.id, own.id, "owner");
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(first.getTime() - DAY) })
      .where(eq(schema.organizations.id, own.id));
    const { dueAt } = await scheduleAccountDeletion(deps(), bia.id);
    const earlier = (await orgRow(own.id))?.deletionDueAt;
    expect(earlier?.getTime()).toBeLessThan(dueAt.getTime());
    await restoreAccount(deps(), bia.id);
    expect((await orgRow(own.id))?.deletionDueAt).toEqual(earlier ?? null);
  });
});

describe("while it waits", () => {
  test("an approval named to them goes to who can answer", async () => {
    const { bia } = await aMemberWithTheirOwn();
    const named = { orgId: f.org.id, ownerUserId: null, approvers: { userIds: [bia.id] } } as never;
    expect(await approverIds(f.db, named)).toEqual([bia.id]);
    await scheduleAccountDeletion(deps(), bia.id);
    expect(await approverIds(f.db, named)).not.toContain(bia.id);
  });

  test("a routine of theirs passes its slot and keeps its schedule: restoring finds it running", async () => {
    const { bia } = await aMemberWithTheirOwn();
    await makeAdmin(f.db, f.org.id, bia.id);
    const routine = await channelRoutine(f, {}, bia.id);
    await scheduleAccountDeletion(deps(), bia.id);
    expect(await fire(f, routine.id, new Date())).toMatchObject({ status: "skipped", code: "creator_left" });
    expect(await routineRow(f, routine.id)).toMatchObject({ active: true, pausedReason: null });
    await restoreAccount(deps(), bia.id);
    expect(await fire(f, routine.id, new Date(Date.now() + 1000))).not.toMatchObject({ status: "skipped" });
  });
});

describe("restoring", () => {
  test("it is all back, workspace included, and the feed says the account brought it, so no plan renews by itself", async () => {
    const { bia, own } = await aMemberWithTheirOwn();
    enableOperatorEvents();
    await scheduleAccountDeletion(deps(), bia.id);
    await restoreAccount(deps(), bia.id);
    expect(await userRow(bia.id)).toMatchObject({ deletionDueAt: null, deletionRequestedAt: null });
    expect((await orgRow(own.id))?.deletionDueAt).toBeNull();
    expect(await getMembership(f.db, bia.id, f.org.id)).not.toBeNull();
    expect((await feedOf("user.deletion_canceled")).map((e) => e.userId)).toEqual([bia.id]);
    expect((await feedOf("organization.deletion_canceled")).map((e) => e.data)).toEqual([{ via: "account" }]);
  });

  test("twice is refused and changes nothing; the first date's job finds nothing, deleted again or not", async () => {
    const { bia } = await aMemberWithTheirOwn();
    enableOperatorEvents();
    await scheduleAccountDeletion(deps(), bia.id);
    await restoreAccount(deps(), bia.id);
    await expect(restoreAccount(deps(), bia.id)).rejects.toMatchObject({ code: "account.not_restorable" });
    expect(await feedOf("user.deletion_canceled")).toHaveLength(1);
    expect(await purgeAccount(deps(), bia.id)).toBe(false);
    expect(await userRow(bia.id)).not.toBeNull();

    const again = await scheduleAccountDeletion(deps(), bia.id);
    expect(await purgeAccount(deps(), bia.id)).toBe(false);
    expect((await userRow(bia.id))?.deletionDueAt).toEqual(again.dueAt);
    expect(await jobs(ACCOUNT_DELETE_JOB)).toHaveLength(2);
  });

  test("a suspended workspace stays closed; the account still comes back", async () => {
    const { bia, own } = await aMemberWithTheirOwn();
    await scheduleAccountDeletion(deps(), bia.id);
    await setOrgStanding({ db: f.db }, own.id, { state: "suspended", reason: null, notice: "silent" });
    await restoreAccount(deps(), bia.id);
    expect((await userRow(bia.id))?.deletionDueAt).toBeNull();
    expect((await orgRow(own.id))?.deletionDueAt).not.toBeNull();
  });

  test("the date is the point of no return, both ways", async () => {
    const { bia } = await aMemberWithTheirOwn();
    await scheduleAccountDeletion(deps(), bia.id);
    // Before the date the job does nothing.
    expect(await purgeAccount(deps(), bia.id)).toBe(false);
    expect(await userRow(bia.id)).not.toBeNull();
    await pastDue(bia.id);
    await expect(restoreAccount(deps(), bia.id)).rejects.toMatchObject({ code: "account.not_restorable" });
    expect(await purgeAccount(deps(), bia.id)).toBe(true);
    expect(await userRow(bia.id)).toBeNull();
  });
});

describe("at the date", () => {
  test("the job deletes exactly as before, tells them it's done, and Apple's sign-in is revoked after", async () => {
    const { bia, own } = await aMemberWithTheirOwn();
    enableOperatorEvents();
    await makeAdmin(f.db, f.org.id, bia.id);
    await f.db
      .insert(schema.accounts)
      .values({ id: "a1", accountId: "apple-sub", providerId: "apple", userId: bia.id, refreshToken: "r1" });
    const revoked: unknown[] = [];
    const appleRevoke = async (token: unknown) => {
      revoked.push(token);
    };
    await scheduleAccountDeletion(deps(), bia.id);
    await pastDue(bia.id);
    expect(await purgeAccount({ ...deps(), appleRevoke }, bia.id)).toBe(true);
    expect(await userRow(bia.id)).toBeNull();
    expect(revoked).toEqual([{ value: "r1", hint: "refresh_token" }]);
    expect((await feedOf("user.deleted")).map((e) => e.userId)).toEqual([bia.id]);
    expect(await emailsTo(bia.email)).toEqual(["account_deleting", "account_deleted"]);
    // Its workspace goes by its own job, and either order works.
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.organizations.id, own.id));
    expect(await purgeWorkspace({ db: f.db, pubsub: f.pubsub }, own.id)).toBe(true);
    expect(await orgRow(own.id)).toBeNull();
  });

  test("a failure midway leaves everything as it was, still restorable by no one and deleted on the next try", async () => {
    const { bia } = await aMemberWithTheirOwn();
    await f.db
      .insert(schema.accounts)
      .values({ id: "a1", accountId: "s", providerId: "apple", userId: bia.id, refreshToken: "r1" });
    const revoked: unknown[] = [];
    const appleRevoke = async (token: unknown) => {
      revoked.push(token);
    };
    await scheduleAccountDeletion(deps(), bia.id);
    await pastDue(bia.id);
    await f.db.execute(sql`create function refuse() returns trigger language plpgsql as
      $$ begin raise exception 'the disk is full'; end $$`);
    await f.db.execute(sql`create trigger refuse before delete on users for each row execute function refuse()`);

    await expect(purgeAccount({ ...deps(), appleRevoke }, bia.id)).rejects.toThrow();
    expect(await userRow(bia.id)).not.toBeNull();
    expect(await f.db.select().from(schema.accounts).where(eq(schema.accounts.userId, bia.id))).toHaveLength(1);
    expect(
      await f.db.select().from(schema.organizationMembers).where(eq(schema.organizationMembers.userId, bia.id)),
    ).toHaveLength(2);
    expect(revoked).toEqual([]);
    expect(await emailsTo(bia.email)).toEqual(["account_deleting"]);

    await f.db.execute(sql`drop trigger refuse on users`);
    expect(await purgeAccount({ ...deps(), appleRevoke }, bia.id)).toBe(true);
    expect(revoked).toHaveLength(1);
  });

  test("the workspace can go first; a blocked account waits; the hourly sweep finds what a deploy lost", async () => {
    const { bia, own } = await aMemberWithTheirOwn();
    await scheduleAccountDeletion(deps(), bia.id);
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.organizations.id, own.id));
    expect(await purgeWorkspace({ db: f.db, pubsub: f.pubsub }, own.id)).toBe(true);
    await pastDue(bia.id);
    await setUserBlocked({ db: f.db }, bia.id, { blocked: true, reason: null });
    expect(await enqueueOverdueAccountDeletions(f.db)).toBe(0);
    expect(await purgeAccount(deps(), bia.id)).toBe(false);
    await setUserBlocked({ db: f.db }, bia.id, { blocked: false, reason: null });
    expect(await enqueueOverdueAccountDeletions(f.db)).toBe(1);
    expect(await jobs(ACCOUNT_DELETE_JOB)).toHaveLength(2);
    expect(await purgeAccount(deps(), bia.id)).toBe(true);
  });
});
