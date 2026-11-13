import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  agentLineRank,
  createAgent,
  createAgentRuns,
  deferMentionReport,
  deliverParked,
  dispatchMentions,
  handOffsFrom,
  INBOX_JOB,
  insertMessage,
  MENTION_REPORT_JOB,
  type OutboxJob,
  PERSON_ASKED_MS,
  personAskedLately,
  postPersonMessage,
  ROOM_BEHIND_RETRY_MS,
  ROOM_RANK_AGE_MS,
  reportMentionReplies,
  roomGate,
  roomHead,
  STRETCH,
  sendNote,
  stopOrgWork,
  stretchStop,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine, RUNNER } from "./machine-fixtures";

/**
 * Calm wakes (ADR 0032): on a computer with work waiting for room, agents' wakes for each other wait outside any run,
 * work a person asked for goes before agents' chatter, replies to a broadcast are reported once, and deeper chains
 * need a clearer reason.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const { agentRuns, agentConsultations, outbox } = schema;

async function agentOf(name: string, handle: string) {
  const a = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role: "Dev", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
  return a;
}

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });

/** A run of `agentId` waiting for room on `machineId`, with its line fields. */
async function inLine(agentId: string, machineId: string, extra: Record<string, unknown> = {}, sinceAgo = 60_000) {
  const id = Bun.randomUUIDv7();
  const [run] = await f.db
    .insert(agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId: f.general.id,
      threadRootId: id,
      triggerMessageId: id,
      trigger: "mention",
      hop: 2,
      status: "waiting_input",
      waitingMachineId: machineId,
      transcript: {
        waitingForBrain: { kind: "claude_code", machineId, code: "busy", waitId: Bun.randomUUIDv7() },
        roomWaitSince: Date.now() - sinceAgo,
        ...extra,
      },
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

async function computerFor(...agentIds: string[]) {
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, RUNNER);
  for (const id of agentIds) await f.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, id));
  return machineId;
}

const agentWrites = (
  agentId: string,
  body: string,
  options: { runId?: string; hop?: number; threadId?: string } = {},
) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    ...(options.threadId ? { threadId: options.threadId } : {}),
    author: { type: "agent", agentId, runId: options.runId ?? crypto.randomUUID(), hop: options.hop ?? 1 },
    body,
  });

const jobsOf = async (kind: string) => (await f.db.select().from(outbox)).filter((j) => j.kind === kind);
const runsOf = async (agentId: string) =>
  (await f.db.select().from(agentRuns)).filter((r) => r.agentId === agentId && r.status !== "waiting_input");
const done = (id: string) => f.db.update(agentRuns).set({ status: "done" }).where(eq(agentRuns.id, id));

describe("the computer's line", () => {
  test("people first, then work a person asked for lately, then agents' own, each by its wait", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const machineId = await computerFor(f.agent.id, rio.id);
    const chatter = await inLine(rio.id, machineId, {}, 300_000);
    const asked = await inLine(rio.id, machineId, { roomAsked: true }, 60_000);
    expect((await roomHead(f.db, machineId))?.id).toBe(asked.id);
    const person = await inLine(f.agent.id, machineId, { roomPeople: true }, 10_000);
    expect((await roomHead(f.db, machineId))?.id).toBe(person.id);
    expect(await agentLineRank(f.db, f.org.id, rio.id)).toBe(1);

    // A newcomer a person asked for waits behind the person's run, never behind agents' own.
    const newcomer = { id: Bun.randomUUIDv7(), orgId: f.org.id };
    // Behind another run it looks again only as a fallback: the line moves by kicks.
    const asking = Date.now();
    const behind = await roomGate(f.db, newcomer, machineId, { rank: 1, since: Date.now() });
    expect(behind?.retryAt).toBeGreaterThanOrEqual(asking + ROOM_BEHIND_RETRY_MS);
    await done(person.id);
    await done(asked.id);
    expect(await roomGate(f.db, newcomer, machineId, { rank: 1, since: Date.now() })).toBeNull();
    expect(chatter.status).toBe("waiting_input");
  });

  test("agents' own work that waited long moves up with asked work; a parked wake's wait counts", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const machineId = await computerFor(f.agent.id, rio.id);
    const asked = await inLine(rio.id, machineId, { roomAsked: true }, 60_000);
    const old = await inLine(f.agent.id, machineId, {}, ROOM_RANK_AGE_MS + 60_000);
    expect((await roomHead(f.db, machineId))?.id).toBe(old.id);
    await done(old.id);
    // Refused once just now, but parked long before the asked run started waiting: it keeps that place.
    const parked = await inLine(f.agent.id, machineId, { roomAsked: true, roomOrderSince: Date.now() - 120_000 }, 0);
    expect((await roomHead(f.db, machineId))?.id).toBe(parked.id);
    expect(asked.status).toBe("waiting_input");
  });

  test("a stretch a person opened lately is asked work; an agent's own or an old one isn't", async () => {
    f = await setup();
    const fresh = await post("revisa o deploy");
    expect(await personAskedLately(f.db, f.org.id, fresh.id)).toBe(true);
    const own = await agentWrites(f.agent.id, "vou olhar os logs");
    expect(await personAskedLately(f.db, f.org.id, own.id)).toBe(false);
    const old = Bun.randomUUIDv7("hex", Date.now() - PERSON_ASKED_MS - 60_000);
    expect(await personAskedLately(f.db, f.org.id, old)).toBe(false);
  });
});

