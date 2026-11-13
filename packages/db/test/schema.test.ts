import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Database, ensureMessagePartitions, rowsOf, schema, sql } from "../src";
import { createTestDatabase } from "./pglite";

let db: Database;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(() => close());

async function seed() {
  const [org] = await db.insert(schema.organizations).values({ name: "Acme" }).returning();
  if (!org) throw new Error("no org");
  const [channel] = await db.insert(schema.channels).values({ orgId: org.id, name: "general" }).returning();
  if (!channel) throw new Error("no channel");
  return { org, channel };
}

describe("migrations", () => {
  test("pgvector is enabled", async () => {
    const rows = rowsOf<{ d: number }>(await db.execute(sql`select '[1,2,3]'::vector <-> '[1,2,4]'::vector as d`));
    expect(Number(rows[0]?.d)).toBeCloseTo(1);
  });

  test("every tenant-owned table has org_id", async () => {
    const rows = rowsOf<{ table_name: string }>(
      await db.execute(sql`
        select t.table_name from information_schema.tables t
        where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
          and t.table_name not like 'messages\\_%'
          and t.table_name not in ('users', 'sessions', 'accounts', 'verifications', 'organizations', 'waitlist_entries', 'push_devices', 'instance_telemetry', 'instance_secrets', 'instance_push', 'push_relay_instances', 'signup_settings', 'claude_auth_settings', 'early_access_invitations', 'oauth_app_clients')
          and not exists (
            select 1 from information_schema.columns c
            where c.table_name = t.table_name and c.column_name = 'org_id'
          )`),
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});

describe("messages partitioning", () => {
  test("messages is range-partitioned with monthly partitions and a default", async () => {
    const parts = rowsOf<{ name: string }>(
      await db.execute(sql`
        select c.relname as name from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_class p on p.oid = i.inhparent
        where p.relname = 'messages' order by 1`),
    );
    const names = parts.map((p) => p.name);
    expect(names).toContain("messages_default");
    const now = new Date();
    const thisMonth = `messages_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(names).toContain(thisMonth);
    expect(names.length).toBe(4); // default + current + 2 ahead
  });

  test("ensureMessagePartitions is idempotent", async () => {
    expect(await ensureMessagePartitions(db)).toBe(0);
    expect(await ensureMessagePartitions(db, 3)).toBe(1);
  });

  test("rows land in the partition of their month; far-off rows in the default", async () => {
    const { org, channel } = await seed();
    const base = { orgId: org.id, channelId: channel.id, authorType: "person" as const, body: "hi" };
    await db.insert(schema.messages).values([{ ...base }, { ...base, createdAt: new Date("2001-01-01T00:00:00Z") }]);
    const rows = rowsOf<{ part: string; n: number }>(
      await db.execute(
        sql`select tableoid::regclass::text as part, count(*)::int as n from messages group by 1 order by 1`,
      ),
    );
    expect(rows.find((r) => r.part === "messages_default")?.n).toBe(1);
    expect(rows.filter((r) => r.part !== "messages_default").map((r) => r.n)).toEqual([1]);
  });

  test("message ids are time-ordered UUIDv7", async () => {
    const { org, channel } = await seed();
    const base = { orgId: org.id, channelId: channel.id, authorType: "person" as const, body: "x" };
    const [a] = await db.insert(schema.messages).values(base).returning();
    const [b] = await db.insert(schema.messages).values(base).returning();
    expect(a?.id.at(14)).toBe("7");
    expect((a?.id ?? "") < (b?.id ?? "")).toBe(true);
  });
});

describe("constraints", () => {
  test("a message author is either a person or an agent", async () => {
    const { org, channel } = await seed();
    const [agent] = await db
      .insert(schema.agents)
      .values({ orgId: org.id, name: "Dev", handle: "dev", model: "claude-sonnet-5-5" })
      .returning();
    await expect(
      Promise.resolve(
        db.insert(schema.messages).values({
          orgId: org.id,
          channelId: channel.id,
          authorType: "person",
          authorAgentId: agent?.id,
          body: "x",
        }),
      ),
    ).rejects.toThrow();
  });

  test("a channel member is exactly one of person or agent", async () => {
    const { org, channel } = await seed();
    await expect(
      Promise.resolve(db.insert(schema.channelMembers).values({ orgId: org.id, channelId: channel.id })),
    ).rejects.toThrow();
  });

  test("a channel membership can't cross organizations", async () => {
    const { channel } = await seed();
    const [other] = await db.insert(schema.organizations).values({ name: "Other" }).returning();
    const [agent] = await db
      .insert(schema.agents)
      .values({ orgId: other?.id ?? "", name: "Spy", handle: "spy", model: "claude-sonnet-5-5" })
      .returning();
    await expect(
      Promise.resolve(
        db.insert(schema.channelMembers).values({ orgId: other?.id ?? "", channelId: channel.id, agentId: agent?.id }),
      ),
    ).rejects.toThrow();
  });
});
