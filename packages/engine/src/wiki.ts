import { contentWords, type PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { plainLine } from "@agenteschat/ui/markdown";
import { getAgent } from "./agents";
import { ARTIFACT_TRASH_DAYS } from "./artifacts";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { requireChannelAccess } from "./channels";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { cutText } from "./format";
import { getMessage } from "./messages";
import { can, type Membership, requireActiveMembership } from "./organizations";
import { maySql } from "./permissions";
import { enqueueIndex, registerDocumentBuilder, registerReindexSource, type SearchDeps, searchVisible } from "./search";
import { type Audience, adminChannelSql, taskSeenSql } from "./task-access";
import {
  pagesBySlug,
  parseWikiLinks,
  syncWikiLinks,
  visibleWikiPageIds,
  wikiPageRunVisibleSql,
  wikiPageVisibleSql,
  wikiSlug,
} from "./wiki-links";

const {
  wikiPages,
  wikiFolderAudiences,
  orgRoles,
  organizationMembers,
  organizationMemberRoles,
  wikiPageVersions,
  wikiLinks,
  wikiPageReads,
  users,
  agents,
  messages,
  channels,
  channelMembers,
  issues,
} = schema;

type PageRow = typeof wikiPages.$inferSelect;

/**
 * Who reads or writes: a person, or an agent for a person ("by Theo, at Walter's request"). An agent sees only what
 * that person and whoever reads `channelId` see (`wikiPageRunVisibleSql`), so it can't hand a page to someone it was
 * kept from; with nobody behind it, it sees no page limited to people.
 */
export type WikiActor =
  | { type: "person"; userId: string }
  | { type: "agent"; agentId: string; requestedByUserId: string | null; channelId?: string | null };

export interface WikiDeps {
  db: Database;
  pubsub?: PubSub;
  /** Search over the wiki (else a title/body match). */
  search?: SearchDeps;
}

export interface WikiAuthor {
  type: "person" | "agent";
  id: string;
  /** For agents: the person who asked. */
  onBehalfOf: string | null;
}

/** A restricted page's audience: the roles and the people who see it (administrators always do). */
export interface WikiAudience {
  roleIds: string[];
  userIds: string[];
}

/** Who edits, among those who see: `editors` null = all of them, `agentEditorIds` null = every agent that reads. */
export interface WikiEditors {
  editors: WikiAudience | null;
  agentEditorIds: string[] | null;
}

/** A folder's audience: `audience` null = every member, `agentIds` null = every agent. */
export interface WikiFolderAudience extends WikiEditors {
  folder: string;
  audience: WikiAudience | null;
  agentIds: string[] | null;
}

export interface WikiPageSummary {
  id: string;
  slug: string;
  title: string;
  folder: string;
  tags: string[];
  version: number;
  locked: boolean;
  /** "Fixadas": at the top of the wiki for everyone. */
  pinned: boolean;
  /** "Sempre no contexto dos agentes": in every run of an agent that reads it (at most `WIKI_CONTEXT_MAX`). */
  agentContext: boolean;
  /** Who sees it besides administrators; null = every member. */
  audience: WikiAudience | null;
  /** The agents that read it; null = every agent. */
  agentIds: string[] | null;
  /** The people who edit it, among those who see it and hold `edit_wiki`; null = all of them. */
  editors: WikiAudience | null;
  /** The agents that edit it, among those that read it; null = all of them. */
  agentEditorIds: string[] | null;
  /** The folder whose audience it follows; null = its own, or open. */
  audienceFolder: string | null;
  /** The start of the text, plain (no markdown), for cards. */
  excerpt: string;
  /** Where it came from: `obsidian` for an imported page, `message` for "Save to wiki". */
  sourceType: string | null;
  /** An imported page: the vault's name, and the import that brought it (null for imports made before ids). */
  sourceName: string | null;
  importId: string | null;
  updatedAt: string;
  /** In the trash since then; null for a live page. */
  deletedAt: string | null;
  updatedBy: WikiAuthor;
}

/** Who a DM is with for its reader (`a:<agentId>|u:<userId>`, sorted): its agent, else the other person. */
function dmOther(dmKey: string | null, viewer: string): { type: "agent" | "person"; id: string } | null {
  const parts = (dmKey ?? "").split("|");
  const agent = parts.find((p) => p.startsWith("a:"));
  if (agent) return { type: "agent", id: agent.slice(2) };
  const other = parts.find((p) => p.startsWith("u:") && p.slice(2) !== viewer);
  return other ? { type: "person", id: other.slice(2) } : null;
}

export type WikiBacklink =
  | { kind: "page"; slug: string; title: string; excerpt: string }
  | {
      kind: "message";
      channelId: string;
      messageId: string;
      channelName: string;
      /** In a direct conversation: who it is with, for the reader (a DM's name is an internal key). */
      dm: { type: "agent" | "person"; id: string } | null;
      excerpt: string;
      at: string;
    }
  | { kind: "issue"; number: number; title: string };

export interface WikiPageView extends WikiPageSummary {
  body: string;
  createdAt: string;
  createdBy: WikiAuthor;
  /** Everyone who wrote it, most recent first. */
  authors: WikiAuthor[];
  backlinks: WikiBacklink[];
  /** Its own `[[…]]` links, resolved. */
  links: { target: string; slug: string; title: string | null; exists: boolean }[];
  source: WikiSource | null;
  /** Agents that used the page in the last 7 days. */
  reads: WikiPageReads;
  /** The audience of the closest limited folder: this page can only be narrower. */
  folderAudience: WikiFolderAudience | null;
  /** Whether the editors' list lets this reader edit it (a locked page or a missing `edit_wiki` still stops them). */
  canEdit: boolean;
  deletedAt: string | null;
}

/** Where a page came from. An import keeps its attachments: file name → Drive artifact id. */
export type WikiSource = { type: string; id: string; channelId?: string; attachments?: Record<string, string> };

export interface WikiPageReads {
  total: number;
  agents: { agentId: string; count: number }[];
  /** The latest use; the channel only when it is a public channel. */
  last: { agentId: string; channelId: string | null; channelName: string | null; at: string } | null;
}

export interface WikiVersionView {
  version: number;
  at: string;
  author: WikiAuthor;
  note: string | null;
  /** A note the server wrote ("created the page"): its code and params, for the app's `wiki.note.*`. */
  noteCode?: string;
  noteParams?: Record<string, string>;
  title: string;
}

export const WIKI_LIMITS = { body: 200_000, title: 200, folder: 200, tags: 20 };

/** Raised when the page moved past the version being edited (409 `version_conflict`). */
export class WikiVersionConflictError extends ConflictError {
  constructor(readonly currentVersion: number) {
    super(
      `Someone edited this page while you were writing (it is now at version ${currentVersion}).`,
      "version_conflict",
    );
  }
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * A title whose folder is given apart keeps its slashes ("30/out e 1/nov") as division slashes (∕): a "/" in a title
 * names a folder, in links and in paths, so it would cut the title there.
 */
const keepSlashes = (title: string) => title.replace(/\//g, "\u2215");

function cleanTitle(title: string) {
  const t = title.replace(/\s+/g, " ").trim().slice(0, WIKI_LIMITS.title);
  if (!t) throw new ValidationError("A title is required", "wiki.title_required");
  if (/[[\]|#]/.test(t)) throw new ValidationError("The title can't contain [ ] | or #", "wiki.title_characters");
  return t;
}

/** " Processos / Vendas/ " → "Processos/Vendas". */
export function cleanFolder(folder: string | undefined | null) {
  if (!folder) return "";
  const parts = folder
    .split("/")
    .map((p) => p.replace(/\s+/g, " ").trim().slice(0, 80))
    .filter(Boolean);
  if (parts.length > 8) throw new ValidationError("At most 8 folder levels", "wiki.folder_depth", { max: 8 });
  return parts.join("/").slice(0, WIKI_LIMITS.folder);
}

function cleanTags(tags: string[] | undefined) {
  if (!tags) return undefined;
  return [...new Set(tags.map((t) => t.trim().replace(/^#/, "").toLowerCase().slice(0, 40)).filter(Boolean))].slice(
    0,
    WIKI_LIMITS.tags,
  );
}

function cleanBody(body: string | undefined) {
  const b = body ?? "";
  if (b.length > WIKI_LIMITS.body)
    throw new ValidationError("A page can have up to 200,000 characters", "wiki.body_too_long", { max: 200_000 });
  return b;
}

// ── Access ───────────────────────────────────────────────────────────────────

/** Every member reads; agents of the org read. Returns the person's membership. */
async function requireReader(db: Database, actor: WikiActor, orgId: string): Promise<Membership | null> {
  if (actor.type === "agent") {
    const agent = await getAgent(db, orgId, actor.agentId);
    if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
    return null;
  }
  const membership = await requireActiveMembership(db, actor.userId, orgId);
  return membership;
}

/**
 * Members create and edit; a locked page only admins (never agents). A restricted page only its audience, and an
 * agent only for someone in it: an agent doesn't write a page for a person who can't see it.
 */
async function requireWriter(db: Database, actor: WikiActor, orgId: string, page?: PageRow) {
  const membership = await requireReader(db, actor, orgId);
  if (membership && !can(membership, "edit_wiki")) throw new ForbiddenError();
  if (page?.locked && !(membership && can(membership, "configure"))) {
    throw new ForbiddenError("This page is locked: only admins edit it", "wiki.locked");
  }
  const who = actor.type === "person" ? actor.userId : actor.requestedByUserId;
  if (page && who && !(await sees(db, who, page))) throw noAccess();
  if (page) await requireEditor(db, actor, page);
  return membership;
}

/** An agent edits only on its own list and for a person on theirs, so nobody edits through an agent what they can't. */
async function requireEditor(db: Executor, actor: WikiActor, page: PageRow) {
  const who = actor.type === "person" ? actor.userId : actor.requestedByUserId;
  if ((who && !(await edits(db, who, page))) || (actor.type === "agent" && !agentEdits(actor.agentId, page))) {
    throw new ForbiddenError("Only the people chosen edit this page", "wiki.edit_limited");
  }
}

const noAccess = () => new ForbiddenError("You don't have access to this page", "wiki.no_access");

/** Whether the person `userId` sees `page`. */
async function sees(db: Executor, userId: string, page: Pick<PageRow, "id" | "restricted">) {
  return !page.restricted || (await visibleWikiPageIds(db, userId, [page.id])).has(page.id);
}

/** Whether the agent reads `page`. */
const agentSees = (agentId: string, page: Pick<PageRow, "agentsLimited" | "audienceAgentIds">) =>
  !page.agentsLimited || page.audienceAgentIds.includes(agentId);

/** Whether the person `userId` is on the page's editors, if it has a list. Administrators always are. */
async function edits(
  db: Executor,
  userId: string,
  page: Pick<PageRow, "orgId" | "editorsLimited" | "editorRoleIds" | "editorUserIds">,
) {
  if (!page.editorsLimited || page.editorUserIds.includes(userId)) return true;
  if ((await roleHolders(db, page.orgId, page.editorRoleIds)).has(userId)) return true;
  const [row] = rowsOf<{ yes: boolean | string }>(
    await db.execute(sql`select ${maySql(sql`${page.orgId}::uuid`, sql`${userId}::text`, "administrator")} as yes`),
  );
  return row?.yes === true || row?.yes === "t";
}

/** Whether the agent is on the page's editors, if it has a list. */
const agentEdits = (agentId: string, page: Pick<PageRow, "agentEditorsLimited" | "agentEditorIds">) =>
  !page.agentEditorsLimited || page.agentEditorIds.includes(agentId);

/** The condition that keeps a person or an agent to the pages they see. */
const visibleTo = (actor: WikiActor) =>
  actor.type === "person"
    ? wikiPageVisibleSql(actor.userId)
    : wikiPageRunVisibleSql({
        agentId: actor.agentId,
        personId: actor.requestedByUserId,
        channelId: actor.channelId ?? null,
      });

/** Of these page ids, the ones `actor` sees. */
async function visibleIds(db: Executor, actor: WikiActor, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(and(inArray(wikiPages.id, [...new Set(ids)]), visibleTo(actor)));
  return new Set(rows.map((r) => r.id));
}

const authorCols = (actor: WikiActor) =>
  actor.type === "person"
    ? { type: "person", id: actor.userId, requestedBy: null }
    : { type: "agent", id: actor.agentId, requestedBy: actor.requestedByUserId };

const auditActor = (actor: WikiActor) =>
  actor.type === "person"
    ? { type: "person" as const, id: actor.userId }
    : { type: "agent" as const, id: actor.agentId };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A live page by id, slug or an earlier slug (or a deleted one with `deleted`), that `actor` sees: a restricted page
 * outside a person's audience is a plain `wiki.no_access`, and for an agent that may not read it the page doesn't exist.
 */
async function findPage(
  db: Executor,
  actor: WikiActor,
  orgId: string,
  ref: string,
  options: { deleted?: boolean } = {},
) {
  const row = await findAnyPage(db, orgId, ref, options);
  if (actor.type === "person" && !(await sees(db, actor.userId, row))) throw noAccess();
  if (actor.type === "agent" && !(await visibleIds(db, actor, [row.id])).has(row.id)) {
    throw new NotFoundError("Page not found", "wiki.page_not_found");
  }
  return row;
}

// ── Folder audiences ─────────────────────────────────────────────────────────

type AudienceCols = Pick<
  PageRow,
  | "restricted"
  | "audienceRoleIds"
  | "audienceUserIds"
  | "agentsLimited"
  | "audienceAgentIds"
  | "editorsLimited"
  | "editorRoleIds"
  | "editorUserIds"
  | "agentEditorsLimited"
  | "agentEditorIds"
>;
type FolderRule = typeof wikiFolderAudiences.$inferSelect;

const OPEN: AudienceCols = {
  restricted: false,
  audienceRoleIds: [],
  audienceUserIds: [],
  agentsLimited: false,
  audienceAgentIds: [],
  editorsLimited: false,
  editorRoleIds: [],
  editorUserIds: [],
  agentEditorsLimited: false,
  agentEditorIds: [],
};

const colsOf = (a: AudienceCols): AudienceCols => ({
  restricted: a.restricted,
  audienceRoleIds: a.audienceRoleIds,
  audienceUserIds: a.audienceUserIds,
  agentsLimited: a.agentsLimited,
  audienceAgentIds: a.audienceAgentIds,
  editorsLimited: a.editorsLimited,
  editorRoleIds: a.editorRoleIds,
  editorUserIds: a.editorUserIds,
  agentEditorsLimited: a.agentEditorsLimited,
  agentEditorIds: a.agentEditorIds,
});

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

const sameAudience = (a: AudienceCols, b: AudienceCols) =>
  a.restricted === b.restricted &&
  a.agentsLimited === b.agentsLimited &&
  a.editorsLimited === b.editorsLimited &&
  a.agentEditorsLimited === b.agentEditorsLimited &&
  sameSet(a.audienceRoleIds, b.audienceRoleIds) &&
  sameSet(a.audienceUserIds, b.audienceUserIds) &&
  sameSet(a.audienceAgentIds, b.audienceAgentIds) &&
  sameSet(a.editorRoleIds, b.editorRoleIds) &&
  sameSet(a.editorUserIds, b.editorUserIds) &&
  sameSet(a.agentEditorIds, b.agentEditorIds);

/** "A/B/C" → A/B/C, A/B, A, "": the folder and the ones above it, closest first, ending with the wiki's root. */
function folderChain(folder: string) {
  const parts = folder ? folder.split("/") : [];
  return [...parts.map((_, i) => parts.slice(0, parts.length - i).join("/")), ""];
}

const closestRule = (rules: FolderRule[], folder: string) => {
  for (const path of folderChain(folder)) {
    const rule = rules.find((r) => r.folder === path);
    if (rule) return rule;
  }
  return null;
};

async function ruleFor(db: Executor, orgId: string, folder: string) {
  const chain = folderChain(folder);
  const rules = await db
    .select()
    .from(wikiFolderAudiences)
    .where(and(eq(wikiFolderAudiences.orgId, orgId), inArray(wikiFolderAudiences.folder, chain)));
  return closestRule(rules, folder);
}

/** The people holding any of these roles. */
async function roleHolders(db: Executor, orgId: string, roleIds: string[]) {
  if (roleIds.length === 0) return new Set<string>();
  const rows = await db
    .select({ userId: organizationMemberRoles.userId })
    .from(organizationMemberRoles)
    .where(and(eq(organizationMemberRoles.orgId, orgId), inArray(organizationMemberRoles.roleId, roleIds)));
  return new Set(rows.map((r) => r.userId));
}

/** Holders of a rule's roles: for its audience, and for its editors. */
async function heldOf(db: Executor, orgId: string, rule: AudienceCols) {
  const [audience, editors] = await Promise.all([
    roleHolders(db, orgId, rule.audienceRoleIds),
    roleHolders(db, orgId, rule.editorRoleIds),
  ]);
  return { audience, editors };
}

type People = { limited: boolean; roleIds: string[]; userIds: string[] };

/** What `rule` leaves open stays as it was, what `a` leaves open takes the rule's list, two lists keep what they share. */
function clampPeople(a: People, rule: People, held: Set<string>): People {
  if (!rule.limited) return a;
  if (!a.limited) return rule;
  return {
    limited: true,
    roleIds: a.roleIds.filter((id) => rule.roleIds.includes(id)),
    userIds: a.userIds.filter((id) => rule.userIds.includes(id) || held.has(id)),
  };
}

function clampAgents(a: { limited: boolean; ids: string[] }, rule: { limited: boolean; ids: string[] }) {
  if (!rule.limited) return a;
  if (!a.limited) return rule;
  return { limited: true, ids: a.ids.filter((id) => rule.ids.includes(id)) };
}

/** `a` kept inside `rule`, seeing and editing alike, so a page or a subfolder is never wider than its folder. */
function clampTo(a: AudienceCols, rule: AudienceCols, held: { audience: Set<string>; editors: Set<string> }) {
  const sees = clampPeople(
    { limited: a.restricted, roleIds: a.audienceRoleIds, userIds: a.audienceUserIds },
    { limited: rule.restricted, roleIds: rule.audienceRoleIds, userIds: rule.audienceUserIds },
    held.audience,
  );
  const reads = clampAgents(
    { limited: a.agentsLimited, ids: a.audienceAgentIds },
    { limited: rule.agentsLimited, ids: rule.audienceAgentIds },
  );
  const writes = clampPeople(
    { limited: a.editorsLimited, roleIds: a.editorRoleIds, userIds: a.editorUserIds },
    { limited: rule.editorsLimited, roleIds: rule.editorRoleIds, userIds: rule.editorUserIds },
    held.editors,
  );
  const agentWrites = clampAgents(
    { limited: a.agentEditorsLimited, ids: a.agentEditorIds },
    { limited: rule.agentEditorsLimited, ids: rule.agentEditorIds },
  );
  return {
    restricted: sees.limited,
    audienceRoleIds: sees.roleIds,
    audienceUserIds: sees.userIds,
    agentsLimited: reads.limited,
    audienceAgentIds: reads.ids,
    editorsLimited: writes.limited,
    editorRoleIds: writes.roleIds,
    editorUserIds: writes.userIds,
    agentEditorsLimited: agentWrites.limited,
    agentEditorIds: agentWrites.ids,
  } satisfies AudienceCols;
}

/** The audience of a page landing in `folder`: what it had, kept inside the closest limited folder. */
async function placement(tx: Executor, orgId: string, folder: string, current: AudienceCols = OPEN) {
  const rule = await ruleFor(tx, orgId, folder);
  if (!rule) return { ...colsOf(current), audienceFolder: null };
  const kept = clampTo(current, rule, await heldOf(tx, orgId, rule));
  return { ...kept, audienceFolder: sameAudience(kept, rule) ? rule.folder : null };
}

/** What a new page in a limited folder takes. */
const inherited = (rule: FolderRule | null) => (rule ? { ...colsOf(rule), audienceFolder: rule.folder } : {});

/** After a create or a move: the writer and the person asking keep the page, so nobody writes what they lose. */
async function requireStaysVisible(tx: Executor, actor: WikiActor, page: PageRow) {
  const who = actor.type === "person" ? actor.userId : actor.requestedByUserId;
  if (who && !(await sees(tx, who, page))) throw noAccess();
  if (actor.type === "agent" && !agentSees(actor.agentId, page)) throw noAccess();
  await requireEditor(tx, actor, page);
}

const folderAudienceOf = (rule: FolderRule | null): WikiFolderAudience | null =>
  rule && {
    folder: rule.folder,
    audience: rule.restricted ? { roleIds: rule.audienceRoleIds, userIds: rule.audienceUserIds } : null,
    agentIds: rule.agentsLimited ? rule.audienceAgentIds : null,
    editors: rule.editorsLimited ? { roleIds: rule.editorRoleIds, userIds: rule.editorUserIds } : null,
    agentEditorIds: rule.agentEditorsLimited ? rule.agentEditorIds : null,
  };

async function findAnyPage(db: Executor, orgId: string, ref: string, options: { deleted?: boolean } = {}) {
  const key = ref.trim();
  if (UUID.test(key)) {
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.id, key)));
    if (row && (options.deleted ? row.deletedAt : !row.deletedAt)) return row;
    throw new NotFoundError("Page not found", "wiki.page_not_found");
  }
  const slug = wikiSlug(key) || key;
  if (options.deleted) {
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, slug), sql`${wikiPages.deletedAt} is not null`))
      .orderBy(desc(wikiPages.deletedAt))
      .limit(1);
    if (!row) throw new NotFoundError("Page not found", "wiki.page_not_found");
    return row;
  }
  const page = (await pagesBySlug(db, orgId, [slug])).get(slug);
  if (!page) throw new NotFoundError("Page not found", "wiki.page_not_found");
  const [row] = await db.select().from(wikiPages).where(eq(wikiPages.id, page.id));
  if (!row) throw new NotFoundError("Page not found", "wiki.page_not_found");
  return row;
}

// ── Views ────────────────────────────────────────────────────────────────────

async function summaries(db: Executor, rows: PageRow[]): Promise<WikiPageSummary[]> {
  if (rows.length === 0) return [];
  const latest = await db
    .select({ pageId: wikiPageVersions.pageId, requestedBy: wikiPageVersions.requestedByUserId })
    .from(wikiPageVersions)
    .where(
      and(
        inArray(
          wikiPageVersions.pageId,
          rows.map((r) => r.id),
        ),
        sql`${wikiPageVersions.version} = (select p.version from wiki_pages p where p.id = ${wikiPageVersions.pageId})`,
      ),
    );
  const behalf = new Map(latest.map((l) => [l.pageId, l.requestedBy]));
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    folder: r.folder,
    tags: r.tags,
    version: r.version,
    locked: r.locked,
    pinned: r.pinned,
    audience: r.restricted ? { roleIds: r.audienceRoleIds, userIds: r.audienceUserIds } : null,
    agentIds: r.agentsLimited ? r.audienceAgentIds : null,
    editors: r.editorsLimited ? { roleIds: r.editorRoleIds, userIds: r.editorUserIds } : null,
    agentEditorIds: r.agentEditorsLimited ? r.agentEditorIds : null,
    audienceFolder: r.audienceFolder,
    excerpt: plainExcerpt(r.body, r.title),
    sourceType: r.source?.type ?? null,
    sourceName: r.source?.type === "message" ? null : (r.source?.id ?? null),
    importId: r.source?.importId ?? null,
    agentContext: r.agentContext,
    updatedAt: r.updatedAt.toISOString(),
    deletedAt: r.deletedAt?.toISOString() ?? null,
    updatedBy: {
      type: r.updatedByType as WikiAuthor["type"],
      id: r.updatedById,
      onBehalfOf: r.updatedByType === "agent" ? (behalf.get(r.id) ?? null) : null,
    },
  }));
}

