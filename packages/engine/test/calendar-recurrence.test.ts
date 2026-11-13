import { afterEach, describe, expect, test } from "bun:test";
import {
  addChannelMember,
  calendarRange,
  confirmCalendarProposal,
  createCalendarEvent,
  deleteCalendarEvent,
  drainOutbox,
  ForbiddenError,
  postPersonMessage,
  proposeCalendarEvent,
  updateCalendarEvent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SP = "America/Sao_Paulo";
const deps = () => ({ db: f.db, pubsub: f.pubsub });
const range = async (from = "2026-10-01T00:00:00Z", to = "2026-11-30T00:00:00Z") =>
  (await calendarRange(deps(), f.owner.id, f.org.id, from, to)).events;

/** Mondays and Wednesdays at 10:00 São Paulo, every 2 weeks, from Mon 12/10 until 25/11. */
async function series() {
  return createCalendarEvent(deps(), f.owner.id, f.org.id, {
    title: "Sync",
    start: "2026-10-12T13:00:00Z",
    end: "2026-10-12T13:30:00Z",
    timezone: SP,
    rule: { freq: "weekly", interval: 2, byWeekday: ["MO", "WE"], until: "2026-11-25" },
    participants: [],
  });
}

describe("repeating events", () => {
  test("a rule expands in the range; the view carries the rule and each occurrence's start", async () => {
    f = await setup();
    const created = await series();
    expect(created).toMatchObject({
      recurrence: "custom",
      rule: { freq: "weekly", interval: 2 },
      seriesId: created.id,
    });
    const list = await range();
    expect(list.map((e) => e.start)).toEqual([
      "2026-10-12T13:00:00.000Z",
      "2026-10-14T13:00:00.000Z",
      "2026-10-26T13:00:00.000Z",
      "2026-10-28T13:00:00.000Z",
      "2026-11-09T13:00:00.000Z",
      "2026-11-11T13:00:00.000Z",
      "2026-11-23T13:00:00.000Z",
      "2026-11-25T13:00:00.000Z",
    ]);
    expect(list.every((e) => e.occurrenceStart === e.start && e.seriesId === created.id)).toBe(true);
    // The legacy presets still work and read back as presets.
    const daily = await createCalendarEvent(deps(), f.owner.id, f.org.id, {
      title: "Standup",
      start: "2026-10-19T12:00:00Z",
      end: "2026-10-19T12:15:00Z",
      timezone: SP,
      recurrence: "weekdays",
      participants: [],
    });
    expect(daily).toMatchObject({ recurrence: "weekdays", rule: { freq: "weekly" } });
  });

  test('"só este" edits one occurrence; "este e os próximos" splits the series; deletes by scope', async () => {
    f = await setup();
    const created = await series();
    const [, second, third] = await range();
    const moved = await updateCalendarEvent(deps(), f.owner.id, f.org.id, created.id, {
      scope: "this",
      occurrenceStart: second?.occurrenceStart ?? "",
      title: "Sync (remarcado)",
      start: "2026-10-14T17:00:00Z",
      end: "2026-10-14T17:30:00Z",
    });
    expect(moved).toMatchObject({ seriesId: created.id, occurrenceStart: second?.occurrenceStart });
    let list = await range();
    expect(list).toHaveLength(8);
    expect(list.find((e) => e.title === "Sync (remarcado)")?.start).toBe("2026-10-14T17:00:00.000Z");
    expect(list.some((e) => e.start === "2026-10-14T13:00:00.000Z")).toBe(false);

    const next = await updateCalendarEvent(deps(), f.owner.id, f.org.id, created.id, {
      scope: "following",
      occurrenceStart: third?.occurrenceStart ?? "",
      title: "Sync novo",
    });
    expect(next.id).not.toBe(created.id);
    list = await range();
    expect(list).toHaveLength(8);
    expect(list.filter((e) => e.title === "Sync").map((e) => e.start)).toEqual(["2026-10-12T13:00:00.000Z"]);
    expect(list.filter((e) => e.title === "Sync novo")).toHaveLength(6);
    expect(list.filter((e) => e.title === "Sync novo").every((e) => e.seriesId === next.id)).toBe(true);
    // The edited one before the split stays with the old series.
    expect(list.find((e) => e.title === "Sync (remarcado)")?.seriesId).toBe(created.id);

    const newer = list.filter((e) => e.seriesId === next.id);
    await deleteCalendarEvent(deps(), f.owner.id, f.org.id, next.id, {
      scope: "this",
      occurrenceStart: newer[1]?.occurrenceStart ?? "",
    });
    expect((await range()).filter((e) => e.seriesId === next.id)).toHaveLength(5);
    await deleteCalendarEvent(deps(), f.owner.id, f.org.id, next.id, {
      scope: "following",
      occurrenceStart: newer[3]?.occurrenceStart ?? "",
    });
    expect((await range()).filter((e) => e.seriesId === next.id).map((e) => e.start)).toEqual([
      "2026-10-26T13:00:00.000Z",
      "2026-11-09T13:00:00.000Z",
    ]);
    await deleteCalendarEvent(deps(), f.owner.id, f.org.id, created.id, { scope: "all" });
    expect((await range()).filter((e) => e.seriesId === created.id)).toEqual([]);

    // Others can't change someone else's event.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(updateCalendarEvent(deps(), bia.id, f.org.id, next.id, { title: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test('"todos" moves every occurrence when the time changes', async () => {
    f = await setup();
    const created = await series();
    const [, second] = await range();
    await updateCalendarEvent(deps(), f.owner.id, f.org.id, created.id, {
      scope: "all",
      occurrenceStart: second?.occurrenceStart ?? "",
      start: "2026-10-14T14:00:00Z",
      end: "2026-10-14T14:30:00Z",
    });
    const list = await range();
    expect(list).toHaveLength(8);
    expect(list.every((e) => e.start.endsWith("T14:00:00.000Z"))).toBe(true);
  });

  test("all-day events over several days, in the event's time zone", async () => {
    f = await setup();
    const trip = await createCalendarEvent(deps(), f.owner.id, f.org.id, {
      title: "Viagem",
      allDay: true,
      startDate: "2026-10-20",
      endDate: "2026-10-22",
      timezone: SP,
      participants: [],
    });
    expect(trip).toMatchObject({
      allDay: true,
      startDate: "2026-10-20",
      endDate: "2026-10-22",
      start: "2026-10-20T03:00:00.000Z",
      end: "2026-10-23T03:00:00.000Z",
    });
    expect((await range("2026-10-21T12:00:00Z", "2026-10-21T13:00:00Z")).map((e) => e.title)).toEqual(["Viagem"]);
    expect(await range("2026-10-23T04:00:00Z", "2026-10-24T00:00:00Z")).toEqual([]);
    // A yearly all-day (a birthday).
    const birthday = await createCalendarEvent(deps(), f.owner.id, f.org.id, {
      title: "Aniversário",
      allDay: true,
      startDate: "2026-11-02",
      timezone: SP,
      rule: { freq: "yearly" },
      participants: [],
    });
    const years = (
      await calendarRange(deps(), f.owner.id, f.org.id, "2026-10-15T00:00:00Z", "2027-11-15T00:00:00Z")
    ).events
      .filter((e) => e.seriesId === birthday.id)
      .map((e) => e.startDate);
    expect(years).toEqual(["2026-11-02", "2027-11-02"]);
  });

  test("an agent can propose a repeating event; confirming creates the series", async () => {
    f = await setup();
    const question = await postPersonMessage(deps() as never, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from((await import("@agenteschat/db")).schema.agentRuns);
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: f.agent.id }).catch(() => undefined);
    const proposal = await proposeCalendarEvent(
      deps(),
      {
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: run?.id ?? "",
        channelId: f.general.id,
        threadRootId: question.id,
        triggerMessageId: question.id,
      },
      {
        title: "1:1",
        start: "2026-10-20T13:00:00Z",
        end: "2026-10-20T13:30:00Z",
        participants: [],
        recurrence: { freq: "weekly", interval: 2 },
      },
    );
    expect(proposal.rule).toEqual({ freq: "weekly", interval: 2 });
    const event = await confirmCalendarProposal(deps(), f.owner.id, f.org.id, proposal.id);
    expect(event.rule).toMatchObject({ freq: "weekly", interval: 2, start: "2026-10-20" });
  });
});
