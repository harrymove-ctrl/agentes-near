import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  calendarRange,
  createChannel,
  createRoutine,
  getRoutineView,
  insertMessage,
  listRoutineRuns,
  listRoutines,
  MAX_ACTIVE_ROUTINES,
  nextCronTime,
  normalizeRule,
  ruleOccurrences,
  type ScheduleRule,
  updateRoutine,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const routineDeps = () => ({ db: f.db, pubsub: f.pubsub, context: f.context });
const HOUR = 3600_000;
type AgentRunRow = typeof schema.agentRuns.$inferSelect;

/** A routine's background agent run in a given state (rows only: no job runs it). */
async function agentRun(status: AgentRunRow["status"], extra: Partial<AgentRunRow> = {}) {
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 0,
      status,
      background: true,
      ...extra,
    })
    .returning();
  return run as AgentRunRow;
}

/** One firing of a routine, `hoursAgo` (its slot and creation time). */
async function routineRun(
  routineId: string,
  hoursAgo: number,
  values: Partial<typeof schema.routineRuns.$inferInsert> = {},
) {
  const at = new Date(Date.now() - hoursAgo * HOUR);
  const [run] = await f.db
    .insert(schema.routineRuns)
    .values({ orgId: f.org.id, routineId, at, createdAt: at, trigger: "schedule", ...values })
    .returning();
  return run as typeof schema.routineRuns.$inferSelect;
}

async function usage(runId: string, tokens: number, billedTo: string, costNanoUsd = 0) {
  await f.db.insert(schema.usageRecords).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    runId,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    requestedModel: "claude-sonnet-5-5",
    inputTokens: tokens,
    outputTokens: 0,
    costNanoUsd,
    billedTo,
  });
}

const daily = (phrase = "todo dia às 9h") => ({ type: "schedule" as const, phrase });

