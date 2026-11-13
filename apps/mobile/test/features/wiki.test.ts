import { describe, expect, test } from "bun:test";
import type { WikiPageSummary } from "@agenteschat/client";
import {
  continueReading,
  docBlocks,
  docRuns,
  foldersIn,
  isWikiSlug,
  parseRecents,
  RECENT_COUNT,
  searchWiki,
  suggestPages,
  wikiHome,
  wikiSlugOf,
  withoutTitleHeading,
  withRecent,
} from "../../src/features/wiki/logic";

const page = (title: string, over: Partial<WikiPageSummary> = {}): WikiPageSummary => ({
  id: title,
  slug: title.toLowerCase().replace(/\s+/g, "-"),
  title,
  folder: "",
  tags: [],
  updatedAt: "2026-10-01T10:00:00.000Z",
  updatedBy: { type: "person", id: "u1" },
  ...over,
});

describe("wiki home", () => {
  const pages = [
    page("Vendas", { folder: "Processos/Comercial" }),
    page("Glossário"),
    page("Deploy", { folder: "Engenharia", pinned: true }),
    page("Rituais", { folder: "Processos" }),
  ];

  test("pinned, the top folders with every page under them, then the pages at the root", () => {
    const home = wikiHome(pages);
    expect(home?.pinned.map((p) => p.title)).toEqual(["Deploy"]);
    expect(home?.folders).toEqual([
      { name: "Engenharia", path: "Engenharia", count: 1 },
      { name: "Processos", path: "Processos", count: 2 },
    ]);
    expect(home?.pages.map((p) => p.title)).toEqual(["Glossário"]);
  });

  test("a folder: its folders and its own pages, nothing pinned or recent", () => {
    const f = wikiHome(pages, "Processos");
    expect(f?.folders).toEqual([{ name: "Comercial", path: "Processos/Comercial", count: 1 }]);
    expect(f?.pages.map((p) => p.title)).toEqual(["Rituais"]);
    expect(f?.pinned).toEqual([]);
    expect(wikiHome(pages, "Sumiu")).toBeNull();
  });

  test("the latest edits only when the lists don't already show everything", () => {
    const few = Array.from({ length: RECENT_COUNT }, (_, i) => page(`P${i}`));
    expect(wikiHome(few)?.recent).toEqual([]);
    const many = Array.from({ length: RECENT_COUNT + 2 }, (_, i) =>
      page(`P${i}`, { updatedAt: `2026-10-0${i + 1}T10:00:00.000Z` }),
    );
    const recent = wikiHome(many)?.recent ?? [];
    expect(recent.length).toBe(RECENT_COUNT);
    expect(recent[0]?.title).toBe(`P${RECENT_COUNT + 1}`);
  });

  test("folders in use, for the shortcuts", () => {
    expect(foldersIn(pages)).toEqual(["Engenharia", "Processos", "Processos/Comercial"]);
  });
});

describe("wiki search", () => {
  const pages = [
    page("Como fazer deploy", { folder: "Engenharia" }),
    page("Onboarding", { excerpt: "Primeiro dia e o deploy de teste" }),
    page("Férias", { tags: ["rh"] }),
  ];

  test("every word, accents and case ignored; title hits first", () => {
    expect(searchWiki(pages, "DEPLOY").map((p) => p.title)).toEqual(["Como fazer deploy", "Onboarding"]);
    expect(searchWiki(pages, "ferias").map((p) => p.title)).toEqual(["Férias"]);
    expect(searchWiki(pages, "rh").map((p) => p.title)).toEqual(["Férias"]);
    expect(searchWiki(pages, "deploy engenharia").map((p) => p.title)).toEqual(["Como fazer deploy"]);
    expect(searchWiki(pages, "  ")).toEqual([]);
  });

  test("the editor's [[ suggestions: titles that start with it, then those that have it", () => {
    expect(suggestPages(pages, "o").map((p) => p.title)).toEqual(["Onboarding", "Como fazer deploy"]);
    expect(suggestPages(pages, "fer").map((p) => p.title)).toEqual(["Férias"]);
  });
});

