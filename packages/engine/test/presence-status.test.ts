import { afterEach, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  AGENT_AWAY_AFTER_MS,
  AGENT_HEARTBEAT_FRESH_MS,
  AGENT_HEAVY_AFTER_MS,
  AGENT_LINE_EVERY_MS,
  agentStatuses,
  announcePresence,
  askRunStatus,
  createFakeJudge,
  createSetStatusToolSource,
  followWork,
  listMembers,
  loadAgentStatuses,
  memberPresence,
  memberStatus,
  postPersonMessage,
  setMyStatus,
  startRunStatus,
  statusCandidates,
  touchLastSeen,
  ValidationError,
} from "../src";
import { toolPolicy } from "../src/tools/run-policy";
import type { ToolContext } from "../src/tools/types";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const orgEvents = (fx: Fixture) => {
  const events: { type: string; event?: { type: string; userId?: string; agentId?: string } }[] = [];
  fx.pubsub.subscribe(orgTopic(fx.org.id), (e) => events.push(e as (typeof events)[number]));
  return events;
};

test("a hidden person reads as offline to everyone else, hidden to themselves", () => {
  expect(memberPresence({ availability: "auto" }, true, false)).toBe("online");
  expect(memberPresence({ availability: "auto" }, false, false)).toBe("offline");
  expect(memberPresence({ availability: "busy" }, true, false)).toBe("busy");
  expect(memberPresence({ availability: "busy" }, false, false)).toBe("offline");
  expect(memberPresence({ availability: "away" }, true, false)).toBe("away");
  expect(memberPresence({ availability: "hidden" }, true, false)).toBe("offline");
  expect(memberPresence({ availability: "hidden" }, true, true)).toBe("hidden");
});

test("a written status clears itself when its time is up", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const row = { statusText: "Em reunião", statusEmoji: "📅", statusUntil: new Date("2026-10-30T13:00:00Z") };
  expect(memberStatus(row, now)).toEqual({ text: "Em reunião", emoji: "📅", until: "2026-10-30T13:00:00.000Z" });
  expect(memberStatus(row, new Date("2026-10-30T13:00:00Z"))).toBeNull();
  expect(memberStatus({ statusText: null, statusEmoji: null, statusUntil: null }, now)).toBeNull();
});

// This can be the shard's first database: allow the PGlite template to finish migrating.
test("a person sets and clears their availability and line; the workspace hears it", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const events = orgEvents(f);
  await setMyStatus({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, {
    availability: "busy",
    status: { text: "  Revisando   contratos ", emoji: "📄" },
  });
  let me = (await listMembers(f.db, f.org.id)).find((m) => m.userId === bia.id);
  expect(me).toMatchObject({ availability: "busy", statusText: "Revisando contratos", statusEmoji: "📄" });
  expect(events.at(-1)?.event).toMatchObject({ type: "member.status", userId: bia.id });

  // Only the line: the availability stays.
  await setMyStatus({ db: f.db }, bia.id, f.org.id, { status: null });
  me = (await listMembers(f.db, f.org.id)).find((m) => m.userId === bia.id);
  expect(me).toMatchObject({ availability: "busy", statusText: null, statusEmoji: null, statusUntil: null });

  await expect(
    setMyStatus({ db: f.db }, bia.id, f.org.id, { status: { text: "x".repeat(101) } }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    setMyStatus({ db: f.db }, bia.id, f.org.id, { status: { text: "Almoço", until: "2020-01-01T00:00:00Z" } }),
  ).rejects.toBeInstanceOf(ValidationError);
}, 20_000);

test("while hidden, last seen stops moving and coming online tells nobody", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const seen = new Date("2026-10-30T10:00:00Z");
  await touchLastSeen(f.db, f.org.id, bia.id, seen);
  await setMyStatus({ db: f.db }, bia.id, f.org.id, { availability: "hidden" });
  await touchLastSeen(f.db, f.org.id, bia.id, new Date("2026-10-30T11:00:00Z"));
  const me = (await listMembers(f.db, f.org.id)).find((m) => m.userId === bia.id);
  expect(me?.lastSeenAt?.toISOString()).toBe(seen.toISOString());

  const events = orgEvents(f);
  await announcePresence({ db: f.db, pubsub: f.pubsub }, f.org.id, bia.id);
  expect(events).toHaveLength(0);
  await setMyStatus({ db: f.db }, bia.id, f.org.id, { availability: "auto" });
  events.length = 0;
  await announcePresence({ db: f.db, pubsub: f.pubsub }, f.org.id, bia.id);
  expect(events.map((e) => e.event?.type)).toEqual(["member.status"]);
});

