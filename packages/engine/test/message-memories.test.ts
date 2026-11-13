import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  announceMessageMemories,
  consolidateItem,
  createChannel,
  drainOutbox,
  editContextItem,
  listMessages,
  postPersonMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** "lembra" saves a fact with `remember`; anything else is a short answer. */
const reply = (req: { messages: { content: unknown }[] }) => {
  const last = JSON.stringify(req.messages.at(-1)?.content ?? "");
  if (last.includes("tool_result")) return { chunks: ["Anotado."] };
  if (last.includes("lembra"))
    return { chunks: [], toolUses: [{ name: "remember", input: { content: "Os posts do blog saem às terças." } }] };
  return { chunks: ["ok"] };
};

const post = (body: string, channelId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId ?? f.general.id, { body });

describe("memory marks on people's messages", () => {
  test("remember from a person's message: the message lists the memory, live and in the list", async () => {
    f = await setup({ contextTools: true, reply });
    const events = f.listen(f.general.id);
    const asked = await post("@dev lembra que os posts saem às terças");
    await drainOutbox(f.db, f.handlers);

    const [item] = await f.db.select().from(schema.contextItems);
    if (!item) throw new Error("nothing saved");
    const listed = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const mine = listed.find((m) => m.id === asked.id);
    expect(mine?.memories).toEqual([
      {
        id: item.id,
        agentId: f.agent.id,
        kind: "fact",
        text: "Os posts do blog saem às terças.",
        createdAt: item.createdAt.toISOString(),
      },
    ]);
    // The agent's own messages never carry a mark.
    expect(listed.filter((m) => m.author.type === "agent").every((m) => m.memories === undefined)).toBe(true);
    await Bun.sleep(5);
    expect(events.find((e) => e.type === "message.memories")).toMatchObject({
      type: "message.memories",
      channelId: f.general.id,
      messageId: asked.id,
      memories: [{ id: item.id, agentId: f.agent.id }],
    });
  });

  test("forgotten or fixed memories update the mark; items from other channels stay out", async () => {
    f = await setup();
    const events = f.listen(f.general.id);
    const m = await post("os posts saem às terças");
    const saved = await consolidateItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      content: "Os posts saem às terças.",
      sourceIds: [m.id],
      channelIds: [f.general.id],
    });
    const marks = async () =>
      (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((x) => x.id === m.id)?.memories;
    expect((await marks())?.map((x) => x.id)).toEqual([saved.item.id]);

    // A fix is a new version: the mark follows it.
    const fixed = await editContextItem(f.db, f.owner.id, f.org.id, saved.item.id, {
      content: "Os posts saem às quartas.",
    });
    expect((await marks())?.map((x) => x.text)).toEqual(["Os posts saem às quartas."]);

    // Archived: no mark; the event says so.
    await editContextItem(f.db, f.owner.id, f.org.id, fixed.id, { archived: true });
    expect(await marks()).toBeUndefined();
    await announceMessageMemories({ db: f.db, pubsub: f.pubsub }, f.org.id, fixed);
    await Bun.sleep(5);
    expect(events.filter((e) => e.type === "message.memories").at(-1)).toMatchObject({ memories: [] });

    // Also drawn from a private channel: whoever reads #general might not read it, so no mark.
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await consolidateItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "agent",
      scopeId: f.agent.id,
      agentId: f.agent.id,
      content: "O orçamento de novembro é 10 mil.",
      sourceIds: [m.id],
      channelIds: [f.general.id, secret.id],
    });
    expect(await marks()).toBeUndefined();

    // Shared items (no agent) and summaries are not an agent studying.
    await consolidateItem(f.db, {
      orgId: f.org.id,
      kind: "fact",
      scopeType: "channel",
      scopeId: f.general.id,
      content: "O canal combina posts às terças.",
      sourceIds: [m.id],
      channelIds: [f.general.id],
    });
    expect(await marks()).toBeUndefined();
    const rows = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.orgId, f.org.id));
    expect(rows.length).toBeGreaterThan(2);
  });
});