describe("routine views", () => {
  test("readers see prompt, records and links; outsiders see outcomes only, and no prompt for a private routine", async () => {
    f = await setup();
    const finance = await createChannel(f.db, f.owner.id, f.org.id, { name: "financeiro", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, finance.id, { agentId: f.agent.id });
    const open = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resuma o dia.",
      target: { type: "channel", channelId: f.general.id },
      trigger: daily(),
    });
    const closed = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Veja faturas atrasadas.",
      target: { type: "channel", channelId: finance.id },
      trigger: daily(),
    });
    const report = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: finance.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "A fatura 812 está atrasada.",
    });
    const done = await agentRun("done");
    await routineRun(closed.id, 1, {
      status: "reported",
      summary: "Fatura 812 atrasada (cliente Acme).",
      agentRunId: done.id,
      messageId: report.id,
      brain: "model",
      finishedAt: new Date(),
    });
    await routineRun(open.id, 1, { status: "silent", summary: "Nada de novo." });

    const asOwner = await listRoutines(f.db, f.owner.id, f.org.id);
    const mine = asOwner.find((r) => r.id === closed.id);
    expect(mine).toMatchObject({ prompt: "Veja faturas atrasadas.", canSeeDetails: true, canManage: true });
    expect(mine?.lastRun).toMatchObject({
      status: "reported",
      summary: "Fatura 812 atrasada (cliente Acme).",
      brain: "model",
      link: { channelId: finance.id, threadId: null, messageId: report.id },
    });
    expect(mine?.lastRun?.finishedAt).not.toBeNull();

    // A member in neither conversation: outcomes only; the public channel's instructions stay visible.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const asBia = await listRoutines(f.db, bia.id, f.org.id);
    const hidden = asBia.find((r) => r.id === closed.id);
    expect(hidden).toMatchObject({ prompt: null, canSeeDetails: false, canManage: false });
    expect(hidden?.lastRun).toMatchObject({ status: "reported", summary: "", link: null });
    const shown = asBia.find((r) => r.id === open.id);
    expect(shown).toMatchObject({ prompt: "Resuma o dia.", canSeeDetails: false });
    expect(shown?.lastRun).toMatchObject({ status: "silent", summary: "" });
    expect((await listRoutineRuns(f.db, bia.id, f.org.id, closed.id))[0]).toMatchObject({ summary: "", link: null });

    // Joining the conversation makes her a reader (not a manager).
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    expect(await getRoutineView(f.db, bia.id, f.org.id, open.id)).toMatchObject({
      canSeeDetails: true,
      canManage: false,
      lastRun: { summary: "Nada de novo." },
    });
  });

  test("state, waiting computer, week health, plan usage, weights by tokens, stopper's name and approval", async () => {
    f = await setup();
    const [machine] = await f.db
      .insert(schema.machines)
      .values({ orgId: f.org.id, name: "MacBook da Ana" })
      .returning();
    await f.db
      .update(schema.agents)
      .set({ brain: "claude_code", machineId: machine?.id })
      .where(eq(schema.agents.id, f.agent.id));
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Veja os erros novos.",
      target: { type: "channel", channelId: f.general.id },
      trigger: daily(),
      access: "act",
      report: "always",
    });
    expect(routine).toMatchObject({ access: "act", report: "always", state: "active", failuresInRow: 0 });

    const reported = await agentRun("done");
    await usage(reported.id, 1200, "plan");
    await routineRun(routine.id, 1, { status: "reported", agentRunId: reported.id, brain: "claude_code" });
    const failed = await agentRun("failed", { error: "provider_error: overloaded" });
    await usage(failed.id, 300, "plan");
    await routineRun(routine.id, 2, { status: "failed", code: "provider_error", agentRunId: failed.id });
    await routineRun(routine.id, 3, { status: "skipped", code: "previous_running" });
    const stopped = await agentRun("canceled", { error: `canceled_by:${f.owner.id}` });
    await routineRun(routine.id, 4, { status: "canceled", code: "stopped", agentRunId: stopped.id });
    const asking = await agentRun("waiting_approval");
    const [approval] = await f.db
      .insert(schema.approvals)
      .values({
        orgId: f.org.id,
        runId: asking.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: asking.threadRootId,
        toolUseId: "tool-1",
        tool: "github_merge",
        scope: "github:pr.merge",
        params: {},
        actionHash: "hash",
        title: "Merge PR #7",
        why: "Tests pass and the fix is small.",
        expiresAt: new Date(Date.now() + HOUR),
      })
      .returning();
    await routineRun(routine.id, 5, { status: "started", agentRunId: asking.id });
    // Ten days ago: outside the week.
    await routineRun(routine.id, 240, { status: "silent" });
    // The newest run waits for the computer.
    const away = await agentRun("waiting_input", { waitingMachineId: machine?.id });
    await routineRun(routine.id, 0.5, { status: "started", agentRunId: away.id });

    const view = await getRoutineView(f.db, f.owner.id, f.org.id, routine.id);
    expect(view.state).toBe("waiting_computer");
    expect(view.waitingFor).toMatchObject({ machineId: machine?.id, machineName: "MacBook da Ana" });
    expect(view.brain).toEqual({ kind: "claude_code", machineName: "MacBook da Ana" });
    // The run a person stopped counts nowhere: the week adds up.
    expect(view.health).toEqual({ ok: 1, silent: 0, failed: 1, skipped: 1, missed: 0, total: 3 });
    expect(view.usage).toEqual({ runs: 5, tokens: 1500, costNanoUsd: 0, billedTo: "plan" });
    const byStatus = Object.fromEntries(view.recentRuns.map((r) => [r.code ?? r.status, r]));
    expect(view.recentRuns.map((r) => r.status)).toEqual([
      "waiting",
      "reported",
      "failed",
      "skipped",
      "canceled",
      "waiting",
      "silent",
    ]);
    // A plan costs nothing: the strip weighs tokens.
    expect(byStatus.provider_error?.weight).toBe(0.25);
    expect(view.recentRuns[1]?.weight).toBe(1);
    expect(byStatus.stopped?.codeParams).toEqual({ by: "ana" });
    expect(view.recentRuns[5]?.approvalId).toBe(approval?.id);
    expect(view.recentRuns[0]?.approvalId).toBeNull();
    // Waiting for its computer, or for a person: the app says which.
    expect(view.recentRuns[0]).toMatchObject({ status: "waiting", code: "waiting_computer" });
    expect(view.recentRuns[5]).toMatchObject({ status: "waiting", code: null });

    // Someone who doesn't read it never gets the approval to open.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const outside = await getRoutineView(f.db, bia.id, f.org.id, routine.id);
    expect(outside.recentRuns[5]).toMatchObject({ status: "waiting", approvalId: null, summary: "" });

    // A provider's failure says its cause to who reads the records, and only the outcome to anyone else.
    const noCredit = await agentRun("failed", { error: "provider_error: no_credit@OpenRouter: Insufficient credits" });
    await routineRun(routine.id, 0.1, { status: "failed", code: "provider_error", agentRunId: noCredit.id });
    const read = await getRoutineView(f.db, f.owner.id, f.org.id, routine.id);
    expect(read.recentRuns[0]).toMatchObject({
      code: "provider_no_credit",
      codeParams: { provider: "OpenRouter", detail: "Insufficient credits" },
    });
    const notRead = await getRoutineView(f.db, bia.id, f.org.id, routine.id);
    expect(notRead.recentRuns[0]?.code).toBe("provider_error");
    expect(notRead.recentRuns[0]?.codeParams).toBeUndefined();
    await f.db.delete(schema.routineRuns).where(eq(schema.routineRuns.agentRunId, noCredit.id));

    // Its agent run answered: no longer waiting; a failure streak shows as failing.
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, away.id));
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, asking.id));
    await f.db.update(schema.routines).set({ failuresInRow: 2 }).where(eq(schema.routines.id, routine.id));
    expect((await getRoutineView(f.db, f.owner.id, f.org.id, routine.id)).state).toBe("failing");
  });

  test("a run at work comes first: a paused routine's manual run, a one-off's run after it fired", async () => {
    f = await setup();
    const [machine] = await f.db
      .insert(schema.machines)
      .values({ orgId: f.org.id, name: "MacBook da Ana" })
      .returning();
    // Inactive: paused by a person, or a one-off once it fired.
    const deactivate = (id: string) =>
      f.db.update(schema.routines).set({ active: false, nextRunAt: null }).where(eq(schema.routines.id, id));
    const paused = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resumo.",
      target: { type: "channel", channelId: f.general.id },
      trigger: daily(),
    });
    await deactivate(paused.id);
    const manual = await agentRun("running");
    await routineRun(paused.id, 0.1, { status: "started", trigger: "manual", agentRunId: manual.id });
    const view = () => getRoutineView(f.db, f.owner.id, f.org.id, paused.id);
    expect(await view()).toMatchObject({ active: false, state: "running" });
    await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_input", waitingMachineId: machine?.id })
      .where(eq(schema.agentRuns.id, manual.id));
    expect(await view()).toMatchObject({
      state: "waiting_computer",
      waitingFor: { machineId: machine?.id, machineName: "MacBook da Ana" },
    });
    // Its run ended: paused again.
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, manual.id));
    expect((await view()).state).toBe("paused");

    // A one-off is inactive as soon as it fires; while its run waits for a person, that is what it says.
    const once = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Veja o deploy.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "once", at: new Date(Date.now() + HOUR).toISOString() },
    });
    await deactivate(once.id);
    const asking = await agentRun("waiting_approval");
    await routineRun(once.id, 0.1, { status: "started", agentRunId: asking.id });
    expect(await getRoutineView(f.db, f.owner.id, f.org.id, once.id)).toMatchObject({
      active: false,
      state: "waiting_person",
    });
  });

  test("the week adds up: a replaced slot is a skip, as in the strip; a run a person stopped counts nowhere", async () => {
    f = await setup();
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Veja os erros novos.",
      target: { type: "channel", channelId: f.general.id },
      trigger: daily(),
    });
    const ended = [
      { status: "reported" },
      { status: "silent" },
      { status: "failed", code: "provider_error" },
      { status: "skipped", code: "previous_running" },
      { status: "superseded", code: "waiting_computer" },
      { status: "missed", code: "stale" },
      { status: "canceled", code: "stopped" },
    ];
    for (const [i, run] of ended.entries()) await routineRun(routine.id, i + 1, { ...run, finishedAt: new Date() });
    const view = await getRoutineView(f.db, f.owner.id, f.org.id, routine.id);
    expect(view.health).toEqual({ ok: 1, silent: 1, failed: 1, skipped: 2, missed: 1, total: 6 });
    expect(view.recentRuns.map((r): string => r.status)).toEqual(ended.map((r) => r.status));
  });

  test("emails held for the next email are no run: the routine isn't busy and no list shows them", async () => {
    f = await setup();
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Leia os emails novos.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "event", event: "issue.created" },
    });
    const failed = await agentRun("failed", { error: "provider_error: overloaded" });
    await routineRun(routine.id, 1, { status: "failed", code: "provider_error", agentRunId: failed.id });
    await f.db.update(schema.routines).set({ failuresInRow: 1 }).where(eq(schema.routines.id, routine.id));
    // Its emails wait for the next email: queued on purpose, with no job to stop.
    const held = await routineRun(routine.id, 0.5, {
      trigger: "event",
      event: { type: "email.received", summary: "2 emails", held: true },
    });
    const view = await getRoutineView(f.db, f.owner.id, f.org.id, routine.id);
    expect(view.state).toBe("failing");
    expect(view.recentRuns.map((r) => r.status)).toEqual(["failed"]);
    expect((await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id)).map((r) => r.id)).not.toContain(held.id);
    // The next email starts them: then it is a run in the queue like any other.
    await f.db
      .update(schema.routineRuns)
      .set({ event: { type: "email.received", summary: "3 emails" } })
      .where(eq(schema.routineRuns.id, held.id));
    expect((await getRoutineView(f.db, f.owner.id, f.org.id, routine.id)).state).toBe("running");
  });

  test("an agent hidden from a person hides its routines too: Rotinas, Início, one routine, the calendar", async () => {
    f = await setup();
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      name: "Relatório diário de custos",
      agentId: f.agent.id,
      prompt: "Resuma os custos.",
      target: { type: "channel", channelId: f.general.id },
      trigger: daily(),
    });
    const outsider = await addMember(f.db, f.org.id, "member", "caio");
    const insider = await addMember(f.db, f.org.id, "member", "dora");
    const admin = await addMember(f.db, f.org.id, "admin", "edu");
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "people", audienceUserIds: [insider.id] })
      .where(eq(schema.agents.id, f.agent.id));
    const range = (userId: string) =>
      calendarRange({ db: f.db }, userId, f.org.id, "2099-01-05T00:00:00Z", "2099-01-09T00:00:00Z");
    const names = async (userId: string) => (await listRoutines(f.db, userId, f.org.id)).map((r) => r.name);

    expect(await names(outsider.id)).toEqual([]);
    await expect(getRoutineView(f.db, outsider.id, f.org.id, routine.id)).rejects.toThrow("Routine not found");
    await expect(listRoutineRuns(f.db, outsider.id, f.org.id, routine.id)).rejects.toThrow("Routine not found");
    expect((await range(outsider.id)).routines).toEqual([]);

    for (const who of [insider.id, admin.id, f.owner.id]) {
      expect(await names(who)).toEqual(["Relatório diário de custos"]);
      expect((await range(who)).routines.length).toBe(4);
    }
    // Only its owner: the member who was let in no longer sees it either.
    await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
    expect(await names(insider.id)).toEqual([]);
    expect(await names(admin.id)).toEqual(["Relatório diário de custos"]);
  });

  test("a paused routine shows its reason; resuming clears the reason and the failure streak", async () => {
    f = await setup();
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resumo.",
      target: { type: "channel", channelId: f.general.id },
      trigger: daily(),
    });
    await f.db
      .update(schema.routines)
      .set({ active: false, nextRunAt: null, pausedReason: "failing", failuresInRow: 5 })
      .where(eq(schema.routines.id, routine.id));
    expect(await getRoutineView(f.db, f.owner.id, f.org.id, routine.id)).toMatchObject({
      state: "paused",
      pausedReason: "failing",
      failuresInRow: 5,
    });
    const resumed = await updateRoutine(routineDeps(), f.owner.id, f.org.id, routine.id, { active: true });
    expect(resumed).toMatchObject({ state: "active", active: true, pausedReason: null, failuresInRow: 0 });
    expect(resumed.nextRunAt).not.toBeNull();
    // Access and report change on their own.
    expect(
      await updateRoutine(routineDeps(), f.owner.id, f.org.id, routine.id, { access: "act", report: "always" }),
    ).toMatchObject({ access: "act", report: "always" });
  });
});

