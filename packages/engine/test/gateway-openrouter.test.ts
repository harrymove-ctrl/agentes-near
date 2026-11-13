import { afterEach, expect, test } from "bun:test";
import { noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  costNanoUsd,
  enableOpenRouterModels,
  maxCostNanoUsd,
  ProviderError,
  parseOpenRouterModels,
  promptChars,
  setOpenRouterModels,
} from "@agenteschat/providers";
import fixture from "../../providers/test/fixtures/openrouter-models.json";
import {
  agentBudgetState,
  createAgent,
  createCredential,
  createModelGateway,
  drainOutbox,
  MissingCredentialError,
  postPersonMessage,
  runErrorDetail,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  enableOpenRouterModels(null);
  setOpenRouterModels({}, 0);
  await f?.close();
});

/** OpenRouter's key check, answered here: no network. */
const keyCheck = (async () =>
  new Response(JSON.stringify({ data: { is_management_key: false } }))) as unknown as typeof fetch;

/** The fixture's workspace with an OpenRouter key and an agent on `model` with it. */
async function withOpenRouter(fx: Fixture, model: string) {
  setOpenRouterModels(parseOpenRouterModels(fixture));
  const key = await createCredential(
    fx.db,
    fx.keyWrapper,
    fx.owner.id,
    fx.org.id,
    { provider: "openrouter", label: "OpenRouter", apiKey: "or-test-key-5678" },
    { fetch: keyCheck },
  );
  const agent = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name: "Rota", handle: "rota", credentialId: key.id, model, monthlyBudgetNanoUsd: 10_000_000_000 },
    { model },
  );
  return { key, agent };
}

const ask = (fx: Fixture, agentId: string, maxTokens = 100) =>
  fx.gateway.stream({
    orgId: fx.org.id,
    agentId,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens,
    onDelta: () => {},
  });

test("the budget reserves the worst case at the listed prices, within the model's output cap", async () => {
  f = await setup({ reply: () => ({ chunks: ["ok"], usage: { inputTokens: 10, outputTokens: 2 } }) });
  const { agent } = await withOpenRouter(f, "~openai/gpt-luna-latest");
  // Held open, so the reservation can be read while the call runs.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const held = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: {
      openrouter: {
        id: "openrouter",
        stream: async (req, opts) => {
          await gate;
          return f.provider.stream(req, opts);
        },
      },
    },
  });
  const running = held.stream({
    orgId: f.org.id,
    agentId: agent.id,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 500_000,
    onDelta: () => {},
  });
  await Bun.sleep(50);
  const prompt = Math.ceil(promptChars({ system: "sys", messages: [{ role: "user", content: "hello" }] }) / 3);
  // GPT-6 Luna writes at most 128,000 tokens a call: the cap and the reservation stop there.
  expect((await agentBudgetState(f.db, f.org.id, agent.id)).reservedNanoUsd).toBe(
    maxCostNanoUsd("~openai/gpt-luna-latest", prompt, 128_000),
  );
  release();
  const result = await running;
  expect(result.maxTokens).toBe(128_000);
  expect(f.provider.calls[0]?.request.maxTokens).toBe(128_000);
  expect(f.provider.calls[0]?.apiKey).toBe("or-test-key-5678");
});

test("the cost recorded is OpenRouter's for the call; without it, the listed prices", async () => {
  let reported: number | undefined = 4321;
  f = await setup({
    reply: () => ({
      chunks: ["Hi"],
      model: "z-ai/glm-5.3",
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 },
      ...(reported !== undefined ? { costNanoUsd: reported } : {}),
    }),
  });
  const { agent, key } = await withOpenRouter(f, "~z-ai/glm-latest");
  const first = await ask(f, agent.id);
  expect(first.costNanoUsd).toBe(4321);
  const [record] = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.agentId, agent.id));
  expect(record).toMatchObject({
    provider: "openrouter",
    model: "z-ai/glm-5.3",
    requestedModel: "~z-ai/glm-latest",
    credentialId: key.id,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 300,
    costNanoUsd: 4321,
  });
  expect(await agentBudgetState(f.db, f.org.id, agent.id)).toEqual({ spentNanoUsd: 4321, reservedNanoUsd: 0 });

  reported = undefined;
  const second = await ask(f, agent.id);
  // Priced as the model that answered, at its listed prices.
  const listed = costNanoUsd("z-ai/glm-5.3", {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
  });
  expect(second.costNanoUsd).toBe(listed);
  expect((await agentBudgetState(f.db, f.org.id, agent.id)).spentNanoUsd).toBe(4321 + listed);
});