/** About 220 characters of plain text from the start of a page (a leading `# Title` is skipped). */
export function plainExcerpt(body: string, title = "", max = 220) {
  const text = body
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"), "")
    .replace(/!\[\[[^\]\n]*\]\]/g, " ")
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n]+)\]\]/g, (_, t: string) => t.split("#")[0]?.split("/").pop() ?? t)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*>\s*\[![\w-]+\][+-]?\s*/gm, "")
    .replace(/^\s*(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)])\s*/gm, "")
    .replace(/[*_`~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text;
}

async function summaryOf(db: Executor, row: PageRow) {
  const [s] = await summaries(db, [row]);
  if (!s) throw new Error("wiki summary missing");
  return s;
}

async function backlinksOf(db: Database, actor: WikiActor, page: PageRow): Promise<WikiBacklink[]> {
  const rows = await db
    .select()
    .from(wikiLinks)
    .where(and(eq(wikiLinks.orgId, page.orgId), eq(wikiLinks.toPageId, page.id)))
    .orderBy(desc(wikiLinks.createdAt))
    .limit(200);
  const out: WikiBacklink[] = [];
  const pageIds = rows.filter((r) => r.fromType === "page" && r.fromId !== page.id).map((r) => r.fromId);
  if (pageIds.length) {
    const from = await db
      .select({ slug: wikiPages.slug, title: wikiPages.title, body: wikiPages.body })
      .from(wikiPages)
      .where(and(inArray(wikiPages.id, pageIds), isNull(wikiPages.deletedAt), visibleTo(actor)))
      .orderBy(asc(wikiPages.title));
    for (const p of from) out.push({ kind: "page", slug: p.slug, title: p.title, excerpt: excerpt(p.body, page) });
  }
  // Messages and issues only where the reader can see them (people: their channels and public ones).
  const viewer = actor.type === "person" ? actor.userId : null;
  const messageIds = rows.filter((r) => r.fromType === "message").map((r) => r.fromId);
  if (messageIds.length && viewer) {
    const found = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        body: messages.body,
        createdAt: messages.createdAt,
        channelName: channels.name,
        kind: channels.kind,
        dmKey: channels.dmKey,
        visibility: channels.visibility,
        memberId: channelMembers.id,
        admin: sql<boolean>`${adminChannelSql(sql`${channels.orgId}`, sql`${viewer}::text`)}`,
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, viewer)))
      .where(
        and(
          eq(messages.orgId, page.orgId),
          inArray(messages.id, messageIds),
          isNull(messages.deletedAt),
          isNull(channels.archivedAt),
        ),
      )
      .orderBy(desc(messages.createdAt));
    for (const m of found) {
      const admin = m.admin === true || String(m.admin) === "t";
      if (!(m.memberId || admin || (m.visibility === "public" && m.kind === "channel"))) continue;
      out.push({
        kind: "message",
        channelId: m.channelId,
        messageId: m.id,
        channelName: m.channelName,
        dm: m.kind === "dm" ? dmOther(m.dmKey, viewer) : null,
        excerpt: excerpt(m.body, page),
        at: m.createdAt.toISOString(),
      });
    }
  }
  const issueIds = rows.filter((r) => r.fromType === "issue").map((r) => r.fromId);
  if (issueIds.length && viewer) {
    const found = await db
      .select({ number: issues.number, title: issues.title })
      .from(issues)
      .where(
        and(eq(issues.orgId, page.orgId), inArray(issues.id, issueIds), taskSeenSql("issues", sql`${viewer}::text`)),
      )
      .orderBy(desc(issues.number));
    for (const i of found) {
      out.push({ kind: "issue", number: i.number, title: i.title });
    }
  }
  return out;
}

/** About 160 characters around the link. */
function excerpt(body: string, page: Pick<PageRow, "slug" | "aliases">) {
  const slugs = new Set([page.slug, ...page.aliases]);
  const ref = parseWikiLinks(body).find((r) => slugs.has(r.slug));
  const at = ref ? body.indexOf(`[[${ref.target}`) : -1;
  const start = Math.max(0, at - 60);
  const text = plainLine(body.slice(start, start + 160));
  return `${start > 0 ? "…" : ""}${text}${start + 160 < body.length ? "…" : ""}`;
}

async function detail(db: Database, actor: WikiActor, row: PageRow): Promise<WikiPageView> {
  const [summary, versions, backlinks, links, reads, rule, canEdit] = await Promise.all([
    summaryOf(db, row),
    db
      .select({
        type: wikiPageVersions.authorType,
        id: wikiPageVersions.authorId,
        requestedBy: wikiPageVersions.requestedByUserId,
        version: wikiPageVersions.version,
      })
      .from(wikiPageVersions)
      .where(eq(wikiPageVersions.pageId, row.id))
      .orderBy(desc(wikiPageVersions.version))
      .limit(500),
    backlinksOf(db, actor, row),
    resolveOwnLinks(db, actor, row),
    pageReads(db, row),
    ruleFor(db, row.orgId, row.folder),
    actor.type === "agent" ? agentEdits(actor.agentId, row) : edits(db, actor.userId, row),
  ]);
  const authors: WikiAuthor[] = [];
  const seen = new Set<string>();
  for (const v of versions) {
    const key = `${v.type}:${v.id}:${v.requestedBy ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push({
      type: v.type as WikiAuthor["type"],
      id: v.id,
      onBehalfOf: v.type === "agent" ? v.requestedBy : null,
    });
  }
  const first = versions.at(-1);
  return {
    ...summary,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    createdBy: {
      type: row.createdByType as WikiAuthor["type"],
      id: row.createdById,
      onBehalfOf: row.createdByType === "agent" && first?.version === 1 ? first.requestedBy : null,
    },
    authors,
    backlinks,
    folderAudience: folderAudienceOf(rule),
    canEdit,
    links,
    source: row.source ?? null,
    reads,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

const READ_WINDOW_DAYS = 7;
const since = (days: number) => new Date(Date.now() - days * 86_400_000);

async function pageReads(db: Executor, row: PageRow): Promise<WikiPageReads> {
  const from = since(READ_WINDOW_DAYS);
  const [byAgent, [last]] = await Promise.all([
    db
      .select({ agentId: wikiPageReads.agentId, count: sql<number>`count(*)::int` })
      .from(wikiPageReads)
      .innerJoin(agents, eq(agents.id, wikiPageReads.agentId))
      .where(and(eq(wikiPageReads.pageId, row.id), gte(wikiPageReads.createdAt, from), isNull(agents.archivedAt)))
      .groupBy(wikiPageReads.agentId)
      .orderBy(desc(sql`count(*)`)),
    db
      .select({
        agentId: wikiPageReads.agentId,
        channelId: wikiPageReads.channelId,
        at: wikiPageReads.createdAt,
        channelName: channels.name,
        kind: channels.kind,
        visibility: channels.visibility,
      })
      .from(wikiPageReads)
      .leftJoin(channels, eq(channels.id, wikiPageReads.channelId))
      .where(and(eq(wikiPageReads.pageId, row.id), gte(wikiPageReads.createdAt, from)))
      .orderBy(desc(wikiPageReads.createdAt))
      .limit(1),
  ]);
  const open = last?.kind === "channel" && last.visibility === "public";
  return {
    total: byAgent.reduce((n, r) => n + r.count, 0),
    agents: byAgent.map((r) => ({ agentId: r.agentId, count: r.count })),
    last: last
      ? {
          agentId: last.agentId,
          channelId: open ? last.channelId : null,
          channelName: open ? (last.channelName ?? null) : null,
          at: last.at.toISOString(),
        }
      : null,
  };
}

/**
 * Agents used these pages: in the run's context (`context`) or opened with `read_wiki_page` (`opened`, the default).
 * Best effort: never fails the run. Now and then drops reads older than 30 days.
 */
export async function recordWikiReads(
  db: Executor,
  input: {
    orgId: string;
    agentId: string;
    runId?: string | null;
    channelId?: string | null;
    pageIds: string[];
    kind?: "context" | "opened";
  },
) {
  const ids = [...new Set(input.pageIds)];
  if (ids.length === 0) return;
  try {
    await db.insert(wikiPageReads).values(
      ids.map((pageId) => ({
        orgId: input.orgId,
        pageId,
        agentId: input.agentId,
        runId: input.runId ?? null,
        channelId: input.channelId ?? null,
        kind: input.kind ?? "opened",
      })),
    );
    if (Math.random() < 0.02) {
      await db
        .delete(wikiPageReads)
        .where(and(eq(wikiPageReads.orgId, input.orgId), lt(wikiPageReads.createdAt, since(30))));
    }
  } catch {
    // Counting reads must never break an answer.
  }
}

/**
 * "What the agents read most": pages by how often agents opened them in the last 7 days, with the agents that did.
 * A page that only went into a run's context isn't counted: that is the search's choice, not the agent's.
 */
export async function topWikiReads(db: Database, actor: WikiActor, orgId: string, limit = 8) {
  await requireReader(db, actor, orgId);
  const rows = await db
    .select({
      pageId: wikiPageReads.pageId,
      agentId: wikiPageReads.agentId,
      count: sql<number>`count(*)::int`,
      slug: wikiPages.slug,
      title: wikiPages.title,
    })
    .from(wikiPageReads)
    .innerJoin(wikiPages, eq(wikiPages.id, wikiPageReads.pageId))
    .innerJoin(agents, eq(agents.id, wikiPageReads.agentId))
    .where(
      and(
        eq(wikiPageReads.orgId, orgId),
        eq(wikiPageReads.kind, "opened"),
        gte(wikiPageReads.createdAt, since(READ_WINDOW_DAYS)),
        isNull(wikiPages.deletedAt),
        isNull(agents.archivedAt),
        visibleTo(actor),
      ),
    )
    .groupBy(wikiPageReads.pageId, wikiPageReads.agentId, wikiPages.slug, wikiPages.title);
  const pages = new Map<
    string,
    { slug: string; title: string; total: number; agents: { agentId: string; count: number }[] }
  >();
  for (const r of rows) {
    const p = pages.get(r.pageId) ?? { slug: r.slug, title: r.title, total: 0, agents: [] };
    p.total += r.count;
    p.agents.push({ agentId: r.agentId, count: r.count });
    pages.set(r.pageId, p);
  }
  return [...pages.values()]
    .map((p) => ({ ...p, agents: p.agents.sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.total - a.total || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** The page's own links; a limited page the reader doesn't see shows as not written. */
async function resolveOwnLinks(db: Executor, actor: WikiActor, row: PageRow) {
  const refs = parseWikiLinks(row.body);
  const pages = await pagesBySlug(
    db,
    row.orgId,
    refs.map((r) => r.slug),
  );
  const hidden = [...pages.values()].filter((p) => p.restricted).map((p) => p.id);
  if (actor.type === "person" && hidden.length) {
    const seen = await visibleWikiPageIds(db, actor.userId, hidden);
    for (const [slug, p] of pages) if (p.restricted && !seen.has(p.id)) pages.delete(slug);
  }
  if (actor.type === "agent" && pages.size) {
    const seen = await visibleIds(
      db,
      actor,
      [...pages.values()].map((p) => p.id),
    );
    for (const [slug, p] of pages) if (!seen.has(p.id)) pages.delete(slug);
  }
  return refs.map((r) => {
    const p = pages.get(r.slug);
    return { target: r.target, slug: p?.slug ?? r.slug, title: p?.title ?? null, exists: Boolean(p) };
  });
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function addVersion(tx: Executor, page: PageRow, actor: WikiActor, note: string) {
  const author = authorCols(actor);
  await tx.insert(wikiPageVersions).values({
    orgId: page.orgId,
    pageId: page.id,
    version: page.version,
    title: page.title,
    body: page.body,
    folder: page.folder,
    tags: page.tags,
    authorType: author.type,
    authorId: author.id,
    requestedByUserId: author.requestedBy,
    note: note.slice(0, 500),
  });
}

/** Links that waited for this page (by its slug or earlier ones) now point to it. */
async function claimLinks(tx: Executor, page: Pick<PageRow, "id" | "orgId" | "slug" | "aliases">) {
  await tx
    .update(wikiLinks)
    .set({ toPageId: page.id })
    .where(
      and(
        eq(wikiLinks.orgId, page.orgId),
        isNull(wikiLinks.toPageId),
        inArray(wikiLinks.toSlug, [page.slug, ...page.aliases]),
      ),
    );
}

async function announce(
  deps: WikiDeps,
  orgId: string,
  page: WikiPageSummary,
  action:
    | "created"
    | "updated"
    | "renamed"
    | "moved"
    | "deleted"
    | "restored"
    | "locked"
    | "unlocked"
    | "pinned"
    | "unpinned"
    | "audience"
    | "context"
    | "imported",
  extra: Record<string, unknown> = {},
) {
  caches.contextPresence.delete(`${orgId}:wiki`);
  // The broadcast reaches every member: a restricted page goes out as its id alone (the apps refetch what they see).
  const shown = page.audience ? { id: page.id, restricted: true } : page;
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "wiki.page.updated", action, page: shown, ...(page.audience ? {} : extra) },
  });
}

/** A free slug for a new page: `deploy`, `deploy-2`… */
async function freeSlug(tx: Executor, orgId: string, wanted: string) {
  const base = wanted || "pagina";
  for (let n = 1; n < 200; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 76)}-${n}`;
    const [taken] = await tx
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, slug), isNull(wikiPages.deletedAt)));
    if (!taken) return slug;
  }
  throw new ConflictError("No free address for this page", "wiki.no_free_slug");
}

export interface WikiPageInput {
  title: string;
  body?: string;
  folder?: string;
  tags?: string[];
  /** Change note for the first version. */
  note?: string;
  source?: { type: string; id: string; channelId?: string } | null;
  /** Who sees it (ADR 0151), inside its folder's audience; left out, its folder's or everyone. */
  audience?: Audience;
}

/** The columns for an audience chosen at creation: whoever writes or asks stays in it. */
async function chosenCols(tx: Executor, actor: WikiActor, orgId: string, audience: Audience | undefined) {
  if (audience?.mode !== "people") return OPEN;
  const who = actor.type === "person" ? actor.userId : actor.requestedByUserId;
  const { userIds } = await cleanPeople(tx, orgId, {
    roleIds: [],
    userIds: [...audience.userIds, ...(who ? [who] : [])],
  });
  return { ...OPEN, restricted: true, audienceUserIds: userIds };
}

/** Creates a page. A title already in use gets `-2` etc. in its slug only when `allowDuplicate`. */
export async function createWikiPage(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  input: WikiPageInput,
  options: { allowDuplicate?: boolean } = {},
): Promise<WikiPageView> {
  const { db } = deps;
  await requireWriter(db, actor, orgId);
  const title = cleanTitle(input.title);
  const body = cleanBody(input.body);
  const folder = cleanFolder(
    input.folder ?? (input.title.includes("/") ? input.title.split("/").slice(0, -1).join("/") : ""),
  );
  // "Pasta/Título" names its folder only when no folder comes apart; with one, the whole title stays.
  const leafTitle =
    input.folder === undefined ? cleanTitle(title.split("/").pop() ?? title) : cleanTitle(keepSlashes(title));
  const author = authorCols(actor);
  const row = await db.transaction(async (tx) => {
    const wanted = wikiSlug(leafTitle);
    if (!wanted) throw new ValidationError("The title needs letters or numbers", "wiki.title_empty_slug");
    const existing = (await pagesBySlug(tx, orgId, [wanted])).get(wanted);
    // A restricted page the writer doesn't see takes the next free slug instead of naming itself in the conflict.
    const who = actor.type === "person" ? actor.userId : actor.requestedByUserId;
    const hidden =
      existing &&
      ((existing.restricted && who && !(await sees(tx, who, existing))) ||
        (actor.type === "agent" && !(await visibleIds(tx, actor, [existing.id])).has(existing.id)));
    if (existing && existing.slug === wanted && !options.allowDuplicate && !hidden) {
      throw new ConflictError(`A page "${existing.title}" already exists`, "slug_taken", {
        title: existing.title,
        slug: existing.slug,
      });
    }
    const slug = existing && existing.slug === wanted ? await freeSlug(tx, orgId, wanted) : wanted;
    const [page] = await tx
      .insert(wikiPages)
      .values({
        orgId,
        slug,
        title: leafTitle,
        body,
        folder,
        tags: cleanTags(input.tags) ?? [],
        ...(await placement(tx, orgId, folder, await chosenCols(tx, actor, orgId, input.audience))),
        source: input.source ?? null,
        createdByType: author.type,
        createdById: author.id,
        updatedByType: author.type,
        updatedById: author.id,
      })
      .returning();
    if (!page) throw new Error("wiki insert returned nothing");
    await requireStaysVisible(tx, actor, page);
    await addVersion(tx, page, actor, input.note ?? (await defaultNote(tx, actor, "created the page")));
    await syncWikiLinks(tx, orgId, { type: "page", id: page.id }, body);
    await claimLinks(tx, page);
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_created",
      target: { type: "wiki_page", id: page.id },
      details: { slug, title: leafTitle, ...(actor.type === "agent" ? { requestedBy: actor.requestedByUserId } : {}) },
    });
    return page;
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "created");
  return view;
}

export interface WikiImportNote {
  /** The note's name (the file name without `.md`). */
  title: string;
  /** Its folder in the vault (`Clientes/Varejo`). */
  folder?: string;
  body: string;
  tags?: string[];
  /** Frontmatter aliases: `[[Alias]]` links reach the page. */
  aliases?: string[];
  /** Attachments it embeds (`![[file.png]]`), already in the Drive: file name → artifact id. */
  attachments?: Record<string, string>;
}

export interface WikiImportInput {
  source: { type: "obsidian"; name: string };
  notes: WikiImportNote[];
  /** Put everything under this folder (empty = merge with the wiki's own folders). */
  folder?: string;
  /** A note named like a live page: a second page "Title (vault)", or leave it out. */
  onConflict: "keep_both" | "skip";
  /** The same for every batch and retry of one import: its pages keep it, so the import can be deleted as one. */
  importId?: string;
}

export const WIKI_IMPORT_MAX_NOTES = 500;

/** Obsidian allows `#`, `[`, `]` and `|` in some file names; our titles don't. */
const importTitle = (name: string) =>
  name
    .replace(/[[\]|#^]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, WIKI_LIMITS.title);

/**
 * Imports notes (an Obsidian vault, read by the app) as pages: one version
 * each ("imported from …"), folders, tags and aliases kept, `[[links]]`
 * resolved among the new pages and the existing ones. Notes that can't be
 * pages (no usable title, too long) come back in `failed` and the rest still
 * go in; tags, aliases and attachment names past their limits are cut. With
 * `importId`, a note that import already brought (same folder and title) isn't
 * made again: it comes back in `created`, so sending a batch twice is safe.
 */
export async function importWikiPages(
  deps: WikiDeps,
  userId: string,
  orgId: string,
  input: WikiImportInput,
): Promise<{
  created: WikiPageSummary[];
  skipped: string[];
  failed: { title: string; reason: "title" | "too_long" }[];
}> {
  const { db } = deps;
  const actor: WikiActor = { type: "person", userId };
  await requireWriter(db, actor, orgId);
  if (input.notes.length > WIKI_IMPORT_MAX_NOTES) {
    throw new ValidationError(`At most ${WIKI_IMPORT_MAX_NOTES} notes per request`, "wiki.import_too_many", {
      max: WIKI_IMPORT_MAX_NOTES,
    });
  }
  const sourceName = input.source.name.replace(/\s+/g, " ").trim().slice(0, 80) || "Obsidian";
  const base = cleanFolder(input.folder);
  const skipped: string[] = [];
  const failed: { title: string; reason: "title" | "too_long" }[] = [];
  const note = `imported from "${sourceName}"`;
  const rows = await db.transaction(async (tx) => {
    const made: PageRow[] = [];
    // A batch sent again (its answer was lost, or "Tentar de novo") finds its notes already in: they count as in, once.
    const mine = input.importId
      ? await tx
          .select()
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.orgId, orgId),
              isNull(wikiPages.deletedAt),
              eq(wikiPages.createdById, userId),
              sql`${wikiPages.source}->>'importId' = ${input.importId}`,
            ),
          )
      : [];
    const already = new Map(mine.map((p) => [`${p.folder}\n${p.title}`, p]));
    const again: PageRow[] = [];
    const rules = await tx.select().from(wikiFolderAudiences).where(eq(wikiFolderAudiences.orgId, orgId));
    for (const n of input.notes) {
      const raw = importTitle(n.title);
      const wanted = wikiSlug(raw);
      if (!raw || !wanted) {
        failed.push({ title: n.title, reason: "title" });
        continue;
      }
      if (n.body.length > WIKI_LIMITS.body) {
        failed.push({ title: raw, reason: "too_long" });
        continue;
      }
      let folder: string;
      try {
        folder = cleanFolder([base, n.folder ?? ""].filter(Boolean).join("/"));
      } catch {
        folder = base;
      }
      const sent =
        already.get(`${folder}\n${raw}`) ?? already.get(`${folder}\n${importTitle(`${raw} (${sourceName})`)}`);
      if (sent) {
        if (!again.includes(sent)) again.push(sent);
        continue;
      }
      const taken = (await pagesBySlug(tx, orgId, [wanted])).get(wanted);
      const before = taken && !made.some((m) => m.id === taken.id);
      if (before && input.onConflict === "skip") {
        skipped.push(raw);
        continue;
      }
      // A clash with a page that was there before: "Glossário (Acme Vault)". Within the vault, `-2`.
      const title = before ? importTitle(`${raw} (${sourceName})`) : raw;
      const slugWanted = wikiSlug(title);
      const slug = (await pagesBySlug(tx, orgId, [slugWanted])).has(slugWanted)
        ? await freeSlug(tx, orgId, slugWanted)
        : slugWanted;
      const aliases = [...new Set((n.aliases ?? []).map((a) => wikiSlug(a)).filter((a) => a && a !== slug))].slice(
        0,
        20,
      );
      const attachments = Object.fromEntries(
        Object.entries(n.attachments ?? {})
          .filter(([name]) => name.length <= 300)
          .slice(0, 200),
      );
      const [page] = await tx
        .insert(wikiPages)
        .values({
          orgId,
          slug,
          aliases,
          title,
          body: n.body,
          folder,
          tags: cleanTags(n.tags) ?? [],
          ...inherited(closestRule(rules, folder)),
          source: {
            type: input.source.type,
            id: sourceName,
            ...(input.importId ? { importId: input.importId } : {}),
            ...(Object.keys(attachments).length ? { attachments } : {}),
          },
          createdByType: "person",
          createdById: userId,
          updatedByType: "person",
          updatedById: userId,
        })
        .returning();
      if (!page) throw new Error("wiki insert returned nothing");
      if (page.restricted || page.editorsLimited) await requireStaysVisible(tx, actor, page);
      await addVersion(tx, page, actor, note);
      await syncWikiLinks(tx, orgId, { type: "page", id: page.id }, page.body);
      await claimLinks(tx, page);
      await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
      made.push(page);
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "wiki.imported",
      target: { type: "wiki", id: orgId },
      details: {
        source: input.source.type,
        name: sourceName,
        importId: input.importId ?? null,
        created: made.length,
        alreadyIn: again.length,
        skipped: skipped.length,
        failed: failed.length,
      },
    });
    return [...made, ...again];
  });
  const created = await summaries(db, rows);
  const first = created[0];
  if (first) await announce(deps, orgId, first, "imported", { count: created.length });
  return { created, skipped, failed };
}

/** "by Theo, at Walter's request: …" for agent edits; the given text for people. */
async function defaultNote(db: Executor, actor: WikiActor, what: string) {
  if (actor.type === "person") return what;
  const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, actor.agentId));
  const [person] = actor.requestedByUserId
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, actor.requestedByUserId))
    : [];
  return `by ${agent?.name ?? "agent"}${person ? `, at ${person.name}'s request` : ""}: ${what}`;
}

/** The notes `defaultNote` and the server write, by code (the author is shown apart, so only the action). */
const NOTE_PATTERNS: [RegExp, string, string[]][] = [
  [/^created the page$/, "created", []],
  [/^edited$/, "edited", []],
  [/^rewrote the section "(.*)"$/, "rewrote_section", ["section"]],
  [/^added a passage$/, "appended", []],
  [/^renamed from "(.*)" to "(.*)"$/, "renamed", ["from", "to"]],
  [/^link updated: "(.*)" → "(.*)"$/, "link_updated", ["from", "to"]],
  [/^moved to the root$/, "moved_root", []],
  [/^moved to "(.*)"$/, "moved", ["folder"]],
  [/^saved a message$/, "saved_message", []],
  [/^created from a message$/, "created_from_message", []],
  [/^imported from "(.*)"$/, "imported", ["source"]],
];

/** `noteCode`/`noteParams` of a version note the server wrote; nothing for a person's own note. */
export function wikiNoteDetail(note: string): { noteCode: string; noteParams: Record<string, string> } | null {
  const action = note.replace(/^by [^:]+: /, "");
  for (const [pattern, code, names] of NOTE_PATTERNS) {
    const m = pattern.exec(action);
    if (m) return { noteCode: code, noteParams: Object.fromEntries(names.map((n, i) => [n, m[i + 1] ?? ""])) };
  }
  return null;
}

export interface WikiPagePatch {
  /** The version being edited; a newer one on the server is a conflict. */
  baseVersion: number;
  title?: string;
  body?: string;
  folder?: string;
  tags?: string[];
  note?: string;
}

/** Saves an edit as a new version, if nobody saved since `baseVersion`. A new title doesn't change the slug (see rename). */
export async function updateWikiPage(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  ref: string,
  patch: WikiPagePatch,
): Promise<WikiPageView> {
  const { db } = deps;
  const current = await findPage(db, actor, orgId, ref);
  await requireWriter(db, actor, orgId, current);
  if (current.version !== patch.baseVersion) throw new WikiVersionConflictError(current.version);
  const next = {
    title: patch.title !== undefined ? cleanTitle(patch.title) : current.title,
    body: patch.body !== undefined ? cleanBody(patch.body) : current.body,
    folder: patch.folder !== undefined ? cleanFolder(patch.folder) : current.folder,
    tags: cleanTags(patch.tags) ?? current.tags,
  };
  const unchanged =
    next.title === current.title &&
    next.body === current.body &&
    next.folder === current.folder &&
    next.tags.join("\n") === current.tags.join("\n");
  if (unchanged) return detail(db, actor, current);
  const author = authorCols(actor);
  const row = await db.transaction(async (tx) => {
    const [page] = await tx
      .update(wikiPages)
      .set({
        ...next,
        // A move keeps the page's audience inside the folder it lands in; out of one it stays limited.
        ...(next.folder !== current.folder ? await placement(tx, orgId, next.folder, current) : {}),
        version: sql`${wikiPages.version} + 1`,
        updatedByType: author.type,
        updatedById: author.id,
        updatedAt: new Date(),
      })
      .where(and(eq(wikiPages.id, current.id), eq(wikiPages.version, patch.baseVersion), isNull(wikiPages.deletedAt)))
      .returning();
    if (!page) {
      const [now] = await tx.select({ version: wikiPages.version }).from(wikiPages).where(eq(wikiPages.id, current.id));
      throw new WikiVersionConflictError(now?.version ?? current.version);
    }
    if (next.folder !== current.folder) await requireStaysVisible(tx, actor, page);
    await addVersion(tx, page, actor, patch.note?.trim() || (await defaultNote(tx, actor, "edited")));
    if (next.body !== current.body) await syncWikiLinks(tx, orgId, { type: "page", id: page.id }, next.body);
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_updated",
      target: { type: "wiki_page", id: page.id },
      details: { version: page.version, ...(actor.type === "agent" ? { requestedBy: actor.requestedByUserId } : {}) },
    });
    return page;
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "updated");
  return view;
}