describe("routine limits", () => {
  test("a routine that starts runs fires at most every 15 minutes, over its real occurrences; reminders are exempt", async () => {
    f = await setup();
    const make = (trigger: Parameters<typeof createRoutine>[3]["trigger"], reminder = false) =>
      createRoutine(routineDeps(), f.owner.id, f.org.id, {
        agentId: f.agent.id,
        prompt: `Olhe as filas ${crypto.randomUUID()}`,
        target: reminder
          ? { type: "conversation", channelId: f.general.id, threadId: null, reminder: true }
          : { type: "channel", channelId: f.general.id },
        trigger,
      });
    await expect(make({ type: "schedule", phrase: "*/5 * * * *" })).rejects.toMatchObject({
      code: "routine.too_frequent",
    });
    // Two times ten minutes apart, from the picker.
    await expect(
      make({ type: "schedule", rule: { freq: "daily", times: ["09:00", "09:10"], timezone: "UTC" } }),
    ).rejects.toMatchObject({ code: "routine.too_frequent", params: { minutes: 15 } });
    expect((await make({ type: "schedule", phrase: "*/15 * * * *" })).active).toBe(true);
    expect((await make({ type: "schedule", phrase: "*/5 * * * *" }, true)).active).toBe(true);
    // An edit is checked the same way.
    const hourly = await make({ type: "schedule", phrase: "a cada hora" });
    const often = { trigger: { type: "schedule" as const, phrase: "*/10 * * * *" } };
    await expect(updateRoutine(routineDeps(), f.owner.id, f.org.id, hourly.id, often)).rejects.toMatchObject({
      code: "routine.too_frequent",
    });
  });

  test("an agent has at most 20 active routines; paused ones, one-offs and reminders don't count", async () => {
    f = await setup();
    const values = (n: number, extra: Partial<typeof schema.routines.$inferInsert> = {}) => ({
      orgId: f.org.id,
      agentId: f.agent.id,
      name: `r${n}`,
      prompt: `r${n}`,
      target: { type: "channel", channelId: f.general.id },
      triggerType: "event",
      event: "issue.created",
      createdByUserId: f.owner.id,
      ...extra,
    });
    await f.db
      .insert(schema.routines)
      .values([
        ...Array.from({ length: MAX_ACTIVE_ROUTINES - 1 }, (_, i) => values(i)),
        values(100, { active: false }),
        values(101, { triggerType: "once", event: null, nextRunAt: new Date(Date.now() + HOUR) }),
        values(102, { target: { type: "conversation", channelId: f.general.id, threadId: null, reminder: true } }),
      ]);
    const input = {
      agentId: f.agent.id,
      prompt: "Mais uma.",
      target: { type: "channel" as const, channelId: f.general.id },
      trigger: daily(),
    };
    const twentieth = await createRoutine(routineDeps(), f.owner.id, f.org.id, input);
    await expect(
      createRoutine(routineDeps(), f.owner.id, f.org.id, { ...input, prompt: "Outra." }),
    ).rejects.toMatchObject({ code: "routine.too_many", params: { max: MAX_ACTIVE_ROUTINES } });
    // Resuming the paused one would be the 21st.
    const [paused] = await f.db.select().from(schema.routines).where(eq(schema.routines.name, "r100"));
    await expect(
      updateRoutine(routineDeps(), f.owner.id, f.org.id, paused?.id ?? "", { active: true }),
    ).rejects.toMatchObject({ code: "routine.too_many" });
    // Pausing one frees a place.
    await updateRoutine(routineDeps(), f.owner.id, f.org.id, twentieth.id, { active: false });
    expect((await updateRoutine(routineDeps(), f.owner.id, f.org.id, paused?.id ?? "", { active: true })).active).toBe(
      true,
    );
  });

  test("an edit keeps the routine's own time zone unless one is given", async () => {
    f = await setup();
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Bom dia.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "todo dia às 9h", timezone: "America/Sao_Paulo" },
    });
    expect(routine.trigger).toMatchObject({ timezone: "America/Sao_Paulo" });
    // The editor's own zone is UTC: the routine keeps São Paulo.
    const moved = await updateRoutine(routineDeps(), f.owner.id, f.org.id, routine.id, {
      trigger: { type: "schedule", phrase: "todo dia às 8h" },
    });
    expect(moved.trigger).toMatchObject({ timezone: "America/Sao_Paulo" });
    expect(moved.nextRunAt?.endsWith("T11:00:00.000Z")).toBe(true);
    const utc = await updateRoutine(routineDeps(), f.owner.id, f.org.id, routine.id, {
      trigger: { type: "schedule", phrase: "todo dia às 8h", timezone: "UTC" },
    });
    expect(utc.trigger).toMatchObject({ timezone: "UTC" });
    expect(utc.nextRunAt?.endsWith("T08:00:00.000Z")).toBe(true);
  });

  test("the creator must be able to post where it reports", async () => {
    f = await setup();
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const carla = await addMember(f.db, f.org.id, "admin", "carla");
    const input = {
      agentId: f.agent.id,
      prompt: "Resumo do secreto.",
      target: { type: "channel" as const, channelId: secret.id },
      trigger: daily(),
    };
    // A plain member who owns the agent: an administrator may post in every channel (ADR 0151).
    const dani = await addMember(f.db, f.org.id, "member", "dani");
    await f.db.update(schema.agents).set({ ownerUserId: dani.id }).where(eq(schema.agents.id, f.agent.id));
    await expect(createRoutine(routineDeps(), dani.id, f.org.id, input)).rejects.toMatchObject({
      code: "routine.creator_cannot_post",
    });
    // The owner is in it; an admin who edits keeps the owner as the one who must post there.
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, input);
    expect(
      (await updateRoutine(routineDeps(), carla.id, f.org.id, routine.id, { target: input.target })).target,
    ).toEqual(input.target);
  });
});

