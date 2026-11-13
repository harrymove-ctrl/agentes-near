import { describe, expect, test } from "bun:test";
import type { ActiveRun, ChannelEvent, Message } from "@agenteschat/client";
import {
  applyChannelEvent,
  applyReceiptEvent,
  applyTyping,
  emptyStreams,
  expectReply,
  expireTyping,
  receiptTicks,
  receiptView,
  reconcileRuns,
  runsInChannel,
  seedReceipt,
  seedReceipts,
  stopTyping,
  TYPING_TTL_MS,
  typingIn,
  typingThrottle,
} from "@agenteschat/client";
import { createStreamsStore } from "@/realtime/context";

const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };

describe("agent activity: thinking → typing → idle", () => {
  test("a mention shows 'pensando' at once; the first server event replaces the provisional row", () => {
    // The server announces at post time (runId null), then the run thinks.
    let s = applyChannelEvent(emptyStreams, { type: "agent.thinking", ...base, runId: null });
    expect(runsInChannel(s, "c1")).toMatchObject([{ status: "thinking", provisional: true }]);
    s = expectReply(s, { channelId: "c1", threadId: "m1", agentId: "ada" });
    expect(runsInChannel(s, "c1")).toHaveLength(1);
    s = applyChannelEvent(s, { type: "agent.thinking", ...base });
    expect(runsInChannel(s, "c1")).toMatchObject([{ runId: "r1", status: "thinking" }]);
    expect(runsInChannel(s, "c1").some((r) => r.provisional)).toBe(false);
    s = applyChannelEvent(s, { type: "agent.typing", ...base });
    s = applyChannelEvent(s, { type: "agent.delta", ...base, seq: 1, text: "Achei" });
    // It writes; its words wait for its message.
    expect(runsInChannel(s, "c1")).toMatchObject([{ status: "running" }]);
    expect(JSON.stringify(runsInChannel(s, "c1"))).not.toContain("Achei");
    s = applyChannelEvent(s, { type: "agent.idle", ...base });
    expect(runsInChannel(s, "c1")).toEqual([]);
  });

  test("today's events work the same way: agent.run running without text is 'thinking'", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    expect(runsInChannel(s, "c1")[0]?.status).toBe("thinking");
    s = applyChannelEvent(s, { type: "agent.delta", ...base, seq: 1, text: "Oi" });
    expect(runsInChannel(s, "c1")[0]?.status).toBe("running");
    s = applyChannelEvent(s, { type: "run.finished", ...base, status: "failed", error: "budget_exceeded" });
    expect(runsInChannel(s, "c1")[0]?.status).toBe("failed");
  });

  test("a run that fails says why in words from its first event, never its stored code until run.finished comes", () => {
    const failure = {
      error: "cli_failed: Claude Code: prompt is too long",
      errorCode: "run.cli_failed",
      errorParams: { brain: "Claude Code", detail: "prompt is too long" },
    };
    const s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "failed", ...failure });
    expect(runsInChannel(s, "c1")[0]).toMatchObject({ status: "failed", ...failure });
  });

  test("an agent's reply message settles its provisional row", () => {
    let s = expectReply(emptyStreams, { channelId: "c1", threadId: "m1", agentId: "ada" });
    const reply = { id: "m2", agentRunId: "r1", threadId: "m1", author: { type: "agent", id: "ada" } } as Message;
    s = applyChannelEvent(s, { type: "message.created", channelId: "c1", messageId: "m2", message: reply });
    expect(runsInChannel(s, "c1")).toEqual([]);
  });
});

describe("typing", () => {
  test("people typing expire after a few seconds and stop when their message arrives", () => {
    let s = applyTyping({}, "c1", "marina", 1000);
    expect(typingIn(s, "c1", 1000 + TYPING_TTL_MS - 1)).toEqual(["marina"]);
    expect(typingIn(s, "c1", 1000 + TYPING_TTL_MS + 1)).toEqual([]);
    expect(typingIn(s, "c1", 1000, "marina")).toEqual([]);
    s = stopTyping(s, "c1", "marina");
    expect(typingIn(s, "c1", 1000)).toEqual([]);
  });

  test("typing in a thread shows in that thread only; the latest frame says where", () => {
    let s = applyTyping({}, "c1", "marina", 1000, TYPING_TTL_MS, "t1");
    s = applyTyping(s, "c1", "joao", 1000);
    expect(typingIn(s, "c1", 1000)).toEqual(["joao"]);
    expect(typingIn(s, "c1", 1000, undefined, "t1")).toEqual(["marina"]);
    expect(typingIn(s, "c1", 1000, undefined, "t2")).toEqual([]);
    // She moved to the conversation itself.
    s = applyTyping(s, "c1", "marina", 2000);
    expect(typingIn(s, "c1", 2000)).toEqual(["marina", "joao"]);
    expect(typingIn(s, "c1", 2000, undefined, "t1")).toEqual([]);
  });

  test("what ran out is dropped on time (a store sweeping it re-renders); nothing ran out, the same state", () => {
    let s = applyTyping({}, "c1", "marina", 1000, 5000);
    s = applyTyping(s, "c1", "joao", 3000, 5000);
    expect(expireTyping(s, 5999)).toBe(s);
    const swept = expireTyping(s, 6000);
    expect(Object.keys(swept.c1 ?? {})).toEqual(["joao"]);
    expect(Object.keys(expireTyping(swept, 8000).c1 ?? {})).toEqual([]);
  });

  test("our own typing frames are throttled to one every 3 s", () => {
    const shouldSend = typingThrottle(3000);
    expect([0, 500, 2999, 3000, 3100, 6000].map((t) => shouldSend(t))).toEqual([true, false, false, true, false, true]);
    // A new message goes at once, so a second message right after the first shows as typing.
    const send = typingThrottle(3000);
    expect(send(0, "o")).toBe(true);
    expect(send(500, "oi")).toBe(false);
    // Sent (the field cleared without a change event), then a suggestion tapped: several characters at once.
    expect(send(1500, "Preciso ")).toBe(true);
    expect(send(1600, "Preciso d")).toBe(false);
    expect(send(1700, "Precis")).toBe(false);
    // Pasted into an emptied field.
    expect(send(1800, "")).toBe(false);
    expect(send(1900, "olha o relatório de ontem")).toBe(true);
  });
});

