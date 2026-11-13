import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  cancelRun,
  createAgent,
  createAgentRuns,
  deliverNoticeToRun,
  drainOutbox,
  holdsMessages,
  insertMessage,
  postPersonMessage,
  queueOnRun,
  recoverStaleRuns,
  releaseHeldInbox,
  releaseInbox,
  stopChecksSettled,
  sweepEndedInboxes,
  type ToolSource,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const post = (body: string, options: { threadId?: string; userId?: string; judge?: boolean } = {}) =>
  postPersonMessage(
    { db: f.db, pubsub: f.pubsub, ...(options.judge ? { judge: f.context.judge } : {}) },
    options.userId ?? f.owner.id,
    f.org.id,
    f.general.id,
    { body, threadId: options.threadId },
  );
const runs = async () =>
  (await f.db.select().from(schema.agentRuns)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
const runById = async (id: string) =>
  (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
const messageById = async (id: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0];

/** A tool that, while it runs, lets the test do something (people write). */
function slowTool(during: () => Promise<unknown>): ToolSource {
  return {
    name: "slow",
    tools: async () => [
      {
        name: "build",
        description: "Build the project",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          await during();
          return { content: "build ok" };
        },
      },
    ],
  };
}

describe("a run's inbox", () => {
  test("status-guarded append: a run that ended is never appended to", async () => {
    f = await setup();
    const ask = await post("@dev prepara o relatório");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    const later = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: ask.id,
      author: { type: "person", userId: f.owner.id },
      body: "inclui setembro",
    });
    expect(await queueOnRun(f.db, run.id, later.id)).toBe(true);
    // Idempotent: queued once.
    expect(await queueOnRun(f.db, run.id, later.id)).toBe(true);
    expect((await runById(run.id))?.pendingMessageIds).toEqual([later.id]);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", pendingMessageIds: [] })
      .where(eq(schema.agentRuns.id, run.id));
    expect(await queueOnRun(f.db, run.id, later.id)).toBe(false);
    expect((await runById(run.id))?.pendingMessageIds).toEqual([]);
  });

  test("a message to an agent whose run ended starts a run of its own (nothing left on the dead run)", async () => {
    f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
    const ask = await post("@dev prepara o relatório");
    const [first] = await runs();
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, first?.id ?? ""));
    // Through the dispatch path too (an agent's notice, a router pick): no join to the ended run.
    const note = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: ask.id,
      author: { type: "person", userId: f.owner.id },
      body: "e outubro",
    });
    const [viaDispatch] = await f.db.transaction((tx) => createAgentRuns(tx, note, [f.agent.id], "mention"));
    expect(viaDispatch?.triggerMessageId).toBe(note.id);
    const reply = await post("@dev e setembro?", { threadId: ask.id });
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all[0]?.pendingMessageIds).toEqual([]);
    // The follow-up joined the live run started by the dispatch, never the ended one.
    expect(all[1]?.pendingMessageIds).toEqual([reply.id]);
    expect((await messageById(reply.id))?.meta).toMatchObject({ steeredRunIds: [viaDispatch?.id] });
  });
});

