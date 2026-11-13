import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  agentSearchChannels,
  closeRoutineRun,
  createChannel,
  createIssue,
  createRoutine,
  drainOutbox,
  openDm,
  routineRoomKey,
  runRoutineNow,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import {
  agentRunRow,
  briefs,
  channelRoutine,
  fire,
  messagesIn,
  minutesFromNow,
  notificationsOf,
  routineDeps,
  routineRunRow,
} from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

/** A routine's background run is the one offered `hand_off`. */
const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const seen = (req: ModelRequest) => JSON.stringify(req.messages);

test("a routine fires in its own room: the brief by its creator, the agent alone, nothing in the conversation", async () => {
  f = await setup({ reply: () => ({ chunks: ["Nada novo: 0 avaliações."] }) });
  const routine = await channelRoutine(f);
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [brief] = await briefs(f);
  const [rr] = await f.db.select().from(schema.routineRuns);
  if (!brief || !rr) throw new Error("the routine didn't fire");
  const [room] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, brief.channelId));
  expect(room).toMatchObject({ kind: "dm", visibility: "private", dmKey: routineRoomKey(f.agent.id, routine.id) });
  const members = await f.db
    .select()
    .from(schema.channelMembers)
    .where(eq(schema.channelMembers.channelId, brief.channelId));
  expect(members.map((m) => [m.agentId, m.userId])).toEqual([[f.agent.id, null]]);
  // The brief: only the routine's instructions, written as its creator, with what the server knows of the firing.
  expect(brief).toMatchObject({
    authorType: "person",
    authorUserId: f.owner.id,
    body: "Veja as avaliações novas.",
    threadId: null,
  });
  expect(brief.meta).toMatchObject({
    background: true,
    routine: { id: routine.id, name: "Avaliações", runId: rr.id },
    routineBrief: {
      routineId: routine.id,
      routineRunId: rr.id,
      name: "Avaliações",
      creatorUserId: f.owner.id,
      deliverTo: { channelId: f.general.id, threadId: null },
      access: "act",
      report: "when_new",
      trigger: "manual",
      dueAt: rr.at.toISOString(),
    },
  });
  // Its background run works there; nothing of the firing reaches the conversation.
  const runs = await f.db.select().from(schema.agentRuns);
  expect(runs).toMatchObject([{ background: true, channelId: room?.id, triggerMessageId: brief.id, status: "done" }]);
  expect(await messagesIn(f, f.general.id)).toEqual([]);
  expect(rr).toMatchObject({
    status: "silent",
    agentRunId: runs[0]?.id,
    brain: "model",
    summary: "Nada novo: 0 avaliações.",
  });
  expect(rr.finishedAt).not.toBeNull();

  // The next firing uses the same room.
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);
  expect(new Set((await briefs(f)).map((b) => b.channelId))).toEqual(new Set([brief.channelId]));
});

test("a routine's room is read only by its own runs: other runs' searches never reach it", async () => {
  f = await setup();
  const routine = await channelRoutine(f);
  await fire(f, routine.id, new Date());
  const [brief] = await briefs(f);
  const room = brief?.channelId ?? "";
  expect(await agentSearchChannels(f.db, f.org.id, f.agent.id, f.general.id)).toEqual([f.general.id]);
  expect(await agentSearchChannels(f.db, f.org.id, f.agent.id, room)).toContain(room);
});

test("a routine's run reads the private conversation it reports to while its creator is in it, never another", async () => {
  f = await setup();
  const privateRoom = async (name: string) => {
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name, visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id });
    return room;
  };
  const sales = await privateRoom("vendas");
  const secret = await privateRoom("secreto");
  const routine = await channelRoutine(f, { target: { type: "channel", channelId: sales.id } });
  await fire(f, routine.id, new Date());
  const room = (await briefs(f))[0]?.channelId ?? "";
  const reach = () => agentSearchChannels(f.db, f.org.id, f.agent.id, room);
  expect(new Set(await reach())).toEqual(new Set([room, sales.id, f.general.id]));
  // Elsewhere the agent reaches neither private channel.
  expect(await agentSearchChannels(f.db, f.org.id, f.agent.id, f.general.id)).toEqual([f.general.id]);

  await f.db
    .delete(schema.channelMembers)
    .where(and(eq(schema.channelMembers.channelId, sales.id), eq(schema.channelMembers.userId, f.owner.id)));
  expect(await reach()).not.toContain(sales.id);
  expect(await reach()).not.toContain(secret.id);
});