/** A run of the fixture's agent in #general (the message names nobody, so it starts none of its own). */
async function runOf(fx: Fixture, values: Partial<typeof schema.agentRuns.$inferInsert> & { agoMs?: number } = {}) {
  const { agoMs = 0, ...rest } = values;
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: `oi ${Math.random()}`,
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(Date.now() - agoMs),
      ...rest,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const finish = (fx: Fixture, runId: string) =>
  fx.db.update(schema.agentRuns).set({ status: "done", finishedAt: new Date() }).where(eq(schema.agentRuns.id, runId));

const presenceOf = async (fx: Fixture, now = new Date()) =>
  (await loadAgentStatuses(fx.db, fx.org.id, now)).find((s) => s.agentId === fx.agent.id);

test("an agent's presence follows its work: busy on long or background work, away idle, offline held", async () => {
  f = await setup();
  // Just made, it never worked: online from its making, away once that is a while ago.
  expect(await presenceOf(f)).toMatchObject({ presence: "online", working: false, activeAt: null });
  expect((await presenceOf(f, new Date(Date.now() + AGENT_AWAY_AFTER_MS + 1000)))?.presence).toBe("away");

  const run = await runOf(f);
  // At work: the apps draw it so whatever its AI reads as for the one looking (the right hand's is each person's own).
  expect(await presenceOf(f)).toMatchObject({ presence: "online", working: true });
  // Going for over 2 minutes with a live worker (fresh heartbeat): heavy work.
  await f.db
    .update(schema.agentRuns)
    .set({ startedAt: new Date(Date.now() - AGENT_HEAVY_AFTER_MS - 1000), heartbeatAt: new Date() })
    .where(eq(schema.agentRuns.id, run.id));
  expect((await presenceOf(f))?.presence).toBe("busy");

  await finish(f, run.id);
  expect(await presenceOf(f)).toMatchObject({ presence: "online", working: false });
  expect((await presenceOf(f, new Date(Date.now() + AGENT_AWAY_AFTER_MS + 1000)))?.presence).toBe("away");

  await runOf(f, { background: true });
  expect((await presenceOf(f))?.presence).toBe("busy");

  await f.db.update(schema.agents).set({ operatorHoldAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
  expect((await presenceOf(f))?.presence).toBe("offline");
  // A member reads it too.
  expect((await agentStatuses(f.db, f.owner.id, f.org.id)).length).toBeGreaterThan(0);
});

const ctxOf = (fx: Fixture, runId: string): ToolContext => ({
  db: fx.db,
  orgId: fx.org.id,
  agentId: fx.agent.id,
  runId,
  channelId: fx.general.id,
  threadRootId: runId,
  triggerMessageId: runId,
});

test("set_status: the agent's line lasts while its run does (or its minutes), busy makes it busy", async () => {
  f = await setup();
  const events = orgEvents(f);
  const [tool] = await createSetStatusToolSource({ pubsub: f.pubsub }).tools({} as ToolContext);
  if (!tool) throw new Error("no tool");
  const run = await runOf(f);

  await tool.execute({ text: "Rodando a migração", emoji: "🛠️", busy: true }, ctxOf(f, run.id));
  let s = await presenceOf(f);
  expect(s).toMatchObject({ presence: "busy", status: { text: "Rodando a migração", emoji: "🛠️", until: null } });
  expect(events.at(-1)?.event).toMatchObject({ type: "agent.status", agentId: f.agent.id });

  await finish(f, run.id);
  s = await presenceOf(f);
  expect(s?.status).toBeNull();
  expect(s?.presence).toBe("online");

  const next = await runOf(f);
  await tool.execute({ text: "Fora até amanhã", minutes: 60 }, ctxOf(f, next.id));
  await finish(f, next.id);
  expect((await presenceOf(f))?.status?.text).toBe("Fora até amanhã");
  expect((await presenceOf(f, new Date(Date.now() + 61 * 60_000)))?.status).toBeNull();

  await tool.execute({ text: "" }, ctxOf(f, next.id));
  expect((await presenceOf(f))?.status).toBeNull();
});

test("set_status is allowed for every kind of run", () => {
  const tool = { name: "set_status", scope: "" };
  expect(toolPolicy({ kind: "person", userId: "u" } as never, tool)).toEqual({ action: "allow" });
  expect(toolPolicy({ kind: "routine", brief: { access: "read" } } as never, tool)).toEqual({ action: "allow" });
  expect(toolPolicy({ kind: "unattended", reason: "routine", routineAccess: "read" } as never, tool)).toEqual({
    action: "allow",
  });
});

test("a running run whose worker died stops counting at once: no line, and the agent isn't busy", async () => {
  f = await setup();
  const run = await runOf(f, { background: true, heartbeatAt: new Date(Date.now() - AGENT_HEARTBEAT_FRESH_MS - 1000) });
  await startRunStatus({ db: f.db }, run, [{ key: "c0", kind: "routine", subject: "Relatório", text: "x" }], null);
  const s = await presenceOf(f);
  expect(s?.presence).not.toBe("busy");
  expect(s?.status).toBeNull();
});

test("a waiting run says what it waits on, and keeps the agent online, not busy", async () => {
  f = await setup();
  const run = await runOf(f, { status: "waiting_approval" });
  await startRunStatus({ db: f.db }, run, [{ key: "c0", kind: "channel", subject: "general", text: "x" }], null);
  expect(await presenceOf(f)).toMatchObject({
    presence: "online",
    working: false,
    status: { by: "wait", kind: "waiting_approval" },
  });
});

test("a run in line for room on its computer says so, not that the computer is gone", async () => {
  f = await setup();
  const machineId = crypto.randomUUID();
  const waiting = (code: string) => ({ waitingForBrain: { kind: "claude_code", machineId, code, waitId: "w" } });
  await runOf(f, { status: "waiting_input", waitingMachineId: machineId, transcript: waiting("busy") });
  expect((await presenceOf(f))?.status).toMatchObject({ by: "wait", kind: "queued_computer" });
  await f.db.update(schema.agentRuns).set({ transcript: waiting("machine_offline") });
  expect((await presenceOf(f))?.status).toMatchObject({ by: "wait", kind: "waiting_computer" });
});

test("the run's line: public channels by name, nothing for a private conversation", async () => {
  f = await setup();
  const run = await runOf(f);
  const lines = await statusCandidates(f.db, run, []);
  expect(lines.map((l) => [l.kind, l.subject])).toEqual([["channel", f.general.name]]);
  expect(await statusCandidates(f.db, { ...run, channelId: crypto.randomUUID() }, [])).toEqual([]);
});

test("Jev's pick shows only when worth it; its weight sets busy; without Jev only a task line; own words kept", async () => {
  f = await setup();
  const run = await runOf(f);
  const candidates = [
    { key: "c0", kind: "channel" as const, subject: "general", text: "Answering in #general" },
    { key: "c1", kind: "coding" as const, subject: null, text: "Coding" },
  ];
  await startRunStatus({ db: f.db }, run, candidates, { line: "c1", heavy: 0.8, worth: 0.9 });
  expect(await presenceOf(f)).toMatchObject({ presence: "busy", status: { by: "auto", kind: "coding" } });

  // A quick reply: not worth a line.
  await startRunStatus({ db: f.db }, run, candidates, { line: "c0", heavy: 0.1, worth: 0.2 });
  expect(await presenceOf(f)).toMatchObject({ presence: "online", status: null });

  // No Jev: only what the work is for.
  await startRunStatus({ db: f.db }, run, candidates, null);
  expect((await presenceOf(f))?.status).toBeNull();
  await startRunStatus(
    { db: f.db },
    run,
    [...candidates, { key: "c2", kind: "task", subject: "Login", text: "x" }],
    null,
  );
  expect((await presenceOf(f))?.status).toMatchObject({ kind: "task", subject: "Login" });

  const [tool] = await createSetStatusToolSource().tools({} as ToolContext);
  await tool?.execute({ text: "Revisando o PR #12" }, ctxOf(f, run.id));
  await startRunStatus({ db: f.db }, run, candidates, { line: "c1", heavy: 0, worth: 1 });
  expect((await presenceOf(f))?.status).toMatchObject({ by: "self", text: "Revisando o PR #12" });
});

test("the line follows real work (heavy or long, at most every 30 s, a task stays); Jev replaces stale own words", async () => {
  f = await setup();
  const t0 = new Date();
  const quick = await runOf(f);
  const browser = { name: "browser_do", scope: "browser:use" };
  const code = { name: "run_code", scope: "sandbox:run" };
  // A quick reply that opens a page: no line.
  await startRunStatus({ db: f.db }, quick, [], null, t0);
  await followWork({ db: f.db }, { orgId: f.org.id, agentId: f.agent.id, runId: quick.id }, browser, t0);
  expect((await presenceOf(f))?.status).toBeNull();
  await finish(f, quick.id);

  // Going for 3 minutes: real work.
  const run = await runOf(f, { startedAt: new Date(t0.getTime() - 3 * 60_000), heartbeatAt: t0 });
  const ctx = { orgId: f.org.id, agentId: f.agent.id, runId: run.id };
  await startRunStatus({ db: f.db }, run, [{ key: "c0", kind: "channel", subject: "general", text: "x" }], null, t0);
  await followWork({ db: f.db }, ctx, browser, new Date(t0.getTime() + AGENT_LINE_EVERY_MS + 1));
  expect((await presenceOf(f))?.status).toMatchObject({ by: "auto", kind: "browsing" });
  // Too soon for another change.
  await followWork({ db: f.db }, ctx, code, new Date(t0.getTime() + AGENT_LINE_EVERY_MS + 2));
  expect((await presenceOf(f))?.status?.kind).toBe("browsing");

  await startRunStatus({ db: f.db }, run, [{ key: "c0", kind: "task", subject: "Login", text: "x" }], null, t0);
  await followWork({ db: f.db }, ctx, code, new Date(t0.getTime() + 10 * AGENT_LINE_EVERY_MS));
  expect((await presenceOf(f))?.status).toMatchObject({ kind: "task", subject: "Login" });

  const [tool] = await createSetStatusToolSource().tools({} as ToolContext);
  await tool?.execute({ text: "Escrevendo o relatório" }, ctxOf(f, run.id));
  const judge = createFakeJudge((kind) => (kind === "status_fits" ? 0.1 : undefined));
  await followWork({ db: f.db, judge }, ctx, browser);
  expect(judge.calls.map((c) => c.kind)).toEqual(["status_fits"]);
  expect((await presenceOf(f))?.status).toMatchObject({ by: "auto", kind: "browsing" });
});

test("Jev's request of its own: the line, its worth and the weight; level probabilities, else the expected level", async () => {
  f = await setup();
  const ask = (judge: ReturnType<typeof createFakeJudge>) =>
    askRunStatus(judge, {
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      agent: { name: "Dev", role: "", instructions: "" },
      message: "faz o deploy",
      recent: [],
      candidates: [{ key: "c0", kind: "coding", subject: null, text: "Coding" }],
    });
  const judge = createFakeJudge((_kind, id) =>
    id === "status_line"
      ? "c0"
      : id === "status_weight"
        ? { score: 2.4, probabilities: { "2": 0.5, "3": 0.3 } }
        : id === "status_worth_c0"
          ? 0.7
          : 0,
  );
  const pick = await ask(judge);
  expect(judge.calls.map((c) => c.kind)).toEqual(["agent_status"]);
  expect(pick?.line).toBe("c0");
  expect(pick?.heavy).toBeCloseTo(0.8);
  expect(pick?.worth).toBeCloseTo(0.7);
  // No distribution: the expected level decides.
  const levelOnly = createFakeJudge((_k, id) => (id === "status_weight" ? { score: 2.2 } : undefined));
  expect((await ask(levelOnly))?.heavy).toBe(1);
});

test("a task or mission title shows only where everyone may see it", async () => {
  f = await setup();
  const [secret] = await f.db
    .insert(schema.channels)
    .values({ orgId: f.org.id, name: "segredo", visibility: "private", createdByUserId: f.owner.id })
    .returning();
  const [issue] = await f.db
    .insert(schema.issues)
    .values({
      orgId: f.org.id,
      number: 1,
      title: "Demissões de março",
      channelId: secret?.id,
      createdByType: "person",
      createdById: f.owner.id,
    })
    .returning();
  const run = await runOf(f, { issueId: issue?.id ?? null });
  const lines = await statusCandidates(f.db, run, []);
  expect(JSON.stringify(lines)).not.toContain("Demissões");
  await f.db
    .update(schema.issues)
    .set({ channelId: null })
    .where(eq(schema.issues.id, issue?.id ?? ""));
  expect((await statusCandidates(f.db, run, [])).map((l) => l.kind)).toContain("task");
});

test("a quick run never wipes another live run's routine line; a timed own line holds while its run goes on", async () => {
  f = await setup();
  const routine = await runOf(f, { background: true });
  await startRunStatus({ db: f.db }, routine, [{ key: "c0", kind: "routine", subject: "Relatório", text: "x" }], null);
  const quick = await runOf(f);
  await startRunStatus({ db: f.db }, quick, [{ key: "c0", kind: "channel", subject: "general", text: "x" }], {
    line: "c0",
    heavy: 0,
    worth: 0.1,
  });
  expect((await presenceOf(f))?.status).toMatchObject({ kind: "routine", subject: "Relatório" });
  await finish(f, routine.id);
  await finish(f, quick.id);

  const long = await runOf(f);
  const [tool] = await createSetStatusToolSource().tools({} as ToolContext);
  await tool?.execute({ text: "Deploy da v2", busy: true, minutes: 5 }, ctxOf(f, long.id));
  // Past its 5 minutes, the run still going: the line and busy stay.
  const later = new Date(Date.now() + 10 * 60_000);
  await f.db.update(schema.agentRuns).set({ heartbeatAt: later }).where(eq(schema.agentRuns.id, long.id));
  expect(await presenceOf(f, later)).toMatchObject({ presence: "busy", status: { text: "Deploy da v2" } });
});

test("an agent hidden from a member keeps its presence but not its line (it can name a routine)", async () => {
  f = await setup();
  const outsider = await addMember(f.db, f.org.id, "member", "caio");
  const routine = await runOf(f, { background: true });
  await startRunStatus({ db: f.db }, routine, [{ key: "c0", kind: "routine", subject: "Relatório", text: "x" }], null);
  await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
  const of = async (userId: string) =>
    (await agentStatuses(f.db, userId, f.org.id)).find((s) => s.agentId === f.agent.id);
  expect(await of(outsider.id)).toMatchObject({ presence: "busy", status: null });
  expect((await of(f.owner.id))?.status).toMatchObject({ kind: "routine", subject: "Relatório" });
});

test("an agent idle for weeks reads as idle since then; only one with no finished run never worked", async () => {
  f = await setup();
  expect((await presenceOf(f))?.activeAt ?? null).toBeNull();
  const run = await runOf(f);
  const longAgo = new Date(Date.now() - 30 * 24 * 3600_000);
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done", createdAt: longAgo, finishedAt: longAgo })
    .where(eq(schema.agentRuns.id, run.id));
  expect((await presenceOf(f))?.activeAt).toBe(longAgo.toISOString());
  // Its last run long ago, not its making, says it is away.
  expect((await presenceOf(f))?.presence).toBe("away");
});

test("the right hand never idles away: it is where the workspace's people come to talk to it", async () => {
  f = await setup({ rightHand: true });
  const [lodi] = await f.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.builtin, "right_hand"));
  const later = new Date(Date.now() + 5 * AGENT_AWAY_AFTER_MS);
  const all = await loadAgentStatuses(f.db, f.org.id, later);
  expect(all.find((s) => s.agentId === lodi?.id)?.presence).toBe("online");
  expect(all.find((s) => s.agentId === f.agent.id)?.presence).toBe("away");
  // Held by the operators, it is offline as any agent.
  await f.db
    .update(schema.agents)
    .set({ operatorHoldAt: new Date() })
    .where(eq(schema.agents.id, lodi?.id ?? ""));
  expect((await loadAgentStatuses(f.db, f.org.id, later)).find((s) => s.agentId === lodi?.id)?.presence).toBe(
    "offline",
  );
});