test("an org call (routing) records OpenRouter's cost too", async () => {
  f = await setup({ reply: () => ({ chunks: ["{}"], usage: { inputTokens: 50, outputTokens: 5 }, costNanoUsd: 77 }) });
  await withOpenRouter(f, "~z-ai/glm-latest");
  const result = await f.gateway.complete({
    orgId: f.org.id,
    kind: "router",
    model: "~openai/gpt-luna-latest",
    system: "route",
    messages: [{ role: "user", content: "who answers?" }],
    maxTokens: 512,
    outputSchema: { type: "object" },
    effort: "none",
  });
  expect(result.costNanoUsd).toBe(77);
  const rows = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.kind, "router"));
  expect(rows.map((r) => [r.provider, r.model, r.costNanoUsd])).toEqual([
    ["openrouter", "~openai/gpt-luna-latest", 77],
  ]);
});

test("a model OpenRouter stopped listing fails with a clear message; with no list at all, it is tried again later", async () => {
  f = await setup();
  const { agent } = await withOpenRouter(f, "~z-ai/glm-latest");
  await f.db.update(schema.agents).set({ model: "acme/gone-model" }).where(eq(schema.agents.id, agent.id));
  const gone = await ask(f, agent.id).catch((e: unknown) => e);
  expect(gone).toBeInstanceOf(ValidationError);
  expect((gone as Error).message).toBe(
    "OpenRouter doesn't list acme/gone-model anymore. Pick another model in the agent's settings.",
  );
  setOpenRouterModels({}, 0);
  const unread = await ask(f, agent.id).catch((e: unknown) => e);
  expect(unread).toBeInstanceOf(ProviderError);
  expect(unread).toMatchObject({ provider: "OpenRouter", message: "could not reach provider" });
  expect(unread).toMatchObject({ retryable: true });
  expect(f.provider.calls).toHaveLength(0);
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(0);
});

test("an agent's run on OpenRouter: with no list yet it tries again; on a model OpenRouter stopped listing it fails with words of its own", async () => {
  f = await setup();
  const { key } = await withOpenRouter(f, "~z-ai/glm-latest");
  await f.db
    .update(schema.agents)
    .set({ model: "acme/gone-model", credentialId: key.id })
    .where(eq(schema.agents.id, f.agent.id));
  const run = async () =>
    (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id)))[0];
  setOpenRouterModels({}, 0);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, f.handlers);
  // An outage, not "no AI": the key is there.
  expect(await run()).toMatchObject({ status: "running", error: null });
  setOpenRouterModels(parseOpenRouterModels(fixture));
  await drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + 60_000) });
  const failed = await run();
  expect(failed?.status).toBe("failed");
  expect(runErrorDetail(failed?.error)).toEqual({
    errorCode: "run.model_unlisted",
    errorParams: { model: "acme/gone-model" },
  });
  expect(f.provider.calls).toHaveLength(0);
});

test("without an OpenRouter key the call fails before OpenRouter's list is read", async () => {
  f = await setup();
  let reads = 0;
  enableOpenRouterModels((async () => {
    reads++;
    return new Response(JSON.stringify(fixture));
  }) as unknown as typeof fetch);
  const result = await f.gateway
    .complete({
      orgId: f.org.id,
      kind: "summary",
      model: "~deepseek/deepseek-flash-latest",
      system: "sum",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 100,
    })
    .catch((e: unknown) => e);
  expect(result).toBeInstanceOf(MissingCredentialError);
  expect((result as Error).message).toBe("Add an API key for OpenRouter in the workspace settings");
  expect(reads).toBe(0);
  expect(
    await f.gateway.hasModelCredential({
      orgId: f.org.id,
      model: "~deepseek/deepseek-flash-latest",
      credentialId: null,
    }),
  ).toBe(false);
  expect(reads).toBe(0);
});
