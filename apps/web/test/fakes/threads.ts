/**
 * Test fake — threads (apps/server/src/routes/app/threads.ts). An in-memory
 * list of `ThreadInfo` per organization, empty unless a test creates one.
 * Lists are not logged (channels read them on every open); changes are.
 */
import type { ApiClient, ThreadFilters, ThreadInfo } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { clone, type MockContext, mockId, perOrg } from "./context";

export function createFakeThreads(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
): ApiClient["threads"] & {
  /** `chat.post` with `openThread`: the thread's row says when (made here when it had none). */
  openByReply(orgId: string, threadId: string, at: string): Promise<void>;
} {
  const store = perOrg(async () => [] as ThreadInfo[]);
  const find = async (orgId: string, threadId: string) => {
    const thread = (await store(orgId)).find((t) => t.id === threadId);
    if (!thread) throw new ApiError(404, "not_found", "Thread not found");
    return thread;
  };
  /** Like the server: any top-level message is a thread, empty until someone replies. */
  const fromMessage = async (orgId: string, rootId: string): Promise<ThreadInfo | null> => {
    const all = (await ctx.lookup.messages?.(orgId)) ?? [];
    const root = all.find((m) => m.id === rootId && !m.threadId);
    if (!root) return null;
    const channel = (await ctx.lookup.channels(orgId)).find((c) => c.id === root.channelId);
    const replies = all.filter((m) => m.threadId === rootId);
    const last = replies.at(-1);
    const people = [root, ...replies].map((m) => m.author);
    return {
      id: root.id,
      channelId: root.channelId,
      channelName: channel?.name ?? "",
      // A task's conversation (ADR 0145): its own channel, never listed.
      channelKind: root.meta?.taskConversation ? "task" : "channel",
      title: null,
      rootText: root.body,
      rootAuthor: root.author,
      state: "open",
      openedByReplyAt: null,
      createdBy: null,
      closedBy: null,
      closedAt: null,
      archivedBy: null,
      archivedAt: null,
      context: null,
      replyCount: replies.length,
      lastActivityAt: last?.createdAt ?? root.createdAt,
      lastMessage: last ? { author: last.author, excerpt: last.body, meta: null, createdAt: last.createdAt } : null,
      participants: people.filter((a, i) => people.findIndex((b) => b.type === a.type && b.id === a.id) === i),
      working: false,
      needsYou: false,
      suggestedResolved: false,
      canManage: true,
      following: false,
      mission: null,
      createdAt: root.createdAt,
    };
  };
  const list = async (orgId: string, f: ThreadFilters = {}) => {
    const tab = f.tab ?? "all";
    const q = f.q?.trim().toLowerCase();
    const threads = (await store(orgId))
      .filter((t) =>
        tab === "archived"
          ? t.state === "archived"
          : tab === "closed"
            ? t.state === "closed"
            : tab === "working"
              ? t.state !== "archived" && t.working
              : t.state !== "archived",
      )
      .filter((t) => !f.channelId || t.channelId === f.channelId)
      .filter((t) => !f.needsYou || t.needsYou)
      .filter((t) => !q || `${t.title ?? ""} ${t.rootText}`.toLowerCase().includes(q))
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
    return { threads: clone(threads), nextCursor: null };
  };
  return {
    list,
    inChannel: (orgId, channelId, filters = {}) => list(orgId, { ...filters, channelId }),
    get: async (orgId, threadId) => {
      const kept = (await store(orgId)).find((t) => t.id === threadId);
      const view = kept ?? (await fromMessage(orgId, threadId));
      if (!view) throw new ApiError(404, "not_found", "Thread not found");
      return clone(view);
    },
    openByReply: async (orgId, threadId, at) => {
      const all = await store(orgId);
      const kept = all.find((t) => t.id === threadId);
      if (kept) {
        kept.openedByReplyAt ??= at;
        return;
      }
      const view = await fromMessage(orgId, threadId);
      if (view) all.push({ ...view, openedByReplyAt: at });
    },
    create: async (orgId, input) => {
      log("threads.create", orgId, input);
      const me = await ctx.lookup.me();
      const channel = (await ctx.lookup.channels(orgId)).find((c) => c.id === input.channelId);
      const now = ctx.now().toISOString();
      const thread: ThreadInfo = {
        // Tests may give the root's id (a thread made from a range is its root message).
        id: (input as { id?: string }).id ?? mockId("thread"),
        channelId: input.channelId,
        channelName: channel?.name ?? "",
        channelKind: "channel",
        title: input.title ?? "Thread",
        rootText: input.title ?? "Thread",
        rootAuthor: { type: "person", id: me?.user.id ?? null },
        state: "open",
        // Tests may say when "Responder" opened it (replies from then on live in the thread panel).
        openedByReplyAt: (input as { openedByReplyAt?: string }).openedByReplyAt ?? null,
        createdBy: me?.user.id ?? null,
        closedBy: null,
        closedAt: null,
        archivedBy: null,
        archivedAt: null,
        context: {
          channelId: input.contextChannelId ?? input.channelId,
          firstMessageId: input.firstMessageId,
          lastMessageId: input.lastMessageId,
          excludedMessageIds: input.excludedMessageIds ?? [],
          moved: false,
          count: 1,
        },
        replyCount: 0,
        lastActivityAt: now,
        lastMessage: null,
        participants: [],
        working: false,
        needsYou: false,
        suggestedResolved: false,
        canManage: true,
        // Tests may seed the row's mission summary (the server joins it from `missions`).
        mission: (input as { mission?: ThreadInfo["mission"] }).mission ?? null,
        createdAt: now,
      };
      (await store(orgId)).push(thread);
      return clone(thread);
    },
    update: async (orgId, threadId, patch) => {
      log("threads.update", orgId, threadId, patch);
      const thread = await find(orgId, threadId);
      if (patch.title !== undefined) thread.title = patch.title || null;
      if (thread.context) {
        if (patch.firstMessageId) thread.context.firstMessageId = patch.firstMessageId;
        if (patch.lastMessageId) thread.context.lastMessageId = patch.lastMessageId;
        if (patch.excludedMessageIds) thread.context.excludedMessageIds = patch.excludedMessageIds;
      }
      return clone(thread);
    },
    remove: async (orgId, threadId) => {
      log("threads.remove", orgId, threadId);
      const all = await store(orgId);
      const at = all.findIndex((t) => t.id === threadId);
      if (at >= 0) all.splice(at, 1);
    },
    act: async (orgId, threadId, action) => {
      log("threads.act", orgId, threadId, action);
      const thread = await find(orgId, threadId);
      if (action === "close") thread.state = "closed";
      if (action === "reopen" || action === "unarchive") thread.state = "open";
      if (action === "archive") thread.state = "archived";
      if (thread.context && (action === "move" || action === "return")) thread.context.moved = action === "move";
      return clone(thread);
    },
  };
}
