import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

/** Owner with @dev in #general, and a member who joined by invitation. */
async function workspace() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const member = browser(t);
  await signUp(member, "ana@example.com");
  const { url } = (await (
    await owner(`/api/app/organizations/${seeded.orgId}/invitations`, {
      json: { email: "ana@example.com", role: "member" },
    })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const api = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { ...seeded, owner: api(owner), member: api(member) };
}

type AgentJson = { id: string; handle: string; previousHandles: string[] };

test("PATCH moves the handle: everyone reads the old one, which still mentions it; a taken one is a 409 with a free one", async () => {
  const w = await workspace();
  const atlas = (await (
    await w.owner("/agents", { json: { name: "Atlas", handle: "atlas", credentialId: w.credentialId } })
  ).json()) as AgentJson;

  // Only who manages agents renames one.
  expect((await w.member(`/agents/${w.agentId}`, { method: "PATCH", json: { handle: "claudio" } })).status).toBe(403);
  const res = await w.owner(`/agents/${w.agentId}`, { method: "PATCH", json: { name: "Claudio", handle: "claudio" } });
  expect(res.status).toBe(200);
  expect((await res.json()) as AgentJson).toMatchObject({ handle: "claudio", previousHandles: ["dev"] });
  const listed = ((await (await w.member("/agents")).json()) as { agents: AgentJson[] }).agents;
  expect(listed.find((a) => a.id === w.agentId)).toMatchObject({ handle: "claudio", previousHandles: ["dev"] });

  const taken = await w.owner(`/agents/${atlas.id}`, { method: "PATCH", json: { handle: "dev" } });
  expect(taken.status).toBe(409);
  expect(await taken.json()).toMatchObject({
    error: { code: "agent.handle_taken", params: { handle: "dev", suggestion: "dev-2" } },
  });

  const sent = await w.owner(`/channels/${w.channelId}/messages`, { json: { body: "@dev oi" } });
  expect(((await sent.json()) as { mentionedAgentIds: string[] }).mentionedAgentIds).toEqual([w.agentId]);
});
