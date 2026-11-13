import { eq, schema } from "@agenteschat/db";
import {
  agentEvents,
  type CalendarDeps,
  type EventRule,
  findFreeTime,
  proposeCalendarEvent,
  resolveParticipants,
} from "./calendar";
import { agentSearchChannels } from "./search";
import type { ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const failed = (error: unknown): ToolOutput => ({
  content: `Failed: ${error instanceof Error ? error.message : String(error)}`,
  isError: true,
});
const handles = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

/** The org's time zone, read as the org itself (no person involved). */
async function orgTimezone(deps: CalendarDeps, orgId: string) {
  const settings = schema.organizationSettings;
  const [row] = await deps.db.select({ tz: settings.timezone }).from(settings).where(eq(settings.orgId, orgId));
  return row?.tz ?? "UTC";
}

/**
 * Calendar tools through the Tool Gateway: `list_events` and
 * `find_free_time` (`calendar:read`), `propose_event` (`calendar:write`).
 * Agents never create events for people: a proposal is a card the person
 * who asked confirms.
 */
export function createCalendarToolSource(deps: CalendarDeps): ToolSource {
  const tools: ToolDefinition[] = [
    {
      name: "list_events",
      description: "List calendar events you attend or that belong to channels you're in, for the next days.",
      scope: "calendar:read",
      inputSchema: {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 60 } },
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const days = typeof input.days === "number" ? input.days : 7;
          const from = new Date();
          const to = new Date(from.getTime() + days * 86_400_000);
          const channels = await agentSearchChannels(ctx.db, ctx.orgId, ctx.agentId, ctx.channelId);
          const events = await agentEvents(ctx.db, ctx.orgId, ctx.agentId, channels, from, to);
          if (events.length === 0) return { content: "No events." };
          return {
            content: events
              .sort((a, b) => a.start.localeCompare(b.start))
              .map((e) => `${e.start} → ${e.end} ${e.title} (${e.participants.length} participants) id=${e.id}`)
              .join("\n"),
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "find_free_time",
      description:
        "Find free slots (weekdays, 9:00 to 18:00 in the workspace time zone) when all the given people and agents are free.",
      scope: "calendar:read",
      inputSchema: {
        type: "object",
        properties: {
          participants: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 20,
            description: "@handles",
          },
          duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
          days: { type: "integer", minimum: 1, maximum: 30 },
        },
        required: ["participants", "duration_minutes"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const who = await resolveParticipants(ctx.db, ctx.orgId, handles(input.participants));
          const timezone = await orgTimezone(deps, ctx.orgId);
          const slots = await findFreeTime(ctx.db, ctx.orgId, who, {
            durationMinutes: Number(input.duration_minutes),
            from: new Date(),
            days: typeof input.days === "number" ? input.days : 7,
            timezone,
          });
          if (slots.length === 0) return { content: "No common free slot in that period." };
          return {
            content: `Free for everyone (${timezone}):\n${slots.map((s) => `${s.start} → ${s.end}`).join("\n")}`,
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
    {
      name: "propose_event",
      description:
        "Propose an event to the person who asked. Nothing is created until they confirm the card; never claim the event exists before that.",
      scope: "calendar:write",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 5000 },
          start: { type: "string", description: "ISO 8601 with offset" },
          end: { type: "string", description: "ISO 8601 with offset" },
          participants: { type: "array", items: { type: "string" }, maxItems: 30, description: "@handles" },
          note: { type: "string", maxLength: 300 },
          recurrence: {
            type: "object",
            description:
              'Only if it repeats. E.g. {"freq":"weekly","byWeekday":["MO","WE"]}, {"freq":"weekly","interval":2}, {"freq":"monthly","byWeekday":["2TU"]}, {"freq":"daily","until":"2026-12-31"}. Time and start come from `start`.',
            properties: {
              freq: { enum: ["daily", "weekly", "monthly", "yearly"] },
              interval: { type: "integer", minimum: 1, maximum: 52 },
              byWeekday: { type: "array", items: { type: "string", maxLength: 4 }, maxItems: 7 },
              byMonthDay: { type: "array", items: { type: "integer", minimum: -31, maximum: 31 }, maxItems: 31 },
              byMonth: { type: "array", items: { type: "integer", minimum: 1, maximum: 12 }, maxItems: 12 },
              bySetPos: { type: "array", items: { type: "integer", minimum: -31, maximum: 31 }, maxItems: 5 },
              until: { type: "string", description: "YYYY-MM-DD" },
              count: { type: "integer", minimum: 1, maximum: 1000 },
            },
            required: ["freq"],
            additionalProperties: false,
          },
        },
        required: ["title", "start", "end"],
        additionalProperties: false,
      },
      async execute(input, ctx) {
        try {
          const participants = await resolveParticipants(ctx.db, ctx.orgId, handles(input.participants));
          const p = await proposeCalendarEvent(deps, ctx, {
            title: str(input.title),
            description: str(input.description),
            start: str(input.start),
            end: str(input.end),
            participants,
            note: str(input.note) || undefined,
            recurrence: (input.recurrence as EventRule | undefined) ?? null,
          });
          return {
            content: `Proposed "${p.title}" (${p.start} → ${p.end}). It waits for the person's confirmation.`,
            data: { calendarProposal: { id: p.id } },
          };
        } catch (error) {
          return failed(error);
        }
      },
    },
  ];
  return { name: "calendar", tools: async () => tools };
}
