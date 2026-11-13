import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, createPostgresPubSub, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  type AgentProposalCard,
  addChannelMember,
  agentProposalOf,
  askAgentProposal,
  ConflictError,
  createAgent,
  createAgentFromProposal,
  createChannel,
  createProposedAgent,
  createProposedRoutine,
  createRole,
  createSetupToolSource,
  createToolGateway,
  denyAgentProposal,
  expireAgentProposalAsks,
  ForbiddenError,
  getAgentProposal,
  insertMessage,
  NEW_AGENT_DEFAULTS,
  openPersonAgentDm,
  PROPOSE_REMOVE_AGENTS_TOOL,
  setMemberRoles,
  suggestAgentAi,
  type ToolContext,
  updateAgent,
} from "../src";
import { addMember, type Fixture, makeAdmin, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** A run of @dev on a message `userId` wrote in #general (or in `channelId`). */
async function runFor(fx: Fixture, userId: string, body: string, channelId = fx.general.id): Promise<ToolContext> {
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId,
    author: { type: "person", userId },
    body,
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId,
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
    channelId,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

/** Through the Tool Gateway, as a run calls it: the scope and the input's schema apply. */
async function propose(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
  const tools = createToolGateway({
    sources: [createSetupToolSource({ pubsub: fx.pubsub, ai: { gateway: fx.gateway } })],
  });
  const res = await tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "propose_agent", input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

const ADA = {
  name: "Ada",
  handle: "ada",
  role: "Designer",
  instructions: "Desenha as telas e revisa o visual.",
  look: { color: "rose", eyes: "happy", accessory: "bow" },
  channels: ["#general"],
  why: "Você pediu alguém para cuidar do design.",
};

const proposals = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).where(eq(schema.messages.orgId, fx.org.id))).filter((m) =>
    agentProposalOf(m.meta),
  );
const cardOf = async (fx: Fixture, id: string) => {
  const [m] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, id));
  return agentProposalOf(m?.meta) as AgentProposalCard;
};
const agentCount = async (fx: Fixture) =>
  (await fx.db.select().from(schema.agents).where(eq(schema.agents.orgId, fx.org.id))).length;
