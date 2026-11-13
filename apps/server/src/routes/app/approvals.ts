import {
  COVER_MODES,
  cancelAheadApproval,
  decideApproval,
  decideApprovals,
  endCover,
  getApproval,
  getMyCovers,
  getRightHandApprovals,
  listApprovalRules,
  listApprovals,
  memoryJudging,
  RIGHT_HAND_CAPS,
  removeApprovalRule,
  setMyCover,
  setRightHandApprovals,
  undoRightHandDecision,
} from "@agenteschat/engine";
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

const tags = ["Approvals"];

/** Where an approval asked while nobody watched comes from (ADR 0053 §8): a routine, or unattended work. */
export const ApprovalOrigin = z.union([
  z.object({ kind: z.literal("routine"), routineId: z.string(), routineName: z.string() }),
  z.object({ kind: z.literal("unattended") }),
]);

/** The email a mail approval writes, as its card shows it. */
export const ApprovalEmail = z
  .object({
    verb: z.enum(["draft", "send", "reply", "forward"]),
    mailbox: z.string().openapi({ example: "support@acme.com" }),
    provider: z.string().nullable().openapi({ example: "iCloud" }),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    bcc: z.array(z.string()),
    subject: z.string(),
    body: z.string().openapi({ description: "The text, cut after 1500 characters." }),
    original: z
      .object({ subject: z.string(), from: z.string().nullable() })
      .nullable()
      .openapi({ description: "The message it answers or forwards." }),
  })
  .openapi("ApprovalEmail");

export const Approval = z
  .object({
    id: z.uuid(),
    runId: z.uuid().nullable().openapi({ description: "Null when a mission's executor asked (`missionId`)." }),
    missionId: z.uuid().nullable(),
    agentId: z.uuid(),
    channelId: z.uuid(),
    threadId: z.uuid().nullable().openapi({ description: "Where its card is; null: the channel's main timeline." }),
    messageId: z.uuid().nullable().openapi({ description: "The approval card in the chat." }),
    tool: z.string(),
    scope: z.string(),
    title: z.string().openapi({ example: "Merge PR #42 into main" }),
    detail: z.string(),
    params: z.record(z.string(), z.unknown()).openapi({ description: "Exactly what will run if approved." }),
    status: z.enum(["pending", "approved", "refused", "expired", "canceled"]),
    expiresAt: z.string(),
    createdAt: z.string(),
    decidedByUserId: z.string().nullable(),
    decidedForUserId: z.string().nullable().openapi({
      description: 'Decided by someone covering this person (ADR 0139): "Aprovado por Bruno, cobrindo Ana".',
    }),
    decidedAt: z.string().nullable(),
    reason: z.string().nullable(),
    canDecide: z.boolean().openapi({ description: "You are the agent's owner or an admin, and it is pending." }),
    ownerUserId: z.string().nullable().openapi({ description: "The agent's owner (they and admins may decide)." }),
    executedAt: z.string().nullable().openapi({ description: "When the approved action ran." }),
    result: z
      .object({ ok: z.boolean(), text: z.string() })
      .nullable()
      .openapi({ description: "What the action returned once it ran (raw, short)." }),
    connector: z.string().nullable().openapi({ example: "github" }),
    connectorAccount: z.string().nullable().openapi({ example: "acme" }),
    email: ApprovalEmail.nullable().openapi({
      description: "The email itself, for mail drafts and sends (From, To, Subject, text); null otherwise.",
    }),
    why: z
      .string()
      .nullable()
      .openapi({ description: "The agent's required reason: what it found and why this action." }),
    origin: ApprovalOrigin.nullable().openapi({
      description: "Asked while nobody was watching: by a routine, or by unattended work.",
    }),
    issue: z.object({ id: z.uuid(), number: z.number().int(), title: z.string() }).nullable(),
    trail: z
      .array(z.object({ text: z.string(), at: z.string() }))
      .optional()
      .openapi({ description: "One approval only: what the agent said at each turn before asking." }),
    approveAlways: z
      .object({ tool: z.string(), actions: z.array(z.string()), routineId: z.string().optional() })
      .nullable()
      .openapi({
        description:
          '"Aprovar sempre" is offered: approving with `always` lets the agent run this server tool (each of these wrapped actions) without asking again, with any values; with `routineId` ("Sempre nesta rotina"), that routine\'s runs only. Null: not offered.',
        example: { tool: "COMPOSIO_MULTI_EXECUTE_TOOL", actions: ["GITHUB_CREATE_AN_ISSUE_COMMENT"] },
      }),
    runAt: z.string().nullable().openapi({
      description:
        "Approved ahead (`schedule_action`): when the routine's run does it by itself, without asking again. Null: it runs once approved.",
    }),
    routineId: z.uuid().nullable().openapi({ description: "The routine whose run at `runAt` it is for." }),
    canCancel: z
      .boolean()
      .openapi({ description: "Approved ahead and not run yet, and you may withdraw it (`…/cancel`)." }),
    approvers: z
      .object({
        label: z.string().openapi({ description: "Who decides, in words.", example: "Diretoria" }),
        requestedByUserId: z.string().nullable().openapi({ description: "Whose request it was." }),
        requesterDecides: z
          .boolean()
          .openapi({ description: "The requester approves by role, so they may decide it too." }),
      })
      .nullable()
      .openapi({
        description:
          "Asked with `request_approval` (ADR 0126): who decides instead of the agent's owner and admins. Null: any other approval.",
      }),
  })
  .openapi("Approval");

