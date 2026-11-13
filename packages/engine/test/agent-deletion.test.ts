import { afterEach, describe, expect, test } from "bun:test";
import { CLAUDE_SHARED_PROTOCOL, channelTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  agentsByHandle,
  archiveAgent,
  createAgent,
  deleteAgent,
  deletedAgentIds,
  drainOutbox,
  exportBundle,
  ForbiddenError,
  getAgent,
  getTeam,
  listAgents,
  listDms,
  listFormerAgents,
  listMessages,
  loadImportState,
  loadTeam,
  MACHINE_CONTROL_TOPIC,
  type MachineHub,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openDm,
  postPersonMessage,
  setAgentScopes,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine, RUNNER } from "./machine-fixtures";

/** ADR 0082: deleting an agent for good, leaving a tombstone that names what it left behind. */

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const remove = (actorId = f.owner.id, agentId = f.agent.id) =>
  deleteAgent({ db: f.db, pubsub: f.pubsub, hub: f.machineHub }, actorId, f.org.id, agentId);
const ask = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const agentRow = async (id = f.agent.id) =>
  (await f.db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0];
const later = () => new Date(Date.now() + 86_400_000);
const runsOf = (agentId = f.agent.id) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agentId));
/** A login on a computer, with `agentId` thinking with it. */
async function login(machineId: string, agentId = f.agent.id) {
  const id = crypto.randomUUID();
  await f.db.insert(schema.machineAccounts).values({
    id,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Trabalho",
    status: "active",
    createdBy: f.owner.id,
  });
  await f.db
    .update(schema.agents)
    .set({ machineId, brain: "claude_code", brainAccountId: id })
    .where(eq(schema.agents.id, agentId));
  return id;
}

/** One of each thing an agent has, beside what `setup` gave it (scopes, a budget period, #general). */
async function seed() {
  const { db } = f;
  const orgId = f.org.id;
  const agentId = f.agent.id;
  const [note] = await db
    .insert(schema.contextItems)
    .values({ orgId, kind: "note", scopeType: "agent", scopeId: agentId, agentId, content: "Ana likes short answers." })
    .returning();
  await db.insert(schema.searchDocuments).values({
    orgId,
    kind: "context_item",
    sourceId: note?.id ?? "",
    body: "Ana likes short answers.",
    sourceCreatedAt: new Date(),
  });
  await db.insert(schema.contextProposals).values({
    orgId,
    target: "agent_instructions",
    agentId,
    baseHash: "h",
    proposedText: "Answer very briefly.",
    diff: "+very",
    rationale: "Ana asked twice",
  });
  await db.insert(schema.outcomes).values({ orgId, agentId, kind: "test", polarity: "positive", source: "tool" });
  const [skill] = await db
    .insert(schema.skills)
    .values({
      orgId,
      slug: "deploy",
      name: "deploy",
      description: "Deploys",
      body: "Run make deploy.",
      source: "manual",
    })
    .returning();
  await db.insert(schema.agentSkills).values({ orgId, agentId, skillId: skill?.id ?? "" });
  await db.insert(schema.agentRepositories).values({ orgId, agentId, repo: "acme/app", position: 0 });
  const [mailbox] = await db.insert(schema.mailAccounts).values({ orgId, provider: "imap", via: "imap" }).returning();
  await db.insert(schema.mailAgentPolicies).values({ orgId, agentId, accountId: mailbox?.id ?? "" });
  const [database] = await db
    .insert(schema.dbConnections)
    .values({
      orgId,
      label: "Produção",
      host: "db.example.com",
      database: "app",
      username: "reader",
      secretCiphertext: "v1.x.y.z",
      wrappedDataKey: "k",
      kekId: "local:v1",
    })
    .returning();
  await db.insert(schema.dbAgentPolicies).values({ orgId, agentId, connectionId: database?.id ?? "" });
  await db
    .insert(schema.budgetReservations)
    .values({ orgId, agentId, periodStart: "2026-10-01", amountNanoUsd: 1000, expiresAt: later() });
  const [routine] = await db
    .insert(schema.routines)
    .values({
      orgId,
      agentId,
      name: "Resumo",
      prompt: "Resuma o dia",
      target: { type: "dm" },
      triggerType: "schedule",
      cron: "0 9 * * *",
      timezone: "UTC",
      nextRunAt: later(),
      createdByUserId: f.owner.id,
    })
    .returning();
  const [approval] = await db
    .insert(schema.approvals)
    .values({
      orgId,
      agentId,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: "tool-1",
      tool: "github_merge",
      scope: "github:pr.merge",
      params: { pr: 42 },
      actionHash: "hash",
      title: "Merge PR #42",
      expiresAt: later(),
    })
    .returning();
  const dm = await openDm(db, f.owner.id, orgId, { agentId });
  const [inbox] = await db
    .insert(schema.notifications)
    .values({
      orgId,
      userId: f.owner.id,
      kind: "approval",
      waiting: true,
      groupKey: `approval:${approval?.id}`,
      actors: [{ type: "agent", id: agentId }],
    })
    .returning();
  const [mission] = await db
    .insert(schema.missions)
    .values({
      orgId,
      agentId,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      ownerId: f.owner.id,
      title: "Migrar o login",
      goal: "Trocar a biblioteca de sessão",
      mainSessionId: crypto.randomUUID(),
    })
    .returning();
  // Settings beside its display fields, none at its default.
  await db
    .update(schema.agents)
    .set({
      monthlyBudgetNanoUsd: 5_000_000_000,
      audienceMode: "owner",
      missionCommandApproval: "never",
      brainModel: "opus",
      brainEffort: "high",
      brainSpeed: "fast",
      brainFallback: false,
      operatorHoldAt: new Date(),
      operatorHoldReason: "abuse",
    })
    .where(eq(schema.agents.id, agentId));
  return { skill, routine, approval, dm, inbox, mission };
}

