import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import {
  isCustomModel,
  type ModelInfo,
  type ModelTier,
  modelInfo,
  setListedModels,
  type TokenPrices,
  usdToNanoUsd,
} from "./catalog";
import { openAIError, saidIn } from "./openai";
import {
  type ContentBlock,
  deniedError,
  estimateTokens,
  laidOut,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
  type PartialUsage,
  ProviderError,
  promptChars,
  type StopReason,
  stableToolsFirst,
  withoutImages,
} from "./types";

/**
 * OpenRouter (ADR 0087): one key for many makers' models, over OpenAI's Chat Completions. Its models come from its
 * public list, read at run time with no key and kept in memory; nothing about it is stored.
 */
export const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** OpenRouter's app attribution: the product's name and site, never a self-hosted server's own address. */
const ATTRIBUTION = { "HTTP-Referer": "https://agentes.chat", "X-OpenRouter-Title": "agentes.chat" };

/** An OpenRouter model id (`z-ai/glm-5.3`, `~z-ai/glm-latest`): the catalog's ids never have a slash. */
export const isOpenRouterModel = (model: string) => model.includes("/") && !isCustomModel(model);

/**
 * A model's provider: a workspace endpoint's by its id, the catalog's or the list's, else OpenRouter's by the id's
 * shape (its list not read yet).
 */
export const modelProvider = (model: string) =>
  isCustomModel(model)
    ? "custom"
    : (modelInfo(model)?.provider ?? (isOpenRouterModel(model) ? "openrouter" : undefined));

/**
 * The good picks, shown first: capable with tools and cheap. Each is a family's `~…-latest` alias, which follows the
 * family's newest model, so the list doesn't age. The tiers are what Automático uses on an OpenRouter key (a
 * workspace can choose others); a pick OpenRouter stops listing is skipped.
 */
export const OPENROUTER_PICKS: readonly {
  id: string;
  tier?: ModelTier;
  recommended?: true;
  cheap?: true;
  router?: true;
}[] = [
  { id: "~z-ai/glm-latest", tier: "medium", recommended: true },
  { id: "~deepseek/deepseek-flash-latest", tier: "small", cheap: true },
  // Fast, with thinking that turns off: the pick for routing and the judge.
  { id: "~openai/gpt-luna-latest", router: true },
  { id: "~anthropic/claude-sonnet-latest", tier: "large" },
  { id: "~deepseek/deepseek-pro-latest" },
  { id: "~google/gemini-flash-latest" },
  { id: "~anthropic/claude-haiku-latest" },
];

/** OpenRouter's reasoning efforts, highest first, as its list gives them. */
const EFFORTS = ["max", "xhigh", "high", "medium", "low", "minimal", "none"] as const;
type Effort = (typeof EFFORTS)[number];
const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort);

const CHAT = "/api/v1/chat/completions";
const ID = /^~?[a-z0-9][\w.-]*\/[\w.:-]+$/;
/** A smaller window can't hold an agent's prompt (instructions, context, tools) and its reply. */
const MIN_CONTEXT = 32_000;
const MAX_MODELS = 2000;
/** A listed price above this (USD per token) is taken as an error: the dearest real ones are near 0.0002. */
const MAX_USD_PER_TOKEN = 0.01;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

/** A listed USD-per-token price in nano-USD, rounded up; undefined unless it is a sane number. */
function nano(v: unknown): number | undefined {
  if (typeof v !== "number" && !(typeof v === "string" && v.trim() !== "")) return undefined;
  const usd = Number(v);
  if (!Number.isFinite(usd) || usd < 0 || usd > MAX_USD_PER_TOKEN) return undefined;
  // Rounded to a pico-USD first, so a decimal like 0.00000015 doesn't round up from float noise.
  return Math.ceil(Math.round(usd * 1e12) / 1000);
}

/** Prices of a `pricing` object; undefined without sane prompt and completion prices. */
function pricesOf(p: Raw): TokenPrices | undefined {
  const input = nano(p.prompt);
  const completion = nano(p.completion);
  if (input === undefined || completion === undefined) return undefined;
  return {
    input,
    // Reasoning tokens are counted as output: they pay at the dearer of the two rates.
    output: Math.max(completion, nano(p.internal_reasoning) ?? 0),
    cacheRead: nano(p.input_cache_read) ?? input,
    cacheWrite: nano(p.input_cache_write) ?? input,
  };
}

