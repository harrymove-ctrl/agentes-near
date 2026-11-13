import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createArtifact } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("choice card API: read it, answer once (409 after), a pick per question (400)", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const card = await createArtifact(t.engine.artifacts, { type: "agent", agentId, channelId }, orgId, {
    title: "Deploy",
    channelId,
    content: {
      kind: "choices",
      questions: [{ question: "Faço agora?", options: [{ label: "Sim" }, { label: "Não" }] }],
    },
  });
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}/choices/${card.id}${path}`, init);

  expect(await (await api("")).json()).toEqual({ id: card.id, answer: null });
  expect((await api("/answer", { json: { picks: [] } })).status).toBe(400);
  expect((await api("/answer", { json: { picks: [5] } })).status).toBe(400);

  const answered = await api("/answer", { json: { picks: [1] } });
  expect(answered.status).toBe(200);
  const out = (await answered.json()) as { choices: { answer: { picks: number[] } }; messageId: string };
  expect(out.choices.answer.picks).toEqual([1]);
  const [message] = await t.db.select().from(schema.messages).where(eq(schema.messages.id, out.messageId));
  expect(message?.body).toBe("@dev Faço agora? Não");

  const again = await api("/answer", { json: { picks: [0] } });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("choices.answered");
  expect(((await (await api("")).json()) as { answer: { picks: number[] } }).answer.picks).toEqual([1]);
});
