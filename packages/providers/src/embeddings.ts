import { ProviderError } from "./types";

/**
 * Text embeddings for hybrid search (ADR 0017). Provider-neutral; only the
 * Model Gateway calls it (`gateway.embed`), which records usage with kind
 * `embedding`. Vectors have `EMBEDDING_DIMENSIONS` entries (the database
 * column is fixed at that size).
 */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingResult {
  vectors: number[][];
  /** Tokens billed by the provider. */
  tokens: number;
  model: string;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  embed(
    texts: string[],
    options: { apiKey: string; inputType: "document" | "query"; signal?: AbortSignal },
  ): Promise<EmbeddingResult>;
}

export interface EmbeddingModel {
  provider: string;
  /** Nano-USD per token (USD per million × 1000); 0 for a model only run on servers of one's own. */
  pricePerToken: number;
  /** Numbers per vector as it is called; fewer than `EMBEDDING_DIMENSIONS` are padded with zeros. */
  dimensions: number;
  /** Put before a query's text, never a document's: the query prompt of an instruction-tuned model. */
  queryPrefix?: string;
  /** Larger natively (Matryoshka): the request asks for `EMBEDDING_DIMENSIONS`. */
  asksDimensions?: boolean;
}

/** Qwen3-Embedding's query prompt, from its `config_sentence_transformers.json`; documents get none. */
const QWEN3_QUERY = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";

/**
 * Embedding models by id. List prices (verify before billing customers): Voyage's as of 2026-10, voyage-3.5
 * $0.06/MTok and voyage-3.5-lite $0.02/MTok; OpenAI's, text-embedding-3-small $0.02/MTok and -large $0.13/MTok;
 * DeepInfra's as of 2026-11, $0.01/MTok for the Qwen3 and bge-m3 models, also recorded when one runs on a server of
 * one's own. Granite isn't hosted there.
 */
export const EMBEDDING_CATALOG: Record<string, EmbeddingModel> = {
  "voyage-3.5": { provider: "voyage", pricePerToken: 60, dimensions: 1024 },
  "voyage-3.5-lite": { provider: "voyage", pricePerToken: 20, dimensions: 1024 },
  "text-embedding-3-small": { provider: "openai", pricePerToken: 20, dimensions: 1024, asksDimensions: true },
  "text-embedding-3-large": { provider: "openai", pricePerToken: 130, dimensions: 1024, asksDimensions: true },
  "Qwen/Qwen3-Embedding-0.6B": { provider: "openai", pricePerToken: 10, dimensions: 1024, queryPrefix: QWEN3_QUERY },
  "Qwen/Qwen3-Embedding-8B": {
    provider: "openai",
    pricePerToken: 10,
    dimensions: 1024,
    queryPrefix: QWEN3_QUERY,
    asksDimensions: true,
  },
  "BAAI/bge-m3": { provider: "openai", pricePerToken: 10, dimensions: 1024 },
  "ibm-granite/granite-embedding-311m-multilingual-r2": { provider: "openai", pricePerToken: 0, dimensions: 768 },
  "fake-embed": { provider: "fake", pricePerToken: 0, dimensions: 1024 },
};

/** `EMBEDDINGS_PROVIDER=openai`'s model when `EMBEDDING_MODEL` is unset. */
export const DEFAULT_OPENAI_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-0.6B";

export const embeddingCostNanoUsd = (model: string, tokens: number) =>
  (EMBEDDING_CATALOG[model]?.pricePerToken ?? 0) * tokens;

