import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  ASK_CHOICES_LINE,
  answerChoices,
  buildRunContext,
  ConflictError,
  choiceReplyText,
  createAgent,
  createBlockToolSource,
  drainOutbox,
  getArtifact,
  getChoices,
  listArtifacts,
  listMessages,
  NEW_AGENT_DEFAULTS,
  openAgentDm,
  postPersonMessage,
  type ToolContext,
  toolKind,
  ValidationError,
  validateContent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const QUESTIONS = [
  {
    question: "Como sigo com o deploy?",
    options: [{ label: "Fazer agora", description: "Sobe em 5 min" }, { label: "Deixar para amanhã" }],
  },
];

function agent(req: ModelRequest) {
  const text = JSON.stringify(req.messages.at(-1)?.content);
  if (text.includes("tool_result")) return { chunks: ["Escolhe aí."] };
  if (text.includes("deploy")) {
    return {
      chunks: [],
      toolUses: [{ name: "ask_choices", input: { title: "Deploy", questions: QUESTIONS } }],
    };
  }
  return { chunks: ["ok"] };
}

const asked = async () => {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev e o deploy?",
  });
  await drainOutbox(f.db, f.handlers);
  const [row] = await f.db.select().from(schema.artifacts);
  if (!row) throw new Error("no card");
  return row;
};

const deps = () => ({ ...f.artifactDeps, pubsub: f.pubsub });

test("an agent asks with a card: in its reply, out of the Drive, with the options as given", async () => {
  f = await setup({ blockTools: true, reply: agent });
  const row = await asked();
  expect(row).toMatchObject({ kind: "choices", inDrive: false, title: "Deploy", channelId: f.general.id });
  const reply = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).at(-1);
  expect(reply?.meta.artifacts).toEqual([{ id: row.id, version: 1, title: "Deploy" }]);
  const shown = await getArtifact(f.artifactDeps, person(f.owner.id), f.org.id, row.id);
  expect(shown.content).toEqual({ kind: "choices", questions: QUESTIONS });
  expect(await listArtifacts(f.db, person(f.owner.id), f.org.id)).toEqual([]);
  expect(await getChoices(f.artifactDeps, f.owner.id, f.org.id, row.id)).toEqual({ id: row.id, answer: null });
});

test("a pick goes to the agent as the person's own message, once; the card then shows it", async () => {
  f = await setup({ blockTools: true, reply: agent });
  const row = await asked();
  const { message, choices } = await answerChoices(deps(), f.owner.id, f.org.id, row.id, { picks: [1] });
  expect(message.body).toBe("@dev Como sigo com o deploy? Deixar para amanhã");
  expect(message.author).toMatchObject({ type: "person", id: f.owner.id });
  expect(message.meta.choiceReply).toEqual({ id: row.id, title: "Deploy" });
  expect(choices.answer).toMatchObject({ userId: f.owner.id, picks: [1], messageId: message.id });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  expect(run?.agentId).toBe(f.agent.id);
  // Someone else, a moment later: the first answer stands.
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "oi" });
  await expect(answerChoices(deps(), bia.id, f.org.id, row.id, { picks: [0] })).rejects.toThrow(ConflictError);
  expect((await getChoices(f.artifactDeps, f.owner.id, f.org.id, row.id)).answer?.picks).toEqual([1]);
});

test("the run a one-question pick starts reads the question it answers", async () => {
  f = await setup({ blockTools: true, reply: agent });
  const row = await asked();
  const { message } = await answerChoices(deps(), f.owner.id, f.org.id, row.id, { picks: [0] });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  if (!run) throw new Error("no run");
  const { messages } = await buildRunContext(f.db, run, f.agent, { maxMessages: 10 });
  expect(JSON.stringify(messages.at(-1)?.content)).toContain("Como sigo com o deploy? Fazer agora");
});

test("a claim whose message never went out (a crash in between) stops holding the card", async () => {
  f = await setup({ blockTools: true, reply: agent });
  const row = await asked();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await f.db.insert(schema.choiceAnswers).values({
    artifactId: row.id,
    orgId: f.org.id,
    userId: bia.id,
    picks: [0],
    createdAt: new Date(Date.now() - 10 * 60_000),
  });
  expect((await getChoices(f.artifactDeps, f.owner.id, f.org.id, row.id)).answer).toBeNull();
  const { choices } = await answerChoices(deps(), f.owner.id, f.org.id, row.id, { picks: [1] });
  expect(choices.answer?.userId).toBe(f.owner.id);
  expect(choices.answer?.picks).toEqual([1]);
});

