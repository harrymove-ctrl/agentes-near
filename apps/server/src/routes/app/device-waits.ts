import { afterDeviceAccessDecided, decideDeviceAccess, deviceWaitAction, firstNames } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, noContent, OrgParams, requireSession, security } from "./context";

const tags = ["Devices"];

/**
 * The agents' side of bring your own devices in the web and phone apps: a device's owner answers an agent's request
 * to use it, and whoever the agent works for presses Try now or Stop waiting on its device card.
 */
export function deviceWaitRoutes(deps: AppDeps) {
  const { db } = deps;
  const pubsub = deps.adapters.pubsub;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/devices/access-requests/{requestId}/decide",
      tags,
      security,
      summary:
        "The device's owner answers an agent's request to use it: once (this work), always (the person joins who can use it) or no; the waiting agent goes on",
      request: {
        params: OrgParams.extend({ requestId: z.uuid() }),
        body: body(z.object({ decision: z.enum(["once", "always", "no"]) })),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, requestId } = c.req.valid("param");
      const userId = c.get("user").id;
      const decided = await decideDeviceAccess({ db, pubsub }, userId, orgId, requestId, c.req.valid("json").decision);
      const owner = (await firstNames(db, [userId])).get(userId) ?? "The owner";
      await afterDeviceAccessDecided({ db, pubsub }, orgId, decided, owner);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/runs/{runId}/device-wait",
      tags,
      security,
      summary:
        "Try now or Stop waiting on an agent's device card (whom it works for, the agent's owner, or who manages agents)",
      request: {
        params: OrgParams.extend({ runId: z.uuid() }),
        body: body(z.object({ action: z.enum(["retry", "stop"]) })),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, runId } = c.req.valid("param");
      await deviceWaitAction({ db, pubsub }, c.get("user").id, orgId, runId, c.req.valid("json").action);
      return c.body(null, 204);
    },
  );

  return app;
}
