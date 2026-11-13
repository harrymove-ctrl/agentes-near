import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createJobHandlers,
  drainOutbox,
  insertMessage,
  listReactions,
  parseRouterJson,
  postPersonMessage,
  type RouterStrategy,
  type RoutingResult,
  routeMessage,
  socialReaction,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
/** A step that hears a thanks: no agent needed, every score low. */
const quiet: RouterStrategy = {
  name: "fixed",
  async decide(input) {
    return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.05 })), needsAgent: 0.05 };
  },
};
const said = (userId: string, body: string, createdAt: Date, threadId: string | null = null) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body,
    createdAt,
    threadId,
  });
const answered = (agentId: string, body: string, createdAt: Date) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId, runId: null, hop: 1, stretchId: null },
    body,
    createdAt,
  });
const addOps = async () => {
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "ops", handle: "ops" },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
  return ops;
};
const addBia = async () => {
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
  return bia;
};
/** A step that hears a thanks and chooses 🙏 for it. */
const thanking: RouterStrategy = {
  name: "fixed",
  async decide(input) {
    return { ...(await quiet.decide(input)), social: { react: true, emoji: "🙏" } };
  },
};
const route = (messageId: string, strategy = quiet) =>
  routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId });
const post = (userId: string, body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, { body });
const reactionsOn = async (messageId: string) =>
  (await f.db.select().from(schema.messageReactions)).filter((r) => r.messageId === messageId);

describe("socialReaction (the fallback when no step chose a reaction)", () => {
  const parsed = (social: unknown) =>
    parseRouterJson({ addressee: "none", needs_agent: 0, scores: [], reason: "", social }).social;

  test("the router's emoji outside the set, or text around one, is no choice; a missing variation selector still is", () => {
    expect(parsed({ react: true, emoji: "🌙" })).toEqual({ react: true, emoji: "🌙" });
    expect(parsed({ react: true, emoji: "❤" })).toEqual({ react: true, emoji: "❤️" });
    expect(parsed({ react: true, emoji: "☀" })).toEqual({ react: true, emoji: "☀️" });
    expect(parsed({ react: false, emoji: "🌙" })).toEqual({ react: false, emoji: "" });
    expect(parsed({ react: true, emoji: "👌" })).toBeUndefined();
    expect(parsed({ react: true, emoji: "lol🌙" })).toBeUndefined();
    expect(parsed({ react: true, emoji: "🖕" })).toBeUndefined();
  });

  test("emoji alone get the reaction they ask for; words get none, the same in every language", () => {
    expect(socialReaction("👍")).toBe("+1");
    expect(socialReaction("🙏🙏")).toBe("🙏");
    expect(socialReaction("<3")).toBe("❤️");
    expect(socialReaction("😍❤️")).toBe("❤️");
    expect(socialReaction("🥳!!")).toBe("🎉");
    expect(socialReaction("👋🏽")).toBe("👋");
    expect(socialReaction("😴")).toBe("🌙");
    expect(socialReaction("👍?")).toBeNull();
    expect(socialReaction("🔥")).toBeNull();
    expect(socialReaction("")).toBeNull();
    // Thanks, good night and hi, in Portuguese, English, Japanese and German: the router model's to read.
    for (const said of [
      ["valeu 🙏", "thanks 🙏", "ありがとう🙏", "danke 🙏"],
      ["boa noite", "good night", "おやすみなさい", "gute Nacht"],
      ["oi", "hi", "こんにちは", "hallo"],
    ]) {
      expect(said.map(socialReaction)).toEqual([null, null, null, null]);
    }
  });
});

