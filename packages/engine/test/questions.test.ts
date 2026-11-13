import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  answerQuestion,
  ConflictError,
  cancelRun,
  createAgent,
  dismissQuestion,
  drainOutbox,
  expireQuestions,
  insertMessage,
  listMessages,
  openDm,
  postPersonMessage,
  ValidationError,
} from "../src";
import { listNotifications } from "../src/notifications";
import { resolveStaleQuestionNotifications } from "../src/questions";
import { addMember, type Fixture, setup } from "./fixtures";

// The first test pays for migrating the PGlite template (2-3 s idle, past 5 s under a full suite's load), and the
// preload's longer default reaches only a run's first file.
setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** Asks which environment for "deploy it"; answers simple requests directly. */
const reply = (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) return { chunks: [`Ok: ${/answered: ([a-z]+)/.exec(last)?.[1] ?? "no answer"}`] };
  if (last.includes("deploy it"))
    return {
      chunks: [],
      toolUses: [
        {
          name: "ask_user",
          input: {
            why: "I need a person's answer before I go on: this decides what I change next.",
            question: "Qual ambiente?",
            choices: ["staging", "production"],
          },
        },
      ],
    };
  return { chunks: ["Feito."] };
};

const post = (body: string, threadId?: string, channelId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId ?? f.general.id, {
    body,
    threadId,
  });

const runs = () => f.db.select().from(schema.agentRuns);
const questions = () => f.db.select().from(schema.agentQuestions);

