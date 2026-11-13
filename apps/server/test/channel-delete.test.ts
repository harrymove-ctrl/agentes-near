import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("deleting a channel: owners and admins, its name typed, never #general; gone from the list, audited", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId: generalChannelId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const made = (await (await member(`${org}/channels`, { json: { name: "lancamento" } })).json()) as { id: string };
  const del = (who: typeof owner, id: string, name: string) => who(`${org}/channels/${id}/delete`, { json: { name } });

  // Its creator archives it; deleting is for owners and admins.
  expect((await del(member, made.id, "lancamento")).status).toBe(403);
  expect((await del(owner, made.id, "outro")).status).toBe(400);
  expect((await del(owner, generalChannelId, "general")).status).toBe(400);
  expect((await del(owner, made.id, "lancamento")).status).toBe(204);

  const list = (await (await owner(`${org}/channels`)).json()) as { channels: { id: string }[] };
  expect(list.channels.map((c) => c.id)).not.toContain(made.id);
  expect((await owner(`${org}/channels/${made.id}/unarchive`, { json: {} })).status).toBe(404);
  expect((await del(owner, made.id, "lancamento")).status).toBe(404);
  const audit = (await (await owner(`${org}/audit?kind=change`)).json()) as { rows: { action: string }[] };
  expect(audit.rows.map((r) => r.action)).toContain("channel.deleted");
  // Its name is free again.
  expect((await owner(`${org}/channels`, { json: { name: "lancamento" } })).status).toBe(201);
});

test("archived channels: listed for who may bring each back, and back as they were", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const made = (await (await member(`${org}/channels`, { json: { name: "lancamento" } })).json()) as { id: string };
  const other = (await (await owner(`${org}/channels`, { json: { name: "financeiro" } })).json()) as { id: string };
  expect((await member(`${org}/channels/${made.id}`, { method: "DELETE" })).status).toBe(204);
  expect((await owner(`${org}/channels/${other.id}`, { method: "DELETE" })).status).toBe(204);
  const archived = async (who: typeof owner) =>
    ((await (await who(`${org}/archived-channels`)).json()) as { channels: { name: string }[] }).channels
      .map((c) => c.name)
      .sort();
  // Its creator sees the one they made; an owner sees both.
  expect(await archived(member)).toEqual(["lancamento"]);
  expect(await archived(owner)).toEqual(["financeiro", "lancamento"]);

  expect((await member(`${org}/channels/${made.id}/unarchive`, { json: {} })).status).toBe(204);
  expect(await archived(member)).toEqual([]);
  const list = (await (await member(`${org}/channels`)).json()) as { channels: { id: string }[] };
  expect(list.channels.map((c) => c.id)).toContain(made.id);
  // A channel deleted for good isn't offered.
  expect((await owner(`${org}/channels/${other.id}/delete`, { json: { name: "financeiro" } })).status).toBe(204);
  expect(await archived(owner)).toEqual([]);
});
