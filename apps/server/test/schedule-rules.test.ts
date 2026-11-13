import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    reply: () => ({ chunks: ["ok"] }),
    // What the model would answer for a one-off (a local date-time in the zone).
    schedules: { "30 de dezembro de 2099 às 9h": { at: "2099-12-30T09:00" } },
  });
});
afterEach(() => t.close());

test("period picker: phrase → rule → description, and a routine on a rule cron can't say", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const parsed = (await (
    await api("/routines/parse-rule", {
      json: { phrase: "a cada 2 semanas na segunda e quarta às 9h", timezone: "America/Sao_Paulo" },
    })
  ).json()) as {
    ok: boolean;
    rule: Record<string, unknown>;
    description: string;
    cron: string | null;
    nextRuns: string[];
  };
  expect(parsed).toMatchObject({
    ok: true,
    rule: { freq: "weekly", interval: 2, byWeekday: ["MO", "WE"], times: ["09:00"] },
    cron: null,
  });
  expect(parsed.description).toStartWith("Every 2 weeks, Mon and Wed, at 09:00 (Brasília time)");
  expect(parsed.nextRuns).toHaveLength(5);

  // A one-off fills the picker's "once"; a phrase the reader can't read is refused with a code.
  const once = await (
    await api("/routines/parse-rule", {
      json: { phrase: "30 de dezembro de 2099 às 9h", timezone: "America/Sao_Paulo" },
    })
  ).json();
  expect(once).toMatchObject({
    ok: true,
    rule: { freq: "once", start: "2099-12-30", times: ["09:00"], timezone: "America/Sao_Paulo" },
    cron: null,
    nextRuns: ["2099-12-30T12:00:00.000Z"],
  });
  expect(await (await api("/routines/parse-rule", { json: { phrase: "quando der vontade" } })).json()).toMatchObject({
    ok: false,
    code: "schedule.unreadable",
  });

  const described = (await (
    await api("/routines/describe-rule", {
      json: { rule: { freq: "monthly", byWeekday: ["TU"], bySetPos: 2, times: ["10:00"], timezone: "UTC" } },
    })
  ).json()) as { ok: boolean; description: string };
  expect(described).toMatchObject({ ok: true, description: "Every month, on the 2nd Tuesday, at 10:00 (UTC)" });

  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Resumo quinzenal",
      target: { type: "channel", channelId },
      trigger: { type: "schedule", rule: parsed.rule },
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as { trigger: { rule: unknown; cron: string }; nextRunAt: string };
  expect(routine.trigger).toMatchObject({ rule: { freq: "weekly", interval: 2 }, cron: "" });
  expect(routine.nextRunAt).toBe(parsed.nextRuns[0] ?? "");
});

test("calendar: repeating event, edit only one, delete the following", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = (await (
    await api("/calendar/events", {
      json: {
        title: "Daily",
        start: "2026-10-19T12:00:00Z",
        end: "2026-10-19T12:15:00Z",
        timezone: "UTC",
        rule: { freq: "daily", interval: 1, times: ["12:00"], timezone: "UTC", start: "2026-10-19", until: null },
        participants: [],
      },
    })
  ).json()) as { id: string; rule: { freq: string } };
  expect(created.rule.freq).toBe("daily");
  const list = async () =>
    (
      (await (await api("/calendar?from=2026-10-19T00:00:00Z&to=2026-10-26T00:00:00Z")).json()) as {
        events: { id: string; title: string; start: string; occurrenceStart: string | null }[];
      }
    ).events;
  expect(await list()).toHaveLength(7);
  const edited = await api(`/calendar/events/${created.id}`, {
    method: "PATCH",
    json: { scope: "this", occurrenceStart: "2026-10-21T12:00:00.000Z", title: "Daily (curta)" },
  });
  expect(edited.status).toBe(200);
  expect((await list()).filter((e) => e.title === "Daily (curta)")).toHaveLength(1);
  const removed = await api(
    `/calendar/events/${created.id}?scope=following&occurrenceStart=${encodeURIComponent("2026-10-23T12:00:00.000Z")}`,
    { method: "DELETE" },
  );
  expect(removed.status).toBe(204);
  expect((await list()).map((e) => e.start.slice(0, 10))).toEqual([
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
  ]);
});
