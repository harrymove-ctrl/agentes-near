import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  createChannel,
  createContextToolSource,
  drainOutbox,
  indexSource,
  insertMessage,
  messageCard,
  messageLink,
  openDm,
  postPersonMessage,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const LINK = /http:\/\/localhost:3000\/org\/[0-9a-f-]+\/c\/[0-9a-f-]+\?m=[0-9a-f-]+/;

/** A run of the agent on `triggerId`, as the dispatcher starts one. */
async function runOn(channelId: string, triggerId: string): Promise<ToolContext> {
  const [started] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.triggerMessageId, triggerId), eq(schema.agentRuns.agentId, f.agent.id)));
  const [run] = started
    ? [started]
    : await f.db
        .insert(schema.agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId,
          threadRootId: triggerId,
          triggerMessageId: triggerId,
          trigger: "mention",
          hop: 1,
          status: "running",
        })
        .returning();
  if (!run) throw new Error("no run");
  const ids = { channelId, threadRootId: triggerId, triggerMessageId: triggerId };
  return { db: f.db, orgId: f.org.id, agentId: f.agent.id, runId: run.id, ...ids };
}

const read = async (ctx: ToolContext, input: Record<string, unknown>) => {
  const tools = await createContextToolSource(f.context).tools(ctx);
  const tool = tools.find((t) => t.name === "read_conversation");
  if (!tool) throw new Error("no read_conversation");
  return tool.execute(input, ctx);
};

/**
 * Bia asks @dev in `channelId` to DM Ana; Ana then asks in that DM where it was asked. Returns the request of Ana's
 * run (its history), the DM and the message that asked.
 */
async function askedElsewhere() {
  const requests: ModelRequest[] = [];
  f = await setup({
    chatTools: true,
    contextTools: true,
    reply: (req: ModelRequest) => {
      requests.push(req);
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("manda os acessos")) {
        return {
          chunks: [],
          toolUses: [
            { name: "send_dm", input: { person: "ana", text: "A Bia pediu pra eu te mandar os acessos de hoje." } },
          ],
        };
      }
      return { chunks: ["ok"] };
    },
  });
  // An admin: she places the agent in her own private channel.
  const bia = await addMember(f.db, f.org.id, "admin", "bia");
  return { bia, requests };
}

async function theExchange(channelId: string, bia: { id: string }, requests: ModelRequest[]) {
  const deps = { db: f.db, pubsub: f.pubsub };
  const asked = await postPersonMessage(deps, bia.id, f.org.id, channelId, {
    body: "@dev manda os acessos de hoje pra ana na dm",
  });
  await drainOutbox(f.db, f.handlers);
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const [sent] = await f.db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.channelId, dm.id), eq(schema.messages.authorAgentId, f.agent.id)));
  const where = await postPersonMessage(deps, f.owner.id, f.org.id, dm.id, { body: "onde ela pediu isso?" });
  await drainOutbox(f.db, f.handlers);
  const seen = JSON.stringify(requests.at(-1)?.messages);
  return { asked, dm, sent, where, seen };
}

describe("where an agent was asked", () => {
  test("send_dm keeps the message that asked; the DM's later runs quote it with its link", async () => {
    const { bia, requests } = await askedElsewhere();
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const { asked, dm, sent, where, seen } = await theExchange(f.general.id, bia, requests);
    const origin = (sent?.meta as { agentDm?: Record<string, unknown> } | undefined)?.agentDm;
    expect(origin).toMatchObject({ fromChannelId: f.general.id, fromMessageId: asked.id });
    expect(origin).not.toHaveProperty("requesterUserId");
    const link = messageLink(f.org.id, asked);
    expect(link).toMatch(LINK);
    expect(seen).toContain(
      `[Why you sent it]: bia asked in #general: \\"@dev manda os acessos de hoje pra ana na dm\\" ${link}`,
    );

    // The link opens the request with what was said around it.
    const opened = await read(await runOn(dm.id, where.id), { message: link });
    expect(opened.isError).toBeFalsy();
    expect(opened.content).toContain(`→ bia in #general`);
    expect(opened.content).toContain("manda os acessos de hoje");
  });

  test("asked in a private channel: named and quoted only for someone in it", async () => {
    const { bia, requests } = await askedElsewhere();
    const board = await createChannel(f.db, bia.id, f.org.id, { name: "diretoria", visibility: "private" });
    await addChannelMember(f.db, bia.id, f.org.id, board.id, { agentId: f.agent.id });
    const { asked, dm, where, seen } = await theExchange(board.id, bia, requests);
    expect(seen).toContain("[Why you sent it]: bia asked in a conversation not everyone here is in.");
    expect(seen).not.toContain("diretoria");
    expect(seen).not.toContain(asked.id);
    const ctx = await runOn(dm.id, where.id);
    expect(await read(ctx, { message: asked.id })).toMatchObject({ isError: true });
    expect(await read(ctx, { channel: "#diretoria" })).toMatchObject({ isError: true });

    // Once Ana is in it: the request itself, and only it.
    await addChannelMember(f.db, bia.id, f.org.id, board.id, { userId: f.owner.id });
    const later = await read(ctx, { message: messageLink(f.org.id, asked) });
    expect(later.content).toContain("bia in #diretoria");
    expect(later.content).toContain("manda os acessos de hoje");
    // Still not the rest of the channel.
    expect(await read(ctx, { channel: "diretoria" })).toMatchObject({ isError: true });
  });

  test("asked in a DM: who asked stays in that DM too", async () => {
    const { bia, requests } = await askedElsewhere();
    const biaDm = await openDm(f.db, bia.id, f.org.id, { agentId: f.agent.id });
    const { asked, seen } = await theExchange(biaDm.id, bia, requests);
    expect(seen).toContain("[Why you sent it]: Someone asked in a conversation not everyone here is in.");
    expect(seen).not.toContain("bia asked");
    expect(seen).not.toContain(asked.id);
  });

  test("asked in a private channel to post in a public one: never quoted there, someone outside it reads the reply", async () => {
    const requests: ModelRequest[] = [];
    f = await setup({
      contextTools: true,
      reply: (req: ModelRequest) => {
        requests.push(req);
        return { chunks: ["ok"] };
      },
    });
    const leo = await addMember(f.db, f.org.id, "member", "leo");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: leo.id });
    const board = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, board.id, { agentId: f.agent.id });
    const asked = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: board.id,
      author: { type: "person", userId: f.owner.id },
      body: "avisa no general que o corte de verba sai sexta",
    });
    // What post_message stores for the message it posts in #general.
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Aviso: sai sexta.",
      meta: { postedFrom: { requesterUserId: f.owner.id, fromChannelId: board.id, fromMessageId: asked.id } },
    });
    const why = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev quem pediu isso?",
    });
    await drainOutbox(f.db, f.handlers);
    const seen = JSON.stringify(requests.at(-1)?.messages);
    expect(seen).toContain("[Why you sent it]: ana asked in a conversation not everyone here is in.");
    expect(seen).not.toContain("corte de verba");
    expect(seen).not.toContain("diretoria");
    expect(await read(await runOn(f.general.id, why.id), { message: asked.id })).toMatchObject({ isError: true });
  });
});

