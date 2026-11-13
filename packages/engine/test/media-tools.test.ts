import { afterEach, describe, expect, test } from "bun:test";
import { createFakeGifs, type GifProvider, GifProviderError } from "@agenteschat/adapters";
import { asc, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  createAgent,
  type createFakeJudge,
  createJobHandlers,
  drainOutbox,
  enqueue,
  findGif,
  gifSearchOf,
  insertMessage,
  MEDIA_PER_RUN_MAX,
  openAgentDm,
  openDm,
  postPersonMessage,
  type RoutineBrief,
  type RunAuthority,
  type ToolContext,
} from "../src";
import { AGENT_MEDIA_JOB, maybeSendAgentMedia, replySkip } from "../src/agent-media";
import { REFUSALS, toolKind, toolPolicy } from "../src/tools/run-policy";
import { type Fixture, setup } from "./fixtures";

// The agent's own GIF and sticker tools (ADR 0091, addendum 2026-10-31): listed only where they can send, posted
// as part of the answer, refused to a routine, three per run, and the step after a reply stays out of their run.

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** The model: on the person's message it makes `calls`; after their results it writes `then` (empty: nothing). */
const script =
  (calls: { name: string; input: Record<string, unknown> }[], then = "") =>
  (req: ModelRequest) =>
    lastText(req).includes("tool_result") ? { chunks: then ? [then] : [] } : { chunks: [], toolUses: calls };

/** The fake judge's answers to the step after a reply only (every other judgment keeps its default). */
function jev(answers: { fits?: number; mood?: string }) {
  return (kind: string, id: string) => {
    if (kind !== "agent_media") return undefined;
    if (id === "fits") return answers.fits ?? 0;
    return id === "mood" ? answers.mood : undefined;
  };
}

/** The workspace's switches (ADR 0091 §5), written as an admin's change would leave them. */
const settings = (patch: Partial<typeof schema.organizationSettings.$inferInsert>) =>
  f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, ...patch })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: patch });

const agentSwitch = (on: boolean) =>
  f.db.update(schema.agents).set({ mediaReplies: on }).where(eq(schema.agents.id, f.agent.id));

/** ana asks in #general, and every job it brings runs. */
async function ask(body: string) {
  const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  await drainOutbox(f.db, f.handlers);
  return asked;
}

/** The agents' messages, oldest first. */
const agentMessages = async () =>
  (await f.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt))).filter(
    (m) => m.authorType === "agent",
  );

/** The tool results the model read in its last call. */
function toolResults() {
  const content = f.provider.calls.at(-1)?.request.messages.at(-1)?.content;
  return Array.isArray(content) ? content.flatMap((b) => (b.type === "tool_result" ? [b] : [])) : [];
}

const mediaJudgments = () =>
  (f.context.judge as ReturnType<typeof createFakeJudge>).calls.filter((c) => c.kind === "agent_media");

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

/** Dev's run over `trigger` (no job runs it), and the tool context its calls get. */
async function runFor(trigger: { id: string; channelId: string; hop: number }, background = false) {
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: trigger.channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: trigger.hop + 1,
      background,
    })
    .returning();
  if (!run) throw new Error("no run");
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
    ...(background ? { background: true } : {}),
  };
  return { run, ctx };
}

/** A run of Dev that ana's message in `channelId` started. */
async function personRun(channelId = f.general.id) {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "Bom dia, Dev!",
  });
  return runFor(trigger);
}

const tools = () => {
  if (!f.tools) throw new Error("no tools");
  return f.tools;
};
/** The GIF and sticker tools a run lists. */
const mediaListed = async (ctx: ToolContext) =>
  (await tools().list(ctx)).map((t) => t.name).filter((name) => name === "send_gif" || name === "send_sticker");
const call = (ctx: ToolContext, name: string, input: Record<string, unknown>) =>
  tools().invoke(ctx, { toolUseId: `tu_${name}_${crypto.randomUUID()}`, name, input });

