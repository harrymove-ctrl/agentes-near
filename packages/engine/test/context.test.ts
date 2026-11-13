import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  type AgentRun,
  buildRunContext,
  CONTINUE_THE_CONVERSATION,
  createAgent,
  forComputerBrain,
  type HandOff,
  handOffsBlock,
  insertMessage,
  type Message,
  nowLine,
  openAgentDm,
  PLAIN_WORDS_LINE,
  postPersonMessage,
  toTurns,
} from "../src";
import { type Fixture, setup } from "./fixtures";

const msg = (over: Partial<Message>): Message =>
  ({ authorUserId: null, authorAgentId: null, body: "", ...over }) as Message;

test("nowLine: the person's local time with its zone and how long since the previous message", () => {
  const now = new Date("2026-10-21T10:40:00Z");
  expect(nowLine("America/Sao_Paulo", "Ana", new Date("2026-10-20T20:40:00Z"), now)).toBe(
    "# Now\nWed, Oct 21, 2026, 07:40 for Ana (America/Sao_Paulo); the previous message here was 14 h ago.",
  );
  // A bad zone falls back to UTC; no person (an agent asked) and nothing before.
  expect(nowLine("Mars/Olympus", null, null, now)).toBe("# Now\nWed, Oct 21, 2026, 10:40 (UTC).");
});

test("toTurns: own messages are assistant turns, others are prefixed user turns, merged and user-bounded", () => {
  const names = new Map([
    ["u1", "Ana"],
    ["a2", "QA (@qa)"],
  ]);
  const turns = toTurns(
    [
      msg({ authorAgentId: "me", body: "leading own message is dropped" }),
      msg({ authorUserId: "u1", body: "hi" }),
      msg({ authorAgentId: "a2", body: "hello" }),
      msg({ authorAgentId: "me", body: "answer" }),
      msg({ authorUserId: "u1", body: "thanks" }),
    ],
    "me",
    names,
  );
  expect(turns).toEqual([
    { role: "user", content: "[Ana]: hi\n\n[QA (@qa)]: hello" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "[Ana]: thanks" },
  ]);
});

test("toTurns: a routine's call reads as the routine's; an agent's message about its report keeps its author", () => {
  const names = new Map([
    ["u1", "Ana"],
    ["a2", "QA (@qa)"],
  ]);
  const routine = { routine: { id: "r", name: "Sentry", runId: "rr" } };
  const turns = toTurns(
    [
      msg({ authorType: "person", authorUserId: "u1", body: "Veja os erros novos.", meta: routine }),
      msg({ authorType: "agent", authorAgentId: "a2", body: "3 erros novos no checkout.", meta: routine }),
    ],
    "me",
    names,
  );
  expect(turns).toEqual([
    {
      role: "user",
      content: '[Routine "Sentry", created by Ana]: Veja os erros novos.\n\n[QA (@qa)]: 3 erros novos no checkout.',
    },
  ]);
});

test("toTurns: with older unanswered messages, the one being answered is marked current", () => {
  const names = new Map([["u1", "Ana"]]);
  const older = msg({ id: "m1", authorUserId: "u1", body: "alguém viu o deploy?" });
  const current = msg({ id: "m2", authorUserId: "u1", body: "@theo consegue criar um pdf?" });
  expect(toTurns([older, current], "me", names, current.id)).toEqual([
    { role: "user", content: "[Ana]: alguém viu o deploy?\n\n(current message) [Ana]: @theo consegue criar um pdf?" },
  ]);
  // Alone, it needs no mark.
  expect(toTurns([current], "me", names, current.id)).toEqual([
    { role: "user", content: "[Ana]: @theo consegue criar um pdf?" },
  ]);
});

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

