import { describe, expect, test } from "bun:test";
import {
  createOpenAIEmbeddings,
  EMBEDDING_CATALOG,
  EMBEDDING_DIMENSIONS,
  embeddingCostNanoUsd,
  ProviderError,
  usdToNanoUsd,
} from "../src";

type Sent = { url: string; headers: Headers; body: { model: string; input: string[]; dimensions?: number } };

/** An OpenAI-style embeddings server: answers each text with a vector of `size` numbers, last index first. */
function server(size = EMBEDDING_DIMENSIONS, reply?: (sent: Sent) => Response | undefined) {
  const sent: Sent[] = [];
  const answer = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Sent = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    sent.push(call);
    return (
      reply?.(call) ??
      Response.json({
        data: call.body.input
          .map((_, index) => ({ embedding: new Array<number>(size).fill(index + 1), index }))
          .reverse(),
        usage: { prompt_tokens: 3 * call.body.input.length, total_tokens: 3 * call.body.input.length },
      })
    );
  }) as typeof fetch;
  return { fetch: answer, sent };
}

const QWEN = "Qwen/Qwen3-Embedding-0.6B";
const QUERY_PROMPT = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";

describe("OpenAI-compatible embeddings (ADR 0167)", () => {
  test("posts the model and the texts to /embeddings under the URL, with the key when there is one", async () => {
    const { fetch, sent } = server();
    const provider = createOpenAIEmbeddings({ url: "https://embed.example.com/v1/", fetch });
    expect([provider.id, provider.model]).toEqual(["openai", QWEN]);
    const result = await provider.embed(["first", "second"], { apiKey: "sk-test", inputType: "document" });
    expect(sent[0]?.url).toBe("https://embed.example.com/v1/embeddings");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(sent[0]?.body).toEqual({ model: QWEN, input: ["first", "second"] });
    // In the order the texts went, whatever order they came back in.
    expect(result.vectors.map((v) => v[0])).toEqual([1, 2]);
    expect(result).toMatchObject({ tokens: 6, model: QWEN });
    // A server of one's own may take no key: none is sent.
    await provider.embed(["third"], { apiKey: "", inputType: "document" });
    expect(sent[1]?.headers.has("authorization")).toBe(false);
  });

  test("a Qwen3 query starts with its instruction, a document never; bge-m3 and granite take none", async () => {
    const { fetch, sent } = server();
    const qwen = createOpenAIEmbeddings({ url: "https://embed.example.com/v1", fetch });
    await qwen.embed(["quando fecham as faturas?"], { apiKey: "k", inputType: "query" });
    await qwen.embed(["Invoices close on the 5th."], { apiKey: "k", inputType: "document" });
    expect(sent.map((s) => s.body.input[0])).toEqual([
      `${QUERY_PROMPT}quando fecham as faturas?`,
      "Invoices close on the 5th.",
    ]);
    for (const model of ["BAAI/bge-m3", "ibm-granite/granite-embedding-311m-multilingual-r2"]) {
      const other = server();
      await createOpenAIEmbeddings({ url: "https://embed.example.com/v1", model, fetch: other.fetch }).embed(["oi"], {
        apiKey: "k",
        inputType: "query",
      });
      expect(other.sent[0]?.body.input).toEqual(["oi"]);
    }
  });

  test("a shorter vector is padded with zeros to 1024; Qwen3-8B is asked for 1024; a longer one is refused", async () => {
    const granite = server(768);
    const padded = await createOpenAIEmbeddings({
      url: "https://embed.example.com/v1",
      model: "ibm-granite/granite-embedding-311m-multilingual-r2",
      fetch: granite.fetch,
    }).embed(["oi"], { apiKey: "", inputType: "document" });
    expect(padded.vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(padded.vectors[0]?.slice(766, 770)).toEqual([1, 1, 0, 0]);
    expect(granite.sent[0]?.body.dimensions).toBeUndefined();

    const big = server();
    await createOpenAIEmbeddings({
      url: "https://embed.example.com/v1",
      model: "Qwen/Qwen3-Embedding-8B",
      fetch: big.fetch,
    }).embed(["oi"], { apiKey: "k", inputType: "query" });
    expect(big.sent[0]?.body).toMatchObject({ model: "Qwen/Qwen3-Embedding-8B", dimensions: 1024 });
    expect(big.sent[0]?.body.input[0]).toStartWith("Instruct: ");

    const unasked = server(4096);
    const refused = await createOpenAIEmbeddings({
      url: "https://embed.example.com/v1",
      model: "some/model-of-4096",
      fetch: unasked.fetch,
    })
      .embed(["oi"], { apiKey: "", inputType: "document" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProviderError);
    expect((refused as ProviderError).retryable).toBe(false);
    expect((refused as ProviderError).message).toContain("4096");
  });

  test("many texts go 16 to a request, in order, with their tokens added up", async () => {
    const { fetch, sent } = server();
    const texts = Array.from({ length: 40 }, (_, i) => `text ${i}`);
    const result = await createOpenAIEmbeddings({ url: "https://embed.example.com/v1", fetch }).embed(texts, {
      apiKey: "k",
      inputType: "document",
    });
    expect(sent.map((s) => s.body.input.length)).toEqual([16, 16, 8]);
    expect(sent.flatMap((s) => s.body.input)).toEqual(texts);
    expect(result.vectors).toHaveLength(40);
    expect(result.tokens).toBe(120);
  });

  test("a busy or broken server is retried, a refusal is not; the timeout's signal reaches the request", async () => {
    const at = (status: number) =>
      createOpenAIEmbeddings({
        url: "https://embed.example.com/v1",
        fetch: server(1024, () => new Response("no", { status })).fetch,
      })
        .embed(["oi"], { apiKey: "k", inputType: "query" })
        .catch((e: ProviderError) => [e.status, e.retryable]);
    expect(await at(429)).toEqual([429, true]);
    expect(await at(503)).toEqual([503, true]);
    expect(await at(401)).toEqual([401, false]);
    const wrongCount = await createOpenAIEmbeddings({
      url: "https://embed.example.com/v1",
      fetch: server(1024, () => Response.json({ data: [] })).fetch,
    })
      .embed(["oi"], { apiKey: "k", inputType: "query" })
      .catch((e: ProviderError) => e.retryable);
    expect(wrongCount).toBe(false);

    const hung = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as typeof fetch;
    const timedOut = (await createOpenAIEmbeddings({ url: "https://embed.example.com/v1", fetch: hung })
      .embed(["oi"], { apiKey: "k", inputType: "query", signal: AbortSignal.timeout(20) })
      .catch((e: unknown) => e)) as ProviderError;
    expect(timedOut).toBeInstanceOf(ProviderError);
    expect([timedOut.retryable, timedOut.message.includes("could not reach")]).toEqual([true, true]);
  });

  test("DeepInfra's models cost $0.01 per million tokens; granite, unknown and local-only models nothing", () => {
    for (const model of [QWEN, "Qwen/Qwen3-Embedding-8B", "BAAI/bge-m3"]) {
      expect(embeddingCostNanoUsd(model, 1_000_000)).toBe(usdToNanoUsd(0.01));
      expect(EMBEDDING_CATALOG[model]?.dimensions).toBe(1024);
    }
    expect(embeddingCostNanoUsd("ibm-granite/granite-embedding-311m-multilingual-r2", 1_000_000)).toBe(0);
    expect(EMBEDDING_CATALOG["ibm-granite/granite-embedding-311m-multilingual-r2"]?.dimensions).toBe(768);
    expect(embeddingCostNanoUsd("nomic-embed-text", 1_000_000)).toBe(0);
  });
});
