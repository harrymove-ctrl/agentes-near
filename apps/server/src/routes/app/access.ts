import {
  accessMatrix,
  getAgentAccess,
  getAgentMergeRepositories,
  getAgentRepositories,
  MAX_AGENT_REPOSITORIES,
  setAgentAccess,
  setAgentMergeRepositories,
  setAgentRepositories,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import { type AppDeps, body, createAppRouter, errors, json, OrgParams, requireSession, security } from "./context";

const tags = ["Agents"];
const State = z.enum(["granted", "inherited", "denied", "off"]);
const Tool = z.object({
  name: z.string(),
  label: z.string().openapi({ description: "Human name in English; the app translates built-ins by tool name." }),
  description: z.string(),
  connectionId: z.uuid().nullable(),
  scope: z.string(),
  sensitive: z.boolean(),
  readOnly: z
    .boolean()
    .openapi({ description: "Only reads: built-in :read scopes, MCP readOnlyHint or classified read." }),
  state: State,
});
const Scope = z.object({ scope: z.string(), label: z.string(), state: State, tools: z.array(Tool) });
const AccessTree = z
  .object({
    all: z.boolean(),
    builtins: z.array(Scope),
    connectors: z.array(
      z.object({
        connectionId: z.uuid(),
        connector: z.string(),
        label: z.string(),
        custom: z.boolean(),
        state: State,
        scopes: z.array(Scope),
      }),
    ),
  })
  .openapi("AgentAccess");
const ToolRef = z.object({ connectionId: z.uuid().nullable(), name: z.string().max(64) });

/**
 * What tools each agent may use: all, per connector (and its future tools),
 * per scope, per tool, with per-tool denies. Sensitive tools always ask a
 * person, whatever the grant.
 */
export function accessRoutes(deps: AppDeps) {
  const { db } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const AgentParams = OrgParams.extend({ agentId: z.uuid() });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/access",
      tags,
      security,
      summary: "Effective access as a tree: built-ins, then connectors, scopes and tools",
      request: { params: AgentParams },
      responses: { 200: json(AccessTree), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await getAgentAccess(db, c.get("user").id, orgId, agentId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/access",
      tags,
      security,
      summary: "Replace an agent's access (admins; its owner may only narrow it); every change is audited",
      request: {
        params: AgentParams,
        body: body(
          z.object({
            all: z.boolean(),
            connectors: z.record(z.uuid(), z.boolean()),
            scopes: z.array(z.object({ connectionId: z.uuid().nullable(), scope: z.string() })).max(500),
            tools: z.object({ allow: z.array(ToolRef).max(500), deny: z.array(ToolRef).max(500) }),
          }),
        ),
      },
      responses: { 200: json(AccessTree), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await setAgentAccess(db, c.get("user").id, orgId, agentId, c.req.valid("json")), 200);
    },
  );

  const Repositories = z
    .object({
      repositories: z.array(z.string()).openapi({
        description:
          "owner/name or owner/* (a whole account), in order: the first is where the agent starts. Empty = every repository.",
      }),
    })
    .openapi("AgentRepositories");

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/repositories",
      tags,
      security,
      summary: "The GitHub repositories the agent may use, in order (empty = every repository)",
      request: { params: AgentParams },
      responses: { 200: json(Repositories), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ repositories: await getAgentRepositories(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/repositories",
      tags,
      security,
      summary: "Replace the agent's GitHub repositories (admins; its owner may only narrow them); audited",
      request: {
        params: AgentParams,
        body: body(z.object({ repositories: z.array(z.string().max(220)).max(MAX_AGENT_REPOSITORIES) })),
      },
      responses: { 200: json(Repositories), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const repositories = await setAgentRepositories(
        db,
        c.get("user").id,
        orgId,
        agentId,
        c.req.valid("json").repositories,
      );
      return c.json({ repositories }, 200);
    },
  );

  const MergeRepositories = z
    .object({
      repositories: z.array(z.string()).openapi({
        description:
          "owner/name, never a whole account: where it merges with no approval card, each merge audited and with a receipt.",
      }),
    })
    .openapi("AgentMergeRepositories");

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/merge-repositories",
      tags,
      security,
      summary: "Where the agent merges without asking (Pode fazer merge sem perguntar)",
      request: { params: AgentParams },
      responses: { 200: json(MergeRepositories), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ repositories: await getAgentMergeRepositories(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/merge-repositories",
      tags,
      security,
      summary: "Replace where the agent merges without asking (its owner or an admin); audited",
      request: {
        params: AgentParams,
        body: body(z.object({ repositories: z.array(z.string().max(220)).max(MAX_AGENT_REPOSITORIES) })),
      },
      responses: { 200: json(MergeRepositories), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const repositories = await setAgentMergeRepositories(
        db,
        c.get("user").id,
        orgId,
        agentId,
        c.req.valid("json").repositories,
      );
      return c.json({ repositories }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/access-matrix",
      tags,
      security,
      summary: "Agents × tools with the effective state (admins)",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            agents: z.array(z.object({ id: z.uuid(), name: z.string(), handle: z.string() })),
            tools: z.array(Tool.omit({ state: true }).extend({ group: z.string(), key: z.string() })),
            cells: z.record(z.string(), z.record(z.string(), State)),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await accessMatrix(db, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  return app;
}