describe("receipts", () => {
  const person = (mentioned: string[] = []) =>
    ({ id: "m1", author: { type: "person", id: "u" }, mentionedAgentIds: mentioned }) as unknown as Message;
  const step = (s: ReturnType<typeof seedReceipt>, e: Partial<ChannelEvent> & { type: string }) =>
    applyReceiptEvent(s, { channelId: "c1", ...e } as ChannelEvent);

  test("mentioned → vai responder → respondendo → esperando aprovação → respondendo → respondeu", () => {
    let s = seedReceipt({}, person(["ada"]));
    expect(receiptView(s.m1).status).toEqual({ kind: "picked", agents: ["ada"] });
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "running" });
    expect(receiptView(s.m1).status?.kind).toBe("claimed");
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "waiting_approval" });
    expect(receiptView(s.m1).status?.kind).toBe("waiting");
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "running" });
    expect(receiptView(s.m1).status?.kind).toBe("claimed");
    s = step(s, { type: "message.handled", messageId: "m1", agentId: "ada" });
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "handled", agents: ["ada"] }, done: true });
    // A late "routed" doesn't move it back.
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: ["ada"] });
    expect(receiptView(s.m1).status?.kind).toBe("handled");
  });

  test("routed to one agent that passed: 'Ninguém respondeu', never 'Respondeu', live and after a reload", () => {
    const routedTo = (agents: string[]) =>
      step(seedReceipt({}, person()), {
        type: "message.routed",
        messageId: "m1",
        seenBy: agents,
        pickedBy: agents,
        runs: agents.map((agentId, i) => ({ agentId, runId: `r${i}` })),
      });
    // The executor's order when it passes (`endQuietly`).
    let s = routedTo(["ada"]);
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r0", agentId: "ada", status: "running" });
    s = step(s, { type: "agent.passed", threadId: "m1", runId: "r0", agentId: "ada" });
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r0", agentId: "ada", status: "done" });
    s = step(s, { type: "run.finished", threadId: "m1", runId: "r0", agentId: "ada", status: "done" });
    s = step(s, {
      type: "message.handled",
      messageId: "m1",
      agentId: "ada",
      runId: "r0",
      status: "done",
      passed: true,
    });
    expect(s.m1?.agents).toEqual([["ada", "passed"]]);
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "passed", agents: ["ada"] }, done: true });
    expect(receiptTicks(s.m1)).toBe("checks");
    // After a reload: the list says it passed.
    const listed = seedReceipt({}, {
      ...person(),
      receipts: {
        seenBy: ["ada"],
        pickedBy: ["ada"],
        handled: [{ agentId: "ada", runId: "r0", status: "done", passed: true }],
      },
    } as Message);
    expect(receiptView(listed.m1).status).toEqual({ kind: "passed", agents: ["ada"] });
    expect(receiptTicks(listed.m1)).toBe("checks");
    // One answer is the answer, whoever else passed.
    let two = routedTo(["ada", "atlas"]);
    two = step(two, {
      type: "message.handled",
      messageId: "m1",
      agentId: "ada",
      runId: "r0",
      status: "done",
      passed: true,
    });
    two = step(two, { type: "message.handled", messageId: "m1", agentId: "atlas", runId: "r1", status: "done" });
    expect(receiptView(two.m1).status).toEqual({ kind: "handled", agents: ["atlas"] });
    expect(two.m1?.agents).toEqual([
      ["ada", "passed"],
      ["atlas", "handled"],
    ]);
  });

  test("a run canceled before it ran didn't reply; one canceled once started reads canceled", () => {
    let s = seedReceipt({}, person(["ada"]));
    s = step(s, {
      type: "message.routed",
      messageId: "m1",
      seenBy: ["ada"],
      pickedBy: ["ada"],
      runs: [{ agentId: "ada", runId: "r" }],
    });
    // cancel.ts, for a run nobody was executing.
    s = step(s, {
      type: "message.handled",
      messageId: "m1",
      agentId: "ada",
      runId: "r",
      status: "canceled",
      passed: true,
    });
    expect(receiptView(s.m1).status).toEqual({ kind: "passed", agents: ["ada"] });
    const listed = (passed: boolean) =>
      seedReceipt({}, {
        ...person(["ada"]),
        receipts: {
          seenBy: ["ada"],
          pickedBy: ["ada"],
          handled: [{ agentId: "ada", runId: "r", status: "canceled", ...(passed ? { passed: true } : {}) }],
        },
      } as Message);
    expect(receiptView(listed(true).m1).status?.kind).toBe("passed");
    expect(receiptView(listed(false).m1).status).toEqual({ kind: "canceled", agents: ["ada"] });
    expect(receiptTicks(listed(false).m1)).toBe("checks");
  });

  test("waiting on its plan or budget reads that wait, never 'waiting for your answer', and a cancel ends it", () => {
    const routed = step(seedReceipt({}, person(["ada"])), {
      type: "message.routed",
      messageId: "m1",
      seenBy: ["ada"],
      pickedBy: ["ada"],
      runs: [{ agentId: "ada", runId: "r" }],
    });
    // executor.ts `waitForUsage`: the run parks on the plan's limit.
    let s = step(routed, {
      type: "run.finished",
      threadId: "m1",
      runId: "r",
      agentId: "ada",
      status: "waiting_input",
      usage: "plan",
    });
    expect(receiptView(s.m1).status).toEqual({ kind: "plan", agents: ["ada"] });
    expect(receiptTicks(s.m1)).toBe("check");
    // A message sent into it while it waits shows the same wait.
    s = step(s, { type: "agent.run.steered", messageId: "m2", runId: "r", agentId: "ada", usage: "plan" } as never);
    expect(receiptView(s.m2).status).toEqual({ kind: "plan", agents: ["ada"] });
    // "Não rodar": cancel.ts finishes a run nobody executes.
    s = step(s, { type: "run.finished", threadId: "m1", runId: "r", agentId: "ada", status: "canceled" });
    expect(receiptView(s.m1).status).toEqual({ kind: "canceled", agents: ["ada"] });
    expect(receiptView(s.m2).status).toEqual({ kind: "canceled", agents: ["ada"] });
    // The budget, after a reload.
    const listed = seedReceipt({}, {
      ...person(["ada"]),
      receipts: {
        seenBy: ["ada"],
        pickedBy: ["ada"],
        handled: [{ agentId: "ada", runId: "r", status: "waiting_input", usage: "budget" }],
      },
    } as Message);
    expect(receiptView(listed.m1).status).toEqual({ kind: "budget", agents: ["ada"] });
    // A question asked is still "waiting for your answer".
    const asked = step(routed, {
      type: "run.finished",
      threadId: "m1",
      runId: "r",
      agentId: "ada",
      status: "waiting_input",
    });
    expect(receiptView(asked.m1).status?.kind).toBe("asking");
  });

  test("a message sent into a run that then passed didn't get a reply either, live as after a reload", () => {
    // m1 started the run, m2 went into it (`agent.run.steered`); only m1 gets `message.handled`.
    let s = step(seedReceipt({}, person()), {
      type: "message.routed",
      messageId: "m1",
      seenBy: ["ada"],
      pickedBy: ["ada"],
      runs: [{ agentId: "ada", runId: "r" }],
    });
    s = step(s, { type: "agent.run.steered", messageId: "m2", runId: "r", agentId: "ada" } as never);
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "done" });
    s = step(s, { type: "run.finished", threadId: "m1", runId: "r", agentId: "ada", status: "done", passed: true });
    expect(s.m2?.agents).toEqual([["ada", "passed"]]);
    expect(receiptView(s.m2).status).toEqual({ kind: "passed", agents: ["ada"] });
  });

  test("an agent's message that mentions agents: whom it handed off to, the one only mentioned, never 'nobody'", () => {
    const byTheo = {
      id: "m1",
      author: { type: "agent", id: "theo" },
      mentionedAgentIds: ["ada"],
    } as unknown as Message;
    let s = seedReceipt({}, byTheo);
    // No guess: the judge decides whom it hands off to (ADR 0089).
    expect(receiptView(s.m1)).toMatchObject({ seen: ["ada"], status: null });
    s = step(s, {
      type: "message.routed",
      messageId: "m1",
      seenBy: ["ada"],
      pickedBy: [],
      referenced: ["ada"],
      strategy: "mention",
    });
    expect(receiptView(s.m1)).toMatchObject({ seen: ["ada"], status: null, referenced: ["ada"] });
    // From the list after a reload, the same.
    const listed = seedReceipt({}, {
      ...byTheo,
      receipts: { seenBy: ["ada"], pickedBy: [], handled: [], blocked: [], referenced: ["ada"] },
    } as unknown as Message);
    expect(receiptView(listed.m1)).toMatchObject({ status: null, referenced: ["ada"] });
    // Handed off: who answers, as under a person's message.
    s = step(seedReceipt({}, byTheo), { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: ["ada"] });
    expect(receiptView(s.m1).status).toEqual({ kind: "picked", agents: ["ada"] });
    // An agent's message that mentions nobody has no receipt.
    expect(seedReceipt({}, { ...byTheo, mentionedAgentIds: [] } as unknown as Message)).toEqual({});
  });

  test("seen by two, picked by nobody: 'Nenhum agente vai responder'", () => {
    let s = seedReceipt({}, person());
    expect(receiptView(s.m1).status).toBeNull();
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada", "atlas"], pickedBy: [] });
    expect(receiptView(s.m1)).toMatchObject({ seen: ["ada", "atlas"], status: { kind: "nobody" } });
  });

  test("past the workspace's platform AI nobody is asked: the row says to mention an agent, live and from the list", () => {
    const live = step(seedReceipt({}, person()), {
      type: "message.routed",
      messageId: "m1",
      seenBy: [],
      pickedBy: [],
      strategy: "none",
      reason: "platform_cap",
    });
    expect(receiptView(live.m1)).toMatchObject({ seen: [], status: { kind: "platform_cap" } });
    const listed = seedReceipt(
      {},
      { ...person(), receipts: { seenBy: [], pickedBy: [], handled: [], platformCap: true } },
    );
    expect(receiptView(listed.m1).status).toEqual({ kind: "platform_cap" });
    // Routed again later (answer now), the new decision says what happens.
    const again = step(live, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: ["ada"] });
    expect(receiptView(again.m1).status).toEqual({ kind: "picked", agents: ["ada"] });
  });

  test("who picked: kept from the decision and from the list; a decision from before says nothing", () => {
    const plan = { step: "plan" as const, brand: "claude" as const, ownerId: "u" };
    let s = seedReceipt({}, person());
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: ["ada"], decidedBy: plan });
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "picked", agents: ["ada"] }, decidedBy: plan });
    // The run's own events keep it.
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "running" });
    expect(receiptView(s.m1).decidedBy).toEqual(plan);

    const reply = { step: "rule" as const, rule: "reply" as const };
    const listed = (receipts: NonNullable<Message["receipts"]>) => ({ ...person(), receipts }) as Message;
    const seeded = seedReceipt({}, listed({ seenBy: ["ada"], pickedBy: ["ada"], handled: [], decidedBy: reply }));
    expect(receiptView(seeded.m1).decidedBy).toEqual(reply);
    const old = seedReceipt({}, listed({ seenBy: ["ada"], pickedBy: ["ada"], handled: [] }));
    expect(receiptView(old.m1)).not.toHaveProperty("decidedBy");
  });

  test("nobody could read it: the reason, live and after a reload; another nobody has none", () => {
    let s = seedReceipt({}, person());
    s = step(s, {
      type: "message.routed",
      messageId: "m1",
      seenBy: ["ada"],
      pickedBy: [],
      strategy: "router",
      reason: "mention_needed",
    });
    expect(receiptView(s.m1).status).toEqual({ kind: "nobody", mentionNeeded: true });
    const reloaded = seedReceipt({}, {
      ...person(),
      receipts: { seenBy: ["ada"], pickedBy: [], handled: [], reason: "mention_needed" },
    } as Message);
    expect(receiptView(reloaded.m1).status).toEqual({ kind: "nobody", mentionNeeded: true });
    const jev = step(seedReceipt({}, person()), {
      type: "message.routed",
      messageId: "m1",
      seenBy: ["ada"],
      pickedBy: [],
      decidedBy: { step: "jev" },
    });
    expect(receiptView(jev.m1)).toMatchObject({ status: { kind: "nobody" }, decidedBy: { step: "jev" } });
    expect(receiptView(jev.m1).status).not.toHaveProperty("mentionNeeded");
  });

  test("'Picking who answers' while the author's plan reads it, until the decision", () => {
    let s = seedReceipt({}, person());
    expect(receiptView(s.m1).picking).toBeUndefined();
    s = step(s, { type: "message.routing", messageId: "m1", step: "plan" });
    expect(receiptView(s.m1)).toEqual({ seen: [], status: null, done: false, referenced: [], picking: true });
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: [], reason: "mention_needed" });
    expect(receiptView(s.m1).picking).toBeUndefined();
    expect(receiptView(s.m1).status).toEqual({ kind: "nobody", mentionNeeded: true });
    // A late "routing" after the decision changes nothing.
    expect(step(s, { type: "message.routing", messageId: "m1", step: "plan" })).toBe(s);
  });

  test("a list read before the decision keeps 'Picking who answers', whichever comes first", () => {
    const undecided = { ...person(), receipts: { seenBy: [], pickedBy: [], handled: [], blocked: [] } } as Message;
    const picking = { seen: [], status: null, done: false, referenced: [], picking: true as const };
    let s = step(seedReceipt({}, person()), { type: "message.routing", messageId: "m1", step: "plan" });
    s = seedReceipt(s, undecided);
    expect(receiptView(s.m1)).toEqual(picking);
    s = seedReceipt({}, undecided);
    s = step(s, { type: "message.routing", messageId: "m1", step: "plan" });
    expect(receiptView(s.m1)).toEqual(picking);
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: ["ada"] });
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "picked", agents: ["ada"] } });
    expect(receiptView(s.m1).picking).toBeUndefined();
  });

  test("claimed and failed; server receipts seed the row", () => {
    let s = step({}, { type: "message.claimed", messageId: "m1", agentId: "atlas" });
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["atlas"] });
    s = step(s, { type: "message.handled", messageId: "m1", agentId: "atlas", status: "failed" });
    expect(receiptView(s.m1).status).toEqual({ kind: "failed", agents: ["atlas"] });
    const seeded = seedReceipt(
      {},
      {
        ...person(),
        receipts: { seenBy: ["ada", "atlas"], pickedBy: ["ada"], handled: [{ agentId: "ada", status: "done" }] },
      },
    );
    expect(receiptView(seeded.m1)).toMatchObject({ seen: ["ada", "atlas"], status: { kind: "handled" } });
  });

  test("a question asked in the channel (no thread) reaches the message its run answers", () => {
    let s = step(seedReceipt({}, person(["ada"])), {
      type: "message.claimed",
      messageId: "m1",
      agentId: "ada",
      runId: "r",
    });
    const question = { id: "q", agentId: "ada", runId: "r" };
    s = step(s, { type: "question.asked", threadId: null, question } as never);
    expect(receiptView(s.m1).status).toEqual({ kind: "asking", agents: ["ada"] });
    s = step(s, { type: "question.answered", threadId: null, question } as never);
    expect(receiptView(s.m1).status?.kind).toBe("claimed");
  });

  /** A read of m1, as over HTTP: new objects each time. */
  const read = (handled: NonNullable<Message["receipts"]>["handled"]) =>
    ({ ...person(["ada"]), receipts: { seenBy: ["ada"], pickedBy: ["ada"], handled, blocked: [] } }) as Message;
  const running = () => read([{ agentId: "ada", runId: "r1", status: "running" }]);

  test("a later read shows how her run ended when its events were missed; an older one moves nothing, not even sideways", () => {
    // Read as her run started; it ended for want of an AI before the channel's events reached us.
    let s = seedReceipt({}, running());
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    s = seedReceipt(s, read([{ agentId: "ada", runId: "r1", status: "failed", reason: "no_ai" }]));
    expect(receiptView(s.m1).status).toEqual({ kind: "no_ai", agents: ["ada"] });
    s = seedReceipt(s, running());
    expect(receiptView(s.m1).status).toEqual({ kind: "no_ai", agents: ["ada"] });
    // She asks live; a read made before that lands after it.
    s = seedReceipt({}, running());
    s = step(s, {
      type: "question.asked",
      threadId: null,
      question: { id: "q", agentId: "ada", runId: "r1" },
    } as never);
    s = seedReceipt(s, running());
    expect(receiptView(s.m1).status).toEqual({ kind: "asking", agents: ["ada"] });
  });

  test("after 'Responder agora', a read of her old run's end never covers the new run", () => {
    const noAi = read([{ agentId: "ada", runId: "r1", status: "failed", reason: "no_ai" }]);
    let s = seedReceipt({}, noAi);
    s = step(s, { type: "message.claimed", messageId: "m1", agentId: "ada", runId: "r2" });
    s = step(s, { type: "agent.run", runId: "r2", agentId: "ada", status: "running" });
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    // The list seeding that read again, and a copy of it made before she started again (a refetch on its way).
    s = seedReceipt(s, noAi);
    s = seedReceipt(s, structuredClone(noAi));
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    s = step(s, { type: "message.handled", messageId: "m1", agentId: "ada", runId: "r2", status: "done" });
    s = seedReceipt(s, structuredClone(noAi));
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "handled", agents: ["ada"] }, done: true });
  });

  test("Tentar de novo: the new run's claim on the same message replaces the failure at once", () => {
    let s = seedReceipt({}, read([{ agentId: "ada", runId: "r1", status: "failed" }]));
    expect(receiptView(s.m1).status).toEqual({ kind: "failed", agents: ["ada"] });
    s = step(s, { type: "message.claimed", messageId: "m1", agentId: "ada", runId: "r2" });
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    // A late claim of the run it already follows never undoes its end.
    s = step(s, { type: "message.handled", messageId: "m1", agentId: "ada", runId: "r2", status: "done" });
    s = step(s, { type: "message.claimed", messageId: "m1", agentId: "ada", runId: "r2" });
    expect(receiptView(s.m1).status?.kind).toBe("handled");
  });

  test("Tentar de novo into her task already at work: going into it replaces the failure too, a late one undoes nothing", () => {
    let s = seedReceipt({}, read([{ agentId: "ada", runId: "r1", status: "failed" }]));
    s = step(s, { type: "agent.run.steered", messageId: "m1", agentId: "ada", runId: "t1" } as never);
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    s = step(s, { type: "message.handled", messageId: "m1", agentId: "ada", runId: "t1", status: "done" });
    s = step(s, { type: "agent.run.steered", messageId: "m1", agentId: "ada", runId: "t1" } as never);
    expect(receiptView(s.m1).status?.kind).toBe("handled");
  });

  test("a read nothing changed the receipt since it was asked for is taken as it is", () => {
    let s = seedReceipt({}, running());
    // She asked before the channel's events reached us.
    s = seedReceipt(s, read([{ agentId: "ada", runId: "r1", status: "waiting_input" }]), true);
    expect(receiptView(s.m1).status).toEqual({ kind: "asking", agents: ["ada"] });
  });
});

