import {
  agentWorkForViewer,
  askWorkspaceAction,
  decideWorkspaceAction,
  getWorkspaceActionCard,
  redoAgentAction,
  undoAgentAction,
  undoMessageActions,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";
import { AgentAction } from "./schemas";

const tags = ["Chat"];

const ForYouItem = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("action"), at: z.string(), channelId: z.uuid(), action: AgentAction }),
    z.object({
      type: z.literal("file"),
      at: z.string(),
      file: z.object({
        id: z.uuid(),
        kind: z.enum(["document", "table", "diff", "html", "diagram", "file", "block", "poll", "choices"]),
        title: z.string(),
        channelId: z.string().nullable(),
        threadId: z.string().nullable(),
      }),
    }),
    z.object({
      type: z.literal("approval"),
      at: z.string(),
      approval: z.object({
        id: z.uuid(),
        title: z.string(),
        status: z.enum(["pending", "approved", "refused", "expired", "canceled"]),
        channelId: z.string(),
        threadId: z.string().nullable().openapi({ description: "Where its card is; null: the main timeline." }),
        waitingOnYou: z.boolean().openapi({ description: "Pending, and the viewer may decide it." }),
      }),
    }),
  ])
  .openapi("AgentForYouItem");

const WorkspaceActionCard = z
  .object({
    kind: z.literal("workspace_action"),
    forUserId: z.string(),
    params: z.object({
      action: z.string().openapi({ description: "The catalog action (`create_role`…): `rightHand.action.{action}`." }),
      input: z.record(z.string(), z.unknown()),
      words: z.record(z.string(), z.string()).openapi({ description: "Values for its sentence." }),
      needs: z.string().nullable().openapi({ description: "The key its screen asks for; null: anyone." }),
      why: z.string(),
      refused: z
        .boolean()
        .optional()
        .openapi({ description: "Its screen refused the person it was for: they send it on (`ask`)." }),
      self: z
        .boolean()
        .optional()
        .openapi({ description: "It changes whoever applies it (their status…): only the person it was for may." }),
    }),
    state: z.enum(["pending", "applied", "dismissed"]),
    decidedByUserId: z.string().nullable(),
    decidedAt: z.string().nullable(),
    askedAt: z.string().nullable().optional(),
  })
  .openapi("WorkspaceActionCard");

/**
 * Act with undo (ADR 0037 round 2): the receipts under an agent's reply.
 * The person the agent worked for, admins and the agent's owner may undo
 * (or redo) while `undoableUntil` has not passed. Conflicts (409):
 * `action.changed_since` (someone changed it after the agent),
 * `action.expired`, `action.already_undone`, `action.not_undone`.
 * Everyone in the channel hears `message.actions`.
 */
export function actionRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const undoDeps = { db, pubsub: deps.adapters.pubsub };
  const ActionParams = OrgParams.extend({ actionId: z.uuid() });

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/actions/{actionId}/undo",
      tags,
      security,
      summary: "Undo a change an agent made (Desfazer)",
      request: { params: ActionParams, body: body(z.object({})) },
      responses: { 200: json(AgentAction), ...errors },
    }),
    async (c) => {
      const { orgId, actionId } = c.req.valid("param");
      return c.json(await undoAgentAction(undoDeps, c.get("user").id, orgId, actionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/actions/{actionId}/redo",
      tags,
      security,
      summary: "Redo a change that was undone (Refazer)",
      request: { params: ActionParams, body: body(z.object({})) },
      responses: { 200: json(AgentAction), ...errors },
    }),
    async (c) => {
      const { orgId, actionId } = c.req.valid("param");
      return c.json(await redoAgentAction(undoDeps, c.get("user").id, orgId, actionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/actions/undo",
      tags,
      security,
      summary: "Undo every change of an agent's reply still undoable, newest first (Desfazer tudo)",
      request: { params: OrgParams.extend({ messageId: z.uuid() }), body: body(z.object({})) },
      responses: {
        200: json(
          z.object({
            actions: z.array(AgentAction).openapi({ description: "The message's receipts now." }),
            failed: z
              .array(z.object({ id: z.uuid(), code: z.string(), message: z.string() }))
              .openapi({ description: "Changes that could not be undone (e.g. `action.changed_since`)." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await undoMessageActions(undoDeps, c.get("user").id, orgId, messageId), 200);
    },
  );

  const CardParams = OrgParams.extend({ messageId: z.uuid() });
  // What the screens' own routes pass: a channel deleted from a card stops its missions and mail triggers too.
  const cardDeps = {
    db,
    pubsub: deps.adapters.pubsub,
    server: { publicUrl: deps.config.PUBLIC_URL, secret: deps.config.AGENTES_SECRET },
    hub: deps.extras?.sandbox?.machines?.hub ?? null,
    mail: deps.adapters.mail,
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/action-cards/{messageId}",
      tags,
      security,
      summary: "A right hand's card of a workspace change, as it is now",
      description: "For whoever reads its conversation, or whom it was sent to and may make the change.",
      request: { params: CardParams },
      responses: {
        200: json(
          z.object({
            messageId: z.uuid(),
            channelId: z.uuid(),
            threadId: z.uuid().nullable(),
            card: WorkspaceActionCard,
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await getWorkspaceActionCard(db, c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/action-cards/{messageId}/{decision}",
      tags,
      security,
      summary: "Apply, dismiss or send to whoever may a right hand's card of a workspace change",
      description:
        "`apply` makes the change as you, with the permissions its screen checks, and puts its receipt (with Undo) on " +
        "the card; `dismiss` is for the person it was for or anyone who may; `ask` sends it to whoever may (the person " +
        "it was for, when they can't). 409 `action_card.decided` once decided.",
      request: {
        params: CardParams.extend({ decision: z.enum(["apply", "dismiss", "ask"]) }),
        body: body(z.object({})),
      },
      responses: { 200: json(z.object({ card: WorkspaceActionCard })), ...errors },
    }),
    async (c) => {
      const { orgId, messageId, decision } = c.req.valid("param");
      const userId = c.get("user").id;
      const card =
        decision === "ask"
          ? await askWorkspaceAction(cardDeps, userId, orgId, messageId)
          : await decideWorkspaceAction(cardDeps, userId, orgId, messageId, decision);
      return c.json({ card }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/for-you",
      tags,
      security,
      summary: "What an agent did for the viewer: their receipts, its files in shared conversations, approvals",
      description:
        "Newest first. Receipts of runs the viewer asked for (not undone, memory left out), files the agent made " +
        "in conversations the viewer shares with it, approvals the viewer decided or may decide now.",
      request: {
        params: OrgParams.extend({ agentId: z.uuid() }),
        query: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }),
      },
      responses: {
        200: json(
          z.object({
            items: z.array(ForYouItem),
            monthCount: z.number().openapi({ description: "Items since the first day of this month (UTC)." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      return c.json(await agentWorkForViewer(db, c.get("user").id, orgId, agentId, { limit }), 200);
    },
  );

  return app;
}