describe("ending a run hands its unread messages on", () => {
  test("canceled while queued: the unread message gets a run of its own at once", async () => {
    f = await setup();
    const events = f.listen(f.general.id);
    const ask = await post("@dev prepara o relatório");
    const more = await post("inclui setembro", { threadId: ask.id });
    const [first] = await runs();
    expect(first?.pendingMessageIds).toEqual([more.id]);
    await cancelRun(deps(), f.owner.id, f.org.id, first?.id ?? "");
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["canceled", "queued"]);
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.triggerMessageId).toBe(more.id);
    expect(events.find((e) => e.type === "agent.run.redispatched")).toMatchObject({
      runId: first?.id,
      newRunId: all[1]?.id,
      messageIds: [more.id],
    });
  });

  test("a stop (the judge) while it works: the other unread message is answered, the stop is not", async () => {
    let threadId = "";
    let correction = "";
    const requests: string[] = [];
    f = await setup({
      judge: (kind, _id, state) => (kind === "stop_request" && state.message === "para" ? 0.95 : 0),
      toolSources: [
        slowTool(async () => {
          correction = (await post("usa a branch dev", { threadId })).id;
          await post("para", { threadId, judge: true });
          await stopChecksSettled();
        }),
      ],
      reply: (req: ModelRequest, call: number) => {
        requests.push(JSON.stringify(req.messages));
        return call === 1
          ? { chunks: [], toolUses: [{ name: "build", input: {} }] }
          : { chunks: ["Certo, na branch dev."] };
      },
    });
    const ask = await post("@dev compila");
    threadId = ask.id;
    await drainOutbox(f.db, f.handlers);
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["canceled", "done"]);
    expect(all[1]?.triggerMessageId).toBe(correction);
    expect(all.every((r) => r.pendingMessageIds.length === 0)).toBe(true);
    expect(requests[1]).toContain("usa a branch dev");
  });

  test("interrupted by a restart: the unread message gets a run of its own", async () => {
    f = await setup();
    const ask = await post("@dev prepara o relatório");
    const more = await post("inclui setembro", { threadId: ask.id });
    const [first] = await runs();
    if (!first) throw new Error("no run");
    // Its worker died mid-run (no transcript to resume from) and still holds the job.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: new Date(Date.now() - 10 * 60_000), heartbeatAt: null })
      .where(eq(schema.agentRuns.id, first.id));
    await f.db
      .update(schema.outbox)
      .set({ status: "processing", lockedUntil: new Date(Date.now() + 600_000), lockedBy: "dead-worker" })
      .where(eq(schema.outbox.kind, "agent_run.execute"));
    expect((await recoverStaleRuns(deps())).failed).toEqual([first.id]);
    const all = await runs();
    expect(all.map((r) => r.status)).toEqual(["failed", "queued"]);
    expect(all[1]?.triggerMessageId).toBe(more.id);
  });

  test("the sweeper hands on what an ended run still holds, once", async () => {
    f = await setup();
    const ask = await post("@dev prepara o relatório");
    const more = await post("inclui setembro", { threadId: ask.id });
    const [first] = await runs();
    // Ended by a path that didn't hand its inbox on (or crashed right after the end).
    await f.db
      .update(schema.agentRuns)
      .set({ status: "failed", finishedAt: new Date(Date.now() - 5_000) })
      .where(eq(schema.agentRuns.id, first?.id ?? ""));
    // Still within the grace: left to the path that ended it.
    expect(await sweepEndedInboxes(deps())).toBe(0);
    expect(await sweepEndedInboxes(deps(), { now: new Date(Date.now() + 60_000) })).toBe(1);
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all[1]?.triggerMessageId).toBe(more.id);
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(await sweepEndedInboxes(deps(), { now: new Date(Date.now() + 60_000) })).toBe(0);
  });

  test("an archived agent's ended run: the sweeper only empties its inbox", async () => {
    f = await setup();
    const ask = await post("@dev prepara o relatório");
    await post("inclui setembro", { threadId: ask.id });
    const [first] = await runs();
    await f.db
      .update(schema.agentRuns)
      .set({ status: "failed", finishedAt: new Date(Date.now() - 5_000) })
      .where(eq(schema.agentRuns.id, first?.id ?? ""));
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    expect(await sweepEndedInboxes(deps(), { now: new Date(Date.now() + 60_000) })).toBe(1);
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(all[0]?.pendingMessageIds).toEqual([]);
  });

  test("the sweeper only empties the inbox of a run that ended long ago", async () => {
    f = await setup();
    const ask = await post("@dev prepare the report");
    const more = await post("include September", { threadId: ask.id });
    const [first] = await runs();
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", finishedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000), pendingMessageIds: [more.id] })
      .where(eq(schema.agentRuns.id, first?.id ?? ""));
    expect(await sweepEndedInboxes(deps())).toBe(1);
    const all = await runs();
    expect(all).toHaveLength(1);
    expect(all[0]?.pendingMessageIds).toEqual([]);
  });

  test("the agent's own fast reply is context only: the person's message is the trigger, alone it starts nothing", async () => {
    f = await setup();
    const ask = await post("@dev prepara o relatório");
    const more = await post("inclui setembro", { threadId: ask.id });
    const fastReply = (body: string) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: ask.id,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
        body,
        meta: { talker: true, notice: { kind: "talker_reply", text: body } },
      });
    const said = await fastReply("Anotado, incluo setembro.");
    const [first] = await runs();
    if (!first) throw new Error("no run");
    // The talker's reply goes first in the inbox (prepended), the person's after it.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "failed", pendingMessageIds: [said.id, more.id] })
      .where(eq(schema.agentRuns.id, first.id));
    await releaseInbox(f.db, f.pubsub, first, { reason: "failed" });
    let all = await runs();
    expect(all).toHaveLength(2);
    expect(all[1]?.triggerMessageId).toBe(more.id);
    // Only a fast reply left unread: nothing to answer.
    const alone = await fastReply("Já volto.");
    await f.db
      .update(schema.agentRuns)
      .set({ status: "failed", pendingMessageIds: [alone.id] })
      .where(eq(schema.agentRuns.id, all[1]?.id ?? ""));
    expect(await releaseInbox(f.db, f.pubsub, all[1] as typeof first, { reason: "failed" })).toBeNull();
    all = await runs();
    expect(all).toHaveLength(2);
    expect(all[1]?.pendingMessageIds).toEqual([]);
  });
});