/** The body with `text` added: at the end, or at the end of the section `section` (created if missing). */
export function appendToSection(body: string, text: string, section?: string | null) {
  const add = text.trim();
  if (!section) return body.trim() ? `${body.replace(/\s+$/, "")}\n\n${add}\n` : `${add}\n`;
  const range = findSection(body, section);
  if (!range) return `${body.replace(/\s+$/, "")}${body.trim() ? "\n\n" : ""}## ${section.trim()}\n\n${add}\n`;
  const before = body.slice(0, range.end).replace(/\s+$/, "");
  const after = body.slice(range.end);
  return `${before}\n\n${add}\n${after ? `\n${after.replace(/^\s+/, "")}` : ""}`;
}

/** The body with the section's content replaced (heading kept; added at the end if missing). */
export function replaceSection(body: string, section: string, text: string) {
  const range = findSection(body, section);
  if (!range) return appendToSection(body, text, section);
  const after = body.slice(range.end);
  return `${body.slice(0, range.contentStart)}\n${text.trim()}\n${after ? `\n${after.replace(/^\s+/, "")}` : ""}`;
}

/** Where a `#`-heading section is: from its line to the next heading of the same or a higher level. */
function findSection(body: string, section: string) {
  const want = section.trim().toLowerCase();
  const lines = body.split("\n");
  let offset = 0;
  let start = -1;
  let level = 0;
  let contentStart = 0;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const hl = (h[1] as string).length;
      if (start >= 0 && hl <= level) return { start, contentStart, end: offset };
      if (start < 0 && (h[2] as string).trim().toLowerCase() === want) {
        start = offset;
        level = hl;
        contentStart = offset + line.length;
      }
    }
    offset += line.length + 1;
  }
  return start >= 0 ? { start, contentStart, end: body.length } : null;
}

