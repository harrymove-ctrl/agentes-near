import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  checkOpenRouterKey,
  costNanoUsd,
  createOpenRouterProvider,
  enableOpenRouterModels,
  ensureOpenRouterModels,
  isKnownModel,
  type ModelRequest,
  modelInfo,
  openRouterListed,
  ProviderError,
  parseOpenRouterModels,
  reasoningFor,
  setOpenRouterModels,
} from "../src";
import fixture from "./fixtures/openrouter-models.json";

const models = () => parseOpenRouterModels(fixture);

afterEach(() => {
  enableOpenRouterModels(null);
  setOpenRouterModels({}, 0);
  setSystemTime();
});

/** Chat Completions chunks as an SSE body, with OpenRouter's keep-alive comment and the end marker. */
const sse = (chunks: Record<string, unknown>[], tail = "data: [DONE]\n\n") =>
  `: OPENROUTER PROCESSING\n\n${chunks.map((c) => `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, ...c })}\n\n`).join("")}${tail}`;

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

/** A fetch that records each request and answers with the next scripted body (the last one repeats). */
function scripted(...answers: { body: string; status?: number; type?: string }[]) {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: new Headers(init?.headers),
    });
    const a = answers[Math.min(requests.length - 1, answers.length - 1)] ?? { body: "" };
    return new Response(a.body, {
      status: a.status ?? 200,
      headers: { "content-type": a.type ?? "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const call = (request: Partial<ModelRequest>, fetcher: typeof fetch) => {
  const deltas: string[] = [];
  const result = createOpenRouterProvider({ fetch: fetcher, maxRetries: 0 }).stream(
    { model: "~z-ai/glm-latest", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 900, ...request },
    { apiKey: "or-test-key", onDelta: (d) => deltas.push(d) },
  );
  return { result, deltas };
};

const failure = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof ProviderError)) throw new Error(`expected a ProviderError, got ${String(error)}`);
  return error;
};

