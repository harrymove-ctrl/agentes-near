import { listOperatorEvents, OPERATOR_EVENTS_PAGE_MAX, operatorReview, REVIEW_MAX_BYTES } from "@agenteschat/engine";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { apiError, errorResponse } from "../http/errors";
import { json } from "../routes/app/context";
import type { OperatorDeps } from "./app";

const tags = ["Operator"];
const errors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Missing or wrong token"),
  404: errorResponse("Not found"),
};

const Event = z
  .object({
    id: z.uuid(),
    at: z.string(),
    type: z.string().openapi({
      description:
        "`user.signed_up`, `session.created`, `user.deletion_requested`, `user.deletion_canceled`, `user.deleted`, `organization.created`, `organization.deletion_requested`, `organization.deletion_canceled`, `organization.deleted`, `invitation.created`, `agent.created`, `agent.deleted`, `mail.sent`, `run.finished`, `run.hop_limit`, `task.finished`, `desktop_control.ended`, `content.viewed`, `platform_ai.threshold` or `account.failure` (ADR 0056 §5 lists each one's `data`). Ignore types you don't know: new ones keep v1.",
    }),
    orgId: z.uuid().nullable(),
    userId: z.string().nullable().openapi({ description: "The person the event is about or who acted." }),
    data: z.record(z.string(), z.unknown()),
  })
  .openapi("OperatorEvent");

const EventPage = z
  .object({
    events: z.array(Event),
    next: z.string().nullable().openapi({
      description: "`after` for the next call; the same value when there was nothing new, null only before any event.",
    }),
  })
  .openapi("OperatorEventPage");

const EventQuery = z.object({
  after: z.string().max(200).optional().openapi({
    description:
      "`next` of the previous page; absent: from the oldest event kept (90 days). One from before the database was restored from a dump is refused (400 `stale_cursor`): start again without it and skip the event ids you already have.",
  }),
  limit: z.coerce.number().int().min(1).max(OPERATOR_EVENTS_PAGE_MAX).default(100),
});

const REVIEW_KINDS = ["run", "task", "session"] as const;

const Review = z
  .object({
    kind: z.enum(REVIEW_KINDS),
    id: z.uuid(),
    orgId: z.uuid(),
    agentId: z.uuid(),
    text: z.string().openapi({ description: `At most ${REVIEW_MAX_BYTES} bytes of UTF-8.` }),
  })
  .openapi("OperatorReview");

const ReviewParams = z.object({
  kind: z.enum(REVIEW_KINDS).openapi({ param: { name: "kind", in: "path" } }),
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});

const ReviewQuery = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .openapi({ description: "Why it is read (a sample, a report, a case): kept in the `content.viewed` event." }),
  operator: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .openapi({ description: "Who reads it: an operator, or the service that samples." }),
});

export function registerOperatorEvents(api: OpenAPIHono, { db, sessions }: OperatorDeps) {
  api.openapi(
    createRoute({
      method: "get",
      path: "/events",
      tags,
      summary: "What happened on this instance, oldest first, as metadata",
      description:
        "Recorded only while the operator API is on, and kept 90 days. Paging never skips an event: one is served only once its transaction, and every transaction that began before it, has ended.",
      request: { query: EventQuery },
      responses: { 200: json(EventPage), 400: errors[400], 401: errors[401] },
    }),
    async (c) => {
      const page = await listOperatorEvents(db, c.req.valid("query"));
      return c.json({ ...page, events: page.events.map((e) => ({ ...e, at: e.at.toISOString() })) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/review/{kind}/{id}",
      tags,
      summary: "What one run, task or screened session did, as one redacted text block",
      description:
        "The only content this API gives: the request, the tool calls with their results, the reply (a run), the prompt, command and output (a task), or the text a person in control of an agent's screen had on it (a session of `desktop_control.ended`, on a server with `SESSION_SCREENING`: from memory only, until 10 minutes after the segment ended, then 404). Credentials are masked and workspace text is inside `<external_data>` blocks. Every read is recorded as a `content.viewed` event first.",
      request: { params: ReviewParams, query: ReviewQuery },
      responses: { 200: json(Review), ...errors },
    }),
    async (c) => {
      const { kind, id } = c.req.valid("param");
      const review = await operatorReview(db, kind, id, c.req.valid("query"), sessions);
      if (!review) return apiError(c, 404, "not_found", `No ${kind} with this id`);
      return c.json(review, 200);
    },
  );
}