describe("read_conversation", () => {
  test("a channel's latest messages or around a time, with who, where and links; one of the inputs only", async () => {
    f = await setup({ contextTools: true });
    const at = Date.now();
    const said = [];
    for (let i = 0; i < 6; i++) {
      said.push(
        await insertMessage(f.db, {
          orgId: f.org.id,
          channelId: f.general.id,
          author: { type: "person", userId: f.owner.id },
          body: `mensagem ${i}`,
          createdAt: new Date(at - (6 - i) * 60_000),
        }),
      );
    }
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: f.owner.id },
      body: "o que falaram no general?",
    });
    const ctx = await runOn(dm.id, ask.id);
    const latest = (await read(ctx, { channel: "general", limit: 2 })).content;
    expect(latest).toContain("mensagem 5");
    expect(latest).toContain("mensagem 4");
    expect(latest).not.toContain("mensagem 3");
    expect(latest).toContain(`ana in #general`);
    expect(latest).toContain(messageLink(f.org.id, said[5] as { id: string; channelId: string }));
    const around = (await read(ctx, { channel: "#general", around: said[1]?.createdAt.toISOString(), limit: 2 }))
      .content;
    expect(around).toContain("mensagem 1");
    expect(around).toContain("mensagem 2");
    expect(around).not.toContain("mensagem 4");
    // Without input: this conversation.
    expect((await read(ctx, {})).content).toContain("o que falaram no general?");
    expect(await read(ctx, { channel: "general", message: ask.id })).toMatchObject({ isError: true });
  });

  test("search_context names who wrote a message, where, and its link", async () => {
    f = await setup({ contextTools: true });
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "o relatório de acessos do site fica pronto amanhã",
    });
    await indexSource(f.context, { orgId: f.org.id, kind: "message", sourceId: m.id });
    const ctx = await runOn(f.general.id, m.id);
    const tools = await createContextToolSource(f.context).tools(ctx);
    const search = tools.find((t) => t.name === "search_context");
    const found = await search?.execute({ query: "relatório de acessos" }, ctx);
    expect(found?.content).toContain(`ana in #general ${messageLink(f.org.id, m)}`);
  });
});

describe("messageCard (a pasted link's pill)", () => {
  test("names the place only for who may see it", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const leo = await addMember(f.db, f.org.id, "member", "leo");
    const say = (channelId: string, body: string, threadId: string | null = null) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId,
        threadId,
        author: { type: "person", userId: f.owner.id },
        body,
      });
    const root = await say(f.general.id, "raiz");
    const reply = await say(f.general.id, "resposta", root.id);
    // A public channel's message: anyone in the workspace, member or not.
    expect(await messageCard(f.db, bia.id, f.org.id, root.id)).toMatchObject({
      kind: "channel",
      name: "general",
      author: "ana",
      threadId: null,
    });
    expect(await messageCard(f.db, bia.id, f.org.id, reply.id)).toMatchObject({ threadId: root.id });

    const board = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    const secret = await say(board.id, "segredo");
    await expect(messageCard(f.db, bia.id, f.org.id, secret.id)).rejects.toThrow("Message not found");
    expect((await messageCard(f.db, f.owner.id, f.org.id, secret.id)).name).toBe("diretoria");

    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    const inDm = await say(dm.id, "oi bia");
    expect(await messageCard(f.db, bia.id, f.org.id, inDm.id)).toMatchObject({ kind: "dm", name: "ana" });
    expect(await messageCard(f.db, f.owner.id, f.org.id, inDm.id)).toMatchObject({ kind: "dm", name: "bia" });
    await expect(messageCard(f.db, leo.id, f.org.id, inDm.id)).rejects.toThrow("Message not found");
  });
});
