import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  addChannelMember,
  askProposal,
  createChannel,
  createSetupToolSource,
  createToolGateway,
  decideProposal,
  deleteSkill,
  describeCapabilities,
  enabledSkills,
  getAgent,
  insertMessage,
  listAudit,
  listProposals,
  MAX_CARDS_PER_RUN,
  MAX_CARDS_PER_RUN_RIGHT_HAND,
  openPersonAgentDm,
  ownWords,
  PROPOSE_SETTINGS_TOOL,
  postPersonMessage,
  presentTools,
  REQUEST_SETTINGS_TOOL,
  RIGHT_HAND,
  RIGHT_HAND_DECIDE_JOB,
  redoAgentAction,
  SETTINGS_REQUEST_CARD,
  saveSkill,
  setAgentScopes,
  setAgentSkills,
  setRightHandApprovals,
  type ToolContext,
  undoAgentAction,
  undoMessageActions,
  updateAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/**
 * A run of Lodi on what `userId` wrote in their DM with it: its tools act for that person. Their message relays outside
 * content, so what they may decide waits on the card; `ownWords`: nothing does, so it applies at once.
 */
async function lodiRun(fx: Fixture, userId: string, body: string, ownWords = false): Promise<ToolContext> {
  const lodi = await lodiOf(fx);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body });
  if (!ownWords)
    await fx.db
      .update(schema.messages)
      .set({ meta: { readOutside: true } })
      .where(eq(schema.messages.id, trigger.id));
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

const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
async function call(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: PROPOSE_SETTINGS_TOOL,
    input,
  });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

/** The newest card's rows, as `viewer` sees them. */
async function cardRows(fx: Fixture, viewer: string) {
  const card = (
    await fx.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.orgId, fx.org.id))
      .orderBy(schema.messages.createdAt)
  )
    .filter((m) => (m.meta.actionCard as { kind?: string } | undefined)?.kind === "settings_proposal")
    .at(-1);
  if (!card) throw new Error("no card");
  const ids = (card.meta.actionCard as { proposalIds: string[] }).proposalIds;
  return { card, rows: await listProposals(fx.db, viewer, fx.org.id, { ids }) };
}

const USD = 1_000_000_000;

describe("a change the person asked for and may make (ADR 0092 §5)", () => {
  test("applies as the card is posted, with Undo on it, and goes back", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "chama o dev de Ada e deixa ele teal", true);
    const out = await call(f, ctx, {
      changes: [{ agent: "@dev", name: "Ada", look: { color: "teal", eyes: "happy" } }],
      reason: "pediu",
    });
    expect(out.content).toContain("applied at once");
    expect(out.content).not.toContain("Nothing has changed");
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      name: "Ada",
      appearance: { color: "teal", eyes: "happy", accessory: "none" },
    });
    const { card, rows } = await cardRows(f, f.owner.id);
    expect(rows.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    const receipts = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipts.map((r) => r.kind)).toEqual(["agent.settings_changed", "agent.settings_changed"]);
    for (const r of receipts) await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, r.id);
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({ name: "Dev", appearance: null });
  });

  test("a row they can't decide stays on the card, and so does an agent's own", async () => {
    f = await setup({ rightHand: true });
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const ctx = await lodiRun(f, member.id, "sobe o limite do dev", true);
    const out = await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: 20 }], reason: "pediu" });
    expect(out.content).not.toContain("applied at once");
    expect((await cardRows(f, member.id)).rows[0]?.status).toBe("pending");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.monthlyBudgetNanoUsd).toBeNull();

    const own = await lodiRun(f, f.owner.id, "sobe seu próprio limite", true);
    await call(f, own, { changes: [{ agent: "@lodi", budget_usd: 20 }], reason: "pediu" });
    expect((await cardRows(f, f.owner.id)).rows[0]?.status).toBe("pending");
  });

  test("on a computer the model is its brain's: any name its CLI takes, with Undo", async () => {
    f = await setup({ rightHand: true });
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    await f.db.update(schema.agents).set({ brain: "codex", machineId }).where(eq(schema.agents.id, f.agent.id));
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no Astra", true);
    const refused = await call(f, ctx, { changes: [{ agent: "@dev", model: "GPT-6 Astra" }], reason: "pediu" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain("That isn't a model name");
    const out = await call(f, ctx, { changes: [{ agent: "@dev", model: "gpt-6-astra" }], reason: "pediu" });
    expect(out.content).toContain("applied at once");
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      brain: "codex",
      brainModel: "gpt-6-astra",
      model: "claude-sonnet-5-5",
    });
    const { card } = await cardRows(f, f.owner.id);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.brainModel).toBeNull();
  });

  test("outside content in the conversation leaves it on the card", async () => {
    f = await setup({ rightHand: true });
    const outside = await lodiRun(f, f.owner.id, "coloca o dev no haiku");
    await call(f, outside, { changes: [{ agent: "@dev", model: "claude-haiku-5-5" }], reason: "pediu" });
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.model).toBe("claude-sonnet-5-5");
  });

  test("a run another agent's message started leaves it on the card, whoever is behind that agent", async () => {
    f = await setup({ rightHand: true });
    const relayed = await lodiRun(f, f.owner.id, "coloca o dev no haiku", true);
    const message = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: relayed.channelId,
      author: { type: "agent", agentId: relayed.agentId, runId: relayed.runId, hop: 0 },
      body: "a pedido dele",
    });
    await call(
      f,
      { ...relayed, triggerMessageId: message.id },
      {
        changes: [{ agent: "@dev", model: "claude-haiku-5-5" }],
        reason: "pediu",
      },
    );
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.model).toBe("claude-sonnet-5-5");
  });
});