test("system prompt carries org context, agent instructions and channel; history ends with the trigger", async () => {
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
  await post("earlier top-level message");
  const root = await post("root question");
  const trigger = await post("@dev what do you think?", root.id);
  const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  const run = runs[0];
  if (!run) throw new Error("no run");
  const ctx = await buildRunContext(f.db, run, f.agent, { maxMessages: 30 });
  expect(systemText(ctx.system)).toContain("Acme builds rockets.");
  expect(systemText(ctx.system)).toContain("Answer briefly.");
  expect(systemText(ctx.system)).toContain("#general");
  expect(systemText(ctx.system)).toContain("Dev (@dev, agent)");
  // A #name links the channel: agents may point people to one.
  expect(systemText(ctx.system)).toContain("write its name with # (#engineering): it shows as a link to it");
  // No tools: nothing to investigate with, so no "How you work".
  expect(systemText(ctx.system)).not.toContain("# How you work");
  const withTools = systemText(
    (await buildRunContext(f.db, run, f.agent, { maxMessages: 30, toolsAvailable: true, askUser: true })).system,
  );
  // Investigate first (ADR 0037): look before answering, reads need no ok, ask only for decisions.
  expect(withTools).toContain("# How you work");
  expect(withTools).toContain("Reading never needs anyone's ok.");
  expect(withTools).toContain("Never ask permission to look");
  expect(withTools).toContain("ambiguous after you have looked with your tools");
  // Lessons from the behavior eval (ADR 0037): whole files, no stopping halfway, recommend the fix,
  // take unowned work, only what tools returned, findings in the turn that asks or requests approval.
  expect(withTools).toContain("Read whole files, not just search snippets");
  expect(withTools).toContain("Choosing the fix is your job");
  expect(withTools).toContain("don't just say someone must take it");
  expect(withTools).toContain("when your searches find nothing, say so");
  expect(withTools).toContain("ask the one question that decides it");
  expect(withTools).toContain("it posts only the text of that same turn");
  // Eval 2026-10-23: an issue it opened on its own cut the data out of a product answer; a thanks
  // in a DM sent it to re-check the deploy.
  expect(withTools).toContain("when the person asked for an internal change");
  expect(withTools).toContain("A change you made on your own doesn't shorten the answer");
  expect(withTools).toContain("A thanks or an ok asks nothing");
  expect(withTools).not.toContain("Use your tools when they help");
  expect(ctx.messages).toEqual([
    {
      role: "user",
      content:
        "[ana]: earlier top-level message\n\n[ana]: root question\n\n(current message) [ana]: @dev what do you think?",
    },
  ]);
  expect(ctx.stats.historyMessages).toBe(3);
});

test("every brain reads that it carries one conversation on: no name up front, no status restated", async () => {
  const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev grava as metas de outubro e novembro",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, ask.id));
  if (!run) throw new Error("no run");
  for (const toolsAvailable of [false, true]) {
    const text = systemText((await buildRunContext(f.db, run, f.agent, { maxMessages: 10, toolsAvailable })).system);
    expect(text).toContain(CONTINUE_THE_CONVERSATION);
    // A computer brain (Claude Code, Codex) gets the same system text, with its own tools added.
    expect(forComputerBrain(text)).toContain(CONTINUE_THE_CONVERSATION);
    expect(text).toContain("- Keep it as short as the news: a report with nothing for the person to decide");
  }
  expect(CONTINUE_THE_CONVERSATION).toContain("Don't open with the person's name");
  expect(CONTINUE_THE_CONVERSATION).toContain("don't repeat what you or others already said here");
  expect(CONTINUE_THE_CONVERSATION).toContain("say only what changed");
});

test("every brain is told to say what it does in plain words, not the names of its tools", async () => {
  const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev entra no site do banco",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, ask.id));
  if (!run) throw new Error("no run");
  const text = systemText(
    (await buildRunContext(f.db, run, f.agent, { maxMessages: 10, toolsAvailable: true })).system,
  );
  expect(text).toContain(PLAIN_WORDS_LINE);
  expect(forComputerBrain(text)).toContain(PLAIN_WORDS_LINE);
  expect(PLAIN_WORDS_LINE).toContain("Never name your tools or functions");
  expect(PLAIN_WORDS_LINE).toContain("clearly technical");
  // The language line no longer tells it to keep tool names as they are.
  expect(text).not.toContain("Tool names, ids and code stay as they are");
});

test("a new top-level message reads the replies shown under earlier messages, not only the top level", async () => {
  const post = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  const earlier = await post("@dev clone the repo");
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: earlier.id,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "The clone hung.",
  });
  // That run answered: it ended (a new message in the channel would otherwise join it while it works).
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.triggerMessageId, earlier.id));
  const trigger = await post("@dev why did it hang?");
  const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  const ctx = await buildRunContext(f.db, runs[0] as NonNullable<(typeof runs)[0]>, f.agent, { maxMessages: 10 });
  expect(ctx.messages).toEqual([
    { role: "user", content: "[ana]: @dev clone the repo" },
    { role: "assistant", content: "The clone hung." },
    { role: "user", content: "[ana]: @dev why did it hang?" },
  ]);
});

