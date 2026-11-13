import {
  type AgentBrainSummary,
  type Agent as AgentRow,
  adjustTeamAgent,
  agentBrainLines,
  agentBudgetsThisMonth,
  agentStatuses,
  agentView,
  allowsPrivateEndpoints,
  applyAgentSetup,
  archiveAgent,
  askAgentProposal,
  audienceMailLoss,
  audienceOf,
  budgetPercent,
  cancelUsageQueue,
  canTalkTo,
  canViewCost,
  checkCredential,
  checkEndpoint,
  confirmSetupStep,
  createAgent,
  createAgentFromProposal,
  createAgentGroup,
  createCredential,
  createProposedAgent,
  createProposedRoutine,
  createTeam,
  decideCostlyProposal,
  deleteAgent,
  deleteAgentGroup,
  deleteCredential,
  denyAgentProposal,
  denyTeam,
  type EndpointNet,
  endpointOrgsOf,
  getAgent,
  getAgentBrain,
  getAgentProposal,
  getMembership,
  getNewAgentSetup,
  getTeam,
  listAgentGroups,
  listAgents,
  listCredentials,
  listEndpoint,
  listFormerAgents,
  listTeamTemplates,
  type Membership,
  moveAgentToGroup,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  newAgentBrainMachines,
  oldHandlesByAgent,
  orgAiStatus,
  orgRouting,
  pickerEndpoint,
  pickerModels,
  proposeChannelMove,
  publishAgentsChanged,
  publishMachineAgentsChanged,
  requirePermission,
  revokeCredential,
  SETUP_AGENTS_MAX,
  seesAgentDetails,
  setAgentAppearance,
  setAgentAudience,
  setAgentBrain,
  setReportsTo,
  speakerOf,
  summaryModelReady,
  TEAM_TEMPLATES,
  unarchiveAgent,
  undoTeam,
  updateAgent,
  updateAgentGroup,
  updateEndpointModels,
  usageQueue,
  usageSummary,
  useTeamTemplate,
} from "@agenteschat/engine";
import { contextWindowOf, nanoUsdToUsd, pricesAt, usdToNanoUsd } from "@agenteschat/providers";
import { learnedPlanModels } from "@agenteschat/providers/plans";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  aiStatusDeps,
  body,
  createAppRouter,
  errors,
  json,
  keyTester,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import { credentialOut, modelIn, modelOut } from "./credential-view";
import {
  Agent,
  AgentAppearance,
  AgentAudience,
  AgentBrain,
  AgentBrakes,
  AgentSetup,
  AgentSetupResult,
  BrainEffortSetting,
  BrainKind,
  BrainMachine,
  BrainSpeed,
  CommandApproval,
  ContextLimit,
  Credential,
  EndpointCheck,
  EndpointModel,
  EndpointStyle,
  FormerAgent,
  Model,
  NewAgentSetup,
  PlanModelOut,
  ProviderId,
  SetupStep,
  Usage,
} from "./schemas";

const tags = ["Agents"];

/** How this server reaches endpoints people type (ADR 0146). */
const endpointNet = (deps: AppDeps): EndpointNet => ({
  allowPrivate: allowsPrivateEndpoints(deps.config),
  fetch: deps.extras?.http,
  resolveHost: deps.extras?.resolveHost,
});

/** One test call per model of an endpoint, when this server has a model gateway. */
const endpointChecks = (deps: AppDeps, userId: string, orgId: string, credentialId: string) => {
  const gateway = deps.extras?.context?.gateway;
  return gateway ? checkEndpoint(deps.db, gateway, userId, orgId, credentialId) : Promise.resolve([]);
};

/** An agent as this person may see it: its budget is money, so admins only (`seesCost`). */
const toAgent = (
  a: AgentRow,
  viewerId: string,
  seesCost: boolean,
  budgetUsedPercent: number | undefined,
  brain: AgentBrainSummary | undefined,
  /** The viewer's membership: the audience rule (ADR 0085) and whether they see how it works. */
  viewer: Membership | null,
) => {
  const v = agentView(a);
  const { monthlyBudgetNanoUsd, ...rest } = v;
  const seesDetails = seesAgentDetails(a, viewerId, viewer);
  return {
    ...rest,
    instructions: seesDetails ? rest.instructions : "",
    seesDetails,
    ...(brain ? { brain } : {}),
    ...(budgetUsedPercent !== undefined && seesDetails ? { budgetUsedPercent } : {}),
    ...(seesCost
      ? { monthlyBudgetUsd: monthlyBudgetNanoUsd === null ? null : nanoUsdToUsd(monthlyBudgetNanoUsd) }
      : {}),
    createdAt: v.createdAt.toISOString(),
    audience: audienceOf(a),
    audienceMode: a.audienceMode,
    canTalk: canTalkTo(a, viewerId, speakerOf(viewer)),
  };
};

const AgentFields = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().max(200).optional(),
  instructions: z.string().max(50_000).optional(),
  model: z.string().optional().openapi({
    description:
      "A catalog model id, an OpenRouter model id (`maker/model`, ADR 0087), or `auto` (each run picks the model tier and effort). Defaults to `auto`.",
  }),
  credentialId: z
    .uuid()
    .nullable()
    .optional()
    .openapi({ description: "Provider credential of this organization. Null = platform key (Cloud only)." }),
  ownerUserId: z.string().nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional().openapi({
    description:
      "Spend cap per calendar month (UTC), admins only. Null = the workspace default (every agent has a budget).",
  }),
  audience: AgentAudience.optional().openapi({
    description: "Who can talk to it. The agent's owner or admins can change it.",
  }),
  appearance: AgentAppearance.nullable().optional().openapi({
    description: "Its look (fixed allow-list). The agent's owner or admins can change it; null = the default.",
  }),
  mediaReplies: z.boolean().optional().openapi({
    description:
      "It may send a sticker or a GIF (ADR 0091): when someone asks for one, and after a light reply as often as the workspace's `agentMedia` allows; off: never. Like the other fields, editing it needs `manage_agents`. Default on.",
  }),
  brakes: AgentBrakes.partial().optional().openapi({
    description: "Its autonomy brakes (ADR 0131); the fields given change, the rest stay. Needs `manage_agents`.",
  }),
});

const budget = (usd: number | null | undefined) =>
  usd === undefined ? undefined : usd === null ? null : usdToNanoUsd(usd);

