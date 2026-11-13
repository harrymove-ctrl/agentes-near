import { MODEL_CATALOG } from "./catalog";
import { sseData } from "./sse";
import {
  type ContentBlock,
  deniedError,
  estimateTokens,
  laidOut,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type PartialUsage,
  ProviderError,
  promptChars,
  type StopReason,
  shortSaid,
  stableToolsFirst,
  systemText,
} from "./types";

/** The most `max_output_tokens` a call that isn't in the background may ask for: above it Google answers 400. */
const MAX_OUTPUT_TOKENS = 65_536;

/** Error codes of a reply Google blocked: the model refused. */
const BLOCKED = new Set([
  "safety",
  "recitation",
  "language",
  "prohibited_content",
  "spii",
  "blocklist",
  "content_blocked",
]);
/**
 * Error codes worth retrying: overload, timeouts, and a tool call the model sampled wrong (unreadable, undeclared or
 * too many), which another sample rarely repeats. Not `missing_thought_signature`: our own request causes it.
 */
const RETRYABLE = new Set([
  "api_error",
  "service_unavailable",
  "deadline_exceeded",
  "gateway_timeout",
  "bad_gateway",
  "internal_server_error",
  "aborted",
  "malformed_function_call",
  "malformed_tool_call",
  "unexpected_tool_call",
  "too_many_tool_calls",
]);

/** One step of an interaction (`user_input`, `model_output`, `thought`, `function_call`, `function_result`…). */
type Step = Record<string, unknown> & { type: string };

interface Usage {
  total_input_tokens?: number;
  total_cached_tokens?: number;
  total_output_tokens?: number;
  total_thought_tokens?: number;
  total_tool_use_tokens?: number;
}

interface StreamEvent {
  event_type: string;
  index?: number;
  step?: Step;
  delta?: { type: string; text?: string; arguments?: string; signature?: string; content?: unknown };
  /** On `step.stop`: the running total since the interaction started. */
  usage?: Usage;
  interaction?: { model?: string; status?: string; usage?: Usage; errors?: { code?: string; message?: string }[] };
  error?: { code?: string; message?: string };
}

/** A step as the stream builds it: the step (what is replayed), its text and its arguments so far. */
interface Built {
  step: Step;
  text: string;
  args: string;
}

/**
 * Gemini over Google's Interactions API (`POST /v1beta/interactions`), streaming, on plain `fetch`.
 *
 * - Stateless (`store: false`): nothing is kept in the key owner's AI Studio logs, and each call sends the whole
 *   history as steps. Thought steps come back as `opaque` blocks and are replayed exactly as received, which Google
 *   requires to keep the reasoning; blocks of another provider are dropped.
 * - `effort` → `thinking_level` (`none`: the least the model allows), thought summaries off, the output capped at
 *   the 65,536 a call may ask for, `outputSchema` → `response_format`.
 * - Usage: input less the cached part, cached as cache reads, thinking as output (Google bills it at that rate), no
 *   cache writes (caching is implicit). Read from the finished interaction, else the last step's running total,
 *   else estimated, so a call is never recorded as free.
 * - A blocked reply is a refusal. Mid-stream failures carry what was received (`ProviderError.partial`), and a call
 *   stopped after Google created the interaction carries one even before its first words (the prompt is estimated).
 */