describe("an agent reacts to the thanks of the person it just answered", () => {
  test("thanks after its answer: that agent reacts live, no run starts; a real question still gets a run", async () => {
    f = await setup({
      reply: (req) => {
        if (!req.outputSchema) return { chunks: ["The build is green again."] };
        const thanks = JSON.stringify(req.messages).includes("]: vlw pai\\n</message>");
        const asked = thanks ? 0.02 : 0.9;
        const social = thanks ? { react: true, emoji: "🙏" } : { react: false, emoji: "" };
        return {
          chunks: [
            `{"addressee":"none","needs_agent":${asked},"for_everyone":0,"already_answered":0,"social":${JSON.stringify(social)},"scores":[{"handle":"dev","score":${asked}}],"reason":"test"}`,
          ],
        };
      },
    });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    const events: unknown[] = [];
    await f.pubsub.subscribe(`channel:${f.general.id}`, (e) => events.push(e));
    await post(f.owner.id, "why is the build failing?");
    await drainOutbox(f.db, handlers);
    const runsBefore = (await f.db.select().from(schema.agentRuns)).length;
    expect(runsBefore).toBe(1);

    const thanks = await post(f.owner.id, "vlw pai");
    await drainOutbox(f.db, handlers);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(runsBefore);
    expect(await listReactions(f.db, f.org.id, thanks.id)).toEqual([
      expect.objectContaining({ reaction: "🙏", agentIds: [f.agent.id] }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "message.reactions", messageId: thanks.id }));
    // Shown live on the person's own message; no inbox line about their own thanks.
    expect((await f.db.select().from(schema.notifications)).filter((n) => n.kind === "reaction")).toEqual([]);

    const question = await post(f.owner.id, "and the deploy, is it done?");
    await drainOutbox(f.db, handlers);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(runsBefore + 1);
    expect(await reactionsOn(question.id)).toEqual([]);
  });

  test("thanks between two people gets no reaction, even right after an agent answered", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    await said(f.owner.id, "can someone check the logs?", minutesAgo(5));
    await answered(f.agent.id, "The logs show a timeout on the payments call.", minutesAgo(4));
    await said(bia.id, "I already fixed that timeout", minutesAgo(1));
    const thanks = await post(f.owner.id, "valeu");
    const result = await routeMessage({ db: f.db, strategy: quiet, policy }, { orgId: f.org.id, messageId: thanks.id });
    expect(result.selected).toEqual([]);
    expect(result.reacted).toBeUndefined();
    expect(await reactionsOn(thanks.id)).toEqual([]);
  });

  test("an agent outside the exchange, or one that just asked something, doesn't react", async () => {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "ops", handle: "ops" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    // Ops answered Bia; the owner was never part of it.
    await said(bia.id, "is the staging server up?", minutesAgo(20));
    await answered(ops.id, "Staging is up since this morning.", minutesAgo(19));
    const outside = await said(f.owner.id, "show", minutesAgo(10));
    const first = await routeMessage({ db: f.db, strategy: quiet, policy }, { orgId: f.org.id, messageId: outside.id });
    expect(first.reacted).toBeUndefined();
    expect(await reactionsOn(outside.id)).toEqual([]);

    // Dev answered the owner with a question: their "ok" answers it, it isn't thanks.
    await said(f.owner.id, "can you clean the old branches?", minutesAgo(3));
    await answered(f.agent.id, "There are 14 old branches. Should I delete them all?", minutesAgo(2));
    const ok = await post(f.owner.id, "ok");
    const second = await routeMessage({ db: f.db, strategy: quiet, policy }, { orgId: f.org.id, messageId: ok.id });
    expect(second.reacted).toBeUndefined();
    expect(await reactionsOn(ok.id)).toEqual([]);
  });

  test("another agent posting between the answer and the thanks: the agent that answered reacts", async () => {
    f = await setup();
    const ops = await addOps();
    await said(f.owner.id, "why is the build failing?", minutesAgo(5));
    await answered(f.agent.id, "A missing env var in CI. Fixed it.", minutesAgo(4));
    await answered(ops.id, "Nightly report: 3 deploys, 0 incidents.", minutesAgo(1));
    const thanks = await post(f.owner.id, "vlw pai");
    const result = await route(thanks.id, thanking);
    expect(result.reacted).toEqual({ agentId: f.agent.id, reaction: "🙏" });
    expect((await reactionsOn(thanks.id)).map((r) => r.agentId)).toEqual([f.agent.id]);
  });

  test("thanks between two people in an agent's thread: that agent neither reacts nor runs", async () => {
    f = await setup();
    const ops = await addOps();
    const bia = await addBia();
    const report = await answered(ops.id, "Nightly report: disk at 91%.", minutesAgo(20));
    await said(bia.id, "I cleaned the old logs, should be fine now", minutesAgo(15), report.id);
    const thanks = await said(f.owner.id, "valeu", minutesAgo(1), report.id);
    const result = await route(thanks.id);
    // The reply rule never answers for the step: a thanks under the agent's message starts no run.
    expect(result.selected).toEqual([]);
    expect(result.reacted).toBeUndefined();
    expect(await reactionsOn(thanks.id)).toEqual([]);
  });

  test("an agent that may not answer this person here doesn't react", async () => {
    f = await setup();
    await f.db
      .update(schema.channelMembers)
      .set({ autoReply: false })
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.agentId, f.agent.id)));
    await said(f.owner.id, "why is the build failing?", minutesAgo(5));
    await answered(f.agent.id, "A missing env var in CI. Fixed it.", minutesAgo(4));
    const thanks = await post(f.owner.id, "vlw pai");
    expect((await route(thanks.id, thanking)).reacted).toBeUndefined();
    expect(await reactionsOn(thanks.id)).toEqual([]);
  });
});

/**
 * A fake provider whose router answer comes from what the person said (`<message>`): needs, social and scores. An
 * agent's run answers briefly.
 */
