import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, asc, eq, inArray, schema, sql } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  answerNow,
  continueStretch,
  createAgent,
  drainOutbox,
  FOLLOW_UP_JOB,
  FOLLOW_UP_TOOL,
  getMessage,
  insertMessage,
  openAgentDm,
  postPersonMessage,
  postStretchCard,
  receiptsFor,
  releaseInbox,
  requireChannelAccess,
  runAuthority,
  STRETCH,
  STRETCH_JOB,
  STRETCH_REFUSAL,
  startOrJoinRun,
  stretchCardOf,
} from "../src";
import { deliverNotice } from "../src/delivery";
import { refusedAtLimit } from "../src/stretch";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Agents keep going until the work is done (ADR 0089): no cap on hand-offs between them, a judge that reads intent
 * in any language, and limits in code that read no words: 50 runs agents start on their own per stretch (10 when
 * nobody asked), 20% of an agent's monthly budget per stretch, a fresh stretch at every person's input, and one
 * card with Continuar when a limit holds them. Fake judges key on call order and the fake model on whose prompt it
 * is, never on what anyone wrote.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** Whose model call it is: its prompt names the agent, never its words. */
const isFor = (req: ModelRequest, name: string, handle: string) =>
  systemText(req.system).includes(`You are ${name} (@${handle})`);

/** An agent of #general. */
async function agentIn(fx: Fixture, name: string, handle: string) {
  const agent = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name, handle, role: "Analytics", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await fx.db.insert(schema.channelMembers).values({ orgId: fx.org.id, channelId: fx.general.id, agentId: agent.id });
  return agent;
}

/** Theo and Ada, two agents of #general. */
const team = async (fx: Fixture) => ({ theo: await agentIn(fx, "Theo", "theo"), ada: await agentIn(fx, "Ada", "ada") });

/** `count` runs agents already started on their own in `stretchId` (`agentId`'s, in #general under `threadRootId`). */
const fillStretch = (
  fx: Fixture,
  agentId: string,
  stretchId: string,
  threadRootId: string,
  count: number = STRETCH.runs,
) =>
  fx.db.insert(schema.agentRuns).values(
    Array.from({ length: count }, () => ({
      orgId: fx.org.id,
      agentId,
      channelId: fx.general.id,
      threadRootId,
      triggerMessageId: Bun.randomUUIDv7(),
      trigger: "mention" as const,
      hop: 2,
      stretchId,
      status: "done" as const,
    })),
  );

/** Each agent says its lines in turn (then "ok"); a structured call (the router's) hears nobody. */
const lines = (said: { theo: string[]; ada: string[] }) => {
  const turn = { theo: 0, ada: 0 };
  return (req: ModelRequest) => {
    if (req.outputSchema) return { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] };
    const who = isFor(req, "Theo", "theo") ? "theo" : isFor(req, "Ada", "ada") ? "ada" : null;
    if (!who) return { chunks: ["ok"] };
    return { chunks: [said[who][turn[who]++] ?? "ok"] };
  };
};

/** Theo and Ada hand the work back to each other forever. */
const pingPong = (req: ModelRequest) =>
  req.outputSchema
    ? { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] }
    : { chunks: [isFor(req, "Theo", "theo") ? "@ada sua vez: revisa o PR #12?" : "@theo revisei: corrige os testes?"] };

/** The mention judge's answers in order (how sure each message needs nothing from the agent it names), then `rest`. */
const inOrder = (scores: number[], rest = 1) => {
  let n = 0;
  return (kind: string) => (kind === "mention_needs_nothing" ? (scores[n++] ?? rest) : undefined);
};

const ask = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });
const drain = (fx: Fixture) => drainOutbox(fx.db, fx.handlers, { maxBatches: 2000 });
const runsOf = (fx: Fixture) => fx.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
const cardsOf = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt))).filter((m) =>
    stretchCardOf(m.meta),
  );

/** Postgres stores now() with microseconds; read back, `createdAt` is cut to milliseconds. */
const withMicroseconds = (fx: Fixture, messageId: string) =>
  fx.db
    .update(schema.messages)
    .set({ createdAt: sql`${schema.messages.createdAt} + interval '456 microseconds'` })
    .where(eq(schema.messages.id, messageId));