describe("background runs", () => {
  test("a person's message never goes to a background run, and its trigger never joins a conversation's run", async () => {
    f = await setup();
    const root = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "relatório semanal",
    });
    const [background] = await f.db.transaction((tx) =>
      createAgentRuns(tx, root, [f.agent.id], "mention", { background: true }),
    );
    expect(background?.background).toBe(true);
    // A person calls the agent in that same thread: a run of its own, not the background one.
    const ask = await post("@dev e o relatório?", { threadId: root.id });
    let all = await runs();
    expect(all).toHaveLength(2);
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.background).toBe(false);
    expect((await messageById(ask.id))?.meta.steeredRunIds).toBeUndefined();
    // Background work on a message in the conversation of a live run starts apart from it.
    const note = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: root.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "rotina: confere o deploy",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, note, [f.agent.id], "mention", { background: true }));
    all = await runs();
    expect(all).toHaveLength(3);
    expect(all[1]?.pendingMessageIds).toEqual([]);
    expect(all[2]).toMatchObject({ background: true, triggerMessageId: note.id });
  });
});

describe("the floor (a follow-up without @ in the channel)", () => {
  test("goes to the agent still answering this same person there, asked within the last 30 minutes", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    await post("@dev prepara o relatório");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    const follow = await post("inclui setembro");
    expect((await messageById(follow.id))?.meta).toMatchObject({ steeredRunIds: [run.id] });
    // Someone else's message: the router decides, not the floor.
    const other = await post("e outubro?", { userId: bia.id });
    expect((await messageById(other.id))?.meta.steeredRunIds).toBeUndefined();
    // Asked too long ago: no longer the floor.
    await f.db
      .update(schema.agentRuns)
      .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(schema.agentRuns.id, run.id));
    const late = await post("e novembro");
    expect((await messageById(late.id))?.meta.steeredRunIds).toBeUndefined();
    expect((await runById(run.id))?.pendingMessageIds).toEqual([follow.id]);
    expect(await runs()).toHaveLength(1);
  });
});

