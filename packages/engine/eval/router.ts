/**
 * Router eval (ADR 0074, addendum of 2026-10-31): who answers a message nobody @mentions, in Portuguese,
 * English, Spanish, German, Japanese and Arabic. The agent a message speaks to answers, not one it only names
 * as someone to ask or to tell ("ada pergunta pro theo ai qual meu email mais recente pls" went to Theo, who
 * has the email, on 2026-10-31). News for an agent told to nobody in particular ("someone tell Theo…") goes to
 * that agent, a reply to an agent stays with it unless it speaks to another one, a message that only talks
 * about an agent gets none, a request to nobody in particular 5 or 23 minutes after a talk with an agent goes to
 * that agent unless it clearly fits another one, and what already worked still does (a message to anyone, to
 * every agent, to a person, small talk, a follow-up). Each case goes through the real `routeMessage` (the
 * candidates, what each can use, continuity, the rules after the step) on an in-memory database, in a channel of
 * its own: only the step calls out.
 *
 * Manual, never in CI (it calls the real service and costs a little):
 *
 *   bun --env-file=.env packages/engine/eval/router.ts [--step jev|llm] [--only id,id]
 *
 * Needs `TYPESAFE_API_KEY` (Jev, as in production) or, with `--step llm`, `ANTHROPIC_API_KEY` for the small
 * model (`EVAL_LLM_MODEL`, default claude-haiku-5-5).
 */
import { eq, schema } from "@agenteschat/db";
import { createAnthropicProvider, type ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  createAgent,
  createChannel,
  createJevRouterStrategy,
  createLlmRouterStrategy,
  DEFAULT_ROUTER_POLICY,
  insertMessage,
  type ModelGateway,
  postPersonMessage,
  type RouterStrategy,
  routeMessage,
} from "../src";
import { addMember, setup } from "../test/fixtures";

export interface RouterCase {
  id: string;
  lang: "pt" | "en" | "es" | "de" | "ja" | "ar";
  /**
   * `asks`: to one agent, about another it should ask or tell; `direct`: to that other agent; `anyone`: to
   * nobody in particular; `about`: to nobody in particular, news for an agent; `reply`: a quote reply or a
   * thread reply to an agent's message; `resumed`: to nobody in particular, within half an hour of a talk with an
   * agent; `default`: what the step may give nobody but is for the agents (a complaint to them, a short question
   * after a talk), or clearly isn't (people talking, a thanks). The rest already worked (`person` also when it
   * talks about an agent).
   */
  kind: "asks" | "direct" | "anyone" | "about" | "reply" | "resumed" | "everyone" | "person" | "follow-up" | "default";
  /** The conversation before it, oldest first, a minute apart: "Ana", "Walter" or an agent's "@handle". */
  before?: { from: string; text: string }[];
  /** Minutes between the last line of `before` and the message (default 1). */
  pause?: number;
  /** The message quotes this line of `before`. */
  replyTo?: number;
  /** The message, and the lines of `before` after its first, go in the thread of that first line. */
  thread?: boolean;
  /** What Ana writes, with no @mention. */
  message: string;
  /** Exactly these answer ([]: nobody). */
  answers: string[];
}

/** The agents of every case's channel, with Ana and Walter: what each does and the apps it can use. */
export const TEAM = [
  {
    name: "Ada",
    handle: "ada",
    role: "Engenheira de software",
    instructions: "Você cuida do código do app: lê o repositório, abre PRs e corrige bugs.",
    apps: ["GitHub"],
  },
  {
    name: "Theo",
    handle: "theo",
    role: "Assistente executivo",
    instructions: "Você cuida da caixa de entrada, da agenda e dos contatos da Ana.",
    apps: ["Gmail", "Google Calendar"],
  },
  {
    name: "Atlas",
    handle: "atlas",
    role: "Observabilidade",
    instructions: "Você acompanha os erros e as métricas de produção e avisa quando algo quebra.",
    apps: ["Sentry"],
  },
];

const ALL = TEAM.map((a) => a.handle);