describe("ask_user", () => {
  test("an ambiguous request asks; the answer from the card resumes the run with it", async () => {
    f = await setup({ askUser: true, reply });
    const events = f.listen(f.general.id);
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);

    const [run] = await runs();
    expect(run?.status).toBe("waiting_input");
    const [q] = await questions();
    expect(q).toMatchObject({ text: "Qual ambiente?", choices: ["staging", "production"], status: "open" });
    // Asked in the channel: the card is in the main timeline.
    expect(q?.threadId).toBeNull();
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const card = main.find((m) => m.id === q?.messageId);
    expect(card?.threadId).toBeNull();
    expect(card?.meta.questionId).toBe(q?.id);
    expect(card?.meta.question).toMatchObject({ id: q?.id, messageId: q?.messageId, status: "open", answer: null });
    await Bun.sleep(5);
    const asked = events.find((e) => e.type === "question.asked") as unknown as {
      threadId: string | null;
      question: { id: string; choices: string[] };
    };
    expect(asked.threadId).toBeNull();
    expect(asked.question.choices).toEqual(["staging", "production"]);

    await expect(
      answerQuestion({ db: f.db }, f.owner.id, f.org.id, q?.id ?? "", { choice: "dev" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const answered = await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "", {
      choice: "staging",
    });
    expect(answered).toMatchObject({ status: "answered", answer: "staging", answeredByUserId: f.owner.id });
    await expect(
      answerQuestion({ db: f.db }, f.owner.id, f.org.id, q?.id ?? "", { text: "again" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await drainOutbox(f.db, f.handlers);

    expect((await runs())[0]?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("The person answered: staging");
    const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(after.at(-1)?.body).toBe("Ok: staging");
    expect(after.find((m) => m.id === q?.messageId)?.meta.question).toMatchObject({ status: "answered" });
    await Bun.sleep(5);
    expect(events.some((e) => e.type === "question.answered")).toBe(true);
  });

  test("someone else answers: the run is told who decided and replies to them", async () => {
    f = await setup({ askUser: true, reply });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [q] = await questions();
    await f.db
      .update(schema.agentQuestions)
      .set({ requestedForUserId: null })
      .where(eq(schema.agentQuestions.id, q?.id ?? ""));
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, q?.id ?? "", { choice: "staging" });
    await drainOutbox(f.db, f.handlers);
    const told = lastText(f.provider.calls.at(-1)?.request as ModelRequest);
    expect(told).toContain("The person answered: staging");
    expect(told).toContain("Decided by Bia Teste. Your reply is for Bia Teste");
  });

  test("a canceled run closes its question's card, so no one is offered an answer that can't arrive", async () => {
    f = await setup({ askUser: true, reply });
    const events = f.listen(f.general.id);
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [run] = await runs();
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run?.id ?? "");
    const [q] = await questions();
    expect(q?.status).toBe("canceled");
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.find((m) => m.id === q?.messageId)?.meta.question).toMatchObject({ status: "answered", answer: null });
    await Bun.sleep(5);
    const closed = events.find((e) => e.type === "question.answered") as unknown as { question: { id: string } };
    expect(closed?.question.id).toBe(q?.id ?? "");
    // Out of the inbox too: nothing waits on a person for an answer nobody can give.
    const inbox = () => listNotifications({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { filter: "waiting" });
    expect((await inbox()).items.filter((n) => n.kind === "agent_question")).toEqual([]);
    // A notification left waiting after the question closed (a release before this one, a crash in between) is
    // swept by the expiry worker.
    await f.db
      .update(schema.notifications)
      .set({ doneAt: null })
      .where(eq(schema.notifications.groupKey, `agent_question:${q?.id ?? ""}`));
    expect((await inbox()).items.filter((n) => n.kind === "agent_question")).toHaveLength(1);
    expect(await resolveStaleQuestionNotifications({ db: f.db, pubsub: f.pubsub })).toBe(1);
    expect((await inbox()).items.filter((n) => n.kind === "agent_question")).toEqual([]);
  });

  test("the next message in the channel answers it, without starting another run", async () => {
    f = await setup({ askUser: true, reply });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const answer = await post("production, por favor");
    expect(answer.meta.answersQuestionId).toBe((await questions())[0]?.id);
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    expect((await questions())[0]).toMatchObject({ status: "answered", answer: "production, por favor" });
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.map((m) => m.body)).toEqual([
      "@dev deploy it",
      "Qual ambiente?",
      "production, por favor",
      "Ok: production",
    ]);
  });

  test("a quote of another agent answers the question only when it names the agent that asked", async () => {
    f = await setup({ askUser: true, reply });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const theo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Theo", handle: "theo" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: theo.id });
    const said = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: theo.id, runId: null, hop: 1, stretchId: null },
      body: "Staging está livre agora.",
    });
    const quote = (body: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, replyTo: said.id });
    const toTheo = await quote("valeu, e o banco?");
    expect(toTheo.meta.answersQuestionId).toBeUndefined();
    const toDev = await quote("@dev vai de staging, como o Theo disse");
    expect(toDev.meta.answersQuestionId).toBe((await questions())[0]?.id);
  });

  test("in a DM the question and the answer stay in the main timeline", async () => {
    f = await setup({ askUser: true, reply });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await post("deploy it", undefined, dm.id);
    await drainOutbox(f.db, f.handlers);
    expect((await questions())[0]?.threadId).toBeNull();
    await post("staging", undefined, dm.id);
    await drainOutbox(f.db, f.handlers);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]); // the answer started no new DM run
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, dm.id);
    expect(timeline.map((m) => m.body)).toEqual(["deploy it", "Qual ambiente?", "staging", "Ok: staging"]);
    expect(timeline.every((m) => m.threadId === null)).toBe(true);
  });

  test("a simple request is answered directly; the prompt tells when to ask, the tool what not to ask", async () => {
    f = await setup({ askUser: true, reply });
    await post("@dev what's 2+2?");
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    expect(await questions()).toEqual([]);
    const request = f.provider.calls[0]?.request as ModelRequest;
    expect(request.tools?.map((t) => t.name)).toContain("ask_user");
    expect(systemText(request.system)).toContain("ambiguous after you have looked with your tools");
    // What not to ask about lives in the tool's own description, read beside the call, not twice in the prompt.
    expect(request.tools?.find((t) => t.name === "ask_user")?.description).toContain(
      "Don't ask before what you can just do and undo",
    );
  });

  test("a person skips the question: the card says so and the run goes on without an answer", async () => {
    f = await setup({ askUser: true, reply });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    const [q] = await questions();
    const skipped = await dismissQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, q?.id ?? "");
    expect(skipped).toMatchObject({ status: "answered", answer: null, answeredByUserId: f.owner.id, dismissed: true });
    await expect(dismissQuestion({ db: f.db }, f.owner.id, f.org.id, q?.id ?? "")).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(
      answerQuestion({ db: f.db }, f.owner.id, f.org.id, q?.id ?? "", { choice: "staging" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await drainOutbox(f.db, f.handlers);
    expect((await runs())[0]?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("The person skipped this question");
    expect((await questions())[0]?.status).toBe("dismissed");
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.find((m) => m.id === q?.messageId)?.meta.question).toMatchObject({ dismissed: true, answer: null });
  });

  test("a long question is refused with what to do: the explanation goes above the card, which holds a short question", async () => {
    const explanation =
      "A política de privacidade já existe, então esse item não é mais bloqueio. Ainda faltam a classificação de conteúdo, o título, o ícone 512x512 e o AAB assinado. ".repeat(
        3,
      );
    const why = "Preencher o Play Console muda o cadastro do app: a pessoa decide quando começo.";
    f = await setup({
      askUser: true,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("this question is"))
          return {
            chunks: [explanation],
            toolUses: [
              {
                name: "ask_user",
                input: { why, question: "Posso começar a preencher o Play Console?", choices: ["Sim", "Ainda não"] },
              },
            ],
          };
        if (last.includes("tool_result")) return { chunks: ["Ok."] };
        return {
          chunks: [],
          toolUses: [{ name: "ask_user", input: { why, question: `${explanation}Posso fazer isso agora?` } }],
        };
      },
    });
    await post("@dev o que falta para enviar o android pra review?");
    await drainOutbox(f.db, f.handlers);

    expect(lastText(f.provider.calls[1]?.request as ModelRequest)).toContain(
      `this question is ${`${explanation}Posso fazer isso agora?`.trim().length} characters`,
    );
    const [q] = await questions();
    expect(q).toMatchObject({ text: "Posso começar a preencher o Play Console?", choices: ["Sim", "Ainda não"] });
    // The whole explanation reads first, as a message of its own; nothing of it is cut.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.map((m) => m.body)).toEqual([
      "@dev o que falta para enviar o android pra review?",
      explanation.trim(),
      "Posso começar a preencher o Play Console?",
    ]);
  });

  test("a why longer than a card shows is refused, never cut", async () => {
    f = await setup({
      askUser: true,
      reply: (req) =>
        lastText(req).includes("tool_result")
          ? { chunks: ["Ok."] }
          : {
              chunks: [],
              toolUses: [{ name: "ask_user", input: { why: "x".repeat(1001), question: "Qual ambiente?" } }],
            },
    });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    expect(await questions()).toEqual([]);
    expect(lastText(f.provider.calls[1]?.request as ModelRequest)).toContain("(at most 1000)");
  });

  test("with no answer in 24 hours the run goes on and the model is told", async () => {
    f = await setup({ askUser: true, reply });
    await post("@dev deploy it");
    await drainOutbox(f.db, f.handlers);
    expect(await expireQuestions({ db: f.db, pubsub: f.pubsub })).toBe(0);
    expect(await expireQuestions({ db: f.db, pubsub: f.pubsub }, new Date(Date.now() + 25 * 3600_000))).toBe(1);
    await drainOutbox(f.db, f.handlers);
    const [run] = await runs();
    expect(run?.status).toBe("done");
    expect(lastText(f.provider.calls.at(-1)?.request as ModelRequest)).toContain("No one answered within 24 hours");
    const [q] = await f.db
      .select()
      .from(schema.agentQuestions)
      .where(eq(schema.agentQuestions.runId, run?.id ?? ""));
    expect(q?.status).toBe("expired");
  });
});
