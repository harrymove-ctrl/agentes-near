import {
  attachmentDisposition,
  getPersonLimits,
  type PersonLimits,
  peopleUsage,
  peopleUsageCsv,
  personUsageDetail,
  raisePersonLimit,
  refuseMoreUsage,
  requestMoreUsage,
  setPersonLimits,
} from "@agenteschat/engine";
import { nanoUsdToUsd, usdToNanoUsd } from "@agenteschat/providers";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";

const tags = ["Usage"];

const Period = z.object({
  since: z.iso.datetime().optional().openapi({ description: "Default: the start of this month (UTC)." }),
  until: z.iso.datetime().optional().openapi({ description: "Default: now." }),
});
const periodOf = (q: z.infer<typeof Period>) => ({
  ...(q.since ? { since: new Date(q.since) } : {}),
  ...(q.until ? { until: new Date(q.until) } : {}),
});

const Place = z
  .object({
    kind: z.enum(["channel", "private", "hidden", "routine"]).openapi({
      description:
        "`private`: a DM with the agent, never its content; `hidden`: a private channel the viewer isn't in.",
    }),
    channelId: z.uuid().optional(),
    channelName: z.string().optional(),
    routineName: z.string().optional(),
  })
  .openapi("UsagePlace");

const LimitState = z.object({
  percent: z.number().nullable(),
  state: z.enum(["none", "ok", "near", "at"]),
  requested: z.boolean().openapi({ description: "The person asked for more this month and nobody answered yet." }),
  reachedAt: z.string().nullable(),
});
const LimitMoney = LimitState.extend({
  monthUsd: z.number(),
  limitUsd: z.number().nullable(),
  limitFrom: z.enum(["raised", "person", "role", "default", "owner", "none"]),
  limitRoleId: z.string().nullable(),
  raiseToUsd: z.number().nullable().openapi({ description: "What “Aumentar para US$ X este mês” offers." }),
});

const LiveWork = z
  .object({
    personId: z.string().nullable(),
    agentId: z.uuid(),
    routine: z.boolean(),
    place: Place,
    title: z.string().nullable(),
    startedAt: z.string(),
  })
  .openapi("LiveWork");

const PeopleUsage = z
  .object({
    month: z.string(),
    since: z.string(),
    until: z.string(),
    totalUsd: z.number(),
    plansOnly: z.boolean().openapi({ description: "Only plans were used: amounts are API equivalents." }),
    limitsOn: z.boolean(),
    people: z.array(
      LimitMoney.extend({
        userId: z.string(),
        name: z.string(),
        image: z.string().nullable(),
        owner: z.boolean(),
        roleIds: z.array(z.string()),
        runs: z.number(),
        costUsd: z.number(),
        estimated: z.boolean(),
        agents: z.array(z.object({ agentId: z.uuid(), share: z.number() })),
        caresFor: z.array(z.uuid()),
        created: z.number(),
        lastActiveAt: z.string().nullable(),
        now: z
          .object({ agentId: z.uuid(), place: Place, title: z.string().nullable(), startedAt: z.string() })
          .nullable(),
      }),
    ),
    live: z.array(LiveWork),
  })
  .openapi("PeopleUsage");

const Recent = z
  .object({
    kind: z.enum(["work", "private", "hidden"]),
    agentId: z.uuid(),
    place: Place.optional(),
    title: z.string().nullable().optional(),
    startedAt: z.string().optional(),
    minutes: z.number().optional(),
    runs: z.number().optional(),
    lastAt: z.string().optional(),
    amount: z.number(),
  })
  .openapi("PersonUsageRecent");

const PersonUsage = z
  .object({
    userId: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    roleIds: z.array(z.string()),
    owner: z.boolean(),
    money: z.boolean().openapi({ description: "Amounts are US$; false: percentages of the person's limit." }),
    estimated: z.boolean().openapi({
      description:
        "Some of the period's use was on a plan: that part is priced at the API's list price, which nobody pays.",
    }),
    renewsAt: z.string(),
    since: z.string(),
    until: z.string(),
    limit: z.union([LimitMoney, LimitState]),
    total: z.number(),
    days: z.array(z.object({ date: z.string(), agents: z.record(z.string(), z.number()) })),
    agents: z.array(z.object({ agentId: z.uuid(), runs: z.number(), amount: z.number() })),
    recent: z.array(Recent),
    created: z.array(z.object({ agentId: z.uuid(), createdAt: z.string() })),
  })
  .openapi("PersonUsage");

