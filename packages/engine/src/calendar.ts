import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, gte, inArray, isNull, lte, or, schema, sql } from "@agenteschat/db";
import { localeInfo } from "@agenteschat/i18n/locale";
import { currentHandles, getAgent } from "./agents";
import { zonedParts, zonedTime } from "./cron";
import { type EmailLocale, emailLocale, modeStamp, queueEmail } from "./email";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishListChanged, publishMessageCreated, publishUserEvent } from "./events";
import { getOrgSettings } from "./management";
import { insertMessage, messageView } from "./messages";
import { can, requireActiveMembership, requirePermission } from "./organizations";
import { calendarReminders, routineSeer, routineSlots } from "./routines";
import { endRuleBefore, localDate, normalizeRule, ruleOccurrences, type ScheduleRule } from "./rrule";
import { bodyCode } from "./run-tools";
import { replyThreadOf } from "./runs";
import { userVisibleChannels } from "./search";
import { closedRefusal } from "./standing";
import { taskSeenSql } from "./task-access";

const {
  calendarEvents,
  calendarAttendees,
  calendarProposals,
  channelMembers,
  issues,
  routines,
  organizationMembers,
  agents,
  users,
  organizations,
} = schema;

/** Legacy presets; `custom` = a rule they can't say (see `rule`). */
export type Recurrence = "none" | "weekdays" | "weekly" | "monthly" | "custom";
export const RECURRENCES: readonly Recurrence[] = ["none", "weekdays", "weekly", "monthly", "custom"];
export interface CalendarActor {
  type: "person" | "agent";
  id: string;
}

export interface CalendarEventView {
  id: string;
  title: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  /** Days left out of the series (local "YYYY-MM-DD"). */
  exdates: string[];
  /** All-day events: the local days, inclusive ("YYYY-MM-DD"). */
  startDate: string | null;
  endDate: string | null;
  timezone: string;
  recurrence: Recurrence;
  /** The series rule, complete (with the event's zone, first day and time); null = doesn't repeat. */
  rule: ScheduleRule | null;
  /** The series this occurrence belongs to (its own id, or the series of an edited occurrence). */
  seriesId: string;
  /** For occurrences of a series: the occurrence's original start (use it for "only this one" / "this and following"). */
  occurrenceStart: string | null;
  participants: CalendarActor[];
  /** RSVP of each person attending. */
  rsvp: { type: "person" | "agent"; id: string; status: "needs_action" | "accepted" | "declined" }[];
  channelId: string | null;
  issueId: string | null;
  createdBy: CalendarActor;
}

export interface CalendarProposalView {
  id: string;
  agentId: string;
  /** Who asked: they confirm it, or who configures the workspace. */
  requesterUserId: string;
  title: string;
  start: string;
  end: string;
  participants: CalendarActor[];
  note: string | null;
  status: "pending" | "confirmed" | "dismissed";
  /** A repeating proposal. */
  rule: EventRule | null;
}

/** A series rule for events: the `ScheduleRule` fields without times, zone or start (they come from the event). */
export type EventRule = Omit<ScheduleRule, "time" | "times" | "timezone" | "start" | "freq"> & {
  /** `once` = doesn't repeat (the picker's "Doesn't repeat"). */
  freq: "once" | "daily" | "weekly" | "monthly" | "yearly";
  /** Accepted and ignored: an event's times, zone and first day are its own. */
  times?: string[];
  timezone?: string;
  start?: string;
};

export interface CalendarEventInput {
  title: string;
  description?: string;
  /** Timed events: instants (ISO 8601). All-day events may give `startDate`/`endDate` instead. */
  start?: string;
  end?: string;
  allDay?: boolean;
  /** All-day: first and last local day, inclusive ("YYYY-MM-DD"); several days for a multi-day event. */
  startDate?: string;
  endDate?: string;
  timezone?: string;
  /** A preset (legacy) or a full `rule`; the rule wins. */
  recurrence?: Recurrence;
  rule?: EventRule | null;
  location?: string | null;
  participants: CalendarActor[];
  channelId?: string | null;
  issueId?: string | null;
}

export interface CalendarDeps {
  db: Database;
  pubsub?: PubSub;
  publicUrl?: string;
}

type EventRow = typeof calendarEvents.$inferSelect;
type ProposalRow = typeof calendarProposals.$inferSelect;

const RRULES: Record<Recurrence, string | null> = {
  none: null,
  custom: null,
  weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
};

const MAX_OCCURRENCES = 400;