const higher = (a: TokenPrices, b: TokenPrices): TokenPrices => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
});

/**
 * A model's prices, erring high: an override for long prompts becomes `longContext` (the lowest threshold, the
 * dearest prices), and any other (a time of day, weekdays) is folded in by taking each price's highest.
 */
function pricingOf(raw: Raw): Pick<ModelInfo, "prices" | "longContext"> | undefined {
  const pricing = obj(raw.pricing);
  const base = pricing && pricesOf(pricing);
  if (!pricing || !base) return undefined;
  let prices = base;
  let long: ModelInfo["longContext"];
  for (const item of Array.isArray(pricing.overrides) ? pricing.overrides : []) {
    const o = obj(item);
    const at = o && pricesOf({ ...pricing, ...o });
    if (!o || !at) continue;
    const from = o.min_prompt_tokens;
    const timed = "utc_days" in o || "utc_start" in o || "utc_end" in o;
    if (typeof from === "number" && Number.isInteger(from) && from > 0 && !timed) {
      // OpenRouter's override starts at `min_prompt_tokens`; ours applies above `aboveInputTokens`.
      long = {
        aboveInputTokens: Math.min(long?.aboveInputTokens ?? from - 1, from - 1),
        prices: long ? higher(long.prices, at) : at,
      };
    } else prices = higher(prices, at);
  }
  return { prices, ...(long ? { longContext: { ...long, prices: higher(long.prices, prices) } } : {}) };
}

/**
 * OpenRouter's model list (`GET /api/v1/models`) as catalog entries: only models that call tools over Chat
 * Completions and answer in text, with a known price, a window of at least 32K tokens and an id and name that look
 * right (the list is outside data). The good picks first, in their order, then the rest in the list's.
 */
export function parseOpenRouterModels(body: unknown): Record<string, ModelInfo> {
  const data = obj(body)?.data;
  const raws = (Array.isArray(data) ? data : []).flatMap((m) => (obj(m) ? [m as Raw] : []));
  const byId = new Map(raws.flatMap((m) => (typeof m.id === "string" ? [[m.id, m] as const] : [])));
  const picks = new Map(OPENROUTER_PICKS.map((p, i) => [p.id, { ...p, order: i }]));
  const parsed: [string, ModelInfo, number][] = [];
  for (const m of raws) {
    if (parsed.length >= MAX_MODELS) break;
    const { id, name, context_length: window } = m;
    if (typeof id !== "string" || id.length > 100 || !ID.test(id) || id.startsWith("openrouter/")) continue;
    if (typeof name !== "string" || !name.trim() || name.length > 120) continue;
    if (typeof window !== "number" || !Number.isInteger(window) || window < MIN_CONTEXT) continue;
    const params = strings(m.supported_parameters);
    if (!strings(m.endpoints).includes(CHAT) || !params.includes("tools")) continue;
    if (!strings(obj(m.architecture)?.output_modalities).includes("text")) continue;
    let pricing = pricingOf(m);
    if (!pricing) continue;
    // An alias bills at the model it points to: the dearer of the two stands for it.
    const target = obj(m.alias_target)?.slug;
    const aimed = typeof target === "string" ? byId.get(target) : undefined;
    const targetPricing = aimed && pricingOf(aimed);
    if (targetPricing) {
      const prices = higher(pricing.prices, targetPricing.prices);
      const long = pricing.longContext ?? targetPricing.longContext;
      pricing = { prices, ...(long ? { longContext: { ...long, prices: higher(long.prices, prices) } } : {}) };
    }
    const maxOut = obj(m.top_provider)?.max_completion_tokens;
    const reasoning = obj(m.reasoning);
    const listed = reasoning?.supported_efforts;
    // Null: every effort; absent: no effort to choose (thinking can still be turned off unless mandatory).
    const efforts =
      listed === null ? [...EFFORTS] : Array.isArray(listed) ? EFFORTS.filter((e) => listed.includes(e)) : [];
    const mandatory = reasoning?.mandatory === true;
    const least = efforts.filter((e) => e !== "none").at(-1);
    const structured = params.includes("structured_outputs");
    const pick = picks.get(id);
    parsed.push([
      id,
      {
        provider: "openrouter",
        // People know Anthropic's models as Claude's: "Claude Sonnet 5.5", as the catalog names them.
        label: name.trim().replace(/^Anthropic: /, ""),
        ...pricing,
        contextWindow: window,
        ...(typeof maxOut === "number" && Number.isInteger(maxOut) && maxOut > 0 ? { maxOutputTokens: maxOut } : {}),
        serverSideFallback: false,
        ...(efforts.length > 0 ? { reasoning: true } : {}),
        ...(Array.isArray(listed) ? { efforts } : {}),
        ...(reasoning && !mandatory ? { leastThinking: "off" as const } : {}),
        ...(mandatory && least === "minimal" ? { leastThinking: "minimal" as const } : {}),
        ...(structured ? {} : { structuredOutput: false as const }),
        pick: pick !== undefined,
        ...(pick?.tier ? { tier: pick.tier } : {}),
        ...(pick?.recommended ? { recommended: true } : {}),
        // Routing, the judge and summaries answer through a schema.
        ...(pick?.cheap && structured ? { cheap: true } : {}),
        ...(pick?.router && structured ? { router: true } : {}),
      },
      pick?.order ?? OPENROUTER_PICKS.length,
    ]);
  }
  // A stable sort: the picks in their order, the rest as listed (most popular first).
  return Object.fromEntries(parsed.sort((a, b) => a[2] - b[2]).map(([id, info]) => [id, info]));
}