test("a DM routine's run reads its creator's DM with the agent", async () => {
  f = await setup();
  const routine = await channelRoutine(f, { target: { type: "dm" } });
  await fire(f, routine.id, new Date());
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const room = (await briefs(f))[0]?.channelId ?? "";
  expect(await agentSearchChannels(f.db, f.org.id, f.agent.id, room)).toContain(dm.id);
});

test("a DM routine reports to its creator's DM with the agent", async () => {
  f = await setup();
  const routine = await channelRoutine(f, { target: { type: "dm" } });
  await fire(f, routine.id, new Date());
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const [brief] = await briefs(f);
  expect(brief?.meta.routineBrief).toMatchObject({ deliverTo: { channelId: dm.id, threadId: null } });
  expect(brief?.channelId).not.toBe(dm.id);
  expect(await messagesIn(f, dm.id)).toEqual([]);
});

test("an event stays in the routine run, never in the brief; an issue's event carries its id, not its title", async () => {
  f = await setup();
  const routine = await createRoutine(routineDeps(f), f.owner.id, f.org.id, {
    agentId: f.agent.id,
    prompt: "Faça a triagem da issue nova.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "event", event: "issue.created" },
  });
  const issue = await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
    title: "Checkout lento",
  });
  const [rr] = await f.db.select().from(schema.routineRuns);
  expect(rr).toMatchObject({ routineId: routine.id, trigger: "event", dedupeKey: `issue:${issue.id}` });
  expect(rr?.event).toMatchObject({
    type: "issue.created",
    issueId: issue.id,
    summary: `New issue #${issue.number} (id ${issue.id})`,
  });
  expect(JSON.stringify(rr?.event)).not.toContain("Checkout lento");
  await drainOutbox(f.db, f.handlers);
  const [brief] = await briefs(f);
  expect(brief?.body).toBe("Faça a triagem da issue nova.");
});

test("hand_off with wake_me delivers to the conversation the routine reports to, never its room; the agent tells people there", async () => {
  f = await setup({
    handOff: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Chegaram 3 avaliações novas; 2 negativas sobre o PDF."] };
      if (seen(req).includes("Handed off")) return { chunks: ["Checado: 3 avaliações novas, reportadas."] };
      return {
        chunks: [],
        toolUses: [
          { name: "hand_off", input: { message: "3 avaliações novas: 2 negativas (PDF), 1 positiva.", wake_me: true } },
        ],
      };
    },
  });
  const routine = await channelRoutine(f);
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [rr] = await f.db.select().from(schema.routineRuns);
  const runs = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  const [background, talk] = runs;
  expect(runs.map((r) => [r.background, r.channelId === f.general.id, r.status])).toEqual([
    [true, false, "done"],
    [false, true, "done"],
  ]);
  const general = await messagesIn(f, f.general.id);
  expect(general.map((m) => [m.authorType, m.body])).toEqual([
    ["agent", "3 avaliações novas: 2 negativas (PDF), 1 positiva."],
    ["agent", "Chegaram 3 avaliações novas; 2 negativas sobre o PDF."],
  ]);
  expect(general[0]?.meta.notice).toEqual({
    kind: "routine_handoff",
    text: "3 avaliações novas: 2 negativas (PDF), 1 positiva.",
    from: "Routine «Avaliações»",
    refs: {
      runId: background?.id,
      routineId: routine.id,
      routineRunId: rr?.id,
      routineName: "Avaliações",
      report: "when_new",
    },
  });
  expect(talk?.triggerMessageId).toBe(general[0]?.id);
  // Reported: its record is its final text.
  expect(rr).toMatchObject({ status: "reported", summary: "Checado: 3 avaliações novas, reportadas." });
  expect(rr?.finishedAt).not.toBeNull();
});

