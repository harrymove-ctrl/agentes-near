import {
  STANDING_NOTICES,
  STANDING_STATES,
  setAgentHold,
  setDeletionHold,
  setOrgStanding,
  setUserBlocked,
} from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { body, iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

export const StandingState = z.enum(STANDING_STATES).openapi("OperatorStandingState", {
  description:
    "`active`; `hold`: its agents stop (no model, computer, routine or invitation), people still read and write; `suspended`: the workspace refuses everything to everyone, and its runs and tasks stop at once.",
});
export const StandingNotice = z.enum(STANDING_NOTICES).openapi("OperatorStandingNotice", {
  description:
    "`shown`: the workspace is told the reason, the change goes into its audit log and a new state notifies its owners and admins. `silent`: it is told only that it is paused, and nothing is written where it can read it. Use `silent` only when an authority's order forbids telling them.",
});

export const Standing = z
  .object({
    state: StandingState,
    reason: z.string().nullable(),
    note: z.string().nullable().openapi({ description: "The operator's own note: never shown to the workspace." }),
    notice: StandingNotice,
    changedAt: z.string().nullable().openapi({ description: "When `state` last changed; null: never." }),
  })
  .openapi("OperatorStanding");

const StandingInput = z.object({
  state: StandingState,
  reason: z.string().trim().min(1).max(64).openapi({
    description:
      "Shown to the workspace with the notice `shown`, its owners' notice included. On agentes.chat Cloud, `review` reads as the automatic review hold's line, `review.<category>` as that line naming what was flagged (`phishing_impersonation`, `account_takeover`, `fraud` or `illegal_content`, any other category reading as plain `review`), `ended` (a plan that ended) as it is, and any other reason is followed by how to contest it, so name the Terms section it rests on.",
  }),
  note: z.string().trim().max(2000).optional(),
  notice: StandingNotice,
});

/** The operator's own reason for a hold or a block: never shown to the workspace or the person. */
const Reason = z.string().trim().min(1).max(64).optional();

const AgentHold = z
  .object({
    held: z.boolean(),
    heldAt: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .openapi("OperatorAgentHold");

const UserBlock = z
  .object({
    blocked: z.boolean(),
    blockedAt: z.string().nullable(),
    reason: z.string().nullable(),
    sessionsRevoked: z.number().int().openapi({ description: "Sessions deleted by this call (0 when unblocking)." }),
  })
  .openapi("OperatorUserBlock");

const DeletionHold = z
  .object({
    held: z.boolean(),
    heldAt: z.string().nullable(),
    reason: z.string().nullable().openapi({ description: "The operator's own reason: never shown to the workspace." }),
  })
  .openapi("OperatorDeletionHold");

const AgentParams = OrgParams.extend({ agentId: z.uuid().openapi({ param: { name: "agentId", in: "path" } }) });

export const UserParams = z.object({
  userId: z
    .string()
    .min(1)
    .max(200)
    .openapi({ param: { name: "userId", in: "path" } }),
});

/** The standing in the API's shape. */
export const standingJson = (s: {
  state: (typeof STANDING_STATES)[number];
  reason: string | null;
  note: string | null;
  notice: (typeof STANDING_NOTICES)[number];
  changedAt: Date | null;
}) => ({ ...s, changedAt: iso(s.changedAt) });

export function registerOperatorStanding(api: OpenAPIHono, { db, pubsub, hub }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/standing",
      tags,
      summary: "Hold, suspend or restore a workspace",
      description:
        "Enforced by this server where work starts: model calls, computer calls, routines, invitations and, when suspended, every permission check. Suspending also stops its runs and its tasks on computers now; cutting a computer's network is up to the operator's own controls on it. Held or suspended, it waits for no computer: what its provisioner last said goes (a ready computer stays), and it is a request again once active. It takes effect at once in this process and within 5 seconds in the server's others. Setting what is already set tells nobody again.",
      request: { params: OrgParams, body: body(StandingInput) },
      responses: { 200: json(Standing), ...errors },
    }),
    async (c) => {
      const { note, ...change } = c.req.valid("json");
      const standing = await setOrgStanding({ db, pubsub, hub }, c.req.valid("param").orgId, {
        ...change,
        note: note || null,
      });
      if (!standing) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json(standingJson(standing), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/agents/{agentId}/hold",
      tags,
      summary: "Hold one agent, or let it go",
      description:
        "Held, the agent starts nothing (no run, model call, computer work, routine or bridge call) and is never picked to answer; the rest of the workspace works. What it is doing stops at its next model, computer or bridge call. The workspace reads only that the agent is paused, never the reason. On agentes.chat Cloud it reads the hold's kind with how to contest it (`network` for a reason starting with `network.`, else `operator`), and the agent's responsible person and the workspace's owners and admins get a notice, replaced when it is held again for another kind and closed when the agent is let go. At once in this process, within 5 seconds in the others.",
      request: { params: AgentParams, body: body(z.object({ held: z.boolean(), reason: Reason })) },
      responses: { 200: json(AgentHold), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const { held, reason } = c.req.valid("json");
      const row = await setAgentHold(db, orgId, agentId, { held, reason: reason ?? null }, pubsub);
      if (!row) return apiError(c, 404, "not_found", "No agent with this id in this workspace");
      return c.json({ held: row.heldAt !== null, heldAt: iso(row.heldAt), reason: row.reason }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/deletion-hold",
      tags,
      summary: "Hold a workspace's deletion (a legal hold), or let it go",
      description:
        "While held, a workspace whose deletion was asked for (by an owner, or with its only member's account) waits past its date instead of being deleted: it stays closed, with everything in it. Nothing is refused and the workspace is told nothing: no audit row, no notice. Restoring the workspace never lifts it. Let go, a deletion past its date goes ahead within an hour.",
      request: { params: OrgParams, body: body(z.object({ held: z.boolean(), reason: Reason })) },
      responses: { 200: json(DeletionHold), ...errors },
    }),
    async (c) => {
      const { held, reason } = c.req.valid("json");
      const row = await setDeletionHold(db, c.req.valid("param").orgId, { held, reason: reason ?? null });
      if (!row) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json({ held: row.heldAt !== null, heldAt: iso(row.heldAt), reason: row.reason }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/users/{userId}/block",
      tags,
      summary: "Block an account, or let it back",
      description:
        "Blocked: its sessions and phones are signed out now, it can't sign in again, every workspace refuses it on its next request (no waiting for a session cookie to expire) and its open connections close. Unblocking lets it sign in again; it keeps its workspaces. On agentes.chat Cloud the refused sign-in reads the block's kind, never its reason: `abuse` for `abuse.resignup`, `legal` for `legal_hold`, else `other`.",
      request: { params: UserParams, body: body(z.object({ blocked: z.boolean(), reason: Reason })) },
      responses: { 200: json(UserBlock), ...errors },
    }),
    async (c) => {
      const { blocked, reason } = c.req.valid("json");
      const state = await setUserBlocked({ db, pubsub }, c.req.valid("param").userId, {
        blocked,
        reason: reason ?? null,
      });
      if (!state) return apiError(c, 404, "not_found", "No account with this id");
      return c.json(
        {
          blocked: state.blockedAt !== null,
          blockedAt: iso(state.blockedAt),
          reason: state.reason,
          sessionsRevoked: state.sessionsRevoked,
        },
        200,
      );
    },
  );
}
