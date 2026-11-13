import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  createAgent,
  createCredential,
  createJobHandlers,
  drainOutbox,
  listCredentials,
  makeDefaultCredential,
  postPersonMessage,
  resolveSummaryModel,
  revokeCredential,
  smallModelFor,
  updateOrgSettings,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const openaiKey = (fx: Fixture, extra: Partial<Parameters<typeof createCredential>[4]> = {}) =>
  createCredential(fx.db, fx.keyWrapper, fx.owner.id, fx.org.id, {
    provider: "openai",
    label: "openai",
    apiKey: "sk-proj-openai-9999",
    organization: "org-abc",
    project: "proj_123",
    ...extra,
  });

describe("credentials per provider", () => {
  test("an OpenAI agent uses the org's OpenAI key (with org/project) and is priced by its model", async () => {
    f = await setup({ reply: () => ({ chunks: ["oi"], usage: { inputTokens: 1000, outputTokens: 100 } }) });
    await openaiKey(f, { makeDefault: true });
    const gpt = await createAgent(f.db, f.owner.id, f.org.id, { name: "Gpt", handle: "gpt" }, { model: "gpt-6-sol" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: gpt.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@gpt hi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.openaiProvider.calls[0]).toMatchObject({ apiKey: "sk-proj-openai-9999" });
    expect(f.provider.calls).toHaveLength(0);
    const [usage] = await f.db.select().from(schema.usageRecords);
    expect(usage).toMatchObject({ provider: "openai", model: "gpt-6-sol", costNanoUsd: 1000 * 2000 + 100 * 10000 });
  });

  test("no key for the model's provider: the run fails with no_ai and the agent's card says so", async () => {
    f = await setup();
    const gpt = await createAgent(f.db, f.owner.id, f.org.id, { name: "Gpt", handle: "gpt" }, { model: "gpt-6-luna" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: gpt.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@gpt hi" });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ status: "failed", error: "no_ai" });
    expect(f.openaiProvider.calls).toHaveLength(0);
    const card = (await f.db.select().from(schema.messages)).find((m) => m.authorAgentId === gpt.id);
    expect(card?.meta).toMatchObject({ bodyCode: "no_ai", noAi: { agentId: gpt.id, reason: "no_key" } });
  });

  test("an agent's key must match its model's provider", async () => {
    f = await setup();
    const key = await openaiKey(f);
    await expect(
      createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name: "X", handle: "x", model: "claude-sonnet-5-5", credentialId: key.id },
        { model: "x" },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("defaults per provider: make default in one call, 'Tornar padrão', can't remove a default", async () => {
    f = await setup();
    const a = await openaiKey(f, { makeDefault: true });
    const b = await openaiKey(f, { label: "second" });
    let list = await listCredentials(f.db, f.owner.id, f.org.id);
    expect(list.filter((c) => c.isDefault).map((c) => c.id)).toEqual([a.id]);
    await expect(revokeCredential(f.db, f.owner.id, f.org.id, a.id)).rejects.toBeInstanceOf(ConflictError);
    await makeDefaultCredential(f.db, f.owner.id, f.org.id, b.id);
    list = await listCredentials(f.db, f.owner.id, f.org.id);
    expect(list.filter((c) => c.isDefault && c.provider === "openai").map((c) => c.id)).toEqual([b.id]);
    await revokeCredential(f.db, f.owner.id, f.org.id, a.id);
    const [settings] = await f.db
      .select()
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    expect(settings?.defaultCredentialIds).toEqual({ openai: b.id });
    await expect(
      updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultCredentialIds: { anthropic: b.id } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("routing and summaries use the small model of the org's default key's provider", async () => {
    f = await setup();
    expect(await smallModelFor(f, f.org.id, { openai: "gpt-6-luna" })).toBe("claude-haiku-5-5");
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    await openaiKey(f, { makeDefault: true });
    expect(await smallModelFor(f, f.org.id, { openai: "gpt-6-luna" })).toBe("gpt-6-luna");
    expect(await resolveSummaryModel({ ...f.context, cheapModels: { openai: "gpt-6-luna" } }, f.org.id)).toBe(
      "gpt-6-luna",
    );
  });

  test("a DeepSeek-only workspace: its agent thinks with the DeepSeek key, priced at DeepSeek's rates; system tasks on DeepSeek Flash, never on Kimi's", async () => {
    f = await setup({ reply: () => ({ chunks: ["oi"], usage: { inputTokens: 1000, outputTokens: 100 } }) });
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    const key = (provider: "deepseek" | "moonshot", apiKey: string) =>
      createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
        provider,
        label: provider,
        apiKey,
        makeDefault: true,
      });
    await key("deepseek", "sk-deepseek-9999");
    const ds = await createAgent(f.db, f.owner.id, f.org.id, { name: "Ds", handle: "ds" }, { model: "deepseek-flash" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ds.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@ds oi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls[0]).toMatchObject({ apiKey: "sk-deepseek-9999", request: { model: "deepseek-flash" } });
    const usage = (await f.db.select().from(schema.usageRecords)).find((u) => u.kind === "agent");
    expect(usage).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
      costNanoUsd: 1000 * 300 + 100 * 1200,
    });
    expect(await smallModelFor(f, f.org.id)).toBe("deepseek-flash");
    expect(await resolveSummaryModel(f.context, f.org.id)).toBe("deepseek-flash");

    // Kimi has no small model: the default Kimi key routes with the other key's, never with K3.1 Pro.
    await key("moonshot", "sk-kimi-9999");
    expect(await smallModelFor(f, f.org.id)).toBe("deepseek-flash");
  });

  test("a Gemini-only workspace: its agent thinks with the Gemini key, priced by its model; routing and summaries on Flash-Lite, with the least thinking it allows", async () => {
    // Flash-Lite has no introductory price, so these costs hold on any date.
    f = await setup({
      reply: (request) =>
        request.outputSchema
          ? {
              chunks: ['{"needs_agent":0.9,"scores":[{"handle":"gem","score":0.9}],"reason":"r"}'],
              usage: { inputTokens: 2000, outputTokens: 40 },
            }
          : { chunks: ["oi"], usage: { inputTokens: 1000, outputTokens: 100 } },
    });
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "gemini",
      label: "Gemini",
      apiKey: "AQ.gemini-test-key-9999",
      makeDefault: true,
    });
    const gem = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Gem", handle: "gem" },
      { model: "gemini-3.5-flash-lite" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: gem.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@gem oi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls[0]).toMatchObject({
      apiKey: "AQ.gemini-test-key-9999",
      request: { model: "gemini-3.5-flash-lite" },
    });
    const usage = (await f.db.select().from(schema.usageRecords)).find((u) => u.kind === "agent");
    expect(usage).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      costNanoUsd: 1000 * 300 + 100 * 2500,
    });
    expect(await smallModelFor(f, f.org.id)).toBe("gemini-3.5-flash-lite");
    expect(await resolveSummaryModel(f.context, f.org.id)).toBe("gemini-3.5-flash-lite");

    // A message nobody mentioned: with no Jev, Flash-Lite picks who answers, on the workspace's key.
    await f.db.update(schema.agentRuns).set({ status: "done" });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "quem vê o deploy?",
    });
    await drainOutbox(f.db, handlers);
    const [decision] = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.messageId, m.id));
    expect(decision).toMatchObject({ strategy: "llm:gemini-3.5-flash-lite", error: null });
    const routed = f.provider.calls.find((c) => c.request.outputSchema);
    expect(routed).toMatchObject({
      apiKey: "AQ.gemini-test-key-9999",
      request: { model: "gemini-3.5-flash-lite", effort: "none" },
    });
    const router = (await f.db.select().from(schema.usageRecords)).find((u) => u.kind === "router");
    expect(router).toMatchObject({ provider: "gemini", costNanoUsd: 2000 * 300 + 40 * 2500 });
  });
});
