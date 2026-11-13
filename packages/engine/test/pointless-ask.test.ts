import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  ASKS_NOTHING,
  answerQuestion,
  drainOutbox,
  FOLLOW_UP_TOOL,
  NOT_A_QUESTION,
  postPersonMessage,
  wakeFollowUp,
} from "../src";
import { repeatedAsk, saysNeedsNothing } from "../src/hand-off";
import { type Fixture, setup } from "./fixtures";

/**
 * A question card that asks the person for nothing the run needs (a status note, an optional offer) never makes the
 * run wait, in any language: `ask_user` refuses it (text with no question mark and no choices by its words alone, an
 * offer by `ask_check` → `none`) and the agent says it in its reply, and a reply read as needing a person but asking
 * for nothing is its answer, never a nudge nor a card. The fake judge reads no words: it answers by the exact text it
 * is shown.
 */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const CASES = {
  pt: {
    question: "Qual canal recebe o post: #geral ou #avisos?",
    note: "Não preciso de nada de você agora. Só entra se você quiser o comunicado também no Portal.",
    offer: "Não preciso de nada de você agora. Quer o comunicado também no Portal?",
  },
  en: {
    question: "Which channel gets the post: #general or #news?",
    note: "I don't need anything from you now. Only if you want the notice on the Portal too.",
    offer: "I don't need anything from you now. Want the notice on the Portal too?",
  },
  ja: {
    question: "投稿はどのチャンネルですか：#general と #news のどちらですか？",
    note: "今はあなたから必要なものはありません。ポータルにも掲載したい場合だけ教えてください。",
    offer: "今はあなたから必要なものはありません。ポータルにも掲載しますか？",
  },
  de: {
    question: "Welcher Kanal bekommt den Beitrag: #general oder #news?",
    note: "Ich brauche gerade nichts von dir. Nur wenn du die Mitteilung auch im Portal willst.",
    offer: "Ich brauche gerade nichts von dir. Willst du die Mitteilung auch im Portal?",
  },
} as const;
const LANGS = Object.keys(CASES) as (keyof typeof CASES)[];
const NOTES: Set<string> = new Set(Object.values(CASES).flatMap((c) => [c.note, c.offer]));
/** The fake `ask_check`: a note or an optional offer asks for nothing, anything else is a person's to answer. */
const askCheck = (state: Record<string, unknown>) => (NOTES.has(String(state.question)) ? "none" : "person");

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
/** The last tool result a model call read. */
const lastResult = (req: ModelRequest | undefined) =>
  (req?.messages ?? [])
    .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    .filter((b) => b.type === "tool_result")
    .at(-1);
const WHY = "I need a person's answer before I go on: this decides what I change next.";
const DONE = "Pronto: o post das 9h está agendado.";

const runs = () => f.db.select().from(schema.agentRuns);
const questions = () => f.db.select().from(schema.agentQuestions);
const judged = (kind: string) =>
  (f.context.judge as unknown as { calls: { kind: string; state: Record<string, unknown> }[] }).calls.filter(
    (c) => c.kind === kind,
  );
const agentPosts = async () =>
  (await f.db.select().from(schema.messages).orderBy(schema.messages.createdAt))
    .filter((m) => m.authorType === "agent" && !m.meta.notice && !m.meta.questionId)
    .map((m) => m.body);
const say = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

