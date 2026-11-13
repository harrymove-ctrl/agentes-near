import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, orgTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainTurn,
  ConflictError,
  createAgent,
  createJobHandlers,
  createRoutine,
  drainOutbox,
  listMachineOutages,
  listMessages,
  moveAgentsFromMachine,
  type OutageDeps,
  postPersonMessage,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * "Computador desconectado": the offline computers some agents think on, who
 * waits for them (routines vs conversations), where they could go, and the
 * move: agents re-pointed, waiting runs queued on the new computer except a
 * cut-off turn that already ran tools on the old one.
 */

let f: Fixture;
afterEach(() => f?.close());

const CLAUDE = { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() };

async function scene() {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub };
  const pair = async (name: string, os: string, online: boolean, executors: Record<string, unknown> = CLAUDE) => {
    const { machineId } = await pairMachine(deps, f.owner.id, f.org.id, {
      name,
      os,
      protocol: MACHINE_PROTOCOL_VERSION,
      exec: true,
    });
    await f.db
      .update(schema.machines)
      .set({
        online,
        lastSeenAt: online ? new Date() : new Date(Date.now() - 3600_000),
        executors,
        protocol: MACHINE_PROTOCOL_VERSION,
        execAllowed: true,
      })
      .where(eq(schema.machines.id, machineId));
    return machineId;
  };
  const air = await pair("MacBook Air", "darwin", false);
  const pro = await pair("MacBook Pro", "darwin", true);
  const pc = await pair("PC do escritório", "windows", false);

  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const qa = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "QA", handle: "qa", role: "Testes", credentialId: f.credential.id, ownerUserId: bia.id },
    { model: "claude-sonnet-5-5" },
  );
  const api = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Api", handle: "api", role: "API", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db
    .update(schema.agents)
    .set({ machineId: air, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  await f.db.update(schema.agents).set({ machineId: air, brain: "codex" }).where(eq(schema.agents.id, qa.id));
  // The model brain on that computer: nobody waits for its brain there.
  await f.db.update(schema.agents).set({ machineId: air, brain: "model" }).where(eq(schema.agents.id, api.id));

  const routine = await createRoutine({ db: f.db, pubsub: f.pubsub, context: f.context }, f.owner.id, f.org.id, {
    name: "Hourly",
    agentId: f.agent.id,
    prompt: "Check the deploys.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  const waitingRun = async (
    agentId: string,
    machineId: string,
    options: { executed?: string[]; routine?: boolean; kind?: string } = {},
  ) => {
    const waitId = Bun.randomUUIDv7();
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
        status: "waiting_input",
        waitingMachineId: machineId,
        transcript: {
          messages: [],
          postedUpTo: 0,
          postedCount: 1,
          deltaSeq: 0,
          waitingForBrain: { kind: options.kind ?? "claude_code", machineId, code: "machine_offline", waitId },
          ...(options.executed ? { interruptedTurn: { prompt: "Fix it", executed: options.executed, drops: 1 } } : {}),
        },
      })
      .returning();
    if (!run) throw new Error("no run");
    if (options.routine) {
      await f.db.insert(schema.routineRuns).values({
        orgId: f.org.id,
        routineId: routine.id,
        at: new Date(Date.now() - Math.random() * 1e9),
        trigger: "schedule",
        agentRunId: run.id,
        status: "started",
      });
    }
    return { id: run.id, waitId };
  };
  const routineRun = await waitingRun(f.agent.id, air, { routine: true });
  const editedRun = await waitingRun(f.agent.id, air, { executed: ["Edit"] });
  const qaRun = await waitingRun(qa.id, air, { kind: "codex" });
  const outageDeps: OutageDeps = { db: f.db, pubsub: f.pubsub };
  return { air, pro, pc, bia, qa, api, routineRun, editedRun, qaRun, outageDeps };
}

test("outages: offline computers with computer-brain agents, waiting routines vs conversations, and the targets", async () => {
  const s = await scene();
  const { outages, targets } = await listMachineOutages(s.outageDeps, f.owner.id, f.org.id);
  expect(outages).toHaveLength(1);
  expect(outages[0]).toMatchObject({
    machineId: s.air,
    name: "MacBook Air",
    platform: "mac",
    waitingRuns: 3,
    agents: [
      { agentId: f.agent.id, name: "Dev", brain: "claude_code", waiting: { routines: 1, conversations: 1 } },
      { agentId: s.qa.id, name: "QA", brain: "codex", waiting: { routines: 0, conversations: 1 } },
    ],
  });
  expect(Date.parse(outages[0]?.offlineSince ?? "")).toBeLessThan(Date.now() - 3000_000);
  // The PC is offline too, but nobody thinks on it: no outage; it is a target (offline).
  expect(targets).toEqual([
    {
      kind: "machine",
      machineId: s.pro,
      name: "MacBook Pro",
      platform: "mac",
      managed: false,
      online: true,
      brains: ["claude_code"],
      reasonOff: null,
    },
    {
      kind: "machine",
      machineId: s.pc,
      name: "PC do escritório",
      platform: "windows",
      managed: false,
      online: false,
      brains: ["claude_code"],
      reasonOff: "offline",
    },
  ]);
});