/** Every agent message past a person's carries its stretch: no path slips out of the count. */
async function expectStretched(fx: Fixture) {
  const loose = (await fx.db.select().from(schema.messages)).filter(
    (m) => m.authorType === "agent" && m.hop > 0 && !m.stretchId,
  );
  expect(loose.map((m) => [m.hop, m.body])).toEqual([]);
}

describe("Ada's question back wakes Theo, and a thanks wakes nobody", () => {
  const flows = {
    pt: {
      ask: "@theo, pode levantar os números do lançamento de ontem?",
      theo: ["@ada você tem o churn de setembro por plano?", "Valeu @ada, por agora basta. Ana, churn de 3,2%."],
      ada: ["@theo tenho: 3,2% no geral, 5% no Pro. Quer também o de agosto para comparar?"],
    },
    ja: {
      ask: "@theo 昨日のローンチの数字を出してもらえますか？",
      theo: ["@ada 9月のプラン別チャーンはありますか？", "@ada ありがとう、今はこれで十分です。"],
      ada: ["@theo あります。全体で3.2%、Proで5%です。比較のために8月分も要りますか？"],
    },
    ar: {
      ask: "@theo هل يمكنك تجهيز أرقام إطلاق الأمس؟",
      theo: ["@ada هل لديك معدل الإلغاء لشهر سبتمبر حسب الخطة؟", "@ada شكراً، هذا يكفي الآن."],
      ada: ["@theo نعم: 3.2% إجمالاً و5% في Pro. هل تريد أرقام أغسطس للمقارنة أيضاً؟"],
    },
  };
  for (const [language, flow] of Object.entries(flows)) {
    test(`in ${language}: hops 1, 2 and 3, then nothing, and Ada only mentioned on Theo's last message`, async () => {
      // Theo asks Ada (0.1: needs her), Ada answers and asks Theo back (0.1), Theo thanks her and asks nothing (0.9).
      f = await setup({ judge: inOrder([0.1, 0.1, 0.9]), reply: lines(flow) });
      const { theo, ada } = await team(f);
      const asked = await ask(f, flow.ask);
      await drain(f);

      const runs = await runsOf(f);
      expect(runs.map((r) => [r.agentId === theo.id ? "theo" : "ada", r.hop, r.status])).toEqual([
        ["theo", 1, "done"],
        ["ada", 2, "done"],
        ["theo", 3, "done"],
      ]);
      // One stretch, Ana's request.
      expect(new Set(runs.map((r) => r.stretchId))).toEqual(new Set([asked.id]));
      expect(await cardsOf(f)).toEqual([]);
      const last = await getMessage(f.db, f.org.id, runs[2]?.replyMessageId ?? "");
      if (!last) throw new Error("no reply");
      expect((await receiptsFor(f.db, f.org.id, [last])).get(last.id)?.referenced).toEqual([ada.id]);
      await expectStretched(f);
    });
  }
});

