import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Ok."] }) });
});
afterEach(() => t.close());

test("a #channel link's card: a public one for everyone, a private one only for its members", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = async (name: string, visibility: "public" | "private") =>
    ((await (await api("/channels", { json: { name, visibility } })).json()) as { id: string }).id;
  const vendas = await created("vendas", "public");
  const diretoria = await created("diretoria", "private");

  // A message in #vendas names both: the server stores the public one; the private one only inside itself.
  const posted = await api(`/channels/${vendas}/messages`, { json: { body: "de #vendas para #Diretoria" } });
  const message = (await posted.json()) as { meta: { channelRefs?: unknown } };
  expect(message.meta.channelRefs).toEqual({ vendas });
  const inside = await api(`/channels/${diretoria}/messages`, { json: { body: "aqui em #diretoria" } });
  expect(((await inside.json()) as { meta: { channelRefs?: unknown } }).meta.channelRefs).toEqual({ diretoria });

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string) => member(`/api/app/organizations/${orgId}${path}`);
  const card = await asMember(`/channels/${vendas}/card`);
  expect(card.status).toBe(200);
  expect(await card.json()).toEqual({
    id: vendas,
    name: "vendas",
    topic: "",
    visibility: "public",
    audienceRoleIds: [],
    isMember: false,
    archived: false,
    people: 1,
    agents: 0,
  });
  expect((await asMember(`/channels/${diretoria}/card`)).status).toBe(404);
  expect((await api(`/channels/${diretoria}/card`)).status).toBe(200);
});

test("a channel for a department: its people see it, join it and lose it with the role (ADR 0125)", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const role = (await (await api("/roles", { json: { name: "Vendas" } })).json()) as { id: string };
  const created = await api("/channels", {
    json: { name: "vendas", visibility: "private", audienceRoleIds: [role.id] },
  });
  expect(created.status).toBe(201);
  const channel = (await created.json()) as { id: string; audienceRoleIds: string[] };
  expect(channel.audienceRoleIds).toEqual([role.id]);

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${orgId}${path}`, init);
  const userId = ((await (await member("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const listed = async () =>
    ((await (await asMember("/channels")).json()) as { channels: { id: string; isMember: boolean }[] }).channels
      .filter((c) => c.id === channel.id)
      .map((c) => c.isMember);

  expect(await listed()).toEqual([]);
  expect((await asMember(`/channels/${channel.id}/join`, { json: {} })).status).toBe(403);

  await api(`/members/${userId}/roles`, { method: "PUT", json: { roleIds: [role.id] } });
  expect(await listed()).toEqual([false]);
  expect((await asMember(`/channels/${channel.id}/card`)).status).toBe(200);
  expect((await asMember(`/channels/${channel.id}/join`, { json: {} })).status).toBe(204);
  expect(await listed()).toEqual([true]);

  await api(`/members/${userId}/roles`, { method: "PUT", json: { roleIds: [] } });
  expect(await listed()).toEqual([]);
  expect((await asMember(`/channels/${channel.id}/messages`)).status).toBe(403);

  // Changed later by its creator: back to invite only.
  const patched = await api(`/channels/${channel.id}`, { method: "PATCH", json: { audienceRoleIds: [] } });
  expect(((await patched.json()) as { audienceRoleIds: string[] }).audienceRoleIds).toEqual([]);
});

test("a message link's pill: where it is and who wrote it, only for who can see it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = async (name: string, visibility: "public" | "private") =>
    ((await (await api("/channels", { json: { name, visibility } })).json()) as { id: string }).id;
  const say = async (channelId: string, body: string) =>
    ((await (await api(`/channels/${channelId}/messages`, { json: { body } })).json()) as { id: string }).id;
  const vendas = await created("vendas", "public");
  const diretoria = await created("diretoria", "private");
  const open = await say(vendas, "a meta do mês");
  const closed = await say(diretoria, "o orçamento");

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const asMember = (path: string) => member(`/api/app/organizations/${orgId}${path}`);
  const card = await asMember(`/messages/${open}/card`);
  expect(card.status).toBe(200);
  expect(await card.json()).toMatchObject({
    id: open,
    channelId: vendas,
    threadId: null,
    kind: "channel",
    name: "vendas",
  });
  // Nothing of the private channel: not its name, not that the message exists.
  const hidden = await asMember(`/messages/${closed}/card`);
  expect(hidden.status).toBe(404);
  expect(await hidden.text()).not.toContain("diretoria");
  expect((await api(`/messages/${closed}/card`)).status).toBe(200);
});

test("an id written in a text: what it names, only for who can see it, and nothing for an id that isn't ours", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const diretoria = (
    (await (await api("/channels", { json: { name: "diretoria", visibility: "private" } })).json()) as {
      id: string;
    }
  ).id;
  const closed = (
    (await (await api(`/channels/${diretoria}/messages`, { json: { body: "o orçamento" } })).json()) as {
      id: string;
    }
  ).id;
  const task = (await (await api("/issues", { json: { title: "Widget flutuante" } })).json()) as {
    id: string;
    number: number;
  };
  expect(await (await api(`/refs/${task.id}`)).json()).toEqual({
    kind: "task",
    id: task.id,
    number: task.number,
    title: "Widget flutuante",
  });
  expect(await (await api(`/refs/${closed}`)).json()).toMatchObject({ kind: "message", message: { id: closed } });
  expect((await api(`/refs/${crypto.randomUUID()}`)).status).toBe(404);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const hidden = await member(`/api/app/organizations/${orgId}/refs/${closed}`);
  expect(hidden.status).toBe(404);
  expect(await hidden.text()).not.toContain("diretoria");
});
