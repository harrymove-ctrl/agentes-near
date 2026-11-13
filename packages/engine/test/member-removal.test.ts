import { afterEach, beforeEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  changeMemberRole,
  createRole,
  declineSecret,
  deleteAccount,
  ForbiddenError,
  getSecretRequest,
  joinOrganization,
  openDm,
  openPersonAgentDm,
  postPersonMessage,
  removalPreview,
  removeMember,
  requireChannelAccess,
  setMemberRoles,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const MAC = {
  name: "mac",
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.9.0",
  workspace: "/Users/a/agentes",
  protocol: ACCOUNTS_PROTOCOL,
  exec: true,
};

const ACCOUNT_ID = "0193eeee-0000-4000-8000-000000000001";

const agentRow = async () => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!row) throw new Error("no agent");
  return row;
};

test("removing someone: their agents pass to the remover, their plan leaves the agents, back to the API", async () => {
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "mac",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.9.0",
    workspace: "/Users/a/agentes",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  await f.db.update(schema.machines).set({ pairedByUserId: null }).where(eq(schema.machines.id, machineId));
  await f.db.insert(schema.machineAccounts).values({
    id: ACCOUNT_ID,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Trabalho",
    email: "caio@example.com",
    status: "active",
    createdBy: caio.id,
  });
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: caio.id, machineId, brain: "claude_code", brainAccountId: ACCOUNT_ID })
    .where(eq(schema.agents.id, f.agent.id));

  const preview = await removalPreview(f.db, f.owner.id, f.org.id, caio.id);
  expect(preview).toEqual({
    heir: { userId: f.owner.id, name: f.owner.name },
    agents: [{ id: f.agent.id, name: f.agent.name }],
    losePlan: [{ id: f.agent.id, name: f.agent.name }],
    computers: [],
    routines: 0,
  });

  await removeMember(f.db, f.owner.id, f.org.id, caio.id, { pubsub: f.pubsub });
  const after = await agentRow();
  expect(after.ownerUserId).toBe(f.owner.id);
  expect(after.brain).toBe("model");
  expect(after.brainAccountId).toBeNull();
});

test("a remover who can't manage agents doesn't get the removed person's agents: the longest-standing owner does", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const rh = await createRole(f.db, f.owner.id, f.org.id, { name: "RH", permissions: ["manage_members"] });
  await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [rh.id]);
  await f.db.update(schema.agents).set({ ownerUserId: caio.id }).where(eq(schema.agents.id, f.agent.id));

  expect((await removalPreview(f.db, bia.id, f.org.id, caio.id))?.heir).toEqual({
    userId: f.owner.id,
    name: f.owner.name,
  });
  await removeMember(f.db, bia.id, f.org.id, caio.id);
  expect((await agentRow()).ownerUserId).toBe(f.owner.id);
});

test("leaving: the agents pass to the longest-standing other owner; the last owner can't leave", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const cy = await addMember(f.db, f.org.id, "member", "cy");
  await changeMemberRole(f.db, f.owner.id, f.org.id, bia.id, "owner");
  await f.db.update(schema.agents).set({ ownerUserId: cy.id }).where(eq(schema.agents.id, f.agent.id));

  expect((await removalPreview(f.db, cy.id, f.org.id, cy.id))?.heir?.userId).toBe(f.owner.id);
  await removeMember(f.db, cy.id, f.org.id, cy.id);
  expect((await agentRow()).ownerUserId).toBe(f.owner.id);

  // Two owners: one leaves, the other is then the last and can't.
  await removeMember(f.db, f.owner.id, f.org.id, f.owner.id);
  expect((await agentRow()).ownerUserId).toBe(bia.id);
  await expect(removeMember(f.db, bia.id, f.org.id, bia.id)).rejects.toBeInstanceOf(ConflictError);
});

test("only someone above removes a member, and the preview refuses the same", async () => {
  const admin = await addMember(f.db, f.org.id, "admin", "adm");
  const other = await addMember(f.db, f.org.id, "admin", "adm2");
  const dev = await addMember(f.db, f.org.id, "member", "dev");
  const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
  await setMemberRoles(f.db, f.owner.id, f.org.id, dev.id, [devs.id]);

  for (const [actor, target] of [
    [dev.id, admin.id],
    [admin.id, other.id],
    [admin.id, f.owner.id],
  ] as const) {
    await expect(removalPreview(f.db, actor, f.org.id, target)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMember(f.db, actor, f.org.id, target)).rejects.toBeInstanceOf(ForbiddenError);
  }
  expect(await removalPreview(f.db, admin.id, f.org.id, dev.id)).not.toBeNull();
  await removeMember(f.db, admin.id, f.org.id, dev.id);
  expect(await removalPreview(f.db, admin.id, f.org.id, dev.id)).toBeNull();
});