describe("ask_user that asks for nothing", () => {
  for (const lang of LANGS) {
    const { question, note } = CASES[lang];

    test(`${lang}: a status note and an optional offer are refused and go in the reply; the run doesn't wait`, async () => {
      const { offer } = CASES[lang];
      f = await setup({
        askUser: true,
        judge: (kind, _id, state) => (kind === "ask_check" ? askCheck(state) : undefined),
        reply: (_req, call) =>
          call > 2
            ? { chunks: [DONE] }
            : {
                chunks: [DONE],
                toolUses: [{ name: "ask_user", input: { why: WHY, question: call === 1 ? note : offer } }],
              },
      });
      await say("@dev valeu");
      await drainOutbox(f.db, f.handlers);
      expect(await questions()).toHaveLength(0);
      expect((await runs()).map((r) => r.status)).toEqual(["done"]);
      // The note asks no question: refused by its words alone, as an error, with no judgment.
      expect(lastResult(f.provider.calls[1]?.request)).toMatchObject({ content: NOT_A_QUESTION, isError: true });
      expect(lastText(f.provider.calls[2]?.request as ModelRequest)).toContain(ASKS_NOTHING.slice(0, 40));
      // The offer asks one: the judge read it, with what it already wrote in that turn.
      expect(judged("ask_check").map((c) => [c.state.question, c.state.reply])).toEqual([[offer, DONE]]);
    });

    test(`${lang}: a real question is still asked and waits`, async () => {
      f = await setup({
        askUser: true,
        judge: (kind, _id, state) => (kind === "ask_check" ? askCheck(state) : undefined),
        reply: () => ({
          chunks: [],
          toolUses: [{ name: "ask_user", input: { why: WHY, question } }],
        }),
      });
      await say("@dev posta o aviso");
      await drainOutbox(f.db, f.handlers);
      expect((await questions()).map((q) => q.text)).toEqual([question]);
      expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
    });

    test(`${lang}: a reply read as needing a person but asking nothing is the answer, no nudge nor card`, async () => {
      f = await setup({
        askUser: true,
        judge: (kind, _id, state) =>
          kind === "follow_through" ? "ask" : kind === "ask_check" ? askCheck(state) : undefined,
        reply: () => ({ chunks: [note] }),
      });
      await say("@dev valeu");
      await drainOutbox(f.db, f.handlers);
      expect(f.provider.calls).toHaveLength(1);
      expect(await questions()).toHaveLength(0);
      expect(await agentPosts()).toEqual([note]);
      expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    });
  }

  test("a described need still gets its nudge, then becomes the question card", async () => {
    const { question } = CASES.de;
    f = await setup({
      askUser: true,
      judge: (kind, _id, state) =>
        kind === "follow_through" ? "ask" : kind === "ask_check" ? askCheck(state) : undefined,
      reply: () => ({ chunks: [question] }),
    });
    await say("@dev posta o aviso");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(2);
    expect((await questions()).map((q) => q.text)).toEqual([question]);
    expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
  });

  test("a promise repeated with nothing to ask ends the run: no card, nothing to skip", async () => {
    const { note } = CASES.pt;
    f = await setup({
      askUser: true,
      judge: (kind, _id, state) =>
        kind === "follow_through" ? "continue" : kind === "ask_check" ? askCheck(state) : undefined,
      reply: () => ({ chunks: [note] }),
    });
    await say("@dev valeu");
    await drainOutbox(f.db, f.handlers);
    expect(await questions()).toHaveLength(0);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
  });

  test("the judge failing posts the card (fail open), but never one that says it needs nothing", async () => {
    const asks = (question: string) => ({
      askUser: true,
      judge: (kind: string) => {
        if (kind === "ask_check") throw new Error("judge unavailable");
        return undefined;
      },
      reply: (req: ModelRequest) =>
        lastText(req).includes("tool_result")
          ? { chunks: [DONE] }
          : { chunks: [], toolUses: [{ name: "ask_user", input: { why: WHY, question } }] },
    });
    f = await setup(asks(CASES.en.question));
    await say("@dev valeu");
    await drainOutbox(f.db, f.handlers);
    expect((await questions()).map((q) => q.text)).toEqual([CASES.en.question]);
    expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
    await f.close();
    f = await setup(asks(CASES.en.note));
    await say("@dev valeu");
    await drainOutbox(f.db, f.handlers);
    expect(await questions()).toHaveLength(0);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
  });
});

