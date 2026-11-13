import { afterEach, describe, expect, test } from "bun:test";
import type { Gif, GifProvider } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  createAgent,
  createFakeJudge,
  createJobHandlers,
  drainOutbox,
  enqueue,
  insertMessage,
  JevOffError,
  type Judge,
  type JudgeQuestion,
  notifyMessage,
  openDm,
  postPersonMessage,
  withJudgeFallback,
} from "../src";
import {
  AGENT_MEDIA_JOB,
  AGENT_MEDIA_THRESHOLDS,
  type AgentMediaDeps,
  agentMediaQuestions,
  maybeSendAgentMedia,
  pickGifIndex,
  replyTextSkip,
} from "../src/agent-media";
import { GIF_CATEGORIES, mediaOf } from "../src/media";
import { type Fixture, setup } from "./fixtures";

// An agent's sticker or GIF after its own reply (ADR 0091 §4): the rules in code, one calibrated judgment, a
// silent message of its own.

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A light reply: good news, short, nothing pending. */
const LIGHT = "Pronto, a versão nova já está no ar! 🚀";
const lightReply = () => ({ chunks: [LIGHT] });

/** The fake judge's answers to this judgment only (every other judgment keeps its default). */
function jev(answers: { fits?: number; mood?: string; gif?: string }) {
  return (kind: string, id: string) => {
    if (kind !== "agent_media") return undefined;
    if (id === "fits") return answers.fits ?? 0;
    return id === "mood" ? answers.mood : id === "gif" ? answers.gif : undefined;
  };
}

/** A person's request in #general (or another channel, or a thread), and every job it brings, run. */
async function ask(body = "@dev pode subir a versão nova?", where: { channelId?: string; threadId?: string } = {}) {
  const asked = await postPersonMessage(
    { db: f.db, pubsub: f.pubsub },
    f.owner.id,
    f.org.id,
    where.channelId ?? f.general.id,
    { body, threadId: where.threadId },
  );
  await drainOutbox(f.db, f.handlers);
  return asked;
}

/** The run that answered a message, and its reply. */
async function answerTo(messageId: string) {
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId));
  if (!run?.replyMessageId) throw new Error("no reply");
  const [reply] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, run.replyMessageId));
  if (!reply) throw new Error("no reply");
  return { run, reply };
}

/** Agents' stickers and GIFs after their replies, oldest first. */
const mediaMessages = async () =>
  (await f.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt))).filter(
    (m) => typeof m.meta.mediaAfter === "string",
  );

const mediaJudgments = () =>
  (f.context.judge as ReturnType<typeof createFakeJudge>).calls.filter((c) => c.kind === "agent_media");

const optionsOf = (q: JudgeQuestion | undefined) => Object.keys((q as { criteria: Record<string, string> }).criteria);

/** The workspace's switches (ADR 0091 §5), written as an admin's change would leave them. */
const settings = (patch: Partial<typeof schema.organizationSettings.$inferInsert>) =>
  f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, ...patch })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: patch });

const agentSwitch = (on: boolean) =>
  f.db.update(schema.agents).set({ mediaReplies: on }).where(eq(schema.agents.id, f.agent.id));

const judgeReply = (messageId: string, extra: Partial<AgentMediaDeps> = {}) =>
  maybeSendAgentMedia({ db: f.db, pubsub: f.pubsub, judge: f.context.judge, ...extra }, { orgId: f.org.id, messageId });

const byPerson = (body: string, threadId?: string) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: threadId ?? null,
    author: { type: "person", userId: f.owner.id },
    body,
  });

/** ana's GIF in #general: people send GIFs in this conversation. */
const personGif = () =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "",
    meta: { media: { kind: "gif", provider: "giphy", id: "party-1", title: "Party", width: 200, height: 150 } },
  });

/** An agent's sticker after one of its replies, as the step writes it (`minutesAgo`: written that long ago). */
const agentSticker = (agentId: string, at: { threadId?: string; minutesAgo?: number } = {}) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: at.threadId ?? null,
    author: { type: "agent", agentId, runId: null, hop: 1, stretchId: null },
    body: "",
    meta: { media: { kind: "sticker", agentId, mood: "deal" }, mediaAfter: crypto.randomUUID() },
    ...(at.minutesAgo ? { createdAt: new Date(Date.now() - at.minutesAgo * 60_000) } : {}),
  });