// ── The list in memory ──────────────────────────────────────────────────────

const LIST_TTL_MS = 60 * 60_000;
const RETRY_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;

/** Null until the server turns reading on: tests set the list themselves. */
let http: typeof fetch | null = null;
let readAt = 0;
let failedAt = 0;
let reading: Promise<void> | null = null;

/** Lets this process read OpenRouter's list (the server, at boot); null turns reading off. */
export function enableOpenRouterModels(f: typeof fetch | null) {
  http = f;
}

/** Puts a list in place, as a read does (tests seed one). */
export function setOpenRouterModels(models: Record<string, ModelInfo>, at = Date.now()) {
  setListedModels(models);
  readAt = at;
  failedAt = 0;
}

/** Whether a list is in place: without one, no OpenRouter model can be priced. */
export const openRouterListed = () => readAt > 0;

function refresh(): Promise<void> {
  const f = http;
  if (!f) return Promise.resolve();
  reading ??= (async () => {
    try {
      // ponytail: one page of up to 1000, the most popular first; follow `links.next` if the list outgrows it.
      const res = await f(`${OPENROUTER_API}/models?sort=most-popular&limit=1000`, {
        headers: ATTRIBUTION,
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
      const models = parseOpenRouterModels(await res.json());
      if (Object.keys(models).length === 0) throw new Error("OpenRouter listed no model we can use");
      setOpenRouterModels(models);
    } catch {
      failedAt = Date.now();
    } finally {
      reading = null;
    }
  })();
  return reading;
}

/**
 * The list, read when due: waited for only while there is none, or when `model` isn't in it and it is over a minute
 * old (a model just added). Otherwise a list over an hour old answers while one read refreshes it. A failed read
 * isn't tried again for a minute. Does nothing until reading is turned on.
 */
export async function ensureOpenRouterModels(model?: string): Promise<void> {
  if (!http) return;
  const now = Date.now();
  if (now - failedAt < RETRY_MS) return;
  if (readAt === 0 || (model !== undefined && !modelInfo(model) && now - readAt > RETRY_MS)) return refresh();
  if (now - readAt > LIST_TTL_MS) void refresh();
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** A key is printable ASCII: a pasted curly quote or zero-width space would fail in `fetch` and read as an outage. */
const KEY_SHAPE = /^[\x21-\x7E]+$/;

/**
 * What OpenRouter says of a key, with no model call (`GET /api/v1/key`): `invalid` (refused), `management` (a key
 * that manages keys, which can't call models), `ok`, or `unchecked` when it didn't answer either way.
 */
export async function checkOpenRouterKey(
  apiKey: string,
  f: typeof fetch = fetch,
): Promise<"ok" | "invalid" | "management" | "unchecked"> {
  if (!KEY_SHAPE.test(apiKey)) return "invalid";
  try {
    const res = await f(`${OPENROUTER_API}/key`, {
      headers: { authorization: `Bearer ${apiKey}`, ...ATTRIBUTION },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 403) return "invalid";
    if (!res.ok) return "unchecked";
    const body = obj(await res.json().catch(() => null));
    return obj(body?.data)?.is_management_key === true ? "management" : "ok";
  } catch {
    return "unchecked";
  }
}

// ── Calls ───────────────────────────────────────────────────────────────────

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /** In credits, which are US dollars. */
  cost?: number;
  is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: number | null };
}

interface Chunk {
  model?: string;
  usage?: Usage;
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
      reasoning_details?: Raw[];
    };
  }[];
}

