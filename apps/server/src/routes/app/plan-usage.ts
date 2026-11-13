import { agentPlanUsage, orgPlanUsage } from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";
import { AccountKind, PlanUsage, PlanWindow } from "./schemas";

const tags = ["Usage"];

const PlanAccountInfo = z.object({
  key: z
    .string()
    .openapi({ description: "`machineId:kind:accountId`, or `…:computer` for the computer's own sign-in." }),
  machineId: z.uuid(),
  machineName: z.string(),
  kind: AccountKind,
  accountId: z.uuid().nullable().openapi({ description: "Null: the computer's own sign-in." }),
  label: z.string().nullable().openapi({ description: "Null for the computer's own sign-in." }),
  plan: z.string().nullable(),
  provider: z.string().nullable().openapi({ description: "A key account's coding plan (`zai`, `kimi`…)." }),
  ownerName: z.string().nullable().openapi({
    description: "Whose it is: its owner, or the person who connected the computer for its own sign-in.",
  }),
  mine: z.boolean().openapi({ description: "The caller owns it." }),
  email: z.string().nullable().openapi({ description: "Only for its owner." }),
  signedOut: z.boolean(),
});

const PlanAccountUsage = PlanAccountInfo.extend({
  usage: PlanUsage.extend({
    windows: z.array(
      PlanWindow.extend({
        agents: z
          .array(z.object({ agentId: z.uuid(), name: z.string(), percent: z.number() }))
          .nullable()
          .openapi({
            description:
              "Each agent's estimated part of `usedPercent`: the percent × its API-priced share of the account's use since the window started. Null: a window of unknown length (no estimate).",
          }),
      }),
    ),
  })
    .nullable()
    .openapi({ description: "The plan's windows as last reported; null: not known yet." }),
  agents: z.array(z.object({ agentId: z.uuid(), name: z.string(), tokens: z.number(), now: z.boolean() })),
  monthTokens: z.number(),
  equivalentUsd: z
    .number()
    .nullable()
    .optional()
    .openapi({ description: "`view_usage` only: what the month's tokens would cost through the API." }),
}).openapi("PlanAccountUsage");

const OrgPlanUsage = z
  .object({
    month: z.string().openapi({ description: "`YYYY-MM` (UTC)." }),
    money: z.boolean().openapi({ description: "The caller sees money (`view_usage`)." }),
    accounts: z.array(PlanAccountUsage),
    api: z.array(
      z.object({
        agentId: z.uuid(),
        name: z.string(),
        tokens: z.number(),
        budgetPercent: z.number(),
        costUsd: z.number().optional(),
        budgetUsd: z.number().optional(),
        budgetIsDefault: z.boolean().optional(),
      }),
    ),
  })
  .openapi("OrgPlanUsage");

const AgentPlanUsage = z
  .object({
    month: z.string(),
    money: z.boolean(),
    tokens: z.number(),
    equivalentUsd: z.number().nullable().optional(),
    sources: z.array(
      z.object({
        key: z
          .string()
          .openapi({ description: "An account's key, `plan:<kind>` (before accounts were recorded) or `api`." }),
        type: z.enum(["plan", "api"]),
        kind: AccountKind.nullable(),
        account: PlanAccountInfo.nullable(),
        removed: z.boolean().openapi({ description: "A plan account that is no longer there." }),
        tokens: z.number(),
        share: z.number().openapi({ description: "Share of the agent's month, 0–100." }),
        lastDay: z.string().nullable(),
        now: z.boolean(),
        equivalentUsd: z.number().nullable().optional(),
        costUsd: z.number().optional(),
        budgetPercent: z.number().optional(),
      }),
    ),
    days: z.array(z.object({ date: z.string(), tokens: z.record(z.string(), z.number()) })),
    current: PlanAccountUsage.nullable(),
  })
  .openapi("AgentPlanUsage");

/**
 * The usage views (ADR 0063): every plan account by computer with the API per
 * agent, and an agent's month by account. Any member; money only with
 * `view_usage`, an account's email only for its owner.
 */
export function planUsageRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage/plans",
      tags,
      security,
      summary: "Plan accounts by computer, each window split by agent, and the API per agent this month",
      request: { params: OrgParams },
      responses: { 200: json(OrgPlanUsage), ...errors },
    }),
    async (c) => c.json(await orgPlanUsage(db, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/usage",
      tags,
      security,
      summary: "An agent's month by account and day, and the account it thinks with now",
      request: { params: OrgParams.extend({ agentId: z.uuid() }) },
      responses: { 200: json(AgentPlanUsage), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await agentPlanUsage(db, c.get("user").id, orgId, agentId), 200);
    },
  );

  return app;
}