/** Appends a block to a page (as a new version): agents, and "Save to wiki". */
export async function appendToWikiPage(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  ref: string,
  input: { text: string; section?: string | null; mode?: "append" | "replace_section"; note?: string },
) {
  const page = await findPage(deps.db, actor, orgId, ref);
  const body =
    input.mode === "replace_section" && input.section
      ? replaceSection(page.body, input.section, input.text)
      : appendToSection(page.body, input.text, input.section);
  return updateWikiPage(deps, actor, orgId, page.id, {
    baseVersion: page.version,
    body,
    note:
      input.note ??
      (await defaultNote(
        deps.db,
        actor,
        input.mode === "replace_section" ? `rewrote the section "${input.section}"` : "added a passage",
      )),
  });
}

/**
 * New title (and slug). Old links keep working (the old slug becomes an
 * alias) and the `[[…]]` in other pages are rewritten to the new title.
 */
export async function renameWikiPage(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  ref: string,
  input: { title: string },
): Promise<WikiPageView> {
  const { db } = deps;
  const current = await findPage(db, actor, orgId, ref);
  await requireWriter(db, actor, orgId, current);
  // Renaming never moves (moving has its own call): the whole title stays.
  const title = cleanTitle(keepSlashes(input.title));
  const wanted = wikiSlug(title);
  if (!wanted) throw new ValidationError("The title needs letters or numbers", "wiki.title_empty_slug");
  const author = authorCols(actor);
  const oldSlugs = new Set([current.slug, ...current.aliases]);
  const { row, touched } = await db.transaction(async (tx) => {
    let slug = current.slug;
    if (wanted !== current.slug) {
      const [taken] = await tx
        .select({ id: wikiPages.id, title: wikiPages.title, restricted: wikiPages.restricted })
        .from(wikiPages)
        .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, wanted), isNull(wikiPages.deletedAt)));
      const who = actor.type === "person" ? actor.userId : actor.requestedByUserId;
      // A page the renamer doesn't see is never named: the page takes the next free address instead.
      if (taken?.restricted && who && !(await sees(tx, who, taken))) slug = await freeSlug(tx, orgId, wanted);
      else if (taken)
        throw new ConflictError(`A page "${taken.title}" already uses this address`, "slug_taken", {
          title: taken.title,
        });
      else slug = wanted;
    }
    const aliases = [...new Set([...current.aliases, current.slug])].filter((a) => a !== slug).slice(-20);
    const [page] = await tx
      .update(wikiPages)
      .set({
        title,
        slug,
        aliases,
        version: sql`${wikiPages.version} + 1`,
        updatedByType: author.type,
        updatedById: author.id,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, current.id))
      .returning();
    if (!page) throw new NotFoundError("Page not found", "wiki.page_not_found");
    await addVersion(tx, page, actor, await defaultNote(tx, actor, `renamed from "${current.title}" to "${title}"`));
    await claimLinks(tx, page);
    // Pages that link here: rewrite their `[[…]]` to the new title, as a new version each. Not for a restricted
    // page: its new title would land in pages its audience doesn't cover, and the old slug resolves as an alias.
    const linking =
      current.restricted || current.agentsLimited
        ? []
        : await tx
            .select({ id: wikiLinks.fromId })
            .from(wikiLinks)
            .where(and(eq(wikiLinks.orgId, orgId), eq(wikiLinks.fromType, "page"), eq(wikiLinks.toPageId, page.id)));
    const touched: string[] = [];
    for (const { id } of linking) {
      const [other] = await tx
        .select()
        .from(wikiPages)
        .where(and(eq(wikiPages.id, id), isNull(wikiPages.deletedAt)));
      if (!other) continue;
      const body = rewriteLinks(other.body, oldSlugs, title);
      if (body === other.body) continue;
      const [saved] = await tx
        .update(wikiPages)
        .set({ body, version: sql`${wikiPages.version} + 1`, updatedAt: new Date() })
        .where(eq(wikiPages.id, other.id))
        .returning();
      if (!saved) continue;
      await addVersion(tx, saved, actor, `link updated: "${current.title}" → "${title}"`);
      await syncWikiLinks(tx, orgId, { type: "page", id: saved.id }, saved.body);
      await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: saved.id });
      touched.push(saved.id);
    }
    // The page's own row, re-read in case it linked to itself.
    const [fresh] = await tx.select().from(wikiPages).where(eq(wikiPages.id, page.id));
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_renamed",
      target: { type: "wiki_page", id: page.id },
      details: {
        from: { title: current.title, slug: current.slug },
        to: { title, slug },
        linksUpdated: touched.length,
      },
    });
    return { row: fresh ?? page, touched };
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "renamed", { previousSlug: current.slug, updatedPageIds: touched });
  return view;
}