describe("the agent inbox", () => {
  test("an agent's wake for an agent in line waits outside any run, then starts one run per conversation", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const machineId = await computerFor(f.agent.id);
    const waiting = await inLine(f.agent.id, machineId);
    const root = await post("sobre o build");
    const first = await agentWrites(rio.id, "@dev olha o build", { threadId: root.id });
    const second = await agentWrites(rio.id, "@dev e os testes", { threadId: root.id });
    for (const m of [first, second])
      await dispatchMentions(f.db, { orgId: f.org.id, messageId: m.id }, { maxHops: 10 });
    expect(await runsOf(f.agent.id)).toEqual([]);
    const parked = await jobsOf(INBOX_JOB);
    expect(parked.map((j) => j.payload)).toMatchObject([
      { messageId: first.id, agentId: f.agent.id, trigger: "mention", look: 1 },
      { messageId: second.id, agentId: f.agent.id, trigger: "mention", look: 1 },
    ]);
    const since = Number(parked[0]?.payload.since);

    // Still in line: it looks again later.
    await deliverParked(f.db, f.org.id, { messageId: first.id, agentId: f.agent.id, trigger: "mention", look: 1 });
    expect(await runsOf(f.agent.id)).toEqual([]);
    expect((await jobsOf(INBOX_JOB)).some((j) => j.dedupeKey === `${INBOX_JOB}:${f.agent.id}:${first.id}:2`)).toBe(
      true,
    );

    // Out of line: one run for the thread, the second wake read with it; its place in line counts from the park.
    await done(waiting.id);
    for (const m of [first, second])
      await deliverParked(f.db, f.org.id, {
        messageId: m.id,
        agentId: f.agent.id,
        trigger: "mention",
        look: 2,
        since,
      });
    const runs = await runsOf(f.agent.id);
    expect(runs.filter((r) => r.id !== waiting.id)).toHaveLength(1);
    expect(runs.find((r) => r.id !== waiting.id)).toMatchObject({
      triggerMessageId: first.id,
      threadRootId: root.id,
      hop: 2,
      pendingMessageIds: [second.id],
    });
    const started = runs.find((r) => r.id !== waiting.id);
    const execute = (await jobsOf("agent_run.execute")).find((j) => j.payload.runId === started?.id);
    expect(execute?.payload.lineSince).toBe(since);
  });

  test("a parked wake whose agent was archived meanwhile is dropped; a closed workspace drops them all", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const machineId = await computerFor(f.agent.id);
    const waiting = await inLine(f.agent.id, machineId);
    const root = await post("sobre o build");
    const m = await agentWrites(rio.id, "@dev olha o build", { threadId: root.id });
    await dispatchMentions(f.db, { orgId: f.org.id, messageId: m.id }, { maxHops: 10 });
    expect(await jobsOf(INBOX_JOB)).toHaveLength(1);
    await done(waiting.id);
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    await deliverParked(f.db, f.org.id, { messageId: m.id, agentId: f.agent.id, trigger: "mention", look: 1 });
    expect((await runsOf(f.agent.id)).filter((r) => r.triggerMessageId === m.id)).toEqual([]);

    await stopOrgWork({ db: f.db, pubsub: f.pubsub }, f.org.id, "closed");
    expect(await jobsOf(INBOX_JOB)).toEqual([]);
  });

  test("a person's message and work a person asked for never wait behind agents' chatter", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const machineId = await computerFor(f.agent.id);
    await inLine(f.agent.id, machineId);
    const root = await post("sobre o build");
    await post("@dev responde aqui", root.id);
    expect(await runsOf(f.agent.id)).toHaveLength(1);

    const asked = await post("@rio pede pro dev revisar");
    const [rioRun] = await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, rio.id));
    if (!rioRun) throw new Error("no run");
    const other = await post("outra coisa");
    const handed = await agentWrites(rio.id, "@dev revisa o PR, a pessoa pediu", {
      runId: rioRun.id,
      threadId: other.id,
    });
    expect(handed.stretchId).toBe(asked.id);
    await dispatchMentions(f.db, { orgId: f.org.id, messageId: handed.id }, { maxHops: 10 });
    expect((await runsOf(f.agent.id)).some((r) => r.triggerMessageId === handed.id)).toBe(true);
    expect(await jobsOf(INBOX_JOB)).toEqual([]);
  });

  test("a note waiting so doesn't expire, shows as in line, and its run answers it", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const machineId = await computerFor(f.agent.id);
    // In line with work a person asked for: a note for the same kind of work waits behind it.
    const waiting = await inLine(f.agent.id, machineId, { roomAsked: true });
    await post("@rio prepara o resumo");
    const [rioRun] = await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, rio.id));
    if (!rioRun) throw new Error("no run");
    const sent = await sendNote(f.db, {
      orgId: f.org.id,
      agentId: rio.id,
      runId: rioRun.id,
      hop: 1,
      targetAgentId: f.agent.id,
      body: "Revisa os números do resumo.",
      chain: [rio.id],
    });
    if (!sent) throw new Error("not sent");
    const rowOf = async () =>
      (await f.db.select().from(agentConsultations).where(eq(agentConsultations.id, sent.consultationId)))[0];
    const before = await rowOf();
    expect(before?.targetRunId).toBeNull();
    expect((await handOffsFrom(f.db, rioRun))[0]).toMatchObject({ target: null, parked: true });

    // Near its deadline, a look keeps it open.
    await f.db
      .update(agentConsultations)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(agentConsultations.id, sent.consultationId));
    await deliverParked(f.db, f.org.id, { messageId: sent.message.id, agentId: f.agent.id, trigger: "dm", look: 1 });
    const kept = await rowOf();
    expect(kept?.targetRunId).toBeNull();
    expect(kept?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    await done(waiting.id);
    await deliverParked(f.db, f.org.id, { messageId: sent.message.id, agentId: f.agent.id, trigger: "dm", look: 2 });
    const [run] = (await runsOf(f.agent.id)).filter((r) => r.triggerMessageId === sent.message.id);
    expect(run).toBeDefined();
    expect((await rowOf())?.targetRunId).toBe(run?.id ?? "");
  });
});

