import { afterEach, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  buildRunContext,
  catchUpText,
  createAgent,
  drainOutbox,
  insertMessage,
  listChannels,
  listDms,
  listMessages,
  markChannelRead,
  openDm,
  PLACE_KEPT_MS,
  postPersonMessage,
  THREAD_ASSESS_DELAY_MS,
} from "../src";
import { runReadOutsideById } from "../src/outside";
import { type Fixture, setup } from "./fixtures";

/**
 * A reply is posted whole at the end of the conversation (ADR 0010): what people sent while it was written reads above
 * it. A message placed before its post (the lead a brain wrote right before its question card, replies from when they
 * kept the place of their streamed words) still reads as new to what asks for what is new since a moment (unread, a
 * catch-up, `landedAfterSql`).
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Past `WORKING_TEXT_MAX`: read as the answer, not as a step's words. */
const LONG = "O deploy de ontem trocou a chave do cache e o login passou a cair depois do refresh. ".repeat(4);

const postIn = (channelId: string, body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body });

/** Resolves once the agent writes in `channelId` (`agent.typing`: none of its words go out before its message). */
const writingIn = (channelId: string) =>
  new Promise<void>((resolve) =>
    f.pubsub.subscribe(channelTopic(channelId), (e) => {
      if ((e as { type: string }).type === "agent.typing") resolve();
    }),
  );

/** Every `agent.delta` that goes out in `channelId`. */
const deltasIn = (channelId: string) => {
  const seen: unknown[] = [];
  f.pubsub.subscribe(channelTopic(channelId), (e) => {
    if ((e as { type: string }).type === "agent.delta") seen.push(e);
  });
  return seen;
};

test("a reply is posted whole at the end: what a person sent while it was written reads above it", async () => {
  let dmId = "";
  f = await setup({
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: [LONG, "Corrijo a chave."],
            // The person writes while it writes, the rest of its answer still on its way.
            hold: writingIn(dmId).then(() => Bun.sleep(5).then(() => postIn(dmId, "olha o refresh também"))),
          }
        : { chunks: ["Olhei o refresh: está certo."] },
  });
  dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  const deltas = deltasIn(dmId);
  await postIn(dmId, "por que o login cai?");
  await drainOutbox(f.db, f.handlers);

  const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
  expect(dm.map((m) => m.body)).toEqual([
    "por que o login cai?",
    "olha o refresh também",
    `${LONG}Corrijo a chave.`.trim(),
    "Olhei o refresh: está certo.",
  ]);
  const [, meanwhile, reply] = dm;
  expect(Date.parse(reply?.createdAt ?? "")).toBeGreaterThan(Date.parse(meanwhile?.createdAt ?? ""));
  // None of its words went out before its message.
  expect(deltas).toEqual([]);
});

test("a draft sent back for another try never shows: the text that replaces it is posted at the end", async () => {
  let dmId = "";
  let verdicts = 0;
  f = await setup({
    // Its first answer gives up with ways left: one more try, never posted; the second is the answer.
    judge: (kind) => (kind === "follow_through" ? (++verdicts === 1 ? "untried" : "done") : undefined),
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: [`Não consegui ver os logs. ${LONG}`],
            hold: writingIn(dmId).then(() => Bun.sleep(5).then(() => postIn(dmId, "é urgente"))),
          }
        : { chunks: [call === 2 ? "Achei: a chave do cache mudou no deploy de ontem." : "Pronto."] },
  });
  dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  const deltas = deltasIn(dmId);
  await postIn(dmId, "por que o login cai?");
  await drainOutbox(f.db, f.handlers);

  const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
  expect(dm.some((m) => m.body.startsWith("Não consegui"))).toBe(false);
  const final = dm.find((m) => m.body.startsWith("Achei"));
  const urgent = dm.find((m) => m.body === "é urgente");
  expect(dm.indexOf(final as (typeof dm)[number])).toBeGreaterThan(dm.indexOf(urgent as (typeof dm)[number]));
  expect(deltas).toEqual([]);
});

test("told to ask, the question card it posts goes at the end, below what came while it was written", async () => {
  const question = `Para configurar o alerta preciso do token do Sentry: ${"você gera em Settings, Auth Tokens, com escopo de projeto. ".repeat(3)}Pode me mandar o token por aqui, assim que tiver ele em mãos?`;
  expect(question.length).toBeGreaterThan(280);
  expect(question.length).toBeLessThanOrEqual(300);
  let dmId = "";
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "ask" : undefined),
    reply: (_request, call) =>
      call === 1
        ? { chunks: ["Assim que tiver o token do Sentry, configuro o alerta."] }
        : {
            chunks: [question],
            hold: writingIn(dmId).then(() => Bun.sleep(5).then(() => postIn(dmId, "vou procurar"))),
          },
  });
  dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  await postIn(dmId, "configura o alerta do Sentry");
  await drainOutbox(f.db, f.handlers);

  const [card] = await f.db.select().from(schema.agentQuestions);
  expect(card?.text).toBe(question);
  const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
  const cardMessage = dm.find((m) => m.id === card?.messageId);
  const meanwhile = dm.find((m) => m.body === "vou procurar");
  expect(dm.indexOf(cardMessage as (typeof dm)[number])).toBeGreaterThan(dm.indexOf(meanwhile as (typeof dm)[number]));
});

