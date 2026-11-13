import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Channel } from "@agenteschat/client";
import { categoryHrefs, channelSteps, movesChannel, stepBefore } from "../../src/features/categories/logic";
import {
  agentStarters,
  buildConversations,
  categoryListKind,
  categoryOfListKind,
  homeLayout,
  parseHomeCollapsed,
  toggleHomeCollapsed,
} from "../../src/features/chats/logic";
import { at } from "./fixtures";

const channel = (id: string, minutesAgo: number, over: Partial<Channel> = {}): Channel => ({
  id,
  name: id,
  topic: "",
  visibility: "public",
  isMember: true,
  createdAt: at(1000),
  lastMessage: {
    id: `m-${id}`,
    authorType: "person",
    authorId: "u1",
    authorName: "Caio",
    preview: "oi",
    meta: null,
    createdAt: at(minutesAgo),
  },
  ...over,
});

const CATEGORIES = [
  { id: "mkt", name: "Marketing", position: 0 },
  { id: "eng", name: "Engenharia", position: 1 },
  { id: "empty", name: "Vazia", position: 2 },
];

describe("the home with channel categories", () => {
  const rows = buildConversations({
    channels: [
      channel("general", 5),
      channel("campanhas", 1, { categoryId: "mkt", unreadCount: 2 }),
      channel("bugs", 3, { categoryId: "eng" }),
      channel("marketing", 9, { categoryId: "mkt" }),
      // A category this phone doesn't know yet: with the ones with none.
      channel("novo", 7, { categoryId: "gone" }),
    ],
    dms: [],
    threads: [],
  });

  test("Canais holds the ones with no category, then one section per category in order, empty ones left out", () => {
    const blocks = homeLayout(rows, CATEGORIES);
    expect(blocks.map((b) => [b.key, b.name, b.rows.map((r) => r.key)])).toEqual([
      ["channels", undefined, ["c:general", "c:novo"]],
      ["category:mkt", "Marketing", ["c:campanhas", "c:marketing"]],
      ["category:eng", "Engenharia", ["c:bugs"]],
    ]);
  });

  test("pinned channels go on top of Canais whatever their category, in their order, and say how many", () => {
    const blocks = homeLayout(rows, CATEGORIES, undefined, [], { agents: [], channels: ["bugs", "novo"], people: [] });
    expect(blocks.map((b) => [b.key, b.rows.map((r) => r.key), b.pinned ?? 0])).toEqual([
      ["channels", ["c:bugs", "c:novo", "c:general"], 2],
      ["category:mkt", ["c:campanhas", "c:marketing"], 0],
    ]);
  });

  test("a category's unread channels are kept for when it is closed", () => {
    const mkt = homeLayout(rows, CATEGORIES).find((b) => b.categoryId === "mkt");
    expect(mkt?.unread.map((r) => r.key)).toEqual(["c:campanhas"]);
  });

  test("closed sections keep any key, and toggle", () => {
    expect(parseHomeCollapsed(JSON.stringify(["agents", "category:mkt", 3]))).toEqual(["agents", "category:mkt"]);
    expect(parseHomeCollapsed("nope")).toEqual([]);
    expect(toggleHomeCollapsed(["agents"], "category:mkt")).toEqual(["agents", "category:mkt"]);
    expect(toggleHomeCollapsed(["agents", "category:mkt"], "agents")).toEqual(["category:mkt"]);
  });

  test("a category's Ver todos route", () => {
    expect(categoryOfListKind(categoryListKind("mkt"))).toBe("mkt");
    expect(categoryOfListKind("channels")).toBeNull();
  });
});