test("an agent thinking with the removed person's own computer goes back to the API, and open apps hear it", async () => {
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, MAC);
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: caio.id, machineId, brain: "claude_code", brainAccountId: null })
    .where(eq(schema.agents.id, f.agent.id));
  expect((await removalPreview(f.db, f.owner.id, f.org.id, caio.id))?.losePlan).toEqual([
    { id: f.agent.id, name: f.agent.name },
  ]);
  const told: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => told.push(e));

  await removeMember(f.db, f.owner.id, f.org.id, caio.id, { pubsub: f.pubsub });
  const after = await agentRow();
  expect(after).toMatchObject({ ownerUserId: f.owner.id, machineId: null, brain: "model", brainAccountId: null });
  expect(told).toContainEqual({
    type: "org.broadcast",
    orgId: f.org.id,
    event: { type: "org.members", agents: [f.agent.id] },
  });
  // Taken out by someone else: not quiet.
  expect(told.find((e) => e.type === "membership.revoked")).toEqual({
    type: "membership.revoked",
    orgId: f.org.id,
    userId: caio.id,
  });
});

for (const brain of ["cursor", "opencode"] as const) {
  test(`an agent on ${brain} with the removed person's plan goes back to the API too, from an account or their computer`, async () => {
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, MAC);
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: caio.id, machineId, brain, brainAccountId: null })
      .where(eq(schema.agents.id, f.agent.id));
    expect((await removalPreview(f.db, f.owner.id, f.org.id, caio.id))?.losePlan).toEqual([
      { id: f.agent.id, name: f.agent.name },
    ]);
    await removeMember(f.db, f.owner.id, f.org.id, caio.id, { pubsub: f.pubsub });
    expect(await agentRow()).toMatchObject({ ownerUserId: f.owner.id, machineId: null, brain: "model" });

    // On a computer nobody here signed in, with an account of theirs.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const mac = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { ...MAC, name: "mac2" });
    await f.db.update(schema.machines).set({ pairedByUserId: null }).where(eq(schema.machines.id, mac.machineId));
    await f.db.insert(schema.machineAccounts).values({
      id: ACCOUNT_ID,
      orgId: f.org.id,
      machineId: mac.machineId,
      kind: brain,
      label: "Trabalho",
      status: "active",
      createdBy: bia.id,
    });
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bia.id, machineId: mac.machineId, brain, brainAccountId: ACCOUNT_ID })
      .where(eq(schema.agents.id, f.agent.id));
    await removeMember(f.db, f.owner.id, f.org.id, bia.id, { pubsub: f.pubsub });
    expect(await agentRow()).toMatchObject({ machineId: mac.machineId, brain: "model", brainAccountId: null });
  });

  test(`deleting the account: an agent on ${brain} with their computer's own sign-in goes back to the API`, async () => {
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, MAC);
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: caio.id, machineId, brain, brainAccountId: null })
      .where(eq(schema.agents.id, f.agent.id));
    const told: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => told.push(e));

    await deleteAccount(f.db, caio.id, { pubsub: f.pubsub });
    expect(await agentRow()).toMatchObject({ machineId: null, brain: "model", brainAccountId: null });
    expect(told).toContainEqual({
      type: "org.broadcast",
      orgId: f.org.id,
      event: { type: "org.members", agents: [f.agent.id] },
    });
  });
}

test("deleting the account: their agents on a plan someone else's computer gives go back to the API too", async () => {
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, MAC);
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: caio.id, machineId, brain: "opencode", brainAccountId: null })
    .where(eq(schema.agents.id, f.agent.id));

  await deleteAccount(f.db, caio.id, { pubsub: f.pubsub });
  // No owner now, so no plan thinks for it; the computer stays (it isn't theirs).
  expect(await agentRow()).toMatchObject({ ownerUserId: null, machineId, brain: "model", brainAccountId: null });
});

test("leaving on one's own is quiet, and the agents skip a blocked owner", async () => {
  const blocked = await addMember(f.db, f.org.id, "member", "old");
  await changeMemberRole(f.db, f.owner.id, f.org.id, blocked.id, "owner");
  // The longest-standing other owner, but blocked: can't sign in.
  await f.db
    .update(schema.organizationMembers)
    .set({ createdAt: new Date(0) })
    .where(eq(schema.organizationMembers.userId, blocked.id));
  await f.db.update(schema.users).set({ blockedAt: new Date() }).where(eq(schema.users.id, blocked.id));
  const cy = await addMember(f.db, f.org.id, "member", "cy");
  await f.db.update(schema.agents).set({ ownerUserId: cy.id }).where(eq(schema.agents.id, f.agent.id));
  const told: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => told.push(e));

  await removeMember(f.db, cy.id, f.org.id, cy.id, { pubsub: f.pubsub });
  expect((await agentRow()).ownerUserId).toBe(f.owner.id);
  expect(told).toContainEqual({ type: "membership.revoked", orgId: f.org.id, userId: cy.id, quiet: true });
});