export function createGeminiProvider(
  options: { /** Tests only: a scripted transport. */ fetch?: typeof fetch } = {},
): ModelProvider {
  const http = options.fetch ?? fetch;
  return {
    id: "gemini",
    async stream(input, { apiKey, onDelta }): Promise<ModelResult> {
      const request = laidOut(input);
      const partial: PartialUsage = {
        inputTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: null,
        outputChars: 0,
      };
      const steps: Built[] = [];
      let model = request.model;
      let status: string | undefined;
      let usage: Usage | undefined;
      let blocked = false;
      let created = false;
      const out = (text: string) => {
        partial.outputChars += text.length;
      };
      try {
        let res: Response;
        try {
          res = await http("https://generativelanguage.googleapis.com/v1beta/interactions", {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(toBody(request)),
            signal: request.signal,
          });
        } catch {
          throw new ProviderError("could not reach provider", true);
        }
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
          throw errorOf(res.status, body?.error?.code, body?.error?.message);
        }
        for await (const data of sseData(res.body)) {
          if (data === "[DONE]") break;
          const event = JSON.parse(data) as StreamEvent;
          const built = event.index === undefined ? undefined : steps[event.index];
          if (event.event_type === "interaction.created" || event.event_type === "interaction.completed") {
            created = true;
            model = event.interaction?.model ?? model;
            if (event.event_type === "interaction.completed") {
              status = event.interaction?.status;
              usage = event.interaction?.usage ?? usage;
              const first = event.interaction?.errors?.[0];
              const code = first?.code;
              if (status === "failed" || status === "cancelled") {
                if (code && BLOCKED.has(code)) blocked = true;
                else throw errorOf(undefined, code ?? "api_error", first?.message);
              }
            }
          } else if (event.event_type === "step.start" && event.step && event.index !== undefined) {
            // Google may start a reply with its first words already in the step.
            const text = stepText(event.step.content);
            steps[event.index] = { step: { ...event.step }, text, args: "" };
            if (text) {
              out(text);
              onDelta(text);
            }
          } else if (event.event_type === "step.delta" && built && event.delta) {
            const d = event.delta;
            if (d.type === "text" && d.text) {
              built.text += d.text;
              out(d.text);
              onDelta(d.text);
            } else if (d.type === "arguments_delta" && d.arguments) {
              built.args += d.arguments;
              out(d.arguments);
            } else if (d.type === "thought_signature" && d.signature) {
              built.step.signature = d.signature;
              out(d.signature);
            } else if (d.type === "thought_summary" && d.content) {
              built.step.summary = [...((built.step.summary as unknown[] | undefined) ?? []), d.content];
              out(JSON.stringify(d.content));
            }
          } else if (event.event_type === "step.stop" && event.usage) {
            usage = event.usage;
          } else if (event.event_type === "error") {
            const code = event.error?.code ?? "api_error";
            if (!BLOCKED.has(code)) throw errorOf(undefined, code, event.error?.message);
            blocked = true;
            break;
          }
        }
        if (!blocked && !status)
          throw new ProviderError("could not read the model's reply: the stream ended early", true);
        const content = steps.flatMap((s) => (s ? [blockOf(s)] : [])).filter((b) => b.type !== "text" || b.text);
        const stopReason: StopReason = blocked
          ? "refusal"
          : content.some((b) => b.type === "tool_use")
            ? "tool_use"
            : status === "incomplete"
              ? "max_tokens"
              : status === "completed"
                ? "end_turn"
                : "other";
        return {
          text: content.map((b) => (b.type === "text" ? b.text : "")).join(""),
          content,
          model,
          stopReason,
          usage: usage
            ? usageOf(usage)
            : {
                inputTokens: estimateTokens(promptChars(request)),
                outputTokens: estimateTokens(partial.outputChars),
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
        };
      } catch (error) {
        const mapped = request.signal?.aborted
          ? new ProviderError("request aborted", false)
          : error instanceof ProviderError
            ? error
            : new ProviderError(
                `could not read the model's reply: ${error instanceof Error ? error.message : String(error)}`,
                true,
              );
        // Google bills nothing for a call that fails with a 400 or 500, but a stopped one may have thought for a
        // while: the thinking comes before any words, and its signature only at the thought's end.
        if (partial.outputChars > 0 || usage || (created && request.signal?.aborted))
          mapped.partial = { ...partial, ...(usage ? usageOf(usage) : {}) };
        throw mapped;
      }
    },
  };
}

