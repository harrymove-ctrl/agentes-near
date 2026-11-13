import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { closeRoutineRun, reapRoutineRuns, routineFailureCode, setRoutineActive } from "../src";
import { type Fixture, setup } from "./fixtures";
import {
  agentRunRow,
  channelRoutine,
  fire,
  minutesFromNow,
  notificationsOf,
  routineDeps,
  routineRow,
  routineRunRow,
} from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const ledger = () => ({ db: f.db, pubsub: f.pubsub });

test("fatigue: the first failure after a good run notifies once, the fifth in a row pauses; a good run resets", async () => {
  f = await setup();
  const routine = await channelRoutine(f);
  const failOnce = async (minutesAgo: number) => {
    const rr = await fire(f, routine.id, minutesFromNow(-minutesAgo));
    const run = await agentRunRow(f, rr.agentRunId);
    await closeRoutineRun(ledger(), run, { status: "failed", code: "provider_error", detail: "provider_error: 529" });
    await f.db.update(schema.agentRuns).set({ status: "failed" }).where(eq(schema.agentRuns.id, run.id));
    return routineRunRow(f, rr.id);
  };

  expect(await failOnce(60)).toMatchObject({
    status: "failed",
    code: "provider_error",
    summary: "provider_error: 529",
  });
  expect(await routineRow(f, routine.id)).toMatchObject({ failuresInRow: 1, active: true });
  const failed = await notificationsOf(f, "routine_failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]).toMatchObject({ userId: f.owner.id, source: { routineId: routine.id } });
  // The coded reason for the app to say in the person's language; never the server's English.
  expect(failed[0]?.latest).toEqual({ title: "Avaliações", reason: "provider_error" });

  for (const minutesAgo of [50, 40, 30]) await failOnce(minutesAgo);
  expect(await routineRow(f, routine.id)).toMatchObject({ failuresInRow: 4, active: true, pausedReason: null });
  expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);

  await failOnce(20);
  expect(await routineRow(f, routine.id)).toMatchObject({
    failuresInRow: 5,
    active: false,
    nextRunAt: null,
    pausedReason: "failing",
  });
  const paused = await notificationsOf(f, "routine_paused");
  expect(paused).toHaveLength(1);
  expect(paused[0]?.latest).toMatchObject({ reason: "failing" });

  // Resumed by a person: the reason and the streak are cleared, the pause notification is done.
  await setRoutineActive(routineDeps(f), f.owner.id, f.org.id, routine.id, true);
  expect(await routineRow(f, routine.id)).toMatchObject({ failuresInRow: 0, active: true, pausedReason: null });
  expect((await notificationsOf(f, "routine_paused"))[0]?.doneAt).not.toBeNull();

  // A good run ends the streak's notification.
  const good = await fire(f, routine.id, minutesFromNow(-10));
  await closeRoutineRun(ledger(), await agentRunRow(f, good.agentRunId), { status: "done", text: "Tudo certo." });
  expect(await routineRunRow(f, good.id)).toMatchObject({ status: "silent", summary: "Tudo certo." });
  expect((await notificationsOf(f, "routine_failed"))[0]?.doneAt).not.toBeNull();
  expect(await routineRow(f, routine.id)).toMatchObject({ failuresInRow: 0 });
});

test("every ending closes the ledger once; a run that reported stays reported", async () => {
  f = await setup();
  const routine = await channelRoutine(f);
  const rr = await fire(f, routine.id, minutesFromNow(-30));
  const run = await agentRunRow(f, rr.agentRunId);
  expect(await closeRoutineRun(ledger(), run, { status: "canceled", code: "stopped", byUserId: f.owner.id })).toEqual({
    routineId: routine.id,
    routineRunId: rr.id,
    status: "canceled",
  });
  // Ended already: a second ending changes nothing.
  expect(await closeRoutineRun(ledger(), run, { status: "failed", code: "provider_error" })).toBeNull();
  expect(await routineRunRow(f, rr.id)).toMatchObject({ status: "canceled", code: "stopped", summary: f.owner.id });
  await f.db.update(schema.agentRuns).set({ status: "canceled" }).where(eq(schema.agentRuns.id, run.id));

  // People heard its report: a failure after it keeps it reported (and counts as a good run).
  const reported = await fire(f, routine.id, minutesFromNow(-20));
  await f.db
    .update(schema.routineRuns)
    .set({ status: "reported", summary: "Relatório" })
    .where(eq(schema.routineRuns.id, reported.id));
  const reportedRun = await agentRunRow(f, reported.agentRunId);
  expect(await closeRoutineRun(ledger(), reportedRun, { status: "failed", code: "too_many_tool_calls" })).toMatchObject(
    { status: "reported" },
  );
  expect(await routineRunRow(f, reported.id)).toMatchObject({ status: "reported", code: null, summary: "Relatório" });
  expect(await routineRow(f, routine.id)).toMatchObject({ failuresInRow: 0 });

  // A run that isn't a routine's has no ledger.
  expect(
    await closeRoutineRun(ledger(), { ...reportedRun, background: false }, { status: "done", text: "" }),
  ).toBeNull();
});