const connect = async (fx: Fixture, connector: string, label: string, toolPrefix = connector) => {
  const [row] = await fx.db
    .insert(schema.connectorConnections)
    .values({
      orgId: fx.org.id,
      connector,
      label,
      toolPrefix,
      serverUrl: `https://${connector}.example.com/mcp`,
      authType: "none",
    })
    .returning();
  if (!row) throw new Error("no connection");
  return row;
};
/** Ana proposes Ada through @dev; the card's message id. */
async function proposed(fx: Fixture) {
  const ctx = await runFor(fx, fx.owner.id, "cria um agente de design");
  const out = await propose(fx, ctx, ADA);
  expect(out.isError).toBeUndefined();
  return (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
}
const deps = (fx: Fixture) => ({ db: fx.db, pubsub: fx.pubsub });
const createAs = (fx: Fixture, userId: string, input: { name: string; handle: string }) => () =>
  createAgent(fx.db, userId, fx.org.id, { ...input, role: "Designer", instructions: "Desenha." }, NEW_AGENT_DEFAULTS);

describe("propose_agent", () => {
  test("a card where the run replies, with the draft as the create-agent screen takes it; it creates nothing", async () => {
    f = await setup();
    const github = await connect(f, "github", "GitHub");
    const ctx = await runFor(f, f.owner.id, "quero um bot de design");
    const agents = await agentCount(f);
    const scopes = (await f.db.select().from(schema.agentScopes)).length;
    const out = await propose(f, ctx, { ...ADA, access: [{ connector: "github", level: "write" }] });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain(
      "A person creates it from the card, in one click or after reviewing it: nothing exists until they do",
    );
    const [card] = await proposals(f);
    expect(card).toMatchObject({
      authorType: "agent",
      authorAgentId: f.agent.id,
      agentRunId: ctx.runId,
      body: "Proposed a new agent, Ada: Você pediu alguém para cuidar do design.",
    });
    expect(card?.meta).toMatchObject({ bodyCode: "agent_proposal", bodyParams: { name: "Ada" } });
    const meta = agentProposalOf(card?.meta) as AgentProposalCard;
    expect(meta).toMatchObject({
      kind: "agent_proposal",
      forUserId: f.owner.id,
      state: "pending",
      agentId: null,
      params: {
        why: ADA.why,
        draft: {
          name: "Ada",
          handle: "ada",
          role: "Designer",
          instructions: ADA.instructions,
          appearance: ADA.look,
          channelIds: [f.general.id],
          access: [{ connectionId: github.id, level: "write" }],
        },
      },
    });
    // Expires like an approval: a day.
    expect(Date.parse(meta.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await agentCount(f)).toBe(agents);
    expect((await f.db.select().from(schema.agentScopes)).length).toBe(scopes);
  });

  test("checked like the create-agent API: nothing is posted for a bad draft", async () => {
    f = await setup();
    const priv = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "board", visibility: "private" })
      .returning();
    expect(priv).toHaveLength(1);
    const ctx = await runFor(f, f.owner.id, "cria um agente");
    const refused = async (input: Record<string, unknown>, says: string) => {
      const out = await propose(f, ctx, { ...ADA, ...input });
      expect(out.isError).toBe(true);
      expect(out.content).toContain(says);
    };
    await refused({ handle: "dev" }, "@dev is already taken");
    await refused({ handle: "Ada Lovelace" }, "handle");
    await refused({ name: "   " }, "name");
    // A private channel's name never goes on a card in a public conversation.
    await refused(
      { channels: ["board"] },
      "No channel #board you can name here. Channels you can name here: #general.",
    );
    await refused({ access: [{ connector: "jira", level: "read" }] }, 'No connected app or mailbox "jira"');
    await refused({ role: "a".repeat(201) }, "input.role: too long (at most 200 characters)");
    await refused({ look: { color: "gold", eyes: "round" } }, "color");
    await refused({ why: "  " }, "why");
    expect(await proposals(f)).toHaveLength(0);
  });

  test("an agent like it already on the team: no card until the person says to make another", async () => {
    f = await setup();
    const ada = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Designer", instructions: "Desenha." },
      NEW_AGENT_DEFAULTS,
    );
    const ctx = await runFor(f, f.owner.id, "cria um agente de design");
    // Its name in other case and accents, or its role under another name.
    for (const input of [
      { ...ADA, name: "ÁDA", handle: "ada-2", role: "Revisora" },
      { ...ADA, name: "Bruna", handle: "bruna", role: "designer " },
    ]) {
      const out = await propose(f, ctx, input);
      expect(out.isError).toBeUndefined();
      expect(out.content).toContain("Not posted: an agent like this already exists: Ada (@ada, Designer)");
      expect(out.content).toContain("call propose_agent again with also_new: true");
    }
    expect(await proposals(f)).toHaveLength(0);
    // The person said to make another one.
    const out = await propose(f, ctx, { ...ADA, name: "Bruna", handle: "bruna", also_new: true });
    expect(out.isError).toBeUndefined();
    expect(await proposals(f)).toHaveLength(1);
    // An archived agent isn't on the team.
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, ada.id));
    expect((await propose(f, ctx, { ...ADA, handle: "ada-3" })).content).toStartWith("Posted the proposal of Ada");
    // A role of only punctuation is none: a draft with no role isn't like it.
    const caio = { name: "Caio", handle: "caio", role: "…", instructions: "Ajuda." };
    await createAgent(f.db, f.owner.id, f.org.id, caio, NEW_AGENT_DEFAULTS);
    const { role: _role, ...noRole } = ADA;
    const fresh = await runFor(f, f.owner.id, "cria um agente");
    expect((await propose(f, fresh, { ...noRole, name: "Dora", handle: "dora" })).content).toStartWith(
      "Posted the proposal of Dora",
    );
  });

  test("starting over: an agent the person asked to remove doesn't stop the one that replaces it", async () => {
    f = await setup();
    await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Designer", instructions: "Desenha." },
      NEW_AGENT_DEFAULTS,
    );
    const ctx = await runFor(f, f.owner.id, "apaga os agentes e monta o time de novo");
    const tools = createToolGateway({ sources: [createSetupToolSource({ pubsub: f.pubsub })] });
    const removal = await tools.invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: PROPOSE_REMOVE_AGENTS_TOOL,
      input: { agents: ["@ada"], reason: "recomeçar" },
    });
    expect(removal.type === "result" && removal.output.content).toContain("propose the new agents now");
    expect((await propose(f, ctx, { ...ADA, handle: "ada-2" })).content).toStartWith("Posted the proposal of Ada");
    // Someone else's ask to remove her keeps her on the team for another person.
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    const other = await runFor(f, bia.id, "cria um agente de design");
    expect((await propose(f, other, { ...ADA, handle: "ada-3" })).content).toContain(
      "Not posted: an agent like this already exists: Ada (@ada, Designer)",
    );
  });

  test("apps by name or by service: a Stripe account is 'stripe'; with two, its name says which", async () => {
    f = await setup();
    const acme = await connect(f, `custom:${crypto.randomUUID()}`, "Stripe (Acme)", "stripe");
    const accessFor = async (connector: string) => {
      const ctx = await runFor(f, f.owner.id, "cria um agente de cobrança");
      const out = await propose(f, ctx, { ...ADA, access: [{ connector, level: "read" }] });
      if (out.isError) return out.content;
      const { messageId } = (out.data as { agentProposal: { messageId: string } }).agentProposal;
      return (await cardOf(f, messageId)).params.draft.access;
    };
    expect(await accessFor("stripe")).toEqual([{ connectionId: acme.id, level: "read" }]);
    const loja = await connect(f, `custom:${crypto.randomUUID()}`, "Stripe (Loja B)", "stripe_2");
    expect(await accessFor("Stripe")).toContain(
      '"stripe" is connected more than once: name one of "Stripe (Acme)", "Stripe (Loja B)".',
    );
    expect(await accessFor("stripe (loja b)")).toEqual([{ connectionId: loja.id, level: "read" }]);
    expect(await accessFor("jira")).toContain(
      'No connected app or mailbox "jira". Channels you can name here: #general. Connected apps: "Stripe (Acme)", "Stripe (Loja B)".',
    );
  });

  test("only where someone who may create agents can open the conversation and decide it", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    // Bia's DM with @dev, and a private channel of hers: no admin or owner can read either.
    const dm = await openPersonAgentDm(f.db, f.org.id, bia.id, f.agent.id);
    const hers = await createChannel(f.db, bia.id, f.org.id, { name: "bia-notes", visibility: "private" });
    for (const where of [dm.id, hers.id]) {
      const out = await propose(f, await runFor(f, bia.id, "cria um agente", where), ADA);
      expect(out.isError).toBe(true);
      expect(out.content).toContain("Nothing was posted: nobody who may create agents can open this conversation");
    }
    expect(await proposals(f)).toHaveLength(0);
    // With the owner in it, a private channel takes the card (as does a public one).
    await addChannelMember(f.db, bia.id, f.org.id, hers.id, { userId: f.owner.id });
    const out = await propose(f, await runFor(f, bia.id, "cria um agente", hers.id), ADA);
    expect(out.isError).toBeUndefined();
    expect(await proposals(f)).toHaveLength(1);
  });
});