describe("which runs list them", () => {
  test("both by default; the GIF needs the workspace's GIFs, the sticker its stickers; the level changes nothing", async () => {
    f = await setup({ mediaTools: true, gifs: createFakeGifs() });
    const { ctx } = await personRun();
    expect(await mediaListed(ctx)).toEqual(["send_gif", "send_sticker"]);
    await settings({ gifs: false });
    expect(await mediaListed(ctx)).toEqual(["send_sticker"]);
    await settings({ gifs: true, agentStickers: false });
    expect(await mediaListed(ctx)).toEqual(["send_gif"]);
    // How often agents send one on their own is the step after a reply's: at Nunca, asked, they still send one.
    await settings({ agentStickers: true, agentMedia: "never" });
    expect(await mediaListed(ctx)).toEqual(["send_gif", "send_sticker"]);
    // The agent's own switch takes both away.
    await agentSwitch(false);
    expect(await mediaListed(ctx)).toEqual([]);
  });

  test("no GIF search on the server: only the sticker, which says to send it when asked for a GIF", async () => {
    f = await setup({ mediaTools: true });
    const { ctx } = await personRun();
    expect(await mediaListed(ctx)).toEqual(["send_sticker"]);
    const sticker = (await tools().list(ctx)).find((t) => t.name === "send_sticker");
    expect(sticker?.scope).toBe("");
    expect(sticker?.description).toContain(
      "If someone asks for a GIF and you have no `send_gif` tool, GIFs are off here: send your sticker instead",
    );
    expect(sticker?.description).toContain("never say you can't send GIFs");
  });

  test("a GIF search with no key for now is none", async () => {
    const keyless: GifProvider = { ...createFakeGifs(), available: () => false };
    f = await setup({ mediaTools: true, gifs: keyless });
    expect(await mediaListed((await personRun()).ctx)).toEqual(["send_sticker"]);
  });

  test("only where people read: a chat channel or a DM with a person, never two agents' DM", async () => {
    f = await setup({ mediaTools: true, gifs: createFakeGifs() });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    expect(await mediaListed((await personRun(dm.id)).ctx)).toEqual(["send_gif", "send_sticker"]);
    const infra = await addInfra();
    const agentsDm = await openAgentDm(f.db, f.org.id, f.agent.id, infra.id);
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: agentsDm.id,
      author: { type: "agent", agentId: infra.id, runId: null, hop: 1, stretchId: null },
      body: "Dev, o deploy de ontem passou?",
    });
    expect(await mediaListed((await runFor(asked)).ctx)).toEqual([]);
  });
});