const LEGACY_RULES: Record<string, EventRule> = {
  weekdays: { freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"] },
  weekly: { freq: "weekly" },
  monthly: { freq: "monthly" },
};

type SeriesFields = Pick<EventRow, "startAt" | "endAt" | "recurrence" | "timezone"> &
  Partial<Pick<EventRow, "rule" | "exdates">>;

/** The stored rule of an event (or its legacy preset), or null when it doesn't repeat. */
export function storedRule(e: Pick<EventRow, "recurrence"> & Partial<Pick<EventRow, "rule">>): EventRule | null {
  if (e.rule) return e.rule as unknown as EventRule;
  return LEGACY_RULES[e.recurrence] ?? null;
}

/** The full rule of a series: its stored rule with the event's zone, first day and wall-clock time. */
export function eventRule(e: SeriesFields): ScheduleRule | null {
  const rule = storedRule(e);
  if (!rule || rule.freq === "once") return null;
  const tz = e.timezone || "UTC";
  const p = zonedParts(e.startAt, tz);
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return normalizeRule(
    { ...rule, freq: rule.freq, timezone: tz, start: localDate(e.startAt, tz), times: [time] },
    e.startAt,
  );
}

/** The legacy preset a rule equals, else `custom`. */
function presetOf(rule: EventRule | null): Recurrence {
  if (!rule) return "none";
  const { times: _t, timezone: _z, start: _s, ...own } = rule;
  const plain = JSON.stringify({ ...own, interval: own.interval ?? 1 });
  for (const [name, preset] of Object.entries(LEGACY_RULES)) {
    if (plain === JSON.stringify({ ...preset, interval: 1 })) return name as Recurrence;
  }
  return "custom";
}

/**
 * Occurrences of an event between `from` and `to`, keeping its wall-clock
 * time in its time zone (so a 9:00 meeting stays at 9:00 across DST).
 * Removed occurrences (`exdates`) are skipped; `occurrenceStart` is each one's original start.
 */
export function occurrences(e: SeriesFields, from: Date, to: Date) {
  const duration = e.endAt.getTime() - e.startAt.getTime();
  const overlaps = (start: Date) => start.getTime() < to.getTime() && start.getTime() + duration > from.getTime();
  const rule = eventRule(e);
  if (!rule) {
    return overlaps(e.startAt) ? [{ start: e.startAt, end: e.endAt, occurrenceStart: null as string | null }] : [];
  }
  const removed = new Set((e.exdates ?? []).map((d) => new Date(d).toISOString()));
  return ruleOccurrences(rule, new Date(from.getTime() - duration), to, MAX_OCCURRENCES)
    .filter((start) => overlaps(start) && !removed.has(start.toISOString()))
    .map((start) => ({
      start,
      end: new Date(start.getTime() + duration),
      occurrenceStart: start.toISOString() as string | null,
    }));
}

/** Expands rows (series, single events and edited occurrences) into what the calendar shows. */
function expand(rows: EventRow[], from: Date, to: Date) {
  const edited = new Set(
    rows.filter((r) => r.overrideOf && r.originalStart).map((r) => `${r.overrideOf}|${r.originalStart?.toISOString()}`),
  );
  return rows.flatMap((r) => {
    if (r.overrideOf) {
      const start = r.startAt;
      if (!(start.getTime() < to.getTime() && r.endAt.getTime() > from.getTime())) return [];
      return [{ row: r, start, end: r.endAt, occurrenceStart: r.originalStart?.toISOString() ?? null }];
    }
    return occurrences(r, from, to)
      .filter((o) => !o.occurrenceStart || !edited.has(`${r.id}|${o.occurrenceStart}`))
      .map((o) => ({ row: r, ...o }));
  });
}

async function attendeesOf(db: Database, eventIds: string[]) {
  if (eventIds.length === 0) return [];
  return db.select().from(calendarAttendees).where(inArray(calendarAttendees.eventId, eventIds));
}

function view(
  e: EventRow,
  attendees: (typeof calendarAttendees.$inferSelect)[],
  occurrence?: { start: Date; end: Date; occurrenceStart?: string | null },
): CalendarEventView {
  const mine = attendees.filter((a) => a.eventId === e.id);
  const start = occurrence?.start ?? e.startAt;
  const end = occurrence?.end ?? e.endAt;
  const rule = e.overrideOf ? null : storedRule(e);
  const full = e.overrideOf ? null : eventRule(e);
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: e.allDay,
    startDate: e.allDay ? localDate(start, e.timezone) : null,
    endDate: e.allDay ? localDate(new Date(end.getTime() - 1), e.timezone) : null,
    timezone: e.timezone,
    recurrence: presetOf(rule),
    rule: full,
    location: e.location ?? null,
    exdates: (e.exdates ?? []).map((d) => localDate(new Date(d), e.timezone)),
    seriesId: e.overrideOf ?? e.id,
    occurrenceStart: occurrence?.occurrenceStart ?? e.originalStart?.toISOString() ?? null,
    participants: mine.map((a) => ({ type: a.attendeeType as CalendarActor["type"], id: a.attendeeId })),
    rsvp: mine.map((a) => ({
      type: a.attendeeType as CalendarActor["type"],
      id: a.attendeeId,
      status: a.status as CalendarEventView["rsvp"][number]["status"],
    })),
    channelId: e.channelId,
    issueId: e.issueId,
    createdBy: { type: e.createdByType as CalendarActor["type"], id: e.createdById },
  };
}