describe("the AI it suggests", () => {
  test("an account of the person's that thinks for no agent, else the workspace's model, else none", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    const account = (id: string, label: string, createdBy: string, kind = "claude_code") =>
      f.db
        .insert(schema.machineAccounts)
        .values({ id, orgId: f.org.id, machineId, kind, label, status: "active", createdBy });
    const USED = "0193aaaa-0000-4000-8000-000000000001";
    const FREE = "0193aaaa-0000-4000-8000-000000000002";
    const BIAS = "0193aaaa-0000-4000-8000-000000000003";
    await account(USED, "Claude Max", f.owner.id);
    await account(FREE, "ChatGPT Plus", f.owner.id, "codex");
    await account(BIAS, "Claude da Bia", bia.id);
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", machineId, brainAccountId: USED })
      .where(eq(schema.agents.id, f.agent.id));
    const ai = { db: f.db, gateway: f.gateway };
    expect(await suggestAgentAi(ai, f.org.id, f.owner.id)).toEqual({
      kind: "account",
      brain: "codex",
      machineId,
      accountId: FREE,
      label: "ChatGPT Plus",
    });
    // On the card, for the person behind the run.
    const ctx = await runFor(f, f.owner.id, "cria um agente");
    const out = await propose(f, ctx, ADA);
    expect(out.content).toContain("Suggested AI: ChatGPT Plus");
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    expect((await cardOf(f, id)).params.draft.ai).toMatchObject({ kind: "account", accountId: FREE });
    // Reviewed by another admin: suggested for them (the account thinks only for its owner's agents).
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: caio.id });
    expect((await getAgentProposal(ai, caio.id, f.org.id, id)).params.draft.ai).toEqual({ kind: "model" });
    expect((await getAgentProposal(ai, f.owner.id, f.org.id, id)).params.draft.ai).toMatchObject({ accountId: FREE });
    // Taken, or nobody behind the run: the workspace's model (it has a key).
    await f.db.update(schema.machineAccounts).set({ status: "signed_out" }).where(eq(schema.machineAccounts.id, FREE));
    expect(await suggestAgentAi(ai, f.org.id, f.owner.id)).toEqual({ kind: "model" });
    expect(await suggestAgentAi(ai, f.org.id, null)).toEqual({ kind: "model" });
    // Bia's account isn't suggested to her while she can't create agents (it would think only for her own).
    expect(await suggestAgentAi(ai, f.org.id, bia.id)).toEqual({ kind: "model" });
    const asked = await propose(f, await runFor(f, bia.id, "cria um agente"), ADA);
    expect(asked.content).toContain("The person who asked can't create agents: an admin or owner reviews it.");
    expect(out.content).not.toContain("can't create agents");
    await makeAdmin(f.db, f.org.id, bia.id);
    expect(await suggestAgentAi(ai, f.org.id, bia.id)).toMatchObject({ kind: "account", accountId: BIAS });
    // No key either: none, connected after it is created.
    await f.db
      .update(schema.providerCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(schema.providerCredentials.orgId, f.org.id));
    expect(await suggestAgentAi(ai, f.org.id, f.owner.id)).toEqual({ kind: "none" });
  });
});