describe("a question card asks something: a question mark in any script, or choices to pick from", () => {
  const STATUS =
    "Abri os PRs #12 e #13 com a correção do login, e os testes passaram nos dois. O que falta depende de vocês: o merge dos PRs e o acesso de escrita ao repositório de infraestrutura.";
  const NOTHING_PENDING =
    "Não tenho mais nada pendente aqui. O que falta já está dito acima e depende de vocês: o merge dos PRs e o acesso ao repositório.";
  /** Judgments that read the list of what is left as a need only a person can fill. */
  const needsPerson = (kind: string) =>
    kind === "follow_through" ? "ask" : kind === "ask_check" ? "person" : undefined;
  /** The question check alone, letting every question through. */
  const letThrough = (kind: string) => (kind === "ask_check" ? "person" : undefined);
  const asking = (input: Record<string, unknown>) => () => ({
    chunks: [],
    toolUses: [{ name: "ask_user", input: { why: WHY, ...input } }],
  });

  test("a statement is refused before any judgment: no card, and the run reads why", async () => {
    f = await setup({
      askUser: true,
      judge: letThrough,
      reply: (req) =>
        lastText(req).includes("tool_result")
          ? { chunks: [] }
          : { chunks: [STATUS], toolUses: [{ name: "ask_user", input: { why: WHY, question: NOTHING_PENDING } }] },
    });
    await say("@dev como estão os PRs do login?");
    await drainOutbox(f.db, f.handlers);
    expect(await questions()).toHaveLength(0);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    expect(lastResult(f.provider.calls[1]?.request)).toMatchObject({ content: NOT_A_QUESTION, isError: true });
    expect(judged("ask_check")).toHaveLength(0);
    expect(await agentPosts()).toEqual([STATUS]);
  });

  test.each([
    ["a question mark", "Posso fazer o merge dos dois PRs agora?"],
    ["the Spanish ¿ alone", "¿Hago el merge de los dos PRs ahora"],
    ["the full-width ？", "2つのPRを今マージしてもいいですか？"],
    ["the Arabic ؟", "هل أدمج الآن؟"],
  ])("a real question is asked: %s", async (_, question) => {
    f = await setup({ askUser: true, judge: letThrough, reply: asking({ question }) });
    await say("@dev e os PRs?");
    await drainOutbox(f.db, f.handlers);
    expect((await questions()).map((q) => q.text)).toEqual([question]);
    expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
  });

  test("a choice list with no question mark is asked", async () => {
    const choices = ["staging", "produção"];
    f = await setup({ askUser: true, judge: letThrough, reply: asking({ question: "Escolha o ambiente", choices }) });
    await say("@dev faz o deploy");
    await drainOutbox(f.db, f.handlers);
    expect((await questions()).map((q) => [q.text, q.choices])).toEqual([["Escolha o ambiente", choices]]);
    expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
  });

  test("told to ask with nothing pending, a reply that asks nothing is its answer: no card", async () => {
    f = await setup({
      askUser: true,
      judge: needsPerson,
      reply: (_req, call) => ({ chunks: [call === 1 ? STATUS : NOTHING_PENDING] }),
    });
    await say("@dev como estão os PRs do login?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(2);
    // Told once to ask, and how to end when it needs nothing.
    expect(lastText(f.provider.calls[1]?.request as ModelRequest)).toContain(
      "end your turn without writing anything more",
    );
    expect(await questions()).toHaveLength(0);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    expect(await agentPosts()).toEqual([STATUS, NOTHING_PENDING]);
    // No judgment spent on a card it never makes.
    expect(judged("ask_check").map((c) => c.state.question)).toEqual([STATUS]);
  });
});

describe("ask_user can't repeat itself", () => {
  /** The run's questions in the order it asks them, then its answer. */
  const asking = (texts: string[]) => {
    let n = 0;
    return (): { chunks: string[]; toolUses?: { name: string; input: Record<string, unknown> }[] } => {
      const question = texts[n++];
      return question
        ? { chunks: [], toolUses: [{ name: "ask_user", input: { why: WHY, question } }] }
        : { chunks: [DONE] };
    };
  };
  const answer = async (body: string) => {
    const [open] = (await questions()).filter((q) => q.status === "open");
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, open?.id as string, { text: body });
    await drainOutbox(f.db, f.handlers);
  };

  test("the same question or nearly the same gets no card: the run reads what came of the first", async () => {
    const first = "Posso publicar o aviso no canal geral agora mesmo ou prefere esperar até amanhã cedo?";
    const again = "Posso publicar o aviso no canal geral agora mesmo, ou prefere esperar até amanhã bem cedo?";
    f = await setup({ askUser: true, reply: asking([first, again]) });
    await say("@dev posta o aviso");
    await drainOutbox(f.db, f.handlers);
    expect((await questions()).map((q) => q.status)).toEqual(["open"]);
    await answer("agora");
    expect((await questions()).map((q) => q.text)).toEqual([first]);
    expect((await runs()).map((r) => r.status)).toEqual(["done"]);
    const told = JSON.stringify(f.provider.calls.at(-1)?.request.messages);
    expect(told).toContain("you already asked this in this run");
    expect(told).toContain("The person answered: agora");
  });

  test("a different question in the same run is still asked", async () => {
    const [a, b] = ["Qual ambiente: staging ou produção?", "Quem aprova o deploy de hoje?"];
    f = await setup({ askUser: true, reply: asking([a, b]) });
    await say("@dev faz o deploy");
    await drainOutbox(f.db, f.handlers);
    await answer("staging");
    expect((await questions()).map((q) => q.text)).toEqual([a, b]);
    expect((await runs()).map((r) => r.status)).toEqual(["waiting_input"]);
  });

  test.each([
    [
      "one word apart",
      "Aprovo o orçamento do projeto de reforma da loja 3?",
      "Aprovo o orçamento do projeto de reforma da loja 4?",
    ],
    [
      "the same words the other way",
      "Apago o arquivo antigo e mantenho o novo?",
      "Apago o arquivo novo e mantenho o antigo?",
    ],
    [
      "long, and apart only at the end",
      `Ao abrir a planilha de custos do trimestre, ${"a coluna de notas e as datas de cada entrega ".repeat(4)}batem com o contrato da Acme?`,
      `Ao abrir a planilha de custos do trimestre, ${"a coluna de notas e as datas de cada entrega ".repeat(4)}batem com o pedido da Zeta?`,
    ],
  ])("a real, different question is still asked: %s", async (_, a, b) => {
    f = await setup({ askUser: true, reply: asking([a, b]) });
    await say("@dev confere pra mim");
    await drainOutbox(f.db, f.handlers);
    await answer("sim");
    expect((await questions()).map((q) => q.text)).toEqual([a, b]);
  });

  test("a question still open reads as open, not as one nobody answered", async () => {
    const asked = "Qual ambiente: staging ou produção?";
    f = await setup({ askUser: true, reply: asking([asked]) });
    await say("@dev faz o deploy");
    await drainOutbox(f.db, f.handlers);
    const [run] = await runs();
    const told = await repeatedAsk(f.db, { id: run?.id as string, orgId: f.org.id }, asked);
    expect(told).toContain("still open");
    expect(told).not.toContain("24 hours");
  });

  test("needing nothing but something is a need, in any of the words", () => {
    for (const text of [
      "Não preciso de nada além do seu ok para publicar.",
      "Não preciso de nada seu, só do arquivo final.",
      "I don't need anything but your approval to ship it.",
      "No necesito nada más que tu visto bueno.",
      "Ich brauche nichts außer deiner Freigabe.",
    ])
      expect(saysNeedsNothing(text)).toBe(false);
    expect(saysNeedsNothing("Não preciso de nada seu. A rolagem continua e volto às 11:20")).toBe(true);
    expect(saysNeedsNothing("I don't need anything from you. It keeps running and I'm back at 11:20.")).toBe(true);
  });

  test("a note that says it needs nothing but asks something is a question", async () => {
    const question = "Não preciso de nada do Portal, mas qual canal recebe o post?";
    f = await setup({ askUser: true, reply: asking([question]) });
    await say("@dev posta o aviso");
    await drainOutbox(f.db, f.handlers);
    expect((await questions()).map((q) => q.text)).toEqual([question]);
  });
});

