import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  answersAgentsOnly,
  approverIds,
  canTalkTo,
  consultationConversation,
  consultationOrigin,
  consultationsIn,
  createAgent,
  drainOutbox,
  insertMessage,
  noAgentText,
  openDm,
  postPersonMessage,
  setAgentAudience,
  speakerFor,
  type ToolContext,
  viaAgent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * "Outros agentes podem consultar" (ADR 0085 addendum): a front-desk agent a person may talk to consults a specialist
 * that person may not. With the switch on (the default) the specialist answers the agent that asked, in their DM,
 * never the person; off, it is refused as before. A plan answering only its owner keeps them out either way.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Lia, a test person who may talk only to Dev (the front desk); Nino, the specialist, answers only its owner Ana. */
async function world(nino: Partial<typeof schema.agents.$inferInsert> = {}) {
  const lia = await addMember(f.db, f.org.id, "member", "lia");
  const specialist = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Nino", handle: "nino", role: "Faturamento", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const [row] = await f.db
    .update(schema.agents)
    .set({ ownerUserId: f.owner.id, audienceMode: "owner", ...nino })
    .where(eq(schema.agents.id, specialist.id))
    .returning();
  if (!row) throw new Error("no agent");
  return { lia, nino: row };
}

/** A run of @dev in #general started by `userId`'s message, and its tool context. */
async function devRunFor(userId: string, body: string): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

const invoke = (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  if (!f.tools) throw new Error("no tools");
  return f.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
};

/** The system prompt of the run answering in the agents' DM. */
const agentsDmPrompt = () =>
  f.provider.calls
    .map((c) => systemText(c.request.system))
    .find((s) => s.includes("A private conversation between agents"));

const ask = (ctx: ToolContext) => invoke(ctx, "ask_agent", { agent: "@nino", question: "A fatura 812 foi paga?" });

