import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  closeRoutineRun,
  deleteRoutine,
  executeRoutineRun,
  ForbiddenError,
  queueRoutineRun,
  removeMember,
  resumeRunsWaitingForMachine,
  setRoutineActive,
  stopRoutineRun,
  takeOverRoutine,
} from "../src";
import * as ledgerModule from "../src/routine-ledger";
import { addMember, type Fixture, setup } from "./fixtures";
import {
  agentRunRow,
  briefs,
  channelRoutine,
  fire,
  messagesIn,
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
const agentRunsOf = async () => f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);

describe("the claim", () => {
  test("a routine run starts once: a second execution of its job does nothing; a retried claim takes it back", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const queued = await queueRoutineRun({ db: f.db }, await routineRow(f, routine.id), new Date(), "manual");
    await executeRoutineRun(routineDeps(f), queued?.id ?? "");
    await executeRoutineRun(routineDeps(f), queued?.id ?? "");
    expect(await agentRunsOf()).toHaveLength(1);
    expect(await routineRunRow(f, queued?.id ?? "")).toMatchObject({ status: "started" });

    // Its worker died after the claim, before any run started: the retried job takes it back.
    const again = await queueRoutineRun({ db: f.db }, await routineRow(f, routine.id), minutesFromNow(1), "manual");
    await f.db.update(schema.agentRuns).set({ status: "done" });
    await f.db
      .update(schema.routineRuns)
      .set({ status: "starting" })
      .where(eq(schema.routineRuns.id, again?.id ?? ""));
    await executeRoutineRun(routineDeps(f), again?.id ?? "");
    expect(await routineRunRow(f, again?.id ?? "")).toMatchObject({ status: "started" });
    expect(await agentRunsOf()).toHaveLength(2);
  });
});

describe("structural checks pause the routine with its reason and one notification", () => {
  const firedAfter = async (change: (routineId: string) => Promise<unknown>) => {
    const routine = await channelRoutine(f);
    await change(routine.id);
    const rr = await fire(f, routine.id, new Date());
    return { rr, routine: await routineRow(f, routine.id) };
  };

  test("agent archived", async () => {
    f = await setup();
    const { rr, routine } = await firedAfter(() =>
      f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id)),
    );
    expect(rr).toMatchObject({ status: "skipped", code: "agent_archived", agentRunId: null });
    expect(routine).toMatchObject({ active: false, nextRunAt: null, pausedReason: "agent_archived" });
    const paused = await notificationsOf(f, "routine_paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ userId: f.owner.id, latest: { reason: "agent_archived" } });
  });

  test("agent no longer in the channel; creator no longer able to post there", async () => {
    f = await setup();
    const out = await firedAfter(() =>
      f.db.delete(schema.channelMembers).where(eq(schema.channelMembers.agentId, f.agent.id)),
    );
    expect(out.rr).toMatchObject({ status: "skipped", code: "agent_not_in_channel" });
    expect(out.routine.pausedReason).toBe("agent_not_in_channel");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: f.agent.id });
    const left = await firedAfter(() =>
      f.db.delete(schema.channelMembers).where(eq(schema.channelMembers.userId, f.owner.id)),
    );
    expect(left.rr).toMatchObject({ status: "skipped", code: "creator_no_access" });
    expect(left.routine.pausedReason).toBe("creator_no_access");
    expect(await briefs(f)).toEqual([]);
  });

  test("a member removed from the organization: their routines pause and stop, the agent's owner hears it", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const routine = await channelRoutine(f, {}, bia.id);
    const rr = await fire(f, routine.id, new Date());
    await removeMember(f.db, f.owner.id, f.org.id, bia.id, { pubsub: f.pubsub });
    expect(await routineRow(f, routine.id)).toMatchObject({ active: false, pausedReason: "creator_left" });
    expect(await routineRunRow(f, rr.id)).toMatchObject({ status: "canceled", code: "creator_left" });
    expect((await agentRunRow(f, rr.agentRunId)).status).toBe("canceled");
    const paused = await notificationsOf(f, "routine_paused");
    expect(paused.map((n) => n.userId)).toEqual([f.owner.id]);
  });
});