describe("report once for @mentions", () => {
  test("replies to a message that woke several agents wake its author once, after all of them", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const nova = await agentOf("Nova", "nova");
    await post("@dev distribui a revisão");
    const [devRun] = await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, f.agent.id));
    if (!devRun) throw new Error("no run");
    await done(devRun.id);
    const asked = await agentWrites(f.agent.id, "@rio @nova revisem o PR", { runId: devRun.id });
    const woke = await f.db.transaction((tx) => createAgentRuns(tx, asked, [rio.id, nova.id], "mention"));
    const [rioRun, novaRun] = woke;
    if (!rioRun || !novaRun) throw new Error("no runs");

    const rioReply = await agentWrites(rio.id, "@dev revisei, tudo certo", { runId: rioRun.id, hop: 2 });
    expect(await deferMentionReport(f.db, rioReply, [f.agent.id])).toBe(f.agent.id);
    const [job] = await jobsOf(MENTION_REPORT_JOB);
    const look = job?.payload as { replyId: string; triggerId: string; agentId: string; look: number };
    expect(look).toEqual({ replyId: rioReply.id, triggerId: asked.id, agentId: f.agent.id, look: 0 });

    // Nova is still at it: nothing yet.
    await done(rioRun.id);
    expect(await reportMentionReplies(f.db, f.org.id, look, { maxHops: 10 })).toBeNull();
    expect((await jobsOf(MENTION_REPORT_JOB)).map((j) => j.dedupeKey)).toContain(
      `${MENTION_REPORT_JOB}:${rioReply.id}:${f.agent.id}:1`,
    );

    const novaReply = await agentWrites(nova.id, "@dev achei um bug no teste", { runId: novaRun.id, hop: 2 });
    await done(novaRun.id);
    const out = await reportMentionReplies(f.db, f.org.id, { ...look, look: 1 }, { maxHops: 10 });
    expect(out?.runs.map((r) => r.triggerMessageId)).toEqual([novaReply.id]);
    // Another reply's look finds it already done: still one wake.
    await reportMentionReplies(f.db, f.org.id, { ...look, replyId: novaReply.id }, { maxHops: 10 });
    expect((await runsOf(f.agent.id)).filter((r) => r.id !== devRun.id)).toHaveLength(1);
  });

  test("a woken agent still parked counts and holds the report; one look per message; a deadline", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const nova = await agentOf("Nova", "nova");
    const machineId = await computerFor(nova.id);
    const novaBusy = await inLine(nova.id, machineId, { roomAsked: true });
    await post("@dev distribui a revisão");
    const [devRun] = await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, f.agent.id));
    if (!devRun) throw new Error("no run");
    await done(devRun.id);
    const asked = await agentWrites(f.agent.id, "@rio @nova revisem o PR", { runId: devRun.id });
    await dispatchMentions(f.db, { orgId: f.org.id, messageId: asked.id }, { maxHops: 10 });
    const [rioRun] = await f.db.select().from(agentRuns).where(eq(agentRuns.triggerMessageId, asked.id));
    if (!rioRun) throw new Error("no run");
    expect(rioRun.agentId).toBe(rio.id);
    expect((await jobsOf(INBOX_JOB)).map((j) => j.payload.agentId)).toEqual([nova.id]);

    const rioReply = await agentWrites(rio.id, "@dev revisei", { runId: rioRun.id, hop: 2 });
    expect(await deferMentionReport(f.db, rioReply, [f.agent.id])).toBe(f.agent.id);
    const again = await agentWrites(rio.id, "@dev e mais uma coisa", { runId: rioRun.id, hop: 2 });
    expect(await deferMentionReport(f.db, again, [f.agent.id])).toBe(f.agent.id);
    expect(await jobsOf(MENTION_REPORT_JOB)).toHaveLength(1);

    // Rio is done, Nova still parked: nothing yet.
    await done(rioRun.id);
    const look = { replyId: rioReply.id, triggerId: asked.id, agentId: f.agent.id, look: 0 };
    expect(await reportMentionReplies(f.db, f.org.id, look, { maxHops: 10 })).toBeNull();

    // Past the wait, the author hears the replies already in.
    await f.db
      .update(schema.messages)
      .set({ createdAt: new Date(Date.now() - 36 * 60_000) })
      .where(eq(schema.messages.id, asked.id));
    const out = await reportMentionReplies(f.db, f.org.id, { ...look, look: 1 }, { maxHops: 10 });
    expect(out?.runs.map((r) => r.triggerMessageId)).toEqual([again.id]);
    expect(novaBusy.status).toBe("waiting_input");
  });

  test("one agent woken, or the author's run still at work: replies wake it as before", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    await post("@dev pede ao rio");
    const [devRun] = await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, f.agent.id));
    if (!devRun) throw new Error("no run");
    const asked = await agentWrites(f.agent.id, "@rio revisa", { runId: devRun.id });
    const [rioRun] = await f.db.transaction((tx) => createAgentRuns(tx, asked, [rio.id], "mention"));
    if (!rioRun) throw new Error("no run");
    const reply = await agentWrites(rio.id, "@dev feito", { runId: rioRun.id, hop: 2 });
    expect(await deferMentionReport(f.db, reply, [f.agent.id])).toBeNull();
  });
});