describe("wiki text", () => {
  test("links apart from the words, with their labels; embeds as their names", () => {
    expect(docRuns("Veja [[Deploy]] e [[Processos/Vendas|vendas]].")).toEqual([
      { kind: "text", text: "Veja " },
      { kind: "link", title: "Deploy", label: "Deploy" },
      { kind: "text", text: " e " },
      { kind: "link", title: "Processos/Vendas", label: "vendas" },
      { kind: "text", text: "." },
    ]);
    expect(docRuns("Em [[Deploy#Passos]]")).toEqual([
      { kind: "text", text: "Em " },
      { kind: "link", title: "Deploy#Passos", label: "Deploy" },
    ]);
    expect(docRuns("![[diagrama.png]]")).toEqual([{ kind: "text", text: "_diagrama.png_" }]);
  });

  test("tables and rules are blocks of their own, also right under a sentence", () => {
    const blocks = docBlocks("Antes\n| PR | Estado |\n|---|---|\n| #75 | Aberto |\n\n---\n\nDepois");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "rule", "paragraph"]);
    expect(blocks[1]).toMatchObject({ header: ["PR", "Estado"], rows: [["#75", "Aberto"]] });
  });

  test("blocks, with each task's line in the text", () => {
    const blocks = docBlocks("Intro\n\n## Passos\n- [x] Abrir o PR\n- [ ] Aprovar\n- solto\n```\ncode\n```");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "heading", "task", "task", "bullet", "code"]);
    expect(blocks[2]).toMatchObject({ kind: "task", done: true, line: 3 });
    expect(blocks[3]).toMatchObject({ kind: "task", done: false, line: 4 });
    expect(blocks[5]).toEqual({ kind: "code", text: "code" });
  });

  test("slugs from the route", () => {
    expect(isWikiSlug("processos/onboarding")).toBe(true);
    expect(isWikiSlug("a b")).toBe(false);
    expect(wikiSlugOf("processos%2Fonboarding")).toBe("processos/onboarding");
    expect(wikiSlugOf("%E0")).toBeNull();
    expect(wikiSlugOf(undefined)).toBeNull();
  });
});

describe("Continuar lendo", () => {
  test("the last page opened goes first, once, per workspace, and only pages that still exist show", () => {
    let r = withRecent({}, "acme", "a");
    r = withRecent(r, "acme", "b");
    r = withRecent(r, "acme", "a");
    r = withRecent(r, "other", "z");
    expect(r).toEqual({ acme: ["a", "b"], other: ["z"] });
    const pages = [page("A", { slug: "a" }), page("B", { slug: "b" }), page("C", { slug: "c" })];
    expect(continueReading(pages, ["gone", "b", "a", "c"], 2).map((p) => p.slug)).toEqual(["b", "a"]);
  });

  test("what storage holds is read safely", () => {
    expect(parseRecents(null)).toEqual({});
    expect(parseRecents("not json")).toEqual({});
    expect(parseRecents("[1,2]")).toEqual({});
    expect(parseRecents('{"acme":["a",3,"b"],"x":"y"}')).toEqual({ acme: ["a", "b"], x: [] });
  });
});

describe("the title once", () => {
  test("the body's first heading goes when it is the title again, its line kept blank", () => {
    const body = "\n# Product Overview\n\nText\n- [ ] task";
    const out = withoutTitleHeading(body, "product overview");
    expect(out).toBe("\n\n\nText\n- [ ] task");
    expect(out.split("\n")).toHaveLength(body.split("\n").length);
  });

  test("a different first heading, or text first, stays", () => {
    expect(withoutTitleHeading("# Other\nText", "Product")).toBe("# Other\nText");
    expect(withoutTitleHeading("Intro\n# Product", "Product")).toBe("Intro\n# Product");
  });
});
