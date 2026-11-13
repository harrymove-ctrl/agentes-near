import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { addChannelMember, insertMessage, postPersonMessage, pruneMessageClientIds } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

describe("idempotent sends (clientId)", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await setup();
  });
  afterEach(() => f.close());

  const post = (userId: string, body: string, extra: { clientId?: string; threadId?: string } = {}) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, { body, ...extra });
  const messages = () => f.db.select().from(schema.messages).where(eq(schema.messages.channelId, f.general.id));
  const runs = () => f.db.select().from(schema.agentRuns);
  const jobs = () => f.db.select().from(schema.outbox);

  test("same clientId twice: one message, one run; the resend returns the first and only republishes it", async () => {
    const events = f.listen(f.general.id);
    const first = await post(f.owner.id, "@dev please look", { clientId: "c-1" });
    const outboxAfterFirst = (await jobs()).length;
    const eventsAfterFirst = events.length;

    const again = await post(f.owner.id, "@dev please look", { clientId: " c-1 " });
    expect(again.id).toBe(first.id);
    expect(again.clientId).toBe("c-1");
    expect(again.body).toBe(first.body);
    expect(await messages()).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
    expect(await jobs()).toHaveLength(outboxAfterFirst);
    // Only `message.created` again (the first send may have died before publishing it).
    expect(events.slice(eventsAfterFirst).map((e) => e.type)).toEqual(["message.created"]);
  });

  test("different people with the same clientId: two messages", async () => {
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const a = await post(f.owner.id, "oi", { clientId: "same" });
    const b = await post(bia.id, "oi", { clientId: "same" });
    expect(a.id).not.toBe(b.id);
    expect(await messages()).toHaveLength(2);
  });

  test("without clientId: every send is a new message, as before", async () => {
    const a = await post(f.owner.id, "@dev one");
    const b = await post(f.owner.id, "@dev one");
    expect(a.id).not.toBe(b.id);
    expect(a.clientId).toBeNull();
    expect(await messages()).toHaveLength(2);
    expect(await f.db.select().from(schema.messageClientIds)).toHaveLength(0);
  });

  test("a refused send claims nothing: the retry into a valid place is written", async () => {
    const wrongThread = Bun.randomUUIDv7();
    await expect(post(f.owner.id, "oi", { clientId: "c-2", threadId: wrongThread })).rejects.toThrow("threadId");
    const ok = await post(f.owner.id, "oi", { clientId: "c-2" });
    expect(ok.clientId).toBe("c-2");
    expect(await messages()).toHaveLength(1);
  });

  test("agents' messages ignore clientId", async () => {
    const author = { type: "agent" as const, agentId: f.agent.id, runId: null, hop: 1, stretchId: null };
    const base = { orgId: f.org.id, channelId: f.general.id, author, body: "feito", clientId: "agent-1" };
    const a = await insertMessage(f.db, base);
    const b = await insertMessage(f.db, base);
    expect(a.id).not.toBe(b.id);
    expect(await f.db.select().from(schema.messageClientIds)).toHaveLength(0);
  });

  test("old send ids are pruned: a resend after that writes a new message", async () => {
    const first = await post(f.owner.id, "oi", { clientId: "c-3" });
    expect(await pruneMessageClientIds(f.db, 60_000)).toBe(0);
    expect(await pruneMessageClientIds(f.db, -60_000)).toBe(1);
    const later = await post(f.owner.id, "oi", { clientId: "c-3" });
    expect(later.id).not.toBe(first.id);
  });
});
