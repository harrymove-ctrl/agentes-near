import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, userTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  calendarRange,
  confirmCalendarProposal,
  createCalendarEvent,
  createIssue,
  createRoutine,
  dismissCalendarProposal,
  drainOutbox,
  ForbiddenError,
  findFreeTime,
  grantScopes,
  listMembers,
  occurrences,
  postPersonMessage,
  respondToEvent,
  uniqueActors,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const at = (iso: string) => new Date(iso);

describe("recurrence", () => {
  test("a weekly 9:00 meeting stays at 9:00 local across DST", () => {
    const e = {
      startAt: at("2026-03-02T14:00:00Z"), // Monday 9:00 EST
      endAt: at("2026-03-02T15:00:00Z"),
      recurrence: "weekly",
      timezone: "America/New_York",
    };
    const list = occurrences(e, at("2026-03-01T00:00:00Z"), at("2026-03-20T00:00:00Z"));
    expect(list.map((o) => o.start.toISOString())).toEqual([
      "2026-03-02T14:00:00.000Z",
      "2026-03-09T13:00:00.000Z", // 9:00 EDT
      "2026-03-16T13:00:00.000Z",
    ]);
  });

  test("weekdays skip the weekend; monthly on the 31st skips short months", () => {
    const weekdays = occurrences(
      {
        startAt: at("2026-10-16T12:00:00Z"),
        endAt: at("2026-10-16T12:30:00Z"),
        recurrence: "weekdays",
        timezone: "UTC",
      },
      at("2026-10-16T00:00:00Z"),
      at("2026-10-21T00:00:00Z"),
    );
    expect(weekdays.map((o) => o.start.toISOString().slice(0, 10))).toEqual(["2026-10-16", "2026-10-19", "2026-10-20"]);
    const monthly = occurrences(
      {
        startAt: at("2026-01-31T10:00:00Z"),
        endAt: at("2026-01-31T11:00:00Z"),
        recurrence: "monthly",
        timezone: "UTC",
      },
      at("2026-01-01T00:00:00Z"),
      at("2026-06-01T00:00:00Z"),
    );
    expect(monthly.map((o) => o.start.toISOString().slice(0, 10))).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });
});

