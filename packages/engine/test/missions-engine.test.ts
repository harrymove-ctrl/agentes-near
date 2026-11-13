import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  askDecision,
  chooseDecision,
  closeMission,
  createMission,
  deliverInbox,
  type MachineHub,
  type MissionDeps,
  type MissionEngine,
  type MissionRunResume,
  type MissionRunStart,
  missionBrain,
  missionTurnFor,
  pauseMission,
  postPersonMessage,
  resumeMission,
  sendMissionMessage,
  startMission,
  stopMission,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { missionRunner, pairedMachine, type TaskStartRequest } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** An engine that only records what the mission side asks of it (ADR 0032 §6 integration seam). */
function fakeEngine() {
  const starts: MissionRunStart[] = [];
  const resumes: MissionRunResume[] = [];
  const cancels: Parameters<MissionEngine["cancelRuns"]>[0][] = [];
  const state = { resumeAnswer: null as { runId: string } | null };
  const engine: MissionEngine = {
    async startRun(_tx, input) {
      starts.push(input);
      return { runId: crypto.randomUUID(), steered: false };
    },
    async resumeRun(input) {
      resumes.push(input);
      return state.resumeAnswer;
    },
    async cancelRuns(input) {
      cancels.push(input);
      return ["run-canceled"];
    },
  };
  return { engine, starts, resumes, cancels, state };
}

const missionRow = async () => (await f.db.select().from(schema.missions))[0] as typeof schema.missions.$inferSelect;

/** A Claude Code mission (`/mission` from the web): its planning is an engine run. */
async function onEngine(options: { executors?: Record<string, unknown> } = {}) {
  f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
  const paired = await pairedMachine(f);
  const runner = missionRunner(f.machineHub as MachineHub, options.executors ? { executors: options.executors } : {});
  await runner.hello(paired.token);
  const fake = fakeEngine();
  const md = (): MissionDeps => ({ ...f.missionDeps, missionEngine: fake.engine });
  const view = await createMission(md(), f.owner.id, f.org.id, {
    agentId: f.agent.id,
    channelId: f.general.id,
    goal: "Build our mobile app",
    title: "Mobile app",
    repoDir: "app",
  });
  return { view, runner, paired, fake, md, mission: await missionRow() };
}