describe("send_sticker", () => {
  test("the wave is a mood like the others: listed for a hello or a goodbye, and sent", async () => {
    f = await setup({ mediaTools: true });
    const { ctx } = await personRun();
    const sticker = (await tools().list(ctx)).find((t) => t.name === "send_sticker");
    const mood = (sticker?.inputSchema.properties as { mood: { enum: string[]; description: string } } | undefined)
      ?.mood;
    expect(mood?.enum).toContain("wave");
    expect(mood?.description).toContain("wave (a hello or a goodbye)");
    expect(await call(ctx, "send_sticker", { mood: "wave" })).toMatchObject({
      type: "result",
      output: { data: { mediaSent: { kind: "sticker" } } },
    });
    const [sent] = await agentMessages();
    expect(sent?.meta.media).toEqual({ kind: "sticker", agentId: f.agent.id, mood: "wave" });
  });

  test("as the whole answer: a message of the run where it answers, no text, live, telling whoever asked, starting nothing", async () => {
    f = await setup({ mediaTools: true, reply: script([{ name: "send_sticker", input: { mood: "celebrate" } }]) });
    const events = f.listen(f.general.id);
    await ask("@dev bom dia! manda uma figurinha pra gente");
    expect(f.provider.calls[0]?.request.tools?.map((t) => t.name)).toContain("send_sticker");

    const [run, ...moreRuns] = await f.db.select().from(schema.agentRuns);
    expect(moreRuns).toEqual([]);
    // The sticker was the answer: the empty reply after it posted nothing (no "Done." either).
    expect(run).toMatchObject({ status: "done", replyMessageId: null });
    const [sticker, ...more] = await agentMessages();
    expect(more).toEqual([]);
    expect(sticker).toMatchObject({
      channelId: f.general.id,
      threadId: null,
      authorAgentId: f.agent.id,
      agentRunId: run?.id,
      hop: run?.hop,
      body: "",
      mentionedAgentIds: [],
      meta: { media: { kind: "sticker", agentId: f.agent.id, mood: "celebrate" }, mediaInRun: true },
    });
    // Part of the answer, not the step's silent one after a reply.
    expect(sticker?.meta.mediaAfter).toBeUndefined();
    expect(events.filter((e) => e.type === "message.created").map((e) => e.messageId)).toContain(sticker?.id);

    // Like any sticker alone it routes to nobody and gets no step after it; whoever asked hears of it.
    const outbox = await f.db.select().from(schema.outbox);
    const about = (kind: string) => outbox.filter((j) => j.kind === kind && j.payload.messageId === sticker?.id);
    expect(about("message.posted")).toEqual([]);
    expect(outbox.filter((j) => j.kind === AGENT_MEDIA_JOB)).toEqual([]);
    expect(about("notifications.message").map((j) => j.status)).toEqual(["done"]);
    const inbox = await f.db.select().from(schema.notifications);
    expect(inbox.find((n) => n.source.messageId === sticker?.id)).toMatchObject({
      userId: f.owner.id,
      kind: "agent_reply",
      latest: { media: "sticker" },
    });

    // The model read that it was sent, and what to do next.
    expect(toolResults().map((r) => r.content)).toEqual([
      "Sticker sent.\nIf you have nothing to add, end your turn with an empty reply.",
    ]);
  });

  test("with words after it: the reply posts as usual, and the step after a reply stays out of that run", async () => {
    f = await setup({
      mediaTools: true,
      reply: script([{ name: "send_sticker", input: { mood: "love" } }], "Bom dia, pessoal! ☀️"),
      judge: jev({ fits: 0.99, mood: "celebrate" }),
    });
    await ask("@dev bom dia!");
    const [run] = await f.db.select().from(schema.agentRuns);
    const [sticker, reply, ...more] = await agentMessages();
    expect(more).toEqual([]);
    expect(sticker?.meta.media).toEqual({ kind: "sticker", agentId: f.agent.id, mood: "love" });
    expect(reply).toMatchObject({ body: "Bom dia, pessoal! ☀️", agentRunId: run?.id });
    expect(run?.replyMessageId).toBe(reply?.id);

    // The light reply queued its step, which found the run's own sticker: no judgment, nothing more posted.
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, AGENT_MEDIA_JOB));
    expect(jobs.map((j) => [j.payload, j.status])).toEqual([[{ messageId: reply?.id }, "done"]]);
    expect(mediaJudgments()).toEqual([]);
    const step = await maybeSendAgentMedia(
      { db: f.db, pubsub: f.pubsub, judge: f.context.judge },
      { orgId: f.org.id, messageId: reply?.id ?? "" },
    );
    expect(step).toEqual({ skipped: "tool_media" });
    expect(await agentMessages()).toHaveLength(2);
  });
});