describe("the floor with two agents answering the same person", () => {
  const twoAnswering = async () => {
    f = await setup();
    const theo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: theo.id });
    await post("@dev @theo como está o limite de uso de vocês?");
    expect(await runs()).toHaveLength(2);
  };
  for (const [lang, body] of [
    ["pt-BR", "quanto de cpu e ram nossa máquina tá usando agora?"],
    ["en", "how much cpu and ram is our machine using right now?"],
  ] as const) {
    test(`a follow-up without @ goes to neither run: the router picks who it is for (${lang})`, async () => {
      await twoAnswering();
      const follow = await post(body);
      expect((await messageById(follow.id))?.meta.steeredRunIds).toBeUndefined();
      expect((await runs()).every((r) => r.pendingMessageIds.length === 0)).toBe(true);
    });
  }
});

describe("a run held by a decision takes nothing new: the agent stays responsive", () => {
  const holdOnApproval = (id: string) =>
    f.db.update(schema.agentRuns).set({ status: "waiting_approval" }).where(eq(schema.agentRuns.id, id));
  /** Paused on a mission's own wait (a blocking decision): a message can't move it. */
  const holdOnDecision = (id: string) =>
    f.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        transcript: {
          system: [],
          messages: [],
          postedUpTo: 0,
          postedCount: 0,
          deltaSeq: 0,
          pending: { calls: [{ toolUseId: "t1", name: "ask_decision", waitId: "decision-1" }] },
        },
      })
      .where(eq(schema.agentRuns.id, id));

  test("waiting on an approval: a person's message, another agent's or a notice starts a run of its own", async () => {
    f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
    const ask = await post("@dev faz o deploy");
    const [held] = await runs();
    if (!held) throw new Error("no run");
    await holdOnApproval(held.id);
    expect(await holdsMessages(f.db, { ...held, status: "waiting_approval" })).toBe(true);

    const more = await post("@dev e o changelog?", { threadId: ask.id });
    let all = await runs();
    expect(all).toHaveLength(2);
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.triggerMessageId).toBe(more.id);

    // Through the dispatch path (an agent's message, a router pick): it joins the new run, never the held one.
    const note = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: ask.id,
      author: { type: "person", userId: f.owner.id },
      body: "e setembro",
    });
    await f.db.transaction((tx) => createAgentRuns(tx, note, [f.agent.id], "mention"));
    all = await runs();
    expect(all).toHaveLength(2);
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.pendingMessageIds).toEqual([note.id]);

    // A notice for the held run (another agent's answer) wakes the agent instead of waiting on it.
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", finishedAt: new Date(), pendingMessageIds: [] })
      .where(eq(schema.agentRuns.id, all[1]?.id ?? ""));
    const delivered = await f.db.transaction((tx) =>
      deliverNoticeToRun(tx, held, { kind: "wait_result", text: "Staging is on Railway.", from: "@infra" }),
    );
    expect(delivered.runs).toHaveLength(1);
    expect((await runById(held.id))?.pendingMessageIds).toEqual([]);
    expect((await runById(held.id))?.status).toBe("waiting_approval");
  });

  test("waiting on a mission's decision: a person's message leaves it for a run of its own", async () => {
    f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
    const events = f.listen(f.general.id);
    const ask = await post("@dev prepara o deploy");
    const [held] = await runs();
    if (!held) throw new Error("no run");
    await holdOnDecision(held.id);
    expect(await holdsMessages(f.db, { id: held.id, orgId: held.orgId, status: "waiting_input" })).toBe(true);

    const more = await post("e o changelog?", { threadId: ask.id });
    await stopChecksSettled();
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all[0]?.status).toBe("waiting_input");
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.triggerMessageId).toBe(more.id);
    expect(events.find((e) => e.type === "agent.run.redispatched")).toMatchObject({
      runId: held.id,
      newRunId: all[1]?.id,
      messageIds: [more.id],
    });
  });

  test("waiting on a person's answer: a message still goes to that run", async () => {
    f = await setup();
    await post("@dev prepara o deploy");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    const transcript = {
      system: [],
      messages: [],
      postedUpTo: 0,
      postedCount: 0,
      deltaSeq: 0,
      pending: { calls: [{ toolUseId: "t1", name: "ask_user", questionId: "q-1" }] },
    };
    expect(await holdsMessages(f.db, { ...run, status: "waiting_input", transcript })).toBe(false);
    expect(await holdsMessages(f.db, { ...run, status: "running" })).toBe(false);
  });

  test("a run that pauses on an approval hands on what it hadn't read yet", async () => {
    f = await setup({ reply: () => ({ chunks: ["Ok."] }) });
    const ask = await post("@dev faz o deploy");
    const [run] = await runs();
    if (!run) throw new Error("no run");
    // Sent while it worked: queued on it.
    const more = await post("@dev e o changelog?", { threadId: ask.id });
    expect((await runById(run.id))?.pendingMessageIds).toEqual([more.id]);
    // Still working: nothing to hand on.
    expect(await releaseHeldInbox(f.db, f.pubsub, run.id)).toBeNull();

    await holdOnApproval(run.id);
    expect(await releaseHeldInbox(f.db, f.pubsub, run.id)).toMatchObject({ messageIds: [more.id] });
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all[0]?.pendingMessageIds).toEqual([]);
    expect(all[1]?.triggerMessageId).toBe(more.id);
  });
});