/** `[[Old#section|text]]` → `[[New#section|text]]` for links to any of `slugs` (code is left alone). */
export function rewriteLinks(body: string, slugs: Set<string>, newTitle: string) {
  const parts = body.split(/(```[\s\S]*?```|`[^`\n]*`)/);
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/\[\[([^[\]\n]+)\]\]/g, (whole, inner: string) => {
            const bar = inner.indexOf("|");
            const target = bar >= 0 ? inner.slice(0, bar) : inner;
            const hash = target.indexOf("#");
            const title = (hash >= 0 ? target.slice(0, hash) : target).trim();
            if (!slugs.has(wikiSlug(title))) return whole;
            const folder = title.includes("/") ? `${title.split("/").slice(0, -1).join("/")}/` : "";
            const section = hash >= 0 ? target.slice(hash) : "";
            const label = bar >= 0 ? inner.slice(bar) : "";
            return `[[${folder}${newTitle}${section}${label}]]`;
          }),
    )
    .join("");
}

/** Moves a page to another folder ("" = the root). */
export async function moveWikiPage(deps: WikiDeps, actor: WikiActor, orgId: string, ref: string, folder: string) {
  const page = await findPage(deps.db, actor, orgId, ref);
  const view = await updateWikiPage(deps, actor, orgId, page.id, {
    baseVersion: page.version,
    folder,
    note: await defaultNote(
      deps.db,
      actor,
      cleanFolder(folder) ? `moved to "${cleanFolder(folder)}"` : "moved to the root",
    ),
  });
  await recordAudit(deps.db, {
    orgId,
    actor: auditActor(actor),
    action: "wiki.page_moved",
    target: { type: "wiki_page", id: page.id },
    details: { from: page.folder, to: view.folder },
  });
  return view;
}

/**
 * Soft delete: links to it show as missing; restore brings it back. It leaves the agents' context for good, so a
 * restore never pushes the workspace past `WIKI_CONTEXT_MAX`.
 */
export async function deleteWikiPage(deps: WikiDeps, actor: WikiActor, orgId: string, ref: string) {
  const { db } = deps;
  const page = await findPage(db, actor, orgId, ref);
  await requireWriter(db, actor, orgId, page);
  const row = await db.transaction(async (tx) => {
    const [deleted] = await tx
      .update(wikiPages)
      .set({ deletedAt: new Date(), updatedAt: new Date(), agentContext: false })
      .where(eq(wikiPages.id, page.id))
      .returning();
    await tx.update(wikiLinks).set({ toPageId: null }).where(eq(wikiLinks.toPageId, page.id));
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_deleted",
      target: { type: "wiki_page", id: page.id },
      details: { slug: page.slug, title: page.title },
    });
    return deleted ?? page;
  });
  await announce(deps, orgId, await summaryOf(db, row), "deleted");
}

/** Brings a deleted page back (by id, or the most recently deleted page with that slug). */
export async function restoreWikiPage(deps: WikiDeps, actor: WikiActor, orgId: string, ref: string) {
  const { db } = deps;
  const page = await findPage(db, actor, orgId, ref, { deleted: true });
  await requireWriter(db, actor, orgId, page);
  const row = await db.transaction(async (tx) => {
    const [taken] = await tx
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, page.slug), isNull(wikiPages.deletedAt)));
    // No title: the page holding the address may be one the restorer doesn't see.
    if (taken) throw new ConflictError("Another page uses this address: rename it first", "wiki.restore_slug_taken");
    const [restored] = await tx
      .update(wikiPages)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(wikiPages.id, page.id))
      .returning();
    if (!restored) throw new NotFoundError("Page not found", "wiki.page_not_found");
    await claimLinks(tx, restored);
    await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: page.id });
    await recordAudit(tx, {
      orgId,
      actor: auditActor(actor),
      action: "wiki.page_restored",
      target: { type: "wiki_page", id: page.id },
      details: { slug: page.slug },
    });
    return restored;
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "restored");
  return view;
}

// ── Many pages at once, and the trash ────────────────────────────────────────

/**
 * Deleted pages stay in the trash this long, as the Drive's files do (ADR 0111); then they are gone for good. A
 * re-export, read when used: `artifacts` imports this module through a cycle, so a copy here would read it unset.
 */
export { ARTIFACT_TRASH_DAYS as WIKI_TRASH_DAYS } from "./artifacts";

/** What "Apagar" reaches: chosen pages, a folder with its subfolders, or one import. */
export type WikiBulkTarget =
  | { ids: string[] }
  | { folder: string }
  | { importId: string }
  /** An import made before imports had ids: every page from that vault without one. */
  | { source: { type: string; name: string } };

const inTrashWindow = () => sql`${wikiPages.deletedAt} > ${since(ARTIFACT_TRASH_DAYS).toISOString()}::timestamptz`;

function targetSql(target: WikiBulkTarget | { all: true }) {
  if ("all" in target) return sql`true`;
  if ("ids" in target) {
    const ids = target.ids.filter((id) => UUID.test(id));
    return ids.length ? inArray(wikiPages.id, ids) : sql`false`;
  }
  if ("folder" in target) {
    const folder = cleanFolder(target.folder);
    if (!folder) throw new ValidationError("Choose a folder", "wiki.folder_required");
    return sql`(${wikiPages.folder} = ${folder} or starts_with(${wikiPages.folder}, ${`${folder}/`}))`;
  }
  if ("importId" in target) return sql`${wikiPages.source}->>'importId' = ${target.importId}`;
  return sql`(${wikiPages.source}->>'type' = ${target.source.type} and ${wikiPages.source}->>'id' = ${target.source.name}
    and ${wikiPages.source}->>'importId' is null)`;
}

/**
 * The pages of `target` (live, or in the trash with `deleted`) that this person may delete or restore: pages they
 * see, not locked unless they configure the workspace, and with them on the editors' list if it has one.
 */
async function pagesToChange(
  db: Database,
  userId: string,
  orgId: string,
  target: WikiBulkTarget | { all: true },
  deleted: boolean,
) {
  const actor: WikiActor = { type: "person", userId };
  const membership = await requireWriter(db, actor, orgId);
  const rows = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.orgId, orgId),
        deleted ? inTrashWindow() : isNull(wikiPages.deletedAt),
        targetSql(target),
        visibleTo(actor),
      ),
    )
    .limit(5000);
  const admin = membership !== null && can(membership, "configure");
  const mine: PageRow[] = [];
  for (const row of rows) if ((!row.locked || admin) && (await edits(db, userId, row))) mine.push(row);
  return { mine, kept: rows.length - mine.length };
}

/** One event for many pages: every member's app reads the wiki again (a page's title may be for some only). */
async function announceMany(deps: WikiDeps, orgId: string, action: "deleted" | "restored" | "audience") {
  caches.contextPresence.delete(`${orgId}:wiki`);
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "wiki.page.updated", action, page: { id: "", restricted: true } },
  });
}

/**
 * "Apagar" for many pages (a selection, a folder with its subfolders, or one import): they go to the trash together,
 * as `deleteWikiPage` sends one. Pages this person may not delete stay where they are and are counted in `kept`.
 */
export async function deleteWikiPages(deps: WikiDeps, userId: string, orgId: string, target: WikiBulkTarget) {
  const { db } = deps;
  const { mine, kept } = await pagesToChange(db, userId, orgId, target, false);
  if (mine.length === 0) return { deleted: 0, kept };
  const ids = mine.map((p) => p.id);
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(wikiPages)
      .set({ deletedAt: now, updatedAt: now, agentContext: false })
      .where(inArray(wikiPages.id, ids));
    await tx.update(wikiLinks).set({ toPageId: null }).where(inArray(wikiLinks.toPageId, ids));
    for (const id of ids) await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "wiki.pages_deleted",
      target: { type: "wiki", id: orgId },
      details: {
        target: "ids" in target ? { ids: target.ids.length } : target,
        count: ids.length,
        slugs: mine.slice(0, 50).map((p) => p.slug),
      },
    });
  });
  await announceMany(deps, orgId, "deleted");
  return { deleted: ids.length, kept };
}

/**
 * "Restaurar" for many pages of the trash. A page whose address a live page took since stays in the trash, in
 * `failed` with `wiki.restore_slug_taken` (rename the live one first).
 */
export async function restoreWikiPages(deps: WikiDeps, userId: string, orgId: string, ids: string[]) {
  const { db } = deps;
  const { mine, kept } = await pagesToChange(db, userId, orgId, { ids }, true);
  const failed: { id: string; title: string; code: string }[] = [];
  let restored = 0;
  await db.transaction(async (tx) => {
    for (const page of mine) {
      const [taken] = await tx
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.slug, page.slug), isNull(wikiPages.deletedAt)));
      if (taken) {
        failed.push({ id: page.id, title: page.title, code: "wiki.restore_slug_taken" });
        continue;
      }
      const [row] = await tx
        .update(wikiPages)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(and(eq(wikiPages.id, page.id), sql`${wikiPages.deletedAt} is not null`))
        .returning();
      if (!row) continue;
      await claimLinks(tx, row);
      await enqueueIndex(tx, { orgId, kind: "wiki", sourceId: row.id });
      restored++;
    }
    if (restored > 0)
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: userId },
        action: "wiki.pages_restored",
        target: { type: "wiki", id: orgId },
        details: { count: restored },
      });
  });
  if (restored > 0) await announceMany(deps, orgId, "restored");
  return { restored, kept, failed };
}

/**
 * "Apagar para sempre" (`ids`) or "Esvaziar lixeira" (none): pages in the trash are removed with their history now,
 * as the purge would after `WIKI_TRASH_DAYS`. Only the pages this person could restore.
 */
export async function purgeWikiPages(deps: WikiDeps, userId: string, orgId: string, ids?: string[]) {
  const { db } = deps;
  const { mine, kept } = await pagesToChange(db, userId, orgId, ids ? { ids } : { all: true }, true);
  if (mine.length === 0) return { purged: 0, kept };
  await db.transaction(async (tx) => {
    await tx.delete(wikiPages).where(
      and(
        inArray(
          wikiPages.id,
          mine.map((p) => p.id),
        ),
        sql`${wikiPages.deletedAt} is not null`,
      ),
    );
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "wiki.pages_purged",
      target: { type: "wiki", id: orgId },
      details: { count: mine.length, titles: mine.slice(0, 50).map((p) => p.title) },
    });
  });
  return { purged: mine.length, kept };
}

/** Job: pages in the trash longer than `WIKI_TRASH_DAYS` are removed with their history. */
export async function purgeDeletedWikiPages(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - ARTIFACT_TRASH_DAYS * 86_400_000).toISOString();
  const gone = await db
    .delete(wikiPages)
    .where(
      inArray(
        wikiPages.id,
        db
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(sql`${wikiPages.deletedAt} is not null and ${wikiPages.deletedAt} < ${cutoff}::timestamptz`)
          .limit(500),
      ),
    )
    .returning({ id: wikiPages.id });
  return gone.length;
}

/**
 * The agents' access for many pages at once (a selection of the root's pages, say): `agentIds` only those agents read
 * them, null every agent. Who sees each page among people stays as it was. Pages this person may not change are in
 * `failed` with the reason.
 */
export async function setWikiPagesAgents(
  deps: WikiDeps,
  userId: string,
  orgId: string,
  ids: string[],
  agentIds: string[] | null,
) {
  const { db } = deps;
  await requireAudienceChooser(db, userId, orgId);
  const rows = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.orgId, orgId),
        isNull(wikiPages.deletedAt),
        targetSql({ ids }),
        visibleTo({ type: "person", userId }),
      ),
    );
  let changed = 0;
  const failed: { id: string; title: string; code: string }[] = [];
  for (const row of rows) {
    const people = row.restricted ? { roleIds: row.audienceRoleIds, userIds: row.audienceUserIds } : null;
    try {
      await setWikiPageAudience({ db }, userId, orgId, row.id, people, agentIds);
      changed++;
    } catch (e) {
      failed.push({ id: row.id, title: row.title, code: (e as { code?: string }).code ?? "error" });
    }
  }
  if (changed > 0) await announceMany(deps, orgId, "audience");
  return { changed, failed };
}

/** At most this many pages are always in the agents' context: each takes up to `WIKI_PAGE_CHARS` of every run. */
export const WIKI_CONTEXT_MAX = 3;

/**
 * "Sempre no contexto dos agentes": every run of an agent that reads the page gets it, within the wiki's budget, as
 * if the message had named it. People who edit the page may set it; at most `WIKI_CONTEXT_MAX` per workspace.
 */
export async function setWikiPageAgentContext(deps: WikiDeps, userId: string, orgId: string, ref: string, on: boolean) {
  const { db } = deps;
  const actor: WikiActor = { type: "person", userId };
  const page = await findPage(db, actor, orgId, ref);
  await requireWriter(db, actor, orgId, page);
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wiki-context:${orgId}`}))`);
    if (on && !page.agentContext) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(wikiPages)
        .where(and(eq(wikiPages.orgId, orgId), eq(wikiPages.agentContext, true), isNull(wikiPages.deletedAt)));
      if (n >= WIKI_CONTEXT_MAX) {
        throw new ValidationError(
          `At most ${WIKI_CONTEXT_MAX} pages are always in the agents' context`,
          "wiki.context_full",
          { max: WIKI_CONTEXT_MAX },
        );
      }
    }
    const [updated] = await tx.update(wikiPages).set({ agentContext: on }).where(eq(wikiPages.id, page.id)).returning();
    if (!updated) throw new NotFoundError("Page not found", "wiki.page_not_found");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: on ? "wiki.page_in_context" : "wiki.page_out_of_context",
      target: { type: "wiki_page", id: page.id },
      details: { slug: page.slug },
    });
    return updated;
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "context");
  return view;
}

