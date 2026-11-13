import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

/** The owner's browser, their organization and a routine in #general. */
async function withRoutine(extra: Record<string, unknown> = {}) {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = await api("/routines", {
    json: {
      agentId,
      prompt: "Resuma o dia",
      target: { type: "channel", channelId },
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
      ...extra,
    },
  });
  expect(created.status).toBe(201);
  const routine = (await created.json()) as Record<string, unknown> & { id: string };
  return { api, routine, orgId, owner };
}

test("create and edit the report, every routine acting; resuming clears the pause reason and the failure streak", async () => {
  const { api, routine } = await withRoutine({ access: "act", report: "always" });
  expect(routine).toMatchObject({
    access: "act",
    report: "always",
    state: "active",
    canManage: true,
    canSeeDetails: true,
    pausedReason: null,
    health: { ok: 0, total: 0 },
    usage: { runs: 0, tokens: 0, billedTo: "api" },
  });
  const edited = await api(`/routines/${routine.id}`, {
    method: "PATCH",
    json: { access: "read", report: "when_new" },
  });
  expect(edited.status).toBe(200);
  // An old client may still send `read`: every routine acts (ADR 0109).
  expect(await edited.json()).toMatchObject({ access: "act", report: "when_new" });

  // It paused itself after failing; a person resumes it.
  await t.db
    .update(schema.routines)
    .set({ active: false, nextRunAt: null, pausedReason: "failing", failuresInRow: 5 })
    .where(eq(schema.routines.id, routine.id));
  const paused = (await (await api("/routines")).json()) as { routines: Record<string, unknown>[] };
  expect(paused.routines[0]).toMatchObject({ state: "paused", pausedReason: "failing", failuresInRow: 5 });
  const resumed = await api(`/routines/${routine.id}`, { method: "PATCH", json: { active: true } });
  expect(await resumed.json()).toMatchObject({ active: true, state: "active", pausedReason: null, failuresInRow: 0 });

  // Too often is refused with its code.
  const often = await api(`/routines/${routine.id}`, {
    method: "PATCH",
    json: { trigger: { type: "schedule", phrase: "*/5 * * * *" } },
  });
  expect(often.status).toBe(400);
  expect(await often.json()).toMatchObject({ error: { code: "routine.too_frequent", params: { minutes: 15 } } });
});

test("stop ends the run in progress as canceled, by whoever stopped it", async () => {
  const { api, routine } = await withRoutine();
  // Queued, not run yet: the worker hasn't picked it up.
  await api(`/routines/${routine.id}/run`, { json: {} });
  const stopped = await api(`/routines/${routine.id}/stop`, { json: {} });
  expect(stopped.status).toBe(200);
  const view = (await stopped.json()) as { id: string; state: string; recentRuns: { status: string }[] };
  expect(view.id).toBe(routine.id);
  expect(view.state).not.toBe("running");
  const [run] = await t.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  expect(run).toMatchObject({ status: "canceled", code: "stopped" });
  expect(view.recentRuns[0]).toMatchObject({ status: "canceled", code: "stopped" });
});

test("take-over: an admin becomes the creator of a routine whose creator left", async () => {
  const { api, routine } = await withRoutine();
  const [me] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
  await t.db
    .update(schema.routines)
    .set({ createdByUserId: null, active: false, nextRunAt: null, pausedReason: "creator_left" })
    .where(eq(schema.routines.id, routine.id));
  const taken = await api(`/routines/${routine.id}/take-over`, { json: {} });
  expect(taken.status).toBe(200);
  expect(await taken.json()).toMatchObject({ id: routine.id, canManage: true });
  const [row] = await t.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
  expect(row?.createdByUserId).toBe(me?.id ?? "");
});

test("continue: a routine paused near its plan's limit goes on for its owner; a plain member is refused", async () => {
  const { api, routine, orgId, owner } = await withRoutine();
  await api(`/routines/${routine.id}/run`, { json: {} });
  await t.drain();
  // Its run parked at 95% of a plan window (the engine's tests park it for real).
  const [ledger] = await t.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, routine.id));
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await t.db
    .update(schema.routineRuns)
    .set({ status: "started" })
    .where(eq(schema.routineRuns.id, ledger?.id ?? ""));
  const [run] = await t.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, ledger?.agentRunId ?? ""));
  await t.db
    .update(schema.agentRuns)
    .set({
      status: "waiting_input",
      transcript: {
        ...(run?.transcript as Record<string, unknown>),
        waitingForBrain: {
          kind: "claude_code",
          machineId: "",
          code: "usage_pause",
          waitId: "wait-1",
          source: "plan",
          resetsAt,
        },
        usagePause: { paused: true },
      },
    })
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  const list = (await (await api("/routines")).json()) as { routines: { state: string; usagePause: unknown }[] };
  const [paused] = list.routines;
  expect(paused?.state).toBe("usage_paused");
  expect(paused?.usagePause).toEqual({
    source: "plan",
    resetsAt,
    limit: false,
    plan: null,
    extraOff: false,
    extraUsedUp: false,
  });

  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const refused = await ana(`/api/app/organizations/${orgId}/routines/${routine.id}/continue`, { json: {} });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: { code: "routine.editor_only" } });

  const continued = await api(`/routines/${routine.id}/continue`, { json: {} });
  expect(continued.status).toBe(200);
  const view = (await continued.json()) as { id: string; state: string; usagePause: unknown };
  expect(view.id).toBe(routine.id);
  expect(view.state).not.toBe("usage_paused");
  expect(view.usagePause).toBeNull();
});