test("history is capped at maxMessages, keeping the most recent", async () => {
  for (let i = 0; i < 5; i++) {
    await f.db.insert(schema.messages).values({
      // No id is an anchor (`historyStart`), so the cap alone decides what is kept: a random anchor at m4 would drop
      // m3, and one at m3 would hide a cap that kept older messages.
      id: `${crypto.randomUUID().slice(0, -6)}000001`,
      orgId: f.org.id,
      channelId: f.general.id,
      authorType: "person",
      authorUserId: f.owner.id,
      body: `m${i}`,
      createdAt: new Date(Date.now() - (10 - i) * 1000),
    });
  }
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev go",
  });
  const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  const ctx = await buildRunContext(f.db, runs[0] as NonNullable<(typeof runs)[0]>, f.agent, { maxMessages: 3 });
  expect(ctx.messages[0]?.content).toBe("[ana]: m3\n\n[ana]: m4\n\n(current message) [ana]: @dev go");
});

test("the hand-offs block: where each colleague is, an answer's start until it was heard, and no @ to copy", () => {
  const now = new Date("2026-10-31T17:00:00Z");
  const at = (hhmm: string) => new Date(`2026-10-31T${hhmm}:00Z`);
  const base: HandOff = {
    id: "h",
    kind: "note",
    status: "open",
    question: "Rita vai ser apagada. Passa ao @diogo a tua pasta e tudo o que sabes.",
    answer: null,
    handle: "rita",
    createdAt: at("16:58"),
    answeredAt: null,
    reportedAt: null,
    target: null,
  };
  const run = (status: AgentRun["status"], more = {}) => ({
    status,
    waitingMachineId: null,
    handedOn: false,
    ...more,
  });
  const open = handOffsBlock(
    [
      { ...base, target: run("running") },
      { ...base, target: run("queued") },
      { ...base, target: run("waiting_approval") },
      { ...base, target: run("waiting_input") },
      { ...base, target: run("waiting_input", { waitingMachineId: "m1" }) },
      { ...base, target: run("waiting_input", { outage: true }) },
      { ...base, target: run("done", { handedOn: true }) },
      { ...base, target: null },
      { ...base, kind: "question", question: "Como o staging sobe?", target: run("running") },
    ],
    "Europe/Lisbon",
    now,
  );
  expect(open?.split("\n")).toEqual([
    "# Work you handed off here",
    "What the agents you handed work to or asked from here are doing, as of this turn (Europe/Lisbon):",
    '- @rita, since 16:58 (2 min ago): working on it. You handed it: "Rita vai ser apagada. Passa ao diogo a tua pasta e tudo o que sabes."',
    '- @rita, since 16:58 (2 min ago): starting. You handed it: "Rita vai ser apagada. Passa ao diogo a tua pasta e tudo o que sabes."',
    '- @rita, since 16:58 (2 min ago): waiting for a person\'s approval. You handed it: "Rita vai ser apagada. Passa ao diogo a tua pasta e tudo o que sabes."',
    '- @rita, since 16:58 (2 min ago): waiting for a person\'s answer. You handed it: "Rita vai ser apagada. Passa ao diogo a tua pasta e tudo o que sabes."',
    '- @rita, since 16:58 (2 min ago): waiting for its computer to come back. You handed it: "Rita vai ser apagada. Passa ao diogo a tua pasta e tudo o que sabes."',
    '- @rita, since 16:58 (2 min ago): its AI provider isn\'t answering; it picks the work up again by itself. You handed it: "Rita vai ser apagada. Passa ao diogo a tua pasta e tudo o que sabes."',
    '- @rita, since 16:58 (2 min ago): did its part and waits for agents it handed some to. You handed it: "Rita vai ser apagada. Passa ao diogo a tua pasta e tudo o que sabes."',
    '- @rita, since 16:58 (2 min ago): not started: the agents reached what they may do on their own; a person can let it go on (Continuar). You handed it: "Rita vai ser apagada. Passa ao diogo a tua pasta e tudo o que sabes."',
    '- @rita, since 16:58 (2 min ago): working on it. You asked: "Como o staging sobe?"',
    "Each outcome reaches you here by itself, even after your turn ends; what you handed off in one turn comes back together. Until then don't check on it, send it again or do its part. If someone asks, say who has what and since when; never say a colleague hasn't answered or that nothing happened while its part is open.",
  ]);
  const long = `O staging sobe da branch main pelo deploy.sh, ${"com cada passo descrito ".repeat(10)}`;
  const closed = handOffsBlock(
    [
      { ...base, handle: "infra", createdAt: at("16:40"), status: "answered", answer: long, answeredAt: at("16:52") },
      { ...base, status: "answered", answer: "Feito.", answeredAt: at("16:59"), reportedAt: at("16:59") },
      { ...base, status: "failed", answer: "stopped by a person", answeredAt: at("16:59") },
      { ...base, status: "expired", answeredAt: at("16:59") },
    ],
    "Europe/Lisbon",
    now,
  );
  expect(closed?.split("\n").slice(2, -1)).toEqual([
    `- @infra, since 16:40: done at 16:52: "${long.replace(/\s+/g, " ").trim().slice(0, 140)}…"`,
    "- @rita, since 16:58: done at 16:59",
    "- @rita, since 16:58: couldn't finish at 16:59: stopped by a person",
    "- @rita, since 16:58: no answer by 16:59",
  ]);
  expect(handOffsBlock([], "UTC")).toBeNull();
});

