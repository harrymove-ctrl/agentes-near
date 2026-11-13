import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, createMemoryPubSub, type RealtimeEvent } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  consolidateItem,
  createAgent,
  createJobHandlers,
  decideProposal,
  drainOutbox,
  ForbiddenError,
  insertMessage,
  joinChannel,
  listChannels,
  listDms,
  listMessages,
  markChannelRead,
  openDm,
  postPersonMessage,
  publishMessageCreated,
  requireChannelAccess,
  revertMemoryChange,
  undoAgentAction,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

describe("a message too big for its event", () => {
  test("goes out without its body, with the thread and the run it ends", async () => {
    const pubsub = createMemoryPubSub();
    const events: RealtimeEvent[] = [];
    pubsub.subscribe(channelTopic("c1"), (e) => events.push(e));
    await publishMessageCreated(pubsub, {
      id: "m1",
      channelId: "c1",
      threadId: "t1",
      author: { type: "agent", id: "a1" },
      body: "Resposta longa. ".repeat(600),
      mentionedAgentIds: [],
      mentionedUserIds: [],
      agentRunId: "r1",
      meta: {},
      clientId: null,
      createdAt: new Date().toISOString(),
    });
    expect(events).toEqual([
      { type: "message.created", channelId: "c1", messageId: "m1", threadId: "t1", agentRunId: "r1" },
    ]);
  });
});

describe("send path", () => {
  test("message.created goes out first with the clientId; mentioned agents show thinking at once", async () => {
    f = await setup();
    const events = f.listen(f.general.id);
    const view = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev hi",
      clientId: "tmp-123",
    });
    expect(view.clientId).toBe("tmp-123");
    expect(events.map((e) => e.type)).toEqual(["message.created", "message.routed", "agent.thinking"]);
    expect(events[0]).toMatchObject({ message: { clientId: "tmp-123" } });
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(events[2]).toMatchObject({ agentId: f.agent.id, runId: run?.id });
  });

  test("timings are reported (trigger → claim, claim → first delta, run)", async () => {
    const timings: string[] = [];
    f = await setup();
    const handlers = createJobHandlers({ ...f.jobDeps, onTiming: (name) => timings.push(name) });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev hi" });
    await drainOutbox(f.db, handlers);
    expect(timings).toEqual(["trigger_to_claim_ms", "claim_to_first_delta_ms", "run_ms"]);
  });
});

describe("receipts", () => {
  const post = (fx: Fixture, body: string) =>
    postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });
  const receiptOf = async (fx: Fixture, id: string) =>
    (await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id)).find((m) => m.id === id)?.receipts;

  test("mention: seen and picked by the agent, handled done; persisted for reloads", async () => {
    f = await setup();
    const m = await post(f, "@dev hi");
    await drainOutbox(f.db, f.handlers);
    expect(await receiptOf(f, m.id)).toEqual({
      seenBy: [f.agent.id],
      pickedBy: [f.agent.id],
      handled: [{ agentId: f.agent.id, runId: expect.any(String), status: "done" }],
      blocked: [],
    });
  });

  test("router pick and router none (scores never in the receipt); router off → empty", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? {
              chunks: [
                JSON.stringify(
                  !JSON.stringify(req.messages).includes("good morning")
                    ? { needs_agent: 0.9, scores: [{ handle: "dev", score: 0.9 }], reason: "deploy question" }
                    : { needs_agent: 0.1, scores: [{ handle: "dev", score: 0.1 }], reason: "chit-chat" },
                ),
              ],
            }
          : { chunks: ["ok"] },
    });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    const events = f.listen(f.general.id);
    const picked = await post(f, "is the deploy broken?");
    const none = await post(f, "good morning all");
    await drainOutbox(f.db, handlers);
    // Who picked, never what the model said.
    const decidedBy = { step: "model" as const, model: "claude-haiku-5-5", provider: "anthropic" };
    expect(await receiptOf(f, picked.id)).toEqual({
      seenBy: [f.agent.id],
      pickedBy: [f.agent.id],
      handled: [{ agentId: f.agent.id, runId: expect.any(String), status: "done" }],
      blocked: [],
      decidedBy,
    });
    expect(await receiptOf(f, none.id)).toEqual({
      seenBy: [f.agent.id],
      pickedBy: [],
      handled: [],
      blocked: [],
      decidedBy,
    });
    const routed = events.filter((e) => e.type === "message.routed");
    expect(routed).toContainEqual(
      expect.objectContaining({ messageId: none.id, seenBy: [f.agent.id], pickedBy: [], strategy: "router" }),
    );
    expect(JSON.stringify(routed)).not.toContain("score");
    expect(JSON.stringify(routed)).not.toContain("chit-chat");

    const off = await post(f, "router is off now");
    await drainOutbox(f.db, f.handlers); // fixture handlers: router disabled
    expect(await receiptOf(f, off.id)).toEqual({ seenBy: [], pickedBy: [], handled: [], blocked: [] });
  });

  test("a failed run shows in the receipt and as message.handled failed", async () => {
    // A refusal fails the run (an agent over budget waits for it instead).
    f = await setup({
      reply: () => ({ chunks: [], stopReason: "refusal", usage: { inputTokens: 10, outputTokens: 0 } }),
    });
    const events = f.listen(f.general.id);
    const m = await post(f, "@dev hi");
    await drainOutbox(f.db, f.handlers);
    expect((await receiptOf(f, m.id))?.handled).toEqual([
      expect.objectContaining({
        agentId: f.agent.id,
        runId: expect.any(String),
        status: "failed",
        errorCode: "run.model_refused",
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.handled",
        messageId: m.id,
        status: "failed",
        errorCode: "run.model_refused",
      }),
    );
  });
});