describe("the fuse: 50 runs agents start on their own, then one card with Continuar", () => {
  test("a judge that always hands off: exactly 50, one card; Continuar starts the held hand-off once", async () => {
    f = await setup({ judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined), reply: pingPong });
    const { theo, ada } = await team(f);
    const asked = await ask(f, "@theo começa a revisão do PR #12");
    await drain(f);

    const runs = await runsOf(f);
    expect(runs.filter((r) => r.hop >= 2).length).toBe(STRETCH.runs);
    expect(runs.length).toBe(STRETCH.runs + 1);
    expect(runs.every((r) => r.stretchId === asked.id && r.status === "done")).toBe(true);
    const [card, ...more] = await cardsOf(f);
    expect(more).toEqual([]);
    if (!card) throw new Error("no card");
    // Theo's 26th turn handed back to Ada: that wake-up waits on the card, written as Theo where the work was.
    const last = runs.at(-1);
    expect(last?.agentId).toBe(theo.id);
    expect(card.authorAgentId).toBe(theo.id);
    expect(card.agentRunId).toBe(last?.id ?? "");
    expect(card.meta).toMatchObject({
      bodyCode: "stretch_paused_runs",
      actionCard: {
        kind: "stretch_paused",
        stretchId: asked.id,
        state: "paused",
        reason: "runs",
        limit: STRETCH.runs,
        forUserId: f.owner.id,
        agentIds: [ada.id],
        held: [{ agentId: ada.id, messageId: last?.replyMessageId, trigger: "mention" }],
      },
    });
    // The person behind the work hears of it.
    const told = await f.db.select().from(schema.notifications);
    expect(told.some((n) => n.userId === f.owner.id && n.source.messageId === card.id)).toBe(true);

    const deps = { db: f.db, pubsub: f.pubsub, gateway: f.gateway };
    const go = await answerNow(deps, f.owner.id, f.org.id, card.id);
    expect(go.runs.map((r) => r.agentId)).toEqual([ada.id]);
    const [resumed] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, go.runs[0]?.runId ?? ""));
    expect(resumed).toMatchObject({ agentId: ada.id, hop: 1, triggerMessageId: last?.replyMessageId });
    expect(resumed?.stretchId).not.toBe(asked.id);
    expect((await getMessage(f.db, f.org.id, card.id))?.meta.actionCard).toMatchObject({
      state: "continued",
      continuedByUserId: f.owner.id,
    });
    // A second press starts nothing.
    expect(await answerNow(deps, f.owner.id, f.org.id, card.id)).toEqual({ runs: [] });
    expect((await runsOf(f)).length).toBe(STRETCH.runs + 2);
    await expectStretched(f);
  });

  test("a judge that fails: a message that opens with @name still wakes, and the count still stops it", async () => {
    f = await setup({
      judge: (kind) => {
        if (kind === "mention_needs_nothing") throw new Error("judge down");
        return undefined;
      },
      reply: pingPong,
    });
    await team(f);
    await ask(f, "@theo começa a revisão do PR #12");
    await drain(f);
    const runs = await runsOf(f);
    expect(runs.filter((r) => r.hop >= 2).length).toBe(STRETCH.runs);
    expect((await cardsOf(f)).length).toBe(1);
    const decisions = await f.db.select().from(schema.routingDecisions);
    expect(decisions.every((d) => d.error === "judge down")).toBe(true);
    await expectStretched(f);
  });

  test("work nobody asked for (a routine's report) gets 10", async () => {
    f = await setup({ judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined), reply: pingPong });
    const { theo } = await team(f);
    // The agents' owner never joined #general.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.orgId, f.org.id));
    const report = await f.db.transaction((tx) =>
      deliverNotice(tx, {
        orgId: f.org.id,
        agentId: theo.id,
        channelId: f.general.id,
        threadId: null,
        hop: 0,
        stretchId: null,
        notice: {
          kind: "routine_handoff",
          text: "3 erros novos no checkout desde as 9h.",
          from: "Routine «Sentry»",
          refs: { runId: Bun.randomUUIDv7(), routineName: "Sentry", report: "always" },
        },
      }),
    );
    await drain(f);
    const runs = await runsOf(f);
    expect(runs.filter((r) => r.hop >= 2).length).toBe(STRETCH.unattendedRuns);
    expect(runs.every((r) => r.stretchId === report.message.id)).toBe(true);
    const [card] = await cardsOf(f);
    expect(card?.meta.actionCard).toMatchObject({ reason: "runs", limit: STRETCH.unattendedRuns, forUserId: null });
    // Nobody is behind the work: the owner of the agent it stopped at hears of the pause, in a channel they didn't join.
    const told = await f.db.select().from(schema.notifications);
    expect(told.some((n) => n.userId === bia.id && n.source.messageId === card?.id)).toBe(true);
    await expectStretched(f);
  });
});

