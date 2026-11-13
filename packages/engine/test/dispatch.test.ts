import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createAgentRuns,
  dispatchMentions,
  insertMessage,
  parseMentionHandles,
  postPersonMessage,
  startOrJoinRun,
} from "../src";
import { type Fixture, setup } from "./fixtures";

describe("parseMentionHandles", () => {
  test("finds handles, ignores emails and duplicates", () => {
    expect(parseMentionHandles("@dev and @QA, ping @dev. mail me at a@dev.com")).toEqual(["dev", "qa"]);
    expect(parseMentionHandles("(@ops)")).toEqual(["ops"]);
    expect(parseMentionHandles("no mentions")).toEqual([]);
  });
});

describe("dispatchMentions", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setup();
  });
  afterEach(() => f.close());

  const post = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  const qa = () =>
    createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, { model: "claude-sonnet-5-5" });

  test("one statement: message, its jobs and the mentioned member's run; non-members are not resolved", async () => {
    await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, { model: "claude-sonnet-5-5" }); // not in #general
    const message = await post("@dev and @qa please look");
    expect(message.mentionedAgentIds).toEqual([f.agent.id]);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({
      agentId: f.agent.id,
      trigger: "mention",
      hop: 1,
      threadRootId: message.id,
      status: "queued",
    });
    const jobs = await f.db.select().from(schema.outbox);
    expect(jobs.map((j) => [j.kind, j.payload]).sort()).toEqual([
      ["agent_run.execute", { runId: run?.id }],
      ["message.posted", { messageId: message.id }],
      ["search.index", { kind: "message", sourceId: message.id }],
    ]);
  });

  test("a message without mentions goes to the router; an agent's only below the chime-in hop (ADR 0034)", async () => {
    const message = await post("hello everyone");
    const posted = async () =>
      (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "message.posted").map((j) => j.payload);
    expect(await posted()).toEqual([{ messageId: message.id }]);
    await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 1 },
        body: "just saying",
      }),
    );
    // An agent's answer may bring in one more agent.
    expect(await posted()).toHaveLength(2);
    await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 2 },
        body: "an answer to an answer",
      }),
    );
    // An answer to an answer brings in nobody.
    expect(await posted()).toHaveLength(2);
  });

  test("creates one run per agent and is idempotent", async () => {
    const root = await post("start");
    const other = await qa();
    const message = await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: root.id,
        author: { type: "agent", agentId: other.id, runId: crypto.randomUUID(), hop: 1 },
        body: "@dev your turn",
      }),
    );
    const first = await dispatchMentions(f.db, { orgId: f.org.id, messageId: message.id }, { maxHops: 3 });
    const again = await dispatchMentions(f.db, { orgId: f.org.id, messageId: message.id }, { maxHops: 3 });
    expect(first.runs.map((r) => [r.agentId, r.hop, r.threadRootId, r.status])).toEqual([
      [f.agent.id, 2, root.id, "queued"],
    ]);
    expect(again.runs).toEqual([]);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
    const execute = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
    expect(execute).toHaveLength(1);
  });

  test("mentions in the channel join the agent's run there waiting for its computer: one turn, not one per mention", async () => {
    const other = await qa();
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: other.id });
    await post("@dev oi");
    const machineId = crypto.randomUUID();
    await f.db.update(schema.agentRuns).set({
      status: "waiting_input",
      waitingMachineId: machineId,
      transcript: { waitingForBrain: { kind: "claude_code", machineId, code: "busy", waitId: "w1" } },
    });
    const mention = () =>
      f.db.transaction((tx) =>
        insertMessage(tx, {
          orgId: f.org.id,
          channelId: f.general.id,
          author: { type: "agent", agentId: other.id, runId: crypto.randomUUID(), hop: 1 },
          body: "@dev olha isso",
        }),
      );
    const first = await mention();
    const second = await mention();
    for (const m of [first, second]) await dispatchMentions(f.db, { orgId: f.org.id, messageId: m.id }, { maxHops: 5 });
    // The run answers an agent's message at hop 1 now: its replies count from there, so the hop limit holds.
    expect((await f.db.select().from(schema.agentRuns))[0]?.hop).toBe(2);
    // A person writing there again joins it too.
    const again = await post("@dev responde");
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.pendingMessageIds).toEqual([first.id, second.id, again.id]);
    // A person waits on it now: it goes to the front of its computer's line, and looks again at once.
    expect(runs[0]?.transcript).toMatchObject({ roomPeople: true });
    const look = (await f.db.select().from(schema.outbox)).find((j) => j.dedupeKey?.includes(":steer:"));
    expect(look?.payload).toEqual({ runId: runs[0]?.id, wait: "w1", line: machineId });
  });

  /** The agent's run in #general, parked in line for its computer. */
  const inLine = async () => {
    await post("@dev oi");
    const machineId = crypto.randomUUID();
    await f.db.update(schema.agentRuns).set({
      status: "waiting_input",
      waitingMachineId: machineId,
      transcript: { waitingForBrain: { kind: "claude_code", machineId, code: "busy", waitId: "w1" } },
    });
    return machineId;
  };

  test("a person's message the router sends to a run in line puts it first, and it looks again at once", async () => {
    const machineId = await inLine();
    const unmentioned = await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: "responde",
      }),
    );
    await f.db.transaction((tx) => createAgentRuns(tx, unmentioned, [f.agent.id], "router", { joinChannelRun: true }));
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.pendingMessageIds).toEqual([unmentioned.id]);
    expect(runs[0]?.transcript).toMatchObject({ roomPeople: true });
    const look = (await f.db.select().from(schema.outbox)).find(
      (j) => j.dedupeKey === `agent_run.execute:${runs[0]?.id}:steer:${unmentioned.id}`,
    );
    expect(look?.payload).toEqual({ runId: runs[0]?.id, wait: "w1", line: machineId });
  });

  test("Continuar on a pause card starts a fresh run, never the one waiting for its computer", async () => {
    await inLine();
    const card = await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 3 },
        body: "@dev segue",
      }),
    );
    const out = await f.db.transaction((tx) =>
      startOrJoinRun(tx, card, f.agent.id, "mention", { granted: crypto.randomUUID() }),
    );
    expect(out && "created" in out ? out.created.hop : null).toBe(1);
  });

  test("hop limit: an agent message at the limit triggers nobody", async () => {
    const root = await post("start");
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: other.id });
    const agentMsg = (hop: number) =>
      f.db.transaction((tx) =>
        insertMessage(tx, {
          orgId: f.org.id,
          channelId: f.general.id,
          threadId: root.id,
          author: { type: "agent", agentId: other.id, runId: crypto.randomUUID(), hop },
          body: "@dev your turn",
        }),
      );
    const below = await agentMsg(2);
    expect((await dispatchMentions(f.db, { orgId: f.org.id, messageId: below.id }, { maxHops: 3 })).runs[0]?.hop).toBe(
      3,
    );
    const atLimit = await agentMsg(3);
    expect(await dispatchMentions(f.db, { orgId: f.org.id, messageId: atLimit.id }, { maxHops: 3 })).toEqual({
      runs: [],
      skipped: "hop_limit",
    });
  });

  test("an agent never triggers itself", async () => {
    const msg = await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 1 },
        body: "note to self @dev",
      }),
    );
    expect(msg.mentionedAgentIds).toEqual([]);
  });

  test("archived agents are skipped at dispatch time", async () => {
    const root = await post("start");
    const other = await qa();
    const message = await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: root.id,
        author: { type: "agent", agentId: other.id, runId: crypto.randomUUID(), hop: 1 },
        body: "@dev hi",
      }),
    );
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    expect((await dispatchMentions(f.db, { orgId: f.org.id, messageId: message.id }, { maxHops: 3 })).runs).toEqual([]);
  });
});
