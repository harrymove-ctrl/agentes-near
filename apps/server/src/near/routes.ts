import type { Database } from "@agenteschat/db";
import { requirePermission } from "@agenteschat/engine";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import { apiError, validationHook } from "../http/errors";
import { type AppDeps, createAppRouter, requireSession } from "../routes/app/context";
import {
  fundComputeEndowment,
  getNearStatus,
  placeConvictionBet,
  quoteNearIntent,
  runAgentEscrowAction,
  runEnclaveTest,
} from "./service";

const quoteBodySchema = z.object({
  assetIn: z.string().trim().min(1).max(120).optional(),
  assetOut: z.string().trim().min(1).max(120).optional(),
  amountUsd: z.number().finite().positive().max(1_000_000).optional(),
});

const enclaveBodySchema = z.object({
  agentHandle: z.string().trim().min(1).max(40).optional(),
  amountUsd: z.number().finite().positive().max(100_000),
  capUsd: z.number().finite().positive().max(10_000).optional(),
  action: z.string().trim().min(1).max(80).optional(),
  toAddress: z.string().trim().min(1).max(120).optional(),
  resetDaily: z.boolean().optional(),
});

const betBodySchema = z.object({
  marketId: z.string().trim().min(1).max(80).default("mkt-1click-route"),
  side: z.enum(["BACK", "FADE"]),
  stakeWnear: z.number().finite().positive().max(10_000),
  handle: z.string().trim().min(1).max(60).optional(),
});

const endowmentBodySchema = z.object({
  hours: z.number().finite().positive().max(1000),
  sponsor: z.string().trim().min(1).max(120).optional(),
  useTabBnpl: z.boolean().optional(),
});

const escrowBodySchema = z.object({
  agentHandle: z.string().trim().min(1).max(40).default("ada"),
  taskTitle: z.string().trim().min(1).max(200).optional(),
  amountUsdc: z.number().finite().positive().max(5000).optional(),
  action: z.enum(["hire", "release", "slash"]),
});

async function parseJson<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
  allowEmpty = false,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => (allowEmpty ? {} : null));
  if (raw === null) {
    return { ok: false, res: apiError(c, 400, "invalid_request", "Expected valid JSON body") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join(". ");
    return { ok: false, res: apiError(c, 400, "invalid_request", msg) };
  }
  return { ok: true, data: parsed.data };
}

function registerNearHandlers(
  router: OpenAPIHono<any>,
  prefix: string,
  resolveContext: (c: Context) => Promise<{ db: Database | null | undefined; orgId?: string; defaultHandle?: string }>,
) {
  router.get(`${prefix}/status`, async (c) => {
    const ctx = await resolveContext(c);
    const forceRefresh = c.req.query("refresh") === "1";
    const status = await getNearStatus(ctx.db, { orgId: ctx.orgId, forceRefresh });
    return c.json(status);
  });

  router.post(`${prefix}/quote`, async (c) => {
    const ctx = await resolveContext(c);
    const parsed = await parseJson(c, quoteBodySchema, true);
    if (!parsed.ok) return parsed.res;
    const result = await quoteNearIntent(ctx.db, {
      orgId: ctx.orgId,
      ...parsed.data,
    });
    return c.json(result);
  });

  router.post(`${prefix}/enclave-test`, async (c) => {
    const ctx = await resolveContext(c);
    const parsed = await parseJson(c, enclaveBodySchema);
    if (!parsed.ok) return parsed.res;
    const result = await runEnclaveTest(ctx.db, {
      orgId: ctx.orgId,
      ...parsed.data,
    });
    return c.json(result);
  });

  router.post(`${prefix}/bet`, async (c) => {
    const ctx = await resolveContext(c);
    const parsed = await parseJson(c, betBodySchema);
    if (!parsed.ok) return parsed.res;
    const result = await placeConvictionBet(ctx.db, {
      orgId: ctx.orgId,
      ...parsed.data,
      handle: parsed.data.handle ?? ctx.defaultHandle,
    });
    return c.json(result);
  });

  router.post(`${prefix}/endowment`, async (c) => {
    const ctx = await resolveContext(c);
    const parsed = await parseJson(c, endowmentBodySchema);
    if (!parsed.ok) return parsed.res;
    const result = await fundComputeEndowment(ctx.db, {
      orgId: ctx.orgId,
      ...parsed.data,
      sponsor: parsed.data.sponsor ?? ctx.defaultHandle,
    });
    return c.json(result);
  });

  router.post(`${prefix}/escrow`, async (c) => {
    const ctx = await resolveContext(c);
    const parsed = await parseJson(c, escrowBodySchema);
    if (!parsed.ok) return parsed.res;
    const result = await runAgentEscrowAction(ctx.db, {
      orgId: ctx.orgId,
      ...parsed.data,
    });
    return c.json(result);
  });
}

/**
 * Public judge & landing endpoints mounted at `/api/near/*` (no session required).
 * Allows OcelliLandingPage (`/ocelli`) and judges to exercise live NEAR Intents,
 * OutLayer Intel TDX Spend Guard, Conviction Markets, Compute Endowment, and Escrow immediately.
 */
export function nearPublicRoutes(opts: { db?: Database | null } = {}) {
  const app = new OpenAPIHono({ defaultHook: validationHook() });
  registerNearHandlers(app, "", async () => ({
    db: opts.db ?? null,
    defaultHandle: "judge.near",
  }));
  return app;
}

/**
 * Authenticated workspace routes mounted at `/api/app/organizations/:orgId/near/*`.
 */
export function nearAppRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/:orgId/near/*", requireSession(deps.auth));

  registerNearHandlers(app, "/organizations/:orgId/near", async (c) => {
    const orgId = c.req.param("orgId") ?? "";
    const user = c.get("user") as { id: string; email?: string; name?: string };
    await requirePermission(deps.db, user.id, orgId, "read");
    return {
      db: deps.db,
      orgId,
      defaultHandle: user.email ?? user.name ?? user.id,
    };
  });

  return app;
}