describe("deciding", () => {
  test("creating it: the edited agent, by someone who may create agents, once; the card says so and the agent hears it", async () => {
    f = await setup();
    const id = await proposed(f);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    for (const who of [bia, caio]) {
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: who.id });
    }
    // Read-only for who can't create agents; nobody but a person decides (an agent is no member).
    expect(await getAgentProposal(deps(f), bia.id, f.org.id, id)).toMatchObject({ canDecide: false, state: "pending" });
    expect(await getAgentProposal(deps(f), caio.id, f.org.id, id)).toMatchObject({
      canDecide: true,
      expired: false,
      proposedByAgentId: f.agent.id,
      channelId: f.general.id,
    });
    const agents = await agentCount(f);
    await expect(
      createAgentFromProposal(deps(f), bia.id, f.org.id, id, createAs(f, bia.id, { name: "Ada", handle: "ada" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(denyAgentProposal(deps(f), f.agent.id, f.org.id, id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await agentCount(f)).toBe(agents);
    // A failed creation (the handle taken meanwhile) leaves it open.
    await expect(
      createAgentFromProposal(deps(f), caio.id, f.org.id, id, createAs(f, caio.id, { name: "Ada", handle: "dev" })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await cardOf(f, id)).state).toBe("pending");

    const events = f.listen(f.general.id);
    const agent = await createAgentFromProposal(
      deps(f),
      caio.id,
      f.org.id,
      id,
      createAs(f, caio.id, { name: "Ada Lovelace", handle: "ada-l" }),
    );
    expect(agent).toMatchObject({ name: "Ada Lovelace", handle: "ada-l", ownerUserId: caio.id });
    expect(await cardOf(f, id)).toMatchObject({ state: "created", agentId: agent.id, decidedByUserId: caio.id });
    expect(events.find((e) => e.type === "agent.proposal.updated")).toMatchObject({
      messageId: id,
      state: "created",
      agentId: agent.id,
      decidedByUserId: caio.id,
    });
    // The agent that proposed it is told, in its conversation, and answers it.
    const [notice] = (
      await f.db
        .select()
        .from(schema.messages)
        .where(
          and(eq(schema.messages.orgId, f.org.id), sql`${schema.messages.meta}->'notice'->>'kind' = 'proposal_result'`),
        )
    ).map((m) => m.meta.notice as { text: string; from: string; refs: Record<string, string> });
    expect(notice).toMatchObject({
      from: "Your proposal of the agent «Ada»",
      text: "caio created it: @ada-l (Ada Lovelace). It is on the team now.",
      refs: { messageId: id, agentId: agent.id },
    });
    const woken = await f.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.agentId, f.agent.id), eq(schema.agentRuns.status, "queued")));
    expect(woken).toHaveLength(1);
    // Once.
    await expect(
      createAgentFromProposal(
        deps(f),
        f.owner.id,
        f.org.id,
        id,
        createAs(f, f.owner.id, { name: "Ada", handle: "ada" }),
      ),
    ).rejects.toMatchObject({ code: "agent_proposal.decided" });
    await expect(denyAgentProposal(deps(f), f.owner.id, f.org.id, id)).rejects.toMatchObject({
      code: "agent_proposal.decided",
    });
  });

  test("saying no: the card stays, marked denied, nothing is made and the agent is told", async () => {
    f = await setup();
    const id = await proposed(f);
    const agents = await agentCount(f);
    const denied = await denyAgentProposal(deps(f), f.owner.id, f.org.id, id);
    expect(denied).toMatchObject({ state: "denied", decidedByUserId: f.owner.id, canDecide: false, agentId: null });
    expect((await cardOf(f, id)).state).toBe("denied");
    expect(await agentCount(f)).toBe(agents);
    const notices = (await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, f.org.id))).filter(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "proposal_result",
    );
    expect((notices[0]?.meta.notice as { text: string } | undefined)?.text).toBe(
      "ana said no. Don't propose it again unless someone asks.",
    );
  });

  test("the decision reaches the conversation through Postgres NOTIFY, however long the instructions", async () => {
    f = await setup();
    // The server's pub/sub across replicas, looped back: it refuses a payload over the NOTIFY limit.
    let deliver: ((payload: string) => void) | null = null;
    const pg = await createPostgresPubSub({
      listen: async (_channel, on) => {
        deliver = on;
        return async () => {};
      },
      notify: async (_channel, payload) => deliver?.(payload),
    });
    const seen: RealtimeEvent[] = [];
    pg.subscribe(channelTopic(f.general.id), (e) => seen.push(e));
    const ctx = await runFor(f, f.owner.id, "cria um agente de acessibilidade");
    const out = await propose(f, ctx, { ...ADA, instructions: "Revisão de acessibilidade. ".repeat(1_850) });
    expect(out.isError).toBeUndefined();
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    await denyAgentProposal({ db: f.db, pubsub: pg }, f.owner.id, f.org.id, id);
    await pg.close?.();
    expect(seen.filter((e) => e.type === "agent.proposal.updated")).toEqual([
      {
        type: "agent.proposal.updated",
        channelId: f.general.id,
        threadId: null,
        messageId: id,
        state: "denied",
        agentId: null,
        decidedByUserId: f.owner.id,
        decidedAt: expect.any(String),
      },
    ]);
  });

  test("expired after a day: nobody decides it any more", async () => {
    f = await setup();
    const id = await proposed(f);
    await f.db
      .update(schema.messages)
      .set({
        meta: sql`jsonb_set(${schema.messages.meta}, '{actionCard,expiresAt}', ${JSON.stringify(new Date(Date.now() - 1000).toISOString())}::jsonb)`,
      })
      .where(eq(schema.messages.id, id));
    expect(await getAgentProposal(deps(f), f.owner.id, f.org.id, id)).toMatchObject({
      state: "pending",
      expired: true,
      canDecide: false,
    });
    await expect(denyAgentProposal(deps(f), f.owner.id, f.org.id, id)).rejects.toMatchObject({
      code: "agent_proposal.expired",
    });
    await expect(
      createAgentFromProposal(
        deps(f),
        f.owner.id,
        f.org.id,
        id,
        createAs(f, f.owner.id, { name: "Ada", handle: "ada" }),
      ),
    ).rejects.toMatchObject({ code: "agent_proposal.expired" });
    expect((await cardOf(f, id)).state).toBe("pending");
  });
});