async function addInfra() {
  const infra = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Infra", handle: "infra", role: "Infrastructure", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: infra.id });
  return infra;
}

/**
 * A reply written by hand in #general: its trigger (ana's, or another agent's), Dev's run over it, and the
 * reply as that run's last word.
 */
async function handMade(
  body: string,
  options: {
    from?: string;
    background?: boolean;
    status?: "done" | "running";
    triggerMeta?: Record<string, unknown>;
    createdAt?: Date;
  } = {},
) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: options.from
      ? { type: "agent", agentId: options.from, runId: null, hop: 1, stretchId: null }
      : { type: "person", userId: f.owner.id },
    body: "Pode subir a versão nova",
    meta: options.triggerMeta,
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
      hop: trigger.hop + 1,
      status: options.status ?? "done",
      background: options.background ?? false,
    })
    .returning();
  if (!run) throw new Error("no run");
  const reply = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: run.hop },
    body,
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  });
  await f.db.update(schema.agentRuns).set({ replyMessageId: reply.id }).where(eq(schema.agentRuns.id, run.id));
  return { trigger, run, reply };
}

/** A GIF provider in memory: `count` results for any search, every search recorded. */
function fakeGifs(count: number) {
  const searches: Parameters<GifProvider["search"]>[0][] = [];
  const gifs: Gif[] = Array.from({ length: count }, (_, i) => ({
    id: `gif-${i}`,
    title: `Applause ${i}`,
    width: 480,
    height: 270 + i,
  }));
  const provider: GifProvider = {
    name: "fake",
    available: () => true,
    async search(input) {
      searches.push(input);
      return { gifs: gifs.slice(input.offset, input.offset + input.limit), next: null };
    },
    async trending() {
      return { gifs: [], next: null };
    },
    async get(id) {
      return gifs.find((g) => g.id === id) ?? null;
    },
    async media() {
      return null;
    },
  };
  return { provider, searches, gifs };
}

describe("after a light reply", () => {
  test("the agent's sticker follows it: an empty message of the reply's run, published, starting and notifying nobody", async () => {
    f = await setup({ reply: lightReply, judge: jev({ fits: 0.92, mood: "celebrate" }) });
    const events = f.listen(f.general.id);
    const asked = await ask();
    const { run, reply } = await answerTo(asked.id);
    expect(reply.body).toBe(LIGHT);

    const [media, ...more] = await mediaMessages();
    expect(more).toEqual([]);
    expect(media).toMatchObject({
      channelId: f.general.id,
      threadId: null,
      authorType: "agent",
      authorAgentId: f.agent.id,
      agentRunId: run.id,
      hop: run.hop,
      body: "",
      mentionedAgentIds: [],
      meta: { media: { kind: "sticker", agentId: f.agent.id, mood: "celebrate" }, mediaAfter: reply.id },
    });
    // Right after the reply, in the conversation and live.
    const order = await f.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.channelId, f.general.id))
      .orderBy(asc(schema.messages.createdAt));
    expect(order.map((m) => m.id)).toEqual([asked.id, reply.id, media?.id as string]);
    const created = events.filter((e) => e.type === "message.created").map((e) => e.messageId);
    expect(created.slice(-2)).toEqual([reply.id, media?.id]);

    // It starts no run and isn't judged again: one judgment, for the reply.
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, AGENT_MEDIA_JOB));
    expect(jobs.map((j) => [j.payload, j.status])).toEqual([[{ messageId: reply.id }, "done"]]);
    // Silent: nobody's inbox has it, and the reply's own notification isn't bumped by it.
    const inbox = await f.db.select().from(schema.notifications);
    expect(inbox.filter((n) => n.source.messageId === media?.id)).toEqual([]);
    expect(inbox.every((n) => n.count === 1)).toBe(true);
    await notifyMessage({ db: f.db, pubsub: f.pubsub }, f.org.id, media?.id ?? "");
    expect(await f.db.select().from(schema.notifications)).toEqual(inbox);

    // The judgment: one calibrated request for the agent's run, with the agent, the conversation and the reply.
    const [judgment, ...again] = mediaJudgments();
    expect(again).toEqual([]);
    expect(judgment).toMatchObject({ orgId: f.org.id, agentId: f.agent.id, runId: run.id, calibrated: true });
    expect(Object.keys(judgment?.questions ?? {})).toEqual(["fits", "mood"]);
    expect(optionsOf(judgment?.questions.mood)).toEqual(["deal", "celebrate", "love", "wow"]);
    expect(judgment?.state).toMatchObject({
      agent: { name: "Dev", role: "Developer" },
      conversation: [{ from: "ana", kind: "person", text: "@dev pode subir a versão nova?" }],
      reply: LIGHT,
    });
  });

  test("in a DM with a person, and in a thread: the sticker goes where the reply is", async () => {
    f = await setup({ reply: lightReply, judge: jev({ fits: 0.9, mood: "love" }) });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const inDm = await ask("valeu, Dev!", { channelId: dm.id });
    const root = await byPerson("Deploy de sexta");
    const inThread = await ask("@dev pode subir?", { threadId: root.id });
    const dmReply = (await answerTo(inDm.id)).reply;
    const threadReply = (await answerTo(inThread.id)).reply;
    expect((await mediaMessages()).map((m) => [m.channelId, m.threadId, m.meta.mediaAfter])).toEqual([
      [dm.id, null, dmReply.id],
      [f.general.id, root.id, threadReply.id],
    ]);
  });

  test("its own message.posted routes it to nobody, even where another agent could chime in", async () => {
    f = await setup();
    const infra = await addInfra();
    let routed = 0;
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: {
        enabled: true,
        model: "claude-haiku-5-5",
        strategy: {
          name: "eager",
          async decide() {
            routed++;
            return { agents: [{ agentId: infra.id, score: 1 }], needsAgent: 1 };
          },
        },
      },
    });
    const sticker = await agentSticker(f.agent.id);
    // Its insert queues no `message.posted`; one delivered anyway (an older insert, a redelivery) changes nothing.
    await enqueue(f.db, {
      orgId: f.org.id,
      kind: "message.posted",
      payload: { messageId: sticker.id },
      dedupeKey: `message.posted:${sticker.id}`,
    });
    await drainOutbox(f.db, handlers);
    expect(routed).toBe(0);
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
    expect(await f.db.select().from(schema.routingDecisions)).toEqual([]);
    expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, AGENT_MEDIA_JOB))).toEqual([]);
  });
});

