import { afterEach, expect } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createRoutine,
  createWebToolSource,
  executeRoutineRun,
  listMessages,
  queueRoutineRun,
  type ToolSource,
  usageSummary,
  WEB_USAGE_PROVIDER,
} from "../../src";
import { routineDeps, routineRow, routineRunRow } from "../routine-fixtures";
import { closeWorlds, type World, world } from "./harness";
import { assertInvariants } from "./invariants";
import { scenario } from "./known";

// Resourceful agents (ADR 0109) against I5 and I6: a run that says it couldn't while it still had ways is told its
// means once, a real blocker or a plain answer is never nudged, and a routine's give-up report is held only once.

afterEach(closeWorlds);

const NEWS = `<div class="result results_links"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.com%2Fbanco-azul">Banco Azul lança cartão novo</a><a class="result__snippet" href="#">O Banco Azul anunciou nesta semana um cartão sem anuidade.</a></div>`;

/** The web source with a fake web: DuckDuckGo answers the news above, every page is a 403. */
const fakeWeb = () =>
  createWebToolSource({
    fetch: async (url) =>
      url.startsWith("https://html.duckduckgo.com/")
        ? new Response(`<html><body>${NEWS}</body></html>`, { status: 200 })
        : new Response("Forbidden", { status: 403 }),
    resolveHost: async () => ["93.184.216.34"],
  });

/** The rubric, as a judge would read it: "couldn't" with fewer than two attempts and no person-only blocker. */
const rubric = (state: Record<string, unknown>) => {
  const reply = String(state.reply);
  const tried = (state.tried ?? []) as string[];
  const gaveUp = /não (tenho|consigo|consegui)/i.test(reply);
  const blocker = /código|senha|pagamento/i.test(reply);
  return gaveUp && !blocker && tried.length < 2 ? "untried" : "done";
};

async function fireRoutine(w: World, handle: string, prompt: string) {
  const routine = await createRoutine(routineDeps(w.f), w.owner.id, w.org.id, {
    name: "Notícias",
    agentId: w.agents[handle]?.id ?? "",
    prompt,
    target: { type: "channel", channelId: w.channelId },
    trigger: { type: "schedule", phrase: "a cada hora" },
  });
  const queued = await queueRoutineRun({ db: w.db }, await routineRow(w.f, routine.id), new Date(), "manual");
  if (!queued) throw new Error("not queued");
  await executeRoutineRun(routineDeps(w.f), queued.id);
  await w.settle();
  return routineRunRow(w.f, queued.id);
}

const untriedSteps = async (w: World) =>
  (await w.steps((await w.runs()).map((r) => r.id))).filter(
    (s) => s.kind === "context" && (s.data as { nudged?: string }).nudged === "untried",
  );

scenario(
  "S54",
  "the weekly news routine that gave up without searching is held once, searches, and posts",
  async () => {
    const w = await world({
      agents: ["rui"],
      setup: { toolSources: [fakeWeb()] },
      judge: { followThrough: rubric },
      script: {
        rui: [
          {
            calls: [{ name: "hand_off", input: { message: "Não tenho ferramenta de busca na web; alguém pesquisa?" } }],
          },
          { calls: [{ name: "web_search", input: { query: "Banco Azul notícias" } }] },
          {
            calls: [
              { name: "hand_off", input: { message: "Resumo da semana: o Banco Azul lançou um cartão sem anuidade." } },
            ],
          },
          { text: "Busquei na web e postei o resumo." },
        ],
      },
    });
    const run = await fireRoutine(w, "rui", "Todo domingo pesquise notícias sobre o Banco Azul e me dê um resumo.");
    expect(run?.status).toBe("reported");
    expect((await w.posts()).map((p) => p.body)).toEqual([
      "Resumo da semana: o Banco Azul lançou um cartão sem anuidade.",
    ]);
    const calls = await w.calls("rui");
    expect(calls.map((c) => c.name)).toEqual(["hand_off", "web_search", "hand_off"]);
    // The held report answers with the nudge, naming the web among its means.
    expect(calls[0]?.result).toContain("Not posted yet");
    expect(calls[0]?.result).toContain("web_search");
    expect(calls[1]?.result).toContain("https://news.example.com/banco-azul");
    // The judge read what the run really has.
    const [held] = w.judgedAs("follow_through");
    expect(((held?.state.means ?? []) as string[]).join(" ")).toContain("web_search");
    expect(String(held?.state.request)).toContain("pesquise notícias sobre o Banco Azul");
    expect(await untriedSteps(w)).toHaveLength(1);
    await assertInvariants(w);
  },
);