test("an agent past 20% of its monthly budget in the stretch stops; the other one still wakes", async () => {
  f = await setup({
    judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
    // Ada's one answer costs US$ 12 at the model's price, past 20% of the US$ 50 default budget.
    reply: (req) =>
      req.outputSchema
        ? { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] }
        : isFor(req, "Ada", "ada")
          ? {
              chunks: ["@theo o churn é 3,2%. Confere com o painel?"],
              usage: { inputTokens: 6_000_000, outputTokens: 10 },
            }
          : { chunks: ["@ada puxa o churn de setembro?"] },
  });
  const { theo, ada } = await team(f);
  await ask(f, "@theo levanta o churn de setembro");
  await drain(f);
  const runs = await runsOf(f);
  // Theo woke again after Ada spent; Ada's next wake-up is the one held.
  expect(runs.map((r) => [r.agentId === theo.id ? "theo" : "ada", r.hop])).toEqual([
    ["theo", 1],
    ["ada", 2],
    ["theo", 3],
  ]);
  const [card, ...more] = await cardsOf(f);
  expect(more).toEqual([]);
  expect(card?.meta).toMatchObject({
    bodyCode: "stretch_paused_spend",
    actionCard: { reason: "spend", limit: 20, agentIds: [ada.id] },
  });
  await expectStretched(f);
});

test("a person's message read mid-run sets hop 1 and a new stretch: the count starts over", async () => {
  f = await setup({
    judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
    reply: lines({ theo: ["@ada pode conferir o deploy?"], ada: ["Conferi: está no ar."] }),
  });
  const { theo, ada } = await team(f);
  const root = await ask(f, "Deploy de hoje");
  // A stretch 49 runs in, written by Ada at hop 6: Theo's run on it is the 50th agents start on their own.
  await fillStretch(f, ada.id, root.id, root.id, STRETCH.runs - 1);
  const handBack = await f.db.transaction(async (tx) => {
    const m = await insertMessage(tx, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: ada.id, runId: null, hop: 6, stretchId: root.id },
      body: "@theo sua vez",
    });
    await startOrJoinRun(tx, m, theo.id, "mention");
    return m;
  });
  const [theoRun] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.agentId, theo.id), eq(schema.agentRuns.triggerMessageId, handBack.id)));
  expect(theoRun).toMatchObject({ hop: 7, stretchId: root.id, status: "queued" });
  // Ana writes to Theo before his run reads anything: it reads her message first.
  const said = await ask(f, "@theo e o deploy?");
  await drain(f);

  const [after] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, theoRun?.id ?? ""));
  expect(after).toMatchObject({ hop: 1, stretchId: said.id, status: "done" });
  // His hand-off to Ada counts in Ana's new stretch, from zero: no card.
  const adaRun = (await runsOf(f)).find((r) => r.agentId === ada.id && r.stretchId === said.id);
  expect(adaRun).toMatchObject({ hop: 2, status: "done" });
  expect(await cardsOf(f)).toEqual([]);
  await expectStretched(f);
});

test("follow-up wakes in a row all run, and the last one still acts for Ana 30 links down", async () => {
  f = await setup({
    followUps: true,
    reply: (req) =>
      JSON.stringify(req.messages.at(-1)?.content).includes("tool_result")
        ? { chunks: ["Ainda rodando, volto já."] }
        : {
            chunks: [],
            toolUses: [{ name: FOLLOW_UP_TOOL, input: { minutes: 1, note: "Check CI run 42.", about: "ver o CI" } }],
          },
  });
  await ask(f, "@dev acompanha o CI até terminar");
  await drain(f);
  for (let i = 0; i < 30; i++) {
    await f.db
      .update(schema.outbox)
      .set({ nextAttemptAt: new Date() })
      .where(and(eq(schema.outbox.kind, FOLLOW_UP_JOB), eq(schema.outbox.status, "pending")));
    await drain(f);
  }
  const runs = await runsOf(f);
  expect(runs.length).toBe(31);
  expect(runs.every((r) => r.status === "done")).toBe(true);
  const last = runs.at(-1);
  if (!last) throw new Error("no run");
  expect(last.hop).toBe(31);
  expect(await runAuthority(f.db, last)).toEqual({ kind: "person", personId: f.owner.id });
  expect(await cardsOf(f)).toEqual([]);
  await expectStretched(f);
});

