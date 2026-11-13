import OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { MODEL_CATALOG } from "./catalog";
import {
  type ContentBlock,
  deniedError,
  laidOut,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type PartialUsage,
  ProviderError,
  type StopReason,
  shortSaid,
  stableToolsFirst,
  systemText,
} from "./types";

/**
 * OpenAI over the Responses API, streaming. A client per call with the
 * org's key (and optional organization/project headers).
 *
 * - System prompt → `instructions`; messages and tool round trips → input
 *   items (`function_call` / `function_call_output`), mapped from the neutral
 *   `tool_use` / `tool_result` blocks.
 * - Stateless (`store: false`) with `reasoning.encrypted_content` included:
 *   reasoning items come back as `opaque` blocks and are replayed unchanged
 *   in tool loops. Blocks from other providers are dropped.
 * - `outputSchema` → `text.format` JSON Schema (strict); `effort` →
 *   `reasoning.effort` on reasoning models (`none` only on one that can
 *   turn reasoning off, `low` on the others).
 * - Usage: `input_tokens` includes cached and cache-write tokens; we split
 *   them so each is priced at its own rate.
 * - Mid-stream failures carry what was received (`ProviderError.partial`).
 */
export function createOpenAIProvider(
  options: { baseURL?: string; maxRetries?: number /** Tests only: scripted transport. */; fetch?: typeof fetch } = {},
): ModelProvider {
  const client = (apiKey: string, organization?: string, project?: string) =>
    new OpenAI({
      apiKey,
      baseURL: options.baseURL,
      maxRetries: options.maxRetries ?? 2,
      fetch: options.fetch,
      organization: organization ?? null,
      project: project ?? null,
    });

  return {
    id: "openai",
    async stream(input, { apiKey, organization, project, onDelta }): Promise<ModelResult> {
      const request = laidOut(input);
      const partial: PartialUsage = {
        inputTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: null,
        outputChars: 0,
      };
      const info = MODEL_CATALOG[request.model];
      const effort = request.effort === "none" && info?.leastThinking !== "off" ? "low" : request.effort;
      try {
        const stream = client(apiKey, organization, project).responses.stream(
          {
            model: request.model,
            instructions: systemText(request.system),
            input: toInput(request.messages),
            max_output_tokens: request.maxTokens,
            store: false,
            include: ["reasoning.encrypted_content"],
            ...(request.tools && request.tools.length > 0 ? { tools: toTools(request) } : {}),
            ...(request.outputSchema
              ? {
                  text: {
                    format: {
                      type: "json_schema" as const,
                      name: "output",
                      schema: request.outputSchema,
                      strict: true,
                    },
                  },
                }
              : {}),
            ...(info?.reasoning && effort ? { reasoning: { effort } } : {}),
          },
          { signal: request.signal },
        );
        stream.on("event", (event: ResponseStreamEvent) => {
          if (event.type === "response.output_text.delta") {
            partial.outputChars += event.delta.length;
            onDelta(event.delta);
          } else if (event.type === "response.function_call_arguments.delta") {
            partial.outputChars += event.delta.length;
          }
        });
        const response = await stream.finalResponse();
        // A failed response ends its stream cleanly: read as a reply, it would be an empty one that "worked".
        if (response.status === "failed") {
          throw new OpenAI.APIError(undefined, response.error ?? undefined, response.error?.message, undefined);
        }
        return fromResponse(response as unknown as Response);
      } catch (error) {
        const mapped = openAIError(error);
        if (partial.outputChars > 0) mapped.partial = partial;
        throw mapped;
      }
    },
  };
}

function toTools(request: ModelRequest): FunctionTool[] {
  return stableToolsFirst(request.tools ?? []).map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}

function toInput(messages: ModelMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      items.push({ role: m.role, content: m.content });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") items.push({ role: m.role, content: b.text });
      else if (b.type === "tool_use")
        items.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      else if (b.type === "tool_result")
        items.push({
          type: "function_call_output",
          call_id: b.toolUseId,
          output: b.images?.length
            ? [
                { type: "input_text", text: b.isError ? `ERROR: ${b.content}` : b.content },
                ...b.images.map((i) => ({
                  type: "input_image" as const,
                  image_url: `data:${i.mediaType};base64,${i.data}`,
                  detail: "auto" as const,
                })),
              ]
            : b.isError
              ? `ERROR: ${b.content}`
              : b.content,
        });
      else if (b.type === "opaque" && b.provider === "openai") items.push(b.data as unknown as ResponseInputItem);
      // Opaque blocks of another provider (e.g. Anthropic thinking) can't be replayed here.
    }
  }
  return items;
}

