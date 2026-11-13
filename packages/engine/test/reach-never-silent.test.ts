import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  createAgent,
  createAskAgentToolSource,
  createChannel,
  createJobHandlers,
  drainOutbox,
  insertMessage,
  type OutboxJob,
  openDm,
  postPersonMessage,
  type RouterStrategy,
  runRoutineNow,
} from "../src";
import { SELF_REPORT_NOTICES } from "../src/notices";
import { notifyAgentUnreached } from "../src/notification-producers";
import { reachNote, reachOf } from "../src/reach";
import { deliverNoticeToRun } from "../src/run-resume";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, messagesIn, notificationsOf, routineDeps } from "./routine-fixtures";

/**
 * A member an agent's message names is reached, or someone is told why not: one the person behind it can't talk to
 * says so under the message, and a routine whose creator can't reach the agent tells the agent's owner. Every skip is
 * in `routing_decisions`. An agent's @ of an agent outside the conversation reaches nobody: `tell_agent` does that.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const NO_ROUTE = { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] };

async function agentOf(name: string, handle: string, options: { inGeneral: boolean }) {
  const a = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role: "Pesquisa", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  if (options.inGeneral)
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
  return a;
}

const runsOf = () => f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));

/** Dev, woken by Ana, writes `body` in #general (or `channelId`) from its run (its mentions are resolved as the server's). */
async function devWrites(body: string, unreached: string[], channelId = f.general.id) {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, {
    body: "@dev prepara o resumo",
  });
  const [run] = await runsOf();
  if (!run) throw new Error("no run");
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  return insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
    body,
    meta: { unreachedAgents: unreached },
  });
}

const decisionOf = async (messageId: string) =>
  (await f.db.select().from(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, messageId)))[0];
const messageOf = async (id: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0];

describe("an agent's mention of an agent outside the conversation", () => {
  const needed = () =>
    setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
  const untouched = async (ivoId: string, sentId: string) => {
    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
    expect((await runsOf()).filter((r) => r.agentId === ivoId)).toEqual([]);
    expect(reachOf((await messageOf(sentId))?.meta)).toEqual([]);
  };

  test("a passing name delivers nothing, wakes nobody and shows no line under the message", async () => {
    f = await needed();
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const sent = await devWrites("O arquivo do app (AAB) vem do @ivo.", ["ivo"]);
    await drainOutbox(f.db, f.handlers);
    await untouched(ivo.id, sent.id);
  });

  test("neither does a clear hand-off: that is what tell_agent is for", async () => {
    f = await needed();
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const sent = await devWrites("@ivo revisa o relatório de hoje.", ["ivo"]);
    await drainOutbox(f.db, f.handlers);
    await untouched(ivo.id, sent.id);
  });

  test("from a private channel and a DM neither", async () => {
    f = await needed();
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const rh = await createChannel(f.db, f.owner.id, f.org.id, { name: "rh", visibility: "private" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: rh.id, agentId: f.agent.id });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    for (const place of [rh.id, dm.id]) {
      const sent = await devWrites("@ivo revisa o relatório de hoje.", ["ivo"], place);
      await drainOutbox(f.db, f.handlers);
      await untouched(ivo.id, sent.id);
    }
  });

  test("one the person behind it can't talk to shows nothing either: the @ was never a call", async () => {
    f = await needed();
    const ivo = await agentOf("Ivo", "ivo", { inGeneral: false });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, ivo.id));
    const sent = await devWrites("@ivo revisa o relatório de hoje.", ["ivo"]);
    await drainOutbox(f.db, f.handlers);
    await untouched(ivo.id, sent.id);
  });
});

describe("a member the person behind an agent's message can't talk to", () => {
  test("isn't woken, and the message says why", async () => {
    f = await setup({
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, gil.id));
    const sent = await devWrites("@gil revisa o relatório de hoje.", []);
    await drainOutbox(f.db, f.handlers);

    expect((await runsOf()).filter((r) => r.agentId === gil.id)).toEqual([]);
    expect(reachOf((await messageOf(sent.id))?.meta)).toEqual([
      { agentId: gil.id, handle: "gil", reason: "audience", userId: f.owner.id },
    ]);
    expect((await decisionOf(sent.id))?.reason).toContain("audience: @gil");
  });
});

