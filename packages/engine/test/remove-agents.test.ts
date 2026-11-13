import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  addChannelMember,
  askProposal,
  BROWSER_GUIDANCE,
  createAgent,
  createSetupToolSource,
  createToolGateway,
  decideProposal,
  getAgent,
  listProposals,
  NEW_AGENT_DEFAULTS,
  PROPOSE_REMOVE_AGENTS_TOOL,
  postPersonMessage,
  RIGHT_HAND,
  rightHandPrompt,
  type ToolContext,
  undoAgentAction,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** A run of @dev on what `userId` wrote in #general: its tools act for that person. */
async function devRun(fx: Fixture, userId: string, body: string): Promise<ToolContext> {
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, fx.general.id, {
    body,
  });
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: trigger.id,
  };
}

const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
async function call(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: PROPOSE_REMOVE_AGENTS_TOOL,
    input,
  });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

async function cardRows(fx: Fixture, viewer: string) {
  const card = (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
    .filter((m) => (m.meta.actionCard as { kind?: string } | undefined)?.kind === "settings_proposal")
    .at(-1);
  if (!card) throw new Error("no card");
  const ids = (card.meta.actionCard as { proposalIds: string[] }).proposalIds;
  return { card, rows: await listProposals(fx.db, viewer, fx.org.id, { ids }) };
}

async function team(fx: Fixture) {
  const make = (name: string, handle: string) =>
    createAgent(fx.db, fx.owner.id, fx.org.id, { name, handle }, NEW_AGENT_DEFAULTS);
  return [await make("Ana", "ana"), await make("Bruno", "bruno"), await make("Caio", "caio")];
}

describe("propose_remove_agents", () => {
  test("any agent with the setup tools posts one card for them all, never itself or the right hand", async () => {
    f = await setup({ rightHand: true });
    const [ana, bruno, caio] = await team(f);
    const ctx = await devRun(f, f.owner.id, "@dev apaga todos os outros agentes e vamos reconstruir tudo");
    expect((await gatewayOf(f).granted(ctx)).map((t) => t.name)).toContain(PROPOSE_REMOVE_AGENTS_TOOL);
    const out = await call(f, ctx, { agents: ["@ana", "@bruno", "@caio", "@dev", "@lodi"], reason: "recomeçar" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Nothing has changed yet");
    expect(out.content).toContain("you can't remove yourself");
    expect(out.content).toContain("@lodi is the workspace's assistant");
    expect(out.content).toContain("propose_agent");
    const { rows } = await cardRows(f, f.owner.id);
    expect(rows.map((r) => r.agentId).sort()).toEqual([ana, bruno, caio].map((a) => a?.id ?? "").sort());
    for (const r of rows) expect(r).toMatchObject({ canDecide: true, settings: [{ field: "archive", to: true }] });
    // Nothing archived before the click.
    expect((await getAgent(f.db, f.org.id, ana?.id ?? ""))?.archivedAt).toBeNull();

    const only = await call(f, ctx, { agents: ["@dev", "@lodi"], reason: "nao" });
    expect(only.isError).toBe(true);
    expect(await f.db.select().from(schema.agents).where(eq(schema.agents.builtin, RIGHT_HAND))).toHaveLength(1);
  });

  test("an admin archives some of them as themselves, leaving one out, and Undo brings one back", async () => {
    f = await setup({ rightHand: true });
    const [ana, bruno, caio] = await team(f);
    const ctx = await devRun(f, f.owner.id, "@dev arquiva a Ana, o Bruno e o Caio");
    await call(f, ctx, { agents: ["@ana", "@bruno", "@caio"], reason: "recomeçar" });
    const { card, rows } = await cardRows(f, f.owner.id);
    const rowOf = (id?: string) => rows.find((r) => r.agentId === id)?.id ?? "";
    for (const a of [ana, bruno]) await decideProposal(f.db, f.owner.id, f.org.id, rowOf(a?.id), "accept");
    expect((await getAgent(f.db, f.org.id, ana?.id ?? ""))?.archivedAt).not.toBeNull();
    expect((await getAgent(f.db, f.org.id, bruno?.id ?? ""))?.archivedAt).not.toBeNull();
    expect((await getAgent(f.db, f.org.id, caio?.id ?? ""))?.archivedAt).toBeNull();
    const receipts = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipts).toHaveLength(2);
    const anas = receipts.find((a) => a.target.id === ana?.id);
    await undoAgentAction({ db: f.db }, f.owner.id, f.org.id, anas?.id ?? "");
    expect((await getAgent(f.db, f.org.id, ana?.id ?? ""))?.archivedAt).toBeNull();
  });

  test("a member who can't archive sends the card to the admins, who decide it", async () => {
    f = await setup({ rightHand: true });
    const [ana] = await team(f);
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const ctx = await devRun(f, bia.id, "@dev arquiva a Ana");
    const out = await call(f, ctx, { agents: ["@ana"], reason: "não uso mais" });
    expect(out.content).toContain("send it to an admin");
    const [row] = (await cardRows(f, bia.id)).rows;
    expect(row).toMatchObject({ canDecide: false, askedAt: null });
    expect(decideProposal(f.db, bia.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    await askProposal({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, row?.id ?? "");
    const [mine] = await listProposals(f.db, f.owner.id, f.org.id, { ids: [row?.id ?? ""] });
    expect(mine).toMatchObject({ canDecide: true });
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept");
    expect((await getAgent(f.db, f.org.id, ana?.id ?? ""))?.archivedAt).not.toBeNull();
  });

  test("deleting is for good under the delete rules, with no Undo", async () => {
    f = await setup({ rightHand: true });
    const [ana] = await team(f);
    const ctx = await devRun(f, f.owner.id, "@dev apaga a Ana de vez");
    await call(f, ctx, { agents: ["@ana"], reason: "primeiro arquiva" });
    const [archived] = (await cardRows(f, f.owner.id)).rows;
    await decideProposal(f.db, f.owner.id, f.org.id, archived?.id ?? "", "accept");
    await call(f, ctx, { agents: ["@ana"], delete: true, reason: "de vez" });
    const { card, rows } = await cardRows(f, f.owner.id);
    expect(rows[0]).toMatchObject({ settings: [{ field: "delete", from: false, to: true }] });
    await decideProposal(f.db, f.owner.id, f.org.id, rows[0]?.id ?? "", "accept", { pubsub: f.pubsub });
    const [gone] = await f.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.id, ana?.id ?? "")));
    expect(gone?.deletedAt).not.toBeNull();
    expect((await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? []).toEqual([]);
    // The card still reads how it ended; the agent's other decided settings rows stay hidden.
    expect((await cardRows(f, f.owner.id)).rows).toMatchObject([{ status: "accepted" }]);
    expect(await listProposals(f.db, f.owner.id, f.org.id, { ids: [archived?.id ?? ""] })).toEqual([]);
  });

  test("the prompts: never sign in to our own app, and the right hand proposes removals too", async () => {
    expect(BROWSER_GUIDANCE).toContain(
      "never to agentes.chat itself, the app you work in, nor ask a person to: change the workspace with your own tools and cards",
    );
    f = await setup({ rightHand: true });
    const [lodi] = await f.db.select().from(schema.agents).where(eq(schema.agents.builtin, RIGHT_HAND));
    if (!lodi) throw new Error("no right hand");
    const prompt = await rightHandPrompt(
      { db: f.db },
      { orgId: f.org.id, agent: lodi, personId: f.owner.id, inDm: true },
    );
    expect(prompt).toContain("Archiving or deleting agents, several at once ('start over'): propose_remove_agents");
    expect(prompt).not.toContain("an account or an agent");
  });
});