scenario("S55", "a routine's second give-up report always posts: the hold is once", async () => {
  const w = await world({
    agents: ["rui"],
    setup: { toolSources: [fakeWeb()] },
    judge: { followThrough: () => "untried" },
    script: {
      rui: [
        { calls: [{ name: "hand_off", input: { message: "Não consegui as notícias." } }] },
        { calls: [{ name: "hand_off", input: { message: "Não consegui as notícias desta semana." } }] },
        { text: "Relatado." },
      ],
    },
  });
  const run = await fireRoutine(w, "rui", "Pesquise notícias sobre o Banco Azul.");
  expect(run?.status).toBe("reported");
  expect((await w.posts()).map((p) => p.body)).toEqual(["Não consegui as notícias desta semana."]);
  // One judgment for the first report; the second posts without one, and the run's turn end doesn't judge again.
  expect(w.judgedAs("follow_through")).toHaveLength(1);
  expect(await untriedSteps(w)).toHaveLength(1);
  await assertInvariants(w);
});

scenario("S56", "a 'couldn't' with one empty attempt is told its means once, then answers", async () => {
  const w = await world({
    agents: ["rui"],
    setup: { toolSources: [fakeWeb()] },
    judge: { followThrough: rubric },
    script: {
      rui: [
        { calls: [{ name: "web_fetch", input: { url: "https://www.google.com/search?q=banco+azul" } }] },
        { text: "Não consigo pesquisar: o Google bloqueou." },
        { calls: [{ name: "web_search", input: { query: "Banco Azul notícias" } }] },
        { text: "O Banco Azul lançou um cartão sem anuidade nesta semana." },
      ],
    },
  });
  await w.say("@rui quais as notícias do Banco Azul?");
  await w.settle();
  expect((await w.calls("rui")).map((c) => [c.name, c.isError])).toEqual([
    ["web_fetch", true],
    ["web_search", false],
  ]);
  const [first] = w.judgedAs("follow_through");
  expect(first?.state.tried).toEqual([
    expect.stringContaining("web_fetch(https://www.google.com/search?q=banco+azul) → failed"),
  ]);
  // Its next turn read the nudge with its means.
  expect(
    w.f.provider.calls.some((c) => JSON.stringify(c.request.messages).includes("You ended saying you couldn't")),
  ).toBe(true);
  // The give-up the judge held is never posted: only the answer is.
  expect((await w.posts("rui")).map((p) => p.body)).toEqual([
    "O Banco Azul lançou um cartão sem anuidade nesta semana.",
  ]);
  expect(await untriedSteps(w)).toHaveLength(1);
  // A web call's usage row is no model call: the reply still names the model, the summary counts model calls only.
  const [run] = await w.runs();
  const before = await usageSummary(w.f.db, w.owner.id, w.org.id);
  await w.f.gateway.recordExternalUsage({
    orgId: w.org.id,
    agentId: run?.agentId,
    runId: run?.id,
    kind: "agent",
    provider: WEB_USAGE_PROVIDER,
    model: "fetch",
    inputTokens: 0,
    outputTokens: 0,
    costNanoUsd: 0,
  });
  const answer = (await listMessages(w.f.db, w.owner.id, w.org.id, w.channelId)).find((m) => m.agentRunId === run?.id);
  expect(answer?.usage?.model).toStartWith("claude-");
  expect(await usageSummary(w.f.db, w.owner.id, w.org.id)).toEqual(before);
  await assertInvariants(w);
});