describe("calendar", () => {
  test("people create events; invitees are notified, RSVP, and see it in their range with routines and deadlines", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://chat.example.com" };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const outsider = await addMember(f.db, f.org.id, "member", "caio");
    const invited: string[] = [];
    f.pubsub.subscribe(userTopic(f.org.id, bia.id), (e) => invited.push(e.type));
    const event = await createCalendarEvent(deps, f.owner.id, f.org.id, {
      title: "Planejamento",
      start: "2026-10-20T13:00:00Z",
      end: "2026-10-20T14:00:00Z",
      recurrence: "none",
      participants: [
        { type: "person", id: bia.id },
        { type: "agent", id: f.agent.id },
      ],
    });
    expect(event.rsvp.map((r) => [r.type, r.status]).sort()).toEqual([
      ["agent", "needs_action"],
      ["person", "accepted"],
      ["person", "needs_action"],
    ]);
    expect(invited).toContain("calendar.invited");
    const emails = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    expect(JSON.stringify(emails.map((e) => e.payload))).toContain("calendar_invite");
    // The button opens the event on its week.
    expect(emails.find((e) => JSON.stringify(e.payload).includes("calendar_invite"))?.payload).toMatchObject({
      template: { url: `https://chat.example.com/org/${f.org.id}/calendar?open=${event.id}&day=2026-10-20` },
    });
    expect((await respondToEvent(deps, bia.id, f.org.id, event.id, "accepted")).rsvp).toContainEqual({
      type: "person",
      id: bia.id,
      status: "accepted",
    });
    await expect(respondToEvent(deps, outsider.id, f.org.id, event.id, "accepted")).rejects.toMatchObject({
      code: "calendar.not_invited",
    });

    await createIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Entrega",
      dueDate: "2026-10-21",
    });
    await createRoutine({ db: f.db, pubsub: f.pubsub, context: f.context }, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resumo",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "todo dia às 9h" },
    });
    const range = await calendarRange(deps, bia.id, f.org.id, "2026-10-19T00:00:00Z", "2026-10-23T00:00:00Z");
    expect(range.events.map((e) => e.title)).toEqual(["Planejamento"]);
    expect(range.deadlines.map((d) => [d.number, d.date])).toEqual([[1, "2026-10-21"]]);
    // Nobody has it yet: the calendar draws its due date without a face.
    expect(range.deadlines[0]?.assignee).toBeNull();
    // One a day, counted in a week that is always ahead (today's 9:00 may already be past).
    const ahead = await calendarRange(deps, bia.id, f.org.id, "2099-01-05T00:00:00Z", "2099-01-09T00:00:00Z");
    expect(ahead.routines.length).toBe(4);
    expect(
      (await calendarRange(deps, outsider.id, f.org.id, "2026-10-19T00:00:00Z", "2026-10-23T00:00:00Z")).events,
    ).toEqual([]);
  });

  test("the invitation email's time names its zone: the reader's, or the event's when they have none", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://chat.example.com" };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, bia.id));
    await createCalendarEvent(deps, f.owner.id, f.org.id, {
      title: "Retro",
      start: "2026-10-28T12:00:00Z",
      end: "2026-10-28T13:00:00Z",
      timezone: "America/Sao_Paulo",
      recurrence: "none",
      participants: [{ type: "person", id: bia.id }],
    });
    const [email] = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "email.send");
    const when = (email?.payload as { template?: { when?: string } } | undefined)?.template?.when;
    expect(when).toContain("GMT-3");
    expect(when).toContain("9:00");
  });

  test("free time: everyone's busy blocks, weekdays 9:00 to 18:00", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await createCalendarEvent(deps, f.owner.id, f.org.id, {
      title: "Ocupado",
      start: "2026-10-19T10:00:00Z",
      end: "2026-10-19T11:00:00Z",
      recurrence: "none",
      participants: [],
    });
    const slots = await findFreeTime(
      f.db,
      f.org.id,
      [
        { type: "person", id: f.owner.id },
        { type: "person", id: bia.id },
      ],
      { durationMinutes: 60, from: at("2026-10-19T09:00:00Z"), days: 1, timezone: "UTC", limit: 2 },
    );
    expect(slots.map((s) => s.start)).toEqual(["2026-10-19T09:00:00.000Z", "2026-10-19T11:00:00.000Z"]);
  });

  test("a due date says who has the task, so the calendar opens it with their face", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const owner = { type: "person" as const, userId: f.owner.id };
    await createIssue(deps, owner, f.org.id, {
      title: "Login",
      dueDate: "2026-10-21",
      assignee: { type: "agent", id: f.agent.id },
    });
    await createIssue(deps, owner, f.org.id, {
      title: "Textos",
      dueDate: "2026-10-22",
      assignee: { type: "person", id: bia.id },
    });
    const range = await calendarRange(deps, f.owner.id, f.org.id, "2026-10-19T00:00:00Z", "2026-10-23T00:00:00Z");
    expect(range.deadlines.map((d) => [d.title, d.assignee])).toEqual([
      ["Login", { type: "agent", id: f.agent.id }],
      ["Textos", { type: "person", id: bia.id }],
    ]);
  });

  test("a proposal names each person once, even one saved naming someone twice", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const twice = [
      { type: "person" as const, id: bia.id },
      { type: "agent" as const, id: f.agent.id },
      { type: "person" as const, id: bia.id },
    ];
    expect(uniqueActors(twice)).toEqual(twice.slice(0, 2));
    await f.db.insert(schema.calendarProposals).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      requesterUserId: f.owner.id,
      channelId: f.general.id,
      title: "Revisão do roadmap",
      startAt: at("2026-10-20T15:00:00Z"),
      endAt: at("2026-10-20T15:45:00Z"),
      participants: twice,
    });
    const range = await calendarRange(
      { db: f.db, pubsub: f.pubsub },
      f.owner.id,
      f.org.id,
      "2026-10-19T00:00:00Z",
      "2026-10-23T00:00:00Z",
    );
    expect(range.proposals[0]?.participants).toEqual([
      { type: "person", id: bia.id },
      { type: "agent", id: f.agent.id },
    ]);
  });

  test("an agent proposes an event; nothing exists until the person who asked confirms", async () => {
    f = await setup({
      calendarTools: true,
      reply: (req: ModelRequest) =>
        JSON.stringify(req.messages.at(-1)?.content).includes("tool_result")
          ? { chunks: ["Sugeri um horário."] }
          : {
              chunks: [],
              toolUses: [
                {
                  name: "propose_event",
                  input: {
                    title: "Revisão do PR",
                    start: "2026-10-20T15:00:00Z",
                    end: "2026-10-20T15:30:00Z",
                    participants: ["@bia"],
                  },
                },
              ],
            },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "calendar:write" }]);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await listMembers(f.db, f.org.id); // handles
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev marca uma revisão com a bia amanhã",
    });
    await drainOutbox(f.db, f.handlers);
    const [proposal] = await f.db.select().from(schema.calendarProposals);
    expect(proposal).toMatchObject({ status: "pending", requesterUserId: f.owner.id, title: "Revisão do PR" });
    expect(await f.db.select().from(schema.calendarEvents)).toEqual([]);
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, proposal?.messageId ?? ""));
    expect(card?.meta.calendarProposalId).toBe(proposal?.id);
    // Lists, the inbox and the push word it in each reader's language: English only as the fallback.
    expect(card).toMatchObject({
      body: "Event proposal: Revisão do PR",
      meta: { bodyCode: "calendar_proposal", bodyParams: { title: "Revisão do PR" } },
    });
    expect(card?.threadId).toBeNull(); // asked in the channel: the card is there
    // Its words in the reader's language, and who confirms it, for the card in the conversation.
    expect(card?.meta).toMatchObject({
      bodyCode: "calendar_proposal",
      bodyParams: { title: "Revisão do PR" },
      calendarProposal: { requesterUserId: f.owner.id, status: "pending" },
    });
    const heard: { type: string; messageId?: string; proposal?: { status: string } }[] = [];
    f.pubsub.subscribe(channelTopic(f.general.id), (e) => heard.push(e as (typeof heard)[number]));

    const deps = { db: f.db, pubsub: f.pubsub };
    await expect(dismissCalendarProposal(deps, bia.id, f.org.id, proposal?.id ?? "")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const event = await confirmCalendarProposal(deps, f.owner.id, f.org.id, proposal?.id ?? "");
    expect(event.participants.map((p) => p.id).sort()).toEqual([f.owner.id, bia.id, f.agent.id].sort());
    const [after] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, proposal?.messageId ?? ""));
    expect(after?.meta.calendarProposal).toMatchObject({ status: "confirmed" });
    // Everyone with the conversation open sees the card decided.
    expect(heard.filter((e) => e.type === "calendar.proposal.updated")).toEqual([
      expect.objectContaining({
        messageId: proposal?.messageId,
        proposal: expect.objectContaining({ status: "confirmed" }),
      }),
    ]);
  });
});