test("someone removed and invited back is back in their DMs once one is opened again", async () => {
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const withAgent = await openDm(f.db, caio.id, f.org.id, { agentId: f.agent.id });
  const withAna = await openDm(f.db, ana.id, f.org.id, { userId: caio.id });
  await removeMember(f.db, f.owner.id, f.org.id, caio.id);
  await f.db.insert(schema.organizationMembers).values({ orgId: f.org.id, userId: caio.id, role: "member" });

  expect((await openDm(f.db, caio.id, f.org.id, { agentId: f.agent.id })).id).toBe(withAgent.id);
  expect((await requireChannelAccess(f.db, caio.id, f.org.id, withAgent.id)).channel.id).toBe(withAgent.id);
  expect((await openDm(f.db, ana.id, f.org.id, { userId: caio.id })).id).toBe(withAna.id);
  expect((await requireChannelAccess(f.db, caio.id, f.org.id, withAna.id)).channel.id).toBe(withAna.id);
});

test("someone invited back is back in the DMs whose other people are still here, before anyone opens them", async () => {
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const dora = await addMember(f.db, f.org.id, "member", "dora");
  const withAna = await openDm(f.db, ana.id, f.org.id, { userId: caio.id });
  const withDora = await openDm(f.db, dora.id, f.org.id, { userId: caio.id });
  const withAgent = await openPersonAgentDm(f.db, f.org.id, caio.id, f.agent.id);
  await removeMember(f.db, f.owner.id, f.org.id, caio.id);
  await removeMember(f.db, f.owner.id, f.org.id, dora.id);
  await f.db.transaction((tx) => joinOrganization(tx, f.org.id, caio.id, "member"));

  const has = async (channelId: string) =>
    (
      await f.db
        .select()
        .from(schema.channelMembers)
        .where(and(eq(schema.channelMembers.channelId, channelId), eq(schema.channelMembers.userId, caio.id)))
    ).length;
  expect(await has(withAna.id)).toBe(1);
  expect(await has(withAgent.id)).toBe(1);
  expect(await has(withDora.id)).toBe(0);
});

test("an agent's DM with someone removed and back takes them in again; not while they're out", async () => {
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const dm = await openPersonAgentDm(f.db, f.org.id, caio.id, f.agent.id);
  await removeMember(f.db, f.owner.id, f.org.id, caio.id);
  await openPersonAgentDm(f.db, f.org.id, caio.id, f.agent.id);
  const inDm = () =>
    f.db
      .select()
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, dm.id), eq(schema.channelMembers.userId, caio.id)));
  expect(await inDm()).toHaveLength(0);

  await f.db.insert(schema.organizationMembers).values({ orgId: f.org.id, userId: caio.id, role: "member" });
  await openPersonAgentDm(f.db, f.org.id, caio.id, f.agent.id);
  expect(await inDm()).toHaveLength(1);
});

test("someone removed can't read or answer an agent's secret request, and the ones waiting on them close", async () => {
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  const [request] = await f.db
    .insert(schema.secretRequests)
    .values({
      orgId: f.org.id,
      runId: run?.id ?? "",
      agentId: f.agent.id,
      channelId: f.general.id,
      toolUseId: "tool-npm",
      requestedForUserId: caio.id,
      name: "NPM_TOKEN",
      purpose: "publicar o pacote",
      targetKind: "env",
      publicKey: "pk",
      expiresAt: new Date(Date.now() + 15 * 60_000),
    })
    .returning();
  if (!request) throw new Error("no request");
  expect((await getSecretRequest(f.db, caio.id, f.org.id, request.id)).status).toBe("pending");

  await removeMember(f.db, f.owner.id, f.org.id, caio.id);
  const [after] = await f.db.select().from(schema.secretRequests).where(eq(schema.secretRequests.id, request.id));
  expect(after?.status).toBe("canceled");
  await expect(getSecretRequest(f.db, caio.id, f.org.id, request.id)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(declineSecret({ db: f.db }, caio.id, f.org.id, request.id)).rejects.toBeInstanceOf(ForbiddenError);
});