test("a pick must name one option of each question", async () => {
  f = await setup({ blockTools: true, reply: agent });
  const row = await asked();
  for (const picks of [[], [2], [0, 1], [-1], [0.5], [3]])
    await expect(answerChoices(deps(), f.owner.id, f.org.id, row.id, { picks })).rejects.toThrow(ValidationError);
  // "Outra resposta" (the pick past the last option) needs its words, and not too many.
  for (const others of [[""], ["   "], [null], ["x".repeat(1001)]])
    await expect(answerChoices(deps(), f.owner.id, f.org.id, row.id, { picks: [2], others })).rejects.toThrow(
      ValidationError,
    );
  expect((await getChoices(f.artifactDeps, f.owner.id, f.org.id, row.id)).answer).toBeNull();
});

test("Outra resposta: what the person wrote reaches the agent in place of an option, and the card shows it", async () => {
  f = await setup({ blockTools: true, reply: agent });
  const row = await asked();
  const { message, choices } = await answerChoices(deps(), f.owner.id, f.org.id, row.id, {
    picks: [2],
    others: ["  Só depois da reunião de sexta  "],
  });
  expect(message.body).toBe("@dev Como sigo com o deploy? Só depois da reunião de sexta");
  expect(message.meta.choiceReply).toEqual({ id: row.id, title: "Deploy", others: ["Só depois da reunião de sexta"] });
  expect(choices.answer).toMatchObject({ picks: [2], others: ["Só depois da reunião de sexta"] });
  // Anyone opening the card later reads it too.
  const later = await getChoices(f.artifactDeps, f.owner.id, f.org.id, row.id);
  expect(later.answer?.others).toEqual(["Só depois da reunião de sexta"]);
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, message.id));
  expect(run?.agentId).toBe(f.agent.id);
});

test("an option an agent wrote that only says other goes: every question takes a written answer of its own", () => {
  const card = validateContent({
    kind: "choices",
    questions: [
      { question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }, { label: "Outra" }] },
      { question: "Quem?", options: [{ label: "Ana" }, { label: "Other (write it)", description: "Diga quem" }] },
      { question: "Onde?", options: [{ label: "Outra cidade" }, { label: "Aqui" }] },
    ],
  });
  expect(card).toEqual({
    kind: "choices",
    questions: [
      { question: "Qual cor?", options: [{ label: "Azul" }, { label: "Verde" }] },
      { question: "Quem?", options: [{ label: "Ana" }] },
      { question: "Onde?", options: [{ label: "Outra cidade" }, { label: "Aqui" }] },
    ],
  });
  expect(choiceReplyText([{ question: "Qual cor?", options: [{ label: "Azul" }] }], [1], ["Vermelho"])).toBe(
    "Qual cor? Vermelho",
  );
});

test("several questions reach the agent one per line; a bad card is refused", () => {
  const questions = [
    { question: "Quando?", options: [{ label: "Hoje" }, { label: "Amanhã" }] },
    { question: "Quem revisa?", options: [{ label: "Ana" }, { label: "Theo" }, { label: "Ninguém" }] },
  ];
  expect(choiceReplyText(questions, [1, 2])).toBe("Quando? Amanhã\nQuem revisa? Ninguém");
  expect(validateContent({ kind: "choices", questions })).toEqual({ kind: "choices", questions });
  const bad = [
    [],
    [{ question: "X", options: [{ label: "só uma" }] }],
    [{ question: "X", options: [{ label: "a" }, { label: "a" }] }],
    [{ question: " ", options: [{ label: "a" }, { label: "b" }] }],
    Array.from({ length: 6 }, () => questions[0]),
  ];
  for (const q of bad) expect(() => validateContent({ kind: "choices", questions: q })).toThrow(ValidationError);
});

test("offered only to a run a person is behind, where people read; it speaks only here", async () => {
  f = await setup({ blockTools: true, reply: agent });
  const source = createBlockToolSource(f.artifactDeps);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  } as ToolContext;
  const names = async (c: ToolContext) => (await source.tools(c)).map((t) => t.name);
  expect(await names(ctx)).toContain("ask_choices");
  expect(await names({ ...ctx, background: true })).not.toContain("ask_choices");
  const ops = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, NEW_AGENT_DEFAULTS);
  const agentsDm = await openAgentDm(f.db, f.org.id, f.agent.id, ops.id);
  expect(await names({ ...ctx, channelId: agentsDm.id })).not.toContain("ask_choices");
  expect(toolKind({ name: "ask_choices", scope: "" })).toEqual({ kind: "here" });
});

test("the prompt says when to use a card only where the tool is", async () => {
  f = await setup();
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const system = async (choices: boolean) =>
    systemText((await buildRunContext(f.db, run, f.agent, { maxMessages: 10, toolsAvailable: true, choices })).system);
  expect(await system(true)).toContain(ASK_CHOICES_LINE);
  expect(await system(false)).not.toContain("ask_choices");
  expect(ASK_CHOICES_LINE).toContain("Never for an open question");
});
