import {
  activeRunsIn,
  addChannelMember,
  answerNow,
  cancelFollowUp,
  channelCard,
  consultationConversation,
  consultationsIn,
  createChannel,
  idRef,
  joinChannel,
  listChannelMembers,
  listChannels,
  listMessages,
  listWorkingRuns,
  MEDIA_REFUSALS,
  type MessageView,
  messageCard,
  openConsultationsIn,
  postPersonMessage,
  requireChannelAccess,
  STICKER_MOODS,
  ValidationError,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import {
  type AppDeps,
  aiStatusDeps,
  body,
  createAppRouter,
  errors,
  iso,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { Channel, Message } from "./schemas";

const tags = ["Chat"];
const ChannelParams = OrgParams.extend({ channelId: z.uuid() });

/** A question an agent asked another from a conversation, or work it handed one (`consultationsIn`). */
const Consultation = z.object({
  id: z.uuid(),
  kind: z
    .enum(["question", "note"])
    .openapi({ description: "`question`: `ask_agent`. `note`: work or news handed off with `tell_agent`." }),
  runId: z.uuid().openapi({ description: "The asking run: its reply (`agentRunId`) shows the list." }),
  agentId: z.uuid(),
  consultedAgentId: z.uuid(),
  consultedRunId: z
    .uuid()
    .nullable()
    .openapi({ description: "The consulted agent's run: the cards it posts here carry it (`agentRunId`)." }),
  status: z.enum(["open", "answered", "expired", "failed"]),
  waiting: z.enum(["approval", "input", "computer", "agents", "outage"]).nullable().openapi({
    description:
      "Open, and the consulted agent waits: on a person (`approval`; `input`: an answer or a secret), for its computer to come back online (`computer`), for its AI provider to come back (`outage`: it retries by itself), or, its part done, on agents it handed some to (`agents`).",
  }),
  question: z.string(),
  answer: z.string().nullable().openapi({ description: "The answer once answered; why it couldn't once failed." }),
  progress: z.object({ posts: z.number().int(), latest: z.string(), at: z.string() }).nullable().openapi({
    description:
      "Open: what the consulted agent posted in the agents' DM so far (how many messages, the start of the latest, when). Null when nothing yet.",
  }),
  createdAt: z.string(),
  answeredAt: z.string().nullable(),
  expiresAt: z.string(),
});

/** Channels and messages. Real-time updates arrive over the WebSocket (`/api/ws`). */
export function chatRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels",
      tags,
      security,
      summary:
        "Public channels, the private ones you belong to and those limited to a role you hold, with your unread count and the last message",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ channels: z.array(Channel) })), ...errors },
    }),
    async (c) => {
      const rows = await listChannels(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        {
          channels: rows.map((r) => ({
            id: r.id,
            name: r.name,
            topic: r.topic,
            visibility: r.visibility,
            audienceRoleIds: r.audienceRoleIds,
            isMember: r.isMember,
            seenAsAdmin: r.seenAsAdmin,
            createdByUserId: r.createdByUserId,
            createdAt: r.createdAt.toISOString(),
            categoryId: r.categoryId,
            position: r.position,
            unreadCount: r.unreadCount,
            mentionCount: r.mentionCount,
            lastReadAt: iso(r.lastReadAt),
            muted: r.muted,
            can: r.can,
            lastMessage: r.lastMessage ? { ...r.lastMessage, createdAt: r.lastMessage.createdAt.toISOString() } : null,
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/active-runs",
      tags,
      security,
      summary: "Agents working now in the conversations you are in (any member)",
      description:
        "Agent runs queued, running or waiting (approval or an answer) in the channels and DMs you are a member of, newest first (at most 100). Never another person's DM or a private channel you're not in. No cost.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            runs: z.array(
              z
                .object({
                  runId: z.uuid(),
                  agentId: z.uuid(),
                  channelId: z.uuid(),
                  channelKind: z.enum(["channel", "dm"]),
                  channelName: z.string().nullable().openapi({ description: "Null for a DM." }),
                  threadId: z.uuid().nullable().openapi({ description: "Null: the main timeline (DMs are flat)." }),
                  status: z.enum(["queued", "running", "waiting_approval", "waiting_input"]),
                  startedAt: z.string().nullable(),
                  createdAt: z.string(),
                  label: z
                    .string()
                    .nullable()
                    .openapi({ description: "What it works on: the thread's title, else its first message (≤ 80)." }),
                  pendingMessageIds: z.array(z.uuid()).openapi({
                    description: "Messages sent to it while it works that it hasn't read yet.",
                  }),
                  background: z.boolean().openapi({
                    description: "A routine's work in the background: people's messages never go to it.",
                  }),
                  work: z
                    .object({
                      id: z.uuid(),
                      title: z.string(),
                      plan: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
                      since: z.string(),
                    })
                    .nullable()
                    .openapi({ description: "Long work in the background (ADR 0121): its title, plan and start." }),
                })
                .openapi("WorkingRun"),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const runs = await listWorkingRuns(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ runs }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels",
      tags,
      security,
      summary: "Create a channel (you join it)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            name: z.string().min(1).max(80),
            topic: z.string().max(500).optional(),
            visibility: z.enum(["public", "private"]).optional(),
            audienceRoleIds: z.array(z.uuid()).max(100).optional().openapi({
              description:
                "Private only: people holding one of these roles (departments) also see it and may join (ADR 0125); empty: invite only.",
            }),
            categoryId: z.uuid().nullable().optional().openapi({ description: "Put it in this sidebar category." }),
          }),
        ),
      },
      responses: { 201: json(Channel, "Created"), ...errors },
    }),
    async (c) => {
      const r = await createChannel(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"), {
        pubsub: adapters.pubsub,
      });
      return c.json(
        {
          id: r.id,
          name: r.name,
          topic: r.topic,
          visibility: r.visibility,
          audienceRoleIds: r.audienceRoleIds,
          isMember: true,
          createdByUserId: r.createdByUserId,
          createdAt: r.createdAt.toISOString(),
          categoryId: r.categoryId,
          position: r.position,
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/join",
      tags,
      security,
      summary: "Join a public channel",
      request: { params: ChannelParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await joinChannel(db, c.get("user").id, orgId, channelId, { pubsub: adapters.pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/card",
      tags,
      security,
      summary: "A #channel link's card: name, topic, counts, whether I'm in it (404 for a channel I can't see)",
      request: { params: ChannelParams },
      responses: {
        200: json(
          z.object({
            id: z.uuid(),
            name: z.string(),
            topic: z.string(),
            visibility: z.enum(["public", "private"]),
            audienceRoleIds: z.array(z.uuid()),
            isMember: z.boolean(),
            archived: z.boolean(),
            people: z.number().int(),
            agents: z.number().int(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json(await channelCard(db, c.get("user").id, orgId, channelId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/messages/{messageId}/card",
      tags,
      security,
      summary: "A message link's pill: where the message is and who wrote it, never its text",
      description:
        "404 for a message the viewer can't see: a private channel they can't see, a DM they aren't in, a deleted message. `name` is the channel's, or for a DM who else is in it. `threadId`: the thread a reply is in, else null.",
      request: { params: OrgParams.extend({ messageId: z.uuid() }) },
      responses: {
        200: json(
          z.object({
            id: z.uuid(),
            channelId: z.uuid(),
            threadId: z.uuid().nullable(),
            kind: z.enum(["channel", "dm"]),
            name: z.string(),
            author: z.string(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await messageCard(db, c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/refs/{id}",
      tags,
      security,
      summary: "What an internal id written in a text names, as its pill shows it",
      description:
        "A file, a task, or a message (a run's id: its reply; a background work's: its card, else where it started), only when the viewer may see it. 404 for anything else: the text shows the id as written.",
      request: { params: OrgParams.extend({ id: z.string().max(64) }) },
      responses: {
        200: json(
          z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("file"),
              id: z.uuid(),
              title: z.string(),
              artifactKind: z.string(),
              fileName: z.string().nullable(),
              contentType: z.string().nullable(),
            }),
            z.object({ kind: z.literal("task"), id: z.uuid(), number: z.number().int(), title: z.string() }),
            z.object({
              kind: z.literal("message"),
              message: z.object({
                id: z.uuid(),
                channelId: z.uuid(),
                threadId: z.uuid().nullable(),
                kind: z.enum(["channel", "dm"]),
                name: z.string(),
                author: z.string(),
              }),
            }),
          ]),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, id } = c.req.valid("param");
      return c.json(await idRef(db, c.get("user").id, orgId, id), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/members",
      tags,
      security,
      summary: "People and agents in a channel",
      request: { params: ChannelParams },
      responses: {
        200: json(z.object({ members: z.array(z.object({ type: z.enum(["person", "agent"]), id: z.string() })) })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      return c.json({ members: await listChannelMembers(db, c.get("user").id, orgId, channelId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/members",
      tags,
      security,
      summary: "Add a person or an agent to a channel (creator or admin; an agent also needs an admin or its owner)",
      request: {
        params: ChannelParams,
        body: body(
          z.union([
            z.object({ userId: z.string() }),
            z.object({
              agentId: z.uuid(),
              autoReply: z
                .boolean()
                .optional()
                .openapi({ description: "Answers here without a mention (router). Default true." }),
            }),
          ]),
        ),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await addChannelMember(db, c.get("user").id, orgId, channelId, c.req.valid("json"), { pubsub: adapters.pubsub });
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/active-runs",
      tags,
      security,
      summary: "Agent runs still in progress here (call on load and reconnect to drop stale live rows)",
      request: { params: ChannelParams },
      responses: {
        200: json(
          z.object({
            runs: z.array(
              z.object({
                runId: z.uuid(),
                agentId: z.uuid(),
                channelId: z.uuid(),
                status: z.enum(["queued", "running", "waiting_approval", "waiting_input"]),
                threadId: z.uuid().nullable(),
                triggerMessageId: z.uuid(),
                startedAt: z.string().nullable(),
                heartbeatAt: z.string().nullable().openapi({ description: "Last sign of life of its worker." }),
                createdAt: z.string(),
                workingMs: z.number().int().openapi({
                  description:
                    "How long the work it is doing now has taken, in milliseconds, as this server counts it: since it last went back to work (after waiting for a person, an approval or its computer) or last posted, else since it was created. For the conversation's \"thinking for …\": count on from it with the app's own clock, never from `startedAt`, which stays at the run's first start.",
                }),
                pendingMessageIds: z.array(z.uuid()).openapi({
                  description:
                    "Messages sent while it works that it hasn't read yet. A message whose `meta.steeredRunIds` names a run that is not here, or is here without it in this list, was read (or handed on: `agent.run.redispatched`).",
                }),
                background: z.boolean().openapi({
                  description:
                    "Work in the background (a routine's, or long work, ADR 0121): not the conversation's working row.",
                }),
              }),
            ),
            consults: z
              .array(
                z.object({
                  runId: z
                    .uuid()
                    .openapi({ description: "The asking run (it may have ended: the answer wakes the agent)." }),
                  agentId: z.uuid(),
                  consultedAgentId: z.uuid(),
                  channelId: z.uuid(),
                  threadId: z.uuid().nullable(),
                  since: z.string(),
                }),
              )
              .openapi({
                description:
                  "Questions agents asked from here (`ask_agent`) still without an answer: the working line says one agent is asking another until `agent.consulted`.",
              }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await requireChannelAccess(db, c.get("user").id, orgId, channelId);
      const [runs, consults] = await Promise.all([
        activeRunsIn(db, orgId, channelId),
        openConsultationsIn(db, orgId, channelId),
      ]);
      return c.json(
        {
          runs: runs.map((r) => ({
            ...r,
            status: r.status as "queued" | "running" | "waiting_approval" | "waiting_input",
          })),
          consults: consults.map((q) => ({ ...q, since: q.since.toISOString() })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/consultations",
      tags,
      security,
      summary:
        "Questions agents asked other agents from here, and work they handed them, latest first (drawn inside the reply that asked)",
      request: { params: ChannelParams },
      responses: {
        200: json(
          z.object({
            consultations: z.array(Consultation),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      await requireChannelAccess(db, c.get("user").id, orgId, channelId);
      const list = await consultationsIn(db, orgId, channelId);
      return c.json(
        {
          consultations: list.map((q) => ({
            ...q,
            progress: q.progress ? { ...q.progress, at: q.progress.at.toISOString() } : null,
            createdAt: q.createdAt.toISOString(),
            answeredAt: q.answeredAt?.toISOString() ?? null,
            expiresAt: q.expiresAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/consultations/{consultationId}",
      tags,
      security,
      summary: "One question asked from here, opened: what the two agents said for it (read only)",
      description:
        "The question as it went into the agents' DM, the consulted agent's messages there and the cards it posted here (approvals, questions, secret requests), oldest first. Only this question's part of their DM. 404 when it wasn't asked from this conversation.",
      request: { params: ChannelParams.extend({ consultationId: z.uuid() }) },
      responses: { 200: json(z.object({ consultation: Consultation, messages: z.array(Message) })), ...errors },
    }),
    async (c) => {
      const { orgId, channelId, consultationId } = c.req.valid("param");
      await requireChannelAccess(db, c.get("user").id, orgId, channelId);
      const found = await consultationConversation(db, orgId, channelId, consultationId);
      if (!found) return apiError(c, 404, "not_found", "Question not found");
      const q = found.consultation;
      return c.json(
        {
          consultation: {
            ...q,
            progress: q.progress ? { ...q.progress, at: q.progress.at.toISOString() } : null,
            createdAt: q.createdAt.toISOString(),
            answeredAt: q.answeredAt?.toISOString() ?? null,
            expiresAt: q.expiresAt.toISOString(),
          },
          messages: found.messages,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/channels/{channelId}/messages",
      tags,
      security,
      summary: "Messages of a channel or of one thread",
      request: {
        params: ChannelParams,
        query: z.object({
          threadId: z.uuid().optional(),
          before: z.iso.datetime().optional().openapi({ description: "Page backwards from this time." }),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          include: z
            .string()
            .optional()
            .openapi({ description: "`replies`: add reply count, last activity and the latest replies per thread." }),
        }),
      },
      responses: { 200: json(z.object({ messages: z.array(Message) })), ...errors },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const q = c.req.valid("query");
      const messages = await listMessages(db, c.get("user").id, orgId, channelId, {
        threadId: q.threadId,
        before: q.before ? new Date(q.before) : undefined,
        limit: q.limit,
        includeReplies: q.include?.split(",").includes("replies") ?? false,
      });
      return c.json({ messages }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/channels/{channelId}/messages",
      tags,
      security,
      summary: "Post a message",
      description:
        "@mentioning an agent that is a member of the channel starts an agent run; its reply streams over the WebSocket.",
      request: {
        params: ChannelParams,
        body: body(
          z.object({
            body: z
              .string()
              .max(40_000)
              .openapi({ description: "Markdown. May be empty only when `attachments` has files or `media` is set." }),
            threadId: z.uuid().nullable().optional(),
            replyTo: z.uuid().nullable().optional().openapi({
              description:
                "Quote reply: a message of this channel and, from a thread, of that thread. Stored as `meta.replyTo` ({ messageId, threadId, author, authorName, excerpt, mediaKind?, deleted? }), `deleted` once the original is gone; `mediaKind` (`gif` or `sticker`) when the quoted message has one (ADR 0091), so a quote of a GIF or sticker with no text still says what it was.",
            }),
            media: z
              .discriminatedUnion("kind", [
                z.object({ kind: z.literal("gif"), id: z.string().max(64) }),
                z.object({ kind: z.literal("sticker"), agentId: z.uuid(), mood: z.enum(STICKER_MOODS) }),
              ])
              .optional()
              .openapi({
                description:
                  "A GIF (its `id` from `GET …/gifs`) or an agent's sticker (ADR 0091); `body` may be empty then. Looked up on the server and stored as `meta.media`: a GIF as { kind, provider, id, title, width, height } at the workspace's rating, a sticker as { kind, agentId, mood } of an agent of this workspace. 422 `message.media_off` (GIFs or stickers off here, or no GIF provider), 422 `message.media_not_found`.",
              }),
            attachments: z.array(z.uuid()).max(10).optional().openapi({
              description:
                "Files (artifact ids) you uploaded or files of this channel. Stored as `meta.artifacts` ({ id, version, title }).",
            }),
            openThread: z.boolean().optional().openapi({
              description:
                'Sent from the thread panel ("Responder"), with `threadId`: the thread gets `openedByReplyAt`, so from this reply on the channel shows one line instead of its replies.',
            }),
            steer: z.literal("now").optional().openapi({
              description:
                "Sent while an agent works here (it goes into its task): stop its current model call and read this message now. Without it, the agent reads it at its next step.",
            }),
            clientId: z
              .string()
              .max(64)
              .optional()
              .openapi({ description: "Your id for the optimistic copy; echoed back on the message and its event." }),
          }),
        ),
      },
      responses: {
        201: json(Message, "Created"),
        422: errorResponse("A GIF or sticker that can't be sent (`message.media_off`, `message.media_not_found`)"),
        429: errorResponse("Too many messages"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, channelId } = c.req.valid("param");
      const user = c.get("user");
      const limit = await adapters.rateLimiter.consume(`post:${user.id}`, { limit: 30, windowMs: 10_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Slow down");
      const started = performance.now();
      let message: MessageView;
      try {
        message = await postPersonMessage(
          {
            db,
            pubsub: adapters.pubsub,
            judge: deps.extras?.context?.judge,
            talker: deps.extras?.talker,
            gifs: adapters.gifs,
          },
          user.id,
          orgId,
          channelId,
          c.req.valid("json"),
        );
      } catch (error) {
        // A GIF or sticker that can't go (ADR 0091): the request was fine, what it names can't be sent.
        if (error instanceof ValidationError && MEDIA_REFUSALS.includes(error.code)) {
          return apiError(c, 422, error.code, error.message);
        }
        throw error;
      }
      // Wake the workers now (router, runs, indexing) instead of waiting for the poll.
      deps.wakeWorkers?.();
      // post → `message.created` published (the commit and the event happen inside postPersonMessage).
      c.header("server-timing", `created;dur=${(performance.now() - started).toFixed(1)}`);
      return c.json(message, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/answer-now",
      tags,
      security,
      summary: "Once an AI is connected, the agent answers what it couldn't (Responder agora)",
      description:
        "The id is a no-AI card (`meta.noAi`: its agent's failed run in that conversation starts again on the person's message) or the person's message (its failed runs start again on that same message, \"Tentar de novo\" with no second copy, else a `no_ai` decision is routed again; long work goes on with its own Continuar). Who asked, the agent's owner or an admin. 409 `ai.still_missing` while there's still no AI; 409 `run.not_restartable` when that run had already done something (a tool, a reply, an approval), so starting over would repeat it; 403 `audience.only` or `audience.nobody` when the agent no longer answers who asked (an agent moved onto a plan answers only its owner until they turn on \"Atende outras pessoas\"). Pressed again, it returns the runs that answer it. On a stretch's pause card (`meta.actionCard.kind` `stretch_paused`, ADR 0089) it is Continuar: the wake-ups it holds start at hop 1 in a fresh stretch, once (pressed again, no runs); who asked, the agents' owners or an admin. On a long-work pause card (`usage_paused`, ADR 0118) it is Continuar agora: with paid extra usage off the run goes on up to the plan's own allowance, and 409 `run.continue_extra_off` once that window is used up (`run.continue_extra_used_up` when the switch is on but the plan has no extra usage left).",
      request: { params: OrgParams.extend({ messageId: z.uuid() }) },
      responses: {
        200: json(z.object({ runs: z.array(z.object({ agentId: z.uuid(), runId: z.uuid() })) })),
        429: errorResponse("Too many requests"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const user = c.get("user");
      // It sends the message again, in effect: the same limit as posting.
      const limit = await adapters.rateLimiter.consume(`post:${user.id}`, { limit: 30, windowMs: 10_000 });
      if (!limit.allowed) return apiError(c, 429, "rate_limited", "Slow down");
      const result = await answerNow(
        { ...aiStatusDeps(deps), db, pubsub: adapters.pubsub, router: deps.extras?.router ?? null },
        user.id,
        orgId,
        messageId,
      );
      deps.wakeWorkers?.();
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/cancel-follow-up",
      tags,
      security,
      summary: "Cancel an agent's follow-up from its line",
      description:
        "The id is the follow-up's line (`meta.notice.kind` `follow_up`). Anyone who can read the conversation. The line changes in place (`message.created` with the same id); at its time the agent isn't woken. 409 `follow_up.not_pending` once it came or was canceled.",
      request: { params: OrgParams.extend({ messageId: z.uuid() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      await cancelFollowUp({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, messageId);
      return c.body(null, 204);
    },
  );

  return app;
}
