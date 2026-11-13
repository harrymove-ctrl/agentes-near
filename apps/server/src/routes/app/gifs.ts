import { GIF_ID_PATTERN, GIF_PAGE_MAX, GIF_SIZES, type GifSize } from "@agenteschat/adapters";
import { GIF_CATEGORIES, GIF_CATEGORY_IDS, mediaSettings, requirePermission } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../../http/errors";
import { imageFile } from "../../http/image-file";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Chat"];

/** Searches one person may make: the picker searches as they type and pages as they scroll. */
export const GIF_SEARCHES_PER_PERSON = { limit: 60, windowMs: 60_000 };
/** Files one person may load: a channel full of GIFs and the picker fit, a script using us as a proxy doesn't. */
export const GIF_FILES_PER_PERSON = { limit: 600, windowMs: 60_000 };
/** A page of the picker when the app doesn't say. */
const DEFAULT_PAGE = 24;

const Gif = z
  .object({
    id: z.string(),
    title: z.string().openapi({ description: "The provider's title (outside text)." }),
    width: z.number().int().openapi({ description: "Of the `full` file, in pixels." }),
    height: z.number().int(),
  })
  .openapi("Gif");

/**
 * GIFs (ADR 0091): search through the server's provider, and every GIF's file through the server, so the key and
 * the provider's address never reach a browser. Only while the provider has a key (`GIPHY_API_KEY`, or the one the
 * installation's owner adds in Settings: `available()`) and the workspace has GIFs on; members only.
 */
export function gifRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  /** The provider and the workspace's rating for a member; null while GIFs are off here (no key, or turned off). */
  const gifsFor = async (userId: string, orgId: string) => {
    await requirePermission(db, userId, orgId, "read");
    const gifs = adapters.gifs;
    if (!gifs?.available()) return null;
    const settings = await mediaSettings(db, orgId);
    return settings.gifs ? { gifs, rating: settings.gifRating } : null;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/gifs",
      tags,
      security,
      summary: "Search GIFs: free text, a category, or what's trending (members)",
      description:
        "`category` searches that category's own query (English, which the provider matches best); else `q`; neither: trending. At the workspace's `gifRating`. Load each GIF with `GET …/gifs/{gifId}/media`. 404 `gifs.off` when the server has no GIF provider or no key for it, or the workspace turned GIFs off; 502 `gifs.unavailable` when the provider doesn't answer; 429 past 60 searches a minute.",
      request: {
        params: OrgParams,
        query: z.object({
          q: z.string().max(100).optional(),
          category: z.enum(GIF_CATEGORY_IDS).optional(),
          offset: z.coerce
            .number()
            .int()
            .min(0)
            .max(4999)
            .optional()
            .openapi({ description: "The `next` of the page before." }),
          limit: z.coerce.number().int().min(1).max(GIF_PAGE_MAX).optional().openapi({ description: "Default 24." }),
          lang: z
            .string()
            .max(16)
            .optional()
            .openapi({ description: "The person's language (`pt-BR`, `en`), to match words of a free-text search." }),
        }),
      },
      responses: {
        200: json(
          z.object({
            gifs: z.array(Gif),
            next: z.number().int().nullable().openapi({ description: "The next page's `offset`; null: no more." }),
          }),
        ),
        429: errorResponse("Too many searches"),
        502: errorResponse("The GIF provider didn't answer"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { q, category, offset = 0, limit = DEFAULT_PAGE, lang } = c.req.valid("query");
      const user = c.get("user");
      const on = await gifsFor(user.id, orgId);
      if (!on) return apiError(c, 404, "gifs.off", "GIFs are off here");
      if (!(await adapters.rateLimiter.consume(`gifs:${user.id}`, GIF_SEARCHES_PER_PERSON)).allowed) {
        return apiError(c, 429, "rate_limited", "Slow down");
      }
      const query = category ? GIF_CATEGORIES[category] : (q ?? "").trim();
      const language = category ? "en" : lang?.slice(0, 2).toLowerCase();
      try {
        const page = query
          ? await on.gifs.search({ query, rating: on.rating, lang: language, limit, offset })
          : await on.gifs.trending({ rating: on.rating, limit, offset });
        return c.json(page, 200);
      } catch (error) {
        deps.log?.warn("GIF search failed", { provider: on.gifs.name, error: String(error) });
        return apiError(c, 502, "gifs.unavailable", "GIFs aren't available right now");
      }
    },
  );

  // One file of a GIF (`size`: `preview` for the picker, `full` in a message, the default, `still` for reduced
  // motion), for members, at the workspace's rating: what every `<img>` loads. Cached for good by the browser: a
  // GIF's file never changes.
  app.get("/organizations/:orgId/gifs/:gifId/media", async (c) => {
    const orgId = c.req.param("orgId");
    const gifId = c.req.param("gifId");
    const size = c.req.query("size") ?? "full";
    if (
      !z.uuid().safeParse(orgId).success ||
      !GIF_ID_PATTERN.test(gifId) ||
      !(GIF_SIZES as readonly string[]).includes(size)
    ) {
      return apiError(c, 400, "invalid_request", "Not a GIF");
    }
    const user = c.get("user");
    const on = await gifsFor(user.id, orgId);
    if (!on) return apiError(c, 404, "gifs.off", "GIFs are off here");
    if (!(await adapters.rateLimiter.consume(`gif-files:${user.id}`, GIF_FILES_PER_PERSON)).allowed) {
      return apiError(c, 429, "rate_limited", "Slow down");
    }
    const file = await on.gifs.media(gifId, size as GifSize, on.rating).catch(() => null);
    if (!file) return apiError(c, 404, "not_found", "GIF not found");
    const bytes = file.body instanceof ArrayBuffer ? file.body : await new Response(file.body).arrayBuffer();
    return imageFile({ body: new Uint8Array(bytes), contentType: file.contentType });
  });

  return app;
}
