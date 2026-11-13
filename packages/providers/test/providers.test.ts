import { afterEach, describe, expect, test } from "bun:test";
import {
  cheapModelOf,
  contextWindowOf,
  costNanoUsd,
  isKnownModel,
  listedModels,
  MODEL_CATALOG,
  MODEL_TIERS,
  maxCostNanoUsd,
  modelForTier,
  outputTokensWithin,
  PROVIDER_IDS,
  PROVIDERS,
  ProviderError,
  parseOpenRouterModels,
  pricesAt,
  providerCause,
  routerModelOf,
  setOpenRouterModels,
  summedCostNanoUsd,
  usdToNanoUsd,
} from "../src";
import { createFakeProvider } from "../src/fake";
import fixture from "./fixtures/openrouter-models.json";

afterEach(() => setOpenRouterModels({}, 0));

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe("pricing", () => {
  test("Sonnet 5.5: $2 / $10 per million tokens, $0.10 cache reads", () => {
    expect(costNanoUsd("claude-sonnet-5-5", usage(1_000_000, 0))).toBe(usdToNanoUsd(2));
    expect(costNanoUsd("claude-sonnet-5-5", usage(0, 1_000_000))).toBe(usdToNanoUsd(10));
    expect(costNanoUsd("claude-sonnet-5-5", usage(0, 0, 1_000_000))).toBe(usdToNanoUsd(0.1));
  });

  test("Fable 5.1: $10 / $0.25 / $12.50 / $50 across its whole 1M window, chosen only by people", () => {
    const perMTok = [usage(1e6, 0), usage(0, 0, 1e6), usage(0, 0, 0, 1e6), usage(0, 1e6)].map(
      (u) => costNanoUsd("claude-fable-5-1", u) / 1e9,
    );
    expect(perMTok).toEqual([10, 0.25, 12.5, 50]);
    expect(costNanoUsd("claude-fable-5-1", usage(900_000, 0))).toBe(900_000 * 10000);
    expect(MODEL_CATALOG["claude-fable-5-1"]).toMatchObject({ provider: "anthropic", contextWindow: 1_000_000 });
    expect(MODEL_CATALOG["claude-fable-5-1"]?.tier).toBeUndefined();
  });

  test("1-hour cache writes cost twice the input price, and reservations allow for them", () => {
    // Opus 5.5: $4 input, $5 per million for 5-minute writes, $8 for 1-hour ones.
    const written = { ...usage(0, 0, 0, 1_000_000), cacheWriteLongTokens: 800_000 };
    expect(costNanoUsd("claude-opus-5-5", written)).toBe(usdToNanoUsd(0.2 * 5 + 0.8 * 8));
    expect(maxCostNanoUsd("claude-opus-5-5", 1000, 0)).toBe(1000 * 5000);
    expect(maxCostNanoUsd("claude-opus-5-5", 1000, 0, true)).toBe(1000 * 8000);
    expect(outputTokensWithin("claude-opus-5-5", 1000, 1000 * 8000, true)).toBe(0);
  });

  test("Haiku 5.5 switches to long-context prices above 100K prompt tokens", () => {
    expect(costNanoUsd("claude-haiku-5-5", usage(100_000, 1000))).toBe(100_000 * 100 + 1000 * 500);
    expect(costNanoUsd("claude-haiku-5-5", usage(90_000, 1000, 20_000))).toBe(90_000 * 500 + 1000 * 2500 + 20_000 * 50);
    // Many calls' tokens added up never cross it: the sum is no one call's prompt.
    expect(summedCostNanoUsd("claude-haiku-5-5", usage(90_000, 1000, 20_000))).toBe(
      90_000 * 100 + 1000 * 500 + 20_000 * 10,
    );
  });

  test("GPT-6.1 Sol: $2 / $0.10 / $2.50 / $10, and $4 / $0.20 / $5 / $15 above 272K prompt tokens", () => {
    // 272,000 prompt tokens exactly: still the base prices.
    expect(costNanoUsd("gpt-6.1-sol", usage(100_000, 1000, 100_000, 72_000))).toBe(
      100_000 * 2000 + 1000 * 10000 + 100_000 * 100 + 72_000 * 2500,
    );
    expect(costNanoUsd("gpt-6.1-sol", usage(100_001, 1000, 100_000, 72_000))).toBe(
      100_001 * 4000 + 1000 * 15000 + 100_000 * 200 + 72_000 * 5000,
    );
  });

  test("GPT-6.1 Terra: $1 / $0.05 / $1.25 / $5, and $2 / $0.10 / $2.50 / $7.50 above 272K prompt tokens", () => {
    expect(costNanoUsd("gpt-6.1-terra", usage(100_000, 1000, 100_000, 72_000))).toBe(
      100_000 * 1000 + 1000 * 5000 + 100_000 * 50 + 72_000 * 1250,
    );
    expect(costNanoUsd("gpt-6.1-terra", usage(100_001, 1000, 100_000, 72_000))).toBe(
      100_001 * 2000 + 1000 * 7500 + 100_000 * 100 + 72_000 * 2500,
    );
    // People pick it: never Automático's, the router's or the system tasks' choice.
    expect(MODEL_CATALOG["gpt-6.1-terra"]).toMatchObject({ provider: "openai", contextWindow: 1_050_000 });
    expect(MODEL_CATALOG["gpt-6.1-terra"]?.tier).toBeUndefined();
  });

  test("GPT-6 Astra: $10 / $1 / $12.50 / $50, and $20 / $2 / $25 / $75 above 272K prompt tokens", () => {
    expect(costNanoUsd("gpt-6-astra", usage(100_000, 1000, 100_000, 72_000))).toBe(
      100_000 * 10000 + 1000 * 50000 + 100_000 * 1000 + 72_000 * 12500,
    );
    expect(costNanoUsd("gpt-6-astra", usage(100_001, 1000, 100_000, 72_000))).toBe(
      100_001 * 20000 + 1000 * 75000 + 100_000 * 2000 + 72_000 * 25000,
    );
    // People pick it: never Automático's, the router's or the system tasks' choice.
    expect(MODEL_CATALOG["gpt-6-astra"]).toMatchObject({ provider: "openai", label: "GPT-6 Astra", reasoning: true });
    expect(contextWindowOf("gpt-6-astra")).toBe(1_050_000);
    expect(MODEL_CATALOG["gpt-6-astra"]?.tier).toBeUndefined();
  });

  test("GPT-6 Sol and Luna: input, cached input and cache writes 2×, output 1.5× above 272K prompt tokens", () => {
    expect(costNanoUsd("gpt-6-sol", usage(272_000, 1000))).toBe(272_000 * 2000 + 1000 * 10000);
    expect(costNanoUsd("gpt-6-sol", usage(200_000, 1000, 72_001))).toBe(200_000 * 4000 + 1000 * 15000 + 72_001 * 400);
    expect(costNanoUsd("gpt-6-luna", usage(272_001, 1000, 0, 10))).toBe(272_001 * 200 + 1000 * 750 + 10 * 250);
  });

  test("every model's provider exists, and each provider has one recommended model", () => {
    for (const m of Object.values(MODEL_CATALOG)) expect(PROVIDER_IDS).toContain(m.provider);
    // A workspace's own endpoint has no catalog models.
    const recommended = Object.keys(PROVIDERS)
      .filter((p) => p !== "custom")
      .map((provider) =>
        Object.entries(MODEL_CATALOG)
          .filter(([, m]) => m.provider === provider && m.recommended)
          .map(([id]) => id),
      );
    expect(recommended).toEqual([
      ["claude-sonnet-5-5"],
      ["gpt-6.1-sol"],
      ["gemini-3.8-flash"],
      ["deepseek-flash"],
      ["kimi-k3.1-pro"],
      ["glm-5.3"],
      ["MiniMax-M3"],
      // OpenRouter's come from its list.
      [],
    ]);
  });

  test("DeepSeek (its peak rates), Kimi, GLM and MiniMax at their published USD per million tokens", () => {
    // Input, output, cache read, cache write.
    const perMTok = (model: string) =>
      [usage(1e6, 0), usage(0, 1e6), usage(0, 0, 1e6), usage(0, 0, 0, 1e6)].map((u) => costNanoUsd(model, u) / 1e9);
    expect(perMTok("deepseek-flash")).toEqual([0.3, 1.2, 0.006, 0.3]);
    expect(perMTok("deepseek-v4-pro")).toEqual([1.32, 3.96, 0.044, 1.32]);
    expect(perMTok("kimi-k3.1-pro")).toEqual([2, 10, 0.2, 2]);
    expect(perMTok("kimi-k3")).toEqual([3, 15, 0.3, 3]);
    expect(perMTok("glm-5.3")).toEqual([1.4, 4.4, 0.26, 1.4]);
    expect(perMTok("glm-5.3-flash")).toEqual([0.15, 0.5, 0.03, 0.15]);
    expect(perMTok("MiniMax-M3.1-Flash")).toEqual([0.15, 0.6, 0.015, 0.15]);
    // MiniMax M3: $0.30 / $1.20 / $0.06 up to 512K prompt tokens, double above.
    expect(costNanoUsd("MiniMax-M3", usage(500_000, 1000, 12_000))).toBe(500_000 * 300 + 1000 * 1200 + 12_000 * 60);
    expect(costNanoUsd("MiniMax-M3", usage(500_000, 1000, 12_001))).toBe(500_000 * 600 + 1000 * 2400 + 12_001 * 120);
  });

  test("system tasks use a provider's cheap model, else its recommended one; Automático's tiers per line", () => {
    expect(PROVIDER_IDS.map((p) => cheapModelOf(p))).toEqual([
      "claude-haiku-5-5",
      "gpt-6-luna",
      "gemini-3.5-flash-lite",
      "deepseek-flash",
      "kimi-k3.1-pro",
      "glm-5.3-flash",
      "MiniMax-M3.1-Flash",
      null,
      null,
    ]);
    const line = (provider: string) => MODEL_TIERS.map((tier) => modelForTier(provider, tier));
    expect(line("gemini")).toEqual(["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-4-argon"]);
    expect(line("deepseek")).toEqual(["deepseek-flash", "deepseek-flash", "deepseek-v4-pro"]);
    expect(line("moonshot")).toEqual(["kimi-k3.1-pro", "kimi-k3.1-pro", "kimi-k3.1-pro"]);
    expect(line("zai")).toEqual(["glm-5.3-flash", "glm-5.3", "glm-5.3"]);
    expect(line("minimax")).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M3"]);
  });

  test("routing picks one model per provider, never Kimi's (its cheapest always thinks)", () => {
    expect(PROVIDER_IDS.map((p) => routerModelOf(p))).toEqual([
      "claude-haiku-5-5",
      "gpt-6-luna",
      "gemini-3.5-flash-lite",
      "deepseek-flash",
      null,
      "glm-5.3-flash",
      "MiniMax-M3",
      null,
      null,
    ]);
    for (const provider of PROVIDER_IDS) {
      const picks = Object.values(MODEL_CATALOG).filter((m) => m.provider === provider && m.router);
      expect(picks).toHaveLength(["moonshot", "openrouter", "custom"].includes(provider) ? 0 : 1);
    }
    // GLM-5.3 Flash can't stop thinking, Flash-Lite keeps a little, every other pick turns it off.
    expect(MODEL_CATALOG["glm-5.3-flash"]?.leastThinking).toBeUndefined();
    expect(MODEL_CATALOG["gemini-3.5-flash-lite"]?.leastThinking).toBe("minimal");
    expect(MODEL_CATALOG["MiniMax-M3"]?.leastThinking).toBe("off");
  });

  test("Gemini at Google's prices, Argon and 3.8 Flash at half until their day (UTC); the list price shown after", () => {
    // Input, output, cache read, cache write, for a call made at `at`.
    const perMTok = (model: string, at: string) =>
      [usage(1e6, 0), usage(0, 1e6), usage(0, 0, 1e6), usage(0, 0, 0, 1e6)].map(
        (u) => costNanoUsd(model, u, new Date(at)) / 1e9,
      );
    expect(perMTok("gemini-4-argon", "2026-11-30T23:59:59Z")).toEqual([2, 10, 0.1, 2]);
    expect(perMTok("gemini-4-argon", "2026-12-01T00:00:00Z")).toEqual([4, 20, 0.2, 4]);
    expect(perMTok("gemini-3.8-flash", "2026-12-31T23:59:59Z")).toEqual([0.75, 3.75, 0.075, 0.75]);
    expect(perMTok("gemini-3.8-flash", "2027-01-01T00:00:00Z")).toEqual([1.5, 7.5, 0.15, 1.5]);
    expect(perMTok("gemini-3.5-flash-lite", "2026-10-27T12:00:00Z")).toEqual([0.3, 2.5, 0.03, 0.3]);
    expect(perMTok("gemini-3.5-flash-lite", "2027-06-01T00:00:00Z")).toEqual([0.3, 2.5, 0.03, 0.3]);
    const argon = MODEL_CATALOG["gemini-4-argon"];
    if (!argon) throw new Error("no Argon");
    expect(pricesAt(argon, new Date("2026-11-01T00:00:00Z")).input).toBe(2000);
    expect(pricesAt(argon, new Date("2026-12-01T00:00:00Z"))).toBe(argon.prices);
  });

  test("costs are exact integers", () => {
    for (const model of Object.keys(MODEL_CATALOG)) {
      expect(Number.isInteger(costNanoUsd(model, usage(123, 456, 7, 8)))).toBe(true);
      expect(Number.isInteger(costNanoUsd(model, usage(123, 456, 7, 8), new Date("2026-11-01T00:00:00Z")))).toBe(true);
    }
  });

  test("unknown models can't be priced", () => {
    expect(isKnownModel("gpt-5")).toBe(false);
    expect(() => costNanoUsd("gpt-5", usage(1, 1))).toThrow(/unknown model/);
  });

  test("defaults from config are in the catalog", () => {
    expect(isKnownModel("claude-sonnet-5-5")).toBe(true);
    expect(isKnownModel("claude-haiku-5-5")).toBe(true);
  });
});