test("outages: the workspace's own computer is marked managed, its system never said", async () => {
  const s = await scene();
  await f.db.update(schema.machines).set({ kind: "managed" }).where(eq(schema.machines.id, s.pro));
  const { targets } = await listMachineOutages(s.outageDeps, f.owner.id, f.org.id);
  expect(targets.find((t) => t.kind === "machine" && t.machineId === s.pro)).toMatchObject({
    managed: true,
    platform: "other",
  });
});

test("outages: the workspace's own computer in standby is asleep by design, never one (ADR 0161)", async () => {
  const s = await scene();
  await f.db
    .update(schema.machines)
    .set({ kind: "managed", standbyAt: new Date() })
    .where(eq(schema.machines.id, s.air));
  const { outages, targets } = await listMachineOutages(s.outageDeps, f.owner.id, f.org.id);
  expect(outages).toEqual([]);
  expect(targets.find((t) => t.machineId === s.air)).toMatchObject({ managed: true, online: false });
  // Out of standby and still away: an outage like any other.
  await f.db.update(schema.machines).set({ standbyAt: null }).where(eq(schema.machines.id, s.air));
  const after = await listMachineOutages(s.outageDeps, f.owner.id, f.org.id);
  expect(after.outages.map((o) => o.machineId)).toEqual([s.air]);
});

test("outages: a computer just gone isn't one yet (a restart, a blip), unless a run already said it waits", async () => {
  const s = await scene();
  const waitCode = async (code: string) => {
    for (const r of await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.waitingMachineId, s.air))) {
      const t = r.transcript as unknown as { waitingForBrain: Record<string, unknown> };
      await f.db
        .update(schema.agentRuns)
        .set({ transcript: { ...t, waitingForBrain: { ...t.waitingForBrain, code } } as typeof r.transcript })
        .where(eq(schema.agentRuns.id, r.id));
    }
  };
  const goneFor = async (ms: number) => {
    await f.db
      .update(schema.machines)
      .set({ lastSeenAt: new Date(Date.now() - ms) })
      .where(eq(schema.machines.id, s.air));
    return (await listMachineOutages(s.outageDeps, f.owner.id, f.org.id)).outages.map((o) => o.machineId);
  };
  // Its runs' turns were cut and wait quietly for a short while.
  await waitCode("machine_dropped");
  expect(await goneFor(20_000)).toEqual([]);
  expect(await goneFor(3 * 60_000)).toEqual([s.air]);
  // A run that already told the people it waits: the outage shows at once.
  await waitCode("machine_offline");
  expect(await goneFor(20_000)).toEqual([s.air]);
});

test("outages: a member sees only the agents they own; none when the computer is back", async () => {
  const s = await scene();
  const mine = await listMachineOutages(s.outageDeps, s.bia.id, f.org.id);
  expect(mine.outages).toHaveLength(1);
  expect(mine.outages[0]?.agents.map((a) => a.agentId)).toEqual([s.qa.id]);
  expect(mine.outages[0]?.waitingRuns).toBe(1);

  const other = await addMember(f.db, f.org.id, "member", "caio");
  expect((await listMachineOutages(s.outageDeps, other.id, f.org.id)).outages).toEqual([]);

  await f.db.update(schema.machines).set({ online: true, lastSeenAt: new Date() }).where(eq(schema.machines.id, s.air));
  expect((await listMachineOutages(s.outageDeps, f.owner.id, f.org.id)).outages).toEqual([]);
});

