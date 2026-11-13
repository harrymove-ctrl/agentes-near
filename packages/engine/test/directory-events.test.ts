import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, orgTopic, userTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  archiveAgent,
  archiveChannel,
  caches,
  channelMembersDetail,
  createAgent,
  createChannel,
  createProposedAgent,
  createSetupToolSource,
  createTeam,
  createToolGateway,
  createWorkspaceToolSource,
  deleteAgent,
  deleteChannel,
  joinChannel,
  listChannelMembers,
  listDms,
  openDm,
  openPersonAgentDm,
  PROPOSE_TEAM_TOOL,
  postPersonMessage,
  RIGHT_HAND,
  removeChannelMember,
  revertSettings,
  setAgentAppearance,
  setAgentChannels,
  type ToolContext,
  unarchiveAgent,
  unarchiveChannel,
  undoTeam,
  updateAgent,
  updateChannel,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** What the org's sockets are told, in order, with each transaction's commit in between. */
function watch(fx: Fixture, channelIds: string[] = []) {
  const log: string[] = [];
  fx.pubsub.subscribe(orgTopic(fx.org.id), (e) => {
    if (e.type === "org.broadcast") log.push((e.event as { type: string }).type);
  });
  for (const id of channelIds)
    fx.pubsub.subscribe(channelTopic(id), (e) => {
      if (e.type.startsWith("channel.member_")) log.push(e.type);
    });
  const transaction = fx.db.transaction.bind(fx.db);
  fx.db.transaction = (async (...args: Parameters<typeof transaction>) => {
    const out = await transaction(...args);
    log.push("commit");
    return out;
  }) as typeof fx.db.transaction;
  return log;
}

const AGENTS = "agents.changed";
const CHANNELS = "channels.changed";
const announced = (log: string[], type: string) => log.filter((t) => t === type).length;

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

async function lodiRun(fx: Fixture, body: string): Promise<ToolContext> {
  const lodi = await lodiOf(fx);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, lodi.id);
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body });
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: dm.id,
    threadRootId: run.threadRootId,
    triggerMessageId: trigger.id,
  };
}

