import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import {
  computerQueue,
  createAgent,
  estimateQueue,
  NEW_AGENT_DEFAULTS,
  QUEUE_END_FLOOR_MS,
  ROOM_ASK_SPACING_MS,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

const NOW = Date.parse("2026-11-02T12:00:00Z");
const MIN = 60_000;

test("estimates: each running turn ends at start + its agent's median, never sooner than 30 s from now", () => {
  const typical = { byAgent: { ada: 6 * MIN, kai: 2 * MIN }, org: 4 * MIN };
  const { ends } = estimateQueue(
    NOW,
    [
      { agentId: "ada", startedAt: NOW - 2 * MIN },
      { agentId: "kai", startedAt: NOW - 5 * MIN },
      { agentId: "new", startedAt: NOW - MIN },
    ],
    [],
    typical,
  );
  expect(ends).toEqual([NOW + 4 * MIN, null, NOW + 3 * MIN]);
  expect(estimateQueue(NOW, [{ agentId: "x", startedAt: NOW }], [], { byAgent: {}, org: null }).ends).toEqual([null]);
  // A turn about to reach its typical length still gets the floor: it is not past it.
  const nearly = estimateQueue(NOW, [{ agentId: "kai", startedAt: NOW - 2 * MIN + 5_000 }], [], typical);
  expect(nearly.ends).toEqual([NOW + QUEUE_END_FLOOR_MS]);
});

test("estimates: a turn past its typical length gives no end, and nobody behind it gets a start from it", () => {
  const typical = { byAgent: { ada: 2 * MIN, kai: 3 * MIN }, org: null };
  const past = estimateQueue(
    NOW,
    [{ agentId: "ada", startedAt: NOW - 33 * MIN }],
    [
      { agentId: "kai", people: true },
      { agentId: "kai", people: false },
    ],
    typical,
  );
  expect(past).toMatchObject({ ends: [null], overdue: [true], starts: [null, null] });
  // Who the head waits for is still known; what isn't is when.
  expect(past.after[0]).toEqual(["ada"]);

  // A slot that frees at a known time serves the line first; only what falls behind the unknown one has no start.
  const mixed = estimateQueue(
    NOW,
    [
      { agentId: "ada", startedAt: NOW - 33 * MIN },
      { agentId: "kai", startedAt: NOW - MIN },
    ],
    [{ agentId: "ada", people: true }],
    typical,
  );
  expect(mixed).toMatchObject({ overdue: [true, false], starts: [NOW + 2 * MIN] });

  // With no basis at all it isn't overdue: it has nothing to be past.
  expect(estimateQueue(NOW, [{ agentId: "x", startedAt: 0 }], [], { byAgent: {}, org: null }).overdue).toEqual([false]);
});

test("estimates: the line takes slots as they free, agents' turns spaced, a person's not", () => {
  const typical = { byAgent: { ada: 4 * MIN, kai: 2 * MIN, rio: MIN }, org: null };
  const { starts, after } = estimateQueue(
    NOW,
    [
      { agentId: "ada", startedAt: NOW - MIN }, // ends +3 min
      { agentId: "kai", startedAt: NOW - MIN }, // ends +1 min
    ],
    [
      { agentId: "rio", people: true },
      { agentId: "nova", people: false },
      { agentId: "kai", people: false },
    ],
    typical,
  );
  // rio takes kai's slot at +1 min; nova (no basis: its slot frees at an unknown time) takes rio's at +2 min;
  // kai gets ada's slot at +3 min, spaced from nova's ask.
  expect(starts).toEqual([NOW + MIN, NOW + 2 * MIN, NOW + 3 * MIN]);
  expect(after).toEqual([["kai"], ["rio"], ["rio", "nova"]]);

  // Agents freed at the same moment still start the spacing apart.
  const spaced = estimateQueue(
    NOW,
    [
      { agentId: "ada", startedAt: NOW - 3 * MIN },
      { agentId: "kai", startedAt: NOW - MIN },
    ],
    [
      { agentId: "rio", people: false },
      { agentId: "nova", people: false },
    ],
    { byAgent: { ada: 4 * MIN, kai: 2 * MIN }, org: null },
  );
  expect(spaced.starts).toEqual([NOW + MIN, NOW + MIN + ROOM_ASK_SPACING_MS]);
});

test("estimates: with no basis the line names the turn it waits for, and nothing after an unknown end", () => {
  const { starts, after } = estimateQueue(
    NOW,
    [
      { agentId: "ada", startedAt: NOW - 9 * MIN },
      { agentId: "kai", startedAt: NOW - MIN },
    ],
    [
      { agentId: "rio", people: false },
      { agentId: "nova", people: false },
      { agentId: "lia", people: false },
    ],
    { byAgent: {}, org: null },
  );
  expect(starts).toEqual([null, null, null]);
  // The longest running turn is the one the head waits for.
  expect(after[0]).toEqual(["ada"]);
  // Nothing running on it (memory used by something else): no estimate.
  expect(estimateQueue(NOW, [], [{ agentId: "rio", people: true }], { byAgent: {}, org: MIN }).starts).toEqual([null]);
});

test("a computer's queue: working turns and the line in roomHead's order, purposes without content, medians", async () => {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  const { machineId } = await pairMachine(deps, f.owner.id, f.org.id, {
    name: "Studio",
    hostname: "studio",
    os: "linux",
    arch: "x64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/home/a/agentes",
    exec: true,
  });
  const nova = f.agent;
  const rio = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Rio", handle: "rio", role: "Ops", instructions: "" },
    NEW_AGENT_DEFAULTS,
  );
  const msg = async (author: { userId?: string; agentId?: string }, meta: Record<string, unknown> = {}) => {
    const [m] = await f.db
      .insert(schema.messages)
      .values({
        orgId: f.org.id,
        channelId: f.general.id,
        authorType: author.userId ? "person" : "agent",
        authorUserId: author.userId ?? null,
        authorAgentId: author.agentId ?? null,
        body: "secret plans",
        meta,
      })
      .returning();
    return m as typeof schema.messages.$inferSelect;
  };
  const now = Date.now();
  const run = async (
    agentId: string,
    trigger: { id: string },
    status: "running" | "waiting_input" | "done",
    transcript: Record<string, unknown>,
    over: Partial<typeof schema.agentRuns.$inferInsert> = {},
  ) => {
    const [r] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
        status,
        brain: "claude_code",
        transcript,
        ...(status === "waiting_input" ? { waitingMachineId: machineId } : {}),
        ...over,
      })
      .returning();
    return r as typeof schema.agentRuns.$inferSelect;
  };
  const busy = (since: number, people = false) => ({
    waitingForBrain: { code: "busy", machineId, waitId: crypto.randomUUID() },
    roomWaitSince: since,
    ...(people ? { roomPeople: true } : {}),
  });

  // History: Nova's turns took 2 and 4 minutes (median 3); Rio has none, so the workspace's median.
  for (const [ms, at] of [
    [2 * MIN, now - 60 * MIN],
    [4 * MIN, now - 30 * MIN],
  ] as const) {
    await run(
      nova.id,
      await msg({ userId: f.owner.id }),
      "done",
      { roomAsk: { machineId, at: at - ms } },
      {
        finishedAt: new Date(at),
      },
    );
  }

  const working = await run(nova.id, await msg({ userId: f.owner.id }), "running", {
    roomAsk: { machineId, at: now - MIN },
  });
  // Another computer's turn isn't on this one.
  await run(rio.id, await msg({ userId: f.owner.id }), "running", {
    roomAsk: { machineId: crypto.randomUUID(), at: now },
  });
  const byAgent = await run(rio.id, await msg({ agentId: nova.id }), "waiting_input", busy(now - 5 * MIN));
  const routine = await run(nova.id, await msg({ userId: f.owner.id }), "waiting_input", busy(now - 9 * MIN), {
    background: true,
  });
  const person = await run(rio.id, await msg({ userId: f.owner.id }), "waiting_input", busy(now - MIN, true));

  const q = await computerQueue(f.db, f.owner.id, f.org.id, machineId, now);
  expect(q.name).toBe("Studio");
  expect(q.working).toHaveLength(1);
  expect(q.working[0]).toMatchObject({
    runId: working.id,
    agentId: nova.id,
    purpose: { kind: "person", userId: f.owner.id },
    where: { channelId: f.general.id, threadId: null, agents: false },
    overdue: false,
    startedAt: new Date(now - MIN).toISOString(),
    // 3 min median from its start.
    estimatedEndAt: new Date(now + 2 * MIN).toISOString(),
  });
  expect(q.waiting.map((w) => w.runId)).toEqual([person.id, routine.id, byAgent.id]);
  expect(q.waiting.map((w) => w.position)).toEqual([1, 2, 3]);
  expect(q.waiting.map((w) => w.purpose)).toEqual([
    { kind: "person", userId: f.owner.id },
    { kind: "routine" },
    { kind: "agent", agentId: nova.id },
  ]);
  expect(q.waiting[0]).toMatchObject({
    people: true,
    after: [nova.id],
    estimatedStartAt: new Date(now + 2 * MIN).toISOString(),
  });
  expect(q.waiting[2]?.after).toEqual([rio.id, nova.id]);
  expect(JSON.stringify(q)).not.toContain("secret plans");

  // Any member reads it; another workspace's computer is not found.
  const member = await addMember(f.db, f.org.id, "member", "bia");
  const seen = await computerQueue(f.db, member.id, f.org.id, machineId, now);
  expect(seen.waiting).toHaveLength(3);
  // What a row lets its reader do follows who reads it.
  expect(q.waiting[0]).toMatchObject({ canOpen: true, canStop: true });
  expect(seen.working[0]).toMatchObject({ canOpen: false, canStop: false, where: { agents: false } });
  const stranger = await addUser(f.db, "eve");
  await expect(computerQueue(f.db, stranger.id, f.org.id, machineId, now)).rejects.toThrow();
  await expect(computerQueue(f.db, f.owner.id, f.org.id, crypto.randomUUID(), now)).rejects.toThrow(
    "Computer not found",
  );

  // Work a person asked for lately ranks after people's runs and before the rest, however short its wait.
  const asked = await run(nova.id, await msg({ agentId: rio.id }), "waiting_input", {
    ...busy(now - 2 * MIN),
    roomAsked: true,
  });
  const line = await computerQueue(f.db, f.owner.id, f.org.id, machineId, now);
  expect(line.waiting.map((w) => w.runId)).toEqual([person.id, asked.id, routine.id, byAgent.id]);
});