export const ROUTER_CASES: RouterCase[] = [
  // The day it went wrong, and the same right after Theo spoke (the follow-up rule must not give it back to him).
  {
    id: "pt-production",
    lang: "pt",
    kind: "asks",
    message: "ada pergunta pro theo ai qual meu email mais recente pls",
    answers: ["ada"],
  },
  {
    id: "pt-production-after-theo",
    lang: "pt",
    kind: "asks",
    before: [
      { from: "Ana", text: "theo, bom dia" },
      { from: "@theo", text: "Bom dia, Ana! Em que posso ajudar?" },
    ],
    message: "ada, pergunta pro theo qual meu email mais recente",
    answers: ["ada"],
  },

  {
    id: "pt-asks",
    lang: "pt",
    kind: "asks",
    message: "Ada, pergunta pro Theo se o cliente já respondeu o email do contrato",
    answers: ["ada"],
  },
  {
    id: "pt-direct",
    lang: "pt",
    kind: "direct",
    message: "Theo, o cliente já respondeu o email do contrato?",
    answers: ["theo"],
  },
  {
    id: "pt-anyone",
    lang: "pt",
    kind: "anyone",
    message: "Alguém consegue ver se o cliente respondeu o email do contrato?",
    answers: ["theo"],
  },
  {
    id: "pt-about",
    lang: "pt",
    kind: "about",
    message: "Alguém avisa o Theo que a reunião com o cliente mudou para as 15h",
    answers: ["theo"],
  },
  {
    id: "pt-asks-tell",
    lang: "pt",
    kind: "asks",
    message: "Atlas, avisa a Ada que o erro do checkout voltou",
    answers: ["atlas"],
  },

  {
    id: "en-asks",
    lang: "en",
    kind: "asks",
    message: "Ada, can you ask Theo what's on my calendar tomorrow morning?",
    answers: ["ada"],
  },
  {
    id: "en-direct",
    lang: "en",
    kind: "direct",
    message: "Theo, what's on my calendar tomorrow morning?",
    answers: ["theo"],
  },
  {
    id: "en-anyone",
    lang: "en",
    kind: "anyone",
    message: "Can someone check what's on my calendar tomorrow morning?",
    answers: ["theo"],
  },
  {
    id: "en-about",
    lang: "en",
    kind: "about",
    message: "Someone let Theo know the client call moved to 3pm",
    answers: ["theo"],
  },
  {
    id: "en-asks-other",
    lang: "en",
    kind: "asks",
    message: "Theo, ask Atlas whether the checkout errors from this morning are back",
    answers: ["theo"],
  },

  {
    id: "es-asks",
    lang: "es",
    kind: "asks",
    message: "Ada, pregúntale a Theo si el proveedor ya contestó el correo de la factura",
    answers: ["ada"],
  },
  {
    id: "es-direct",
    lang: "es",
    kind: "direct",
    message: "Theo, ¿el proveedor ya contestó el correo de la factura?",
    answers: ["theo"],
  },
  {
    id: "es-anyone",
    lang: "es",
    kind: "anyone",
    message: "¿Alguien puede revisar si el proveedor contestó el correo de la factura?",
    answers: ["theo"],
  },
  {
    id: "es-about",
    lang: "es",
    kind: "about",
    message: "Que alguien le diga a Theo que la reunión con el proveedor pasó al jueves",
    answers: ["theo"],
  },

  {
    id: "de-asks",
    lang: "de",
    kind: "asks",
    message: "Ada, frag bitte Theo, ob die Rechnung vom Lieferanten schon per Mail gekommen ist",
    answers: ["ada"],
  },
  {
    id: "de-direct",
    lang: "de",
    kind: "direct",
    message: "Theo, ist die Rechnung vom Lieferanten schon per Mail gekommen?",
    answers: ["theo"],
  },
  {
    id: "de-anyone",
    lang: "de",
    kind: "anyone",
    message: "Kann mal jemand nachsehen, ob die Rechnung vom Lieferanten per Mail gekommen ist?",
    answers: ["theo"],
  },
  {
    id: "de-about",
    lang: "de",
    kind: "about",
    message: "Kann jemand Theo sagen, dass das Kundenmeeting auf 15 Uhr verschoben wurde?",
    answers: ["theo"],
  },
  {
    id: "de-asks-tell",
    lang: "de",
    kind: "asks",
    message: "Atlas, sag Ada bitte, dass der Checkout-Fehler wieder da ist",
    answers: ["atlas"],
  },

  {
    id: "ja-asks",
    lang: "ja",
    kind: "asks",
    message: "Adaさん、Theoさんに明日の午前の予定を聞いてもらえますか？",
    answers: ["ada"],
  },
  {
    id: "ja-direct",
    lang: "ja",
    kind: "direct",
    message: "Theoさん、明日の午前の予定を教えてください",
    answers: ["theo"],
  },
  {
    id: "ja-anyone",
    lang: "ja",
    kind: "anyone",
    message: "誰か明日の午前の予定を確認してもらえますか？",
    answers: ["theo"],
  },
  {
    id: "ja-about",
    lang: "ja",
    kind: "about",
    message: "誰かTheoさんに、顧客との打ち合わせが15時に変更になったと伝えてください",
    answers: ["theo"],
  },
  {
    id: "ja-asks-other",
    lang: "ja",
    kind: "asks",
    message: "Theoさん、今朝のチェックアウトのエラーがまた出ていないかAtlasさんに聞いてください",
    answers: ["theo"],
  },

  {
    id: "ar-asks",
    lang: "ar",
    kind: "asks",
    message: "Ada، اسألي Theo إن كان العميل قد رد على رسالة العقد",
    answers: ["ada"],
  },
  {
    id: "ar-direct",
    lang: "ar",
    kind: "direct",
    message: "Theo، هل رد العميل على رسالة العقد؟",
    answers: ["theo"],
  },
  {
    id: "ar-anyone",
    lang: "ar",
    kind: "anyone",
    message: "هل يستطيع أحد أن يتحقق إن كان العميل قد رد على رسالة العقد؟",
    answers: ["theo"],
  },
  {
    id: "ar-about",
    lang: "ar",
    kind: "about",
    message: "ليخبر أحدكم Theo أن اجتماع العميل تأجل إلى الساعة الثالثة",
    answers: ["theo"],
  },

  // A reply stays with the agent replied to, unless it speaks to another one.
  {
    id: "pt-reply-hand-over",
    lang: "pt",
    kind: "reply",
    before: [{ from: "@theo", text: "Resumo de hoje: 3 emails novos do cliente, e o deploy de ontem falhou no CI." }],
    replyTo: 0,
    message: "isso do deploy é com a ada",
    answers: ["theo"],
  },
  {
    id: "en-thread-asks",
    lang: "en",
    kind: "reply",
    before: [
      { from: "@theo", text: "Today's summary: 3 new emails from the client, and yesterday's deploy failed in CI." },
    ],
    thread: true,
    message: "Ada, the deploy failure is yours: can you check the CI logs?",
    answers: ["ada"],
  },

  // 23 minutes after a talk with Ada, past the continuity window, a request any agent could do is still hers: it
  // went to Theo, 0.63 to her 0.55, on 2026-10-31. So it is 5 minutes after, while she is the agent just talking,
  // though it is no short follow-up. A request that clearly fits another agent's role goes to that agent.
  {
    id: "pt-last-talked-to",
    lang: "pt",
    kind: "resumed",
    before: [
      { from: "Ana", text: "ada quanto ta seu limite de uso?" },
      { from: "@ada", text: "Ana, não consigo consultar meu saldo de uso por aqui: não aparece quanto já consumi." },
    ],
    pause: 23,
    message: "me de bom dia todo dia ás 8:30 da manha",
    answers: ["ada"],
  },
  {
    id: "pt-last-talked-to-soon",
    lang: "pt",
    kind: "resumed",
    before: [
      { from: "Ana", text: "ada quanto ta seu limite de uso?" },
      { from: "@ada", text: "Ana, não consigo consultar meu saldo de uso por aqui: não aparece quanto já consumi." },
    ],
    pause: 5,
    message: "me de bom dia todo dia ás 8:30 da manha",
    answers: ["ada"],
  },
  {
    id: "pt-last-talked-to-clear-fit",
    lang: "pt",
    kind: "resumed",
    before: [
      { from: "Ana", text: "theo, o que tenho na agenda amanhã?" },
      { from: "@theo", text: "Amanhã: reunião com a Lumen às 10h e dentista às 15h." },
    ],
    pause: 23,
    message: "escreve um script em python que conta as linhas de um csv",
    answers: ["ada"],
  },

  // What already worked, and the day's case mirrored: a follow-up that names another agent to ask is still for
  // the agent just talking.
  {
    id: "pt-follow-up-asks-other",
    lang: "pt",
    kind: "follow-up",
    before: [
      { from: "Ana", text: "Theo, o cliente respondeu o email do contrato?" },
      { from: "@theo", text: "Ainda não, Ana. O último email dele é de segunda." },
    ],
    message: "pergunta pra Ada se o PR do contrato já subiu",
    answers: ["theo"],
  },
  {
    id: "en-follow-up-asks-other",
    lang: "en",
    kind: "follow-up",
    before: [
      { from: "Ana", text: "Theo, did the client answer the contract email?" },
      { from: "@theo", text: "Not yet, Ana. Their last email is from Monday." },
    ],
    message: "ask Ada whether the contract PR is merged",
    answers: ["theo"],
  },
  {
    id: "pt-person-about-agent",
    lang: "pt",
    kind: "person",
    message: "Walter, a Ada já terminou o relatório?",
    answers: [],
  },
  {
    id: "en-room-about-agent",
    lang: "en",
    kind: "person",
    before: [{ from: "Walter", text: "the client loved the summary this morning" }],
    message: "yeah, Theo did a great job with it",
    answers: [],
  },
  {
    id: "pt-everyone",
    lang: "pt",
    kind: "everyone",
    message: "Agentes, cada um me diz em uma frase no que está trabalhando agora",
    answers: ALL,
  },
  {
    id: "en-everyone",
    lang: "en",
    kind: "everyone",
    message: "Agents, each of you tell me in one line what you're working on right now",
    answers: ALL,
  },
  // Each about themselves, then one fact they share right after (a workspace's agents share its computer).
  {
    id: "pt-everyone-own-limit",
    lang: "pt",
    kind: "everyone",
    message: "como tá o limite de uso de vocês?",
    answers: ALL,
  },
  {
    id: "en-everyone-own-limit",
    lang: "en",
    kind: "everyone",
    message: "how are your usage limits looking, all of you?",
    answers: ALL,
  },
  {
    id: "pt-shared-machine",
    lang: "pt",
    kind: "anyone",
    before: [
      { from: "Ana", text: "como tá o limite de uso de vocês?" },
      { from: "@ada", text: "Usei 40% do meu limite da semana." },
      { from: "@theo", text: "Estou em 15% do meu." },
      { from: "@atlas", text: "Uns 20% por aqui." },
    ],
    message: "quanto de cpu e ram nossa máquina tá usando agora?",
    answers: ["atlas"],
  },
  {
    id: "en-shared-machine",
    lang: "en",
    kind: "anyone",
    before: [
      { from: "Ana", text: "how are your usage limits looking, all of you?" },
      { from: "@ada", text: "I've used 40% of my weekly limit." },
      { from: "@theo", text: "About 15% of mine." },
      { from: "@atlas", text: "Around 20% here." },
    ],
    message: "how much cpu and ram is our machine using right now?",
    answers: ["atlas"],
  },
  // The same follow-up sent while every agent is still on the first question, before any reply.
  {
    id: "pt-shared-machine-mid-run",
    lang: "pt",
    kind: "anyone",
    before: [{ from: "Ana", text: "como tá o limite de uso de vocês?" }],
    message: "quanto de cpu e ram nossa máquina tá usando agora?",
    answers: ["atlas"],
  },
  {
    id: "en-shared-machine-mid-run",
    lang: "en",
    kind: "anyone",
    before: [{ from: "Ana", text: "how are your usage limits looking, all of you?" }],
    message: "how much cpu and ram is our machine using right now?",
    answers: ["atlas"],
  },
  {
    id: "pt-person",
    lang: "pt",
    kind: "person",
    message: "Walter, você vai na reunião das 15h?",
    answers: [],
  },
  {
    id: "en-small-talk",
    lang: "en",
    kind: "person",
    before: [{ from: "Walter", text: "anyone watching the game tonight?" }],
    message: "haha yes, wouldn't miss it",
    answers: [],
  },
  {
    id: "pt-follow-up",
    lang: "pt",
    kind: "follow-up",
    before: [
      { from: "Ana", text: "Theo, o que tenho na agenda amanhã?" },
      { from: "@theo", text: "Amanhã: reunião com a Lumen às 10h e dentista às 15h." },
    ],
    message: "e na sexta?",
    answers: ["theo"],
  },
  {
    id: "en-follow-up",
    lang: "en",
    kind: "follow-up",
    before: [
      { from: "Ana", text: "Atlas, any new errors in Sentry since the deploy?" },
      { from: "@atlas", text: "Two new ones in checkout, both since api@3.8.0." },
    ],
    message: "which one hits more people?",
    answers: ["atlas"],
  },
  // A message for the agents always gets one (ADR 0074, R5), and people talking among themselves still get none.
  {
    id: "pt-default-complaint",
    lang: "pt",
    kind: "default",
    before: [
      { from: "Ana", text: "Ada, olha o build do app que quebrou" },
      { from: "@ada", text: "Olhei, é o teste de login que falha desde ontem." },
    ],
    pause: 5,
    message: "Eu mesmo peguei e corrigi tudo aqui no meu computador, vocês se enrolaram muito.",
    answers: ["ada"],
  },
  {
    id: "pt-default-followup-question",
    lang: "pt",
    kind: "default",
    before: [
      { from: "Ana", text: "Ada, olha o build do app que quebrou" },
      { from: "@ada", text: "Olhei, é o teste de login que falha desde ontem. Vou corrigir." },
    ],
    pause: 4,
    message: "E aí, conseguiram?",
    answers: ["ada"],
  },
  {
    id: "pt-default-people-talking",
    lang: "pt",
    kind: "default",
    before: [{ from: "Walter", text: "Ana, consegue revisar o contrato até amanhã?" }],
    message: "consigo sim, de manhã eu vejo",
    answers: [],
  },
  {
    id: "en-default-to-room",
    lang: "en",
    kind: "default",
    message: "did any of you see what broke in production this morning?",
    answers: ["atlas"],
  },
  {
    id: "pt-default-ack",
    lang: "pt",
    kind: "default",
    before: [
      { from: "Ana", text: "Theo, o que tenho na agenda amanhã?" },
      { from: "@theo", text: "Amanhã: reunião com a Lumen às 10h." },
    ],
    message: "valeu",
    answers: [],
  },
];

