import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { serverText } from "@agenteschat/i18n";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  type Brain,
  createChannel,
  createJobHandlers,
  drainOutbox,
  executeToolForRun,
  insertMessage,
  moveRun,
  moveToBackground,
  postPersonMessage,
  postWorkUpdate,
  WORK_IN_BACKGROUND_TOOL,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/**
 * "Continue no canal, fora dessa thread": `post_message` with `move_here` moves the run's replies to a channel's top
 * level, its background work's updates and report too, and a line where it was links there.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const say = (body: string, threadId?: string, channelId = f.general.id) =>
  postPersonMessage(deps(), f.owner.id, f.org.id, channelId, { body, ...(threadId ? { threadId } : {}) });
const agentPosts = async () =>
  (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorAgentId === f.agent.id,
  );
const toolContents = async () =>
  (await f.db.select().from(schema.agentRunSteps))
    .filter((s) => s.kind === "tool_result")
    .map((s) => s.data as { name: string; content: string; isError: boolean });
const asked = (req: ModelRequest, words: string) => JSON.stringify(req.messages).includes(words);
const called = (req: ModelRequest, tool: string) => JSON.stringify(req.messages).includes(`"name":"${tool}"`);

/** A thread in #general with the agent's reply in it, ready for the person's next message there. */
async function thread() {
  const root = await say("@dev confere as lojas");
  await drainOutbox(f.db, f.handlers);
  return root;
}

const moveCall = (channel: string, text: string) => ({
  chunks: [],
  toolUses: [{ name: "post_message", input: { channel, text, move_here: true } }],
});

test("out of a thread: the message at the channel's top level, the line in the thread, the reply follows", async () => {
  f = await setup({
    chatTools: true,
    reply: (req) => {
      if (!asked(req, "fora dessa thread")) return { chunks: ["Conferi."] };
      return called(req, "post_message")
        ? { chunks: ["Segui aqui: 3 lojas abertas."] }
        : moveCall("general", "Sigo aqui.");
    },
  });
  const root = await thread();
  const events = f.listen(f.general.id);
  await say("@dev continue no canal, fora dessa thread", root.id);
  await drainOutbox(f.db, f.handlers);

  const posts = await agentPosts();
  const moved = posts.find((m) => m.body === "Sigo aqui.");
  expect(moved?.threadId).toBeNull();
  const line = posts.find((m) => m.meta.movedOn);
  expect(line?.threadId).toBe(root.id);
  expect(line?.meta.bodyCode).toBe("moved_on");
  expect(JSON.stringify(line?.meta.bodyParams)).toContain(moved?.id as string);
  expect(posts.at(-1)).toMatchObject({ body: "Segui aqui: 3 lojas abertas.", threadId: null, channelId: f.general.id });

  // The live row ends in the thread and starts over at the channel's top level.
  const run = (await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt)).at(-1);
  expect(run?.threadRootId).toBe(run?.triggerMessageId as string);
  const idle = events.findIndex((e) => e.type === "agent.idle" && e.runId === run?.id && e.threadId === root.id);
  const thinking = events.findIndex((e) => e.type === "agent.thinking" && e.runId === run?.id && e.threadId === null);
  expect(idle).toBeGreaterThanOrEqual(0);
  expect(thinking).toBeGreaterThan(idle);
  expect(serverText("pt-BR", "chat.body.moved_on", { link: "x" })).toBe("Continua em x");
});

test("to another channel: the run answers there", async () => {
  f = await setup({
    chatTools: true,
    reply: (req) => {
      if (!asked(req, "continue no #lojas")) return { chunks: ["Conferi."] };
      return called(req, "post_message") ? { chunks: ["Lojas conferidas."] } : moveCall("lojas", "Sigo aqui.");
    },
  });
  const lojas = await createChannel(f.db, f.owner.id, f.org.id, { name: "lojas", visibility: "public" });
  await addChannelMember(f.db, f.owner.id, f.org.id, lojas.id, { agentId: f.agent.id });
  const root = await thread();
  await say("@dev continue no #lojas", root.id);
  await drainOutbox(f.db, f.handlers);

  const posts = await agentPosts();
  expect(posts.find((m) => m.meta.movedOn)).toMatchObject({ channelId: f.general.id, threadId: root.id });
  expect(posts.at(-1)).toMatchObject({ body: "Lojas conferidas.", channelId: lojas.id, threadId: null });
  const run = (await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt)).at(-1);
  expect(run?.channelId).toBe(lojas.id);
});

test("background work asked in a thread: its updates and its report follow the move", async () => {
  f = await setup({
    chatTools: true,
    workTools: true,
    reply: (req) => {
      if (!asked(req, "fora dessa thread")) return { chunks: ["Conferi."] };
      if (!called(req, WORK_IN_BACKGROUND_TOOL))
        return {
          chunks: [],
          toolUses: [{ name: WORK_IN_BACKGROUND_TOOL, input: { title: "Lojas", say: "Vou cuidar disso." } }],
        };
      if (!called(req, "post_message")) return moveCall("general", "Sigo aqui com as lojas.");
      return { chunks: ["Pronto: lojas conferidas."] };
    },
  });
  const root = await thread();
  await say("@dev confere tudo, continue no canal, fora dessa thread", root.id);
  await drainOutbox(f.db, f.handlers);

  const posts = await agentPosts();
  expect(posts.find((m) => m.meta.longWork)?.threadId).toBe(root.id);
  expect(posts.find((m) => m.meta.movedOn)?.threadId).toBe(root.id);
  expect(posts.at(-1)).toMatchObject({ body: "Pronto: lojas conferidas.", threadId: null });
  const [work] = await f.db.select().from(schema.agentWorks);
  expect(work).toMatchObject({ homeThreadId: null, ownThread: false, status: "done" });
});