describe("the workspace's level and switches", () => {
  async function stickersAt(level: "sometimes" | "often", fits: number) {
    f = await setup({ reply: lightReply, judge: jev({ fits, mood: "deal" }) });
    await settings({ agentMedia: level });
    await ask();
    return (await mediaMessages()).length;
  }

  test("the bars are 0.8 for sometimes and 0.6 for often", () => {
    expect(AGENT_MEDIA_THRESHOLDS).toEqual({ sometimes: 0.8, often: 0.6 });
  });

  test("Jev at 0.7 is under the bar of sometimes: nothing", async () => {
    expect(await stickersAt("sometimes", 0.7)).toBe(0);
  });

  test("Jev at 0.7 clears the bar of often: the sticker", async () => {
    expect(await stickersAt("often", 0.7)).toBe(1);
  });

  test("Jev under the default bar (sometimes): nothing", async () => {
    f = await setup({ reply: lightReply, judge: jev({ fits: 0.79, mood: "celebrate" }) });
    const asked = await ask();
    expect(await judgeReply((await answerTo(asked.id)).reply.id)).toEqual({ skipped: "unfit" });
    expect(await mediaMessages()).toEqual([]);
  });

  test("Jev isn't asked when the workspace says never, the agent's switch is off, or nothing could be sent", async () => {
    f = await setup({ reply: lightReply, judge: jev({ fits: 0.99, mood: "celebrate" }) });
    await settings({ agentMedia: "never" });
    const never = await ask("@dev sobe a versão 1?");
    expect(await judgeReply((await answerTo(never.id)).reply.id)).toEqual({ skipped: "off" });

    await settings({ agentMedia: "often" });
    await agentSwitch(false);
    const switchedOff = await ask("@dev sobe a versão 2?");
    expect(await judgeReply((await answerTo(switchedOff.id)).reply.id)).toEqual({ skipped: "agent_off" });

    // Stickers off, and no GIF can go: this server has no GIF search.
    await agentSwitch(true);
    await settings({ agentStickers: false });
    const nothing = await ask("@dev sobe a versão 3?");
    expect(await judgeReply((await answerTo(nothing.id)).reply.id)).toEqual({ skipped: "nothing_to_send" });
    expect(mediaJudgments()).toEqual([]);
    expect(await mediaMessages()).toEqual([]);

    // All on again: the same kind of reply gets its sticker.
    await settings({ agentStickers: true });
    await ask("@dev sobe a versão 4?");
    expect(mediaJudgments()).toHaveLength(1);
    expect(await mediaMessages()).toHaveLength(1);
  });
});