describe("send_gif", () => {
  test("a few English words at the workspace's rating; the GIF looked up again and kept without a URL; never its title to the model", async () => {
    const gifs = createFakeGifs();
    f = await setup({
      mediaTools: true,
      gifs,
      reply: script([{ name: "send_gif", input: { search: "  sunshine   morning " } }]),
    });
    await settings({ gifRating: "pg" });
    await ask("@dev manda um GIF de bom dia pra gente");

    expect(gifs.calls.search).toEqual([{ query: "sunshine morning", rating: "pg", lang: "en", limit: 8, offset: 0 }]);
    expect(gifs.calls.get).toEqual([{ id: "fakeMorning1", rating: "pg" }]);
    const [gif, ...more] = await agentMessages();
    expect(more).toEqual([]);
    expect(gif?.body).toBe("");
    expect(gif?.meta).toEqual({
      media: {
        kind: "gif",
        provider: "giphy",
        id: "fakeMorning1",
        title: "Good morning sunshine",
        width: 480,
        height: 270,
      },
      mediaInRun: true,
    });
    expect(JSON.stringify(gif?.meta)).not.toContain("http");
    const [result, ...others] = toolResults();
    expect(others).toEqual([]);
    expect(result?.content.startsWith("GIF sent.")).toBe(true);
    expect(result?.content).not.toContain("Good morning sunshine");
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ status: "done", replyMessageId: null });
  });

  test("a second GIF for the same search isn't the first again", async () => {
    f = await setup({ mediaTools: true, gifs: createFakeGifs() });
    const { ctx } = await personRun();
    for (let i = 0; i < 2; i++) {
      expect(await call(ctx, "send_gif", { search: "celebration" })).toMatchObject({
        type: "result",
        output: { data: { mediaSent: { kind: "gif" } } },
      });
    }
    const ids = (await agentMessages()).map((m) => (m.meta.media as { id?: string } | undefined)?.id);
    // Two GIFs for "celebration" at the default rating (any age): both, one each time.
    expect(ids.sort()).toEqual(["fakeCelebration1", "fakeCelebration2"]);
  });

  test("a GIF the provider no longer has gives way to the next; a search that fails says so and points to the sticker", async () => {
    const fake = createFakeGifs();
    const lost: GifProvider = {
      ...fake,
      get: async (id, rating) => (id === "fakeCelebration2" ? fake.get(id, rating) : null),
    };
    expect((await findGif(lost, { query: "celebration", rating: "g", seed: "any" }))?.id).toBe("fakeCelebration2");

    const down: GifProvider = {
      ...fake,
      search: async () => {
        throw new GifProviderError("GIPHY answered 503", 503);
      },
    };
    await expect(findGif(down, { query: "celebration", rating: "g", seed: "any" })).rejects.toThrow();
    f = await setup({ mediaTools: true, gifs: down });
    const { ctx } = await personRun();
    expect(await call(ctx, "send_gif", { search: "celebration" })).toMatchObject({
      type: "result",
      output: {
        isError: true,
        content: "GIF search isn't answering right now. Send your sticker with `send_sticker` instead, or just reply.",
      },
    });
    expect(await agentMessages()).toEqual([]);
  });

  test("the search is a few words: six at most, 50 characters at most", () => {
    expect(gifSearchOf("  good   morning\ncoffee cat  ")).toBe("good morning coffee cat");
    expect(gifSearchOf("one two three four five six seven eight")).toBe("one two three four five six");
    expect(gifSearchOf("a".repeat(80))).toHaveLength(50);
    expect(gifSearchOf(42)).toBe("");
  });
});

