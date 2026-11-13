import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  calendarRange,
  cancelReminder,
  createFakeScheduleReader,
  createLlmScheduleReader,
  drainOutbox,
  fireDueRoutines,
  listReminders,
  listRoutines,
  momentFromFields,
  NotFoundError,
  type OrgCall,
  openDm,
  parseWhen,
  postPersonMessage,
  setAgentAccess,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("one-off times", () => {
  // Thursday 2026-10-15, 12:00 in São Paulo.
  const now = new Date("2026-10-15T15:00:00Z");
  const sp = "America/Sao_Paulo";
  // What the model would answer: a local date-time in the zone (or why there is none).
  const reader = createFakeScheduleReader({
    "amanhã às 9h": { at: "2026-10-16T09:00" },
    "sexta às 15h": { at: "2026-10-16T15:00" },
    "monday at 10:30am": { at: "2026-10-19T10:30" },
    "lundi à 10h30": { at: "2026-10-19T10:30" },
    "hoje às 10h": { at: "2026-10-15T10:00" },
    "dia 31 de fevereiro às 9h": { at: "2027-02-31T09:00" },
    "14/03 às 2h30": { at: "2027-03-14T02:30" },
    amanhã: { error: "time_missing" },
  });
  const read = (text: string, timezone = sp) => parseWhen(reader, { orgId: "org", text, timezone, now });
  const at = async (text: string, timezone = sp) => {
    const r = await read(text, timezone);
    return r.ok ? r.at.toISOString() : r.code;
  };

  test("the reader's local time becomes the UTC moment, described in human terms", async () => {
    expect(await read("amanhã às 9h")).toEqual({
      ok: true,
      at: new Date("2026-10-16T12:00:00Z"),
      timezone: sp,
      description: "tomorrow, Oct 16, at 09:00 (Brasília time)",
    });
    // Any language: the model reads it, the code only converts it. Other days by weekday.
    for (const text of ["monday at 10:30am", "lundi à 10h30"]) {
      expect(await read(text)).toMatchObject({
        ok: true,
        at: new Date("2026-10-19T13:30:00Z"),
        description: "Monday, Oct 19, at 10:30 (Brasília time)",
      });
    }
    expect(await at("sexta às 15h")).toBe("2026-10-16T18:00:00.000Z");
    // The same local time in another zone is another moment.
    expect(await at("amanhã às 9h", "UTC")).toBe("2026-10-16T09:00:00.000Z");
  });

  test("ISO is read by code; the past, impossible dates, DST gaps and unreadable text are refused", async () => {
    expect(await at("2026-10-16T09:00")).toBe("2026-10-16T12:00:00.000Z");
    expect(await at("2026-10-16T09:00:00Z")).toBe("2026-10-16T09:00:00.000Z");
    expect(await at("2026-10-15T09:00:00Z")).toBe("when.past");
    expect(reader.calls.map((c) => c.text)).not.toContain("2026-10-16T09:00");
    expect(await at("hoje às 10h")).toBe("when.past");
    expect(await at("dia 31 de fevereiro às 9h")).toBe("when.unreadable");
    // New York springs forward on 2027-03-14: 02:30 doesn't exist that day.
    expect(await at("14/03 às 2h30", "America/New_York")).toBe("when.nonexistent");
    expect(await read("amanhã")).toMatchObject({ ok: false, code: "when.time_missing" });
    expect(await read("quando der")).toMatchObject({ ok: false, code: "when.unreadable" });
    expect(await read("  ")).toMatchObject({ ok: false, code: "when.required" });
    // Without a reader only ISO is read.
    expect(await parseWhen(null, { orgId: "org", text: "amanhã às 9h", timezone: sp, now })).toMatchObject({
      code: "when.unreadable",
    });
  });

  test("the model's fields: relative minutes count from now, absolute ones are checked", () => {
    expect(momentFromFields({ status: "ok", in_minutes: 120, local_date_time: "" }, sp, now)).toEqual({
      localDateTime: "2026-10-15T14:00",
    });
    expect(momentFromFields({ status: "ok", in_minutes: 0, local_date_time: "2026-10-16T09:00" }, sp, now)).toEqual({
      localDateTime: "2026-10-16T09:00",
    });
    expect(momentFromFields({ status: "ok", in_minutes: 0, local_date_time: "2026-10-16T25:00" }, sp, now)).toEqual({
      error: "unreadable",
    });
    expect(momentFromFields({ status: "time_missing", in_minutes: 0, local_date_time: "" }, sp, now)).toEqual({
      error: "time_missing",
    });
  });

  test("the model reader asks the org's cheap model with today's date, weekday and time in the zone", async () => {
    const requests: OrgCall[] = [];
    const reader = createLlmScheduleReader({
      gateway: {
        complete: async (call) => {
          requests.push(call);
          return {
            text: JSON.stringify({ status: "ok", in_minutes: 0, local_date_time: "2026-10-16T09:00" }),
          } as never;
        },
      },
      resolveModel: async () => "cheap-model",
    });
    expect(await reader.readMoment({ orgId: "org", text: "amanhã às 9h", timezone: sp, now })).toEqual({
      localDateTime: "2026-10-16T09:00",
    });
    const [call] = requests;
    expect(call).toMatchObject({ orgId: "org", model: "cheap-model", kind: "summary" });
    expect(call?.outputSchema).toMatchObject({ type: "object", required: ["status", "in_minutes", "local_date_time"] });
    const sent = JSON.parse(String(call?.messages[0]?.content));
    expect(sent).toEqual({
      now: { date: "2026-10-15", weekday: "Thursday", time: "12:00", timezone: sp },
      when: "amanhã às 9h",
    });
  });
});