function toBody(request: ModelRequest) {
  const least = MODEL_CATALOG[request.model]?.leastThinking === "minimal" ? "minimal" : "low";
  const level = request.effort === "none" ? least : request.effort;
  const system = systemText(request.system);
  return {
    model: request.model,
    // Gemini caches a prompt's prefix by itself: the system blocks' breakpoints aren't needed.
    ...(system ? { system_instruction: system } : {}),
    input: toInput(request.messages),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: stableToolsFirst(request.tools).map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        }
      : {}),
    generation_config: {
      max_output_tokens: Math.min(request.maxTokens, MAX_OUTPUT_TOKENS),
      thinking_summaries: "none",
      ...(level ? { thinking_level: level } : {}),
    },
    ...(request.outputSchema
      ? { response_format: { type: "text", mime_type: "application/json", schema: request.outputSchema } }
      : {}),
    stream: true,
    store: false,
  };
}

/** The history as steps: a turn's consecutive texts in one step, tool calls and results as their own. */
function toInput(messages: ModelMessage[]): Step[] {
  const steps: Step[] = [];
  const names = new Map<string, string>();
  for (const m of messages) {
    const blocks: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    let texts: { type: "text"; text: string }[] | null = null;
    for (const b of blocks) {
      if (b.type === "text") {
        if (!b.text) continue;
        if (!texts) {
          texts = [];
          steps.push({ type: m.role === "user" ? "user_input" : "model_output", content: texts });
        }
        texts.push({ type: "text", text: b.text });
      } else if (b.type === "tool_use") {
        names.set(b.id, b.name);
        steps.push({ type: "function_call", id: b.id, name: b.name, arguments: b.input });
        texts = null;
      } else if (b.type === "tool_result") {
        const name = names.get(b.toolUseId);
        steps.push({
          type: "function_result",
          call_id: b.toolUseId,
          ...(name ? { name } : {}),
          result: [
            { type: "text", text: b.content },
            ...(b.images ?? []).map((i) => ({ type: "image", data: i.data, mime_type: i.mediaType })),
          ],
          ...(b.isError ? { is_error: true } : {}),
        });
        texts = null;
      } else if (b.provider === "gemini") {
        steps.push(b.data as Step);
        texts = null;
      }
      // Another provider's opaque block (Claude's thinking, OpenAI's reasoning) can't be replayed here.
    }
  }
  return steps;
}

/** The text items of a step's content, joined. */
const stepText = (content: unknown) =>
  Array.isArray(content)
    ? content.map((c) => (c && typeof c === "object" && c.type === "text" ? String(c.text ?? "") : "")).join("")
    : "";

function blockOf({ step, text, args }: Built): ContentBlock {
  if (step.type === "model_output") return { type: "text", text };
  if (step.type !== "function_call") return { type: "opaque", provider: "gemini", data: step };
  let input = step.arguments as Record<string, unknown> | undefined;
  if (args) {
    try {
      input = JSON.parse(args) as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(`could not read the model's reply: ${(error as Error).message}`, true);
    }
  }
  return { type: "tool_use", id: String(step.id), name: String(step.name), input: input ?? {} };
}

function usageOf(u: Usage): ModelUsage {
  const cached = u.total_cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.total_input_tokens ?? 0) - cached) + (u.total_tool_use_tokens ?? 0),
    outputTokens: (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** A failure by Google's HTTP status or error code, in the words the other adapters use. */
function errorOf(status: number | undefined, code: string | undefined, message?: string): ProviderError {
  if (status === 401 || code === "authentication") return new ProviderError("invalid provider API key", false, 401);
  if (status === 402 || code === "payment_required")
    return new ProviderError("no prepaid credit left at the provider", false, 402);
  if (status === 403 || code === "permission_denied") return deniedError(code, message ? shortSaid(message) : "");
  if (code === "quota_exceeded") return new ProviderError("daily quota used up at the provider", false, 429);
  if (status === 429 || status === 408 || code === "rate_limit_exceeded" || code === "too_many_requests")
    return new ProviderError("rate limited by provider", true, status ?? 429);
  if ((status ?? 0) >= 500 || (code && RETRYABLE.has(code))) return new ProviderError("provider error", true, status);
  const why = [status, code].filter(Boolean).join(" ");
  const said = message ? shortSaid(message) : "";
  return new ProviderError(
    `provider rejected the request (${why || "?"})${said ? `: ${said}` : ""}`,
    false,
    status,
    undefined,
    said || undefined,
  );
}