export interface RouterCaseResult {
  c: RouterCase;
  ok: boolean;
  /** Handles of the agents it went to. */
  picked: string[];
  /** Every agent's score, by handle. */
  scores: Record<string, number>;
  reason: string | null;
}

/** One in-memory workspace with Ana, Walter and `TEAM`; `run` routes a case with the step given. */
export async function routerEval() {
  const f = await setup();
  await f.db.update(schema.users).set({ name: "Ana" }).where(eq(schema.users.id, f.owner.id));
  const walter = await addMember(f.db, f.org.id, "member", "Walter");
  const ids = new Map<string, string>();
  for (const a of TEAM) {
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: a.name, handle: a.handle, role: a.role, instructions: a.instructions, credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    ids.set(a.handle, agent.id);
    for (const label of a.apps) {
      const [connection] = await f.db
        .insert(schema.connectorConnections)
        .values({
          orgId: f.org.id,
          connector: label.toLowerCase().replaceAll(" ", "-"),
          toolPrefix: label.toLowerCase().replaceAll(" ", "_"),
          label,
          serverUrl: "https://mcp.example.com",
          authType: "none",
        })
        .returning();
      await f.db
        .insert(schema.agentScopes)
        .values({ orgId: f.org.id, agentId: agent.id, connectionId: connection?.id, scope: "connector:*" });
    }
  }
  const handleOf = new Map([...ids].map(([handle, id]) => [id, handle]));
  let n = 0;

  async function run(c: RouterCase, strategy: RouterStrategy): Promise<RouterCaseResult> {
    n += 1;
    const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: `team-${n}` });
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { userId: walter.id });
    for (const id of ids.values()) await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: id });
    const now = Date.now();
    const lines = c.before ?? [];
    const posted: string[] = [];
    for (const [i, line] of lines.entries()) {
      const agentId = line.from.startsWith("@") ? ids.get(line.from.slice(1)) : undefined;
      const m = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: channel.id,
        threadId: c.thread && i > 0 ? posted[0] : null,
        author: agentId
          ? { type: "agent", agentId, runId: null, hop: 1, stretchId: null }
          : { type: "person", userId: line.from === "Walter" ? walter.id : f.owner.id },
        body: line.text,
        createdAt: new Date(now - (lines.length - 1 - i + (c.pause ?? 1)) * 60_000),
      });
      posted.push(m.id);
    }
    // As a person posts it, so a quote reply carries the quote it does in production.
    const message = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channel.id, {
      body: c.message,
      threadId: c.thread ? posted[0] : null,
      replyTo: c.replyTo === undefined ? null : posted[c.replyTo],
    });
    const routed = await routeMessage(
      { db: f.db, strategy, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 } },
      { orgId: f.org.id, messageId: message.id },
    );
    const [decision] = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.messageId, message.id));
    const picked = (routed.selected ?? []).map((id) => handleOf.get(id) ?? id);
    const scores = Object.fromEntries(
      (decision?.candidates ?? []).map((s) => [handleOf.get(s.agentId) ?? s.agentId, Math.round(s.score * 100) / 100]),
    );
    const ok = [...picked].sort().join() === [...c.answers].sort().join();
    return { c, ok, picked, scores, reason: decision?.reason ?? decision?.error ?? null };
  }

  return { run, close: () => f.close() };
}

