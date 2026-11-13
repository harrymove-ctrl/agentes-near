import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }), env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

type Me = { organizations: { id: string; start?: { page: string; channelId: string | null } }[] };

test("what opens when the app starts: the home by default, each person's own, in GET /me", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const startOf = async (b: typeof owner) =>
    ((await (await b("/api/app/me")).json()) as Me).organizations.find((o) => o.id === orgId)?.start;
  const put = (b: typeof owner, json: Record<string, unknown>) =>
    b(`/api/app/organizations/${orgId}/me/start`, { method: "PUT", json });

  expect(await startOf(owner)).toEqual({ page: "home", channelId: null });

  const chosen = await put(owner, { page: "channel", channelId });
  expect(chosen.status).toBe(200);
  expect(await chosen.json()).toEqual({ page: "channel", channelId });
  expect(await startOf(owner)).toEqual({ page: "channel", channelId });

  // Another page drops the channel.
  expect(await (await put(owner, { page: "last", channelId })).json()).toEqual({ page: "last", channelId: null });
  expect(await startOf(owner)).toEqual({ page: "last", channelId: null });

  // A member's choice is theirs alone.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await startOf(member)).toEqual({ page: "home", channelId: null });
  expect((await put(member, { page: "channel", channelId })).status).toBe(200);
  expect(await startOf(owner)).toEqual({ page: "last", channelId: null });
});

test("a chosen channel is one of the workspace's, with me in it, not a DM and not archived", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const choose = async (channelId: unknown) => {
    const res = await api("/me/start", { method: "PUT", json: { page: "channel", channelId } });
    return {
      status: res.status,
      code: res.status === 200 ? null : ((await res.json()) as { error: { code: string } }).error.code,
    };
  };
  const refused = { status: 400, code: "start.channel_unknown" };

  expect(await choose(undefined)).toEqual(refused);
  expect(await choose("00000000-0000-4000-8000-000000000000")).toEqual(refused);
  expect((await choose("not-a-channel")).status).toBe(400);

  const { channelId: dmId } = (await (await api("/dms", { json: { agentId } })).json()) as { channelId: string };
  expect(await choose(dmId)).toEqual(refused);

  const made = (await (await api("/channels", { json: { name: "produto" } })).json()) as { id: string };
  expect(await choose(made.id)).toEqual({ status: 200, code: null });
  expect((await api(`/channels/${made.id}`, { method: "DELETE" })).status).toBeLessThan(300);
  expect(await choose(made.id)).toEqual(refused);

  // Someone else's workspace: not theirs to set.
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  const other = await stranger(`/api/app/organizations/${orgId}/me/start`, { method: "PUT", json: { page: "home" } });
  expect(other.status).toBe(403);
});