describe("the settings card", () => {
  test("every agent that sets the team up has it, and the right hand's run may post 10 cards (3 for the others)", async () => {
    f = await setup({ rightHand: true });
    expect([MAX_CARDS_PER_RUN, MAX_CARDS_PER_RUN_RIGHT_HAND]).toEqual([3, 10]);
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no haiku");
    expect((await gatewayOf(f).granted(ctx)).map((t) => t.name)).toContain(PROPOSE_SETTINGS_TOOL);
    const dev = { ...ctx, agentId: f.agent.id };
    // Another agent proposes too, and the right hand may decide its card for the person (ADR 0139).
    expect((await gatewayOf(f).granted(dev)).map((t) => t.name)).toContain(PROPOSE_SETTINGS_TOOL);
    for (let i = 0; i < 10; i++) {
      const out = await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: i + 1 }], reason: "mais folga" });
      expect(out.isError).toBeFalsy();
    }
    const out = await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: 50 }], reason: "mais folga" });
    expect(out).toMatchObject({ isError: true, content: "You already offered 10 cards in this turn." });
  });

  test("each row applies as whoever clicks, with Undo on the card and `via` in the audit", async () => {
    f = await setup({ rightHand: true });
    const lodi = await lodiOf(f);
    const ctx = await lodiRun(f, f.owner.id, "coloca o dev no haiku e sobe o limite dele pra US$ 20");
    const out = await call(f, ctx, {
      changes: [{ agent: "@dev", model: "claude-haiku-5-5", budget_usd: 20 }],
      reason: "mais barato e com folga",
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Nothing has changed yet");
    const { card, rows } = await cardRows(f, f.owner.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      target: "agent_settings",
      agentId: f.agent.id,
      requestedByUserId: f.owner.id,
      canDecide: true,
      settings: [
        { field: "model", from: "claude-sonnet-5-5", to: "claude-haiku-5-5" },
        { field: "budget", from: null, to: 20 * USD },
      ],
    });
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.model).toBe("claude-sonnet-5-5");

    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      model: "claude-haiku-5-5",
      monthlyBudgetNanoUsd: 20 * USD,
    });
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipt).toMatchObject({
      kind: "agent.settings_changed",
      agentId: lodi.id,
      requestedByUserId: f.owner.id,
      target: { type: "agent", id: f.agent.id, title: "Dev" },
    });
    const [audit] = await f.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "proposal.accepted")));
    expect(audit?.details).toMatchObject({ via: lodi.id, target: "agent_settings" });
    // "Ver o que o Lodi fez": what was applied from its cards, with the person as the actor.
    const viaLodi = await listAudit(f.db, f.owner.id, f.org.id, { via: lodi.id });
    expect(viaLodi.rows.map((r) => [r.action, r.actor.id])).toContainEqual(["proposal.accepted", f.owner.id]);
    expect((await listAudit(f.db, f.owner.id, f.org.id, { via: f.agent.id })).rows).toEqual([]);

    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await getAgent(f.db, f.org.id, f.agent.id)).toMatchObject({
      model: "claude-sonnet-5-5",
      monthlyBudgetNanoUsd: null,
    });
  });

  test("a row is out of date once the agent changed, and Undo stops once someone changed it since", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "sobe o limite do dev");
    await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: 20 }], reason: "folga" });
    const [stale] = (await cardRows(f, f.owner.id)).rows;
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 5 * USD });
    expect(decideProposal(f.db, f.owner.id, f.org.id, stale?.id ?? "", "accept")).rejects.toThrow(/changed since/);
    expect((await listProposals(f.db, f.owner.id, f.org.id, { ids: [stale?.id ?? ""] }))[0]?.status).toBe("stale");

    await call(f, ctx, { changes: [{ agent: "@dev", budget_usd: 20 }], reason: "folga" });
    const { card, rows } = await cardRows(f, f.owner.id);
    await decideProposal(f.db, f.owner.id, f.org.id, rows[0]?.id ?? "", "accept");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 30 * USD });
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(undoAgentAction({ db: f.db }, f.owner.id, f.org.id, receipt?.id ?? "")).rejects.toThrow(/changed after/);
  });

  test("a member's row waits for them to send it, then reaches only who manages agents; the click is read then", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    const admin = await addMember(f.db, f.org.id, "admin", "Theo");
    const ctx = await lodiRun(f, bia.id, "troca o modelo do dev pra um melhor");
    const out = await call(f, ctx, { changes: [{ agent: "@dev", model: "claude-opus-5-5" }], reason: "melhor" });
    expect(out.content).toContain("can't apply it: the card lets them send it to whoever may");
    const [row] = (await cardRows(f, bia.id)).rows;
    expect(row).toMatchObject({ canDecide: false, askedAt: null });
    expect(decideProposal(f.db, bia.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    const inbox = async () =>
      (
        await f.db
          .select({ userId: schema.notifications.userId, doneAt: schema.notifications.doneAt })
          .from(schema.notifications)
          .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "change_request")))
      ).sort((a, b) => a.userId.localeCompare(b.userId));
    expect(await inbox()).toEqual([]);
    // Unsent, nobody else hears of it: not listed for an admin, and not theirs to apply.
    expect((await listProposals(f.db, f.owner.id, f.org.id, { status: "pending" })).some((p) => p.id === row?.id)).toBe(
      false,
    );
    expect(decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    // Only the person who asked sends it, once.
    expect(askProposal({ db: f.db }, admin.id, f.org.id, row?.id ?? "")).rejects.toThrow(/Only the person who asked/);
    await askProposal({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, row?.id ?? "");
    expect(askProposal({ db: f.db }, bia.id, f.org.id, row?.id ?? "")).rejects.toThrow(/already sent/);
    expect((await inbox()).map((n) => n.userId).sort()).toEqual([admin.id, f.owner.id].sort());
    expect(
      (await listProposals(f.db, f.owner.id, f.org.id, { status: "pending" })).find((p) => p.id === row?.id),
    ).toMatchObject({ canDecide: true });
    // Theo lost the right to manage agents before clicking: the click is refused.
    await f.db.delete(schema.organizationMemberRoles).where(eq(schema.organizationMemberRoles.userId, admin.id));
    expect(decideProposal(f.db, admin.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.model).toBe("claude-opus-5-5");
    expect((await inbox()).every((n) => n.doneAt !== null)).toBe(true);
  });

  test("an AI account is decided by its owner alone, who must own the agent", async () => {
    f = await setup({ rightHand: true });
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, {
      name: "MacBook",
      exec: true,
    });
    await f.db.insert(schema.machineAccounts).values({
      id: "0193aaaa-0000-4000-8000-000000000011",
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "Claude do Caio",
      status: "active",
      createdBy: caio.id,
    });
    const ctx = await lodiRun(f, f.owner.id, "põe o dev no Claude do Caio");
    const refused = await call(f, ctx, { changes: [{ agent: "@dev", ai_account: "Claude do Caio" }], reason: "plano" });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain("its owner must own the agent first");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    await call(f, ctx, { changes: [{ agent: "@dev", ai_account: "Claude do Caio" }], reason: "plano" });
    const [row] = (await cardRows(f, f.owner.id)).rows;
    expect(row?.canDecide).toBe(false);
    // Unsent, the account's owner doesn't hear of it yet.
    expect(await listProposals(f.db, caio.id, f.org.id, { ids: [row?.id ?? ""] })).toEqual([]);
    await askProposal({ db: f.db }, f.owner.id, f.org.id, row?.id ?? "");
    expect((await listProposals(f.db, caio.id, f.org.id, { ids: [row?.id ?? ""] }))[0]?.canDecide).toBe(true);
    const asked = await f.db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "change_request"));
    expect(asked.map((n) => n.userId)).toEqual([caio.id]);
  });

  test("archive, its Undo, and channels; never the right hand itself", async () => {
    f = await setup({ rightHand: true });
    const design = await createChannel(f.db, f.owner.id, f.org.id, { name: "design" });
    const ctx = await lodiRun(f, f.owner.id, "tira o dev do general, põe no design só quando chamado, e arquiva");
    const self = await call(f, ctx, { changes: [{ agent: "@lodi", archive: true }], reason: "nao" });
    expect(self).toMatchObject({ isError: true });
    expect(self.content).toContain("You can't change your own archive");
    await call(f, ctx, {
      changes: [
        {
          agent: "@dev",
          leave: ["general"],
          join: ["design"],
          replies: [{ channel: "design", without_mention: false }],
          archive: true,
        },
      ],
      reason: "reorganizar",
    });
    const { card, rows } = await cardRows(f, f.owner.id);
    // Channels and archiving are decided under different rules: two rows on one card.
    expect(rows.map((r) => r.settings?.map((l) => l.field))).toEqual(
      expect.arrayContaining([["channel_add", "channel_remove"], ["archive"]]),
    );
    expect(rows.find((r) => r.settings?.[0]?.field === "channel_add")?.settings).toEqual([
      { field: "channel_add", channelId: design.id, from: null, to: false, label: { to: "#design" } },
      { field: "channel_remove", channelId: f.general.id, from: true, to: null, label: { to: "#general" } },
    ]);
    for (const r of rows) await decideProposal(f.db, f.owner.id, f.org.id, r.id, "accept");
    const seats = await f.db
      .select({ channelId: schema.channelMembers.channelId })
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.agentId, f.agent.id));
    expect(seats.map((s) => s.channelId)).toEqual([design.id]);
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.archivedAt).not.toBeNull();
    const archived = ((await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? []).find((a) =>
      (a.params.fields as string[]).includes("archive"),
    );
    await undoAgentAction({ db: f.db }, f.owner.id, f.org.id, archived?.id ?? "");
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.archivedAt).toBeNull();
  });
});