test("hand_off re-checks the routine: paused, deleted or a creator who can't post there blocks it", async () => {
  const blocked: string[] = [];
  f = await setup({
    handOff: true,
    reply: (req) => {
      const said = seen(req);
      if (said.includes("Nothing was delivered")) {
        blocked.push(said);
        return { chunks: ["ok"] };
      }
      if (said.includes("Handed off")) return { chunks: ["ok"] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: "Novidade importante." } }] };
    },
  });
  const run = async (change: (routineId: string) => Promise<unknown>, at: Date, trigger: "schedule" | "manual") => {
    const routine = await channelRoutine(f, { name: `R ${at.getTime()}` });
    const rr = await fire(f, routine.id, at, trigger);
    await change(routine.id);
    await drainOutbox(f.db, f.handlers);
    return routineRunRow(f, rr.id);
  };
  const paused = await run(
    (id) => f.db.update(schema.routines).set({ active: false }).where(eq(schema.routines.id, id)),
    minutesFromNow(-5),
    "schedule",
  );
  expect(paused).toMatchObject({ status: "skipped", code: "paused" });
  const deleted = await run(
    (id) => f.db.update(schema.routines).set({ deletedAt: new Date() }).where(eq(schema.routines.id, id)),
    minutesFromNow(-4),
    "schedule",
  );
  expect(deleted).toMatchObject({ status: "skipped", code: "deleted" });
  const noAccess = await run(
    () =>
      f.db
        .delete(schema.channelMembers)
        .where(eq(schema.channelMembers.userId, f.owner.id))
        .then(() => undefined),
    minutesFromNow(-3),
    "schedule",
  );
  expect(noAccess).toMatchObject({ status: "skipped", code: "creator_no_access" });
  expect(blocked).toHaveLength(3);
  expect(await messagesIn(f, f.general.id)).toEqual([]);
});

test("a manual run of a paused routine is live: its report is delivered", async () => {
  f = await setup({
    handOff: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Aviso dado."] };
      if (seen(req).includes("Handed off")) return { chunks: ["ok"] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: "Achei 1 erro novo." } }] };
    },
  });
  const routine = await channelRoutine(f);
  await f.db.update(schema.routines).set({ active: false }).where(eq(schema.routines.id, routine.id));
  const rr = await fire(f, routine.id, new Date(), "manual");
  await drainOutbox(f.db, f.handlers);
  expect(await routineRunRow(f, rr.id)).toMatchObject({ status: "reported" });
  expect((await messagesIn(f, f.general.id))[0]?.body).toBe("Achei 1 erro novo.");
});

test("report every time: a final text without hand_off is the report (auto_report); no text fails (no_report)", async () => {
  f = await setup();
  const routine = await channelRoutine(f);
  await f.db.update(schema.routines).set({ report: "always" }).where(eq(schema.routines.id, routine.id));
  const deps = { db: f.db, pubsub: f.pubsub };

  const first = await fire(f, routine.id, minutesFromNow(-10));
  const firstRun = await agentRunRow(f, first.agentRunId);
  expect(await closeRoutineRun(deps, firstRun, { status: "done", text: "Relatório: 3 itens novos." })).toMatchObject({
    status: "reported",
  });
  expect(await routineRunRow(f, first.id)).toMatchObject({
    status: "reported",
    code: "auto_report",
    summary: "Relatório: 3 itens novos.",
  });
  // Its final text is its record, not a message for people: a notice the agent tells them from.
  const [notice] = await messagesIn(f, f.general.id);
  expect(notice?.meta.notice).toMatchObject({
    kind: "routine_handoff",
    text: "Relatório: 3 itens novos.",
    refs: { routineId: routine.id, routineRunId: first.id, report: "always" },
  });
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, firstRun.id));

  const second = await fire(f, routine.id, minutesFromNow(-5));
  const secondRun = await agentRunRow(f, second.agentRunId);
  expect(await closeRoutineRun(deps, secondRun, { status: "done", text: "  " })).toMatchObject({ status: "failed" });
  expect(await routineRunRow(f, second.id)).toMatchObject({ status: "failed", code: "no_report" });
  expect(await notificationsOf(f, "routine_failed")).toHaveLength(1);
  // Only the first report reached the conversation.
  expect(await messagesIn(f, f.general.id)).toHaveLength(1);
});
