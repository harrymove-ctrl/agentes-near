import { confirmWaitlist, joinWaitlist, WAITLIST_LOCALES } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestLimitIp } from "../http/client-ip";
import { apiError, errorResponse } from "../http/errors";
import { HUMAN_CHECK_HEADER, humanCheckRefusal } from "../http/human-check";
import { type AppDeps, allowedOrigins } from "./app/context";

/** Joins per address per hour, and in total per hour (each one can send an email). */
const JOIN_PER_IP = { limit: 10, windowMs: 3600_000 };
const JOIN_TOTAL = { limit: 500, windowMs: 3600_000 };
/** Confirmation attempts per address per hour (tokens are 192 bits; this only stops noise). */
const CONFIRM_PER_IP = { limit: 30, windowMs: 3600_000 };

const join = createRoute({
  method: "post",
  path: "/waitlist",
  tags: ["Public"],
  summary: "Join the waiting list",
  description:
    "Public, from the landing page (`LANDING_URL` or our origin, JSON only). Emails a confirmation link (double opt-in). Answers 202 whether or not the email was already on the list or confirmed. Guarded by the bot check when this server has one.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().max(254).openapi({ example: "ana@acme.com" }),
            locale: z.enum(WAITLIST_LOCALES).optional(),
          }),
        },
      },
    },
  },
  responses: {
    202: {
      description: "Confirmation pending",
      content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
    },
    400: errorResponse("Invalid email (`invalid_email`) or body (`invalid_request`)"),
    403: errorResponse(
      "Not from our origin (`bad_origin`), or the bot check refused (`human_check`, `human_check_blocked`)",
    ),
    429: errorResponse("Too many attempts (`rate_limited`)"),
  },
});

const confirm = createRoute({
  method: "post",
  path: "/waitlist/confirm",
  tags: ["Public"],
  summary: "Confirm a waiting list email",
  description:
    "Public, from the landing page that the confirmation link opens (POST, so link scanners that only fetch the URL don't confirm).",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({ token: z.string().max(64) }) } },
    },
  },
  responses: {
    200: { description: "Confirmed", content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } } },
    400: errorResponse("Unknown or expired link (`invalid_token`) or bad body (`invalid_request`)"),
    403: errorResponse("Not from our origin (`bad_origin`)"),
    429: errorResponse("Too many attempts (`rate_limited`)"),
  },
});

/**
 * `POST /api/waitlist` and `/api/waitlist/confirm`: the landing page's only call to action.
 * The landing page is its own site (`LANDING_URL`), so these two routes, and only these,
 * answer it through CORS: JSON only, no cookies.
 */
export function registerWaitlist(api: OpenAPIHono, deps: AppDeps) {
  const { config } = deps;
  const landing = config.LANDING_URL ? new URL(config.LANDING_URL).origin : null;
  const origins = new Set([...allowedOrigins(config), ...(landing ? [landing] : [])]);
  const { rateLimiter, humanCheck } = deps.adapters;
  if (landing) {
    const landingCors = cors({
      origin: landing,
      allowMethods: ["POST"],
      allowHeaders: ["content-type", HUMAN_CHECK_HEADER],
      maxAge: 600,
    });
    api.use("/waitlist", landingCors);
    api.use("/waitlist/confirm", landingCors);
  }

  api.openapi(join, async (c) => {
    const origin = c.req.header("origin");
    if (!origin || !origins.has(origin)) return apiError(c, 403, "bad_origin", "Cross-origin request refused");
    const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
    if (!(await rateLimiter.consume(`waitlist:${ip}`, JOIN_PER_IP)).allowed)
      return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
    // Before the total, so refused bots don't spend it.
    const refused = await humanCheckRefusal(humanCheck, c.req.raw.headers, "waitlist", config.TRUSTED_PROXIES);
    if (refused) return apiError(c, 403, refused.code, refused.message);
    const { email, locale } = c.req.valid("json");
    if (!(await rateLimiter.consume("waitlist:all", JOIN_TOTAL)).allowed)
      return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
    // The link opens the landing page, which confirms it.
    await joinWaitlist(deps.db, { email, locale, publicUrl: config.LANDING_URL ?? config.PUBLIC_URL });
    return c.json({ ok: true as const }, 202);
  });

  api.openapi(confirm, async (c) => {
    const origin = c.req.header("origin");
    if (!origin || !origins.has(origin)) return apiError(c, 403, "bad_origin", "Cross-origin request refused");
    const ip = requestLimitIp(c.req.raw.headers, config.TRUSTED_PROXIES);
    if (!(await rateLimiter.consume(`waitlist-confirm:${ip}`, CONFIRM_PER_IP)).allowed)
      return apiError(c, 429, "rate_limited", "Too many requests. Try again later.");
    if (!(await confirmWaitlist(deps.db, c.req.valid("json").token)))
      return apiError(c, 400, "invalid_token", "This link is unknown or expired. Join the list again for a new one.");
    return c.json({ ok: true as const }, 200);
  });
}
