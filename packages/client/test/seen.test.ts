import { describe, expect, test } from "bun:test";
import { seenMessageId, withRead } from "../src/lib/seen";

const msg = (id: string, at: string, by: string, local?: "pending") => ({
  id,
  createdAt: `2026-10-20T${at}:00.000Z`,
  author: { type: "person", id: by },
  ...(local ? { local } : {}),
});
const read = (at: string) => [{ userId: "bia", lastReadAt: `2026-10-20T${at}:00.000Z` }];

describe('"Visto" in a DM between people', () => {
  const list = [msg("m1", "08:00", "bia"), msg("m2", "08:47", "me")];

  test("under my latest message once they read it", () => {
    expect(seenMessageId(list, "me", read("08:50"))).toBe("m2");
    expect(seenMessageId(list, "me", read("08:40"))).toBeNull();
    expect(seenMessageId(list, "me", [])).toBeNull();
  });

  test("my own read never counts: sending marks the DM read for me, not for them", () => {
    const mine = { userId: "me", lastReadAt: "2026-10-20T08:48:00.000Z" };
    expect(seenMessageId(list, "me", [mine])).toBeNull();
    expect(seenMessageId(list, "me", [mine, ...read("08:40")])).toBeNull();
    expect(seenMessageId(list, "me", [mine, ...read("08:50")])).toBe("m2");
  });

  test("not when their answer came after, nor on a message still sending", () => {
    expect(seenMessageId([...list, msg("m3", "08:51", "bia")], "me", read("08:52"))).toBeNull();
    expect(seenMessageId([...list, msg("local-1", "08:53", "me", "pending")], "me", read("08:52"))).toBeNull();
  });

  test("a later read wins; an older one never moves it back", () => {
    const now = read("08:50");
    expect(withRead(now, { userId: "bia", lastReadAt: "2026-10-20T08:40:00.000Z" })).toEqual(now);
    expect(withRead(now, { userId: "bia", lastReadAt: "2026-10-20T09:00:00.000Z" })).toEqual(read("09:00"));
    expect(withRead(undefined, now[0] as (typeof now)[number])).toEqual(now);
  });
});