const CoverView = z.object({
  userId: z.string().openapi({ description: "Who covers me (`cover`), or whom I cover (`covering`)." }),
  mode: z.enum(COVER_MODES).openapi({ description: "`always`, or `while_out`: only while the status says out." }),
  risky: z.boolean().openapi({ description: "Merge, deploy and other high-risk actions are in." }),
  endsAt: z.string().nullable(),
  active: z.boolean().openapi({ description: "Deciding now: not past its end, and `always` or the person is out." }),
});

export const ApprovalCovers = z
  .object({ cover: CoverView.nullable(), covering: z.array(CoverView) })
  .openapi("ApprovalCovers");

export const RightHandApprovals = z
  .object({
    enabled: z.boolean(),
    newAgents: z.boolean().openapi({ description: "Creating agents other agents propose (no apps, open channels)." }),
    agentChanges: z
      .boolean()
      .openapi({ description: "Model on the same AI account, budget and open channels of an existing agent." }),
    budgetCapNanoUsd: z.number().int().openapi({ description: "Budget it may add per agent in a month." }),
    guidance: z.string(),
    pausedAt: z.string().nullable().openapi({ description: "Three decisions undone in a week stopped it." }),
    rightHand: z.object({ id: z.string(), name: z.string() }).nullable(),
    mayDecide: z.object({ newAgents: z.boolean(), agentChanges: z.boolean() }),
    caps: z.object({ decisionsPerDay: z.number(), newAgentsPerDay: z.number(), monthNanoUsd: z.number() }),
    used: z.object({ decisionsToday: z.number(), newAgentsToday: z.number(), monthNanoUsd: z.number() }),
  })
  .openapi("RightHandApprovals");