test("a tool refused at the limit: the agent says what is left, and the run Continuar starts reads that it may go on", async () => {
  const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
  f = await setup({
    askAgent: true,
    reply: (req) => {
      if (req.outputSchema) return { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] };
      if (lastText(req).includes("A person let you go on")) return { chunks: ["Retomando com o Infra."] };
      if (lastText(req).includes("tool_result")) return { chunks: ["Diagnóstico feito; falta perguntar ao Infra."] };
      return {
        chunks: [],
        toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "Como é o deploy de staging?" } }],
      };
    },
  });
  await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Infra", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const asked = await ask(f, "@dev investiga o deploy de staging");
  // Ana's stretch is already at its limit.
  await fillStretch(f, f.agent.id, asked.id, asked.id);
  await drain(f);
  expect(f.provider.calls.some((c) => lastText(c.request).includes("did what you may do on your own"))).toBe(true);
  expect(STRETCH_REFUSAL).toContain("did what you may do on your own");
  expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
  const [card, ...more] = await cardsOf(f);
  expect(more).toEqual([]);
  if (!card) throw new Error("no card");
  // Written as the refused run, where Ana reads; Continuar wakes that agent again, on the card.
  expect(card.agentRunId).not.toBeNull();
  expect(card.meta.actionCard).toMatchObject({
    forUserId: f.owner.id,
    agentIds: [f.agent.id],
    held: [{ agentId: f.agent.id, messageId: null }],
  });
  const go = await answerNow({ db: f.db, pubsub: f.pubsub, gateway: f.gateway }, f.owner.id, f.org.id, card.id);
  expect(go.runs.map((r) => r.agentId)).toEqual([f.agent.id]);
  await drain(f);
  expect(f.provider.calls.some((c) => lastText(c.request).includes("A person let you go on"))).toBe(true);
  const [resumed] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, go.runs[0]?.runId ?? ""));
  expect(resumed).toMatchObject({ hop: 1, status: "done", triggerMessageId: card.id });
  await expectStretched(f);
});

test("a tool refused for the spend of the agent it would wake: the card names that agent, Continuar wakes the asker", async () => {
  const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
  f = await setup({
    askAgent: true,
    reply: (req) => {
      if (req.outputSchema) return { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] };
      if (lastText(req).includes("tool_result")) return { chunks: ["Falta perguntar ao Infra."] };
      return {
        chunks: [],
        toolUses: [{ name: "ask_agent", input: { agent: "@infra", question: "Como é o deploy de staging?" } }],
      };
    },
  });
  const infra = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Infra", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const asked = await ask(f, "@dev investiga o deploy de staging");
  // Infra already spent US$ 11 of its US$ 50 in Ana's stretch, on a run agents started.
  const [spent] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: infra.id,
      channelId: f.general.id,
      threadRootId: asked.id,
      triggerMessageId: Bun.randomUUIDv7(),
      trigger: "dm",
      hop: 2,
      stretchId: asked.id,
      status: "done",
    })
    .returning();
  await f.db.insert(schema.usageRecords).values({
    orgId: f.org.id,
    agentId: infra.id,
    runId: spent?.id,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    requestedModel: "claude-sonnet-5-5",
    inputTokens: 1,
    outputTokens: 1,
    costNanoUsd: 11_000_000_000,
    billedTo: "org",
  });
  await drain(f);
  const [card, ...more] = await cardsOf(f);
  expect(more).toEqual([]);
  if (!card) throw new Error("no card");
  expect(card.body).toBe("Infra paused to check with you. It used 20% of the month's budget.");
  expect(card.meta.actionCard).toMatchObject({
    reason: "spend",
    agentIds: [infra.id],
    held: [{ agentId: f.agent.id, messageId: null }],
  });
  const go = await answerNow({ db: f.db, pubsub: f.pubsub, gateway: f.gateway }, f.owner.id, f.org.id, card.id);
  expect(go.runs.map((r) => r.agentId)).toEqual([f.agent.id]);
});

