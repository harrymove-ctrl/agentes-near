import { afterEach, describe, expect, test } from "bun:test";
import type { ErrorReporter } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import { type EmbeddingProvider, ProviderError } from "@agenteschat/providers";
import { createFakeEmbeddings } from "@agenteschat/providers/testing";
import {
  drainOutbox,
  EMBED_FAILURES_REPORTED,
  indexSource,
  insertContextItem,
  postPersonMessage,
  queueEmbeddingBackfill,
  reindexOrg,
  retrieveForRun,
  type SearchDeps,
  searchVisible,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A fact of @dev's in #general, as `remember` saves it (its index job queued, and indexed at once). */
async function remember(content: string, title?: string) {
  const item = await insertContextItem(f.db, {
    orgId: f.org.id,
    kind: "fact",
    scopeType: "agent",
    scopeId: f.agent.id,
    agentId: f.agent.id,
    channelIds: [f.general.id],
    title,
    content,
    evidence: [{ type: "self", ref: f.agent.id, agentId: f.agent.id, at: new Date().toISOString() }],
    createdByKind: "agent",
    createdById: f.agent.id,
  });
  await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id }).catch(() => {});
  return item;
}

const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const documents = async () => new Map((await f.db.select().from(schema.searchDocuments)).map((d) => [d.sourceId, d]));
const embeddingCalls = async () =>
  (await f.db.select().from(schema.usageRecords)).filter((u) => u.kind === "embedding").length;
const deps = (): SearchDeps => ({ db: f.db, search: f.search, gateway: f.gateway });

describe("vectors for the kinds that get them (EMBEDDINGS_KINDS)", () => {
  test("memories get vectors, messages stay words alone; a query is embedded only for kinds that have them", async () => {
    f = await setup({ embeddings: { kinds: ["context_item"] } });
    const message = await post("the deploy pipeline broke on staging");
    const memory = await remember("Deploys go out with scripts/blue.sh.");
    await drainOutbox(f.db, f.handlers);
    const indexed = await documents();
    expect([indexed.get(message.id)?.embedding, indexed.get(message.id)?.embeddingModel]).toEqual([null, null]);
    expect(indexed.get(memory.id)?.embeddingModel).toBe("fake-embed");

    const before = await embeddingCalls();
    const inGeneral = { orgId: f.org.id, visibleChannelIds: [f.general.id] };
    const messages = await searchVisible(deps(), { ...inGeneral, text: "pipeline staging", kinds: ["message"] });
    expect(messages.map((h) => h.sourceId)).toEqual([message.id]);
    expect(await embeddingCalls()).toBe(before);
    await searchVisible(deps(), { ...inGeneral, text: "deploys", kinds: ["context_item"] });
    await searchVisible(deps(), { ...inGeneral, text: "deploys" });
    expect(await embeddingCalls()).toBe(before + 2);
  });

  test("a reindex rebuilds the kinds it is given; each start queues one per model and kinds where vectors are missing", async () => {
    f = await setup({ embeddings: { kinds: ["context_item"] } });
    const message = await post("release checklist for friday");
    const memory = await remember("Releases ship on Thursdays.");
    await drainOutbox(f.db, f.handlers);
    // As if another model had embedded it.
    await f.db
      .update(schema.searchDocuments)
      .set({ embeddingModel: "old-model" })
      .where(eq(schema.searchDocuments.sourceId, memory.id));
    const messageAt = (await documents()).get(message.id)?.updatedAt;

    const backfill = (model: string, kinds: ("context_item" | "message")[] = ["context_item"]) =>
      queueEmbeddingBackfill(f.db, { model, kinds });
    expect(await backfill("fake-embed")).toBe(1);
    expect(await backfill("fake-embed")).toBe(0);
    // One that failed (the provider was down, or its key wrong) is queued again at the next start.
    await f.db.update(schema.outbox).set({ status: "failed" }).where(eq(schema.outbox.kind, "search.reindex"));
    expect(await backfill("fake-embed")).toBe(1);
    await drainOutbox(f.db, f.handlers);
    const after = await documents();
    expect(after.get(memory.id)?.embeddingModel).toBe("fake-embed");
    // Only memories were rebuilt: the message's document wasn't touched.
    expect(after.get(message.id)?.updatedAt).toEqual(messageAt);
    // Every memory has this model's vector: nothing more to queue for it, while messages still have none.
    expect(await backfill("fake-embed", ["context_item", "message"])).toBe(1);
    // A workspace on hold waits for a start after it opens again.
    await f.db.update(schema.organizations).set({ standing: "hold" }).where(eq(schema.organizations.id, f.org.id));
    expect(await backfill("another-model")).toBe(0);
    await f.db.update(schema.organizations).set({ standing: "active" }).where(eq(schema.organizations.id, f.org.id));
    expect(await backfill("another-model")).toBe(1);

    expect(await reindexOrg(deps(), f.org.id, { kinds: ["context_item"] })).toBe(1);
    expect(await reindexOrg(deps(), f.org.id)).toBe(2);
  });
});