describe("server confirmation and the safety timeout", () => {
  test("message.routed is authoritative: a guessed 'picked' falls back to 'seen' and the provisional row goes", async () => {
    const { guessReceipt } = await import("@agenteschat/client");
    let r = guessReceipt({}, "m1", ["theo"]);
    expect(receiptView(r.m1).status?.kind).toBe("picked");
    expect(r.m1?.confirmed).toBe(false);
    r = applyReceiptEvent(r, {
      type: "message.routed",
      channelId: "c",
      messageId: "m1",
      seenBy: ["theo"],
      pickedBy: [],
    });
    expect(receiptView(r.m1).status).toEqual({ kind: "nobody" });
    let s = expectReply(emptyStreams, { channelId: "c", threadId: "m1", agentId: "theo" });
    s = applyChannelEvent(s, {
      type: "message.routed",
      channelId: "c",
      messageId: "m1",
      seenBy: ["theo"],
      pickedBy: [],
    });
    expect(runsInChannel(s, "c")).toEqual([]);
  });

  test("an unconfirmed 'pensando…' is dropped after 20 s and its channel resyncs", async () => {
    const { createStreamsStore, PROVISIONAL_TTL_MS } = await import("@/realtime/context");
    let now = 1000;
    const store = createStreamsStore(undefined, () => now);
    store.expect("c1", "m1", ["theo"]);
    expect(runsInChannel(store.get().streams, "c1")).toHaveLength(1);
    now += PROVISIONAL_TTL_MS - 1;
    expect(store.sweep()).toEqual([]);
    now += 2;
    expect(store.sweep()).toEqual(["c1"]);
    expect(runsInChannel(store.get().streams, "c1")).toEqual([]);
    expect(store.get().receipts.m1).toBeUndefined();
  });

  test("server receipts from a refetch replace the client's guess", () => {
    const guessed = applyReceiptEvent(
      {},
      { type: "agent.thinking", channelId: "c", threadId: "x", agentId: "a", runId: null },
    );
    expect(guessed.x?.confirmed).toBe(true);
    const local = seedReceipt({}, {
      id: "m1",
      author: { type: "person", id: "u" },
      mentionedAgentIds: ["theo"],
    } as unknown as Message);
    expect(local.m1?.confirmed).toBe(false);
    const fromServer = seedReceipt(local, {
      id: "m1",
      author: { type: "person", id: "u" },
      mentionedAgentIds: ["theo"],
      receipts: { seenBy: ["theo"], pickedBy: [], handled: [], blocked: ["theo"] },
    } as unknown as Message);
    // Only when the server says the mentioned agent can't answer this person.
    expect(receiptView(fromServer.m1).status).toEqual({ kind: "nobody" });
  });
});

