import {
  isAgentesCloud,
  type JevKey,
  type JevKeyView,
  jevMonth,
  NotFoundError,
  pinnedOwner,
  ValidationError,
} from "@agenteschat/engine";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, requireSession, security } from "./context";

const tags = ["System"];

const Jev = z
  .object({
    source: z
      .enum(["env", "settings"])
      .nullable()
      .openapi({ description: "`env`: `TYPESAFE_API_KEY`, read-only here. `settings`: added here. Null: none." }),
    hint: z.string().nullable().openapi({ description: "The key's last 4 characters. The key is never returned." }),
    state: z.enum(["off", "ok", "invalid", "no_credit"]).openapi({
      description: "What its owner can fix: TypeSafe refused the key, or its account is out of credit. Else `ok`.",
    }),
    month: z
      .object({ decisions: z.number().int(), costUsd: z.number() })
      .openapi({ description: "Jev's calls this month (UTC), every workspace on the server together." }),
  })
  .openapi("JevKey");

const ApiKey = z.object({
  apiKey: z.string().trim().min(8).max(512).openapi({
    description:
      "The TypeSafe key, checked with TypeSafe before it is stored. Printable ASCII with no spaces, else 422 `jev_key_invalid` before any check, like a key TypeSafe refuses.",
  }),
});

/** Limits checking keys through this server, so it can't test keys in bulk. */
const WRITES = { limit: 10, windowMs: 60_000 };

const notFound = "404 for everyone but the installation's pinned owner (ADR 0073), and on agentes.chat itself.";
const tooMany = { 429: errorResponse("Too many tries (`rate_limited`)") };

/** The installation's Jev key (ADR 0073): only its pinned owner, and never on agentes.chat's own servers. */
export function jevRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/jev", requireSession(deps.auth));
  app.use("/jev/*", requireSession(deps.auth));

  const ownerOnly = async (userId: string): Promise<JevKey> => {
    const jev = deps.extras?.jevKey;
    if (!jev || isAgentesCloud(config.PUBLIC_URL) || (await pinnedOwner(db)) !== userId) throw new NotFoundError();
    return jev;
  };
  const allowed = async (userId: string) => (await deps.adapters.rateLimiter.consume(`jev:${userId}`, WRITES)).allowed;
  const withMonth = async (view: JevKeyView) => {
    const month = await jevMonth(db);
    return { ...view, month: { decisions: month.decisions, costUsd: nanoUsdToUsd(month.costNanoUsd) } };
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/jev",
      tags,
      summary: "The installation's Jev key: where it comes from, its last 4 characters and its state",
      description: notFound,
      security,
      responses: { 200: json(Jev), 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const jev = await ownerOnly(c.get("user").id);
      return c.json(await withMonth(await jev.view()), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/jev",
      tags,
      summary: "Add or replace the Jev key",
      description: `${notFound} Checked with TypeSafe first: a key it refuses is not stored (422 \`jev_key_invalid\`). 409 \`jev_key_env\` while \`TYPESAFE_API_KEY\` is set. Recorded in every workspace's audit log, with the key's last 4 characters.`,
      security,
      request: { body: body(ApiKey) },
      responses: {
        200: json(Jev),
        ...errors,
        422: errorResponse("TypeSafe refused the key, or it can't be one (`jev_key_invalid`)"),
        ...tooMany,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const jev = await ownerOnly(user.id);
      if (!(await allowed(user.id))) return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      try {
        return c.json(await withMonth(await jev.save(c.req.valid("json").apiKey, user.id)), 200);
      } catch (error) {
        if (error instanceof ValidationError && error.code === "jev_key_invalid") {
          return apiError(c, 422, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/jev/check",
      tags,
      summary: "Check the Jev key with TypeSafe again",
      description: `${notFound} An answer that says nothing about the key (a limit, an outage) leaves its state as it was.`,
      security,
      responses: { 200: json(Jev), 401: errors[401], 404: errors[404], ...tooMany },
    }),
    async (c) => {
      const user = c.get("user");
      const jev = await ownerOnly(user.id);
      if (!(await allowed(user.id))) return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      return c.json(await withMonth(await jev.check()), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/jev",
      tags,
      summary: "Remove the Jev key",
      description: `${notFound} 409 \`jev_key_env\` while \`TYPESAFE_API_KEY\` is set. Recorded in every workspace's audit log.`,
      security,
      responses: { 200: json(Jev), 401: errors[401], 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const user = c.get("user");
      const jev = await ownerOnly(user.id);
      return c.json(await withMonth(await jev.remove(user.id)), 200);
    },
  );

  return app;
}