/** Admins lock (only admins edit) or unlock a page. */
export async function setWikiPageLock(deps: WikiDeps, userId: string, orgId: string, ref: string, locked: boolean) {
  const { db } = deps;
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!can(membership, "configure")) throw new ForbiddenError("Only admins lock pages", "wiki.lock_admins_only");
  const page = await findPage(db, { type: "person", userId }, orgId, ref);
  const [row] = await db.update(wikiPages).set({ locked }).where(eq(wikiPages.id, page.id)).returning();
  if (!row) throw new NotFoundError("Page not found", "wiki.page_not_found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: locked ? "wiki.page_locked" : "wiki.page_unlocked",
    target: { type: "wiki_page", id: page.id },
    details: { slug: page.slug },
  });
  const view = await detail(db, { type: "person", userId }, row);
  await announce(deps, orgId, view, locked ? "locked" : "unlocked");
  return view;
}

/** Pins a page to the top of the wiki (or unpins it). Members who write can do it. */
export async function setWikiPagePinned(deps: WikiDeps, userId: string, orgId: string, ref: string, pinned: boolean) {
  const { db } = deps;
  const actor: WikiActor = { type: "person", userId };
  await requireWriter(db, actor, orgId);
  const page = await findPage(db, actor, orgId, ref);
  const [row] = await db.update(wikiPages).set({ pinned }).where(eq(wikiPages.id, page.id)).returning();
  if (!row) throw new NotFoundError("Page not found", "wiki.page_not_found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: pinned ? "wiki.page_pinned" : "wiki.page_unpinned",
    target: { type: "wiki_page", id: page.id },
    details: { slug: page.slug },
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, pinned ? "pinned" : "unpinned");
  return view;
}

/** People who may choose who sees a page or a folder. */
async function requireAudienceChooser(db: Database, userId: string, orgId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!(can(membership, "edit_wiki") && can(membership, "manage_roles"))) {
    throw new ForbiddenError(
      "Only people who edit the wiki and manage roles choose who sees a page",
      "wiki.audience_forbidden",
    );
  }
  return membership;
}

/** Only the roles and people of this workspace. */
async function cleanPeople(db: Executor, orgId: string, list: WikiAudience) {
  const wantedRoles = [...new Set(list.roleIds)].filter((id) => UUID.test(id));
  const wantedUsers = [...new Set(list.userIds)];
  const roleIds = wantedRoles.length
    ? (
        await db
          .select({ id: orgRoles.id })
          .from(orgRoles)
          .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, wantedRoles)))
      ).map((r) => r.id)
    : [];
  const userIds = wantedUsers.length
    ? (
        await db
          .select({ id: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, wantedUsers)))
      ).map((r) => r.id)
    : [];
  return { roleIds, userIds };
}

/** Only this workspace's active agents. */
async function cleanAgents(db: Executor, orgId: string, ids: string[]) {
  const wanted = [...new Set(ids)].filter((id) => UUID.test(id));
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), inArray(agents.id, wanted)));
  return rows.map((r) => r.id);
}

/** Whether the chooser is in this list, as a person or through a role. */
async function includes(db: Executor, orgId: string, userId: string, list: { roleIds: string[]; userIds: string[] }) {
  return list.userIds.includes(userId) || (await roleHolders(db, orgId, list.roleIds)).has(userId);
}

/**
 * The columns for an audience, keeping only roles, people and agents of this workspace. Whoever sets it stays able to
 * see and edit, so nobody takes a page from themselves. `agents` or `edit` undefined keeps `keep`'s (an older app
 * doesn't send them).
 */
async function audienceCols(
  db: Executor,
  orgId: string,
  chooser: { userId: string; admin: boolean },
  audience: WikiAudience | null,
  chosen: string[] | null | undefined,
  edit: WikiEditors | undefined,
  keep: AudienceCols,
): Promise<AudienceCols> {
  const people = audience ? await cleanPeople(db, orgId, audience) : { roleIds: [], userIds: [] };
  if (audience && !chooser.admin && !(await includes(db, orgId, chooser.userId, people))) {
    throw new ValidationError(
      "Keep yourself in the audience (one of your roles, or you)",
      "wiki.audience_excludes_you",
    );
  }
  const limited = chosen === undefined ? keep.agentsLimited : chosen !== null;
  const agentIds = limited
    ? await cleanAgents(db, orgId, chosen === undefined ? keep.audienceAgentIds : (chosen ?? []))
    : [];
  const editorsChosen = edit === undefined ? keep.editorsLimited : edit.editors !== null;
  const editors = !editorsChosen
    ? { roleIds: [], userIds: [] }
    : await cleanPeople(
        db,
        orgId,
        edit === undefined
          ? { roleIds: keep.editorRoleIds, userIds: keep.editorUserIds }
          : (edit.editors ?? { roleIds: [], userIds: [] }),
      );
  if (editorsChosen && !chooser.admin && !(await includes(db, orgId, chooser.userId, editors))) {
    throw new ValidationError("Keep yourself among the people who edit", "wiki.editors_exclude_you");
  }
  const agentEditorsChosen = edit === undefined ? keep.agentEditorsLimited : edit.agentEditorIds !== null;
  const agentEditorIds = agentEditorsChosen
    ? await cleanAgents(db, orgId, edit === undefined ? keep.agentEditorIds : (edit.agentEditorIds ?? []))
    : [];
  return {
    restricted: Boolean(audience),
    audienceRoleIds: people.roleIds,
    audienceUserIds: people.userIds,
    agentsLimited: limited,
    audienceAgentIds: agentIds,
    editorsLimited: editorsChosen,
    editorRoleIds: editors.roleIds,
    editorUserIds: editors.userIds,
    agentEditorsLimited: agentEditorsChosen,
    agentEditorIds,
  };
}

/** `a` may only be narrower than the folder above it. */
async function requireInsideFolder(db: Executor, orgId: string, a: AudienceCols, rule: FolderRule | null) {
  if (!rule) return;
  if (!sameAudience(clampTo(a, rule, await heldOf(db, orgId, rule)), a)) {
    throw new ValidationError(
      "A page or subfolder can only be narrower than its folder: change the folder instead",
      "wiki.audience_wider_than_folder",
      { folder: rule.folder },
    );
  }
}

/**
 * Limits a page to an audience (or opens it again with `null`): besides administrators, only the people holding one of
 * `roleIds` and the people in `userIds` see it, with `agents` only those agents read it (`null` = every agent), and
 * `edit` says who edits among them. Who may: anyone who edits the page (ADR 0151), for who sees it; choosing agents or
 * editors takes managing roles too. Only an audience they stay in, so nobody hides a page from themselves. Inside a
 * limited folder it can only be narrower.
 */
export async function setWikiPageAudience(
  deps: WikiDeps,
  userId: string,
  orgId: string,
  ref: string,
  audience: WikiAudience | null,
  agents?: string[] | null,
  edit?: WikiEditors,
) {
  const { db } = deps;
  const actor: WikiActor = { type: "person", userId };
  const membership =
    agents === undefined && edit === undefined
      ? await requireActiveMembership(db, userId, orgId)
      : await requireAudienceChooser(db, userId, orgId);
  const page = await findPage(db, actor, orgId, ref);
  await requireWriter(db, actor, orgId, page);
  await requireEditor(db, actor, page);
  const cols = await audienceCols(
    db,
    orgId,
    { userId, admin: can(membership, "administrator") },
    audience,
    agents,
    edit,
    page,
  );
  const rule = await ruleFor(db, orgId, page.folder);
  await requireInsideFolder(db, orgId, cols, rule);
  const [row] = await db
    .update(wikiPages)
    .set({ ...cols, audienceFolder: rule && sameAudience(cols, rule) ? rule.folder : null })
    .where(eq(wikiPages.id, page.id))
    .returning();
  if (!row) throw new NotFoundError("Page not found", "wiki.page_not_found");
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: isLimited(cols) ? "wiki.page_restricted" : "wiki.page_opened",
    target: { type: "wiki_page", id: page.id },
    details: {
      slug: page.slug,
      roleIds: cols.audienceRoleIds,
      userIds: cols.audienceUserIds,
      agentIds: cols.agentsLimited ? cols.audienceAgentIds : null,
      editors: cols.editorsLimited ? { roleIds: cols.editorRoleIds, userIds: cols.editorUserIds } : null,
      agentEditorIds: cols.agentEditorsLimited ? cols.agentEditorIds : null,
    },
  });
  const view = await detail(db, actor, row);
  await announce(deps, orgId, view, "audience");
  return view;
}

/** The audience set on `folder` itself, and the closest one above it (for the dialog). */
export async function getWikiFolderAudience(db: Database, userId: string, orgId: string, folder: string) {
  const membership = await requireAudienceChooser(db, userId, orgId);
  const path = cleanFolder(folder);
  const rules = await db
    .select()
    .from(wikiFolderAudiences)
    .where(and(eq(wikiFolderAudiences.orgId, orgId), inArray(wikiFolderAudiences.folder, folderChain(path))));
  await requireInsideRule(db, { userId, admin: can(membership, "administrator") }, orgId, closestRule(rules, path));
  return {
    own: folderAudienceOf(rules.find((r) => r.folder === path) ?? null),
    above: folderAudienceOf(ruleAbove(rules, path)),
  };
}

const parentFolder = (folder: string) => folder.split("/").slice(0, -1).join("/");

/** The closest rule above `folder`: the root ("") has none. */
const ruleAbove = (rules: FolderRule[], folder: string) => (folder ? closestRule(rules, parentFolder(folder)) : null);

const isLimited = (a: AudienceCols) => a.restricted || a.agentsLimited || a.editorsLimited || a.agentEditorsLimited;

/** A limited folder is only for people who see it, and changing it for those who edit it (and administrators). */
async function requireInsideRule(
  db: Executor,
  who: { userId: string; admin: boolean },
  orgId: string,
  rule: FolderRule | null,
) {
  if (who.admin || !rule) return;
  const list = { roleIds: rule.audienceRoleIds, userIds: rule.audienceUserIds };
  if (rule.restricted && !(await includes(db, orgId, who.userId, list))) throw noAccess();
  const editors = { roleIds: rule.editorRoleIds, userIds: rule.editorUserIds };
  if (rule.editorsLimited && !(await includes(db, orgId, who.userId, editors))) {
    throw new ForbiddenError("Only the people chosen edit this folder", "wiki.edit_limited");
  }
}

