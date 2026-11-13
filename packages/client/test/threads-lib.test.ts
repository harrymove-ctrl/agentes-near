import { describe, expect, test } from "bun:test";
import type { Message, ThreadInfo } from "../src/index";
import {
  contextMarks,
  excludedRuns,
  hiddenByThreads,
  moveEdge,
  pickRow,
  type RangeSelection,
  selectionInfo,
  selectionOf,
  stepEdge,
  suggestRange,
  threadMessageCount,
  threadStartOf,
  threadStatus,
  timeSpan,
} from "../src/lib/threads";

const at = (minute: number) => new Date(2026, 9, 16, 10, minute).toISOString();
const msg = (id: string, minute: number, extra: Partial<Message> = {}): Message => ({
  id,
  channelId: "c",
  threadId: null,
  author: { type: "person", id: "ana" },
  body: id,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: at(minute),
  ...extra,
});
const start = (first: string, last: string, moved = false) => ({
  threadStart: {
    title: "T",
    contextChannelId: "c",
    firstMessageId: first,
    lastMessageId: last,
    count: 2,
    moved,
    movedCount: 0,
  },
});
const thread = (over: Partial<ThreadInfo> = {}): ThreadInfo => ({
  id: "root",
  channelId: "c",
  channelName: "produto",
  channelKind: "channel",
  title: null,
  rootText: "root",
  rootAuthor: { type: "person", id: "ana" },
  state: "open",
  createdBy: "ana",
  closedBy: null,
  closedAt: null,
  archivedBy: null,
  archivedAt: null,
  context: null,
  replyCount: 0,
  lastActivityAt: at(40),
  lastMessage: null,
  participants: [],
  working: false,
  needsYou: false,
  openedByReplyAt: null,
  suggestedResolved: false,
  canManage: true,
  createdAt: at(40),
  ...over,
});

describe("suggestRange (Criar thread a partir daqui)", () => {
  const list = [msg("a", 0), msg("b", 2), msg("c", 5), msg("d", 30), msg("e", 31)];

  test("starts at the clicked message and runs forward until a long pause", () => {
    expect(suggestRange(list, "b")).toEqual({ firstId: "b", lastId: "c", ids: ["b", "c"] });
    expect(suggestRange(list, "d")).toEqual({ firstId: "d", lastId: "e", ids: ["d", "e"] });
  });

  test("a message alone is a range of one; unknown ids give nothing", () => {
    expect(suggestRange([msg("x", 0), msg("y", 40)], "x")?.ids).toEqual(["x"]);
    expect(suggestRange(list, "nope")).toBeNull();
  });

  test("skips replies, unsent messages and thread markers, and stops at the cap", () => {
    const mixed = [
      msg("a", 0),
      msg("reply", 1, { threadId: "a" }),
      msg("local", 1, { local: "pending" }),
      msg("marker", 2, { meta: start("a", "a") }),
      msg("b", 3),
      msg("c", 4),
    ];
    expect(suggestRange(mixed, "a")?.ids).toEqual(["a", "b", "c"]);
    expect(suggestRange(mixed, "a", { max: 2 })?.ids).toEqual(["a", "b"]);
  });
});

describe("timeSpan", () => {
  test("same day: one clock range; one instant: one time", () => {
    expect(timeSpan("pt-BR", at(2), at(31))).toBe("10:02–10:31");
    expect(timeSpan("pt-BR", at(2), at(2))).toBe("10:02");
  });
  test("across days: both dates", () => {
    const next = new Date(2026, 9, 17, 9, 0).toISOString();
    const label = timeSpan("pt-BR", at(2), next);
    expect(label).toContain("10:02");
    expect(label).toContain("09:00");
    expect(label).toContain(" – ");
  });
});