/** Voyage AI embeddings over its REST API (no SDK needed). Optional: enabled by env. */
export function createVoyageEmbeddings(
  options: { model?: string; baseURL?: string; fetch?: typeof fetch } = {},
): EmbeddingProvider {
  const model = options.model ?? "voyage-3.5";
  const http = options.fetch ?? fetch;
  return {
    id: "voyage",
    model,
    async embed(texts, { apiKey, inputType, signal }) {
      let res: Response;
      try {
        res = await http(`${options.baseURL ?? "https://api.voyageai.com"}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ input: texts, model, input_type: inputType, output_dimension: EMBEDDING_DIMENSIONS }),
          signal,
        });
      } catch (error) {
        throw new ProviderError(`could not reach Voyage: ${String(error)}`, true);
      }
      if (!res.ok) {
        throw new ProviderError(
          `Voyage rejected the request (${res.status})`,
          res.status === 429 || res.status >= 500,
          res.status,
        );
      }
      const body = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
        usage?: { total_tokens?: number };
      };
      const vectors = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return { vectors, tokens: body.usage?.total_tokens ?? 0, model };
    },
  };
}

/**
 * Texts per request. text-embeddings-inference refuses more than 32 by default, and on a CPU a shorter batch keeps
 * the queries that wait behind it within their timeout.
 */
const OPENAI_BATCH = 16;

/**
 * Embeddings from any server with OpenAI's embeddings API (ADR 0167): DeepInfra, OpenAI, or one of your own
 * (text-embeddings-inference, vLLM, llama.cpp, Ollama). `url` is the API's base: requests go to `/embeddings` under
 * it. A query starts with its model's `queryPrefix`. A shorter vector is padded with zeros, which keeps its cosine
 * similarities.
 */
export function createOpenAIEmbeddings(options: {
  url: string;
  model?: string;
  fetch?: typeof fetch;
}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL;
  const info = EMBEDDING_CATALOG[model];
  const http = options.fetch ?? fetch;
  const endpoint = `${options.url.replace(/\/+$/, "")}/embeddings`;
  return {
    id: "openai",
    model,
    async embed(texts, { apiKey, inputType, signal }) {
      const prefix = inputType === "query" ? (info?.queryPrefix ?? "") : "";
      const vectors: number[][] = [];
      let tokens = 0;
      for (let i = 0; i < texts.length; i += OPENAI_BATCH) {
        const input = texts.slice(i, i + OPENAI_BATCH).map((text) => prefix + text);
        let res: Response;
        try {
          res = await http(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({
              model,
              input,
              ...(info?.asksDimensions ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
            }),
            signal,
          });
        } catch (error) {
          throw new ProviderError(`could not reach the embeddings server: ${String(error)}`, true);
        }
        if (!res.ok) {
          throw new ProviderError(
            `the embeddings server rejected the request (${res.status})`,
            res.status === 429 || res.status >= 500,
            res.status,
          );
        }
        const body = (await res.json()) as {
          data?: { embedding: number[]; index: number }[];
          usage?: { prompt_tokens?: number; total_tokens?: number };
        };
        const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
        if (data.length !== input.length) {
          throw new ProviderError(
            `the embeddings server returned ${data.length} vectors for ${input.length} texts`,
            false,
          );
        }
        for (const { embedding } of data) {
          if (embedding.length > EMBEDDING_DIMENSIONS) {
            throw new ProviderError(
              `${model} returns ${embedding.length} numbers per vector, more than the ${EMBEDDING_DIMENSIONS} search keeps`,
              false,
            );
          }
          vectors.push(embedding.concat(new Array<number>(EMBEDDING_DIMENSIONS - embedding.length).fill(0)));
        }
        tokens += body.usage?.total_tokens ?? body.usage?.prompt_tokens ?? 0;
      }
      return { vectors, tokens, model };
    },
  };
}

/**
 * Deterministic embeddings for tests: hashed bag of words, L2-normalized, so
 * texts sharing words are close. No network.
 */
export function createFakeEmbeddings(): EmbeddingProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    id: "fake",
    model: "fake-embed",
    calls,
    async embed(texts) {
      calls.push(texts);
      const vectors = texts.map((text) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
          let h = 2166136261;
          for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
          v[Math.abs(h) % EMBEDDING_DIMENSIONS] = (v[Math.abs(h) % EMBEDDING_DIMENSIONS] ?? 0) + 1;
        }
        const norm = Math.sqrt(v.reduce((n, x) => n + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      });
      return { vectors, tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0), model: "fake-embed" };
    },
  };
}
