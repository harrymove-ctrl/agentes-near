import {
  type CalendarDeps,
  calendarRange,
  confirmCalendarProposal,
  createCalendarEvent,
  deleteCalendarEvent,
  dismissCalendarProposal,
  respondToEvent,
  updateCalendarEvent,
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

const tags = ["Calendar"];
const Actor = z.object({ type: z.enum(["person", "agent"]), id: z.string() });
const Recurrence = z.enum(["none", "weekdays", "weekly", "monthly", "custom"]);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A series rule: dates and time come from the event (RRULE-like). */
export const EventRule = z
  .object({
    freq: z.enum(["once", "daily", "weekly", "monthly", "yearly"]).openapi({ description: "`once` = doesn't repeat." }),
    interval: z.number().int().min(1).max(1000).optional(),
    byWeekday: z
      .array(z.string().regex(/^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/))
      .max(14)
      .optional()
      .openapi({
        description: '"MO"…"SU"; monthly/yearly may carry a position: "2TU" (2nd Tuesday), "-1FR" (last Friday).',
      }),
    byMonthDay: z.array(z.number().int().min(-31).max(31)).max(31).optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    bySetPos: z
      .union([z.number().int().min(-31).max(31), z.array(z.number().int().min(-31).max(31)).max(10)])
      .optional(),
    until: Day.nullable().optional().openapi({ description: "Last day, inclusive." }),
    count: z.number().int().min(1).max(10_000).nullable().optional(),
    times: z.array(z.string()).max(24).optional().openapi({ description: "Ignored: the event's start sets the time." }),
    timezone: z.string().max(64).optional().openapi({ description: "Ignored: the event's zone." }),
    start: Day.optional().openapi({ description: "Ignored: the event's first day." }),
  })
  .openapi("EventRule");
/** A series rule as returned: complete, with the event's zone, first day and time. */
const FullRule = EventRule.extend({
  freq: z.enum(["hourly", "daily", "weekly", "monthly", "yearly"]),
  times: z.array(z.string()).optional().openapi({ description: "The event's local time." }),
  timezone: z.string().optional().openapi({ description: "The event's zone." }),
  start: Day.optional().openapi({ description: "The series' first day." }),
  time: z.string().optional(),
}).openapi("EventSeriesRule");
const Scope = z.enum(["this", "following", "all"]).openapi({
  description: "Repeating events: only this occurrence, this and the next ones, or the whole series.",
});
const CalendarEvent = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string(),
    start: z.string(),
    end: z.string(),
    allDay: z.boolean(),
    startDate: Day.nullable().openapi({ description: "All-day events: first local day." }),
    endDate: Day.nullable().openapi({ description: "All-day events: last local day (inclusive)." }),
    timezone: z.string(),
    recurrence: Recurrence,
    rule: FullRule.nullable(),
    location: z.string().nullable(),
    exdates: z.array(Day).openapi({ description: "Days left out of the series." }),
    seriesId: z.uuid(),
    occurrenceStart: z
      .string()
      .nullable()
      .openapi({ description: "Occurrences of a series: send it back to edit or delete this one / the next ones." }),
    participants: z.array(Actor),
    rsvp: z.array(Actor.extend({ status: z.enum(["needs_action", "accepted", "declined"]) })),
    channelId: z.uuid().nullable(),
    issueId: z.uuid().nullable(),
    createdBy: Actor,
  })
  .openapi("CalendarEvent");
const Proposal = z
  .object({
    id: z.uuid(),
    agentId: z.uuid(),
    requesterUserId: z.string(),
    title: z.string(),
    start: z.string(),
    end: z.string(),
    participants: z.array(Actor),
    note: z.string().nullable(),
    status: z.enum(["pending", "confirmed", "dismissed"]),
    rule: EventRule.nullable(),
  })
  .openapi("CalendarProposal");

