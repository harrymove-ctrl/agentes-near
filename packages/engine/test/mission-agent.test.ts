import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  chooseDecision,
  closeMission,
  closeThread,
  createAgent,
  createMission,
  decideApproval,
  drainOutbox,
  eligibleMissionAgents,
  getMission,
  type MachineHub,
  MISSION_STUCK,
  machineExecutors,
  pauseMission,
  postPersonMessage,
  setAgentAudience,
  setMissionExecutor,
  setParticipant,
  startMachineTask,
  startMission,
  tellMainSession,
  transferMission,
  updatePlan,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { missionRunner, pairedMachine, type TaskStartRequest } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const md = () => f.missionDeps;
const missionRow = async () => (await f.db.select().from(schema.missions))[0] as typeof schema.missions.$inferSelect;
const threadMessages = (threadId: string) =>
  f.db.select().from(schema.messages).where(eq(schema.messages.threadId, threadId));
const lastText = (req: { messages: { content: unknown }[] }) => JSON.stringify(req.messages.at(-1)?.content ?? "");

/**
 * The agent of an agent-mode mission, scripted on what it last read: it
 * proposes, plans with update_plan, runs a shell task, asks a blocking
 * decision when the task ends, asks approval for the merge after the
 * decision, and says it's done once approved.
 */
const agentScript = (req: { messages: { content: unknown }[]; system: unknown }) => {
  const last = lastText(req);
  if (last.includes("Approved: go ahead")) return { chunks: ["Merged."] };
  if (last.includes("Decision: Ship to stores now?")) {
    return {
      chunks: ["Asking to merge."],
      toolUses: [
        {
          name: "request_approval",
          input: {
            action: "merge",
            target: "PR #3",
            why: "The decision came back and the checks passed: merging ships the work.",
          },
        },
      ],
    };
  }
  if (last.includes("Recorded. End your turn")) return { chunks: ["Waiting for your call."] };
  if (last.includes("[Background task")) {
    return {
      chunks: ["Tests passed."],
      toolUses: [
        {
          name: "ask_decision",
          input: {
            question: "Ship to stores now?",
            options: ["Yes", "Later"],
            recommendation: "Later",
            blocking: true,
          },
        },
      ],
    };
  }
  if (last.includes("Started background task")) return { chunks: ["Running the tests."] };
  if (last.includes("The person approved the plan")) {
    return {
      chunks: ["On it."],
      toolUses: [{ name: "start_task", input: { title: "Run tests", executor: "shell", command: "npm test" } }],
    };
  }
  if (last.includes("Plan saved")) return { chunks: ["Plan ready: press Start."] };
  if (last.includes("PLAN MODE")) {
    return {
      chunks: ["Planning."],
      toolUses: [
        {
          name: "update_plan",
          input: {
            items: [
              { id: "tests", title: "Tests pass", status: "todo" },
              { id: "ship", title: "Ship", status: "todo" },
            ],
          },
        },
        { name: "report", input: { summary: "Build and ship the app." } },
      ],
    };
  }
  if (last.includes("build the app")) {
    return {
      chunks: ["Proposing."],
      toolUses: [
        {
          name: "propose_mission",
          input: {
            title: "Mobile app",
            goal: "Build the app",
            executor: "agent",
            findings: [{ kind: "read", text: "Read the repo" }],
          },
        },
      ],
    };
  }
  return { chunks: ["ok"] };
};

async function agentMission() {
  f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
  const paired = await pairedMachine(f);
  // A runner that found no coding CLI on the machine: only the agent itself can program there.
  const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
  await runner.hello(paired.token);
  const view = await createMission(md(), f.owner.id, f.org.id, {
    agentId: f.agent.id,
    channelId: f.general.id,
    goal: "Build the app",
    title: "Mobile app",
  });
  return { view, runner, paired };
}

