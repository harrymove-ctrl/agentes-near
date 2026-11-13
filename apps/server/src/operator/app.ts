import type { HumanCheck, PubSub } from "@agenteschat/adapters";
import type { Config } from "@agenteschat/config";
import type { Database } from "@agenteschat/db";
import { type MachineHub, type SessionScreening, safeEqual } from "@agenteschat/engine";
import { OpenAPIHono } from "@hono/zod-openapi";
import { apiError, domainErrorResponse, routeOf, validationHook } from "../http/errors";
import type { Logger } from "../logger";
import { registerOperatorAccess } from "./access";
import { registerOperatorAnalytics } from "./analytics";
import { registerOperatorClaudeAuth } from "./claude-auth";
import { registerOperatorEvents } from "./events";
import { registerOperatorLimits } from "./limits";
import { registerOperatorMachines } from "./machines";
import { registerOperatorOrgs } from "./orgs";
import { registerOperatorStanding } from "./standing";

/** Versioned because its caller deploys apart from this server (ADR 0056 §3). */
export const OPERATOR_API_PREFIX = "/api/operator/v1";

export interface OperatorDeps {
  db: Database;
  config: Config;
  version: string;
  log: Logger;
  /** Tells a workspace's members and admins of a change of standing (absent: nobody hears it live). */
  pubsub?: PubSub;
  /** Stops a suspended workspace's tasks on its computers. */
  hub?: MachineHub;
  /**
   * The server sends email: a workspace waiting long for its computer is told its owners will be emailed, and
   * early-access invitations can go out.
   */
  emails?: boolean;
  /** The bot check (ADR 0075), reported by `/health`; absent: `off`. */
  humanCheck?: HumanCheck | null;
  /** Screened sessions (ADR 0076), read through the review door; absent: none, so every one is a 404. */
  sessions?: Pick<SessionScreening, "segment"> | null;
}

/**
 * The operator API (ADR 0056): what the people who run this instance need from their own services,
 * behind one bearer token. Served only by its own listener (`serveOperatorApi`), never by `createApp`.
 */
export function createOperatorApp(deps: OperatorDeps, token: string) {
  const api = new OpenAPIHono({ defaultHook: validationHook() });
  api.openAPIRegistry.registerComponent("securitySchemes", "operator", {
    type: "http",
    scheme: "bearer",
    description: "This server's `OPERATOR_API_TOKEN`.",
  });
  // Every path under the prefix, unknown ones and the document included, so nothing answers without it.
  api.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    if (!safeEqual(header.startsWith("Bearer ") ? header.slice(7).trim() : "", token)) {
      return apiError(c, 401, "unauthorized", "Missing or wrong operator token");
    }
    await next();
  });
  registerOperatorOrgs(api, deps);
  registerOperatorStanding(api, deps);
  registerOperatorLimits(api, deps);
  registerOperatorEvents(api, deps);
  registerOperatorMachines(api, deps);
  registerOperatorAccess(api, deps);
  registerOperatorAnalytics(api, deps);
  registerOperatorClaudeAuth(api, deps);
  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentes.chat operator API",
      version: deps.version,
      description:
        "Workspace and account lookups, workspace standing, billing holds and limits (ADR 0079), the events feed and review blocks, the workspaces' computers from an external provisioner, who may sign up (the waiting list and early-access invitations, ADR 0078), how new Claude sign-ins for all agents are made (ADR 0150), and how connectors are used (ADR 0103), for the people who run this instance (ADR 0056).",
    },
    servers: [{ url: OPERATOR_API_PREFIX }],
    security: [{ operator: [] }],
  });

  const app = new OpenAPIHono();
  app.onError((error, c) => {
    const mapped = domainErrorResponse(error, c);
    if (mapped) return mapped;
    deps.log.error("unhandled error", {
      method: c.req.method,
      path: c.req.path,
      route: routeOf(c),
      status: 500,
      orgId: c.req.param("orgId"),
      error,
      stack: error.stack,
    });
    return apiError(c, 500, "internal_error", "Something went wrong on our side");
  });
  app.route(OPERATOR_API_PREFIX, api);
  app.notFound((c) => apiError(c, 404, "not_found", "Route not found"));
  return app;
}

/** The operator API's own listener, only when `OPERATOR_API_TOKEN` is set: without it nothing listens. */
export function serveOperatorApi(deps: OperatorDeps, port = deps.config.OPERATOR_API_PORT) {
  const token = deps.config.OPERATOR_API_TOKEN;
  if (!token) return null;
  const app = createOperatorApp(deps, token);
  return Bun.serve({ hostname: deps.config.HOST, port, fetch: (req) => app.fetch(req) });
}