test("a wake-up held inside the agents' DM: its card goes where the person asked, and Continuar starts it in the DM", async () => {
  f = await setup({ reply: lines({ theo: [], ada: [] }) });
  const { theo } = await team(f);
  const asked = await ask(f, "@dev investiga o deploy de staging");
  const [dev] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
  if (!dev) throw new Error("no run");
  await fillStretch(f, theo.id, asked.id, asked.id);
  const dm = await openAgentDm(f.db, f.org.id, f.agent.id, theo.id);
  // Dev's note to Theo in their private DM, past Ana's stretch.
  const note = await f.db.transaction(async (tx) => {
    const m = await insertMessage(tx, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "agent", agentId: f.agent.id, runId: dev.id, hop: dev.hop },
      body: "Theo, confere o deploy de staging.",
      meta: { agentNote: { runId: dev.id } },
    });
    expect(await startOrJoinRun(tx, m, theo.id, "dm")).toBeNull();
    return m;
  });
  await drain(f);
  const [card, ...more] = await cardsOf(f);
  expect(more).toEqual([]);
  if (!card) throw new Error("no card");
  // Where Ana reads, written as Dev's run there: nobody reads the agents' DM.
  expect(card).toMatchObject({
    channelId: f.general.id,
    threadId: null,
    authorAgentId: f.agent.id,
    agentRunId: dev.id,
  });
  expect(card.meta.actionCard).toMatchObject({
    forUserId: f.owner.id,
    agentIds: [theo.id],
    held: [{ agentId: theo.id, messageId: note.id, trigger: "dm" }],
  });
  const go = await answerNow({ db: f.db, pubsub: f.pubsub, gateway: f.gateway }, f.owner.id, f.org.id, card.id);
  expect(go.runs.map((r) => r.agentId)).toEqual([theo.id]);
  const [held] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, go.runs[0]?.runId ?? ""));
  expect(held).toMatchObject({ channelId: dm.id, hop: 1, triggerMessageId: note.id });
});

test("one card per stretch: Ada's refused tool in her long work's thread joins the card under Theo's hand-off", async () => {
  f = await setup({ reply: lines({ theo: [], ada: [] }) });
  const { theo, ada } = await team(f);
  const asked = await ask(f, "@theo organiza o lançamento");
  await fillStretch(f, theo.id, asked.id, asked.id);
  const say = (agentId: string, body: string, threadId?: string) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      ...(threadId ? { threadId } : {}),
      author: { type: "agent", agentId, runId: null, hop: 1, stretchId: asked.id },
      body,
    });
  // Ada's work moved to the background: it answers in her anchor's own thread, in Ana's stretch.
  const anchor = await say(ada.id, "Vou cuidar dos dados em segundo plano.");
  const [work] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: ada.id,
      channelId: f.general.id,
      threadRootId: anchor.id,
      triggerMessageId: asked.id,
      trigger: "mention",
      hop: 2,
      stretchId: asked.id,
      status: "done",
    })
    .returning();
  if (!work) throw new Error("no run");
  // Theo hands Ada more on the timeline: held past the limit, its card there, written as Theo.
  const handOff = await say(theo.id, "@ada pode fechar a planilha?");
  expect(await f.db.transaction((tx) => startOrJoinRun(tx, handOff, ada.id, "mention"))).toBeNull();
  await drain(f);
  // Ada's run in her thread asks Theo back: refused, and its wake-up joins that card instead of a second one there.
  expect(await refusedAtLimit(f.db, work, theo.id)).toMatchObject({ isError: true });
  await drain(f);
  const [card, ...more] = await cardsOf(f);
  expect(more).toEqual([]);
  if (!card) throw new Error("no card");
  expect(card).toMatchObject({ channelId: f.general.id, threadId: null, authorAgentId: theo.id });
  expect(card.meta.actionCard).toMatchObject({
    agentIds: [ada.id],
    held: [
      { agentId: ada.id, messageId: handOff.id },
      { agentId: ada.id, messageId: null, threadId: anchor.id },
    ],
  });
  expect(card.body).toBe("Ada paused to check with you before going on.");
  expect(card.meta.bodyParams).toEqual({ agents: "Ada", count: 1 });
  // Continuar: the hand-off on the timeline, and her refused work back in her thread, not under the card.
  await withMicroseconds(f, card.id);
  const go = await answerNow({ db: f.db, pubsub: f.pubsub, gateway: f.gateway }, f.owner.id, f.org.id, card.id);
  const started = await f.db
    .select()
    .from(schema.agentRuns)
    .where(
      inArray(
        schema.agentRuns.id,
        go.runs.map((r) => r.runId),
      ),
    );
  expect(started.map((r) => r.threadRootId).sort()).toEqual([handOff.id, anchor.id].sort());
});