scenario("S57", "a blocker only a person can clear, after real attempts, is not nudged", async () => {
  const w = await world({
    agents: ["rui"],
    setup: { toolSources: [fakeWeb()] },
    judge: { followThrough: rubric },
    script: {
      rui: [
        { calls: [{ name: "web_fetch", input: { url: "https://banco.example.com/extrato" } }] },
        {
          text: "Não consegui abrir o extrato: o site pede o código de verificação que chega no seu celular. Tentei o site direto. Me passe o código.",
        },
      ],
    },
  });
  await w.say("@rui pega o extrato do mês no site do banco");
  await w.settle();
  expect(w.prompts("rui")).toHaveLength(2);
  expect(await untriedSteps(w)).toHaveLength(0);
  await assertInvariants(w);
});

scenario("S58", "a plain answer with nothing in the way gets no nudge and no extra turn", async () => {
  const w = await world({
    agents: ["rui"],
    setup: { toolSources: [fakeWeb()] },
    judge: { followThrough: rubric },
    script: { rui: [{ text: "Domingo às 9h, como combinado." }] },
  });
  await w.say("@rui que horas sai o resumo?");
  await w.settle();
  expect(w.prompts("rui")).toHaveLength(1);
  expect(await untriedSteps(w)).toHaveLength(0);
  await assertInvariants(w);
});

// A question to a person goes through the same check (ADR 0109 addendum): one for what the agent could find is held
// once with its means, a secret asked in the chat is turned to the secure request, and a person's own question goes.

const API_DOCS =
  "<h1>Acme Ledger API</h1><p>Base URL: https://api.acme-ledger.example/v1</p><p>Authentication: Authorization: Bearer YOUR_KEY.</p><p>GET /usage?product=jev returns spend in USD by day for one product.</p>";

/** A fake web with an API's docs: the search finds them, the docs page opens, the API itself wants a key. */
const docsWeb = () =>
  createWebToolSource({
    fetch: async (url) => {
      if (url.startsWith("https://html.duckduckgo.com/"))
        return new Response(
          `<html><body><div class="result results_links"><a class="result__a" href="https://docs.acme-ledger.example/api">Acme Ledger API reference</a><a class="result__snippet" href="#">Base URL, API keys and the usage endpoint.</a></div></body></html>`,
        );
      if (url === "https://docs.acme-ledger.example/api") return new Response(API_DOCS, { status: 200 });
      return new Response('{"error":"missing API key"}', { status: 401 });
    },
    resolveHost: async () => ["93.184.216.34"],
  });

/** The computer's secure request, recorded only (the real one pauses the run on a card). */
const secretRequests: Record<string, unknown>[] = [];
const fakeSecretRequest: ToolSource = {
  name: "secret-request",
  tools: async () => [
    {
      name: "request_secret",
      description: "Ask the person for a secret in a private card.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, purpose: { type: "string" }, target: { enum: ["env", "file"] } },
        required: ["name", "purpose", "target"],
        additionalProperties: false,
      },
      execute: async (input) => {
        secretRequests.push(input);
        return { content: "A secure card was sent; the key arrived." };
      },
    },
  ],
};

/** What a question asks for, as a judge would read it: a key is a secret, an address or a meaning is findable. */
const askRubric = (state: Record<string, unknown>) => {
  const q = String(state.question);
  if (/chave|key|senha/i.test(q)) return "secret" as const;
  if (/endereço|o que .* identifica|address/i.test(q)) return "findable" as const;
  return "person" as const;
};

const questions = (w: World) =>
  w.db.select().from(schema.agentQuestions).where(eq(schema.agentQuestions.orgId, w.org.id));

