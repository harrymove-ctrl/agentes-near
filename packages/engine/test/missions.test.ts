import { afterEach, describe, expect, test } from "bun:test";
import {
  ASK_IN_CHAT,
  approvalMessage,
  MACHINE_PROTOCOL_VERSION,
  PERMISSION_TIMEOUT_MESSAGE,
  type ServerFrame,
} from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  afterMissionRunEnded,
  approveProvisionalDecisions,
  buildRunContext,
  chooseDecision,
  closeMission,
  createAgent,
  createMission,
  createMissionRunToolSource,
  decideCommand,
  decideJoinRequest,
  decideReview,
  decideSuggestion,
  drainOutbox,
  eligibleMissionAgents,
  getMission,
  getMissionFiles,
  getTaskOutput,
  grantScopes,
  indexSource,
  insertContextItem,
  LOW_RISK_THRESHOLD,
  listJoinRequests,
  listMissionCommands,
  listMissions,
  listThreads,
  type MachineHub,
  MISSION_RULES,
  machineExecutors,
  missionBranchPrefix,
  missionSummary,
  missionWorktreePath,
  openDm,
  opineDecision,
  pauseMission,
  postPersonMessage,
  requestFilesSync,
  requestToJoin,
  retryBlockedCommand,
  START_PROMPT,
  setAgentAudience,
  setAgentComputerTarget,
  setCommandApproval,
  setParticipant,
  startMachineTask,
  startMission,
  startSessionTask,
  stopMission,
  syncMissionFiles,
  taskNotice,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { ownerWrites } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const SANDBOX = [{ connectionId: null, scope: "sandbox:run" }];
const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.5.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};
const deps = () => ({ db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" });
const md = () => f.missionDeps;

type Request = Extract<ServerFrame, { type: "request" }>;
type TaskStartRequest = Extract<Request, { op: "task.start" }>;
type McpResult = Extract<ServerFrame, { type: "mcp.result" }>;

/** A runner over an in-memory socket: tasks, files in memory (`read`/`write`), and MCP calls. */
function missionRunner(hub: MachineHub) {
  const sent: ServerFrame[] = [];
  const started: TaskStartRequest[] = [];
  const files = new Map<string, string>();
  const canceled: string[] = [];
  /** `mission.worktree` requests (ADR 0044). */
  const worktree: Extract<Request, { op: "mission.worktree" }>[] = [];
  /** How `push` fails. */
  const pushes: { refusal?: { code: string; message: string } } = {};
  /** What `task.output` answers, per task. */
  const outputs = new Map<string, string[]>();
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type !== "request") return;
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "task.start") {
          started.push(frame);
          return ok({
            taskId: frame.taskId,
            pid: 100 + started.length,
            startedAt: new Date().toISOString(),
            cwd: frame.branch ? `.worktrees/${frame.taskId}` : (frame.cwd ?? ""),
            ...(frame.branch ? { branch: frame.branch } : {}),
            command: "claude -p --output-format stream-json",
          });
        }
        if (frame.op === "task.cancel") {
          canceled.push(frame.taskId);
          return ok({ canceled: true });
        }
        if (frame.op === "mission.worktree") {
          worktree.push(frame);
          if (frame.action === "remove") return ok({ removed: true });
          return ok({
            path: frame.path,
            branch: frame.branch,
            baseBranch: "main",
            baseSha: frame.baseSha ?? "0123456789abcdef0123456789abcdef01234567",
            created: !frame.baseSha,
            dirty: false,
            setupCommand: null,
            copied: [],
          });
        }
        if (frame.op === "task.output") {
          const lines = outputs.get(frame.taskId) ?? [];
          return ok({ lines: lines.slice(-frame.tail), truncated: lines.length > frame.tail });
        }
        if (frame.op === "read") {
          const text = files.get(frame.path);
          return ok(
            text === undefined
              ? { base64: null, size: 0 }
              : { base64: Buffer.from(text).toString("base64"), size: text.length },
          );
        }
        if (frame.op === "write") {
          files.set(frame.path, Buffer.from(frame.base64, "base64").toString("utf8"));
          return ok({ size: frame.base64.length });
        }
        if (frame.op === "push" && pushes.refusal) {
          return void reply({ type: "result", id: frame.id, ok: false, error: pushes.refusal });
        }
        return ok({});
      }, 1);
    },
    close() {
      void hub.close(conn);
    },
  };
  const conn = hub.open(socket);
  let calls = 0;
  return {
    sent,
    started,
    files,
    canceled,
    worktree,
    outputs,
    pushes,
    close: () => hub.close(conn),
    frame: (frame: Record<string, unknown>) => reply(frame),
    hello: (token: string) => hub.message(conn, JSON.stringify({ type: "hello", token, ...RUNNER, exec: true })),
    /** The executor of `taskId` calls one of our MCP tools; resolves with the server's answer. */
    async mcp(taskId: string, tool: string, args: Record<string, unknown>): Promise<McpResult> {
      const callId = `call-${++calls}`;
      await reply({ type: "mcp.call", callId, taskId, tool, args });
      for (let i = 0; i < 400; i++) {
        const found = sent.find((s): s is McpResult => s.type === "mcp.result" && s.callId === callId);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`no mcp.result for ${tool}`);
    },
    done: (taskId: string, extra: Record<string, unknown> = {}) =>
      reply({ type: "task.done", taskId, exitCode: 0, seconds: 60, ...extra }),
  };
}

async function pairedMachine() {
  const paired = await pairMachine(deps(), f.owner.id, f.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
  await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, paired.machineId);
  return paired;
}

const missionRow = async () => (await f.db.select().from(schema.missions))[0] as typeof schema.missions.$inferSelect;
const ok = (r: McpResult) => {
  if (!r.ok) throw new Error(`mcp refused: ${r.error.code} ${r.error.message}`);
  return r.text;
};

/**
 * A mission made from the web (`/mission`), its runner connected, its planning turn (the main session's run,
 * ADR 0032 §6) answered, and one item session of it running on the computer (`task`).
 */
async function proposed(
  options: {
    reply?: NonNullable<Parameters<typeof setup>[0]>["reply"];
    judge?: NonNullable<Parameters<typeof setup>[0]>["judge"];
  } = {},
) {
  f = await setup({
    machines: true,
    missionTools: true,
    reply: options.reply ?? (() => ({ chunks: ["ok"] })),
    ...(options.judge ? { judge: options.judge } : {}),
  });
  const paired = await pairedMachine();
  const runner = missionRunner(f.machineHub as MachineHub);
  await runner.hello(paired.token);
  const view = await createMission(md(), f.owner.id, f.org.id, {
    agentId: f.agent.id,
    channelId: f.general.id,
    goal: "Build our mobile app",
    title: "Mobile app",
    repoDir: "app",
  });
  await drainOutbox(f.db, f.handlers);
  const mission = await missionRow();
  await startSessionTask(md(), mission, {
    title: "Explore",
    prompt: "Map the repo",
    sessionId: crypto.randomUUID(),
    cwd: mission.repoDir,
    resume: false,
  });
  const task = runner.started[0] as TaskStartRequest;
  return { view, runner, task, paired };
}

/**
 * The main session (the agent's run in the mission thread, a computer brain through the runner bridge) calls
 * one of its machine tools (`start_task`, `upload_artifact`, `get_context`, `permission_prompt`).
 */
async function mainCall(tool: string, args: Record<string, unknown>) {
  const mission = await missionRow();
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: mission.channelId,
      threadRootId: mission.threadRootId,
      triggerMessageId: await ownerWrites(f, mission),
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  const ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run?.id as string,
    channelId: mission.channelId,
    threadRootId: mission.threadRootId,
    triggerMessageId: run?.triggerMessageId as string,
    bridge: { machineId: mission.machineId as string },
  };
  const { db: _db, ...deps } = f.missionDeps;
  const found = (await createMissionRunToolSource(deps).tools(ctx)).find((t) => t.name === tool);
  if (!found) throw new Error(`the main session has no ${tool}`);
  const out = await found.execute(args, ctx);
  // The turn ends: write items queued behind it start (ADR 0044).
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done" })
    .where(eq(schema.agentRuns.id, run?.id as string));
  await afterMissionRunEnded(f.missionDeps, run?.id as string);
  return out;
}
const done = (out: { content: string; isError?: boolean }) => {
  if (out.isError) throw new Error(`refused: ${out.content}`);
  return out.content;
};