describe("OpenRouter's model list", () => {
  test("keeps models that call tools on Chat Completions and answer in text, the good picks first", () => {
    expect(Object.keys(models())).toEqual([
      "~z-ai/glm-latest",
      "~deepseek/deepseek-flash-latest",
      "~openai/gpt-luna-latest",
      "~anthropic/claude-sonnet-latest",
      "deepseek/deepseek-v4.1-flash-1017",
      "openai/gpt-6-luna",
      "z-ai/glm-5.3",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "anthropic/claude-sonnet-5.5",
      "qwen/qwen3.7-flash",
      "tencent/hy3-preview",
    ]);
    // Out: a batch variant (no endpoint), OpenRouter's own router (no price), one without tools, an 8K window.
    for (const id of [
      "anthropic/claude-haiku-5.5:batch",
      "openrouter/auto",
      "mistralai/mistral-small-24b-instruct-2501",
      "openai/gpt-4",
    ])
      expect(models()[id]).toBeUndefined();
  });

  test("the picks carry Automático's tiers and the routing, cheap and recommended marks; the rest is the long list", () => {
    const m = models();
    expect(m["~z-ai/glm-latest"]).toMatchObject({
      pick: true,
      tier: "medium",
      recommended: true,
      provider: "openrouter",
    });
    expect(m["~deepseek/deepseek-flash-latest"]).toMatchObject({ pick: true, tier: "small", cheap: true });
    expect(m["~openai/gpt-luna-latest"]).toMatchObject({ pick: true, router: true, leastThinking: "off" });
    // Claude's models by their own name, without "Anthropic:".
    expect(m["~anthropic/claude-sonnet-latest"]).toMatchObject({
      pick: true,
      tier: "large",
      label: "Claude Sonnet Latest",
    });
    expect(m["anthropic/claude-sonnet-5.5"]?.label).toBe("Claude Sonnet 5.5");
    expect(m["z-ai/glm-5.3"]).toMatchObject({ pick: false, label: "Z.ai: GLM 5.3" });
    expect(m["z-ai/glm-5.3"]?.tier).toBeUndefined();
  });

  test("prices in nano-USD per token, rounded up; a missing cache price is the input price", () => {
    const m = models();
    expect(m["tencent/hy3-preview"]?.prices).toEqual({ input: 180, output: 600, cacheRead: 60, cacheWrite: 180 });
    expect(m["anthropic/claude-sonnet-5.5"]?.prices).toEqual({
      input: 2000,
      output: 10000,
      cacheRead: 100,
      cacheWrite: 2500,
    });
    expect(m["nvidia/nemotron-3-ultra-550b-a55b:free"]?.prices).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // 0.0000000699 USD a token: 69.9 nano-USD, kept at 70.
    const alias = fixture.data.find((d) => d.id === "~z-ai/glm-latest");
    expect(alias?.pricing.prompt).toBe("0.0000000699");
    const lone = parseOpenRouterModels({ data: [{ ...alias, alias_target: null }] });
    expect(lone["~z-ai/glm-latest"]?.prices.input).toBe(70);
  });

  test("time-of-day prices count at their highest, a long-prompt override is long context, an alias at its target's dearer prices", () => {
    const m = models();
    // DeepSeek Flash: half price off-peak; the peak stands for every hour.
    expect(m["deepseek/deepseek-v4.1-flash-1017"]?.prices).toEqual({
      input: 300,
      output: 1200,
      cacheRead: 6,
      cacheWrite: 300,
    });
    expect(m["deepseek/deepseek-v4.1-flash-1017"]?.longContext).toBeUndefined();
    // GPT-6 Luna: dearer from 272K prompt tokens on.
    expect(m["openai/gpt-6-luna"]?.longContext).toEqual({
      aboveInputTokens: 271_999,
      prices: { input: 200, output: 750, cacheRead: 20, cacheWrite: 250 },
    });
    // Two long-prompt tiers: the lowest threshold with the dearest prices.
    expect(m["qwen/qwen3.7-flash"]?.longContext).toEqual({
      aboveInputTokens: 31_999,
      prices: { input: 200, output: 800, cacheRead: 40, cacheWrite: 250 },
    });
    // The aliases list lower prices than their targets: the targets' stand.
    expect(m["~z-ai/glm-latest"]?.prices).toEqual({ input: 104, output: 2769, cacheRead: 99, cacheWrite: 104 });
    expect(m["~deepseek/deepseek-flash-latest"]?.prices).toEqual(m["deepseek/deepseek-v4.1-flash-1017"]?.prices);
  });

  test("output pays at the dearer of completion and internal reasoning", () => {
    const hy3 = fixture.data.find((d) => d.id === "tencent/hy3-preview");
    const parsed = parseOpenRouterModels({
      data: [{ ...hy3, pricing: { ...hy3?.pricing, internal_reasoning: "0.000001" } }],
    });
    expect(parsed["tencent/hy3-preview"]?.prices.output).toBe(1000);
  });

  test("windows, output caps, efforts, the least thinking and structured output from the list", () => {
    const m = models();
    expect(m["~z-ai/glm-latest"]).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 943_718 });
    // Thinking can't be turned off and goes no lower than low.
    expect(m["~z-ai/glm-latest"]).toMatchObject({ reasoning: true, efforts: ["max", "high", "low"] });
    expect(m["~z-ai/glm-latest"]?.leastThinking).toBeUndefined();
    expect(m["tencent/hy3-preview"]).toMatchObject({ reasoning: true, leastThinking: "off", structuredOutput: false });
    // Thinks with no effort to choose: only on or off.
    expect(m["qwen/qwen3.7-flash"]?.reasoning).toBeUndefined();
    expect(m["qwen/qwen3.7-flash"]?.leastThinking).toBe("off");
    expect(m["~openai/gpt-luna-latest"]?.structuredOutput).toBeUndefined();
    expect(m["nvidia/nemotron-3-ultra-550b-a55b:free"]?.structuredOutput).toBe(false);
  });

  test("untrusted entries: bad ids, names, windows and prices are left out, and a pick without a schema routes nothing", () => {
    const base = fixture.data.find((d) => d.id === "tencent/hy3-preview");
    const variant = (patch: Record<string, unknown>) => parseOpenRouterModels({ data: [{ ...base, ...patch }] });
    expect(Object.keys(variant({ id: "../etc/passwd" }))).toEqual([]);
    expect(Object.keys(variant({ id: `a/${"x".repeat(100)}` }))).toEqual([]);
    expect(Object.keys(variant({ name: "x".repeat(121) }))).toEqual([]);
    expect(Object.keys(variant({ context_length: 16_384 }))).toEqual([]);
    expect(Object.keys(variant({ pricing: { prompt: "1", completion: "0.1" } }))).toEqual([]);
    expect(Object.keys(variant({ pricing: { prompt: "abc", completion: "0.1" } }))).toEqual([]);
    expect(parseOpenRouterModels(null)).toEqual({});
    expect(parseOpenRouterModels({ data: "nope" })).toEqual({});
    const luna = fixture.data.find((d) => d.id === "~openai/gpt-luna-latest");
    const noSchema = parseOpenRouterModels({
      data: [{ ...luna, alias_target: null, supported_parameters: ["tools", "reasoning"] }],
    });
    expect(noSchema["~openai/gpt-luna-latest"]?.router).toBeUndefined();
    expect(noSchema["~openai/gpt-luna-latest"]?.pick).toBe(true);
  });

  test("once in place, its models are known and priced like the catalog's", () => {
    expect(isKnownModel("z-ai/glm-5.3")).toBe(false);
    setOpenRouterModels(models());
    expect(isKnownModel("z-ai/glm-5.3")).toBe(true);
    expect(modelInfo("z-ai/glm-5.3")?.provider).toBe("openrouter");
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 0 };
    expect(costNanoUsd("z-ai/glm-5.3", usage)).toBe(1000 * 104 + 100 * 2769 + 2000 * 99);
    // A catalog id is never shadowed by a listed one.
    setOpenRouterModels({
      "claude-haiku-5-5": { ...(models()["z-ai/glm-5.3"] as NonNullable<ReturnType<typeof modelInfo>>) },
    });
    expect(modelInfo("claude-haiku-5-5")?.provider).toBe("anthropic");
  });
});