describe("limits", () => {
  test("three per run: past it the tool says stop and searches nothing; another run starts its own count", async () => {
    expect(MEDIA_PER_RUN_MAX).toBe(3);
    const gifs = createFakeGifs();
    f = await setup({ mediaTools: true, gifs });
    const { ctx } = await personRun();
    for (const mood of ["celebrate", "love", "deal"]) {
      expect(await call(ctx, "send_sticker", { mood })).toMatchObject({
        type: "result",
        output: { data: { mediaSent: { kind: "sticker" } } },
      });
    }
    const content = "You already sent 3 GIFs or stickers in this turn: stop and finish your reply.";
    const stop = { type: "result", output: { isError: true, content } };
    expect(await call(ctx, "send_sticker", { mood: "wow" })).toMatchObject(stop);
    expect(await call(ctx, "send_gif", { search: "celebration" })).toMatchObject(stop);
    expect(gifs.calls.search).toEqual([]);
    expect(await agentMessages()).toHaveLength(3);

    const next = await personRun();
    expect(await call(next.ctx, "send_sticker", { mood: "wow" })).toMatchObject({
      type: "result",
      output: { data: { mediaSent: { kind: "sticker" } } },
    });
  });

  test("a routine's background run lists neither, and a call is refused like a reaction", async () => {
    f = await setup({ mediaTools: true, gifs: createFakeGifs() });
    const brief: RoutineBrief = {
      routineId: "00000000-0000-4000-8000-000000000001",
      routineRunId: "00000000-0000-4000-8000-000000000002",
      name: "Pedidos do dia",
      creatorUserId: f.owner.id,
      deliverTo: { channelId: f.general.id, threadId: null },
      access: "act",
      report: "when_new",
      trigger: "schedule",
      dueAt: new Date().toISOString(),
    };
    const trigger = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "Check today's orders.",
      meta: { routineBrief: brief },
    });
    const { ctx } = await runFor(trigger, true);
    expect(await mediaListed(ctx)).toEqual([]);
    const refused = { type: "result", output: { isError: true, content: REFUSALS.routineMedia } };
    expect(await call(ctx, "send_sticker", { mood: "deal" })).toMatchObject(refused);
    expect(await call(ctx, "send_gif", { search: "done" })).toMatchObject(refused);
    expect(await agentMessages()).toEqual([]);

    // The table: they speak here, like `react`; work nobody asked for still may (a routine's report woke it).
    const routine: RunAuthority = { kind: "routine", personId: null, brief };
    const unattended: RunAuthority = { kind: "unattended", personId: null, reason: "routine_report" };
    for (const name of ["send_gif", "send_sticker"]) {
      const tool = { name, scope: "", connectionId: null };
      expect(toolKind(tool).kind).toBe("here");
      expect(toolPolicy(routine, tool)).toEqual({ action: "refuse", reason: REFUSALS.routineMedia });
      expect(toolPolicy(unattended, tool)).toEqual({ action: "allow" });
    }
  });
});

describe("the step after a reply", () => {
  test("skips a reply that is itself a GIF or a sticker", () => {
    const reply = {
      authorType: "agent" as const,
      authorAgentId: "agent-1",
      agentRunId: "run-1",
      body: "",
      mentionedAgentIds: [],
      deletedAt: null,
    };
    const media = { kind: "sticker", agentId: "agent-1", mood: "deal" };
    expect(replySkip({ ...reply, meta: { media } })).toBe("media_reply");
    // Its own silent one is no reply at all.
    expect(replySkip({ ...reply, meta: { media, mediaAfter: "message-1" } })).toBe("not_reply");
  });

  test("a tool's sticker whose message.posted is delivered anyway routes to nobody and queues no step", async () => {
    f = await setup({ mediaTools: true });
    const infra = await addInfra();
    const { ctx } = await personRun();
    const sent = await call(ctx, "send_sticker", { mood: "wow" });
    if (sent.type !== "result") throw new Error("expected a result");
    const { messageId } = (sent.output.data as { mediaSent: { messageId: string } }).mediaSent;
    // What the run's own message brought (the sticker's notification, ana's message) is done first.
    await drainOutbox(f.db, f.handlers);

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
    await enqueue(f.db, {
      orgId: f.org.id,
      kind: "message.posted",
      payload: { messageId },
      dedupeKey: `message.posted:${messageId}`,
    });
    await drainOutbox(f.db, handlers);
    expect(routed).toBe(0);
    expect((await f.db.select().from(schema.agentRuns)).map((r) => r.id)).toEqual([ctx.runId]);
    const decisions = await f.db.select().from(schema.routingDecisions);
    expect(decisions.filter((d) => d.messageId === messageId)).toEqual([]);
    expect(await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, AGENT_MEDIA_JOB))).toEqual([]);
  });
});

