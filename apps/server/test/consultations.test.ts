import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { insertMessage, openAgentDm } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

type Opened = {
  consultation: { id: string; kind: string; consultedRunId: string | null; status: string; waiting: string | null };
  messages: { body: string; channelId: string }[];
};

test("an opened question: its part of the agents' DM, to whoever reads the conversation that asked", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId, credentialId } = await seedOrg(owner);
  const infra = (await (
    await owner(`/api/app/organizations/${orgId}/agents`, {
      json: {
        name: "Infra",
        handle: "infra",
        instructions: "Cuida do deploy e dos servidores. Responde rápido.",
        credentialId,
      },
    })
  ).json()) as { id: string };

  // Dev, at work in the channel, asked Infra in their DM; Infra's run answered there.
  const reply = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "agent", agentId, runId: null, hop: 0, stretchId: null },
    body: "Vou perguntar ao Infra.",
  });
  const [asker] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: reply.id,
      triggerMessageId: reply.id,
      trigger: "mention",
      hop: 0,
      status: "running",
    })
    .returning();
  const dm = await openAgentDm(t.db, orgId, agentId, infra.id);
  const consultationId = crypto.randomUUID();
  if (!asker) throw new Error("no asking run");
  const question = await insertMessage(t.db, {
    orgId,
    channelId: dm.id,
    author: { type: "agent", agentId, runId: asker.id, hop: 0 },
    body: "Como o staging é publicado?",
    meta: { consultation: { id: consultationId } },
  });
  const [target] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId: infra.id,
      channelId: dm.id,
      threadRootId: question.id,
      triggerMessageId: question.id,
      trigger: "dm",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!target) throw new Error("no consulted run");
  await insertMessage(t.db, {
    orgId,
    channelId: dm.id,
    author: { type: "agent", agentId: infra.id, runId: target.id, hop: 1 },
    body: "Com o deploy.sh, a partir da main.",
  });
  await t.db.insert(schema.agentConsultations).values({
    id: consultationId,
    orgId,
    askerRunId: asker?.id ?? "",
    askerAgentId: agentId,
    targetAgentId: infra.id,
    channelId: dm.id,
    messageId: question.id,
    targetRunId: target?.id ?? null,
    waitId: "w1",
    question: "Como o staging é publicado?",
    chain: [agentId],
    expiresAt: new Date(Date.now() + 60_000),
  });

  const res = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/consultations/${consultationId}`);
  expect(res.status).toBe(200);
  const opened = (await res.json()) as Opened;
  expect(opened.consultation).toMatchObject({
    id: consultationId,
    kind: "question",
    consultedRunId: target?.id,
    status: "open",
    waiting: null,
  });
  expect(opened.messages.map((m) => m.body)).toEqual([
    "Como o staging é publicado?",
    "Com o deploy.sh, a partir da main.",
  ]);
  expect(opened.messages.every((m) => m.channelId === dm.id)).toBe(true);
  // The list carries the consulted run too: its cards in the channel say whom it helps.
  const list = (await (await owner(`/api/app/organizations/${orgId}/channels/${channelId}/consultations`)).json()) as {
    consultations: { id: string; consultedRunId: string | null }[];
  };
  expect(list.consultations[0]).toMatchObject({ id: consultationId, consultedRunId: target?.id });
  // Its part done, Infra waits on what it handed to Dev: the list says so (ADR 0095).
  await t.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, target.id));
  await t.db.insert(schema.agentConsultations).values({
    orgId,
    kind: "note",
    askerRunId: target.id,
    askerAgentId: infra.id,
    targetAgentId: agentId,
    channelId: dm.id,
    messageId: crypto.randomUUID(),
    waitId: "w2",
    question: "Confere o deploy.sh na main.",
    chain: [agentId, infra.id],
    expiresAt: new Date(Date.now() + 60_000),
  });
  const handed = (await (
    await owner(`/api/app/organizations/${orgId}/channels/${channelId}/consultations`)
  ).json()) as { consultations: { id: string; kind: string; waiting: string | null }[] };
  expect(handed.consultations.find((c) => c.id === consultationId)).toMatchObject({
    kind: "question",
    waiting: "agents",
  });
  // A question that wasn't asked from here: not found.
  const missing = `/api/app/organizations/${orgId}/channels/${channelId}/consultations/${crypto.randomUUID()}`;
  const other = await owner(missing);
  expect(other.status).toBe(404);
});
