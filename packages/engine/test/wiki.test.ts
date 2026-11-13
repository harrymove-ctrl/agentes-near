import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  appendSourceToWiki,
  appendToSection,
  ConflictError,
  createIssue,
  createOrganization,
  createPageFromSource,
  createWikiPage,
  createWikiToolSource,
  DEFAULT_AGENT_SCOPES,
  deleteWikiPage,
  diffWikiVersions,
  drainOutbox,
  ForbiddenError,
  getWikiPage,
  insertMessage,
  listMessages,
  listWikiVersions,
  NotFoundError,
  openDm,
  parseWikiLinks,
  postPersonMessage,
  renameWikiPage,
  replaceSection,
  resolveWikiTargets,
  restoreWikiPage,
  searchForUser,
  searchVisible,
  setAgentScopes,
  setWikiPageLock,
  suggestWikiPages,
  type ToolContext,
  updateWikiPage,
  WIKI_WRITE_REFUSAL,
  type WikiActor,
  WikiVersionConflictError,
  wikiGraph,
  wikiSlug,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string): WikiActor => ({ type: "person", userId });
const wikiDeps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context, artifacts: f.artifactDeps });

describe("links", () => {
  test("parsing: titles, folders, labels, sections; code is skipped", () => {
    const refs = parseWikiLinks(
      "Veja [[Guia de Deploy]], [[Processos/Onboarding|o onboarding]] e [[Guia de Deploy#Rollback]].\n`[[não]]`\n```\n[[também não]]\n```",
    );
    expect(refs).toEqual([
      {
        target: "Guia de Deploy",
        title: "Guia de Deploy",
        section: null,
        label: "Guia de Deploy",
        slug: "guia-de-deploy",
      },
      {
        target: "Processos/Onboarding",
        title: "Processos/Onboarding",
        section: null,
        label: "o onboarding",
        slug: "onboarding",
      },
      {
        target: "Guia de Deploy#Rollback",
        title: "Guia de Deploy",
        section: "Rollback",
        label: "Guia de Deploy",
        slug: "guia-de-deploy",
      },
    ]);
    expect(wikiSlug("Ação & Reação")).toBe("acao-reacao");
  });

  test("a title keeps its slashes when its folder comes apart; a mention in a DM says who it is with", async () => {
    f = await setup();
    const deps = wikiDeps();
    const me = person(f.owner.id);
    // An agent wrote the folder apart and dates in the title: the title stays whole (a "/" would name a folder).
    const page = await createWikiPage(deps, me, f.org.id, {
      title: "Changelog (30/out e 1/nov)",
      folder: "Engenharia",
      body: "O que mudou.",
    });
    expect(page).toMatchObject({ title: "Changelog (30\u2215out e 1\u2215nov)", folder: "Engenharia" });
    const renamed = await renameWikiPage(deps, me, f.org.id, page.slug, { title: "Mudanças de 1/nov" });
    expect(renamed).toMatchObject({ title: "Mudanças de 1\u2215nov", folder: "Engenharia" });

    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    if (!dm) throw new Error("no DM");
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: `Atualiza a [[${renamed.title}]], por favor`,
    });
    const read = await getWikiPage(f.db, me, f.org.id, renamed.slug);
    expect(read.backlinks).toMatchObject([
      { kind: "message", channelId: dm.id, dm: { type: "agent", id: f.agent.id } },
    ]);
  });

  test("backlinks from pages, messages and issues; unresolved links resolve when the page appears", async () => {
    f = await setup();
    const deps = wikiDeps();
    const me = person(f.owner.id);
    const runbook = await createWikiPage(deps, me, f.org.id, {
      title: "Runbook",
      body: "Antes, leia [[Guia de Deploy#Rollback|o rollback]].",
    });
    expect(runbook.links).toEqual([
      { target: "Guia de Deploy#Rollback", slug: "guia-de-deploy", title: null, exists: false },
    ]);
    expect((await wikiGraph(f.db, me, f.org.id)).unresolved).toEqual([{ from: "runbook", toSlug: "guia-de-deploy" }]);

    const posted = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "Segue o [[Guia de Deploy]] e o [[Inexistente]]",
    });
    expect(posted.meta.wikiLinks).toEqual([
      {
        target: "Guia de Deploy",
        label: "Guia de Deploy",
        section: null,
        slug: "guia-de-deploy",
        title: null,
        exists: false,
      },
      { target: "Inexistente", label: "Inexistente", section: null, slug: "inexistente", title: null, exists: false },
    ]);
    await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Automatizar deploy",
      description: "Base: [[Guia de Deploy]]",
    });

    const guide = await createWikiPage(deps, me, f.org.id, {
      title: "Processos/Guia de Deploy",
      body: "## Rollback\nVolte.",
    });
    expect(guide).toMatchObject({ slug: "guia-de-deploy", title: "Guia de Deploy", folder: "Processos", version: 1 });
    const page = await getWikiPage(f.db, me, f.org.id, "guia-de-deploy");
    expect(page.backlinks).toEqual(
      expect.arrayContaining([
        {
          kind: "page",
          slug: "runbook",
          title: "Runbook",
          excerpt: "Antes, leia o rollback.",
        },
        expect.objectContaining({
          kind: "message",
          channelId: f.general.id,
          messageId: posted.id,
          channelName: "general",
        }),
        { kind: "issue", number: 1, title: "Automatizar deploy" },
      ]),
    );
    expect(page.backlinks).toHaveLength(3);
    // Messages are resolved when read: the page exists now.
    const listed = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === posted.id);
    const resolvedLinks = (listed?.meta.wikiLinks ?? []) as { slug: string; exists: boolean; title: string | null }[];
    expect(resolvedLinks[0]).toMatchObject({
      slug: "guia-de-deploy",
      title: "Guia de Deploy",
      exists: true,
    });
    expect(await wikiGraph(f.db, me, f.org.id)).toMatchObject({
      edges: [{ from: "runbook", to: "guia-de-deploy" }],
      unresolved: [],
    });
    expect((await suggestWikiPages(f.db, me, f.org.id, "gui")).map((p) => p.slug)).toEqual(["guia-de-deploy"]);
  });

  test("rename: other pages' links are rewritten, old links still resolve", async () => {
    f = await setup();
    const deps = wikiDeps();
    const me = person(f.owner.id);
    await createWikiPage(deps, me, f.org.id, { title: "Deploy", body: "## Rollback\nx" });
    await createWikiPage(deps, me, f.org.id, {
      title: "Runbook",
      body: "Veja [[Deploy#Rollback|como voltar]] e [[Processos/Deploy]]. `[[Deploy]]` fica.",
    });
    const renamed = await renameWikiPage(deps, me, f.org.id, "deploy", { title: "Publicação" });
    expect(renamed).toMatchObject({ slug: "publicacao", title: "Publicação", version: 2 });
    const runbook = await getWikiPage(f.db, me, f.org.id, "runbook");
    expect(runbook.body).toBe(
      "Veja [[Publicação#Rollback|como voltar]] e [[Processos/Publicação]]. `[[Deploy]]` fica.",
    );
    expect(runbook.version).toBe(2);
    expect((await listWikiVersions(f.db, me, f.org.id, "runbook"))[0]?.note).toContain("link updated");
    // The old slug finds the page; old `[[Deploy]]` in messages still resolve to it.
    expect((await getWikiPage(f.db, me, f.org.id, "deploy")).slug).toBe("publicacao");
    const [link] = await resolveWikiTargets(f.db, f.org.id, parseWikiLinks("[[Deploy]]"));
    expect(link).toMatchObject({ slug: "publicacao", title: "Publicação", exists: true });
    expect(renamed.backlinks).toMatchObject([{ kind: "page", slug: "runbook", title: "Runbook" }]);
  });
});