if (import.meta.main) {
  const arg = (name: string) =>
    process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const step = arg("--step") ?? "jev";
  const only = arg("--only")?.split(",");
  let strategy: RouterStrategy;
  if (step === "jev") {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error("TYPESAFE_API_KEY is missing (or run with --step llm)");
    strategy = createJevRouterStrategy({ key, recordUsage: async () => {}, timeoutMs: 10_000 });
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing");
    const provider = createAnthropicProvider();
    const model = process.env.EVAL_LLM_MODEL ?? "claude-haiku-5-5";
    strategy = createLlmRouterStrategy({
      gateway: {
        complete: (call: ModelRequest) => provider.stream(call, { apiKey, onDelta: () => {} }),
      } as unknown as ModelGateway,
      resolveModel: async () => model,
    });
  }
  const cases = ROUTER_CASES.filter((c) => !only || only.includes(c.id));
  const evaluation = await routerEval();
  let right = 0;
  for (const c of cases) {
    const r = await evaluation.run(c, strategy);
    if (r.ok) right++;
    const scores = Object.entries(r.scores)
      .map(([h, s]) => `${h} ${s.toFixed(2)}`)
      .join(" · ");
    const want = c.answers.join(", ") || "nobody";
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${c.lang}  ${c.kind.padEnd(9)} ${c.id.padEnd(26)} → ${r.picked.join(", ") || "nobody"} (want ${want})  ${scores}  ${r.reason ?? ""}`,
    );
  }
  await evaluation.close();
  console.log(`\n${right}/${cases.length} right (${step})`);
  process.exit(right === cases.length ? 0 : 1);
}