type Message =
  | { role: "system"; content: { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } }[] }
  | { role: "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
      reasoning_details?: unknown[];
    };

const isClaude = (model: string) => /^~?anthropic\//.test(model);

/** The `reasoning` to send: the nearest effort the model takes (a tie goes up), thinking off only where it can be. */
export function reasoningFor(
  effort: ModelRequest["effort"],
  info: ModelInfo | undefined,
): { effort: Effort } | { enabled: false } | undefined {
  if (!effort || !info) return undefined;
  const off = info.leastThinking === "off";
  if (!info.reasoning) return effort === "none" && off ? { enabled: false } : undefined;
  const takes = (info.efforts ?? EFFORTS).filter((e): e is Effort => isEffort(e) && (e !== "none" || off));
  const want = EFFORTS.indexOf(effort === "none" && !off ? "minimal" : effort);
  let best = takes[0];
  for (const e of takes) {
    if (best === undefined || Math.abs(EFFORTS.indexOf(e) - want) < Math.abs(EFFORTS.indexOf(best) - want)) best = e;
  }
  return best ? { effort: best } : undefined;
}

function toMessages(request: ModelRequest, claude: boolean): Message[] {
  const blocks = typeof request.system === "string" ? [{ text: request.system, cache: true }] : request.system;
  const system = blocks
    .filter((b) => b.text.length > 0)
    .map((b) => ({
      type: "text" as const,
      text: b.text,
      // Claude caches only at its breakpoints (an hour with `cacheTtl`); the others cache a prompt's prefix by themselves.
      ...(claude && b.cache
        ? {
            cache_control: { type: "ephemeral" as const, ...(request.cacheTtl === "1h" ? { ttl: "1h" as const } : {}) },
          }
        : {}),
    }));
  const out: Message[] = system.length > 0 ? [{ role: "system", content: system }] : [];
  // ponytail: images left out for every model; send them once the catalog knows which OpenRouter models read images.
  for (const m of withoutImages(request.messages)) {
    const parts: ContentBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const text = parts.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n\n");
    if (m.role === "assistant") {
      const calls = parts.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }]
          : [],
      );
      // Its own reasoning goes back unchanged, as OpenRouter asks; another provider's can't be replayed here.
      const details = parts.flatMap((b) =>
        b.type === "opaque" && b.provider === "openrouter" && Array.isArray(b.data.details) ? b.data.details : [],
      );
      out.push({
        role: "assistant",
        content: text || (calls.length > 0 ? null : ""),
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
        ...(details.length > 0 ? { reasoning_details: details } : {}),
      });
      continue;
    }
    for (const b of parts) {
      if (b.type === "tool_result")
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.isError ? `ERROR: ${b.content}` : b.content });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function toBody(request: ModelRequest, compatible: boolean) {
  const claude = !compatible && isClaude(request.model);
  const reasoning = compatible ? undefined : reasoningFor(request.effort, modelInfo(request.model));
  return {
    model: request.model,
    messages: toMessages(request, claude),
    max_tokens: request.maxTokens,
    stream: true as const,
    ...(request.tools && request.tools.length > 0
      ? {
          // The stable tools first: every model's prefix cache keeps them when a tool group loads.
          tools: stableToolsFirst(request.tools).map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(request.outputSchema
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: { name: "output", strict: true, schema: request.outputSchema },
          },
          // Only to an upstream provider that honors the schema.
          ...(compatible ? {} : { provider: { require_parameters: true } }),
        }
      : {}),
    // Plain Chat Completions sends usage only when asked.
    ...(compatible ? { stream_options: { include_usage: true } } : {}),
    // Claude's automatic caching also covers the growing conversation of a tool loop.
    ...(claude ? { cache_control: { type: "ephemeral" as const } } : {}),
  };
}

