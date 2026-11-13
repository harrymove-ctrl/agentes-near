import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * The org wiki (ADR 0023): markdown pages every member reads, linked with
 * `[[Title]]`, `[[slug|text]]` or `[[Page#section]]`. Agents write only when
 * a person asks. Every save is a version; links are parsed on save into
 * `wiki_links` (backlinks and the graph).
 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `guia-de-deploy`: unique among live pages of the org. */
    slug: text().notNull(),
    /** Earlier slugs (renames), so old links still resolve. */
    aliases: text().array().notNull().default(sql`'{}'::text[]`),
    title: text().notNull(),
    body: text().notNull().default(""),
    /** `Engenharia/Backend`; empty = the root. */
    folder: text().notNull().default(""),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    /** Bumped on every save (optimistic concurrency). */
    version: integer().notNull().default(1),
    /** Admins lock a page: only admins edit it. */
    locked: boolean().notNull().default(false),
    /** "Fixadas": shown at the top of the wiki for everyone. */
    pinned: boolean().notNull().default(false),
    /** "Sempre no contexto dos agentes": every run of an agent that reads it gets it, within the wiki's budget. */
    agentContext: boolean().notNull().default(false),
    /**
     * Limited to an audience (ADR 0023 addendum): only administrators, the people holding one of `audienceRoleIds` and the
     * people in `audienceUserIds` see it.
     */
    restricted: boolean().notNull().default(false),
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Limited to some agents: only `audienceAgentIds` read it. Independent of `restricted`. */
    agentsLimited: boolean().notNull().default(false),
    audienceAgentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Only these people edit it, among those who see it and hold `edit_wiki`. Administrators always do. */
    editorsLimited: boolean().notNull().default(false),
    editorRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    editorUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Only these agents edit it, among those who read it and hold `wiki:write`. */
    agentEditorsLimited: boolean().notNull().default(false),
    agentEditorIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** The folder whose audience this page follows; null = its own audience, or open. */
    audienceFolder: text(),
    /**
     * Where it came from: "Salvar na wiki" (`message`) or an import (`obsidian`, id = the vault's name, `importId` = the
     * run that brought it, the same across its batches and retries).
     */
    source: jsonb().$type<{
      type: string;
      id: string;
      channelId?: string;
      importId?: string;
      attachments?: Record<string, string>;
    }>(),
    /** `person` or `agent`. */
    createdByType: text().notNull(),
    createdById: text().notNull(),
    updatedByType: text().notNull(),
    updatedById: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("wiki_pages_org_slug").on(t.orgId, t.slug).where(sql`${t.deletedAt} is null`),
    index().on(t.orgId, t.updatedAt),
  ],
);

/**
 * A folder's audience (ADR 0023 addendum): applied to the pages in it and its subfolders, and taken by a page created
 * or moved in. A page holds its own copy, so one condition over `wiki_pages` decides who sees it.
 */
export const wikiFolderAudiences = pgTable(
  "wiki_folder_audiences",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `Financeiro/Contratos`, as `wiki_pages.folder` writes it. */
    folder: text().notNull(),
    restricted: boolean().notNull().default(false),
    audienceRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    agentsLimited: boolean().notNull().default(false),
    audienceAgentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    editorsLimited: boolean().notNull().default(false),
    editorRoleIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    editorUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    agentEditorsLimited: boolean().notNull().default(false),
    agentEditorIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    updatedById: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.orgId, t.folder)],
);

/** Full history: one row per save, with who wrote it (and for whom, for agents) and a note. */
export const wikiPageVersions = pgTable(
  "wiki_page_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    pageId: uuid()
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    folder: text().notNull().default(""),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    authorType: text().notNull(),
    authorId: text().notNull(),
    /** The person an agent wrote it for ("by Theo, at Walter's request"). */
    requestedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    note: text().notNull().default(""),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.pageId, t.version), index().on(t.orgId)],
);

/**
 * `[[…]]` links, from a page or from anything else that can mention one (a
 * message, an issue). `toPageId` is null while the target
 * doesn't exist. Backlinks and the graph come from here.
 */
export const wikiLinks = pgTable(
  "wiki_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    /** `page`, `message` or `issue`. */
    fromType: text().notNull(),
    fromId: uuid().notNull(),
    /** Set for page links (removed with the page). */
    fromPageId: uuid().references(() => wikiPages.id, { onDelete: "cascade" }),
    /** Where a message link lives (who may see the backlink). */
    channelId: uuid(),
    toSlug: text().notNull(),
    toPageId: uuid().references(() => wikiPages.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.fromType, t.fromId, t.toSlug),
    index().on(t.orgId, t.toSlug),
    index().on(t.toPageId),
    index().on(t.fromPageId),
  ],
);

/**
 * An agent used a page: it went into the run's context (`context`) or the agent opened it with `read_wiki_page`
 * (`opened`). "What the agents read most" counts the opened ones; "agents that use this page" both. Kept for 30 days.
 */
export const wikiPageReads = pgTable(
  "wiki_page_reads",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    pageId: uuid()
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid(),
    /** `context` or `opened`. */
    kind: text().notNull().default("context"),
    /** Where the agent was answering. */
    channelId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.createdAt), index().on(t.pageId, t.createdAt)],
);
