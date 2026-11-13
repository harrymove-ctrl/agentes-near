import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  createWikiPage,
  ForbiddenError,
  getWikiPage,
  importWikiPages,
  listWikiPages,
  listWikiVersions,
  parseWikiLinks,
  plainExcerpt,
  recordWikiReads,
  setWikiPagePinned,
  topWikiReads,
  ValidationError,
  type WikiActor,
  wikiGraph,
} from "../src";
import { addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string): WikiActor => ({ type: "person", userId });
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const vault = { type: "obsidian" as const, name: "Acme Vault" };

describe("importing an Obsidian vault", () => {
  test("notes become pages with folders, tags, aliases and links among them", async () => {
    f = await setup();
    const me = person(f.owner.id);
    const result = await importWikiPages(deps(), f.owner.id, f.org.id, {
      source: vault,
      onConflict: "keep_both",
      notes: [
        {
          title: "Início",
          body: "Comece por [[Mercado Bom]] e [[Clientes/Casa Verde|a Casa Verde]]. Ver [[Home]].\n\n![[diagrama.png]]",
          tags: ["Mapa"],
          aliases: ["Home"],
          attachments: { "diagrama.png": "00000000-0000-4000-8000-000000000001" },
        },
        { title: "Mercado Bom", folder: "Clientes", body: "Volta para o [[Início]]." },
        { title: "Casa Verde", folder: "Clientes", body: "Usa a API." },
      ],
    });
    expect(result.created.map((p) => p.title)).toEqual(["Início", "Mercado Bom", "Casa Verde"]);
    expect(result.skipped).toEqual([]);

    const home = await getWikiPage(f.db, me, f.org.id, "inicio");
    expect(home.tags).toEqual(["mapa"]);
    expect(home.source).toEqual({
      type: "obsidian",
      id: "Acme Vault",
      attachments: { "diagrama.png": "00000000-0000-4000-8000-000000000001" },
    });
    expect(home.sourceType).toBe("obsidian");
    // Links written before their page existed resolve once it is imported; the embed is not a link.
    expect(home.links.map((l) => [l.slug, l.exists])).toEqual([
      ["mercado-bom", true],
      ["casa-verde", true],
      ["inicio", true],
    ]);
    // The alias reaches the page.
    expect((await getWikiPage(f.db, me, f.org.id, "home")).slug).toBe("inicio");
    expect(home.backlinks).toMatchObject([{ kind: "page", slug: "mercado-bom", title: "Mercado Bom" }]);
    expect((await getWikiPage(f.db, me, f.org.id, "mercado-bom")).folder).toBe("Clientes");

    const [v1] = await listWikiVersions(f.db, me, f.org.id, "inicio");
    expect(v1).toMatchObject({ version: 1, noteCode: "imported", noteParams: { source: "Acme Vault" } });
    const graph = await wikiGraph(f.db, me, f.org.id);
    expect(graph.edges).toContainEqual({ from: "inicio", to: "mercado-bom" });
    expect(graph.edges).toContainEqual({ from: "mercado-bom", to: "inicio" });
  });

  test("a note named like an existing page: a second page, or left out", async () => {
    f = await setup();
    await createWikiPage(deps(), person(f.owner.id), f.org.id, { title: "Glossário", body: "Nosso." });
    const both = await importWikiPages(deps(), f.owner.id, f.org.id, {
      source: vault,
      onConflict: "keep_both",
      notes: [{ title: "Glossário", body: "Da vault." }],
    });
    expect(both.created.map((p) => p.title)).toEqual(["Glossário (Acme Vault)"]);
    const skip = await importWikiPages(deps(), f.owner.id, f.org.id, {
      source: vault,
      onConflict: "skip",
      notes: [
        { title: "Glossário", body: "De novo." },
        { title: "Novo", body: "Entra." },
      ],
    });
    expect(skip.skipped).toEqual(["Glossário"]);
    expect(skip.created.map((p) => p.title)).toEqual(["Novo"]);
  });

  test("a folder for the whole vault; odd titles and long notes", async () => {
    f = await setup();
    const result = await importWikiPages(deps(), f.owner.id, f.org.id, {
      source: vault,
      onConflict: "keep_both",
      folder: "Obsidian",
      notes: [
        { title: "Notas #1 [rascunho]", folder: "Pesquisa", body: "ok" },
        { title: "###", body: "sem nome" },
        { title: "Enorme", body: "x".repeat(200_001) },
      ],
    });
    expect(result.created).toMatchObject([{ title: "Notas 1 rascunho", folder: "Obsidian/Pesquisa" }]);
    expect(result.failed).toEqual([
      { title: "###", reason: "title" },
      { title: "Enorme", reason: "too_long" },
    ]);
  });

  test("only members; at most 500 notes per call", async () => {
    f = await setup();
    const outsider = await addUser(f.db, "fora");
    await expect(
      importWikiPages(deps(), outsider.id, f.org.id, { source: vault, onConflict: "skip", notes: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      importWikiPages(deps(), f.owner.id, f.org.id, {
        source: vault,
        onConflict: "skip",
        notes: Array.from({ length: 501 }, (_, i) => ({ title: `N${i}`, body: "" })),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("pins, excerpts and what the agents read", () => {
  test("pinning and the excerpt in summaries", async () => {
    f = await setup();
    const me = person(f.owner.id);
    await createWikiPage(deps(), me, f.org.id, {
      title: "Deploy",
      body: "# Deploy\n\n> [!warning] Atenção\n> Só às **terças**, ver [[Guia|o guia]].\n\n- [ ] CI verde",
    });
    expect((await setWikiPagePinned(deps(), f.owner.id, f.org.id, "deploy", true)).pinned).toBe(true);
    const [page] = await listWikiPages(f.db, me, f.org.id);
    expect(page).toMatchObject({ pinned: true, excerpt: "Atenção Só às terças, ver o guia. CI verde" });
    const outsider = await addUser(f.db, "fora");
    await expect(setWikiPagePinned(deps(), outsider.id, f.org.id, "deploy", false)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("plainExcerpt cuts on a word", () => {
    expect(plainExcerpt("uma frase bem longa aqui", "", 12)).toBe("uma frase…");
    expect(plainExcerpt("---\ntags: [a]\n---\n# Título\nTexto", "Título")).toBe("Texto");
  });

  test("reads count per page and per agent, with the last public channel", async () => {
    f = await setup();
    const me = person(f.owner.id);
    const a = await createWikiPage(deps(), me, f.org.id, { title: "Arquitetura" });
    const b = await createWikiPage(deps(), me, f.org.id, { title: "FAQ" });
    for (let i = 0; i < 3; i++) {
      await recordWikiReads(f.db, { orgId: f.org.id, agentId: f.agent.id, channelId: f.general.id, pageIds: [a.id] });
    }
    await recordWikiReads(f.db, { orgId: f.org.id, agentId: f.agent.id, pageIds: [b.id, b.id] });
    const page = await getWikiPage(f.db, me, f.org.id, "arquitetura");
    expect(page.reads).toMatchObject({
      total: 3,
      agents: [{ agentId: f.agent.id, count: 3 }],
      last: { agentId: f.agent.id },
    });
    expect(await topWikiReads(f.db, me, f.org.id)).toMatchObject([
      { slug: "arquitetura", total: 3 },
      { slug: "faq", total: 1 },
    ]);
    // Older than the window: not counted.
    await f.db.update(schema.wikiPageReads).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) });
    expect((await getWikiPage(f.db, me, f.org.id, "faq")).reads).toEqual({ total: 0, agents: [], last: null });
  });

  test("an embed is not a link", () => {
    expect(parseWikiLinks("![[foto.png]] e [[Página]]").map((r) => r.slug)).toEqual(["pagina"]);
  });
});