const install = (fx: Fixture, name: string) =>
  saveSkill({ db: fx.db, blobs: fx.artifactDeps.blobs }, fx.owner.id, fx.org.id, {
    name,
    description: `Trabalha com ${name}.`,
    body: "1. Abra o arquivo.",
    metadata: {},
    source: "manual",
  });
const skillsOf = async (fx: Fixture) => (await enabledSkills(fx.db, fx.org.id, fx.agent.id)).map((k) => k.name);
/** What the agent that posted a card was told once its rows were decided. */
const notices = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).where(eq(schema.messages.orgId, fx.org.id)))
    .map((m) => m.meta.notice as { kind?: string; text?: string } | undefined)
    .filter((n) => n?.kind === "proposal_result")
    .map((n) => n?.text ?? "");
/** Who "Pedir a um admin" reached. */
const askedOf = async (fx: Fixture) =>
  (
    await fx.db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, fx.org.id), eq(schema.notifications.kind, "change_request")))
  ).map((n) => n.userId);

describe("an agent's skills on the card, as on its page", () => {
  test("given and taken at once for who may, by name, with Undo putting them back", async () => {
    f = await setup({ rightHand: true });
    const excel = await install(f, "excel");
    const pdf = await install(f, "pdf");
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: pdf.id, enabled: true }]);
    const ctx = await lodiRun(f, f.owner.id, "dá a skill de Excel pro dev e tira a de pdf", true);
    const out = await call(f, ctx, {
      changes: [{ agent: "@dev", add_skills: ["Excel"], remove_skills: ["pdf"] }],
      reason: "pediu",
    });
    expect(out.content).toContain("applied at once");
    expect(await skillsOf(f)).toEqual(["excel"]);
    const { card, rows } = await cardRows(f, f.owner.id);
    expect(rows.map((r) => [r.status, r.settings])).toEqual([
      [
        "accepted",
        [
          { field: "skill", skillId: excel.id, from: false, to: true, label: { to: "excel" } },
          { field: "skill", skillId: pdf.id, from: true, to: false, label: { to: "pdf" } },
        ],
      ],
    ]);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await skillsOf(f)).toEqual(["pdf"]);
  });

  test("only who manages agents decides it, as on its page: its owner sends the card on, an admin applies it", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: bia.id });
    const asked = await lodiRun(f, bia.id, "coloca a skill excel no dev", true);
    const out = await call(f, asked, { changes: [{ agent: "@dev", add_skills: ["excel"] }], reason: "pediu" });
    expect(out.content).toContain("can't apply it: the card lets them send it to whoever may");
    const [row] = (await cardRows(f, bia.id)).rows;
    expect(row).toMatchObject({ status: "pending", canDecide: false });
    await expect(decideProposal(f.db, bia.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    expect(await skillsOf(f)).toEqual([]);
    await askProposal({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, row?.id ?? "");
    expect(await askedOf(f)).toEqual([f.owner.id]);
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await skillsOf(f)).toEqual(["excel"]);
  });

  test("clear refusals: a skill not installed, one it already has, the right hand's own, one removed since", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "dá a skill excel pro dev");
    const none = await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["excel"] }], reason: "pediu" });
    expect(none).toMatchObject({ isError: true });
    expect(none.content).toContain("No skill is installed here yet");
    const excel = await install(f, "excel");
    await install(f, "pdf");
    const unknown = await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["planilhas"] }], reason: "pediu" });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content).toStartWith("No skill planilhas. Skills here: excel, pdf. One not installed yet:");
    const taken = await call(f, ctx, { changes: [{ agent: "@dev", remove_skills: ["excel"] }], reason: "pediu" });
    expect(taken).toMatchObject({ isError: true });
    expect(taken.content).toContain("@dev doesn't have the skill excel.");
    const own = await call(f, ctx, { changes: [{ agent: "@lodi", add_skills: ["excel"] }], reason: "pediu" });
    expect(own.content).toContain("You can't change your own skill");

    // Outside content read: it waits on the card, and goes out of date once the skill is removed.
    await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["excel"] }], reason: "pediu" });
    const [row] = (await cardRows(f, f.owner.id)).rows;
    expect(row?.status).toBe("pending");
    await deleteSkill(f.db, f.owner.id, f.org.id, excel.id);
    await expect(decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow(/changed since/);
    expect(await skillsOf(f)).toEqual([]);
  });

  test("a name finds its own skill before one that differs only by a hyphen", async () => {
    f = await setup({ rightHand: true });
    await install(f, "pdf-tools");
    const plain = await install(f, "pdftools");
    const ctx = await lodiRun(f, f.owner.id, "dá a skill pdftools pro dev");
    await call(f, ctx, { changes: [{ agent: "@dev", add_skills: ["pdftools"] }], reason: "pediu" });
    expect((await cardRows(f, f.owner.id)).rows[0]?.settings).toMatchObject([{ field: "skill", skillId: plain.id }]);
  });

  test("the proposer hears each skill on or off by its name", async () => {
    f = await setup({ rightHand: true });
    const pdf = await install(f, "pdf");
    await setAgentSkills(f.db, f.owner.id, f.org.id, f.agent.id, [{ skillId: pdf.id, enabled: true }]);
    const ctx = await lodiRun(f, f.owner.id, "tira a skill pdf do dev");
    await call(f, ctx, { changes: [{ agent: "@dev", remove_skills: ["pdf"] }], reason: "pediu" });
    const [row] = (await cardRows(f, f.owner.id)).rows;
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await skillsOf(f)).toEqual([]);
    const [notice] = await notices(f);
    expect(notice).toContain(`@dev's settings: skill "pdf" off.`);
  });
});

