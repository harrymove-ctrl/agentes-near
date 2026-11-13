import { BILLING_FROM, mintBillingLink, orgLimitsView, PLAN_CLAIM } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { apiError } from "../../http/errors";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Billing"];

/**
 * The workspace's way to the billing service, and its limits (ADR 0079): this server knows no plan, price or
 * currency, only a link that opens the service signed in as the person asking and the numbers the service set.
 */
export function billingRoutes(deps: AppDeps) {
  const { db, config } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/billing-link",
      tags,
      security,
      summary: "A signed link to the workspace's plan and billing (owners and admins)",
      description:
        "Opens the billing service signed in as you, for 5 minutes and once. Allowed on hold (paying is how a billing hold ends) and while the workspace is being deleted (its invoices and card stay within reach), refused while suspended. 404 `billing.off` when this server has no billing service.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            from: z
              .enum(BILLING_FROM)
              .openapi({ description: "Where in the app it was opened: the billing service opens on that." }),
            returnTo: z.string().max(500).optional().openapi({
              description:
                "The page it was opened from (a path in this workspace, `/org/{orgId}/…`): the billing service sends the person back there instead of the entry point's default, its search and hash dropped. Anything else is ignored.",
            }),
            plan: z.string().regex(PLAN_CLAIM).optional().openapi({
              description:
                "The plan picked in the app, as the billing service's own plan list names it: it opens that plan's Checkout. This server never reads it.",
            }),
          }),
        ),
      },
      responses: { 200: json(z.object({ url: z.string(), expiresAt: z.string() })), ...errors },
    }),
    async (c) => {
      if (!config.BILLING_URL || !config.BILLING_LINK_SECRET)
        return apiError(c, 404, "billing.off", "This server has no billing service");
      const link = await mintBillingLink(db, {
        secret: config.BILLING_LINK_SECRET,
        baseUrl: config.BILLING_URL,
        userId: c.get("user").id,
        orgId: c.req.valid("param").orgId,
        from: c.req.valid("json").from,
        returnTo: c.req.valid("json").returnTo,
        plan: c.req.valid("json").plan,
      });
      return c.json({ url: link.url, expiresAt: link.expiresAt.toISOString() }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/limits",
      tags,
      security,
      summary: "People, files and today's uploads against the workspace's limits",
      description:
        "Any member. A limit null: none (a self-hosted server never sets any). `storage.ownStorage`: new files go to the workspace's own bucket, which no limit counts.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            members: z.object({
              used: z.number().int(),
              limit: z.number().int().nullable().openapi({ description: "The seats paid for." }),
              max: z
                .number()
                .int()
                .nullable()
                .openapi({ description: "The most people the plan takes with seats added; null: not said." }),
              canAddSeats: z.boolean().openapi({
                description: "Below `max`: whoever manages billing can add a seat on the billing service.",
              }),
              payer: z
                .object({
                  you: z.boolean().openapi({ description: "The viewer pays for the plan." }),
                  name: z.string().nullable().openapi({
                    description:
                      "To anyone else who manages billing, the payer's name while they are in the workspace.",
                  }),
                })
                .nullable()
                .openapi({
                  description:
                    "Who pays for the plan, the only one who can add seats or change plans; null: the billing service didn't say.",
                }),
            }),
            storage: z.object({
              usedBytes: z
                .number()
                .int()
                .openapi({ description: "Files on this server's storage, the trash left out." }),
              limitBytes: z.number().int().nullable(),
              ownStorage: z.boolean(),
            }),
            uploads: z.object({
              usedBytes24h: z.number().int().openapi({ description: "Written to this server's storage in 24 hours." }),
              limitBytesPerDay: z.number().int().nullable(),
            }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await orgLimitsView(db, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  return app;
}