describe("missions with executor agent (ADR 0029)", () => {
  test("end to end: propose → plan via update_plan → start → shell task → its end wakes the agent → decision → approval → close", async () => {
    f = await setup({ machines: true, missionTools: true, reply: (req) => agentScript(req) });
    const paired = await pairedMachine(f);
    const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
    await runner.hello(paired.token);
    // Detection at hello: nothing installed, so only the agent.
    const [machine] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId));
    expect(machine?.executors.detectedAt).toBeTruthy();
    expect(machineExecutors(machine as typeof schema.machines.$inferSelect).available).toEqual(["agent"]);
    expect((await eligibleMissionAgents(md(), f.owner.id, f.org.id))[0]).toMatchObject({
      executors: ["agent"],
      defaultExecutor: "agent",
    });

    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev build the app",
    });
    await drainOutbox(f.db, f.handlers);
    let mission = await missionRow();
    expect(mission).toMatchObject({ executor: "agent", status: "proposed" });
    // Asked in the channel: the mission's home is a thread of its own.
    expect(mission.threadRootId).not.toBe(ask.id);
    // No executor session on the machine: the agent planned it itself.
    expect(runner.started).toHaveLength(0);
    expect(mission.planVersion).toBe(1);
    expect(mission.planTotal).toBe(2);
    let lines = await threadMessages(mission.threadRootId);
    expect(lines.some((m) => (m.meta.missionReport as { executor?: string } | undefined)?.executor === "agent")).toBe(
      true,
    );
    expect(lines.some((m) => m.meta.missionPlan)).toBe(true);

    await startMission(md(), f.owner.id, f.org.id, mission.id);
    await drainOutbox(f.db, f.handlers);
    const task = runner.started[0] as TaskStartRequest;
    expect(task).toMatchObject({ executor: "shell", command: "npm test" });
    expect(task.mission).toBeUndefined();
    const [taskRow] = await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, task.taskId));
    expect(taskRow?.missionId).toBe(mission.id);

    // The task's end: a notice in the thread and a run of the agent (hop reset: its own wake-ups are hop 0).
    await runner.done(task.taskId, { exitCode: 0, result: "12 passed" });
    await drainOutbox(f.db, f.handlers);
    lines = await threadMessages(mission.threadRootId);
    const notice = lines.find((m) => (m.meta.machineTask as { id?: string } | undefined)?.id === task.taskId);
    expect(notice?.hop).toBe(0);
    const woken = (await f.db.select().from(schema.agentRuns)).find((r) => r.triggerMessageId === notice?.id);
    expect(woken?.hop).toBe(1);
    const [decision] = await f.db.select().from(schema.missionDecisions);
    expect(decision).toMatchObject({ status: "pending", taskId: null, question: "Ship to stores now?" });

    // The owner decides: the agent is woken with it and asks approval for the merge (an ADR 0015 approval of its run).
    await chooseDecision(md(), f.owner.id, f.org.id, mission.id, decision?.id as string, "Later");
    await drainOutbox(f.db, f.handlers);
    const [approval] = await f.db.select().from(schema.approvals);
    expect(approval).toMatchObject({ status: "pending", missionId: mission.id, tool: "request_approval" });
    expect(approval?.runId).not.toBeNull();
    const waiting = (await f.db.select().from(schema.agentRuns)).find((r) => r.id === approval?.runId);
    expect(waiting?.status).toBe("waiting_approval");

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id as string, {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    const resumed = (await f.db.select().from(schema.agentRuns)).find((r) => r.id === approval?.runId);
    expect(resumed?.status).toBe("done");
    const events = await f.db
      .select()
      .from(schema.missionEvents)
      .where(and(eq(schema.missionEvents.missionId, mission.id), eq(schema.missionEvents.kind, "approval_granted")));
    expect(events).toHaveLength(1);

    const closed = await closeMission(md(), f.owner.id, f.org.id, mission.id, { outcome: "done" });
    expect(closed.status).toBe("done");
    mission = await missionRow();
    expect(mission.inbox).toEqual([]);
  });

  test("a report is the answer: the final reply after it (empty or a summary) posts nothing more", async () => {
    f = await setup({
      machines: true,
      missionTools: true,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("Reported in the mission's thread")) return { chunks: ["I made the plan: 2 steps."] };
        return agentScript(req);
      },
    });
    const paired = await pairedMachine(f);
    const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
    await runner.hello(paired.token);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev build the app",
    });
    await drainOutbox(f.db, f.handlers);
    expect((await missionRow()).planTotal).toBe(2);
    // The proposal's reply is in the channel, the planning turn in the mission's own thread: both count.
    const fromAgent = await f.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, f.agent.id));
    expect(fromAgent.some((m) => m.meta.missionReport)).toBe(true);
    // The planning turn left only its cards: no reply repeating the report, no empty or failed one.
    expect(fromAgent.map((m) => m.body)).not.toContain("I made the plan: 2 steps.");
    const blank = (m: (typeof fromAgent)[number]) =>
      m.body.trim() === "" && !m.meta.missionReport && !m.meta.missionPlan && !m.meta.missionLink;
    expect(fromAgent.filter(blank)).toEqual([]);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => r.status)).not.toContain("failed");
  });

  test("stuck guard: 5 wake-ups without the plan moving pause the mission (mission.paused_stuck); a person's word or a moving plan resets it", async () => {
    const { view } = await agentMission();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    for (let i = 0; i < MISSION_STUCK.idleWakeups - 1; i++) {
      await tellMainSession(md(), await missionRow(), `nudge ${i}`, { kind: "system" });
    }
    // A moving plan starts the count over.
    await updatePlan(md(), await missionRow(), {
      items: [{ id: "a", title: "A", status: "doing" }],
      source: "executor",
    });
    expect((await missionRow()).idleWakeups).toBe(0);
    for (let i = 0; i < MISSION_STUCK.idleWakeups; i++) {
      expect((await tellMainSession(md(), await missionRow(), `again ${i}`, { kind: "system" })).delivered).toBe(true);
    }
    const stuck = await tellMainSession(md(), await missionRow(), "one more", { kind: "system" });
    expect(stuck.delivered).toBe(false);
    const row = await missionRow();
    expect(row.status).toBe("paused");
    expect(row.inbox.at(-1)?.text).toBe("one more");
    const notice = (await threadMessages(view.threadId)).find((m) => m.meta.missionStuck);
    expect(notice?.meta).toMatchObject({ bodyCode: "mission_stuck_idle", missionStuck: { reason: "no_progress" } });
  });

  test("stuck guard: the same task failing 3 times in a row pauses the mission instead of waking the agent again", async () => {
    const { view, runner } = await agentMission();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await drainOutbox(f.db, f.handlers);
    const mission = await missionRow();
    for (let i = 0; i < MISSION_STUCK.failures; i++) {
      const row = await startMachineTask(
        { db: f.db, pubsub: f.pubsub, call: (f.machineHub as MachineHub).call },
        {
          orgId: f.org.id,
          agent: { id: f.agent.id, handle: "dev" },
          machineId: mission.machineId as string,
          protocol: MACHINE_PROTOCOL_VERSION,
          machineName: "MacBook",
          channelId: f.general.id,
          threadRootId: view.threadId,
          runId: null,
          requestedByUserId: f.owner.id,
          title: "Build",
          executor: "shell",
          command: "npm run build",
          missionId: mission.id,
        },
      );
      await runner.done(row.id, { exitCode: 1 });
      await drainOutbox(f.db, f.handlers);
    }
    const after = await missionRow();
    expect(after.status).toBe("paused");
    const stuck = (await threadMessages(view.threadId)).find((m) => m.meta.missionStuck);
    expect(stuck?.meta).toMatchObject({ missionStuck: { reason: "repeated_failure", title: "Build" } });
    // The inbox says why in each reader's language, as the chat does, never the server's English.
    const [stopped] = await f.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.kind, "mission_stopped"));
    expect(stopped?.latest).toMatchObject({
      meta: {
        bodyCode: "mission_stuck_failure",
        bodyParams: { title: "Build", count: String(MISSION_STUCK.failures) },
      },
    });
    // The first two failures woke the agent with their notices; the third didn't.
    const failures = (await threadMessages(view.threadId)).filter(
      (m) => (m.meta.machineTask as { status?: string } | undefined)?.status === "failed",
    );
    expect(failures).toHaveLength(MISSION_STUCK.failures - 1);
  });

  test("after the computer was away, an interrupted shell task of an agent-mode mission wakes the agent", async () => {
    const { view, runner, paired } = await agentMission();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await drainOutbox(f.db, f.handlers);
    const mission = await missionRow();
    const row = await startMachineTask(
      { db: f.db, pubsub: f.pubsub, call: (f.machineHub as MachineHub).call },
      {
        orgId: f.org.id,
        agent: { id: f.agent.id, handle: "dev" },
        machineId: mission.machineId as string,
        protocol: MACHINE_PROTOCOL_VERSION,
        machineName: "MacBook",
        channelId: f.general.id,
        threadRootId: view.threadId,
        runId: null,
        requestedByUserId: f.owner.id,
        title: "Long build",
        executor: "shell",
        command: "make all",
        missionId: mission.id,
      },
    );
    await runner.close();
    // Back, with a journal that doesn't have it any more: interrupted for good, and the agent hears it.
    const back = missionRunner(f.machineHub as MachineHub, { executors: {}, tasks: [] });
    await back.hello(paired.token);
    await drainOutbox(f.db, f.handlers);
    const notice = (await threadMessages(view.threadId)).find(
      (m) => (m.meta.machineTask as { id?: string } | undefined)?.id === row.id,
    );
    expect((notice?.meta.machineTask as { status?: string } | undefined)?.status).toBe("interrupted");
    expect((await f.db.select().from(schema.agentRuns)).some((r) => r.triggerMessageId === notice?.id)).toBe(true);
  });

  test("tasks in a mission thread run on the mission's computer, are the mission's, and are refused before Start (only read-only commands) and while paused", async () => {
    const { view, runner } = await agentMission();
    await drainOutbox(f.db, f.handlers);
    const mission = await missionRow();
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev status?",
      threadId: view.threadId,
    });
    await drainOutbox(f.db, f.handlers);
    const run = (await f.db.select().from(schema.agentRuns)).find((r) => r.triggerMessageId === msg.id);
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id as string,
      channelId: f.general.id,
      threadRootId: view.threadId,
      triggerMessageId: msg.id,
    };
    const call = async (name: string, input: Record<string, unknown>) => {
      const out = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
      if (out?.type !== "result") throw new Error(`expected a result, got ${out?.type}`);
      return out.output;
    };
    const names = (await f.tools?.list(ctx))?.map((t) => t.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["update_plan", "report", "ask_decision", "request_review"]));
    expect(names).not.toContain("send_to_mission");
    expect(names).not.toContain("propose_mission");
    // Proposed: only reading.
    const write = await call("start_task", { title: "Build", executor: "shell", command: "npm run build" });
    expect(write.isError).toBe(true);
    expect(write.content).toContain("isn't approved yet");
    const read = await call("start_task", { title: "Look", executor: "shell", command: "git status && ls -la" });
    expect(read.isError).toBeFalsy();
    expect((runner.started.at(-1) as TaskStartRequest).command).toBe("git status && ls -la");
    const [row] = await f.db.select().from(schema.machineTasks);
    expect(row).toMatchObject({ missionId: mission.id, machineId: mission.machineId });
    // ask_decision waits for Start; paused refuses work.
    expect((await call("ask_decision", { question: "Q?", options: ["A", "B"], blocking: true })).isError).toBe(true);
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await pauseMission(md(), f.owner.id, f.org.id, view.id);
    expect(runner.canceled).toContain(row?.id as string);
    const paused = await call("run_code", { language: "bash", code: "npm test" });
    expect(paused.content).toContain("paused");
  });

  test("task tools only see the conversation's tasks; a mission's only in its thread; cancel_task needs the owner or a decider", async () => {
    const { view } = await agentMission();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await drainOutbox(f.db, f.handlers);
    const mission = await missionRow();
    const start = (threadRootId: string, title: string, missionId: string | null) =>
      startMachineTask(
        { db: f.db, pubsub: f.pubsub, call: (f.machineHub as MachineHub).call },
        {
          orgId: f.org.id,
          agent: { id: f.agent.id, handle: "dev" },
          machineId: mission.machineId as string,
          protocol: MACHINE_PROTOCOL_VERSION,
          machineName: "MacBook",
          channelId: f.general.id,
          threadRootId,
          runId: null,
          requestedByUserId: f.owner.id,
          title,
          executor: "shell",
          command: "sleep 100",
          missionId,
        },
      );
    const inMission = await start(view.threadId, "Mission work", mission.id);
    // Elsewhere in the channel, a person who takes no part asks the agent.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const other = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
      body: "@dev what runs?",
    });
    await drainOutbox(f.db, f.handlers);
    const otherTask = await start(other.id, "Bia's", null);
    const runOf = async (messageId: string) =>
      (await f.db.select().from(schema.agentRuns)).find((r) => r.triggerMessageId === messageId);
    const ctxOther = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: (await runOf(other.id))?.id as string,
      channelId: f.general.id,
      threadRootId: other.id,
      triggerMessageId: other.id,
    };
    const invoke = async (ctx: typeof ctxOther, name: string, input: Record<string, unknown>) => {
      const out = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
      if (out?.type !== "result") throw new Error("expected a result");
      return out.output;
    };
    const listed = await invoke(ctxOther, "list_tasks", {});
    expect(listed.content).toContain(otherTask.id);
    expect(listed.content).not.toContain(inMission.id);
    expect((await invoke(ctxOther, "task_status", { task_id: inMission.id })).isError).toBe(true);
    expect((await invoke(ctxOther, "cancel_task", { task_id: inMission.id })).isError).toBe(true);
    // In the mission's thread, a run for a non-participant can't stop the mission's work.
    const fromBia = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
      body: "hello there",
      threadId: view.threadId,
    });
    const ctxBia = { ...ctxOther, threadRootId: view.threadId, triggerMessageId: fromBia.id };
    const refused = await invoke(ctxBia, "cancel_task", { task_id: inMission.id });
    expect(refused).toMatchObject({ isError: true, data: { code: "mission.not_allowed" } });
  });

  test("roles and audience: deciding, taking over and lending need the agent to answer them and the computer's person", async () => {
    const { view } = await agentMission();
    const zed = await addMember(f.db, f.org.id, "member", "zed");
    const carl = await addMember(f.db, f.org.id, "admin", "carl");
    for (const u of [zed, carl]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [carl.id] });
    await expect(
      setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: zed.id, role: "decide" }),
    ).rejects.toMatchObject({ code: "mission.agent_unavailable" });
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: zed.id, role: "comment" });
    await expect(transferMission(md(), f.owner.id, f.org.id, view.id, { userId: zed.id })).rejects.toMatchObject({
      code: "mission.agent_unavailable",
    });
    // An admin who didn't pair the computer can't lend it to the new owner.
    await expect(
      transferMission(md(), carl.id, f.org.id, view.id, { userId: carl.id, lendMachine: true }),
    ).rejects.toMatchObject({ code: "mission.not_your_computer" });
    // The computer's own person can.
    const moved = await transferMission(md(), f.owner.id, f.org.id, view.id, { userId: carl.id, lendMachine: true });
    expect(moved.ownerId).toBe(carl.id);
    expect(moved.machine?.lentBy).toBe(f.owner.id);
  });

  test("the owner switches who programs before Start; a plain reply by someone who takes no part becomes a suggestion", async () => {
    const { view, runner, paired } = await agentMission();
    await expect(setMissionExecutor(md(), f.owner.id, f.org.id, view.id, "claude")).rejects.toMatchObject({
      code: "mission.executor_unavailable",
    });
    // Claude Code shows up at the next hello.
    await runner.close();
    const again = missionRunner(f.machineHub as MachineHub, { executors: { claude: { version: "2.1.300" } } });
    await again.hello(paired.token);
    const switched = await setMissionExecutor(md(), f.owner.id, f.org.id, view.id, "claude");
    expect(switched.executor).toBe("claude");
    // A new main session plans again: a notice for the agent's run (with the new brain), no task on the computer.
    expect(again.started).toHaveLength(0);
    const plans = (await threadMessages(view.threadId)).filter((m) =>
      String((m.meta.missionInbox as { text?: string } | undefined)?.text ?? "").includes("PLAN MODE"),
    );
    expect(plans).toHaveLength(2);

    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const reply = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
      body: "maybe dark mode?",
      threadId: view.threadId,
    });
    expect(reply.meta.missionSuggestion).toEqual({ status: "pending", missionId: view.id });
    expect((await getMission(md(), f.owner.id, f.org.id, view.id)).pending.suggestions).toBe(1);
  });

  test("thread controls of an open mission are its owner's (and admins'); a mission in someone else's thread adds its author as a decider", async () => {
    f = await setup({ machines: true, missionTools: true, reply: () => ({ chunks: ["ok"] }) });
    const paired = await pairedMachine(f);
    const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
    await runner.hello(paired.token);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    const root = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
      body: "the app idea",
    });
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      threadId: root.id,
      goal: "Build it",
    });
    expect((await getMission(md(), bia.id, f.org.id, view.id)).role).toBe("decide");
    // Bia wrote the thread's first message, but the mission is open: closing it is the owner's.
    await expect(closeThread({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, root.id)).rejects.toMatchObject({
      code: "thread.not_allowed",
    });
    const closed = await closeThread({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, root.id);
    expect(closed.state).toBe("closed");
  });

  test("another agent can't make the mission's agent work for someone who takes no part", async () => {
    f = await setup({
      machines: true,
      missionTools: true,
      // Ops' mention needs Dev: only the mission's rule keeps Dev from working for Bia.
      judge: (kind) => (kind === "mention_needs_nothing" ? 0 : 1),
      reply: (req) =>
        systemText(req.system).includes("(@ops)")
          ? { chunks: ["@dev please build the dark mode now"] }
          : { chunks: ["ok"] },
    });
    const paired = await pairedMachine(f);
    const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
    await runner.hello(paired.token);
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Build the app",
    });
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Infra", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
      body: "@ops ask dev for a dark mode",
      threadId: view.threadId,
    });
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.filter((r) => r.agentId === ops.id)).toHaveLength(1);
    // Dev only has the planning wake-up from the proposal (the mission's own), nothing from Ops' mention.
    const devRuns = runs.filter((r) => r.agentId === f.agent.id);
    const triggers = await Promise.all(
      devRuns.map(
        async (r) => (await f.db.select().from(schema.messages).where(eq(schema.messages.id, r.triggerMessageId)))[0],
      ),
    );
    expect(triggers.every((m) => m?.authorAgentId !== ops.id)).toBe(true);
  });
});