describe("one run at a time", () => {
  test("the previous run still works: the slot is skipped", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    await fire(f, routine.id, minutesFromNow(-60), "schedule");
    const second = await fire(f, routine.id, minutesFromNow(-30), "schedule");
    expect(second).toMatchObject({ status: "skipped", code: "previous_running", agentRunId: null });
    expect(await agentRunsOf()).toHaveLength(1);
  });

  test("waiting for a person: kept through one slot, replaced at the next (its approvals expire)", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const first = await fire(f, routine.id, minutesFromNow(-180), "schedule");
    const waiting = await agentRunRow(f, first.agentRunId);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_approval", updatedAt: minutesFromNow(-179) })
      .where(eq(schema.agentRuns.id, waiting.id));
    const [approval] = await f.db
      .insert(schema.approvals)
      .values({
        orgId: f.org.id,
        runId: waiting.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: waiting.threadRootId,
        toolUseId: "tu_1",
        tool: "github_merge",
        scope: "github:write",
        params: {},
        actionHash: "h",
        title: "Merge PR #42",
        expiresAt: minutesFromNow(600),
      })
      .returning();

    const second = await fire(f, routine.id, minutesFromNow(-120), "schedule");
    expect(second).toMatchObject({ status: "skipped", code: "previous_waiting" });
    expect(await routineRunRow(f, first.id)).toMatchObject({ status: "started" });

    const third = await fire(f, routine.id, minutesFromNow(-60), "schedule");
    expect(third).toMatchObject({ status: "started" });
    expect(await routineRunRow(f, first.id)).toMatchObject({ status: "superseded", code: "superseded" });
    expect((await agentRunRow(f, waiting.id)).status).toBe("canceled");
    const [expired] = await f.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approval?.id ?? ""));
    expect(expired?.status).toBe("canceled");
    // Quietly: nothing was posted where it reports.
    expect(await messagesIn(f, f.general.id)).toEqual([]);
  });

  test("waiting for its computer: the next slot replaces it and the routine's people hear it once per outage", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const [machine] = await f.db
      .insert(schema.machines)
      .values({ orgId: f.org.id, name: "MacBook da Ana", lastSeenAt: minutesFromNow(-300) })
      .returning();
    const park = (agentRunId: string | null) =>
      f.db
        .update(schema.agentRuns)
        .set({ status: "waiting_input", waitingMachineId: machine?.id })
        .where(eq(schema.agentRuns.id, agentRunId ?? ""));

    const first = await fire(f, routine.id, minutesFromNow(-180), "schedule");
    await park(first.agentRunId);
    const second = await fire(f, routine.id, minutesFromNow(-120), "schedule");
    expect(second).toMatchObject({ status: "started" });
    expect(await routineRunRow(f, first.id)).toMatchObject({ status: "superseded", code: "waiting_computer" });
    expect((await agentRunRow(f, first.agentRunId)).status).toBe("canceled");

    await park(second.agentRunId);
    const third = await fire(f, routine.id, minutesFromNow(-60), "schedule");
    expect(await routineRunRow(f, second.id)).toMatchObject({ status: "superseded", code: "waiting_computer" });
    const stalled = await notificationsOf(f, "routine_stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({
      userId: f.owner.id,
      source: { routineId: routine.id, machineId: machine?.id },
      latest: { text: "MacBook da Ana" },
    });

    // The next good run resolves it.
    await closeRoutineRun(ledger(), await agentRunRow(f, third.agentRunId), { status: "done", text: "ok" });
    expect((await notificationsOf(f, "routine_stalled"))[0]?.doneAt).not.toBeNull();
  });

  test("in line for room on a full computer: it keeps its place, the next slot gives way and nobody hears of a stall", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const [machine] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "Acme Mac" }).returning();
    const first = await fire(f, routine.id, minutesFromNow(-180), "schedule");
    await f.db
      .update(schema.agentRuns)
      .set({
        status: "waiting_input",
        waitingMachineId: machine?.id,
        transcript: { messages: [], waitingForBrain: { code: "busy", waitId: "w1" }, roomWaitSince: Date.now() },
      })
      .where(eq(schema.agentRuns.id, first.agentRunId ?? ""));

    const second = await fire(f, routine.id, minutesFromNow(-120), "schedule");
    expect(second).toMatchObject({ status: "skipped", code: "previous_waiting" });
    expect(await routineRunRow(f, first.id)).toMatchObject({ status: "started" });
    expect((await agentRunRow(f, first.agentRunId)).status).toBe("waiting_input");
    expect(await notificationsOf(f, "routine_stalled")).toEqual([]);
  });

  test("a computer online that can't take the turn (an old runner, its plan's limit) notifies once, not every slot", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const [machine] = await f.db
      .insert(schema.machines)
      .values({ orgId: f.org.id, name: "MacBook da Ana" })
      .returning();
    const park = async (agentRunId: string | null) => {
      await f.db
        .update(schema.agentRuns)
        .set({ status: "waiting_input", waitingMachineId: machine?.id })
        .where(eq(schema.agentRuns.id, agentRunId ?? ""));
      // Online: it answers every ping, so its last sign of life moves on every slot.
      await f.db.update(schema.machines).set({ lastSeenAt: new Date() });
    };
    let last = await fire(f, routine.id, minutesFromNow(-240), "schedule");
    for (const at of [-180, -120, -60]) {
      await park(last.agentRunId);
      last = await fire(f, routine.id, minutesFromNow(at), "schedule");
    }
    expect(await notificationsOf(f, "routine_stalled")).toHaveLength(1);
    // It runs again, then the next outage is news again.
    await closeRoutineRun(ledger(), await agentRunRow(f, last.agentRunId), { status: "done", text: "ok" });
    const next = await fire(f, routine.id, minutesFromNow(-30), "schedule");
    await park(next.agentRunId);
    await fire(f, routine.id, minutesFromNow(-10), "schedule");
    const stalled = await notificationsOf(f, "routine_stalled");
    expect(stalled).toHaveLength(2);
    expect(stalled.filter((n) => n.doneAt === null)).toHaveLength(1);
  });

  test("a computer back after more than 12 hours: the stale run is missed, a fresh one resumes", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const machineId = crypto.randomUUID();
    const park = (agentRunId: string | null) =>
      f.db
        .update(schema.agentRuns)
        .set({ status: "waiting_input", waitingMachineId: machineId })
        .where(eq(schema.agentRuns.id, agentRunId ?? ""));
    const stale = await fire(f, routine.id, minutesFromNow(-13 * 60), "schedule");
    await park(stale.agentRunId);
    expect(await resumeRunsWaitingForMachine(f.db, machineId, { pubsub: f.pubsub })).toEqual([]);
    expect(await routineRunRow(f, stale.id)).toMatchObject({ status: "missed", code: "stale" });
    expect((await agentRunRow(f, stale.agentRunId)).status).toBe("canceled");

    const fresh = await fire(f, routine.id, minutesFromNow(-60), "schedule");
    await park(fresh.agentRunId);
    expect(await resumeRunsWaitingForMachine(f.db, machineId, { pubsub: f.pubsub })).toEqual([fresh.agentRunId ?? ""]);
    expect(await routineRunRow(f, fresh.id)).toMatchObject({ status: "started" });
  });
});