describe("pages", () => {
  test("versions: stale edits conflict; history, diff, duplicate names, sections", async () => {
    f = await setup();
    const deps = wikiDeps();
    const me = person(f.owner.id);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await createWikiPage(deps, me, f.org.id, { title: "FAQ", body: "linha 1\nlinha 2", tags: ["#Suporte"] });
    const v2 = await updateWikiPage(deps, person(bia.id), f.org.id, "faq", {
      baseVersion: 1,
      body: "linha 1\nlinha 2\nlinha 3",
      note: "acrescentei a 3",
    });
    expect(v2).toMatchObject({ version: 2, tags: ["suporte"], updatedBy: { type: "person", id: bia.id } });
    const stale = updateWikiPage(deps, me, f.org.id, "faq", { baseVersion: 1, body: "outra coisa" });
    await expect(stale).rejects.toBeInstanceOf(WikiVersionConflictError);
    await expect(stale).rejects.toMatchObject({ code: "version_conflict", currentVersion: 2 });

    const history = await listWikiVersions(f.db, me, f.org.id, "faq");
    expect(history.map((v) => [v.version, v.author.id, v.note])).toEqual([
      [2, bia.id, "acrescentei a 3"],
      [1, f.owner.id, "created the page"],
    ]);
    // A note the server wrote carries its code (the app translates it); a person's own note doesn't.
    expect(history.map((v) => v.noteCode ?? null)).toEqual([null, "created"]);
    const diff = await diffWikiVersions(f.db, me, f.org.id, "faq", 1, 2);
    expect(diff).toMatchObject({ added: 1, removed: 0 });
    expect(diff.patch).toContain("+linha 3");

    await expect(createWikiPage(deps, me, f.org.id, { title: "faq" })).rejects.toMatchObject({ code: "slug_taken" });
    await expect(createWikiPage(deps, me, f.org.id, { title: "faq" })).rejects.toBeInstanceOf(ConflictError);

    expect(appendToSection("# A\nx\n## B\ny\n# C\nz", "novo", "B")).toBe("# A\nx\n## B\ny\n\nnovo\n\n# C\nz");
    expect(replaceSection("# A\nx\n## B\ny\n# C\nz", "B", "trocado")).toBe("# A\nx\n## B\ntrocado\n\n# C\nz");
    expect(appendToSection("texto", "mais", "Veja também")).toBe("texto\n\n## Veja também\n\nmais\n");
  });

  test("lock (admins), delete and restore, audit, events", async () => {
    f = await setup();
    const deps = wikiDeps();
    const me = person(f.owner.id);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const events: { type: string; event?: { type: string; action?: string } }[] = [];
    f.pubsub.subscribe(`org:${f.org.id}`, (e) => events.push(e as (typeof events)[number]));
    await createWikiPage(deps, me, f.org.id, { title: "Política", body: "regras" });
    await createWikiPage(deps, me, f.org.id, { title: "Índice", body: "[[Política]]" });

    await expect(setWikiPageLock(deps, bia.id, f.org.id, "politica", true)).rejects.toBeInstanceOf(ForbiddenError);
    await setWikiPageLock(deps, f.owner.id, f.org.id, "politica", true);
    await expect(
      updateWikiPage(deps, person(bia.id), f.org.id, "politica", { baseVersion: 1, body: "mudei" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const agentActor: WikiActor = { type: "agent", agentId: f.agent.id, requestedByUserId: f.owner.id };
    await expect(
      updateWikiPage(deps, agentActor, f.org.id, "politica", { baseVersion: 1, body: "mudei" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await updateWikiPage(deps, me, f.org.id, "politica", { baseVersion: 1, body: "admin muda" })).version).toBe(
      2,
    );

    await deleteWikiPage(deps, me, f.org.id, "politica");
    await expect(getWikiPage(f.db, me, f.org.id, "politica")).rejects.toBeInstanceOf(NotFoundError);
    expect((await getWikiPage(f.db, me, f.org.id, "indice")).links[0]).toMatchObject({ exists: false });
    const restored = await restoreWikiPage(deps, me, f.org.id, "politica");
    expect(restored.backlinks).toMatchObject([{ kind: "page", slug: "indice", title: "Índice" }]);

    const actions = (await f.db.select().from(schema.auditLog))
      .map((a) => a.action)
      .filter((a) => a.startsWith("wiki."));
    expect(actions).toEqual(
      expect.arrayContaining([
        "wiki.page_created",
        "wiki.page_locked",
        "wiki.page_updated",
        "wiki.page_deleted",
        "wiki.page_restored",
      ]),
    );
    expect(events.filter((e) => e.event?.type === "wiki.page.updated").map((e) => e.event?.action)).toEqual(
      expect.arrayContaining(["created", "locked", "updated", "deleted", "restored"]),
    );
  });

  test('"Salvar na wiki" from a message: new page or appended, with the source', async () => {
    f = await setup();
    const deps = wikiDeps();
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "Decidimos usar Postgres como fila.",
    });
    const source = { kind: "message" as const, channelId: f.general.id, messageId: msg.id };
    const page = await createPageFromSource(deps, f.owner.id, f.org.id, { source, title: "Decisões" });
    expect(page.body).toContain("Decidimos usar Postgres como fila.");
    expect(page.body).toContain("in #general");
    expect(page.source).toEqual({ type: "message", id: msg.id, channelId: f.general.id });
    const appended = await appendSourceToWiki(deps, f.owner.id, f.org.id, "decisoes", { source, section: "Fila" });
    expect(appended.version).toBe(2);
    expect(appended.body).toContain("## Fila");
    // Someone outside the channel can't save it.
    const zed = await addUser(f.db, "zed");
    await expect(createPageFromSource(deps, zed.id, f.org.id, { source })).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("search includes the wiki", async () => {
    f = await setup();
    await createWikiPage(wikiDeps(), person(f.owner.id), f.org.id, {
      title: "Férias",
      body: "Pedidos de férias vão para o RH com 30 dias de antecedência.",
    });
    await drainOutbox(f.db, f.handlers);
    const hits = await searchVisible(f.context, {
      orgId: f.org.id,
      text: "férias antecedência",
      visibleChannelIds: [],
      kinds: ["wiki"],
    });
    expect(hits.map((h) => [h.kind, h.title])).toEqual([["wiki", "Férias"]]);
    const mine = await searchForUser(f.context, f.owner.id, f.org.id, { text: "antecedência" });
    expect(mine.some((h) => h.kind === "wiki")).toBe(true);
  });

  test("organizations are isolated", async () => {
    f = await setup();
    const deps = wikiDeps();
    const zed = await addUser(f.db, "zed");
    const { organization: other } = await createOrganization(f.db, zed.id, { name: "Outra" });
    const mine = await createWikiPage(deps, person(f.owner.id), f.org.id, { title: "Segredo", body: "senha do cofre" });
    await expect(getWikiPage(f.db, person(zed.id), f.org.id, "segredo")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getWikiPage(f.db, person(zed.id), other.id, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createWikiPage(deps, person(zed.id), f.org.id, { title: "Intruso" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Same slug in the other org is fine, and links never cross organizations.
    await createWikiPage(deps, person(zed.id), other.id, { title: "Segredo", body: "outro" });
    await createWikiPage(deps, person(zed.id), other.id, { title: "Índice", body: "[[Segredo]]" });
    const index = await getWikiPage(f.db, person(zed.id), other.id, "indice");
    expect(index.links[0]?.exists).toBe(true);
    const theirs = await getWikiPage(f.db, person(zed.id), other.id, "segredo");
    expect(theirs.id).not.toBe(mine.id);
    expect((await getWikiPage(f.db, person(f.owner.id), f.org.id, "segredo")).backlinks).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    const hits = await searchVisible(f.context, {
      orgId: other.id,
      text: "cofre",
      visibleChannelIds: [],
      kinds: ["wiki"],
    });
    expect(hits).toEqual([]);
  });
});

describe("agents", () => {
  test("reads by default; writes only when a person asks, as 'by Dev, at ana's request'", async () => {
    let step = 0;
    f = await setup({
      wikiTools: true,
      reply: (req: ModelRequest) => {
        step++;
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (step === 1 && last.includes("salva na wiki")) {
          return {
            chunks: [],
            toolUses: [
              {
                name: "create_wiki_page",
                input: { title: "Deploy", body: "1. Rode os testes.\n2. Publique.", folder: "Engenharia" },
              },
            ],
          };
        }
        return { chunks: ["Feito: [[Deploy]]."] };
      },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev salva na wiki como fazemos deploy: testes e depois publicar",
    });
    await drainOutbox(f.db, f.handlers);

    const first = f.provider.calls[0]?.request;
    const names = (first?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_wiki", "read_wiki_page", "create_wiki_page"]));
    expect(systemText(first?.system ?? "")).toContain("Only write to the wiki");

    const page = await getWikiPage(f.db, person(f.owner.id), f.org.id, "deploy");
    expect(page).toMatchObject({
      folder: "Engenharia",
      createdBy: { type: "agent", id: f.agent.id, onBehalfOf: f.owner.id },
    });
    const [v1] = await listWikiVersions(f.db, person(f.owner.id), f.org.id, "deploy");
    expect(v1?.note).toBe("by Dev, at ana's request: created the page");
    expect(v1).toMatchObject({ noteCode: "created", noteParams: {} });
    expect(v1?.author).toEqual({ type: "agent", id: f.agent.id, onBehalfOf: f.owner.id });

    // A later question pulls the page into the prompt as a trusted source.
    const before = f.provider.calls.length;
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev como fazemos o deploy? publique os testes",
    });
    await drainOutbox(f.db, f.handlers);
    const later = systemText(f.provider.calls[before]?.request.system ?? "");
    expect(later).toContain("Organization wiki (trusted source)");
    expect(later).toContain("Rode os testes");
  });

  test("no request, no write: agents' own messages are refused; the scope can be turned off", async () => {
    f = await setup({ wikiTools: true });
    const source = createWikiToolSource({ pubsub: f.pubsub, search: f.context });
    const tools = await source.tools({} as ToolContext);
    const create = tools.find((t) => t.name === "create_wiki_page");
    if (!create) throw new Error("create_wiki_page missing");
    const ctx = (triggerMessageId: string): ToolContext => ({
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: triggerMessageId,
      triggerMessageId,
    });
    const own = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Vou documentar isso.",
    });
    expect(await create.execute({ title: "Nota", body: "x" }, ctx(own.id))).toEqual({
      content: WIKI_WRITE_REFUSAL,
      isError: true,
    });
    expect(await f.db.select().from(schema.wikiPages)).toEqual([]);

    // Without wiki:write the write tools are gone; reading stays.
    expect(DEFAULT_AGENT_SCOPES).toEqual(expect.arrayContaining(["wiki:read", "wiki:write"]));
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      DEFAULT_AGENT_SCOPES.filter((s) => s !== "wiki:write").map((scope) => ({ connectionId: null, scope })),
    );
    const listed = (await f.tools?.list(ctx(own.id)))?.map((t) => t.name) ?? [];
    expect(listed).toEqual(expect.arrayContaining(["search_wiki", "read_wiki_page"]));
    expect(listed).not.toContain("create_wiki_page");
    expect(listed).not.toContain("update_wiki_page");
  });

  test("channel membership is not needed to read the wiki; it is org-wide", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await createWikiPage(wikiDeps(), person(f.owner.id), f.org.id, { title: "Geral", body: "para todos" });
    expect((await getWikiPage(f.db, person(bia.id), f.org.id, "geral")).body).toBe("para todos");
  });
});