describe("effort", () => {
  test("goes as the nearest the model takes, a tie going up; none turns thinking off only where it can be", () => {
    const m = models();
    const glm = m["~z-ai/glm-latest"];
    expect(reasoningFor("medium", glm)).toEqual({ effort: "high" });
    expect(reasoningFor("low", glm)).toEqual({ effort: "low" });
    expect(reasoningFor("none", glm)).toEqual({ effort: "low" });
    expect(reasoningFor("none", m["~anthropic/claude-sonnet-latest"])).toEqual({ effort: "low" });
    expect(reasoningFor("medium", m["~anthropic/claude-sonnet-latest"])).toEqual({ effort: "medium" });
    expect(reasoningFor("none", m["~openai/gpt-luna-latest"])).toEqual({ effort: "none" });
    expect(reasoningFor("medium", m["nvidia/nemotron-3-ultra-550b-a55b:free"])).toEqual({ effort: "medium" });
    expect(reasoningFor("low", m["nvidia/nemotron-3-ultra-550b-a55b:free"])).toEqual({ effort: "medium" });
    // No effort to choose: only off, else the model's own default.
    expect(reasoningFor("none", m["qwen/qwen3.7-flash"])).toEqual({ enabled: false });
    expect(reasoningFor("high", m["qwen/qwen3.7-flash"])).toBeUndefined();
    expect(reasoningFor(undefined, glm)).toBeUndefined();
  });
});

