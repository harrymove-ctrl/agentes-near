import {
  archiveThread,
  closeThread,
  countUnreadThreads,
  createThreadFromRange,
  deleteThread,
  getThread,
  listThreads,
  markThreadRead,
  moveContextIntoThread,
  reopenThread,
  returnContextToChannel,
  setThreadFollow,
  type ThreadDeps,
  unarchiveThread,
  unreadTaskConversations,
  updateThread,
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
import { PreviewMeta } from "./schemas";

const tags = ["Threads"];
const Actor = z.object({ type: z.enum(["person", "agent"]), id: z.string().nullable() });
const State = z.enum(["open", "closed", "archived"]);
const Tab = z.enum(["all", "working", "missions", "closed", "archived"]);

const Thread = z
  .object({
    id: z.uuid().openapi({ description: "The root message id (what replies carry as `threadId`)." }),
    channelId: z.uuid(),
    channelName: z.string(),
    channelKind: z.enum(["channel", "dm", "task"]),
    title: z.string().nullable().openapi({ description: "Null: show `rootText`." }),
    rootText: z.string(),
    rootAuthor: Actor,
    state: State,
    createdBy: z.string().nullable(),
    closedBy: z.string().nullable(),
    closedAt: z.string().nullable(),
    archivedBy: z.string().nullable(),
    archivedAt: z.string().nullable(),
    context: z
      .object({
        channelId: z.uuid(),
        firstMessageId: z.uuid(),
        lastMessageId: z.uuid(),
        excludedMessageIds: z.array(z.uuid()),
        moved: z.boolean().openapi({ description: "The range left the channel (a stub stays there)." }),
        count: z.number(),
      })
      .nullable()
      .openapi({ description: "The range of a conversation this thread was made from." }),
    replyCount: z.number(),
    lastActivityAt: z.string(),
    lastMessage: z.object({ author: Actor, excerpt: z.string(), meta: PreviewMeta, createdAt: z.string() }).nullable(),
    participants: z.array(Actor),
    working: z.boolean().openapi({
      description:
        "An agent run is in progress (or waiting for an approval or an answer) in this thread; not one waiting for its computer.",
    }),
    needsYou: z.boolean(),
    openedByReplyAt: z.string().nullable().openapi({
      description:
        "When someone first replied from the thread panel (`openThread` on the reply): replies from then on live in the panel and the channel shows one line. Null: the channel shows its replies in the timeline.",
    }),
    suggestedResolved: z.boolean().openapi({
      description:
        "Open, and a model judged its matter done after its last message: offer to close it. Cleared by a new message, closing or reopening; never closes by itself.",
    }),
    canManage: z.boolean().openapi({ description: "You may close, archive, rename or change the context." }),
    following: z.boolean().openapi({
      description:
        "You follow it: notified of its replies, which count as unread in the channel. By default whoever started it or wrote in it; `PUT`/`DELETE …/follow` choose. Left out of `thread.updated` events.",
    }),
    unread: z.number().int().openapi({
      description:
        "Replies you haven't read in a thread you follow (0 otherwise), at most 100: not yours, not moved in from the channel, after your read of the thread (`POST …/read`, or your joining its channel). Left out of `thread.updated` events.",
    }),
    mission: z
      .object({
        id: z.uuid(),
        agentId: z.string().openapi({ description: "The mission's agent." }),
        status: z.enum(["proposed", "active", "paused", "done", "canceled", "awaiting_close"]),
        planDone: z.number(),
        planTotal: z.number(),
        waitingYou: z.number().openapi({
          description:
            "Plan items waiting for people, pending decisions and reviews; command cards and a mission waiting to be concluded for whoever answers them.",
        }),
      })
      .nullable()
      .openapi({ description: "The thread's mission, in short (details: `GET …/threads/{id}/mission`)." }),
    createdAt: z.string(),
  })
  .openapi("Thread");

const ThreadParams = OrgParams.extend({ threadId: z.uuid() });
const ChannelParams = OrgParams.extend({ channelId: z.uuid() });
const ListQuery = z.object({
  tab: Tab.optional(),
  agentId: z.uuid().optional(),
  needsYou: z.stringbool().optional(),
  mine: z.stringbool().optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const ThreadList = z.object({ threads: z.array(Thread), nextCursor: z.string().nullable() });

/**
 * Threads (ADR 0029): the Threads page, a thread made from a range of a
 * conversation, moving that range out of the channel and back, closing and
 * archiving. Everyone who reads the channel sees its threads; its creator,
 * the root's author and admins manage them.
 */
export function threadRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const threads = (): ThreadDeps => ({ db, pubsub: adapters.pubsub });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/threads",
      tags,
      security,
      summary: "Threads you can see, most recent activity first",
      request: { params: OrgParams, query: ListQuery.extend({ channelId: z.uuid().optional() }) },
      responses: { 200: json(ThreadList), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const list = await listThreads(db, c.get("user").id, { orgId, ...c.req.valid("query") });
      return c.json(list, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/threads",
      tags,
      security,
      summary: 'A channel\'s threads (its "Threads (N)")',
      request: { params: ChannelParams, query: ListQuery },
      responses: { 200: json(ThreadList), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const list = await listThreads(db, c.get("user").id, { orgId, channelId, ...c.req.valid("query") });
      return c.json(list, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/threads",
      tags,
      security,
      summary: "Create a thread from a range of a conversation (the range is its context; nothing moves)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            channelId: z.uuid().openapi({ description: "Where the thread lives." }),
            contextChannelId: z.uuid().optional().openapi({
              description:
                "Where the range comes from (default: `channelId`). Refused with `thread.context_not_visible` when someone in `channelId` can't see it.",
            }),
            firstMessageId: z.uuid(),
            lastMessageId: z.uuid(),
            excludedMessageIds: z.array(z.uuid()).max(500).optional(),
            title: z.string().max(200).nullable().optional().openapi({
              description: "Default: made from the first message of the range.",
            }),
          }),
        ),
      },
      responses: { 201: json(Thread, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const thread = await createThreadFromRange(threads(), c.get("user").id, { orgId, ...c.req.valid("json") });
      return c.json(thread, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/threads/{threadId}",
      tags,
      security,
      summary: "One thread (any state)",
      request: { params: ThreadParams },
      responses: { 200: json(Thread), ...errors },
    }),
    async (c) => {
      const { orgId, threadId } = c.req.valid("param");
      return c.json(await getThread(db, c.get("user").id, orgId, threadId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/threads/{threadId}",
      tags,
      security,
      summary: 'Rename a thread or change its range ("Ajustar trecho")',
      request: {
        params: ThreadParams,
        body: body(
          z.object({
            title: z.string().max(200).nullable().optional().openapi({ description: "Empty or null: no title." }),
            firstMessageId: z.uuid().optional(),
            lastMessageId: z.uuid().optional(),
            excludedMessageIds: z.array(z.uuid()).max(500).optional(),
          }),
        ),
      },
      responses: { 200: json(Thread), ...errors },
    }),
    async (c) => {
      const { orgId, threadId } = c.req.valid("param");
      return c.json(await updateThread(threads(), c.get("user").id, orgId, threadId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/threads/{threadId}",
      tags,
      security,
      summary: "Undo a thread made from a range, while nobody replied in it",
      request: { params: ThreadParams },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, threadId } = c.req.valid("param");
      await deleteThread(threads(), c.get("user").id, orgId, threadId);
      return c.body(null, 204);
    },
  );

  const actions = [
    ["move", moveContextIntoThread, "Take the range out of the channel into the thread (a stub stays)"],
    ["return", returnContextToChannel, "Put the moved messages back in the channel"],
    ["close", closeThread, "Close: resolved; reopens when someone replies"],
    ["reopen", reopenThread, "Reopen a closed thread"],
    ["archive", archiveThread, "Archive: hidden from lists by default and read only"],
    ["unarchive", unarchiveThread, "Unarchive (back to open or closed)"],
  ] as const;
  for (const [action, run, summary] of actions) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/threads/{threadId}/${action}`,
        tags,
        security,
        summary,
        request: { params: ThreadParams },
        responses: { 200: json(Thread), ...errors },
      }),
      async (c) => {
        const { orgId, threadId } = c.req.valid("param");
        return c.json(await run(threads(), c.get("user").id, orgId, threadId), 200);
      },
    );
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/threads/{threadId}/read",
      tags,
      security,
      summary: "Mark a thread's replies read up to now",
      description: "Whoever reads the thread's channel. Your other devices hear `thread.read` on your own topic.",
      request: { params: ThreadParams, body: body(z.object({})) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, threadId } = c.req.valid("param");
      await markThreadRead(threads(), c.get("user").id, orgId, threadId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/unread-threads",
      tags,
      security,
      summary: "How many threads you follow have a reply you haven't read (at most 100)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ count: z.number().int() })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ count: await countUnreadThreads(db, c.get("user").id, orgId) }, 200);
    },
  );

  const UnreadTask = z
    .object({ issueId: z.uuid(), unread: z.number().int(), mentions: z.number().int() })
    .openapi("UnreadTask");
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/unread-tasks",
      tags,
      security,
      summary: "Tasks whose conversation has a reply you haven't read, with the ones that mention you",
      description:
        "Only tasks you see. A reply counts when you follow the conversation or it mentions you, at most 100 each.",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ tasks: z.array(UnreadTask) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ tasks: await unreadTaskConversations(db, c.get("user").id, orgId) }, 200);
    },
  );

  const Follow = z.object({ threadId: z.uuid(), channelId: z.uuid(), following: z.boolean() }).openapi("ThreadFollow");
  for (const [method, following] of [
    ["put", true],
    ["delete", false],
  ] as const) {
    app.openapi(
      createRoute({
        method,
        path: "/organizations/{orgId}/threads/{threadId}/follow",
        tags,
        security,
        summary: following
          ? "Follow a thread: be notified of its replies, which count as unread in the channel"
          : "Unfollow a thread: no reply notifications nor unread from it, even where you wrote (mentions still notify)",
        description: "Whoever reads the thread's channel. Your other devices hear `thread.follow` on your own topic.",
        request: { params: ThreadParams },
        responses: { 200: json(Follow), ...errors },
      }),
      async (c) => {
        const { orgId, threadId } = c.req.valid("param");
        return c.json(await setThreadFollow(threads(), c.get("user").id, orgId, threadId, following), 200);
      },
    );
  }

  return app;
}