test("run errors become coded reasons", () => {
  expect(routineFailureCode("budget_exceeded")).toBe("budget_exceeded");
  expect(routineFailureCode("provider_error: overloaded")).toBe("provider_error");
  expect(routineFailureCode("runner_outdated")).toBe("runner_outdated");
  expect(routineFailureCode("Add an API key for Anthropic in the workspace settings")).toBe("missing_credential");
  expect(routineFailureCode("Something odd happened")).toBe("error");
  expect(routineFailureCode(null)).toBe("error");
});

test("the reaper closes rows whose run ended, fails rows whose job died, and starts a gathered run", async () => {
  f = await setup();
  const routine = await channelRoutine(f);
  const old = minutesFromNow(-10);

  // Its agent run failed and nothing closed the row.
  const ended = await fire(f, routine.id, minutesFromNow(-60));
  await f.db
    .update(schema.agentRuns)
    .set({ status: "failed", error: "provider_error: 529", updatedAt: old })
    .where(eq(schema.agentRuns.id, ended.agentRunId ?? ""));

  // Queued, but its job is gone (it failed for good).
  const [lost] = await f.db
    .insert(schema.routineRuns)
    .values({ orgId: f.org.id, routineId: routine.id, at: minutesFromNow(-50), trigger: "schedule", createdAt: old })
    .returning();
  // Queued with its job alive: left alone.
  const [alive] = await f.db
    .insert(schema.routineRuns)
    .values({ orgId: f.org.id, routineId: routine.id, at: minutesFromNow(-40), trigger: "schedule", createdAt: old })
    .returning();
  await f.db.insert(schema.outbox).values({
    orgId: f.org.id,
    kind: "routine.run",
    payload: { routineRunId: alive?.id },
    dedupeKey: `routine.run:${alive?.id}`,
    nextAttemptAt: minutesFromNow(60),
  });
  // Gathered while another worked; that one is gone now.
  const [gathered] = await f.db
    .insert(schema.routineRuns)
    .values({
      orgId: f.org.id,
      routineId: routine.id,
      at: minutesFromNow(-30),
      trigger: "event",
      event: { type: "github.pr_opened", summary: "PR #3", gathered: true },
      createdAt: old,
    })
    .returning();

  expect(await reapRoutineRuns(ledger())).toBe(2);
  expect(await routineRunRow(f, ended.id)).toMatchObject({
    status: "failed",
    code: "provider_error",
    summary: "provider_error: 529",
  });
  expect(await routineRunRow(f, lost?.id ?? "")).toMatchObject({ status: "failed", code: "lost" });
  expect(await routineRunRow(f, alive?.id ?? "")).toMatchObject({ status: "queued" });
  // The queued run with a live job is working: the gathered one keeps waiting for it.
  expect((await routineRunRow(f, gathered?.id ?? "")).event).toMatchObject({ gathered: true });

  await f.db.delete(schema.outbox).where(eq(schema.outbox.dedupeKey, `routine.run:${alive?.id}`));
  await f.db
    .update(schema.routineRuns)
    .set({ status: "skipped", code: "previous_running" })
    .where(eq(schema.routineRuns.id, alive?.id ?? ""));
  await reapRoutineRuns(ledger());
  expect((await routineRunRow(f, gathered?.id ?? "")).event).not.toHaveProperty("gathered");
  const jobs = await f.db
    .select()
    .from(schema.outbox)
    .where(eq(schema.outbox.dedupeKey, `routine.run:${gathered?.id}`));
  expect(jobs).toHaveLength(1);
  // Closed rows stay closed: the next tick finds nothing.
  expect(await reapRoutineRuns(ledger())).toBe(0);
});