describe("deleting an agent", () => {
  test("only owners and admins: a member is refused", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "bia");
    await expect(remove(member.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await agentRow())?.deletedAt).toBeNull();
    const admin = await addMember(f.db, f.org.id, "admin", "caio");
    await remove(admin.id);
    expect((await agentRow())?.deletedAt).toBeInstanceOf(Date);
  });

  test("its data goes at once; a tombstone, its messages, usage and audit rows stay", async () => {
    f = await setup();
    await ask("@dev oi");
    await drainOutbox(f.db, f.handlers);
    const usageBefore = await f.db
      .select()
      .from(schema.usageRecords)
      .where(eq(schema.usageRecords.agentId, f.agent.id));
    expect(usageBefore.length).toBeGreaterThan(0);
    const { skill, routine, approval, dm, inbox, mission } = await seed();

    await remove();

    const tomb = await agentRow();
    // Its name, role and look stay; every other setting is back at its default.
    expect(tomb).toMatchObject({
      name: "Dev",
      role: "Developer",
      instructions: "",
      handle: `deleted-${f.agent.id}`,
      model: "",
      credentialId: null,
      ownerUserId: null,
      monthlyBudgetNanoUsd: null,
      audienceMode: "everyone",
      audienceUserIds: [],
      missionCommandApproval: null,
      brain: "model",
      brainModel: null,
      brainFallback: true,
      brainEffort: null,
      brainSpeed: "standard",
      operatorHoldAt: null,
      operatorHoldReason: null,
    });
    expect(tomb?.deletedAt).toBeInstanceOf(Date);
    expect(tomb?.archivedAt).toBeInstanceOf(Date);
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toBeNull();

    const agentId = f.agent.id;
    for (const table of [
      schema.contextItems,
      schema.contextProposals,
      schema.outcomes,
      schema.agentSkills,
      schema.agentScopes,
      schema.agentRepositories,
      schema.mailAgentPolicies,
      schema.dbAgentPolicies,
      schema.agentBudgetPeriods,
      schema.budgetReservations,
      schema.channelMembers,
    ]) {
      expect(await f.db.select().from(table).where(eq(table.agentId, agentId))).toEqual([]);
    }
    expect(
      await f.db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.kind, "context_item")),
    ).toEqual([]);
    // The skill stays in the library; only its binding went.
    expect(
      await f.db
        .select()
        .from(schema.skills)
        .where(eq(schema.skills.id, skill?.id ?? "")),
    ).toHaveLength(1);
    const [gone] = await f.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.id, routine?.id ?? ""));
    expect(gone).toMatchObject({ active: false, nextRunAt: null });
    expect(gone?.deletedAt).toBeInstanceOf(Date);
    const [closed] = await f.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approval?.id ?? ""));
    expect(closed?.status).toBe("canceled");
    const [ended] = await f.db
      .select()
      .from(schema.missions)
      .where(eq(schema.missions.id, mission?.id ?? ""));
    expect(ended?.status).toBe("canceled");
    const [resolved] = await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, inbox?.id ?? ""));
    expect(resolved?.doneAt).toBeInstanceOf(Date);
    const [conversation] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, dm.id));
    expect(conversation?.archivedAt).toBeInstanceOf(Date);
    expect(await listDms(f.db, f.owner.id, f.org.id)).toEqual([]);

    // Usage keeps its rows and costs for the workspace's reports.
    const usageAfter = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.agentId, agentId));
    expect(usageAfter.map((u) => [u.id, u.costNanoUsd])).toEqual(usageBefore.map((u) => [u.id, u.costNanoUsd]));

    const actions = (await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, agentId))).map(
      (a) => a.action,
    );
    expect(actions).toContain("agent.created");
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "agent.deleted"), eq(schema.auditLog.targetId, agentId)));
    expect(audit).toMatchObject({ actorId: f.owner.id, details: { name: "Dev", handle: "dev" } });
  });

  test("its old messages still name it: the tombstone gives its name and look", async () => {
    f = await setup();
    await ask("@dev oi");
    await drainOutbox(f.db, f.handlers);
    await remove();
    const messages = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const reply = messages.find((m) => m.author.type === "agent");
    expect(reply?.author.id).toBe(f.agent.id);
    expect(await listFormerAgents(f.db, f.owner.id, f.org.id)).toEqual([
      { id: f.agent.id, name: "Dev", role: "Developer", appearance: null, deleted: true },
    ]);
  });

  test("its handle is free again and goes to the new agent", async () => {
    f = await setup();
    await remove();
    const again = await createAgent(f.db, f.owner.id, f.org.id, { name: "Dev 2", handle: "dev" }, NEW_AGENT_DEFAULTS);
    const { rows, missing } = await agentsByHandle(f.db, f.org.id, ["@dev"]);
    expect(missing).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual([again.id]);
  });

  test("a running run is canceled", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f = await setup({
      reply: (_req: ModelRequest, call: number) =>
        call === 1 ? { chunks: ["Começando. ", "Isto nunca chega."], hold } : { chunks: ["não deveria"] },
    });
    await ask("@dev analisa os logs");
    let seen = false;
    f.pubsub.subscribe(channelTopic(f.general.id), (event) => {
      if (seen || event.type !== "agent.typing") return;
      seen = true;
      void remove().finally(release);
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
    expect(run).toMatchObject({ status: "canceled", error: "agent_archived" });
    expect(f.provider.calls).toHaveLength(1);
    expect((await agentRow())?.deletedAt).toBeInstanceOf(Date);
  });

  test("what was sent to its runs is dropped: no run of its own starts after it", async () => {
    f = await setup();
    await ask("@dev analisa os logs");
    const [queued] = await runsOf();
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev e o deploy também",
      threadId: queued?.threadRootId ?? null,
    });
    expect((await runsOf())[0]?.pendingMessageIds).toHaveLength(1);

    await remove();
    await drainOutbox(f.db, f.handlers);

    expect((await runsOf()).map((r) => [r.status, r.error])).toEqual([["canceled", "agent_archived"]]);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("its login on its computer becomes a tombstone the runner hears about", async () => {
    f = await setup({ machines: true });
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "mac" });
    const accountId = await login(machineId);
    const control: Record<string, unknown>[] = [];
    f.pubsub.subscribe(MACHINE_CONTROL_TOPIC, (event) => control.push(event));

    await remove();

    const [account] = await f.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, accountId));
    expect(account?.status).toBe("removing");
    expect(await agentRow()).toMatchObject({ brainAccountId: null, machineId: null });
    expect(control).toContainEqual({ type: "machine.accounts", machineId });
    expect(control).toContainEqual({ type: "machine.agents", orgId: f.org.id });
  });

  test("a login made for all of its owner's agents stays on the computer for the others", async () => {
    f = await setup({ machines: true });
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "mac" });
    const accountId = await login(machineId);
    await f.db.update(schema.machineAccounts).set({ shared: true }).where(eq(schema.machineAccounts.id, accountId));

    await remove();

    const [account] = await f.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, accountId));
    expect(account?.status).toBe("active");
    expect((await agentRow())?.brainAccountId).toBeNull();
  });

  test("an archived agent's login a live agent thinks with now stays with that agent", async () => {
    f = await setup({ machines: true });
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "mac" });
    const accountId = await login(machineId);
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);
    // Archived agents hold no login for themselves alone: it was given to Theo.
    const theo = await createAgent(f.db, f.owner.id, f.org.id, { name: "Theo", handle: "theo" }, NEW_AGENT_DEFAULTS);
    await f.db
      .update(schema.agents)
      .set({ machineId, brain: "claude_code", brainAccountId: accountId })
      .where(eq(schema.agents.id, theo.id));

    await remove();

    expect(await agentRow(theo.id)).toMatchObject({ brain: "claude_code", brainAccountId: accountId });
    const [account] = await f.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, accountId));
    expect(account?.status).toBe("active");
    expect((await agentRow())?.brainAccountId).toBeNull();
  });

  test("a computer hears an agent is deleted, not that it was archived, and an older runner hears nothing", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "on", ...RUNNER });
    const told = async (protocol = RUNNER.protocol) => {
      const runner = fakeRunner(hub);
      await runner.hello(paired.token, { protocol });
      return runner.sent.find((frame) => frame.type === "agents");
    };
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(await told()).not.toHaveProperty("deleted");
    await remove();
    expect(await told()).toMatchObject({ deleted: [f.agent.id] });
    expect(await told(CLAUDE_SHARED_PROTOCOL - 1)).not.toHaveProperty("deleted");
    expect(await deletedAgentIds(f.db, crypto.randomUUID())).toEqual([]);
  });

  test("the secrets people gave it leave the computers that answer; an offline one keeps its row open", async () => {
    f = await setup({ machines: true });
    // Computers it worked on before: the secrets stay on the one they were delivered to.
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "on", ...RUNNER });
    const runner = fakeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const offline = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "off" });
    await ask("@dev oi");
    const [run] = await runsOf();
    const delivered = (machineId: string, name: string) => ({
      orgId: f.org.id,
      runId: run?.id ?? "",
      agentId: f.agent.id,
      channelId: f.general.id,
      toolUseId: `tool-${name}`,
      requestedForUserId: f.owner.id,
      name,
      purpose: "publicar o pacote",
      targetKind: "env" as const,
      machineId,
      publicKey: "pk",
      status: "delivered" as const,
      deliveredAt: new Date(),
      expiresAt: later(),
    });
    await f.db
      .insert(schema.secretRequests)
      .values([delivered(paired.machineId, "NPM_TOKEN"), delivered(offline.machineId, "AWS_KEY")]);

    await remove();

    expect(runner.sent).toContainEqual(
      expect.objectContaining({ type: "request", op: "secret", action: "remove", name: "NPM_TOKEN" }),
    );
    const rows = await f.db.select().from(schema.secretRequests);
    expect(Object.fromEntries(rows.map((r) => [r.name, r.removedAt !== null]))).toEqual({
      NPM_TOKEN: true,
      AWS_KEY: false,
    });
  });

  test("another agent keeps its work and data", async () => {
    f = await setup({ machines: true });
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "mac" });
    const theo = await createAgent(f.db, f.owner.id, f.org.id, { name: "Theo", handle: "theo" }, NEW_AGENT_DEFAULTS);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: theo.id });
    await ask("@dev oi");
    await ask("@theo oi");
    const logins: Record<string, string> = {};
    for (const agentId of [f.agent.id, theo.id]) {
      logins[agentId] = await login(machineId, agentId);
      await f.db.insert(schema.machineTasks).values({
        orgId: f.org.id,
        agentId,
        machineId,
        channelId: f.general.id,
        title: "Build",
        executor: "shell",
        status: "running",
      });
      await f.db.insert(schema.contextItems).values({
        orgId: f.org.id,
        kind: "note",
        scopeType: "agent",
        scopeId: agentId,
        agentId,
        content: "Prefere respostas curtas.",
      });
    }
    const theirs = async () => ({
      agent: await agentRow(theo.id),
      login: await f.db
        .select()
        .from(schema.machineAccounts)
        .where(eq(schema.machineAccounts.id, logins[theo.id] ?? "")),
      runs: await runsOf(theo.id),
      tasks: await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.agentId, theo.id)),
      scopes: await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, theo.id)),
      channels: await f.db.select().from(schema.channelMembers).where(eq(schema.channelMembers.agentId, theo.id)),
      notes: await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.agentId, theo.id)),
      budget: await f.db.select().from(schema.agentBudgetPeriods).where(eq(schema.agentBudgetPeriods.agentId, theo.id)),
    });
    const before = await theirs();
    expect(before.runs).toMatchObject([{ status: "queued" }]);
    expect(before.scopes.length).toBeGreaterThan(0);

    await remove();

    expect(await theirs()).toEqual(before);
    const [own] = await f.db
      .select()
      .from(schema.machineAccounts)
      .where(eq(schema.machineAccounts.id, logins[f.agent.id] ?? ""));
    expect(own?.status).toBe("removing");
    const [task] = await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.agentId, f.agent.id));
    expect(task).toMatchObject({ status: "canceled", canceledBy: "system" });
    expect((await runsOf()).map((r) => r.status)).toEqual(["canceled"]);
  });

  test("lists and pickers never offer it", async () => {
    f = await setup();
    await remove();
    expect((await listAgents(f.db, f.owner.id, f.org.id)).map((a) => a.id)).toEqual([]);
    expect((await getTeam(f.db, f.owner.id, f.org.id)).agents).toEqual([]);
    expect(await loadTeam(f.db, f.org.id)).toEqual([]);
    expect((await agentsByHandle(f.db, f.org.id, ["dev"])).missing).toEqual(["dev"]);
    expect((await exportBundle(f.db, f.owner.id, f.org.id)).agents).toEqual([]);
    const state = await loadImportState(f.db, f.owner.id, f.org.id, { app: "openclaw", ref: "main" });
    expect(state.handles.has("dev")).toBe(false);
  });

  test("an archived agent can be deleted; a deleted one can't be changed or deleted again", async () => {
    f = await setup();
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);
    await remove();
    expect((await agentRow())?.deletedAt).toBeInstanceOf(Date);
    await expect(remove()).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { name: "Back" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [{ connectionId: null, scope: "drive:read" }]),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id))).toEqual([]);
  });
});