/** A Gmail mailbox `ownerId` connected (ADR 0038). */
const mailbox = async (fx: Fixture, ownerId: string, address: string) => {
  const [row] = await fx.db
    .insert(schema.mailAccounts)
    .values({
      orgId: fx.org.id,
      provider: "gmail",
      via: "composio",
      address,
      label: address,
      status: "active",
      createdByUserId: ownerId,
    })
    .returning();
  if (!row) throw new Error("no mailbox");
  return row;
};
const NOON = {
  schedule: "0 12 * * *",
  prompt: "Lê a caixa de entrada e me resume o que chegou.",
  title: "E-mails do dia",
};
const CAIO = {
  name: "Caio",
  handle: "caio",
  role: "E-mail",
  instructions: "Cuida dos e-mails da Ana.",
  look: { color: "teal", eyes: "round" },
  why: "Você pediu alguém para checar seus e-mails todo dia ao meio-dia.",
};

describe("one request, one card: channels, mailboxes and a routine", () => {
  test("a private channel of the asker's that everyone here is in, their own mailbox, a routine read now", async () => {
    f = await setup();
    const github = await connect(f, "github", "GitHub");
    const inbox = await mailbox(f, f.owner.id, "ana@acme.com");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await mailbox(f, bia.id, "bia@acme.com");
    // Ana's private channel, where she asked.
    const priv = await createChannel(f.db, f.owner.id, f.org.id, { name: "private", visibility: "private" });
    const ctx = await runFor(f, f.owner.id, "cria um agente que checa meus emails todo dia meio dia", priv.id);
    // As the agent first tried in production: its mailbox as "mail", and the channel by name.
    const out = await propose(f, ctx, {
      ...CAIO,
      channels: ["#private"],
      access: [
        { connector: "mail", level: "read" },
        { connector: "github", level: "read" },
      ],
      routine: NOON,
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("Its routine «E-mails do dia» runs: Every day, at 12:00 (UTC).");
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    expect((await cardOf(f, id)).params.draft).toMatchObject({
      channelIds: [priv.id],
      access: [{ connectionId: github.id, level: "read" }],
      mail: [{ accountId: inbox.id, address: "ana@acme.com", level: "read", ownerUserId: f.owner.id }],
      routine: {
        name: "E-mails do dia",
        prompt: NOON.prompt,
        schedule: "0 12 * * *",
        rule: { freq: "daily", times: ["12:00"] },
        report: "when_new",
        // Every routine does what its agent can (ADR 0109).
        access: "act",
      },
    });
  });

  test("what it can't name is refused with everything it can, so the next call is right", async () => {
    f = await setup();
    await connect(f, "github", "GitHub");
    await mailbox(f, f.owner.id, "ana@acme.com");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await mailbox(f, bia.id, "bia@acme.com");
    const priv = await createChannel(f.db, f.owner.id, f.org.id, { name: "private", visibility: "private" });
    const OFFER = "Connected apps: github. Mailboxes of the person who asked (in access, by address): ana@acme.com.";
    // In #general (anyone reads it), Ana's private channel can't be named.
    const general = await runFor(f, f.owner.id, "cria um agente");
    const there = await propose(f, general, { ...CAIO, channels: ["private"] });
    expect(there.content).toBe(
      `Failed: No channel #private you can name here. Channels you can name here: #general. ${OFFER}`,
    );
    // In her DM with @dev, only she reads the card: her private channel can be.
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
    expect(
      (await propose(f, await runFor(f, f.owner.id, "cria um agente", dm.id), { ...CAIO, channels: ["private"] }))
        .isError,
    ).toBeUndefined();
    // With Bia in #private too, still only Ana's own mailboxes: Bia's isn't hers to give.
    await addChannelMember(f.db, f.owner.id, f.org.id, priv.id, { userId: bia.id });
    const here = await runFor(f, f.owner.id, "cria um agente", priv.id);
    const others = await propose(f, here, { ...CAIO, access: [{ connector: "bia@acme.com", level: "read" }] });
    expect(others.content).toBe(
      `Failed: No connected app or mailbox "bia@acme.com". Channels you can name here: #general, #private. ${OFFER}`,
    );
    const bad = await propose(f, here, { ...CAIO, routine: { ...NOON, schedule: "quando der" } });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('Write it as 5-field cron ("0 12 * * *")');
    // One createRoutine would refuse is refused now, so the agent proposes one that can be made.
    const often = await propose(f, here, { ...CAIO, routine: { ...NOON, schedule: "*/5 * * * *" } });
    expect(often.isError).toBe(true);
    expect(often.content).toContain("at most every 15 minutes");
    expect(await proposals(f)).toHaveLength(1);
  });

  test("Criar in one click: every line the person may give, the rest on the card for who may; the agent hears both", async () => {
    f = await setup();
    const github = await connect(f, "github", "GitHub");
    const inbox = await mailbox(f, f.owner.id, "ana@acme.com");
    const priv = await createChannel(f.db, f.owner.id, f.org.id, { name: "private", visibility: "private" });
    const ctx = await runFor(f, f.owner.id, "cria um agente que checa meus emails todo dia meio dia", priv.id);
    const out = await propose(f, ctx, {
      ...CAIO,
      access: [
        { connector: "ana@acme.com", level: "read" },
        { connector: "github", level: "read" },
      ],
      routine: NOON,
    });
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    // Its routine reports here: #private comes with it.
    expect((await cardOf(f, id)).params.draft.channelIds).toEqual([priv.id]);
    expect((await cardOf(f, id)).params.draft.routine?.reportsIn).toBe(priv.id);

    const events = f.listen(priv.id);
    const made = await createProposedAgent(
      { db: f.db, pubsub: f.pubsub, gateway: f.gateway },
      f.owner.id,
      f.org.id,
      id,
    );
    const agent = made.agent;
    expect(agent).toMatchObject({ name: "Caio", handle: "caio", role: "E-mail", ownerUserId: f.owner.id });
    expect(agent.appearance).toMatchObject({ color: "teal", eyes: "round" });
    const inPrivate = await f.db
      .select()
      .from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, priv.id), eq(schema.channelMembers.agentId, agent.id)));
    expect(inPrivate).toHaveLength(1);
    const scopes = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, agent.id));
    expect(scopes.filter((s) => s.connectionId === inbox.id).map((s) => s.scope)).toEqual(["mail:read"]);
    expect(scopes.some((s) => s.connectionId === github.id && s.scope === "github:repo.read")).toBe(true);
    const [routine] = await f.db.select().from(schema.routines).where(eq(schema.routines.agentId, agent.id));
    expect(routine).toMatchObject({
      name: "E-mails do dia",
      prompt: NOON.prompt,
      createdByUserId: f.owner.id,
      target: { type: "conversation", channelId: priv.id },
      triggerType: "schedule",
      active: true,
    });
    expect(await cardOf(f, id)).toMatchObject({
      state: "created",
      agentId: agent.id,
      applied: { channelIds: [priv.id], connectionIds: [github.id], mailAccountIds: [inbox.id] },
      routineId: routine?.id,
    });
    expect(events.find((e) => e.type === "agent.proposal.updated")).toMatchObject({
      state: "created",
      applied: { channelIds: [priv.id], mailAccountIds: [inbox.id] },
      routineId: routine?.id,
    });
    const [notice] = (
      await f.db
        .select()
        .from(schema.messages)
        .where(sql`${schema.messages.meta}->'notice'->>'kind' = 'proposal_result'`)
    ).map((m) => m.meta.notice as { text: string });
    expect(notice?.text).toBe(
      `ana created it: @caio (Caio). It is on the team now. It joined #private, reads GitHub, reads the mailbox ana@acme.com, has its routine «E-mails do dia» (${routine?.description}).`,
    );
  });

  test("Criar: an app the proposal doesn't name starts at Ler e escrever, as every agent has it; the agent hears it", async () => {
    f = await setup();
    const github = await connect(f, "github", "GitHub");
    const linear = await connect(f, "linear", "Linear");
    const ctx = await runFor(f, f.owner.id, "cria um agente que lê o GitHub");
    const out = await propose(f, ctx, { ...CAIO, access: [{ connector: "github", level: "read" }] });
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    const made = await createProposedAgent(
      { db: f.db, pubsub: f.pubsub, gateway: f.gateway },
      f.owner.id,
      f.org.id,
      id,
    );
    const scopes = await f.db.select().from(schema.agentScopes).where(eq(schema.agentScopes.agentId, made.agent.id));
    // What it named keeps its level: read stays read.
    expect(scopes.some((s) => s.connectionId === github.id && s.scope === "connector:*")).toBe(false);
    expect(scopes.some((s) => s.connectionId === github.id && s.scope === "github:repo.read")).toBe(true);
    expect(scopes.filter((s) => s.connectionId === linear.id).map((s) => s.scope)).toEqual(["connector:*"]);
    const [notice] = (
      await f.db
        .select()
        .from(schema.messages)
        .where(sql`${schema.messages.meta}->'notice'->>'kind' = 'proposal_result'`)
    ).map((m) => m.meta.notice as { text: string });
    expect(notice?.text).toContain("reads GitHub, reads and writes Linear");
  });

  test("an admin who doesn't own the mailbox, a member who can't give apps: what waits, and for whom", async () => {
    f = await setup();
    const github = await connect(f, "github", "GitHub");
    await mailbox(f, f.owner.id, "ana@acme.com");
    const ctx = await runFor(f, f.owner.id, "cria um agente que lê meus emails");
    // The same agent on each card, on purpose: each is decided by someone else.
    const card = async () => {
      const out = await propose(f, ctx, {
        ...CAIO,
        handle: `caio-${crypto.randomUUID().slice(0, 4)}`,
        channels: ["general"],
        access: [
          { connector: "ana@acme.com", level: "read" },
          { connector: "github", level: "write" },
        ],
        also_new: true,
      });
      return (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    };
    const deps = { db: f.db, pubsub: f.pubsub, gateway: f.gateway };
    // Caio, an admin: the apps and #general, never Ana's mailbox.
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: caio.id });
    const first = await card();
    const byAdmin = await createProposedAgent(deps, caio.id, f.org.id, first);
    expect((await cardOf(f, first)).applied).toEqual({
      channelIds: [f.general.id],
      connectionIds: [github.id],
      mailAccountIds: [],
    });
    const mail = await f.db
      .select()
      .from(schema.agentScopes)
      .where(and(eq(schema.agentScopes.agentId, byAdmin.agent.id), sql`${schema.agentScopes.scope} like 'mail:%'`));
    expect(mail).toHaveLength(0);
    // Bia may create agents and nothing more: giving apps waits for an admin.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    const makers = await createRole(f.db, f.owner.id, f.org.id, { name: "Makers", permissions: ["create_agents"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [makers.id]);
    const second = await card();
    await createProposedAgent(deps, bia.id, f.org.id, second);
    expect((await cardOf(f, second)).applied?.connectionIds).toEqual([]);
    const texts = (
      await f.db
        .select()
        .from(schema.messages)
        .where(sql`${schema.messages.meta}->'notice'->>'kind' = 'proposal_result'`)
        .orderBy(schema.messages.createdAt)
    ).map((m) => (m.meta.notice as { text: string }).text);
    expect(texts[0]).toContain("Not given yet: the mailbox ana@acme.com (only ana gives it).");
    expect(texts[1]).toContain("GitHub (an admin)");
    // Caio's own plan account thinks for the next one, which then answers only Caio: Ana gives it once it answers her.
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    await f.db
      .update(schema.machines)
      .set({
        protocol: 8,
        executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
      })
      .where(eq(schema.machines.id, machineId));
    await f.db.insert(schema.machineAccounts).values({
      id: "0193aaaa-0000-4000-8000-000000000009",
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "Claude do Caio",
      status: "active",
      createdBy: caio.id,
    });
    const third = await card();
    const onPlan = await createProposedAgent(deps, caio.id, f.org.id, third);
    expect(onPlan.ai).toBe("account");
    const said = await f.db
      .select()
      .from(schema.messages)
      .where(sql`${schema.messages.meta}->'notice'->>'kind' = 'proposal_result'`)
      .orderBy(schema.messages.createdAt);
    expect(JSON.stringify(said.at(-1)?.meta.notice)).toContain(
      "the mailbox ana@acme.com (only ana gives it, once it answers ana:",
    );
  });

  test("a member who only creates agents gives the new agent her own mailbox in one click", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    const makers = await createRole(f.db, f.owner.id, f.org.id, { name: "Makers", permissions: ["create_agents"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [makers.id]);
    const inbox = await mailbox(f, bia.id, "bia@acme.com");
    const ctx = await runFor(f, bia.id, "cria um agente que lê meus emails");
    const out = await propose(f, ctx, { ...CAIO, access: [{ connector: "bia@acme.com", level: "read" }] });
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    await createProposedAgent({ db: f.db, pubsub: f.pubsub, gateway: f.gateway }, bia.id, f.org.id, id);
    expect((await cardOf(f, id)).applied?.mailAccountIds).toEqual([inbox.id]);
  });

  test("created from the review, its routine comes once it is where it reports: once", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria um agente que resume o dia");
    const out = await propose(f, ctx, { ...CAIO, routine: NOON });
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    const deps = { db: f.db, pubsub: f.pubsub };
    await expect(createProposedRoutine(deps, f.owner.id, f.org.id, id)).rejects.toMatchObject({
      code: "agent_proposal.no_routine",
    });
    const agent = await createAgentFromProposal(deps, f.owner.id, f.org.id, id, () =>
      createAgent(f.db, f.owner.id, f.org.id, { name: "Caio", handle: "caio" }, NEW_AGENT_DEFAULTS),
    );
    // Not in #general yet: the routine can't report there, and the card lets go of it.
    await expect(createProposedRoutine(deps, f.owner.id, f.org.id, id)).rejects.toMatchObject({
      code: "routine.agent_not_in_channel",
    });
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: agent.id });
    const view = await createProposedRoutine(deps, f.owner.id, f.org.id, id);
    const [routine] = await f.db.select().from(schema.routines).where(eq(schema.routines.agentId, agent.id));
    expect(view.routineId).toBe(routine?.id);
    expect((await cardOf(f, id)).routineId).toBe(routine?.id);
    await expect(createProposedRoutine(deps, f.owner.id, f.org.id, id)).rejects.toMatchObject({
      code: "agent_proposal.routine_made",
    });
  });
});

