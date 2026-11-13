import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("deleting an agent for good (ADR 0082): owners and admins; it leaves the team, its name stays for what it left", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const agent = `${org}/agents/${agentId}`;

  expect((await member(`${agent}?purge=true`, { method: "DELETE" })).status).toBe(403);
  expect((await owner(`${agent}?purge=true`, { method: "DELETE" })).status).toBe(204);

  // Only the workspace's right hand is left (ADR 0137).
  const left = (await (await member(`${org}/agents`)).json()) as { agents: { handle: string }[] };
  expect(left.agents.map((a) => a.handle)).toEqual(["lodi"]);
  expect(await (await member(`${org}/former-agents`)).json()).toEqual({
    agents: [{ id: agentId, name: "Dev", role: "", appearance: null, deleted: true }],
  });
  expect((await owner(agent)).status).toBe(404);
  expect((await owner(agent, { method: "PATCH", json: { name: "Back" } })).status).toBe(404);
  expect((await owner(`${agent}?purge=true`, { method: "DELETE" })).status).toBe(404);
  const audit = (await (await owner(`${org}/audit?kind=change`)).json()) as { rows: { action: string }[] };
  expect(audit.rows.map((r) => r.action)).toContain("agent.deleted");

  // Its handle is free again.
  expect((await owner(`${org}/agents`, { json: { name: "Dev", handle: "dev" } })).status).toBe(201);
});

test("an archived agent comes back from Equipe (who manages agents): in the team again, its handle kept", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const agent = `${org}/agents/${agentId}`;

  expect((await owner(agent, { method: "DELETE" })).status).toBe(204);
  const handles = async () =>
    ((await (await member(`${org}/agents`)).json()) as { agents: { handle: string }[] }).agents
      .map((a) => a.handle)
      .sort();
  expect(await handles()).toEqual(["lodi"]);

  expect((await member(`${agent}/unarchive`, { json: {} })).status).toBe(403);
  expect((await owner(`${agent}/unarchive`, { json: {} })).status).toBe(204);
  expect(await handles()).toEqual(["dev", "lodi"]);
  expect(await (await member(`${org}/former-agents`)).json()).toEqual({ agents: [] });
  const audit = (await (await owner(`${org}/audit?kind=change`)).json()) as { rows: { action: string }[] };
  expect(audit.rows.map((r) => r.action)).toContain("agent.unarchived");

  // A deleted one never comes back.
  expect((await owner(`${agent}?purge=true`, { method: "DELETE" })).status).toBe(204);
  expect((await owner(`${agent}/unarchive`, { json: {} })).status).toBe(404);
});
