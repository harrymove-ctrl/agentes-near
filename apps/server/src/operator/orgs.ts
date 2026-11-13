import { isWorkAreaAnswer, WORK_AREA_ANSWERS } from "@agenteschat/client/lib/work-area";
import { operatorListOrgs, operatorOrg, operatorUser } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { iso, json, OrgParams } from "../routes/app/context";
import type { OperatorDeps } from "./app";
import { LimitsState, limitsJson, Meters } from "./limits";
import { Standing, StandingState, standingJson, UserParams } from "./standing";

/**
 * A person's place in a workspace, as the operator API has always named it: an owner, someone holding
 * `administrator` (ADR 0085), or a member.
 */
const Role = z.enum(["owner", "admin", "member"]).openapi("Role");

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const BotCheck = z
  .object({
    state: z.enum(["off", "ok", "unreachable", "secret_refused"]).openapi({
      description:
        "`off` without both Turnstile keys. While `unreachable` (this server can't reach Cloudflare) or `secret_refused` (Cloudflare refuses `TURNSTILE_SECRET_KEY`), every request goes through unchecked.",
    }),
    since: z.iso.datetime({ offset: true }).openapi({ description: "When it took this state." }),
    blocked: z.number().int().min(0).openapi({
      description:
        "Networks refused in the last 10 minutes because their page couldn't load the check (`human_check_blocked`), each counted once: an IPv4 address, or an IPv6 /64. Any client can claim its page couldn't load it, so read it beside `passed`.",
    }),
    passed: z.number().int().min(0).openapi({
      description:
        "Tokens Cloudflare passed in the last 10 minutes. When the widget is down for everyone, `blocked` rises while this falls. Clients claiming it is down don't move it.",
    }),
    testing: z.boolean().openapi({
      description:
        "`TURNSTILE_SECRET_KEY` is one of Cloudflare's test secrets. They refuse real tokens, and the one that passes takes a public dummy token from anyone. Right only on a test server.",
    }),
  })
  .openapi("OperatorBotCheck");

const Health = z
  .object({
    ok: z.literal(true),
    version: z.string(),
    botCheck: BotCheck.openapi({ description: "The bot check before public forms (ADR 0075)." }),
  })
  .openapi("OperatorHealth");

const OrgSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.string(),
    standing: StandingState,
    members: z.number().int(),
    agents: z.number().int().openapi({ description: "Not archived." }),
  })
  .openapi("OperatorOrgSummary");

const OrgPage = z
  .object({
    orgs: z.array(OrgSummary),
    next: z.string().nullable().openapi({ description: "`cursor` for the next page; null on the last one." }),
  })
  .openapi("OperatorOrgPage");

