import { type GifKey, isAgentesCloud, NotFoundError, pinnedOwner, ValidationError } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, requireSession, security } from "./context";

const tags = ["System"];

const KeyView = z
  .object({
    source: z
      .enum(["env", "settings"])
      .nullable()
      .openapi({ description: "`env`: `GIPHY_API_KEY`, read-only here. `settings`: added here. Null: none." }),
    hint: z.string().nullable().openapi({ description: "The key's last 4 characters. The key is never returned." }),
    state: z.enum(["off", "ok", "invalid"]).openapi({
      description:
        "`invalid`: a saved key that doesn't open on this server (another `AGENTES_SECRET`), or one in `GIPHY_API_KEY` that can't be a key. `off`: none.",
    }),
  })
  .openapi("GifKey");

const ApiKey = z.object({
  apiKey: z.string().trim().min(8).max(512).openapi({
    description:
      "The GIPHY key, checked with GIPHY before it is stored. Printable ASCII with no spaces, else 422 `gif_key_invalid` before any check, like a key GIPHY refuses.",
  }),
});

/** Limits checking keys through this server, so it can't test keys in bulk. */
const WRITES = { limit: 10, windowMs: 60_000 };

const notFound = "404 for everyone but the installation's pinned owner (ADR 0073), and on agentes.chat itself.";
const tooMany = { 429: errorResponse("Too many tries (`rate_limited`)") };

/**
 * The installation's GIPHY key (ADR 0091, amended 2026-10-31): only its pinned owner, and never on agentes.chat's own
 * servers, whose key is in their environment. A save or a removal turns GIFs on or off in every workspace at once
 * (`gifsAvailable`).
 */
export function gifKeyRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/gif-key", requireSession(deps.auth));

  const ownerOnly = async (userId: string): Promise<GifKey> => {
    const gifKey = deps.extras?.gifKey;
    if (!gifKey || isAgentesCloud(config.PUBLIC_URL) || (await pinnedOwner(db)) !== userId) throw new NotFoundError();
    return gifKey;
  };
  const allowed = async (userId: string) =>
    (await deps.adapters.rateLimiter.consume(`gif-key:${userId}`, WRITES)).allowed;

  app.openapi(
    createRoute({
      method: "get",
      path: "/gif-key",
      tags,
      summary: "The installation's GIPHY key: where it comes from, its last 4 characters and its state",
      description: notFound,
      security,
      responses: { 200: json(KeyView), 401: errors[401], 404: errors[404] },
    }),
    async (c) => {
      const gifKey = await ownerOnly(c.get("user").id);
      return c.json(await gifKey.view(), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/gif-key",
      tags,
      summary: "Add or replace the GIPHY key",
      description: `${notFound} Checked with GIPHY first: a key it refuses is not stored (422 \`gif_key_invalid\`). 409 \`gif_key_env\` while \`GIPHY_API_KEY\` is set. GIFs work in every workspace at once. Recorded in every workspace's audit log, with the key's last 4 characters.`,
      security,
      request: { body: body(ApiKey) },
      responses: {
        200: json(KeyView),
        ...errors,
        422: errorResponse("GIPHY refused the key, or it can't be one (`gif_key_invalid`)"),
        ...tooMany,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const gifKey = await ownerOnly(user.id);
      if (!(await allowed(user.id))) return apiError(c, 429, "rate_limited", "Too many tries. Wait a minute.");
      try {
        return c.json(await gifKey.save(c.req.valid("json").apiKey, user.id), 200);
      } catch (error) {
        if (error instanceof ValidationError && error.code === "gif_key_invalid") {
          return apiError(c, 422, error.code, error.message);
        }
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/gif-key",
      tags,
      summary: "Remove the GIPHY key",
      description: `${notFound} 409 \`gif_key_env\` while \`GIPHY_API_KEY\` is set. GIFs stop in every workspace at once. Recorded in every workspace's audit log.`,
      security,
      responses: { 200: json(KeyView), 401: errors[401], 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const user = c.get("user");
      const gifKey = await ownerOnly(user.id);
      return c.json(await gifKey.remove(user.id), 200);
    },
  );

  return app;
}
