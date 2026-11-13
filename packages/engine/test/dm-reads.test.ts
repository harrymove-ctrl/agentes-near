import { afterEach, describe, expect, test } from "bun:test";
import { dmReads, listDms, markChannelRead, openDm } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe('"Visto" in a DM between people', () => {
  test("reading the DM tells the other one; each sees only the others' reads", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    const events = f.listen(dm.id);
    expect(await dmReads(f.db, f.owner.id, f.org.id, dm.id)).toEqual([]);

    const at = new Date("2026-10-20T11:50:00.000Z");
    await markChannelRead(f.db, bia.id, f.org.id, dm.id, at, f.pubsub);
    expect(events).toContainEqual({
      type: "channel.read",
      channelId: dm.id,
      userId: bia.id,
      lastReadAt: at.toISOString(),
    });
    expect(await dmReads(f.db, f.owner.id, f.org.id, dm.id)).toEqual([
      { userId: bia.id, lastReadAt: at.toISOString() },
    ]);
    // Bia doesn't get her own read back.
    expect(await dmReads(f.db, bia.id, f.org.id, dm.id)).toEqual([]);
  });

  test("a channel never says who read what", async () => {
    f = await setup();
    const events = f.listen(f.general.id);
    await markChannelRead(f.db, f.owner.id, f.org.id, f.general.id, new Date(), f.pubsub);
    expect(events.filter((e) => e.type === "channel.read")).toEqual([]);
    expect(await dmReads(f.db, f.owner.id, f.org.id, f.general.id)).toEqual([]);
  });
});

describe("a DM's first visit (the right hand's wave, ADR 0137 §6)", () => {
  test("never read by me until I first read it, whatever the other one does", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    const everRead = async (userId: string) =>
      (await listDms(f.db, userId, f.org.id)).find((d) => d.channelId === dm.id)?.everRead;
    expect(await everRead(f.owner.id)).toBe(false);
    await markChannelRead(f.db, bia.id, f.org.id, dm.id);
    expect(await everRead(f.owner.id)).toBe(false);
    expect(await everRead(bia.id)).toBe(true);
    await markChannelRead(f.db, f.owner.id, f.org.id, dm.id);
    expect(await everRead(f.owner.id)).toBe(true);
  });
});