test("move: re-points agents that the target can run, resumes runs without executed tools, keeps the others waiting", async () => {
  const s = await scene();
  const events: { type: string; event?: { type: string; [k: string]: unknown } }[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e as (typeof events)[number]));

  const result = await moveAgentsFromMachine(s.outageDeps, f.owner.id, f.org.id, s.air, {
    agentIds: [f.agent.id, s.qa.id],
    target: { kind: "machine", machineId: s.pro },
  });
  expect(result).toEqual({
    moved: [f.agent.id],
    skipped: [{ agentId: s.qa.id, reason: "brain_unavailable" }],
    resumed: 1,
    stillWaiting: 1,
  });

  const agentRow = async (id: string) => (await f.db.select().from(schema.agents).where(eq(schema.agents.id, id)))[0];
  expect((await agentRow(f.agent.id))?.machineId).toBe(s.pro);
  expect((await agentRow(s.qa.id))?.machineId).toBe(s.air);

  const runRow = async (id: string) =>
    (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
  const resumed = await runRow(s.routineRun.id);
  expect(resumed?.waitingMachineId).toBe(s.pro);
  const wait = (resumed?.transcript as { waitingForBrain: { machineId: string; waitId: string } } | undefined)
    ?.waitingForBrain ?? { machineId: "", waitId: "" };
  expect(wait.machineId).toBe(s.pro);
  expect(wait.waitId).not.toBe(s.routineRun.waitId);
  const jobs = await f.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));
  expect(jobs.filter((j) => j.payload.runId === s.routineRun.id).map((j) => j.payload.wait)).toEqual([wait.waitId]);
  // Tools already ran on the old computer: it keeps waiting for it, no job.
  expect((await runRow(s.editedRun.id))?.waitingMachineId).toBe(s.air);
  expect(jobs.some((j) => j.payload.runId === s.editedRun.id)).toBe(false);

  const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, f.org.id));
  expect(audit.find((a) => a.action === "machine.agents_moved")).toMatchObject({
    targetId: s.air,
    details: { moved: [f.agent.id], resumed: 1, stillWaiting: 1, to: { kind: "machine", machineId: s.pro } },
  });
  expect(audit.some((a) => a.action === "agent.computer_target" && a.targetId === f.agent.id)).toBe(true);
  expect(events.map((e) => e.event?.type)).toContain("machine.agents_moved");
  expect(events.find((e) => e.event?.type === "machine.agents_moved")?.event).toMatchObject({
    machineId: s.air,
    agentIds: [f.agent.id],
  });

  // Dev still has the run that waits for the Air: it stays in the outage for that one.
  const { outages } = await listMachineOutages(s.outageDeps, f.owner.id, f.org.id);
  expect(outages[0]?.agents).toEqual([
    { agentId: f.agent.id, name: "Dev", brain: "claude_code", waiting: { routines: 0, conversations: 1 } },
    { agentId: s.qa.id, name: "QA", brain: "codex", waiting: { routines: 0, conversations: 1 } },
  ]);
});

test("move: offline, unknown or same target is a conflict; members move only their own", async () => {
  const s = await scene();
  const move = (actorId: string, agentIds: string[], target: Parameters<typeof moveAgentsFromMachine>[4]["target"]) =>
    moveAgentsFromMachine(s.outageDeps, actorId, f.org.id, s.air, { agentIds, target });
  const conflict = async (p: Promise<unknown>, code: string) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(code);
  };
  await conflict(move(f.owner.id, [f.agent.id], { kind: "machine", machineId: s.pc }), "machine.target_offline");
  await conflict(
    move(f.owner.id, [f.agent.id], { kind: "machine", machineId: crypto.randomUUID() }),
    "machine.target_not_found",
  );
  await conflict(move(f.owner.id, [f.agent.id], { kind: "machine", machineId: s.air }), "machine.target_same");

  // Bia owns QA but not Dev; an agent unrelated to the computer is not found there.
  const byBia = await move(s.bia.id, [f.agent.id, s.qa.id, crypto.randomUUID()], {
    kind: "machine",
    machineId: s.pro,
  });
  expect(byBia.skipped).toEqual([
    { agentId: f.agent.id, reason: "forbidden" },
    { agentId: s.qa.id, reason: "brain_unavailable" },
    { agentId: expect.any(String), reason: "not_found" },
  ]);
  expect(byBia.moved).toEqual([]);
});

test("end to end: the waiting note names the computer and the agent; after the move the run answers on the new computer", async () => {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub };
  const pair = async (name: string, online: boolean) => {
    const { machineId } = await pairMachine(deps, f.owner.id, f.org.id, {
      name,
      os: "darwin",
      protocol: MACHINE_PROTOCOL_VERSION,
      exec: true,
    });
    await f.db
      .update(schema.machines)
      .set({ online, lastSeenAt: new Date(), executors: CLAUDE })
      .where(eq(schema.machines.id, machineId));
    return machineId;
  };
  const air = await pair("MacBook Air", false);
  await f.db
    .update(schema.agents)
    .set({ machineId: air, brain: "claude_code" })
    .where(eq(schema.agents.id, f.agent.id));
  // No key the API could answer with: the run waits for the computer.
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const onlineIds = new Set<string>();
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      seen.push(turn);
      yield { type: "done", text: "Pronto, daqui." };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id) => ({
        id,
        orgId: f.org.id,
        name: id === air ? "MacBook Air" : "MacBook Pro",
        online: onlineIds.has(id),
        execAllowed: true,
        os: "darwin",
        protocol: 8,
        executors: CLAUDE,
      }),
    },
  });
  await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, handlers);
  const [waiting] = await f.db.select().from(schema.agentRuns);
  expect(waiting?.status).toBe("waiting_input");
  let timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.at(-1)?.meta).toMatchObject({
    bodyCode: "brain_unavailable",
    brainUnavailable: { brain: "claude_code", code: "machine_offline", machineId: air, agentId: f.agent.id },
  });

  const pro = await pair("MacBook Pro", true);
  onlineIds.add(pro);
  const result = await moveAgentsFromMachine(deps, f.owner.id, f.org.id, air, {
    agentIds: [f.agent.id],
    target: { kind: "machine", machineId: pro },
  });
  expect(result).toEqual({ moved: [f.agent.id], skipped: [], resumed: 1, stillWaiting: 0 });
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(run?.waitingMachineId).toBeNull();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.session?.machineId).toBe(pro);
  timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.at(-1)?.body).toBe("Pronto, daqui.");
});
