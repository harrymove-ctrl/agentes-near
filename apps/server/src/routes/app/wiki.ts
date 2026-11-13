import {
  appendSourceToWiki,
  createPageFromSource,
  createWikiPage,
  deleteWikiPage,
  deleteWikiPages,
  diffWikiVersions,
  getWikiFolderAudience,
  getWikiPage,
  getWikiVersion,
  importWikiPages,
  listWikiPages,
  listWikiVersions,
  moveWikiPage,
  parseWikiLinks,
  purgeWikiPages,
  renameWikiPage,
  requirePermission,
  resolveWikiTargets,
  restoreWikiPage,
  restoreWikiPages,
  setWikiFolderAudience,
  setWikiPageAgentContext,
  setWikiPageAudience,
  setWikiPageLock,
  setWikiPagePinned,
  setWikiPagesAgents,
  suggestWikiPages,
  topWikiReads,
  updateWikiPage,
  WIKI_CONTEXT_MAX,
  WIKI_IMPORT_MAX_NOTES,
  WIKI_TRASH_DAYS,
  type WikiActor,
  type WikiDeps,
  wikiGraph,
  wikiTree,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { errorResponse } from "../../http/errors";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { AudienceChoice } from "./schemas";

const tags = ["Wiki"];
const Author = z
  .object({
    type: z.enum(["person", "agent"]),
    id: z.string(),
    onBehalfOf: z.string().nullable().openapi({ description: "Agents: the person who asked for the edit." }),
  })
  .openapi("WikiAuthor");
const Audience = z
  .object({
    roleIds: z.array(z.uuid()).max(100),
    userIds: z.array(z.string().min(1).max(200)).max(500),
  })
  .openapi("WikiAudience");
const AgentIds = z.array(z.uuid()).max(500);
const FolderAudience = z
  .object({
    folder: z.string(),
    audience: Audience.nullable().openapi({ description: "null = every member." }),
    agentIds: AgentIds.nullable().openapi({ description: "null = every agent." }),
    editors: Audience.nullable().openapi({ description: "Who edits among those who see it; null = all of them." }),
    agentEditorIds: AgentIds.nullable().openapi({ description: "null = every agent that reads it." }),
  })
  .openapi("WikiFolderAudience");
const Summary = z
  .object({
    id: z.uuid(),
    slug: z.string().openapi({ description: '"guia-de-deploy": unique in the org, no folder; changes on rename.' }),
    title: z.string(),
    folder: z.string().openapi({ description: '"Processos/Vendas" ("" = the root).' }),
    tags: z.array(z.string()),
    version: z.number(),
    locked: z.boolean().openapi({ description: "Only admins edit it." }),
    pinned: z.boolean().openapi({ description: "At the top of the wiki for everyone." }),
    agentContext: z.boolean().openapi({
      description: "In every run of an agent that reads it, within the wiki's budget (at most 3 per workspace).",
    }),
    audience: Audience.nullable().openapi({
      description: "Limited to these roles and people (plus owners); null = every member.",
    }),
    agentIds: AgentIds.nullable().openapi({ description: "Limited to these agents; null = every agent." }),
    editors: Audience.nullable().openapi({
      description: "The people who edit it, among those who see it and hold `edit_wiki`; null = all of them.",
    }),
    agentEditorIds: AgentIds.nullable().openapi({ description: "Limited to these agents; null = every agent." }),
    audienceFolder: z.string().nullable().openapi({ description: "The folder whose audience it follows." }),
    excerpt: z.string().openapi({ description: "The start of the text, plain." }),
    sourceType: z.string().nullable().openapi({ description: '"obsidian" for an imported page.' }),
    sourceName: z.string().nullable().openapi({ description: "An imported page: the vault's name." }),
    importId: z
      .string()
      .nullable()
      .openapi({ description: "The import that brought it (null for pages imported before imports had ids)." }),
    updatedAt: z.string(),
    updatedBy: Author,
    deletedAt: z.string().nullable().openapi({ description: "In the trash since then; null for a live page." }),
  })
  .openapi("WikiPageSummary");
const Backlink = z
  .union([
    z.object({ kind: z.literal("page"), slug: z.string(), title: z.string(), excerpt: z.string() }),
    z.object({
      kind: z.literal("message"),
      channelId: z.uuid(),
      messageId: z.uuid(),
      channelName: z.string(),
      dm: z
        .object({ type: z.enum(["agent", "person"]), id: z.string() })
        .nullable()
        .openapi({ description: "In a direct conversation: who it is with (a DM's name is an internal key)." }),
      excerpt: z.string(),
      at: z.string(),
    }),
    z.object({ kind: z.literal("issue"), number: z.number(), title: z.string() }),
  ])
  .openapi("WikiBacklink");
const AgentReads = z.object({
  total: z.number(),
  agents: z.array(z.object({ agentId: z.string(), count: z.number() })),
});
const Page = Summary.extend({
  body: z.string(),
  createdAt: z.string(),
  createdBy: Author,
  authors: z.array(Author).openapi({ description: "Everyone who wrote it, most recent first." }),
  backlinks: z.array(Backlink),
  folderAudience: FolderAudience.nullable().openapi({
    description: "The closest limited folder: this page can only be narrower.",
  }),
  canEdit: z.boolean().openapi({
    description: "The editors' list lets this reader edit it; a locked page or a missing `edit_wiki` still stop them.",
  }),
  links: z.array(z.object({ target: z.string(), slug: z.string(), title: z.string().nullable(), exists: z.boolean() })),
  source: z
    .object({
      type: z.string(),
      id: z.string(),
      channelId: z.string().optional(),
      attachments: z
        .record(z.string(), z.string())
        .optional()
        .openapi({ description: "Imported attachments: file name → Drive artifact id (for `![[file]]`)." }),
    })
    .nullable(),
  reads: AgentReads.extend({
    last: z
      .object({
        agentId: z.string(),
        channelId: z.string().nullable(),
        channelName: z.string().nullable().openapi({ description: "Only for public channels." }),
        at: z.string(),
      })
      .nullable(),
  }).openapi({ description: "Agents that used the page in the last 7 days (in their context or opened)." }),
}).openapi("WikiPage");
const Version = z
  .object({
    version: z.number(),
    at: z.string(),
    author: Author,
    note: z.string().nullable(),
    noteCode: z.string().optional(),
    noteParams: z.record(z.string(), z.string()).optional(),
    title: z.string(),
  })
  .openapi("WikiVersion");
const Source = z.object({ kind: z.literal("message"), channelId: z.uuid(), messageId: z.uuid() }).openapi("WikiSource");
const Title = z.string().trim().min(1).max(200);
const Folder = z.string().max(200);
const Tags = z.array(z.string().max(40)).max(20);
const PageParams = OrgParams.extend({ slug: z.string().min(1).max(200) });
const conflict = errorResponse("`version_conflict`: someone saved first; `slug_taken`: the name is in use");

/**
 * The org wiki (ADR 0023): pages every member reads and edits (admins can lock
 * one), linked with `[[Title]]`, with history, backlinks and a graph.
 * `{slug}` also accepts the page id.
 */
export function wikiRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const wiki = (): WikiDeps => ({
    db,
    pubsub: adapters.pubsub,
    search: { db, search: adapters.search, gateway: { embed: deps.extras?.embed ?? (async () => null) } },
  });
  const person = (userId: string): WikiActor => ({ type: "person", userId });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/pages",
      tags,
      security,
      summary: "Pages without bodies (all, or by folder, tag or title words), most recent first",
      request: {
        params: OrgParams,
        query: z.object({
          folder: z.string().max(200).optional(),
          tag: z.string().max(40).optional(),
          q: z.string().max(200).optional(),
          deleted: z
            .stringbool()
            .optional()
            .openapi({
              description: `The trash: pages deleted in the last ${WIKI_TRASH_DAYS} days, to restore (then they are gone).`,
            }),
        }),
      },
      responses: { 200: json(z.object({ pages: z.array(Summary) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ pages: await listWikiPages(db, person(c.get("user").id), orgId, c.req.valid("query")) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/tree",
      tags,
      security,
      summary: "Folders and tags with counts, all pages and the latest ones (the sidebar)",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            pages: z.array(Summary),
            folders: z.array(z.object({ path: z.string(), count: z.number() })),
            tags: z.array(z.object({ tag: z.string(), count: z.number() })),
            recent: z.array(Summary),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await wikiTree(db, person(c.get("user").id), c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/search",
      tags,
      security,
      summary: "Title search for the `[[` autocomplete (titles starting with the text first)",
      request: { params: OrgParams, query: z.object({ q: z.string().max(200).default("") }) },
      responses: { 200: json(z.object({ pages: z.array(Summary) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const pages = await suggestWikiPages(db, person(c.get("user").id), orgId, c.req.valid("query").q);
      return c.json({ pages }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/resolve",
      tags,
      security,
      summary: "Resolve `[[…]]` links (or a text containing them): for issues and documents",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            targets: z.array(z.string().max(300)).max(200).optional(),
            text: z.string().max(200_000).optional(),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            links: z.array(
              z.object({
                target: z.string(),
                label: z.string(),
                section: z.string().nullable(),
                slug: z.string(),
                title: z.string().nullable(),
                exists: z.boolean(),
                restricted: z
                  .literal(true)
                  .optional()
                  .openapi({ description: "Limited to an audience: no title, and only its audience opens it." }),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      const input = c.req.valid("json");
      const text = [input.text ?? "", ...(input.targets ?? []).map((t) => `[[${t.replace(/[[\]]/g, "")}]]`)].join("\n");
      return c.json({ links: await resolveWikiTargets(db, orgId, parseWikiLinks(text)) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/graph",
      tags,
      security,
      summary: "Pages and the links between them (`unresolved`: links to pages not written yet)",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            nodes: z.array(
              z.object({
                id: z.uuid(),
                slug: z.string(),
                title: z.string(),
                folder: z.string(),
                tags: z.array(z.string()),
                agentId: z.uuid().nullable(),
                sourceType: z.string().nullable().openapi({ description: '"obsidian" for an imported page.' }),
              }),
            ),
            edges: z.array(z.object({ from: z.string(), to: z.string() })),
            unresolved: z.array(z.object({ from: z.string(), toSlug: z.string() })),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await wikiGraph(db, person(c.get("user").id), c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/pages",
      tags,
      security,
      summary: "Create a page (the slug comes from the title)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            title: Title,
            body: z.string().max(200_000).default(""),
            folder: Folder.optional(),
            tags: Tags.optional(),
            note: z.string().max(300).optional(),
            audience: AudienceChoice.optional().openapi({
              description: "Who sees it, inside its folder's audience. Left out: its folder's, or everyone.",
            }),
          }),
        ),
      },
      responses: { 201: json(Page, "Created"), ...errors, 409: conflict },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await createWikiPage(wiki(), person(c.get("user").id), orgId, c.req.valid("json")), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/save",
      tags,
      security,
      summary: '"Salvar na wiki" on a new page: a message, with a link back to it',
      request: {
        params: OrgParams,
        body: body(
          z.object({ source: Source, title: Title.optional(), folder: Folder.optional(), tags: Tags.optional() }),
        ),
      },
      responses: { 201: json(Page, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await createPageFromSource(wiki(), c.get("user").id, orgId, c.req.valid("json")), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/pages/{slug}",
      tags,
      security,
      summary: "A page with its backlinks (an old slug still finds it)",
      request: { params: PageParams },
      responses: { 200: json(Page), ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await getWikiPage(db, person(c.get("user").id), orgId, slug), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/wiki/pages/{slug}",
      tags,
      security,
      summary: "Save an edit (409 `version_conflict` if someone saved after `baseVersion`)",
      request: {
        params: PageParams,
        body: body(
          z.object({
            body: z.string().max(200_000),
            baseVersion: z.number().int().min(1),
            title: Title.optional(),
            folder: Folder.optional(),
            tags: Tags.optional(),
            note: z.string().max(300).optional(),
          }),
        ),
      },
      responses: { 200: json(Page), ...errors, 409: conflict },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await updateWikiPage(wiki(), person(c.get("user").id), orgId, slug, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/pages/{slug}/append",
      tags,
      security,
      summary: '"Salvar na wiki" on an existing page: appends the message, with where it came from',
      request: {
        params: PageParams,
        body: body(
          z.object({
            text: z.string().max(200_000).optional().openapi({ description: "Your own text instead of the source's." }),
            source: Source,
            section: z.string().max(200).optional(),
          }),
        ),
      },
      responses: { 200: json(Page), ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await appendSourceToWiki(wiki(), c.get("user").id, orgId, slug, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/pages/{slug}/rename",
      tags,
      security,
      summary: "New title and slug; links in other pages follow, old links keep working",
      request: { params: PageParams, body: body(z.object({ title: Title })) },
      responses: { 200: json(Page), ...errors, 409: conflict },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await renameWikiPage(wiki(), person(c.get("user").id), orgId, slug, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/pages/{slug}/move",
      tags,
      security,
      summary: 'Move to another folder ("" = the root)',
      request: { params: PageParams, body: body(z.object({ folder: Folder })) },
      responses: { 200: json(Page), ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await moveWikiPage(wiki(), person(c.get("user").id), orgId, slug, c.req.valid("json").folder), 200);
    },
  );

  const Ids = z.array(z.uuid()).max(5000);
  const Failed = z.array(z.object({ id: z.string(), title: z.string(), code: z.string() }));

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/bulk/delete",
      tags,
      security,
      summary: "Move many pages to the trash: chosen ones, a folder with its subfolders, or one import",
      description:
        "Give one of `ids`, `folder`, `importId` or `source` (an import made before imports had ids). Pages this person may not delete (locked, or off their editors) stay and are counted in `kept`. `wiki.folder_required`: an empty folder.",
      request: {
        params: OrgParams,
        body: body(
          z.union([
            z.object({ ids: Ids }),
            z.object({ folder: Folder }),
            z.object({ importId: z.uuid() }),
            z.object({ source: z.object({ type: z.string().max(40), name: z.string().max(200) }) }),
          ]),
        ),
      },
      responses: { 200: json(z.object({ deleted: z.number(), kept: z.number() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await deleteWikiPages(wiki(), c.get("user").id, orgId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/trash/restore",
      tags,
      security,
      summary: "Bring pages back from the trash",
      description:
        "A page whose address a live page took since stays in the trash, in `failed` with `wiki.restore_slug_taken`.",
      request: { params: OrgParams, body: body(z.object({ ids: Ids })) },
      responses: {
        200: json(z.object({ restored: z.number(), kept: z.number(), failed: Failed })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await restoreWikiPages(wiki(), c.get("user").id, orgId, c.req.valid("json").ids), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/trash/purge",
      tags,
      security,
      summary: `Delete pages of the trash for good (\`ids\`), or empty it (no \`ids\`), before the ${WIKI_TRASH_DAYS} days`,
      request: { params: OrgParams, body: body(z.object({ ids: Ids.optional() })) },
      responses: { 200: json(z.object({ purged: z.number(), kept: z.number() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await purgeWikiPages(wiki(), c.get("user").id, orgId, c.req.valid("json").ids), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/wiki/bulk/agents",
      tags,
      security,
      summary: "Choose which agents read many pages at once (`agentIds` null = every agent); who sees them stays",
      description: "For people who edit the wiki and manage roles. Pages that can't change come back in `failed`.",
      request: { params: OrgParams, body: body(z.object({ ids: Ids, agentIds: AgentIds.nullable() })) },
      responses: { 200: json(z.object({ changed: z.number(), failed: Failed })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { ids, agentIds } = c.req.valid("json");
      return c.json(await setWikiPagesAgents(wiki(), c.get("user").id, orgId, ids, agentIds), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/pages/{slug}/context",
      tags,
      security,
      summary: `"Sempre no contexto dos agentes": the page goes into every run of an agent that reads it (at most ${WIKI_CONTEXT_MAX})`,
      description: "`wiki.context_full`: the workspace already has the most pages always in context.",
      request: { params: PageParams, body: body(z.object({ on: z.boolean() })) },
      responses: { 200: json(Page), ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await setWikiPageAgentContext(wiki(), c.get("user").id, orgId, slug, c.req.valid("json").on), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/pages/{slug}/pin",
      tags,
      security,
      summary: "Pin a page to the top of the wiki (or unpin it)",
      request: { params: PageParams, body: body(z.object({ pinned: z.boolean() })) },
      responses: { 200: json(Page), ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await setWikiPagePinned(wiki(), c.get("user").id, orgId, slug, c.req.valid("json").pinned), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/reads",
      tags,
      security,
      summary: "What the agents opened most in the last 7 days (pages that only went into a run's context don't count)",
      request: { params: OrgParams },
      responses: {
        200: json(z.array(AgentReads.extend({ slug: z.string(), title: z.string() })).openapi("WikiTopReads")),
        ...errors,
      },
    }),
    async (c) => c.json(await topWikiReads(db, person(c.get("user").id), c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/import",
      tags,
      security,
      summary: "Import notes (an Obsidian vault read by the app) as pages",
      description: `Up to ${WIKI_IMPORT_MAX_NOTES} notes per call; the app sends a big vault in batches with one \`importId\`. Attachments go to the Drive first (upload), and each note says which ones it embeds. A note that can't be a page comes back in \`failed\` and the others still go in; tags, aliases and attachment names past their limits are cut.`,
      request: {
        params: OrgParams,
        body: body(
          z.object({
            source: z.object({ type: z.literal("obsidian"), name: z.string().max(200) }),
            notes: z
              .array(
                z.object({
                  title: z.string().max(1000),
                  folder: z.string().max(1000).optional(),
                  body: z.string().max(1_000_000),
                  tags: z.array(z.string().max(1000)).max(200).optional(),
                  aliases: z.array(z.string().max(1000)).max(200).optional(),
                  attachments: z.record(z.string().max(1000), z.uuid()).optional(),
                }),
              )
              .max(WIKI_IMPORT_MAX_NOTES),
            folder: Folder.optional().openapi({ description: "Put everything under this folder." }),
            onConflict: z.enum(["keep_both", "skip"]).default("keep_both"),
            importId: z.uuid().optional().openapi({
              description: "The same for every batch and retry of one import: its pages keep it (delete it as one).",
            }),
          }),
        ),
      },
      responses: {
        200: json(
          z
            .object({
              created: z.array(Summary),
              skipped: z.array(z.string()).openapi({ description: "Titles left out (a page already had the name)." }),
              failed: z.array(z.object({ title: z.string(), reason: z.enum(["title", "too_long"]) })),
            })
            .openapi("WikiImportResult"),
          "Imported",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await importWikiPages(wiki(), c.get("user").id, orgId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/pages/{slug}/lock",
      tags,
      security,
      summary: "Lock (only admins edit) or unlock a page; admins only",
      request: { params: PageParams, body: body(z.object({ locked: z.boolean() })) },
      responses: { 200: json(Page), ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await setWikiPageLock(wiki(), c.get("user").id, orgId, slug, c.req.valid("json").locked), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/wiki/pages/{slug}/audience",
      tags,
      security,
      summary:
        "Limit a page to roles and people (owners always read it) and to some agents, or open it with `null`; for people who edit the wiki and manage roles",
      description:
        "Anyone who edits the page, for `audience` alone. `wiki.audience_forbidden`: `agentIds` or `editors` without `edit_wiki` and `manage_roles`; `wiki.audience_excludes_you`: the audience must include you; `wiki.audience_wider_than_folder`: inside a limited folder a page can only be narrower; `wiki.editors_exclude_you`: the editors must include you. People outside it get `wiki.no_access` on the page, and those off its editors `wiki.edit_limited` on a write. Leaving out `agentIds`, or `editors` with `agentEditorIds`, keeps the page's own.",
      request: {
        params: PageParams,
        body: body(
          z.object({
            audience: Audience.nullable(),
            agentIds: AgentIds.nullable().optional(),
            editors: Audience.nullable().optional(),
            agentEditorIds: AgentIds.nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(Page), ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      const { audience, agentIds, editors, agentEditorIds } = c.req.valid("json");
      const edit =
        editors === undefined && agentEditorIds === undefined
          ? undefined
          : { editors: editors ?? null, agentEditorIds: agentEditorIds ?? null };
      return c.json(await setWikiPageAudience(wiki(), c.get("user").id, orgId, slug, audience, agentIds, edit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/folder-audience",
      tags,
      security,
      summary: "A folder's audience and the closest limited folder above it (\"\" = the wiki's root)",
      request: { params: OrgParams, query: z.object({ folder: z.string().max(200) }) },
      responses: {
        200: json(z.object({ own: FolderAudience.nullable(), above: FolderAudience.nullable() })),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await getWikiFolderAudience(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("query").folder),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/wiki/folder-audience",
      tags,
      security,
      summary:
        "Limit a folder to roles, people and agents (both `null` opens it); for people who edit the wiki and manage roles",
      description:
        "Reaches the pages in it and its subfolders, and a page created or moved in takes it. A page with its own narrower audience keeps it, cut to fit. `folder` \"\" is the wiki's root: every page. Same errors as a page's audience.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            folder: z.string().max(200),
            audience: Audience.nullable(),
            agentIds: AgentIds.nullable(),
            editors: Audience.nullable().optional(),
            agentEditorIds: AgentIds.nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(z.object({ folder: z.string(), pages: z.number() })), ...errors },
    }),
    async (c) => {
      const { folder, audience, agentIds, editors, agentEditorIds } = c.req.valid("json");
      const edit = { editors: editors ?? null, agentEditorIds: agentEditorIds ?? null };
      const { orgId } = c.req.valid("param");
      return c.json(
        await setWikiFolderAudience(wiki(), c.get("user").id, orgId, folder, audience, agentIds, edit),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/wiki/pages/{slug}",
      tags,
      security,
      summary: "Move a page to the trash (restore brings it back)",
      request: { params: PageParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      await deleteWikiPage(wiki(), person(c.get("user").id), orgId, slug);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/wiki/pages/{slug}/restore",
      tags,
      security,
      summary: "Bring a deleted page back (by id, or the latest deleted page with that slug)",
      request: { params: PageParams },
      responses: { 200: json(Page), ...errors, 409: conflict },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json(await restoreWikiPage(wiki(), person(c.get("user").id), orgId, slug), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/pages/{slug}/history",
      tags,
      security,
      summary: "Every version, newest first, with author (and for whom, for agents) and note",
      request: { params: PageParams },
      responses: { 200: json(z.object({ versions: z.array(Version) })), ...errors },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      return c.json({ versions: await listWikiVersions(db, person(c.get("user").id), orgId, slug) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/pages/{slug}/versions/{version}",
      tags,
      security,
      summary: "One version's content",
      request: { params: PageParams.extend({ version: z.coerce.number().int().min(1) }) },
      responses: {
        200: json(
          z.object({
            version: z.number(),
            title: z.string(),
            body: z.string(),
            folder: z.string(),
            tags: z.array(z.string()),
            at: z.string(),
            author: Author,
            note: z.string().nullable(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, slug, version } = c.req.valid("param");
      return c.json(await getWikiVersion(db, person(c.get("user").id), orgId, slug, version), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/wiki/pages/{slug}/diff",
      tags,
      security,
      summary: "What changed between two versions (lines and a unified patch)",
      request: {
        params: PageParams,
        query: z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }),
      },
      responses: {
        200: json(
          z.object({
            from: z.number(),
            to: z.number(),
            titleChanged: z.object({ from: z.string(), to: z.string() }).nullable(),
            added: z.number(),
            removed: z.number(),
            lines: z.array(z.object({ type: z.enum(["same", "add", "del"]), text: z.string() })),
            patch: z.string(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, slug } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      return c.json(await diffWikiVersions(db, person(c.get("user").id), orgId, slug, from, to), 200);
    },
  );

  return app;
}