test("posted after someone read, in a place before their read: unread for them, and a catch-up reads it", async () => {
  f = await setup();
  const agentSays = (channelId: string, body: string, createdAt?: Date) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body,
      ...(createdAt ? { createdAt } : {}),
    });
  const dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  for (const channelId of [f.general.id, dmId]) await agentSays(channelId, "Lido antes.");
  await Bun.sleep(5);
  const readAt = new Date();
  for (const channelId of [f.general.id, dmId]) await markChannelRead(f.db, f.owner.id, f.org.id, channelId, readAt);
  await Bun.sleep(5);
  for (const channelId of [f.general.id, dmId]) {
    // Posted after their read, in a place before it.
    await agentSays(channelId, "O deploy de ontem trocou a chave.", new Date(readAt.getTime() - 30_000));
    // Never placed this far back (`PLACE_KEPT_MS`).
    await agentSays(channelId, "Bem antigo.", new Date(readAt.getTime() - PLACE_KEPT_MS - 60_000));
  }
  const general = (await listChannels(f.db, f.owner.id, f.org.id)).find((c) => c.id === f.general.id);
  expect(general?.unreadCount).toBe(1);
  const dm = (await listDms(f.db, f.owner.id, f.org.id)).find((d) => d.channelId === dmId);
  expect(dm?.unread).toBe(1);

  // A run asked at `trigger`, back from a wait: a reply that landed since, placed before its trigger, is news to it.
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "e o refresh?",
  });
  await Bun.sleep(5);
  await agentSays(f.general.id, "Já olhei o refresh.", new Date(trigger.createdAt.getTime() - 10_000));
  const text = await catchUpText(
    f.db,
    {
      orgId: f.org.id,
      agentId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      pendingMessageIds: [],
    },
    trigger,
    { since: Date.now() - 20 * 60_000, why: "plan", mayPass: true },
  );
  expect(text).toContain("Já olhei o refresh.");
  expect(text).not.toContain("Lido antes.");
});

test("asked by a reply placed before its post, a run reads what was sent before it was posted", async () => {
  f = await setup();
  const qa = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "QA", handle: "qa", role: "Testes", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const qaSays = (body: string, meta?: Record<string, unknown>, createdAt?: Date) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: qa.id, runId: null, hop: 1, stretchId: null },
      body,
      ...(meta ? { meta } : {}),
      ...(createdAt ? { createdAt } : {}),
    });
  // QA's reply is placed 30 s back; a person and a relayed e-mail came in before it was posted.
  const placedAt = new Date(Date.now() - 30_000);
  await postIn(f.general.id, "o deploy já foi revertido");
  await qaSays("O e-mail do cliente diz que voltou a cair.", { readOutside: true });
  const ask = await qaSays("@dev olha o deploy de ontem", undefined, placedAt);
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
      trigger: "mention",
      hop: 2,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  await Bun.sleep(5);
  await postIn(f.general.id, "alguém viu?");

  const read = JSON.stringify((await buildRunContext(f.db, run, f.agent, { maxMessages: 30 })).messages);
  expect(read).toContain("o deploy já foi revertido");
  expect(read).toContain("O e-mail do cliente");
  expect(read).toContain("olha o deploy de ontem");
  // Sent after it was asked: it comes to the run as it works, not as what was there.
  expect(read).not.toContain("alguém viu?");
  // What it read relays outside content, so what it posts says so (ADR 0117).
  expect(await runReadOutsideById(f.db, f.org.id, run.id)).toBe(true);
});

test("stopped to read a message sent to it, the answer it writes next goes below that message", async () => {
  let dmId = "";
  f = await setup({
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: [LONG, "isto nunca chega"],
            // "Parar e mandar" while it writes: the call is cut, the message read at once.
            hold: writingIn(dmId).then(() =>
              postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dmId, {
                body: "na verdade, olha o refresh",
                steer: "now",
              }),
            ),
          }
        : { chunks: ["Certo, olhei o refresh: a chave expira antes do token."] },
  });
  dmId = (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
  await postIn(dmId, "por que o login cai?");
  await drainOutbox(f.db, f.handlers);

  expect(f.provider.calls).toHaveLength(2);
  const dm = await listMessages(f.db, f.owner.id, f.org.id, dmId);
  expect(dm.map((m) => m.body)).toEqual([
    "por que o login cai?",
    "na verdade, olha o refresh",
    "Certo, olhei o refresh: a chave expira antes do token.",
  ]);
});

test("a reply placed above one posted before it still gets its thread assessed", async () => {
  const isAssess = (system: Parameters<typeof systemText>[0]) =>
    systemText(system).startsWith("You read a conversation thread");
  f = await setup({
    reply: (request) => ({
      chunks: [isAssess(request.system) ? JSON.stringify({ title: "Login caindo no refresh", resolved: true }) : "ok"],
    }),
  });
  const assessed = () => f.provider.calls.filter((c) => isAssess(c.request.system));
  const later = () => drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + THREAD_ASSESS_DELAY_MS + 60_000) });
  const root = await postIn(f.general.id, "o login cai depois do refresh");
  const placedAt = new Date();
  await Bun.sleep(5);
  // Sent in the thread; assessed before the answer landed.
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "acontece no iOS também",
    threadId: root.id,
  });
  await later();
  const before = assessed().length;
  // The answer lands in a place before it, above that message.
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: root.id,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "Corrigido: a chave do cache expirava antes do token.",
    createdAt: placedAt,
  });
  await later();
  expect(assessed()).toHaveLength(before + 1);
  expect(JSON.stringify(assessed().at(-1)?.request.messages)).toContain("Corrigido");
});