export const ApprovalRule = z
  .object({
    id: z.uuid(),
    connectionId: z
      .uuid()
      .nullable()
      .openapi({ description: "Null: a command on the agent's computer (`tool` is `command`)." }),
    server: z
      .string()
      .nullable()
      .openapi({ description: "The connection's name; null for a command.", example: "Composio" }),
    tool: z.string().openapi({ description: "The server's own tool name.", example: "COMPOSIO_MULTI_EXECUTE_TOOL" }),
    toolLabel: z.string().openapi({ description: "How the workspace labelled that tool." }),
    action: z.string().openapi({
      description: "The wrapped action (empty: the tool itself).",
      example: "GITHUB_CREATE_AN_ISSUE_COMMENT",
    }),
    createdByUserId: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("ApprovalRule");

const ApprovalParams = OrgParams.extend({ approvalId: z.uuid() });
const AgentParams = OrgParams.extend({ agentId: z.uuid() });
/** The card it was decided from, for the audit's "via" (ADR 0137 §4): ignored unless that card lists it. */
const Via = z.uuid().optional().openapi({ description: "The right hand's approvals card it was decided from." });
const Decision = z.object({ reason: z.string().max(1000).optional(), via: Via });
const Approve = Decision.extend({
  always: z.boolean().optional().openapi({
    description:
      "Also approve this kind for good (only where `approveAlways` is set, else 409 `approval.always_unavailable`).",
  }),
});

/**
 * Sensitive actions agents asked for (ADR 0015). Decisions resume the run; events
 * `approval.created` / `approval.decided` go to the channel and to approvers
 * over the WebSocket.
 */
export function approvalRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/approvals",
      tags,
      security,
      summary: "Approvals you can see (admins: all; others: their agents' and their channels')",
      request: {
        params: OrgParams,
        query: z.object({
          status: z.enum(["pending", "decided"]).optional(),
          agentId: z.uuid().optional(),
          messageId: z.uuid().optional().openapi({ description: "The requests on one approval card." }),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: { 200: json(z.object({ approvals: z.array(Approval) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ approvals: await listApprovals(db, c.get("user").id, orgId, c.req.valid("query")) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/approvals/{approvalId}",
      tags,
      security,
      summary: "One approval",
      request: { params: ApprovalParams },
      responses: { 200: json(Approval), ...errors },
    }),
    async (c) => {
      const { orgId, approvalId } = c.req.valid("param");
      return c.json(await getApproval(db, c.get("user").id, orgId, approvalId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/approvals/decide",
      tags,
      security,
      summary: 'Decide several at once (a card\'s "Aprovar tudo"): exactly these ids, the ones you may decide',
      request: {
        params: OrgParams,
        body: body(
          z.object({
            ids: z.array(z.uuid()).min(1).max(50),
            decision: z.enum(["approve", "refuse"]),
            reason: z.string().max(1000).optional(),
            via: Via,
          }),
        ),
      },
      responses: {
        200: json(
          z.object({
            approvals: z.array(Approval),
            skipped: z
              .array(z.uuid())
              .openapi({ description: "Not decided: already decided, not found, or not yours to decide." }),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const result = await decideApprovals(
        {
          db,
          pubsub: adapters.pubsub,
          memory: deps.extras?.context ? memoryJudging(deps.extras.context) : undefined,
        },
        c.get("user").id,
        orgId,
        c.req.valid("json"),
      );
      deps.wakeWorkers?.();
      return c.json(result, 200);
    },
  );

  for (const decision of ["approve", "refuse"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/organizations/{orgId}/approvals/{approvalId}/${decision}`,
        tags,
        security,
        summary:
          decision === "approve" ? "Approve: the run executes exactly this action" : "Refuse: the agent is told why",
        request: { params: ApprovalParams, body: body(decision === "approve" ? Approve : Decision) },
        responses: { 200: json(Approval), ...errors },
      }),
      async (c) => {
        const { orgId, approvalId } = c.req.valid("param");
        const input: { reason?: string; always?: boolean; via?: string } = c.req.valid("json");
        const view = await decideApproval(
          {
            db,
            pubsub: adapters.pubsub,
            memory: deps.extras?.context ? memoryJudging(deps.extras.context) : undefined,
          },
          c.get("user").id,
          orgId,
          approvalId,
          { decision, reason: input.reason, always: decision === "approve" && input.always === true, via: input.via },
        );
        deps.wakeWorkers?.();
        return c.json(view, 200);
      },
    );
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/approvals/{approvalId}/cancel",
      tags,
      security,
      summary:
        "Withdraw an action approved ahead before its time (or its request, still waiting): its routine's run won't do it",
      description:
        "Of those who see it (as on the approvals list), who may decide it and who manages its routine: 404 for anyone else. 409 `approval.not_ahead` for an action that runs once approved, `approval.not_cancelable` once it ran or ended.",
      request: { params: ApprovalParams },
      responses: { 200: json(Approval), ...errors },
    }),
    async (c) => {
      const { orgId, approvalId } = c.req.valid("param");
      const view = await cancelAheadApproval({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, approvalId);
      deps.wakeWorkers?.();
      return c.json(view, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/me/approval-cover",
      tags,
      security,
      summary: "Who approves for me, and whom I approve for (ADR 0139)",
      request: { params: OrgParams },
      responses: { 200: json(ApprovalCovers), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await getMyCovers(db, c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/me/approval-cover",
      tags,
      security,
      summary: "Choose who approves for me",
      description:
        "One person of the workspace, never you (400 `approval_cover.self`, `approval_cover.not_member`), until `endsAt` (in the future: 400 `approval_cover.ends_past`) or null. They decide in your name what is asked of you personally, never their own requests, a mailbox's actions or access for good; merge, deploy and the like only with `risky`. They hear it in their inbox.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            userId: z.string().min(1),
            mode: z.enum(COVER_MODES),
            risky: z.boolean(),
            endsAt: z.iso.datetime({ offset: true }).nullable(),
          }),
        ),
      },
      responses: { 200: json(ApprovalCovers), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      return c.json(await setMyCover({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, input), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/me/right-hand-approvals",
      tags,
      security,
      summary: "Whether the right hand approves for me, and within what (ADR 0139)",
      request: { params: OrgParams },
      responses: { 200: json(RightHandApprovals), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json(await getRightHandApprovals(db, c.get("user").id, orgId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/me/right-hand-approvals",
      tags,
      security,
      summary: "Let the right hand approve for me",
      description:
        "It decides only cards another agent posted from your own request, of the kinds turned on, and approves or passes them to you. The budget per agent is from 0 to US$ 50 (400 `right_hand_approvals.budget`); guidance at most 2,000 characters. Turning it on ends a pause.",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            enabled: z.boolean().optional(),
            newAgents: z.boolean().optional(),
            agentChanges: z.boolean().optional(),
            budgetCapNanoUsd: z.number().int().min(0).max(RIGHT_HAND_CAPS.budgetCapMax).optional(),
            guidance: z.string().max(RIGHT_HAND_CAPS.guidanceChars).optional(),
          }),
        ),
      },
      responses: { 200: json(RightHandApprovals), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const input = c.req.valid("json");
      return c.json(await setRightHandApprovals({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, input), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/right-hand-decisions/{decisionId}/undo",
      tags,
      security,
      summary: "Desfazer what the right hand approved for someone",
      description:
        "For 24 hours (409 `right_hand.undo_expired`), by the person it decided for or who manages agents: a new agent is archived, settings go back (409 `right_hand.changed_since` when they moved). Three undone in a week pause it.",
      request: { params: OrgParams.extend({ decisionId: z.uuid() }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, decisionId } = c.req.valid("param");
      await undoRightHandDecision({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, decisionId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/approval-covers/{userId}",
      tags,
      security,
      summary: 'End someone\'s cover: theirs, the one you give them ("Não quero cobrir"), or any as an admin',
      description:
        "The covered person, the person covering them or who manages members (403 otherwise; 404 `approval_cover.not_found`). The covered person hears it when someone else ends it.",
      request: { params: OrgParams.extend({ userId: z.string().min(1) }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, userId } = c.req.valid("param");
      await endCover({ db, pubsub: adapters.pubsub }, c.get("user").id, orgId, userId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/agents/{agentId}/approval-rules",
      tags,
      security,
      summary: 'What the agent runs without asking ("Aprovar sempre"), oldest first',
      request: { params: AgentParams },
      responses: { 200: json(z.object({ rules: z.array(ApprovalRule) })), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json({ rules: await listApprovalRules(db, c.get("user").id, orgId, agentId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/agents/{agentId}/approval-rules/{ruleId}",
      tags,
      security,
      summary: "The agent asks again for this kind (admins and the agent's owner)",
      request: { params: AgentParams.extend({ ruleId: z.uuid() }) },
      responses: { ...noContent, ...errors },
    }),
    async (c) => {
      const { orgId, agentId, ruleId } = c.req.valid("param");
      await removeApprovalRule(db, c.get("user").id, orgId, agentId, ruleId);
      return c.body(null, 204);
    },
  );

  return app;
}
