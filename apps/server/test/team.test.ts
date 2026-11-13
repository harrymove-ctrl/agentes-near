import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { insertMessage } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

type Team = {
  agents: { id: string; handle: string; capabilities: string[]; busy: boolean; ownerUserId: string }[];
  people: { id: string; name: string }[];
  consultations: Record<string, unknown>[];
};

test("team: agents with what they can do and who is busy, their people, and who consulted whom (no question text)", async () => {
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

  // Dev is working right now and asked Infra something in their private DM.
  const ask = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "agent", agentId, runId: crypto.randomUUID(), hop: 0 },
    body: "Como o staging é publicado?",
  });
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: ask.id,
      triggerMessageId: ask.id,
      trigger: "mention",
      hop: 0,
      status: "running",
    })
    .returning();
  await t.db.insert(schema.agentConsultations).values({
    orgId,
    askerRunId: run?.id ?? "",
    askerAgentId: agentId,
    targetAgentId: infra.id,
    channelId,
    messageId: ask.id,
    waitId: "w1",
    question: "Como o staging é publicado?",
    chain: [agentId],
    expiresAt: new Date(Date.now() + 60_000),
  });

  const res = await owner(`/api/app/organizations/${orgId}/team`);
  expect(res.status).toBe(200);
  const team = (await res.json()) as Team;

  const dev = team.agents.find((a) => a.id === agentId);
  const inf = team.agents.find((a) => a.id === infra.id);
  expect(dev?.busy).toBe(true);
  expect(inf?.busy).toBe(false);
  expect(inf?.capabilities).toContain("drive");
  expect(inf?.capabilities).not.toContain("drive:read");
  expect(team.people.map((p) => p.id)).toContain(inf?.ownerUserId ?? "");
  expect(team.consultations).toHaveLength(1);
  expect(team.consultations[0]).toMatchObject({ askerAgentId: agentId, targetAgentId: infra.id, status: "open" });
  expect(JSON.stringify(team.consultations)).not.toContain("staging");
});