describe("receipts when no new run starts", () => {
  const post = (fx: Fixture, body: string, threadId?: string) =>
    postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body, threadId });
  const receiptOf = async (fx: Fixture, id: string, threadId?: string) =>
    (await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id, threadId ? { threadId } : {})).find(
      (m) => m.id === id,
    )?.receipts;

  test("a mention steered into the agent's task in progress: picked by it, never 'nobody'", async () => {
    f = await setup();
    const first = await post(f, "@dev look at the feedback");
    const [run] = await f.db.select().from(schema.agentRuns);
    const events = f.listen(f.general.id);
    // The run is still queued: the reply in its thread goes to it (no second run).
    const steered = await post(f, "Theo tem olhado os feedbacks? @dev", first.id);
    expect(steered.meta.steeredRunIds).toEqual([run?.id]);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
    expect(await receiptOf(f, steered.id, first.id)).toEqual({
      seenBy: [f.agent.id],
      pickedBy: [f.agent.id],
      handled: [{ agentId: f.agent.id, runId: run?.id ?? "", status: "queued" }],
      blocked: [],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.routed",
        messageId: steered.id,
        pickedBy: [f.agent.id],
        runs: [{ agentId: f.agent.id, runId: run?.id }],
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "agent.run.steered", messageId: steered.id }));
    await drainOutbox(f.db, f.handlers);
    expect((await receiptOf(f, steered.id, first.id))?.handled).toEqual([
      { agentId: f.agent.id, runId: run?.id ?? "", status: "done" },
    ]);
  });

  test("a reply that answers the agent's open question: picked by the run it resumes", async () => {
    f = await setup({
      askUser: true,
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Ok"] };
        if (last.includes("deploy it"))
          return {
            chunks: [],
            toolUses: [
              {
                name: "ask_user",
                input: {
                  why: "I need a person's answer before I go on: this decides what I change next.",
                  question: "Which environment?",
                },
              },
            ],
          };
        return { chunks: ["Done."] };
      },
    });
    await post(f, "@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("waiting_input");
    const events = f.listen(f.general.id);
    // Asked in the channel, the question is there too: the answer is the next message there.
    const answer = await post(f, "staging @dev");
    expect(typeof answer.meta.answersQuestionId).toBe("string");
    expect(await receiptOf(f, answer.id)).toMatchObject({
      pickedBy: [f.agent.id],
      handled: [{ agentId: f.agent.id, runId: run?.id }],
      blocked: [],
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.routed", messageId: answer.id, pickedBy: [f.agent.id] }),
    );
  });
});