describe("who asked, and what the reply is", () => {
  test("only a person's own request: never a routine's background run, another agent's request or text on the way", async () => {
    f = await setup({ judge: jev({ fits: 0.95, mood: "celebrate" }) });
    const infra = await addInfra();
    const background = await handMade("Relatório pronto!", { background: true });
    expect(await judgeReply(background.reply.id)).toEqual({ skipped: "not_person" });
    const routine = await handMade("Relatório pronto!", { triggerMeta: { background: true } });
    expect(await judgeReply(routine.reply.id)).toEqual({ skipped: "not_person" });
    const fromAgent = await handMade("Feito, Infra!", { from: infra.id });
    expect(await judgeReply(fromAgent.reply.id)).toEqual({ skipped: "not_person" });
    const issue = await handMade("Feito!", { triggerMeta: { issueId: crypto.randomUUID() } });
    expect(await judgeReply(issue.reply.id)).toEqual({ skipped: "work" });
    const onTheWay = await handMade("Já começo!", { status: "running" });
    expect(await judgeReply(onTheWay.reply.id)).toEqual({ skipped: "not_final" });
    // A hand-off to another agent: the conversation goes on with it.
    const handOff = await handMade("@infra, segue com o deploy.");
    expect(handOff.reply.mentionedAgentIds).toEqual([infra.id]);
    expect(await judgeReply(handOff.reply.id)).toEqual({ skipped: "not_reply" });
    // The person's own message is never a reply to judge.
    expect(await judgeReply(handOff.trigger.id)).toEqual({ skipped: "not_reply" });
    expect(mediaJudgments()).toEqual([]);
    expect(await mediaMessages()).toEqual([]);
  });

  test("a long reply, code, a table, a chart or a question ends it before Jev", async () => {
    expect(replyTextSkip("Feito! 🎉")).toBeNull();
    expect(replyTextSkip("Feito: a migração terminou, 3 tabelas e nenhum erro.")).toBeNull();
    expect(replyTextSkip("x".repeat(601))).toBe("dense");
    expect(replyTextSkip("Rodei:\n```sh\nbun test\n```")).toBe("dense");
    expect(replyTextSkip("| plano | preço |\n| --- | --- |\n| Pro | 10 |")).toBe("dense");
    expect(replyTextSkip('```chart\n{"type":"bar","data":[1,2]}\n```')).toBe("dense");
    expect(replyTextSkip("Feito! Quer que eu suba em produção também?")).toBe("question");
    expect(replyTextSkip("Feito! Mais alguma coisa? 😊")).toBe("question");

    // Through the jobs: a reply with code is never even queued for a judgment.
    f = await setup({
      reply: () => ({ chunks: ["Rodei os testes:\n```\n12 passed\n```"] }),
      judge: jev({ fits: 0.99, mood: "celebrate" }),
    });
    const asked = await ask();
    expect(await judgeReply((await answerTo(asked.id)).reply.id)).toEqual({ skipped: "dense" });
    expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, AGENT_MEDIA_JOB))).toEqual([]);
    expect(mediaJudgments()).toEqual([]);
    expect(await mediaMessages()).toEqual([]);
  });
});

