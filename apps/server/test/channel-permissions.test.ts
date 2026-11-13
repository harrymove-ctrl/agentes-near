import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("a channel's exceptions: who manages it reads and sets them, the rest get 403, unknown 404; in OpenAPI", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const perms = `${org}/channels/${channelId}/permissions`;
  const { roles } = (await (await owner(`${org}/roles`)).json()) as { roles: { id: string; kind: string }[] };
  const everyone = roles.find((r) => r.kind === "everyone")?.id ?? "";

  expect((await member(perms)).status).toBe(403);
  const put = (who: typeof owner, json: unknown) => who(perms, { method: "PUT", json });
  expect((await put(member, { target: { type: "role", id: everyone }, allow: [], deny: ["post"] })).status).toBe(403);

  const set = await put(owner, { target: { type: "role", id: everyone }, allow: [], deny: ["post"] });
  expect(set.status).toBe(200);
  expect(await set.json()).toEqual({ target: { type: "role", id: everyone }, allow: [], deny: ["post"] });
  const listed = (await (await owner(perms)).json()) as { keys: string[]; overrides: unknown[] };
  expect(listed.keys).toEqual(["post", "talk_to_agents", "manage_channels"]);
  expect(listed.overrides).toHaveLength(1);

  const list = (await (await member(`${org}/channels`)).json()) as {
    channels: { id: string; can: { post: boolean; callAgents: boolean; manage: boolean } }[];
  };
  expect(list.channels.find((c) => c.id === channelId)?.can).toEqual({ post: false, callAgents: true, manage: false });
  const sent = await member(`${org}/channels/${channelId}/messages`, { json: { body: "oi" } });
  expect(sent.status).toBe(403);
  expect(((await sent.json()) as { error: { code: string } }).error.code).toBe("channel.post_denied");

  expect((await put(owner, { target: { type: "role", id: everyone }, allow: [], deny: [] })).status).toBe(204);
  expect((await member(`${org}/channels/${channelId}/messages`, { json: { body: "oi" } })).status).toBe(201);
  expect((await put(owner, { target: { type: "role", id: everyone }, allow: ["read"], deny: [] })).status).toBe(400);
  const unknown = `${org}/channels/00000000-0000-4000-8000-000000000000/permissions`;
  expect((await owner(unknown)).status).toBe(404);

  const doc = (await (await t.app.request("/api/openapi.json")).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  expect(Object.keys(doc.paths["/app/organizations/{orgId}/channels/{channelId}/permissions"] ?? {}).sort()).toEqual([
    "get",
    "put",
  ]);
});