describe("one DST semantics", () => {
  test("a local time skipped by DST moves forward in rules and in cron alike", () => {
    // New York springs forward on 2026-03-08 (02:00 → 03:00).
    const rule = normalizeRule({
      freq: "daily",
      times: ["02:30"],
      timezone: "America/New_York",
      start: "2026-03-07",
    } as ScheduleRule);
    const slots = ruleOccurrences(rule, new Date("2026-03-07T00:00:00Z"), new Date("2026-03-10T00:00:00Z"));
    expect(slots.map((d) => d.toISOString())).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-08T07:00:00.000Z", // 02:30 didn't exist: 03:00 EDT
      "2026-03-09T06:30:00.000Z",
    ]);
    expect(nextCronTime("30 2 * * *", "America/New_York", new Date("2026-03-08T00:00:00Z"))?.toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    // Hourly: the skipped hour lands on the next one, once.
    const hourly = normalizeRule({
      freq: "hourly",
      times: ["00:00"],
      timezone: "America/New_York",
      start: "2026-03-08",
    } as ScheduleRule);
    const night = ruleOccurrences(hourly, new Date("2026-03-08T05:00:00Z"), new Date("2026-03-08T09:00:00Z"));
    expect(night.map((d) => d.toISOString())).toEqual([
      "2026-03-08T05:00:00.000Z", // 00:00 EST
      "2026-03-08T06:00:00.000Z", // 01:00 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT (02:00 moved here, merged)
      "2026-03-08T08:00:00.000Z",
    ]);
  });
});