describe("receipts when the mention doesn't start a new run", () => {
  const person = (id: string, mentioned: string[], extra: Partial<Message> = {}) =>
    ({ id, author: { type: "person", id: "u" }, mentionedAgentIds: mentioned, ...extra }) as unknown as Message;
  // Loose on purpose: some events (agent.run.steered) live in the client stream union, not ChannelEvent.
  const ev = (e: Record<string, unknown> & { type: string }) => ({ channelId: "c1", ...e }) as unknown as ChannelEvent;

  test("an agent the message only references: 'only mentioned', never 'will answer' nor 'nobody'", () => {
    // The sender's copy carries meta.referencedAgentIds: Atlas will answer, Ada is only referenced.
    let s = seedReceipt({}, person("m5", ["atlas", "ada"], { meta: { referencedAgentIds: ["ada"] } }));
    expect(s.m5?.agents).toEqual([
      ["atlas", "picked"],
      ["ada", "seen"],
    ]);
    s = applyReceiptEvent(
      s,
      ev({
        type: "message.routed",
        messageId: "m5",
        seenBy: ["atlas", "ada"],
        pickedBy: ["atlas"],
        runs: [{ agentId: "atlas", runId: "r5" }],
        referenced: ["ada"],
        strategy: "mention",
      }),
    );
    expect(receiptView(s.m5).status).toEqual({ kind: "picked", agents: ["atlas"] });
    expect(receiptView(s.m5).referenced).toEqual(["ada"]);
    s = applyReceiptEvent(
      s,
      ev({ type: "run.finished", runId: "r5", threadId: "m5", agentId: "atlas", status: "done" }),
    );
    expect(receiptView(s.m5)).toMatchObject({ status: { kind: "handled", agents: ["atlas"] }, done: true });
    // From the list API: referenced, nothing blocked.
    const listed = seedReceipt(
      {},
      person("m6", ["atlas", "ada"], {
        receipts: { seenBy: ["atlas", "ada"], pickedBy: [], handled: [], blocked: [], referenced: ["ada", "atlas"] },
      }),
    );
    // Everyone only referenced: the decision is final, nobody answers.
    expect(receiptView(listed.m6).status).toEqual({ kind: "nobody" });
  });

  test("a mention steered into the agent's task: never 'nobody'; picked from the list receipts", () => {
    // The old list receipts (no run of its own, nothing blocked): seen only, not "nobody".
    const old = seedReceipt(
      {},
      person("m2", ["theo"], { receipts: { seenBy: ["theo"], pickedBy: [], handled: [], blocked: [] } }),
    );
    expect(receiptView(old.m2).status).toBeNull();
    // Today's: the steered run is the one answering it.
    const s = seedReceipt(
      {},
      person("m2", ["theo"], {
        receipts: {
          seenBy: ["theo"],
          pickedBy: ["theo"],
          handled: [{ agentId: "theo", runId: "r1", status: "running" }],
          blocked: [],
        },
      }),
    );
    expect(receiptView(s.m2).status).toEqual({ kind: "claimed", agents: ["theo"] });
  });

  test("live: agent.run.steered marks the agent on the message; the run's end settles it", () => {
    let s = seedReceipt({}, person("m2", ["theo"]));
    s = applyReceiptEvent(s, ev({ type: "agent.run.steered", runId: "r1", agentId: "theo", messageId: "m2" }));
    expect(receiptView(s.m2).status).toEqual({ kind: "claimed", agents: ["theo"] });
    // A late "nobody picked it" decision without `blocked` doesn't hide a mention.
    s = applyReceiptEvent(s, ev({ type: "message.routed", messageId: "m2", seenBy: ["theo"], pickedBy: [] }));
    expect(receiptView(s.m2).status?.kind).not.toBe("nobody");
    s = applyReceiptEvent(
      s,
      ev({ type: "run.finished", threadId: "m1", runId: "r1", agentId: "theo", status: "done" }),
    );
    expect(receiptView(s.m2)).toMatchObject({ status: { kind: "handled", agents: ["theo"] }, done: true });
  });

  test("a reply that answers the agent's question: message.routed with its run picks the agent", () => {
    let s = seedReceipt({}, person("m3", []));
    s = applyReceiptEvent(
      s,
      ev({
        type: "message.routed",
        messageId: "m3",
        seenBy: ["theo"],
        pickedBy: ["theo"],
        runs: [{ agentId: "theo", runId: "r1" }],
        strategy: "mention",
      }),
    );
    expect(receiptView(s.m3).status).toEqual({ kind: "picked", agents: ["theo"] });
    s = applyReceiptEvent(s, ev({ type: "agent.typing", threadId: "root", runId: "r1", agentId: "theo" }));
    expect(receiptView(s.m3).status?.kind).toBe("claimed");
  });

  test("a mention the agent can't answer (blocked) says 'nobody'", () => {
    let s = seedReceipt({}, person("m4", ["theo"]));
    s = applyReceiptEvent(
      s,
      ev({ type: "message.routed", messageId: "m4", seenBy: ["theo"], pickedBy: [], blocked: ["theo"] }),
    );
    expect(receiptView(s.m4).status).toEqual({ kind: "nobody" });
  });

  test("a thread reply's run events land on the reply, not on the thread's root", () => {
    // Root m1 was answered by ada; the reply m2 mentions theo, whose run r2 has threadId = m1.
    let s = seedReceipt({}, person("m1", ["ada"]));
    s = applyReceiptEvent(s, ev({ type: "message.handled", messageId: "m1", agentId: "ada", runId: "r1" }));
    s = seedReceipt(s, person("m2", ["theo"], { threadId: "m1" }));
    s = applyReceiptEvent(
      s,
      ev({
        type: "message.routed",
        messageId: "m2",
        seenBy: ["theo"],
        pickedBy: ["theo"],
        runs: [{ agentId: "theo", runId: "r2" }],
      }),
    );
    s = applyReceiptEvent(s, ev({ type: "agent.thinking", threadId: "m1", runId: "r2", agentId: "theo" }));
    s = applyReceiptEvent(
      s,
      ev({ type: "agent.run", threadId: "m1", runId: "r2", agentId: "theo", status: "running" }),
    );
    expect(receiptView(s.m2).status).toEqual({ kind: "claimed", agents: ["theo"] });
    expect(s.m1?.agents.map(([id]) => id)).toEqual(["ada"]);
    const reply = {
      id: "m5",
      threadId: "m1",
      agentRunId: "r2",
      author: { type: "agent", id: "theo" },
      meta: {},
    } as unknown as Message;
    s = applyReceiptEvent(s, ev({ type: "message.created", messageId: "m5", message: reply }));
    expect(receiptView(s.m2).status).toEqual({ kind: "handled", agents: ["theo"] });
    expect(s.m1?.agents).toEqual([["ada", "handled"]]);
  });
});