describe("missions arrive investigated (ADR 0037 round 2)", () => {
  const FINDINGS = [
    { kind: "read", text: "The prompt fires right after the subscription", refs: ["ReviewPrompt.swift:41"] },
    { kind: "data", text: "9 of 11 negative reviews came right after subscribing" },
    { kind: "decision", text: "After how many completed trips?" },
  ];

  test("findings and plan come with the proposal: no plan mode, the view and card show them, Start carries them", async () => {
    f = await setup({
      machines: true,
      missionTools: true,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("The person approved the plan")) return { chunks: ["On it."] };
        if (last.includes("already investigated")) return { chunks: ["Mission proposed."] };
        return {
          chunks: ["Looked at it."],
          toolUses: [
            {
              name: "propose_mission",
              input: {
                title: "Review prompt",
                goal: "Ask for a review at the right moment",
                executor: "agent",
                findings: FINDINGS,
                plan: ["Remove the trigger", "Fire after the first trip", "Test and PR"],
              },
            },
          ],
        };
      },
    });
    const paired = await pairedMachine(f);
    const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
    await runner.hello(paired.token);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev why does the review prompt show right after subscribing?",
    });
    await drainOutbox(f.db, f.handlers);
    const mission = await missionRow();
    expect(mission).toMatchObject({ status: "proposed", planVersion: 1, planTotal: 3 });
    expect(mission.findings).toHaveLength(3);
    // Asked in the channel: the mission's cards are in its own thread.
    const lines = await threadMessages(mission.threadRootId);
    // Arrives planned: no plan-mode notice to the main session.
    expect(lines.some((m) => JSON.stringify(m.meta.missionInbox ?? "").includes("PLAN MODE"))).toBe(false);
    const card = lines.find((m) => m.meta.missionPlan);
    expect((card?.meta.missionPlan as { findings?: unknown[] } | undefined)?.findings).toHaveLength(3);
    const view = await getMission(md(), f.owner.id, f.org.id, mission.id);
    expect(view.findings[0]).toEqual(FINDINGS[0] as (typeof view.findings)[number]);
    expect(view.openQuestion).toBe("After how many completed trips?");
    expect(view.plan.items.map((i) => i.title)).toEqual([
      "Remove the trigger",
      "Fire after the first trip",
      "Test and PR",
    ]);

    // Writing waits for Start; Start tells the main session what was found.
    await startMission(md(), f.owner.id, f.org.id, mission.id);
    const after = await threadMessages(mission.threadRootId);
    const start = after
      .map((m) => (m.meta.missionInbox as { text?: string } | undefined)?.text ?? "")
      .find((t) => t.startsWith("The person approved the plan"));
    expect(start).toContain("ReviewPrompt.swift:41");
    expect(start).toContain("Build on what was found");
  });

  test("findings are required and hold at most one decision", async () => {
    f = await setup({
      machines: true,
      missionTools: true,
      reply: (_req, n) => {
        if (n === 1)
          return {
            chunks: ["Proposing."],
            toolUses: [{ name: "propose_mission", input: { title: "App", goal: "Build", executor: "agent" } }],
          };
        if (n === 2)
          return {
            chunks: ["Again."],
            toolUses: [
              {
                name: "propose_mission",
                input: {
                  title: "App",
                  goal: "Build",
                  executor: "agent",
                  findings: [
                    { kind: "decision", text: "Which store?" },
                    { kind: "decision", text: "Which color?" },
                  ],
                },
              },
            ],
          };
        return { chunks: ["ok"] };
      },
    });
    const paired = await pairedMachine(f);
    const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
    await runner.hello(paired.token);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev build the app",
    });
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.missions)).toHaveLength(0);
    const seen = f.provider.calls.map((c) => JSON.stringify(c.request.messages)).join("\n");
    expect(seen).toContain("Invalid input");
    expect(seen).toContain("at most one decision");
  });

  test("a person's /mission is planned by the main session, which records findings while proposed", async () => {
    f = await setup({
      machines: true,
      missionTools: true,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("Plan saved")) return { chunks: [""] };
        if (last.includes("PLAN MODE")) {
          return {
            chunks: ["Investigating."],
            toolUses: [
              {
                name: "record_findings",
                input: { findings: [{ kind: "read", text: "No tests yet", refs: ["package.json:12"] }] },
              },
              { name: "update_plan", input: { items: [{ id: "tests", title: "Add tests", status: "todo" }] } },
            ],
          };
        }
        return { chunks: ["ok"] };
      },
    });
    const paired = await pairedMachine(f);
    const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
    await runner.hello(paired.token);
    const created = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Add tests",
      executor: "agent",
    });
    expect(created.findings).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    const view = await getMission(md(), f.owner.id, f.org.id, created.id);
    expect(view.findings).toEqual([{ kind: "read", text: "No tests yet", refs: ["package.json:12"] }]);
    expect(view.openQuestion).toBeNull();
    expect(view.status).toBe("proposed");
    expect(view.plan.total).toBe(1);
  });
});