/** The notices the mission posted in its thread for the main session (`meta.missionInbox`). */
const notices = async (threadId: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, threadId)))
    .map((m) => m.meta.missionInbox as { text?: string } | undefined)
    .filter((x): x is { text?: string } => Boolean(x))
    .map((x) => x.text ?? "");

describe("missions (ADR 0029)", () => {
  test("get_context: its owner's preferences come in, nobody else's", async () => {
    await proposed();
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    for (const [userId, content] of [
      [bob.id, "Relatórios secretos do bob vão por fora."],
      [f.owner.id, "Relatórios secretos do dono vão às sextas."],
    ] as const) {
      const item = await insertContextItem(f.db, {
        orgId: f.org.id,
        kind: "preference",
        scopeType: "person",
        scopeId: userId,
        agentId: f.agent.id,
        content,
      });
      await indexSource(f.context, { orgId: f.org.id, kind: "context_item", sourceId: item.id });
    }
    const found = JSON.stringify(await mainCall("get_context", { query: "relatórios secretos" }));
    expect(found).toContain("do dono");
    expect(found).not.toContain("do bob");
  });

  test("proposed from a flat DM: its home is a new thread and the agent's reply in the DM carries the link card", async () => {
    f = await setup({
      machines: true,
      missionTools: true,
      reply: (_req, n) =>
        n === 1
          ? {
              chunks: ["Planning it."],
              toolUses: [
                {
                  name: "propose_mission",
                  input: {
                    title: "Photos",
                    goal: "Make a contact sheet",
                    findings: [{ kind: "read", text: "Read the repo" }],
                  },
                },
              ],
            }
          : { chunks: ["Proposed the mission; the plan is coming."] },
    });
    const paired = await pairedMachine();
    const runner = missionRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "make a contact sheet of my photos",
    });
    await drainOutbox(f.db, f.handlers);
    const mission = await missionRow();
    expect(mission.threadRootId).not.toBe(ask.id);
    const replies = await f.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, dm.id), eq(schema.messages.authorAgentId, f.agent.id)));
    const linked = replies.filter((m) => m.meta.missionLink);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.threadId).toBeNull();
    expect(linked[0]?.meta.missionLink).toEqual({ missionId: mission.id, threadId: mission.threadRootId });
    // The tool told the model not to name the app's buttons (the DM run's turn after the tool).
    const toolResult = f.provider.calls
      .map((c) => JSON.stringify(c.request.messages))
      .find((m) => m.includes("don't name buttons"));
    expect(toolResult).toBeTruthy();
    expect(toolResult).not.toContain("press Start");
  });

  test("the agent proposes (plan card, the planning is the main session's run); only the owner starts", async () => {
    f = await setup({
      machines: true,
      missionTools: true,
      reply: (_req, n) =>
        n === 1
          ? {
              chunks: ["Planning it."],
              toolUses: [
                {
                  name: "propose_mission",
                  input: {
                    title: "Mobile app",
                    goal: "Build our mobile app",
                    findings: [{ kind: "read", text: "Read the repo" }],
                  },
                },
              ],
            }
          : { chunks: ["Planning; the plan card shows when it is ready."] },
    });
    const paired = await pairedMachine();
    const runner = missionRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev build our mobile app with Claude Code",
    });
    await drainOutbox(f.db, f.handlers);
    const mission = await missionRow();
    expect(mission).toMatchObject({
      status: "proposed",
      ownerId: f.owner.id,
      title: "Mobile app",
      executor: "claude",
    });
    // Asked in the channel: the mission's home is a thread of its own, like from a DM.
    expect(mission.threadRootId).not.toBe(ask.id);
    // No executor task: the main session is the agent's run in the thread, told to plan.
    expect(runner.started).toHaveLength(0);
    expect((await notices(mission.threadRootId)).some((t) => t.includes("PLAN MODE"))).toBe(true);
    const thread = await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, mission.threadRootId));
    const card = thread.find((m) => m.meta.missionPlan);
    expect(card?.meta).toMatchObject({ missionPlan: { missionId: mission.id }, bodyCode: "mission_plan" });
    expect(card?.authorAgentId).toBe(f.agent.id);

    // A decider can't press Start; the owner can.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    await setParticipant(md(), f.owner.id, f.org.id, mission.id, { userId: bia.id, role: "decide" });
    await expect(startMission(md(), bia.id, f.org.id, mission.id)).rejects.toMatchObject({ code: "mission.not_owner" });
    const started = await startMission(md(), f.owner.id, f.org.id, mission.id);
    expect(started.status).toBe("active");
    // "Proceed" is a notice that starts (or joins) the main session's run; nothing goes to the computer by itself.
    const after = await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, mission.threadRootId));
    const notice = after.find((m) =>
      (m.meta.missionInbox as { text?: string } | undefined)?.text?.startsWith(START_PROMPT),
    );
    expect(notice).toBeTruthy();
    const runs = await f.db.select().from(schema.agentRuns);
    expect(
      runs.some((r) => r.triggerMessageId === notice?.id || r.pendingMessageIds.includes(notice?.id as string)),
    ).toBe(true);
    expect(runner.started).toHaveLength(0);
    expect((await missionRow()).inbox).toHaveLength(0);
  });

  test("update_plan versions the plan; changes after the first post one line; mission brief in the run's context", async () => {
    const { view, runner, task: plan } = await proposed();
    const first = ok(
      await runner.mcp(plan.taskId, "update_plan", {
        items: [
          { id: "nav", title: "Navigation", status: "doing" },
          { id: "auth", title: "Sign-in", status: "todo" },
        ],
      }),
    );
    expect(first).toContain("version 1");
    let lines = await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId));
    expect(lines.some((m) => m.meta.missionPlanChange)).toBe(false);
    ok(
      await runner.mcp(plan.taskId, "update_plan", {
        items: [
          { id: "nav", title: "Navigation", status: "done" },
          { id: "build", title: "Dev build", status: "todo" },
        ],
      }),
    );
    lines = await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId));
    const change = lines.find((m) => m.meta.missionPlanChange);
    expect(change?.meta.missionPlanChange).toMatchObject({
      version: 2,
      added: [{ id: "build", title: "Dev build" }],
      removed: [{ id: "auth", title: "Sign-in" }],
      changed: [{ id: "nav", from: "doing", to: "done" }],
    });
    expect((await missionRow()).planDone).toBe(1);
    const versions = await f.db.select().from(schema.missionPlanVersions);
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);

    // The owner asks the agent in the thread: its context has the brief.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev how is it going?",
      threadId: view.threadId,
    });
    await drainOutbox(f.db, f.handlers);
    const system = JSON.stringify(f.provider.calls.at(-1)?.request.system ?? "");
    expect(system).toContain("# Mission in this thread");
    expect(system).toContain("Plan: 1 of 2 done");
    // The run is the main session, whatever its brain: it does the work itself.
    expect(system).toContain("You do this mission's work yourself");
    expect(system).not.toContain("send_to_mission");
  });

  test("roles: a non-participant's or commenter's mention is a suggestion (no run); a decider's starts a run; accept forwards it", async () => {
    const { view } = await proposed();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const duda = await addMember(f.db, f.org.id, "member", "duda");
    for (const u of [bia, caio, duda]) {
      await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
    }
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: caio.id, role: "comment" });
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: duda.id, role: "decide" });
    const post = (userId: string, body: string) =>
      postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, {
        body,
        threadId: view.threadId,
      });

    const fromBia = await post(bia.id, "@dev add a dark mode");
    const fromCaio = await post(caio.id, "@dev use tabs");
    expect(fromBia.meta.missionSuggestion).toEqual({ status: "pending", missionId: view.id });
    expect(fromCaio.meta.missionSuggestion).toEqual({ status: "pending", missionId: view.id });
    await drainOutbox(f.db, f.handlers);
    const runs = () => f.db.select().from(schema.agentRuns);
    const by = async (ids: string[]) => (await runs()).filter((r) => ids.includes(r.triggerMessageId));
    expect(await by([fromBia.id, fromCaio.id])).toHaveLength(0);
    const fromDuda = await post(duda.id, "@dev what's the status?");
    expect(fromDuda.meta.missionSuggestion).toBeUndefined();
    expect(await by([fromDuda.id])).toHaveLength(1);
    expect((await getMission(md(), bia.id, f.org.id, view.id)).role).toBe("none");

    // A commenter can't decline; the owner accepts: the main session gets it (a notice for its run).
    await expect(decideSuggestion(md(), caio.id, f.org.id, view.id, fromBia.id, "declined")).rejects.toMatchObject({
      code: "mission.not_allowed",
    });
    await decideSuggestion(md(), f.owner.id, f.org.id, view.id, fromCaio.id, "declined");
    await decideSuggestion(md(), f.owner.id, f.org.id, view.id, fromBia.id, "accepted");
    const told = await notices(view.threadId);
    expect(told.some((t) => t.includes("Suggestion from bia, accepted by ana:") && t.includes("add a dark mode"))).toBe(
      true,
    );
    expect(told.some((t) => t.includes("use tabs"))).toBe(false);
  });

  test("blocking decision: the item session waits; commenters only give opinions; the choice resumes it", async () => {
    const { view, runner, task: plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: caio.id });
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: caio.id, role: "comment" });
    const text = ok(
      await runner.mcp(plan.taskId, "ask_decision", {
        question: "Navigation style?",
        options: ["Tabs", "Drawer"],
        recommendation: "Tabs",
        why: "Fewer taps",
        blocking: true,
      }),
    );
    expect(text).toBe("Recorded. Stop now and wait; you'll be resumed with the decision.");
    const [decision] = await f.db.select().from(schema.missionDecisions);
    expect(decision).toMatchObject({ status: "pending", sessionId: plan.session, taskId: plan.taskId });
    const card = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
      (m) => m.meta.missionDecision,
    );
    expect(card?.meta.missionDecision).toEqual({ id: decision?.id, missionId: view.id });
    await runner.done(plan.taskId);
    await drainOutbox(f.db, f.handlers);
    const before = runner.started.length;

    const id = decision?.id as string;
    await expect(chooseDecision(md(), caio.id, f.org.id, view.id, id, "Tabs")).rejects.toMatchObject({
      code: "mission.not_allowed",
    });
    const opined = await opineDecision(md(), caio.id, f.org.id, view.id, id, "Tabs");
    expect(opined.opinions).toEqual([{ userId: caio.id, option: "Tabs", at: expect.any(String) }]);
    const taken = await chooseDecision(md(), f.owner.id, f.org.id, view.id, id, "Drawer");
    expect(taken).toMatchObject({ status: "taken", chosen: "Drawer", chosenBy: f.owner.id });
    const resumed = runner.started[before] as TaskStartRequest;
    expect(resumed).toMatchObject({
      session: plan.session,
      resume: true,
      prompt: "Decision: Navigation style? → Drawer (by ana)",
      cwd: "app",
    });
  });

  test("provisional decisions go on with the recommendation and are approved together", async () => {
    const { view, runner, task: plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const text = ok(
      await runner.mcp(plan.taskId, "ask_decision", {
        question: "Icon set?",
        options: ["Lucide", "Phosphor"],
        recommendation: "Phosphor",
        blocking: false,
      }),
    );
    expect(text).toBe("Recorded as provisional: continue with your recommendation.");
    const [d] = await f.db.select().from(schema.missionDecisions);
    expect(d).toMatchObject({ status: "provisional", chosen: "Phosphor" });
    const before = runner.started.length;
    const approved = await approveProvisionalDecisions(md(), f.owner.id, f.org.id, view.id);
    expect(approved.map((x) => x.status)).toEqual(["taken"]);
    expect(runner.started.length).toBe(before);
  });

  test("upload_artifact: a path written in full reaches the runner as is, and a refusal reads like upload_file's", async () => {
    const { view, runner, task: main } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const full = "/home/ag-0193aaaa/dev-0193aaaa/clips/big.mp4";
    runner.pushes.refusal = { code: "too_large", message: "The file has 90000000 bytes (max 52428800)" };
    const big = await runner.mcp(main.taskId, "upload_artifact", { path: full });
    expect(runner.sent.filter((s) => s.type === "request" && s.op === "push")).toEqual([
      expect.objectContaining({ path: full }),
    ]);
    expect(JSON.stringify(big)).toContain("is over the 50 MB the Drive takes per file");
  });

  test("reviews: approve or ask for changes resumes the item session with the outcome", async () => {
    const { view, runner, task: main } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    ok(await runner.mcp(main.taskId, "request_review", { title: "Navigation prototypes", summary: "Three screens" }));
    const [review] = await f.db.select().from(schema.missionReviews);
    const card = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
      (m) => m.meta.missionReview,
    );
    expect(card?.meta.missionReview).toEqual({ id: review?.id, missionId: view.id });
    await runner.done(main.taskId);
    await drainOutbox(f.db, f.handlers);
    await expect(
      decideReview(md(), f.owner.id, f.org.id, view.id, review?.id as string, { outcome: "changes_requested" }),
    ).rejects.toMatchObject({ code: "mission.review_note_required" });
    const out = await decideReview(md(), f.owner.id, f.org.id, view.id, review?.id as string, {
      outcome: "changes_requested",
      note: "Bigger buttons",
    });
    expect(out.status).toBe("changes_requested");
    expect(runner.started.at(-1)?.prompt).toBe('Changes requested on "Navigation prototypes" (by ana): Bigger buttons');
  });

  test("an item task can't ask for approvals: merges, deploys and rollbacks are the main session's", async () => {
    const { view, runner, task } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const refused = await runner.mcp(task.taskId, "request_approval", {
      action: "merge",
      target: "PR #12",
      detail: "Navigation",
    });
    expect(refused).toMatchObject({ ok: false, error: { code: "mission.unknown_tool" } });
    expect(await f.db.select().from(schema.approvals)).toHaveLength(0);
    const [row] = await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, task.taskId));
    expect(row?.waitingFor ?? null).toBeNull();
  });

  test("pause refuses new tasks (mission.paused); stop cancels the running ones", async () => {
    const { view, runner, task: plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const started = done(await mainCall("start_task", { title: "Navigation", prompt: "Build the tabs" }));
    // Items work in the mission's own folder, on its branch under the mission's prefix (ADR 0044).
    const branch = `${missionBranchPrefix(view.id)}mobile-app`;
    expect(started).toContain(`branch ${branch}`);
    const item = runner.started.at(-1) as TaskStartRequest;
    expect(item).toMatchObject({
      cwd: missionWorktreePath(view.id),
      commit: { message: "agentes: Navigation" },
      baseCheck: { branch: "main", sha: "0123456789abcdef0123456789abcdef01234567" },
      mission: { id: view.id, rules: MISSION_RULES, branchPrefix: missionBranchPrefix(view.id) },
    });
    expect(item.branch).toBeUndefined();
    expect(item.session).not.toBe(plan.session);
    // Only the main session starts tasks; an item session is told so.
    expect(ok(await runner.mcp(plan.taskId, "start_task", { title: "x", prompt: "y" }))).toContain("main session");
    expect(runner.started.at(-1)).toBe(item);
    await pauseMission(md(), f.owner.id, f.org.id, view.id);
    const refused = await mainCall("start_task", { title: "Auth", prompt: "Sign-in", branch: "auth" });
    expect(refused).toMatchObject({ isError: true, data: { code: "mission.paused" } });
    const stopped = await stopMission(md(), f.owner.id, f.org.id, view.id);
    expect(stopped.canceledTasks).toBe(2);
    expect(runner.canceled.sort()).toEqual([plan.taskId, item.taskId].sort());
  });

  test("mcp.call is refused for a task of another machine or with no mission", async () => {
    const { runner, task: plan } = await proposed();
    const plain = await startMachineTask(
      { db: f.db, pubsub: f.pubsub, call: (f.machineHub as MachineHub).call },
      {
        orgId: f.org.id,
        agent: { id: f.agent.id, handle: "dev" },
        machineId: (await missionRow()).machineId as string,
        protocol: MACHINE_PROTOCOL_VERSION,
        machineName: "MacBook",
        channelId: f.general.id,
        threadRootId: null,
        runId: null,
        requestedByUserId: f.owner.id,
        title: "Plain",
        executor: "shell",
        command: "true",
      },
    );
    expect(await runner.mcp(plain.id, "report", { summary: "hi" })).toMatchObject({
      ok: false,
      error: { code: "mission.not_allowed" },
    });
    // Another computer of the org presenting the mission's task id.
    const other = await pairMachine(deps(), f.owner.id, f.org.id, { name: "Other", ...RUNNER, exec: true });
    const intruder = missionRunner(f.machineHub as MachineHub);
    await intruder.hello(other.token);
    expect(await intruder.mcp(plan.taskId, "report", { summary: "hi" })).toMatchObject({
      ok: false,
      error: { code: "mission.not_allowed" },
    });
    expect(await runner.mcp(plan.taskId, "report", { nope: 1 })).toMatchObject({
      ok: false,
      error: { code: "mission.invalid_input" },
    });
    expect(ok(await runner.mcp(plan.taskId, "report", { summary: "Mapped the repo @ana" }))).toContain("Reported");
    const report = (await f.db.select().from(schema.messages)).find((m) => m.meta.missionReport);
    expect(report?.mentionedUserIds).toEqual([]);
    expect(report?.meta.missionReport).toMatchObject({ taskId: plan.taskId, computer: "MacBook", main: false });
  });

  test(".agentes files: written to the machine; an edit there is recorded and overwritten; notes come back after a task", async () => {
    const { view, runner, task: plan } = await proposed();
    ok(await runner.mcp(plan.taskId, "update_plan", { items: [{ id: "nav", title: "Navigation", status: "doing" }] }));
    await syncMissionFiles(md(), view.id);
    const mission = runner.files.get("app/.agentes/mission.md") ?? "";
    expect(mission).toContain("# Mission: Mobile app");
    expect(mission).toContain("- [~] Navigation");
    expect(mission).toContain("agentes.request_approval");
    expect(runner.files.get("app/.agentes/decisions.md")).toContain("# Decisions: Mobile app");

    runner.files.set("app/.agentes/mission.md", `${mission}\nlocal note by hand\n`);
    await requestFilesSync(f.db, await missionRow());
    await syncMissionFiles(md(), view.id);
    expect(runner.files.get("app/.agentes/mission.md")).toBe(mission);
    const files = await getMissionFiles(md(), f.owner.id, f.org.id, view.id);
    expect(files.editedOnMachine[0]).toMatchObject({ name: "mission.md", diff: "+ local note by hand" });

    runner.files.set("app/.agentes/notes.md", "Expo works; next: auth.");
    await runner.done(plan.taskId);
    await drainOutbox(f.db, f.handlers);
    const notes = (await getMissionFiles(md(), f.owner.id, f.org.id, view.id)).files.find((x) => x.name === "notes.md");
    expect(notes).toMatchObject({ content: "Expo works; next: auth.", source: "machine" });
  });

  test("summary from the database; closing with saveToWiki makes a page", async () => {
    const { view, runner, task: plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    ok(
      await runner.mcp(plan.taskId, "update_plan", {
        items: [
          { id: "a", title: "Navigation", status: "done" },
          { id: "b", title: "Sign-in", status: "waiting_you" },
          { id: "c", title: "Push, email", status: "waiting_you" },
        ],
      }),
    );
    const summary = await missionSummary(md(), f.owner.id, f.org.id, view.id);
    expect(summary.text).toContain("Plan: 1 of 3 done, 2 waiting for you.");
    expect(summary.text).toContain("Waiting for you: Sign-in · Push, email.");
    expect(summary.plan).toEqual({ done: 1, total: 3, doing: 0, waiting: 2 });
    const closed = await closeMission(md(), f.owner.id, f.org.id, view.id, { outcome: "done", saveToWiki: true });
    expect(closed.status).toBe("done");
    const [page] = await f.db.select().from(schema.wikiPages);
    expect(page?.title).toBe("Mobile app: decisions and lessons");
    expect(closed.wikiPageId).toBe(page?.id ?? null);
    expect(await runner.mcp(plan.taskId, "report", { summary: "late" })).toMatchObject({
      ok: false,
      error: { code: "mission.closed" },
    });
  });

  test("buildRunContext has no mission block outside a mission's thread", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const ask = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev hi",
    });
    const [run] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.triggerMessageId, ask.id)));
    const agent = (await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id)))[0];
    const ctx = await buildRunContext(
      f.db,
      run as typeof schema.agentRuns.$inferSelect,
      agent as typeof schema.agents.$inferSelect,
      {
        maxMessages: 10,
      },
    );
    expect(ctx.system.map((b) => b.text).join("\n")).not.toContain("# Mission in this thread");
  });

  test("a task's output: the computer's lines when online; the kept ring when offline; only for who reads the thread", async () => {
    const { view, runner, task: plan } = await proposed();
    runner.outputs.set(plan.taskId, ["Reading app/package.json", "Editing app/src/nav.tsx", "Running: bun test"]);
    const online = await getTaskOutput(md(), f.owner.id, f.org.id, plan.taskId, { tail: 2 });
    expect(online).toMatchObject({ source: "computer", lines: ["Editing app/src/nav.tsx", "Running: bun test"] });
    expect(runner.sent.some((s) => s.type === "request" && s.op === "task.output")).toBe(true);

    // Lines from events are kept (the same line twice in a row once), at most 50.
    for (const line of ["Reading a", "Reading a", "Editing b", ...Array.from({ length: 55 }, (_, i) => `step ${i}`)]) {
      await runner.frame({ type: "task.event", taskId: plan.taskId, kind: "line", line });
    }
    const [row] = await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, plan.taskId));
    expect(row?.recentLines).toHaveLength(50);
    expect(row?.recentLines.at(-1)).toBe("step 54");

    await runner.close();
    const offline = await getTaskOutput(md(), f.owner.id, f.org.id, plan.taskId, { tail: 3 });
    expect(offline).toMatchObject({ source: "saved", lines: ["step 52", "step 53", "step 54"], truncated: true });

    const outsider = await addMember(f.db, f.org.id, "member", "zed");
    await expect(getTaskOutput(md(), outsider.id, f.org.id, plan.taskId)).rejects.toMatchObject({
      code: "task.not_found",
    });
    expect(view.id).toBeTruthy();
  });

  test("pull requests: from a task's output line, the runner's prUrl, report and request_review", async () => {
    const { view, runner, task: plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    const prOf = async (id: string) =>
      (await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, id)))[0]?.prUrl ?? null;
    await runner.frame({
      type: "task.event",
      taskId: plan.taskId,
      kind: "line",
      line: "Opened https://github.com/acme/app/pull/431 for review",
    });
    expect(await prOf(plan.taskId)).toBe("https://github.com/acme/app/pull/431");
    // The first one stays.
    await runner.frame({
      type: "task.event",
      taskId: plan.taskId,
      kind: "progress",
      prUrl: "https://github.com/acme/app/pull/9",
    });
    expect(await prOf(plan.taskId)).toBe("https://github.com/acme/app/pull/431");

    done(await mainCall("start_task", { title: "Navigation", prompt: "Build the tabs", branch: "nav" }));
    const item = runner.started.at(-1) as TaskStartRequest;
    await runner.frame({
      type: "task.event",
      taskId: item.taskId,
      kind: "progress",
      prUrl: "https://github.com/acme/app/pull/12",
    });
    expect(await prOf(item.taskId)).toBe("https://github.com/acme/app/pull/12");

    done(await mainCall("start_task", { title: "Auth", prompt: "Sign-in", mode: "read" }));
    const auth = runner.started.at(-1) as TaskStartRequest;
    ok(
      await runner.mcp(auth.taskId, "report", {
        summary: "Sign-in is up",
        pr_url: "https://github.com/acme/app/pull/13",
      }),
    );
    expect(await prOf(auth.taskId)).toBe("https://github.com/acme/app/pull/13");

    done(await mainCall("start_task", { title: "Build", prompt: "Dev build", mode: "read" }));
    const build = runner.started.at(-1) as TaskStartRequest;
    ok(
      await runner.mcp(build.taskId, "request_review", {
        title: "Dev build",
        pr_url: "https://github.com/acme/app/pull/14",
      }),
    );
    expect(await prOf(build.taskId)).toBe("https://github.com/acme/app/pull/14");
  });

  test("the view carries plan items and what is in progress", async () => {
    const { view, runner, task: plan } = await proposed();
    ok(
      await runner.mcp(plan.taskId, "update_plan", {
        items: [
          { id: "nav", title: "Navigation", status: "doing" },
          { id: "auth", title: "Sign-in", status: "doing" },
          { id: "push", title: "Push", status: "waiting_you" },
          { id: "old", title: "Drawer", status: "dropped" },
          { id: "done", title: "Repo", status: "done" },
        ],
      }),
    );
    const m = await getMission(md(), f.owner.id, f.org.id, view.id);
    expect(m.plan).toMatchObject({ done: 1, total: 4, waiting: 1, doing: 2 });
    expect(m.plan.items.map((i) => [i.id, i.status])).toEqual([
      ["nav", "doing"],
      ["auth", "doing"],
      ["push", "waiting_you"],
      ["old", "dropped"],
      ["done", "done"],
    ]);
    const { missions } = await listMissions(md(), f.owner.id, f.org.id, {});
    expect(missions[0]?.plan.doing).toBe(2);
  });

  test("requests to join: only who takes no part asks; the owner and deciders answer; accept adds with the role", async () => {
    const { view } = await proposed();
    const [bia, caio, duda] = await Promise.all(
      ["bia", "caio", "duda"].map((n) => addMember(f.db, f.org.id, "member", n)),
    );
    for (const u of [bia, caio, duda]) {
      await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u?.id as string });
    }
    const b = bia as { id: string };
    const c = caio as { id: string };
    const d = duda as { id: string };
    await setParticipant(md(), f.owner.id, f.org.id, view.id, { userId: c.id, role: "comment" });
    await expect(requestToJoin(md(), c.id, f.org.id, view.id)).rejects.toMatchObject({
      code: "mission.already_participant",
    });
    const asked = await requestToJoin(md(), b.id, f.org.id, view.id);
    expect(asked).toMatchObject({ status: "pending", userId: b.id, name: "bia" });
    // Asking again returns the same request; nothing is posted in the thread.
    expect((await requestToJoin(md(), b.id, f.org.id, view.id)).id).toBe(asked.id);
    const posted = await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId));
    expect(posted.some((m) => m.authorUserId === b.id)).toBe(false);
    expect((await getMission(md(), b.id, f.org.id, view.id)).joinRequested).toBe(true);
    expect((await getMission(md(), f.owner.id, f.org.id, view.id)).pending.joinRequests).toBe(1);
    expect((await getMission(md(), c.id, f.org.id, view.id)).pending.joinRequests).toBe(0);
    expect(await listJoinRequests(md(), c.id, f.org.id, view.id)).toHaveLength(0);
    expect(await listJoinRequests(md(), f.owner.id, f.org.id, view.id)).toHaveLength(1);

    // A commenter can't answer; the owner accepts as a decider.
    await expect(
      decideJoinRequest(md(), c.id, f.org.id, view.id, b.id, { outcome: "accepted", role: "decide" }),
    ).rejects.toMatchObject({ code: "mission.not_allowed" });
    const accepted = await decideJoinRequest(md(), f.owner.id, f.org.id, view.id, b.id, {
      outcome: "accepted",
      role: "decide",
    });
    expect(accepted).toMatchObject({ status: "accepted", role: "decide", decidedBy: f.owner.id });
    expect((await getMission(md(), b.id, f.org.id, view.id)).role).toBe("decide");

    // The new decider declines duda's request.
    await requestToJoin(md(), d.id, f.org.id, view.id);
    const declined = await decideJoinRequest(md(), b.id, f.org.id, view.id, d.id, { outcome: "declined" });
    expect(declined.status).toBe("declined");
    expect((await getMission(md(), d.id, f.org.id, view.id)).role).toBe("none");
    await expect(
      decideJoinRequest(md(), f.owner.id, f.org.id, view.id, d.id, { outcome: "declined" }),
    ).rejects.toMatchObject({ code: "mission.join_not_found" });
    // Someone who doesn't read the conversation doesn't see the mission at all.
    const zed = await addMember(f.db, f.org.id, "member", "zed");
    await expect(requestToJoin(md(), zed.id, f.org.id, view.id)).rejects.toMatchObject({ code: "mission.not_found" });
  });

  test("eligible agents: every agent, with a reason when it can't (no computer, commands off, old runner, audience); offline still eligible", async () => {
    f = await setup({ machines: true, missionTools: true });
    const elig = (userId = f.owner.id) => eligibleMissionAgents(md(), userId, f.org.id);
    expect(await elig()).toEqual([
      {
        agentId: f.agent.id,
        handle: f.agent.handle,
        name: f.agent.name,
        eligible: false,
        reason: "no_computer",
        canManage: true,
        machine: null,
        ready: false,
        executors: [],
        defaultExecutor: null,
        codexTooOld: false,
        commandApproval: "low_risk_auto",
      },
    ]);
    const paired = await pairedMachine();
    const runner = missionRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    expect(await elig()).toEqual([
      {
        agentId: f.agent.id,
        handle: f.agent.handle,
        name: f.agent.name,
        eligible: true,
        reason: null,
        canManage: true,
        machine: { id: paired.machineId, name: "MacBook", online: true },
        ready: true,
        // An older runner that doesn't report its CLIs: Claude Code is assumed.
        executors: ["claude", "agent"],
        defaultExecutor: "claude",
        codexTooOld: false,
        commandApproval: "low_risk_auto",
      },
    ]);
    // A second agent on the same computer: both eligible, by name ("Ada" before "Dev").
    const ada = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ada", handle: "ada", role: "Developer", instructions: "", credentialId: null },
      { model: "claude-sonnet-5-5" },
    );
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, ada.id, paired.machineId);
    expect((await elig()).map((a) => [a.name, a.eligible, a.machine?.name])).toEqual([
      ["Ada", true, "MacBook"],
      ["Dev", true, "MacBook"],
    ]);
    // Ada with no computer: listed after the eligible ones.
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, ada.id, null);
    expect((await elig()).map((a) => [a.name, a.reason])).toEqual([
      ["Dev", null],
      ["Ada", "no_computer"],
    ]);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    expect((await elig(bia.id)).find((a) => a.agentId === f.agent.id)).toMatchObject({
      eligible: true,
      canManage: false,
    });
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "owner", userIds: [] });
    expect((await elig(bia.id)).find((a) => a.agentId === f.agent.id)?.reason).toBe("not_in_audience");
    await runner.close();
    const offline = (await elig()).find((a) => a.agentId === f.agent.id);
    expect(offline).toMatchObject({ eligible: true, ready: false, machine: { online: false } });
    // Below protocol 14 a mission can't get its own copy of the project (ADR 0044): runner outdated.
    await f.db.update(schema.machines).set({ protocol: 13 }).where(eq(schema.machines.id, paired.machineId));
    expect((await elig()).find((a) => a.agentId === f.agent.id)?.reason).toBe("runner_outdated");
    await f.db.update(schema.machines).set({ protocol: 3 }).where(eq(schema.machines.id, paired.machineId));
    expect((await elig()).find((a) => a.agentId === f.agent.id)?.reason).toBe("runner_outdated");
    await f.db
      .update(schema.machines)
      .set({ protocol: 5, execAllowed: false })
      .where(eq(schema.machines.id, paired.machineId));
    expect((await elig()).find((a) => a.agentId === f.agent.id)?.reason).toBe("exec_off");
  });

  test("list filters (status, conversation, agent, words) and counts (active, waiting for you, closed)", async () => {
    const { view, runner, task: plan } = await proposed();
    const counts = (await listMissions(md(), f.owner.id, f.org.id, { status: "open" })).counts;
    expect(counts).toEqual({ active: 1, waitingYou: 0, closed: 0 });
    ok(await runner.mcp(plan.taskId, "update_plan", { items: [{ id: "push", title: "Push", status: "waiting_you" }] }));
    const after = await listMissions(md(), f.owner.id, f.org.id, { status: "waiting_you" });
    expect(after.counts.waitingYou).toBe(1);
    expect(after.missions.map((m) => m.id)).toEqual([view.id]);
    // Someone who can't act sees it, but nothing waits for them.
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
    expect((await listMissions(md(), bia.id, f.org.id, {})).counts).toEqual({ active: 1, waitingYou: 0, closed: 0 });
    const ids = async (input: Parameters<typeof listMissions>[3]) =>
      (await listMissions(md(), f.owner.id, f.org.id, input)).missions.map((m) => m.id);
    expect(await ids({ q: "mobile" })).toEqual([view.id]);
    expect(await ids({ q: "mobile app build" })).toEqual([]);
    expect(await ids({ q: "Build our" })).toEqual([view.id]);
    expect(await ids({ channelId: f.general.id })).toEqual([view.id]);
    expect(await ids({ channelId: crypto.randomUUID() })).toEqual([]);
    expect(await ids({ agentId: f.agent.id })).toEqual([view.id]);
    expect(await ids({ agentId: crypto.randomUUID() })).toEqual([]);
    expect(await ids({ status: "closed" })).toEqual([]);
    await closeMission(md(), f.owner.id, f.org.id, view.id, { outcome: "done" });
    const closed = await listMissions(md(), f.owner.id, f.org.id, { status: "closed" });
    expect(closed.counts).toEqual({ active: 0, waitingYou: 0, closed: 1 });
    expect(closed.missions.map((m) => m.id)).toEqual([view.id]);
  });

  test("an item that stops to wait is told to the main session as waiting, not done", async () => {
    const { view, runner } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    done(await mainCall("start_task", { title: "Navigation", prompt: "Build the tabs", branch: "nav" }));
    const item = runner.started.at(-1) as TaskStartRequest;
    ok(
      await runner.mcp(item.taskId, "ask_decision", {
        question: "Tabs or drawer?",
        options: ["Tabs", "Drawer"],
        blocking: true,
      }),
    );
    const [row] = await f.db.select().from(schema.machineTasks).where(eq(schema.machineTasks.id, item.taskId));
    expect(row?.waitingFor).toBe("decision");
    await runner.done(item.taskId);
    await drainOutbox(f.db, f.handlers);
    // The main session (its run) hears it as "waiting".
    const told = (await notices(view.threadId)).filter((t) => t.includes('"Navigation"'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("is waiting for a decision");
    expect(told[0]).not.toContain("done after");
  });

  test("mission tools are rate limited per task, and what looks like a secret never reaches a card", async () => {
    const { view, runner, task: plan } = await proposed();
    await startMission(md(), f.owner.id, f.org.id, view.id);
    ok(await runner.mcp(plan.taskId, "report", { summary: "Pushed with token ghp_abcdefghijklmnopqrstuvwxyz0123" }));
    const report = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
      (m) => m.meta.missionReport,
    );
    expect(report?.body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(report?.body).toContain("••••");
    const ask = (i: number) =>
      runner.mcp(plan.taskId, "ask_decision", { question: `Icon ${i}?`, options: ["A", "B"], blocking: false });
    for (let i = 0; i < 10; i++) ok(await ask(i));
    expect(await ask(10)).toMatchObject({ ok: false, error: { code: "mission.rate_limited" } });
  });

  test("hello stores the coding CLIs; Codex counts only from the minimum version; Claude Code is required to choose it", async () => {
    f = await setup({ machines: true, missionTools: true });
    const paired = await pairedMachine();
    const runner = missionRunner(f.machineHub as MachineHub);
    await runner.close();
    const hub = f.machineHub as MachineHub;
    const conn = hub.open({ send() {}, close() {} });
    await hub.message(
      conn,
      JSON.stringify({
        type: "hello",
        token: paired.token,
        ...RUNNER,
        exec: true,
        executors: { codex: { version: "codex-cli 0.150.0" } },
      }),
    );
    const [machine] = await f.db.select().from(schema.machines);
    expect(machine?.executors).toMatchObject({ codex: { version: "codex-cli 0.150.0" } });
    expect(machineExecutors(machine as typeof schema.machines.$inferSelect)).toEqual({
      available: ["agent"],
      codexTooOld: true,
    });
    expect(
      machineExecutors({
        protocol: 7,
        execAllowed: true,
        executors: { codex: { version: "codex-cli 0.163.0" }, detectedAt: "x" },
      }).available,
    ).toEqual(["codex", "agent"]);
    await expect(
      createMission(md(), f.owner.id, f.org.id, {
        agentId: f.agent.id,
        channelId: f.general.id,
        goal: "Build",
        executor: "codex",
      }),
    ).rejects.toMatchObject({ code: "mission.executor_outdated" });
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Build",
    });
    expect(view.executor).toBe("agent");
    expect(view.machine?.executors).toEqual(["agent"]);
  });

  describe("command approvals (Claude Code's permission prompts)", () => {
    /** An active mission with one item session running (Claude Code's prompts come from it). */
    async function working(judge?: NonNullable<Parameters<typeof setup>[0]>["judge"]) {
      const { view, runner, task: main } = await proposed(judge ? { judge } : {});
      await startMission(md(), f.owner.id, f.org.id, view.id);
      const prompt = async (taskId: string, args: Record<string, unknown>) =>
        JSON.parse(ok(await runner.mcp(taskId, "permission_prompt", args))) as {
          behavior?: string;
          message?: string;
          code?: string;
          status?: string;
          request_id?: string;
        };
      return { view, runner, main, prompt };
    }

    test("a command off the allow list posts the card; Aprovar sempre allows it now, later and in the next tasks' settings", async () => {
      const { view, runner, main, prompt } = await working();
      const asked = await prompt(main.taskId, { tool_name: "Bash", input: { command: "swift build -c release" } });
      expect(asked).toMatchObject({ status: "pending" });
      const id = asked.request_id as string;
      const card = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
        (m) => m.meta.missionCommand,
      );
      expect(card?.meta.missionCommand).toMatchObject({ id, missionId: view.id, command: "swift build -c release" });
      expect(card?.body).toContain("Claude Code wants to run");
      // The runner asks again while it waits: still pending; the same command again is the same card.
      expect(await prompt(main.taskId, { request_id: id })).toEqual({ status: "pending", request_id: id });
      expect(
        (await prompt(main.taskId, { tool_name: "Bash", input: { command: "swift build -c release" } })).request_id,
      ).toBe(id);
      // Only the owner or a decider answers (bia reads the conversation, but doesn't decide).
      const bia = await addMember(f.db, f.org.id, "member", "bia");
      await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
      await expect(decideCommand(md(), bia.id, f.org.id, view.id, id, "allow")).rejects.toMatchObject({
        code: "mission.not_allowed",
      });
      // The open card waits for the owner ("Esperando você", the thread row, the sidebar), not for bia.
      const threadWaiting = async (userId: string) =>
        (await listThreads(f.db, userId, { orgId: f.org.id, tab: "missions" })).threads.find(
          (x) => x.mission?.id === view.id,
        )?.mission?.waitingYou ?? -1;
      expect((await getMission(md(), f.owner.id, f.org.id, view.id)).pending.commands).toBe(1);
      expect((await getMission(md(), bia.id, f.org.id, view.id)).pending.commands).toBe(0);
      expect((await listMissions(md(), f.owner.id, f.org.id, {})).missions[0]?.pending.commands).toBe(1);
      expect((await listMissions(md(), f.owner.id, f.org.id, {})).counts.waitingYou).toBe(1);
      const ownerWaiting = await threadWaiting(f.owner.id);
      expect(await threadWaiting(bia.id)).toBe(ownerWaiting - 1);
      const decided = await decideCommand(md(), f.owner.id, f.org.id, view.id, id, "always");
      expect((await getMission(md(), f.owner.id, f.org.id, view.id)).pending.commands).toBe(0);
      expect(await threadWaiting(f.owner.id)).toBe(ownerWaiting - 1);
      expect(decided).toMatchObject({ state: "allowed", always: true, rules: ["Bash(swift build *)"] });
      expect(await prompt(main.taskId, { request_id: id })).toEqual({ behavior: "allow" });
      await expect(decideCommand(md(), f.owner.id, f.org.id, view.id, id, "deny")).rejects.toMatchObject({
        code: "mission.command_decided",
      });
      // The rule covers the next one at once (no card).
      expect(await prompt(main.taskId, { tool_name: "Bash", input: { command: "swift build" } })).toEqual({
        behavior: "allow",
      });
      expect((await listMissionCommands(md(), f.owner.id, f.org.id, view.id)).rules).toEqual(["Bash(swift build *)"]);
      // A new task's settings carry it.
      done(await mainCall("start_task", { title: "Release", prompt: "Build it", branch: "release" }));
      expect((runner.started.at(-1) as TaskStartRequest).mission?.allow).toEqual(["Bash(swift build *)"]);
    });

    test("Aprovar sempre para o agente keeps the command's kind for the agent; read-only gh needs no card", async () => {
      const { view, main, prompt: ask } = await working();
      // Where the session runs, as the runner says: plain reads and writes inside it are code's to allow.
      const prompt = (taskId: string, args: Record<string, unknown>) =>
        ask(taskId, { ...args, scope: { cwd: "/w/app", folders: ["/w/app"] } });
      expect(
        await prompt(main.taskId, { tool_name: "Bash", input: { command: "gh pr view 12 --json title" } }),
      ).toEqual({ behavior: "allow" });
      const asked = await prompt(main.taskId, { tool_name: "Bash", input: { command: "gh issue create --title x" } });
      const id = asked.request_id as string;
      const [card] = (await listMissionCommands(md(), f.owner.id, f.org.id, view.id)).commands;
      expect(card).toMatchObject({ id, agentKind: "gh issue create", forAgent: false });
      const decided = await decideCommand(md(), f.owner.id, f.org.id, view.id, id, "agent");
      expect(decided).toMatchObject({ state: "allowed", always: false, forAgent: true });
      expect(await ask(main.taskId, { request_id: id })).toEqual({ behavior: "allow" });
      expect(
        (await f.db.select().from(schema.approvalRules)).map((r) => [r.agentId, r.connectionId, r.tool, r.action]),
      ).toEqual([[f.agent.id, null, "command", "gh issue create"]]);
      const [audit] = await f.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "mission.command_agent"));
      expect(audit?.details).toMatchObject({ agentId: f.agent.id, kind: "gh issue create" });
      // Its kind with other arguments runs at once; another kind asks; a forbidden one is never offered.
      expect(
        await prompt(main.taskId, { tool_name: "Bash", input: { command: "gh issue create --title y --label bug" } }),
      ).toEqual({ behavior: "allow" });
      expect(await prompt(main.taskId, { tool_name: "Bash", input: { command: "gh issue close 2" } })).toMatchObject({
        status: "pending",
      });
      const outside = await prompt(main.taskId, { tool_name: "Bash", input: { command: "touch /etc/x" } });
      const commands = (await listMissionCommands(md(), f.owner.id, f.org.id, view.id)).commands;
      expect(commands.find((c) => c.id === outside.request_id)?.agentKind).toBeNull();
    });

    describe("Pedir aprovação de comandos (the deny list, plain reads, the judge)", () => {
      /** What the fake judge says about commands (mission_command_risk), and how often it was asked. */
      let risk: number | "error" = 0;
      let asked = 0;
      const judge: NonNullable<Parameters<typeof setup>[0]>["judge"] = (kind) => {
        if (kind !== "mission_command_risk") return undefined;
        asked++;
        if (risk === "error") throw new Error("judge down");
        return risk;
      };
      const scope = { cwd: "/Users/w/agentes/ada/app", folders: ["/Users/w/agentes/ada/app"], home: "/Users/w" };
      const bash = (command: string, withScope = true) => ({
        tool_name: "Bash",
        input: { command },
        ...(withScope ? { scope } : {}),
      });
      const threadMessages = async (threadId: string) =>
        f.db.select().from(schema.messages).where(eq(schema.messages.threadId, threadId));
      afterEach(() => {
        risk = 0;
        asked = 0;
      });

      test("new missions default to low_risk_auto; the deny list and plain reads are never judged nor carded", async () => {
        const { view, main, prompt } = await working(judge);
        expect(view.commandApproval).toBe("low_risk_auto");
        risk = 0.99;
        // Refused with the kind it is, never judged (pushes are read on the computer, before they get here).
        expect(await prompt(main.taskId, bash("npm publish"))).toEqual({
          behavior: "deny",
          message: approvalMessage("This publishes a package, an image or a release", ASK_IN_CHAT),
          code: "never",
        });
        expect(await prompt(main.taskId, bash("gh pr merge 12"))).toMatchObject({ behavior: "deny" });
        for (const command of [
          "ls /System/Library/Fonts /Library/Fonts",
          "curl -sI https://commons.wikimedia.org/w/api.php",
        ]) {
          expect(await prompt(main.taskId, bash(command))).toEqual({ behavior: "allow" });
        }
        expect(asked).toBe(0);
        const msgs = await threadMessages(view.threadId);
        expect(msgs.some((m) => m.meta.missionCommand || m.meta.missionAutoApproved)).toBe(false);
      });

      test("the judge at the threshold or more allows with one quiet line; below, or failing, it is the card", async () => {
        const { view, main, prompt } = await working(judge);
        risk = LOW_RISK_THRESHOLD;
        expect(await prompt(main.taskId, bash("swift build -c release"))).toEqual({ behavior: "allow" });
        expect(asked).toBe(1);
        let msgs = await threadMessages(view.threadId);
        const line = msgs.find((m) => m.meta.missionAutoApproved);
        expect(line?.meta.missionAutoApproved).toMatchObject({
          missionId: view.id,
          command: "swift build -c release",
          reason: "low_risk",
        });
        expect(line?.meta.bodyCode).toBe("mission_auto_approved");
        expect(msgs.some((m) => m.meta.missionCommand)).toBe(false);
        const audits = await f.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, "mission.command_auto"));
        expect(audits).toHaveLength(1);
        // Below the threshold: the card.
        risk = LOW_RISK_THRESHOLD - 0.01;
        expect(await prompt(main.taskId, bash("make release"))).toMatchObject({ status: "pending" });
        // The judge fails: the card (fail closed).
        risk = "error";
        expect(await prompt(main.taskId, bash("python3 tools/gen.py"))).toMatchObject({ status: "pending" });
        // Code forbids it: the judge isn't even asked.
        risk = 0.99;
        const before = asked;
        for (const command of ["sudo make install", "rm -rf ~/Documents", "npm i -g x", "scp a host:/tmp"]) {
          expect(await prompt(main.taskId, bash(command))).toMatchObject({ status: "pending" });
        }
        // Without the runner's scope nothing writes outside: rm is forbidden there too.
        expect(await prompt(main.taskId, bash("rm -rf build", false))).toMatchObject({ status: "pending" });
        expect(asked).toBe(before);
        msgs = await threadMessages(view.threadId);
        expect(msgs.filter((m) => m.meta.missionCommand)).toHaveLength(7);
        expect(msgs.filter((m) => m.meta.missionAutoApproved)).toHaveLength(1);
      });

      test("never allows everything but the deny list; always asks for every command; changes are audited", async () => {
        const { view, main, prompt } = await working(judge);
        const bia = await addMember(f.db, f.org.id, "member", "bia");
        await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
        await expect(setCommandApproval(md(), bia.id, f.org.id, view.id, "never")).rejects.toMatchObject({
          code: "mission.not_allowed",
        });
        await expect(setCommandApproval(md(), f.owner.id, f.org.id, view.id, "sometimes")).rejects.toMatchObject({
          code: "mission.invalid_command_approval",
        });
        expect(await setCommandApproval(md(), f.owner.id, f.org.id, view.id, "never")).toEqual({
          commandApproval: "never",
        });
        expect((await getMission(md(), f.owner.id, f.org.id, view.id)).commandApproval).toBe("never");
        expect(await prompt(main.taskId, bash("brew install ffmpeg"))).toEqual({ behavior: "allow" });
        expect(await prompt(main.taskId, bash("npm publish"))).toMatchObject({ behavior: "deny" });
        expect(asked).toBe(0);
        const line = (await threadMessages(view.threadId)).find((m) => m.meta.missionAutoApproved);
        expect(line?.meta.missionAutoApproved).toMatchObject({ command: "brew install ffmpeg", reason: "never" });
        // Revogar: back to always; even a low-risk command gets the card.
        await setCommandApproval(md(), f.owner.id, f.org.id, view.id, "always");
        risk = 0.99;
        expect(await prompt(main.taskId, bash("swift build"))).toMatchObject({ status: "pending" });
        expect(asked).toBe(0);
        const audits = await f.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, "mission.command_approval"));
        expect(audits.sort((a, b) => (a.id < b.id ? -1 : 1)).map((a) => a.details)).toEqual([
          { from: "low_risk_auto", to: "never" },
          { from: "never", to: "always" },
        ]);
        // Asked for at creation.
        const other = await createMission(md(), f.owner.id, f.org.id, {
          agentId: f.agent.id,
          channelId: f.general.id,
          goal: "Photos",
          commandApproval: "always",
        });
        expect(other.commandApproval).toBe("always");
      });
    });

    test("Recusar denies; nobody answering in time denies with the wait message; prompts per task are limited", async () => {
      const { view, main, prompt } = await working();
      const a = (await prompt(main.taskId, { tool_name: "Bash", input: { command: "brew install imagemagick" } }))
        .request_id as string;
      await decideCommand(md(), f.owner.id, f.org.id, view.id, a, "deny");
      // Each refusal carries a code, so the apps say why in the person's language.
      expect(await prompt(main.taskId, { request_id: a })).toMatchObject({ behavior: "deny", code: "person" });
      const b = (await prompt(main.taskId, { tool_name: "WebFetch", input: { url: "https://example.com/x" } }))
        .request_id as string;
      await f.db.execute(sql`update mission_events set created_at = now() - interval '31 minutes'
        where kind = 'command_prompt' and data->>'promptId' = ${b}`);
      expect(await prompt(main.taskId, { request_id: b })).toEqual({
        behavior: "deny",
        message: PERMISSION_TIMEOUT_MESSAGE,
        code: "expired",
      });
      await expect(decideCommand(md(), f.owner.id, f.org.id, view.id, b, "allow")).rejects.toMatchObject({
        code: "mission.command_expired",
      });
      // At most COMMAND_PROMPTS_PER_TASK (30) in 10 minutes per task (a is one of them; b is older).
      const answers = [];
      for (let i = 0; i < 30; i++) {
        answers.push(await prompt(main.taskId, { tool_name: "Bash", input: { command: `tool${i} --run` } }));
      }
      expect(answers.slice(0, 29).every((x) => x.status === "pending")).toBe(true);
      expect(answers[29]).toMatchObject({ behavior: "deny", code: "tooMany" });
      expect(answers[29]?.message).toContain("Too many");
    });

    test("refused commands reach the task's end notice; Liberar e repetir adds the rule and resumes the session", async () => {
      const { view, runner } = await working();
      done(await mainCall("start_task", { title: "Photos", prompt: "Resize them", branch: "photos" }));
      const item = runner.started.at(-1) as TaskStartRequest;
      const command = "python3 -c 'import PIL'";
      await runner.done(item.taskId, { denials: [{ tool: "Bash", command }] });
      await drainOutbox(f.db, f.handlers);
      const notice = (
        await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))
      ).find((m) => (m.meta.machineTask as { id?: string } | undefined)?.id === item.taskId);
      expect((notice?.meta.machineTask as { blocked?: unknown } | undefined)?.blocked).toEqual([
        { tool: "Bash", command },
      ]);
      // People see them under the line (from its meta); the agent reads them in its English line.
      expect(notice && taskNotice(notice)).toContain(`Blocked: \`${command}\``);
      await expect(
        retryBlockedCommand(md(), f.owner.id, f.org.id, view.id, { taskId: item.taskId, command: "ls" }),
      ).rejects.toMatchObject({ code: "mission.command_not_found" });
      const out = await retryBlockedCommand(md(), f.owner.id, f.org.id, view.id, { taskId: item.taskId, command });
      expect(out.rules).toEqual(["Bash(python3 *)"]);
      const resumed = runner.started.at(-1) as TaskStartRequest;
      expect(resumed.session).toBe(item.session);
      expect(resumed.resume).toBe(true);
      expect(resumed.prompt).toContain("The command was allowed; retry it");
      expect(resumed.mission?.allow).toEqual(["Bash(python3 *)"]);
    });

    test("Liberar e repetir for several blocked commands at once: one resume; refused while paused", async () => {
      const { view, runner } = await working();
      done(await mainCall("start_task", { title: "Photos", prompt: "Resize them", branch: "photos" }));
      const item = runner.started.at(-1) as TaskStartRequest;
      const blocked = ["python3 -c 'import PIL'", "swift build"];
      await runner.done(item.taskId, { denials: blocked.map((command) => ({ tool: "Bash", command })) });
      await drainOutbox(f.db, f.handlers);
      await pauseMission(md(), f.owner.id, f.org.id, view.id);
      await expect(
        retryBlockedCommand(md(), f.owner.id, f.org.id, view.id, { taskId: item.taskId, commands: blocked }),
      ).rejects.toMatchObject({ code: "mission.paused" });
      await f.db.update(schema.missions).set({ status: "active" }).where(eq(schema.missions.id, view.id));
      const before = runner.started.length;
      const out = await retryBlockedCommand(md(), f.owner.id, f.org.id, view.id, {
        taskId: item.taskId,
        commands: blocked,
      });
      expect(out.rules.sort()).toEqual(["Bash(python3 *)", "Bash(swift build *)"].sort());
      expect(runner.started.length).toBe(before + 1);
      const resumed = runner.started.at(-1) as TaskStartRequest;
      expect(resumed.session).toBe(item.session);
      expect(resumed.prompt).toContain("These commands were allowed; retry them:");
      expect(resumed.prompt).toContain("- swift build");
    });
  });
});