/** A run of @dev: the right hand is denied some tools. */
async function devRun(fx: Fixture, body: string): Promise<ToolContext> {
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body,
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
async function call(fx: Fixture, ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

const IARA = {
  name: "Iara",
  handle: "iara",
  role: "Atendimento",
  line: "Responde os clientes.",
  channel: "atendimento",
};
const CAIO = { name: "Caio", handle: "caio", role: "Cobrança", line: "Lembra quem atrasou.", channel: "financeiro" };
const ADA = { name: "Ada", handle: "ada", role: "Dev", line: "Corrige os bugs.", channel: "general" };

async function teamCard(fx: Fixture, agents: Record<string, unknown>[]) {
  const ctx = await lodiRun(fx, "Monta o time");
  const out = await call(fx, ctx, PROPOSE_TEAM_TOOL, { lead: "O time.", agents });
  return (out.data as { actionCard: { messageId: string } }).actionCard.messageId;
}

describe("what Lodi creates reaches every open app, after its transaction commits", () => {
  test("Criar o time: the agents and the channels are announced once, and nothing goes out before the commit", async () => {
    f = await setup({ rightHand: true });
    const id = await teamCard(f, [IARA, CAIO, ADA]);
    const log = watch(f, [f.general.id]);
    const made = await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(made.card.state).toBe("created");
    expect(announced(log, AGENTS)).toBe(1);
    expect(announced(log, CHANNELS)).toBe(1);
    expect(log).toContain("channel.member_added");
    const commit = log.indexOf("commit");
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("channel.member_added")).toBeGreaterThan(commit);
    expect(log.indexOf(AGENTS)).toBeGreaterThan(commit);
    expect(log.indexOf(CHANNELS)).toBeGreaterThan(commit);
  });

  test("a team that fails is undone whole: nobody hears of what never was", async () => {
    f = await setup({ rightHand: true });
    const id = await teamCard(f, [ADA, IARA]);
    await f.db.insert(schema.agents).values({
      orgId: f.org.id,
      name: "Outra Iara",
      handle: "iara",
      role: "",
      instructions: "",
      model: "auto",
      ownerUserId: f.owner.id,
    });
    const log = watch(f, [f.general.id]);
    const tried = await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(tried.card.state).toBe("pending");
    expect(log.filter((t) => t !== "commit")).toEqual([]);
  });

  test("Desfazer: the agents and channels leave every list, once its transaction is done", async () => {
    f = await setup({ rightHand: true });
    const id = await teamCard(f, [IARA]);
    await createTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    const log = watch(f);
    await undoTeam({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(announced(log, AGENTS)).toBe(1);
    expect(announced(log, CHANNELS)).toBe(1);
    expect(log.indexOf(AGENTS)).toBeGreaterThan(log.indexOf("commit"));
  });

  test("create_channel: announced after the run's transaction, with its agents in it", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, "cria o #vendas com o @dev");
    const log = watch(f);
    const out = await call(f, ctx, "create_channel", { name: "vendas", agents: ["@dev"] });
    expect(out.isError).toBeFalsy();
    expect(announced(log, CHANNELS)).toBe(1);
    expect(log.indexOf(CHANNELS)).toBeGreaterThan(log.indexOf("commit"));
  });
});

describe("what runs cached while a transaction was open goes with its commit", () => {
  test("add_agent_to_channel: a run reading between the write and the commit doesn't keep the old members", async () => {
    f = await setup({ rightHand: true });
    const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas" });
    const ctx = await devRun(f, "põe o dev no vendas");
    const key = `${f.org.id}:${channel.id}`;
    const transaction = f.db.transaction.bind(f.db);
    f.db.transaction = (async (run: (tx: never) => Promise<unknown>) =>
      transaction(async (tx) => {
        const out = await run(tx as never);
        caches.channelMembers.set(key, ["as it was"]);
        return out;
      })) as typeof f.db.transaction;
    const tools = createToolGateway({ sources: [createWorkspaceToolSource({ pubsub: f.pubsub })] });
    const res = await tools.invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: "add_agent_to_channel",
      input: { agent: "@dev", channel: "vendas" },
    });
    if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
    expect(res.output.content).toContain("Added");
    expect(caches.channelMembers.get(key)).toBeUndefined();
  });
});