/** The native calendar: events, agents' proposals (confirmed by a person), and a range view with routines and deadlines. */
export function calendarRoutes(deps: AppDeps) {
  const { db, adapters, config } = deps;
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const calendar: CalendarDeps = { db, pubsub: adapters.pubsub, publicUrl: config.PUBLIC_URL };

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/calendar",
      tags,
      security,
      summary: "Events, routine runs, reminders, issue deadlines and my pending proposals between from and to",
      request: { params: OrgParams, query: z.object({ from: z.string(), to: z.string() }) },
      responses: {
        200: json(
          z.object({
            events: z.array(CalendarEvent),
            routines: z.array(
              z.object({
                routineId: z.uuid(),
                name: z.string(),
                agentId: z.uuid(),
                at: z.string(),
                target: z.unknown(),
              }),
            ),
            reminders: z.array(
              z.object({
                id: z.uuid(),
                message: z.string(),
                at: z.string(),
                forUserId: z.string(),
                channelId: z.uuid(),
                threadId: z.uuid().nullable(),
                agentId: z.uuid(),
                createdBy: z.string().nullable().openapi({ description: "The person who set it." }),
                canCancel: z.boolean().openapi({ description: "Only who set it can (`DELETE /reminders/{id}`)." }),
              }),
            ),
            deadlines: z.array(
              z.object({
                issueId: z.uuid(),
                number: z.number(),
                title: z.string(),
                date: z.string(),
                assignee: Actor.nullable().openapi({ description: "Who has the task; null: nobody." }),
              }),
            ),
            proposals: z.array(Proposal),
          }),
        ),
        ...errors,
      },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { from, to } = c.req.valid("query");
      return c.json(await calendarRange(calendar, c.get("user").id, orgId, from, to), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/calendar/events",
      tags,
      security,
      summary: "Create an event and invite the participants",
      request: {
        params: OrgParams,
        body: body(
          z.object({
            title: z.string().min(1).max(200),
            description: z.string().max(10_000).optional(),
            start: z.string().optional(),
            end: z.string().optional(),
            allDay: z.boolean().optional(),
            startDate: Day.optional(),
            endDate: Day.optional(),
            timezone: z.string().max(64).optional(),
            recurrence: Recurrence.optional(),
            rule: EventRule.nullable().optional(),
            location: z.string().max(300).nullable().optional(),
            participants: z.array(Actor).max(100),
            channelId: z.uuid().nullable().optional(),
            issueId: z.uuid().nullable().optional(),
          }),
        ),
      },
      responses: { 201: json(CalendarEvent, "Created"), ...errors },
    }),
    async (c) => {
      const created = await createCalendarEvent(
        calendar,
        c.get("user").id,
        c.req.valid("param").orgId,
        c.req.valid("json"),
      );
      return c.json(created, 201);
    },
  );

  const EventParams = OrgParams.extend({ eventId: z.uuid() });
  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/calendar/events/{eventId}",
      tags,
      security,
      summary: "Edit an event (its creator or admins); repeating ones: only this, this and the next ones, or all",
      request: {
        params: EventParams,
        body: body(
          z.object({
            scope: Scope.optional(),
            occurrenceStart: z.string().optional(),
            title: z.string().min(1).max(200).optional(),
            description: z.string().max(10_000).optional(),
            start: z.string().optional(),
            end: z.string().optional(),
            allDay: z.boolean().optional(),
            startDate: Day.optional(),
            endDate: Day.optional(),
            timezone: z.string().max(64).optional(),
            recurrence: Recurrence.optional(),
            rule: EventRule.nullable().optional(),
            location: z.string().max(300).nullable().optional(),
          }),
        ),
      },
      responses: { 200: json(CalendarEvent), ...errors },
    }),
    async (c) => {
      const { orgId, eventId } = c.req.valid("param");
      return c.json(await updateCalendarEvent(calendar, c.get("user").id, orgId, eventId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/calendar/events/{eventId}",
      tags,
      security,
      summary: "Delete an event; repeating ones: only this, this and the next ones, or all",
      request: {
        params: EventParams,
        query: z.object({ scope: Scope.optional(), occurrenceStart: z.string().optional() }),
      },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, eventId } = c.req.valid("param");
      await deleteCalendarEvent(calendar, c.get("user").id, orgId, eventId, c.req.valid("query"));
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/calendar/events/{eventId}/rsvp",
      tags,
      security,
      summary: "Accept or decline an invitation",
      request: {
        params: OrgParams.extend({ eventId: z.uuid() }),
        body: body(z.object({ status: z.enum(["accepted", "declined"]) })),
      },
      responses: { 200: json(CalendarEvent), ...errors },
    }),
    async (c) => {
      const { orgId, eventId } = c.req.valid("param");
      return c.json(await respondToEvent(calendar, c.get("user").id, orgId, eventId, c.req.valid("json").status), 200);
    },
  );

  const ProposalParams = OrgParams.extend({ proposalId: z.uuid() });
  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/calendar/proposals/{proposalId}/confirm",
      tags,
      security,
      summary: "Confirm an agent's proposal: creates the event and invites the people",
      request: { params: ProposalParams },
      responses: { 200: json(CalendarEvent), ...errors },
    }),
    async (c) => {
      const { orgId, proposalId } = c.req.valid("param");
      return c.json(await confirmCalendarProposal(calendar, c.get("user").id, orgId, proposalId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/calendar/proposals/{proposalId}/dismiss",
      tags,
      security,
      summary: "Dismiss an agent's proposal",
      request: { params: ProposalParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, proposalId } = c.req.valid("param");
      await dismissCalendarProposal(calendar, c.get("user").id, orgId, proposalId);
      return c.body(null, 204);
    },
  );

  return app;
}