const OrgQuery = z.object({
  q: z
    .string()
    .max(320)
    .optional()
    .openapi({ description: "An org id, part of its name, or part of a member's email; any case." }),
  createdAfter: z.iso.datetime({ offset: true }).optional(),
  standing: StandingState.optional().openapi({ description: "Only the workspaces in this standing." }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

const Org = z
  .object({
    id: z.uuid(),
    name: z.string(),
    createdAt: z.string(),
    standing: Standing,
    admins: z
      .array(
        z.object({
          userId: z.string(),
          email: z.string(),
          name: z.string(),
          role: Role,
          createdAt: z.string().openapi({ description: "When the account was created." }),
          lastSeenAt: z.string().nullable().openapi({ description: "Last time they had this workspace open." }),
        }),
      )
      .openapi({ description: "Owners and admins, owners first." }),
    counts: z.object({
      members: z.number().int(),
      agents: z.number().int().openapi({ description: "Not archived." }),
      channels: z.number().int().openapi({ description: "Channels, not archived; no direct messages." }),
      machines: z.number().int().openapi({ description: "Connected computers." }),
      invitations: z.number().int().openapi({ description: "Pending: neither accepted nor expired." }),
    }),
    limits: LimitsState,
    meters: Meters,
    deletion: z
      .object({
        dueAt: z.string().openapi({ description: "When it is deleted for good, unless a hold keeps it longer." }),
        requestedAt: z.string().nullable(),
        requestedBy: z.string().nullable().openapi({ description: "Who asked; null once their account is gone." }),
      })
      .nullable()
      .openapi({
        description:
          "Its deletion, asked by an owner or with its only member's account: closed until `dueAt`. Null when it isn't being deleted.",
      }),
    deletionHold: z
      .object({
        heldAt: z.string(),
        reason: z.string().nullable(),
      })
      .nullable()
      .openapi({ description: "The operator's deletion hold (`PUT /orgs/{orgId}/deletion-hold`); null when none." }),
  })
  .openapi("OperatorOrg");

const User = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
    createdAt: z.string(),
    blockedAt: z
      .string()
      .nullable()
      .openapi({ description: "Since when it is blocked (`PUT /users/{userId}/block`)." }),
    blockedReason: z.string().nullable(),
    workArea: z.enum(WORK_AREA_ANSWERS).nullable().openapi({
      description:
        "The person's own area, asked once during the onboarding: `dev`, `marketing`, `sales`, `finance`, `ops`, `support`, `other`, or `skipped`; null until asked (or for an account from before the question).",
    }),
    orgs: z.array(
      z.object({
        orgId: z.uuid(),
        name: z.string(),
        role: Role,
        joinedAt: z.string(),
        lastSeenAt: z.string().nullable(),
      }),
    ),
    sessions: z
      .array(z.object({ ip: z.string().nullable(), userAgent: z.string().nullable(), createdAt: z.string() }))
      .openapi({ description: "Its 10 newest sessions on record, newest first. Signing out deletes a session." }),
  })
  .openapi("OperatorUser");

export function registerOperatorOrgs(api: OpenAPIHono, { db, version, humanCheck }: OperatorDeps) {
  const started = new Date();
  api.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags,
      summary: "The token works and this server answers, with its bot check's state",
      responses: { 200: json(Health), 401: errors[401] },
    }),
    (c) => {
      const check = humanCheck?.status() ?? {
        state: "off" as const,
        since: started,
        blocked: 0,
        passed: 0,
        testing: false,
      };
      return c.json({ ok: true as const, version, botCheck: { ...check, since: check.since.toISOString() } }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs",
      tags,
      summary: "Find workspaces, newest first",
      request: { query: OrgQuery },
      responses: { 200: json(OrgPage), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const { createdAfter, ...query } = c.req.valid("query");
      const page = await operatorListOrgs(db, {
        ...query,
        createdAfter: createdAfter ? new Date(createdAfter) : undefined,
      });
      return c.json({ ...page, orgs: page.orgs.map((o) => ({ ...o, createdAt: o.createdAt.toISOString() })) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}",
      tags,
      summary: "One workspace: its owners and admins, how much is in it, and its limits with what it uses",
      request: { params: OrgParams },
      responses: { 200: json(Org), ...errors },
    }),
    async (c) => {
      const org = await operatorOrg(db, c.req.valid("param").orgId);
      if (!org) return apiError(c, 404, "not_found", "No workspace with this id");
      return c.json(
        {
          ...org,
          createdAt: org.createdAt.toISOString(),
          standing: standingJson(org.standing),
          limits: limitsJson(org.limits),
          deletion: org.deletion && {
            dueAt: org.deletion.dueAt.toISOString(),
            requestedAt: iso(org.deletion.requestedAt),
            requestedBy: org.deletion.requestedBy,
          },
          deletionHold: org.deletionHold && {
            heldAt: org.deletionHold.heldAt.toISOString(),
            reason: org.deletionHold.reason,
          },
          admins: org.admins.map((a) => ({
            ...a,
            createdAt: a.createdAt.toISOString(),
            lastSeenAt: iso(a.lastSeenAt),
          })),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/users/{userId}",
      tags,
      summary: "One account: its workspaces and newest sessions",
      request: { params: UserParams },
      responses: { 200: json(User), ...errors },
    }),
    async (c) => {
      const user = await operatorUser(db, c.req.valid("param").userId);
      if (!user) return apiError(c, 404, "not_found", "No account with this id");
      return c.json(
        {
          ...user,
          createdAt: user.createdAt.toISOString(),
          blockedAt: iso(user.blockedAt),
          workArea: isWorkAreaAnswer(user.workArea) ? user.workArea : null,
          orgs: user.orgs.map((o) => ({ ...o, joinedAt: o.joinedAt.toISOString(), lastSeenAt: iso(o.lastSeenAt) })),
          sessions: user.sessions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
        },
        200,
      );
    },
  );
}