describe("OpenRouter adapter (Chat Completions, scripted transport)", () => {
  test("the request: attribution, the key, system and tools, tool round trips, its own reasoning sent back", async () => {
    setOpenRouterModels(models());
    const reasoning = [{ type: "reasoning.text", text: "Look at the PR.", signature: "sig-1", index: 0, format: "x" }];
    const { fetcher, requests } = scripted({ body: sse([delta({ content: "ok" }, "stop")]) });
    await call(
      {
        model: "~z-ai/glm-latest",
        system: [{ text: "org", cache: true }, { text: "agent" }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "anthropic", data: { type: "thinking" } },
              { type: "opaque", provider: "openrouter", data: { details: reasoning } },
              { type: "text", text: "Checking." },
              { type: "tool_use", id: "call_0", name: "search_context", input: { query: "x" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "call_0", content: "nothing", isError: true },
              { type: "text", text: "and now?" },
            ],
          },
        ],
        tools: [
          { name: "b", description: "b", inputSchema: { type: "object" } },
          { name: "a", description: "a", inputSchema: { type: "object" } },
        ],
        effort: "medium",
      },
      fetcher,
    ).result;
    const req = requests[0];
    expect(req?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req?.headers.get("authorization")).toBe("Bearer or-test-key");
    expect(req?.headers.get("http-referer")).toBe("https://agentes.chat");
    expect(req?.headers.get("x-openrouter-title")).toBe("agentes.chat");
    expect(req?.body).toMatchObject({
      model: "~z-ai/glm-latest",
      max_tokens: 900,
      stream: true,
      reasoning: { effort: "high" },
    });
    // Not Claude: no cache markers, it caches by itself.
    expect(req?.body.cache_control).toBeUndefined();
    expect(req?.body.messages).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: "org" },
          { type: "text", text: "agent" },
        ],
      },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          { id: "call_0", type: "function", function: { name: "search_context", arguments: '{"query":"x"}' } },
        ],
        reasoning_details: reasoning,
      },
      { role: "tool", tool_call_id: "call_0", content: "ERROR: nothing" },
      { role: "user", content: "and now?" },
    ]);
    expect(req?.body.tools).toEqual([
      { type: "function", function: { name: "a", description: "a", parameters: { type: "object" } } },
      { type: "function", function: { name: "b", description: "b", parameters: { type: "object" } } },
    ]);
  });

  test("Claude gets cache breakpoints; a schema goes as strict JSON only to providers that honor it", async () => {
    setOpenRouterModels(models());
    const { fetcher, requests } = scripted({ body: sse([delta({ content: "{}" }, "stop")]) });
    const schema = { type: "object", properties: {}, additionalProperties: false };
    await call(
      {
        model: "~anthropic/claude-sonnet-latest",
        system: [{ text: "org", cache: true }, { text: "agent" }],
        outputSchema: schema,
        effort: "none",
      },
      fetcher,
    ).result;
    const body = requests[0]?.body;
    expect(body?.cache_control).toEqual({ type: "ephemeral" });
    expect((body?.messages as { content: unknown }[] | undefined)?.[0]?.content).toEqual([
      { type: "text", text: "org", cache_control: { type: "ephemeral" } },
      { type: "text", text: "agent" },
    ]);
    expect(body?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "output", strict: true, schema },
    });
    expect(body?.provider).toEqual({ require_parameters: true });
    // Claude's thinking can't be turned off on OpenRouter: the least it takes.
    expect(body?.reasoning).toEqual({ effort: "low" });
  });

  test("Claude's stable prefix for an hour; the stable tools first for every model", async () => {
    setOpenRouterModels(models());
    const { fetcher, requests } = scripted({ body: sse([delta({ content: "ok" }, "stop")]) });
    await call(
      {
        model: "~anthropic/claude-sonnet-latest",
        system: [{ text: "org" }, { text: "agent", cache: true }],
        cacheTtl: "1h",
        tools: [
          { name: "a_group_tool", description: "", inputSchema: {} },
          { name: "z_core", description: "", inputSchema: {}, stable: true },
        ],
      },
      fetcher,
    ).result;
    const body = requests[0]?.body;
    // The conversation's automatic breakpoint stays at 5 minutes (a longer entry must come first).
    expect(body?.cache_control).toEqual({ type: "ephemeral" });
    expect((body?.messages as { content: unknown }[] | undefined)?.[0]?.content).toEqual([
      { type: "text", text: "org" },
      { type: "text", text: "agent", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(((body?.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name)).toEqual([
      "z_core",
      "a_group_tool",
    ]);
  });

  test("the reply: text deltas, tool calls by index, merged reasoning, the answering model, split usage and OpenRouter's cost", async () => {
    setOpenRouterModels(models());
    const { fetcher } = scripted({
      body: sse([
        {
          model: "z-ai/glm-5.3",
          ...delta({ reasoning_details: [{ type: "reasoning.text", text: "Let me ", index: 0, format: "x" }] }),
        },
        {
          model: "z-ai/glm-5.3",
          ...delta({ reasoning_details: [{ type: "reasoning.text", text: "look.", index: 0 }] }),
        },
        {
          model: "z-ai/glm-5.3",
          ...delta({ reasoning_details: [{ type: "reasoning.text", signature: "sig", index: 0 }] }),
        },
        { model: "z-ai/glm-5.3", ...delta({ content: "Check" }) },
        { model: "z-ai/glm-5.3", ...delta({ content: "ing." }) },
        {
          model: "z-ai/glm-5.3",
          ...delta({
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "github_get_pr", arguments: "" } },
            ],
          }),
        },
        { model: "z-ai/glm-5.3", ...delta({ tool_calls: [{ index: 0, function: { arguments: '{"pr":' } }] }) },
        { model: "z-ai/glm-5.3", ...delta({ tool_calls: [{ index: 0, function: { arguments: "42}" } }] }) },
        {
          model: "z-ai/glm-5.3",
          ...delta({ tool_calls: [{ index: 1, id: "call_2", function: { name: "search_context", arguments: "{}" } }] }),
        },
        { model: "z-ai/glm-5.3", ...delta({}, "tool_calls") },
        // The usage chunk repeats the finish reason.
        {
          model: "z-ai/glm-5.3",
          ...delta({}, "tool_calls"),
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 50,
            total_tokens: 1050,
            prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
            completion_tokens_details: { reasoning_tokens: 10 },
            cost: 0.00012345,
            is_byok: false,
            cost_details: { upstream_inference_cost: 0.0001 },
          },
        },
      ]),
    });
    const { result, deltas } = call({ tools: [{ name: "github_get_pr", description: "", inputSchema: {} }] }, fetcher);
    const r = await result;
    expect(deltas).toEqual(["Check", "ing."]);
    expect(r.text).toBe("Checking.");
    expect(r.model).toBe("z-ai/glm-5.3");
    expect(r.stopReason).toBe("tool_use");
    expect(r.content).toEqual([
      {
        type: "opaque",
        provider: "openrouter",
        data: { details: [{ type: "reasoning.text", text: "Let me look.", index: 0, format: "x", signature: "sig" }] },
      },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "call_1", name: "github_get_pr", input: { pr: 42 } },
      { type: "tool_use", id: "call_2", name: "search_context", input: {} },
    ]);
    expect(r.usage).toEqual({ inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100 });
    // Not the person's own provider key: OpenRouter's charge is the whole cost.
    expect(r.costNanoUsd).toBe(123_450);
  });

  test("with the person's own provider key, the upstream charge is added to OpenRouter's fee", async () => {
    setOpenRouterModels(models());
    const { fetcher } = scripted({
      body: sse([
        delta({ content: "hi" }, "stop"),
        {
          ...delta({}, "stop"),
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            cost: 0.000005,
            is_byok: true,
            cost_details: { upstream_inference_cost: 0.0001 },
          },
        },
      ]),
    });
    expect((await call({}, fetcher).result).costNanoUsd).toBe(105_000);
  });

  test("finish reasons, and no usage chunk: tokens estimated, no reported cost", async () => {
    setOpenRouterModels(models());
    for (const [finish, stop] of [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["content_filter", "refusal"],
      ["something_new", "other"],
    ] as const) {
      const { fetcher } = scripted({ body: sse([delta({ content: "abcdefgh" }, finish)]) });
      const r = await call({}, fetcher).result;
      expect(r.stopReason).toBe(stop);
      expect(r.costNanoUsd).toBeUndefined();
      expect(r.usage).toEqual({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 });
    }
  });

  test("errors: a bad key and no credit aren't retried; limits, outages and a failure inside the stream are", async () => {
    const json = (status: number, code: number, message: string) => ({
      status,
      type: "application/json",
      body: JSON.stringify({ error: { code, message } }),
    });
    let e = await failure(call({}, scripted(json(401, 401, "No auth credentials found")).fetcher).result);
    expect(e).toMatchObject({ message: "invalid provider API key", retryable: false, status: 401 });
    e = await failure(call({}, scripted(json(402, 402, "Insufficient credits")).fetcher).result);
    expect(e).toMatchObject({ message: "no prepaid credit left at the provider", retryable: false, status: 402 });
    e = await failure(call({}, scripted(json(429, 429, "Rate limited")).fetcher).result);
    expect(e).toMatchObject({ retryable: true, status: 429 });
    e = await failure(call({}, scripted(json(503, 503, "No provider available")).fetcher).result);
    expect(e).toMatchObject({ message: "provider error", retryable: true, status: 503 });
    e = await failure(call({}, scripted(json(408, 408, "Timeout")).fetcher).result);
    expect(e).toMatchObject({ retryable: true, status: 408 });
    e = await failure(call({}, scripted(json(400, 400, "bad")).fetcher).result);
    expect(e).toMatchObject({ retryable: false, status: 400, said: "bad" });

    // Behind OpenRouter's generic words: the upstream's own, as text or as its JSON body.
    const upstream = (raw: string) => ({
      status: 429,
      type: "application/json",
      body: JSON.stringify({ error: { code: 429, message: "Provider returned error", metadata: { raw } } }),
    });
    e = await failure(call({}, scripted(upstream("x/y is temporarily rate-limited upstream")).fetcher).result);
    expect(e).toMatchObject({ said: "x/y is temporarily rate-limited upstream" });
    e = await failure(call({}, scripted(upstream('{"error":{"message":"busy\\n"}}')).fetcher).result);
    expect((e as ProviderError).said).toContain("busy");
    // A body that echoes the request is never shown: only its message is, else OpenRouter's words.
    const echoed = '{"detail":[{"msg":"Field required","input":{"role":"system","content":"private instructions"}}]}';
    e = await failure(call({}, scripted(upstream(echoed)).fetcher).result);
    expect(e).toMatchObject({ said: "Provider returned error" });
    e = await failure(call({}, scripted(upstream("<html>502 Bad Gateway</html>")).fetcher).result);
    expect(e).toMatchObject({ said: "Provider returned error" });

    // HTTP 200 already sent: the failure arrives as a chunk, its code the status it stands for.
    const broken = (code: unknown) =>
      sse(
        [
          delta({ content: "Hal" }),
          { ...delta({ content: "" }, "error"), error: { code, message: "Provider disconnected" } },
        ],
        "",
      );
    e = await failure(call({}, scripted({ body: broken(502) }).fetcher).result);
    expect(e).toMatchObject({ message: "provider error", retryable: true, status: 502 });
    expect(e.partial).toMatchObject({ outputChars: 3, inputTokens: null });
    e = await failure(call({}, scripted({ body: broken("server_error") }).fetcher).result);
    expect(e).toMatchObject({ message: "provider error", retryable: true });
    e = await failure(call({}, scripted({ body: broken(400) }).fetcher).result);
    expect(e).toMatchObject({ retryable: false, status: 400 });

    // A stream that ends without a finish reason was cut short.
    e = await failure(call({}, scripted({ body: sse([delta({ content: "Hal" })], "") }).fetcher).result);
    expect(e).toMatchObject({ retryable: true });
    expect(e.message).toContain("ended early");
  });
});