const wakeSkipped = async () =>
  (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "wake_skipped",
  );

describe("an agent whose every message names an agent it can't reach", () => {
  test("hears it once and stops: the notice never starts a run of its own", async () => {
    f = await setup({
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["Já deixei o recado com o @gil acima."] }),
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, gil.id));
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev prepara o resumo",
    });
    await drainOutbox(f.db, f.handlers);

    expect((await runsOf()).filter((r) => r.agentId === f.agent.id)).toHaveLength(1);
    expect((await runsOf()).filter((r) => r.agentId === gil.id)).toEqual([]);
    const told = await wakeSkipped();
    expect(told).toHaveLength(1);
    // The app's words under the message come from the cause.
    expect(told[0]?.meta.notice).toMatchObject({ refs: { agentHandles: "gil", reason: "audience" } });
  });

  test("no notice about the run's own work starts a run of its own once that run ended", async () => {
    f = await setup();
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev prepara o resumo",
    });
    const [run] = await runsOf();
    if (!run) throw new Error("no run");
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
    for (const kind of SELF_REPORT_NOTICES) {
      const delivered = await f.db.transaction((tx) => deliverNoticeToRun(tx, run, { kind, text: "x" }));
      expect({ kind, runs: delivered.runs }).toEqual({ kind, runs: [] });
    }
    expect(await runsOf()).toHaveLength(1);
  });

  test("named again in the same stretch, no second notice; a plan only its owner uses is the cause it reads", async () => {
    f = await setup({ judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined) });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", brain: "claude_code" })
      .where(eq(schema.agents.id, gil.id));
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev prepara o resumo",
    });
    const [run] = await runsOf();
    if (!run) throw new Error("no run");
    for (const body of ["@gil revisa o relatório.", "@gil, o relatório está acima."]) {
      const said = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: asked.id,
        author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 1 },
        body,
      });
      await f.handlers["message.posted"]?.(
        { orgId: f.org.id, payload: { messageId: said.id } } as unknown as OutboxJob,
        { finalAttempt: false },
      );
    }
    const told = await wakeSkipped();
    expect(told).toHaveLength(1);
    expect(JSON.stringify(told[0]?.meta.notice)).toContain("its owner's own AI plan");
    // The live run reads it at its next step: nothing else starts.
    expect(await runsOf()).toHaveLength(1);
    const [live] = await runsOf();
    expect(live?.pendingMessageIds).toContain(told[0]?.id ?? "");
  });
});