describe("an agent's role says what it does, in as many words as it takes", () => {
  const LONG_ROLE = "Assistente de e-mails, agenda e reuniões";

  test("a 40-character role is taken when it is set or changed", async () => {
    f = await setup();
    expect(LONG_ROLE).toHaveLength(40);
    const caio = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Caio", handle: "caio", role: LONG_ROLE },
      NEW_AGENT_DEFAULTS,
    );
    expect(caio.role).toBe(LONG_ROLE);
    const edited = await updateAgent(f.db, f.owner.id, f.org.id, caio.id, { role: `${LONG_ROLE.slice(0, 39)}!` });
    expect(edited.role).toBe(`${LONG_ROLE.slice(0, 39)}!`);
  });

  test("propose_agent takes a 40-character role, and the agent made from the card has it", async () => {
    f = await setup();
    const out = await propose(f, await runFor(f, f.owner.id, "cria um agente"), { ...CAIO, role: LONG_ROLE });
    expect(out.isError).toBeUndefined();
    const id = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    const made = await createProposedAgent(
      { db: f.db, pubsub: f.pubsub, gateway: f.gateway },
      f.owner.id,
      f.org.id,
      id,
    );
    expect(made.agent.role).toBe(LONG_ROLE);
  });
});

describe("the right hand's agent cards (ADR 0137)", () => {
  /** A run of Lodi on what `userId` wrote in their DM with it. */
  async function lodiRun(fx: Fixture, userId: string): Promise<ToolContext> {
    const [lodi] = await fx.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, "right_hand")));
    if (!lodi) throw new Error("no right hand");
    const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
    const ctx = await runFor(fx, userId, "preciso de alguém pro design", dm.id);
    await fx.db.update(schema.agentRuns).set({ agentId: lodi.id }).where(eq(schema.agentRuns.id, ctx.runId));
    return { ...ctx, agentId: lodi.id };
  }

  test("Criar e testar opens the clicker's DM with it and sends nothing for them", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id);
    const out = await propose(f, ctx, { ...ADA, first_task: "Desenha a tela de login." });
    const messageId = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    expect((await cardOf(f, messageId)).params.firstTask).toBe("Desenha a tela de login.");
    const made = await createProposedAgent(
      { db: f.db, pubsub: f.pubsub, gateway: f.gateway },
      f.owner.id,
      f.org.id,
      messageId,
      { test: true },
    );
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, made.agent.id);
    expect(made.testChannelId).toBe(dm.id);
    const said = await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id));
    expect(said.filter((m) => m.authorUserId !== null)).toEqual([]);
  });

  test("a newer card for the same handle takes the older one's place; another handle's stays", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id);
    const first = (await propose(f, ctx, ADA)).data as { agentProposal: { messageId: string } };
    const other = (await propose(f, ctx, { ...ADA, name: "Lia", handle: "lia" })).data as typeof first;
    await propose(f, ctx, { ...ADA, role: "Designer de produto" });
    expect((await cardOf(f, first.agentProposal.messageId)).state).toBe("superseded");
    expect((await cardOf(f, other.agentProposal.messageId)).state).toBe("pending");
  });

  test("in a member's DM the card is posted all the same; they send it, and an admin creates it from the inbox", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    const ctx = await lodiRun(f, bia.id);
    const out = await propose(f, ctx, ADA);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("the card lets them send it to an admin or owner");
    const messageId = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    // Ana isn't in Bia's DM: until Bia sends it, the card isn't hers to open.
    expect(getAgentProposal({ db: f.db }, f.owner.id, f.org.id, messageId)).rejects.toThrow();
    expect(askAgentProposal({ db: f.db }, f.owner.id, f.org.id, messageId)).rejects.toThrow();
    await askAgentProposal({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, messageId);
    expect(askAgentProposal({ db: f.db }, bia.id, f.org.id, messageId)).rejects.toThrow(/already sent/);
    const inbox = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "change_request")));
    expect(inbox.map((n) => [n.userId, n.waiting])).toEqual([[f.owner.id, true]]);
    expect((await getAgentProposal({ db: f.db }, f.owner.id, f.org.id, messageId)).canDecide).toBe(true);
    const made = await createProposedAgent({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, messageId);
    expect(made.agent.ownerUserId).toBe(f.owner.id);
    const [done] = await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, inbox[0]?.id ?? ""));
    expect(done?.doneAt).not.toBeNull();
  });

  test("a sent card that runs out leaves the admins' inbox", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    const out = await propose(f, await lodiRun(f, bia.id), ADA);
    const messageId = (out.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    await askAgentProposal({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, messageId);
    const open = () =>
      f.db
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.kind, "change_request"), sql`${schema.notifications.doneAt} is null`));
    expect(await expireAgentProposalAsks({ db: f.db })).toBe(0);
    expect(await open()).toHaveLength(1);
    const past = JSON.stringify(new Date(Date.now() - 1000).toISOString());
    await f.db
      .update(schema.messages)
      .set({ meta: sql`jsonb_set(${schema.messages.meta}, '{actionCard,expiresAt}', ${past}::jsonb)` })
      .where(eq(schema.messages.id, messageId));
    expect(await expireAgentProposalAsks({ db: f.db, pubsub: f.pubsub })).toBe(1);
    expect(await open()).toEqual([]);
  });
});
