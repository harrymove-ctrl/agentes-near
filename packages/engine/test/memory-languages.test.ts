import { afterEach, describe, expect, test } from "bun:test";
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from "@agenteschat/providers";
import { createFakeEmbeddings } from "@agenteschat/providers/testing";
import { indexSource, insertContextItem, retrieveForRun } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Made-up memories, each with a request in the other language that shares none of its words. */
const PAIRS = [
  // English memories, asked in Portuguese.
  {
    memory: "Invoices go out on the first business day of every month.",
    request: "em que dia do mês mandamos as faturas?",
  },
  {
    memory: "The office wifi password changes every Monday.",
    request: "quando troca a senha da internet do escritório?",
  },
  {
    memory: "Customers get their refunds within seven days.",
    request: "em quantos dias o cliente recebe o reembolso?",
  },
  {
    memory: "Expenses above five hundred dollars need approval from finance.",
    request: "quem precisa aprovar uma despesa grande?",
  },
  {
    memory: "Backups of the database run every night at three.",
    request: "a que horas roda a cópia de segurança do banco?",
  },
  {
    memory: "New employees receive their laptop on the first morning.",
    request: "quando o funcionário novo ganha o computador?",
  },
  {
    memory: "Support answers tickets within four hours on weekdays.",
    request: "qual é o prazo de resposta do atendimento?",
  },
  {
    memory: "The quarterly report is due two weeks after the quarter ends.",
    request: "qual é o prazo do relatório trimestral?",
  },
  { memory: "Vacation requests must be sent a month in advance.", request: "com quanta antecedência eu peço férias?" },
  { memory: "Contracts are signed electronically, never on paper.", request: "como assinamos os contratos?" },
  {
    memory: "The company pays for one conference trip per person each year.",
    request: "a empresa paga viagem para eventos?",
  },
  { memory: "Passwords are kept in the shared vault, never in chat.", request: "onde guardamos as senhas?" },
  // Portuguese memories, asked in English.
  { memory: "As entregas para o sul saem às terças e quintas.", request: "which days do southern deliveries leave?" },
  { memory: "O aluguel do escritório vence no dia dez.", request: "when is the office rent due?" },
  {
    memory: "Reuniões com clientes ficam gravadas por trinta dias.",
    request: "how long are client meeting recordings kept?",
  },
  { memory: "O cardápio do almoço muda toda semana.", request: "how often does the lunch menu change?" },
  { memory: "Pedidos acima de mil reais têm frete grátis.", request: "when is shipping free?" },
  { memory: "O estoque é contado no último sábado do mês.", request: "when do we count the inventory?" },
  { memory: "Os boletos atrasados pagam multa de dois por cento.", request: "what is the late payment fee?" },
  { memory: "A garantia dos produtos é de um ano.", request: "how long is the product warranty?" },
  { memory: "O plantão de fim de semana é revezado na equipe.", request: "who covers weekend on-call?" },
  { memory: "Fotos do evento ficam na pasta compartilhada de marketing.", request: "where are the event photos?" },
  { memory: "O treinamento de segurança é obrigatório todo ano.", request: "is the safety training mandatory?" },
  { memory: "As notas fiscais são emitidas pelo financeiro.", request: "who issues the tax receipts?" },
] as const;

/** Memories in the request's language that share one of its words and mean something else. */
const LOOKALIKES = [
  "O escritório fecha mais cedo nas sextas.",
  "O cliente da padaria pediu outro orçamento.",
  "O banco cobra tarifa por transferência.",
  "The weekend team meeting moved to Friday.",
  "Office plants get water on Mondays.",
  "The event budget is approved by the board.",
];

/** A multilingual model's stand-in: a memory and its request in the other language get one vector. */
function translating(): EmbeddingProvider {
  const words = createFakeEmbeddings();
  return {
    id: "fake",
    model: "fake-translating",
    async embed(texts, options) {
      const hashed = await words.embed(texts, options);
      const vectors = texts.map((text, i) => {
        const pair = PAIRS.findIndex((p) => text.includes(p.memory) || text.includes(p.request));
        if (pair < 0) return hashed.vectors[i] ?? [];
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        vector[pair] = 1;
        return vector;
      });
      return { ...hashed, vectors, model: "fake-translating" };
    },
  };
}

/** How many requests find their memory among the first five of a run's memory. */
async function foundInTop5(vectors: boolean) {
  f = await setup(vectors ? { embeddings: { provider: translating(), kinds: ["context_item"] } } : {});
  const contents = [
    ...PAIRS.map((p) => p.memory),
    ...LOOKALIKES,
    ...[1, 2, 3, 4, 5, 6].map((n) => `Routine ${n} posts the weekly numbers in the general channel.`),
  ];
  const ids = new Map<string, string>();
  for (const content of contents) {
    const item = await insertContextItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      channelIds: [f.general.id],
      content,
      evidence: [{ type: "self", ref: f.agent.id, agentId: f.agent.id, at: new Date().toISOString() }],
      createdByKind: "agent",
      createdById: f.agent.id,
    });
    await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
    ids.set(content, item.id);
  }
  const missed: string[] = [];
  for (const { memory, request } of PAIRS) {
    const { matchedIds } = await retrieveForRun(f.context, {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      text: request,
      personIds: [f.owner.id],
    });
    if (!matchedIds.slice(0, 5).includes(ids.get(memory) ?? "")) missed.push(request);
  }
  await f.close();
  f = undefined as unknown as Fixture;
  return { found: PAIRS.length - missed.length, missed };
}

/**
 * The cross-language check of ADR 0167's addendum, offline: Portuguese requests for English memories and the reverse,
 * among lookalikes that share their words. With vectors (a model that maps a translation to its original) every one
 * is in the top 5 of the hybrid ranking; by words alone almost none. A real model is checked in production.
 */
describe("memory across languages: the memory a request needs is in the top 5", () => {
  test("with vectors, all 24; by words alone, almost none", async () => {
    const hybrid = await foundInTop5(true);
    expect(hybrid.missed).toEqual([]);
    const words = await foundInTop5(false);
    expect(words.found).toBeLessThanOrEqual(2);
  });
});