describe("spacing and freshness", () => {
  test("no agent's sticker among the conversation's last 8 messages", async () => {
    f = await setup({ judge: jev({ fits: 0.95, mood: "deal" }) });
    const infra = await addInfra();
    await agentSticker(infra.id);
    const close = await handMade("Feito! O botão novo já está no ar.");
    expect(await judgeReply(close.reply.id)).toEqual({ skipped: "recent_media" });
    // Eight messages later it no longer counts (and Infra's stickers never count against Dev's time).
    for (let i = 1; i <= 8; i++) await byPerson(`Linha ${i}`);
    const later = await handMade("Feito! O texto novo também.");
    expect(await judgeReply(later.reply.id)).toMatchObject({ sent: { kind: "sticker", mood: "deal" } });
  });

  test("none from this agent in the channel in the last 15 minutes, in any of its threads", async () => {
    f = await setup({ judge: jev({ fits: 0.95, mood: "deal" }) });
    const root = await byPerson("Planejamento da semana");
    const recent = await agentSticker(f.agent.id, { threadId: root.id, minutesAgo: 5 });
    const { reply } = await handMade("Feito! Já atualizei o quadro.");
    expect(await judgeReply(reply.id)).toEqual({ skipped: "agent_gap" });
    await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, recent.id));
    await agentSticker(f.agent.id, { threadId: root.id, minutesAgo: 20 });
    expect(await judgeReply(reply.id)).toMatchObject({ sent: { kind: "sticker" } });
  });

  test("something newer, before Jev or while it answers, takes the moment; a late judgment sends nothing", async () => {
    f = await setup({ judge: jev({ fits: 0.95, mood: "deal" }) });
    const first = await handMade("Feito! Já subi a correção.");
    await byPerson("Valeu! E o outro bug?");
    expect(await judgeReply(first.reply.id)).toEqual({ skipped: "newer" });

    // Someone writes while Jev answers: checked again under the conversation's lock, right before posting.
    const second = await handMade("Feito! O outro também.");
    const answers = createFakeJudge(jev({ fits: 0.95, mood: "deal" }));
    const racing: Judge = {
      name: "racing",
      async ask(request) {
        await byPerson("Perfeito, obrigado!");
        return answers.ask(request);
      },
    };
    expect(await judgeReply(second.reply.id, { judge: racing })).toEqual({ skipped: "newer" });

    const old = await handMade("Feito!", { createdAt: new Date(Date.now() - 3 * 60_000) });
    expect(await judgeReply(old.reply.id)).toEqual({ skipped: "late" });
    expect(await mediaMessages()).toEqual([]);
  });
});

describe("GIFs", () => {
  test("only where people send GIFs: the category's query at the workspace's rating, the pick fixed by the reply", async () => {
    const gifs = fakeGifs(6);
    f = await setup({
      reply: lightReply,
      judge: jev({ fits: 0.9, mood: "celebrate", gif: "applause" }),
      gifs: gifs.provider,
    });
    await settings({ gifRating: "pg" });
    await personGif();
    const asked = await ask();
    const { reply } = await answerTo(asked.id);

    expect(gifs.searches).toEqual([{ query: GIF_CATEGORIES.applause, rating: "pg", lang: "en", limit: 8, offset: 0 }]);
    const picked = gifs.gifs[pickGifIndex(reply.id, 5)];
    if (!picked) throw new Error("no such fake GIF");
    expect((await mediaMessages()).map((m) => mediaOf(m.meta))).toEqual([
      { kind: "gif", provider: "giphy", id: picked.id, title: picked.title, width: 480, height: picked.height },
    ]);
    const [judgment] = mediaJudgments();
    expect(Object.keys(judgment?.questions ?? {})).toEqual(["fits", "mood", "gif"]);
    expect(optionsOf(judgment?.questions.gif)).toEqual([
      "ok",
      "thanks",
      "celebrate",
      "applause",
      "wow",
      "good_morning",
      "bye",
    ]);
    // ana's GIF is in what Jev read, as "a GIF", without its title.
    expect(JSON.stringify(judgment?.state)).not.toContain("Party");
    expect(judgment?.state.conversation).toEqual([
      { from: "ana", kind: "person", text: "", sent: "a GIF" },
      { from: "ana", kind: "person", text: "@dev pode subir a versão nova?" },
    ]);
  });

  test("a GIF search with no key for now is none: the sticker, even where people send GIFs", async () => {
    const gifs = fakeGifs(6);
    f = await setup({
      reply: lightReply,
      judge: jev({ fits: 0.9, mood: "love", gif: "thanks" }),
      gifs: { ...gifs.provider, available: () => false },
    });
    await personGif();
    await ask();
    expect(gifs.searches).toEqual([]);
    expect((await mediaMessages()).map((m) => mediaOf(m.meta))).toEqual([
      { kind: "sticker", agentId: f.agent.id, mood: "love" },
    ]);
    expect(Object.keys(mediaJudgments()[0]?.questions ?? {})).toEqual(["fits", "mood"]);
  });

  test("where nobody sends GIFs, the agent's sticker: the GIF question isn't even asked", async () => {
    const gifs = fakeGifs(6);
    f = await setup({ reply: lightReply, judge: jev({ fits: 0.9, mood: "love", gif: "thanks" }), gifs: gifs.provider });
    await ask();
    expect(gifs.searches).toEqual([]);
    expect((await mediaMessages()).map((m) => mediaOf(m.meta))).toEqual([
      { kind: "sticker", agentId: f.agent.id, mood: "love" },
    ]);
    expect(Object.keys(mediaJudgments()[0]?.questions ?? {})).toEqual(["fits", "mood"]);
  });

  async function noGifFound(stickers: boolean) {
    const gifs = fakeGifs(0);
    f = await setup({
      reply: lightReply,
      judge: jev({ fits: 0.9, mood: "celebrate", gif: "celebrate" }),
      gifs: gifs.provider,
    });
    await settings({ agentStickers: stickers });
    await personGif();
    await ask();
    expect(gifs.searches).toHaveLength(1);
    return (await mediaMessages()).map((m) => mediaOf(m.meta));
  }

  test("a search that finds nothing falls back to the sticker", async () => {
    expect(await noGifFound(true)).toEqual([{ kind: "sticker", agentId: f.agent.id, mood: "celebrate" }]);
  });

  test("a search that finds nothing, with the stickers off: nothing", async () => {
    expect(await noGifFound(false)).toEqual([]);
  });

  test("a reply's pick is fixed and among the first five", () => {
    for (const id of ["a", "0192b7e2-9c1f-7e10-8f00-000000000001", crypto.randomUUID()]) {
      const i = pickGifIndex(id, 5);
      expect(pickGifIndex(id, 5)).toBe(i);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(5);
    }
    expect(pickGifIndex("a", 1)).toBe(0);
  });
});