describe("a member that takes consultations for the person behind an agent's message", () => {
  test("isn't woken here: it is asked privately by note, and answers the agent in their DM", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner" })
      .where(eq(schema.agents.id, gil.id));
    const sent = await devWrites("@gil revisa o relatório de hoje.", []);
    await drainOutbox(f.db, f.handlers);

    const [note] = await f.db.select().from(schema.agentConsultations);
    expect(note).toMatchObject({ targetAgentId: gil.id, kind: "note" });
    const gilRuns = (await runsOf()).filter((r) => r.agentId === gil.id);
    expect(gilRuns.map((r) => r.channelId)).toEqual([note?.channelId ?? ""]);
    const said = await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, gil.id));
    expect(said.every((m) => m.channelId === note?.channelId)).toBe(true);
    const reach = reachOf((await messageOf(sent.id))?.meta);
    expect(reach).toEqual([{ agentId: gil.id, handle: "gil", reason: "audience", consultationId: note?.id ?? "" }]);
    expect(reachNote(reach)).toContain("only answers the people here through other agents");
    // It was reached: the author isn't told its mention woke nobody.
    const skipped = (await f.db.select().from(schema.messages)).filter(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "wake_skipped",
    );
    expect(skipped).toEqual([]);
  });

  test("with no AI connected, the line under the message says that, not that the person can't talk to it", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", model: "gpt-6-luna", credentialId: null })
      .where(eq(schema.agents.id, gil.id));
    const sent = await devWrites("@gil revisa o relatório de hoje.", []);
    await drainOutbox(f.db, f.handlers);

    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
    expect(reachOf((await messageOf(sent.id))?.meta)).toEqual([
      { agentId: gil.id, handle: "gil", reason: "audience", noAi: true },
    ]);
    // The author reads the real cause too.
    const [told] = await wakeSkipped();
    expect(told?.body).toContain("no AI connected");
    expect(told?.body).not.toContain("certain people");
    expect(told?.meta.notice).toMatchObject({ refs: { agentHandles: "gil", reason: "no_ai" } });
  });

  test("the same mention again within the hour is the same delivery: no wake_skipped for it", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner" })
      .where(eq(schema.agents.id, gil.id));
    await devWrites("@gil revisa o relatório de hoje.", []);
    await drainOutbox(f.db, f.handlers);
    // Another of Dev's runs, for another ask, says the same.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev e o resumo de amanhã?",
    });
    const second = (await runsOf()).filter((r) => r.agentId === f.agent.id).at(-1);
    if (!second || second.id === (await runsOf())[0]?.id) throw new Error("no second run");
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, second.id));
    const again = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: second.id, hop: 1 },
      body: "@gil revisa o relatório de hoje.",
    });
    await drainOutbox(f.db, f.handlers);

    const notes = await f.db.select().from(schema.agentConsultations);
    expect(notes).toHaveLength(1);
    expect(reachOf((await messageOf(again.id))?.meta)).toEqual([
      { agentId: gil.id, handle: "gil", reason: "audience", consultationId: notes[0]?.id ?? "" },
    ]);
    expect(await wakeSkipped()).toEqual([]);
  });
});

describe("a routine whose creator can't reach the agent it names", () => {
  test("its report says so, the agent's owner is told, and the decision is recorded", async () => {
    f = await setup({
      handOff: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => {
        if (req.outputSchema) return NO_ROUTE;
        if (isRoutine(req)) return { chunks: ["Relatório: o Gil precisa revisar o PR #42."] };
        return { chunks: ["@gil revisa o PR #42 hoje, por favor."] };
      },
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, gil.id));
    const routine = await channelRoutine(f, {
      access: "act",
      report: "always",
      prompt: "Cobre o @gil sobre o PR #42.",
    });
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);

    expect((await runsOf()).filter((r) => r.agentId === gil.id)).toEqual([]);
    const said = (await messagesIn(f, f.general.id)).find((m) => m.body.startsWith("@gil"));
    if (!said) throw new Error("the report wasn't told");
    expect(reachOf(said.meta)).toEqual([
      {
        agentId: gil.id,
        handle: "gil",
        reason: "routine_creator_reach",
        userId: f.owner.id,
        routine: { id: routine.id, name: routine.name, creatorUserId: f.owner.id, access: "act" },
      },
    ]);
    expect((await decisionOf(said.id))?.reason).toContain("routine_creator_reach: @gil");
    const [told] = await notificationsOf(f, "agent_unreached");
    expect(told).toMatchObject({ userId: bob.id });
    expect(told?.source).toMatchObject({ agentId: gil.id, routineId: routine.id, messageId: said.id });
  });
});