test("the hand-offs block: only this agent's, from this conversation, the last day; never for a routine or between agents", async () => {
  const infra = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Infrastructure", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  /** A run of `agentId` in #general: on its own top-level message, or in `thread`. */
  const runIn = async (agentId: string, thread?: string) => {
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      ...(thread ? { threadId: thread } : {}),
      author: { type: "person", userId: f.owner.id },
      body: "pedido",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        threadRootId: thread ?? m.id,
        triggerMessageId: m.id,
        trigger: "mention",
        hop: 1,
        status: "done",
      })
      .returning();
    if (!run) throw new Error("no run");
    return run;
  };
  const handed = (
    asker: AgentRun,
    question: string,
    over: Partial<typeof schema.agentConsultations.$inferInsert> = {},
  ) =>
    f.db.insert(schema.agentConsultations).values({
      orgId: f.org.id,
      kind: "note",
      askerRunId: asker.id,
      askerAgentId: asker.agentId,
      targetAgentId: asker.agentId === infra.id ? f.agent.id : infra.id,
      channelId: f.general.id,
      messageId: Bun.randomUUIDv7(),
      waitId: `async:${Bun.randomUUIDv7()}`,
      question,
      chain: [asker.agentId],
      expiresAt: new Date(Date.now() + 60_000),
      ...over,
    });
  const earlier = await runIn(f.agent.id);
  const thread = await runIn(f.agent.id);
  const inThread = await runIn(f.agent.id, thread.triggerMessageId);
  await handed(earlier, "Here, still out");
  await handed(inThread, "In the thread");
  await handed(await runIn(infra.id), "Infra's own");
  await handed(earlier, "Closed two hours ago", {
    status: "answered",
    answer: "ok",
    answeredAt: new Date(Date.now() - 2 * 3_600_000),
  });
  await handed(earlier, "Two days old", { createdAt: new Date(Date.now() - 2 * 86_400_000) });

  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev e aí, como ficou?",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const block = async (options: { routine?: boolean } = {}) =>
    (await buildRunContext(f.db, run, f.agent, { maxMessages: 30, ...options })).system.find((b) =>
      b.text.startsWith("# Work you handed off here"),
    );
  const listed = await block();
  expect(listed).toMatchObject({ turn: true, found: true });
  expect(listed?.text).toContain('You handed it: "Here, still out"');
  for (const left of ["In the thread", "Infra's own", "Closed two hours ago", "Two days old"])
    expect(listed?.text).not.toContain(left);
  expect(await block({ routine: true })).toBeUndefined();
  // In the thread, its own.
  const threadCtx = await buildRunContext(f.db, inThread, f.agent, { maxMessages: 30 });
  expect(systemText(threadCtx.system)).toContain('You handed it: "In the thread"');
  expect(systemText(threadCtx.system)).not.toContain("Here, still out");
  // Between agents: none (that run answers one agent).
  const dm = await openAgentDm(f.db, f.org.id, f.agent.id, infra.id);
  const note = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: dm.id,
    author: { type: "agent", agentId: f.agent.id, runId: earlier.id, hop: 1 },
    body: "Confere o deploy.",
  });
  const [between] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: infra.id,
      channelId: dm.id,
      threadRootId: note.id,
      triggerMessageId: note.id,
      trigger: "dm",
      hop: 2,
    })
    .returning();
  if (!between) throw new Error("no run");
  await handed(between, "Infra hands on");
  expect(systemText((await buildRunContext(f.db, between, infra, { maxMessages: 30 })).system)).not.toContain(
    "# Work you handed off here",
  );
});

test("the person's app language is a line of the turn", async () => {
  await f.db.update(schema.users).set({ locale: "ja" }).where(eq(schema.users.id, f.owner.id));
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev hi",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const { system } = await buildRunContext(f.db, run, f.agent, { maxMessages: 10 });
  const line = system.find((b) => b.text.startsWith("The person's app language"));
  expect(line?.text).toBe("The person's app language: ja, Japanese. Still reply in the language they write in.");
  expect((line as { turn?: boolean } | undefined)?.turn).toBe(true);
});