test("a work's update after the move lands at the channel's top level too", async () => {
  f = await setup({ chatTools: true, workTools: true, reply: () => ({ chunks: ["Conferi."] }) });
  const root = await thread();
  await say("@dev confere tudo", root.id);
  const [run] = await f.db
    .update(schema.agentRuns)
    .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
    .where(eq(schema.agentRuns.status, "queued"))
    .returning();
  if (!run) throw new Error("no run");
  await moveToBackground(deps(), run.id, { how: "agent", title: "Lojas", say: "Vou cuidar disso." });
  const [work] = await f.db.select().from(schema.agentWorks);
  const posted = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: run.hop },
    body: "Sigo aqui.",
  });
  await moveRun(deps(), { ...run, workId: work?.id ?? null }, posted);

  const out = await postWorkUpdate(deps(), run.id, { text: "Metade conferida." }, new Date(Date.now() + 10 * 60_000));
  expect(out.ok).toBe(true);
  expect((await agentPosts()).find((m) => m.meta.workUpdate)).toMatchObject({
    channelId: f.general.id,
    threadId: null,
  });
});

test("the next wake lands there too: an answer to its question comes back at the channel's top level", async () => {
  f = await setup({
    chatTools: true,
    askUser: true,
    reply: (req) => {
      if (!asked(req, "fora dessa thread")) return { chunks: ["Conferi."] };
      if (!called(req, "post_message")) return moveCall("general", "Sigo aqui.");
      if (!called(req, "ask_user"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "ask_user",
              input: { question: "Qual loja primeiro?", why: "I need a person's answer before I go on." },
            },
          ],
        };
      return { chunks: ["Começando pela loja 2."] };
    },
  });
  const root = await thread();
  await say("@dev continue no canal, fora dessa thread", root.id);
  await drainOutbox(f.db, f.handlers);
  await say("a 2");
  await drainOutbox(f.db, f.handlers);
  expect((await agentPosts()).at(-1)).toMatchObject({ body: "Começando pela loja 2.", threadId: null });
});

test("a run at the channel's top level has nothing to move there", async () => {
  f = await setup({
    chatTools: true,
    reply: (req) => (called(req, "post_message") ? { chunks: ["Certo."] } : moveCall("general", "Sigo aqui.")),
  });
  await say("@dev continue aqui");
  await drainOutbox(f.db, f.handlers);
  const [result] = await toolContents();
  expect(result).toMatchObject({ isError: true });
  expect(result?.content).toContain("this conversation");
  expect((await agentPosts()).map((m) => m.body)).toEqual(["Certo."]);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
  expect(run?.threadRootId).toBe(run?.triggerMessageId as string);
});

test("in a thread without move_here, the result says how to leave it", async () => {
  f = await setup({
    chatTools: true,
    reply: (req) => {
      if (!asked(req, "no canal")) return { chunks: ["Conferi."] };
      return called(req, "post_message")
        ? { chunks: ["Certo."] }
        : { chunks: [], toolUses: [{ name: "post_message", input: { channel: "general", text: "Oi." } }] };
    },
  });
  const root = await thread();
  await say("@dev manda no canal", root.id);
  await drainOutbox(f.db, f.handlers);
  expect((await toolContents()).at(-1)?.content).toContain("`move_here`");
});

test("a brain that moves inside its turn: its first words after the move don't bring the row back to the thread", async () => {
  f = await setup({ chatTools: true, reply: () => ({ chunks: ["Conferi."] }) });
  const root = await thread();
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      await executeToolForRun(
        f.jobDeps,
        { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId: "mac" },
        { id: "m1", name: "post_message", input: { channel: "general", text: "Sigo aqui.", move_here: true } },
      );
      yield { type: "tool_call", id: "m1", name: "post_message", input: {}, executed: { content: "ok" } };
      await new Promise((r) => setTimeout(r, 50));
      yield { type: "text_delta", text: "Lojas conferidas." };
      yield { type: "done", text: "Lojas conferidas." };
    },
  };
  const events = f.listen(f.general.id);
  await say("@dev continue no canal, fora dessa thread", root.id);
  await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, brains: { model: () => brain } }));

  expect((await agentPosts()).at(-1)).toMatchObject({ body: "Lojas conferidas.", threadId: null });
  const typing = events.filter((e) => e.type === "agent.typing");
  expect(typing.map((e) => e.threadId)).toEqual([null]);
});

test("in a mission's thread: told once it stays, never sent back and forth between `move_here` and not", async () => {
  f = await setup({
    chatTools: true,
    reply: (req) => {
      if (!asked(req, "fora dessa thread")) return { chunks: ["Conferi."] };
      if (called(req, "post_message")) return { chunks: ["Sigo aqui."] };
      return { chunks: [], toolUses: [{ name: "post_message", input: { channel: "general", text: "Oi." } }] };
    },
  });
  const root = await thread();
  await f.db.insert(schema.missions).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: root.id,
    ownerId: f.owner.id,
    title: "Lojas",
    goal: "Conferir as lojas",
    mainSessionId: crypto.randomUUID(),
  });
  await say("@dev continue fora dessa thread", root.id);
  await drainOutbox(f.db, f.handlers);
  expect((await toolContents()).at(-1)?.content).not.toContain("`move_here`");
});
