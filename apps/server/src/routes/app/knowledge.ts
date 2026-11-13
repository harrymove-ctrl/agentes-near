import { MESSAGE_HAS, type MessageHas } from "@agenteschat/adapters";
import { and, desc, eq, inArray, schema } from "@agenteschat/db";
import {
  addContextItemByPerson,
  addReaction,
  type ContextItem,
  can,
  correctAgentMessage,
  deleteContextItem,
  describeHits,
  editContextItem,
  enqueue,
  ForbiddenError,
  getAgent,
  listContextItems,
  listMessageReactions,
  memoryJudging,
  readableChannelIds,
  removeReaction,
  requirePermission,
  searchForUser,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
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

const tags = ["Knowledge"];
const KINDS = [
  "thread_summary",
  "period_summary",
  "decision",
  "fact",
  "preference",
  "open_question",
  "entity_profile",
  "note",
  "lesson",
  "rule",
] as const;
const SEARCH_KINDS = ["message", "context_item", "issue", "file", "wiki", "action"] as const;

/** A comma-separated list of ids in a query string (at most 50). */
const ids = (description: string, id: z.ZodType<string, string>) =>
  z
    .string()
    .max(4000)
    .optional()
    .transform((v) =>
      v
        ?.split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(id).max(50).optional())
    .openapi({ description, type: "string" });
const userId = z.string().regex(/^[\w-]{1,100}$/);

/** Search filters (ADR 0123): any of them searches messages only. */
const SearchFilterQuery = {
  in: ids("Comma-separated channel or DM ids (`in:`). Ones you can't read are ignored.", z.uuid()),
  fromUsers: ids("Comma-separated user ids: written by any of them or of `fromAgents` (`from:`).", userId),
  fromAgents: ids("Comma-separated agent ids (`from:`).", z.uuid()),
  mentionsUsers: ids("Comma-separated user ids: mentions any of them or of `mentionsAgents` (`mentions:`).", userId),
  mentionsAgents: ids("Comma-separated agent ids (`mentions:`).", z.uuid()),
  has: z
    .string()
    .optional()
    .transform((v) => v?.split(",").filter((x): x is MessageHas => (MESSAGE_HAS as readonly string[]).includes(x)))
    .openapi({ description: `Comma-separated, all required: ${MESSAGE_HAS.join(", ")}`, type: "string" }),
  author: z.enum(["person", "agent"]).optional().openapi({ description: "Written by a person or by an agent." }),
  pinned: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  after: z.iso.datetime({ offset: true }).optional().openapi({ description: "Created at or after (`after:`)." }),
  before: z.iso.datetime({ offset: true }).optional().openapi({ description: "Created before (`before:`)." }),
  sort: z.enum(["relevance", "newest", "oldest"]).optional(),
};

type FilterQuery = z.output<z.ZodObject<typeof SearchFilterQuery>>;

function searchFilters(q: FilterQuery) {
  const has = q.has?.length ? q.has : undefined;
  const messages = {
    ...(q.fromUsers?.length ? { fromUserIds: q.fromUsers } : {}),
    ...(q.fromAgents?.length ? { fromAgentIds: q.fromAgents } : {}),
    ...(q.mentionsUsers?.length ? { mentionsUserIds: q.mentionsUsers } : {}),
    ...(q.mentionsAgents?.length ? { mentionsAgentIds: q.mentionsAgents } : {}),
    ...(q.author ? { authorType: q.author } : {}),
    ...(has ? { has } : {}),
    ...(q.pinned ? { pinned: true } : {}),
  };
  return {
    channelIds: q.in?.length ? q.in : undefined,
    messages: Object.keys(messages).length ? messages : undefined,
    after: q.after ? new Date(q.after) : undefined,
    before: q.before ? new Date(q.before) : undefined,
    sort: q.sort,
  };
}

const Item = z
  .object({
    id: z.uuid(),
    kind: z.enum(KINDS),
    agentId: z.uuid().nullable().openapi({ description: "Owner agent (notes, lessons); null = shared." }),
    scopeType: z.string(),
    scopeId: z.string().nullable(),
    title: z.string(),
    content: z.string(),
    trust: z.enum(["high", "low"]).openapi({ description: "`low` = came from outside the team (webhooks, tools)." }),
    verified: z.boolean().openapi({ description: "Backed by an outcome or a person (agent claims alone are not)." }),
    evidence: z.array(z.object({ type: z.enum(["outcome", "human", "agent", "app", "self"]), ref: z.string() })),
    confidence: z.number(),
    relevance: z.number(),
    recurrence: z.number(),
    useCount: z.number().openapi({ description: "Runs whose memory carried it." }),
    disputed: z.boolean().openapi({ description: "Another item says otherwise, until a person decides." }),
    channelIds: z.array(z.uuid()).openapi({ description: "Where it was learned." }),
    pinned: z.boolean(),
    status: z.enum(["active", "archived"]),
    supersededBy: z.uuid().nullable(),
    version: z.number(),
    sourceIds: z.array(z.uuid()),
    createdByKind: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("ContextItem");

const toItem = (i: ContextItem) => ({
  id: i.id,
  kind: i.kind,
  agentId: i.agentId,
  scopeType: i.scopeType,
  scopeId: i.scopeId,
  title: i.title,
  content: i.content,
  trust: i.trust,
  verified: i.verified,
  evidence: i.evidence.map((e) => ({ type: e.type, ref: e.ref })),
  confidence: i.confidence,
  relevance: i.relevance,
  recurrence: i.recurrence,
  useCount: i.useCount,
  disputed: i.disputed,
  channelIds: i.channelIds,
  pinned: i.pinned,
  status: i.status,
  supersededBy: i.supersededBy,
  version: i.version,
  sourceIds: i.sourceIds,
  createdByKind: i.createdByKind,
  createdAt: i.createdAt.toISOString(),
  updatedAt: i.updatedAt.toISOString(),
});

const Reactions = z.array(
  z.object({ reaction: z.string(), count: z.number(), userIds: z.array(z.string()), agentIds: z.array(z.string()) }),
);

/**
 * Search, the org's context items, outcomes, and feedback on agent replies
 * (reactions, corrections). Agent memories and proposals in the shape the web
 * app uses: `memory.ts`.
 */
export function knowledgeRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  // Queries are embedded when the deployment has embeddings (recorded as usage); else full-text.
  const searchDeps = { db, search: adapters.search, gateway: { embed: deps.extras?.embed ?? (async () => null) } };
  const ItemParams = OrgParams.extend({ itemId: z.uuid() });
  const MessageParams = OrgParams.extend({ messageId: z.uuid() });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/search",
      tags,
      security,
      summary: "Search what you can read (messages, summaries, facts, issues, files, the team's outside actions)",
      request: {
        params: OrgParams,
        query: z.object({
          q: z.string().max(500).default("").openapi({ description: "Words. Optional when a filter is set." }),
          kinds: z
            .string()
            .optional()
            .openapi({ description: `Comma-separated: ${SEARCH_KINDS.join(", ")}` }),
          limit: z.coerce.number().int().min(1).max(100).optional(),
          ...SearchFilterQuery,
        }),
      },
      responses: {
        200: json(
          z.object({
            hits: z.array(
              z.object({
                kind: z.enum(SEARCH_KINDS),
                sourceId: z.uuid(),
                channelIds: z.array(z.uuid()),
                title: z.string(),
                snippet: z.string(),
                score: z.number(),
                createdAt: z.string(),
                messageId: z.uuid().nullable().openapi({ description: "Message hits: open it here." }),
                threadId: z.uuid().nullable(),
                threadTitle: z.string().nullable().openapi({
                  description: "Message hits in a thread: its title, else its root message's first line.",
                }),
                author: z.object({ type: z.enum(["person", "agent"]), id: z.string(), name: z.string() }).nullable(),
                mediaKind: z.enum(["voice", "gif", "sticker"]).optional().openapi({
                  description: "Message hits: a voice message (its snippet is empty), a GIF or a sticker.",
                }),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const q = c.req.valid("query");
      const kinds = q.kinds
        ?.split(",")
        .map((k) => k.trim())
        .filter((k): k is (typeof SEARCH_KINDS)[number] => (SEARCH_KINDS as readonly string[]).includes(k));
      const found = await searchForUser(searchDeps, c.get("user").id, orgId, {
        text: q.q,
        kinds,
        limit: q.limit,
        ...searchFilters(q),
      });
      const hits = await describeHits(db, orgId, found);
      return c.json({ hits: hits.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/search/reindex",
      tags,
      security,
      summary: "Rebuild the organization's search index (admins)",
      request: { params: OrgParams, body: body(z.object({})) },
      responses: { 202: { description: "Queued" }, ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "configure");
      await enqueue(db, { orgId, kind: "search.reindex", payload: {} });
      deps.wakeWorkers?.();
      return c.body(null, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/context-items",
      tags,
      security,
      summary: "What the org and its agents know (filter by agent for its memory)",
      request: {
        params: OrgParams,
        query: z.object({
          agentId: z.uuid().optional(),
          kinds: z
            .string()
            .optional()
            .openapi({ description: `Comma-separated: ${KINDS.join(", ")}` }),
          includeArchived: z.stringbool().optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          createdBy: z
            .string()
            .optional()
            .openapi({ description: 'Comma-separated: agent, job, person ("What it learned": agent,job).' }),
        }),
      },
      responses: { 200: json(z.object({ items: z.array(Item) })), ...errors },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const kinds = q.kinds
        ?.split(",")
        .map((k) => k.trim())
        .filter((k): k is (typeof KINDS)[number] => (KINDS as readonly string[]).includes(k));
      const rows = await listContextItems(db, c.get("user").id, c.req.valid("param").orgId, {
        agentId: q.agentId,
        kinds,
        includeArchived: q.includeArchived,
        limit: q.limit,
        createdBy: q.createdBy
          ?.split(",")
          .map((k) => k.trim())
          .filter((k): k is "agent" | "job" | "person" => k === "agent" || k === "job" || k === "person"),
      });
      return c.json({ items: rows.map(toItem) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/context-items",
      tags,
      security,
      summary: "Add a fact, decision, preference or note by hand",
      description:
        "Org-wide items need admins; an agent's notes need its owner or an admin. Credentials and permission rules are refused.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            kind: z.enum(["decision", "fact", "preference", "note", "lesson"]),
            content: z.string().min(1).max(8000),
            title: z.string().max(300).optional(),
            agentId: z.uuid().nullable().optional(),
            pinned: z.boolean().optional(),
          }),
        ),
      },
      responses: { 201: json(Item, "Created"), ...errors },
    }),
    async (c) => {
      const row = await addContextItemByPerson(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"));
      return c.json(toItem(row), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/context-items/{itemId}",
      tags,
      security,
      summary: "Edit (new version), pin or archive an item",
      request: {
        params: ItemParams,
        body: body(
          z.object({
            content: z.string().min(1).max(8000).optional(),
            title: z.string().max(300).optional(),
            pinned: z.boolean().optional(),
            archived: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(Item), ...errors },
    }),
    async (c) => {
      const { orgId, itemId } = c.req.valid("param");
      return c.json(toItem(await editContextItem(db, c.get("user").id, orgId, itemId, c.req.valid("json"))), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/context-items/{itemId}",
      tags,
      security,
      summary: "Delete an item for good",
      request: { params: ItemParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, itemId } = c.req.valid("param");
      await deleteContextItem(db, c.get("user").id, orgId, itemId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/outcomes",
      tags,
      security,
      summary: "Observed outcomes of agent actions (admins; owners for their agent)",
      request: { params: OrgParams, query: z.object({ agentId: z.uuid().optional() }) },
      responses: {
        200: json(
          z.object({
            outcomes: z.array(
              z.object({
                id: z.uuid(),
                agentId: z.uuid().nullable(),
                runId: z.uuid().nullable(),
                kind: z.string(),
                polarity: z.string(),
                subject: z.string(),
                summary: z.string(),
                source: z.string(),
                createdAt: z.string(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { agentId } = c.req.valid("query");
      const membership = await requirePermission(db, c.get("user").id, orgId, "read");
      if (!can(membership, "view_usage")) {
        const agent = agentId ? await getAgent(db, orgId, agentId) : null;
        if (agent?.ownerUserId !== c.get("user").id) throw new ForbiddenError();
      }
      const o = schema.outcomes;
      const rows = await db
        .select()
        .from(o)
        .where(and(eq(o.orgId, orgId), agentId ? eq(o.agentId, agentId) : undefined))
        .orderBy(desc(o.createdAt))
        .limit(200);
      // What a run did in a conversation is quoted only to who reads it, as on the run history.
      const runIds = [...new Set(rows.flatMap((r) => (!r.channelId && r.runId ? [r.runId] : [])))];
      const runChannel = new Map(
        (runIds.length
          ? await db
              .select({ id: schema.agentRuns.id, channelId: schema.agentRuns.channelId })
              .from(schema.agentRuns)
              .where(and(eq(schema.agentRuns.orgId, orgId), inArray(schema.agentRuns.id, runIds)))
          : []
        ).map((r) => [r.id, r.channelId]),
      );
      const channelOf = (r: (typeof rows)[number]) => r.channelId ?? (r.runId ? runChannel.get(r.runId) : undefined);
      const readable = await readableChannelIds(
        db,
        orgId,
        c.get("user").id,
        rows.flatMap((r) => channelOf(r) ?? []),
      );
      // A run pruned since leaves its conversation unknown: kept quiet too.
      const hidden = (r: (typeof rows)[number]) => {
        const channelId = channelOf(r);
        return channelId ? !readable.has(channelId) : r.runId !== null;
      };
      return c.json(
        {
          outcomes: rows.map((r) => ({
            id: r.id,
            agentId: r.agentId,
            runId: r.runId,
            kind: r.kind,
            polarity: r.polarity,
            subject: hidden(r) ? "" : r.subject,
            summary: hidden(r) ? "" : r.summary,
            source: r.source,
            createdAt: r.createdAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  // ── Feedback on messages ──────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/messages/{messageId}/reactions",
      tags,
      security,
      summary: "Reactions on a message",
      request: { params: MessageParams },
      responses: { 200: json(z.object({ reactions: Reactions })), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json({ reactions: await listMessageReactions(db, c.get("user").id, orgId, messageId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/reactions",
      tags,
      security,
      summary: "React (👍 `+1` / 👎 `-1` on an agent's reply are feedback for it)",
      request: { params: MessageParams, body: body(z.object({ reaction: z.string().min(1).max(32) })) },
      responses: { 200: json(z.object({ reactions: Reactions })), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const reactions = await addReaction(
        db,
        c.get("user").id,
        orgId,
        messageId,
        c.req.valid("json").reaction,
        adapters.pubsub,
      );
      deps.wakeWorkers?.();
      return c.json({ reactions }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/messages/{messageId}/reactions",
      tags,
      security,
      summary: "Remove your reaction (everyone in the channel gets `message.reactions`)",
      request: { params: MessageParams, query: z.object({ reaction: z.string().min(1).max(32) }) },
      responses: { 200: json(z.object({ reactions: Reactions })), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const { reaction } = c.req.valid("query");
      return c.json(
        { reactions: await removeReaction(db, c.get("user").id, orgId, messageId, reaction, adapters.pubsub) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/correction",
      tags,
      security,
      summary: "Correct an agent's reply: it becomes a lesson for that agent",
      request: { params: MessageParams, body: body(z.object({ body: z.string().min(1).max(4000) })) },
      responses: { 201: json(Item, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const res = await correctAgentMessage(
        {
          db,
          pubsub: adapters.pubsub,
          memory: deps.extras?.context ? memoryJudging(deps.extras.context) : undefined,
        },
        c.get("user").id,
        orgId,
        messageId,
        c.req.valid("json").body,
      );
      return c.json(toItem(res.item), 201);
    },
  );

  return app;
}