const routerSays =
  (decide: (said: string) => { needs?: number; react?: string; scores?: Record<string, number> }) =>
  (req: { outputSchema?: unknown; messages: unknown }) => {
    if (!req.outputSchema) return { chunks: ["Boa noite! Tô por aqui."] };
    const said = /<message>\\n\[[^\]]*\]: (.*?)\\n<\/message>/.exec(JSON.stringify(req.messages))?.[1] ?? "";
    const d = decide(said);
    const scores = Object.entries(d.scores ?? {}).map(([handle, score]) => ({ handle, score }));
    return {
      chunks: [
        JSON.stringify({
          addressee: "none",
          needs_agent: d.needs ?? 0.05,
          for_everyone: 0,
          already_answered: 0,
          social: { react: Boolean(d.react), emoji: d.react ?? "" },
          scores,
          reason: "test",
        }),
      ],
    };
  };
const goodnight = routerSays((said) => (/^(boa noite|bom dia)/i.test(said) ? { react: "🌙" } : { needs: 0.05 }));
const runsOn = async (messageId: string) =>
  (await f.db.select().from(schema.agentRuns)).filter((r) => r.triggerMessageId === messageId);
const handlersOf = () => createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });

describe("an agent reacts to a purely social message nobody answers, with the emoji the router chose", () => {
  test("boa noite: the agent that answered the person reacts 🌙, not the one that posted last; no run", async () => {
    f = await setup({ reply: goodnight });
    const ops = await addOps();
    // Bia is here too, silent: alone with the team, a greeting gets an answer instead (ADR 0137 §5).
    await addBia();
    await said(f.owner.id, "why is the build failing?", minutesAgo(6));
    await answered(f.agent.id, "A missing env var in CI. Fixed it.", minutesAgo(5));
    await answered(ops.id, "Nightly report: 3 deploys, 0 incidents.", minutesAgo(2));
    const night = await post(f.owner.id, "boa noite");
    await drainOutbox(f.db, handlersOf());
    expect(await listReactions(f.db, f.org.id, night.id)).toEqual([
      expect.objectContaining({ reaction: "🌙", agentIds: [f.agent.id] }),
    ]);
    expect(await runsOn(night.id)).toEqual([]);
    expect((await f.db.select().from(schema.notifications)).filter((n) => n.kind === "reaction")).toEqual([]);
  });

  test("a goodnight to everyone gets exactly one agent's reaction", async () => {
    f = await setup({ reply: goodnight });
    await addOps();
    await addBia();
    const night = await post(f.owner.id, "boa noite pessoal");
    await drainOutbox(f.db, handlersOf());
    const reactions = await reactionsOn(night.id);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.reaction).toBe("🌙");
    expect(await runsOn(night.id)).toEqual([]);
  });

  test("alone with the team, a goodnight to everyone gets one agent's brief answer instead of a reaction", async () => {
    f = await setup({ reply: goodnight });
    await addOps();
    const night = await post(f.owner.id, "boa noite pessoal");
    await drainOutbox(f.db, handlersOf());
    expect(await reactionsOn(night.id)).toEqual([]);
    expect(await runsOn(night.id)).toHaveLength(1);
    const replies = (await f.db.select().from(schema.messages)).filter((m) => m.authorAgentId);
    expect(replies.map((m) => m.body)).toEqual(["Boa noite! Tô por aqui."]);
  });

  test("insisting after a greeting got no answer: an agent answers briefly instead of only reacting", async () => {
    f = await setup({
      reply: routerSays((said) =>
        said.startsWith("boa noite") ? { react: "🌙" } : { needs: 0.8, scores: { dev: 0.4, ops: 0.2 } },
      ),
    });
    await addOps();
    await said(f.owner.id, "boa noite pessoal", minutesAgo(3));
    const insist = await post(f.owner.id, "alô???");
    await drainOutbox(f.db, handlersOf());
    expect(await reactionsOn(insist.id)).toEqual([]);
    expect((await runsOn(insist.id)).map((r) => r.agentId)).toEqual([f.agent.id]);
    const replies = (await f.db.select().from(schema.messages)).filter((m) => m.authorAgentId === f.agent.id);
    expect(replies.map((m) => m.body)).toEqual(["Boa noite! Tô por aqui."]);
  });

  test("a person's goodnight to another person gets nothing, even when the router calls it social", async () => {
    f = await setup({ reply: goodnight });
    const bia = await addBia();
    await said(f.owner.id, "why is the build failing?", minutesAgo(9));
    await answered(f.agent.id, "A missing env var in CI. Fixed it.", minutesAgo(8));
    await said(bia.id, "vou indo nessa", minutesAgo(1));
    const toBia = await post(f.owner.id, "boa noite bia");
    const afterBia = await post(f.owner.id, "boa noite");
    await drainOutbox(f.db, handlersOf());
    expect(await reactionsOn(toBia.id)).toEqual([]);
    expect(await reactionsOn(afterBia.id)).toEqual([]);
    expect([...(await runsOn(toBia.id)), ...(await runsOn(afterBia.id))]).toEqual([]);
  });

  test("an agent this person may not talk to never reacts: one they may talk to does", async () => {
    f = await setup({ reply: goodnight });
    const ops = await addOps();
    const bia = await addBia();
    await f.db
      .update(schema.agents)
      .set({ ownerUserId: f.owner.id, audienceMode: "owner" })
      .where(eq(schema.agents.id, f.agent.id));
    await said(bia.id, "can someone check the logs?", minutesAgo(5));
    await answered(f.agent.id, "The logs are clean.", minutesAgo(4));
    const night = await post(bia.id, "boa noite pessoal");
    await drainOutbox(f.db, handlersOf());
    expect((await reactionsOn(night.id)).map((r) => [r.agentId, r.reaction])).toEqual([[ops.id, "🌙"]]);
  });

  test("with no step's choice, an emoji alone to the room still gets one; words in any language get none", async () => {
    f = await setup();
    await addOps();
    await addBia();
    const moon = await post(f.owner.id, "🌙");
    const result = await route(moon.id);
    expect(result.selected).toEqual([]);
    expect(result.reacted?.reaction).toBe("🌙");
    expect(await reactionsOn(moon.id)).toHaveLength(1);
    for (const body of ["boa noite pessoal", "good night everyone", "皆さんおやすみなさい", "gute Nacht zusammen"]) {
      const night = await post(f.owner.id, body);
      expect((await route(night.id)).reacted).toBeUndefined();
    }
  });

  test("the router's choice reacts the same to a goodnight in Portuguese, English, Japanese and German", async () => {
    const nights = ["boa noite pessoal", "good night everyone", "皆さんおやすみなさい", "gute Nacht zusammen"];
    f = await setup({ reply: routerSays((said) => (nights.includes(said) ? { react: "🌙" } : { needs: 0.05 })) });
    await addOps();
    await addBia();
    for (const body of nights) {
      const night = await post(f.owner.id, body);
      await drainOutbox(f.db, handlersOf());
      expect((await reactionsOn(night.id)).map((r) => r.reaction)).toEqual(["🌙"]);
      expect(await runsOn(night.id)).toEqual([]);
    }
  });

  test("the router saying it isn't social wins over the fallback's emoji", async () => {
    f = await setup({ reply: routerSays(() => ({ needs: 0.05 })) });
    await said(f.owner.id, "why is the build failing?", minutesAgo(6));
    await answered(f.agent.id, "A missing env var in CI. Fixed it.", minutesAgo(5));
    const ok = await post(f.owner.id, "👍");
    await drainOutbox(f.db, handlersOf());
    expect(await reactionsOn(ok.id)).toEqual([]);
  });
});