describe("deeper chains on a crowded computer", () => {
  test("a crowded computer never lowers a stretch's limit: it only orders and parks turns", async () => {
    f = await setup();
    const rio = await agentOf("Rio", "rio");
    const machineId = await computerFor(f.agent.id, rio.id);
    const root = await agentWrites(rio.id, "vou chamar o time");
    // Past the old crowded cap (5), below the limit for work nobody asked for.
    await f.db.insert(agentRuns).values(
      Array.from({ length: STRETCH.unattendedRuns - 1 }, () => {
        const id = Bun.randomUUIDv7();
        return {
          orgId: f.org.id,
          agentId: rio.id,
          channelId: f.general.id,
          threadRootId: id,
          triggerMessageId: id,
          trigger: "mention" as const,
          hop: 2,
          stretchId: root.id,
          status: "done" as const,
        };
      }),
    );
    await inLine(rio.id, machineId);
    expect(await stretchStop(f.db, f.org.id, root.id, f.agent.id)).toBeNull();
  });

  test("a wake four links down needs the judge's higher bar there", async () => {
    // The judge: 70% sure the message asks the agent it names (30% that it leaves it nothing to do).
    f = await setup({ judge: (kind) => (kind === "mention_needs_nothing" ? 0.3 : undefined) });
    const rio = await agentOf("Rio", "rio");
    const nova = await agentOf("Nova", "nova");
    const machineId = await computerFor(f.agent.id, rio.id);
    await inLine(rio.id, machineId);
    const posted = (messageId: string) =>
      f.handlers["message.posted"]?.({ orgId: f.org.id, payload: { messageId } } as unknown as OutboxJob, {
        finalAttempt: false,
      });
    const deep = await agentWrites(nova.id, "@dev confere isso também", { hop: 3 });
    await posted(deep.id);
    expect(await runsOf(f.agent.id)).toEqual([]);
    const shallow = await agentWrites(nova.id, "@dev confere isso", { hop: 1 });
    await posted(shallow.id);
    expect((await runsOf(f.agent.id)).map((r) => r.triggerMessageId)).toEqual([shallow.id]);
  });
});

