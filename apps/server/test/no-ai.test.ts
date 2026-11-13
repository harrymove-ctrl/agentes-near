import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

/** No AI connected over HTTP (ADR 0061): the AI status, the card, and "Responder agora". */

let t: TestServer;
afterEach(async () => {
  const current = t;
  t = undefined as unknown as TestServer;
  await current?.close();
});

test("ai-status per agent; a mention with no key gets the card; answer-now 409, then the agent answers", async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Resumo: tudo certo."] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const org = `/api/app/organizations/${orgId}`;
  const status = async () => (await (await owner(`${org}/ai-status`)).json()) as Record<string, unknown>;
  // Who picks the agents for a message nobody mentioned: the workspace's small model, on its own key.
  const byModel = { by: "model", mine: "model", model: "claude-haiku-5-5", noSmallModel: null };
  // The workspace's right hand (ADR 0137) comes first, on the same key: on Automático, it names the key's maker.
  const lodi = expect.any(String);
  expect(await status()).toEqual({
    any: true,
    agents: [
      { agentId: lodi, state: "ready", provider: "anthropic" },
      { agentId, state: "ready" },
    ],
    routing: byModel,
    apiKey: true,
    // Memory reflects with the same key (ADR 0167).
    reflection: true,
  });

  await t.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  expect(await status()).toEqual({
    any: false,
    agents: [
      { agentId: lodi, state: "no_ai", reason: "no_key" },
      { agentId, state: "no_ai", reason: "no_key" },
    ],
    routing: { by: "rules", mine: "rules", model: null, noSmallModel: null },
    apiKey: false,
    reflection: false,
  });
  const asked = await owner(`${org}/channels/${channelId}/messages`, { json: { body: "@dev resume o canal" } });
  const { id: askedId } = (await asked.json()) as { id: string };
  await t.drain();
  const listed = (await (await owner(`${org}/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; meta: Record<string, unknown> }[];
  };
  const card = listed.messages.find((m) => m.meta.bodyCode === "no_ai");
  expect(card).toMatchObject({
    author: { type: "agent", id: agentId },
    meta: { noAi: { agentId, reason: "no_key", intent: "task" } },
  });

  const refused = await owner(`${org}/messages/${card?.id}/answer-now`, { json: {} });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("ai.still_missing");

  await t.db.update(schema.providerCredentials).set({ revokedAt: null });
  const answered = await owner(`${org}/messages/${card?.id}/answer-now`, { json: {} });
  expect(answered.status).toBe(200);
  const { runs } = (await answered.json()) as { runs: { agentId: string; runId: string }[] };
  expect(runs).toEqual([{ agentId, runId: expect.any(String) }]);
  await t.drain();
  const after = (await (await owner(`${org}/channels/${channelId}/messages`)).json()) as {
    messages: { body: string; agentRunId: string | null }[];
  };
  expect(after.messages).toContainEqual(
    expect.objectContaining({ body: "Resumo: tudo certo.", agentRunId: runs[0]?.runId }),
  );
  // Pressed on the person's message instead: the same run, nothing new.
  const again = await owner(`${org}/messages/${askedId}/answer-now`, { json: {} });
  expect(((await again.json()) as { runs: unknown[] }).runs).toEqual(runs);
  const unknown = await owner(`${org}/messages/${crypto.randomUUID()}/answer-now`, { json: {} });
  expect(unknown.status).toBe(404);
});