/** Streamed `reasoning_details`, merged by `index`: text pieces joined, the signature and ids kept as they come. */
function mergeDetail(into: Raw[], d: Raw) {
  const at = typeof d.index === "number" ? into.find((x) => x.index === d.index && x.type === d.type) : undefined;
  if (!at) {
    into.push({ ...d });
    return;
  }
  for (const [k, v] of Object.entries(d)) {
    if (v === null || v === undefined || v === "") continue;
    at[k] = (k === "text" || k === "summary" || k === "data") && typeof at[k] === "string" ? `${at[k]}${v}` : v;
  }
}

function usageOf(u: Usage): ModelUsage {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached - written),
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: written,
  };
}

/** What the call cost: OpenRouter's charge, plus the upstream provider's when the person's own provider key served it. */
function costOf(u: Usage): number | undefined {
  if (typeof u.cost !== "number" || !Number.isFinite(u.cost) || u.cost < 0) return undefined;
  const upstream = u.is_byok ? (u.cost_details?.upstream_inference_cost ?? 0) : 0;
  return usdToNanoUsd(u.cost + (Number.isFinite(upstream) && upstream > 0 ? upstream : 0));
}

/** A failure by its status: HTTP, or the code of an error inside the stream (which arrives with HTTP 200). */
function statusError(status: number | undefined, said = ""): ProviderError {
  if (status === 401) return new ProviderError("invalid provider API key", false, 401);
  if (status === 402) return new ProviderError("no prepaid credit left at the provider", false, 402);
  if (status === 403) return deniedError(null, said);
  if (status === 429) return new ProviderError("rate limited by provider", true, 429);
  if (status === undefined || status === 408 || status >= 500) return new ProviderError("provider error", true, status);
  return new ProviderError(`provider rejected the request (${status})${said ? `: ${said}` : ""}`, false, status);
}

function routerError(error: unknown, compatible: boolean): ProviderError {
  if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIUserAbortError)
    return openAIError(error);
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? (Number(error.code) || undefined);
    const said = saidIn(error);
    // A workspace's own endpoint: its admin reads the server's words to fix it (a model name, a missing feature).
    if (compatible && error.message) {
      const mapped = statusError(status);
      return new ProviderError(
        `${mapped.message}: ${error.message.slice(0, 300)}`,
        mapped.retryable,
        mapped.status,
        undefined,
        said,
      );
    }
    const mapped = statusError(status, said);
    mapped.said = said;
    return mapped;
  }
  return openAIError(error);
}

/**
 * OpenRouter over Chat Completions, streaming, through the OpenAI SDK.
 *
 * - System blocks as one system message; tool calls and results as `tool_calls` and `tool` messages; tools (the
 *   stable ones first, each part by name) sent on every call. Claude's ids get cache breakpoints (its system blocks
 *   marked `cache`, an hour with `cacheTtl`, and automatic caching on top); every other model caches a prompt's prefix
 *   by itself.
 * - `effort` → `reasoning` at the nearest effort the model takes; `none` turns thinking off only where it can be.
 *   Its `reasoning_details` come back as one `opaque` block, sent back unchanged in tool loops.
 * - `outputSchema` → `response_format` (strict JSON Schema), only to upstream providers that honor it.
 * - Usage: prompt tokens less the cached and written ones, each priced at its own rate; `costNanoUsd` is what
 *   OpenRouter says it charged. Without a usage chunk, tokens are estimated and the catalog prices them.
 * - Errors in the words of the other adapters, a failure inside the stream by its code. Mid-stream failures carry
 *   what was received (`ProviderError.partial`).
 */