test("Continuar starts every wake-up the card holds, also one held there after the card was read", async () => {
  f = await setup({ reply: lines({ theo: [], ada: [] }) });
  const { theo, ada } = await team(f);
  const max = await agentIn(f, "Max", "max");
  const root = await ask(f, "Deploy de hoje");
  await fillStretch(f, theo.id, root.id, root.id);
  const handOff = (to: string, body: string) =>
    f.db.transaction(async (tx) => {
      const m = await insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: theo.id, runId: null, hop: 6, stretchId: root.id },
        body,
      });
      expect(await startOrJoinRun(tx, m, to, "mention")).toBeNull();
      return m;
    });
  const toAda = await handOff(ada.id, "@ada sua vez");
  await drain(f);
  const [card] = await cardsOf(f);
  if (!card) throw new Error("no card");
  await withMicroseconds(f, card.id);
  // Continuar reads the card, and Max's wake-up is held on it before Continuar writes.
  const read = stretchCardOf(card.meta);
  if (!read) throw new Error("no card");
  const toMax = await handOff(max.id, "@max confere o deploy");
  await drain(f);
  const { membership } = await requireChannelAccess(f.db, f.owner.id, f.org.id, f.general.id);
  const go = await continueStretch({ db: f.db, pubsub: f.pubsub }, f.owner.id, membership, card, read);
  expect(go.runs.map((r) => r.agentId)).toEqual([ada.id, max.id]);
  expect(stretchCardOf((await getMessage(f.db, f.org.id, card.id))?.meta)).toMatchObject({
    state: "continued",
    held: [
      { agentId: ada.id, messageId: toAda.id },
      { agentId: max.id, messageId: toMax.id },
    ],
  });
});

test("Continuar while the agent still works there: that run writes from hop 1 in the new stretch, and handed on unread nothing holds it", async () => {
  f = await setup({ reply: lines({ theo: [], ada: [] }) });
  const root = await ask(f, "Deploy de staging");
  const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev investiga",
    threadId: root.id,
  });
  const [working] = await f.db
    .update(schema.agentRuns)
    .set({ hop: 30, status: "running" })
    .where(eq(schema.agentRuns.triggerMessageId, asked.id))
    .returning();
  if (!working) throw new Error("no run");
  await fillStretch(f, f.agent.id, asked.id, root.id);
  // Its ask_agent was refused at the limit while it goes on writing.
  const card = await postStretchCard({ db: f.db, pubsub: f.pubsub }, f.org.id, {
    stretchId: asked.id,
    channelId: f.general.id,
    threadId: root.id,
    authorAgentId: f.agent.id,
    runId: working.id,
    hop: working.hop,
    agentId: f.agent.id,
    messageId: null,
    trigger: "mention",
    stop: { reason: "runs", limit: STRETCH.runs },
  });
  if (!card) throw new Error("no card");
  await withMicroseconds(f, card.id);
  const go = await answerNow({ db: f.db, pubsub: f.pubsub, gateway: f.gateway }, f.owner.id, f.org.id, card.id);
  expect(go.runs).toEqual([{ agentId: f.agent.id, runId: working.id }]);
  const [joined] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, working.id));
  expect(joined).toMatchObject({ hop: 1, pendingMessageIds: [card.id] });
  const stretchId = joined?.stretchId;
  expect(stretchId).not.toBe(asked.id);
  // The run still knows its old hop as it posts its reply.
  const reply = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: root.id,
    author: { type: "agent", agentId: f.agent.id, runId: working.id, hop: working.hop },
    body: "Diagnóstico feito.",
  });
  expect(reply).toMatchObject({ hop: 1, stretchId });
  // It ends before reading the card: the card gets a run of its own, in the new stretch, and no second card.
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, working.id));
  const handed = await releaseInbox(f.db, f.pubsub, working, { reason: "done" });
  expect(handed?.messageIds).toEqual([card.id]);
  const [next] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, handed?.runId ?? ""));
  expect(next).toMatchObject({ triggerMessageId: card.id, stretchId, status: "queued" });
  expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, STRETCH_JOB))).toEqual([]);
});