describe("the selection of Ajustar trecho", () => {
  const list = ["a", "b", "c", "d", "e", "f"].map((id, i) => msg(id, i));
  const sel: RangeSelection = { a: "b", b: "d", excluded: new Set(["c"]) };

  test("counts what is in, from the first to the last included", () => {
    const info = selectionInfo(list, sel);
    expect(info.range.map((m) => m.id)).toEqual(["b", "c", "d"]);
    expect(info.count).toBe(2);
    expect(info.left.map((m) => m.id)).toEqual(["c"]);
    expect([info.from, info.to]).toEqual([at(1), at(3)]);
  });

  test("a tap outside extends the range; inside toggles the row", () => {
    expect(pickRow(list, sel, "a").a).toBe("a");
    expect(pickRow(list, sel, "f").b).toBe("f");
    expect([...pickRow(list, sel, "c").excluded]).toEqual([]);
    expect([...pickRow(list, sel, "d").excluded].sort()).toEqual(["c", "d"]);
  });

  test("edges never cross, and exclusions that fall out are dropped", () => {
    expect(moveEdge(list, sel, "a", "e").a).toBe("d");
    expect(moveEdge(list, sel, "b", "a").b).toBe("b");
    const moved = moveEdge(list, sel, "a", "d");
    expect(moved.a).toBe("d");
    expect([...moved.excluded]).toEqual([]);
    expect(stepEdge(list, sel, "a", -1).a).toBe("a");
    expect(stepEdge(list, sel, "b", 1).b).toBe("e");
    expect(stepEdge(list, { ...sel, a: "a" }, "a", -1).a).toBe("a");
  });

  test("rows left out in a row collapse under the first one", () => {
    const wide: RangeSelection = { a: "a", b: "f", excluded: new Set(["b", "c", "e"]) };
    const runs = excludedRuns(list, wide);
    expect([...runs.heads.keys()]).toEqual(["b", "e"]);
    expect(runs.heads.get("b")?.map((m) => m.id)).toEqual(["b", "c"]);
    expect([...runs.hidden]).toEqual(["c"]);
    // Opened by the person: shown as rows again.
    expect(excludedRuns(list, wide, new Set(["b", "c"])).heads.has("b")).toBe(false);
  });

  test("starts from the thread's context when its messages are loaded", () => {
    const ctx = {
      channelId: "c",
      firstMessageId: "b",
      lastMessageId: "e",
      excludedMessageIds: ["c", "z"],
      moved: false,
      count: 3,
    };
    const s = selectionOf(list, ctx);
    expect(s && [s.a, s.b, [...s.excluded]]).toEqual(["b", "e", ["c"]]);
    expect(selectionOf(list.slice(3), ctx)).toBeNull();
  });
});

describe("what the channel shows", () => {
  const list = [msg("a", 0), msg("b", 1), msg("c", 2), msg("root", 3, { meta: start("a", "c") }), msg("d", 4)];
  const ctx = {
    channelId: "c",
    firstMessageId: "a",
    lastMessageId: "c",
    excludedMessageIds: ["b"],
    moved: false,
    count: 2,
  };

  test("context messages still in the channel get the mark", () => {
    expect([...contextMarks([thread({ context: ctx })], list, "c")]).toEqual(["a", "c"]);
    expect(contextMarks([thread({ context: { ...ctx, moved: true } })], list, "c").size).toBe(0);
    expect(contextMarks([thread({ context: ctx })], list, "other").size).toBe(0);
  });

  test("closed and archived threads hide their replies; archived roots and range replies too", () => {
    const hidden = hiddenByThreads(
      [thread({ id: "x", state: "closed" }), thread({ id: "y", state: "archived" })],
      [...list, msg("x", 5), msg("y", 6)],
    );
    expect(hidden(msg("r1", 7, { threadId: "x" }))).toBe(true);
    expect(hidden(msg("x", 5))).toBe(false);
    expect(hidden(msg("y", 6))).toBe(true);
    expect(hidden(msg("r2", 8, { threadId: "root" }))).toBe(true);
    expect(hidden(msg("d", 4))).toBe(false);
  });

  test("markers, status and counts", () => {
    expect(threadStartOf(list[3]?.meta)?.firstMessageId).toBe("a");
    expect(threadStartOf({ threadStart: { title: "x" } })).toBeNull();
    expect(threadStatus(thread({ needsYou: true, working: true }))).toBe("needsYou");
    expect(threadStatus(thread({ working: true }))).toBe("working");
    expect(threadStatus(thread({ state: "archived", needsYou: true }))).toBe("archived");
    expect(threadMessageCount(thread({ replyCount: 3 }))).toBe(4);
    expect(threadMessageCount(thread({ replyCount: 3, context: ctx }))).toBe(5);
    expect(threadMessageCount(thread({ replyCount: 5, context: { ...ctx, moved: true } }))).toBe(5);
  });
});