describe("a GIF in another channel (post_message's gif)", () => {
  /** `post_message` as the run lists it. */
  const postMessageOf = async (ctx: ToolContext) => (await tools().list(ctx)).find((t) => t.name === "post_message");
  const hasGif = async (ctx: ToolContext) =>
    "gif" in (((await postMessageOf(ctx))?.inputSchema.properties ?? {}) as object);
  /** ana asks Dev in their DM. */
  const dmRun = async () => personRun((await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id);
  /** What landed in #general. */
  const inGeneral = async () =>
    (await agentMessages()).filter((m) => m.channelId === f.general.id).map((m) => ({ body: m.body, meta: m.meta }));

  test("asked in a DM: the text and the GIF go to #general as one message, kept without a URL, never its title", async () => {
    const gifs = createFakeGifs();
    f = await setup({ mediaTools: true, chatTools: true, gifs });
    const { ctx } = await dmRun();
    expect(await hasGif(ctx)).toBe(true);
    expect((await postMessageOf(ctx))?.description).toContain("add one with `gif`");
    const sent = await call(ctx, "post_message", {
      channel: "#general",
      text: "Boa noite, pessoal!",
      gif: "  good   morning ",
    });
    const output = (sent as { output: { content: string; isError?: boolean } }).output;
    expect(output.isError).toBeFalsy();
    expect(output.content).toStartWith("Posted in #general with a GIF:");
    expect(output.content).not.toContain("Good morning sunshine");
    expect(gifs.calls.search.map((s) => s.query)).toEqual(["good morning"]);
    const [posted, ...more] = await inGeneral();
    expect(more).toEqual([]);
    expect(posted?.body).toBe("Boa noite, pessoal!");
    expect(posted?.meta.media).toMatchObject({ kind: "gif", provider: "giphy", id: "fakeMorning1" });
    expect(JSON.stringify(posted?.meta)).not.toContain("http");
  });

  test("a GIF alone posts too; GIFs off: not offered, and a call posts nothing", async () => {
    f = await setup({ mediaTools: true, chatTools: true, gifs: createFakeGifs() });
    const { ctx } = await dmRun();
    expect(await call(ctx, "post_message", { channel: "general", gif: "celebration" })).toMatchObject({
      type: "result",
      output: { content: expect.stringContaining("Posted in #general with a GIF:") },
    });
    expect((await inGeneral()).map((m) => m.body)).toEqual([""]);

    await settings({ gifs: false });
    expect(await hasGif(ctx)).toBe(false);
    await settings({ gifs: true });
    await agentSwitch(false);
    expect(await hasGif(ctx)).toBe(false);
    // Called anyway (a listing from before the switch): the schema has no `gif`, so nothing goes.
    expect(await call(ctx, "post_message", { channel: "general", text: "Oi", gif: "hello" })).toMatchObject({
      type: "result",
      output: { isError: true },
    });
    expect(await inGeneral()).toHaveLength(1);
  });

  test("no GIF search on the server, or a search that fails: no gif, and nothing posted", async () => {
    f = await setup({ mediaTools: true, chatTools: true });
    expect(await hasGif((await dmRun()).ctx)).toBe(false);
    await f.close();

    const fake = createFakeGifs();
    const down: GifProvider = {
      ...fake,
      search: async () => {
        throw new GifProviderError("GIPHY answered 503", 503);
      },
    };
    f = await setup({ mediaTools: true, chatTools: true, gifs: down });
    const { ctx } = await dmRun();
    expect(await call(ctx, "post_message", { channel: "general", text: "Boa noite!", gif: "moon" })).toMatchObject({
      type: "result",
      output: {
        isError: true,
        content: "GIF search isn't answering right now: try again, or post without `gif`.",
      },
    });
    expect(await inGeneral()).toEqual([]);
  });
});
