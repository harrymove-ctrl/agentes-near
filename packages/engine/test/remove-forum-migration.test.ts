import { afterEach, expect, test } from "bun:test";
import { eq, rowsOf, schema, sql } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import { insertMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const count = async (table: string) =>
  rowsOf<{ n: number }>(await f.db.execute(sql.raw(`select count(*)::int as n from "${table}"`)))[0]?.n ?? 0;

test("the forum's removal takes its channels and what points at them; other conversations stay as they were", async () => {
  f = await setup();
  const orgId = f.org.id;
  const [forum] = await f.db
    .insert(schema.channels)
    .values({ orgId, name: "forum-pricing", kind: "forum", visibility: "public" })
    .returning();
  if (!forum) throw new Error("no forum channel");
  await f.db.insert(schema.channelMembers).values({ orgId, channelId: forum.id, userId: f.owner.id });
  const post = await insertMessage(f.db, {
    orgId,
    channelId: forum.id,
    author: { type: "person", userId: f.owner.id },
    body: "Plano B",
  });
  const topicId = crypto.randomUUID();
  await f.db.execute(
    sql`insert into forum_topics (id, org_id, channel_id, title, goal, created_by_type, created_by_id)
      values (${topicId}, ${orgId}, ${forum.id}, 'Preço', 'Decidir', 'person', ${f.owner.id})`,
  );
  await f.db.execute(
    sql`insert into forum_turns (id, org_id, topic_id, round, seat_type, seat_id, kind)
      values (${crypto.randomUUID()}, ${orgId}, ${topicId}, 0, 'person', ${f.owner.id}, 'post')`,
  );

  const agent = { type: "agent" as const, agentId: f.agent.id, runId: null, hop: 0, stretchId: null };
  const kept = await insertMessage(f.db, {
    orgId,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "Bom dia",
  });
  const card = await insertMessage(f.db, {
    orgId,
    channelId: f.general.id,
    author: agent,
    body: 'Worth a forum? "Preço"',
    meta: { forumSuggestion: { title: "Preço" } },
  });
  const answered = await insertMessage(f.db, {
    orgId,
    channelId: f.general.id,
    author: agent,
    body: 'The forum "Preço" is over.',
    meta: { forumConcluded: { topicId }, bodyCode: "forum_concluded" },
  });
  const reply = await insertMessage(f.db, {
    orgId,
    channelId: f.general.id,
    threadId: answered.id,
    author: { type: "person", userId: f.owner.id },
    body: "Valeu",
  });
  await f.db.insert(schema.notifications).values([
    { orgId, userId: f.owner.id, kind: "forum_turn", groupKey: `forum_turn:${topicId}:1`, source: { topicId } },
    { orgId, userId: f.owner.id, kind: "mention", groupKey: `mention:${kept.id}`, source: { messageId: kept.id } },
  ]);
  await f.db
    .insert(schema.agentScopes)
    .values({ orgId, agentId: f.agent.id, connectionId: null, scope: "forum:write" })
    .onConflictDoNothing();
  await f.db.execute(
    sql`update organization_members set sidebar_items = '{"forum":"always","wiki":"more","tools":["forum","drive","wiki"]}'::jsonb where user_id = ${f.owner.id}`,
  );
  const scopesBefore = await count("agent_scopes");

  await runMigration(f.db, "remove_forum");

  const channelIds = (await f.db.select({ id: schema.channels.id }).from(schema.channels)).map((c) => c.id);
  expect(channelIds).toContain(f.general.id);
  expect(channelIds).not.toContain(forum.id);
  const left = await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, orgId));
  const byId = new Map(left.map((m) => [m.id, m]));
  expect(byId.has(post.id)).toBe(false);
  expect(byId.has(card.id)).toBe(false);
  expect(byId.get(kept.id)).toMatchObject({ body: "Bom dia", deletedAt: null });
  // Replied to in its thread: emptied as a deleted message, its reply untouched.
  expect(byId.get(answered.id)?.deletedAt).toBeInstanceOf(Date);
  expect(byId.get(answered.id)?.meta.forumConcluded).toBeUndefined();
  expect(byId.get(reply.id)).toMatchObject({ body: "Valeu", threadId: answered.id, deletedAt: null });
  expect(await f.db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, forum.id))).toEqual(
    [],
  );

  const kinds = (await f.db.select({ kind: schema.notifications.kind }).from(schema.notifications)).map((n) => n.kind);
  expect(kinds).toEqual(["mention"]);
  expect(await count("agent_scopes")).toBe(scopesBefore - 1);
  const [member] = await f.db
    .select({ items: schema.organizationMembers.sidebarItems })
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.userId, f.owner.id));
  expect(member?.items as unknown).toEqual({ wiki: "more", tools: ["drive", "wiki"] });
  // The tables stay for one release (the previous version still reads them); their rows go with their channels.
  expect(await count("forum_topics")).toBe(0);
  expect(await count("forum_turns")).toBe(0);
});

test("without forum data it changes nothing", async () => {
  f = await setup();
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "Bom dia",
  });
  const tables = ["channels", "messages", "channel_members", "notifications", "agent_scopes", "agent_runs", "issues"];
  const before = await Promise.all(tables.map(count));
  await runMigration(f.db, "remove_forum");
  expect(await Promise.all(tables.map(count))).toEqual(before);
});