describe("other agents can consult it", () => {
  test("on: it answers the agent that asked, in their DM; nothing of it reaches the person", async () => {
    f = await setup({ askAgent: true, askUser: true, chatTools: true, reply: () => ({ chunks: ["Paga em 3/11."] }) });
    const { lia, nino } = await world();
    const ctx = await devRunFor(lia.id, "@dev a fatura 812 foi paga?");
    expect(await ask(ctx)).toMatchObject({ output: { content: expect.stringContaining("Asked @nino") } });
    await drainOutbox(f.db, f.handlers);

    const [consultation] = await f.db.select().from(schema.agentConsultations);
    expect(consultation).toMatchObject({ targetAgentId: nino.id, status: "answered" });
    expect(consultation?.channelId).not.toBe(f.general.id);
    // Nino wrote only in the agents' DM: nothing in #general, no DM with Lia.
    const said = await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, nino.id));
    expect(said.length).toBeGreaterThan(0);
    expect(said.every((m) => m.channelId === consultation?.channelId)).toBe(true);

    // Its run answers agents only: its cards (approvals, questions) stay in the agents' DM, its DMs are refused.
    const runId = consultation?.targetRunId ?? "";
    expect(await answersAgentsOnly(f.db, f.org.id, runId)).toBe(true);
    expect(await consultationOrigin(f.db, f.org.id, runId)).toBeNull();
    const ninoCtx = { ...ctx, agentId: nino.id, runId, channelId: consultation?.channelId ?? "" };
    expect(await invoke(ninoCtx, "send_dm", { person: "lia", text: "Paga." })).toMatchObject({
      output: { isError: true, content: expect.stringContaining("You were consulted by another agent") },
    });
    // Nobody would see a question card: it is refused, and its prompt never offers to ask Lia.
    expect(
      await invoke(ninoCtx, "ask_user", {
        why: "Há duas faturas com o número 812, uma de março e outra de abril, e a resposta muda com isso.",
        question: "Qual fatura?",
      }),
    ).toMatchObject({
      output: { isError: true, content: expect.stringContaining("No person reads this conversation") },
    });
    expect(agentsDmPrompt()).toContain("Still missing: say in your answer exactly what");
    expect(agentsDmPrompt()).not.toContain("ask lia with `ask_user`");

    // Where Lia reads: the consultation's state, never Nino's words (the list, the panel, the trail on Dev's reply).
    const [listed] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(listed).toMatchObject({ status: "answered", answer: null, progress: null });
    const opened = await consultationConversation(f.db, f.org.id, f.general.id, consultation?.id ?? "");
    expect(opened?.consultation.answer).toBeNull();
    expect(opened?.messages).toEqual([]);
    const replies = (await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, f.general.id)))
      .map((m) => (m.meta as { notice?: { kind: string; refs?: Record<string, string> } }).notice)
      .filter((n) => n?.kind === "consult_reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.refs?.status).toBe("answered");
    expect(replies[0]?.refs?.answer).toBeUndefined();
  });

  test("a person it does answer still sees its cards where they asked", async () => {
    f = await setup({ askAgent: true, reply: () => ({ chunks: ["Paga."] }) });
    await world();
    await ask(await devRunFor(f.owner.id, "@dev a fatura 812 foi paga?"));
    const [consultation] = await f.db.select().from(schema.agentConsultations);
    const runId = consultation?.targetRunId ?? "";
    expect(await answersAgentsOnly(f.db, f.org.id, runId)).toBe(false);
    expect((await consultationOrigin(f.db, f.org.id, runId))?.channelId).toBe(f.general.id);
    await drainOutbox(f.db, f.handlers);
    expect((await consultationsIn(f.db, f.org.id, f.general.id))[0]?.answer).toBe("Paga.");
    expect(agentsDmPrompt()).toContain("Still missing: ask ana with `ask_user`");
  });

  test("off: refused with the line that says why and how to open it", async () => {
    f = await setup({ askAgent: true });
    const { lia } = await world({ consultable: false });
    expect(await ask(await devRunFor(lia.id, "@dev a fatura 812 foi paga?"))).toMatchObject({
      output: {
        isError: true,
        content: expect.stringContaining(
          "@nino only works with some people and doesn't take questions from other agents for anyone else",
        ),
      },
    });
    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
  });

  test("a plan that answers only its owner keeps them out, switch or not; its 'reply to everyone' lets them in", async () => {
    f = await setup({ askAgent: true });
    const { lia, nino } = await world({ brain: "claude_code" });
    const via = viaAgent(await speakerFor(f.db, f.org.id, lia.id));
    expect(canTalkTo(nino, lia.id, via)).toBe(false);
    expect(await ask(await devRunFor(lia.id, "@dev a fatura 812 foi paga?"))).toMatchObject({
      output: { isError: true, content: expect.stringContaining("@nino only works with some people") },
    });
    // "Só algumas pessoas" with nobody but its owner picked (what a move onto a plan keeps): still only its owner.
    for (const audienceUserIds of [[], [f.owner.id]]) {
      expect(canTalkTo({ ...nino, audienceMode: "people", audienceUserIds }, lia.id, via)).toBe(false);
    }
    // Its owner turned the plan's switch on (some people, Lia not among them): consulted for her.
    const shared = { ...nino, audienceMode: "people" as const, audienceUserIds: [crypto.randomUUID()] };
    expect(canTalkTo(shared, lia.id, via)).toBe(true);
    expect(canTalkTo({ ...shared, consultable: false }, lia.id, via)).toBe(false);
    // Never directly.
    expect(canTalkTo(shared, lia.id, await speakerFor(f.db, f.org.id, lia.id))).toBe(false);
  });

  test("the switch: its owner or an admin turns it off and on again, on a plan too, audited", async () => {
    f = await setup({ askAgent: true });
    const { nino } = await world({ brain: "claude_code", audienceMode: "people", audienceUserIds: [] });
    const caio = await addMember(f.db, f.org.id, "admin", "caio");
    const set = (actor: string, consultable: boolean) =>
      setAgentAudience(f.db, actor, f.org.id, nino.id, { mode: "people", userIds: [], consultable }).catch((e) => e);
    expect((await set(caio.id, false)).consultable).toBe(false);
    expect((await set(caio.id, true)).consultable).toBe(true);
    const audits = (await f.db.select().from(schema.auditLog)).filter((a) => a.action === "agent.audience_changed");
    expect(audits.map((a) => (a.details as { to: { consultable: boolean } }).to.consultable)).toEqual([false, true]);
    // Absent (an older app): kept.
    expect(
      (await setAgentAudience(f.db, caio.id, f.org.id, nino.id, { mode: "people", userIds: [] })).consultable,
    ).toBe(true);
  });

  test("turning the switch under 'only its owner' keeps who its plan kept out, for when the plan is let out", async () => {
    f = await setup({ askAgent: true });
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    const { nino } = await world({ brain: "claude_code", audienceUserIds: [lia.id] });
    const updated = await setAgentAudience(f.db, f.owner.id, f.org.id, nino.id, {
      mode: "owner",
      userIds: [],
      roleIds: [],
      consultable: false,
    });
    expect(updated).toMatchObject({ audienceMode: "owner", audienceUserIds: [lia.id], consultable: false });
  });

  test("its approvals go to the people who decide for it, never to the person it was consulted for", async () => {
    f = await setup({ askAgent: true });
    const { lia, nino } = await world();
    const deciders = await approverIds(f.db, { orgId: f.org.id, ownerUserId: nino.ownerUserId, tool: "merge" });
    expect(deciders).toContain(f.owner.id);
    expect(deciders).not.toContain(lia.id);
  });

  test("a handle that doesn't exist: only ask_agent and tell_agent suggest the agents it consults for the person", async () => {
    f = await setup({ askAgent: true });
    const { lia } = await world();
    const ctx = await devRunFor(lia.id, "@dev cria um tópico pro nin");
    expect(await noAgentText(ctx, ["nin"])).not.toContain("@nino");
    expect(await noAgentText(ctx, ["nin"], { viaAgent: true })).toContain("@nino");
  });

  test("the person still can't talk to it directly: no DM, no run from a mention", async () => {
    f = await setup({ askAgent: true });
    const { lia, nino } = await world();
    await expect(openDm(f.db, lia.id, f.org.id, { agentId: nino.id })).rejects.toMatchObject({
      code: "audience.only",
    });
    await f.db.insert(schema.channelMembers).values([
      { orgId: f.org.id, channelId: f.general.id, agentId: nino.id },
      { orgId: f.org.id, channelId: f.general.id, userId: lia.id },
    ]);
    const sent = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, lia.id, f.org.id, f.general.id, {
      body: "@nino a fatura 812 foi paga?",
    });
    expect(sent.notices?.map((n) => n.agentId)).toEqual([nino.id]);
    const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, nino.id));
    expect(runs).toEqual([]);
  });
});