export function createOpenRouterProvider(
  options: {
    maxRetries?: number;
    /** Outbound HTTP (tests: a scripted transport; a workspace endpoint: the guarded one). */
    fetch?: typeof fetch;
    /**
     * Another server's Chat Completions (a workspace's own endpoint, ADR 0146): sent to `baseURL` with no
     * OpenRouter attribution, routing, reasoning or cache markers, usage asked for, and its reported cost ignored.
     */
    compatible?: { id: string; baseURL: string };
  } = {},
): ModelProvider {
  const compatible = options.compatible;
  return {
    id: compatible?.id ?? "openrouter",
    async stream(input, { apiKey, onDelta }): Promise<ModelResult> {
      const request = laidOut(input);
      const partial: PartialUsage = {
        inputTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: null,
        outputChars: 0,
      };
      let model = request.model;
      let usage: Usage | undefined;
      let finish: string | undefined;
      let text = "";
      const calls: { id: string; name: string; args: string }[] = [];
      const details: Raw[] = [];
      try {
        const client = new OpenAI({
          apiKey,
          baseURL: compatible?.baseURL ?? OPENROUTER_API,
          ...(compatible ? {} : { defaultHeaders: ATTRIBUTION }),
          maxRetries: options.maxRetries ?? 2,
          fetch: options.fetch,
        });
        const stream = await client.chat.completions.create(
          toBody(request, compatible !== undefined) as unknown as ChatCompletionCreateParamsStreaming,
          { signal: request.signal },
        );
        for await (const raw of stream) {
          const chunk = raw as unknown as Chunk;
          if (typeof chunk.model === "string" && chunk.model) model = chunk.model;
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          const delta = choice.delta;
          if (typeof delta?.content === "string" && delta.content) {
            text += delta.content;
            partial.outputChars += delta.content.length;
            onDelta(delta.content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            // Some compatible servers leave out `index`: a new id is a new call, else the last one goes on.
            const byId = tc.id ? calls.findIndex((c) => c?.id === tc.id) : -1;
            const i =
              tc.index ?? (byId >= 0 ? byId : tc.id && calls.length > 0 ? calls.length : Math.max(calls.length - 1, 0));
            const at = calls[i] ?? { id: "", name: "", args: "" };
            calls[i] = at;
            if (tc.id) at.id = tc.id;
            if (tc.function?.name) at.name = tc.function.name;
            // A few send the arguments as an object instead of JSON text.
            const args = tc.function?.arguments as unknown;
            const piece =
              typeof args === "string" ? args : args && typeof args === "object" ? JSON.stringify(args) : "";
            if (piece) {
              at.args += piece;
              partial.outputChars += piece.length;
            }
          }
          for (const d of delta?.reasoning_details ?? []) {
            if (!obj(d)) continue;
            mergeDetail(details, d);
            partial.outputChars += JSON.stringify(d).length;
          }
        }
        if (!finish) throw new ProviderError("could not read the model's reply: the stream ended early", true);
        const content: ContentBlock[] = [
          ...(details.length > 0 ? [{ type: "opaque" as const, provider: "openrouter", data: { details } }] : []),
          ...(text ? [{ type: "text" as const, text }] : []),
          ...calls.flatMap((c, i) => {
            if (!c) return [];
            let input: Record<string, unknown>;
            try {
              input = (c.args ? JSON.parse(c.args) : {}) as Record<string, unknown>;
            } catch (error) {
              throw new ProviderError(`could not read the model's reply: ${(error as Error).message}`, true);
            }
            return [{ type: "tool_use" as const, id: c.id || `call_${i}`, name: c.name, input }];
          }),
        ];
        const stopReason: StopReason = content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : finish === "length"
            ? "max_tokens"
            : finish === "content_filter"
              ? "refusal"
              : finish === "stop"
                ? "end_turn"
                : "other";
        const cost = usage && !compatible ? costOf(usage) : undefined;
        return {
          text,
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
          ...(cost !== undefined ? { costNanoUsd: cost } : {}),
        };
      } catch (error) {
        const mapped = request.signal?.aborted
          ? new ProviderError("request aborted", false)
          : error instanceof ProviderError
            ? error
            : routerError(error, compatible !== undefined);
        if (partial.outputChars > 0 || usage) mapped.partial = { ...partial, ...(usage ? usageOf(usage) : {}) };
        throw mapped;
      }
    },
  };
}