describe("the home's Agentes before any conversation with an agent", () => {
  const agents = [
    { id: "a1", name: "Ada", handle: "ada" },
    { id: "a2", name: "Dev", handle: "dev" },
    { id: "a3", name: "Infra", handle: "infra" },
  ];
  const starters = agentStarters(agents, new Set(["a3"]));
  const channels = buildConversations({ channels: [channel("general", 5)], dms: [], threads: [] });

  test("lists the team's agents I can see, each a DM still to open, with no 'Ver todos'", () => {
    const agentsBlock = homeLayout(channels, [], 1, starters)[0];
    expect(agentsBlock?.key).toBe("agents");
    expect(agentsBlock?.rows.map((r) => [r.key, r.channelId])).toEqual([["a:a1", ""]]);
    expect(agentsBlock?.total).toBe(2);
    expect(agentsBlock?.more).toBe(false);
  });

  test("an agent DM replaces them", () => {
    const rows = buildConversations({
      channels: [],
      dms: [
        {
          channelId: "d1",
          with: { type: "agent", id: "a2", name: "Dev", handle: "dev" },
          lastMessage: null,
          unread: 0,
        },
      ],
      threads: [],
    });
    expect(homeLayout(rows, [], undefined, starters)[0]?.rows.map((r) => r.key)).toEqual(["d:d1"]);
  });
});

describe("arranging categories", () => {
  test("moving one step up or down says what it then sits before", () => {
    const ids = ["a", "b", "c"];
    expect(stepBefore(ids, "c", -1)).toBe("b");
    expect(stepBefore(ids, "a", 1)).toBe("c");
    expect(stepBefore(ids, "b", 1)).toBeNull();
    expect(stepBefore(ids, "a", -1)).toBeUndefined();
    expect(stepBefore(ids, "c", 1)).toBeUndefined();
  });

  test("a channel moves one step among the ones of its category, or the ones with none", () => {
    const list = [
      { id: "general", categoryId: null },
      { id: "bugs", categoryId: "eng" },
      { id: "avisos" },
      { id: "tech", categoryId: "eng" },
      { id: "vendas", categoryId: null },
    ];
    expect(channelSteps(list, "avisos")).toEqual({
      at: 1,
      count: 3,
      up: { channelId: "avisos", categoryId: null, beforeChannelId: "general" },
      down: { channelId: "avisos", categoryId: null, beforeChannelId: null },
    });
    expect(channelSteps(list, "general").up).toBeUndefined();
    expect(channelSteps(list, "tech")).toEqual({
      at: 1,
      count: 2,
      up: { channelId: "tech", categoryId: "eng", beforeChannelId: "bugs" },
      down: undefined,
    });
  });

  test("a channel's creator still in it, or who manages channels, may move it", () => {
    const member = { role: "member" as const, permissions: ["read", "post"] };
    const manager = { role: "member" as const, permissions: ["read", "manage_channels"] };
    expect(movesChannel({ isMember: true, createdByUserId: "u1" }, "u1", member)).toBe(true);
    expect(movesChannel({ isMember: false, createdByUserId: "u1" }, "u1", member)).toBe(false);
    expect(movesChannel({ createdByUserId: "u2" }, "u1", member)).toBe(false);
    expect(movesChannel({ createdByUserId: "u2" }, "u1", manager)).toBe(true);
    expect(movesChannel({ createdByUserId: null }, null, member)).toBe(false);
    expect(movesChannel({ createdByUserId: "u2" }, "u1", undefined)).toBe(false);
  });

  test("the screens' addresses", () => {
    expect(categoryHrefs.pick("c 1")).toBe("/channel-category?channelId=c%201");
    expect(categoryHrefs.create()).toBe("/channel-category-new");
    expect(categoryHrefs.edit("x")).toBe("/channel-category-edit?id=x");
  });
});

describe("Nova categoria on the phone", () => {
  test("the category being made never reads as taken: the name is checked against the list from before Criar", () => {
    const screens = readFileSync(join(import.meta.dir, "../../src/features/categories/CategoryScreens.tsx"), "utf8");
    expect(screens).toMatch(
      /const taken = useHeldWhile\(\s*\(categories\.data \?\? \[\]\)\.some\([^;]*\),\s*create\.isPending \|\| create\.isSuccess,\s*\);/,
    );
  });
});