/**
 * Sets a folder's audience (both `null` opens it): it reaches the pages in it and its subfolders, and a page created
 * or moved in takes it. A page keeps its own narrower audience, cut to fit; opening a folder opens only the pages that
 * followed it. Each page holds a copy, so one condition over `wiki_pages` keeps deciding who sees what.
 */
export async function setWikiFolderAudience(
  deps: WikiDeps,
  userId: string,
  orgId: string,
  folder: string,
  audience: WikiAudience | null,
  agents: string[] | null,
  edit: WikiEditors = { editors: null, agentEditorIds: null },
) {
  const { db } = deps;
  const membership = await requireAudienceChooser(db, userId, orgId);
  const path = cleanFolder(folder);
  const chooser = { userId, admin: can(membership, "administrator") };
  const cols = await audienceCols(db, orgId, chooser, audience, agents, edit, OPEN);
  const limited = isLimited(cols);
  const changed = await db.transaction(async (tx) => {
    // One change at a time per workspace: two saves can't leave a page on a rule that was replaced.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`wiki-folders:${orgId}`}))`);
    await requireInsideRule(tx, chooser, orgId, await ruleFor(tx, orgId, path));
    if (limited) {
      if (path) await requireInsideFolder(tx, orgId, cols, await ruleFor(tx, orgId, parentFolder(path)));
      await tx
        .insert(wikiFolderAudiences)
        .values({ orgId, folder: path, ...cols, updatedById: userId })
        .onConflictDoUpdate({
          target: [wikiFolderAudiences.orgId, wikiFolderAudiences.folder],
          set: { ...cols, updatedById: userId, updatedAt: new Date() },
        });
    } else {
      await tx
        .delete(wikiFolderAudiences)
        .where(and(eq(wikiFolderAudiences.orgId, orgId), eq(wikiFolderAudiences.folder, path)));
    }
    const count = await reapplyFolder(tx, orgId, path);
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: limited ? "wiki.folder_restricted" : "wiki.folder_opened",
      target: { type: "wiki_folder", id: path },
      details: {
        roleIds: cols.audienceRoleIds,
        userIds: cols.audienceUserIds,
        agentIds: cols.agentsLimited ? cols.audienceAgentIds : null,
        editors: cols.editorsLimited ? { roleIds: cols.editorRoleIds, userIds: cols.editorUserIds } : null,
        agentEditorIds: cols.agentEditorsLimited ? cols.agentEditorIds : null,
        pages: count,
      },
    });
    return count;
  });
  caches.contextPresence.delete(`${orgId}:wiki`);
  // No page in it: this reaches every member, and the folder's name may be for some of them only.
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "wiki.page.updated", action: "audience", page: { id: "", restricted: true } },
  });
  return { folder: path, pages: changed };
}

/** After `path` changed: its subfolders' audiences and every page under it, deleted ones too, follow. */
async function reapplyFolder(tx: Executor, orgId: string, path: string) {
  // The root ("") holds every page and folder.
  const under = path
    ? sql`(${wikiPages.folder} = ${path} or starts_with(${wikiPages.folder}, ${`${path}/`}))`
    : sql`true`;
  const rules = await tx.select().from(wikiFolderAudiences).where(eq(wikiFolderAudiences.orgId, orgId));
  const holders = new Map<string, { audience: Set<string>; editors: Set<string> }>();
  const heldBy = async (rule: FolderRule) => {
    const known = holders.get(rule.id);
    if (known) return known;
    const held = await heldOf(tx, orgId, rule);
    holders.set(rule.id, held);
    return held;
  };
  // Closest to `path` first, so a subfolder is cut to its already-cut parent.
  const nested = rules
    .filter((r) => (path ? r.folder.startsWith(`${path}/`) : r.folder !== ""))
    .sort((a, b) => a.folder.split("/").length - b.folder.split("/").length);
  for (const rule of nested) {
    const above = ruleAbove(rules, rule.folder);
    if (!above) continue;
    const kept = clampTo(rule, above, await heldBy(above));
    if (sameAudience(kept, rule)) continue;
    Object.assign(rule, kept);
    await tx.update(wikiFolderAudiences).set(kept).where(eq(wikiFolderAudiences.id, rule.id));
  }
  const pages = await tx
    .select({
      id: wikiPages.id,
      folder: wikiPages.folder,
      audienceFolder: wikiPages.audienceFolder,
      restricted: wikiPages.restricted,
      audienceRoleIds: wikiPages.audienceRoleIds,
      audienceUserIds: wikiPages.audienceUserIds,
      agentsLimited: wikiPages.agentsLimited,
      audienceAgentIds: wikiPages.audienceAgentIds,
      editorsLimited: wikiPages.editorsLimited,
      editorRoleIds: wikiPages.editorRoleIds,
      editorUserIds: wikiPages.editorUserIds,
      agentEditorsLimited: wikiPages.agentEditorsLimited,
      agentEditorIds: wikiPages.agentEditorIds,
    })
    .from(wikiPages)
    .where(and(eq(wikiPages.orgId, orgId), under));
  let changed = 0;
  for (const page of pages) {
    const rule = closestRule(rules, page.folder);
    // A page that followed a folder has no audience of its own: it takes the closest one left, or opens.
    const base = page.audienceFolder !== null ? OPEN : page;
    const cols = rule ? clampTo(base, rule, await heldBy(rule)) : page.audienceFolder !== null ? OPEN : colsOf(page);
    const audienceFolder = rule && sameAudience(cols, rule) ? rule.folder : null;
    if (sameAudience(cols, page) && audienceFolder === page.audienceFolder) continue;
    await tx
      .update(wikiPages)
      .set({ ...colsOf(cols), audienceFolder })
      .where(eq(wikiPages.id, page.id));
    changed++;
  }
  return changed;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getWikiPage(db: Database, actor: WikiActor, orgId: string, ref: string) {
  await requireReader(db, actor, orgId);
  return detail(db, actor, await findPage(db, actor, orgId, ref));
}

/** Pages (no bodies): all of them, or by folder (and its subfolders), tag or title words; most recent first. */
export async function listWikiPages(
  db: Database,
  actor: WikiActor,
  orgId: string,
  filters: { folder?: string; tag?: string; q?: string; deleted?: boolean; limit?: number } = {},
): Promise<WikiPageSummary[]> {
  await requireReader(db, actor, orgId);
  const folder = filters.folder !== undefined ? cleanFolder(filters.folder) : undefined;
  const q = filters.q?.trim();
  const rows = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.orgId, orgId),
        filters.deleted ? inTrashWindow() : isNull(wikiPages.deletedAt),
        folder !== undefined && folder !== ""
          ? or(eq(wikiPages.folder, folder), sql`${wikiPages.folder} like ${`${folder.replace(/[%_\\]/g, "\\$&")}/%`}`)
          : undefined,
        filters.tag ? sql`${filters.tag.trim().replace(/^#/, "").toLowerCase()} = any(${wikiPages.tags})` : undefined,
        q ? sql`${wikiPages.title} ilike ${`%${q.replace(/[%_\\]/g, "\\$&")}%`}` : undefined,
        visibleTo(actor),
      ),
    )
    .orderBy(filters.deleted ? desc(wikiPages.deletedAt) : desc(wikiPages.updatedAt))
    .limit(Math.min(filters.limit ?? 2000, 5000));
  return summaries(db, rows);
}

/** Folders and tags with counts, plus the latest pages (the sidebar). */
export async function wikiTree(db: Database, actor: WikiActor, orgId: string) {
  const pages = await listWikiPages(db, actor, orgId);
  const folders = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const p of pages) {
    const parts = p.folder ? p.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      folders.set(path, (folders.get(path) ?? 0) + 1);
    }
    for (const t of p.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  return {
    pages,
    folders: [...folders].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
    tags: [...tags]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    recent: pages.slice(0, 10),
  };
}

/** Title autocomplete for `[[`: titles starting with the text first, then containing it. */
export async function suggestWikiPages(db: Database, actor: WikiActor, orgId: string, text: string, limit = 10) {
  await requireReader(db, actor, orgId);
  const q = text.trim().split("/").pop()?.trim() ?? "";
  const esc = q.replace(/[%_\\]/g, "\\$&");
  const rows = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.orgId, orgId),
        isNull(wikiPages.deletedAt),
        q
          ? or(sql`${wikiPages.title} ilike ${`%${esc}%`}`, sql`${wikiPages.slug} like ${`%${wikiSlug(q) || esc}%`}`)
          : undefined,
        visibleTo(actor),
      ),
    )
    .orderBy(
      ...(q ? [sql`case when ${wikiPages.title} ilike ${`${esc}%`} then 0 else 1 end`] : []),
      desc(wikiPages.updatedAt),
    )
    .limit(Math.min(limit, 50));
  return summaries(db, rows);
}

export async function listWikiVersions(db: Database, actor: WikiActor, orgId: string, ref: string) {
  await requireReader(db, actor, orgId);
  const page = await findPage(db, actor, orgId, ref);
  const rows = await db
    .select()
    .from(wikiPageVersions)
    .where(eq(wikiPageVersions.pageId, page.id))
    .orderBy(desc(wikiPageVersions.version))
    .limit(500);
  return rows.map(
    (v): WikiVersionView => ({
      version: v.version,
      at: v.createdAt.toISOString(),
      author: {
        type: v.authorType as WikiAuthor["type"],
        id: v.authorId,
        onBehalfOf: v.authorType === "agent" ? v.requestedByUserId : null,
      },
      note: v.note || null,
      ...(v.note ? wikiNoteDetail(v.note) : null),
      title: v.title,
    }),
  );
}

export async function getWikiVersion(db: Database, actor: WikiActor, orgId: string, ref: string, version: number) {
  await requireReader(db, actor, orgId);
  const page = await findPage(db, actor, orgId, ref);
  const [v] = await db
    .select()
    .from(wikiPageVersions)
    .where(and(eq(wikiPageVersions.pageId, page.id), eq(wikiPageVersions.version, version)));
  if (!v) throw new NotFoundError("Version not found", "wiki.version_not_found");
  return {
    version: v.version,
    title: v.title,
    body: v.body,
    folder: v.folder,
    tags: v.tags,
    at: v.createdAt.toISOString(),
    author: {
      type: v.authorType as WikiAuthor["type"],
      id: v.authorId,
      onBehalfOf: v.authorType === "agent" ? v.requestedByUserId : null,
    },
    note: v.note || null,
    ...(v.note ? wikiNoteDetail(v.note) : null),
  };
}

/** What changed between two versions: lines and a unified patch. */
export async function diffWikiVersions(
  db: Database,
  actor: WikiActor,
  orgId: string,
  ref: string,
  from: number,
  to: number,
) {
  const [a, b] = await Promise.all([
    getWikiVersion(db, actor, orgId, ref, from),
    getWikiVersion(db, actor, orgId, ref, to),
  ]);
  const lines = diffLines(a.body, b.body);
  return {
    from,
    to,
    titleChanged: a.title !== b.title ? { from: a.title, to: b.title } : null,
    added: lines.filter((l) => l.type === "add").length,
    removed: lines.filter((l) => l.type === "del").length,
    lines,
    patch: unifiedPatch(lines, `v${from}`, `v${to}`),
  };
}

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** Line diff (longest common subsequence; large texts fall back to prefix/suffix trimming). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ type: "same", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ type: "same", text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  let middle: DiffLine[];
  if (x.length * y.length > 4_000_000) {
    middle = [
      ...x.map((text): DiffLine => ({ type: "del", text })),
      ...y.map((text): DiffLine => ({ type: "add", text })),
    ];
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        lcs[i * w + j] =
          x[i] === y[j]
            ? (lcs[(i + 1) * w + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
    middle = [];
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        middle.push({ type: "same", text: x[i] as string });
        i++;
        j++;
      } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) {
        middle.push({ type: "del", text: x[i++] as string });
      } else {
        middle.push({ type: "add", text: y[j++] as string });
      }
    }
    while (i < x.length) middle.push({ type: "del", text: x[i++] as string });
    while (j < y.length) middle.push({ type: "add", text: y[j++] as string });
  }
  return [...head, ...middle, ...tail];
}

/** A unified patch (3 lines of context) from `diffLines`. */
export function unifiedPatch(lines: DiffLine[], fromName: string, toName: string) {
  const changed = lines.map((l, i) => (l.type !== "same" ? i : -1)).filter((i) => i >= 0);
  if (changed.length === 0) return "";
  const out = [`--- ${fromName}`, `+++ ${toName}`];
  let k = 0;
  while (k < changed.length) {
    const first = changed[k] as number;
    let last = first;
    while (k + 1 < changed.length && (changed[k + 1] as number) - last <= 6) last = changed[++k] as number;
    k++;
    const from = Math.max(0, first - 3);
    const to = Math.min(lines.length, last + 4);
    let aLine = 1;
    let bLine = 1;
    for (let i = 0; i < from; i++) {
      if (lines[i]?.type !== "add") aLine++;
      if (lines[i]?.type !== "del") bLine++;
    }
    const hunk = lines.slice(from, to);
    const aCount = hunk.filter((l) => l.type !== "add").length;
    const bCount = hunk.filter((l) => l.type !== "del").length;
    out.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
    for (const l of hunk) out.push(`${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`);
  }
  return `${out.join("\n")}\n`;
}

