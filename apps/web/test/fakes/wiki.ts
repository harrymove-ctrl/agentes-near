/**
 * Test fake — the org wiki (expected shapes; the backend will match):
 * `GET …/wiki/pages`, `GET/PUT …/wiki/pages/{slug}`, `POST …/wiki/pages`,
 * `…/rename`, `…/history`, `…/versions/{n}`, `…/append`, `GET …/wiki/graph`,
 * `GET …/wiki/search?q=`. A stale `baseVersion` → 409 `version_conflict`.
 */
import type { ApiClient, WikiAuthor, WikiBacklink, WikiPage, WikiPageSummary, WikiVersion } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { resolveWikiLink, wikiLinksIn, wikiSlug } from "@agenteschat/client/lib/wiki";
import { clone, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

interface Stored {
  page: Omit<WikiPage, "backlinks">;
  versions: (WikiVersion & { body: string })[];
  /** Mentions outside the wiki (messages, issues). */
  outside: WikiBacklink[];
}

export function createFakeWiki(ctx: MockContext, log: (method: string, ...args: unknown[]) => void): ApiClient["wiki"] {
  const trashed = perOrg(async (): Promise<Stored[]> => []);
  const store = perOrg(async (orgId) => {
    const list: Stored[] = [];
    if (!ctx.seed) return list;
    const me = await ctx.lookup.me();
    const agents = await ctx.lookup.agents(orgId);
    const channels = await ctx.lookup.channels(orgId);
    const now = ctx.now();
    const person: WikiAuthor = { type: "person", id: me?.user.id ?? "me" };
    const agent: WikiAuthor = agents[0] ? { type: "agent", id: agents[0].id, onBehalfOf: me?.user.id ?? null } : person;
    const add = (title: string, folder: string, tags: string[], body: string, by: WikiAuthor, age: number) => {
      const at = minutesAgo(now, age);
      list.push({
        page: {
          id: mockId("wiki"),
          slug: wikiSlug(title),
          title,
          folder,
          tags,
          body,
          version: 1,
          createdAt: at,
          createdBy: by,
          updatedAt: at,
          updatedBy: by,
          authors: [by],
        },
        versions: [{ version: 1, at, author: by, note: null, body }],
        outside: [],
      });
    };
    add(
      "Visão geral",
      "",
      ["início"],
      "# Visão geral\n\nComo a Acme trabalha. Comece por [[Onboarding]] e veja o [[Glossário]].\n\n> [!tip] Dica\n\n## Times\n\n- [x] Produto\n- [ ] Suporte",
      person,
      600,
    );
    add(
      "Onboarding",
      "Processos",
      ["processo", "pessoas"],
      "# Onboarding\n\nPassos da primeira semana. Termos em [[Glossário]]; o deploy em [[Deploy]] e o [[Plano de férias]].\n\n## Acessos\n\nPeça ao admin.\n\n## Primeira tarefa\n\nUma issue pequena.",
      agent,
      300,
    );
    add(
      "Deploy",
      "Processos",
      ["processo", "eng"],
      "# Deploy\n\nSó de segunda a quinta. Volta para [[Onboarding]].",
      person,
      200,
    );
    add(
      "Glossário",
      "",
      ["referência"],
      "# Glossário\n\n**PR**: pull request.\n\n**Rotina**: tarefa agendada.",
      agent,
      100,
    );
    const onboarding = list.find((s) => s.page.title === "Onboarding");
    if (onboarding && channels[0]) {
      onboarding.outside.push({
        kind: "message",
        channelId: channels[0].id,
        messageId: "m-1",
        channelName: channels[0].name,
        excerpt: "Leiam o [[Onboarding]] antes de segunda.",
        at: minutesAgo(now, 50),
      });
      onboarding.outside.push({ kind: "issue", number: 131, title: "Atualizar o [[Onboarding]] com o PC dos agentes" });
      // A DM's name is an internal key: the page says who the conversation is with.
      if (agents[0])
        onboarding.outside.push({
          kind: "message",
          channelId: channels[0].id,
          messageId: "m-2",
          channelName: "dm-7f3a9c2e41b8d06a5c11",
          dm: { type: "agent", id: agents[0].id },
          excerpt: "Atualiza o [[Onboarding]] com o novo acesso.",
          at: minutesAgo(now, 40),
        });
    }
    return list;
  });
  const find = async (orgId: string, slug: string) => {
    const s = (await store(orgId)).find((x) => x.page.slug === slug);
    if (!s) throw new MockNotFoundError("Página não encontrada.");
    return s;
  };
  const summary = (s: Stored) => {
    const { body: _b, version: _v, createdAt: _c, createdBy: _cb, authors: _a, ...rest } = s.page;
    return clone(rest);
  };
  const withBacklinks = async (orgId: string, s: Stored): Promise<WikiPage> => {
    const all = await store(orgId);
    const pages = all.map((x) => x.page);
    const fromPages: WikiBacklink[] = all
      .filter((x) => x !== s && wikiLinksIn(x.page.body).some((t) => resolveWikiLink(pages, t)?.slug === s.page.slug))
      .map((x) => ({ kind: "page", slug: x.page.slug, title: x.page.title }));
    return clone({
      ...s.page,
      backlinks: [...fromPages, ...s.outside],
      reads: s.page.reads ?? { total: 0, agents: [], last: null },
    });
  };
  const me = async (): Promise<WikiAuthor> => ({ type: "person", id: (await ctx.lookup.me())?.user.id ?? "me" });
  return {
    tree: async (orgId) => (await store(orgId)).map(summary),
    get: async (orgId, slug) => withBacklinks(orgId, await find(orgId, slug)),
    search: async (orgId, q) => {
      const query = q.trim().toLowerCase();
      return (await store(orgId))
        .filter((s) => s.page.title.toLowerCase().includes(query))
        .sort(
          (a, b) =>
            Number(!a.page.title.toLowerCase().startsWith(query)) -
            Number(!b.page.title.toLowerCase().startsWith(query)),
        )
        .map(summary);
    },
    create: async (orgId, input) => {
      log("wiki.create", orgId, input);
      const list = await store(orgId);
      const folder = input.folder ?? "";
      const slug = wikiSlug(input.title);
      if (list.some((s) => s.page.slug === slug))
        throw new ApiError(409, "slug_taken", "Já existe uma página com esse nome.");
      const by = await me();
      const at = ctx.now().toISOString();
      const s: Stored = {
        page: {
          id: mockId("wiki"),
          slug,
          title: input.title,
          folder,
          tags: input.tags ?? [],
          body: input.body,
          version: 1,
          createdAt: at,
          createdBy: by,
          updatedAt: at,
          updatedBy: by,
          authors: [by],
        },
        versions: [{ version: 1, at, author: by, note: null, body: input.body }],
        outside: [],
      };
      list.push(s);
      return withBacklinks(orgId, s);
    },
    update: async (orgId, slug, input) => {
      log("wiki.update", orgId, slug, input);
      const s = await find(orgId, slug);
      if (input.baseVersion !== s.page.version) {
        throw new ApiError(409, "version_conflict", "Alguém editou esta página enquanto você escrevia.");
      }
      const by = await me();
      const at = ctx.now().toISOString();
      s.page = {
        ...s.page,
        body: input.body,
        title: input.title ?? s.page.title,
        folder: input.folder ?? s.page.folder,
        tags: input.tags ?? s.page.tags,
        version: s.page.version + 1,
        updatedAt: at,
        updatedBy: by,
        authors: [by, ...s.page.authors.filter((a) => !(a.type === by.type && a.id === by.id))],
      };
      s.versions.push({ version: s.page.version, at, author: by, note: input.note ?? null, body: input.body });
      return withBacklinks(orgId, s);
    },
    rename: async (orgId, slug, title) => {
      log("wiki.rename", orgId, slug, title);
      const s = await find(orgId, slug);
      s.page = { ...s.page, title, slug: wikiSlug(title) };
      return withBacklinks(orgId, s);
    },
    history: async (orgId, slug) =>
      [...(await find(orgId, slug)).versions].reverse().map(({ body: _b, ...v }) => clone(v)),
    version: async (orgId, slug, version) => {
      const v = (await find(orgId, slug)).versions.find((x) => x.version === version);
      if (!v) throw new MockNotFoundError("Versão não encontrada.");
      return { version, body: v.body };
    },
    graph: async (orgId) => {
      const all = await store(orgId);
      const pages = all.map((x) => x.page);
      return {
        nodes: pages.map((p) => ({
          slug: p.slug,
          title: p.title,
          folder: p.folder,
          tags: p.tags,
          agentId: p.createdBy.type === "agent" ? p.createdBy.id : null,
        })),
        edges: all.flatMap((x) =>
          wikiLinksIn(x.page.body)
            .map((t) => resolveWikiLink(pages, t))
            .filter((p): p is (typeof pages)[number] => Boolean(p))
            .map((p) => ({ from: x.page.slug, to: p.slug })),
        ),
      };
    },
    move: async (orgId, slug, folder) => {
      log("wiki.move", orgId, slug, folder);
      const s = await find(orgId, slug);
      s.page = { ...s.page, folder };
      return withBacklinks(orgId, s);
    },
    lock: async (orgId, slug, locked) => {
      log("wiki.lock", orgId, slug, locked);
      const s = await find(orgId, slug);
      s.page = { ...s.page, locked };
      return withBacklinks(orgId, s);
    },
    pin: async (orgId, slug, pinned) => {
      log("wiki.pin", orgId, slug, pinned);
      const s = await find(orgId, slug);
      s.page = { ...s.page, pinned };
      return withBacklinks(orgId, s);
    },
    audience: async (orgId, slug, access) => {
      log("wiki.audience", orgId, slug, access);
      const s = await find(orgId, slug);
      s.page = { ...s.page, ...access };
      return withBacklinks(orgId, s);
    },
    folderAudience: async (orgId, folder) => {
      log("wiki.folderAudience", orgId, folder);
      return { own: null, above: null };
    },
    setFolderAudience: async (orgId, folder, access) => {
      log("wiki.setFolderAudience", orgId, folder, access);
      return { folder, pages: 0 };
    },
    remove: async (orgId, slug) => {
      log("wiki.remove", orgId, slug);
      const list = await store(orgId);
      const at = list.findIndex((x) => x.page.slug === slug);
      const [gone] = at >= 0 ? list.splice(at, 1) : [];
      if (gone) (await trashed(orgId)).unshift({ ...gone, page: { ...gone.page, deletedAt: ctx.now().toISOString() } });
    },
    removeMany: async (orgId, target) => {
      log("wiki.removeMany", orgId, target);
      const list = await store(orgId);
      const hit = (p: Stored["page"]) =>
        "ids" in target
          ? target.ids.includes(p.id)
          : "folder" in target
            ? p.folder === target.folder || p.folder.startsWith(`${target.folder}/`)
            : "importId" in target
              ? p.importId === target.importId
              : p.sourceName === target.source.name && !p.importId;
      const gone = list.filter((x) => hit(x.page));
      for (const x of gone) list.splice(list.indexOf(x), 1);
      const at = ctx.now().toISOString();
      (await trashed(orgId)).unshift(...gone.map((x) => ({ ...x, page: { ...x.page, deletedAt: at } })));
      return { deleted: gone.length, kept: 0 };
    },
    trash: async (orgId) => (await trashed(orgId)).map(summary),
    restoreMany: async (orgId, ids) => {
      log("wiki.restoreMany", orgId, ids);
      const bin = await trashed(orgId);
      const back = bin.filter((x) => ids.includes(x.page.id));
      for (const x of back) bin.splice(bin.indexOf(x), 1);
      (await store(orgId)).push(...back.map((x) => ({ ...x, page: { ...x.page, deletedAt: null } })));
      return { restored: back.length, kept: 0, failed: [] };
    },
    purge: async (orgId, ids) => {
      log("wiki.purge", orgId, ids);
      const bin = await trashed(orgId);
      const gone = bin.filter((x) => !ids || ids.includes(x.page.id));
      for (const x of gone) bin.splice(bin.indexOf(x), 1);
      return { purged: gone.length, kept: 0 };
    },
    setAgents: async (orgId, ids, agentIds) => {
      log("wiki.setAgents", orgId, ids, agentIds);
      const list = (await store(orgId)).filter((x) => ids.includes(x.page.id));
      for (const x of list) x.page = { ...x.page, agentIds };
      return { changed: list.length, failed: [] };
    },
    context: async (orgId, slug, on) => {
      log("wiki.context", orgId, slug, on);
      const s = await find(orgId, slug);
      s.page = { ...s.page, agentContext: on };
      return withBacklinks(orgId, s);
    },
    reads: async (orgId) => {
      const agents = await ctx.lookup.agents(orgId);
      const all = await store(orgId);
      const [first] = all;
      return ctx.seed && first && agents[0]
        ? [
            {
              slug: first.page.slug,
              title: first.page.title,
              total: 12,
              agents: [{ agentId: agents[0].id, count: 12 }],
            },
          ]
        : [];
    },
    import: async (orgId, input) => {
      log("wiki.import", orgId, input);
      const list = await store(orgId);
      const by = await me();
      const at = ctx.now().toISOString();
      const created: WikiPageSummary[] = [];
      const skipped: string[] = [];
      for (const n of input.notes) {
        const taken = list.some((s) => s.page.slug === wikiSlug(n.title));
        if (taken && input.onConflict === "skip") {
          skipped.push(n.title);
          continue;
        }
        const title = taken ? `${n.title} (${input.source.name})` : n.title;
        const s: Stored = {
          page: {
            id: mockId("wiki"),
            slug: wikiSlug(title),
            title,
            folder: [input.folder, n.folder].filter(Boolean).join("/"),
            tags: n.tags ?? [],
            body: n.body,
            version: 1,
            createdAt: at,
            createdBy: by,
            updatedAt: at,
            updatedBy: by,
            authors: [by],
            sourceType: "obsidian",
            sourceName: input.source.name,
            importId: input.importId ?? null,
            source: { type: "obsidian", id: input.source.name, attachments: n.attachments },
          },
          versions: [{ version: 1, at, author: by, note: null, body: n.body }],
          outside: [],
        };
        list.push(s);
        created.push(summary(s));
      }
      return { created, skipped, failed: [] };
    },
    append: async (orgId, slug, input) => {
      log("wiki.append", orgId, slug, input);
      const s = await find(orgId, slug);
      const body = `${s.page.body.trimEnd()}\n\n${input.text}\n`;
      s.page = { ...s.page, body, version: s.page.version + 1, updatedAt: ctx.now().toISOString() };
      s.versions.push({ version: s.page.version, at: s.page.updatedAt, author: await me(), note: null, body });
      return withBacklinks(orgId, s);
    },
  };
}
