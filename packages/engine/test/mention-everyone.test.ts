import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { mentionsEveryone } from "@agenteschat/i18n/everyone";
import {
  addChannelMember,
  createAgent,
  createRole,
  drainOutbox,
  insertMessage,
  listMembers,
  listNotifications,
  openDm,
  postPersonMessage,
  replyPolicyFor,
  setAgentAudience,
  setMemberRoles,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/**
 * #general: Ana (owner), Bia and Caio (members), `@dev` (answers anyone), `@ops` (answers only Caio, its owner) and
 * Lodi; `@fora` is outside it.
 */
async function world() {
  f = await setup({ rightHand: true, reply: () => ({ chunks: ["ok"] }) });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await listMembers(f.db, f.org.id);
  for (const u of [bia, caio]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  const model = { model: "claude-sonnet-5-5" };
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", ownerUserId: caio.id },
    model,
  );
  await setAgentAudience(f.db, f.owner.id, f.org.id, ops.id, { mode: "owner", userIds: [] });
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
  const fora = await createAgent(f.db, f.owner.id, f.org.id, { name: "Fora", handle: "fora" }, model);
  const [lodi] = await f.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, "right_hand")));
  if (!lodi) throw new Error("no right hand");
  await f.db
    .insert(schema.channelMembers)
    .values({ orgId: f.org.id, channelId: f.general.id, agentId: lodi.id })
    .onConflictDoNothing();
  return { bia, caio, ops, fora, lodi };
}

const runsOf = (messageId: string) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId));

describe("@todos (a mention of everyone)", () => {
  test("any language's word, as a mention, not inside a word or an email", () => {
    for (const body of ["@todos reunião às 15h", "oi @everyone", "@Alle bitte", "(@tous)", "@全員 確認して", "@все"])
      expect(mentionsEveryone(body)).toBe(true);
    for (const body of ["a@todos.com", "@todosx", "@всем", "todos", "@todo"])
      expect(mentionsEveryone(body)).toBe(false);
  });

  test("an owner's @todos mentions every person and wakes every agent that answers them here, never Lodi", async () => {
    const { bia, caio, ops, fora, lodi } = await world();
    const m = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@todos reunião às 15h" });
    expect(m.meta).toMatchObject({ mentionsEveryone: true, everyoneAgentIds: [f.agent.id] });
    expect(new Set(m.mentionedUserIds)).toEqual(new Set([bia.id, caio.id]));
    // `@ops` answers only Caio and `@fora` isn't here; Lodi is never one of everyone.
    expect(m.mentionedAgentIds).toEqual([f.agent.id]);
    for (const id of [ops.id, fora.id, lodi.id]) expect(m.mentionedAgentIds).not.toContain(id);
    // No "won't answer you" notice for agents nobody named.
    expect(m.notices ?? []).toEqual([]);
    const [run] = await runsOf(m.id);
    expect(run).toMatchObject({ agentId: f.agent.id, trigger: "mention", hop: 1 });
    // Not named, so it may stay quiet like an agent the router brought in.
    expect(replyPolicyFor(run as NonNullable<typeof run>, { authorType: "person", meta: m.meta }).mayPass).toBe(true);
    await drainOutbox(f.db, f.handlers);
    for (const u of [bia, caio]) {
      const { items } = await listNotifications(deps(), u.id, f.org.id);
      expect(items.map((n) => n.kind)).toContain("mention");
    }
  });

  test("named too, an agent must answer; its run follows Caio's reach when he writes it", async () => {
    const { caio, ops } = await world();
    await f.db
      .update(schema.organizationMembers)
      .set({ role: "owner" })
      .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, caio.id)));
    const m = await postPersonMessage(deps(), caio.id, f.org.id, f.general.id, { body: "@everyone @dev olha isso" });
    expect(m.meta).toMatchObject({ mentionsEveryone: true, everyoneAgentIds: [ops.id] });
    expect(new Set(m.mentionedAgentIds)).toEqual(new Set([f.agent.id, ops.id]));
    const runs = await runsOf(m.id);
    expect(runs.map((r) => r.agentId).sort()).toEqual([f.agent.id, ops.id].sort());
    const dev = runs.find((r) => r.agentId === f.agent.id);
    expect(replyPolicyFor(dev as NonNullable<typeof dev>, { authorType: "person", meta: m.meta }).mayPass).toBe(false);
  });

  test("without `mention_everyone` it stays plain text, until a role gives it", async () => {
    const { bia } = await world();
    const plain = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@todos bom dia" });
    expect(plain.meta.mentionsEveryone).toBeUndefined();
    expect(plain.mentionedUserIds).toEqual([]);
    expect(plain.mentionedAgentIds).toEqual([]);
    expect(await runsOf(plain.id)).toEqual([]);

    const role = await createRole(f.db, f.owner.id, f.org.id, { name: "Avisos", permissions: ["mention_everyone"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [role.id]);
    const loud = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@todos bom dia" });
    expect(loud.meta.mentionsEveryone).toBe(true);
    expect(loud.mentionedUserIds).toContain(f.owner.id);
    expect(loud.mentionedAgentIds).toEqual([f.agent.id]);
  });

  test("an agent never mentions everyone, and a message's meta can't claim it", async () => {
    await world();
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "@todos terminei",
      meta: { mentionsEveryone: true, everyoneAgentIds: [f.agent.id] },
    });
    expect(said.meta.mentionsEveryone).toBeUndefined();
    expect(said.meta.everyoneAgentIds).toBeUndefined();
    expect(said.mentionedUserIds).toEqual([]);
    expect(said.mentionedAgentIds).toEqual([]);
  });

  test("leaves out a held agent and what each agent asked; someone also named is mentioned once", async () => {
    const { bia } = await world();
    const asked = await postPersonMessage(deps(), bia.id, f.org.id, f.general.id, { body: "@dev qual branch?" });
    const [askRun] = await runsOf(asked.id);
    if (!askRun) throw new Error("no run");
    const [question] = await f.db
      .insert(schema.agentQuestions)
      .values({
        orgId: f.org.id,
        runId: askRun.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        toolUseId: "ask-1",
        text: "Qual branch?",
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();
    const held = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Held", handle: "held" },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: held.id });
    await f.db.update(schema.agents).set({ operatorHoldAt: new Date() }).where(eq(schema.agents.id, held.id));

    const m = await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@todos @bia reunião" });
    expect(m.mentionedAgentIds).not.toContain(held.id);
    expect(m.mentionedUserIds.filter((id) => id === bia.id)).toHaveLength(1);
    const [still] = await f.db
      .select({ status: schema.agentQuestions.status })
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.id, (question as NonNullable<typeof question>).id));
    expect(still?.status).toBe("open");
    await drainOutbox(f.db, f.handlers);
    const { items } = await listNotifications(deps(), bia.id, f.org.id);
    expect(items.filter((n) => n.kind === "mention")).toHaveLength(1);
  });

  test("in a DM it does nothing", async () => {
    await world();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const m = await postPersonMessage(deps(), f.owner.id, f.org.id, dm.id, { body: "@todos oi" });
    expect(m.meta.mentionsEveryone).toBeUndefined();
    expect(m.mentionedAgentIds).toEqual([]);
  });
});