describe("models listed at run time (OpenRouter's)", () => {
  test("unknown until the list is in place; then known, priced and tiered like the catalog's, after it", () => {
    expect(isKnownModel("~z-ai/glm-latest")).toBe(false);
    expect(modelForTier("openrouter", "medium")).toBeNull();
    setOpenRouterModels(parseOpenRouterModels(fixture));
    expect(isKnownModel("~z-ai/glm-latest")).toBe(true);
    const line = MODEL_TIERS.map((tier) => modelForTier("openrouter", tier));
    expect(line).toEqual(["~deepseek/deepseek-flash-latest", "~z-ai/glm-latest", "~anthropic/claude-sonnet-latest"]);
    expect(routerModelOf("openrouter")).toBe("~openai/gpt-luna-latest");
    expect(cheapModelOf("openrouter")).toBe("~deepseek/deepseek-flash-latest");
    // The catalog's lines don't change.
    expect(modelForTier("anthropic", "medium")).toBe("claude-sonnet-5-5");
    const ids = listedModels().map(([id]) => id);
    expect(ids.slice(0, Object.keys(MODEL_CATALOG).length)).toEqual(Object.keys(MODEL_CATALOG));
    expect(ids.at(-1)).toBe("tencent/hy3-preview");
    expect(contextWindowOf("~z-ai/glm-latest")).toBe(1_048_576);
    // GPT-6 Luna through OpenRouter: dearer from 272K prompt tokens on, as OpenAI bills it.
    const u = (inputTokens: number) => ({ inputTokens, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(costNanoUsd("openai/gpt-6-luna", u(271_999))).toBe(271_999 * 100 + 1000 * 500);
    expect(costNanoUsd("openai/gpt-6-luna", u(272_000))).toBe(272_000 * 200 + 1000 * 750);
    // A reservation at the worst case: every prompt token at the cache-write rate.
    expect(maxCostNanoUsd("openai/gpt-6-luna", 1000, 500)).toBe(1000 * 125 + 500 * 500);
    // A free model reserves nothing and is never out of budget.
    expect(maxCostNanoUsd("nvidia/nemotron-3-ultra-550b-a55b:free", 1000, 500)).toBe(0);
    expect(outputTokensWithin("nvidia/nemotron-3-ultra-550b-a55b:free", 1000, 1)).toBe(Number.POSITIVE_INFINITY);
    setOpenRouterModels({}, 0);
    expect(isKnownModel("~z-ai/glm-latest")).toBe(false);
  });
});

describe("fake provider", () => {
  test("streams chunks and records the call", async () => {
    const fake = createFakeProvider();
    const deltas: string[] = [];
    const result = await fake.stream(
      { model: "claude-sonnet-5-5", system: "s", messages: [{ role: "user", content: "hello" }], maxTokens: 100 },
      { apiKey: "sk-test", onDelta: (d) => deltas.push(d) },
    );
    expect(deltas.join("")).toBe("Echo: hello.");
    expect(result.text).toBe("Echo: hello.");
    expect(fake.calls[0]?.apiKey).toBe("sk-test");
  });

  test("can be scripted to fail", async () => {
    const fake = createFakeProvider(() => new Error("boom"));
    await expect(
      fake.stream({ model: "m", system: "", messages: [], maxTokens: 1 }, { apiKey: "", onDelta: () => {} }),
    ).rejects.toThrow("boom");
  });
});

describe("providerCause", () => {
  const cause = (status: number | undefined, message: string, said?: string) =>
    providerCause(new ProviderError(message, false, status, undefined, said));

  test.each([
    // OpenRouter
    [402, "no prepaid credit left at the provider", "Insufficient credits", "no_credit"],
    [403, "provider denied access", "Key limit exceeded (total limit)", "no_credit"],
    [401, "invalid provider API key", "No auth credentials found", "invalid_key"],
    [404, "provider rejected the request (404)", "No endpoints found for x/y.", "model_unavailable"],
    [400, "provider rejected the request (400)", "x/y is not a valid model ID", "model_unavailable"],
    [429, "rate limited by provider", "Rate limit exceeded: free-models-per-min", "rate_limit"],
    [502, "provider error", "Provider returned error", "down"],
    [503, "provider error", "No provider available", "down"],
    [408, "provider error", "Timeout", "timeout"],
    [403, "provider denied access", "Your input was flagged by moderation", null],
    // OpenAI
    [429, "no prepaid credit left at the provider", "You exceeded your current quota", "no_credit"],
    [401, "invalid provider API key", "Incorrect API key provided", "invalid_key"],
    [404, "provider rejected the request (404)", "The model `x` does not exist", "model_unavailable"],
    [403, "provider denied access", "Country, region, or territory not supported", "no_access"],
    [500, "provider error", undefined, "down"],
    [undefined, "provider timed out", undefined, "timeout"],
    [undefined, "could not reach provider", undefined, "unreachable"],
    // Claude
    [400, "provider rejected the request (400 invalid_request_error)", "Your credit balance is too low", "no_credit"],
    [400, "provider rejected the request (400)", "You have reached your specified API usage limits", "no_credit"],
    [404, "provider rejected the request (404 not_found_error)", "model: claude-x", "model_unavailable"],
    [529, "provider error", undefined, "down"],
    [504, "provider error", undefined, "timeout"],
    // The words as adapters put them after a message's start
    [429, "no prepaid credit left at the provider (429 insufficient_quota): Add credit.", "Add credit.", "no_credit"],
    [403, "provider denied access (403 permission_error): Org disabled.", "Org disabled.", "no_access"],
    [403, "provider denied access (403 model_not_found): No access to m.", "No access to m.", "model_unavailable"],
    // Gemini: over for the day, nothing a wait in this conversation fixes
    [429, "daily quota used up at the provider", undefined, "no_credit"],
  ] as const)("%s %s (%s) is %s", (status, message, said, expected) => {
    expect(cause(status, message, said)).toBe(expected);
  });

  test("a refusal that names no cause stays the provider's to say", () => {
    expect(cause(400, "provider rejected the request (400)", "tools: too many")).toBeNull();
    expect(cause(undefined, "could not read the model's reply: the stream ended early")).toBeNull();
  });
});