describe("a reply in a thread joins only the run of the agent it is for", () => {
  /**
   * Dev answers the person in a thread and names Theo there, so Theo works in that thread on a run Dev's message
   * started. The person then writes in the thread.
   */
  const devNamedTheo = async () => {
    f = await setup();
    const theo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: theo.id });
    const root = await post("@dev olha essa tela");
    const [devRun] = await runs();
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(schema.agentRuns.id, devRun?.id ?? ""));
    const devReply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: root.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Era essa tela. O @theo pode seguir daqui.",
    });
    const [theoRun] = await f.db.transaction((tx) => createAgentRuns(tx, devReply, [theo.id], "mention"));
    if (!theoRun) throw new Error("no run");
    const reply = (body: string, replyTo?: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
        body,
        threadId: root.id,
        ...(replyTo ? { replyTo } : {}),
      });
    return { theo, root, devReply, theoRun, reply };
  };

  test("a quote of the agent that spoke goes to that agent, not into the run it named", async () => {
    const { devReply, theoRun, reply } = await devNamedTheo();
    const asked = await reply("e por que não achou antes?", devReply.id);
    expect((await messageById(asked.id))?.meta.steeredRunIds).toBeUndefined();
    expect((await runById(theoRun.id))?.pendingMessageIds).toEqual([]);
  });

  test("unaddressed, it is for the agent that spoke last, not the one it named", async () => {
    const { theoRun, reply } = await devNamedTheo();
    const asked = await reply("e por que não achou antes?");
    expect((await messageById(asked.id))?.meta.steeredRunIds).toBeUndefined();
    expect((await runById(theoRun.id))?.pendingMessageIds).toEqual([]);
  });

  test("a mention of the other agent never feeds the run in progress", async () => {
    const { theoRun, reply } = await devNamedTheo();
    const asked = await reply("@dev e por que não achou antes?");
    expect((await runById(theoRun.id))?.pendingMessageIds).toEqual([]);
    const devRuns = (await runs()).filter((r) => r.agentId === f.agent.id && r.triggerMessageId === asked.id);
    expect(devRuns).toHaveLength(1);
  });

  test("once the named agent speaks, or when quoted, the person's reply joins its run", async () => {
    const { theo, root, theoRun, reply } = await devNamedTheo();
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: root.id,
      author: { type: "agent", agentId: theo.id, runId: theoRun.id, hop: 2 },
      body: "Vou gerar o build agora.",
    });
    const follow = await reply("usa a branch dev");
    const quote = await reply("e assina com a chave nova", said.id);
    expect((await runById(theoRun.id))?.pendingMessageIds).toEqual([follow.id, quote.id]);
  });
});