/** Each person and agent once, in the order first named: a list an agent wrote may name someone twice. */
export function uniqueActors(list: CalendarActor[]): CalendarActor[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const key = `${a.type}:${a.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const proposalView = (p: ProposalRow): CalendarProposalView => ({
  id: p.id,
  agentId: p.agentId,
  requesterUserId: p.requesterUserId,
  title: p.title,
  start: p.startAt.toISOString(),
  end: p.endAt.toISOString(),
  // A stored row may still name someone twice: whoever reads it sees each once.
  participants: uniqueActors(p.participants as CalendarActor[]),
  note: p.note,
  status: p.status as CalendarProposalView["status"],
  rule: (p.rule as EventRule | null) ?? null,
});

async function checkParticipants(db: Database, orgId: string, participants: CalendarActor[]) {
  const people = participants.filter((p) => p.type === "person").map((p) => p.id);
  const bots = participants.filter((p) => p.type === "agent").map((p) => p.id);
  if (people.length > 0) {
    const found = await db
      .select({ id: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, people)));
    if (found.length !== new Set(people).size)
      throw new ValidationError("Every participant must be in the organization");
  }
  if (bots.length > 0) {
    const found = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, bots), isNull(agents.archivedAt)));
    if (found.length !== new Set(bots).size) throw new ValidationError("Every agent must be in the organization");
  }
}

/**
 * "Oct 20, 2026 at 9:00 AM GMT-3" / "20 de out. de 2026, 09:00 BRT": in a time zone and the email's language,
 * naming the zone, which may be the event's rather than the reader's.
 */
const formatWhen = (d: Date, timeZone: string, locale: EmailLocale) =>
  new Intl.DateTimeFormat(localeInfo(locale).intl, {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);

/** Tells invited people: in the app, and by email. */
async function notifyInvited(deps: CalendarDeps, e: EventRow, inviterId: string, people: string[]) {
  if (people.length === 0) return;
  const [inviter] = await deps.db.select({ name: users.name }).from(users).where(eq(users.id, inviterId));
  const [org] = await deps.db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, e.orgId));
  const rows = await deps.db
    .select({ id: users.id, email: users.email, locale: users.locale, tz: organizationMembers.timezone })
    .from(users)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.userId, users.id), eq(organizationMembers.orgId, e.orgId)),
    )
    .where(inArray(users.id, people));
  const mode = await modeStamp(deps.db, e.orgId);
  for (const r of rows) {
    const zone = r.tz ?? e.timezone;
    await publishUserEvent(deps.pubsub, e.orgId, r.id, { type: "calendar.invited", eventId: e.id, title: e.title });
    await queueEmail(deps.db, {
      orgId: e.orgId,
      key: `calendar-invite:${e.id}:${r.id}`,
      to: [r.email],
      template: {
        kind: "calendar_invite",
        locale: emailLocale(r.locale),
        orgName: org?.name ?? "",
        inviterName: inviter?.name ?? "",
        title: e.title,
        when: formatWhen(e.startAt, zone, emailLocale(r.locale)),
        // Its day puts the calendar on the event's week, where `open` finds it.
        url: `${(deps.publicUrl ?? "").replace(/\/$/, "")}/org/${e.orgId}/calendar?open=${e.id}&day=${localDate(e.startAt, zone)}`,
        ...mode,
      },
    });
  }
}

function checkZone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ValidationError("timezone must be an IANA time zone");
  }
  return timezone;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayStart = (date: string, timezone: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  // Midnight, or the first valid minute when DST skips it (Brazil used to start DST at 00:00).
  for (let minute = 0; minute <= 120; minute++) {
    const at = zonedTime(y, m, d, Math.floor(minute / 60), minute % 60, timezone);
    if (at) return at;
  }
  throw new ValidationError("Invalid date in this time zone", "calendar.invalid_date");
};
const nextDay = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/**
 * The instants of an event. All-day events span whole local days: from the
 * first day's midnight to the midnight after the last one (multi-day ranges).
 */
export function eventTimes(
  input: Pick<CalendarEventInput, "start" | "end" | "allDay" | "startDate" | "endDate">,
  timezone: string,
): { start: Date; end: Date; allDay: boolean } {
  if (input.allDay) {
    const first = input.startDate ?? (input.start ? localDate(new Date(input.start), timezone) : "");
    const last =
      input.endDate ?? (input.end ? localDate(new Date(new Date(input.end).getTime() - 1), timezone) : first);
    if (!DAY.test(first) || !DAY.test(last)) throw new ValidationError("All-day events need startDate (YYYY-MM-DD)");
    if (last < first) throw new ValidationError("endDate must not be before startDate");
    return { start: dayStart(first, timezone), end: dayStart(nextDay(last), timezone), allDay: true };
  }
  const start = new Date(input.start ?? "");
  const end = new Date(input.end ?? "");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new ValidationError("end must be after start");
  }
  return { start, end, allDay: false };
}

/** A series rule, checked against the event's first occurrence; times and zone are the event's. */
function checkEventRule(rule: EventRule | null, start: Date, timezone: string): EventRule | null {
  if (!rule || rule.freq === "once") return null;
  const { freq, interval, byWeekday, byMonthDay, byMonth, bySetPos, until, count } = rule;
  const clean: EventRule = { freq, ...(interval && interval > 1 ? { interval } : {}) };
  if (byWeekday?.length) clean.byWeekday = byWeekday;
  if (byMonthDay?.length) clean.byMonthDay = byMonthDay;
  if (byMonth?.length) clean.byMonth = byMonth;
  if (typeof bySetPos === "number" || bySetPos?.length) clean.bySetPos = bySetPos;
  if (until) clean.until = until;
  if (count) clean.count = count;
  if (!["daily", "weekly", "monthly", "yearly"].includes(freq))
    throw new ValidationError("Events repeat at most daily.");
  // Validates (throws in pt-BR) with the event's own start.
  normalizeRule({ ...clean, timezone, start: localDate(start, timezone), times: ["00:00"] } as ScheduleRule, start);
  return clean;
}

/** People create events; attendees (people and agents) are invited, the creator has accepted. */
export async function createCalendarEvent(
  deps: CalendarDeps,
  userId: string,
  orgId: string,
  input: CalendarEventInput,
): Promise<CalendarEventView> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "post");
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new ValidationError("title is required");
  const settings = await getOrgSettings(db, userId, orgId);
  const timezone = checkZone(input.timezone ?? settings.timezone);
  const { start, end, allDay } = eventTimes(input, timezone);
  const recurrence = input.recurrence ?? "none";
  if (!RECURRENCES.includes(recurrence)) throw new ValidationError("invalid recurrence");
  const rule = checkEventRule(input.rule ?? LEGACY_RULES[recurrence] ?? null, start, timezone);
  const participants = input.participants.filter((p) => !(p.type === "person" && p.id === userId));
  await checkParticipants(db, orgId, participants);
  if (input.channelId) {
    const [member] = await db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, input.channelId), eq(channelMembers.userId, userId)));
    if (!member) throw new NotFoundError("Channel not found");
  }
  if (input.issueId) {
    const [issue] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.orgId, orgId)));
    if (!issue) throw new NotFoundError("Issue not found");
  }
  const event = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(calendarEvents)
      .values({
        orgId,
        title,
        description: (input.description ?? "").slice(0, 10_000),
        startAt: start,
        endAt: end,
        allDay,
        timezone,
        location: input.location?.trim().slice(0, 300) || null,
        recurrence: rule ? presetOf(rule) : "none",
        rrule: rule ? RRULES[presetOf(rule)] : null,
        rule: rule as Record<string, unknown> | null,
        channelId: input.channelId ?? null,
        issueId: input.issueId ?? null,
        createdByType: "person",
        createdById: userId,
      })
      .returning();
    if (!row) throw new Error("event insert returned nothing");
    const list = uniqueActors([{ type: "person", id: userId }, ...participants]);
    await tx.insert(calendarAttendees).values(
      list.map((p) => ({
        orgId,
        eventId: row.id,
        attendeeType: p.type,
        attendeeId: p.id,
        status: p.type === "person" && p.id === userId ? "accepted" : "needs_action",
        respondedAt: p.type === "person" && p.id === userId ? new Date() : null,
      })),
    );
    return row;
  });
  await notifyInvited(
    deps,
    event,
    userId,
    participants.filter((p) => p.type === "person").map((p) => p.id),
  );
  const result = view(event, await attendeesOf(db, [event.id]));
  if (event.channelId) {
    await publishChannelEvent(deps.pubsub, {
      type: "calendar.event_created",
      channelId: event.channelId,
      event: result,
    });
  }
  await publishListChanged(deps.pubsub, orgId, "calendar");
  return result;
}

export type EditScope = "this" | "following" | "all";

export interface CalendarEventPatch {
  /** For a repeating event: just this occurrence, this and the next ones, or the whole series (default). */
  scope?: EditScope;
  /** The occurrence being edited (its `occurrenceStart`); needed for `this` and `following`. */
  occurrenceStart?: string;
  title?: string;
  description?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  recurrence?: Recurrence;
  rule?: EventRule | null;
  location?: string | null;
}

/** The event's creator or admins change or delete it. */
async function requireEventEditor(db: Database, userId: string, orgId: string, eventId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  const [row] = await db
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.orgId, orgId), isNull(calendarEvents.deletedAt)));
  if (!row) throw new NotFoundError("Event not found");
  const own = row.createdByType === "person" && row.createdById === userId;
  if (!own && !can(membership, "configure"))
    throw new ForbiddenError("Only who created the event (or an admin) can change it");
  return row;
}

async function copyAttendees(tx: Executor, orgId: string, fromId: string, toId: string) {
  const rows = await tx.select().from(calendarAttendees).where(eq(calendarAttendees.eventId, fromId));
  if (rows.length === 0) return;
  await tx
    .insert(calendarAttendees)
    .values(rows.map(({ id: _id, eventId: _e, ...a }) => ({ ...a, orgId, eventId: toId })))
    .onConflictDoNothing();
}

/** The occurrence an "only this one / this and following" refers to, checked against the series. */
function occurrenceOf(series: EventRow, occurrenceStart: string | undefined) {
  if (!occurrenceStart) throw new ValidationError("occurrenceStart is required for this scope");
  const at = new Date(occurrenceStart);
  if (Number.isNaN(at.getTime())) throw new ValidationError("occurrenceStart must be a date-time");
  const found = occurrences(series, at, new Date(at.getTime() + 1)).find((o) => o.occurrenceStart === at.toISOString());
  if (!found) throw new ValidationError("That occurrence isn't part of the series");
  return at;
}

/** Fields of a patch, resolved against what the row has. */
function patched(row: EventRow, patch: CalendarEventPatch, base: { start: Date; end: Date }) {
  const timezone = checkZone(patch.timezone ?? row.timezone);
  const timesGiven =
    patch.start !== undefined || patch.end !== undefined || patch.startDate !== undefined || patch.allDay !== undefined;
  const times = timesGiven
    ? eventTimes(
        {
          allDay: patch.allDay ?? row.allDay,
          start: patch.start ?? base.start.toISOString(),
          end: patch.end ?? base.end.toISOString(),
          startDate: patch.startDate,
          endDate: patch.endDate,
        },
        timezone,
      )
    : { start: base.start, end: base.end, allDay: row.allDay };
  return {
    title: patch.title !== undefined ? patch.title.trim().slice(0, 200) || row.title : row.title,
    location: patch.location !== undefined ? patch.location?.trim().slice(0, 300) || null : row.location,
    description: patch.description !== undefined ? patch.description.slice(0, 10_000) : row.description,
    timezone,
    startAt: times.start,
    endAt: times.end,
    allDay: times.allDay,
  };
}

/**
 * Edits an event. For a repeating one:
 * - `this`: only that occurrence (an edited copy keyed by its original start);
 * - `following`: the series ends the day before, and a new series starts there with the changes
 *   (removed and edited occurrences after that move along);
 * - `all`: the whole series (a time change moves every occurrence).
 */
export async function updateCalendarEvent(
  deps: CalendarDeps,
  userId: string,
  orgId: string,
  eventId: string,
  patch: CalendarEventPatch,
): Promise<CalendarEventView> {
  const { db } = deps;
  const row = await requireEventEditor(db, userId, orgId, eventId);
  const scope = patch.scope ?? "all";
  const repeating = !row.overrideOf && storedRule(row) !== null;
  const result = await db.transaction(async (tx) => {
    // An edited occurrence, or a single event: change it in place.
    if (row.overrideOf || !repeating) {
      const fields = patched(row, patch, { start: row.startAt, end: row.endAt });
      const rule =
        !row.overrideOf && (patch.rule !== undefined || patch.recurrence !== undefined)
          ? checkEventRule(
              patch.rule ?? LEGACY_RULES[patch.recurrence ?? "none"] ?? null,
              fields.startAt,
              fields.timezone,
            )
          : undefined;
      const [updated] = await tx
        .update(calendarEvents)
        .set({
          ...fields,
          ...(rule !== undefined ? { rule: rule as Record<string, unknown> | null, recurrence: presetOf(rule) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, row.id))
        .returning();
      return updated ?? row;
    }
    const duration = row.endAt.getTime() - row.startAt.getTime();
    if (scope === "this") {
      const at = occurrenceOf(row, patch.occurrenceStart);
      const fields = patched(row, patch, { start: at, end: new Date(at.getTime() + duration) });
      const [existing] = await tx
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.overrideOf, row.id),
            eq(calendarEvents.originalStart, at),
            isNull(calendarEvents.deletedAt),
          ),
        );
      if (existing) {
        const [updated] = await tx
          .update(calendarEvents)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(calendarEvents.id, existing.id))
          .returning();
        return updated ?? existing;
      }
      const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = row;
      const [override] = await tx
        .insert(calendarEvents)
        .values({
          ...copy,
          ...fields,
          recurrence: "none",
          rrule: null,
          rule: null,
          exdates: [],
          overrideOf: row.id,
          originalStart: at,
        })
        .returning();
      if (!override) throw new Error("override insert returned nothing");
      await copyAttendees(tx, orgId, row.id, override.id);
      return override;
    }
    if (scope === "following") {
      const at = occurrenceOf(row, patch.occurrenceStart);
      const first = occurrences(row, row.startAt, new Date(row.startAt.getTime() + 1))[0]?.start;
      if (!first || at.getTime() > first.getTime()) {
        // Split: the old series ends the day before; a new one starts here.
        const stored = storedRule(row) as EventRule;
        const ended = endRuleBefore(
          { ...stored, timezone: row.timezone, start: localDate(row.startAt, row.timezone) } as ScheduleRule,
          localDate(at, row.timezone),
        );
        const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = row;
        const fields = patched(row, patch, { start: at, end: new Date(at.getTime() + duration) });
        let nextRule: EventRule | null =
          patch.rule !== undefined || patch.recurrence !== undefined
            ? (patch.rule ?? LEGACY_RULES[patch.recurrence ?? "none"] ?? null)
            : stored;
        if (nextRule?.count) {
          // The new series gets the occurrences the old one had left.
          const before = occurrences({ ...row, exdates: [] }, row.startAt, at).length;
          nextRule = { ...nextRule, count: Math.max(1, nextRule.count - before) };
        }
        nextRule = checkEventRule(nextRule, fields.startAt, fields.timezone);
        const exdates = (row.exdates ?? []).map((d) => new Date(d).toISOString());
        const [next] = await tx
          .insert(calendarEvents)
          .values({
            ...copy,
            ...fields,
            rule: nextRule as Record<string, unknown> | null,
            recurrence: presetOf(nextRule),
            rrule: null,
            exdates: exdates.filter((d) => d >= at.toISOString()),
          })
          .returning();
        if (!next) throw new Error("series insert returned nothing");
        await copyAttendees(tx, orgId, row.id, next.id);
        const { timezone: _tz, times: _t, start: _s, time: _tm, ...endedRule } = ended ?? ({} as ScheduleRule);
        await tx
          .update(calendarEvents)
          .set({
            rule: (ended ? endedRule : null) as Record<string, unknown> | null,
            recurrence: ended ? "custom" : "none",
            exdates: exdates.filter((d) => d < at.toISOString()),
            updatedAt: new Date(),
          })
          .where(eq(calendarEvents.id, row.id));
        await tx
          .update(calendarEvents)
          .set({ overrideOf: next.id })
          .where(and(eq(calendarEvents.overrideOf, row.id), gte(calendarEvents.originalStart, at)));
        return next;
      }
      // "This and following" from the first one is the whole series.
    }
    // The whole series: a time change moves every occurrence (and its removed/edited ones).
    const at = patch.occurrenceStart ? new Date(patch.occurrenceStart) : row.startAt;
    const fields = patched(row, patch, { start: at, end: new Date(at.getTime() + duration) });
    const shift = fields.startAt.getTime() - at.getTime();
    const rule =
      patch.rule !== undefined || patch.recurrence !== undefined
        ? checkEventRule(patch.rule ?? LEGACY_RULES[patch.recurrence ?? "none"] ?? null, row.startAt, fields.timezone)
        : storedRule(row);
    const [updated] = await tx
      .update(calendarEvents)
      .set({
        title: fields.title,
        description: fields.description,
        location: fields.location,
        timezone: fields.timezone,
        allDay: fields.allDay,
        startAt: new Date(row.startAt.getTime() + shift),
        endAt: new Date(row.startAt.getTime() + shift + (fields.endAt.getTime() - fields.startAt.getTime())),
        rule: rule as Record<string, unknown> | null,
        recurrence: presetOf(rule),
        exdates: (row.exdates ?? []).map((d) => new Date(new Date(d).getTime() + shift).toISOString()),
        updatedAt: new Date(),
      })
      .where(eq(calendarEvents.id, row.id))
      .returning();
    if (shift !== 0) {
      await tx
        .update(calendarEvents)
        .set({ originalStart: sql`${calendarEvents.originalStart} + ${`${shift} milliseconds`}::interval` })
        .where(eq(calendarEvents.overrideOf, row.id));
    }
    return updated ?? row;
  });
  const out = view(result, await attendeesOf(db, [result.id]));
  if (result.channelId) {
    await publishChannelEvent(deps.pubsub, { type: "calendar.event_updated", channelId: result.channelId, event: out });
  }
  await publishListChanged(deps.pubsub, orgId, "calendar");
  return out;
}

/** Deletes an event: one occurrence, this and the next ones, or the whole series. */
export async function deleteCalendarEvent(
  deps: CalendarDeps,
  userId: string,
  orgId: string,
  eventId: string,
  options: { scope?: EditScope; occurrenceStart?: string } = {},
) {
  const { db } = deps;
  const row = await requireEventEditor(db, userId, orgId, eventId);
  const scope = options.scope ?? "all";
  const now = new Date();
  await db.transaction(async (tx) => {
    if (row.overrideOf) {
      // An edited occurrence: remove it, and keep it out of the series.
      await tx.update(calendarEvents).set({ deletedAt: now }).where(eq(calendarEvents.id, row.id));
      if (row.originalStart) {
        await tx
          .update(calendarEvents)
          .set({
            exdates: sql`${calendarEvents.exdates} || ${JSON.stringify([row.originalStart.toISOString()])}::jsonb`,
          })
          .where(eq(calendarEvents.id, row.overrideOf));
      }
      return;
    }
    const repeating = storedRule(row) !== null;
    if (!repeating || scope === "all") {
      await tx
        .update(calendarEvents)
        .set({ deletedAt: now })
        .where(or(eq(calendarEvents.id, row.id), eq(calendarEvents.overrideOf, row.id)));
      return;
    }
    const at = occurrenceOf(row, options.occurrenceStart);
    if (scope === "this") {
      await tx
        .update(calendarEvents)
        .set({ exdates: [...(row.exdates ?? []), at.toISOString()], updatedAt: now })
        .where(eq(calendarEvents.id, row.id));
      await tx
        .update(calendarEvents)
        .set({ deletedAt: now })
        .where(and(eq(calendarEvents.overrideOf, row.id), eq(calendarEvents.originalStart, at)));
      return;
    }
    const ended = endRuleBefore(
      {
        ...(storedRule(row) as EventRule),
        timezone: row.timezone,
        start: localDate(row.startAt, row.timezone),
      } as ScheduleRule,
      localDate(at, row.timezone),
    );
    if (!ended) {
      await tx
        .update(calendarEvents)
        .set({ deletedAt: now })
        .where(or(eq(calendarEvents.id, row.id), eq(calendarEvents.overrideOf, row.id)));
      return;
    }
    const { timezone: _tz, times: _t, start: _s, time: _tm, ...endedRule } = ended;
    await tx
      .update(calendarEvents)
      .set({ rule: endedRule as Record<string, unknown>, recurrence: "custom", updatedAt: now })
      .where(eq(calendarEvents.id, row.id));
    await tx
      .update(calendarEvents)
      .set({ deletedAt: now })
      .where(and(eq(calendarEvents.overrideOf, row.id), gte(calendarEvents.originalStart, at)));
  });
  if (row.channelId) {
    await publishChannelEvent(deps.pubsub, {
      type: "calendar.event_deleted",
      channelId: row.channelId,
      eventId: row.id,
      scope,
      ...(options.occurrenceStart ? { occurrenceStart: options.occurrenceStart } : {}),
    });
  }
  await publishListChanged(deps.pubsub, orgId, "calendar");
}

/** RSVP of a person to an event they're invited to. */
export async function respondToEvent(
  deps: CalendarDeps,
  userId: string,
  orgId: string,
  eventId: string,
  status: "accepted" | "declined",
) {
  const { db } = deps;
  const [row] = await db
    .update(calendarAttendees)
    .set({ status, respondedAt: new Date() })
    .where(
      and(
        eq(calendarAttendees.orgId, orgId),
        eq(calendarAttendees.eventId, eventId),
        eq(calendarAttendees.attendeeType, "person"),
        eq(calendarAttendees.attendeeId, userId),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("You are not invited to this event", "calendar.not_invited");
  const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId));
  if (!event) throw new NotFoundError("Event not found");
  await publishListChanged(deps.pubsub, orgId, "calendar");
  return view(event, await attendeesOf(db, [eventId]));
}

/** Events a person sees: theirs (invited or created) and those of channels they read. */
async function visibleEvents(db: Database, userId: string, orgId: string, from: Date, to: Date) {
  const invited = db
    .select({ id: calendarAttendees.eventId })
    .from(calendarAttendees)
    .where(
      and(
        eq(calendarAttendees.orgId, orgId),
        eq(calendarAttendees.attendeeType, "person"),
        eq(calendarAttendees.attendeeId, userId),
      ),
    );
  const myChannels = await userVisibleChannels(db, orgId, userId, { archived: true });
  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.orgId, orgId),
        isNull(calendarEvents.deletedAt),
        lte(calendarEvents.startAt, to),
        or(
          sql`${calendarEvents.recurrence} <> 'none'`,
          sql`${calendarEvents.rule} is not null`,
          gte(calendarEvents.endAt, from),
        ),
        or(inArray(calendarEvents.id, invited), inArray(calendarEvents.channelId, myChannels)),
      ),
    );
}

/** The calendar view: events (with recurrences expanded), routine runs, reminders, issue deadlines and my pending proposals. */
export async function calendarRange(deps: CalendarDeps, userId: string, orgId: string, fromIso: string, toIso: string) {
  const { db } = deps;
  const membership = await requirePermission(db, userId, orgId, "read");
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new ValidationError("to must be after from");
  }
  if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new ValidationError("The range is too long");
  const rows = await visibleEvents(db, userId, orgId, from, to);
  const attendees = await attendeesOf(
    db,
    rows.map((r) => r.id),
  );
  const events = expand(rows, from, to)
    .map((o) => view(o.row, attendees, o))
    .sort((a, b) => a.start.localeCompare(b.start));

  // Being deleted, its routines and reminders run at none of their times, so none shows (ADR 0088 §7).
  const closed = closedRefusal(membership.standing) !== null;
  const routineRows = closed
    ? []
    : await db
        .select()
        .from(routines)
        .where(
          and(
            eq(routines.orgId, orgId),
            eq(routines.active, true),
            eq(routines.triggerType, "schedule"),
            // A widget's refreshes aren't slots on a calendar (every 30 minutes would fill it; ADR 0135 §4).
            sql`coalesce(${routines.target}->>'type', '') <> 'widget'`,
          ),
        );
  const routineRuns: { routineId: string; name: string; agentId: string; at: string; target: unknown }[] = [];
  const sees = await routineSeer(db, orgId, userId);
  for (const r of routineRows) {
    if (r.deletedAt || !sees(r)) continue;
    for (const at of routineSlots(r, from, to)) {
      routineRuns.push({ routineId: r.id, name: r.name, agentId: r.agentId, at: at.toISOString(), target: r.target });
    }
  }

  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  const due = await db
    .select({
      id: issues.id,
      number: issues.number,
      title: issues.title,
      date: issues.dueDate,
      assigneeType: issues.assigneeType,
      assigneeId: issues.assigneeId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        sql`${issues.dueDate} >= ${fromDay}::date`,
        sql`${issues.dueDate} <= ${toDay}::date`,
        sql`${issues.status} not in ('done', 'canceled')`,
        taskSeenSql("issues", sql`${userId}::text`),
      ),
    )
    .orderBy(issues.dueDate, issues.number);
  // Who has each task: the calendar opens its due date with their face.
  const deadlines = due.map((d) => ({
    issueId: d.id,
    number: d.number,
    title: d.title,
    date: d.date ?? "",
    assignee:
      d.assigneeType && d.assigneeId
        ? { type: d.assigneeType as CalendarActor["type"], id: d.assigneeId }
        : (null as CalendarActor | null),
  }));

  const proposals = (
    await db
      .select()
      .from(calendarProposals)
      .where(
        and(
          eq(calendarProposals.orgId, orgId),
          eq(calendarProposals.requesterUserId, userId),
          eq(calendarProposals.status, "pending"),
        ),
      )
  ).map(proposalView);
  const mine = new Set(await userVisibleChannels(db, orgId, userId, { archived: true }));
  const reminders = closed ? [] : await calendarReminders(db, userId, orgId, from, to, mine, sees);
  return { events, routines: routineRuns, reminders, deadlines, proposals };
}

/** Busy blocks (no details) of people and agents between two instants. */
async function busy(db: Database, orgId: string, who: CalendarActor[], from: Date, to: Date) {
  if (who.length === 0) return [];
  const rows = await db
    .select({ event: calendarEvents, attendee: calendarAttendees })
    .from(calendarAttendees)
    .innerJoin(calendarEvents, eq(calendarEvents.id, calendarAttendees.eventId))
    .where(
      and(
        eq(calendarAttendees.orgId, orgId),
        inArray(
          calendarAttendees.attendeeId,
          who.map((w) => w.id),
        ),
        sql`${calendarAttendees.status} <> 'declined'`,
        isNull(calendarEvents.deletedAt),
        lte(calendarEvents.startAt, to),
      ),
    );
  return expand(
    rows.map((r) => r.event),
    from,
    to,
  );
}

/**
 * Free slots for everyone in `who`, on weekdays between 9:00 and 18:00 in
 * the org's time zone, from `from` for `days` days. Only busy/free: agents
 * never see other people's event details this way.
 */
export async function findFreeTime(
  db: Database,
  orgId: string,
  who: CalendarActor[],
  options: { durationMinutes: number; from: Date; days: number; timezone: string; limit?: number },
) {
  const to = new Date(options.from.getTime() + options.days * 86_400_000);
  const blocks = await busy(db, orgId, who, options.from, to);
  const duration = options.durationMinutes * 60_000;
  const slots: { start: string; end: string }[] = [];
  const step = 30 * 60_000;
  let t = Math.ceil(options.from.getTime() / step) * step;
  while (t + duration <= to.getTime() && slots.length < (options.limit ?? 3)) {
    const p = zonedParts(new Date(t), options.timezone);
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const endParts = zonedParts(new Date(t + duration), options.timezone);
    const inHours =
      weekday !== 0 &&
      weekday !== 6 &&
      p.hour >= 9 &&
      (endParts.hour < 18 || (endParts.hour === 18 && endParts.minute === 0));
    const clash = blocks.some((b) => b.start.getTime() < t + duration && b.end.getTime() > t);
    if (inHours && !clash) {
      slots.push({ start: new Date(t).toISOString(), end: new Date(t + duration).toISOString() });
      t += duration;
    } else t += step;
  }
  return slots;
}

/**
 * An agent suggests an event. Nothing is created: the person who asked gets
 * an inline card in the conversation and confirms (or dismisses) it.
 */
export async function proposeCalendarEvent(
  deps: CalendarDeps,
  run: {
    orgId: string;
    agentId: string;
    runId: string;
    channelId: string;
    threadRootId: string;
    triggerMessageId: string;
  },
  input: {
    title: string;
    description?: string;
    start: string;
    end: string;
    participants: CalendarActor[];
    note?: string;
    /** A repeating event (`EventRule`), in the org's time zone. */
    recurrence?: EventRule | null;
  },
): Promise<CalendarProposalView> {
  const { db } = deps;
  const [trigger] = await db
    .select({ userId: schema.messages.authorUserId })
    .from(schema.messages)
    .where(and(eq(schema.messages.id, run.triggerMessageId), eq(schema.messages.orgId, run.orgId)));
  if (!trigger?.userId) throw new ValidationError("Only a person's request can lead to an event proposal");
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new ValidationError("end must be after start");
  }
  await checkParticipants(db, run.orgId, input.participants);
  const zone = (await getOrgSettings(db, trigger.userId, run.orgId).catch(() => null))?.timezone ?? "UTC";
  const rule = checkEventRule(input.recurrence ?? null, start, zone);
  const proposal = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(calendarProposals)
      .values({
        orgId: run.orgId,
        agentId: run.agentId,
        runId: run.runId,
        requesterUserId: trigger.userId as string,
        channelId: run.channelId,
        title: input.title.trim().slice(0, 200),
        description: (input.description ?? "").slice(0, 10_000),
        startAt: start,
        endAt: end,
        participants: uniqueActors(input.participants),
        rule: rule as Record<string, unknown> | null,
        note: input.note?.slice(0, 300) ?? null,
      })
      .returning();
    if (!row) throw new Error("proposal insert returned nothing");
    const card = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId: replyThreadOf(run),
      author: { type: "agent", agentId: run.agentId, runId: run.runId, hop: 1 },
      body: `Event proposal: ${row.title}`,
      meta: {
        calendarProposalId: row.id,
        calendarProposal: proposalView(row),
        ...bodyCode("calendar_proposal", { title: row.title }),
      },
    });
    const [linked] = await tx
      .update(calendarProposals)
      .set({ messageId: card.id })
      .where(eq(calendarProposals.id, row.id))
      .returning();
    return { row: linked ?? row, card };
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(proposal.card));
  await publishUserEvent(deps.pubsub, run.orgId, trigger.userId, {
    type: "calendar.proposal",
    proposal: proposalView(proposal.row),
  });
  return proposalView(proposal.row);
}

async function decideProposalRow(db: Database, userId: string, orgId: string, id: string) {
  const [p] = await db
    .select()
    .from(calendarProposals)
    .where(and(eq(calendarProposals.id, id), eq(calendarProposals.orgId, orgId)));
  if (!p) throw new NotFoundError("Proposal not found");
  const membership = await requireActiveMembership(db, userId, orgId);
  if (p.requesterUserId !== userId && !can(membership, "configure")) {
    throw new ForbiddenError("Only the person who asked can confirm this");
  }
  if (p.status !== "pending") throw new ValidationError("This proposal was already decided");
  return p;
}

/** The proposal's card in its conversation follows its decision, at once for who has it open. */
async function syncProposalCard(deps: CalendarDeps, p: ProposalRow) {
  if (!p.messageId) return;
  const [card] = await deps.db
    .update(schema.messages)
    .set({
      meta: sql`jsonb_set(${schema.messages.meta}, '{calendarProposal}', ${JSON.stringify(proposalView(p))}::jsonb)`,
    })
    .where(and(eq(schema.messages.id, p.messageId), eq(schema.messages.orgId, p.orgId)))
    .returning({ channelId: schema.messages.channelId, threadId: schema.messages.threadId });
  if (card)
    await publishChannelEvent(deps.pubsub, {
      type: "calendar.proposal.updated",
      channelId: card.channelId,
      threadId: card.threadId,
      messageId: p.messageId,
      proposal: proposalView(p),
    });
}

/** The person who asked confirms: the event is created (by them) and the participants are invited. */
export async function confirmCalendarProposal(deps: CalendarDeps, userId: string, orgId: string, id: string) {
  const p = await decideProposalRow(deps.db, userId, orgId, id);
  const agent = await getAgent(deps.db, orgId, p.agentId);
  const participants = [
    ...(p.participants as CalendarActor[]),
    ...(agent ? [{ type: "agent" as const, id: agent.id }] : []),
  ];
  const event = await createCalendarEvent(deps, userId, orgId, {
    title: p.title,
    description: p.description,
    start: p.startAt.toISOString(),
    end: p.endAt.toISOString(),
    rule: (p.rule as EventRule | null) ?? null,
    participants,
    channelId: null,
  });
  const [row] = await deps.db
    .update(calendarProposals)
    .set({ status: "confirmed", eventId: event.id })
    .where(eq(calendarProposals.id, p.id))
    .returning();
  if (row) await syncProposalCard(deps, row);
  return event;
}

export async function dismissCalendarProposal(deps: CalendarDeps, userId: string, orgId: string, id: string) {
  const p = await decideProposalRow(deps.db, userId, orgId, id);
  const [row] = await deps.db
    .update(calendarProposals)
    .set({ status: "dismissed" })
    .where(eq(calendarProposals.id, p.id))
    .returning();
  if (row) await syncProposalCard(deps, row);
}

/** Resolves `@ana` / `@dev` handles (or ids) to people and agents of the org. */
export async function resolveParticipants(db: Database, orgId: string, refs: string[]): Promise<CalendarActor[]> {
  const handles = await currentHandles(
    db,
    orgId,
    refs.map((r) => r.trim().replace(/^@/, "").toLowerCase()).filter(Boolean),
  );
  if (handles.length === 0) return [];
  const [people, bots] = await Promise.all([
    db
      .select({ id: organizationMembers.userId, handle: organizationMembers.handle })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.handle, handles))),
    db
      .select({ id: agents.id, handle: agents.handle })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.handle, handles), isNull(agents.archivedAt))),
  ]);
  const out: CalendarActor[] = [
    ...people.map((p) => ({ type: "person" as const, id: p.id })),
    ...bots.map((b) => ({ type: "agent" as const, id: b.id })),
  ];
  const known = new Set([...people.map((p) => p.handle), ...bots.map((b) => b.handle)]);
  const unknown = handles.filter((h) => !known.has(h));
  if (unknown.length > 0)
    throw new ValidationError(`Not found: ${unknown.map((h) => `@${h}`).join(", ")}`, "participants.unknown", {
      handles: unknown,
    });
  return out;
}

/** Events an agent may see: those it attends and those of channels it can read in this run. */
export async function agentEvents(
  db: Database,
  orgId: string,
  agentId: string,
  visibleChannelIds: string[],
  from: Date,
  to: Date,
) {
  const attending = db
    .select({ id: calendarAttendees.eventId })
    .from(calendarAttendees)
    .where(
      and(
        eq(calendarAttendees.orgId, orgId),
        eq(calendarAttendees.attendeeType, "agent"),
        eq(calendarAttendees.attendeeId, agentId),
      ),
    );
  const rows = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.orgId, orgId),
        isNull(calendarEvents.deletedAt),
        lte(calendarEvents.startAt, to),
        visibleChannelIds.length > 0
          ? or(inArray(calendarEvents.id, attending), inArray(calendarEvents.channelId, visibleChannelIds))
          : inArray(calendarEvents.id, attending),
      ),
    );
  const attendees = await attendeesOf(
    db,
    rows.map((r) => r.id),
  );
  return expand(rows, from, to).map((o) => view(o.row, attendees, o));
}