/** Pages and their links (only between existing pages); `unresolved` lists links to pages not written yet. */
export async function wikiGraph(db: Database, actor: WikiActor, orgId: string) {
  await requireReader(db, actor, orgId);
  const pages = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      folder: wikiPages.folder,
      tags: wikiPages.tags,
      createdByType: wikiPages.createdByType,
      createdById: wikiPages.createdById,
      source: wikiPages.source,
    })
    .from(wikiPages)
    .where(and(eq(wikiPages.orgId, orgId), isNull(wikiPages.deletedAt), visibleTo(actor)))
    .limit(5000);
  const links = await db
    .select({ from: wikiLinks.fromId, to: wikiLinks.toPageId, toSlug: wikiLinks.toSlug })
    .from(wikiLinks)
    .where(and(eq(wikiLinks.orgId, orgId), eq(wikiLinks.fromType, "page")))
    .limit(50_000);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const edges: { from: string; to: string }[] = [];
  const unresolved: { from: string; toSlug: string }[] = [];
  for (const l of links) {
    const from = byId.get(l.from);
    if (!from) continue;
    if (l.to && !byId.has(l.to)) continue; // a page the reader doesn't see
    const to = l.to ? byId.get(l.to) : undefined;
    if (to) {
      if (to.id !== from.id) edges.push({ from: from.slug, to: to.slug });
    } else unresolved.push({ from: from.slug, toSlug: l.toSlug });
  }
  return {
    nodes: pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      folder: p.folder,
      tags: p.tags,
      agentId: p.createdByType === "agent" ? p.createdById : null,
      sourceType: p.source?.type ?? null,
    })),
    edges,
    unresolved,
  };
}

/** Wiki search: hybrid search when available, else title and body words. */
export async function searchWiki(deps: WikiDeps, actor: WikiActor, orgId: string, text: string, limit = 8) {
  await requireReader(deps.db, actor, orgId);
  return searchPages(deps, actor, orgId, text, limit);
}

/**
 * With `minTextRank` (a run's context) only pages that pass it: the index's answer stands even when empty or failed.
 * Otherwise the word match below answers when the index can't.
 */
async function searchPages(
  deps: WikiDeps,
  actor: WikiActor,
  orgId: string,
  text: string,
  limit: number,
  minTextRank?: number,
): Promise<PageRow[]> {
  const q = text.trim();
  if (!q) return [];
  if (deps.search) {
    const hits = await searchVisible(deps.search, {
      orgId,
      text: q.slice(0, 500),
      visibleChannelIds: [],
      kinds: ["wiki"],
      limit,
      match: "any",
      minTextRank,
    }).catch(() => null);
    if (minTextRank !== undefined && !hits?.length) return [];
    if (hits && hits.length > 0) {
      const rows = await deps.db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.orgId, orgId),
            isNull(wikiPages.deletedAt),
            inArray(
              wikiPages.id,
              hits.map((h) => h.sourceId),
            ),
            visibleTo(actor),
          ),
        );
      const rank = new Map(hits.map((h, i) => [h.sourceId, i]));
      return rows.sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
    }
  }
  // Without the index nothing measures relevance: a run's context gets no page rather than any page with a word.
  if (minTextRank !== undefined) return [];
  const words = contentWords(q, 8);
  if (words.length === 0) return [];
  const match = or(
    ...words.map((w) => {
      const like = `%${w.replace(/[%_\\]/g, "\\$&")}%`;
      return or(sql`${wikiPages.title} ilike ${like}`, sql`${wikiPages.body} ilike ${like}`);
    }),
  );
  return deps.db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.orgId, orgId), isNull(wikiPages.deletedAt), match, visibleTo(actor)))
    .orderBy(desc(wikiPages.updatedAt))
    .limit(limit);
}

// ── "Save to wiki" ─────────────────────────────────────────────────────────────

export type WikiSaveSource = { kind: "message"; channelId: string; messageId: string };

/** The text of a message, with a line saying where it came from. */
async function sourceBlock(deps: WikiDeps, userId: string, orgId: string, source: WikiSaveSource) {
  const { db } = deps;
  await requireChannelAccess(db, userId, orgId, source.channelId);
  const m = await getMessage(db, orgId, source.messageId);
  if (!m || m.deletedAt || m.channelId !== source.channelId)
    throw new NotFoundError("Message not found", "message.not_found");
  const [channel] = await db
    .select({ name: channels.name, kind: channels.kind })
    .from(channels)
    .where(eq(channels.id, m.channelId));
  const [author] =
    m.authorType === "agent" && m.authorAgentId
      ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, m.authorAgentId))
      : m.authorUserId
        ? await db.select({ name: users.name }).from(users).where(eq(users.id, m.authorUserId))
        : [];
  const where = channel?.kind === "dm" ? "a DM" : `#${channel?.name ?? "channel"}`;
  const date = m.createdAt.toISOString().slice(0, 10);
  return {
    text: `${m.body.trim()}\n\n_Saved from a message by ${author?.name ?? "someone"} in ${where} (${date})._`,
    source: { type: "message", id: m.id, channelId: m.channelId },
    title:
      m.body
        .split("\n")[0]
        ?.replace(/[#*_`[\]|]/g, "")
        .trim()
        .slice(0, 80) || "Note",
  };
}

/** "Save to wiki": appends the message to a page, with where it came from. */
export async function appendSourceToWiki(
  deps: WikiDeps,
  userId: string,
  orgId: string,
  ref: string,
  input: { source: WikiSaveSource; text?: string; section?: string | null },
) {
  const block = await sourceBlock(deps, userId, orgId, input.source);
  const text = input.text?.trim() ? `${input.text.trim()}\n\n${block.text.split("\n").at(-1)}` : block.text;
  return appendToWikiPage(deps, { type: "person", userId }, orgId, ref, {
    text,
    section: input.section,
    note: "saved a message",
  });
}

/** "Save to wiki" on a new page: the message becomes the page, with its source. */
export async function createPageFromSource(
  deps: WikiDeps,
  userId: string,
  orgId: string,
  input: { source: WikiSaveSource; title?: string; folder?: string; tags?: string[] },
) {
  const block = await sourceBlock(deps, userId, orgId, input.source);
  return createWikiPage(
    deps,
    { type: "person", userId },
    orgId,
    {
      title: input.title?.trim() || block.title,
      body: block.text,
      folder: input.folder,
      tags: input.tags,
      source: block.source,
      note: "created from a message",
    },
    { allowDuplicate: true },
  );
}

// ── Agents' context ──────────────────────────────────────────────────────────

/**
 * Wiki pages relevant to the trigger message, for the run's prompt (a trusted
 * source written by the team). Pages marked "Sempre no contexto" and the pages
 * the message links with `[[…]]` come first, then the search's matches that
 * pass `WIKI_MIN_RANK`. An org without a wiki costs one cached lookup.
 */
export async function retrieveWikiForRun(
  deps: WikiDeps,
  input: { orgId: string; text: string; budgetChars?: number; reader: () => Promise<WikiActor> },
): Promise<{ text: string; pageIds: string[]; held: boolean }> {
  const { db } = deps;
  const known = (await caches.contextPresence.getOrLoad(`${input.orgId}:wiki`, async () => {
    const [[row], always] = await Promise.all([
      db
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.orgId, input.orgId), isNull(wikiPages.deletedAt)))
        .limit(1),
      db
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(eq(wikiPages.orgId, input.orgId), eq(wikiPages.agentContext, true), isNull(wikiPages.deletedAt)))
        .orderBy(asc(wikiPages.title))
        .limit(WIKI_CONTEXT_MAX),
    ]);
    return { any: Boolean(row), always: always.map((r) => r.id) };
  })) as { any: boolean; always: string[] };
  if (!known.any || (!input.text.trim() && known.always.length === 0)) return { text: "", pageIds: [], held: false };
  const actor = await input.reader();
  const wide = withoutConversation(actor);
  const linked = parseWikiLinks(input.text);
  const namedLinks = linked.length
    ? [
        ...(
          await pagesBySlug(
            db,
            input.orgId,
            linked.map((l) => l.slug),
          )
        ).values(),
      ].map((p) => p.id)
    : [];
  // "Sempre no contexto" goes in as if the message named it, after the pages it names: those come first in the budget.
  const named = [...namedLinks, ...known.always.filter((id) => !namedLinks.includes(id))];
  const namedRows = named.length
    ? await db
        .select()
        .from(wikiPages)
        .where(and(inArray(wikiPages.id, named), isNull(wikiPages.deletedAt), visibleTo(wide)))
    : [];
  const hits = await searchPages(deps, wide, input.orgId, input.text, 5, WIKI_MIN_RANK).catch(() => [] as PageRow[]);
  const seen = await visibleIds(db, actor, [...new Set([...namedRows, ...hits].map((p) => p.id))]);
  // What the message names, or the best match, kept from this conversation only: it goes to the person's DM. A page
  // always in context that this conversation may not read just stays out.
  const held = [...namedRows.filter((p) => namedLinks.includes(p.id)), ...hits.slice(0, 1)].some(
    (p) => !seen.has(p.id),
  );
  const order = new Map(named.map((id, i) => [id, i]));
  const namedSeen = namedRows
    .filter((p) => seen.has(p.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const found = hits.filter((p) => seen.has(p.id));
  const budget = input.budgetChars ?? 6000;
  const lines: string[] = [];
  const ids: string[] = [];
  let used = 0;
  // Context on demand (ADR 0043): pages the message names and the best match go in (cut at `WIKI_PAGE_CHARS`);
  // the other matches only as an index line, read with read_wiki_page when the run needs them.
  const full = new Set([...namedSeen.map((p) => p.id), ...found.slice(0, 1).map((p) => p.id)]);
  for (const p of [...namedSeen, ...found]) {
    if (ids.includes(p.id)) continue;
    const room = Math.min(full.has(p.id) ? WIKI_PAGE_CHARS : WIKI_INDEX_CHARS, budget - used);
    if (room < 120) break;
    const body = p.body.trim();
    const where = `${p.folder ? `${p.folder}/` : ""}${p.slug}, v${p.version}`;
    const text = full.has(p.id)
      ? `## [[${p.title}]] (${where})\n${body.length > room ? `${cutText(body, room)}\n[… continues: read it with read_wiki_page]` : body}`
      : `- [[${p.title}]] (${where}): ${cutText(body.replace(/\s+/g, " "), room)}${body.length > room ? "… [read it with read_wiki_page]" : ""}`;
    lines.push(text);
    ids.push(p.id);
    used += text.length;
  }
  return { text: lines.join("\n\n"), pageIds: ids, held };
}

/** The same reader away from any conversation: the agent and the person only. */
const withoutConversation = (actor: WikiActor): WikiActor =>
  actor.type === "agent" && actor.requestedByUserId ? { ...actor, channelId: null } : actor;

/**
 * Whether only the conversation keeps `actor` from this page: the agent and the person behind it may read it, the
 * others there may not. Never says what the page is.
 */
export async function wikiPageHeld(db: Database, actor: WikiActor, orgId: string, ref: string) {
  const row = await findAnyPage(db, orgId, ref).catch(() => null);
  if (!row) return false;
  return (
    !(await visibleIds(db, actor, [row.id])).has(row.id) &&
    (await visibleIds(db, withoutConversation(actor), [row.id])).has(row.id)
  );
}

/** `searchWiki` for a run: what it may read, and whether the best match is kept from this conversation only. */
export async function searchWikiForRun(deps: WikiDeps, actor: WikiActor, orgId: string, text: string, limit = 8) {
  const hits = await searchWiki(deps, withoutConversation(actor), orgId, text, limit);
  const seen = await visibleIds(
    deps.db,
    actor,
    hits.map((p) => p.id),
  );
  const best = hits[0];
  return { pages: hits.filter((p) => seen.has(p.id)), held: Boolean(best && !seen.has(best.id)) };
}

/** What a search over everything hands an agent: wiki hits only for pages this run may read. */
export async function wikiHitsForAgent<T extends { kind: string; sourceId: string }>(
  db: Executor,
  actor: WikiActor,
  hits: T[],
): Promise<T[]> {
  const ids = hits.filter((h) => h.kind === "wiki").map((h) => h.sourceId);
  if (ids.length === 0) return hits;
  const seen = await visibleIds(db, actor, ids);
  return hits.filter((h) => h.kind !== "wiki" || seen.has(h.sourceId));
}

/**
 * A run's context takes a page only when its matches' density (`SearchQuery.minTextRank`) reaches this, and it matches
 * two of the message's words or one in its title: about one match every 40 words. Measured on a 200-page pt-BR vault
 * (`test/wiki-corpus.ts`): pages about the question pass at 0.003 and up, long pages that mention it in passing stay
 * under 0.002, and a message that shares one word with a page gets nothing.
 */
// ponytail: one fixed floor calibrated on pt/en pages; make it per-workspace if a wiki needs it looser.
const WIKI_MIN_RANK = 0.0025;

/** A page the run's message names, or its best match, goes in up to this much (ADR 0043). */
const WIKI_PAGE_CHARS = 1500;
/** Any other match goes in as one index line this long. */
const WIKI_INDEX_CHARS = 200;

// ── Search index ─────────────────────────────────────────────────────────────

registerDocumentBuilder("wiki", async (db, orgId, id) => {
  const [p] = await db
    .select()
    .from(wikiPages)
    .where(and(eq(wikiPages.id, id), eq(wikiPages.orgId, orgId)));
  if (!p || p.deletedAt) return null;
  return {
    orgId,
    kind: "wiki",
    sourceId: p.id,
    // The whole org reads the wiki.
    channelIds: [],
    title: `${p.folder ? `${p.folder}/` : ""}${p.title}`,
    body: [p.tags.length ? `#${p.tags.join(" #")}` : "", p.body].filter(Boolean).join("\n").slice(0, 20_000),
    createdAt: p.createdAt,
  };
});

registerReindexSource("wiki", async (db, orgId) =>
  (
    await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.orgId, orgId), isNull(wikiPages.deletedAt)))
  ).map((r) => r.id),
);
