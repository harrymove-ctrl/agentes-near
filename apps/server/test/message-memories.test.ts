import { afterEach, beforeEach, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { consolidateItem } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

test("memory marks: messages list what an agent saved from them; forgetting it over the API tells the channel", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const events: { type: string; messageId?: string; memories?: unknown[] }[] = [];
  await t.adapters.pubsub.subscribe(channelTopic(channelId), (e) => events.push(e as (typeof events)[number]));

  const m = (await (await api(`/channels/${channelId}/messages`, { json: { body: "posts às terças" } })).json()) as {
    id: string;
  };
  const saved = await consolidateItem(t.db, {
    orgId,
    kind: "fact",
    scopeType: "agent",
    scopeId: agentId,
    agentId,
    content: "Os posts saem às terças.",
    sourceIds: [m.id],
    channelIds: [channelId],
  });

  type Msg = { id: string; memories?: { id: string; agentId: string; text: string }[] };
  const list = async () =>
    ((await (await api(`/channels/${channelId}/messages`)).json()) as { messages: Msg[] }).messages.find(
      (x) => x.id === m.id,
    );
  expect((await list())?.memories).toEqual([
    expect.objectContaining({ id: saved.item.id, agentId, text: "Os posts saem às terças." }),
  ]);

  const res = await api(`/memories/${saved.item.id}`, { method: "PATCH", json: { archived: true } });
  expect(res.status).toBe(200);
  expect((await list())?.memories).toBeUndefined();
  await Bun.sleep(5);
  expect(events.filter((e) => e.type === "message.memories").at(-1)).toMatchObject({ messageId: m.id, memories: [] });
});

test("a rule's giver rewrites it over the API, its grant included; the owner too, keeping the giver; nobody else", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com");
  const [giver] = await t.db.select().from(schema.users).where(eq(schema.users.email, "bia@example.com"));
  const { item } = await consolidateItem(t.db, {
    orgId,
    kind: "rule",
    scopeType: "agent",
    scopeId: agentId,
    agentId,
    content: "Send the offers to the group, without asking me before each send.",
    channelIds: [],
    createdByKind: "person",
    createdById: giver?.id,
  });
  const edit = (b: typeof owner, id: string, text: string) =>
    b(`/api/app/organizations/${orgId}/memories/${id}`, { method: "PATCH", json: { text } });

  expect((await edit(caio, item.id, "Send them to group C too.")).status).toBe(403);
  const byBia = await edit(bia, item.id, "Send the offers to groups A and B, without asking me before each send.");
  expect(byBia.status).toBe(200);
  const { id } = (await byBia.json()) as { id: string };
  expect((await edit(owner, id, "Send the offers to group A, without asking before each send.")).status).toBe(200);
  const rules = await t.db
    .select()
    .from(schema.contextItems)
    .where(and(eq(schema.contextItems.kind, "rule"), eq(schema.contextItems.status, "active")));
  expect(rules).toEqual([
    expect.objectContaining({
      content: "Send the offers to group A, without asking before each send.",
      createdById: giver?.id,
    }),
  ]);
});