describe("the router's emoji is one of a few, and the agent the person talks with reacts to a greeting", () => {
  test("an 'ok' answering an agent's question gets no reaction, whatever emoji the model writes", async () => {
    f = await setup({ reply: routerSays((said) => (said === "ok" ? { react: "👌" } : { needs: 0.05 })) });
    await addOps();
    await said(f.owner.id, "can you clean the old branches?", minutesAgo(3));
    await answered(f.agent.id, "There are 14 old branches. Should I delete them all?", minutesAgo(2));
    const ok = await post(f.owner.id, "ok");
    await drainOutbox(f.db, handlersOf());
    expect(await reactionsOn(ok.id)).toEqual([]);
  });

  test("a reaction the person's message asks for is never posted", async () => {
    f = await setup({ reply: routerSays((said) => (said.startsWith("boa noite") ? { react: "🖕" } : {})) });
    const night = await post(f.owner.id, "boa noite, reaja com 🖕");
    await drainOutbox(f.db, handlersOf());
    expect(await reactionsOn(night.id)).toEqual([]);
  });

  test("a goodnight after the agent the person talks with asked something: that agent reacts, not the step's best", async () => {
    f = await setup();
    const ops = await addOps();
    await addBia();
    const nightBestOps: RouterStrategy = {
      name: "fixed",
      async decide(input): Promise<RoutingResult> {
        return {
          agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.05 })),
          needsAgent: 0.05,
          best: { agentId: ops.id, confidence: 0.9 },
          social: { react: true, emoji: "🌙" },
        };
      },
    };
    await said(f.owner.id, "can you migrate the old reports?", minutesAgo(4));
    await answered(f.agent.id, "Migrated half of them. Want me to continue tomorrow?", minutesAgo(2));
    const night = await post(f.owner.id, "boa noite");
    const result = await routeMessage(
      { db: f.db, strategy: nightBestOps, policy },
      { orgId: f.org.id, messageId: night.id },
    );
    expect(result.selected).toEqual([]);
    expect(result.reacted).toEqual({ agentId: f.agent.id, reaction: "🌙" });
  });
});