const Limits = z
  .object({
    defaultUsd: z.number().positive().nullable(),
    roles: z
      .record(z.string(), z.number().positive().nullable())
      .openapi({ description: "A role not here: the default." }),
    people: z.record(z.string(), z.number().positive().nullable()),
    onLimit: z.enum(["block", "notify"]),
    warn: z.boolean(),
  })
  .openapi("PersonLimits");

const toUsd = (v: number | null) => (v === null ? null : nanoUsdToUsd(v));
const toNano = (v: number | null) => (v === null ? null : usdToNanoUsd(v));
const mapValues = <A, B>(o: Record<string, A>, f: (v: A) => B) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
const limitsView = (l: PersonLimits): z.infer<typeof Limits> => ({
  defaultUsd: toUsd(l.default),
  roles: mapValues(l.roles, toUsd),
  people: mapValues(l.people, toUsd),
  onLimit: l.onLimit,
  warn: l.warn,
});

/**
 * Usage per person (ADR 0141): Uso › Pessoas and its CSV, a person's month, "Seu uso", the monthly limits, and
 * "Pedir mais" with its answers. Money only with `view_usage`; a member reads their own month in percentages.
 */
export function personUsageRoutes(deps: AppDeps) {
  const { db } = deps;
  const notices = { db, pubsub: deps.adapters.pubsub };
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage/people",
      tags,
      security,
      summary: "Each person's AI use in the period, their limit this month and what they do now (view_usage)",
      request: { params: OrgParams, query: Period },
      responses: { 200: json(PeopleUsage), ...errors },
    }),
    async (c) =>
      c.json(await peopleUsage(db, c.get("user").id, c.req.valid("param").orgId, periodOf(c.req.valid("query"))), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage/people.csv",
      tags,
      security,
      summary: "One row per person per day: requests, tokens, cost, a plan's API estimate, agents (view_usage)",
      request: { params: OrgParams, query: Period },
      responses: { 200: { description: "CSV", content: { "text/csv": { schema: z.string() } } }, ...errors },
    }),
    async (c) => {
      const csv = await peopleUsageCsv(
        db,
        c.get("user").id,
        c.req.valid("param").orgId,
        periodOf(c.req.valid("query")),
      );
      const day = new Date().toISOString().slice(0, 10);
      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": attachmentDisposition(`usage-per-person-${day}.csv`),
      });
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage/people/{userId}",
      tags,
      security,
      summary: "A person's month: limit, use per day by agent, agents, recent work, agents they created",
      description:
        "Anyone's with `view_usage`, in US$; one's own, in percentages. A DM's work is a count, never a title.",
      request: { params: OrgParams.extend({ userId: z.string().min(1) }), query: Period },
      responses: { 200: json(PersonUsage), ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      return c.json(await personUsageDetail(db, c.get("user").id, orgId, userId, periodOf(c.req.valid("query"))), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage/limits",
      tags,
      security,
      summary: "The monthly AI limits per person: the default, per role and per person (view_usage)",
      request: { params: OrgParams },
      responses: { 200: json(Limits), ...errors },
    }),
    async (c) => c.json(limitsView(await getPersonLimits(db, c.get("user").id, c.req.valid("param").orgId)), 200),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/usage/limits",
      tags,
      security,
      summary: "Saves the monthly AI limits per person (configure and view_usage); audited",
      request: { params: OrgParams, body: body(Limits) },
      responses: { 200: json(Limits), ...errors },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const saved = await setPersonLimits(db, c.get("user").id, c.req.valid("param").orgId, {
        default: toNano(input.defaultUsd),
        roles: mapValues(input.roles, toNano),
        people: mapValues(input.people, toNano),
        onLimit: input.onLimit,
        warn: input.warn,
      });
      return c.json(limitsView(saved), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/usage/limits/request",
      tags,
      security,
      summary: "“Pedir mais”: the caller, at their limit, asks who decides for more this month",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ requestedAt: z.string() })), ...errors },
    }),
    async (c) => c.json(await requestMoreUsage(notices, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/usage/people/{userId}/raise",
      tags,
      security,
      summary: "Raises a person's limit for this month only (configure and view_usage)",
      request: {
        params: OrgParams.extend({ userId: z.string().min(1) }),
        body: body(z.object({ limitUsd: z.number().positive().max(1_000_000) })),
      },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      await raisePersonLimit(notices, c.get("user").id, orgId, userId, usdToNanoUsd(c.req.valid("json").limitUsd));
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/usage/people/{userId}/refuse",
      tags,
      security,
      summary: "Refuses a person's request for more this month (configure and view_usage)",
      request: { params: OrgParams.extend({ userId: z.string().min(1) }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      await refuseMoreUsage(notices, c.get("user").id, orgId, userId);
      return c.body(null, 204);
    },
  );

  return app;
}
