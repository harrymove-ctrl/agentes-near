import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

type Team = { agents: { id: string; reportsToAgentId: string | null }[] };

test("Responde a: who manages agents sets it at once and puts it back; members read it; a loop is refused", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId: dev } = await seedOrg(owner);
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const nina = (await (await api(owner, "/agents", { json: { name: "Nina", handle: "nina" } })).json()) as {
    id: string;
  };
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");

  const set = await api(owner, "/agent-lines", {
    method: "PUT",
    json: { changes: [{ agentId: dev, reportsToAgentId: nina.id }] },
  });
  expect(set.status).toBe(200);
  const { previous } = (await set.json()) as { previous: { agentId: string; reportsToAgentId: string | null }[] };
  expect(previous).toEqual([{ agentId: dev, reportsToAgentId: null }]);

  const team = (await (await api(member, "/team")).json()) as Team;
  expect(team.agents.find((a) => a.id === dev)?.reportsToAgentId).toBe(nina.id);
  const { agents } = (await (await api(member, "/agents")).json()) as {
    agents: { id: string; reportsToAgentId?: string | null }[];
  };
  expect(agents.find((a) => a.id === dev)?.reportsToAgentId).toBe(nina.id);

  const refused = await api(member, "/agent-lines", { method: "PUT", json: { changes: previous } });
  expect(refused.status).toBe(403);
  const loop = await api(owner, "/agent-lines", {
    method: "PUT",
    json: { changes: [{ agentId: nina.id, reportsToAgentId: dev }] },
  });
  expect(loop.status).toBe(400);
  expect(((await loop.json()) as { error: { code: string } }).error.code).toBe("agent.reports_to");

  // Desfazer: the same call with what came back.
  expect((await api(owner, "/agent-lines", { method: "PUT", json: { changes: previous } })).status).toBe(200);
  const after = (await (await api(owner, "/team")).json()) as Team;
  expect(after.agents.find((a) => a.id === dev)?.reportsToAgentId).toBeNull();
});
