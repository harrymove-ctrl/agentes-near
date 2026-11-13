import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("calendar API: create an event, see it in the range, RSVP", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = await api("/calendar/events", {
    json: {
      title: "Daily",
      start: "2026-10-19T12:00:00Z",
      end: "2026-10-19T12:15:00Z",
      recurrence: "weekdays",
      participants: [{ type: "agent", id: agentId }],
    },
  });
  expect(created.status).toBe(201);
  const event = (await created.json()) as { id: string; recurrence: string };
  expect(event.recurrence).toBe("weekdays");
  const range = (await (await api("/calendar?from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z")).json()) as {
    events: { id: string; start: string }[];
    proposals: unknown[];
  };
  expect(range.events.map((e) => e.start.slice(0, 10))).toEqual([
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
  ]);
  expect(range.proposals).toEqual([]);
  const rsvp = await api(`/calendar/events/${event.id}/rsvp`, { json: { status: "declined" } });
  expect(await rsvp.json()).toMatchObject({
    rsvp: expect.arrayContaining([expect.objectContaining({ status: "declined" })]),
  });
  expect((await api("/calendar?from=2026-10-20T00:00:00Z&to=2026-10-19T00:00:00Z")).status).toBe(400);
});

test("calendar API: a task's due date says who has it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const assignee = { type: "agent", id: agentId };
  expect((await api("/issues", { json: { title: "Login", dueDate: "2026-10-21", assignee } })).status).toBe(201);
  expect((await api("/issues", { json: { title: "Textos", dueDate: "2026-10-22" } })).status).toBe(201);
  const range = (await (await api("/calendar?from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z")).json()) as {
    deadlines: { title: string; assignee: unknown }[];
  };
  expect(range.deadlines.map((d) => [d.title, d.assignee])).toEqual([
    ["Login", assignee],
    ["Textos", null],
  ]);
});