describe("missions on the engine (ADR 0032 §6)", () => {
  test("brain per mission: override first, else executor (claude → claude_code, codex → codex, agent → model)", () => {
    expect(missionBrain({ executor: "claude" })).toEqual({ brain: "claude_code" });
    expect(missionBrain({ executor: "codex" })).toEqual({ brain: "codex" });
    expect(missionBrain({ executor: "agent" })).toEqual({ brain: "model" });
    expect(missionBrain({ executor: "agent", brain: "codex", brainModel: "gpt-6" })).toEqual({
      brain: "codex",
      model: "gpt-6",
    });
    expect(missionBrain({ executor: "claude", brain: "nonsense" })).toEqual({ brain: "claude_code" });
  });

  test("proposing starts the planning as an engine run in a new main session; no executor task", async () => {
    const { runner, paired, fake, mission } = await onEngine();
    expect(runner.started).toHaveLength(0);
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]).toMatchObject({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: mission.threadRootId,
      brain: "claude_code",
      session: { id: mission.mainSessionId, resume: false, machineId: paired.machineId, cwd: "app" },
      missionId: mission.id,
      kind: "system",
      hop: 0,
    });
    expect(fake.starts[0]?.trigger).toContain("PLAN MODE");
    // The trigger is a notice in the home thread (the run answers it).
    const [notice] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fake.starts[0]?.triggerMessageId as string));
    expect(notice?.threadId).toBe(mission.threadRootId);
    expect(notice?.meta.missionInbox).toMatchObject({ missionId: mission.id });
  });

  test("a person's message in the mission thread runs with the mission's brain, resuming its session", async () => {
    const { paired, fake, md, mission } = await onEngine();
    // "Mudar algo" (POST …/messages): a notice and an engine turn in the same session.
    const out = await sendMissionMessage(md(), f.owner.id, f.org.id, mission.id, "Use tabs, not a drawer");
    expect(out.delivered).toBe(true);
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1]).toMatchObject({
      brain: "claude_code",
      session: { id: mission.mainSessionId, resume: true, machineId: paired.machineId, cwd: "app" },
      kind: "person",
      requestedBy: f.owner.id,
    });
    expect(fake.starts[1]?.trigger).toContain("Use tabs, not a drawer");

    // A message addressed to the agent in the thread starts its run in the message insert; the engine
    // resolves that run's brain from the mission.
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev how is it going?",
      threadId: mission.threadRootId,
    });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
    expect(run).toBeTruthy();
    const turn = await missionTurnFor(f.db, run as typeof schema.agentRuns.$inferSelect);
    expect(turn).toMatchObject({
      missionId: mission.id,
      brain: "claude_code",
      session: { id: mission.mainSessionId, resume: true, machineId: paired.machineId, cwd: "app" },
    });
    // Outside the mission thread: not a mission run.
    expect(
      await missionTurnFor(f.db, { orgId: f.org.id, agentId: f.agent.id, threadRootId: crypto.randomUUID() }),
    ).toBeNull();
  });

  test("a decision resumes the run paused on it with the decision text; with none paused, a new turn", async () => {
    const { paired, fake, md, mission } = await onEngine();
    await startMission(md(), f.owner.id, f.org.id, mission.id);
    expect(fake.starts.at(-1)?.trigger).toContain("The person approved the plan");
    const active = await missionRow();
    const decision = await askDecision(md(), active, null, {
      question: "Tabs or drawer?",
      options: ["Tabs", "Drawer"],
      blocking: true,
    });
    // The run that asked waits for it (the gateway's ask_decision paused it).
    const [waiting] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: mission.threadRootId,
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
        status: "waiting_input",
      })
      .returning();
    fake.state.resumeAnswer = { runId: waiting?.id as string };
    const startsBefore = fake.starts.length;
    await chooseDecision(md(), f.owner.id, f.org.id, mission.id, decision.id, "Tabs");
    expect(fake.resumes).toHaveLength(1);
    expect(fake.resumes[0]).toMatchObject({
      run: { orgId: f.org.id, agentId: f.agent.id, runId: waiting?.id, machineId: paired.machineId },
      pause: { kind: "input", id: decision.id },
      session: { id: mission.mainSessionId, resume: true },
    });
    expect(fake.resumes[0]?.result.content).toContain("Decision: Tabs or drawer? → Tabs");
    expect(fake.starts).toHaveLength(startsBefore);

    // Nothing waits on the next one (the engine says so): the answer is a new turn in the session.
    fake.state.resumeAnswer = null;
    const second = await askDecision(md(), await missionRow(), null, {
      question: "Dark mode?",
      options: ["Yes", "No"],
      blocking: true,
    });
    await chooseDecision(md(), f.owner.id, f.org.id, mission.id, second.id, "Yes");
    expect(fake.resumes).toHaveLength(2);
    expect(fake.starts).toHaveLength(startsBefore + 1);
    expect(fake.starts.at(-1)?.trigger).toContain("Decision: Dark mode? → Yes");
    expect(fake.starts.at(-1)?.session?.resume).toBe(true);
  });

  test("paused: texts wait in the inbox; resume delivers the main session's as one turn and items' as tasks", async () => {
    const { runner, fake, md, mission } = await onEngine();
    await startMission(md(), f.owner.id, f.org.id, mission.id);
    await pauseMission(md(), f.owner.id, f.org.id, mission.id);
    const startsBefore = fake.starts.length;
    const queued = await sendMissionMessage(md(), f.owner.id, f.org.id, mission.id, "Add a settings screen");
    expect(queued.delivered).toBe(false);
    // An item session's text waits too (it stays a machine task).
    const row = await missionRow();
    await f.db
      .update(schema.missions)
      .set({
        inbox: [
          ...row.inbox,
          {
            sessionId: "11111111-1111-4111-8111-111111111111",
            cwd: "app",
            text: "for the item",
            at: "2026-10-17T00:00:00.000Z",
          },
        ],
      })
      .where(eq(schema.missions.id, mission.id));
    expect((await missionRow()).inbox).toHaveLength(2);
    expect(fake.starts).toHaveLength(startsBefore);

    await resumeMission(md(), f.owner.id, f.org.id, mission.id);
    expect(fake.starts).toHaveLength(startsBefore + 1);
    expect(fake.starts.at(-1)?.trigger).toContain("Add a settings screen");
    expect(fake.starts.at(-1)?.trigger).not.toContain("for the item");
    const item = runner.started.find((t: TaskStartRequest) => t.session === "11111111-1111-4111-8111-111111111111");
    expect(item).toMatchObject({ resume: true });
    expect(item?.prompt).toContain("for the item");
    expect((await missionRow()).inbox).toHaveLength(0);
  });

  test("stop and close cancel the main session's runs in the thread", async () => {
    const { fake, md, mission } = await onEngine();
    await startMission(md(), f.owner.id, f.org.id, mission.id);
    const stopped = await stopMission(md(), f.owner.id, f.org.id, mission.id);
    expect(stopped.status).toBe("paused");
    expect(fake.cancels).toHaveLength(1);
    expect(fake.cancels[0]).toMatchObject({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: mission.threadRootId,
      actorId: f.owner.id,
      reason: "stopped",
    });
    const events = await f.db.select().from(schema.missionEvents).where(eq(schema.missionEvents.missionId, mission.id));
    expect(events.some((e) => e.kind === "engine_runs_canceled")).toBe(true);
    await closeMission(md(), f.owner.id, f.org.id, mission.id, { outcome: "canceled" });
    expect(fake.cancels.at(-1)?.reason).toBe("closed");
    // Closed: nothing reaches it any more.
    const before = fake.starts.length;
    await deliverInbox(md(), mission.id);
    expect(fake.starts).toHaveLength(before);
  });

  test("an agent-executor mission maps to the model brain (no session)", async () => {
    const { runner, fake, mission } = await onEngine({ executors: {} });
    expect(mission.executor).toBe("agent");
    expect(runner.started).toHaveLength(0);
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]?.brain).toBe("model");
    expect(fake.starts[0]?.session).toBeUndefined();
    expect(fake.starts[0]?.trigger).toContain("PLAN MODE");
  });
});