describe("a run waiting for its computer", () => {
  const person = {
    id: "m1",
    channelId: "c1",
    threadId: null,
    author: { type: "person", id: "u1" },
    body: "@nova @rio oi",
    mentionedAgentIds: ["nova", "rio"],
    mentionedUserIds: [],
    agentRunId: null,
    meta: {},
    createdAt: "2026-11-02T10:00:00.000Z",
  } as unknown as Message;
  const handled = (agentId: string, runId: string, computer: "queued" | "away") =>
    ({
      type: "message.handled",
      channelId: "c1",
      messageId: "m1",
      agentId,
      runId,
      status: "waiting_input",
      computer,
    }) as ChannelEvent;

  test("in line for room or for the computer to come back: never 'waiting for your answer'", () => {
    let s = seedReceipt({}, person);
    s = applyReceiptEvent(s, handled("nova", "r1", "queued"));
    expect(receiptView(s.m1).status).toEqual({ kind: "queued", agents: ["nova"] });
    s = applyReceiptEvent(s, handled("rio", "r2", "away"));
    expect(receiptView(s.m1).status).toEqual({ kind: "away", agents: ["rio"] });
  });

  test("the list's receipts say the same", () => {
    const s = seedReceipt({}, {
      ...person,
      receipts: {
        seenBy: ["nova"],
        pickedBy: ["nova"],
        handled: [{ agentId: "nova", runId: "r1", status: "waiting_input", computer: "queued" }],
        blocked: [],
      },
    } as Message);
    expect(receiptView(s.m1).status).toEqual({ kind: "queued", agents: ["nova"] });
  });

  test("it got the computer while nobody listened: a list asked since brings its row back, an older one doesn't", () => {
    const where = { channelId: "c1", threadId: "m1", agentId: "nova", runId: "r1" };
    let s = applyChannelEvent(emptyStreams, { type: "agent.thinking", ...where } as unknown as ChannelEvent);
    s = applyChannelEvent(s, {
      type: "agent.run",
      ...where,
      status: "waiting_input",
      computer: "queued",
    } as unknown as ChannelEvent);
    expect(s.runs.r1).toBeUndefined();
    const active = [
      { ...where, status: "running", triggerMessageId: "m1", startedAt: null, heartbeatAt: null, background: false },
    ] as unknown as ActiveRun[];
    const heard = Date.now();
    expect(reconcileRuns(s, "c1", active, heard, heard - 1_000).runs.r1).toBeUndefined();
    expect(reconcileRuns(s, "c1", active, heard + 1_000, heard + 1_000).runs.r1?.status).toBe("thinking");
  });

  test("a read asked before anything else moved says where a run went while nobody listened", () => {
    const listed = (status: string, computer?: string) =>
      ({
        ...person,
        receipts: {
          seenBy: ["nova"],
          pickedBy: ["nova"],
          handled: [{ agentId: "nova", runId: "r1", status, ...(computer ? { computer } : {}) }],
          blocked: [],
        },
      }) as Message;
    const inLine = seedReceipts({}, [listed("waiting_input", "queued")]);
    expect(receiptView(inLine.m1).status).toEqual({ kind: "queued", agents: ["nova"] });
    // The same read with no `before` only ends runs; with it, the run working now reads as working.
    expect(receiptView(seedReceipts(inLine, [listed("running")]).m1).status?.kind).toBe("queued");
    expect(receiptView(seedReceipts(inLine, [listed("running")], inLine).m1).status?.kind).toBe("claimed");
  });

  test("still in line after ten minutes in a thread: the note it posts is no answer, its wait stays", () => {
    let s = applyReceiptEvent(seedReceipt({}, person), {
      type: "message.claimed",
      channelId: "c1",
      messageId: "m1",
      agentId: "nova",
      runId: "r1",
    } as unknown as ChannelEvent);
    const parked = {
      type: "agent.run",
      channelId: "c1",
      threadId: "t1",
      agentId: "nova",
      runId: "r1",
      status: "waiting_input",
      computer: "queued",
    } as unknown as ChannelEvent;
    s = applyReceiptEvent(s, parked);
    s = applyReceiptEvent(s, {
      type: "message.created",
      channelId: "c1",
      message: {
        id: "note",
        channelId: "c1",
        threadId: "t1",
        agentRunId: "r1",
        author: { type: "agent", id: "nova" },
        meta: { brainUnavailable: { code: "busy" } },
      },
    } as unknown as ChannelEvent);
    s = applyReceiptEvent(s, parked);
    expect(s.m1?.agents).toContainEqual(["nova", "queued"]);
  });

  test('a message that joins a run in line has no "pensando…" of its own, even on the optimistic id', () => {
    let s = expectReply(emptyStreams, { channelId: "c1", threadId: "local-1", agentId: "nova" });
    s = applyChannelEvent(s, {
      type: "agent.run.steered",
      channelId: "c1",
      runId: "r1",
      agentId: "nova",
      messageId: "m2",
      computer: "queued",
    } as unknown as ChannelEvent);
    expect(Object.values(s.runs)).toEqual([]);
  });

  test("a message that went into a run in line says so live, as a reload would", () => {
    let s = seedReceipt({}, person);
    s = applyReceiptEvent(s, {
      type: "agent.run.steered",
      channelId: "c1",
      runId: "r1",
      agentId: "nova",
      messageId: "m1",
      computer: "queued",
    } as unknown as ChannelEvent);
    expect(receiptView(s.m1).status).toEqual({ kind: "queued", agents: ["nova"] });
  });
});

