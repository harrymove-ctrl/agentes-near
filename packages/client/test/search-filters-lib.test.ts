import { describe, expect, test } from "bun:test";
import {
  chipFitsDm,
  DM_SEARCH_OPS,
  formatSearch,
  groupByChannel,
  groupHitsByPlace,
  inDmOnly,
  markTerms,
  parseSearch,
  periodOf,
  rememberSearch,
  type SearchDirectory,
  type SearchWords,
  searchFilterInput,
  searchSortFor,
  searchTerms,
  suggestActors,
  typingOperator,
} from "../src/lib/search-filters";

const dir: SearchDirectory = {
  actors: [
    { type: "person", id: "u1", name: "Lia Moreira", handle: "lia" },
    { type: "agent", id: "a1", name: "Dev", handle: "dev" },
  ],
  places: [
    { id: "c1", name: "geral" },
    { id: "c2", name: "Lia Moreira", dm: true },
  ],
};
const pt: SearchWords = {
  ops: {
    from: "de",
    mentions: "menciona",
    in: "em",
    has: "tem",
    before: "antes",
    after: "depois",
    during: "durante",
    pinned: "fixada",
    author: "autor",
  },
  has: { link: "link", file: "arquivo", image: "imagem", card: "cartão" },
  author: { person: "pessoa", agent: "agente" },
};