function fromResponse(response: Response): ModelResult {
  const content: ContentBlock[] = [];
  let refused = false;
  for (const item of response.output as ResponseOutputItem[]) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") content.push({ type: "text", text: part.text });
        else if (part.type === "refusal") refused = true;
      }
    } else if (item.type === "function_call") {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(item.arguments || "{}") as Record<string, unknown>;
      } catch {
        input = {};
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    } else if (item.type === "reasoning") {
      content.push({ type: "opaque", provider: "openai", data: item as unknown as Record<string, unknown> });
    }
  }
  const usage = response.usage;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const written = (usage?.input_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ?? 0;
  const stopReason: StopReason = refused
    ? "refusal"
    : content.some((b) => b.type === "tool_use")
      ? "tool_use"
      : response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens"
        ? "max_tokens"
        : response.status === "completed"
          ? "end_turn"
          : "other";
  return {
    text: content.map((b) => (b.type === "text" ? b.text : "")).join(""),
    content,
    model: response.model,
    stopReason,
    usage: {
      inputTokens: Math.max(0, (usage?.input_tokens ?? 0) - cached - written),
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: written,
    },
  };
}

/**
 * What an upstream's raw error says: its text, or the message of its JSON body. Nothing else of a body or a page is
 * shown: a validation error can carry the request back, system prompt included.
 */
function upstreamWords(raw: unknown) {
  if (typeof raw !== "string") return "";
  if (!/^\s*[{[<]/.test(raw)) return raw;
  try {
    const body = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } } | null;
    const message = body?.error?.message ?? body?.message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

/**
 * What an error body says. OpenRouter's own message is often only "Provider returned error": the upstream's words are
 * in `metadata.raw`.
 */
export function saidIn(error: InstanceType<typeof OpenAI.APIError>) {
  const body = error.error as { message?: unknown; metadata?: { raw?: unknown } } | undefined;
  const upstream = upstreamWords(body?.metadata?.raw);
  return shortSaid(upstream || (typeof body?.message === "string" ? body.message : "")) || undefined;
}

/**
 * An OpenAI SDK failure in the words every adapter uses (also OpenRouter's, which speaks through this SDK). A failure
 * inside a stream arrives as a plain `APIError` with no status, only its body's `code`, so the code decides first. No
 * credit is a 429 on OpenAI: it never passes by waiting.
 */
export function openAIError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.APIError) {
    if (error.code === "insufficient_quota") {
      const said = saidIn(error);
      const why = `no prepaid credit left at the provider (429 insufficient_quota)${said ? `: ${said}` : ""}`;
      return new ProviderError(why, false, error.status ?? 429, undefined, said);
    }
    if (error.status === undefined) {
      if (error.code === "rate_limit_exceeded") return new ProviderError("rate limited by provider", true, 429);
      if (error.code === "invalid_api_key") return new ProviderError("invalid provider API key", false, 401);
      if (error.code === "server_error") return new ProviderError("provider error", true);
    }
  }
  if (error instanceof OpenAI.RateLimitError) return new ProviderError("rate limited by provider", true, 429);
  if (error instanceof OpenAI.AuthenticationError) return new ProviderError("invalid provider API key", false, 401);
  if (error instanceof OpenAI.PermissionDeniedError) return deniedError(error.code, saidIn(error));
  if (error instanceof OpenAI.InternalServerError) return new ProviderError("provider error", true, error.status);
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError("provider timed out", true);
  if (error instanceof OpenAI.APIConnectionError) return new ProviderError("could not reach provider", true);
  if (error instanceof OpenAI.APIUserAbortError) return new ProviderError("request aborted", false);
  if (error instanceof OpenAI.APIError) {
    const what = [error.status ?? "?", error.code].filter(Boolean).join(" ");
    const said = saidIn(error);
    return new ProviderError(
      `provider rejected the request (${what})${said ? `: ${said}` : ""}`,
      false,
      error.status,
      undefined,
      said,
    );
  }
  if (error instanceof OpenAI.OpenAIError || error instanceof SyntaxError) {
    return new ProviderError(`could not read the model's reply: ${error.message}`, true);
  }
  return new ProviderError(error instanceof Error ? error.message : String(error), false);
}