describe("an agent asks for its own settings on the same card (request_settings_change)", () => {
  /** A run of @dev on what `userId` wrote to it in #general, in their own words unless it relays outside content. */
  async function devRun(fx: Fixture, userId: string, body: string, outside = false): Promise<ToolContext> {
    const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, fx.general.id, {
      body: `@dev ${body}`,
    });
    if (outside)
      await fx.db
        .update(schema.messages)
        .set({ meta: { readOutside: true } })
        .where(eq(schema.messages.id, trigger.id));
    const [run] = await fx.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.triggerMessageId, trigger.id), eq(schema.agentRuns.agentId, fx.agent.id)));
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
  async function ask(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
    const res = await gatewayOf(fx).invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: REQUEST_SETTINGS_TOOL,
      input,
    });
    if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
    return res.output;
  }

  test("every agent but the right hand holds it in any run, without the setup tools, and is told to ask with it", async () => {
    f = await setup({ rightHand: true });
    const ctx = await devRun(f, f.owner.id, "liga a skill excel pra você");
    await setAgentScopes(f.db, f.owner.id, f.org.id, f.agent.id, [{ connectionId: null, scope: "skills:read" }]);
    const granted = await gatewayOf(f).granted(ctx);
    expect(granted.map((t) => t.name)).toContain(REQUEST_SETTINGS_TOOL);
    expect(granted.map((t) => t.name)).not.toContain(PROPOSE_SETTINGS_TOOL);
    // No group loaded for this message: it waits on demand, and what the agent can do names it.
    expect(describeCapabilities(presentTools(granted, undefined, []))).toContain("ask with `request_settings_change`");
    const lodi = await lodiRun(f, f.owner.id, "oi");
    expect((await gatewayOf(f).granted(lodi)).map((t) => t.name)).not.toContain(REQUEST_SETTINGS_TOOL);
  });

  test("it waits for a click even when an admin asked in their own words, and no other agent is a target", async () => {
    f = await setup({ rightHand: true });
    const excel = await install(f, "excel");
    const ctx = await devRun(f, f.owner.id, "liga a skill excel pra você");
    // Lodi's card would apply this at once: the admin wrote it, and may.
    expect(await ownWords(ctx)).toBe(f.owner.id);
    const other = await ask(f, ctx, { agent: "@lodi", add_skills: ["excel"], reason: "pediu" });
    expect(other).toMatchObject({ isError: true });
    expect(other.content).toContain("input.agent: not allowed");
    const out = await ask(f, ctx, { add_skills: ["excel"], reason: "Preciso dela para ler a planilha" });
    expect(out.content).toContain("Posted the card for your settings; the person who asked applies it from the card.");
    expect(out.content).toContain("Your own settings wait for that click");
    expect(out.content).toContain("Nothing has changed yet");
    const { card, rows } = await cardRows(f, f.owner.id);
    expect(card.meta).toMatchObject({ bodyCode: SETTINGS_REQUEST_CARD, bodyParams: {} });
    expect(rows).toMatchObject([
      {
        status: "pending",
        canDecide: true,
        agentId: f.agent.id,
        proposedByAgentId: f.agent.id,
        requestedByUserId: f.owner.id,
        settings: [{ field: "skill", skillId: excel.id, from: false, to: true }],
      },
    ]);
    expect(await skillsOf(f)).toEqual([]);
  });

  test("an admin's click applies it as them, Undo puts it back, and the agent hears its own settings changed", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    const ctx = await devRun(f, f.owner.id, "liga a skill excel pra você");
    await ask(f, ctx, { add_skills: ["excel"], reason: "pediu" });
    const { card, rows } = await cardRows(f, f.owner.id);
    await decideProposal(f.db, f.owner.id, f.org.id, rows[0]?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await skillsOf(f)).toEqual(["excel"]);
    expect((await notices(f))[0]).toContain(`your settings: skill "excel" on.`);
    const [receipt] = (await actionsFor(f.db, f.org.id, [card.id])).get(card.id) ?? [];
    expect(receipt).toMatchObject({
      kind: "agent.settings_changed",
      agentId: f.agent.id,
      requestedByUserId: f.owner.id,
    });
    // Its owner may undo its other changes, never a skill's: skills are only admins' on its page.
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    const undo = { db: f.db, pubsub: f.pubsub };
    await expect(undoAgentAction(undo, caio.id, f.org.id, receipt?.id ?? "")).rejects.toThrow(/Only an admin/);
    await undoAgentAction(undo, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await skillsOf(f)).toEqual([]);
    await expect(redoAgentAction(undo, caio.id, f.org.id, receipt?.id ?? "")).rejects.toThrow(/Only an admin/);
    expect(await skillsOf(f)).toEqual([]);
  });

  test("Desfazer tudo by the agent's owner undoes nothing of a card with a skill on it, not even its own rows", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    const design = await createChannel(f.db, f.owner.id, f.org.id, { name: "design" });
    const ctx = await devRun(f, f.owner.id, "liga a skill excel e entra no design");
    await ask(f, ctx, { add_skills: ["excel"], join: ["design"], reason: "pediu" });
    const { card, rows } = await cardRows(f, f.owner.id);
    // The skill's row first: Desfazer tudo starts from the newest receipt, the channel's, which its owner may undo.
    const skillRow = rows.find((r) => r.settings?.[0]?.field === "skill");
    const seatRow = rows.find((r) => r.settings?.[0]?.field === "channel_add");
    for (const r of [skillRow, seatRow]) await decideProposal(f.db, f.owner.id, f.org.id, r?.id ?? "", "accept");
    // Its owner, in #design: alone, the channel's receipt is one he may undo.
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, design.id, { userId: caio.id });
    const seated = async () =>
      (
        await f.db
          .select({ id: schema.channelMembers.id })
          .from(schema.channelMembers)
          .where(and(eq(schema.channelMembers.channelId, design.id), eq(schema.channelMembers.agentId, f.agent.id)))
      ).length;
    await expect(undoMessageActions({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, card.id)).rejects.toThrow(
      /Only an admin/,
    );
    expect(await seated()).toBe(1);
    expect(await skillsOf(f)).toEqual(["excel"]);
  });

  test("a member who can't decide it sends it with Pedir a um admin; it reaches admins, not the agent's owner", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    const bia = await addMember(f.db, f.org.id, "member", "Bia Rocha");
    // Its owner decides its channels, never its skills: the card goes to admins alone.
    const caio = await addMember(f.db, f.org.id, "member", "Caio Mendes");
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { ownerUserId: caio.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const ctx = await devRun(f, bia.id, "liga a skill excel pra você");
    const out = await ask(f, ctx, { add_skills: ["excel"], reason: "pediu" });
    expect(out.content).toContain("can't apply it: the card lets them send it to whoever may");
    const [row] = (await cardRows(f, bia.id)).rows;
    expect(row).toMatchObject({ status: "pending", canDecide: false, askedAt: null, requestedByUserId: bia.id });
    await expect(decideProposal(f.db, bia.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    await expect(decideProposal(f.db, caio.id, f.org.id, row?.id ?? "", "accept")).rejects.toThrow();
    await askProposal({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, row?.id ?? "");
    expect(await askedOf(f)).toEqual([f.owner.id]);
    await decideProposal(f.db, f.owner.id, f.org.id, row?.id ?? "", "accept", { pubsub: f.pubsub });
    expect(await skillsOf(f)).toEqual(["excel"]);
  });

  test("the right hand never looks at its card for the person, though it looks at the agent's card on a teammate", async () => {
    f = await setup({ rightHand: true });
    await install(f, "excel");
    await setRightHandApprovals({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { enabled: true });
    const looks = async () =>
      (
        await f.db
          .select({ id: schema.outbox.id })
          .from(schema.outbox)
          .where(and(eq(schema.outbox.orgId, f.org.id), eq(schema.outbox.kind, RIGHT_HAND_DECIDE_JOB)))
      ).length;
    const ctx = await devRun(f, f.owner.id, "liga a skill excel pra você e sobe o limite do lodi", true);
    await ask(f, ctx, { add_skills: ["excel"], reason: "pediu" });
    expect(await looks()).toBe(0);
    await call(f, ctx, { changes: [{ agent: "@lodi", budget_usd: 20 }], reason: "pediu" });
    expect(await looks()).toBe(1);
  });

  test("a skill on and off at once is refused, and a long list of skills is cut short", async () => {
    f = await setup({ rightHand: true });
    for (let i = 0; i < 25; i++) await install(f, `skill-${String(i).padStart(2, "0")}`);
    const ctx = await devRun(f, f.owner.id, "liga e desliga a skill-00 pra você");
    const both = await ask(f, ctx, { add_skills: ["skill-00"], remove_skills: ["skill-00"], reason: "pediu" });
    expect(both).toMatchObject({
      isError: true,
      content: "Each skill goes on or off, not both: skill-00 is in add_skills and remove_skills.",
    });
    const unknown = await ask(f, ctx, { add_skills: ["planilhas"], reason: "pediu" });
    expect(unknown.content).toContain("skill-19, +5 more.");
    expect(unknown.content).not.toContain("skill-20");
  });
});