describe("search filters", () => {
  test("operators become chips; unknown values and plain words stay as text", () => {
    const { chips, text } = parseSearch(
      'deploy from:@dev in:geral has:file has:link mentions:"Lia Moreira" from:nobody pinned:true author:agent',
      dir,
    );
    expect(text).toBe("deploy from:nobody");
    expect(chips.map((c) => c.op)).toEqual(["from", "in", "has", "has", "mentions", "pinned", "author"]);
    expect(searchFilterInput(chips, "newest")).toEqual({
      fromAgents: ["a1"],
      in: ["c1"],
      has: ["file", "link"],
      mentionsUsers: ["u1"],
      pinned: true,
      author: "agent",
      sort: "newest",
    });
  });

  test("English works in every language; the person's language adds its own words, accents optional", () => {
    const { chips, text } = parseSearch("de:@lia tem:arquivo has:cartao em:#geral from:dev", dir, pt);
    expect(text).toBe("");
    expect(searchFilterInput(chips)).toEqual({
      fromUsers: ["u1"],
      fromAgents: ["a1"],
      has: ["file", "card"],
      in: ["c1"],
    });
    // Without the language, its words are text.
    expect(parseSearch("de:@lia", dir).text).toBe("de:@lia");
  });

  test("dates: before the day starts, after it ends, during the whole period; the last of each wins", () => {
    const local = (y: number, m: number, d: number) => new Date(y, m, d).toISOString();
    expect(searchFilterInput(parseSearch("before:2026-10-05 after:2026-09-30", dir).chips)).toEqual({
      before: local(2026, 9, 5),
      after: local(2026, 9, 1),
    });
    expect(searchFilterInput(parseSearch("during:2026-02", dir).chips)).toEqual({
      after: local(2026, 1, 1),
      before: local(2026, 2, 1),
    });
    expect(searchFilterInput(parseSearch("before:2025 before:2026-01-02", dir).chips)).toEqual({
      before: local(2026, 0, 2),
    });
    expect(periodOf("2026-02-30")).toBeNull();
    expect(periodOf("2026-13")).toBeNull();
    expect(parseSearch("before:tomorrow", dir).text).toBe("before:tomorrow");
  });

  test("written back with English operators, it reads the same", () => {
    const parsed = parseSearch("em:geral de:Dev tem:imagem durante:2026-10 fixada:sim mentions:@lia hello", dir, pt);
    const text = formatSearch(parsed.chips, parsed.text);
    expect(text).toBe("in:geral from:@dev has:image during:2026-10 pinned:true mentions:@lia hello");
    expect(parseSearch(text, dir)).toEqual(parsed);
    expect(formatSearch([{ op: "in", place: { id: "c2", name: "Lia Moreira" } }], "")).toBe('in:"Lia Moreira"');
  });

  test("the operator being typed opens its picker", () => {
    expect(typingOperator("deploy from:")).toEqual({ op: "from", value: "", start: 7 });
    expect(typingOperator("de:li", pt)).toEqual({ op: "from", value: "li", start: 0 });
    expect(typingOperator("deploy from:dev ")).toBeNull();
    expect(typingOperator("http:")).toBeNull();
    // The full-width colon CJK input methods type.
    expect(typingOperator("deploy from\uFF1Ali")).toEqual({ op: "from", value: "li", start: 7 });
    expect(searchFilterInput(parseSearch("de\uFF1A@lia", dir, pt).chips)).toEqual({ fromUsers: ["u1"] });
    expect(parseSearch("nota\uFF1Afim", dir, pt).text).toBe("nota\uFF1Afim");
    expect(suggestActors("mor", dir.actors).map((a) => a.id)).toEqual(["u1"]);
    expect(suggestActors("@d", dir.actors).map((a) => a.id)).toEqual(["a1"]);
  });

  test("unpicked, the sort is by relevance with words and newest first without", () => {
    expect(searchSortFor(null, "invoice")).toBe("relevance");
    expect(searchSortFor(null, "  ")).toBe("newest");
    expect(searchSortFor("oldest", "invoice")).toBe("oldest");
  });

  test("recent searches and channel groups", () => {
    expect(rememberSearch(["a", "b", "c"], "b", 3)).toEqual(["b", "a", "c"]);
    expect(rememberSearch(["a"], "  ")).toEqual(["a"]);
    expect(rememberSearch(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
    const hits = [{ channelIds: ["x"] }, { channelIds: ["y"] }, { channelIds: ["x"] }];
    expect(groupByChannel(hits).map(([id, list]) => [id, list.length])).toEqual([
      ["x", 2],
      ["y", 1],
    ]);
  });

  test("hits by place: a thread's replies under the thread, the rest under their channel", () => {
    const hits = [
      { channelIds: ["x"], messageId: "m1", threadId: null },
      { channelIds: ["x"], messageId: "m2", threadId: "r1", threadTitle: "Erro no convite" },
      { channelIds: ["y"], messageId: "m3", threadId: null },
      // The thread's root is in the channel's timeline.
      { channelIds: ["x"], messageId: "r1", threadId: "r1", threadTitle: "Erro no convite" },
      { channelIds: ["x"], messageId: "m4", threadId: "r1", threadTitle: "Erro no convite" },
    ];
    expect(groupHitsByPlace(hits).map((g) => [g.key, g.channelId, g.thread?.title ?? null, g.hits.length])).toEqual([
      ["x", "x", null, 2],
      ["thread:r1", "x", "Erro no convite", 2],
      ["y", "y", null, 1],
    ]);
  });

  test("markTerms: any case and accents, several words, overlaps merged, nothing found", () => {
    const marked = (text: string, terms: string[]) =>
      markTerms(text, terms)
        .map((s) => (s.mark ? `[${s.text}]` : s.text))
        .join("");
    expect(marked("O Convite chegou", ["convite"])).toBe("O [Convite] chegou");
    expect(marked("Ação e acao", ["acao"])).toBe("[Ação] e [acao]");
    expect(marked("deploy do convite", searchTerms('"convite"  deploy'))).toBe("[deploy] do [convite]");
    expect(marked("convites", ["convite", "vites"])).toBe("[convites]");
    expect(markTerms("nada aqui", ["zebra"])).toEqual([{ text: "nada aqui" }]);
    expect(markTerms("", ["x"])).toEqual([{ text: "" }]);
  });
});

describe("a search held to one DM", () => {
  const here = { id: "c2", name: "Lia Moreira", dm: true };
  const lia = { type: "person" as const, id: "u1", name: "Lia Moreira" };
  test("offers no who or where", () => {
    expect(DM_SEARCH_OPS).toEqual(["has", "before", "after", "during", "pinned"]);
  });
  test("its own in: chip first, the rest only what fits a DM", () => {
    const chips = inDmOnly(
      [
        { op: "has", value: "file" },
        { op: "in", place: { id: "c1", name: "geral" } },
        { op: "from", actor: lia },
        { op: "author", value: "agent" },
        { op: "after", value: "2026-10" },
      ],
      here,
    );
    expect(chips).toEqual([
      { op: "in", place: here },
      { op: "has", value: "file" },
      { op: "after", value: "2026-10" },
    ]);
    expect(inDmOnly(chips, here)).toEqual(chips);
    expect(chipFitsDm({ op: "in", place: here }, "c2")).toBe(true);
    expect(chipFitsDm({ op: "in", place: { id: "c1", name: "geral" } }, "c2")).toBe(false);
    expect(chipFitsDm({ op: "mentions", actor: lia }, "c2")).toBe(false);
  });
});