describe("a promise that rests on what an earlier run set", () => {
  const LOOP = "A rolagem continua em segundo plano e eu volto às 11:20 com o resultado.";
  const inThread = (body: string, threadId: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });

  test("a follow-up still to come keeps a repeated promise: no nudge, one post, no card", async () => {
    f = await setup({
      askUser: true,
      followUps: true,
      judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
      reply: (_request, call) =>
        call === 1
          ? {
              chunks: [LOOP],
              toolUses: [{ name: FOLLOW_UP_TOOL, input: { minutes: 13, note: "Ver a rolagem.", about: "a rolagem" } }],
            }
          : { chunks: [LOOP] },
    });
    const root = await say("Rolagem de hoje");
    await inThread("@dev começa a rolagem", root.id);
    await drainOutbox(f.db, f.handlers);
    const before = f.provider.calls.length;
    const posted = (await agentPosts()).length;
    await inThread("@dev e aí?", root.id);
    await drainOutbox(f.db, f.handlers);
    // The follow-up already brings it back: no nudge into a second status.
    expect(f.provider.calls.length).toBe(before + 1);
    expect(await agentPosts()).toHaveLength(posted + 1);
    expect(await questions()).toHaveLength(0);
    expect((await runs()).map((r) => r.status)).toEqual(["done", "done"]);
  });

  test("a follow-up that comes due with nothing left to do stays quiet", async () => {
    f = await setup({
      followUps: true,
      reply: (_request, call) =>
        call === 1
          ? {
              chunks: [LOOP],
              toolUses: [{ name: FOLLOW_UP_TOOL, input: { minutes: 13, note: "Ver a rolagem.", about: "a rolagem" } }],
            }
          : { chunks: call === 2 ? [LOOP] : [] },
    });
    await say("@dev começa a rolagem");
    await drainOutbox(f.db, f.handlers);
    const before = (await agentPosts()).length;
    const lines = (await f.db.select().from(schema.messages)).filter(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up",
    );
    await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, lines[0]?.id as string);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(3);
    expect(await agentPosts()).toHaveLength(before);
    expect((await runs()).map((r) => r.status)).toEqual(["done", "done"]);
  });

  test("a new promise beside long work is still told to act; once told, the wake keeps it", async () => {
    f = await setup({
      askUser: true,
      judge: (kind) => (kind === "follow_through" ? "continue" : kind === "ask_check" ? "none" : undefined),
      reply: () => ({ chunks: [LOOP] }),
    });
    await f.db.insert(schema.agentWorks).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      anchorMessageId: Bun.randomUUIDv7(),
      ownThread: true,
      title: "rolagem",
      status: "live",
      how: "agent",
      lastUpdateAt: new Date(),
    });
    await say("@dev traduz esse texto");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(2);
    expect(JSON.stringify(f.provider.calls[1]?.request.messages)).toContain("You ended saying you would do more");
    expect(await questions()).toHaveLength(0);
  });
});