describe("live memory cards", () => {
  const update = { action: "proposed", itemId: "i1", text: "Prefere respostas curtas", requestedByUserId: "u1" };
  const reply = {
    id: "a1",
    channelId: "c1",
    threadId: "m1",
    author: { type: "agent", id: "nova" },
    body: "Anotado.",
    mentionedAgentIds: [],
    mentionedUserIds: [],
    agentRunId: "r1",
    meta: { memoryUpdates: [update] },
    createdAt: "2026-11-02T10:00:00.000Z",
  } as unknown as Message;

  test("a big message's event comes without it: the card stays until the read that has the message", () => {
    const store = createStreamsStore();
    store.apply({
      type: "memory.updated",
      channelId: "c1",
      threadId: "m1",
      agentId: "nova",
      runId: "r1",
      update,
    } as ChannelEvent);
    // Another card of the same run, not on this message, stays.
    store.apply({
      type: "memory.updated",
      channelId: "c1",
      threadId: "m1",
      agentId: "nova",
      runId: "r1",
      update: { ...update, itemId: "i2" },
    } as ChannelEvent);
    store.apply({ type: "message.created", channelId: "c1", messageId: "a1" } as ChannelEvent);
    expect(store.get().memory.c1?.map((c) => c.key)).toEqual(["r1:i1", "r1:i2"]);
    store.seed([reply]);
    expect(store.get().memory.c1?.map((c) => c.key)).toEqual(["r1:i2"]);
    const memory = store.get().memory;
    store.seed([reply]);
    expect(store.get().memory).toBe(memory);
  });

  test("an event that carries the message drops its cards at once", () => {
    const store = createStreamsStore();
    store.apply({
      type: "memory.updated",
      channelId: "c1",
      threadId: "m1",
      agentId: "nova",
      runId: "r1",
      update,
    } as ChannelEvent);
    store.apply({ type: "message.created", channelId: "c1", messageId: "a1", message: reply } as ChannelEvent);
    expect(store.get().memory.c1).toEqual([]);
  });
});