describe("every path that changes the agents or the channels tells the workspace", () => {
  const input = { name: "Iara", handle: "iara", role: "", instructions: "x" };
  const defaults = { model: "auto" };

  test("agents: made, renamed, a new look, archived, back, deleted", async () => {
    f = await setup();
    const log = watch(f);
    const { db, pubsub, org, owner } = f;
    const agent = await createAgent(db, owner.id, org.id, input, defaults, { pubsub });
    expect(announced(log, AGENTS)).toBe(1);
    await updateAgent(db, owner.id, org.id, agent.id, { name: "Iara Souza" }, { pubsub });
    expect(announced(log, AGENTS)).toBe(2);
    await setAgentAppearance(db, owner.id, org.id, agent.id, { color: "rose", eyes: "happy" }, { pubsub });
    expect(announced(log, AGENTS)).toBe(3);
    await archiveAgent(db, owner.id, org.id, agent.id, pubsub);
    expect(announced(log, AGENTS)).toBe(4);
    await unarchiveAgent(db, owner.id, org.id, agent.id, { pubsub });
    expect(announced(log, AGENTS)).toBe(5);
    await deleteAgent({ db, pubsub } as Parameters<typeof deleteAgent>[0], owner.id, org.id, agent.id);
    expect(announced(log, AGENTS)).toBe(6);
  });

  test("channels: made, renamed, archived, back, deleted", async () => {
    f = await setup();
    const log = watch(f);
    const { db, pubsub, org, owner } = f;
    const channel = await createChannel(db, owner.id, org.id, { name: "vendas" }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(1);
    await updateChannel(db, owner.id, org.id, channel.id, { name: "comercial" }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(2);
    await archiveChannel(db, owner.id, org.id, channel.id, { pubsub });
    expect(announced(log, CHANNELS)).toBe(3);
    await unarchiveChannel(db, owner.id, org.id, channel.id, { pubsub });
    expect(announced(log, CHANNELS)).toBe(4);
    await deleteChannel(
      { db, pubsub } as Parameters<typeof deleteChannel>[0],
      owner.id,
      org.id,
      channel.id,
      "comercial",
    );
    expect(announced(log, CHANNELS)).toBe(5);
  });

  test("members: added, taken out, joining, an agent's channels set from its page", async () => {
    f = await setup();
    const log = watch(f);
    const { db, pubsub, org, owner, agent } = f;
    const channel = await createChannel(db, owner.id, org.id, { name: "vendas" });
    const bia = await addMember(db, org.id, "member", "bia");
    await addChannelMember(db, owner.id, org.id, channel.id, { agentId: agent.id }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(1);
    await removeChannelMember(db, owner.id, org.id, channel.id, { agentId: agent.id }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(2);
    await joinChannel(db, bia.id, org.id, channel.id, { pubsub });
    expect(announced(log, CHANNELS)).toBe(3);
    await removeChannelMember(db, bia.id, org.id, channel.id, { userId: bia.id }, { pubsub });
    expect(announced(log, CHANNELS)).toBe(4);
    await setAgentChannels(db, owner.id, org.id, agent.id, [{ channelId: channel.id }], { pubsub });
    expect(announced(log, CHANNELS)).toBe(5);
  });

  test("Desfazer of a change to who it answers or to its AI, which have no editor of their own to announce them", async () => {
    f = await setup();
    const log = watch(f);
    const { db, pubsub, org, owner, agent } = f;
    const everyone = { mode: "everyone", userIds: [], roleIds: [] };
    const action = {
      orgId: org.id,
      targetId: agent.id,
      params: {
        lines: [{ field: "audience", from: { mode: "owner", userIds: [], roleIds: [] }, to: everyone, label: "" }],
      },
    } as unknown as Parameters<typeof revertSettings>[1];
    await revertSettings({ db, pubsub }, action, owner.id, "undo", () => new Error("changed"));
    expect(announced(log, AGENTS)).toBe(1);
  });

  test("a proposed agent, on one click: read again once it has its AI, which moves who may talk to it", async () => {
    f = await setup();
    const { db, pubsub, org, owner, gateway } = f;
    const ctx = await devRun(f, "cria um agente de cobrança");
    const { machineId } = await pairMachine({ db, pubsub }, owner.id, org.id, { name: "MacBook", exec: true });
    await db
      .update(schema.machines)
      .set({
        protocol: 8,
        executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
      })
      .where(eq(schema.machines.id, machineId));
    await db.insert(schema.machineAccounts).values({
      id: "0193aaaa-0000-4000-8000-000000000009",
      orgId: org.id,
      machineId,
      kind: "claude_code",
      label: "Claude",
      status: "active",
      createdBy: owner.id,
    });
    const tools = createToolGateway({ sources: [createSetupToolSource({ pubsub, ai: { gateway } })] });
    const res = await tools.invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: "propose_agent",
      input: {
        name: "Caio",
        handle: "caio",
        role: "Cobrança",
        instructions: "Lembra quem atrasou.",
        why: "Você pediu alguém para cobrar quem atrasa.",
      },
    });
    if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
    if (res.output.isError) throw new Error(res.output.content);
    const { messageId } = (res.output.data as { agentProposal: { messageId: string } }).agentProposal;
    const log = watch(f);
    const made = await createProposedAgent({ db, pubsub, gateway }, owner.id, org.id, messageId);
    expect(made.ai).toBe("account");
    expect(announced(log, AGENTS)).toBe(2);
  });

  test("a new DM reaches the other devices of who opened it, and the other person with its first message", async () => {
    f = await setup();
    const { db, pubsub, org, owner, agent } = f;
    const bia = await addMember(db, org.id, "member", "bia");
    const heard: string[] = [];
    for (const [who, id] of [
      ["owner", owner.id],
      ["bia", bia.id],
    ] as const)
      pubsub.subscribe(userTopic(org.id, id), (e) => {
        if (e.type === CHANNELS) heard.push(who);
      });
    const log = watch(f);
    await openDm(db, owner.id, org.id, { agentId: agent.id }, { pubsub });
    expect(heard).toEqual(["owner"]);
    const dm = await openDm(db, owner.id, org.id, { userId: bia.id }, { pubsub });
    expect(heard).toEqual(["owner", "owner"]);
    await openDm(db, owner.id, org.id, { userId: bia.id }, { pubsub });
    expect(heard).toHaveLength(2);
    expect(announced(log, CHANNELS)).toBe(0);

    const listed = async (id: string) => (await listDms(db, id, org.id)).map((d) => d.channelId);
    expect(await listed(owner.id)).toContain(dm.id);
    expect(await listed(bia.id)).toEqual([]);

    // The first message shows it to the other person.
    const cara = await addMember(db, org.id, "member", "cara");
    const toCara = await openDm(db, owner.id, org.id, { userId: cara.id }, { pubsub });
    expect(await listed(cara.id)).toEqual([]);
    await postPersonMessage({ db, pubsub }, owner.id, org.id, toCara.id, { body: "oi" });
    expect(await listed(cara.id)).toEqual([toCara.id]);

    // Or their own opening it: their other devices hear it once, nothing counts as read, and the DM stays theirs.
    heard.length = 0;
    await openDm(db, bia.id, org.id, { userId: owner.id }, { pubsub });
    await openDm(db, bia.id, org.id, { userId: owner.id }, { pubsub });
    expect(heard).toEqual(["bia"]);
    expect(await listed(bia.id)).toEqual([dm.id]);
    await postPersonMessage({ db, pubsub }, owner.id, org.id, dm.id, { body: "oi" });
    expect((await listDms(db, bia.id, org.id))[0]?.unread).toBe(1);
  });

  test("a DM with an agent is listed even with no message, and opening it reads nothing (the right hand's wave)", async () => {
    f = await setup();
    const { db, pubsub, org, owner, agent } = f;
    const made = await openPersonAgentDm(db, org.id, owner.id, agent.id);
    await openDm(db, owner.id, org.id, { agentId: agent.id }, { pubsub });
    expect(await listDms(db, owner.id, org.id)).toMatchObject([{ channelId: made.id, everRead: false }]);
  });

  test("a DM with no message sorts by when it began, so the one just opened is first", async () => {
    f = await setup();
    const { db, pubsub, org, owner, agent } = f;
    const bia = await addMember(db, org.id, "member", "bia");
    const talked = await openDm(db, owner.id, org.id, { agentId: agent.id }, { pubsub });
    await postPersonMessage({ db, pubsub }, owner.id, org.id, talked.id, { body: "oi" });
    const opened = await openDm(db, owner.id, org.id, { userId: bia.id }, { pubsub });
    expect((await listDms(db, owner.id, org.id)).map((d) => d.channelId)).toEqual([opened.id, talked.id]);
  });

  test("an archived agent stays a member, but leaves what a channel lists until it is back", async () => {
    f = await setup();
    const { db, pubsub, org, owner, agent, general } = f;
    const ids = async () => (await listChannelMembers(db, owner.id, org.id, general.id)).map((m) => m.id);
    const named = async () => (await channelMembersDetail(db, org.id, general.id)).map((m) => m.agentId);
    expect(await ids()).toContain(agent.id);
    expect(await named()).toContain(agent.id);
    await archiveAgent(db, owner.id, org.id, agent.id, pubsub);
    expect(await ids()).not.toContain(agent.id);
    expect(await named()).not.toContain(agent.id);
    await unarchiveAgent(db, owner.id, org.id, agent.id, { pubsub });
    expect(await ids()).toContain(agent.id);
    expect(await named()).toContain(agent.id);
  });
});
