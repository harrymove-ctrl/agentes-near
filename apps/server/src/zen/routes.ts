import { and, eq, isNull, schema } from "@agenteschat/db";
import { requirePermission } from "@agenteschat/engine";
import { z } from "zod";
import { type AppDeps, createAppRouter, requireSession } from "../routes/app/context";
import {
  listZenDecisions,
  listZenEntities,
  listZenReceipts,
  simulateZenTamperCheck,
  updateZenDecision,
  verifyZenLedger,
} from "./ledger";
import { ZEN_DEMO_PERSONAS } from "./seed";

export function zenAppRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/:orgId/zen/*", requireSession(deps.auth));

  app.get("/organizations/:orgId/zen/overview", async (c) => {
    const orgId = c.req.param("orgId");
    const user = c.get("user");
    await requirePermission(deps.db, user.id, orgId, "read");

    const [verification, decisions, receipts, entities] = await Promise.all([
      verifyZenLedger(deps.db, orgId),
      listZenDecisions(deps.db, orgId),
      listZenReceipts(deps.db, orgId, 30),
      listZenEntities(deps.db, orgId),
    ]);

    return c.json({
      codename: "ZEN",
      product: "Ergo (PoC · CommandOSS Customer Zero)",
      personas: ZEN_DEMO_PERSONAS,
      currentUser: { id: user.id, name: user.name, email: user.email },
      verification,
      decisions,
      receipts,
      entities,
    });
  });

  const decisionBody = z.object({
    status: z.enum(["pending", "agree", "adjust"]),
    note: z.string().max(1000).default(""),
  });

  app.post("/organizations/:orgId/zen/decisions/:decisionId", async (c) => {
    const orgId = c.req.param("orgId");
    const decisionId = c.req.param("decisionId");
    const user = c.get("user");
    await requirePermission(deps.db, user.id, orgId, "read");

    const parsed = decisionBody.parse(await c.req.json());
    const result = await updateZenDecision(deps.db, {
      orgId,
      decisionId,
      status: parsed.status,
      note: parsed.note,
      actorUserId: user.id,
      actorName: user.name,
    });
    const verification = await verifyZenLedger(deps.db, orgId);
    return c.json({ ...result, verification });
  });

  app.post("/organizations/:orgId/zen/tamper-check", async (c) => {
    const orgId = c.req.param("orgId");
    const user = c.get("user");
    await requirePermission(deps.db, user.id, orgId, "read");
    const result = await simulateZenTamperCheck(deps.db, orgId);
    return c.json(result);
  });

  app.get("/organizations/:orgId/zen/export-bundle", async (c) => {
    const orgId = c.req.param("orgId");
    const user = c.get("user");
    await requirePermission(deps.db, user.id, orgId, "read");

    const [agentRows, skillRows, credRows, receipts] = await Promise.all([
      deps.db
        .select({
          id: schema.agents.id,
          handle: schema.agents.handle,
          name: schema.agents.name,
          role: schema.agents.role,
          model: schema.agents.model,
          instructions: schema.agents.instructions,
          appearance: schema.agents.appearance,
          monthlyBudgetNanoUsd: schema.agents.monthlyBudgetNanoUsd,
        })
        .from(schema.agents)
        .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.deletedAt))),
      deps.db
        .select({
          slug: schema.skills.slug,
          name: schema.skills.name,
          description: schema.skills.description,
          version: schema.skills.version,
          body: schema.skills.body,
        })
        .from(schema.skills)
        .where(eq(schema.skills.orgId, orgId)),
      deps.db
        .select({
          provider: schema.providerCredentials.provider,
          label: schema.providerCredentials.label,
          keyHint: schema.providerCredentials.keyHint,
          options: schema.providerCredentials.options,
        })
        .from(schema.providerCredentials)
        .where(and(eq(schema.providerCredentials.orgId, orgId), isNull(schema.providerCredentials.revokedAt))),
      listZenReceipts(deps.db, orgId, 15),
    ]);

    return c.json({
      format: "ergo-bundle/v1",
      epic: "ZEN-E15 (No Vendor Lock-In)",
      exportedAt: new Date().toISOString(),
      exportedBy: { id: user.id, email: user.email },
      secretsIncluded: false,
      secretPolicy: "Zero raw API keys or vault secrets exported; credential references carry provider + keyHint only.",
      providerReferences: credRows.map((cr) => ({
        provider: cr.provider,
        label: cr.label,
        keyHintRedacted: `***${cr.keyHint}`,
        endpointBaseUrl: cr.options?.endpoint?.baseURL ?? null,
      })),
      agents: agentRows,
      skillsMarkdown: skillRows,
      provenanceReceipts: receipts,
    });
  });

  return app;
}