const ProposalParams = OrgParams.extend({ messageId: z.uuid() });
const AgentProposal = z
  .object({
    kind: z.literal("agent_proposal"),
    messageId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    proposedByAgentId: z.uuid(),
    forUserId: z.string().nullable(),
    params: z.object({
      draft: z.object({
        name: z.string(),
        handle: z.string(),
        role: z.string(),
        instructions: z.string(),
        appearance: AgentAppearance.nullable(),
        channelIds: z.array(z.uuid()),
        access: z.array(z.object({ connectionId: z.uuid(), level: z.enum(["read", "write"]) })),
        mail: z
          .array(
            z.object({
              accountId: z.uuid(),
              address: z.string(),
              level: z.enum(["read", "write"]),
              ownerUserId: z.string(),
            }),
          )
          .optional()
          .openapi({ description: "Mailboxes of the person who asked: only a mailbox's owner gives an agent access." }),
        routine: z
          .object({
            name: z.string(),
            prompt: z.string(),
            schedule: z.string(),
            rule: z.record(z.string(), z.unknown()).nullable(),
            cron: z.string(),
            timezone: z.string(),
            description: z.string(),
            report: z.enum(["always", "when_new"]),
            access: z.enum(["read", "act"]),
            reportsIn: z.uuid().nullable().optional().openapi({
              description: "The channel it reports in, which the agent must be in first (null: the creator's DM).",
            }),
          })
          .nullable()
          .optional()
          .openapi({
            description:
              "A routine of its own, created with it (its schedule read when proposed: `rule`, else `cron`). It reports where the card is (a DM: the creator's DM with it).",
          }),
        ai: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("account"),
            brain: z.enum(["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"]),
            machineId: z.uuid(),
            accountId: z.uuid(),
            label: z.string(),
          }),
          z.object({ kind: z.literal("model") }),
          z.object({ kind: z.literal("none") }),
        ]),
      }),
      why: z.string(),
      firstTask: z.string().optional().openapi({
        description: 'What "Criar e testar" sends the new agent, from the clicker, in their DM with it.',
      }),
    }),
    state: z.enum(["pending", "creating", "created", "denied", "superseded"]).openapi({
      description: "`superseded`: a newer card of the same agent for the same handle, here, took its place.",
    }),
    askedAt: z.string().optional().openapi({
      description:
        'When the person it is for, who can\'t create agents, sent it to whoever may ("Pedir a um admin"): they may open it from their inbox.',
    }),
    agentId: z.uuid().nullable(),
    decidedByUserId: z.string().nullable(),
    decidedAt: z.string().nullable(),
    expiresAt: z.string(),
    applied: z
      .object({ channelIds: z.array(z.uuid()), connectionIds: z.array(z.uuid()), mailAccountIds: z.array(z.uuid()) })
      .optional()
      .openapi({
        description: "Created in one click: the lines of its draft it got (the rest waits for who may give it).",
      }),
    routineId: z.string().nullable().optional().openapi({ description: "The routine made with it." }),
    expired: z.boolean(),
    canDecide: z.boolean(),
  })
  .openapi("AgentProposal", {
    description:
      "An agent's proposal of a new agent (`meta.actionCard` of its card, ADR 0081): the draft, the AI it suggests and what was decided.",
  });

