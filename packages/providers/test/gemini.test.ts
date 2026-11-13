import { describe, expect, test } from "bun:test";
import { createGeminiProvider, type ModelRequest, ProviderError } from "../src";
import { sseData } from "../src/sse";
import { scripted } from "./scripted";

/** An Interactions stream: each event named by its `event_type`, then the `[DONE]` tail. */
const sse = (events: Record<string, unknown>[], done = true) =>
  events.map((e) => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`).join("") +
  (done ? "event: done\ndata: [DONE]\n\n" : "");

const created = (model = "gemini-3.8-flash") => ({
  event_type: "interaction.created",
  interaction: { id: "v1_1", status: "in_progress", object: "interaction", model },
});
const completed = (status: string, usage?: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  event_type: "interaction.completed",
  interaction: {
    id: "v1_1",
    status,
    object: "interaction",
    model: "gemini-3.8-flash",
    ...(usage ? { usage } : {}),
    ...extra,
  },
});
const start = (index: number, step: Record<string, unknown>) => ({ event_type: "step.start", index, step });
const delta = (index: number, d: Record<string, unknown>) => ({ event_type: "step.delta", index, delta: d });
const stop = (index: number, usage?: Record<string, number>) => ({
  event_type: "step.stop",
  index,
  ...(usage ? { usage } : {}),
});
const said = (index: number, ...texts: string[]) => [
  start(index, { type: "model_output" }),
  ...texts.map((text) => delta(index, { type: "text", text })),
  stop(index),
];

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "gemini-3.8-flash",
  system: "s",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1000,
  ...over,
});
const quiet = { apiKey: "AQ.key", onDelta: () => {} };

/** The adapter on a scripted transport: the requests it sent, and a call's result or error. */
function gemini(body: string, status = 200) {
  const { fetcher, requests } = scripted(body, status);
  return { requests, provider: createGeminiProvider({ fetch: fetcher }) };
}
const failure = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e as ProviderError);

/** A transport that sends `events` and keeps the stream open until the call is aborted; `more` runs once they were read. */
const hanging = (events: Record<string, unknown>[], more?: () => void) =>
  (async (_url: string | URL | Request, init?: RequestInit) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse(events, false)));
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
        pull: more,
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;

describe("Gemini adapter (Interactions API, scripted transport)", () => {
  test("a full tool loop: the request's steps and settings, the reply's text streamed, its blocks and split usage", async () => {
    const thought = { type: "thought", signature: "sig-0" };
    const { provider, requests } = gemini(
      sse([
        created(),
        { event_type: "interaction.status_update", interaction_id: "v1_1", status: "in_progress" },
        start(0, { type: "thought" }),
        delta(0, { type: "thought_signature", signature: "sig-1" }),
        stop(0),
        // Google may start a reply with its first words already in the step.
        start(1, { type: "model_output", content: [{ type: "text", text: "Check" }] }),
        delta(1, { type: "text", text: "ing." }),
        stop(1),
        start(2, { type: "function_call", id: "fc_1", name: "github_get_pr", arguments: {} }),
        delta(2, { type: "arguments_delta", arguments: '{"pr":' }),
        delta(2, { type: "arguments_delta", arguments: "42}" }),
        stop(2),
        completed("requires_action", {
          total_input_tokens: 1000,
          total_cached_tokens: 600,
          total_output_tokens: 50,
          total_thought_tokens: 30,
          total_tool_use_tokens: 0,
        }),
      ]),
    );
    const deltas: string[] = [];
    const result = await provider.stream(
      request({
        system: [{ text: "org", cache: true }, { text: "agent" }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "gemini", data: thought },
              { type: "text", text: "Looking." },
              { type: "tool_use", id: "fc_0", name: "search_context", input: { query: "x" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "fc_0",
                content: "nothing",
                isError: true,
                images: [{ mediaType: "image/png", data: "UE5H" }],
              },
              { type: "text", text: "and" },
              { type: "text", text: "now?" },
            ],
          },
        ],
        maxTokens: 100_000,
        tools: [
          { name: "b", description: "b", inputSchema: { type: "object" } },
          { name: "a", description: "a", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
        ],
        effort: "high",
      }),
      { apiKey: "AQ.secret", onDelta: (d) => deltas.push(d) },
    );
    const req = requests[0];
    expect(req?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(req?.headers.get("x-goog-api-key")).toBe("AQ.secret");
    expect(req?.body).toEqual({
      model: "gemini-3.8-flash",
      system_instruction: "org\n\nagent",
      input: [
        { type: "user_input", content: [{ type: "text", text: "hi" }] },
        thought,
        { type: "model_output", content: [{ type: "text", text: "Looking." }] },
        { type: "function_call", id: "fc_0", name: "search_context", arguments: { query: "x" } },
        {
          type: "function_result",
          call_id: "fc_0",
          name: "search_context",
          result: [
            { type: "text", text: "nothing" },
            { type: "image", data: "UE5H", mime_type: "image/png" },
          ],
          is_error: true,
        },
        {
          type: "user_input",
          content: [
            { type: "text", text: "and" },
            { type: "text", text: "now?" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "a",
          description: "a",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
        { type: "function", name: "b", description: "b", parameters: { type: "object" } },
      ],
      generation_config: { max_output_tokens: 65_536, thinking_summaries: "none", thinking_level: "high" },
      stream: true,
      store: false,
    });

    expect(deltas).toEqual(["Check", "ing."]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.text).toBe("Checking.");
    expect(result.content).toEqual([
      { type: "opaque", provider: "gemini", data: { type: "thought", signature: "sig-1" } },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "fc_1", name: "github_get_pr", input: { pr: 42 } },
    ]);
    // Input less the cached part; thinking billed as output; caching is implicit, with no writes.
    expect(result.usage).toEqual({ inputTokens: 400, cacheReadTokens: 600, outputTokens: 80, cacheWriteTokens: 0 });
    expect(result.model).toBe("gemini-3.8-flash");
  });

  test("structured output: the schema in response_format, the reply's JSON as its text", async () => {
    const { provider, requests } = gemini(sse([created(), ...said(0, '{"ok":', "true}"), completed("completed")]));
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const result = await provider.stream(request({ outputSchema: schema }), quiet);
    expect(requests[0]?.body.response_format).toEqual({ type: "text", mime_type: "application/json", schema });
    expect(result.text).toBe('{"ok":true}');
    expect(result.stopReason).toBe("end_turn");
  });

  test("effort none: the least thinking each model allows (minimal on Flash-Lite, low on 3.8 Flash); none given, none sent", async () => {
    const levelOf = async (over: Partial<ModelRequest>) => {
      const { provider, requests } = gemini(sse([created(), ...said(0, "ok"), completed("completed")]));
      await provider.stream(request(over), quiet);
      return (requests[0]?.body.generation_config as { thinking_level?: string } | undefined)?.thinking_level;
    };
    expect(await levelOf({ model: "gemini-3.5-flash-lite", effort: "none" })).toBe("minimal");
    expect(await levelOf({ model: "gemini-3.8-flash", effort: "none" })).toBe("low");
    expect(await levelOf({ model: "gemini-4-argon", effort: "none" })).toBe("low");
    expect(await levelOf({ model: "gemini-3.5-flash-lite", effort: "medium" })).toBe("medium");
    expect(await levelOf({})).toBeUndefined();
  });

  test("a blocked reply is a refusal, as an error event or a failed interaction", async () => {
    const asEvent = gemini(
      sse([created(), ...said(0, "Sure, "), { event_type: "error", error: { code: "safety", message: "blocked" } }]),
    );
    const refused = await asEvent.provider.stream(request(), quiet);
    expect(refused).toMatchObject({ stopReason: "refusal", text: "Sure, " });
    for (const code of ["recitation", "content_blocked"]) {
      const asStatus = gemini(sse([created(), completed("failed", undefined, { errors: [{ code }] })]));
      expect((await asStatus.provider.stream(request(), quiet)).stopReason).toBe("refusal");
    }
  });

  test("a tool call the model sampled wrong is retried, as an error event or a failed interaction; a missing thought signature isn't", async () => {
    const errorFor = async (code: string, asEvent: boolean) => {
      const failed = asEvent
        ? { event_type: "error", error: { code } }
        : completed("failed", undefined, { errors: [{ code }] });
      const { provider } = gemini(sse([created(), start(0, { type: "thought" }), failed]));
      const e = (await failure(provider.stream(request(), quiet))) as ProviderError;
      return { message: e.message, retryable: e.retryable, partial: e.partial };
    };
    const retried = { message: "provider error", retryable: true, partial: undefined };
    for (const code of [
      "malformed_function_call",
      "malformed_tool_call",
      "unexpected_tool_call",
      "too_many_tool_calls",
    ]) {
      expect(await errorFor(code, true)).toEqual(retried);
      expect(await errorFor(code, false)).toEqual(retried);
    }
    expect(await errorFor("missing_thought_signature", false)).toEqual({
      message: "provider rejected the request (missing_thought_signature)",
      retryable: false,
      partial: undefined,
    });
  });

  test("HTTP errors: a bad key, no credit and no access aren't retried; limits and outages are, a daily quota isn't", async () => {
    const errorFor = async (status: number, code: string, message?: string) => {
      const { provider } = gemini(JSON.stringify({ error: { code, message } }), status);
      return (await failure(provider.stream(request(), quiet))) as ProviderError;
    };
    const shape = (e: ProviderError) => ({ message: e.message, retryable: e.retryable, partial: e.partial });
    expect(shape(await errorFor(401, "authentication"))).toEqual({
      message: "invalid provider API key",
      retryable: false,
      partial: undefined,
    });
    expect(shape(await errorFor(402, "payment_required"))).toMatchObject({
      message: "no prepaid credit left at the provider",
      retryable: false,
    });
    expect(shape(await errorFor(403, "permission_denied"))).toMatchObject({
      message: "provider denied access",
      retryable: false,
    });
    expect(shape(await errorFor(429, "rate_limit_exceeded"))).toMatchObject({
      message: "rate limited by provider",
      retryable: true,
    });
    expect(shape(await errorFor(429, "quota_exceeded"))).toMatchObject({
      message: "daily quota used up at the provider",
      retryable: false,
    });
    expect(shape(await errorFor(503, "service_unavailable"))).toMatchObject({
      message: "provider error",
      retryable: true,
    });
    // Another 4xx keeps Google's code, so a disabled billing reads as itself.
    expect(shape(await errorFor(400, "failed_precondition"))).toMatchObject({
      message: "provider rejected the request (400 failed_precondition)",
      retryable: false,
    });
    expect(shape(await errorFor(400, "invalid_argument", "API key not valid."))).toMatchObject({
      message: "provider rejected the request (400 invalid_argument): API key not valid.",
      retryable: false,
    });
  });

  test("a stream that breaks after text throws with what was received", async () => {
    const { provider } = gemini(
      sse(
        [
          created(),
          start(0, { type: "model_output" }),
          delta(0, { type: "text", text: "Half of" }),
          { event_type: "error", error: { code: "gateway_timeout", message: "Deadline expired" } },
        ],
        false,
      ),
    );
    const error = await failure(provider.stream(request(), quiet));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ message: "provider error", retryable: true });
    expect(error?.partial).toEqual({
      inputTokens: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: null,
      outputChars: 7,
    });
  });

  test("usage from the last step's running total when the interaction gives none; else estimated, never free", async () => {
    const total = {
      total_input_tokens: 900,
      total_cached_tokens: 100,
      total_output_tokens: 20,
      total_thought_tokens: 5,
    };
    const fromStep = gemini(
      sse([
        created(),
        start(0, { type: "model_output" }),
        delta(0, { type: "text", text: "ok" }),
        stop(0, total),
        completed("completed"),
      ]),
    );
    expect((await fromStep.provider.stream(request(), quiet)).usage).toEqual({
      inputTokens: 800,
      cacheReadTokens: 100,
      outputTokens: 25,
      cacheWriteTokens: 0,
    });
    const none = gemini(sse([created(), ...said(0, "12345678"), completed("completed")]));
    const estimated = await none.provider.stream(request(), quiet);
    expect(estimated.usage.inputTokens).toBeGreaterThan(0);
    expect(estimated.usage.outputTokens).toBe(2);
  });

  test("an aborted call: request aborted, not retried, with what streamed", async () => {
    const controller = new AbortController();
    const provider = createGeminiProvider({
      fetch: hanging([created(), start(0, { type: "model_output" }), delta(0, { type: "text", text: "Hel" })]),
    });
    const call = provider.stream(request({ signal: controller.signal }), {
      apiKey: "k",
      onDelta: () => controller.abort(),
    });
    const error = await failure(call);
    expect(error).toMatchObject({ message: "request aborted", retryable: false });
    expect(error?.partial?.outputChars).toBe(3);
  });

  test("a call stopped while the model thinks, before any words, still carries a partial so its prompt is billed", async () => {
    const controller = new AbortController();
    const provider = createGeminiProvider({
      fetch: hanging([created("gemini-4-argon"), start(0, { type: "thought" })], () => controller.abort()),
    });
    const error = await failure(
      provider.stream(request({ model: "gemini-4-argon", signal: controller.signal }), quiet),
    );
    expect(error).toMatchObject({ message: "request aborted", retryable: false });
    expect(error?.partial).toEqual({
      inputTokens: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: null,
      outputChars: 0,
    });
  });

  test("another provider's blocks are dropped; a result whose call isn't in the history goes without a name", async () => {
    const { provider, requests } = gemini(sse([created(), ...said(0, "ok"), completed("completed")]));
    await provider.stream(
      request({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "anthropic", data: { type: "thinking", signature: "x" } },
              { type: "opaque", provider: "openai", data: { type: "reasoning" } },
              { type: "text", text: "Done." },
            ],
          },
          { role: "user", content: [{ type: "tool_result", toolUseId: "gone", content: "late" }] },
        ],
      }),
      quiet,
    );
    expect(requests[0]?.body.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "hi" }] },
      { type: "model_output", content: [{ type: "text", text: "Done." }] },
      { type: "function_result", call_id: "gone", result: [{ type: "text", text: "late" }] },
    ]);
  });

  test("an incomplete interaction stopped at its output cap", async () => {
    const { provider } = gemini(sse([created(), ...said(0, "Cut"), completed("incomplete")]));
    expect((await provider.stream(request(), quiet)).stopReason).toBe("max_tokens");
  });
});

describe("server-sent events over fetch", () => {
  test("an event split across chunks, with CRLF line ends, reads whole", async () => {
    const chunks = ['data: {"a":', "1}\r", "\n\r\ndata: x\r\n", "data: y\r\n\r\n", "data: [DONE]"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const data of sseData(body)) out.push(data);
    expect(out).toEqual(['{"a":1}', "x\ny", "[DONE]"]);
  });
});