scenario("S59", "an external API with no connector: reads the docs and asks only for the key, securely", async () => {
  secretRequests.length = 0;
  const w = await world({
    agents: ["ada"],
    setup: { toolSources: [docsWeb(), fakeSecretRequest] },
    judge: { ask: askRubric },
    script: {
      ada: [
        {
          calls: [
            {
              name: "ask_user",
              input: {
                question: 'Qual é o endereço da API do Acme Ledger e o que "jev" identifica nos gastos?',
                why: "Preciso disso para seguir com o pedido da pessoa aqui.",
              },
            },
          ],
        },
        { calls: [{ name: "web_search", input: { query: "Acme Ledger API usage endpoint" } }] },
        { calls: [{ name: "web_fetch", input: { url: "https://docs.acme-ledger.example/api" } }] },
        {
          calls: [
            {
              name: "ask_user",
              input: {
                question: "Me passa a chave da API do Acme Ledger?",
                why: "Preciso disso para seguir com o pedido da pessoa aqui.",
              },
            },
          ],
        },
        {
          calls: [
            {
              name: "request_secret",
              input: { name: "ACME_LEDGER_KEY", purpose: "Ler seus gastos de jev na API", target: "env" },
            },
          ],
        },
        { text: "Achei a API (GET /usage?product=jev). Assim que a chave chegar no cartão seguro, puxo os gastos." },
      ],
    },
  });
  await w.say("@ada puxa meus gastos de jev na api do acme ledger por favor");
  await w.settle();
  const calls = await w.calls("ada");
  expect(calls.map((c) => c.name)).toEqual(["ask_user", "web_search", "web_fetch", "ask_user", "request_secret"]);
  // The findable question is held with its means; the key asked in the chat is turned to the secure request.
  expect(calls[0]?.result).toStartWith("Not asked yet");
  expect(calls[0]?.result).toContain("web_search");
  expect(calls[2]?.result).toContain("https://api.acme-ledger.example/v1");
  expect(calls[3]?.result).toStartWith("Not asked: a secret typed in the chat");
  expect(calls[3]?.result).toContain("request_secret");
  expect(secretRequests.map((r) => r.name)).toEqual(["ACME_LEDGER_KEY"]);
  // No question reached the person, and the judge read the question, the request and what it had tried.
  expect(await questions(w)).toHaveLength(0);
  const [first, second] = w.judgedAs("ask_check");
  expect(String(first?.state.request)).toContain("gastos de jev");
  expect(((first?.state.means ?? []) as string[]).join(" ")).toContain("web_search");
  expect(((second?.state.tried ?? []) as string[]).join(" ")).toContain(
    "web_fetch(https://docs.acme-ledger.example/api)",
  );
  expect((await w.posts("ada")).map((p) => p.body)).toEqual([
    "Achei a API (GET /usage?product=jev). Assim que a chave chegar no cartão seguro, puxo os gastos.",
  ]);
  await assertInvariants(w);
});

scenario("S60", "a truly ambiguous request still gets its one question", async () => {
  const w = await world({
    agents: ["ada"],
    setup: { toolSources: [docsWeb()] },
    judge: { ask: askRubric },
    script: {
      ada: [
        {
          calls: [
            {
              name: "ask_user",
              input: {
                question: "Qual resumo, e para quem?",
                why: "Preciso disso para seguir com o pedido da pessoa aqui.",
              },
            },
          ],
        },
      ],
    },
  });
  await w.say("@ada manda aquele resumo pra ele");
  await w.settle();
  expect((await questions(w)).map((q) => q.text)).toEqual(["Qual resumo, e para quem?"]);
  expect((await w.runs("ada")).map((r) => r.status)).toEqual(["waiting_input"]);
  expect(w.judgedAs("ask_check")).toHaveLength(1);
  await assertInvariants(w);
});

scenario("S61", "a findable question is held once: the second ask goes through", async () => {
  const w = await world({
    agents: ["ada"],
    setup: { toolSources: [docsWeb()] },
    judge: { ask: () => "findable" },
    script: {
      ada: [
        {
          calls: [
            {
              name: "ask_user",
              input: {
                question: "Qual é o endereço da API?",
                why: "Preciso disso para seguir com o pedido da pessoa aqui.",
              },
            },
          ],
        },
        {
          calls: [
            {
              name: "ask_user",
              input: {
                question: "Qual é o endereço da API, já que a busca não achou?",
                why: "Preciso disso para seguir com o pedido da pessoa aqui.",
              },
            },
          ],
        },
      ],
    },
  });
  await w.say("@ada puxa meus gastos na api do acme ledger");
  await w.settle();
  const calls = await w.calls("ada");
  expect(calls[0]?.result).toStartWith("Not asked yet");
  expect((await questions(w)).map((q) => q.text)).toEqual(["Qual é o endereço da API, já que a busca não achou?"]);
  expect((await w.runs("ada")).map((r) => r.status)).toEqual(["waiting_input"]);
  await assertInvariants(w);
});

