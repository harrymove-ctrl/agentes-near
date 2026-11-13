import {
  askAgentToImplement,
  commentIssue,
  createIssue,
  createIssueColumn,
  deleteIssue,
  deleteIssueColumn,
  getIssueDetail,
  type IssueDeps,
  issueFromMessage,
  listIssueActivity,
  listIssueColumns,
  listIssues,
  openTaskConversation,
  setCriterion,
  setIssueAudience,
  updateIssue,
  updateIssueColumn,
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
import { AudienceChoice, WorkView } from "./schemas";

const tags = ["Issues"];
const Actor = z.object({ type: z.enum(["person", "agent"]), id: z.string() });
const Status = z.enum(["todo", "in_progress", "in_review", "done", "canceled"]);
const Priority = z.enum(["low", "normal", "high"]);
const GithubUrl = z
  .string()
  .max(500)
  .nullable()
  .openapi({ description: "The GitHub issue or pull request this task is about (`null` removes it)." });
const DueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

const ConversationRef = z.object({
  channelId: z.uuid().openapi({ description: "The conversation's own channel (kind `task`): the chat's routes." }),
  rootId: z.uuid().openapi({ description: "The thread's root: replies go to it (`threadId`)." }),
});
const Conversation = ConversationRef.extend({
  count: z.number().int().openapi({ description: "Messages in it." }),
  lastAt: z.string().nullable(),
  participants: z.array(Actor).openapi({ description: "The first ones to write, oldest first (at most 5)." }),
  working: z.boolean().openapi({ description: "An agent's turn is live in it." }),
});

const Issue = z
  .object({
    id: z.uuid(),
    number: z.number(),
    title: z.string(),
    description: z.string(),
    status: Status,
    columnId: z.uuid().nullable().openapi({ description: "Its board column, always one of its stage." }),
    boardRank: z.number().openapi({ description: "Order inside the column, lowest first." }),
    priority: Priority,
    assignee: Actor.nullable(),
    labels: z.array(z.string()),
    dueDate: z.string().nullable(),
    criteria: z.array(
      z.object({ id: z.string(), text: z.string(), done: z.boolean(), doneBy: Actor.nullable().optional() }),
    ),
    createdBy: Actor,
    source: z.record(z.string(), z.unknown()),
    channelId: z.uuid().nullable(),
    audience: z
      .object({
        mode: z.enum(["everyone", "people"]),
        userIds: z.array(z.string()),
        channelId: z.uuid().nullable().openapi({
          description: "Those people are whoever is in this conversation now, a DM or a private channel.",
        }),
      })
      .openapi({ description: "Who sees it besides administrators (ADR 0151)." }),
    parentIssueId: z.uuid().nullable().openapi({ description: "The issue this one is a sub-issue of." }),
    pullRequests: z.array(z.object({ number: z.number(), url: z.string(), openedBy: Actor.nullable() })),
    githubUrl: z.string().nullable(),
    artifacts: z.array(z.object({ id: z.uuid(), title: z.string(), createdBy: Actor })),
    work: z
      .object({
        agentId: z.uuid(),
        runId: z.uuid().nullable(),
        state: z.enum(["running", "waiting_approval", "waiting_input", "stalled"]),
        since: z.string(),
        steps: z.array(
          z.object({
            tool: z.string(),
            detail: z.string().optional(),
            at: z.string(),
            outcome: z
              .enum(["refused", "waiting"])
              .optional()
              .openapi({ description: "A computer command's check: refused, or still waiting on a person." }),
          }),
        ),
        reason: z.enum(["failed", "canceled", "budget"]).optional(),
      })
      .nullable()
      .openapi({
        description:
          "The assigned agent's work, from its runs: live (running, waiting) or stalled (in progress, no run alive).",
      }),
    blocked: z.object({ reason: z.string(), since: z.string(), text: z.string().optional() }).nullable().openapi({
      description: "Background work stopped on something (ADR 0121): a badge, the card stays in its stage.",
    }),
    backgroundWork: WorkView.nullable().openapi({
      description: "The agent's background work this card tracks: its plan, last update and line (ADR 0121).",
    }),
    conversation: Conversation.nullable().openapi({
      description: "Its conversation (ADR 0145), once opened or written: a thread the chat's routes read and post to.",
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Issue");

const IssueDetail = Issue.extend({
  subIssues: z.array(
    z.object({ id: z.uuid(), number: z.number(), title: z.string(), status: Status, assignee: Actor.nullable() }),
  ),
}).openapi("IssueDetail");

const Activity = z
  .object({
    id: z.uuid(),
    kind: z.enum(["comment", "event"]),
    author: Actor,
    text: z.string(),
    event: z.string().optional(),
    textCode: z.string().optional(),
    textParams: z.record(z.string(), z.string()).optional(),
    auto: z.boolean().optional().openapi({ description: "The system moved it on its own (runs and PRs)." }),
    attachments: z.array(z.object({ id: z.uuid(), title: z.string() })).optional(),
    createdAt: z.string(),
  })
  .openapi("IssueActivity");

const IssueParams = OrgParams.extend({ issueId: z.uuid() });

const Column = z
  .object({
    id: z.uuid(),
    stage: Status,
    name: z.string().nullable().openapi({ description: "Null: the stage's own name, in the reader's language." }),
    position: z.number(),
  })
  .openapi("IssueColumn");
const Columns = z.object({
  columns: z.array(Column).openapi({ description: "Board order: by stage, then position." }),
});
const ColumnParams = OrgParams.extend({ columnId: z.uuid() });

/** Native issues: numbers per org, acceptance criteria, activity, "ask an agent to implement". */
export function issueRoutes(deps: AppDeps) {
  const { db, adapters } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const issues: IssueDeps = { db, pubsub: adapters.pubsub };
  const person = (userId: string) => ({ type: "person" as const, userId });

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issues",
      tags,
      security,
      summary: "Issues you can see, open ones first",
      request: {
        params: OrgParams,
        query: z.object({
          q: z.string().max(200).optional(),
          status: Status.optional(),
          parentIssueId: z.uuid().optional(),
        }),
      },
      responses: { 200: json(z.object({ issues: z.array(Issue) })), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const query = c.req.valid("query");
      const list = await listIssues(db, person(c.get("user").id), orgId, {
        q: query.q,
        status: query.status,
        parentIssueId: query.parentIssueId,
      });
      return c.json({ issues: list }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issues/by-number/{number}",
      tags,
      security,
      summary: "An issue by its number (#131)",
      request: { params: OrgParams.extend({ number: z.coerce.number().int().min(1) }) },
      responses: { 200: json(IssueDetail), ...errors },
    }),
    async (c) => {
      const { orgId, number } = c.req.valid("param");
      return c.json(await getIssueDetail(db, person(c.get("user").id), orgId, { number }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issues/{issueId}",
      tags,
      security,
      summary: "An issue, with its sub-issues",
      request: { params: IssueParams },
      responses: { 200: json(IssueDetail), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      return c.json(await getIssueDetail(db, person(c.get("user").id), orgId, { id: issueId }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issues",
      tags,
      security,
      summary: "Create an issue",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            title: z.string().min(1).max(300),
            description: z.string().max(50_000).optional(),
            criteria: z.array(z.string().max(500)).max(50).optional(),
            assignee: Actor.nullable().optional(),
            priority: Priority.optional(),
            dueDate: DueDate.optional(),
            labels: z.array(z.string().max(40)).max(20).optional(),
            githubUrl: GithubUrl.optional(),
            parentIssueId: z.uuid().nullable().optional(),
            attachmentIds: z
              .array(z.uuid())
              .max(10)
              .optional()
              .openapi({ description: "Drive files uploaded from the new-issue box (linked to the issue)." }),
            audience: AudienceChoice.optional().openapi({
              description: "Who sees it. A sub-issue follows its parent. Left out: the whole workspace.",
            }),
          }),
        ),
      },
      responses: { 201: json(Issue, "Created"), ...errors },
    }),
    async (c) => {
      const created = await createIssue(
        issues,
        person(c.get("user").id),
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(created, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/issues/{issueId}",
      tags,
      security,
      summary: "Change an issue (each change goes to its activity)",
      request: {
        params: IssueParams,
        body: body(
          z.object({
            title: z.string().min(1).max(300).optional(),
            description: z.string().max(50_000).optional(),
            status: Status.optional(),
            columnId: z
              .uuid()
              .optional()
              .openapi({ description: "Move to a board column; the issue takes that column's stage." }),
            boardRank: z.number().optional().openapi({ description: "Its order inside the column (lowest first)." }),
            priority: Priority.optional(),
            assignee: Actor.nullable().optional(),
            dueDate: DueDate.optional(),
            labels: z.array(z.string().max(40)).max(20).optional(),
            githubUrl: GithubUrl.optional(),
            criteria: z
              .array(z.object({ id: z.string().optional(), text: z.string().max(500) }))
              .max(50)
              .optional()
              .openapi({
                description:
                  "The whole list of acceptance criteria, in order: an `id` keeps that criterion (and its check), one without is new, one left out is removed.",
              }),
          }),
        ),
      },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      return c.json(await updateIssue(issues, person(c.get("user").id), orgId, issueId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/issues/{issueId}",
      tags,
      security,
      summary: "Delete a task for good (who created it, an administrator; on an agent's task, whoever may assign work)",
      description:
        "Its steps and its conversation go with it, and what an agent is doing on it stops. The audit log keeps who deleted it and its title; its number isn't given again.",
      request: { params: IssueParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      await deleteIssue(
        { db, pubsub: adapters.pubsub, hub: deps.extras?.sandbox?.machines?.hub ?? null, mail: adapters.mail },
        c.get("user").id,
        orgId,
        issueId,
      );
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issue-columns",
      tags,
      security,
      summary: "The board's columns, each in a fixed stage",
      request: { params: OrgParams },
      responses: { 200: json(Columns), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ columns: await listIssueColumns(db, c.get("user").id, orgId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issue-columns",
      tags,
      security,
      summary: "Add a column to a stage (after `afterId` when it is in the same stage, else at the stage's end)",
      request: {
        params: OrgParams,
        body: body(
          z.object({ name: z.string().min(1).max(40), stage: Status, afterId: z.uuid().nullable().optional() }),
        ),
      },
      responses: { 201: json(Columns, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      return c.json({ columns: await createIssueColumn(issues, c.get("user").id, orgId, c.req.valid("json")) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/issue-columns/{columnId}",
      tags,
      security,
      summary: "Rename a column, or move it inside its stage (`index`)",
      request: {
        params: ColumnParams,
        body: body(z.object({ name: z.string().min(1).max(40).optional(), index: z.number().int().min(0).optional() })),
      },
      responses: { 200: json(Columns), ...errors },
    }),
    async (c) => {
      const { orgId, columnId } = c.req.valid("param");
      const columns = await updateIssueColumn(issues, c.get("user").id, orgId, columnId, c.req.valid("json"));
      return c.json({ columns }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/issue-columns/{columnId}",
      tags,
      security,
      summary: "Delete a column; its issues go to `moveTo` (a stage keeps at least one column)",
      request: { params: ColumnParams, query: z.object({ moveTo: z.uuid() }) },
      responses: { 200: json(Columns), ...errors },
    }),
    async (c) => {
      const { orgId, columnId } = c.req.valid("param");
      const { moveTo } = c.req.valid("query");
      return c.json({ columns: await deleteIssueColumn(issues, c.get("user").id, orgId, columnId, moveTo) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/issues/{issueId}/criteria/{criterionId}",
      tags,
      security,
      summary: "Check or uncheck an acceptance criterion",
      request: {
        params: IssueParams.extend({ criterionId: z.string() }),
        body: body(z.object({ done: z.boolean() })),
      },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId, criterionId } = c.req.valid("param");
      const issue = await setCriterion(
        issues,
        person(c.get("user").id),
        orgId,
        issueId,
        criterionId,
        c.req.valid("json").done,
      );
      return c.json(issue, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issues/{issueId}/share",
      tags,
      security,
      summary: "Show a card to the whole workspace (Mostrar para todos)",
      description: "`PUT …/audience` with `everyone`, for apps from before it.",
      request: { params: IssueParams },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      const everyone = { mode: "everyone" as const };
      return c.json(await setIssueAudience(issues, person(c.get("user").id), orgId, issueId, everyone), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/issues/{issueId}/audience",
      tags,
      security,
      summary: "Change who sees a task",
      description:
        "Anyone who sees the task. Limited, its sub-issues go with it; to everyone, they stay as they are. Whoever changes it stays in the list unless they're an administrator, and so does a person assigned to it. `issue.audience_empty`: nobody chosen.",
      request: { params: IssueParams, body: body(AudienceChoice) },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      const audience = c.req.valid("json");
      return c.json(await setIssueAudience(issues, person(c.get("user").id), orgId, issueId, audience), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/issues/{issueId}/activity",
      tags,
      security,
      summary: "Comments and events, oldest first",
      request: { params: IssueParams },
      responses: { 200: json(z.object({ activity: z.array(Activity) })), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      return c.json({ activity: await listIssueActivity(db, person(c.get("user").id), orgId, issueId) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issues/{issueId}/conversation",
      tags,
      security,
      summary: "Open the task's conversation (made on first use): its channel and thread root, for the chat's routes",
      request: { params: IssueParams },
      responses: { 200: json(ConversationRef), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      return c.json(await openTaskConversation(db, person(c.get("user").id), orgId, issueId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issues/{issueId}/comments",
      tags,
      security,
      summary: "Comment on an issue: a reply in its conversation, as the chat's send",
      request: {
        params: IssueParams,
        body: body(
          z.object({
            text: z.string().max(20_000),
            attachmentIds: z
              .array(z.uuid())
              .max(10)
              .optional()
              .openapi({ description: "Drive files uploaded from the comment box (also linked to the issue)." }),
          }),
        ),
      },
      responses: { 201: json(Activity, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      const { text, attachmentIds } = c.req.valid("json");
      const comment = await commentIssue(issues, person(c.get("user").id), orgId, issueId, text, { attachmentIds });
      return c.json(comment, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/issues/{issueId}/ask-agent",
      tags,
      security,
      summary: '"Ask Ada to implement": assigns the agent and starts its work in the task\'s conversation',
      request: { params: IssueParams, body: body(z.object({ agentId: z.uuid() })) },
      responses: { 200: json(Issue), ...errors },
    }),
    async (c) => {
      const { orgId, issueId } = c.req.valid("param");
      const issue = await askAgentToImplement(issues, c.get("user").id, orgId, issueId, c.req.valid("json").agentId);
      deps.wakeWorkers?.();
      return c.json(issue, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/messages/{messageId}/issue",
      tags,
      security,
      summary: '"Transformar em issue": a message becomes an issue',
      request: {
        params: OrgParams.extend({ messageId: z.uuid() }),
        body: body(z.object({ title: z.string().max(300).optional() })),
      },
      responses: { 201: json(Issue, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, messageId } = c.req.valid("param");
      return c.json(await issueFromMessage(issues, c.get("user").id, orgId, messageId, c.req.valid("json")), 201);
    },
  );

  return app;
}