describe("the judgment", () => {
  test("in a fixed order, the plainest option first; reversed only for the eval", () => {
    const fixed = agentMediaQuestions({ gif: true });
    expect(Object.keys(fixed)).toEqual(["fits", "mood", "gif"]);
    expect(fixed.fits).toMatchObject({ type: "noul" });
    expect(optionsOf(fixed.mood)).toEqual(["deal", "celebrate", "love", "wow"]);
    expect(optionsOf(fixed.gif)?.[0]).toBe("ok");
    expect(optionsOf(agentMediaQuestions({ gif: true, reversed: true }).mood)).toEqual([
      "wow",
      "love",
      "celebrate",
      "deal",
    ]);
    expect(Object.keys(agentMediaQuestions({ gif: false }))).toEqual(["fits", "mood"]);
  });

  test("Jev fails, hangs or has no key: nothing is sent, quietly, and the job still succeeds", async () => {
    f = await setup({
      reply: lightReply,
      judge: (kind) => {
        if (kind === "agent_media") throw new Error("Jev is down");
        return undefined;
      },
    });
    const asked = await ask();
    const { reply } = await answerTo(asked.id);
    expect(await mediaMessages()).toEqual([]);
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, AGENT_MEDIA_JOB));
    expect(jobs.map((j) => [j.payload, j.status])).toEqual([[{ messageId: reply.id }, "done"]]);
    expect(await judgeReply(reply.id)).toEqual({ skipped: "judge_failed" });

    const hung: Judge = { name: "hung", ask: () => new Promise(() => {}) };
    expect(await judgeReply(reply.id, { judge: hung, judgeTimeoutMs: 10 })).toEqual({ skipped: "judge_failed" });

    // No Jev key: the request is calibrated, so the workspace's own model is never asked instead.
    let fallbackAsked = false;
    const noKey = withJudgeFallback(
      {
        name: "jev",
        async ask() {
          throw new JevOffError();
        },
      },
      {
        name: "llm",
        async ask() {
          fallbackAsked = true;
          return { fits: { noul: 1 }, mood: { choice: "celebrate", probabilities: { celebrate: 1 } } };
        },
      },
      () => false,
    );
    expect(await judgeReply(reply.id, { judge: noKey })).toEqual({ skipped: "judge_failed" });
    expect(fallbackAsked).toBe(false);
    expect(await judgeReply(reply.id, { judge: null })).toEqual({ skipped: "no_judge" });

    // A mood that isn't one of the agent's: nothing either.
    const odd = createFakeJudge(jev({ fits: 0.95, mood: "dizzy" }));
    expect(await judgeReply(reply.id, { judge: odd })).toEqual({ skipped: "no_choice" });
    expect(await mediaMessages()).toEqual([]);
  });
});