describe("receipt ticks: clock, one, two", () => {
  const ev = (e: Record<string, unknown>) => e as unknown as ChannelEvent;
  const routed = (pickedBy: string[], seenBy = ["ada", "atlas"]) =>
    applyReceiptEvent({}, ev({ type: "message.routed", channelId: "c1", messageId: "m1", seenBy, pickedBy }));

  test("clock until an agent takes it; one tick while anyone it was for is on it; two once all of them acted", () => {
    expect(receiptTicks(undefined)).toBe("clock");
    expect(receiptTicks(applyReceiptEvent({}, ev({ type: "message.routing", messageId: "m1", step: "plan" })).m1)).toBe(
      "clock",
    );
    let s = routed(["ada", "atlas"]);
    // Picked, both still in line: nobody picked it up yet.
    expect(receiptTicks(s.m1)).toBe("clock");
    s = applyReceiptEvent(s, ev({ type: "message.claimed", messageId: "m1", agentId: "ada", runId: "r1" }));
    expect(receiptTicks(s.m1)).toBe("check");
    s = applyReceiptEvent(
      s,
      ev({ type: "message.handled", messageId: "m1", agentId: "ada", runId: "r1", status: "done" }),
    );
    // Ada answered, Atlas hasn't yet: still one.
    expect(receiptTicks(s.m1)).toBe("check");
    s = applyReceiptEvent(s, ev({ type: "message.claimed", messageId: "m1", agentId: "atlas", runId: "r2" }));
    s = applyReceiptEvent(
      s,
      ev({ type: "run.finished", ...base, runId: "r2", agentId: "atlas", status: "waiting_approval" }),
    );
    expect(receiptTicks(s.m1)).toBe("check");
    s = applyReceiptEvent(
      s,
      ev({ type: "message.handled", messageId: "m1", agentId: "atlas", runId: "r2", status: "done" }),
    );
    expect(receiptTicks(s.m1)).toBe("checks");
  });

  test("routed to nobody: everyone it reached decided not to answer, two ticks", () => {
    expect(receiptTicks(routed([]).m1)).toBe("checks");
  });

  test("a mention guessed before the server confirms is still the clock", () => {
    const s = seedReceipt({}, {
      id: "m1",
      channelId: "c1",
      threadId: null,
      author: { type: "person", id: "u1" },
      body: "@ada oi",
      mentionedAgentIds: ["ada"],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    expect(receiptTicks(s.m1)).toBe("clock");
  });
});
