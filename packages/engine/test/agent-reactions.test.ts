import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addAgentReaction,
  addReaction,
  createAgent,
  createChannel,
  drainOutbox,
  ForbiddenError,
  grantScopes,
  insertMessage,
  listMessageReactions,
  listMessages,
  listReactions,
  NEW_AGENT_DEFAULTS,
  normalizeReaction,
  postPersonMessage,
  removeReaction,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** "valeu" gets a 🙌 and nothing else; anything else gets a normal answer. */
const reply = (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) return { chunks: [] };
  if (last.includes("valeu")) return { chunks: [], toolUses: [{ name: "react", input: { emoji: "🙌" } }] };
  if (last.includes("joinha")) return { chunks: [], toolUses: [{ name: "react", input: { emoji: "👎" } }] };
  return { chunks: ["Os builds rodam no GitHub Actions."] };
};

const post = (body: string, extra: { replyTo?: string; threadId?: string } = {}) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, ...extra });

const agentMessages = async () => (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
const feedbackJobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "context.feedback"));

describe("react (reaction instead of reply)", () => {
  test("the agent reacts to a thanks and posts no message; the reaction lists the agent", async () => {
    f = await setup({ react: true, reply });
    const events = f.listen(f.general.id);
    const thanks = await post("@dev valeu");
    await drainOutbox(f.db, f.handlers);

    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    expect(run?.replyMessageId).toBeNull();
    expect(await agentMessages()).toEqual([]);

    expect(await listReactions(f.db, f.org.id, thanks.id)).toEqual([
      { reaction: "🙌", count: 1, userIds: [], agentIds: [f.agent.id] },
    ]);
    const listed = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(listed.find((m) => m.id === thanks.id)?.reactions).toEqual([
      { reaction: "🙌", count: 1, userIds: [], agentIds: [f.agent.id] },
    ]);
    await Bun.sleep(5);
    expect(events.find((e) => e.type === "message.reactions")).toMatchObject({
      messageId: thanks.id,
      reactions: [{ reaction: "🙌", agentIds: [f.agent.id] }],
    });
    expect(await feedbackJobs()).toEqual([]);
  });

  test("the tool is built in (no scope) and the prompt says when to react instead of replying", async () => {
    f = await setup({ react: true, reply });
    await post("@dev onde rodam os builds?");
    await drainOutbox(f.db, f.handlers);
    const request = f.provider.calls[0]?.request as ModelRequest;
    expect(request.tools?.map((t) => t.name)).toContain("react");
    expect(systemText(request.system)).toContain("react with one fitting emoji using `react`");
    expect(systemText(request.system)).toContain("Never react and also reply");
    expect((await agentMessages()).map((m) => m.body)).toEqual(["Os builds rodam no GitHub Actions."]);
  });

  test("an agent's 👍/👎 is stored as +1/-1 but never becomes feedback; a person's does", async () => {
    f = await setup({ react: true, reply });
    await post("@dev onde rodam os builds?");
    await drainOutbox(f.db, f.handlers);
    const [answer] = await agentMessages();
    if (!answer) throw new Error("no answer");

    await addAgentReaction(f.db, { orgId: f.org.id, agentId: f.agent.id, messageId: answer.id, reaction: "-1" });
    expect(await feedbackJobs()).toEqual([]);
    await addReaction(f.db, f.owner.id, f.org.id, answer.id, "-1");
    expect(await feedbackJobs()).toHaveLength(1);
    expect(await listReactions(f.db, f.org.id, answer.id)).toEqual([
      { reaction: "-1", count: 2, userIds: [f.owner.id], agentIds: [f.agent.id] },
    ]);
    // Twice by the same agent is one reaction.
    await addAgentReaction(f.db, { orgId: f.org.id, agentId: f.agent.id, messageId: answer.id, reaction: "-1" });
    expect((await listReactions(f.db, f.org.id, answer.id))[0]?.count).toBe(2);

    expect(normalizeReaction("👍")).toBe("+1");
    expect(normalizeReaction("👎")).toBe("-1");
    expect(normalizeReaction(" 🎉 ")).toBe("🎉");
  });

  test("a reply that also reacted counts only its other tools: alone, the apps show no tools under it", async () => {
    const gh = fakeGithub();
    // Reacts, and on "PR" also reads it; then answers anyway.
    const both = (req: ModelRequest) => {
      const last = lastText(req);
      if (last.includes("tool_result")) return { chunks: ["Os builds rodam no GitHub Actions."] };
      const pr = last.includes("PR") ? [{ name: "github_get_pr", input: { repo: "acme/app", pr: 42 } }] : [];
      return { chunks: [], toolUses: [{ name: "react", input: { emoji: "🙌" } }, ...pr] };
    };
    f = await setup({ react: true, reply: both, toolSources: [gh.source] });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    await post("@dev valeu, e onde rodam os builds?");
    await drainOutbox(f.db, f.handlers);
    await post("@dev valeu, e o PR 42?");
    await drainOutbox(f.db, f.handlers);

    const replies = (await agentMessages()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(replies.map((m) => (m.meta as { work?: { steps: number } } | null)?.work?.steps)).toEqual([0, 1]);
    expect(gh.executed.map((e) => e.tool)).toEqual(["github_get_pr"]);
  });

  test("the react tool turns 👎 into -1 without a feedback job", async () => {
    f = await setup({ react: true, reply });
    const msg = await post("@dev joinha");
    await drainOutbox(f.db, f.handlers);
    expect(await agentMessages()).toEqual([]);
    expect(await listReactions(f.db, f.org.id, msg.id)).toEqual([
      { reaction: "-1", count: 1, userIds: [], agentIds: [f.agent.id] },
    ]);
    expect(await feedbackJobs()).toEqual([]);
  });

  test("a reaction is by a person or by an agent, never both or neither", async () => {
    f = await setup();
    const m = await post("bom dia");
    const r = schema.messageReactions;
    // Drizzle builders are thenables, not promises: `rejects` needs a real promise.
    const insert = async (values: typeof r.$inferInsert) => {
      await f.db.insert(r).values(values);
    };
    await expect(insert({ orgId: f.org.id, messageId: m.id, reaction: "🎉" })).rejects.toThrow();
    await expect(
      insert({ orgId: f.org.id, messageId: m.id, userId: f.owner.id, agentId: f.agent.id, reaction: "🎉" }),
    ).rejects.toThrow();
    await f.db.insert(r).values({ orgId: f.org.id, messageId: m.id, userId: f.owner.id, reaction: "🎉" });
    await f.db.insert(r).values({ orgId: f.org.id, messageId: m.id, agentId: f.agent.id, reaction: "🎉" });
    const rows = await f.db
      .select()
      .from(r)
      .where(and(eq(r.orgId, f.org.id), eq(r.messageId, m.id)));
    expect(rows).toHaveLength(2);
  });
});

describe("react to someone else's message (`to`)", () => {
  /** "reaja ao Caio" reacts with 👍 `to` whoever follows "ao", then says so in words, as models do. */
  const askedTo = (req: ModelRequest) => {
    const last = lastText(req);
    if (last.includes("tool_result")) return { chunks: ["Reagi com 👍 à mensagem do Caio."] };
    // The latest ask: the turn's text also carries the earlier ones.
    const to = [...last.matchAll(/reaja ao (\S+?)["\\]/g)].at(-1)?.[1];
    if (to) return { chunks: [], toolUses: [{ name: "react", input: { emoji: "👍", to } }] };
    return { chunks: [], toolUses: [{ name: "react", input: { emoji: "🙌" } }] };
  };
  const toolResult = () =>
    f.provider.calls.map((c) => lastText(c.request as ModelRequest)).find((t) => t.includes("tool_result")) ?? "";
  const byAgent = (agentId: string, body: string, threadId: string | null = null) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId,
      author: { type: "agent", agentId, runId: null, hop: 1, stretchId: null },
      body,
    });
  const caio = () => createAgent(f.db, f.owner.id, f.org.id, { name: "Caio", handle: "caio" }, NEW_AGENT_DEFAULTS);

  test("reacts to the named agent's latest message, not the request, says which, and posts no text", async () => {
    f = await setup({ react: true, reply: askedTo });
    const p = await caio();
    await byAgent(p.id, "Primeiro rascunho");
    const latest = await byAgent(p.id, "Fechei o relatório de vendas de outubro com os números finais");
    const ask = await post("@dev reaja ao @Caio");
    await drainOutbox(f.db, f.handlers);

    // 👍 is stored as "+1".
    expect(await listReactions(f.db, f.org.id, latest.id)).toEqual([
      { reaction: "+1", count: 1, userIds: [], agentIds: [f.agent.id] },
    ]);
    expect(await listReactions(f.db, f.org.id, ask.id)).toEqual([]);
    expect(toolResult()).toContain('Reacted 👍 to Caio (@caio): \\"Fechei o relatório de vendas de outubro');
    expect((await agentMessages()).filter((m) => m.authorAgentId === f.agent.id)).toEqual([]);
  });

  test("in a thread, the author's latest message in that thread, even when the channel has a newer one", async () => {
    f = await setup({ react: true, reply: askedTo });
    const p = await caio();
    const root = await post("Plano da semana");
    const inThread = await byAgent(p.id, "Topo, sigo com o plano", root.id);
    const outside = await byAgent(p.id, "Outra coisa no canal");
    await post("@dev reaja ao caio", { threadId: root.id });
    await drainOutbox(f.db, f.handlers);

    expect((await listReactions(f.db, f.org.id, inThread.id)).map((r) => r.reaction)).toEqual(["+1"]);
    expect(await listReactions(f.db, f.org.id, outside.id)).toEqual([]);
  });

  test("a person by first name; nobody by that name reacts to nothing and says so", async () => {
    f = await setup({ react: true, reply: askedTo });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Lima");
    const theirs = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: bia.id },
      body: "Subi a versão nova",
    });
    await post("@dev reaja ao Bia");
    await drainOutbox(f.db, f.handlers);
    expect((await listReactions(f.db, f.org.id, theirs.id)).map((r) => r.reaction)).toEqual(["+1"]);
    expect(toolResult()).toContain('to Bia Lima: \\"Subi a versão nova\\"');

    const before = f.provider.calls.length;
    const ask = await post("@dev reaja ao Ninguém");
    await drainOutbox(f.db, f.handlers);
    expect(await listReactions(f.db, f.org.id, ask.id)).toEqual([]);
    const result = f.provider.calls
      .slice(before)
      .map((c) => lastText(c.request as ModelRequest))
      .find((t) => t.includes("tool_result"));
    expect(result).toContain("No message from Ninguém in this conversation: nothing was reacted to.");
  });

  test("`quote` picks an older message of that author; words nobody wrote react to nothing", async () => {
    const quoting = (req: ModelRequest) => {
      const last = lastText(req);
      if (last.includes("tool_result")) return { chunks: [""] };
      const q = [...last.matchAll(/reaja ao bom (\S+?)["\\]/g)].at(-1)?.[1];
      return q
        ? { chunks: [], toolUses: [{ name: "react", input: { emoji: "👍", to: "@caio", quote: `Bom ${q}` } }] }
        : { chunks: [], toolUses: [{ name: "react", input: { emoji: "🙌" } }] };
    };
    f = await setup({ react: true, reply: quoting });
    const p = await caio();
    const morning = await byAgent(p.id, "Bom dia, pessoal! ☀️ Bom dia a todos.");
    const relay = await byAgent(p.id, "@dev a Ana pediu para reagirem à minha mensagem");
    await post("@dev reaja ao bom dia");
    await drainOutbox(f.db, f.handlers);
    expect((await listReactions(f.db, f.org.id, morning.id)).map((r) => r.reaction)).toEqual(["+1"]);
    expect(await listReactions(f.db, f.org.id, relay.id)).toEqual([]);
    expect(toolResult()).toContain('Caio (@caio): \\"Bom dia, pessoal!');

    const before = f.provider.calls.length;
    await post("@dev reaja ao bom almoço");
    await drainOutbox(f.db, f.handlers);
    const result = f.provider.calls
      .slice(before)
      .map((c) => lastText(c.request as ModelRequest))
      .find((t) => t.includes("tool_result"));
    expect(result).toContain("nothing was reacted to");
  });

  test("without `to`, the result names the message being answered", async () => {
    f = await setup({ react: true, reply: askedTo });
    await post("@dev valeu pela ajuda");
    await drainOutbox(f.db, f.handlers);
    expect(toolResult()).toContain("Reacted 🙌 to the message you are answering,");
    expect(toolResult()).toContain("valeu pela ajuda");
  });

  test("a first name two authors share reacts to nothing and lists them; a handle picks one", async () => {
    f = await setup({ react: true, reply: askedTo });
    const lima = await addMember(f.db, f.org.id, "member", "Bia Lima");
    const souza = await addMember(f.db, f.org.id, "member", "Bia Souza");
    const byPerson = (userId: string, body: string) =>
      insertMessage(f.db, { orgId: f.org.id, channelId: f.general.id, author: { type: "person", userId }, body });
    const limas = await byPerson(lima.id, "Subi a versão nova");
    const souzas = await byPerson(souza.id, "Revisei o contrato");

    const ask = await post("@dev reaja ao Bia");
    await drainOutbox(f.db, f.handlers);
    for (const id of [limas.id, souzas.id, ask.id]) expect(await listReactions(f.db, f.org.id, id)).toEqual([]);
    expect(toolResult()).toContain("Bia names more than one author here: ");
    expect(toolResult()).toContain("Bia Lima");
    expect(toolResult()).toContain("Bia Souza");

    await f.db
      .update(schema.organizationMembers)
      .set({ handle: "bia" })
      .where(eq(schema.organizationMembers.userId, lima.id));
    await post("@dev reaja ao @bia");
    await drainOutbox(f.db, f.handlers);
    expect((await listReactions(f.db, f.org.id, limas.id)).map((r) => r.reaction)).toEqual(["+1"]);
    expect(await listReactions(f.db, f.org.id, souzas.id)).toEqual([]);
  });

  test("a message_id outside this conversation is refused", async () => {
    let elsewhereId = "";
    f = await setup({
      react: true,
      reply: (req) =>
        lastText(req).includes("tool_result")
          ? { chunks: [] }
          : { chunks: [], toolUses: [{ name: "react", input: { emoji: "👍", message_id: elsewhereId } }] },
    });
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng" });
    const elsewhere = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: eng.id,
      author: { type: "person", userId: f.owner.id },
      body: "Em outro canal",
    });
    elsewhereId = elsewhere.id;
    await post("@dev reaja àquela mensagem");
    await drainOutbox(f.db, f.handlers);
    expect(await listReactions(f.db, f.org.id, elsewhere.id)).toEqual([]);
    expect(toolResult()).toContain("No such message in this conversation.");
  });
});

