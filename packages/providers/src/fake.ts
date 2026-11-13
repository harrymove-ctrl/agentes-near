export { createFakeEmbeddings } from "./embeddings";

import {
  type ContentBlock,
  type Endpoint,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  ProviderError,
  promptChars,
  type StopReason,
  systemText,
  textOf,
} from "./types";

export interface FakeReply {
  chunks: string[];
  /** Tool calls appended after the text (stop reason becomes `tool_use` unless set). */
  toolUses?: { id?: string; name: string; input: Record<string, unknown> }[];
  /** Extra provider blocks to return (e.g. a fake thinking block), placed first. */
  opaque?: Record<string, unknown>[];
  usage?: Partial<ModelUsage>;
  stopReason?: StopReason;
  /** Report a different answering model (simulates a server-side fallback). */
  model?: string;
  /** Thinking the call went without (`ModelResult.thinking`). */
  thinking?: ModelResult["thinking"];
  /** What the provider says the call cost (OpenRouter's reported cost). */
  costNanoUsd?: number;
  /**
   * Fail after streaming `chunks`. `inputTokens` simulates the start-of-stream
   * usage event (null = the stream died before it).
   */
  failMidStream?: { error?: string; retryable?: boolean; inputTokens: number | null };
  /**
   * Waits for this after the first chunk (the test cancels meanwhile). If the
   * request's signal is aborted then, the stream ends like a real abort:
   * `request aborted`, with the usage so far.
   */
  hold?: Promise<unknown>;
}

export interface FakeCall {
  request: ModelRequest;
  apiKey: string;
  workspaceId?: string;
  endpoint?: Endpoint;
  session?: string;
}

/**
 * In-memory provider for tests: no network. By default answers
 * "Echo: <last user message>" in three chunks. Pass `reply` to script answers
 * or throw errors. Records every call (including the decrypted key, so tests
 * can assert the gateway used the right credential).
 */
export function createFakeProvider(reply?: (request: ModelRequest, call: number) => FakeReply | Error) {
  const calls: FakeCall[] = [];
  const countCalls: ModelRequest[] = [];
  let toolSeq = 0;
  const provider: ModelProvider & { calls: FakeCall[]; countCalls: ModelRequest[] } = {
    id: "anthropic",
    calls,
    countCalls,
    async stream(request, { apiKey, workspaceId, endpoint, session, onDelta }): Promise<ModelResult> {
      calls.push({
        request: structuredClone({ ...request, signal: undefined }),
        apiKey,
        workspaceId,
        ...(endpoint ? { endpoint } : {}),
        ...(session ? { session } : {}),
      });
      const scripted = reply?.(request, calls.length);
      if (scripted instanceof Error) throw scripted;
      const lastMessage = request.messages.at(-1);
      const last = lastMessage ? textOf(lastMessage.content) : "";
      const r = scripted ?? { chunks: ["Echo: ", last.slice(0, 40), "."] };
      let streamed = 0;
      for (const [i, chunk] of r.chunks.entries()) {
        await Promise.resolve();
        if (request.signal?.aborted) break;
        onDelta(chunk);
        streamed += chunk.length;
        if (i === 0 && r.hold) await r.hold;
      }
      if (request.signal?.aborted) {
        throw new ProviderError("request aborted", false, undefined, {
          inputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: null,
          outputChars: streamed,
        });
      }
      const text = r.chunks.join("");
      if (r.failMidStream) {
        throw new ProviderError(r.failMidStream.error ?? "stream broke", r.failMidStream.retryable ?? true, 500, {
          inputTokens: r.failMidStream.inputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: null,
          outputChars: text.length,
        });
      }
      const content: ContentBlock[] = [
        ...(r.opaque ?? []).map((data) => ({ type: "opaque" as const, provider: "anthropic", data })),
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(r.toolUses ?? []).map((t) => ({
          type: "tool_use" as const,
          id: t.id ?? `toolu_fake_${++toolSeq}`,
          name: t.name,
          input: t.input,
        })),
      ];
      return {
        text,
        content,
        model: r.model ?? request.model,
        stopReason: r.stopReason ?? (r.toolUses?.length ? "tool_use" : "end_turn"),
        usage: {
          inputTokens: r.usage?.inputTokens ?? Math.ceil((systemText(request.system).length + last.length) / 4),
          outputTokens: r.usage?.outputTokens ?? Math.ceil(text.length / 4),
          cacheReadTokens: r.usage?.cacheReadTokens ?? 0,
          cacheWriteTokens: r.usage?.cacheWriteTokens ?? 0,
        },
        ...(r.costNanoUsd !== undefined ? { costNanoUsd: r.costNanoUsd } : {}),
        ...(r.thinking ? { thinking: r.thinking } : {}),
      };
    },
    async countTokens(request) {
      countCalls.push(request);
      return Math.ceil(promptChars(request) / 4);
    },
  };
  return provider;
}

export type FakeProvider = ReturnType<typeof createFakeProvider>;
