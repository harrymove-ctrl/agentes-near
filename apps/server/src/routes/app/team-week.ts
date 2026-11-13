import { actOnTeamWeek, getTeamWeekPrefs, type RoutineDeps, setTeamWeekPrefs } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  hookConfig,
  json,
  noContent,
  OrgParams,
  requireSession,
  routineConnectorDeps,
  security,
} from "./context";

const tags = ["Right hand"];

const TeamWeekPrefs = z
  .object({
    off: z.boolean(),
    day: z.number().int().min(0).max(6).openapi({ description: "0 = Sunday." }),
    hour: z.number().int().min(0).max(23),
    daily: z.boolean().openapi({
      description: "Resumo do dia: the same card every day at `hour`, over the last day. Anyone may turn it on.",
    }),
    timezone: z.string().openapi({ description: "The workspace's time zone, which `day` and `hour` are in." }),
  })
  .openapi("TeamWeekPrefs");

const TeamWeekAct = z
  .union([
    z.object({ dismiss: z.literal(true) }),
    z.object({
      rowId: z.string().min(1).max(200),
      text: z.string().max(2000).optional().openapi({
        description: "`unanswered` and `stalled`: the person's message, in their words.",
      }),
    }),
  ])
  .openapi("TeamWeekAct");

/**
 * Lodi's weekly card (ADR 0137 §9): the person's own day and hour, or off, and a row of their card applied as them
 * ("Criar rotina", asking Lodi for an agent, telling a task's agent to go on) or "Agora não".
 */
export function teamWeekRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const routines: RoutineDeps = {
    db,
    pubsub: adapters.pubsub,
    context: deps.extras?.context,
    mail: adapters.mail,
    hooks: hookConfig(deps.config),
    connectors: routineConnectorDeps(deps),
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/team-week",
      tags,
      security,
      summary: "When my weekly card comes, or that it is off",
      request: { params: OrgParams },
      responses: { 200: json(TeamWeekPrefs), ...errors },
    }),
    async (c) => c.json(await getTeamWeekPrefs(db, c.req.valid("param").orgId, c.get("user").id), 200),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/team-week",
      tags,
      security,
      summary: "Move my weekly card, stop it or start it again",
      request: { params: OrgParams, body: body(TeamWeekPrefs.omit({ timezone: true }).partial()) },
      responses: { 200: json(TeamWeekPrefs), ...errors },
    }),
    async (c) =>
      c.json(await setTeamWeekPrefs(db, c.req.valid("param").orgId, c.get("user").id, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/team-week/{messageId}",
      tags,
      security,
      summary: "Apply a row of my weekly card, or put it away",
      request: { params: OrgParams.extend({ messageId: z.uuid() }), body: body(TeamWeekAct) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      await actOnTeamWeek(routines, c.get("user").id, orgId, messageId, c.req.valid("json"));
      return c.body(null, 204);
    },
  );

  return app;
}