describe("stop, pause and delete end the work in progress quietly", () => {
  test("Stop: canceled with who stopped it; pausing and deleting stop it too", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const deps = routineDeps(f);

    const stopped = await fire(f, routine.id, minutesFromNow(-60));
    expect(await stopRoutineRun(deps, f.owner.id, f.org.id, routine.id)).toEqual({ stopped: 1 });
    expect(await routineRunRow(f, stopped.id)).toMatchObject({
      status: "canceled",
      code: "stopped",
      summary: f.owner.id,
    });
    expect((await agentRunRow(f, stopped.agentRunId)).status).toBe("canceled");
    expect(await routineRow(f, routine.id)).toMatchObject({ active: true });
    expect(await stopRoutineRun(deps, f.owner.id, f.org.id, routine.id)).toEqual({ stopped: 0 });

    const paused = await fire(f, routine.id, minutesFromNow(-50));
    await setRoutineActive(deps, f.owner.id, f.org.id, routine.id, false);
    expect(await routineRunRow(f, paused.id)).toMatchObject({ status: "canceled", code: "paused" });
    expect((await agentRunRow(f, paused.agentRunId)).status).toBe("canceled");

    await setRoutineActive(deps, f.owner.id, f.org.id, routine.id, true);
    const deleted = await fire(f, routine.id, minutesFromNow(-40));
    await deleteRoutine(deps, f.owner.id, f.org.id, routine.id);
    expect(await routineRunRow(f, deleted.id)).toMatchObject({ status: "canceled", code: "deleted" });
    expect((await agentRunRow(f, deleted.agentRunId)).status).toBe("canceled");
    expect(await messagesIn(f, f.general.id)).toEqual([]);
  });

  test("Stop racing a start: the agent run the start got is stopped too", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const queued = await queueRoutineRun({ db: f.db }, await routineRow(f, routine.id), minutesFromNow(-5), "manual");
    // Claimed, not started yet: Stop reads it without an agent run.
    await f.db
      .update(schema.routineRuns)
      .set({ status: "starting" })
      .where(eq(schema.routineRuns.id, queued?.id ?? ""));
    const realEnd = ledgerModule.endRoutineRun;
    const spy = spyOn(ledgerModule, "endRoutineRun").mockImplementationOnce(async (deps, ref, end) => {
      // Its start commits first: the routine run is started, with its agent run.
      await executeRoutineRun(routineDeps(f), queued?.id ?? "");
      return realEnd(deps, ref, end);
    });
    try {
      expect(await stopRoutineRun(routineDeps(f), f.owner.id, f.org.id, routine.id)).toEqual({ stopped: 1 });
    } finally {
      spy.mockRestore();
    }
    const row = await routineRunRow(f, queued?.id ?? "");
    expect(row).toMatchObject({ status: "canceled", code: "stopped" });
    expect(row.agentRunId).not.toBeNull();
    expect((await agentRunRow(f, row.agentRunId)).status).toBe("canceled");
  });

  test("only its creator, the agent's owner or an admin can stop it", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    const carl = await addMember(f.db, f.org.id, "member", "carl");
    await expect(stopRoutineRun(routineDeps(f), carl.id, f.org.id, routine.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("take over", () => {
  test("an admin becomes the creator after the audience check; the pause reason is cleared", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    await f.db
      .update(schema.routines)
      .set({ active: false, pausedReason: "creator_left", createdByUserId: null })
      .where(eq(schema.routines.id, routine.id));
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    const carl = await addMember(f.db, f.org.id, "member", "carl");
    // Not in the conversation it reports to yet.
    await expect(takeOverRoutine(routineDeps(f), bia.id, f.org.id, routine.id)).rejects.toMatchObject({
      code: "routine.take_over_no_access",
    });
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    await takeOverRoutine(routineDeps(f), bia.id, f.org.id, routine.id);
    expect(await routineRow(f, routine.id)).toMatchObject({
      createdByUserId: bia.id,
      pausedReason: null,
      active: false,
    });
    await expect(takeOverRoutine(routineDeps(f), carl.id, f.org.id, routine.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