const TeamRoutine = z.object({
  name: z.string(),
  prompt: z.string(),
  schedule: z.string(),
  rule: z.record(z.string(), z.unknown()).nullable(),
  cron: z.string(),
  timezone: z.string(),
  description: z.string(),
  report: z.enum(["always", "when_new"]),
  access: z.enum(["read", "act"]),
});
const TeamProposalCard = z
  .object({
    kind: z.literal("team_proposal"),
    forUserId: z.string().nullable(),
    params: z.object({
      lead: z.string(),
      agents: z.array(
        z.object({
          name: z.string(),
          handle: z.string(),
          role: z.string(),
          line: z.string(),
          instructions: z.string(),
          appearance: AgentAppearance.nullable(),
          channel: z.string().openapi({
            description:
              "The channel it lives in, by name; empty when it lives in its DM with the person instead (a personal workspace's template, ADR 0159).",
          }),
          routines: z.array(TeamRoutine),
          firstTask: z.string().nullable(),
        }),
      ),
      newChannels: z.array(z.string()),
      skills: z.array(
        z.object({
          name: z.string(),
          title: z.string(),
          description: z.string(),
          body: z.string(),
          agents: z.array(z.string()),
        }),
      ),
      weekly: TeamRoutine.nullable(),
      approvals: z.string(),
      invite: z.array(z.string()),
      template: z.string().optional(),
      example: z.string().optional(),
    }),
    state: z.enum(["pending", "creating", "created", "denied", "superseded", "undone"]),
    decidedByUserId: z.string().nullable(),
    decidedAt: z.string().nullable(),
    expiresAt: z.string(),
    created: z
      .object({
        agentIds: z.array(z.uuid()),
        channelIds: z.array(z.uuid()),
        routineIds: z.array(z.uuid()),
        skillIds: z.array(z.uuid()),
        skipped: z.array(z.enum(["skills", "weekly"])),
        noAi: z.array(z.uuid()),
      })
      .optional(),
    error: z
      .object({
        step: z.string(),
        reason: z.string(),
        status: z.number().int().optional(),
        code: z.string().optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .nullable()
      .optional(),
    undoneAt: z.string().optional(),
  })
  .openapi("TeamProposalCard", {
    description:
      "The right hand's team card (`meta.actionCard`, ADR 0137 §10): several agents with their channels, routines and skills, created in one click.",
  });

/** Provider credentials, agents, usage and the model catalog. */
export function agentRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  app.use("/models", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/models",
      tags,
      security,
      summary: "Models agents can use, with prices",
      description:
        "The catalog's models, then OpenRouter's (ADR 0087) while a workspace on this server has an OpenRouter key: its good picks first (`pick: true`), then the rest of its list (`pick: false`). Then the models of the signed-in person's workspaces' own endpoints (ADR 0146, `endpoint`).",
      responses: {
        200: json(
          z.object({
            models: z.array(Model),
            defaultModel: z.string().openapi({ description: "What a new agent gets when no model is chosen: `auto`." }),
            planModels: z.record(z.string(), z.array(PlanModelOut)).openapi({
              description:
                "The coding plans whose makers' public lists this server has read, by plan id: their models now. A plan not here goes by the table in `@agenteschat/providers/plans`.",
            }),
          }),
        ),
        401: errors[401],
      },
    }),
    async (c) =>
      c.json(
        {
          defaultModel: NEW_AGENT_DEFAULTS.model,
          planModels: learnedPlanModels(),
          models: (await pickerModels(db, await endpointOrgsOf(db, c.get("user").id))).map(([id, m]) => ({
            id,
            label: m.label,
            provider: m.provider,
            contextWindow: contextWindowOf(id),
            inputUsdPerMTok: pricesAt(m).input / 1000,
            outputUsdPerMTok: pricesAt(m).output / 1000,
            ...(m.pick !== undefined ? { pick: m.pick } : {}),
            ...(m.tier ? { tier: m.tier } : {}),
            ...pickerEndpoint(id, m),
          })),
        },
        200,
      ),
  );

  // ── Credentials ───────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/credentials",
      tags,
      security,
      summary: "Provider credentials (metadata only)",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ credentials: z.array(Credential) })), ...errors },
    }),
    async (c) => {
      const rows = await listCredentials(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ credentials: rows.map(credentialOut) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/credentials",
      tags,
      security,
      summary: "Add a provider API key",
      description:
        "The key is encrypted at rest and never returned by any endpoint. It makes one cheap real call first: a key the provider refuses (`provider_key_invalid`), with no credit (`provider_key_no_credit`) or with no permission to call (`provider_key_denied`) is never stored, and `params` carry the provider's name and words (`said`). A provider that gives no answer about the key doesn't stop the save: `check` is `unchecked`. An OpenRouter key is checked with OpenRouter too (ADR 0087): a management key (`provider_key_management`) is never stored. `custom` (ADR 0146) takes `endpoint`, may have no key, and answers with one test call per model (`checks`).",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            provider: ProviderId,
            label: z.string().trim().min(1).max(80),
            apiKey: z.string().max(500),
            workspaceId: z.string().max(128).nullable().optional().openapi({
              description:
                "Claude Console workspace ID, for a key that works in more than one workspace (sent as `anthropic-workspace-id`).",
            }),
            organization: z.string().max(128).nullable().optional().openapi({ description: "OpenAI organization id." }),
            project: z.string().max(128).nullable().optional().openapi({ description: "OpenAI project id." }),
            makeDefault: z
              .boolean()
              .optional()
              .openapi({ description: "Make it the workspace's default key in the same call (onboarding)." }),
            endpoint: z
              .object({ style: EndpointStyle, baseURL: z.string().min(1).max(500), models: z.array(EndpointModel) })
              .optional()
              .openapi({ description: "`custom` only: the endpoint's address, API and the models it offers." }),
          }),
        ),
      },
      responses: {
        201: json(Credential.extend({ checks: z.array(EndpointCheck).optional() }), "Created"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { endpoint, ...input } = c.req.valid("json");
      const userId = c.get("user").id;
      const row = await createCredential(
        db,
        adapters.keyWrapper,
        userId,
        orgId,
        { ...input, ...(endpoint ? { endpoint: { ...endpoint, models: endpoint.models.map(modelIn) } } : {}) },
        { fetch: deps.extras?.http, net: endpointNet(deps), verify: (await keyTester(deps, userId))?.verifyKey },
      );
      const checks = row.endpoint ? await endpointChecks(deps, userId, orgId, row.id) : undefined;
      return c.json({ ...credentialOut(row), ...(checks ? { checks } : {}) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/credentials/endpoint-models",
      tags,
      security,
      summary: "What a workspace's own endpoint lists (ADR 0146), before it is saved (admins)",
      description:
        "Reads `GET {baseURL}/models` (Chat Completions) or `GET {baseURL}/v1/models` (Anthropic) with the key, which is not stored. On agentes.chat Cloud only public https addresses are reached (`url.https_required`, `url.internal`). A list the endpoint doesn't give comes back empty with `error`: the admin types ids instead.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            style: EndpointStyle,
            baseURL: z.string().min(1).max(500),
            apiKey: z.string().max(500).optional(),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            baseURL: z.string().openapi({ description: "The address as it will be stored." }),
            models: z.array(z.object({ id: z.string(), label: z.string().optional() })),
            error: z.string().optional(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await listEndpoint(db, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json"), endpointNet(deps)),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/credentials/{credentialId}/models",
      tags,
      security,
      summary: "Change an endpoint's models and prices, then test each again (admins, ADR 0146)",
      request: {
        params: OrgParams.extend({ credentialId: z.uuid() }),
        body: body(z.object({ models: z.array(EndpointModel) })),
      },
      responses: { 200: json(z.object({ models: z.array(EndpointModel), checks: z.array(EndpointCheck) })), ...errors },
    }),
    async (c) => {
      const { orgId, credentialId } = c.req.valid("param");
      const userId = c.get("user").id;
      await updateEndpointModels(db, userId, orgId, credentialId, c.req.valid("json").models.map(modelIn));
      const checks = await endpointChecks(deps, userId, orgId, credentialId);
      const saved = (await listCredentials(db, userId, orgId)).find((r) => r.id === credentialId);
      return c.json({ models: (saved?.endpoint?.models ?? []).map(modelOut), checks }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/credentials/{credentialId}",
      tags,
      security,
      summary: "Revoke a provider API key (or delete it for good with ?purge=true)",
      description:
        "Purging is refused while the key is a default (`credential.default`) or agents use it (`credential.in_use`), so they never move to another key silently. `release=true`, sent once the person read what happens: the agents using it lose it and it stops being a default.",
      request: {
        params: OrgParams.extend({ credentialId: z.uuid() }),
        query: z.object({ purge: z.stringbool().optional(), release: z.stringbool().optional() }),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, credentialId } = c.req.valid("param");
      const { purge, release } = c.req.valid("query");
      if (purge) await deleteCredential(db, c.get("user").id, orgId, credentialId, { release });
      else await revokeCredential(db, c.get("user").id, orgId, credentialId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/credentials/{credentialId}/check",
      tags,
      security,
      summary: "Try a stored key with one cheap real call (admins)",
      description:
        "Answers as saving a key does: `check` is `ok` or `unchecked`, and a refusal comes as `provider_key_invalid`, `provider_key_no_credit` or `provider_key_denied`.",
      request: { params: OrgParams.extend({ credentialId: z.uuid() }) },
      responses: { 200: json(z.object({ check: z.enum(["ok", "unchecked"]) })), ...errors },
    }),
    async (c) => {
      const { orgId, credentialId } = c.req.valid("param");
      const userId = c.get("user").id;
      const gateway = await keyTester(deps, userId);
      if (!gateway) return c.json({ check: "unchecked" as const }, 200);
      return c.json({ check: await checkCredential(db, gateway, userId, orgId, credentialId) }, 200);
    },
  );

  // ── Agents ────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents",
      tags,
      security,
      summary: "Agents of the organization",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ agents: z.array(Agent) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const actor = c.get("user").id;
      const list = await listAgents(db, actor, orgId);
      const [seesCost, budgets, brains, viewer, old] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBudgetsThisMonth(db, orgId),
        agentBrainLines(db, actor, orgId, list),
        getMembership(db, actor, orgId),
        oldHandlesByAgent(db, orgId),
      ]);
      const percent = (id: string) => {
        const b = budgets.get(id);
        return b ? budgetPercent(b.spentNanoUsd, b.budgetNanoUsd) : 0;
      };
      return c.json(
        {
          agents: list.map((a) => ({
            ...toAgent(a, actor, seesCost, percent(a.id), brains.get(a.id), viewer),
            previousHandles: old.get(a.id) ?? [],
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/former-agents",
      tags,
      security,
      summary: "Agents no longer in the team (archived or deleted): the name, role and look their messages still show",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ agents: z.array(FormerAgent) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ agents: await listFormerAgents(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/ai-status",
      tags,
      security,
      summary: "Whether each agent has an AI to think with, whether the organization has any, and who picks the agents",
      description:
        "Per agent: `ready`; `no_ai` with why (`no_key`, `not_signed_in`, `no_computer`, `cli_missing`: nothing to think with, and no fallback; `own`: with `not_signed_in`, the CLI whose own sign-in isn't there on the computer, where the agent has no account); `waiting` (its computer is away for now). `any`: an agent that isn't archived is ready or waiting. `routing` (ADR 0074): who picks the agents for a message nobody mentioned, for the workspace (`by`) and for the caller's own messages (`mine`): Jev, the organization's small model (`model`), people's own plans (only for their own messages), rules, or `off` (only mentions). `noSmallModel`: with `rules`, the default key's provider, which has no small model. `apiKey`: a key of its own, or the server's own Claude key. Computed on each request; no key is read.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            any: z.boolean(),
            agents: z.array(
              z.object({
                agentId: z.uuid(),
                state: z.enum(["ready", "no_ai", "waiting"]),
                reason: z
                  .enum([
                    "no_key",
                    "not_signed_in",
                    "no_computer",
                    "cli_missing",
                    "computer_away",
                    "computer_failed",
                    "cli_failed",
                    "plan_limit",
                    "model_limit",
                    "model_region",
                    "model_off",
                    "plan_inactive",
                    "commands_off",
                    "plan_not_shared",
                    "runner_outdated",
                    "plan_tools",
                  ])
                  .optional(),
                own: z.enum(["claude_code", "codex", "cursor", "opencode", "grok", "antigravity"]).optional(),
                provider: z.string().optional().openapi({
                  description: "Ready on an API key with Automático: the maker of the key it thinks with.",
                }),
              }),
            ),
            routing: z.object({
              by: z.enum(["jev", "model", "plans", "rules", "off"]),
              mine: z.enum(["jev", "model", "plan", "rules", "off"]),
              model: z.string().nullable(),
              noSmallModel: z.string().nullable(),
            }),
            apiKey: z.boolean(),
            /** Memory reflects on finished conversations: a summary model it can call (ADR 0167). */
            reflection: z.boolean(),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const userId = c.get("user").id;
      await requirePermission(db, userId, orgId, "read");
      const status = aiStatusDeps(deps);
      const context = deps.extras?.context;
      const [ai, routing, reflection] = await Promise.all([
        orgAiStatus(status, orgId, userId),
        orgRouting(status, deps.extras?.router?.routing ?? null, orgId, userId),
        context ? summaryModelReady(context, orgId) : false,
      ]);
      return c.json({ ...ai, ...routing, reflection }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-status",
      tags,
      security,
      summary: "Each agent's presence (online, busy, away, out of office, offline) and what it says it is doing",
      description:
        "From its work (ADR 0084): `busy` on a routine, a task, a run going for over 2 minutes or one rated heavy, or when it said so; `online` while answering, waiting on an answer or active in the last 30 minutes (one never active, in the 30 minutes since it was made; the right hand always); `away` after that; `out` (out of office, §12) while its plan is at its limit with no model to fall back on or its monthly budget is spent, with an `out_of_plan`/`out_of_budget` line whose `until` says when it is back, and the router leaves it out of messages nobody mentioned it in; `offline` when held. An agent with no AI is drawn offline by the apps (`ai-status`). `status`: its own words (`set_status`), a line picked for its run (`kind` + `subject`), or what its run waits on; gone when the run ends unless it set `until`. Refreshed on `agent.status` events and every 30 seconds while open.",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            agents: z.array(
              z.object({
                agentId: z.uuid(),
                presence: z.enum(["online", "busy", "away", "out", "offline"]),
                status: z
                  .object({
                    by: z.enum(["self", "auto", "wait"]).openapi({
                      description: "Its own words (`text`), a line picked for its run, or what its run waits on.",
                    }),
                    text: z.string().nullable(),
                    kind: z
                      .enum([
                        "task",
                        "routine",
                        "mission",
                        "channel",
                        "browsing",
                        "coding",
                        "files",
                        "wiki",
                        "planning",
                        "data",
                        "mail",
                        "connector",
                        "computer",
                        "waiting_approval",
                        "waiting_answer",
                        "waiting_computer",
                        "queued_computer",
                        "waiting_plan",
                        "waiting_budget",
                        "out_of_plan",
                        "out_of_budget",
                        "provider_down",
                        "work",
                      ])
                      .nullable()
                      .openapi({ description: "With `auto`/`wait`: what it does, worded by the app." }),
                    subject: z.string().nullable(),
                    emoji: z.string().nullable(),
                    until: z.string().nullable(),
                    since: z.string().optional().openapi({ description: "Background work: since when." }),
                    count: z.number().optional().openapi({ description: "Background work: how many at once." }),
                    second: z.string().nullable().optional().openapi({ description: "A second work's title." }),
                    wait: z
                      .enum(["approval", "answer", "plan", "computer", "line"])
                      .optional()
                      .openapi({ description: "One background work that waits: on what." }),
                  })
                  .nullable(),
                activeAt: z.string().nullable(),
                working: z.boolean().openapi({
                  description:
                    "Something of its own thinks now (a run, or long work at work): drawn at work whatever its AI reads as for the viewer.",
                }),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const gateway = deps.extras?.context?.gateway;
      // A plan at its limit still answers through a model with a key (ADR 0032 §5): not out of office then.
      const hasModel = gateway
        ? (agent: Parameters<typeof gateway.hasModelCredential>[0]) => gateway.hasModelCredential(agent)
        : undefined;
      return c.json(
        { agents: await agentStatuses(db, c.get("user").id, orgId, new Date(), hasModel ? { hasModel } : {}) },
        200,
      );
    },
  );

  const TeamAgent = z.object({
    id: z.uuid(),
    name: z.string(),
    handle: z.string(),
    role: z.string(),
    appearance: AgentAppearance.nullable(),
    ownerUserId: z.string().nullable(),
    reportsToAgentId: z.uuid().nullable().openapi({ description: "Responde a: the agent it reports to, if any." }),
    capabilities: z.array(z.string()).openapi({
      description:
        "What it can do, as stable group keys (`drive`, `github`, `calendar`, `custom`…); empty without `seesDetails`.",
    }),
    busy: z.boolean().openapi({ description: "Working on something right now." }),
    channelIds: z
      .array(z.uuid())
      .openapi({ description: "The channels it is in that the current person may see, in the sidebar's order." }),
    canTalk: z.boolean(),
    seesDetails: z.boolean().openapi({ description: "Whether the current person sees how it works." }),
  });
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/team",
      tags,
      security,
      summary: "The agents as a team: grouped by responsible person, with who consulted whom in the last day",
      request: { params: OrgParams },
      responses: {
        200: json(
          z.object({
            agents: z.array(TeamAgent),
            people: z.array(z.object({ id: z.string(), name: z.string(), image: z.string().nullable() })),
            consultations: z.array(
              z.object({
                id: z.uuid(),
                askerAgentId: z.uuid(),
                targetAgentId: z.uuid(),
                status: z.string(),
                createdAt: z.string(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const team = await getTeam(db, c.get("user").id, orgId);
      return c.json(
        {
          ...team,
          consultations: team.consultations.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/team/channel-move",
      tags,
      security,
      summary:
        "Propose moving an agent to another channel, as the team's right hand's settings card in the person's DM with it (ADR 0148); nothing changes until applied",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            agentId: z.uuid(),
            fromChannelId: z.uuid().nullable(),
            toChannelId: z.uuid(),
            reason: z.string().trim().min(1).max(500),
          }),
        ),
      },
      responses: {
        201: json(z.object({ channelId: z.uuid(), messageId: z.uuid(), rightHandId: z.uuid() }), "Created"),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(
        await proposeChannelMove({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, c.req.valid("json")),
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents",
      tags,
      security,
      summary: "Create an agent",
      request: {
        params: OrgParams,
        body: body(
          AgentFields.extend({
            handle: z.string().min(2).max(32),
            proposal: z.uuid().optional().openapi({
              description: "The card of an agent's proposal it comes from (ADR 0081): it is marked created.",
            }),
            autonomy: CommandApproval.optional().openapi({
              description:
                "The Autonomia it starts with (ADR 0094, the last setup's). Default: low_risk_auto. Whoever may create it may set it: an admin, or its owner (without Manage agents, only your own agent).",
            }),
            setup: z
              .object({
                role: z
                  .string()
                  .regex(/^[a-z][a-z_-]{0,31}$/)
                  .nullable(),
                hello: z.string().max(500).optional().openapi({
                  description: "How it introduced itself on its card, in its own voice (ADR 0164): its first message.",
                }),
                starter: z
                  .string()
                  .regex(/^[a-z][a-z_-]{0,31}$/)
                  .optional()
                  .openapi({ description: "The personal starter it began as (`clara`, ADR 0159 §3)." }),
                apps: z
                  .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), z.enum(["read", "write"]))
                  .refine((apps) => Object.keys(apps).length <= 12, { message: "At most 12 apps" })
                  .optional()
                  .openapi({
                    description:
                      "The apps it was made to use (catalog connector ids) at their levels (ADR 0164): its checklist suggests them; the levels of the ones already connected are set by the app.",
                  }),
              })
              .optional()
              .openapi({
                description:
                  "The ready-made role it starts from (`support`), for its setup checklist's suggestions (ADR 0155 §2), and what its card said (ADR 0164). Every new agent gets the checklist; without it, no role.",
              }),
          }),
        ),
      },
      responses: { 201: json(Agent, "Created"), ...errors },
    }),
    async (c) => {
      const { monthlyBudgetUsd, audience, appearance, proposal, brakes: _brakes, ...input } = c.req.valid("json");
      const orgId = c.req.valid("param").orgId;
      const make = () =>
        createAgent(
          db,
          c.get("user").id,
          orgId,
          {
            ...input,
            monthlyBudgetNanoUsd: budget(monthlyBudgetUsd),
            // A restricted one is born answering only its owner, so an audience refused below never leaves it open.
            ...(audience && audience.mode !== "everyone" ? { audienceMode: "owner" as const } : {}),
          },
          // New agents start on "Automático".
          NEW_AGENT_DEFAULTS,
          // The person's Criar agente: what they pick is what the next one starts with (ADR 0094).
          { remember: true, pubsub: adapters.pubsub },
        );
      let agent = proposal
        ? await createAgentFromProposal({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, proposal, make)
        : await make();
      if (audience) {
        agent = await setAgentAudience(db, c.get("user").id, orgId, agent.id, audience);
        await publishAgentsChanged(adapters.pubsub, orgId);
      }
      if (appearance)
        agent = await setAgentAppearance(db, c.get("user").id, orgId, agent.id, appearance, {
          pubsub: adapters.pubsub,
        });
      // Born on the workspace's own computer: it lists its agents again.
      if (agent.machineId) await publishMachineAgentsChanged(adapters.pubsub, orgId);
      const userId = c.get("user").id;
      const [seesCost, viewer] = await Promise.all([canViewCost(db, userId, orgId), getMembership(db, userId, orgId)]);
      return c.json(toAgent(agent, userId, seesCost, undefined, undefined, viewer), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/autonomy-proposals/{signalId}",
      tags,
      security,
      summary: "Decide an agent's proposal of costly work nobody asked for",
      description:
        "The proposal card (ADR 0131 §3): `go` for this run, `not_now`, or `always` / `never` remembered on the agent for this kind. The person it is for, the agent's owner or someone who manages agents. The run that asked hears it and wakes.",
      request: {
        params: OrgParams.extend({ signalId: z.uuid() }),
        body: body(z.object({ decision: z.enum(["go", "not_now", "never", "always"]) })),
      },
      responses: { 200: json(z.object({ state: z.enum(["go", "not_now", "never", "always"]) })), ...errors },
    }),
    async (c) => {
      const { orgId, signalId } = c.req.valid("param");
      const out = await decideCostlyProposal(
        { db, pubsub: adapters.pubsub },
        c.get("user").id,
        orgId,
        signalId,
        c.req.valid("json").decision,
      );
      return c.json(out, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-proposals/{messageId}",
      tags,
      security,
      summary: "An agent's proposal of a new agent (its card's message), for whoever reads its conversation",
      request: { params: ProposalParams },
      responses: { 200: json(AgentProposal), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const gateway = deps.extras?.context?.gateway;
      return c.json(await getAgentProposal({ db, gateway }, c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-proposals/{messageId}/create",
      tags,
      security,
      summary: "Create a proposed agent as it is, in one click (who may create agents)",
      description:
        "The agent from the draft, owned by whoever creates it, with each line they may give it: its AI (an account of theirs), its channels, its access to the connected apps (an admin's), the mailboxes (only their owner's) and its routine. The card (`applied`, `routineId`) says what it got; the agent that proposed it is told what waits for whom. With `test` (\"Criar e testar\") and a card that has a `firstTask`, the task is then sent from you in your DM with it (`testChannelId`).",
      request: {
        params: ProposalParams,
        body: { ...body(z.object({ test: z.boolean().optional() })), required: false },
      },
      responses: {
        201: json(
          z.object({
            agent: Agent,
            proposal: AgentProposal,
            ai: z.enum(["account", "model", "none"]).openapi({
              description: "What it thinks with now (the clicker's account, the workspace's model or nothing yet).",
            }),
            testChannelId: z
              .uuid()
              .nullable()
              .openapi({ description: '"Criar e testar": the DM its first task went to.' }),
          }),
          "Created",
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      const userId = c.get("user").id;
      const gateway = deps.extras?.context?.gateway;
      const test = c.req.valid("json")?.test === true;
      const made = await createProposedAgent({ db, pubsub: adapters.pubsub, gateway }, userId, orgId, messageId, {
        test,
      });
      if (made.agent.machineId) await publishMachineAgentsChanged(adapters.pubsub, orgId);
      return c.json(
        {
          agent: toAgent(
            made.agent,
            userId,
            await canViewCost(db, userId, orgId),
            undefined,
            undefined,
            await getMembership(db, userId, orgId),
          ),
          proposal: made.proposal,
          ai: made.ai,
          testChannelId: made.testChannelId,
        },
        201,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-proposals/{messageId}/routine",
      tags,
      security,
      summary: "Create the routine a proposal came with, for the agent created from it in the review",
      description:
        "After the review put the agent where the routine reports. Once (409 `agent_proposal.routine_made`); the routine's own rules apply (the agent's owner or an admin).",
      request: { params: ProposalParams },
      responses: { 200: json(AgentProposal), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(
        await createProposedRoutine({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, messageId),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-proposals/{messageId}/deny",
      tags,
      security,
      summary: "Say no to an agent's proposal of a new agent (who may create agents): the card stays, marked denied",
      request: { params: ProposalParams },
      responses: { 200: json(AgentProposal), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await denyAgentProposal({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-proposals/{messageId}/ask",
      tags,
      security,
      summary: "Send a proposed agent you can't create to whoever may (\"Pedir a um admin\", the right hand's cards)",
      description:
        "Only the person it was proposed for, once (409 `agent_proposal.asked`), while it is open. Each person who may create agents gets a waiting inbox entry (`change_request`) and may open the card from it.",
      request: { params: ProposalParams },
      responses: { 200: json(AgentProposal), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await askAgentProposal({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, messageId), 200);
    },
  );

  const TeamParams = OrgParams.extend({ messageId: z.uuid() });
  const TeamCardResult = z
    .object({
      card: TeamProposalCard,
      noAi: z.array(z.uuid()).optional().openapi({
        description: "Agents created with nothing to think with yet: the app opens Connect AI for them.",
      }),
    })
    .openapi("TeamCardResult");
  const teamDeps = () => ({ db, pubsub: adapters.pubsub, gateway: deps.extras?.context?.gateway });

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/team-proposals/{messageId}/create",
      tags,
      security,
      summary: 'Create the whole team on the right hand\'s team card ("Criar o time", who may create agents)',
      description:
        "Its channels, agents, their channels and routines, its skills (admins) and the right hand's weekly check (who manages its routines), as you, in one transaction. A step that fails creates nothing: the card stays open with `error` (which step, and why). Created, the card carries `created` (for Desfazer and what was left out).",
      request: { params: TeamParams },
      responses: { 200: json(TeamCardResult), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await createTeam(teamDeps(), c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/team-proposals/{messageId}/deny",
      tags,
      security,
      summary: "Dismiss the right hand's team card (whoever it was for, or who may create agents)",
      request: { params: TeamParams },
      responses: { 200: json(TeamCardResult), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await denyTeam(teamDeps(), c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/team-proposals/{messageId}/undo",
      tags,
      security,
      summary: "Undo a team created from its card, within a day (whoever created it, or an admin)",
      description:
        "Its routines and skills go; its agents and the channels it created are archived. 409 `team_proposal.undo_expired` after a day.",
      request: { params: TeamParams },
      responses: { 200: json(TeamCardResult), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await undoTeam(teamDeps(), c.get("user").id, orgId, messageId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/team-proposals/{messageId}/agents/{handle}",
      tags,
      security,
      summary: 'Adjust one agent on an open team card before the team is created ("Ajustar")',
      request: {
        params: TeamParams.extend({ handle: z.string().min(1).max(32) }),
        body: body(
          z.object({
            name: z.string().max(80).optional(),
            role: z.string().max(200).optional(),
            line: z.string().max(300).optional(),
            instructions: z.string().max(50_000).optional(),
            channel: z.string().max(81).optional(),
            firstTask: z.string().max(500).optional(),
          }),
        ),
      },
      responses: { 200: json(TeamCardResult), ...errors },
    }),
    async (c) => {
      const { orgId, messageId, handle } = c.req.valid("param");
      return c.json(
        await adjustTeamAgent(teamDeps(), c.get("user").id, orgId, messageId, handle, c.req.valid("json")),
        200,
      );
    },
  );

  const TemplateView = z
    .object({
      id: z.enum(TEAM_TEMPLATES),
      name: z.string(),
      sub: z.string(),
      description: z.string(),
      team: TeamProposalCard.shape.params,
    })
    .openapi("TeamTemplate");

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/team-templates",
      tags,
      security,
      summary: 'The team templates ("See team templates"), in your language',
      description:
        "By business type; in a personal workspace, by area of the person's life instead, whose agents live in their DM with the person and make no channel (ADR 0159). Any template's id can be used in either mode.",
      request: { params: OrgParams, query: z.object({ locale: z.string().max(20).optional() }) },
      responses: { 200: json(z.object({ templates: z.array(TemplateView) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const context = deps.extras?.context;
      const templates = await listTeamTemplates({ db, context }, c.get("user").id, orgId, c.req.valid("query").locale);
      return c.json({ templates }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/team-templates/{templateId}/use",
      tags,
      security,
      summary: 'Create a template\'s team at once ("Criar o time")',
      description:
        "No model call, so it works on a billing hold too: the team is made, and its card in your DM with the right hand reads created, with Undo for a day (ADR 0155 §6). `state` is `pending` with the card's error when a step failed.",
      request: {
        params: OrgParams.extend({ templateId: z.enum(TEAM_TEMPLATES) }),
        body: { ...body(z.object({ locale: z.string().max(20).optional() })), required: false },
      },
      responses: {
        200: json(
          z.object({
            channelId: z.uuid(),
            messageId: z.uuid(),
            state: z.enum(["pending", "creating", "created", "denied", "superseded", "undone"]),
            error: z
              .object({
                step: z.string(),
                reason: z.string(),
                status: z.number().int().optional(),
                code: z.string().optional(),
                params: z.record(z.string(), z.unknown()).optional(),
              })
              .nullable()
              .openapi({ description: "The step that failed and why, as the card keeps it; null once created." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, templateId } = c.req.valid("param");
      const context = deps.extras?.context;
      const input = c.req.valid("json");
      const out = await useTeamTemplate({ ...teamDeps(), context }, c.get("user").id, orgId, templateId, input?.locale);
      return c.json(out, 200);
    },
  );

  /** The team's right hand's AIs (ADR 0137 §11): the caller's own (the default) or the workspace's. */
  const BrainScope = z.enum(["mine", "workspace"]).openapi({
    description:
      "The team's right hand only: `mine`, the caller's own AI for their DM with it (any member); `workspace`, what every DM thinks with while its person has none (admins). Ignored for other agents.",
  });

  const AgentParams = OrgParams.extend({ agentId: z.uuid() });

  const UsageQueueRow = z.object({
    runId: z.uuid(),
    kind: z.enum(["conversation", "routine", "work"]),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    channelKind: z.string(),
    channelName: z.string().nullable().openapi({ description: "Null for a DM." }),
    messageId: z.uuid().openapi({ description: 'What it answers ("Ver conversa" opens it).' }),
    askers: z
      .array(z.string())
      .openapi({ description: "Who asked (people's ids): the trigger's author, then who joined." }),
    since: z.string().openapi({ description: "When it first paused." }),
    after: z.object({ count: z.number().int(), names: z.array(z.string()) }).openapi({
      description: "What was posted in its conversation after it: how many messages, and by whom.",
    }),
    state: z.enum(["queued", "answering"]),
    title: z.string().nullable().openapi({ description: "A routine's or a long work's title." }),
    mayStop: z.boolean().openapi({ description: "The viewer may say not to run it (who asked, the owner, an admin)." }),
  });
  const UsageQueueClosedRow = z.object({
    runId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable(),
    channelKind: z.string(),
    channelName: z.string().nullable(),
    messageId: z.uuid().openapi({ description: "The skipped note." }),
    closed: z.object({
      reason: z.enum(["solved", "withdrawn", "task_canceled", "mixed"]),
      who: z
        .object({ name: z.string(), userId: z.string().optional(), agentId: z.string().optional() })
        .optional()
        .openapi({ description: "Who was credited: the asker (withdrawn), who answered, or who canceled the task." }),
      askers: z.array(z.string()).openapi({ description: "Who asked: they may answer it anyway." }),
      at: z.string(),
    }),
    continuedRunId: z.uuid().nullable().openapi({ description: "Someone asked it to answer anyway: that run." }),
    mayAnswer: z.boolean().openapi({
      description:
        'The viewer may press "Responder mesmo assim" (`POST …/runs/{runId}/continue`): who asked, the owner, an admin, for 7 days.',
    }),
  });
  const UsageQueue = z
    .object({
      agentId: z.uuid(),
      reason: z.enum(["plan", "budget"]).nullable(),
      plan: z.string().nullable(),
      resetsAt: z.string().nullable(),
      sharedWith: z.array(z.uuid()).openapi({ description: "Other agents waiting in the same plan's line." }),
      rows: z.array(UsageQueueRow),
      hidden: z.number().int().openapi({ description: "Waiting in conversations the viewer can't read." }),
      mayStopAll: z.boolean().openapi({ description: "\"Don't run any\": the agent's owner and admins." }),
      closed: z.array(UsageQueueClosedRow).openapi({
        description: "Catch-ups skipped in the last day as already handled (ADR 0136), newest first.",
      }),
    })
    .openapi("UsageQueue");
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/usage-queue",
      tags,
      security,
      summary: "What an agent picks up when its plan or budget is back, in order",
      description:
        "One row per conversation waiting on the agent's plan or budget (ADR 0118), people's first, then long work, then routines, each by when it first paused; the one answering now first. Rows only for conversations the viewer reads (`hidden` counts the rest). Refetch on `agent.status` events.",
      request: { params: AgentParams },
      responses: { 200: json(UsageQueue), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await usageQueue(db, c.get("user").id, orgId, agentId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/usage-queue/cancel",
      tags,
      security,
      summary: "Don't run anything waiting on the agent's plan or budget",
      description:
        "Every conversation, routine and long work waiting on the agent's plan or budget is stopped, each audited as a stop and its note saying it won't run. The agent's owner and admins.",
      request: { params: AgentParams },
      responses: {
        200: json(z.object({ canceled: z.number().int(), skipped: z.number().int() })),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await cancelUsageQueue({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, agentId), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/agents/{agentId}",
      tags,
      security,
      summary: "Edit an agent",
      request: {
        params: AgentParams,
        body: body(
          AgentFields.partial().extend({
            handle: z.string().min(2).max(32).optional().openapi({
              description:
                "Its new @handle (admins): the one it leaves keeps reaching it. Taken by another agent (now or before) or a person: 409 `agent.handle_taken` with a free `suggestion`.",
            }),
            coordinator: z.boolean().optional().openapi({
              deprecated: true,
              description: "Ignored. Older apps send it: the team's coordinator (ADR 0093) is retired (ADR 0137).",
            }),
            acceptPlanTerms: z.boolean().optional().openapi({
              deprecated: true,
              description: "Ignored. Older apps send it when an agent on a plan replies to everyone.",
            }),
            mailLossSeen: z.array(z.uuid()).max(500).optional().openapi({
              description:
                "With `audience`: the mailboxes the person agreed it loses (`audience/mail-loss`). If it would lose another (given since), 409 `agent.mail_loss_changed` and nothing is saved: ask again.",
            }),
          }),
        ),
      },
      responses: { 200: json(Agent), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const {
        monthlyBudgetUsd,
        audience,
        appearance,
        coordinator: _coordinator,
        acceptPlanTerms: _,
        mailLossSeen,
        brakes,
        ...rest
      } = c.req.valid("json");
      const input = { ...rest, ...(brakes ? { autonomyBrakes: brakes } : {}) };
      const actor = c.get("user").id;
      // The audience and the look can be changed by the agent's owner too; everything else needs an admin.
      const other =
        (!audience && appearance === undefined) ||
        Object.values(input).some((v) => v !== undefined) ||
        monthlyBudgetUsd !== undefined;
      let agent = other
        ? await updateAgent(
            db,
            actor,
            orgId,
            agentId,
            { ...input, monthlyBudgetNanoUsd: budget(monthlyBudgetUsd) },
            { pubsub: adapters.pubsub },
          )
        : null;
      if (audience) {
        agent = await setAgentAudience(db, actor, orgId, agentId, audience, mailLossSeen);
        await publishAgentsChanged(adapters.pubsub, orgId);
      }
      if (appearance !== undefined)
        agent = await setAgentAppearance(db, actor, orgId, agentId, appearance, { pubsub: adapters.pubsub });
      if (!agent) {
        agent = await getAgent(db, orgId, agentId);
        if (!agent) throw new NotFoundError("Agent not found");
      }
      // Its computer shows its name and look (the desktop app, ADR 0036) and names its folder by its handle, and a new
      // owner may take its plan away.
      if (
        agent.machineId &&
        (input.name !== undefined ||
          input.handle !== undefined ||
          appearance !== undefined ||
          input.ownerUserId !== undefined)
      ) {
        await publishMachineAgentsChanged(adapters.pubsub, orgId);
      }
      const [seesCost, brains, viewer, old] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBrainLines(db, actor, orgId, [agent]),
        getMembership(db, actor, orgId),
        oldHandlesByAgent(db, orgId),
      ]);
      return c.json(
        {
          ...toAgent(agent, actor, seesCost, undefined, brains.get(agent.id), viewer),
          previousHandles: old.get(agent.id) ?? [],
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/setup/{step}",
      tags,
      security,
      summary: "Confirm a step of a new agent's setup checklist",
      description:
        "Its owner or whoever manages agents chose (or skipped) one step of the checklist at the top of its chat (ADR 0155 §2). Confirming twice changes nothing; an agent with no checklist keeps none.",
      request: { params: AgentParams.extend({ step: SetupStep }) },
      responses: { 200: json(Agent), ...errors },
    }),
    async (c) => {
      const { orgId, agentId, step } = c.req.valid("param");
      const actor = c.get("user").id;
      await confirmSetupStep(db, actor, orgId, agentId, step);
      // Another device of theirs, or another admin, ticks the row at once.
      await publishAgentsChanged(adapters.pubsub, orgId);
      const agent = await getAgent(db, orgId, agentId);
      if (!agent) throw new NotFoundError("Agent not found");
      const [seesCost, brains, viewer, old] = await Promise.all([
        canViewCost(db, actor, orgId),
        agentBrainLines(db, actor, orgId, [agent]),
        getMembership(db, actor, orgId),
        oldHandlesByAgent(db, orgId),
      ]);
      return c.json(
        {
          ...toAgent(agent, actor, seesCost, undefined, brains.get(agent.id), viewer),
          previousHandles: old.get(agent.id) ?? [],
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/audience/mail-loss",
      tags,
      security,
      summary: "The mailboxes a new audience would take from the agent, taking nothing",
      description:
        "Letting someone new talk to an agent takes the mailboxes other people gave it (only a mailbox's owner gives an agent access to it, ADR 0038): the apps ask here first and name whose mail goes. Empty when the audience lets nobody new in or every mailbox is the caller's own. Its owner or admins, as for saving the audience.",
      request: { params: AgentParams, body: body(z.object({ audience: AgentAudience })) },
      responses: {
        200: json(
          z.object({
            mailboxes: z.array(
              z.object({
                accountId: z.uuid(),
                address: z.string(),
                ownerUserId: z.string().nullable(),
                ownerName: z.string().nullable(),
              }),
            ),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const { audience } = c.req.valid("json");
      return c.json({ mailboxes: await audienceMailLoss(db, c.get("user").id, orgId, agentId, audience) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agents/{agentId}",
      tags,
      security,
      summary: "Archive an agent (or delete it for good with ?purge=true)",
      description:
        "Deleting (ADR 0082) is permanent and works on archived agents too: its instructions, memory, routines, grants, budget, channels and login on its computer go, its work stops and its DMs close; its messages, usage and audit rows stay, named by a tombstone that frees its handle. Owners and admins.",
      request: { params: AgentParams, query: z.object({ purge: z.stringbool().optional() }) },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const actor = c.get("user").id;
      if (c.req.valid("query").purge) {
        const hub = deps.extras?.sandbox?.machines?.hub ?? null;
        await deleteAgent({ db, pubsub: adapters.pubsub, hub, mail: adapters.mail }, actor, orgId, agentId);
        return c.body(null, 204);
      }
      await archiveAgent(db, actor, orgId, agentId, adapters.pubsub);
      await publishMachineAgentsChanged(adapters.pubsub, orgId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agents/{agentId}/unarchive",
      tags,
      security,
      summary: "Bring an archived agent back to the team (who manages agents); a deleted one never comes back",
      request: { params: AgentParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      await unarchiveAgent(db, c.get("user").id, orgId, agentId, { pubsub: adapters.pubsub });
      await publishMachineAgentsChanged(adapters.pubsub, orgId);
      return c.body(null, 204);
    },
  );

  // ── Agent groups (ADR 0083) ───────────────────────────────────────────────
  // Every write answers with every group and tells the workspace's open apps (`agent.groups`).
  const groups = { db, pubsub: adapters.pubsub };
  const Groups = z.object({
    groups: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        agentIds: z.array(z.uuid()).openapi({ description: "Its agents in order (archived ones left out)." }),
        color: z.string().openapi({ description: "One of the roles' colors." }),
        icon: z.string().openapi({ description: "One of the roles' icons." }),
        leadUserId: z.string().nullable().openapi({ description: "Who leads the setor (ADR 0148)." }),
        backupUserId: z.string().nullable().openapi({ description: "Who covers for the lead." }),
      }),
    ),
  });
  const GroupLook = {
    color: z.string().max(20).optional(),
    icon: z.string().max(40).optional(),
  };
  const GroupParams = OrgParams.extend({ groupId: z.uuid() });
  const GroupName = z.string().trim().min(1).max(80);

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-groups",
      tags,
      security,
      summary: "The workspace's groups of agents, in order; an agent is in one at most",
      request: { params: OrgParams },
      responses: { 200: json(Groups), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ groups: await listAgentGroups(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-groups",
      tags,
      security,
      summary: "Add a group after the others, with these agents in it in order (owners and admins)",
      request: {
        params: OrgParams,
        body: body(z.object({ name: GroupName, agentIds: z.array(z.uuid()).max(200).optional(), ...GroupLook })),
      },
      responses: { 201: json(Groups, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ groups: await createAgentGroup(groups, c.get("user").id, orgId, c.req.valid("json")) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/agent-groups/{groupId}",
      tags,
      security,
      summary:
        "Rename a group, move it among the groups (`index`), or set its color, icon, lead or substitute (owners and admins)",
      request: {
        params: GroupParams,
        body: body(
          z.object({
            name: GroupName.optional(),
            index: z.number().int().min(0).optional(),
            ...GroupLook,
            leadUserId: z.string().min(1).max(200).nullable().optional(),
            backupUserId: z.string().min(1).max(200).nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(Groups), ...errors },
    }),
    async (c) => {
      const { orgId, groupId } = c.req.valid("param");
      return c.json(
        { groups: await updateAgentGroup(groups, c.get("user").id, orgId, groupId, c.req.valid("json")) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agent-groups/{groupId}",
      tags,
      security,
      summary: "Delete a group; its agents go back to no group (owners and admins)",
      request: { params: GroupParams },
      responses: { 200: json(Groups), ...errors },
    }),
    async (c) => {
      const { orgId, groupId } = c.req.valid("param");
      return c.json({ groups: await deleteAgentGroup(groups, c.get("user").id, orgId, groupId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agent-lines",
      tags,
      security,
      summary:
        "Set who agents report to (Responde a), in order, all or none: one agent, a setor's agents, or Desfazer with what came back (who manages agents)",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            changes: z
              .array(z.object({ agentId: z.uuid(), reportsToAgentId: z.uuid().nullable() }))
              .min(1)
              .max(200),
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            previous: z
              .array(z.object({ agentId: z.uuid(), reportsToAgentId: z.uuid().nullable() }))
              .openapi({ description: "What the changed agents reported to before: send it back to undo." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await setReportsTo(groups, c.get("user").id, orgId, c.req.valid("json").changes), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/group",
      tags,
      security,
      summary:
        "Move an agent into a group (at `index` among its agents, else at the end) or out of any (owners and admins)",
      request: {
        params: AgentParams,
        body: body(z.object({ groupId: z.uuid().nullable(), index: z.number().int().min(0).optional() })),
      },
      responses: { 200: json(Groups), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(
        { groups: await moveAgentToGroup(groups, c.get("user").id, orgId, agentId, c.req.valid("json")) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/usage",
      tags,
      security,
      summary: "Tokens and cost per agent this month",
      request: { params: OrgParams },
      responses: { 200: json(z.object({ usage: z.array(Usage) })), ...errors },
    }),
    async (c) => {
      const rows = await usageSummary(db, c.get("user").id, c.req.valid("param").orgId);
      return c.json(
        { usage: rows.map(({ costNanoUsd, ...r }) => ({ ...r, costUsd: nanoUsdToUsd(costNanoUsd) })) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/brain-machines",
      tags,
      security,
      summary:
        '"Quem pensa" for an agent still being created: every computer of the workspace with what it offers (Claude Code, Codex). Admins (who create agents).',
      request: { params: OrgParams },
      responses: { 200: json(z.object({ machines: z.array(BrainMachine) })), ...errors },
    }),
    async (c) => {
      const machines = await newAgentBrainMachines({ db }, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ machines }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/brain",
      tags,
      security,
      summary:
        "\"Quem pensa\" (ADR 0032): the model (API), Claude Code or Codex on its computer, the model and the fallback, with what its computer offers. An admin or the agent's owner; the team's right hand's `mine`, any member.",
      request: { params: AgentParams, query: z.object({ scope: BrainScope.optional() }) },
      responses: { 200: json(AgentBrain), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const scope = c.req.valid("query").scope ?? "mine";
      return c.json(await getAgentBrain({ db }, c.get("user").id, orgId, agentId, scope), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/agents/{agentId}/brain",
      tags,
      security,
      summary:
        "Choose who thinks for the agent (an admin or the agent's owner; audited); only what its computer has can be chosen. A plan (Claude Code or Codex) answers only the agent's owner at first; letting others talk to it is the owner's choice (`onlyOwner: false`).",
      request: {
        params: AgentParams,
        body: body(
          z.object({
            scope: BrainScope.optional(),
            brain: BrainKind.optional(),
            model: z.string().max(80).nullable().optional().openapi({
              description:
                "Claude Code: `opus`, `sonnet`, `haiku`, a Claude model id or one of a coding plan's models by id (`@agenteschat/providers/plans`; another account runs `sonnet` for it); Codex: a model name; `auto` (each run picks the tier). Null = the brain's default; omitted = keep (reset when the brain changes).",
            }),
            fallback: z.boolean().optional(),
            extraUsage: z.boolean().optional().openapi({
              description:
                "Long work may go on into the plan's paid extra usage when the provider reports it on (ADR 0118; Claude's plans); false: it pauses at 95% of the plan like any other. Only the agent's owner changes it (`brain.extra_owner_only`): it bills their plan. Omitted = keep.",
            }),
            onlyOwner: z.boolean().optional().openapi({
              description:
                "\"Atende outras pessoas\" turned off (ADR 0059): true, only its owner talks to it; false, whoever its audience's people list lets in, everyone with no list (its owner or an admin, on a plan too). Omitted = keep; switching onto a plan makes it the owner's only. Audited as `agent.audience_changed`.",
            }),
            acceptPlanTerms: z.boolean().optional().openapi({
              deprecated: true,
              description: "Ignored. Older apps send it with `onlyOwner: false`.",
            }),
            account: z.uuid().nullable().optional().openapi({
              description:
                "An account on the agent's computer of the brain's kind (ADR 0041); null = the computer's own sign-in; omitted = keep (cleared when the brain kind changes). One of the agent's owner's accounts, chosen by its owner or an admin (`account.not_owner`), or anyone's there for someone with `use_others_plans` (its owner is told, `account.lent`).",
            }),
            moveAccount: z.boolean().optional().openapi({
              description: "The account thinks for another agent (`account.in_use`): take it from that one (audited).",
            }),
            effort: BrainEffortSetting.nullable()
              .optional()
              .openapi({ description: "`auto` = picked per run; null = the CLI's default; omitted = keep." }),
            speed: BrainSpeed.optional().openapi({ description: "Omitted = keep." }),
            contextTokens: ContextLimit.nullable().optional().openapi({
              description:
                "The most context it reads, any brain (Claude Code and Codex compact there, the API brain drops old tool results); null = its model's window; omitted = keep.",
            }),
          }),
        ),
      },
      responses: { 200: json(AgentBrain), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      const input = c.req.valid("json");
      const view = await setAgentBrain({ db }, c.get("user").id, orgId, agentId, {
        ...input,
        scope: input.scope ?? "mine",
      });
      // Its computers hear which account each agent thinks with (system mode lends the folders by it), on every save:
      // the one an old plan was on may be none the view shows (the team's right hand, which is on no computer).
      await publishMachineAgentsChanged(adapters.pubsub, orgId);
      await publishAgentsChanged(adapters.pubsub, orgId);
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agent-setup",
      tags,
      security,
      summary:
        'What a new agent starts thinking with (ADR 0094): the last "Quem pensa" someone saved or used on other agents, with its Autonomia, as it stands now. Whoever creates agents.',
      request: { params: OrgParams },
      responses: { 200: json(z.object({ setup: NewAgentSetup.nullable() })), ...errors },
    }),
    async (c) => {
      const setup = await getNewAgentSetup({ db }, c.get("user").id, c.req.valid("param").orgId);
      return c.json({ setup }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/agent-setup",
      tags,
      security,
      summary:
        'Use one agent\'s "Quem pensa" and its Autonomia on these agents (ADR 0094), each by its own rules: who may change it, whose plan thinks for it. Each change is audited as its own (`agent.brain`, `agent.mission_command_approval`, `via: setup`); `preview` says what each would do and keeps nothing. Applied, it is what new agents start with.',
      request: {
        params: OrgParams,
        body: body(
          z.object({
            setup: AgentSetup,
            agentIds: z.array(z.uuid()).min(1).max(SETUP_AGENTS_MAX),
            preview: z.boolean().optional(),
          }),
        ),
      },
      responses: { 200: json(z.object({ results: z.array(AgentSetupResult) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      const results = await applyAgentSetup({ db }, c.get("user").id, orgId, input);
      // Their computers hear which account each agent thinks with now (system mode lends the folders by it).
      if (!input.preview && results.some((r) => r.status === "applied")) {
        await publishMachineAgentsChanged(adapters.pubsub, orgId);
        await publishAgentsChanged(adapters.pubsub, orgId);
      }
      return c.json({ results }, 200);
    },
  );

  return app;
}