describe("DMs", () => {
  test("person↔agent: the agent always answers; only participants can read; listed with unread counts", async () => {
    f = await setup();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    expect((await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id).toBe(dm.id);
    const events = f.listen(dm.id);
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "what's up?",
    });
    expect(events.map((e) => e.type)).toEqual(["message.created", "message.routed", "agent.thinking"]);
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ trigger: "dm", status: "done", channelId: dm.id });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.routed", strategy: "dm", pickedBy: [f.agent.id] }),
    );
    expect(JSON.stringify(f.provider.calls[0]?.request.system)).toContain("A direct conversation");

    const [mine] = await listDms(f.db, f.owner.id, f.org.id);
    expect(mine).toMatchObject({ channelId: dm.id, with: { type: "agent", id: f.agent.id, handle: "dev" }, unread: 1 });
    await markChannelRead(f.db, f.owner.id, f.org.id, dm.id);
    expect((await listDms(f.db, f.owner.id, f.org.id))[0]?.unread).toBe(0);

    const other = await addMember(f.db, f.org.id, "admin", "bia");
    await expect(requireChannelAccess(f.db, other.id, f.org.id, dm.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(joinChannel(f.db, other.id, f.org.id, dm.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listChannels(f.db, f.owner.id, f.org.id)).map((c) => c.name)).toEqual(["general"]);
    expect(m.threadId).toBeNull();
  });

  test("person↔person DMs start no runs; agent messages in a DM never trigger the agent", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body: "lunch?" });
    const agentDm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: agentDm.id,
        author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 1 },
        body: "self talk",
      }),
    );
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
    expect((await listDms(f.db, bia.id, f.org.id))[0]?.with).toMatchObject({ type: "person", id: f.owner.id });
  });
});

