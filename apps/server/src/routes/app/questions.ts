import { answerQuestion, dismissQuestion, getQuestion } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Chat"];

const AgentQuestion = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    messageId: z.uuid().nullable(),
    text: z.string(),
    choices: z.array(z.string()).nullable(),
    requestedForUserId: z
      .string()
      .nullable()
      .openapi({ description: "The one person who may answer it; null: anyone in the conversation." }),
    status: z.enum(["open", "answered"]),
    answer: z.string().nullable(),
    answeredByUserId: z.string().nullable(),
    dismissed: z.literal(true).optional(),
  })
  .openapi("AgentQuestion");

const QuestionParams = OrgParams.extend({ questionId: z.uuid() });

/**
 * Questions agents ask people (`ask_user`). The run waits until someone
 * answers here or replies in the thread; after 24 hours it goes on without
 * an answer.
 */
export function questionRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/questions/{questionId}",
      tags,
      security,
      summary: "A question an agent asked",
      request: { params: QuestionParams },
      responses: { 200: json(AgentQuestion), ...errors },
    }),
    async (c) => {
      const { orgId, questionId } = c.req.valid("param");
      return c.json(await getQuestion(db, c.get("user").id, orgId, questionId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/questions/{questionId}/answer",
      tags,
      security,
      summary: "Answer an agent's question (a choice, text, or both); the agent continues",
      request: {
        params: QuestionParams,
        body: body(z.object({ choice: z.string().max(200).optional(), text: z.string().max(4000).optional() })),
      },
      responses: { 200: json(AgentQuestion), ...errors },
    }),
    async (c) => {
      const { orgId, questionId } = c.req.valid("param");
      const answered = await answerQuestion(
        { db, pubsub: adapters.pubsub },
        c.get("user").id,
        orgId,
        questionId,
        c.req.valid("json"),
      );
      return c.json(answered, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/questions/{questionId}/dismiss",
      tags,
      security,
      summary: "Skip an agent's question; the agent continues without an answer",
      request: { params: QuestionParams },
      responses: { 200: json(AgentQuestion), ...errors },
    }),
    async (c) => {
      const { orgId, questionId } = c.req.valid("param");
      return c.json(await dismissQuestion({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, questionId), 200);
    },
  );

  return app;
}
