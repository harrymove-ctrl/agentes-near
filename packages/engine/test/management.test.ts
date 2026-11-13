import { afterEach, describe, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  acceptInvitation,
  addChannelMember,
  agentDetail,
  budgetPercent,
  ConflictError,
  createAgent,
  createChannel,
  createInvitation,
  createModelGateway,
  createRole,
  DEFAULT_AGENT_BUDGET_NANO_USD,
  deleteCredential,
  drainOutbox,
  ForbiddenError,
  inviteMany,
  joinChannel,
  listAgentChannels,
  listInvitationsWithStatus,
  listRoles,
  listRuns,
  openDm,
  orgOverview,
  postPersonMessage,
  removeChannelMember,
  resendInvitation,
  rotateCredential,
  setAgentChannels,
  setMemberRoles,
  updateChannel,
  updateOrgSettings,
  updateRole,
  usageReport,
  ValidationError,
} from "../src";
import { addMember, addUser, adminRoleId, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("organization settings", () => {
  test("admins change context and settings; values are validated", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    await expect(updateOrgSettings(f.db, member.id, f.org.id, { context: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateOrgSettings(f.db, f.owner.id, f.org.id, { routerModel: "gpt-9" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(updateOrgSettings(f.db, f.owner.id, f.org.id, { timezone: "Mars/Olympus" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultCredentialId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(ValidationError);
    const s = await updateOrgSettings(f.db, f.owner.id, f.org.id, {
      context: "Acme builds rockets. We deploy on Fridays never.",
      routerModel: "claude-haiku-5-5",
      timezone: "America/Sao_Paulo",
      defaultCredentialId: f.credential.id,
    });
    expect(s).toMatchObject({ name: "Acme", timezone: "America/Sao_Paulo", defaultCredentialId: f.credential.id });
    // The new context reaches the next prompt.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev hi" });
    await drainOutbox(f.db, f.handlers);
    expect(JSON.stringify(f.provider.calls[0]?.request.system)).toContain("We deploy on Fridays never.");
  });
});

describe("invitations", () => {
  test("invite many, resend (old link dies), accept only by the invited email; statuses", async () => {
    f = await setup();
    const existing = await addMember(f.db, f.org.id, "member", "bia");
    const results = await inviteMany(f.db, f.owner.id, f.org.id, {
      emails: ["joao@example.com", "JOAO@example.com", "not-an-email", existing.email, "rita@example.com"],
    });
    expect(results.map((r) => [r.email, r.status])).toEqual([
      ["joao@example.com", "invited"],
      ["not-an-email", "invalid_email"],
      [existing.email, "already_member"],
      ["rita@example.com", "invited"],
    ]);
    const again = await inviteMany(f.db, f.owner.id, f.org.id, { emails: ["joao@example.com"] });
    expect(again[0]?.status).toBe("already_invited");
    // As mail apps copy an address: never an invitation nobody could accept.
    const wrapped = await inviteMany(f.db, f.owner.id, f.org.id, {
      emails: ["<ana@example.com>", '"bia@example.com"', "mailto:caio@example.com"],
    });
    expect(wrapped.map((r) => r.status)).toEqual(["invalid_email", "invalid_email", "invalid_email"]);
    const joaoInvite = results[0];
    if (joaoInvite?.status !== "invited") throw new Error("expected invite");

    const { token } = await resendInvitation(f.db, f.owner.id, f.org.id, joaoInvite.invitationId);
    const joao = await addUser(f.db, "joao");
    await expect(acceptInvitation(f.db, { id: joao.id, email: "joao@example.com" }, joaoInvite.token)).rejects.toThrow(
      "invalid or has expired",
    );
    await expect(acceptInvitation(f.db, { id: joao.id, email: "other@example.com" }, token)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await acceptInvitation(f.db, { id: joao.id, email: "joao@example.com" }, token);

    const later = new Date(Date.now() + 8 * 86_400_000);
    const statuses = await listInvitationsWithStatus(f.db, f.owner.id, f.org.id, later);
    expect(statuses.map((s) => [s.email, s.status])).toEqual([["rita@example.com", "expired"]]);
    // Inviting an address that has an invitation sends that one again (a new link, the roles asked), never a second.
    const rita = results[3];
    if (rita?.status !== "invited") throw new Error("expected invite");
    const admin = await adminRoleId(f.db, f.org.id);
    const renewed = await createInvitation(
      f.db,
      f.owner.id,
      f.org.id,
      { email: "Rita@Example.com", roleIds: [admin] },
      later,
    );
    expect(renewed.invitation).toMatchObject({ id: rita.invitationId, role: "member", roleIds: [admin] });
    expect(renewed.token).not.toBe(rita.token);
    const after = await listInvitationsWithStatus(f.db, f.owner.id, f.org.id, later);
    expect(after.map((s) => [s.email, s.status])).toEqual([["rita@example.com", "pending"]]);
    const member = await addMember(f.db, f.org.id, "member");
    await expect(inviteMany(f.db, member.id, f.org.id, { emails: ["x@example.com"] })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("credentials", () => {
  test("rotate keeps the id (the agent uses the new key); purge is refused while in use", async () => {
    f = await setup();
    await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, f.credential.id, {
      apiKey: "sk-ant-rotated-9999",
    });
    await f.gateway.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      onDelta: () => {},
    });
    expect(f.provider.calls[0]?.apiKey).toBe("sk-ant-rotated-9999");
    await expect(deleteCredential(f.db, f.owner.id, f.org.id, f.credential.id)).rejects.toBeInstanceOf(ConflictError);
    await f.db.update(schema.agents).set({ credentialId: null });
    await deleteCredential(f.db, f.owner.id, f.org.id, f.credential.id);
    expect(await f.db.select().from(schema.providerCredentials)).toEqual([]);
  });
});

describe("agents, runs and usage", () => {
  test("agent detail, channels, run history with cost, usage by kind, overview", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"], usage: { inputTokens: 1000, outputTokens: 100 } }) });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev please check the deploy",
    });
    await drainOutbox(f.db, f.handlers);
    const cost = 1000 * 2000 + 100 * 10000;

    const detail = await agentDetail(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(detail.month).toMatchObject({
      spentNanoUsd: cost,
      runs: 1,
      tokens: 1100,
      // No budget of its own: the workspace default counts.
      budgetNanoUsd: DEFAULT_AGENT_BUDGET_NANO_USD,
      budgetUsedPercent: budgetPercent(cost, DEFAULT_AGENT_BUDGET_NANO_USD),
      failures: 0,
    });
    // The Atividade tab's month: today's run on today's day (UTC).
    expect(detail.month.byDay).toEqual([{ day: new Date().getUTCDate(), runs: 1, failed: 0 }]);
    expect(detail.channels.map((c) => c.name)).toEqual(["general"]);

    const [run] = await listRuns(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    expect(run).toMatchObject({
      status: "done",
      what: "@dev please check the deploy",
      costNanoUsd: cost,
      inputTokens: 1000,
      cachedTokens: 0,
      outputTokens: 100,
      turns: 1,
    });

    const report = await usageReport(f.db, f.owner.id, f.org.id);
    expect(report.byKind).toEqual([
      { kind: "agent", calls: 1, partialCalls: 0, inputTokens: 1000, outputTokens: 100, costNanoUsd: cost },
    ]);
    expect(report.agents.find((a) => a.handle === "dev")?.costNanoUsd).toBe(cost);

    const overview = await orgOverview(f.db, f.owner.id, f.org.id);
    expect(overview).toMatchObject({
      people: 1,
      agents: 1,
      budgetUsedPercent: budgetPercent(cost, DEFAULT_AGENT_BUDGET_NANO_USD),
      approvalsWaitingForMe: 0,
    });
    expect(overview).not.toHaveProperty("myAgentsSpendNanoUsd");

    // Owners of an agent see its runs; other members don't.
    const member = await addMember(f.db, f.org.id, "member");
    await expect(listRuns(f.db, member.id, f.org.id, { agentId: f.agent.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(usageReport(f.db, member.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);

    const eng = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "eng", createdByUserId: f.owner.id })
      .returning();
    const channels = await setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, [
      { channelId: eng[0]?.id ?? "", autoReply: false },
    ]);
    expect(channels).toEqual([{ id: eng[0]?.id ?? "", name: "eng", autoReply: false }]);
    // From its page, as from the channel: each channel's members column hears who came, went or changed.
    const engId = eng[0]?.id ?? "";
    const inEng = f.listen(engId);
    const inGeneral = f.listen(f.general.id);
    const pub = { pubsub: f.pubsub };
    await setAgentChannels(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      [{ channelId: engId, autoReply: true }, { channelId: f.general.id }],
      pub,
    );
    await setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, [], pub);
    await Bun.sleep(5);
    const seen = (list: { type: string }[]) =>
      list.map((e) => [e.type, (e as unknown as { member: { type: string; id: string; autoReply?: boolean } }).member]);
    expect(seen(inEng)).toEqual([
      ["channel.member_updated", { type: "agent", id: f.agent.id, autoReply: true }],
      ["channel.member_removed", { type: "agent", id: f.agent.id }],
    ]);
    expect(seen(inGeneral)).toEqual([
      ["channel.member_added", { type: "agent", id: f.agent.id, autoReply: true }],
      ["channel.member_removed", { type: "agent", id: f.agent.id }],
    ]);
    await expect(
      setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, [{ channelId: crypto.randomUUID() }]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("agent channel listings hide private and DM metadata from unrelated members", async () => {
    f = await setup();
    const outsider = await addMember(f.db, f.org.id, "member", "outsider");
    const [secret] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "secret-project", visibility: "private", createdByUserId: f.owner.id })
      .returning();
    if (!secret) throw new Error("no private channel");
    await setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, [{ channelId: secret.id }]);
    expect(await listAgentChannels(f.db, outsider.id, f.org.id, f.agent.id)).toEqual([]);
    expect((await agentDetail(f.db, outsider.id, f.org.id, f.agent.id)).channels).toEqual([]);
    expect(await listAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual([
      { id: secret.id, name: secret.name, autoReply: true },
    ]);
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    expect(await listAgentChannels(f.db, outsider.id, f.org.id, f.agent.id)).toEqual([]);
    expect((await listAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id)).map((c) => c.id)).toContain(dm.id);
  });

  test("bulk agent channel settings cannot change a DM's fixed participants", async () => {
    f = await setup();
    const other = await addMember(f.db, f.org.id, "member", "dm-peer");
    const peopleDm = await openDm(f.db, f.owner.id, f.org.id, { userId: other.id });
    await expect(
      setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, [{ channelId: peopleDm.id }]),
    ).rejects.toBeInstanceOf(ValidationError);
    const agentDm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, []);
    const [participant] = await f.db
      .select({ id: schema.channelMembers.id })
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, agentDm.id), eq(schema.channelMembers.agentId, f.agent.id)));
    expect(participant).toBeDefined();
    // What the agent page sends back: the GET's own list, with that DM in it.
    const seen = await listAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(seen.map((c) => c.id)).toEqual([agentDm.id]);
    const back = seen.map((c) => ({ channelId: c.id, autoReply: c.autoReply }));
    expect(await setAgentChannels(f.db, f.owner.id, f.org.id, f.agent.id, back)).toEqual(seen);
  });

  test("channel updates: creator or admin, unique names, #general keeps its name", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member");
    await expect(updateChannel(f.db, member.id, f.org.id, f.general.id, { topic: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(updateChannel(f.db, f.owner.id, f.org.id, f.general.id, { name: "main" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const updated = await updateChannel(f.db, f.owner.id, f.org.id, f.general.id, {
      topic: "Everything",
      visibility: "public",
    });
    expect(updated.topic).toBe("Everything");
  });

  test("the owner is told when an agent crosses 80% and 100% of its budget", async () => {
    f = await setup({
      budgetNanoUsd: 100_000_000,
      reply: () => ({ chunks: ["x"], usage: { inputTokens: 21_000, outputTokens: 0 } }),
    });
    const events: { level: string; spent: number }[] = [];
    const gateway = createModelGateway({
      db: f.db,
      keyWrappers: [f.keyWrapper],
      providers: { anthropic: f.provider },
      platformCredentials: noPlatformCredentials,
      onBudgetThreshold: ({ level, spentNanoUsd }) => {
        events.push({ level, spent: spentNanoUsd });
      },
    });
    const call = () =>
      gateway.stream({
        orgId: f.org.id,
        agentId: f.agent.id,
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 300,
        onDelta: () => {},
      });
    for (let i = 0; i < 2; i++) await call(); // 84M of 100M
    expect(events).toEqual([{ level: "warning", spent: 84_000_000 }]);
    await call(); // 126M: over
    expect(events.at(-1)).toEqual({ level: "exhausted", spent: 126_000_000 });
  });
});

describe("where an agent works: its owner in their channels, Manage agents for anyone's", () => {
  /** Bia may create agents and nothing past the base role; her @bot; #squad (the owner's, Bia in it), #sales (not). */
  async function start() {
    f = await setup();
    const makers = await createRole(f.db, f.owner.id, f.org.id, { name: "Makers", permissions: ["create_agents"] });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [makers.id]);
    const bot = await createAgent(
      f.db,
      bia.id,
      f.org.id,
      { name: "Bot", handle: "bot" },
      { model: "claude-haiku-5-5" },
    );
    const squad = await createChannel(f.db, f.owner.id, f.org.id, { name: "squad" });
    await joinChannel(f.db, bia.id, f.org.id, squad.id);
    const sales = await createChannel(f.db, f.owner.id, f.org.id, { name: "sales" });
    const names = async (agentId: string) =>
      (await listAgentChannels(f.db, f.owner.id, f.org.id, agentId)).map((c) => c.name).sort();
    return { bia, bot, squad, sales, names };
  }

  test("its owner puts it in a channel they're in and takes it out, without Manage agents", async () => {
    const { bia, bot, squad, names } = await start();
    expect(await setAgentChannels(f.db, bia.id, f.org.id, bot.id, [{ channelId: squad.id }])).toEqual([
      { id: squad.id, name: "squad", autoReply: true },
    ]);
    expect(await setAgentChannels(f.db, bia.id, f.org.id, bot.id, [])).toEqual([]);
    // What she doesn't see stays: a private channel an admin put it in. Her DM with it comes back in her list.
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await setAgentChannels(f.db, f.owner.id, f.org.id, bot.id, [{ channelId: secret.id }]);
    const dm = await openDm(f.db, bia.id, f.org.id, { agentId: bot.id });
    const seen = await listAgentChannels(f.db, bia.id, f.org.id, bot.id);
    expect(seen.map((c) => c.id)).toEqual([dm.id]);
    await setAgentChannels(f.db, bia.id, f.org.id, bot.id, [
      ...seen.map((c) => ({ channelId: c.id, autoReply: c.autoReply })),
      { channelId: squad.id },
    ]);
    expect(await names(bot.id)).toEqual(["secret", "squad"]);
  });

  test("its owner can't put it in a channel they're not in, or can't post in, unless they arrange channels", async () => {
    const { bia, bot, squad, sales, names } = await start();
    await expect(setAgentChannels(f.db, bia.id, f.org.id, bot.id, [{ channelId: sales.id }])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const { roles } = await listRoles(f.db, f.owner.id, f.org.id);
    const everyone = roles.find((r) => r.kind === "everyone");
    if (!everyone) throw new Error("no base role");
    await updateRole(f.db, f.owner.id, f.org.id, everyone.id, {
      permissions: everyone.permissions.filter((k) => k !== "post"),
    });
    await expect(setAgentChannels(f.db, bia.id, f.org.id, bot.id, [{ channelId: squad.id }])).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await names(bot.id)).toEqual([]);
    const arrangers = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Arrangers",
      permissions: ["create_agents", "manage_channels"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [arrangers.id]);
    await setAgentChannels(f.db, bia.id, f.org.id, bot.id, [{ channelId: squad.id }, { channelId: sales.id }]);
    expect(await names(bot.id)).toEqual(["sales", "squad"]);
  });

  test("someone else's agent needs Manage agents, even in a channel they're in", async () => {
    const { bia, bot, squad, names } = await start();
    await expect(
      setAgentChannels(f.db, bia.id, f.org.id, f.agent.id, [{ channelId: squad.id }]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await names(f.agent.id)).toEqual(["general"]);
    await setAgentChannels(f.db, bia.id, f.org.id, bot.id, [{ channelId: squad.id }]);
    expect(await names(bot.id)).toEqual(["squad"]);
  });

  test("Manage agents changes anyone's agent in the channels they're in; elsewhere it takes arranging channels", async () => {
    const { squad, sales, names } = await start();
    const general = f.general.id;
    const leads = await createRole(f.db, f.owner.id, f.org.id, { name: "Agent leads", permissions: ["manage_agents"] });
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await setMemberRoles(f.db, f.owner.id, f.org.id, caio.id, [leads.id]);
    await joinChannel(f.db, caio.id, f.org.id, squad.id);
    await setAgentChannels(f.db, caio.id, f.org.id, f.agent.id, [{ channelId: general }, { channelId: squad.id }]);
    expect(await names(f.agent.id)).toEqual(["general", "squad"]);
    await expect(
      setAgentChannels(f.db, caio.id, f.org.id, f.agent.id, [
        { channelId: general },
        { channelId: squad.id },
        { channelId: sales.id },
      ]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Taking it out of #general, which he isn't in, too.
    await expect(
      setAgentChannels(f.db, caio.id, f.org.id, f.agent.id, [{ channelId: squad.id }]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // An admin (every key): anywhere, a private channel they're not in too.
    const dora = await addMember(f.db, f.org.id, "admin", "dora");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await setAgentChannels(f.db, dora.id, f.org.id, f.agent.id, [{ channelId: sales.id }, { channelId: secret.id }]);
    expect(await names(f.agent.id)).toEqual(["sales", "secret"]);
  });

  test("a channel's members follow the same rule; who created the channel still takes any agent out", async () => {
    const { bia, bot, squad, sales, names } = await start();
    const pub = { pubsub: f.pubsub };
    // As from its page (and an agent's add_agent_to_channel, its Undo, an import): hers, where she is.
    await addChannelMember(f.db, bia.id, f.org.id, squad.id, { agentId: bot.id }, pub);
    expect(await names(bot.id)).toEqual(["squad"]);
    await expect(addChannelMember(f.db, bia.id, f.org.id, sales.id, { agentId: bot.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(addChannelMember(f.db, bia.id, f.org.id, squad.id, { agentId: f.agent.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await expect(addChannelMember(f.db, bia.id, f.org.id, squad.id, { userId: caio.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, squad.id, { agentId: f.agent.id }, pub);
    await expect(
      removeChannelMember(f.db, bia.id, f.org.id, squad.id, { agentId: f.agent.id }, pub),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await removeChannelMember(f.db, bia.id, f.org.id, squad.id, { agentId: bot.id }, pub);
    expect(await names(bot.id)).toEqual([]);
    const room = await createChannel(f.db, caio.id, f.org.id, { name: "room" });
    await joinChannel(f.db, bia.id, f.org.id, room.id);
    await addChannelMember(f.db, bia.id, f.org.id, room.id, { agentId: bot.id }, pub);
    await removeChannelMember(f.db, caio.id, f.org.id, room.id, { agentId: bot.id }, pub);
    expect(await names(bot.id)).toEqual([]);
  });
});