/** ana (São Paulo) and @dev with the scheduling tools. */
type Reply = NonNullable<NonNullable<Parameters<typeof setup>[0]>["reply"]>;
async function world(reply: Reply) {
  f = await setup({ scheduleTools: true, askUser: true, reply });
  await f.db
    .update(schema.organizationMembers)
    .set({ timezone: "America/Sao_Paulo" })
    .where(eq(schema.organizationMembers.userId, f.owner.id));
}

const results = async () =>
  (await f.db.select().from(schema.agentRunSteps))
    .filter((s) => s.kind === "tool_result")
    .map((s) => s.data as { name: string; content: string; isError: boolean });

const fireNow = async () => {
  // A minute ago: past any routine's offset into its minute (`fireDueRoutines`).
  await f.db.update(schema.routines).set({ nextRunAt: new Date(Date.now() - 60_000) });
  await fireDueRoutines({ db: f.db, pubsub: f.pubsub, context: f.context });
  await drainOutbox(f.db, f.handlers);
};

describe("reminders from the chat", () => {
  test("in a DM: scheduled in the person's zone, confirmed, fired as the agent's message, then done", async () => {
    let prompt = "";
    await world((req) => {
      prompt = systemText(req.system ?? "");
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Combinado."] };
      if (last.includes("me lembra"))
        return {
          chunks: [],
          toolUses: [{ name: "schedule_reminder", input: { when: "amanhã às 9h", message: "pagar a conta de luz" } }],
        };
      return { chunks: ["ok"] };
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "me lembra amanhã às 9h de pagar a conta de luz",
    });
    await drainOutbox(f.db, f.handlers);
    expect(prompt).toContain("You can schedule reminders and routines");
    const [result] = await results();
    expect(result).toMatchObject({ name: "schedule_reminder", isError: false });
    expect(result?.content).toContain("tomorrow, ");
    expect(result?.content).toContain("at 09:00 (Brasília time)");
    expect(result?.content).toContain("call it a reminder and say it shows in the calendar");

    const [routine] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(routine).toMatchObject({ trigger: { type: "once", timezone: "America/Sao_Paulo" }, active: true });
    expect(routine?.target).toMatchObject({ type: "conversation", channelId: dm.id, threadId: null, reminder: true });
    const runsBefore = (await f.db.select().from(schema.agentRuns)).length;

    await fireNow();
    const posted = (await f.db.select().from(schema.messages)).find((m) => m.meta.reminder === true);
    expect(posted).toMatchObject({
      channelId: dm.id,
      threadId: null,
      authorType: "agent",
      authorAgentId: f.agent.id,
      body: "@ana Reminder: pagar a conta de luz",
    });
    expect(posted?.meta.routine).toMatchObject({ id: routine?.id });
    expect(posted?.mentionedUserIds).toEqual([f.owner.id]);
    expect((await f.db.select().from(schema.agentRuns)).length).toBe(runsBefore); // a plain reminder starts nothing
    const [after] = await f.db.select().from(schema.routines);
    expect(after).toMatchObject({ active: false, nextRunAt: null });
    expect(await listReminders(f.db, f.owner.id, f.org.id)).toEqual([]);
  });

  test("asking for the same routine again (an interrupted run asked again) doesn't schedule it twice", async () => {
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("rotina"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "create_routine",
              input: {
                schedule: "toda segunda às 10h",
                prompt: "Veja os reviews  da última hora e avise aqui.",
                title: "Reviews",
              },
            },
          ],
        };
      return { chunks: ["ok"] };
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    for (const body of ["cria uma rotina de reviews", "a rotina de reviews, de novo"]) {
      await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body });
      await drainOutbox(f.db, f.handlers);
    }
    const created = (await results()).filter((r) => r.name === "create_routine");
    expect(created).toHaveLength(2);
    expect(created[0]?.content).toContain("Created routine");
    // Same agent, conversation and instructions (spacing and case aside): the existing one.
    expect(created[1]?.content).toContain("already exists");
    expect(await listRoutines(f.db, f.owner.id, f.org.id)).toHaveLength(1);
  });

  test("a routine asked in a DM moves to #general (update_routine): it runs there, flat, and nothing comes to the DM", async () => {
    let routineId = "";
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("cria a rotina"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "create_routine",
              input: { schedule: "toda segunda às 10h", prompt: "Veja erros novos no Sentry." },
            },
          ],
        };
      if (last.includes("manda no general"))
        return { chunks: [], toolUses: [{ name: "update_routine", input: { id: routineId, channel: "#General" } }] };
      return { chunks: ["Nenhum erro novo."] };
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const say = async (body: string) => {
      await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body });
      await drainOutbox(f.db, f.handlers);
    };
    await say("cria a rotina de erros");
    const [created] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(created?.target).toMatchObject({ type: "conversation", channelId: dm.id });
    routineId = created?.id ?? "";
    await say("manda no general, não no privado");
    const updated = (await results()).find((r) => r.name === "update_routine");
    expect(updated).toMatchObject({ isError: false });
    expect(updated?.content).toContain("reports in #general");
    const [moved] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(moved?.target).toEqual({ type: "channel", channelId: f.general.id });

    const before = (await f.db.select().from(schema.messages)).filter((m) => m.channelId === dm.id).length;
    await fireNow();
    const all = await f.db.select().from(schema.messages);
    expect(all.filter((m) => m.channelId === dm.id)).toHaveLength(before);
    // Background work in the routine's own room (ADR 0053 §4), reporting to #general; with nothing handed
    // off, nothing reaches any conversation.
    const [work] = (await f.db.select().from(schema.agentRuns)).filter((r) => r.background);
    expect(work).toMatchObject({ status: "done", replyMessageId: null });
    expect(work?.channelId).not.toBe(f.general.id);
    const brief = all.find((m) => m.id === work?.triggerMessageId);
    expect(brief?.meta.routineBrief).toMatchObject({ deliverTo: { channelId: f.general.id, threadId: null } });
    expect(all.filter((m) => m.channelId === f.general.id && m.id === work?.triggerMessageId)).toEqual([]);
    expect(all.filter((m) => m.authorType === "agent" && m.channelId === f.general.id)).toEqual([]);
  });

  test("create_routine with a channel posts there; a channel the person isn't in is not found", async () => {
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Feito."] };
      if (last.includes("no secreto"))
        return {
          chunks: [],
          toolUses: [
            { name: "create_routine", input: { schedule: "toda segunda às 10h", prompt: "x", channel: "secreto" } },
          ],
        };
      if (last.includes("rotina"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "create_routine",
              input: { schedule: "toda segunda às 10h", prompt: "Erros?", channel: "general" },
            },
          ],
        };
      return { chunks: ["ok"] };
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    for (const body of ["rotina de erros", "outra no secreto"]) {
      await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, { body });
      await drainOutbox(f.db, f.handlers);
    }
    const created = (await results()).filter((r) => r.name === "create_routine");
    expect(created[0]?.content).toContain("reports in #general");
    expect(created[1]).toMatchObject({ isError: true });
    expect(created[1]?.content).toContain("No channel #secreto");
    const routines = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(routines.map((r) => r.target)).toEqual([{ type: "channel", channelId: f.general.id }]);
  });

  test("asked in a channel it lands in the channel itself, flat; ask_agent makes the agent do it then", async () => {
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Combinado."] };
      if (last.includes("verifica o deploy"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "schedule_reminder",
              input: { when: "em 2 horas", message: "verifique o deploy e conte aqui", ask_agent: true },
            },
          ],
        };
      return { chunks: ["ok"] };
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev daqui a 2 horas verifica o deploy",
    });
    await drainOutbox(f.db, f.handlers);
    const [routine] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(routine?.target).toMatchObject({
      type: "conversation",
      channelId: f.general.id,
      threadId: null,
      reminder: false,
    });
    await fireNow();
    // The routine's brief, in its own room; it reports to the conversation it was asked in.
    const asked = (await f.db.select().from(schema.messages)).find(
      (m) => m.meta.routineBrief !== undefined && m.authorType === "person",
    );
    expect(asked).toMatchObject({ threadId: null, body: "verifique o deploy e conte aqui" });
    expect(asked?.meta.routineBrief).toMatchObject({ deliverTo: { channelId: f.general.id, threadId: null } });
    const runs = (await f.db.select().from(schema.agentRuns)).filter((r) => r.triggerMessageId === asked?.id);
    expect(runs).toHaveLength(1);
  });

  test("the calendar shows a pending reminder to who set it and who is in its conversation, no one else", async () => {
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["ok"] };
      if (last.includes("lembra"))
        return {
          chunks: [],
          toolUses: [{ name: "schedule_reminder", input: { when: "amanhã às 10h", message: "reunião" } }],
        };
      return { chunks: ["ok"] };
    });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    const eve = await addMember(f.db, f.org.id, "member", "eve");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev me lembra amanhã às 10h da reunião",
    });
    await drainOutbox(f.db, f.handlers);
    const [mine] = await listReminders(f.db, f.owner.id, f.org.id);
    const id = mine?.id ?? "";
    const at = Date.parse(mine?.at ?? "");
    const seen = async (userId: string, from = at - 3_600_000) =>
      (
        await calendarRange(
          { db: f.db, pubsub: f.pubsub, publicUrl: "" },
          userId,
          f.org.id,
          new Date(from).toISOString(),
          new Date(from + 7_200_000).toISOString(),
        )
      ).reminders;

    expect(await seen(f.owner.id)).toMatchObject([
      {
        id,
        message: "reunião",
        at: mine?.at,
        forUserId: f.owner.id,
        channelId: f.general.id,
        agentId: f.agent.id,
        createdBy: f.owner.id,
        canCancel: true,
      },
    ]);
    // In the conversation: sees it, can't cancel it. Outside it: nothing. Outside the range: nothing.
    expect((await seen(bob.id))[0]).toMatchObject({ id, canCancel: false });
    expect(await seen(eve.id)).toEqual([]);
    expect(await seen(f.owner.id, at + 3_600_000)).toEqual([]);
    // Cancelled, it leaves the calendar.
    await cancelReminder({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, id);
    expect(await seen(f.owner.id)).toEqual([]);
  });

  test("what an agent was asked to do later stays with who asked, and an agent hidden from someone hides its reminder", async () => {
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["ok"] };
      if (last.includes("demite"))
        return {
          chunks: [],
          toolUses: [
            { name: "schedule_reminder", input: { when: "amanhã às 10h", message: "demite o Bob", ask_agent: true } },
          ],
        };
      if (last.includes("lembra"))
        return {
          chunks: [],
          toolUses: [{ name: "schedule_reminder", input: { when: "amanhã às 10h", message: "reunião" } }],
        };
      return { chunks: ["ok"] };
    });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    for (const body of ["@dev demite o Bob amanhã às 10h", "@dev me lembra amanhã às 10h da reunião"]) {
      await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
      await drainOutbox(f.db, f.handlers);
    }
    const [first] = await listReminders(f.db, f.owner.id, f.org.id);
    const at = Date.parse(first?.at ?? "");
    const seen = async (userId: string) =>
      (
        await calendarRange(
          { db: f.db, pubsub: f.pubsub, publicUrl: "" },
          userId,
          f.org.id,
          new Date(at - 3_600_000).toISOString(),
          new Date(at + 3_600_000).toISOString(),
        )
      ).reminders.map((r) => r.message);

    expect((await seen(f.owner.id)).sort()).toEqual(["demite o Bob", "reunião"]);
    expect(await seen(bob.id)).toEqual(["reunião"]);
    await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
    expect(await seen(bob.id)).toEqual([]);
  });

  test("only the person who asked can cancel; denying the scope hides the tools", async () => {
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["ok"] };
      if (last.includes("lembra"))
        return {
          chunks: [],
          toolUses: [{ name: "schedule_reminder", input: { when: "amanhã às 10h", message: "reunião" } }],
        };
      return { chunks: ["ok"] };
    });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev me lembra amanhã às 10h da reunião",
    });
    await drainOutbox(f.db, f.handlers);
    const [mine] = await listReminders(f.db, f.owner.id, f.org.id);
    expect(mine?.message).toBe("reunião");
    expect(await listReminders(f.db, bob.id, f.org.id)).toEqual([]);
    const deps = { db: f.db, pubsub: f.pubsub };
    await expect(cancelReminder(deps, bob.id, f.org.id, mine?.id ?? "")).rejects.toBeInstanceOf(NotFoundError);
    expect((await cancelReminder(deps, f.owner.id, f.org.id, mine?.id ?? "")).done).toBe(true);
    await fireNow();
    expect((await f.db.select().from(schema.messages)).some((m) => m.meta.reminder === true)).toBe(false);

    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
      all: true,
      connectors: {},
      scopes: [],
      tools: {
        allow: [],
        deny: [
          "schedule_reminder",
          "create_routine",
          "list_routines",
          "update_routine",
          "list_reminders",
          "cancel_reminder",
        ].map((name) => ({
          connectionId: null,
          name,
        })),
      },
    });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).not.toContain("schedule_reminder");
  });
});