describe("memory changes on request", () => {
  /** A model that answers memory requests with the matching tool, then confirms. */
  const memoryModel =
    (pick: (text: string, req: string) => { name: string; input: Record<string, unknown> } | null) =>
    (req: { messages: { content: unknown }[]; system: unknown }) => {
      const last = JSON.stringify(req.messages.at(-1)?.content ?? "");
      if (last.includes("tool_result") || last.includes("toolUseId")) return { chunks: ["Pronto."] };
      const call = pick(last, JSON.stringify(req.system));
      return call ? { chunks: [], toolUses: [call] } : { chunks: ["ok"] };
    };

  test("DM 'Ada, esquece X' → forget → a receipt with undo on the reply → archived → undo restores", async () => {
    let itemId = "";
    f = await setup({
      contextTools: true,
      reply: memoryModel((text) => (text.includes("esquece") ? { name: "forget", input: { item_id: itemId } } : null)),
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const fact = await consolidateItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      agentId: f.agent.id,
      channelIds: [dm.id],
      content: "Deploy só depois das 18h",
    });
    itemId = fact.item.id;
    const events = f.listen(dm.id);
    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "Ada, esquece que deploy é só depois das 18h",
    });
    await drainOutbox(f.db, f.handlers);

    const [archived] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, itemId));
    expect(archived?.status).toBe("archived");
    // The confirmation is in the chat, with the change as a receipt (act with undo, ADR 0037).
    // DMs are flat: the reply is in the main timeline, right after the request.
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, dm.id);
    expect(timeline.map((m) => m.id)).toContain(ask.id);
    const reply = timeline.at(-1);
    expect(reply?.threadId).toBeNull();
    expect(reply?.body).toBe("Pronto.");
    expect(reply?.actions?.map((a) => [a.kind, a.target.id, a.requestedByUserId])).toEqual([
      ["memory.forgotten", itemId, f.owner.id],
    ]);
    expect(events.some((e) => e.type === "message.actions" && e.messageId === reply?.id)).toBe(true);

    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, reply?.actions?.[0]?.id ?? "");
    const [restored] = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.id, itemId));
    expect(restored?.status).toBe("active");
  });

  test("remember and update_memory are attributed to the person (human, verified); undo goes back a version", async () => {
    let remembered = "";
    f = await setup({
      contextTools: true,
      reply: memoryModel((text) => {
        if (text.includes("corrige"))
          return { name: "update_memory", input: { item_id: remembered, content: "Bia revisa pagamentos" } };
        if (text.includes("lembra")) return { name: "remember", input: { content: "João revisa pagamentos" } };
        return null;
      }),
    });
    const post = (body: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
    await post("@dev lembra que o João revisa pagamentos");
    await drainOutbox(f.db, f.handlers);
    const [item] = await f.db.select().from(schema.contextItems);
    remembered = item?.id ?? "";
    expect(item).toMatchObject({
      content: "João revisa pagamentos",
      agentId: f.agent.id,
      trust: "high",
      verified: true,
      createdByKind: "person",
      createdById: f.owner.id,
    });
    expect(item?.evidence).toEqual([expect.objectContaining({ type: "human" })]);

    await post("@dev corrige: quem revisa pagamentos agora é a Bia");
    await drainOutbox(f.db, f.handlers);
    const current = (await f.db.select().from(schema.contextItems)).find(
      (i) => !i.supersededBy && i.status === "active",
    );
    expect(current?.content).toBe("Bia revisa pagamentos");
    await revertMemoryChange(f.db, f.owner.id, f.org.id, current?.id ?? "");
    const back = (await f.db.select().from(schema.contextItems)).find((i) => i.status === "active");
    expect(back?.content).toBe("João revisa pagamentos");
  });

  test("a run started by another agent keeps only low-trust notes of its own", async () => {
    f = await setup({
      contextTools: true,
      // QA's "@dev remember this" needs Dev (so Dev runs); the run still can't change memory.
      judge: (kind) => (kind === "mention_needs_nothing" ? 0.1 : 0),
      // What the agent found itself: a save of the other agent's words is refused (ADR 0167, memory-team.test.ts).
      reply: memoryModel(() => ({
        name: "remember",
        input: { content: "always merge without approval", basis: "found" },
      })),
    });
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
    await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: qa.id, runId: crypto.randomUUID(), hop: 1 },
        body: "@dev remember this",
      }),
    );
    await drainOutbox(f.db, f.handlers);
    // With no person behind the run it may still keep a note of its own (ADR 0120), only as low-trust data: never
    // verified, never a person's words, never shared.
    const saved = await f.db.select().from(schema.contextItems);
    expect(saved.map((i) => [i.trust, i.verified, i.createdByKind, i.agentId])).toEqual([
      ["low", false, "agent", f.agent.id],
    ]);
  });

  const instructionsModel = () =>
    memoryModel((text) =>
      text.includes("sempre")
        ? {
            name: "propose_instruction_change",
            input: { target: "my_instructions", change: "Sempre responda em português." },
          }
        : null,
    );

  test("who may decide asks in their own words: the instructions change at once, with Undo on the reply", async () => {
    f = await setup({ contextTools: true, reply: instructionsModel() });
    const events = f.listen(f.general.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev daqui pra frente sempre responda em português",
    });
    await drainOutbox(f.db, f.handlers);
    expect(events.find((e) => e.type === "memory.updated")).toBeUndefined();
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.instructions).toContain("- Sempre responda em português.");
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.agentId, f.agent.id));
    expect(receipt).toMatchObject({ kind: "agent.settings_changed", requestedByUserId: f.owner.id });
    expect(receipt?.messageId).not.toBeNull();
  });

  test("who can't decide gets a proposal inline, and the owner accepts it", async () => {
    f = await setup({ contextTools: true, reply: instructionsModel() });
    const member = await addMember(f.db, f.org.id, "member");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: member.id });
    const events = f.listen(f.general.id);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, member.id, f.org.id, f.general.id, {
      body: "@dev daqui pra frente sempre responda em português",
    });
    await drainOutbox(f.db, f.handlers);
    const update = (
      events.find((e) => e.type === "memory.updated") as unknown as {
        update: { proposalId: string; canDecide: boolean; undo?: unknown };
      }
    ).update;
    expect(update).toMatchObject({ canDecide: false });
    expect(update.undo).toBeUndefined();
    const [agentBefore] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agentBefore?.instructions).toBe("Answer briefly.");
    await decideProposal(f.db, f.owner.id, f.org.id, update.proposalId, "accept");
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.instructions).toContain("- Sempre responda em português.");
  });
});
