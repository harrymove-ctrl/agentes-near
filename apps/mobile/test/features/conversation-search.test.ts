import { describe, expect, test } from "bun:test";
import {
  DM_SEARCH_OPS,
  ENGLISH_SEARCH_WORDS,
  formatSearch,
  SEARCH_OPS,
  type SearchChip,
  type SearchDirectory,
} from "@agenteschat/client/lib/search-filters";
import { conversationScope, hitHref, hitTarget, idleIn, typeSearch } from "../../src/features/search/logic";

const geral = { id: "c1", name: "geral" };
const ana = { id: "d1", name: "Ana", dm: true };
const lia = { type: "person" as const, id: "u2", name: "Lia", handle: "lia" };
const dir: SearchDirectory = { actors: [lia], places: [geral, ana] };

describe("conversation search: scope", () => {
  test("a channel starts in itself, its in: chip shown and removable, every operator offered", () => {
    const s = conversationScope(geral, [{ op: "in", place: geral }]);
    expect(s.ops).toEqual(SEARCH_OPS);
    expect(s.shown).toEqual([{ op: "in", place: geral }]);
    expect(conversationScope(geral, []).searched).toEqual([]);
  });

  test("a DM holds to itself: its in: chip is searched, never shown; no who or where", () => {
    const chips: SearchChip[] = [{ op: "in", place: geral }, { op: "from", actor: lia }, { op: "pinned" }];
    const s = conversationScope(ana, chips);
    expect(s.ops).toEqual(DM_SEARCH_OPS);
    expect(s.ops).not.toContain("from");
    expect(s.ops).not.toContain("in");
    expect(s.searched).toEqual([{ op: "in", place: ana }, { op: "pinned" }]);
    expect(s.shown).toEqual([{ op: "pinned" }]);
    // A recent search in a DM is kept without the DM itself.
    expect(formatSearch(s.shown, "convite")).toBe("pinned:true convite");
  });

  test("idle while nothing is asked beyond the conversation", () => {
    expect(idleIn(geral, [{ op: "in", place: geral }], " ")).toBe(true);
    expect(idleIn(geral, [], "")).toBe(true);
    expect(idleIn(geral, [{ op: "in", place: geral }], "convite")).toBe(false);
    expect(idleIn(ana, [{ op: "in", place: ana }, { op: "pinned" }], "")).toBe(false);
  });
});

describe("conversation search: typing", () => {
  test("a space after a complete operator makes a chip", () => {
    expect(typeSearch("from:@lia ", [], dir, ENGLISH_SEARCH_WORDS)).toEqual({
      chips: [{ op: "from", actor: lia }],
      q: "",
    });
    expect(typeSearch("from:@lia", [], dir, ENGLISH_SEARCH_WORDS)).toEqual({ chips: [], q: "from:@lia" });
  });

  test("an operator a DM doesn't offer stays as typed", () => {
    expect(typeSearch("from:@lia ", [], dir, ENGLISH_SEARCH_WORDS, DM_SEARCH_OPS)).toEqual({
      chips: [],
      q: "from:@lia ",
    });
    expect(typeSearch("has:link ", [], dir, ENGLISH_SEARCH_WORDS, DM_SEARCH_OPS).chips).toEqual([
      { op: "has", value: "link" },
    ]);
  });
});

describe("conversation search: where a hit goes", () => {
  test("a message on this conversation's timeline is gone to in place", () => {
    expect(hitTarget({ channelIds: ["c1"], messageId: "m1", threadId: null }, "c1")).toEqual({
      kind: "here",
      messageId: "m1",
    });
    // A thread's root stands on the timeline.
    expect(hitTarget({ channelIds: ["c1"], messageId: "m1", threadId: "m1" }, "c1")).toEqual({
      kind: "here",
      messageId: "m1",
    });
  });

  test("a thread's reply opens the thread at it; another conversation's opens there", () => {
    expect(hitTarget({ channelIds: ["c1"], messageId: "m2", threadId: "m1" }, "c1")).toEqual({
      kind: "open",
      href: "/chat/c1?thread=m1&m=m2",
    });
    expect(hitTarget({ channelIds: ["c9"], messageId: "m3", threadId: null }, "c1")).toEqual({
      kind: "open",
      href: "/chat/c9?m=m3",
    });
    expect(hitHref({ channelIds: ["c1"], messageId: "m1", threadId: "m1" })).toBe("/chat/c1?m=m1");
  });
});