describe("a mention's copy to an agent outside the conversation", () => {
  test("joins the run already answering an open copy of the same author: no second row, one answer back", async () => {
    f = await setup();
    const ivo = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ivo", handle: "ivo", role: "Pesquisa", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    const runOn = async (body: string) => {
      const m = await post(body);
      const [run] = await f.db
        .insert(agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadRootId: m.id,
          triggerMessageId: m.id,
          trigger: "mention",
          hop: 1,
          status: "done",
        })
        .returning();
      if (!run) throw new Error("no run");
      return run;
    };
    const first = await runOn("primeiro pedido");
    const second = await runOn("segundo pedido");
    const copy = (runId: string, body: string) =>
      sendNote(f.db, {
        orgId: f.org.id,
        agentId: f.agent.id,
        runId,
        hop: 1,
        targetAgentId: ivo.id,
        body,
        chain: [f.agent.id],
        fromMention: true,
      });
    const a = await copy(first.id, "[@dev mentioned you] olha o relatório");
    const b = await copy(second.id, "[@dev mentioned you] e a planilha");
    expect(b?.consultationId).toBe(a?.consultationId ?? "");
    expect(await f.db.select().from(agentConsultations)).toHaveLength(1);
    const [ivoRun] = await f.db.select().from(agentRuns).where(eq(agentRuns.agentId, ivo.id));
    expect(ivoRun?.pendingMessageIds).toEqual([b?.message.id ?? ""]);
  });
});