scenario("S62", "a secret is never asked in the chat, even with no secure request at hand", async () => {
  const w = await world({
    agents: ["ada"],
    setup: { toolSources: [docsWeb()] },
    judge: { ask: askRubric },
    script: {
      ada: [
        {
          calls: [
            {
              name: "ask_user",
              input: {
                question: "Me passa a chave da API do Acme Ledger?",
                why: "Preciso disso para seguir com o pedido da pessoa aqui.",
              },
            },
          ],
        },
        { text: "Preciso da chave da API do Acme Ledger configurada no meu computador para puxar os gastos." },
      ],
    },
  });
  await w.say("@ada puxa meus gastos na api do acme ledger");
  await w.settle();
  const [held] = await w.calls("ada");
  expect(held?.result).toStartWith("Not asked: a secret typed in the chat");
  expect(held?.result).toContain("no secure way");
  expect(await questions(w)).toHaveLength(0);
  await assertInvariants(w);
});

scenario("S63", "the controller never makes a question card of a reply asking for a key in the chat", async () => {
  const w = await world({
    agents: ["ada"],
    setup: { toolSources: [docsWeb()] },
    judge: { followThrough: (s) => (/chave|key/i.test(String(s.reply)) ? "secret" : "done") },
    script: {
      ada: [
        { text: "Me manda a API key do Acme Ledger aqui que eu puxo os gastos." },
        { text: "Preciso da chave do Acme Ledger: ela é criada em Configurações > API do Acme Ledger." },
      ],
    },
  });
  await w.say("@ada puxa meus gastos na api do acme ledger");
  await w.settle();
  // The reply asking for the key is never posted nor turned into a card; the run says which key and where.
  expect(await questions(w)).toHaveLength(0);
  expect((await w.posts("ada")).map((p) => p.body)).toEqual([
    "Preciso da chave do Acme Ledger: ela é criada em Configurações > API do Acme Ledger.",
  ]);
  expect((await w.runs("ada")).map((r) => r.status)).toEqual(["done"]);
  await assertInvariants(w);
});

scenario(
  "S64",
  "a key asked in the chat is refused every time, past the other holds and when the judge fails",
  async () => {
    const keyQuestion = (question: string) => ({
      calls: [{ name: "ask_user", input: { question, why: "Preciso disso para seguir com o pedido da pessoa aqui." } }],
    });
    const w = await world({
      agents: ["ada"],
      setup: { toolSources: [docsWeb()] },
      // The judge is down for the last question: one naming a secret is refused all the same.
      judge: { ask: (s) => (/senha/i.test(String(s.question)) ? "fail" : askRubric(s)) },
      script: {
        ada: [
          keyQuestion("Qual é o endereço da API do Acme Ledger?"),
          keyQuestion("Me passa a chave da API do Acme Ledger?"),
          keyQuestion("Me passa a chave da API, por favor?"),
          keyQuestion("Qual é a senha da conta?"),
          { text: "Preciso da chave do Acme Ledger, criada em Configurações > API." },
        ],
      },
    });
    await w.say("@ada puxa meus gastos na api do acme ledger");
    await w.settle();
    const calls = await w.calls("ada");
    expect(calls.map((c) => c.result?.slice(0, 14))).toEqual([
      "Not asked yet:",
      "Not asked: a s",
      "Not asked: a s",
      "Not asked: a s",
    ]);
    expect(await questions(w)).toHaveLength(0);
    await assertInvariants(w);
  },
);