describe("the key check", () => {
  const answer = (status: number, body: unknown = {}) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("refused, a management key, accepted, or no answer either way; no model call", async () => {
    const urls: string[] = [];
    const ok = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: { label: "x", is_management_key: false, limit: null } }));
    }) as unknown as typeof fetch;
    expect(await checkOpenRouterKey("or-test-key", ok)).toBe("ok");
    expect(urls).toEqual(["https://openrouter.ai/api/v1/key"]);
    expect(await checkOpenRouterKey("or-test-key", answer(401))).toBe("invalid");
    expect(await checkOpenRouterKey("or-test-key", answer(200, { data: { is_management_key: true } }))).toBe(
      "management",
    );
    expect(await checkOpenRouterKey("or-test-key", answer(500))).toBe("unchecked");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkOpenRouterKey("or-test-key", down)).toBe("unchecked");
    // A pasted curly quote can't be a key.
    expect(await checkOpenRouterKey("or-test-key”", ok)).toBe("invalid");
  });
});

describe("the list in memory", () => {
  const counting = (fail = false) => {
    let reads = 0;
    const f = (async (url: string | URL | Request) => {
      reads++;
      expect(String(url)).toBe("https://openrouter.ai/api/v1/models?sort=most-popular&limit=1000");
      if (fail) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(fixture));
    }) as unknown as typeof fetch;
    return { f, reads: () => reads };
  };

  test("nothing is read until reading is turned on", async () => {
    const { f, reads } = counting();
    await ensureOpenRouterModels();
    expect(openRouterListed()).toBe(false);
    enableOpenRouterModels(f);
    await Promise.all([ensureOpenRouterModels(), ensureOpenRouterModels("z-ai/glm-5.3")]);
    expect(reads()).toBe(1);
    expect(openRouterListed()).toBe(true);
    expect(modelInfo("z-ai/glm-5.3")?.label).toBe("Z.ai: GLM 5.3");
  });

  test("a list over an hour old answers while one read refreshes it; a model not in it waits for a read", async () => {
    const { f, reads } = counting();
    enableOpenRouterModels(f);
    setSystemTime(new Date("2026-10-30T10:00:00Z"));
    await ensureOpenRouterModels();
    setSystemTime(new Date("2026-10-30T10:30:00Z"));
    await ensureOpenRouterModels("z-ai/glm-5.3");
    expect(reads()).toBe(1);
    // A model it doesn't have, with a list over a minute old: read again, waited for.
    await ensureOpenRouterModels("acme/new-model");
    expect(reads()).toBe(2);
    setSystemTime(new Date("2026-10-30T12:00:00Z"));
    const pending = ensureOpenRouterModels("z-ai/glm-5.3");
    await pending;
    expect(modelInfo("z-ai/glm-5.3")).toBeDefined();
    await Bun.sleep(0);
    expect(reads()).toBe(3);
  });

  test("a failed read isn't tried again for a minute", async () => {
    const failing = counting(true);
    enableOpenRouterModels(failing.f);
    setSystemTime(new Date("2026-10-30T10:00:00Z"));
    await ensureOpenRouterModels();
    await ensureOpenRouterModels("z-ai/glm-5.3");
    expect(failing.reads()).toBe(1);
    expect(openRouterListed()).toBe(false);
    setSystemTime(new Date("2026-10-30T10:01:01Z"));
    const ok = counting();
    enableOpenRouterModels(ok.f);
    await ensureOpenRouterModels();
    expect(ok.reads()).toBe(1);
    expect(openRouterListed()).toBe(true);
  });
});