describe("a query's vector is compared with the same model's only", () => {
  test("vectors another model made never answer it, so a reindex half done can't mix them", async () => {
    f = await setup({ embeddings: { kinds: ["context_item"] } });
    const memory = await remember("the deploy pipeline broke on staging");
    const index = await f.search.forOrg(f.org.id);
    const [vector] = (
      await createFakeEmbeddings().embed(["pipeline staging deploys"], { apiKey: "", inputType: "query" })
    ).vectors;
    const near = (embeddingModel: string) =>
      index.query({ text: "", embedding: vector, embeddingModel, visibleChannelIds: [f.general.id] });
    expect((await near("fake-embed")).map((h) => h.sourceId)).toEqual([memory.id]);
    expect(await near("another-model")).toEqual([]);

    // Through search: "deploys" isn't in it, so only the vector finds it, and only this model's.
    const query = { orgId: f.org.id, text: "pipeline staging deploys", visibleChannelIds: [f.general.id] };
    expect((await searchVisible(deps(), query)).map((h) => h.sourceId)).toEqual([memory.id]);
    const otherModel: SearchDeps["gateway"] = {
      embed: async (call) => {
        const result = await f.gateway.embed(call);
        return result && { ...result, model: "another-model" };
      },
    };
    expect(await searchVisible({ ...deps(), gateway: otherModel }, query)).toEqual([]);
  });
});

/** The fake, until `mode` makes it hang until its timeout or fail at once. */
function flaky() {
  const fake = createFakeEmbeddings();
  const state = { mode: "ok" as "ok" | "hang" | "fail" };
  const provider: EmbeddingProvider = {
    id: "flaky",
    model: "fake-embed",
    embed: (texts, options) =>
      state.mode === "ok"
        ? fake.embed(texts, options)
        : state.mode === "fail"
          ? Promise.reject(new ProviderError("the embeddings server rejected the request (503)", true, 503))
          : new Promise((_, reject) =>
              options.signal?.addEventListener("abort", () =>
                reject(new ProviderError(`could not reach the embeddings server: ${options.signal?.reason}`, true)),
              ),
            ),
  };
  return { provider, state };
}

describe("a slow or failing embeddings server leaves search to its words", () => {
  test("a run's memory past the query's timeout comes by words; the third failure in a row is reported, once", async () => {
    const server = flaky();
    const reports: { tags: unknown }[] = [];
    const errors: ErrorReporter = {
      capture: (_error, tags) => {
        reports.push({ tags });
        return "report";
      },
      flush: async () => true,
    };
    f = await setup({ embeddings: { provider: server.provider, kinds: ["context_item"], queryTimeoutMs: 50 }, errors });
    const memory = await remember("Deploy Northwind with scripts/blue.sh.", "Deploy da Northwind");
    const memoryFor = () =>
      retrieveForRun(f.context, {
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        text: "como fazer o deploy da northwind?",
      });

    server.state.mode = "hang";
    const started = Date.now();
    expect((await memoryFor()).matchedIds).toEqual([memory.id]);
    expect(Date.now() - started).toBeLessThan(1000);
    server.state.mode = "fail";
    expect((await memoryFor()).matchedIds).toEqual([memory.id]);
    expect(reports).toEqual([]);
    await memoryFor();
    expect(reports).toEqual([
      { tags: { cause: "embeddings", provider: "flaky", model: "fake-embed", input_type: "query" } },
    ]);
    await memoryFor();
    expect(reports).toHaveLength(1);
    // A call that works ends the outage; the next one is reported again.
    server.state.mode = "ok";
    const calls = await embeddingCalls();
    await memoryFor();
    expect(await embeddingCalls()).toBe(calls + 1);
    server.state.mode = "fail";
    for (let i = 0; i < EMBED_FAILURES_REPORTED; i++) await memoryFor();
    expect(reports).toHaveLength(2);
    // A failed call records no usage.
    expect(await embeddingCalls()).toBe(calls + 1);
  });

  test("a memory whose vector fails is still found by its words, and its job tries the vector again", async () => {
    const server = flaky();
    f = await setup({ embeddings: { provider: server.provider, kinds: ["context_item"] } });
    server.state.mode = "fail";
    const memory = await remember("Northwind invoices close on the 5th.");
    await drainOutbox(f.db, f.handlers);
    expect((await documents()).get(memory.id)?.embedding).toBeNull();
    const hits = await searchVisible(deps(), {
      orgId: f.org.id,
      text: "northwind invoices",
      visibleChannelIds: [f.general.id],
    });
    expect(hits.map((h) => h.sourceId)).toEqual([memory.id]);
    const [job] = await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "search.index"), sql`${schema.outbox.payload}->>'sourceId' = ${memory.id}`));
    expect([job?.status, job?.attempts]).toEqual(["pending", 1]);

    server.state.mode = "ok";
    await drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + 60_000) });
    expect((await documents()).get(memory.id)?.embeddingModel).toBe("fake-embed");
  });
});