describe("never silent, the edges", () => {
  test("an outside mention leaves the chime-in router its say: a member it picks still starts", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    await agentOf("Ivo", "ivo", { inGeneral: false });
    const ops = await agentOf("Ops", "ops", { inGeneral: true });
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        return {
          agents: input.candidates.map((c) => ({ agentId: c.agentId, score: c.handle === "ops" ? 0.9 : 0 })),
          reason: "test",
        };
      },
    };
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", strategy },
    });
    const sent = await devWrites("Deploy feito, @ivo pode conferir os logs?", ["ivo"]);
    await drainOutbox(f.db, handlers);

    expect((await runsOf()).some((r) => r.agentId === ops.id && r.triggerMessageId === sent.id)).toBe(true);
    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
  });

  test("a tell_agent after a member's mention was handed sends no second note", async () => {
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => (req.outputSchema ? NO_ROUTE : { chunks: ["ok"] }),
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: true });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner" })
      .where(eq(schema.agents.id, gil.id));
    const sent = await devWrites("@gil revisa o relatório de hoje.", []);
    // Gil never works on it: the note stays open.
    const handlers = { ...f.handlers, "agent_run.execute": async () => {} };
    await drainOutbox(f.db, handlers);
    expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(1);

    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: sent.agentRunId as string,
      channelId: f.general.id,
      threadRootId: sent.id,
      triggerMessageId: sent.id,
    };
    const tell = (await createAskAgentToolSource().tools(ctx)).find((t) => t.name === "tell_agent");
    const out = await tell?.execute({ agent: "@gil", message: "Confere os logs também." }, ctx);
    expect(out?.content).toContain("already has it");
    expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(1);
    expect((await f.db.select().from(schema.agentConsultations))[0]?.targetAgentId).toBe(gil.id);
  });
});

describe("a routine's own tell_agent to an agent its creator can't reach", () => {
  test("the report shows the line, the agent's owner is told, and the decision is recorded", async () => {
    const hasResult = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content).includes("tool_result");
    f = await setup({
      askAgent: true,
      handOff: true,
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : undefined),
      reply: (req) => {
        if (req.outputSchema) return NO_ROUTE;
        if (isRoutine(req) && !hasResult(req))
          return {
            chunks: [],
            toolUses: [{ name: "tell_agent", input: { agent: "@gil", message: "Revise o PR #42." } }],
          };
        return { chunks: ["Relatório: não consegui chamar o Gil sobre o PR #42."] };
      },
    });
    const gil = await agentOf("Gil", "gil", { inGeneral: false });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: bob.id, audienceMode: "owner", consultable: false })
      .where(eq(schema.agents.id, gil.id));
    const routine = await channelRoutine(f, { access: "act", report: "always", prompt: "Cobre o Gil sobre o PR #42." });
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);

    expect(await f.db.select().from(schema.agentConsultations)).toEqual([]);
    const all = await f.db.select().from(schema.messages);
    const said = all.find((m) => reachOf(m.meta).length > 0);
    if (!said) throw new Error("no line under the routine's message");
    expect(reachOf(said.meta)).toEqual([
      {
        agentId: gil.id,
        handle: "gil",
        reason: "routine_creator_reach",
        userId: f.owner.id,
        routine: { id: routine.id, name: routine.name, creatorUserId: f.owner.id, access: "act" },
      },
    ]);
    expect(all.filter((m) => reachOf(m.meta).length > 0)).toHaveLength(1);
    expect((await decisionOf(said.id))?.reason).toContain("routine_creator_reach: @gil");
    const told = await notificationsOf(f, "agent_unreached");
    expect(told.map((n) => n.userId)).toEqual([bob.id]);
    expect(told[0]?.source).toMatchObject({ agentId: gil.id, routineId: routine.id, userId: f.owner.id });
  });

  test("an agent with no owner: who manages agents hears it", async () => {
    f = await setup();
    const gil = await agentOf("Gil", "gil", { inGeneral: false });
    await f.db.update(schema.agents).set({ ownerUserId: null }).where(eq(schema.agents.id, gil.id));
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await notifyAgentUnreached(
      { db: f.db, pubsub: f.pubsub },
      {
        orgId: f.org.id,
        agentId: gil.id,
        routineId: crypto.randomUUID(),
        routineName: "Cobrança",
        creatorUserId: bob.id,
        channelId: f.general.id,
      },
    );
    expect((await notificationsOf(f, "agent_unreached")).map((n) => n.userId)).toEqual([f.owner.id]);
  });
});
