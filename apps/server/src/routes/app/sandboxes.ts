import {
  getAgentBrowser,
  getAgentComputer,
  getSandboxSettings,
  MAX_BROWSER_DOMAINS,
  requirePermission,
  SANDBOX_LIMITS,
  setAgentBrowserDomains,
  updateSandboxSettings,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { ComputerTarget } from "../machines";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Agent computer"];
const Computer = z
  .object({
    target: ComputerTarget.openapi({
      description:
        "Which computer the agent uses (ADR 0025): a connected computer, or none. Set with `PUT …/computer/target`.",
    }),
  })
  .openapi("AgentComputer");
const Settings = z
  .object({
    enabled: z.boolean(),
    execTimeoutSeconds: z.number(),
    maxTimeoutSeconds: z.number(),
    requireApproval: z.boolean(),
  })
  .openapi("SandboxSettings");
const AgentParams = OrgParams.extend({ agentId: z.uuid() });
const AgentBrowser = z
  .object({
    allowedDomains: z
      .array(z.string())
      .nullable()
      .openapi({ description: "Sites the browser may open (`*.example.com` covers the domain too); null = any." }),
    available: z.boolean().openapi({ description: "Its computer serves the browser now (it may still be offline)." }),
    reason: z
      .enum(["no_machine", "machine_removed", "outdated", "switched_off", "not_installed", "not_reported"])
      .nullable()
      .openapi({
        description:
          "Why not: no connected computer, removed, runner too old, turned off on the computer, not ready there, or not reported yet.",
      }),
    detail: z.string().nullable().openapi({ description: "The computer's own words when it isn't ready." }),
    machine: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    profileId: z
      .uuid()
      .nullable()
      .openapi({ description: "Its default browser: a shared browser profile it may use (ADR 0110); null = its own." }),
  })
  .openapi("AgentBrowser");

/**
 * Which computer each agent uses (ADR 0025), the organization's Run code settings (on or off, a command's
 * default timeout, approval before running code) and each agent's browser (ADR 0040).
 */
export function sandboxRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const settingsView = async (orgId: string) => {
    const s = await getSandboxSettings(db, orgId);
    return {
      enabled: s.enabled,
      execTimeoutSeconds: s.execTimeoutSeconds,
      maxTimeoutSeconds: SANDBOX_LIMITS.maxTimeoutSeconds,
      requireApproval: s.requireApproval,
    };
  };
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/computer",
      tags,
      security,
      summary: "Which computer the agent uses (owner or admins)",
      request: { params: AgentParams },
      responses: { 200: json(Computer), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await getAgentComputer(db, c.get("user").id, orgId, agentId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/sandbox-settings",
      tags,
      security,
      summary: "Settings of the agents' computers in the organization",
      request: { params: OrgParams },
      responses: { 200: json(Settings), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await requirePermission(db, c.get("user").id, orgId, "read");
      return c.json(await settingsView(orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/sandbox-settings",
      tags,
      security,
      summary: "Change the computers' settings (admins): on/off, a command's default timeout, approval",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            enabled: z.boolean().optional(),
            execTimeoutSeconds: z.number().int().min(5).max(SANDBOX_LIMITS.maxTimeoutSeconds).optional(),
            requireApproval: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(Settings), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      await updateSandboxSettings(db, c.get("user").id, orgId, c.req.valid("json"));
      return c.json(await settingsView(orgId), 200);
    },
  );

  const machinesHub = () => deps.extras?.sandbox?.machines?.hub;
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/browser",
      tags,
      security,
      summary: "The agent's browser: whether its computer can serve it, and the sites it may open (ADR 0040)",
      request: { params: AgentParams },
      responses: { 200: json(AgentBrowser), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await getAgentBrowser(db, machinesHub(), c.get("user").id, orgId, agentId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/browser",
      tags,
      security,
      summary: "Set the sites the agent's browser may open (owner or admins); null or empty = any site",
      request: {
        params: AgentParams,
        body: body(
          z.object({
            allowedDomains: z.array(z.string().max(253)).max(MAX_BROWSER_DOMAINS).nullable(),
          }),
        ),
      },
      responses: { 200: json(AgentBrowser), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const { allowedDomains } = c.req.valid("json");
      return c.json(
        await setAgentBrowserDomains(db, machinesHub(), c.get("user").id, orgId, agentId, allowedDomains),
        200,
      );
    },
  );

  return app;
}