test("reaction reads and deletes require access to the message's channel", async () => {
  f = await setup();
  const outsider = await addMember(f.db, f.org.id, "member", "reaction-outsider");
  const [privateChannel] = await f.db
    .insert(schema.channels)
    .values({ orgId: f.org.id, name: "reaction-private", visibility: "private", createdByUserId: f.owner.id })
    .returning();
  if (!privateChannel) throw new Error("no private channel");
  await f.db
    .insert(schema.channelMembers)
    .values({ orgId: f.org.id, channelId: privateChannel.id, userId: f.owner.id });
  const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, privateChannel.id, {
    body: "private note",
  });
  await addReaction(f.db, f.owner.id, f.org.id, message.id, "🎉");
  expect(await listMessageReactions(f.db, f.owner.id, f.org.id, message.id)).toHaveLength(1);
  await expect(listMessageReactions(f.db, outsider.id, f.org.id, message.id)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(removeReaction(f.db, outsider.id, f.org.id, message.id, "🎉")).rejects.toBeInstanceOf(ForbiddenError);
});

describe('👎 then "Pedir correção"', () => {
  test("the person's reply quoting the 👎'd answer and mentioning the agent starts a run that sees it", async () => {
    f = await setup({ react: true, reply });
    await post("@dev onde rodam os builds?");
    await drainOutbox(f.db, f.handlers);
    const [answer] = await agentMessages();
    if (!answer) throw new Error("no answer");
    await addReaction(f.db, f.owner.id, f.org.id, answer.id, "-1");

    const fix = await post("@dev faltou dizer que mudamos para o Buildkite", {
      replyTo: answer.id,
      threadId: answer.threadId ?? undefined,
    });
    expect(fix.meta.replyTo).toMatchObject({ messageId: answer.id });
    await drainOutbox(f.db, f.handlers);

    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(2);
    const request = f.provider.calls
      .map((c) => c.request as ModelRequest)
      .find((r) => lastText(r).includes("Buildkite"));
    expect(request ? lastText(request) : "").toContain("replying to Dev");
  });
});
