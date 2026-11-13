import {
  CLAUDE_AUTH_ORGS_MAX,
  CLAUDE_AUTH_ROLLOUTS,
  type ClaudeAuthPolicy,
  operatorClaudeAuth,
  operatorOrgClaudeAuth,
  setClaudeAuthPolicy,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
};
const Count = z.number().int().min(0);

const Method = z.enum(["cli_login", "setup_token"]).openapi("OperatorClaudeLoginMethod", {
  description:
    "`setup_token`: `claude setup-token`'s long-lived token, kept by the computer's runner. `cli_login`: Claude's own login, kept and refreshed by Claude Code in the connection's folder.",
});
const AuthMethod = z.enum(["cli_login", "setup_token", "api_key"]).openapi("OperatorAuthMethod");

const PolicyInput = z
  .object({
    method: Method.openapi({
      description:
        "What NEW Claude sign-ins for all agents use on computers where each agent is its own OS user, in the workspaces `rollout` covers (`setup_token` in the others). Elsewhere they always use Claude's own login.",
    }),
    rollout: z
      .enum(CLAUDE_AUTH_ROLLOUTS)
      .openapi({ description: "`selected`: only the workspaces in `orgIds`. `all`: every workspace." }),
    orgIds: z.array(z.uuid()).max(CLAUDE_AUTH_ORGS_MAX).openapi({ description: "Deduplicated; each must exist." }),
  })
  .openapi("OperatorClaudeAuthInput");

const Policy = PolicyInput.extend({
  changedAt: z.string().nullable().openapi({ description: "When it last changed; null: never." }),
}).openapi("OperatorClaudeAuthPolicy");

const ClaudeAuth = Policy.extend({
  connections: z.object({ cli_login: Count, setup_token: Count, api_key: Count, unknown: Count }).openapi({
    description:
      "Claude subscription connections people have now (signed in or signed out), by how they sign in; `unknown`: their computer never said.",
  }),
}).openapi("OperatorClaudeAuth");

const OrgClaudeAuth = z
  .object({
    effective: z.object({ method: Method }).openapi({
      description:
        "What a new Claude sign-in for all agents uses on the workspace's computers where each agent is its own OS user.",
    }),
    policy: Policy,
    machines: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        system: z.boolean().openapi({ description: "Each agent is its own OS user there." }),
        protocol: z.number().int(),
        claudeLoginMethods: z.array(AuthMethod).openapi({
          description:
            "What a new Claude sign-in for all agents can use there: what its runner said (protocol 50), else what older runners do.",
        }),
        supportsSelected: z.boolean().openapi({
          description: "It can use the method the policy gives it now; else such a sign-in there is refused.",
        }),
        claudeLoginBlocked: z.string().nullable().openapi({
          description:
            "Why its runner's last self-check keeps Claude's own login for all agents off there, as the runner said when it last connected. Null when it can use the policy's method, or the runner didn't say: its check is still running, the switch hasn't reached it, it's offline or older.",
        }),
      }),
    ),
  })
  .openapi("OperatorOrgClaudeAuth");

const policyJson = (p: ClaudeAuthPolicy) => ({
  method: p.method,
  rollout: p.rollout,
  orgIds: p.orgIds,
  changedAt: iso(p.changedAt),
});

/**
 * How new Claude sign-ins for all agents are made (ADR 0150): the installation's policy and how the connections
 * people have now sign in. A change reaches only sign-ins started after it; every connection keeps its method.
 */
export function registerOperatorClaudeAuth(api: OpenAPIHono, { db }: OperatorDeps) {
  const answer = async () => {
    const { connections, ...policy } = await operatorClaudeAuth(db);
    return { ...policyJson(policy), connections };
  };

  api.openapi(
    createRoute({
      method: "get",
      path: "/claude-auth",
      tags,
      summary: "How new Claude sign-ins for all agents are made",
      responses: { 200: json(ClaudeAuth), 401: errors[401] },
    }),
    async (c) => c.json(await answer(), 200),
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/claude-auth",
      tags,
      summary: "Choose how new Claude sign-ins for all agents are made",
      description:
        "Takes effect for sign-ins started after it, with no restart; every connection keeps the method it was made with. Setting the current policy changes nothing. A workspace that doesn't exist is refused (400 `claude_auth.unknown_org`).",
      request: { body: body(PolicyInput) },
      responses: { 200: json(ClaudeAuth), ...errors },
    }),
    async (c) => {
      await setClaudeAuthPolicy(db, c.req.valid("json"));
      return c.json(await answer(), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/claude-auth",
      tags,
      summary: "How new Claude sign-ins for all agents are made in the workspace, and on each of its computers",
      request: { params: OrgParams },
      responses: { 200: json(OrgClaudeAuth), ...errors, 404: errorResponse("No workspace with this id") },
    }),
    async (c) => {
      const view = await operatorOrgClaudeAuth(db, c.req.valid("param").orgId);
      if (!view) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json({ ...view, policy: policyJson(view.policy) }, 200);
    },
  );
}
